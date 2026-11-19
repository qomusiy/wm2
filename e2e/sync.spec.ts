import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { expect, test, type Browser, type Page } from '@playwright/test';
import { controllableNetwork, setRoomPlaying, type NetworkControl } from './net';

const host = JSON.parse(readFileSync(join(__dirname, '.host.json'), 'utf8')) as { hostUrl: string; joinUrl: string };

interface VideoState { t: number; paused: boolean; rate: number }
const video = (p: Page): Promise<VideoState> => p.evaluate(() => {
  const v = document.querySelector('video')!;
  return { t: v.currentTime, paused: v.paused, rate: v.playbackRate };
});

const networks = new WeakMap<Page, NetworkControl>();

async function joinGuest(browser: Browser, name: string, viewport = { width: 1280, height: 760 }, opts: { direct?: boolean } = {}): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  networks.set(page, await controllableNetwork(page));
  // A viewer whose network is slowed down by the test must not get video another way.
  if (opts.direct === false) await page.addInitScript(() => localStorage.setItem('wr:p2p:route', JSON.stringify('off')));
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForSelector('video');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  return page;
}

/** All pages playing (or paused) and within `tol` seconds of each other. */
async function expectInSync(pages: Page[], opts: { paused: boolean; tol: number; near?: number }) {
  await expect.poll(async () => {
    const states = await Promise.all(pages.map(video));
    if (states.some((s) => s.paused !== opts.paused)) return `paused mismatch ${JSON.stringify(states)}`;
    const ts = states.map((s) => s.t);
    const spread = Math.max(...ts) - Math.min(...ts);
    if (spread > opts.tol) return `spread ${spread.toFixed(3)}s ${ts.map((t) => t.toFixed(2)).join(',')}`;
    if (opts.near !== undefined && Math.abs(ts[0]! - opts.near) > 1.5) return `not near ${opts.near}: ${ts[0]}`;
    return 'ok';
  }, { timeout: 25_000, intervals: [250] }).toBe('ok');
}

const intent = (p: Page, key: string) => p.keyboard.press(key);

