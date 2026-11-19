import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { setRoomPlaying } from './net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = JSON.parse(readFileSync(join(__dirname, '.host.json'), 'utf8')) as { hostUrl: string; joinUrl: string };

async function joinGuest(browser: Browser, name: string, route?: 'direct'): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  // On one machine HTTP is as fast as anything; pin the route so the test checks the direct path deterministically.
  if (route) await page.addInitScript((r) => localStorage.setItem('wr:p2p:route', JSON.stringify(r)), route);
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForSelector('video');
  return page;
}

test.describe.serial('direct connections', () => {
  let h: Page;
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    h = await (await browser.newContext({ viewport: { width: 1400, height: 860 } })).newPage();
    await h.goto(host.hostUrl);
    await h.waitForSelector('video');
    await h.getByRole('tab', { name: /Room/ }).click();
    await setRoomPlaying(h, false);
  });

  test.afterAll(async () => {
    if (h && !h.isClosed()) await setRoomPlaying(h, false).catch(() => {});
    await Promise.all([a, b, h].map((p) => (p && !p.isClosed() ? p.context().close() : undefined)));
  });

  test('a viewer connects straight to the host and gets video that way', async ({ browser }) => {
    a = await joinGuest(browser, 'Ada', 'direct');
    await expect(h.getByText('direct', { exact: true })).toBeVisible();
    await expect(h.getByText(/1 of 1 connected directly/)).toBeVisible();
    await setRoomPlaying(h, true);
    await expect.poll(() => a.evaluate(() => !document.querySelector('video')!.paused), { timeout: 20_000 }).toBe(true);
    // On one machine HTTP fills the buffer before the direct connection is up; jump to fresh video now that it is.
    const route = h.getByRole('listitem', { name: 'Ada' }).getByTitle(/^Connected directly to this computer/);
    const amounts = async () => {
      const t = (await route.getAttribute('title')) ?? '';
      const n = (re: RegExp) => Number(re.exec(t)?.[1] ?? 0);
      return { direct: n(/([\d.]+) MB direct/), link: n(/([\d.]+) MB via link/) };
    };
    await a.waitForTimeout(2500); // let a status report arrive
    const before = await amounts();
    const start = await a.evaluate(() => performance.now());
    await h.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await h.keyboard.press('6'); // 60% into the video: nothing buffered there yet
    await expect.poll(() => a.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 20_000 }).toBeGreaterThan(130);
    await expect.poll(() => a.evaluate(() => {
      const v = document.querySelector('video')!;
      return v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
    }), { timeout: 30_000 }).toBeGreaterThan(30);
    await a.waitForTimeout(2500);
    const after = await amounts();
    const httpAfterSeek = await a.evaluate((t0) => performance.getEntriesByType('resource')
      .filter((e) => /\/\d+\.ts$/.test(e.name) && e.startTime > t0).length, start);
    console.log('direct MB', before.direct, '->', after.direct, '| link MB', before.link, '->', after.link, '| HTTP segments after seek', httpAfterSeek);
    expect(after.direct - before.direct).toBeGreaterThan(1);
    expect(httpAfterSeek).toBeLessThanOrEqual(2); // at most what was already in flight at the moment of the seek
  });

  test('a second viewer gets segments from the first one, verified, and both stay in sync', async ({ browser }) => {
    // Ada has read ahead by now; Bea joins the playing room at the same quality.
    await a.waitForTimeout(6000);
    b = await joinGuest(browser, 'Bea');
    await expect(h.getByText(/direct · 1 friend/).first()).toBeVisible({ timeout: 30_000 });
    await expect(h.getByText(/MB shared between friends instead of uploaded by you/)).toBeVisible({ timeout: 40_000 });
    // Every segment from Ada was checked against the host's fingerprint before playing.
    expect(await b.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('.ts.sha256')).length)).toBeGreaterThan(0);
    await expect.poll(() => b.evaluate(() => !document.querySelector('video')!.paused), { timeout: 20_000 }).toBe(true);
    const times = async () => Promise.all([a, b].map((p) => p.evaluate(() => document.querySelector('video')!.currentTime)));
    await expect.poll(async () => { const [x, y] = await times(); return Math.abs(x! - y!); }, { timeout: 20_000 }).toBeLessThan(0.25);
  });

  test('turning direct connections off moves everyone back to the link without interrupting playback', async () => {
    await h.getByRole('switch', { name: 'Direct connections' }).click();
    await expect(a.getByText('turned off direct connections').first()).toBeAttached();
    await expect(h.getByText(/connected directly/)).toBeHidden();
    const before = await b.evaluate(() => document.querySelector('video')!.currentTime);
    await b.waitForTimeout(5000);
    expect(await b.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(before + 3);
    await h.getByRole('switch', { name: 'Direct connections' }).click();
    await expect(h.getByText(/2 of 2 connected directly/)).toBeVisible({ timeout: 30_000 });
    await h.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await h.keyboard.press('k'); // pause
  });

  test('a viewer who sends tampered video is caught by the fingerprint check and ignored from then on', async ({ browser }) => {
    await Promise.all([a, b].map((p) => p.context().close()));
    // Eve's browser corrupts every binary message it sends to other viewers.
    const eveCtx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    await eveCtx.addInitScript(() => {
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) {
        if (typeof data !== 'string' && ArrayBuffer.isView(data) && data.byteLength > 100) {
          const copy = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          for (let i = 50; i < copy.length; i += 97) copy[i] ^= 0xff;
          return send.call(this, copy);
        }
        return send.call(this, data as never);
      };
    });
    const eve = await eveCtx.newPage();
    await eve.goto(host.joinUrl);
    await eve.getByPlaceholder('How friends will see you').fill('Eve');
    await eve.getByRole('button', { name: 'Join' }).click();
    await eve.waitForSelector('video');
    await h.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await h.keyboard.press('k'); // play
    await expect.poll(() => eve.evaluate(() => {
      const v = document.querySelector('video')!;
      return v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
    }), { timeout: 30_000 }).toBeGreaterThan(40);
    const eveId = await eve.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.startsWith('wr:resume:'))!)!).participantId as string);

    // Fay's link is slow (as over the internet), so once a direct connection to Eve is up she asks Eve. On one machine
    // she would otherwise fill her whole buffer over HTTP before any connection to Eve exists.
    const fayCtx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    await fayCtx.addInitScript(() => localStorage.setItem('wr:p2p:route', JSON.stringify('link')));
    await fayCtx.route(/\/media\/.+\.ts$/, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue().catch(() => {});
    });
    const fay = await fayCtx.newPage();
    await fay.goto(host.joinUrl);
    await fay.getByPlaceholder('How friends will see you').fill('Fay');
    await fay.getByRole('button', { name: 'Join' }).click();
    await fay.waitForSelector('video');
    const state = () => fay.evaluate(() => (window as unknown as { __watchroomP2P(): { banned: string[]; stats: { fromPeers: number } } }).__watchroomP2P());
    await expect.poll(async () => (await state()).banned, { timeout: 40_000 }).toContain(eveId).catch(async (err) => {
      // Explain a failure: what each side saw.
      console.log('Fay:', JSON.stringify(await fay.evaluate(() => (window as unknown as { __watchroomP2P(): unknown }).__watchroomP2P())));
      console.log('Eve:', JSON.stringify(await eve.evaluate(() => (window as unknown as { __watchroomP2P(): unknown }).__watchroomP2P())));
      throw err;
    });
    expect((await state()).stats.fromPeers).toBe(0); // nothing from Eve was accepted
    // Fay keeps watching normally (segments came over the link instead).
    await fayCtx.unroute(/\/media\/.+\.ts$/);
    const t1 = await fay.evaluate(() => document.querySelector('video')!.currentTime);
    await fay.waitForTimeout(4000);
    expect(await fay.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(t1 + 3);
    await h.keyboard.press('k');
    await Promise.all([eve, fay].map((p) => p.context().close()));
  });
});
