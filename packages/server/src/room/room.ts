import { scryptSync, randomBytes } from 'node:crypto';
import {
  CloseCode, LIMITS, P2P, PARTICIPANT_COLORS, PROTOCOL_VERSION, SYNC, clamp, excerpt, expectedPosition, formatTime, sanitizeChat, sanitizeName,
  type ChatAttachment, type ChatMessage, type ChatReplyRef, type UserChatMessage, type ClientMessage, type ErrorCode, type JoinMessage, type MediaDescriptor, type ParticipantInfo,
  type PlaybackState, type RoomPreview, type RoomSettings, type RoomSnapshot, type ServerMessage, type SettingsMessage,
  type RtcMessage, type StatusMessage, type SystemIcon, type YouTubeMediaDescriptor, type LinkPreview, findYouTubeLink,
} from '@watchroom/protocol';
import { randomId, randomToken, safeEqual } from '../util/ids';
import type { Logger } from '../util/log';
import { TokenBucket } from '../util/ratelimit';
import type { ChatImageStore } from './images';

export interface RoomSocket {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface Participant {
  info: ParticipantInfo;
  token: string;
  deviceId: string;
  socket: RoomSocket | null;
  lastStatus: (StatusMessage & { at: number }) | null;
  bufferingSince: number | null;
  catchUpUntil: number;
  graceTimer: NodeJS.Timeout | null;
  stallTimer: NodeJS.Timeout | null;
  intentBucket: TokenBucket;
  chatBucket: TokenBucket;
  msgBucket: TokenBucket;
  reactionBucket: TokenBucket;
  rtcBucket: TokenBucket;
  openBucket: TokenBucket;
  /** Messages dropped by the rate limit recently (decays as normal messages get through). */
  dropped: number;
  lastRateNotice: number;
  typingTimer: NodeJS.Timeout | null;
}

export type JoinResult =
  | { ok: true; participant: Participant; resumed: boolean }
  | { ok: false; code: ErrorCode; message: string };

export interface RoomEvents {
  participantsChanged?(participants: ParticipantInfo[]): void;
  playbackChanged?(playback: PlaybackState): void;
  settingsChanged?(settings: RoomSettings): void;
  /** WebRTC signalling addressed to the host's own peer. */
  rtcToHost?(p: Participant, msg: RtcMessage): void;
  /** A participant left for good (their direct connections should be closed). */
  participantGone?(participantId: string): void;
  /** Someone asked to watch a YouTube link: the host app checks it and switches the room's media. */
  openYouTube?(url: string, by: Participant): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Title and channel of a YouTube video, for a link someone posted in chat. */
  lookupYouTube?(videoId: string): Promise<{ status: 'ok'; title: string; author: string | null } | { status: 'unavailable' | 'unknown' }>;
  /** The current YouTube video's length became known (or changed). */
  mediaInfo?(media: YouTubeMediaDescriptor): void;
}

interface StoredSettings extends RoomSettings {
  passwordHash: string | null;
}

const STATUS_STALE_MS = 10_000;

function hashPassword(pw: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}

function checkPassword(pw: string, stored: string): boolean {
  const [salt] = stored.split(':');
  return salt ? safeEqual(hashPassword(pw, salt), stored) : false;
}

export class Room {
  readonly id = randomId(10);
  key = randomToken(16);
  readonly hostToken = randomToken(24);
  readonly participants = new Map<string, Participant>();
  media: MediaDescriptor | null = null;
  playback: PlaybackState = {
    status: 'paused', position: 0, anchor: 0, rate: 1, version: 0, action: null, actor: null, waitReason: null, waitingFor: [],
  };
  private chat: ChatMessage[] = [];
  private seq = 0;
  private bans = new Set<string>();
  private settings: StoredSettings = {
    controlMode: 'everyone', bufferingPolicy: 'wait', locked: false, passwordRequired: false,
    maxParticipants: LIMITS.maxParticipantsDefault, passwordHash: null, p2p: true,
  };
  private startTimer: NodeJS.Timeout | null = null;
  private bufferTimer: NodeJS.Timeout | null = null;
  private participantsTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private pendingSeek: { actorId: string; timer: NodeJS.Timeout; text: string } | null = null;
  private failedJoins: number[] = [];
  private ended = false;
  hostName = 'Host';

  constructor(
    private readonly log: Logger,
    private readonly events: RoomEvents = {},
    private readonly now: () => number = Date.now,
    private readonly images: ChatImageStore | null = null,
  ) {}

  // ------------------------------------------------------------------ public views

  publicSettings(): RoomSettings {
    const { passwordHash: _ignored, ...rest } = this.settings;
    return rest;
  }

  participantList(): ParticipantInfo[] {
    return [...this.participants.values()].map((p) => ({ ...p.info }));
  }

