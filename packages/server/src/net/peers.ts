/*
 * The host's side of direct (WebRTC) delivery. Each viewer may open one peer connection to the host's server; over
 * its "seg" data channel the viewer asks for video/audio segments by key and receives them as tagged binary chunks.
 *
 * Security: the connection is set up over the viewer's authenticated room WebSocket, so the host knows who is on
 * the other end. Requests go through the same checks as HTTP (current video only, known rendition, numeric
 * segment), and nothing else (playlists, subtitles, files) is reachable. Private network addresses are never
 * offered as connection candidates unless explicitly allowed.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  P2P, candidateInfo, encodeChunk, isPrivateAddress, parseControl, parseSegmentKey, type PeerControl, type RtcMessage,
} from '@watchroom/protocol';
import type { DataChannel, PeerConnection } from 'node-datachannel';
import type { MediaSession } from '../media/session';
import { SegmentError } from '../media/scheduler';
import type { Room } from '../room/room';
import type { Logger } from '../util/log';

type Ndc = typeof import('node-datachannel');

export interface HostPeersDeps {
  room(): Room;
  media(): MediaSession | null;
  recordUpload(bytes: number, participantId: string): void;
  log: Logger;
  /** Offer LAN addresses as candidates too (tests and same-network use). */
  allowPrivateCandidates?: boolean;
}

interface Transfer {
  id: number;
  data: Buffer;
  offset: number;
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_ACTIVE = 4;
const MAX_QUEUED = 8;
const CONNECT_TIMEOUT_MS = 25_000;
const SEGMENT_TIMEOUT_MS = 20_000;

let ndcCache: Ndc | null | undefined;
function loadNdc(log: Logger): Ndc | null {
  if (ndcCache !== undefined) return ndcCache;
  try {
    // A native module, loaded lazily so the app still works (over the link only) if it can't be loaded. The bundled
    // server is CommonJS (require exists); tests run the sources as ES modules.
    const req = typeof require === 'function' ? require : createRequire(import.meta.url);
    ndcCache = req('node-datachannel') as Ndc;
  } catch (err) {
    log.warn(`direct connections unavailable: ${(err as Error).message}`);
    ndcCache = null;
  }
  return ndcCache;
}

export class HostPeers {
  private readonly peers = new Map<string, HostPeer>();
  private readonly ndc: Ndc | null;
  private closed = false;

  constructor(private readonly deps: HostPeersDeps) {
    this.ndc = loadNdc(deps.log);
  }

  get available(): boolean {
    return this.ndc !== null;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.connected) n++;
    return n;
  }

  /** Signalling from a viewer (via the room WebSocket). */
  signal(participantId: string, msg: RtcMessage): void {
    if (!this.ndc || this.closed) return;
    if (msg.sdp?.type === 'offer') {
      this.peers.get(participantId)?.close();
      if (this.peers.size >= 32) return;
      const peer = new HostPeer(this.ndc, participantId, this.deps, () => {
        if (this.peers.get(participantId) === peer) this.peers.delete(participantId);
      });
      this.peers.set(participantId, peer);
      peer.offer(msg.sdp.sdp);
      return;
    }
    if (msg.candidate) this.peers.get(participantId)?.candidate(msg.candidate.candidate, msg.candidate.mid);
  }

  close(participantId: string): void {
    this.peers.get(participantId)?.close();
  }

  closeAll(): void {
    for (const p of [...this.peers.values()]) p.close();
  }

  shutdown(): void {
    this.closed = true;
    this.closeAll();
    try {
      this.ndc?.cleanup();
    } catch { /* already gone */ }
  }
}

class HostPeer {
  private readonly pc: PeerConnection;
  private dc: DataChannel | null = null;
  private readonly active: Transfer[] = [];
  private readonly queue: { id: number; key: string }[] = [];
  private readonly cancelled = new Set<number>();
  private pending = 0;
  private rr = 0;
  private done = false;
  connected = false;
  private readonly connectTimer: NodeJS.Timeout;

  constructor(ndc: Ndc, private readonly pid: string, private readonly deps: HostPeersDeps, private readonly onClose: () => void) {
    this.pc = new ndc.PeerConnection(`wr-${pid}`, { iceServers: [...P2P.stun], maxMessageSize: 256 * 1024 });
    this.pc.onLocalDescription((sdp, type) => {
      if (type !== 'answer' || this.done) return;
      this.deps.room().sendRtc(pid, { sdp: { type: 'answer', sdp: this.filterSdp(sdp) } });
    });
    this.pc.onLocalCandidate((candidate, mid) => {
      const c = candidate.replace(/^a=/, '');
      if (this.done || !this.allowed(c)) return;
      this.deps.room().sendRtc(pid, { candidate: { candidate: c, mid } });
    });
    this.pc.onStateChange((state) => {
      if (state === 'connected') {
        this.connected = true;
        clearTimeout(this.connectTimer);
        this.deps.log.info(`direct connection to ${pid} up`);
      }
      if (state === 'failed' || state === 'closed') this.close();
    });
    this.pc.onDataChannel((dc) => {
      if (dc.getLabel() !== 'seg' || this.dc) {
        dc.close();
        return;
      }
      this.dc = dc;
      dc.setBufferedAmountLowThreshold(LOW_WATER);
      dc.onBufferedAmountLow(() => this.pump());
      dc.onMessage((m) => {
        if (typeof m === 'string') this.onControl(parseControl(m));
      });
      dc.onClosed(() => this.close());
    });
    this.connectTimer = setTimeout(() => { if (!this.connected) this.close(); }, CONNECT_TIMEOUT_MS);
  }

