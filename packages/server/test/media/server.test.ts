import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@watchroom/protocol';
import { WatchroomServer } from '../../src/app';
import { asFile } from '../helpers';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'media', 'h264_ac3_51_multi.mkv');
let server: WatchroomServer;
let dataDir: string;
let base: string;

class Client {
  ws!: WebSocket;
  messages: ServerMessage[] = [];
  welcome: Extract<ServerMessage, { type: 'welcome' }> | null = null;
  cookie = '';

  async connect(join: Record<string, unknown>): Promise<ServerMessage> {
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    this.ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, deviceId: `dev-${Math.random().toString(36).slice(2, 10)}`, ...join }));
    const first = await this.next((m) => m.type === 'welcome' || m.type === 'error');
    if (first.type === 'welcome') {
      this.welcome = first;
      const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: first.token }) });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Strict/);
      this.cookie = setCookie.split(';')[0]!;
    }
    return first;
  }

  async next(pred: (m: ServerMessage) => boolean, timeout = 10_000): Promise<ServerMessage> {
    const start = Date.now();
    let seen = 0;
    while (Date.now() - start < timeout) {
      for (; seen < this.messages.length; seen++) if (pred(this.messages[seen]!)) return this.messages.splice(seen, 1)[0]!;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout waiting for message');
  }

  get(path: string, cookie = this.cookie) {
    return fetch(base + path, { headers: cookie ? { cookie } : {} });
  }

  send(msg: object) { this.ws.send(JSON.stringify(msg)); }
  close() {
    // Like a browser tab closing: say goodbye so the seat is released immediately.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'leave' }));
    this.ws?.close();
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'watchroom-srv-'));
  server = new WatchroomServer({ staticDir: null, dataDir, linkMode: 'local' });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  const res = await server.openVideo(fixture);
  expect(res.ok).toBe(true);
});