test.describe.serial('watch together', () => {
  let hostPage: Page;
  let a: Page;
  let b: Page;

  test('host and two guests join and see each other', async ({ browser }) => {
    hostPage = await (await browser.newContext({ viewport: { width: 1400, height: 820 } })).newPage();
    await hostPage.goto(host.hostUrl);
    await hostPage.waitForSelector('video');
    await setRoomPlaying(hostPage, false);
    a = await joinGuest(browser, 'Aziz');
    b = await joinGuest(browser, 'Dilnoza', { width: 390, height: 800 }, { direct: false });
    await hostPage.getByRole('tab', { name: /People/ }).click();
    await expect(hostPage.getByText('Aziz', { exact: true })).toBeVisible();
    await expect(hostPage.getByText('Dilnoza', { exact: true })).toBeVisible();
    await hostPage.getByRole('tab', { name: /Chat/ }).click();
  });

  test.afterAll(async () => {
    for (const p of [a, b, hostPage]) if (p && !p.isClosed()) await p.context().close();
  });

  test('play from the host starts everyone together', async () => {
    await hostPage.mouse.move(400, 300);
    await intent(hostPage, 'k');
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.25 });
    await hostPage.waitForTimeout(3000);
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.2 });
  });

  test('a guest pause pauses everyone at the same frame', async () => {
    await intent(a, 'k');
    await expectInSync([hostPage, a, b], { paused: true, tol: 0.15 });
  });

  test('a guest seek moves everyone and keeps them together', async () => {
    await intent(b, '5'); // jump to 50%
    await expectInSync([hostPage, a, b], { paused: true, tol: 0.15, near: 120 });
    await intent(b, 'k');
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.25 });
  });

  test('a late joiner lands in sync with a playing room', async ({ browser }) => {
    await intent(a, '1'); // back to 10% so there is time left
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.25 });
    const late = await joinGuest(browser, 'Late');
    await expectInSync([hostPage, a, b, late], { paused: false, tol: 0.35 });
    await late.close();
  });

  test('speed is shared by the room', async () => {
    await a.keyboard.press('Shift+Period'); // '>' faster
    await expect.poll(async () => (await video(b)).rate, { timeout: 10_000 }).toBeGreaterThanOrEqual(1.2);
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.35 });
    await a.keyboard.press('Shift+Comma'); // back to 1x
    await expect.poll(async () => Math.abs((await video(b)).rate - 1) < 0.1, { timeout: 10_000 }).toBe(true);
  });

  test('quality is per viewer', async () => {
    await a.mouse.move(400, 300);
    await a.getByRole('button', { name: 'Quality' }).click();
    await a.getByRole('menuitemradio', { name: /^360p/ }).click();
    // A's manual choice applies only to A: B stays on automatic, the host on the original.
    await expect(a.locator('footer')).toContainText('360p', { timeout: 30_000 });
    await expect(a.locator('footer')).not.toContainText('Auto');
    await expect(b.locator('footer')).toContainText('Auto');
    await expect(hostPage.locator('footer')).toContainText('Original');
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.35 });
  });

  test('chat messages reach everyone, system events are distinct', async () => {
    await b.getByLabel('Chat message').fill('Hi everyone!');
    await b.keyboard.press('Enter');
    await expect(hostPage.getByText('Hi everyone!')).toBeVisible();
    await expect(a.getByText('Hi everyone!')).toBeVisible();
    await expect(hostPage.getByText('Aziz paused at')).toBeVisible();
  });

  test('a dropped connection resumes the same seat and re-syncs', async () => {
    const net = networks.get(a)!;
    await net.cut();
    await expect(a.locator('footer')).toContainText(/Reconnecting|Connecting/, { timeout: 10_000 }); // really dropped
    await a.waitForTimeout(4000);
    await net.restore();
    await expect(a.locator('footer')).toContainText('Connected', { timeout: 20_000 });
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.35 });
    await expect(hostPage.getByText('Aziz left')).toHaveCount(0);
  });

  test('the room waits for a viewer whose video stalls', async () => {
    // Pause, then make every new segment for guest B take 6 seconds and seek far ahead.
    await intent(hostPage, 'k');
    await expectInSync([hostPage, a, b], { paused: true, tol: 0.2 });
    // Start B with an empty buffer (a refresh keeps the seat), so there is video it hasn't loaded yet.
    await b.reload();
    await b.waitForSelector('video');
    await expectInSync([hostPage, a, b], { paused: true, tol: 0.2 });
    await b.route('**/*.ts', async (route) => {
      await new Promise((r) => setTimeout(r, 6000));
      await route.continue();
    });
    // Jump to a 10% mark that B has *not* buffered (browsers keep data read ahead earlier, even after seeking away).
    const ranges = await b.evaluate(() => {
      const v = document.querySelector('video')!;
      return Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)] as [number, number]);
    });
    const digit = [9, 8, 7, 6, 5, 4, 3, 2].find((d) => ranges.every(([s0, e0]) => d * 24 < s0 - 8 || d * 24 > e0 + 8));
    expect(digit, `no unbuffered target in ${JSON.stringify(ranges)}`).toBeDefined();
    const target = digit! * 24;
    await intent(hostPage, String(digit));
    await expectInSync([hostPage, a], { paused: true, tol: 0.2, near: target });
    await intent(hostPage, 'k');
    // While B can't load, nobody runs ahead: the start waits for readiness (bounded by the start timeout).
    await hostPage.waitForTimeout(2500);
    const early = await video(hostPage);
    expect(early.paused || early.t < target + 1.5, `host at ${early.t}`).toBe(true);
    await expect(hostPage.locator('footer')).toContainText(/Starting|Waiting/);
    await b.unroute('**/*.ts');
    await expectInSync([hostPage, a, b], { paused: false, tol: 0.4 });
  });
});
