import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { controllableNetwork, setRoomPlaying } from './net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = JSON.parse(readFileSync(join(__dirname, '.host.json'), 'utf8')) as { hostUrl: string; joinUrl: string };

const video = (p: Page) => p.evaluate(() => {
  const v = document.querySelector('video')!;
  return { t: v.currentTime, paused: v.paused };
});

async function joinGuest(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 740 } })).newPage();
  // These viewers test the link under bad conditions: no direct connections (WebRTC isn't throttled by the emulator).
  await page.addInitScript(() => localStorage.setItem('wr:p2p:route', JSON.stringify('off')));
  (page as Page & { net?: unknown }).net = await controllableNetwork(page);
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForSelector('video');
  return page;
}

async function expectInSync(pages: Page[], tol: number, timeout = 40_000) {
  await expect.poll(async () => {
    const s = await Promise.all(pages.map(video));
    if (s.some((x) => x.paused)) return `paused ${JSON.stringify(s)}`;
    const spread = Math.max(...s.map((x) => x.t)) - Math.min(...s.map((x) => x.t));
    return spread <= tol ? 'ok' : `spread ${spread.toFixed(3)}`;
  }, { timeout, intervals: [300] }).toBe('ok');
}

test.describe.serial('bad networks', () => {
  let h: Page;

  test.beforeAll(async ({ browser }) => {
    h = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
    await h.goto(host.hostUrl);
    await h.waitForSelector('video');
    await setRoomPlaying(h, false);
  });
  test.afterAll(async () => {
    await setRoomPlaying(h, false).catch(() => {});
    await h.context().close();
  });

  test('a viewer on a slow, high-latency link stays in sync and gets a low quality automatically', async ({ browser }) => {
    const slow = await joinGuest(browser, 'Slow');
    const cdp = await slow.context().newCDPSession(slow);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 1_200_000 / 8, uploadThroughput: 500_000 / 8 });
    await h.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await h.keyboard.press('1'); // 10% in: fresh segments for the slow viewer
    await h.keyboard.press('k');
    // 400 ms each way is compensated by the clock sync: still within a few frames of the host.
    await expectInSync([h, slow], 0.3, 60_000);
    await expect.poll(async () => (await slow.locator('footer').textContent()) ?? '', { timeout: 40_000 }).toMatch(/(240p|360p)/);
    const before = (await video(slow)).t;
    await slow.waitForTimeout(6000);
    expect((await video(slow)).t).toBeGreaterThan(before + 5); // playing smoothly, not stalling
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await slow.context().close();
  });

  test('a connection that keeps dropping ends in sync, in the same seat', async ({ browser }) => {
    const flaky = await joinGuest(browser, 'Flaky');
    await expectInSync([h, flaky], 0.35);
    const net = (flaky as Page & { net?: Awaited<ReturnType<typeof controllableNetwork>> }).net!;
    for (let i = 0; i < 5; i++) {
      await net.cut();
      await expect(flaky.locator('footer')).toContainText(/Reconnecting|Connecting/, { timeout: 10_000 }); // really dropped
      await flaky.waitForTimeout(800 + i * 300);
      await net.restore();
      await expect(flaky.locator('footer')).toContainText('Connected', { timeout: 20_000 });
      await flaky.waitForTimeout(500);
    }
    await expect(flaky.locator('footer')).toContainText('Connected', { timeout: 20_000 });
    await expectInSync([h, flaky], 0.35);
    // One seat: no duplicate "Flaky 2", no "left/joined" churn.
    await h.getByRole('tab', { name: /People/ }).click();
    await expect(h.getByText('Flaky', { exact: true })).toHaveCount(1);
    await expect(h.getByText(/^Flaky 2$/)).toHaveCount(0);
    await h.getByRole('tab', { name: /Chat/ }).click();
    await expect(h.getByText('Flaky left')).toHaveCount(0);
    await flaky.context().close();
  });

  test('after an outage longer than the reconnect grace, the viewer rejoins and re-syncs on its own', async ({ browser }) => {
    test.setTimeout(200_000);
    const away = await joinGuest(browser, 'Away');
    await expectInSync([h, away], 0.35);
    const net = (away as Page & { net?: Awaited<ReturnType<typeof controllableNetwork>> }).net!;
    await net.cut();
    // A vanished viewer is noticed by the heartbeat (no goodbye on a real network loss), then keeps the seat for the
    // 30 s reconnect grace: up to about a minute before it's freed.
    await expect(h.getByText('Away left')).toBeVisible({ timeout: 100_000 });
    await net.restore();
    await expect(away.locator('footer')).toContainText('Connected', { timeout: 30_000 });
    await expectInSync([h, away], 0.35);
    await expect(h.getByText('Away joined')).toHaveCount(2); // a fresh seat, announced like any arrival
    await away.context().close();
  });
});
