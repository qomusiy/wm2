/*
 * YouTube videos, end to end, with real YouTube: a headless host opens a YouTube link, viewers' browsers play it in
 * YouTube's embedded player, and the room keeps them in sync. Needs internet access to YouTube.
 * Skipped when WATCHROOM_E2E_OFFLINE=1.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// "YouTube Developers Live: Embedded Web Player Customization" (Google for Developers), embeddable, 22 minutes.
const VIDEO = 'M7lc1UVf-VE';
// "Me at the zoo": the first YouTube video, 19 seconds.
const SECOND = 'jNQXAC9IVRw';

interface PlayerState {
  kind: 'file' | 'youtube';
  ready: boolean;
  fatal: string | null;
  t: number;
  paused: boolean;
  rate: number;
  sync: { state: string; drift: number | null };
}
const player = (p: Page) => p.evaluate(() => (window as unknown as { __watchroomPlayer(): PlayerState | null }).__watchroomPlayer());
const videoIdOf = (p: Page) => p.evaluate(() => /\/embed\/([\w-]{11})/.exec(document.querySelector('iframe.yt-frame')?.getAttribute('src') ?? '')?.[1] ?? null);

async function waitReady(p: Page, timeout = 60_000) {
  await expect.poll(async () => {
    const s = await player(p);
    if (s?.fatal) throw new Error(`YouTube failed: ${s.fatal}`);
    return s?.ready ?? false;
  }, { timeout, intervals: [500] }).toBe(true);
}

/** Everyone playing (or paused) within `tol` seconds of each other. */
async function expectInSync(pages: Page[], opts: { paused: boolean; tol: number; near?: number; timeout?: number }) {
  await expect.poll(async () => {
    const states = await Promise.all(pages.map(player));
    if (states.some((s) => !s || s.paused !== opts.paused)) return `paused mismatch ${JSON.stringify(states.map((s) => s && [s.paused, s.t.toFixed(2), s.sync.state]))}`;
    // Playing for real (not a moment between the room's decision and the player following it).
    if (!opts.paused && states.some((s) => !['synced', 'correcting'].includes(s!.sync.state))) return `settling ${states.map((s) => s!.sync.state).join(',')}`;
    const ts = states.map((s) => s!.t);
    const spread = Math.max(...ts) - Math.min(...ts);
    if (spread > opts.tol) return `spread ${spread.toFixed(3)}s ${ts.map((t) => t.toFixed(2)).join(',')}`;
    if (opts.near !== undefined && Math.abs(ts[0]! - opts.near) > 2) return `not near ${opts.near}: ${ts[0]}`;
    return 'ok';
  }, { timeout: opts.timeout ?? 30_000, intervals: [250] }).toBe('ok');
}

/** Keyboard shortcuts go to our page (not into YouTube's frame, where a click would also toggle playback). */
async function pressKey(p: Page, key: string) {
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await p.keyboard.press(key);
}

