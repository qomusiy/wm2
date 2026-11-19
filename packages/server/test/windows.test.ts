/*
 * Windows-only code paths, exercised on Linux by pretending to be Windows (process.platform / os.platform).
 * Real Windows behaviour (file locking, Windows ffmpeg) can't be reproduced here; these tests pin the logic.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, platform: () => (globalThis as { __fakePlatform?: string }).__fakePlatform ?? os.platform() };
});

const realPlatform = process.platform;
function pretend(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  (globalThis as { __fakePlatform?: string }).__fakePlatform = platform;
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete (globalThis as { __fakePlatform?: string }).__fakePlatform;
});

describe('on Windows', () => {
  it('retries a rename that fails while a file is briefly locked, and gives up on real errors', async () => {
    const { renameRetry } = await import('../src/util/fsx');
    const dir = mkdtempSync(join(tmpdir(), 'wr-win-'));
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'a.ts'), 'x');
    chmodSync(locked, 0o500); // rename out of it fails with EACCES, like a locked file on Windows
    pretend('win32');
    setTimeout(() => chmodSync(locked, 0o700), 150); // the "antivirus" lets go
    await renameRetry(join(locked, 'a.ts'), join(dir, 'b.ts'));
    expect(existsSync(join(dir, 'b.ts'))).toBe(true);
    await expect(renameRetry(join(dir, 'missing.ts'), join(dir, 'c.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not retry on Linux (a failure there is real)', async () => {
    const { renameRetry } = await import('../src/util/fsx');
    const dir = mkdtempSync(join(tmpdir(), 'wr-lin-'));
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'a.ts'), 'x');
    chmodSync(locked, 0o500);
    const t0 = Date.now();
    await expect(renameRetry(join(locked, 'a.ts'), join(dir, 'b.ts'))).rejects.toMatchObject({ code: 'EACCES' });
    expect(Date.now() - t0).toBeLessThan(100);
    chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads the Windows build of cloudflared (if one is not bundled)', async () => {
    const { assetName } = await import('../src/net/tunnel');
    pretend('win32');
    expect(assetName()).toBe('cloudflared-windows-amd64.exe');
    pretend('linux');
    expect(assetName()).toBe('cloudflared-linux-amd64');
    pretend('darwin');
    expect(assetName()).toBeNull();
  });

  it('reports the ffmpeg sandbox as unavailable, and runs tools directly', async () => {
    const { initSandbox, jailed, sandboxStatus } = await import('../src/util/sandbox');
    const { createLogger } = await import('../src/util/log');
    pretend('win32');
    expect((await initSandbox('C:\\Watchroom\\ffmpeg.exe', createLogger('t'))).state).toBe('unsupported');
    expect(sandboxStatus().state).toBe('unsupported');
    expect(jailed('C:\\Watchroom\\ffmpeg.exe', ['-i', 'C:\\Videos\\a b.mkv'], { read: ['C:\\Videos\\a b.mkv'], write: [] }))
      .toEqual(['C:\\Watchroom\\ffmpeg.exe', ['-i', 'C:\\Videos\\a b.mkv']]);
  });

  it('uses the software encoder unless hardware encoding is asked for', async () => {
    const { detectEncoder } = await import('../src/media/hwaccel');
    const fakeFf = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'x', filters: new Set<string>(), encoders: new Set(['libx264', 'h264_nvenc', 'h264_vaapi']) };
    pretend('win32');
    delete process.env.WATCHROOM_HWACCEL;
    const d = await detectEncoder(fakeFf);
    expect(d.choice.kind).toBe('libx264');
    expect(d.tried.map((t) => t.kind)).toEqual(['libx264']); // no hardware encoder was even tried
  });

  it('runs background work at normal priority (nice does not exist on Windows)', async () => {
    const { lowPriority } = await import('../src/util/lowprio');
    pretend('win32');
    expect(lowPriority('C:\\ffmpeg.exe', ['-x'])).toEqual(['C:\\ffmpeg.exe', ['-x']]);
  });
});
