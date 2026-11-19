/*
 * Hostile traffic against a real server: garbage and floods on the WebSocket, odd HTTP paths, misbehaving direct
 * (WebRTC) peers. The server must stay up and responsive for an honest viewer, answer with 4xx (never 5xx or file
 * contents), and keep its memory bounded.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@watchroom/protocol';
import { WatchroomServer } from '../../src/app';
import { rng } from '../fuzz.test';
import { asFile } from '../helpers';

const here = dirname(fileURLToPath(import.meta.url));
let server: WatchroomServer;
let dataDir: string;
let base: string;

beforeAll(async () => {
  process.env.WATCHROOM_P2P_LAN = '1';
  dataDir = mkdtempSync(join(tmpdir(), 'watchroom-hard-'));
  // Serve the real web build so path tricks also hit the static file handler.
  const web = join(here, '..', '..', '..', '..', 'apps', 'web', 'dist');
  server = new WatchroomServer({ staticDir: existsSync(join(web, 'index.html')) ? web : null, dataDir, linkMode: 'local' });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  expect((await server.openVideo(join(here, '..', 'fixtures', 'media', 'long_h264_aac.mkv'))).ok).toBe(true);
});

afterAll(async () => {
  delete process.env.WATCHROOM_P2P_LAN;
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function honestViewer(name: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const msgs: ServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMessage));
  ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, roomId: server.room.id, key: server.room.key, name, deviceId: `dev-${name}-${Date.now()}` }));
  const start = Date.now();
  while (!msgs.some((m) => m.type === 'welcome') && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20));
  const welcome = msgs.find((m) => m.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
  if (!welcome) throw new Error(`could not join: ${JSON.stringify(msgs.slice(0, 3))} state=${ws.readyState}`);
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: welcome.token }) });
  return { ws, msgs, welcome, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

describe('hostile WebSocket traffic', () => {
  it('stays responsive for an honest viewer while 24 connections send garbage and floods', async () => {
    const honest = await honestViewer('Honest');
    const heapBefore = process.memoryUsage().heapUsed;
    // The honest viewer pings every 100 ms and measures the longest gap between answers.
    let pingId = 0;
    let lastPong = Date.now();
    let worstGap = 0;
    honest.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      if (m.type === 'pong') {
        worstGap = Math.max(worstGap, Date.now() - lastPong);
        lastPong = Date.now();
      }
    });
    const pinger = setInterval(() => honest.ws.send(JSON.stringify({ type: 'ping', id: ++pingId, t0: performance.now() })), 100);

    const r = rng(7);
    const garbage = (): string | Buffer => {
      switch (r.int(0, 11)) {
        case 0: return '{not json';
        case 1: return Buffer.from([0xff, 0x00, 0x13]);
        case 2: return JSON.stringify({ type: 'intent', action: 'seek', position: 'NaN', version: 1 });
        case 3: return JSON.stringify({ type: r.pick(['chat', 'kick', 'settings', 'rtc', 'join', 'evil']), text: 'x'.repeat(r.int(0, 5000)) });
        case 4: return `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
        case 5: return JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, roomId: server.room.id, key: 'wrong-key-123456', name: 'Eve', deviceId: `e${r.int(0, 1e9)}` });
        case 6: return JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, roomId: server.room.id, key: server.room.key, name: '‮'.repeat(50), deviceId: 'x' });
        case 7: return JSON.stringify({ type: 'ping', id: r.int(0, 1e9), t0: r.next() });
        case 8: return JSON.stringify({ __proto__: { polluted: true }, type: 'chat', text: 'proto', nonce: 'n', constructor: { prototype: { x: 1 } } });
        case 9: return 'x'.repeat(70 * 1024); // over the 64 KB frame limit
        case 10: return JSON.stringify({ type: 'settings', patch: { password: 'hijack', controlMode: 'host' } });
        default: return JSON.stringify({ type: 'rtc', to: '@host', sdp: { type: 'offer', sdp: 'v=0\r\n'.repeat(1000) } });
      }
    };
    const attackers = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
      ws.on('error', () => {});
      await new Promise((res) => { ws.once('open', res); ws.once('error', res); });
      // Half of them join properly first, then misbehave from inside the room.
      if (i % 2 === 0 && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, roomId: server.room.id, key: server.room.key, name: `Bad${i}`, deviceId: `bad-${i}-${Date.now()}` }));
      }
      for (let n = 0; n < 400 && ws.readyState === ws.OPEN; n++) {
        ws.send(garbage());
        if (n % 50 === 0) await new Promise((res) => setTimeout(res, 5));
      }
      return { ws, closed };
    }));
    await new Promise((res) => setTimeout(res, 1500));
    clearInterval(pinger);

    expect(worstGap, 'longest pause in pongs for the honest viewer').toBeLessThan(1500);
    expect(honest.ws.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/healthz`)).ok).toBe(true);
    // Every attacker that kept misbehaving was cut off; nobody but the host could change settings.
    const codes = await Promise.all(attackers.map((a) => Promise.race([a.closed, new Promise<number>((res) => setTimeout(() => res(-1), 3000))])));
    expect(codes.filter((c) => c === -1).length, `still connected: ${codes.join(',')}`).toBe(0);
    expect(server.room.publicSettings()).toMatchObject({ passwordRequired: false, controlMode: 'everyone' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The honest viewer still gets media, and memory stayed reasonable.
    const media = honest.welcome.snapshot.media!;
    expect((await fetch(`${base}/media/${media.id}/master.m3u8`, { headers: { cookie: honest.cookie } })).status).toBe(200);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024);
    honest.ws.close();
  }, 60_000);
});

describe('odd HTTP requests', () => {
  it('answers 4xx (never 5xx, never file contents) for path tricks and junk under every route', async () => {
    const v = await honestViewer('Paths');
    const id = v.welcome.snapshot.media!.id;
    const r = rng(99);
    const pieces = ['..', '%2e%2e', '%2f', '..%2f', '%00', 'etc', 'passwd', 'master.m3u8', 'index.m3u8', 'subs', 'thumbs', '0.ts', '1.ts.sha256', 'v480', 'a0', '%5c', '~', '.', '∕', 'x'.repeat(300)];
    const statuses = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const parts = Array.from({ length: r.int(1, 4) }, () => r.pick(pieces));
      const prefix = r.pick([`/media/${id}/`, '/media/', '/api/chat/images/', '/join/', '/', '/assets/']);
      const res = await fetch(`${base}${prefix}${parts.join('/')}`, { headers: r.bool() ? { cookie: v.cookie } : {} });
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      const body = await res.text();
      expect(res.status, `${prefix}${parts.join('/')}`).toBeLessThan(500);
      expect(body).not.toMatch(/root:x:0:0|\[boot loader\]/);
      if (res.status === 200 && prefix === '/') expect(res.headers.get('content-security-policy')).toBeTruthy();
    }
    expect([...statuses.keys()].every((s) => s < 500)).toBe(true);
    v.ws.close();
  }, 60_000);
});

describe('misbehaving direct peers', () => {
  it('a peer flooding requests and junk gets refusals, and an honest peer is served meanwhile', async () => {
    const ndc = createRequire(import.meta.url)('node-datachannel') as typeof import('node-datachannel');
    const connect = async (name: string) => {
      const v = await honestViewer(name);
      const pc = new ndc.PeerConnection(name, { iceServers: [] });
      v.ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMessage;
        if (m.type !== 'rtc') return;
        if (m.sdp) pc.setRemoteDescription(m.sdp.sdp, m.sdp.type);
        if (m.candidate) pc.addRemoteCandidate(m.candidate.candidate, m.candidate.mid);
      });
      pc.onLocalDescription((sdp, type) => { if (type === 'offer') v.ws.send(JSON.stringify({ type: 'rtc', to: '@host', sdp: { type, sdp } })); });
      pc.onLocalCandidate((c, mid) => v.ws.send(JSON.stringify({ type: 'rtc', to: '@host', candidate: { candidate: c.replace(/^a=/, ''), mid } })));
      const dc = pc.createDataChannel('seg');
      const texts: string[] = [];
      let bytes = 0;
      dc.onMessage((m) => { if (typeof m === 'string') texts.push(m); else bytes += (m as Buffer).length; });
      await new Promise<void>((res, rej) => { dc.onOpen(() => res()); setTimeout(() => rej(new Error('no channel')), 15_000); });
      return { v, pc, dc, texts, bytes: () => bytes };
    };
    const bad = await connect('Flooder');
    const good = await connect('Polite');
    const media = asFile(good.v.welcome.snapshot.media);
    const level = media.levels.find((l) => !l.copy)!.id;
    // 200 requests at once plus junk frames from the flooder.
    for (let i = 0; i < 200; i++) bad.dc.sendMessage(JSON.stringify({ t: 'get', id: i, key: `${media.id}/${level}/${i % 50}.ts` }));
    for (const junk of ['', '{}', 'null', '{"t":"get","id":1e99,"key":"x"}', JSON.stringify({ t: 'have', keys: Array(5000).fill('a') })]) bad.dc.sendMessage(junk);
    bad.dc.sendMessageBinary(Buffer.alloc(1000, 1));
    good.dc.sendMessage(JSON.stringify({ t: 'get', id: 1, key: `${media.id}/${level}/2.ts` }));
    const start = Date.now();
    while (!good.texts.some((t) => t.includes('"status":200')) && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 50));
    expect(good.texts.some((t) => t.includes('"status":200'))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    const refused = bad.texts.filter((t) => t.includes('"status":429')).length;
    expect(refused, 'flooder requests refused').toBeGreaterThan(150);
    expect((await fetch(`${base}/healthz`)).ok).toBe(true);
    for (const p of [bad, good]) { p.pc.close(); p.v.ws.close(); }
  }, 60_000);
});
