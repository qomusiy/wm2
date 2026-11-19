import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, expect, test } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = JSON.parse(readFileSync(join(__dirname, '.host.json'), 'utf8')) as { joinUrl: string };

test('phone: tapping the video brings hidden controls back (and a second tap hides them)', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill('Phone');
  await page.getByRole('button', { name: 'Join' }).tap();
  const player = page.locator('[data-controls]');
  await expect(player).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: 'Play', exact: true }).tap();
  await expect.poll(() => page.evaluate(() => !document.querySelector('video')!.paused), { timeout: 15_000 }).toBe(true);
  // Controls auto-hide while playing.
  await expect(player).toHaveAttribute('data-controls', 'hidden', { timeout: 8_000 });

  const box = (await player.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(player).toHaveAttribute('data-controls', 'visible');
  await page.waitForTimeout(1200);
  await expect(player).toHaveAttribute('data-controls', 'visible'); // still up, not flashed away
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  // A second tap on the picture hides them again.
  await page.waitForTimeout(400);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(player).toHaveAttribute('data-controls', 'hidden');

  // Tap to show, then use a control: the room pauses and controls stay visible.
  await page.waitForTimeout(400);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('button', { name: 'Pause' }).tap();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused), { timeout: 10_000 }).toBe(true);
  await expect(player).toHaveAttribute('data-controls', 'visible');
  await ctx.close();
});

test('phone in landscape: message cards open with a tap, take a reply, and swipe away', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7 landscape'] });
  const page = await ctx.newPage();
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill('Lana');
  await page.getByRole('button', { name: 'Join' }).tap();
  await expect(page.locator('[data-controls]')).toBeVisible();

  const desk = await (await browser.newContext({ viewport: { width: 1200, height: 760 } })).newPage();
  await desk.goto(host.joinUrl);
  await desk.getByPlaceholder('How friends will see you').fill('Desk');
  await desk.getByRole('button', { name: 'Join' }).click();
  const say = async (text: string) => {
    await desk.getByLabel('Chat message').fill(text);
    await desk.getByLabel('Chat message').press('Enter');
  };

  await say('popcorn is ready');
  const card = page.getByRole('article', { name: 'Message from Desk' });
  await expect(card).toContainText('popcorn is ready');
  const reply = card.getByRole('button', { name: 'Reply' });
  await expect(reply).toBeHidden(); // a quiet card is just the message
  const box = (await card.boundingBox())!;
  await page.touchscreen.tap(box.x + 24, box.y + 20);
  await expect(reply).toBeVisible();
  await reply.tap();
  await page.getByRole('textbox', { name: 'Reply to Desk' }).fill('bring it');
  await page.getByRole('textbox', { name: 'Reply to Desk' }).press('Enter');
  await expect(card).toContainText('Reply sent');
  await expect(desk.getByText('bring it')).toBeVisible();
  await expect(card).toBeHidden({ timeout: 5000 });

  // Swipe a card to the right to dismiss it before its time is up.
  await say('swipe me away');
  const next = page.getByRole('article', { name: 'Message from Desk' });
  await expect(next).toContainText('swipe me away');
  const b = (await next.boundingBox())!;
  const cdp = await ctx.newCDPSession(page);
  const y = b.y + b.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 30, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + 30 + i * 13, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(next).toBeHidden({ timeout: 1000 });

  await desk.close();
  await ctx.close();
});
