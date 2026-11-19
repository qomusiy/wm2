import { SYNC, YOUTUBE_SYNC, clamp, driftCorrection, expectedPosition, quantizeRate, type PlaybackState } from '@watchroom/protocol';
import { localNow, type RoomConnection } from '../lib/connection';
import { toast, useRoom, type SyncState } from '../state/room';
import { activeSwarm } from '../p2p/swarm';
import type { MediaSurface } from './surface';

export function bufferedAhead(v: HTMLVideoElement): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.25 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
  }
  return 0;
}

export interface SyncOptions {
  /** Length of the video in seconds (Infinity while unknown). */
  duration(): number;
  /** A live stream: only play/pause are shared (everyone watches the live edge). */
  live?(): boolean;
  /** May this viewer control playback right now (false when the host made it host-only)? */
  canControl?(): boolean;
  /** Told when a viewer tried to control a locked room from inside the YouTube frame. */
  onLocked?(): void;
}

/**
 * Makes the local media surface (<video> or YouTube's player) follow the room timeline. The surface only *renders*
 * room state: user actions become intents sent to the server, never inferred from media events, so nothing echoes.
 * (The one exception: a click inside YouTube's frame toggles its playback directly; that is detected and turned
 * into the same intent.)
 */
export class SyncController {
  private applied: PlaybackState | null = null;
  private correcting = false;
  private startTimer: number | null = null;
  private readonly loopTimer: number;
  private readonly statusTimer: number;
  private buffering = false;
  private bufferingTimer: number | null = null;
  private readySent = -1;
  private lastHardSeek = -Infinity;
  /** The viewer paused inside YouTube's frame: don't restart the player while the room takes that in. */
  private holdUntil = 0;
  private lastStatusKey = '';
  private readonly cleanup: (() => void)[] = [];
  blocked = false;
  mutedByPolicy = false;
  private onFlags: (() => void) | null = null;

  constructor(
    private readonly media: MediaSurface,
    private readonly conn: RoomConnection,
    private readonly opts: SyncOptions,
  ) {
    const m = media;
    const on = (type: Parameters<MediaSurface['on']>[0], fn: () => void) => this.cleanup.push(m.on(type, fn));
    on('waiting', () => this.setBuffering(true));
    on('playing', () => {
      this.setBuffering(false);
      // Started after all (e.g. the viewer tapped YouTube's own play button where the browser wanted a tap).
      if (this.blocked) {
        this.blocked = false;
        this.onFlags?.();
        this.report(false);
      }
    });
    on('canplay', () => { this.setBuffering(false); this.checkReady(); });
    on('seeked', () => this.checkReady());
    on('progress', () => this.checkReady());
    on('ratechange', () => {
      // Some players reset the rate on source changes; keep the room rate.
      if (this.applied && !this.correcting && Math.abs(m.playbackRate - this.applied.rate) > 0.001) m.playbackRate = this.applied.rate;
    });
    on('userpause', () => this.userToggled('pause'));
    on('userplay', () => this.userToggled('play'));
    on('change', () => {
      if (m.ready) this.apply();
      this.report(false);
    });
    this.cleanup.push(useRoom.subscribe((s, prev) => {
      if (s.playback && s.playback !== prev.playback) this.onPlayback(s.playback);
    }));
    this.loopTimer = window.setInterval(() => this.tick(), 250);
    this.statusTimer = window.setInterval(() => this.report(true), 2000);
    const pb = useRoom.getState().playback;
    if (pb) this.onPlayback(pb);
  }

  onFlagsChange(cb: () => void): void {
    this.onFlags = cb;
  }

  destroy(): void {
    window.clearInterval(this.loopTimer);
    window.clearInterval(this.statusTimer);
    this.clearStart();
    if (this.bufferingTimer) window.clearTimeout(this.bufferingTimer);
    for (const c of this.cleanup) c();
  }

  // ---------------------------------------------------------------- applying room state

  private onPlayback(state: PlaybackState): void {
    const sameVersion = this.applied?.version === state.version;
    this.applied = state;
    if (sameVersion) return; // only `waitingFor` changed
    this.readySent = -1;
    this.holdUntil = 0;
    this.apply();
  }

  private get duration(): number {
    return this.opts.duration();
  }

  private get live(): boolean {
    return this.opts.live?.() ?? false;
  }