  offer(sdp: string): void {
    try {
      this.pc.setRemoteDescription(sdp, 'offer');
    } catch (err) {
      this.deps.log.warn(`bad offer from ${this.pid}: ${(err as Error).message}`);
      this.close();
    }
  }

  candidate(candidate: string, mid: string): void {
    if (this.done || !candidate) return;
    try {
      this.pc.addRemoteCandidate(candidate, mid || '0');
    } catch { /* stale or malformed: ignore */ }
  }

  private allowed(candidate: string): boolean {
    if (this.deps.allowPrivateCandidates) return true;
    const info = candidateInfo(candidate);
    return Boolean(info) && !(info!.type === 'host' && isPrivateAddress(info!.address));
  }

  private filterSdp(sdp: string): string {
    return sdp.split(/\r?\n/).filter((line) => !line.startsWith('a=candidate:') || this.allowed(line.slice(2))).join('\r\n');
  }

  private send(msg: PeerControl): void {
    try {
      this.dc?.sendMessage(JSON.stringify(msg));
    } catch { /* channel closing */ }
  }

  private onControl(msg: PeerControl | null): void {
    if (!msg || this.done) return;
    if (msg.t === 'cancel') {
      const i = this.active.findIndex((t) => t.id === msg.id);
      if (i >= 0) this.active.splice(i, 1);
      const q = this.queue.findIndex((x) => x.id === msg.id);
      if (q >= 0) this.queue.splice(q, 1);
      else this.cancelled.add(msg.id);
      return;
    }
    if (msg.t !== 'get') return; // the host has everything; viewers' have-lists don't matter here
    if (this.queue.length + this.pending >= MAX_QUEUED) {
      this.send({ t: 'res', id: msg.id, status: 429, size: 0 });
      return;
    }
    this.queue.push({ id: msg.id, key: msg.key });
    this.next();
  }

  /** Starts preparing queued requests while there is room. */
  private next(): void {
    while (this.queue.length && this.active.length + this.pending < MAX_ACTIVE) {
      const req = this.queue.shift()!;
      this.pending++;
      void this.prepare(req.id, req.key).finally(() => {
        this.pending--;
        this.next();
      });
    }
  }

  private async prepare(id: number, key: string): Promise<void> {
    const parsed = parseSegmentKey(key);
    const media = this.deps.media();
    if (!parsed || !media || parsed.mediaId !== media.id || !this.deps.room().isConnected(this.pid)) {
      this.send({ t: 'res', id, status: 404, size: 0 });
      return;
    }
    let data: Buffer;
    try {
      let timer: NodeJS.Timeout | undefined;
      const path = await Promise.race([
        media.segment(parsed.rid, parsed.index, this.pid),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new SegmentError('timeout', 503)), SEGMENT_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      data = await readFile(path);
    } catch (err) {
      const status = err instanceof SegmentError ? err.status === 404 ? 404 : 503 : 503;
      this.send({ t: 'res', id, status, size: 0 });
      return;
    }
    if (this.done || this.cancelled.delete(id)) return;
    this.send({ t: 'res', id, status: 200, size: data.length });
    this.active.push({ id, data, offset: 0 });
    this.pump();
  }

  /** Sends chunks round-robin across active transfers while the channel's buffer has room. */
  private pump(): void {
    const dc = this.dc;
    if (!dc || this.done) return;
    while (this.active.length && dc.bufferedAmount() < HIGH_WATER) {
      this.rr %= this.active.length;
      const t = this.active[this.rr]!;
      const end = Math.min(t.data.length, t.offset + P2P.chunk);
      const chunk = encodeChunk(t.id, t.data.subarray(t.offset, end));
      try {
        // false means "queued, not sent yet" (not a failure); bufferedAmount() keeps the queue bounded.
        dc.sendMessageBinary(chunk);
      } catch {
        this.close();
        return;
      }
      this.deps.recordUpload(end - t.offset, this.pid);
      t.offset = end;
      if (t.offset >= t.data.length) this.active.splice(this.rr, 1);
      else this.rr++;
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.connectTimer);
    this.active.length = 0;
    this.queue.length = 0;
    try {
      this.dc?.close();
    } catch { /* ignore */ }
    try {
      this.pc.close();
    } catch { /* ignore */ }
    this.onClose();
  }
}
