import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeChunk, parseControl, type PeerControl, type ServerMessage } from '@watchroom/protocol';
import { WatchroomServer } from '../../src/app';
import { asFile } from '../helpers';

const ndc = createRequire(import.meta.url)('node-datachannel') as typeof import('node-datachannel');
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'media', 'long_h264_aac.mkv');
let server: WatchroomServer;
let dataDir: string;
let base: string;

/** A viewer that talks to the host's peer like a browser would, using libdatachannel. */
class PeerViewer {
  ws!: WebSocket;
  welcome!: Extract<ServerMessage, { type: 'welcome' }>;
  cookie = '';
  pc!: import('node-datachannel').PeerConnection;
  dc!: import('node-datachannel').DataChannel;
  candidates: string[] = [];
  private waiters = new Map<number, { resolve(v: { status: number; data: Buffer }): void; size: number; parts: Buffer[]; got: number; status: number }>();

  async join(name: string): Promise<void> {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    const msgs: ServerMessage[] = [];
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      if (m.type === 'rtc') this.onSignal(m);
      else msgs.push(m);
    });
    this.ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, roomId: server.room.id, key: server.room.key, name, deviceId: `dev-${name}-${Date.now()}` }));
    await expect.poll(() => msgs.find((m) => m.type === 'welcome')).toBeTruthy();
    this.welcome = msgs.find((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
    const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.welcome.token }) });
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  }

  async connect(): Promise<void> {
    this.pc = new ndc.PeerConnection(`viewer-${Math.random()}`, { iceServers: [] });
    this.pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') this.ws.send(JSON.stringify({ type: 'rtc', to: '@host', sdp: { type, sdp } }));
    });
    this.pc.onLocalCandidate((candidate, mid) => this.ws.send(JSON.stringify({ type: 'rtc', to: '@host', candidate: { candidate: candidate.replace(/^a=/, ''), mid } })));
    this.dc = this.pc.createDataChannel('seg');
    this.dc.onMessage((m) => {
      if (typeof m === 'string') return this.onControl(parseControl(m));
      const chunk = decodeChunk(new Uint8Array(m as Buffer));
      const w = chunk && this.waiters.get(chunk.id);
      if (!w || !chunk) return;
      w.parts.push(Buffer.from(chunk.payload));
      w.got += chunk.payload.byteLength;
      if (w.got >= w.size) {
        this.waiters.delete(chunk.id);
        w.resolve({ status: 200, data: Buffer.concat(w.parts) });
      }
    });
    await new Promise<void>((res, rej) => {
      this.dc.onOpen(() => res());
      setTimeout(() => rej(new Error('data channel did not open')), 15_000);
    });
  }

  private onSignal(m: Extract<ServerMessage, { type: 'rtc' }>): void {
    if (m.sdp) this.pc.setRemoteDescription(m.sdp.sdp, m.sdp.type);
    if (m.candidate) {
      this.candidates.push(m.candidate.candidate);
      this.pc.addRemoteCandidate(m.candidate.candidate, m.candidate.mid);
    }
  }

  private onControl(m: PeerControl | null): void {
    if (m?.t !== 'res') return;
    const w = this.waiters.get(m.id);
    if (!w) return;
    if (m.status !== 200) {
      this.waiters.delete(m.id);
      w.resolve({ status: m.status, data: Buffer.alloc(0) });
    } else if (m.size === 0) {
      this.waiters.delete(m.id);
      w.resolve({ status: 200, data: Buffer.alloc(0) });
    } else w.size = m.size;
  }

  private nextId = 1;
  get(key: string): Promise<{ status: number; data: Buffer }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, { resolve, size: Infinity, parts: [], got: 0, status: 0 });
      this.dc.sendMessage(JSON.stringify({ t: 'get', id, key }));
    });
  }

  close(): void {
    try { this.pc?.close(); } catch { /* ignore */ }
    this.ws.send(JSON.stringify({ type: 'leave' }));
    this.ws.close();
  }
}

