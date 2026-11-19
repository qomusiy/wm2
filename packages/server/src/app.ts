import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  parseYouTubeUrl, youtubeThumbnail, youtubeWatchUrl,
  type HostRpc, type HostStatus, type LinkMode, type MediaDescriptor, type RecentVideo, type YouTubeMediaDescriptor,
  localOrigin,
} from '@watchroom/protocol';
import { Gateway } from './http/gateway';
import { buildHttp } from './http/server';
import { detectEncoder, type EncoderDetection } from './media/hwaccel';
import { HostStore } from './library';
import { YouTubeLookup } from './net/youtube';
import { randomId } from './util/ids';
import { inspectFfmpeg, locateFfmpeg, type FfmpegInfo } from './media/ffmpeg';
import { ProbeError } from './media/probe';
import { MediaSession } from './media/session';
import { lanAddresses } from './net/lan';
import { HostPeers } from './net/peers';
import { CloudflareTunnel } from './net/tunnel';
import { ChatImageStore } from './room/images';
import { Room } from './room/room';
import { createLogger, type Logger } from './util/log';
import { initSandbox, sandboxStatus } from './util/sandbox';

export interface ServerOptions {
  /** Loopback port for the host UI and the tunnel (0 = pick a free one). */
  port?: number;
  /** Port used when LAN mode is enabled. */
  lanPort?: number;
  /** Built web client (apps/web/dist). */
  staticDir: string | null;
  /** Writable directory for the segment cache and downloaded tools. */
  dataDir: string;
  /** Where the host's settings, recent videos and posters live (defaults to dataDir). Not a cache: never pruned. */
  stateDir?: string;
  linkMode?: LinkMode;
  customBase?: string | null;
  log?: Logger;
  /** How the host asks YouTube about videos (tests replace it). */
  fetch?: typeof fetch;
}

function defaultMaxJobs(): number {
  const byCpu = Math.floor(cpus().length / 5);
  const byMem = Math.floor((totalmem() / 2 ** 30 - 2) / 1.5);
  return Math.max(1, Math.min(4, byCpu, byMem));
}

export class WatchroomServer extends EventEmitter implements HostRpc {
  readonly room: Room;
  private media: MediaSession | null = null;
  private mediaLoading = false;
  private mediaError: string | null = null;
  private mediaFile: string | null = null;
  private ff: FfmpegInfo | null = null;
  private ffError: string | null = null;
  private encoder: EncoderDetection | null = null;
  private readonly maxJobs = defaultMaxJobs();
  private http!: FastifyInstance;
  private lanServer: Server | null = null;
  /** The same server on the IPv6 loopback address (see listenLoopback6). */
  private loopback6: Server | null = null;
  private readonly gateway: Gateway;
  readonly tunnel: CloudflareTunnel;
  private linkMode: LinkMode;
  private customBase: string | null;
  port = 0;
  private lanPort: number;
  private ready = false;
  private uploadWindow: { t: number; bytes: number }[] = [];
  private readonly viewerUpload = new Map<string, { window: { t: number; bytes: number }[]; total: number }>();
  private uploadHistory: number[] = [];
  readonly images: ChatImageStore;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private openSeq = 0;
  private toolsReady: Promise<void> = Promise.resolve();
  readonly store: HostStore;
  /** Recent-list id of the open video. */
  private currentRecent: string | null = null;
  private recentVersion = 0;
  private ticks = 0;
  readonly peers: HostPeers;
  readonly youtube: YouTubeLookup;

