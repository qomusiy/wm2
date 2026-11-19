import { P2P, decodeChunk, encodeChunk, parseControl, type PeerControl } from '@watchroom/protocol';
import type { SegmentCache } from './cache';

export type LinkSignal = { sdp?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; mid: string } };

export interface LinkOptions {
  remoteId: string;
  initiator: boolean;
  iceServers: RTCIceServer[];
  sendSignal(signal: LinkSignal): void;
  /** Segments we may serve to this peer (null: we never serve, e.g. to the host). */
  cache: SegmentCache | null;
  onChange(): void;
}

interface Incoming {
  resolve(data: Uint8Array): void;
  reject(err: Error): void;
  size: number;
  received: number;
  parts: Uint8Array[];
  start: number;
  lastByte: number;
}

interface Outgoing {
  id: number;
  data: Uint8Array;
  offset: number;
}

export class PeerError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_SERVING = 3;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * One direct connection (to the host's computer or another viewer) with a "seg" data channel: asks for segments,
 * answers the other side's requests from the local cache, and keeps track of what the other side has.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  /** Segments the other side says it has. */
  readonly remoteHave = new Set<string>();
  /** Recent download speed from this peer (bytes per ms, smoothed); 0 until measured. */
  rate = 0;
  failures = 0;
  bytesIn = 0;
  bytesOut = 0;
  private nextId = 1;
  private readonly incoming = new Map<number, Incoming>();
  private readonly serving: Outgoing[] = [];
  private rr = 0;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private readonly connectTimer: number;

  constructor(private readonly opts: LinkOptions) {
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) opts.sendSignal({ candidate: { candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' } });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close();
    };
    if (opts.initiator) {
      this.attach(this.pc.createDataChannel('seg'));
      void this.pc.createOffer().then(async (offer) => {
        await this.pc.setLocalDescription(offer);
        opts.sendSignal({ sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
      }).catch(() => this.close());
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === 'seg' && !this.dc) this.attach(e.channel);
        else e.channel.close();
      };
    }
    this.connectTimer = window.setTimeout(() => { if (this.state === 'connecting') this.close(); }, CONNECT_TIMEOUT_MS);
  }

  get remoteId(): string {
    return this.opts.remoteId;
  }

  get busy(): number {
    return this.incoming.size;
  }

  async signal(s: LinkSignal): Promise<void> {
    if (this.state === 'closed') return;
    try {
      if (s.sdp) {
        await this.pc.setRemoteDescription(s.sdp);
        if (s.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.opts.sendSignal({ sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
        }
        for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      }
      if (s.candidate) {
        const c = { candidate: s.candidate.candidate, sdpMid: s.candidate.mid };
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => {});
        else this.pendingCandidates.push(c);
      }
    } catch {
      this.close();
    }
  }

  private attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => {
      window.clearTimeout(this.connectTimer);
      this.state = 'open';
      if (this.opts.cache) this.send({ t: 'have', keys: this.opts.cache.keys(), reset: true });
      this.opts.onChange();
    };
    dc.onclose = () => this.close();
    dc.onbufferedamountlow = () => this.pump();
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') this.onControl(parseControl(e.data));
      else this.onChunk(e.data as ArrayBuffer);
    };
  }

  private send(msg: PeerControl): void {
    if (this.dc?.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify(msg));
    } catch { /* closing */ }
  }

  announce(keys: string[]): void {
    if (keys.length) this.send({ t: 'have', keys });
  }

  announceLost(keys: string[]): void {
    if (keys.length) this.send({ t: 'lost', keys });
  }

  /** Downloads one segment. Rejects on refusal, abort, or when the link closes. */
  request(key: string, signal?: AbortSignal): { promise: Promise<Uint8Array>; progress(): { received: number; size: number; idleMs: number } } {
    const id = this.nextId++;
    let entry: Incoming | undefined;
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      if (this.state !== 'open') return reject(new PeerError('not connected'));
      if (signal?.aborted) return reject(new PeerError('aborted'));
      const now = performance.now();
      entry = { resolve, reject, size: -1, received: 0, parts: [], start: now, lastByte: now };
      this.incoming.set(id, entry);
      signal?.addEventListener('abort', () => {
        if (!this.incoming.delete(id)) return;
        this.send({ t: 'cancel', id });
        reject(new PeerError('aborted'));
      }, { once: true });
      this.send({ t: 'get', id, key });
    });
    return {
      promise,
      progress: () => ({ received: entry?.received ?? 0, size: entry?.size ?? -1, idleMs: entry ? performance.now() - entry.lastByte : 0 }),
    };
  }

  private onControl(msg: PeerControl | null): void {
    if (!msg) return;
    switch (msg.t) {
      case 'res': {
        const w = this.incoming.get(msg.id);
        if (!w) return;
        if (msg.status !== 200) {
          this.incoming.delete(msg.id);
          w.reject(new PeerError(`refused (${msg.status})`, msg.status));
        } else if (msg.size === 0) {
          this.incoming.delete(msg.id);
          w.reject(new PeerError('empty', 404));
        } else {
          w.size = msg.size;
          w.lastByte = performance.now();
        }
        return;
      }
      case 'have':
        if (msg.reset) this.remoteHave.clear();
        for (const k of msg.keys) this.remoteHave.add(k);
        if (this.remoteHave.size > 20_000) this.remoteHave.clear();
        return;
      case 'lost':
        for (const k of msg.keys) this.remoteHave.delete(k);
        return;
      case 'cancel': {
        const i = this.serving.findIndex((t) => t.id === msg.id);
        if (i >= 0) this.serving.splice(i, 1);
        return;
      }
      case 'get': {
        const data = this.opts.cache?.get(msg.key);
        if (!data) return this.send({ t: 'res', id: msg.id, status: 404, size: 0 });
        if (this.serving.length >= MAX_SERVING) return this.send({ t: 'res', id: msg.id, status: 429, size: 0 });
        this.send({ t: 'res', id: msg.id, status: 200, size: data.byteLength });
        this.serving.push({ id: msg.id, data, offset: 0 });
        this.pump();
      }
    }
  }

  private onChunk(buf: ArrayBuffer): void {
    const chunk = decodeChunk(buf);
    const w = chunk && this.incoming.get(chunk.id);
    if (!chunk || !w || w.size < 0) return;
    if (w.received + chunk.payload.byteLength > w.size) {
      this.incoming.delete(chunk.id);
      w.reject(new PeerError('too much data'));
      return;
    }
    w.parts.push(chunk.payload);
    w.received += chunk.payload.byteLength;
    w.lastByte = performance.now();
    this.bytesIn += chunk.payload.byteLength;
    if (w.received < w.size) return;
    this.incoming.delete(chunk.id);
    const out = new Uint8Array(w.size);
    let o = 0;
    for (const p of w.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    const ms = Math.max(1, performance.now() - w.start);
    const r = out.byteLength / ms;
    this.rate = this.rate ? this.rate * 0.7 + r * 0.3 : r;
    this.failures = 0;
    w.resolve(out);
  }

  /** Sends chunks round-robin while the channel's buffer has room. */
  private pump(): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return;
    while (this.serving.length && dc.bufferedAmount < HIGH_WATER) {
      this.rr %= this.serving.length;
      const t = this.serving[this.rr]!;
      const end = Math.min(t.data.byteLength, t.offset + P2P.chunk);
      try {
        dc.send(encodeChunk(t.id, t.data.subarray(t.offset, end)) as Uint8Array<ArrayBuffer>);
      } catch {
        this.close();
        return;
      }
      this.bytesOut += end - t.offset;
      t.offset = end;
      if (t.offset >= t.data.byteLength) this.serving.splice(this.rr, 1);
      else this.rr++;
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    window.clearTimeout(this.connectTimer);
    for (const w of this.incoming.values()) w.reject(new PeerError('connection closed'));
    this.incoming.clear();
    this.serving.length = 0;
    try {
      this.dc?.close();
    } catch { /* ignore */ }
    try {
      this.pc.close();
    } catch { /* ignore */ }
    this.opts.onChange();
  }
}
