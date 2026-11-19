import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** A second host serving the HEVC 10-bit fixture (the shared e2e host plays H.264). */
let child: ChildProcess;
let data: string;
let joinUrl = '';

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'watchroom-hevc-e2e-'));
  child = spawn('node', [join(root, 'packages/server/dist/cli.cjs'), '--video', join(root, 'packages/server/test/fixtures/media/hevc10_eac3.mkv'),
    '--link', 'local', '--json', '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HEVC host did not start')), 60_000);
    let buf = '';
    let media = false;
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.startsWith('{')) continue;
        const m = JSON.parse(line) as { event: string; url?: string };
        if (m.event === 'local' && m.url) joinUrl = m.url;
        if (m.event === 'media') media = true;
      }
      if (joinUrl && media) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
  rmSync(data, { recursive: true, force: true, maxRetries: 3 });
});

test('a browser without HEVC support gets the H.264 qualities for an HEVC video and plays it', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
  expect(await page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L120.B0"'))).toBe(false);
  await page.goto(joinUrl);
  await page.getByPlaceholder('How friends will see you').fill('NoHevc');
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForSelector('video');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('k');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 40_000 }).toBeGreaterThan(2);
  expect(await page.evaluate(() => document.querySelector('video')!.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Quality' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: /^1080p/ })).toBeVisible();
  await expect(menu.getByText(/Original/)).toHaveCount(0); // the untouched HEVC level isn't offered here
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
});