afterAll(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server end to end', () => {
  it('refuses room connections opened by pages on other sites', async () => {
    const tryOpen = (origin?: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, origin ? { origin } : {});
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.once('error', () => resolve('error'));
    });
    expect(await tryOpen()).toBe('open'); // no Origin: not a browser
    expect(await tryOpen(base)).toBe('open'); // our own page
    expect(await tryOpen('https://evil.example')).toBe('403');
    expect(await tryOpen('null')).toBe('403');
    expect(await tryOpen(base.replace('127.0.0.1', 'localhost'))).toBe('403');
    const csp = (await fetch(`${base}/healthz`)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*ws:/);
  });

  it('answers on the IPv6 loopback too, where browsers try "localhost" first', async () => {
    const v6 = await fetch(`http://[::1]:${server.port}/healthz`).then((r) => r.status).catch(() => null);
    if (v6 === null) return; // no IPv6 on this machine: localhost falls back to 127.0.0.1
    expect(v6).toBe(200);
    const opened = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://[::1]:${server.port}/ws`, { headers: { host: `localhost:${server.port}` }, origin: `http://localhost:${server.port}` });
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.once('error', (e) => resolve(`error ${e.message}`));
    });
    expect(opened).toBe('open');
  });

  it('rejects a wrong room key and accepts the real one', async () => {
    const bad = new Client();
    const err = await bad.connect({ roomId: server.room.id, key: 'nope', name: 'Eve' });
    expect(err).toMatchObject({ type: 'error', code: 'invalid_key', fatal: true });
    bad.close();
    const good = new Client();
    const welcome = await good.connect({ roomId: server.room.id, key: server.room.key, name: 'Aziz' });
    expect(welcome.type).toBe('welcome');
    if (welcome.type === 'welcome') expect(welcome.snapshot.media?.title).toBe('Test Movie');
    good.close();
  });

  it('serves media only to joined participants, with correct types and security headers', async () => {
    const c = new Client();
    await c.connect({ roomId: server.room.id, key: server.room.key, name: 'Viewer' });
    const media = asFile(c.welcome!.snapshot.media);
    expect((await c.get(media.masterUrl, '')).status).toBe(401);
    expect((await c.get(media.masterUrl, 'wr_s=forged')).status).toBe(401);
    const master = await c.get(media.masterUrl);
    expect(master.status).toBe(200);
    expect(master.headers.get('content-type')).toContain('mpegurl');
    expect(master.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(master.headers.get('referrer-policy')).toBe('no-referrer');
    expect(master.headers.get('cache-control')).toBe('no-store');
    const text = await master.text();
    expect(text).toContain('src/index.m3u8');
    expect(text).toContain('a1/index.m3u8');
    const level = await (await c.get(`/media/${media.id}/v720/index.m3u8`)).text();
    expect(level).toContain('#EXT-X-ENDLIST');
    const seg = await c.get(`/media/${media.id}/v720/3.ts`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('video/mp2t');
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const copy = await c.get(`/media/${media.id}/src/index.m3u8`);
    expect(copy.status).toBe(200);
    const audio = await c.get(`/media/${media.id}/a1/0.ts`);
    expect(audio.status).toBe(200);
    c.close();
  });

  it('refuses path tricks and unknown renditions', async () => {
    const c = new Client();
    await c.connect({ roomId: server.room.id, key: server.room.key, name: 'Prober' });
    const id = c.welcome!.snapshot.media!.id;
    for (const path of [
      `/media/${id}/../../etc/passwd`, `/media/${id}/v720/..%2F..%2Fsecret.ts`, `/media/${id}/v720/-1.ts`,
      `/media/${id}/zzz/0.ts`, `/media/${id}/v720/99999.ts`, `/media/otherid1/master.m3u8`, '/etc/passwd',
    ]) {
      const res = await c.get(path);
      expect([400, 404], path).toContain(res.status);
    }
    c.close();
  });

  it('runs the sync handshake between two clients', async () => {
    const a = new Client();
    const b = new Client();
    await a.connect({ roomId: server.room.id, key: server.room.key, name: 'A' });
    await b.connect({ roomId: server.room.id, key: server.room.key, name: 'B' });
    for (const c of [a, b]) c.send({ type: 'status', player: 'paused', position: 0, bufferAhead: 5, quality: '720p', rtt: 40 });
    await new Promise((r) => setTimeout(r, 100));
    a.send({ type: 'intent', action: 'play', version: server.room.playback.version });
    const waiting = await b.next((m) => m.type === 'playback' && m.playback.status === 'waiting');
    if (waiting.type !== 'playback') throw new Error('unexpected');
    for (const c of [a, b]) c.send({ type: 'ready', version: waiting.playback.version, ready: true });
    const playing = await a.next((m) => m.type === 'playback' && m.playback.status === 'playing');
    if (playing.type === 'playback') expect(playing.playback.anchor).toBeGreaterThan(playing.serverTime);
    const chat = await b.next((m) => m.type === 'chat' && m.message.kind === 'system' && m.message.text === 'A pressed play');
    expect(chat).toBeDefined();
    a.send({ type: 'ping', id: 7, t0: 123 });
    const pong = await a.next((m) => m.type === 'pong');
    expect(pong).toMatchObject({ type: 'pong', id: 7, t0: 123 });
    a.close();
    b.close();
  });

  it('local network mode serves the same app on the LAN port, and can be turned off', async () => {
    await server.setLinkMode('lan');
    const status = server.getStatus();
    expect(status.link.mode).toBe('lan');
    const lan = status.link.lanUrls[0];
    if (lan) {
      const origin = new URL(lan.url).origin;
      expect((await fetch(`${origin}/healthz`)).status).toBe(200);
      expect(status.link.shareUrl).toContain(origin);
    }
    await server.setLinkMode('local');
    expect(server.getStatus().link.lanUrls).toEqual([]);
    if (lan) await expect(fetch(`${new URL(lan.url).origin}/healthz`)).rejects.toThrow();
  });

  it('accepts real images only, serves them only to the room, and attaches them to chat', async () => {
    const a = new Client();
    const b = new Client();
    await a.connect({ roomId: server.room.id, key: server.room.key, name: 'Img A' });
    await b.connect({ roomId: server.room.id, key: server.room.key, name: 'Img B' });
    const png = join(dataDir, 'x.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', png]);
    const upload = (body: Buffer | string, type: string, cookie = a.cookie) => fetch(`${base}/api/chat/images`, {
      method: 'POST', headers: { 'content-type': type, ...(cookie ? { cookie } : {}) }, body,
    });
    expect((await upload(readFileSync(png), 'image/png', '')).status).toBe(401);
    expect((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/png')).status).toBe(400);
    expect((await upload('<svg/>', 'image/svg+xml')).status).toBe(415);
    const res = await upload(readFileSync(png), 'image/png');
    expect(res.status).toBe(200);
    const img = await res.json() as { id: string; width: number; height: number };
    expect(img).toMatchObject({ width: 64, height: 48 });
    expect((await a.get(`/api/chat/images/${img.id}`, '')).status).toBe(401);
    const got = await b.get(`/api/chat/images/${img.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    // Someone else cannot post A's upload; A can.
    b.send({ type: 'chat', text: '', nonce: 'x', attachment: { kind: 'image', id: img.id } });
    expect(await b.next((m) => m.type === 'error')).toMatchObject({ code: 'not_allowed' });
    a.send({ type: 'chat', text: 'look', nonce: 'y', attachment: { kind: 'image', id: img.id } });
    const msg = await b.next((m) => m.type === 'chat' && m.message.kind === 'user' && m.message.text === 'look');
    if (msg.type === 'chat' && msg.message.kind === 'user') expect(msg.message.attachment).toEqual({ kind: 'image', url: `/api/chat/images/${img.id}`, width: 64, height: 48 });
    a.close();
    b.close();
  });

  it('serves subtitles and thumbnails only to joined participants', async () => {
    const c = new Client();
    await c.connect({ roomId: server.room.id, key: server.room.key, name: 'Subs' });
    const id = c.welcome!.snapshot.media!.id;
    let d = asFile(c.welcome!.snapshot.media);
    for (let i = 0; i < 300 && !(d.subtitles[0]?.url && d.thumbnails); i++) {
      await new Promise((r) => setTimeout(r, 200));
      d = asFile(server.getStatus().media.descriptor);
    }
    expect(d.subtitles[0]?.url).toBeTruthy();
    const vtt = await c.get(d.subtitles[0]!.url!);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toContain('text/vtt');
    expect(await vtt.text()).toContain('Hello from the test movie');
    expect((await c.get(d.subtitles[0]!.url!, '')).status).toBe(401);
    expect((await c.get(`/media/${id}/subs/nope.vtt`)).status).toBe(404);
    const sheet = await c.get(d.thumbnails!.sheets[0]!);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type')).toBe('image/jpeg');
    expect((await c.get(`/media/${id}/thumbs/99.jpg`)).status).toBe(404);
    c.close();
  });

  it('kicks via host role only and the kicked session loses media access', async () => {
    const host = new Client();
    await host.connect({ roomId: server.room.id, hostToken: server.hostJoin().hostToken, name: 'Host' });
    const guest = new Client();
    await guest.connect({ roomId: server.room.id, key: server.room.key, name: 'Guest' });
    const id = guest.welcome!.snapshot.media!.id;
    expect((await guest.get(`/media/${id}/master.m3u8`)).status).toBe(200);
    host.send({ type: 'kick', participantId: guest.welcome!.participantId });
    await guest.next((m) => m.type === 'kicked');
    expect((await guest.get(`/media/${id}/master.m3u8`)).status).toBe(401);
    host.close();
  });

  it('remembers the video with a poster, resumes where the room stopped, and can start over', async () => {
    const long = join(here, '..', 'fixtures', 'media', 'long_h264_aac.mkv');
    expect((await server.openVideo(long)).ok).toBe(true);
    const host = new Client();
    await host.connect({ roomId: server.room.id, hostToken: server.hostJoin().hostToken, name: 'Host' });
    const v = host.welcome!.snapshot.playback.version;
    host.send({ type: 'intent', action: 'seek', position: 42, version: v });
    await host.next((m) => m.type === 'playback' && Math.abs(m.playback.position - 42) < 0.01);
    server.closeVideo();
    await expect.poll(async () => (await server.listRecent())[0]?.poster ?? null, { timeout: 20_000 }).toMatch(/^data:image\/jpeg;base64,/);
    const [entry] = await server.listRecent();
    expect(entry).toMatchObject({ fileName: 'long_h264_aac.mkv', current: false, missing: false });
    expect(entry!.position).toBeCloseTo(42, 0);
    // Nothing about the host's library is reachable over HTTP.
    expect(JSON.stringify(server.room.snapshot())).not.toContain(dirname(fixture));

    const resumed = await server.openRecent(entry!.id, false);
    expect(resumed.ok).toBe(true);
    expect(server.room.playback.position).toBeCloseTo(42, 0);
    expect((await server.listRecent())[0]!.current).toBe(true);
    const fresh = await server.openRecent(entry!.id, true);
    expect(fresh.ok).toBe(true);
    expect(server.room.playback.position).toBe(0);
    expect(await server.openRecent('0000000000000000', false)).toMatchObject({ ok: false });
    host.close();
  });
});