  private apply(): void {
    const s = this.applied;
    const v = this.media;
    if (!s || !v.ready) return;
    this.clearStart();
    this.correcting = false;
    v.playbackRate = s.rate;
    if (this.live) {
      // A live stream: everyone watches the live edge; only play/pause are shared.
      if (s.status === 'playing') this.play();
      else if (!v.paused) v.pause();
      this.setSync(s.status === 'playing' ? 'synced' : s.status === 'waiting' ? 'waiting' : 'paused', null);
      this.checkReady();
      return;
    }
    if (s.status !== 'playing') {
      if (!v.paused) v.pause();
      this.seekTo(s.position, 0.04);
      this.setSync(s.status === 'waiting' ? 'waiting' : 'paused', null);
      this.checkReady();
      return;
    }
    if (this.conn.clock.sampleCount === 0) return; // tick() applies once the clock is known
    const now = this.conn.serverNow();
    if (now < s.anchor - 15) {
      // Scheduled start: be at the start frame, then begin at the same instant as everyone else.
      if (!v.paused) v.pause();
      this.seekTo(s.position, 0.04);
      const latency = v.kind === 'youtube' ? YOUTUBE_SYNC.startLatencyMs : 0;
      const delay = this.conn.clock.toLocal(s.anchor) - localNow() - latency;
      this.startTimer = window.setTimeout(() => {
        this.startTimer = null;
        this.startPlayback();
      }, Math.max(0, delay));
      this.setSync('waiting', null);
    } else {
      this.startPlayback();
    }
  }

  private startPlayback(): void {
    const s = this.applied;
    if (!s || s.status !== 'playing') return;
    if (!this.live) {
      const target = expectedPosition(s, this.conn.serverNow() + 50, this.duration);
      if (Math.abs(this.media.currentTime - target) > 0.25) this.seekTo(target, 0);
    }
    this.play();
  }

  private play(): void {
    const v = this.media;
    const p = v.play();
    if (!p) return;
    p.then(() => {
      if (this.blocked) {
        this.blocked = false;
        this.onFlags?.();
        this.report(false);
      }
    }).catch((err: DOMException) => {
      if (err.name !== 'NotAllowedError') return; // AbortError: interrupted by a pause/seek, harmless
      if (!v.muted) {
        // Browsers allow muted autoplay: stay in sync silently and ask for one tap to unmute.
        v.muted = true;
        this.mutedByPolicy = true;
        this.onFlags?.();
        v.play().catch(() => {
          this.blocked = true;
          this.onFlags?.();
          this.report(false);
        });
      } else {
        this.blocked = true;
        this.onFlags?.();
        this.report(false);
      }
    });
  }

  private seekTo(t: number, tolerance: number): void {
    const target = clamp(t, 0, Math.max(0, this.duration - 0.05));
    if (Math.abs(this.media.currentTime - target) > tolerance) this.media.seek(target);
  }