  constructor(private readonly opts: ServerOptions) {
    super();
    this.log = opts.log ?? createLogger('server');
    this.store = new HostStore(opts.stateDir ?? opts.dataDir, this.log.child('store'), opts.dataDir);
    this.linkMode = opts.linkMode ?? this.store.linkMode ?? 'tunnel';
    this.customBase = opts.customBase ?? this.store.customBase;
    this.lanPort = opts.lanPort ?? 47800;
    this.images = new ChatImageStore(join(opts.dataDir, 'chat-images'), this.log.child('images'));
    this.room = new Room(this.log.child('room'), {
      participantsChanged: () => this.queueStatus(),
      settingsChanged: (s) => {
        this.store.setRoomDefaults({ controlMode: s.controlMode, bufferingPolicy: s.bufferingPolicy, maxParticipants: s.maxParticipants, p2p: s.p2p });
        if (!s.p2p) this.peers.closeAll();
      },
      rtcToHost: (p, msg) => this.peers.signal(p.info.id, msg),
      participantGone: (id) => this.peers.close(id),
      openYouTube: async (url, p) => {
        const res = await this.openYouTube(url, { by: p.info.name });
        return res.ok ? { ok: true } : res;
      },
      lookupYouTube: async (videoId) => {
        const r = await this.youtube.lookup(videoId);
        if (r.status === 'ok') return { status: 'ok', ...r.info };
        return { status: r.status === 'unknown' ? 'unknown' : 'unavailable' };
      },
      mediaInfo: (m) => {
        if (this.currentRecent && m.duration) this.store.setDuration(this.currentRecent, m.duration);
        this.queueStatus();
      },
    }, Date.now, this.images);
    this.youtube = new YouTubeLookup(this.log.child('youtube'), opts.fetch);
    this.peers = new HostPeers({
      room: () => this.room,
      media: () => this.media,
      recordUpload: (bytes, pid) => this.recordUpload(bytes, pid),
      log: this.log.child('p2p'),
      allowPrivateCandidates: process.env.WATCHROOM_P2P_LAN === '1',
    });
    this.room.applyDefaults(this.store.roomDefaults);
    this.gateway = new Gateway(() => this.room, this.log.child('ws'));
    this.tunnel = new CloudflareTunnel(join(opts.dataDir, 'bin'), this.log.child('tunnel'));
    this.tunnel.on('status', () => this.queueStatus());
  }

  async start(): Promise<void> {
    this.http = await buildHttp({
      room: () => this.room,
      media: () => this.media,
      recordUpload: (bytes, pid) => this.recordUpload(bytes, pid),
      images: this.images,
      log: this.log.child('http'),
    }, this.opts.staticDir);
    this.http.server.on('upgrade', (req, socket, head) => this.gateway.handleUpgrade(req, socket, head));
    await this.http.listen({ host: '127.0.0.1', port: this.opts.port ?? 0 });
    const addr = this.http.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.log.info(`listening on http://127.0.0.1:${this.port}`);
    await this.listenLoopback6();
    this.ready = true;
    this.statusTimer = setInterval(() => {
      this.uploadHistory = [...this.uploadHistory, this.uploadBps()].slice(-60);
      // Remember where the room is every 10 s, so a crash or power cut loses little.
      if (++this.ticks % 5 === 0) this.saveProgress(false);
      this.queueStatus();
    }, 2000);
    this.statusTimer.unref();
    this.toolsReady = this.initMediaTools();
    await this.applyLinkMode();
    this.queueStatus();
  }

  private async initMediaTools(): Promise<void> {
    const paths = locateFfmpeg();
    if (!paths) {
      this.ffError = process.platform === 'win32'
        ? 'The video tools (ffmpeg) are missing from this installation. Reinstall Watchroom.'
        : 'ffmpeg was not found. Install it with: sudo apt install ffmpeg';
      this.queueStatus();
      return;
    }
    try {
      this.ff = await inspectFfmpeg(paths);
      // Sandbox first: encoder detection then proves hardware encoding works inside it.
      await initSandbox(this.ff.ffmpeg, this.log.child('sandbox'));
      this.encoder = await detectEncoder(this.ff);
    } catch (err) {
      this.ffError = (err as Error).message;
    }
    this.queueStatus();
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.saveProgress(true);
    this.store.save(true);
    this.peers.shutdown();
    this.room.end('The host closed Watchroom.');
    this.gateway.closeAll();
    this.media?.close();
    this.media = null;
    this.tunnel.stop();
    await new Promise<void>((r) => (this.lanServer ? this.lanServer.close(() => r()) : r()));
    if (this.loopback6) {
      this.loopback6.closeAllConnections?.();
      await new Promise<void>((r) => this.loopback6!.close(() => r()));
      this.loopback6 = null;
    }
    await this.http?.close();
  }

