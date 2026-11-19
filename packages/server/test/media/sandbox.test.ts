import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFfmpeg, locateFfmpeg, type FfmpegInfo } from '../../src/media/ffmpeg';
import { createLogger } from '../../src/util/log';
import { run } from '../../src/util/proc';
import { initSandbox, jailed, signalTree } from '../../src/util/sandbox';

const here = dirname(fileURLToPath(import.meta.url));
const video = join(here, '..', 'fixtures', 'media', 'h264_aac.mp4');
let ff: FfmpegInfo;
let work: string;
let on = false;

beforeAll(async () => {
  ff = await inspectFfmpeg(locateFfmpeg()!);
  on = (await initSandbox(ff.ffmpeg, createLogger('sandbox'))).state === 'on';
  work = mkdtempSync(join(tmpdir(), 'wr-jail-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('ffmpeg sandbox', () => {
  it('is available on this machine', () => {
    expect(on).toBe(true);
  });

  it('lets a tool read its video and write its cache folder, and nothing else', async (ctx) => {
    if (!on) return ctx.skip();
    const out = join(work, 'cache');
    const secretDir = mkdtempSync(join(tmpdir(), 'wr-secret-'));
    const secret = join(secretDir, 'private.mp4');
    writeFileSync(secret, readFileSync(video));
    try {
      const ok = await run(...jailed(ff.ffmpeg, ['-v', 'error', '-y', '-i', video, '-t', '1', '-c', 'copy', join(out, 'ok.mp4')], { read: [video], write: [out] }));
      expect(ok.code, ok.stderr).toBe(0);
      expect(existsSync(join(out, 'ok.mp4'))).toBe(true);
      // Another file on the computer doesn't exist as far as the tool is concerned…
      const peek = await run(...jailed(ff.ffmpeg, ['-v', 'error', '-i', secret, '-f', 'null', '-'], { read: [video], write: [out] }));
      expect(peek.code).not.toBe(0);
      expect(peek.stderr).toMatch(/No such file/);
      // …and it can't write anywhere but its own folder (here: next to the secret).
      const drop = await run(...jailed(ff.ffmpeg, ['-v', 'error', '-y', '-i', video, '-t', '1', '-c', 'copy', join(secretDir, 'dropped.mp4')], { read: [video], write: [out] }));
      expect(drop.code).not.toBe(0);
      expect(existsSync(join(secretDir, 'dropped.mp4'))).toBe(false);
      // The home folder is invisible too.
      const home = await run(...jailed('/usr/bin/ls', [process.env.HOME ?? '/home'], { read: [], write: [] }));
      expect(home.code).not.toBe(0);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('has no network', async (ctx) => {
    if (!on) return ctx.skip();
    const res = await run(...jailed(ff.ffprobe, ['-v', 'error', '-rw_timeout', '3000000', 'http://1.1.1.1/'], { read: [], write: [] }), { timeoutMs: 15_000 });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/unreachable|Cannot assign|resolve|Connection refused|Network/i);
  });

  it('pausing and stopping reach the tool inside the sandbox', async (ctx) => {
    if (!on) return ctx.skip();
    const out = join(work, 'pause');
    const [cmd, args] = jailed(ff.ffmpeg, ['-v', 'error', '-y', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=60',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'segment', '-segment_time', '1', join(out, '%d.ts')], { read: [], write: [out] });
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const count = () => (existsSync(out) ? readdirSync(out).length : 0);
    await new Promise((r) => setTimeout(r, 2500));
    signalTree(child.pid, 'SIGSTOP');
    await new Promise((r) => setTimeout(r, 300));
    const paused = count();
    await new Promise((r) => setTimeout(r, 2000));
    expect(count(), 'no new segments while paused').toBe(paused);
    signalTree(child.pid, 'SIGCONT');
    await new Promise((r) => setTimeout(r, 2500));
    expect(count()).toBeGreaterThan(paused);
    const exited = new Promise((r) => child.once('exit', r));
    signalTree(child.pid, 'SIGKILL');
    await exited;
  });
});