  snapshot(): RoomSnapshot {
    return {
      roomId: this.id,
      participants: this.participantList(),
      playback: this.playback,
      media: this.media,
      chat: this.chat.slice(-200),
      settings: this.publicSettings(),
      serverTime: this.now(),
    };
  }

  checkKey(key: string | undefined): boolean {
    return typeof key === 'string' && safeEqual(key, this.key);
  }

  preview(key: string): RoomPreview | null {
    if (!this.checkKey(key)) return null;
    const host = [...this.participants.values()].find((p) => p.info.role === 'host');
    return {
      roomId: this.id,
      title: this.media?.title ?? null,
      duration: this.media?.duration ?? null,
      hostName: host?.info.name ?? this.hostName,
      participants: [...this.participants.values()].filter((p) => p.info.connected).map((p) => ({ name: p.info.name, color: p.info.color })),
      passwordRequired: this.settings.passwordRequired,
      locked: this.settings.locked,
      full: this.activeCount() >= this.settings.maxParticipants,
    };
  }

  participantByToken(token: string): Participant | undefined {
    for (const p of this.participants.values()) if (safeEqual(p.token, token)) return p;
    return undefined;
  }

  /** Invalidate the current link: new key, everyone already inside stays. */
  regenerateKey(): string {
    this.key = randomToken(16);
    return this.key;
  }

  // ------------------------------------------------------------------ join / leave