  /**
   * Browsers open "localhost" over IPv6 (::1) first. Answer there as well, on the same port: otherwise each new
   * connection waits for the IPv4 fallback (on Windows a refused connection takes a moment). Still loopback only.
   */
  private async listenLoopback6(): Promise<void> {
    const server = createServer((req, res) => this.http.routing(req, res));
    server.on('upgrade', (req, socket, head) => this.gateway.handleUpgrade(req, socket, head));
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen({ port: this.port, host: '::1', ipv6Only: true }, () => resolve(true));
    });
    if (ok) this.loopback6 = server;
    else this.log.debug('IPv6 loopback not available; localhost is served over 127.0.0.1');
  }

  // ------------------------------------------------------------------ host RPC

  hostJoin(): { roomId: string; hostToken: string } {
    return { roomId: this.room.id, hostToken: this.room.hostToken };
  }

  async openVideo(path: string, opts: { fromStart?: boolean } = {}): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }> {
    const seq = ++this.openSeq;
    await this.toolsReady;
    if (!this.ff || !this.encoder) return { ok: false, error: this.ffError ?? 'Video tools are still starting. Try again in a moment.' };
    this.mediaLoading = true;
    this.mediaError = null;
    this.mediaFile = path.split(/[\\/]/).pop() ?? path;
    this.queueStatus();
    try {
      const session = await MediaSession.open(path, {
        ff: this.ff,
        encoder: this.encoder.choice,
        cacheRoot: join(this.opts.dataDir, 'media'),
        maxRunningJobs: this.maxJobs,
        log: this.log.child('media'),
      });
      if (seq !== this.openSeq) {
        session.close();
        return { ok: false, error: 'Another video was opened.' };
      }
      this.saveProgress(true);
      this.media?.close();
      this.media = session;
      session.on('status', () => this.queueStatus());
      session.on('update', () => {
        if (this.media === session) {
          this.room.updateMedia(session.descriptor());
          this.queueStatus();
        }
      });
      this.mediaLoading = false;
      const descriptor = session.descriptor();
      let resumeAt = 0;
      try {
        const rec = this.store.opened(path, { title: descriptor.title, duration: descriptor.duration });
        this.currentRecent = rec.entry.id;
        resumeAt = opts.fromStart ? 0 : rec.resumeAt;
        if (!this.store.hasPoster(rec.entry.id)) {
          void session.writePoster(this.store.posterPath(rec.entry.id)).then((ok) => { if (ok) this.recentChanged(); });
        }
      } catch (err) {
        this.currentRecent = null;
        this.log.warn('could not record the recent video', err);
      }
      this.room.setMedia(descriptor, undefined, resumeAt);
      this.recentChanged();
      return { ok: true, media: descriptor };
    } catch (err) {
      const message = err instanceof ProbeError ? err.userMessage : `Could not open the video: ${(err as Error).message}`;
      this.log.warn(`open failed for ${path}`, err);
      if (seq === this.openSeq) {
        this.mediaLoading = false;
        this.mediaError = message;
        this.queueStatus();
      }
      return { ok: false, error: message };
    }
  }

  closeVideo(): void {
    this.openSeq++;
    this.saveProgress(true);
    this.currentRecent = null;
    this.recentChanged();
    this.media?.close();
    this.media = null;
    this.mediaFile = null;
    this.mediaError = null;
    this.mediaLoading = false;
    this.room.setMedia(null);
    this.images.clear();
    this.queueStatus();
  }

  async addSubtitle(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.media) return { ok: false, error: 'Open a video first.' };
    try {
      await this.media.subtitles.addExternal(path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Switches the room to a YouTube video. Everyone's browser then plays it from YouTube itself (official embedded
   * player); this computer only checks the link and keeps the room in sync. No upload, no transcoding.
   */
  async openYouTube(url: string, opts: { by?: string; fromStart?: boolean } = {}): Promise<{ ok: true; media: YouTubeMediaDescriptor } | { ok: false; error: string }> {
    const ref = parseYouTubeUrl(url);
    if (!ref) return { ok: false, error: 'That is not a YouTube video link.' };
    const seq = ++this.openSeq;
    const look = await this.youtube.lookup(ref.videoId);
    if (seq !== this.openSeq) return { ok: false, error: 'Another video was opened in the meantime.' };
    if (look.status === 'not-found') return { ok: false, error: 'That YouTube video does not exist, or it is private.' };
    if (look.status === 'unavailable') {
      return { ok: false, error: 'The owner of this video does not allow playing it outside YouTube (or it is private or age-restricted).' };
    }
    // "unknown": YouTube didn't answer this computer; viewers' players may still manage, and they report problems.
    const title = look.status === 'ok' ? look.info.title : 'YouTube video';
    const author = look.status === 'ok' ? look.info.author : null;
    this.saveProgress(true);
    this.media?.close();
    this.media = null;
    this.mediaLoading = false;
    this.mediaError = null;
    this.mediaFile = title;
    let resumeAt = 0;
    // Watched before: its length is already known (the players report it again anyway).
    let knownDuration: number | null = null;
    try {
      const rec = this.store.openedYouTube({ videoId: ref.videoId, title, author });
      this.currentRecent = rec.entry.id;
      resumeAt = opts.fromStart ? 0 : rec.resumeAt;
      knownDuration = rec.entry.duration > 0 ? rec.entry.duration : null;
      if (!this.store.hasPoster(rec.entry.id)) void this.saveYouTubePoster(rec.entry.id, ref.videoId);
    } catch (err) {
      this.currentRecent = null;
      this.log.warn('could not record the recent video', err);
    }
    const media: YouTubeMediaDescriptor = {
      kind: 'youtube', id: randomId(12), videoId: ref.videoId, title, author, duration: knownDuration, isLive: false,
      thumbnail: youtubeThumbnail(ref.videoId, 'hq'), sourceSummary: author ? `YouTube · ${author}` : 'YouTube',
    };
    const fromLink = ref.startAt > 0;
    this.room.setMedia(media, opts.by, fromLink ? ref.startAt : resumeAt, fromLink ? 'link' : 'resume');
    this.recentChanged();
    this.log.info(`opened YouTube video ${ref.videoId}${opts.by ? ` (by ${opts.by})` : ''}`);
    return { ok: true, media };
  }

  private async saveYouTubePoster(recentEntryId: string, videoId: string): Promise<void> {
    const jpeg = await this.youtube.thumbnail(videoId);
    if (!jpeg) return;
    try {
      const path = this.store.posterPath(recentEntryId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, jpeg);
      this.recentChanged();
    } catch (err) {
      this.log.debug('could not save the YouTube thumbnail', err);
    }
  }

  // ------------------------------------------------------------------ recent videos (host IPC only)

  listRecent(): Promise<RecentVideo[]> {
    return this.store.describe(this.currentRecent);
  }

  async openRecent(id: string, fromStart: boolean): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }> {
    const entry = typeof id === 'string' ? this.store.get(id) : undefined;
    if (!entry) return { ok: false, error: 'That video is no longer on the list.' };
    if (entry.kind === 'youtube' && entry.videoId) return this.openYouTube(youtubeWatchUrl(entry.videoId), { fromStart: Boolean(fromStart) });
    return this.openVideo(entry.path, { fromStart: Boolean(fromStart) });
  }

  removeRecent(id: string | null): void {
    if (id !== null && typeof id !== 'string') return;
    this.store.remove(id);
    this.recentChanged();
  }

  private saveProgress(flush: boolean): void {
    const m = this.room.media;
    // A live stream has no position to come back to.
    if (!this.currentRecent || !m || (m.kind === 'youtube' && m.isLive)) return;
    this.store.progress(this.currentRecent, this.room.currentPosition(), flush);
  }

  private recentChanged(): void {
    this.recentVersion++;
    this.queueStatus();
  }

  async setLinkMode(mode: LinkMode, customBase?: string | null): Promise<void> {
    if (mode === 'custom') {
      const base = (customBase ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/i.test(base)) throw new Error('Enter an address like https://example.com');
      this.customBase = base;
    }
    this.linkMode = mode;
    await this.applyLinkMode();
    this.store.setLink(this.linkMode, this.customBase);
    this.queueStatus();
  }

  async retryTunnel(): Promise<void> {
    if (this.linkMode === 'tunnel') await this.tunnel.restart();
  }

  regenerateLink(): string | null {
    this.room.regenerateKey();
    this.queueStatus();
    return this.shareUrl();
  }

  private async applyLinkMode(): Promise<void> {
    if (this.linkMode === 'tunnel') void this.tunnel.start(this.port);
    else this.tunnel.stop();
    const wantLan = this.linkMode === 'lan' || this.linkMode === 'custom';
    if (wantLan && !this.lanServer) {
      await this.http.ready();
      const server = createServer((req, res) => this.http.routing(req, res));
      server.on('upgrade', (req, socket, head) => this.gateway.handleUpgrade(req, socket, head));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.lanPort, '0.0.0.0', () => resolve());
      }).catch((err) => {
        this.log.error(`could not listen on port ${this.lanPort}`, err);
        throw new Error(`Port ${this.lanPort} is already in use.`);
      });
      this.lanServer = server;
      this.log.info(`LAN access enabled on port ${this.lanPort}`);
    } else if (!wantLan && this.lanServer) {
      const s = this.lanServer;
      this.lanServer = null;
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private joinPath(): string {
    return `/join/${this.room.id}#${this.room.key}`;
  }

  shareUrl(): string | null {
    if (this.linkMode === 'tunnel') return this.tunnel.status.state === 'online' && this.tunnel.status.url ? this.tunnel.status.url + this.joinPath() : null;
    if (this.linkMode === 'custom') return this.customBase ? this.customBase + this.joinPath() : null;
    if (this.linkMode === 'lan') {
      const first = lanAddresses()[0];
      return first ? `http://${first.address}:${this.lanPort}${this.joinPath()}` : null;
    }
    return `${localOrigin(this.port)}${this.joinPath()}`;
  }

  // ------------------------------------------------------------------ status

  private recordUpload(bytes: number, participantId: string): void {
    const t = Date.now();
    const add = (win: { t: number; bytes: number }[]) => {
      const last = win[win.length - 1];
      if (last && t - last.t < 250) last.bytes += bytes;
      else win.push({ t, bytes });
    };
    add(this.uploadWindow);
    let v = this.viewerUpload.get(participantId);
    if (!v) {
      v = { window: [], total: 0 };
      this.viewerUpload.set(participantId, v);
    }
    add(v.window);
    v.total += bytes;
  }

  private perViewer(): Record<string, { bps: number; bytes: number }> {
    const t = Date.now();
    const out: Record<string, { bps: number; bytes: number }> = {};
    const present = new Set(this.room.participantList().map((p) => p.id));
    for (const [id, v] of this.viewerUpload) {
      if (!present.has(id)) {
        this.viewerUpload.delete(id);
        continue;
      }
      v.window = v.window.filter((x) => t - x.t < 5000);
      out[id] = { bps: Math.round((v.window.reduce((a, x) => a + x.bytes, 0) * 8) / 5), bytes: v.total };
    }
    return out;
  }

  private uploadBps(): number {
    const t = Date.now();
    this.uploadWindow = this.uploadWindow.filter((x) => t - x.t < 5000);
    const total = this.uploadWindow.reduce((a, x) => a + x.bytes, 0);
    return Math.round((total * 8) / 5);
  }

  getStatus(): HostStatus {
    const ms = this.media?.status;
    const sched = this.media?.scheduler.stats();
    const participants = this.room.participantList();
    return {
      ready: this.ready,
      system: {
        ffmpeg: this.ff ? { ok: true, version: this.ff.version } : this.ffError ? { ok: false, error: this.ffError } : null,
        encoder: this.encoder?.label ?? null,
        maxJobs: this.maxJobs,
        sandbox: sandboxStatus(),
      },
      link: {
        mode: this.linkMode,
        shareUrl: this.shareUrl(),
        localUrl: `${localOrigin(this.port)}${this.joinPath()}`,
        lanUrls: this.lanServer ? lanAddresses().map((a) => ({ label: a.label, url: `http://${a.address}:${this.lanPort}${this.joinPath()}` })) : [],
        customBase: this.customBase,
        tunnel: { ...this.tunnel.status },
      },
      media: {
        loading: this.mediaLoading,
        error: this.mediaError,
        fileName: this.mediaFile,
        // What the room is showing (a file being streamed, or a YouTube video).
        descriptor: this.room.media,
        indexing: ms?.indexing ?? false,
        indexProgress: ms?.indexProgress ?? 0,
        copyAvailable: ms?.copyAvailable ?? null,
        copyReason: ms?.copyReason ?? null,
      },
      recentVersion: this.recentVersion,
      stats: {
        uploadBps: this.uploadBps(),
        uploadHistory: this.uploadHistory,
        perViewer: this.perViewer(),
        viewers: participants.filter((p) => p.role !== 'host' && p.connected).length,
        runningJobs: sched?.running ?? 0,
        pausedJobs: sched?.paused ?? 0,
        directConnections: this.peers.connectedCount(),
        directAvailable: this.peers.available,
      },
      participants,
    };
  }

  private statusQueued = false;
  private queueStatus(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    setTimeout(() => {
      this.statusQueued = false;
      this.emit('status', this.getStatus());
    }, 100);
  }
}
