import { P2P, type ParticipantP2P, type ServerMessage } from '@watchroom/protocol';
import type { RoomConnection } from '../lib/connection';
import { local } from '../lib/storage';
import { useRoom } from '../state/room';
import { SegmentCache, cacheBudget } from './cache';
import { PeerError, PeerLink, type LinkSignal } from './link';

export type Source = 'cache' | 'peer' | 'host' | 'link';

export interface FetchContext {
  signal: AbortSignal;
  /** Seconds of video already buffered ahead of the playhead (how much time we have). */
  bufferAhead: number;
  /** Length of the segment in seconds. */
  fragDuration: number;
}

let current: PeerSwarm | null = null;
/** The swarm, when direct delivery is on for this viewer right now. */
export const activeSwarm = (): PeerSwarm | null => (current?.enabled ? current : null);

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const VIDEO_SIZED = 200 * 1024;

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Direct delivery for one viewer. Keeps a connection to the host's computer and to other viewers, and fetches each
 * segment from the best place: our own cache, a viewer who already has it (verified against the host's fingerprint),
 * the host directly, or (by returning null) the normal link. Recently played segments are kept in memory and
 * offered to the other viewers, so the host uploads each segment fewer times.
 */
export class PeerSwarm {
  readonly cache: SegmentCache;
  private host: PeerLink | null = null;
  private hostState: ParticipantP2P['host'] = 'off';
  private hostAttempts = 0;
  private hostRetryAt = 0;
  private hostStrikes = 0;
  private hostBenchUntil = 0;
  private readonly guests = new Map<string, PeerLink>();
  private readonly guestRetryAt = new Map<string, number>();
  private readonly banned = new Set<string>();
  private readonly stats = { fromHost: 0, fromPeers: 0, fromLink: 0 };
  private readonly ewma = { host: 0, link: 0 };
  private readonly samples = { host: 0, link: 0 };
  private requests = 0;
  private mediaId: string | null = null;
  private announceQueue: string[] = [];
  private announceTimer: number | null = null;
  private reconcileQueued = false;
  private retryTimer: number | null = null;
  private destroyed = false;
  private readonly unsub: (() => void)[] = [];
  private readonly iceServers: RTCIceServer[] = [{ urls: [...P2P.stun] }];

  constructor(private readonly conn: RoomConnection) {
    this.cache = new SegmentCache(cacheBudget(), (keys) => this.broadcastLost(keys));
    this.unsub.push(conn.on((m) => { if (m.type === 'rtc') this.onSignal(m); }));
    this.unsub.push(useRoom.subscribe(() => this.queueReconcile()));
    current = this;
    // Read-only summary for troubleshooting from the browser console: __watchroomP2P()
    (window as unknown as { __watchroomP2P?: () => unknown }).__watchroomP2P = () => this.debug();
    this.queueReconcile();
  }

  debug(): unknown {
    return {
      enabled: this.enabled, host: this.hostState, hostLink: this.host?.state ?? null, ewma: this.ewma, samples: this.samples,
      cache: { segments: this.cache.keys().length, mb: Math.round(this.cache.bytes / 1e5) / 10 }, stats: this.stats,
      guests: [...this.guests.values()].map((l) => ({ id: l.remoteId, state: l.state, has: l.remoteHave.size, rate: l.rate, failures: l.failures })),
      banned: [...this.banned],
    };
  }

  get enabled(): boolean {
    const st = useRoom.getState();
    // localStorage "wr:p2p:route" = "off" switches direct delivery off on this device only.
    return !this.destroyed && st.phase === 'joined' && local.get<string>('wr:p2p:route', 'auto') !== 'off' && st.sessionReady && st.me?.role === 'guest' && st.settings?.p2p === true
      && Boolean(st.media) && window.isSecureContext && typeof RTCPeerConnection === 'function' && Boolean(crypto?.subtle);
  }

  /** What this viewer reports to the room (shown to the host). */
  report(): ParticipantP2P | null {
    if (!this.enabled) return null;
    let peers = 0;
    for (const l of this.guests.values()) if (l.state === 'open') peers++;
    return { host: this.hostState, peers, ...this.stats };
  }

  // ------------------------------------------------------------------ connections

  private queueReconcile(): void {
    if (this.reconcileQueued || this.destroyed) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (!this.enabled) {
      this.closeAll();
      return;
    }
    const st = useRoom.getState();
    const mediaId = st.media?.id ?? null;
    if (mediaId !== this.mediaId) {
      this.mediaId = mediaId;
      this.broadcastLost(this.cache.retainMedia(mediaId));
    }
    const now = performance.now();
    if (!this.host && now >= this.hostRetryAt) this.connectHost();

    const me = st.me!.id;
    const wanted = st.participants
      .filter((p) => p.id !== me && p.role === 'guest' && p.connected && p.p2p !== null && !this.banned.has(p.id))
      .slice(0, P2P.maxPeers);
    const ids = new Set(wanted.map((p) => p.id));
    for (const [id, link] of this.guests) {
      if (!ids.has(id)) {
        this.guests.delete(id);
        link.close();
      }
    }
    // The viewer with the smaller id starts the connection, so two viewers never both offer.
    for (const p of wanted) {
      if (!this.guests.has(p.id) && me < p.id && now >= (this.guestRetryAt.get(p.id) ?? 0)) this.connectGuest(p.id, true);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    const next = Math.min(this.host ? Infinity : this.hostRetryAt, ...this.guestRetryAt.values()) - performance.now();
    if (Number.isFinite(next) && next > 0) this.retryTimer = window.setTimeout(() => this.queueReconcile(), next + 50);
  }

  private connectHost(): void {
    this.hostState = 'connecting';
    const link: PeerLink = new PeerLink({
      remoteId: P2P.hostPeer, initiator: true, iceServers: this.iceServers, cache: null,
      sendSignal: (s) => this.conn.send({ type: 'rtc', to: P2P.hostPeer, ...s }),
      onChange: () => {
        if (this.host !== link) return;
        if (link.state === 'open') {
          this.hostState = 'connected';
          this.hostAttempts = 0;
        } else if (link.state === 'closed') {
          this.host = null;
          this.hostAttempts++;
          this.hostState = this.hostAttempts >= 3 ? 'failed' : 'connecting';
          this.hostRetryAt = performance.now() + Math.min(120_000, 2000 * 2 ** this.hostAttempts);
          this.scheduleRetry();
        }
      },
    });
    this.host = link;
  }

  private connectGuest(id: string, initiator: boolean): PeerLink {
    const link: PeerLink = new PeerLink({
      remoteId: id, initiator, iceServers: this.iceServers, cache: this.cache,
      sendSignal: (s) => this.conn.send({ type: 'rtc', to: id, ...s }),
      onChange: () => {
        if (link.state === 'closed' && this.guests.get(id) === link) {
          this.guests.delete(id);
          this.guestRetryAt.set(id, performance.now() + 15_000);
          this.scheduleRetry();
        }
      },
    });
    this.guests.set(id, link);
    return link;
  }

  private onSignal(m: Extract<ServerMessage, { type: 'rtc' }>): void {
    if (!this.enabled) return;
    const s: LinkSignal = { ...(m.sdp ? { sdp: m.sdp } : {}), ...(m.candidate ? { candidate: m.candidate } : {}) };
    if (m.from === P2P.hostPeer) {
      void this.host?.signal(s);
      return;
    }
    let link = this.guests.get(m.from);
    if (m.sdp?.type === 'offer') {
      // The server relays only between viewers of this room, so an offer may come from someone whose arrival we
      // haven't been told about yet.
      if (this.banned.has(m.from)) return;
      if (link) {
        this.guests.delete(m.from);
        link.close();
      } else if (this.guests.size >= P2P.maxPeers) return;
      link = this.connectGuest(m.from, false);
    }
    void link?.signal(s);
  }

  /** Deliberate shutdown (feature off, left the room): not a failure, so no back-off afterwards. */
  private closeAll(): void {
    const host = this.host;
    const guests = [...this.guests.values()];
    this.host = null;
    this.guests.clear();
    host?.close();
    for (const l of guests) l.close();
    this.hostState = 'off';
    this.hostAttempts = 0;
    this.hostRetryAt = 0;
    this.hostStrikes = 0;
    this.hostBenchUntil = 0;
    this.guestRetryAt.clear();
  }

  // ------------------------------------------------------------------ sharing

  /** Keeps a segment we downloaded (from anywhere) and tells the other viewers we have it. */
  private keep(key: string, data: Uint8Array): void {
    if (!this.mediaId || !key.startsWith(`${this.mediaId}/`) || !this.cache.put(key, data)) return;
    this.announceQueue.push(key);
    if (this.announceTimer === null) {
      this.announceTimer = window.setTimeout(() => {
        this.announceTimer = null;
        const keys = this.announceQueue.splice(0);
        for (const l of this.guests.values()) l.announce(keys);
      }, 300);
    }
  }

  private broadcastLost(keys: string[]): void {
    if (!keys.length) return;
    for (const l of this.guests.values()) l.announceLost(keys);
  }

  /** Called by the loader after a segment came over the normal link. */
  recordLink(key: string, data: Uint8Array, ms: number): void {
    this.stats.fromLink += data.byteLength;
    if (data.byteLength >= VIDEO_SIZED) this.sample('link', data.byteLength / Math.max(1, ms));
    this.keep(key, data);
  }

  private sample(which: 'host' | 'link', rate: number): void {
    this.ewma[which] = this.samples[which] ? this.ewma[which] * 0.7 + rate * 0.3 : rate;
    this.samples[which]++;
  }

  // ------------------------------------------------------------------ fetching

  /** A segment from the cache, another viewer or the host directly; null means "use the normal link". */
  async fetch(key: string, ctx: FetchContext): Promise<{ data: Uint8Array; source: Source } | null> {
    const cached = this.cache.get(key);
    if (cached) return { data: cached, source: 'cache' };
    this.requests++;

    // 1. Another viewer who already has it (only when there's time to spare: it's an extra hop to verify).
    if (ctx.bufferAhead >= 6) {
      const holders = [...this.guests.values()]
        .filter((l) => l.state === 'open' && l.remoteHave.has(key) && l.busy < 2 && l.failures < 3)
        .sort((a, b) => b.rate - a.rate);
      for (const peer of holders.slice(0, 2)) {
        const data = await this.fromPeer(peer, key, ctx).catch(() => null);
        if (ctx.signal.aborted) throw new PeerError('aborted');
        if (data) {
          this.stats.fromPeers += data.byteLength;
          this.keep(key, data);
          return { data, source: 'peer' };
        }
      }
    }

    // 2. The host's computer, directly.
    if (this.useHostDirect(ctx)) {
      const t0 = performance.now();
      const data = await this.fromHost(key, ctx).catch(() => null);
      if (ctx.signal.aborted) throw new PeerError('aborted');
      if (data) {
        if (data.byteLength >= VIDEO_SIZED) this.sample('host', data.byteLength / Math.max(1, performance.now() - t0));
        this.stats.fromHost += data.byteLength;
        this.keep(key, data);
        return { data, source: 'host' };
      }
    }
    return null;
  }

  /** Direct from the host when it's connected and (as measured) at least about as fast as the link. */
  private useHostDirect(ctx: FetchContext): boolean {
    if (!this.host || this.host.state !== 'open' || performance.now() < this.hostBenchUntil) return false;
    // Troubleshooting override, per browser: localStorage "wr:p2p:route" = "direct" | "link" | "off" (default automatic).
    const forced = local.get<string>('wr:p2p:route', 'auto');
    if (forced === 'direct') return true;
    if (forced === 'link') return false;
    // Now and then try the other path so both measurements stay current (only with plenty buffered).
    const explore = this.requests % 10 === 0 && ctx.bufferAhead > 20;
    if (this.samples.host === 0) return true;
    if (this.samples.link === 0) return !explore;
    const hostBetter = this.ewma.host >= this.ewma.link * 0.8;
    return explore ? !hostBetter : hostBetter;
  }

  private async watch(
    req: { promise: Promise<Uint8Array>; progress(): { received: number; size: number; idleMs: number } },
    ctrl: AbortController, limits: { firstByteMs: number; idleMs: number; totalMs: number },
  ): Promise<Uint8Array> {
    const start = performance.now();
    let done = false;
    void req.promise.finally(() => { done = true; }).catch(() => {});
    void (async () => {
      while (!done && !ctrl.signal.aborted) {
        await sleep(200);
        if (done) return;
        const p = req.progress();
        const elapsed = performance.now() - start;
        if ((p.received === 0 && elapsed > limits.firstByteMs) || (p.received > 0 && p.idleMs > limits.idleMs) || elapsed > limits.totalMs) ctrl.abort();
      }
    })();
    return req.promise;
  }

  private async fromPeer(peer: PeerLink, key: string, ctx: FetchContext): Promise<Uint8Array> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    // Fetch the host's fingerprint while the bytes travel; nothing from another viewer is played unverified.
    const expected = fetch(`/media/${key}.sha256`, { credentials: 'same-origin', signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : null)).catch(() => null);
    try {
      const totalMs = Math.max(2500, Math.min(ctx.bufferAhead * 400, 10_000));
      const data = await this.watch(peer.request(key, ctrl.signal), ctrl, { firstByteMs: 1500, idleMs: 2000, totalMs });
      const want = await expected;
      if (!want) throw new PeerError('cannot verify');
      if ((await sha256(data)) !== want.trim()) {
        // Wrong bytes: never ask this viewer again this session.
        this.banned.add(peer.remoteId);
        this.guests.delete(peer.remoteId);
        peer.close();
        throw new PeerError('integrity check failed');
      }
      return data;
    } catch (err) {
      peer.failures++;
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      ctrl.abort();
    }
  }

  private async fromHost(key: string, ctx: FetchContext): Promise<Uint8Array> {
    const host = this.host!;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      // The host may need a few seconds to encode a segment after a seek; after that, bytes should keep flowing.
      const data = await this.watch(host.request(key, ctrl.signal), ctrl, { firstByteMs: 10_000, idleMs: 5000, totalMs: 60_000 });
      this.hostStrikes = 0;
      return data;
    } catch (err) {
      if (!ctx.signal.aborted && !(err instanceof PeerError && err.status === 404)) {
        // Repeated trouble: use the link for a minute before trying direct again.
        if (++this.hostStrikes >= 3) {
          this.hostStrikes = 0;
          this.hostBenchUntil = performance.now() + 60_000;
        }
      }
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsub) u();
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.announceTimer) window.clearTimeout(this.announceTimer);
    this.closeAll();
    if (current === this) current = null;
  }
}