  private uniqueName(name: string, exceptId: string | null): string {
    const taken = new Set([...this.participants.values()].filter((p) => p.info.id !== exceptId).map((p) => p.info.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let i = 2;
    const base = name.slice(0, LIMITS.nameMax - 3);
    while (taken.has(`${base} ${i}`.toLowerCase())) i++;
    return `${base} ${i}`;
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.info.role !== 'host') n++;
    return n;
  }

  private rateLimitedJoins(): boolean {
    const t = this.now();
    this.failedJoins = this.failedJoins.filter((x) => t - x < 60_000);
    return this.failedJoins.length >= 30;
  }

  private failJoin(code: ErrorCode, message: string): JoinResult {
    if (code === 'invalid_key' || code === 'wrong_password') this.failedJoins.push(this.now());
    return { ok: false, code, message };
  }

  join(socket: RoomSocket, msg: JoinMessage): JoinResult {
    if (this.ended) return { ok: false, code: 'room_not_found', message: 'This room has ended.' };
    if (msg.protocol !== PROTOCOL_VERSION) return { ok: false, code: 'protocol_mismatch', message: 'Please reload the page.' };
    if (msg.roomId !== this.id) return { ok: false, code: 'room_not_found', message: 'This room does not exist anymore.' };
    if (this.rateLimitedJoins()) return { ok: false, code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' };

    const isHost = typeof msg.hostToken === 'string' && safeEqual(msg.hostToken, this.hostToken);
    if (!isHost && !this.checkKey(msg.key)) return this.failJoin('invalid_key', 'This invite link is not valid anymore. Ask the host for a new one.');

    // Resume an existing session (reconnect) without announcing a leave/join.
    if (msg.resume) {
      const existing = this.participants.get(msg.resume.participantId);
      if (existing && safeEqual(existing.token, msg.resume.token)) {
        if (existing.socket && existing.socket !== socket) existing.socket.close(CloseCode.replaced, 'replaced by a newer connection');
        existing.socket = socket;
        existing.info.connected = true;
        existing.lastStatus = null;
        if (existing.graceTimer) clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        this.queueParticipants();
        return { ok: true, participant: existing, resumed: true };
      }
    }

    if (this.bans.has(msg.deviceId)) return { ok: false, code: 'banned', message: 'The host removed you from this room.' };
    if (!isHost) {
      if (this.settings.locked) return { ok: false, code: 'room_locked', message: 'The host has locked this room.' };
      if (this.settings.passwordHash) {
        if (!msg.password) return { ok: false, code: 'password_required', message: 'This room needs a password.' };
        if (!checkPassword(msg.password, this.settings.passwordHash)) return this.failJoin('wrong_password', 'Wrong password.');
      }
      if (this.activeCount() >= this.settings.maxParticipants) return { ok: false, code: 'room_full', message: 'This room is full.' };
    }

    const clean = sanitizeName(msg.name);
    if (clean.length < LIMITS.nameMin) return { ok: false, code: 'bad_request', message: 'Please enter a name.' };
    const name = this.uniqueName(clean, null);

    const used = new Map<string, number>();
    for (const p of this.participants.values()) used.set(p.info.color, (used.get(p.info.color) ?? 0) + 1);
    const color = [...PARTICIPANT_COLORS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0]!;

    const now = this.now;
    const participant: Participant = {
      info: {
        id: randomId(10), name, color, role: isHost ? 'host' : 'guest', connected: true, joinedAt: now(),
        player: 'loading', quality: null, rtt: null, device: msg.device ?? null, p2p: null,
      },
      token: randomToken(24),
      deviceId: msg.deviceId,
      socket,
      lastStatus: null,
      bufferingSince: null,
      catchUpUntil: 0,
      graceTimer: null,
      stallTimer: null,
      intentBucket: new TokenBucket(8, 3, now),
      chatBucket: new TokenBucket(6, 1, now),
      msgBucket: new TokenBucket(60, 20, now),
      reactionBucket: new TokenBucket(8, 2, now),
      // Connection setup sends a burst of ICE candidates per peer; allow that, not a flood.
      rtcBucket: new TokenBucket(120, 20, now),
      // Switching the room's video: a few in a row, then one every few seconds.
      openBucket: new TokenBucket(3, 0.2, now),
      dropped: 0,
      lastRateNotice: 0,
      typingTimer: null,
    };
    this.participants.set(participant.info.id, participant);
    if (isHost) this.hostName = name;
    this.system('join', `${name} joined`, participant.info.id);
    this.queueParticipants();
    this.log.info(`${isHost ? 'host' : 'guest'} "${name}" joined (${this.participants.size} in room)`);
    return { ok: true, participant, resumed: false };
  }

  /** Socket closed. Keep the seat for a grace period so a reconnect is seamless. */
  disconnect(p: Participant, socket: RoomSocket): void {
    if (p.socket !== socket) return; // an older, replaced socket
    p.socket = null;
    p.info.connected = false;
    p.bufferingSince = null;
    this.clearStall(p);
    this.dropFromWait(p.info.id);
    this.queueParticipants();
    if (p.graceTimer) clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => this.remove(p, `${p.info.name} left`), SYNC.resumeGraceMs);
  }

  leave(p: Participant): void {
    p.socket?.close(CloseCode.normal, 'left');
    this.remove(p, `${p.info.name} left`);
  }

  private remove(p: Participant, text: string, icon: SystemIcon = 'leave'): void {
    if (!this.participants.has(p.info.id)) return;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    this.stopTyping(p);
    this.clearStall(p);
    this.participants.delete(p.info.id);
    this.dropFromWait(p.info.id);
    this.events.participantGone?.(p.info.id);
    this.system(icon, text, p.info.id);
    this.queueParticipants();
    this.log.info(`"${p.info.name}" removed (${this.participants.size} in room)`);
  }

  kick(targetId: string): boolean {
    const p = this.participants.get(targetId);
    if (!p || p.info.role === 'host') return false;
    this.bans.add(p.deviceId);
    p.socket?.send({ type: 'kicked' });
    p.socket?.close(CloseCode.kicked, 'kicked');
    p.socket = null;
    this.remove(p, `${p.info.name} was removed by the host`, 'kick');
    return true;
  }

  end(reason: string): void {
    this.ended = true;
    for (const t of [this.startTimer, this.bufferTimer, this.participantsTimer, this.endTimer]) if (t) clearTimeout(t);
    if (this.pendingSeek) clearTimeout(this.pendingSeek.timer);
    for (const p of this.participants.values()) {
      if (p.graceTimer) clearTimeout(p.graceTimer);
      if (p.typingTimer) clearTimeout(p.typingTimer);
      this.clearStall(p);
      p.socket?.send({ type: 'ended', reason });
      p.socket?.close(CloseCode.ended, 'ended');
    }
    this.participants.clear();
  }

  // ------------------------------------------------------------------ messages

  handle(p: Participant, msg: ClientMessage): void {
    if (!p.msgBucket.take()) {
      // A client that floods well past the limit is disconnected; others get one notice every few seconds.
      if (++p.dropped > 300) {
        this.log.warn(`disconnecting "${p.info.name}": message flood`);
        p.socket?.close(CloseCode.protocol, 'message flood');
        this.remove(p, `${p.info.name} was disconnected (sending too much)`, 'kick');
        return;
      }
      if (this.now() - p.lastRateNotice > 3000) {
        p.lastRateNotice = this.now();
        p.socket?.send({ type: 'error', code: 'rate_limited', message: 'Slow down a little.', fatal: false });
      }
      return;
    }
    if (p.dropped > 0) p.dropped--;
    switch (msg.type) {
      case 'intent': return this.intent(p, msg);
      case 'ready': return this.ready(p, msg.version, msg.ready);
      case 'status': return this.status(p, msg);
      case 'chat': return this.chatMessage(p, msg.text, msg.nonce, msg.attachment, msg.replyTo);
      case 'kick':
        if (p.info.role !== 'host') return this.deny(p, 'Only the host can remove people.');
        this.kick(msg.participantId);
        return;
      case 'settings':
        if (p.info.role !== 'host') return this.deny(p, 'Only the host can change room settings.');
        return this.applySettings(msg.patch, p.info.name);
      case 'leave': return this.leave(p);
      case 'typing': return msg.active ? this.startTyping(p) : this.stopTyping(p);
      case 'rtc': return this.rtc(p, msg);
      case 'open-youtube': return void this.openYouTube(p, msg.url, msg.requestId);
      case 'media-info': return this.mediaInfo(p, msg);
      case 'reaction':
        if (!p.reactionBucket.take()) return;
        this.broadcast({ type: 'reaction', id: randomId(10), participantId: p.info.id, emoji: msg.emoji });
        return;
      case 'rename': return this.rename(p, msg.name);
      default: return;
    }
  }

  private deny(p: Participant, message: string): void {
    p.socket?.send({ type: 'error', code: 'not_allowed', message, fatal: false });
  }

  // ------------------------------------------------------------------ media

  /** The host's saved preferences, applied quietly when the app starts. */
  applyDefaults(d: Partial<Pick<RoomSettings, 'controlMode' | 'bufferingPolicy' | 'maxParticipants' | 'p2p'>>): void {
    if (d.controlMode) this.settings.controlMode = d.controlMode;
    if (typeof d.p2p === 'boolean') this.settings.p2p = d.p2p;
    if (d.bufferingPolicy) this.settings.bufferingPolicy = d.bufferingPolicy;
    if (d.maxParticipants) this.settings.maxParticipants = clamp(Math.round(d.maxParticipants), 1, LIMITS.maxParticipantsHard);
  }

  /** Where the room is right now (seconds into the video). */
  currentPosition(): number {
    return expectedPosition(this.playback, this.now(), this.media?.duration ?? Infinity);
  }

  setMedia(media: MediaDescriptor | null, actorName?: string, startAt = 0, startReason: 'resume' | 'link' = 'resume'): void {
    this.media = media;
    this.clearWaitTimers();
    for (const p of this.participants.values()) {
      p.info.player = 'loading';
      p.lastStatus = null;
      p.bufferingSince = null;
      this.clearStall(p);
    }
    const position = media && startAt > 0 && (media.duration === null || startAt < media.duration) && !(media.kind === 'youtube' && media.isLive)
      ? startAt : 0;
    this.setPlayback({ status: 'paused', position, anchor: this.now(), rate: 1, action: 'load', actor: null, waitReason: null, waitingFor: [] });
    this.broadcast({ type: 'media', media });
    if (media) {
      this.system('video', `${actorName ?? this.hostName} opened “${media.title}”`, null);
      if (position > 0 && startReason === 'resume') this.system('info', `Continuing from ${formatTime(position)}, where you stopped last time`, null);
    }
    this.queueParticipants();
  }

  /** Switch to a YouTube link (from the open box or a chat card). Host always; others while everyone controls playback. */
  private async openYouTube(p: Participant, url: string, requestId: string): Promise<void> {
    const reply = (ok: boolean, error?: string) => p.socket?.send({ type: 'open-result', requestId, ok, ...(error ? { error } : {}) });
    if (p.info.role !== 'host' && this.settings.controlMode === 'host') return reply(false, 'Only the host can change the video in this room.');
    if (!p.openBucket.take()) return reply(false, 'Please wait a moment before changing the video again.');
    if (!this.events.openYouTube) return reply(false, 'YouTube videos are not available here.');
    try {
      const res = await this.events.openYouTube(url, p);
      reply(res.ok, res.ok ? undefined : res.error);
    } catch (err) {
      this.log.warn('opening a YouTube video failed', err);
      reply(false, 'Could not open that video. Try again.');
    }
  }

  /** A viewer's YouTube player told us the video's length (YouTube only reveals it to the player). */
  private mediaInfo(p: Participant, msg: Extract<ClientMessage, { type: 'media-info' }>): void {
    const m = this.media;
    if (!m || m.kind !== 'youtube' || m.id !== msg.mediaId) return;
    const duration = msg.isLive || msg.duration < 1 ? null : Math.round(msg.duration * 1000) / 1000;
    if (msg.isLive === m.isLive && duration === m.duration) return;
    // First report wins; the host's own player may correct it later (it is the one the room trusts most).
    if ((m.duration !== null || m.isLive) && p.info.role !== 'host') return;
    const next: YouTubeMediaDescriptor = { ...m, duration, isLive: msg.isLive };
    this.media = next;
    this.broadcast({ type: 'media', media: next });
    this.scheduleEnd();
    this.events.mediaInfo?.(next);
  }

  /** Same video, more information (subtitles extracted, thumbnails ready): no playback reset. */
  updateMedia(media: MediaDescriptor): void {
    if (!this.media || this.media.id !== media.id) return;
    this.media = media;
    this.broadcast({ type: 'media', media });
  }

  // ------------------------------------------------------------------ playback state machine

  private setPlayback(patch: Partial<PlaybackState>, bumpVersion = true): void {
    this.playback = { ...this.playback, ...patch, version: this.playback.version + (bumpVersion ? 1 : 0) };
    this.broadcast({ type: 'playback', playback: this.playback, serverTime: this.now() });
    this.events.playbackChanged?.(this.playback);
    if (bumpVersion) this.scheduleEnd();
  }

  /** When the timeline reaches the end, the room pauses there (late joiners then see the last frame, not a spinner). */
  private scheduleEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    const pb = this.playback;
    const dur = this.duration();
    if (pb.status !== 'playing' || !Number.isFinite(dur) || dur <= 0) return;
    const ms = Math.max(0, pb.anchor - this.now()) + Math.max(0, (dur - pb.position) / pb.rate) * 1000;
    const version = pb.version;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (this.playback.version !== version || this.playback.status !== 'playing') return;
      this.setPlayback({ status: 'paused', position: dur, anchor: this.now(), action: 'pause', actor: null, waitReason: null, waitingFor: [] });
      this.system('info', 'The video ended', null);
    }, ms + 250);
  }

  /** Length of the current video; Infinity while unknown (a YouTube video before any player reported it, or live). */
  private duration(): number {
    const d = this.media?.duration;
    return d !== null && d !== undefined && d > 0 ? d : Infinity;
  }

  private intent(p: Participant, msg: Extract<ClientMessage, { type: 'intent' }>): void {
    if (!this.media) return this.deny(p, 'No video is loaded yet.');
    if (this.settings.controlMode === 'host' && p.info.role !== 'host') return this.deny(p, 'Only the host can control playback in this room.');
    if (!p.intentBucket.take()) {
      p.socket?.send({ type: 'error', code: 'rate_limited', message: 'Too many playback actions at once.', fatal: false });
      return;
    }
    const now = this.now();
    const dur = this.duration();
    const exp = expectedPosition(this.playback, now, dur);
    const actor = { id: p.info.id, name: p.info.name };
    this.log.debug(`intent ${msg.action}${msg.position !== undefined ? ` @${msg.position.toFixed(2)}` : ''} by ${p.info.name} (room ${this.playback.status} @${exp.toFixed(2)})`);
    switch (msg.action) {
      case 'play': {
        if (this.playback.status === 'playing') return;
        if (this.playback.status === 'waiting' && this.playback.waitReason === 'buffering') {
          // Someone insists on playing while the room waits for a buffering viewer: start now.
          this.system('play', `${p.info.name} resumed without waiting`, p.info.id);
          return this.startNow();
        }
        const at = exp >= dur - 0.5 ? 0 : exp; // pressing play at the end restarts
        this.system('play', `${p.info.name} pressed play`, p.info.id);
        return this.beginStart(actor, at, 'play');
      }
      case 'pause': {
        let pos = msg.position ?? exp;
        pos = this.playback.status === 'playing' ? clamp(pos, exp - 3, exp + 1) : pos;
        pos = clamp(pos, 0, dur);
        this.clearWaitTimers();
        this.setPlayback({ status: 'paused', position: pos, anchor: now, action: 'pause', actor, waitReason: null, waitingFor: [] });
        this.system('pause', `${p.info.name} paused at ${formatTime(pos)}`, p.info.id);
        return;
      }
      case 'seek': {
        if (msg.position === undefined) return;
        if (this.media.kind === 'youtube' && this.media.isLive) return this.deny(p, 'A live stream can\'t be jumped around in.');
        const pos = clamp(msg.position, 0, Math.max(0, dur - 0.25));
        this.queueSeekMessage(p, pos);
        if (this.playback.status === 'paused') {
          this.setPlayback({ position: pos, anchor: now, action: 'seek', actor, waitReason: null, waitingFor: [] });
          return;
        }
        return this.beginStart(actor, pos, 'seek');
      }
      case 'rate': {
        if (msg.rate === undefined || msg.rate === this.playback.rate) return;
        this.setPlayback({ position: exp, anchor: now, rate: msg.rate, action: 'rate', actor });
        this.system('rate', `${p.info.name} set speed to ${msg.rate}×`, p.info.id);
        return;
      }
    }
  }

  /** Participants whose readiness gates a synchronized start. */
  private required(): Participant[] {
    const now = this.now();
    return [...this.participants.values()].filter((p) =>
      p.socket && p.info.connected && p.catchUpUntil <= now
      && p.lastStatus && now - p.lastStatus.at < STATUS_STALE_MS
      && p.info.player !== 'loading' && p.info.player !== 'blocked');
  }

  private beginStart(actor: { id: string; name: string }, position: number, action: 'play' | 'seek'): void {
    this.clearWaitTimers();
    const required = this.required();
    this.log.debug(`start check at ${position.toFixed(2)}s waits for [${required.map((p) => p.info.name).join(', ')}]; excluded [${[...this.participants.values()].filter((p) => !required.includes(p)).map((p) => `${p.info.name}:${p.info.player}${p.socket ? '' : ':offline'}${p.lastStatus ? `:${this.now() - p.lastStatus.at}ms` : ':nostatus'}`).join(', ')}]`);
    this.setPlayback({
      status: 'waiting', position, anchor: this.now(), action, actor, waitReason: 'starting', waitingFor: required.map((p) => p.info.id),
    });
    if (required.length === 0) return this.startNow();
    this.startTimer = setTimeout(() => {
      this.log.debug(`start timeout, not ready: ${this.playback.waitingFor.join(',')}`);
      this.startNow();
    }, SYNC.startTimeoutMs);
  }

  private lead(): number {
    let maxRtt = 0;
    for (const p of this.required()) maxRtt = Math.max(maxRtt, p.info.rtt ?? 200);
    return clamp(maxRtt / 2 + 150, SYNC.minLeadMs, SYNC.maxLeadMs);
  }

  private startNow(): void {
    this.clearWaitTimers();
    if (!this.media) return;
    const resumed = this.playback.waitReason === 'buffering';
    this.setPlayback({
      status: 'playing', position: this.playback.position, anchor: this.now() + this.lead(),
      action: resumed ? 'resume' : this.playback.action, waitReason: null, waitingFor: [],
    });
  }

  private ready(p: Participant, version: number, isReady: boolean): void {
    if (this.playback.status !== 'waiting' || version !== this.playback.version || !isReady) return;
    if (!this.playback.waitingFor.includes(p.info.id)) return;
    this.log.debug(`ready: ${p.info.name} (v${version})`);
    const waitingFor = this.playback.waitingFor.filter((id) => id !== p.info.id);
    if (waitingFor.length === 0) return this.startNow();
    this.setPlayback({ waitingFor }, false);
  }

  private dropFromWait(id: string): void {
    if (this.playback.status !== 'waiting' || !this.playback.waitingFor.includes(id)) return;
    const waitingFor = this.playback.waitingFor.filter((x) => x !== id);
    if (waitingFor.length === 0) this.startNow();
    else this.setPlayback({ waitingFor }, false);
  }

  private clearWaitTimers(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.bufferTimer) clearTimeout(this.bufferTimer);
    this.startTimer = null;
    this.bufferTimer = null;
  }

  private clearStall(p: Participant): void {
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = null;
  }

  /** Relays WebRTC signalling between two people in this room, or hands it to the host's peer. */
  private rtc(p: Participant, msg: RtcMessage): void {
    if (!this.settings.p2p || !p.rtcBucket.take()) return;
    if (msg.to === P2P.hostPeer) {
      if (p.info.role !== 'host') this.events.rtcToHost?.(p, msg);
      return;
    }
    // Viewer to viewer only: receivers can then accept an offer from someone they haven't heard about yet.
    const target = this.participants.get(msg.to);
    if (p.info.role === 'host' || !target || target === p || !target.socket || target.info.role === 'host') return;
    target.socket.send({ type: 'rtc', from: p.info.id, ...(msg.sdp ? { sdp: msg.sdp } : {}), ...(msg.candidate ? { candidate: msg.candidate } : {}) });
  }

  /** Sends signalling from the host's peer to a participant. */
  sendRtc(participantId: string, payload: Omit<Extract<ServerMessage, { type: 'rtc' }>, 'type' | 'from'>): void {
    this.participants.get(participantId)?.socket?.send({ type: 'rtc', from: P2P.hostPeer, ...payload });
  }

  /** True while this participant is in the room with an open connection. */
  isConnected(participantId: string): boolean {
    return Boolean(this.participants.get(participantId)?.socket);
  }

  private status(p: Participant, msg: StatusMessage): void {
    // Byte counters change constantly; tell the room when the route changes or a counter moves by a megabyte.
    const p2pKey = () => {
      const d = p.info.p2p;
      return d ? `${d.host}|${d.peers}|${Math.floor(d.fromHost / 1e6)}|${Math.floor(d.fromPeers / 1e6)}|${Math.floor(d.fromLink / 1e6)}` : '';
    };
    const p2pBefore = p2pKey();
    if (msg.p2p !== undefined) p.info.p2p = msg.p2p;
    const p2pChanged = p2pBefore !== p2pKey();
    const before = `${p.info.player}|${p.info.quality}`;
    p.lastStatus = { ...msg, at: this.now() };
    p.info.player = msg.player;
    p.info.quality = msg.quality;
    const rttChanged = msg.rtt !== null && Math.abs((p.info.rtt ?? 0) - msg.rtt) > 25;
    if (msg.rtt !== null) p.info.rtt = Math.round(msg.rtt);
    if (before !== `${p.info.player}|${p.info.quality}` || rttChanged || p2pChanged) this.queueParticipants();

    if (msg.player !== 'buffering') {
      p.bufferingSince = null;
      this.clearStall(p);
      return;
    }
    if (this.playback.status !== 'playing' || this.settings.bufferingPolicy !== 'wait') return;
    if (p.catchUpUntil > this.now() || p.bufferingSince !== null) return;
    p.bufferingSince = this.now();
    p.stallTimer = setTimeout(() => this.stallCheck(p), SYNC.stallGraceMs);
  }

  private stallCheck(p: Participant): void {
    p.stallTimer = null;
    if (p.bufferingSince === null || this.playback.status !== 'playing' || !p.socket || !this.media) return;
    const now = this.now();
    const exp = expectedPosition(this.playback, now, this.duration());
    if (exp >= this.duration() - 1) return; // the video is ending anyway
    const pos = clamp(p.lastStatus?.position ?? exp, Math.max(0, exp - 5), exp);
    const required = this.required();
    this.log.info(`holding room for buffering viewer "${p.info.name}"`);
    this.setPlayback({
      status: 'waiting', position: pos, anchor: now, action: 'wait', actor: { id: p.info.id, name: p.info.name },
      waitReason: 'buffering', waitingFor: required.map((x) => x.info.id),
    });
    this.bufferTimer = setTimeout(() => {
      // Waited long enough: continue, and stop letting the slow viewers hold the room for a while.
      for (const id of this.playback.waitingFor) {
        const slow = this.participants.get(id);
        if (slow) slow.catchUpUntil = this.now() + SYNC.catchUpExclusionMs;
      }
      this.startNow();
    }, SYNC.bufferWaitMaxMs);
  }

  // ------------------------------------------------------------------ settings

  private applySettings(patch: SettingsMessage['patch'], by = this.hostName): void {
    const s = this.settings;
    const notes: string[] = [];
    if (patch.controlMode && patch.controlMode !== s.controlMode) {
      s.controlMode = patch.controlMode;
      notes.push(s.controlMode === 'host' ? `${by} made playback controls host-only` : `${by} gave everyone playback controls`);
    }
    if (patch.bufferingPolicy && patch.bufferingPolicy !== s.bufferingPolicy) {
      s.bufferingPolicy = patch.bufferingPolicy;
      notes.push(s.bufferingPolicy === 'wait' ? 'The room now waits for anyone who is buffering' : 'The room no longer waits for people who are buffering');
    }
    if (patch.locked !== undefined && patch.locked !== s.locked) {
      s.locked = patch.locked;
      notes.push(s.locked ? `${by} locked the room` : `${by} unlocked the room`);
    }
    if (patch.maxParticipants !== undefined) s.maxParticipants = patch.maxParticipants;
    if (patch.p2p !== undefined && patch.p2p !== s.p2p) {
      s.p2p = patch.p2p;
      notes.push(s.p2p ? `${by} turned on direct connections` : `${by} turned off direct connections; video now comes through the link only`);
    }
    if (patch.password !== undefined) {
      const had = s.passwordHash !== null;
      s.passwordHash = patch.password ? hashPassword(patch.password) : null;
      s.passwordRequired = Boolean(patch.password);
      if (patch.password) notes.push(`${by} ${had ? 'changed' : 'set'} a room password`);
      else if (had) notes.push(`${by} removed the room password`);
    }
    for (const n of notes) this.system('settings', n, null);
    this.broadcast({ type: 'settings', settings: this.publicSettings() });
    this.events.settingsChanged?.(this.publicSettings());
  }

  // ------------------------------------------------------------------ names, typing

  rename(p: Participant, raw: string): void {
    const clean = sanitizeName(raw);
    if (clean.length < LIMITS.nameMin || clean === p.info.name) return;
    const old = p.info.name;
    p.info.name = this.uniqueName(clean, p.info.id);
    if (p.info.role === 'host') this.hostName = p.info.name;
    this.system('rename', `${old} is now ${p.info.name}`, p.info.id);
    this.queueParticipants();
  }

  private startTyping(p: Participant): void {
    const wasTyping = p.typingTimer !== null;
    if (p.typingTimer) clearTimeout(p.typingTimer);
    // Clients refresh every few seconds while typing; expire on our own if they go quiet.
    p.typingTimer = setTimeout(() => this.stopTyping(p), 6000);
    if (!wasTyping) this.broadcastExcept(p, { type: 'typing', participantId: p.info.id, active: true });
  }

  private stopTyping(p: Participant): void {
    if (!p.typingTimer) return;
    clearTimeout(p.typingTimer);
    p.typingTimer = null;
    this.broadcastExcept(p, { type: 'typing', participantId: p.info.id, active: false });
  }

  private broadcastExcept(except: Participant, msg: ServerMessage): void {
    for (const p of this.participants.values()) if (p !== except) p.socket?.send(msg);
  }

  // ------------------------------------------------------------------ chat

  private chatMessage(
    p: Participant, raw: string, nonce: string, att?: { kind: 'image'; id: string } | { kind: 'sticker'; id: string }, replyToId?: string,
  ): void {
    const text = sanitizeChat(raw);
    let attachment: ChatAttachment | undefined;
    if (att?.kind === 'sticker') attachment = { kind: 'sticker', id: att.id };
    if (att?.kind === 'image') {
      const img = this.images?.get(att.id);
      // Only the uploader can post their image, so ids can't be replayed by others.
      if (!img || img.owner !== p.info.id) return this.deny(p, 'That image is no longer available. Try sending it again.');
      attachment = { kind: 'image', url: `/api/chat/images/${img.id}`, width: img.width, height: img.height };
    }
    if (!text && !attachment) return;
    if (!p.chatBucket.take()) {
      p.socket?.send({ type: 'error', code: 'rate_limited', message: 'You are sending messages too fast.', fatal: false });
      return;
    }
    this.stopTyping(p);
    // Replies quote a snapshot of the original; a reply to a message that has left the history is sent as a plain message.
    const original = replyToId
      ? this.chat.find((m): m is UserChatMessage => m.kind === 'user' && m.id === replyToId)
      : undefined;
    const replyTo: ChatReplyRef | undefined = original && {
      id: original.id, authorId: original.authorId, authorName: original.authorName, authorColor: original.authorColor,
      excerpt: excerpt(original.text, 140), ...(original.attachment ? { attachment: original.attachment.kind } : {}),
    };
    // A YouTube link becomes a card: shown at once with its thumbnail, title and channel filled in when known.
    const link = text ? findYouTubeLink(text) : null;
    const preview: LinkPreview | undefined = link
      ? { kind: 'youtube', videoId: link.videoId, startAt: link.startAt, status: this.events.lookupYouTube ? 'pending' : 'unknown', title: null, author: null }
      : undefined;
    const message: UserChatMessage = {
      kind: 'user', id: randomId(12), seq: ++this.seq, ts: this.now(),
      authorId: p.info.id, authorName: p.info.name, authorColor: p.info.color, text,
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(preview ? { preview } : {}),
    };
    this.pushChat(message, nonce);
    if (preview && this.events.lookupYouTube) void this.fillPreview(message, preview);
  }

  private async fillPreview(message: UserChatMessage, preview: LinkPreview): Promise<void> {
    const info = await this.events.lookupYouTube!(preview.videoId).catch(() => ({ status: 'unknown' as const }));
    if (this.ended || !this.chat.includes(message)) return;
    const filled: LinkPreview = info.status === 'ok'
      ? { ...preview, status: 'ok', title: info.title, author: info.author }
      : { ...preview, status: info.status };
    message.preview = filled;
    this.broadcast({ type: 'chat-preview', messageId: message.id, preview: filled });
  }

  private system(icon: SystemIcon, text: string, actorId: string | null): void {
    this.pushChat({ kind: 'system', id: randomId(12), seq: ++this.seq, ts: this.now(), icon, text, actorId });
  }

  /** Rapid scrubbing produces one chat line ("jumped to …") after the actor settles. */
  private queueSeekMessage(p: Participant, pos: number): void {
    if (this.pendingSeek) {
      clearTimeout(this.pendingSeek.timer);
      if (this.pendingSeek.actorId !== p.info.id) this.system('seek', this.pendingSeek.text, this.pendingSeek.actorId);
    }
    const text = `${p.info.name} jumped to ${formatTime(pos)}`;
    this.pendingSeek = {
      actorId: p.info.id, text,
      timer: setTimeout(() => {
        this.pendingSeek = null;
        this.system('seek', text, p.info.id);
      }, 1200),
    };
  }

  private pushChat(message: ChatMessage, nonce?: string): void {
    this.chat.push(message);
    if (this.chat.length > LIMITS.chatHistory) this.chat.splice(0, this.chat.length - LIMITS.chatHistory);
    this.broadcast({ type: 'chat', message, ...(nonce ? { nonce } : {}) });
  }

  // ------------------------------------------------------------------ broadcast

  broadcast(msg: ServerMessage): void {
    for (const p of this.participants.values()) p.socket?.send(msg);
  }

  /** Coalesce participant list updates (status reports arrive often). */
  private queueParticipants(): void {
    if (this.participantsTimer) return;
    this.participantsTimer = setTimeout(() => {
      this.participantsTimer = null;
      const list = this.participantList();
      this.broadcast({ type: 'participants', participants: list });
      this.events.participantsChanged?.(list);
    }, 150);
  }
}
