import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Builds, then starts a headless host on a fixture video. Writes connection info for the specs. */
export default async function globalSetup() {
  const root = join(__dirname, '..');
  execFileSync('node', [join(root, 'packages/server/test/fixtures/generate.mjs')], { stdio: 'inherit' });
  if (!process.env.WATCHROOM_SKIP_BUILD) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const data = mkdtempSync(join(tmpdir(), 'watchroom-e2e-'));
  const child = spawn('node', [
    join(root, 'packages/server/dist/cli.cjs'), '--video', join(root, 'packages/server/test/fixtures/media/long_h264_aac.mkv'),
    '--link', 'local', '--json', '--data', data,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Everything runs on this machine: let the host offer its LAN address for direct connections.
    env: { ...process.env, WATCHROOM_LOG: process.env.WATCHROOM_LOG ?? 'debug', WATCHROOM_P2P_LAN: '1' },
  });
  // Keep the host's log for debugging failed runs.
  const logFile = join(__dirname, '.host.log');
  writeFileSync(logFile, '');
  child.stdout!.on('data', (d: Buffer) => appendFileSync(logFile, d));
  child.stderr!.on('data', (d: Buffer) => appendFileSync(logFile, d));
  const info: Record<string, unknown> = {};
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host did not start')), 30_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.startsWith('{')) continue;
        const msg = JSON.parse(line) as { event: string; hostUrl?: string; url?: string };
        if (msg.event === 'ready') info.hostUrl = msg.hostUrl;
        if (msg.event === 'local') info.joinUrl = msg.url;
        if (msg.event === 'media') info.media = true;
      }
      if (info.hostUrl && info.joinUrl && info.media) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`host exited ${code}`)));
  });
  writeFileSync(join(__dirname, '.host.json'), JSON.stringify(info));
  return async () => {
    child.kill('SIGTERM');
  };
}