  private clearStart(): void {
    if (this.startTimer) window.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  // ---------------------------------------------------------------- continuous correction

  private tick(): void {
    const s = this.applied;
    const v = this.media;
    if (!s || !v.ready) return;
    if (s.status !== 'playing') {
      this.checkReady();
      return;
    }
    if (this.conn.clock.sampleCount === 0) return;
    const now = this.conn.serverNow();
    if (now < s.anchor || this.startTimer) return;
    if (this.blocked) {
      this.setSync('blocked', null);
      return;
    }
    if (this.live) {
      if (v.paused) this.play();
      this.setSync(this.buffering ? 'buffering' : 'synced', null);
      return;
    }
    const expected = expectedPosition(s, now, this.duration);
    if (v.ended || expected >= this.duration - 0.1) {
      this.setSync('synced', null);
      return;
    }
    if (v.paused) {
      if (localNow() < this.holdUntil) return;
      // Paused by the OS/browser (e.g. a phone call), or first apply happened before the clock was known.
      this.startPlayback();
      return;
    }
    if (v.seeking || this.buffering) {
      this.setSync(this.buffering ? 'buffering' : 'seeking', null);
      return;
    }
    const drift = v.currentTime - expected;
    const yt = v.kind === 'youtube';
    const action = driftCorrection(drift, s.rate, this.correcting, yt ? YOUTUBE_SYNC : SYNC);
    if (action.kind === 'seek') {
      if (localNow() - this.lastHardSeek < (yt ? YOUTUBE_SYNC.seekCooldownMs : 2500)) return; // let the last seek settle
      this.lastHardSeek = localNow();
      this.correcting = false;
      v.playbackRate = s.rate;
      const lead = v.isBuffered(expected) ? (yt ? 0.15 : 0.06) : yt ? 0.6 : 0.4;
      this.seekTo(expected + lead * s.rate, 0);
      this.setSync('seeking', drift);
      return;
    }
    const rate = quantizeRate(Math.round(action.rate * 100) / 100, s.rate, v.rateStep);
    if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
    this.correcting = action.correcting;
    this.setSync(action.correcting ? 'correcting' : 'synced', drift);
  }

  private checkReady(): void {
    const s = this.applied;
    const v = this.media;
    if (!s || s.status !== 'waiting' || this.readySent === s.version || !v.ready) return;
    if (!this.live && (v.seeking || Math.abs(v.currentTime - s.position) > 0.3)) return;
    const remaining = this.duration - v.currentTime;
    if (v.readyState >= 3 || v.bufferedAhead() >= Math.min(2, remaining - 0.1)) {
      if (this.conn.send({ type: 'ready', version: s.version, ready: true })) this.readySent = s.version;
    }
  }

  private setBuffering(on: boolean): void {
    if (on) {
      if (this.buffering || this.bufferingTimer) return;
      // Ignore micro-stalls.
      this.bufferingTimer = window.setTimeout(() => {
        this.bufferingTimer = null;
        if (this.media.readyState >= 3 && !this.media.seeking) return;
        this.buffering = true;
        this.report(false);
      }, 400);
    } else {
      if (this.bufferingTimer) window.clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
      if (!this.buffering) return;
      this.buffering = false;
      this.report(false);
    }
  }

  private setSync(state: SyncState, drift: number | null): void {
    const cur = useRoom.getState().sync;
    const d = drift === null ? null : Math.round(drift * 1000) / 1000;
    if (cur.state === state && (cur.drift === null ? d === null : d !== null && Math.abs(cur.drift - d) < 0.02)) return;
    useRoom.setState({ sync: { state, drift: d } });
  }

  /** Tell the room what this viewer is doing (drives readiness, buffering holds and the people list). */
  report(force: boolean): void {
    const v = this.media;
    const s = this.applied;
    const player = !v.ready ? 'loading'
      : this.blocked ? 'blocked'
        : this.buffering && s?.status === 'playing' ? 'buffering'
          : v.paused ? 'paused' : 'playing';
    const quality = v.qualityLabel();
    const key = `${player}|${quality}`;
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.conn.send({
      type: 'status', player, position: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      bufferAhead: Math.min(1e5, v.bufferedAhead()), quality, rtt: this.conn.clock.rtt, p2p: activeSwarm()?.report() ?? null,
    });
    useRoom.setState({ player: { quality, auto: v.autoQuality } });
  }

  // ---------------------------------------------------------------- user intents

  private intent(action: 'play' | 'pause' | 'seek' | 'rate', extra: { position?: number; rate?: number } = {}): boolean {
    const version = this.applied?.version ?? 0;
    const ok = this.conn.send({ type: 'intent', action, version, ...extra });
    if (!ok) toast('warning', 'Not connected right now. Reconnecting…');
    return ok;
  }

  /** Must be called from a user gesture (it also unlocks media playback on mobile). */
  requestPlay(): void {
    const v = this.media;
    if (this.blocked || this.mutedByPolicy) this.unlock();
    else if (v.paused && v.kind === 'file') {
      // Prime the element inside the gesture, then let the room decide when to really start.
      void v.play().then(() => {
        if (this.applied?.status !== 'playing') v.pause();
      }).catch(() => {});
    }
    if (this.intent('play')) this.setSync('waiting', null);
  }

  requestPause(): void {
    const v = this.media;
    if (!v.paused) v.pause();
    this.clearStart();
    this.intent('pause', this.live ? {} : { position: v.currentTime });
  }

  /** The viewer clicked play/pause inside YouTube's own frame. */
  private userToggled(kind: 'play' | 'pause'): void {
    const s = this.applied;
    if (!s) return;
    if (!(this.opts.canControl?.() ?? true)) {
      this.opts.onLocked?.(); // host-only room: say why it is undone
    } else if (kind === 'pause' && s.status !== 'paused') {
      this.clearStart();
      if (this.intent('pause', this.live ? {} : { position: this.media.currentTime })) this.holdUntil = localNow() + 1500;
      return;
    } else if (kind === 'play' && s.status === 'paused') {
      if (this.intent('play')) this.setSync('waiting', null);
      return;
    }
    // Nothing for the room to do (or not allowed): the player goes back to what the room is doing.
    if (s.status === 'playing') this.startPlayback();
    else if (!this.media.paused) this.media.pause();
  }

  togglePlay(): void {
    const s = this.applied;
    if (!s || s.status === 'paused') this.requestPlay();
    else this.requestPause();
  }

  requestSeek(t: number): void {
    if (this.live) return;
    const target = clamp(t, 0, Math.max(0, this.duration - 0.25));
    this.seekTo(target, 0);
    this.intent('seek', { position: target });
  }

  requestRate(rate: number): void {
    this.intent('rate', { rate });
  }

  /** User tapped "unmute" or "tap to sync". */
  unlock(): void {
    const v = this.media;
    if (this.mutedByPolicy) {
      v.muted = false;
      this.mutedByPolicy = false;
    }
    if (this.blocked) {
      this.blocked = false;
      if (this.applied?.status === 'playing') this.startPlayback();
      else if (v.kind === 'file') void v.play().then(() => v.pause()).catch(() => {});
    }
    this.onFlags?.();
    this.report(false);
  }

  /** Current timeline status for the UI. */
  get state(): PlaybackState | null {
    return this.applied;
  }

  expectedNow(): number {
    const s = this.applied;
    return s ? expectedPosition(s, this.conn.serverNow(), this.duration) : 0;
  }

  get syncConstants(): typeof SYNC {
    return SYNC;
  }
}