beforeAll(async () => {
  process.env.WATCHROOM_P2P_LAN = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'watchroom-p2p-'));
  server = new WatchroomServer({ staticDir: null, dataDir, linkMode: 'local' });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  expect((await server.openVideo(fixture)).ok).toBe(true);
});

afterAll(async () => {
  delete process.env.WATCHROOM_P2P_LAN;
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('direct delivery from the host', () => {
  it('serves the same segment bytes as HTTP over a data channel and counts them as upload', async () => {
    const v = new PeerViewer();
    await v.join('Pia');
    await v.connect();
    const media = asFile(v.welcome.snapshot.media);
    const level = media.levels.find((l) => !l.copy)!.id;
    const audio = media.audioTracks[0]!.id;
    for (const key of [`${media.id}/${level}/3.ts`, `${media.id}/${audio}/3.ts`]) {
      const viaPeer = await v.get(key);
      expect(viaPeer.status).toBe(200);
      const viaHttp = Buffer.from(await (await fetch(`${base}/media/${key}`, { headers: { cookie: v.cookie } })).arrayBuffer());
      expect(viaPeer.data.length).toBeGreaterThan(1000);
      expect(viaPeer.data.equals(viaHttp)).toBe(true);
      // The viewer can check bytes it got from someone else against the host's fingerprint.
      const sum = await (await fetch(`${base}/media/${key}.sha256`, { headers: { cookie: v.cookie } })).text();
      expect(sum).toBe((await import('node:crypto')).createHash('sha256').update(viaHttp).digest('base64'));
    }
    expect(server.getStatus().stats.directConnections).toBe(1);
    expect(server.getStatus().stats.perViewer[v.welcome.participantId]!.bytes).toBeGreaterThan(2000);
    // Several requests at once interleave on the one channel and all complete.
    const many = await Promise.all([5, 6, 7, 8].map((n) => v.get(`${media.id}/${level}/${n}.ts`)));
    expect(many.every((r) => r.status === 200 && r.data[0] === 0x47)).toBe(true);
    v.close();
    await expect.poll(() => server.getStatus().stats.directConnections, { timeout: 10_000 }).toBe(0);
  });

  it('refuses anything that is not a segment of the current video', async () => {
    const v = new PeerViewer();
    await v.join('Max');
    await v.connect();
    const media = asFile(v.welcome.snapshot.media);
    expect((await v.get(`othermedia1/${media.levels[0]!.id}/1.ts`)).status).toBe(404);
    expect((await v.get(`${media.id}/nosuchlevel/1.ts`)).status).toBe(404);
    expect((await v.get(`${media.id}/${media.levels[0]!.id}/999999.ts`)).status).toBe(404);
    // Malformed requests are dropped without an answer (parseControl rejects them); the channel stays usable.
    v.dc.sendMessage(JSON.stringify({ t: 'get', id: 99, key: '../../etc/passwd' }));
    v.dc.sendMessage('not json');
    expect((await v.get(`${media.id}/${media.audioTracks[0]!.id}/0.ts`)).status).toBe(200);
    v.close();
  });

  it('stops relaying and closes direct connections when the host turns them off', async () => {
    const v = new PeerViewer();
    await v.join('Lu');
    await v.connect();
    await expect.poll(() => server.getStatus().stats.directConnections).toBe(1);
    server.room.applyDefaults({ p2p: false });
    // applyDefaults is quiet; the host's settings message path also closes peers:
    (server as unknown as { peers: { closeAll(): void } }).peers.closeAll();
    await expect.poll(() => server.getStatus().stats.directConnections).toBe(0);
    const v2 = new PeerViewer();
    await v2.join('Mo');
    await expect(v2.connect()).rejects.toThrow(/did not open/);
    server.room.applyDefaults({ p2p: true });
    v.close();
    v2.close();
  }, 30_000);
});
