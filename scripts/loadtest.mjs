#!/usr/bin/env node
/*
 * Load test: starts a real headless host and simulates viewers (WebSocket sync traffic + segment downloads at
 * several qualities, together, like a watch party). Reports segment latency, errors, and the host's CPU and memory.
 *
 *   node scripts/loadtest.mjs [--viewers 8] [--seconds 40] [--video path] [--speed 2]
 *
 * --speed: how many seconds of video each viewer pulls per second (2 = twice real time, to stress the encoder).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({ options: {
  viewers: { type: 'string', default: '8' }, seconds: { type: 'string', default: '40' }, speed: { type: 'string', default: '2' },
  video: { type: 'string' },
} });
const VIEWERS = Number(values.viewers);
const SECONDS = Number(values.seconds);
const SPEED = Number(values.speed);
const root = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'watchroom-load-'));
// Default video: a 3-minute 1080p clip with 5.1 audio (generated once, cached in the temp folder).
let video = values.video ? resolve(values.video) : join(tmpdir(), 'watchroom-load-1080p.mkv');
if (!values.video && !existsSync(video)) {
  console.log('generating a 3-minute 1080p test clip (once)…');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=180',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=180,aformat=channel_layouts=5.1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '96', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '384k', video]);
}

const host = spawn('node', [join(root, 'packages/server/dist/cli.cjs'), '--video', video, '--link', 'local', '--json', '--data', data],
  { stdio: ['ignore', 'pipe', 'inherit'] });
let joinUrl = null;
let media = null;
let buf = '';
host.stdout.on('data', (d) => {
  buf += d.toString();
  for (const line of buf.split('\n')) {
    if (!line.startsWith('{')) continue;
    const m = JSON.parse(line);
    if (m.event === 'local') joinUrl = m.url;
    if (m.event === 'media') media = m.media;
  }
});
const t0 = Date.now();
while ((!joinUrl || !media) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100));
if (!joinUrl) throw new Error('host did not start');
const url = new URL(joinUrl);
const base = url.origin;
const roomId = url.pathname.split('/').pop();
const key = url.hash.slice(1);
console.log(`host up: ${media.title} · levels ${media.levels.map((l) => l.label).join(', ')} · ${VIEWERS} viewers for ${SECONDS}s at ${SPEED}× real time`);

function procStats(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const rss = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) * 1024;
    return { cpu: (Number(stat[11]) + Number(stat[12])) / 100, rss }; // utime+stime in seconds (CLK_TCK=100)
  } catch { return null; }
}
function childFfmpegs(pid) {
  let n = 0;
  for (const p of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const st = readFileSync(`/proc/${p}/stat`, 'utf8');
      const ppid = Number(st.split(') ')[1].split(' ')[1]);
      if ((ppid === pid || readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(data)) && st.includes('(ffmpeg)')) n++;
    } catch { /* gone */ }
  }
  return n;
}

const latencies = [];
const errors = [];
let bytes = 0;
let pongs = 0;
let maxPongGap = 0;
const levels = [...media.levels].sort((a, b) => b.bandwidth - a.bandwidth);
const audio = media.audioTracks[0]?.id;

async function viewer(i) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let welcome = null;
  let lastPong = Date.now();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'welcome') welcome = m;
    if (m.type === 'pong') { pongs++; maxPongGap = Math.max(maxPongGap, Date.now() - lastPong); lastPong = Date.now(); }
  });
  ws.send(JSON.stringify({ type: 'join', protocol: 1, roomId, key, name: `Load ${i}`, deviceId: `load-${i}-${Date.now()}` }));
  while (!welcome) await new Promise((r) => setTimeout(r, 20));
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: welcome.token }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const level = levels[i % levels.length];
  const ping = setInterval(() => ws.send(JSON.stringify({ type: 'ping', id: Date.now(), t0: performance.now() })), 1000);
  const status = setInterval(() => ws.send(JSON.stringify({ type: 'status', player: 'playing', position: 0, bufferAhead: 20, quality: level.label, rtt: 20 })), 2000);
  const deadline = Date.now() + SECONDS * 1000;
  const segSeconds = 4;
  for (let n = 0; Date.now() < deadline; n++) {
    const due = Date.now() + (segSeconds / SPEED) * 1000;
    for (const rid of [level.id, audio].filter(Boolean)) {
      const s = performance.now();
      try {
        const r = await fetch(`${base}/media/${media.id}/${rid}/${n}.ts`, { headers: { cookie } });
        const body = await r.arrayBuffer();
        if (r.status === 404) return finish();
        if (!r.ok) errors.push(`${rid}/${n}: ${r.status}`);
        else { bytes += body.byteLength; latencies.push(performance.now() - s); }
      } catch (e) { errors.push(`${rid}/${n}: ${e.message}`); }
    }
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return finish();
  function finish() {
    clearInterval(ping);
    clearInterval(status);
    ws.send(JSON.stringify({ type: 'leave' }));
    ws.close();
  }
}

const before = procStats(host.pid);
const samples = [];
const sampler = setInterval(() => {
  const s = procStats(host.pid);
  if (s) samples.push({ ...s, ffmpeg: childFfmpegs(host.pid), t: Date.now() });
}, 1000);
const start = Date.now();
await Promise.all(Array.from({ length: VIEWERS }, (_, i) => viewer(i)));
clearInterval(sampler);
const elapsed = (Date.now() - start) / 1000;
const after = procStats(host.pid);
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]?.toFixed(0);
console.log(JSON.stringify({
  viewers: VIEWERS, seconds: Math.round(elapsed), segments: latencies.length, errors: errors.length, firstErrors: errors.slice(0, 5),
  servedMbit: Math.round((bytes * 8) / 1e6), avgMbps: Number(((bytes * 8) / 1e6 / elapsed).toFixed(1)),
  segmentMs: { p50: Number(pct(50)), p95: Number(pct(95)), max: Number(latencies.at(-1)?.toFixed(0)) },
  hostProcess: { cpuPercent: Math.round(((after.cpu - before.cpu) / elapsed) * 100), maxRssMB: Math.round(Math.max(...samples.map((s) => s.rss)) / 1e6) },
  maxFfmpegProcesses: Math.max(0, ...samples.map((s) => s.ffmpeg)), pongs, maxPongGapMs: maxPongGap,
}, null, 2));
host.kill('SIGTERM');
await new Promise((r) => host.once('exit', r));
rmSync(data, { recursive: true, force: true });