/** The middle of YouTube's picture (a click there toggles playback inside YouTube's player). */
async function clickPicture(p: Page) {
  const box = (await p.locator('iframe.yt-frame').boundingBox())!;
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.skip(process.env.WATCHROOM_E2E_OFFLINE === '1', 'needs internet access to YouTube');

test.describe.serial('YouTube videos', () => {
  let child: ChildProcess;
  let hostUrl = '';
  let joinUrl = '';
  let host: Page;
  let a: Page;
  let b: Page;

  test.beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), 'watchroom-e2e-yt-'));
    child = spawn('node', [join(root, 'packages/server/dist/cli.cjs'), '--video', `https://www.youtube.com/watch?v=${VIDEO}`, '--link', 'local', '--json', '--data', data], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WATCHROOM_LOG: 'debug' },
    });
    const logFile = join(__dirname, '.host-youtube.log');
    writeFileSync(logFile, '');
    child.stderr!.on('data', (d: Buffer) => appendFileSync(logFile, d));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube host did not start')), 40_000);
      let buf = '';
      let media = false;
      child.stdout!.on('data', (d: Buffer) => {
        appendFileSync(logFile, d);
        buf += d.toString();
        for (const line of buf.split('\n')) {
          if (!line.startsWith('{')) continue;
          const msg = JSON.parse(line) as { event: string; hostUrl?: string; url?: string };
          if (msg.event === 'ready') hostUrl = msg.hostUrl!;
          if (msg.event === 'local') joinUrl = msg.url!;
          if (msg.event === 'media') media = true;
        }
        if (hostUrl && joinUrl && media) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`YouTube host exited ${code}`)));
    });
  });

  test.afterAll(async () => {
    for (const p of [host, a, b]) await p?.context().close().catch(() => {});
    child?.kill('SIGTERM');
  });

  async function joinGuest(browser: Browser, name: string, viewport = { width: 1280, height: 760 }) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(joinUrl);
    await page.getByPlaceholder('How friends will see you').fill(name);
    await page.getByRole('button', { name: 'Join' }).click();
    return page;
  }

  test('host and guests load the video in YouTube\'s player; the room learns its length', async ({ browser }) => {
    host = await (await browser.newContext({ viewport: { width: 1400, height: 820 } })).newPage();
    await host.goto(hostUrl);
    a = await joinGuest(browser, 'Aziz');
    b = await joinGuest(browser, 'Dilnoza', { width: 390, height: 800 });
    await Promise.all([waitReady(host), waitReady(a), waitReady(b)]);
    for (const p of [host, a, b]) {
      expect(await videoIdOf(p)).toBe(VIDEO);
      await expect(p.getByText('YouTube Developers Live: Embedded Web Player Customization').first()).toBeVisible();
    }
    // Privacy-enhanced player, in a sandboxed frame; nothing else on the page talks to YouTube.
    const src = await host.locator('iframe.yt-frame').getAttribute('src');
    expect(src).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
    expect(await host.locator('iframe.yt-frame').getAttribute('sandbox')).toContain('allow-scripts');
    // The length comes from the players (YouTube doesn't tell the host): the bar shows 22 minutes.
    await expect(a.getByText(/^22:2\d$/)).toBeVisible({ timeout: 20_000 });
  });

  test('play starts together and stays in sync', async () => {
    await pressKey(host, 'k');
    await expectInSync([host, a, b], { paused: false, tol: 0.3 });
    // Still together a few seconds later (drift correction in 0.05 speed steps).
    await host.waitForTimeout(4000);
    await expectInSync([host, a, b], { paused: false, tol: 0.25 });
  });

  test('a guest jumps ahead and everyone follows', async () => {
    const before = (await player(host))!.t;
    await pressKey(a, 'l');
    await expectInSync([host, a, b], { paused: false, tol: 0.35, near: before + 12 });
  });

  test('clicking the picture inside YouTube\'s player pauses it for everyone', async () => {
    await clickPicture(a);
    await expectInSync([host, a, b], { paused: true, tol: 0.3 });
    await expect(host.getByText('Aziz paused').first()).toBeVisible();
    // ... and clicking again plays it for everyone.
    await clickPicture(a);
    await expectInSync([host, a, b], { paused: false, tol: 0.35 });
  });

  test('when only the host controls playback, a guest\'s click in the picture is undone', async () => {
    await host.getByRole('tab', { name: /Room/ }).click();
    await host.getByRole('radio', { name: 'Only me' }).click();
    await expect.poll(() => a.evaluate(() => document.body.innerText.includes('host-only'))).toBe(true);
    await clickPicture(b);
    await expect(b.getByText('The host is controlling playback in this room.')).toBeVisible();
    // The room kept playing, and the guest is back with everyone.
    await expectInSync([host, a, b], { paused: false, tol: 0.4 });
    await host.getByRole('radio', { name: 'Everyone' }).click();
    await host.getByRole('tab', { name: /Chat/ }).click();
  });

  test('a YouTube link in the chat can be watched together', async () => {
    await pressKey(host, 'k'); // pause first, so switching needs no confirmation
    await expectInSync([host, a, b], { paused: true, tol: 0.4 });
    await a.getByLabel('Chat message').fill(`this one! https://youtu.be/${SECOND}`);
    await a.getByLabel('Chat message').press('Enter');
    // The host looked it up: a card with its title and channel.
    await expect(host.getByText('Me at the zoo')).toBeVisible({ timeout: 20_000 });
    await host.getByRole('button', { name: 'Watch together' }).click();
    for (const p of [host, a, b]) await expect.poll(() => videoIdOf(p), { timeout: 20_000 }).toBe(SECOND);
    await Promise.all([waitReady(host), waitReady(a), waitReady(b)]);
    await expect(a.getByText('Playing now')).toBeVisible();
    await pressKey(host, 'k');
    await expectInSync([host, a, b], { paused: false, tol: 0.35 });
  });

  test('a link that can\'t be played gets a clear answer', async () => {
    // A host running from the command line has no file dialog: the button goes straight to the YouTube box.
    await host.getByRole('button', { name: 'Watch a YouTube video' }).click();
    const input = host.getByLabel('YouTube link');
    await input.fill('https://example.com/watch?v=abc');
    await input.press('Enter');
    await expect(host.getByRole('alert')).toContainText('isn\'t a link to a YouTube video');
    await input.fill('https://youtu.be/aaaaaaaaaaa');
    await input.press('Enter');
    await expect(host.getByRole('alert')).toContainText(/does not exist|does not allow/, { timeout: 20_000 });
    expect(await videoIdOf(a)).toBe(SECOND);
  });
});
