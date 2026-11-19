import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { setRoomPlaying } from './net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = JSON.parse(readFileSync(join(__dirname, '.host.json'), 'utf8')) as { hostUrl: string; joinUrl: string };

async function joinGuest(browser: Browser, name: string, opts: Parameters<Browser['newContext']>[0] = { viewport: { width: 1280, height: 760 } }): Promise<Page> {
  const page = await (await browser.newContext(opts)).newPage();
  await page.goto(host.joinUrl);
  await page.getByPlaceholder('How friends will see you').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForSelector('video');
  return page;
}

test.describe.serial('chat, reactions, subtitles and room settings', () => {
  let h: Page;
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    h = await (await browser.newContext({ viewport: { width: 1400, height: 820 } })).newPage();
    await h.goto(host.hostUrl);
    await h.waitForSelector('video');
    await setRoomPlaying(h, false);
    a = await joinGuest(browser, 'Ann');
    b = await joinGuest(browser, 'Ben');
  });

  // Specs share one host: leave the room (and stop decoding video) so later specs start clean.
  test.afterAll(async () => {
    for (const p of [a, b, h]) if (p && !p.isClosed()) await p.context().close();
  });

  test('emoji picker inserts into the message; emoji-only messages are shown large', async () => {
    await a.getByRole('button', { name: 'Emoji', exact: true }).click();
    await a.getByPlaceholder('Search emoji').fill('popcorn');
    await a.locator('button[title^="popcorn"]').first().click();
    await a.getByLabel('Chat message').press('End');
    await a.getByLabel('Chat message').pressSequentially(' snacks ready');
    await a.getByLabel('Chat message').press('Enter');
    await expect(b.getByText('🍿 snacks ready')).toBeVisible();
    await a.keyboard.press('Escape');
    await a.getByLabel('Chat message').fill('🔥🔥');
    await a.getByLabel('Chat message').press('Enter');
    const jumbo = b.locator('div', { hasText: /^🔥🔥$/ }).last();
    await expect(jumbo).toBeVisible();
    expect(await jumbo.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(24);
  });

  test('stickers arrive for everyone', async () => {
    await b.getByRole('button', { name: 'Stickers' }).click();
    await b.getByRole('button', { name: 'Send popcorn sticker' }).click();
    await expect(a.getByRole('img', { name: 'popcorn sticker' })).toBeVisible();
    await expect(h.getByRole('img', { name: 'popcorn sticker' })).toBeVisible();
  });

  test('pictures are compressed, uploaded and shown with their caption; the lightbox opens', async () => {
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1800x1200', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']);
    await a.getByLabel('Chat message').fill('our view tonight');
    await a.locator('input[type=file]').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: png });
    const pic = b.getByRole('button', { name: 'Open picture from Ann' });
    await expect(pic).toBeVisible();
    await expect(b.getByText('our view tonight')).toBeVisible();
    // The browser resized it before sending: the host never stores more than 1600px on the long side.
    const natural = await pic.locator('img').evaluate(async (img: HTMLImageElement) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
    expect(Math.max(...natural)).toBeLessThanOrEqual(1600);
    await pic.click();
    await expect(b.getByRole('dialog', { name: 'Picture' })).toBeVisible();
    await b.keyboard.press('Escape');
    await expect(b.getByRole('dialog', { name: 'Picture' })).toHaveCount(0);
  });

  test('typing is shown to others and cleared when the message is sent', async () => {
    await b.getByLabel('Chat message').pressSequentially('hello there');
    await expect(a.getByText('Ben is typing…')).toBeVisible();
    await b.getByLabel('Chat message').press('Enter');
    await expect(a.getByText('Ben is typing…')).toHaveCount(0);
  });

  test("reactions float over everyone's video", async () => {
    await b.mouse.move(400, 300);
    await b.getByRole('button', { name: 'React', exact: true }).click();
    await b.getByRole('button', { name: 'React 🎉' }).click();
    await expect(a.locator('[class*="reactionEmoji"]', { hasText: '🎉' })).toBeVisible();
    await expect(a.locator('[class*="reactionName"]', { hasText: 'Ben' })).toBeVisible();
  });

  test('subtitles next to the video can be turned on per person', async () => {
    await h.keyboard.press('Home');
    await h.keyboard.press('0'); // jump to the start (paused)
    await a.mouse.move(400, 300);
    await expect.poll(async () => a.getByRole('button', { name: 'Subtitles' }).count(), { timeout: 30_000 }).toBe(1);
    await a.getByRole('button', { name: 'Subtitles' }).click();
    const english = a.getByRole('menuitemradio', { name: /English/ });
    await expect(english).toBeEnabled({ timeout: 30_000 });
    await english.click();
    await a.keyboard.press('Escape');
    await h.keyboard.press('k');
    await expect(a.getByText('External English subtitle line')).toBeVisible({ timeout: 15_000 });
    await expect(b.getByText('External English subtitle line')).toHaveCount(0); // Ben didn't turn them on
    await h.keyboard.press('k');
  });

  test('styled (ASS) subtitles keep their positions, colours and styling', async () => {
    await a.mouse.move(400, 300);
    await a.getByRole('button', { name: 'Subtitles' }).click();
    const signs = a.getByRole('menuitemradio', { name: /signs/i });
    await expect(signs).toBeEnabled({ timeout: 30_000 });
    await signs.click();
    await a.keyboard.press('Escape');
    await a.mouse.move(5, 5); // let the controls hide so nothing overlaps
    const video = (await a.locator('video').boundingBox())!;
    const sign = a.getByText('ROAD SIGN', { exact: true });
    await expect(sign).toBeVisible({ timeout: 15_000 });
    const sb = (await sign.boundingBox())!;
    // \pos(640,100) on a 1280×720 script, centred horizontally, anchored at its top edge.
    const picture = { top: video.y + (video.height - video.width * 9 / 16) / 2, h: video.width * 9 / 16 };
    expect(Math.abs(sb.x + sb.width / 2 - (video.x + video.width / 2))).toBeLessThan(8);
    expect(Math.abs(sb.y - (picture.top + (100 / 720) * picture.h))).toBeLessThan(8);
    expect(await sign.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 0)');
    expect(await sign.evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(700);
    // Dialogue: bottom centre, two rows, one italic word.
    const italic = a.getByText('dialogue', { exact: true });
    expect(await italic.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
    const db = (await a.getByText('second row', { exact: true }).boundingBox())!;
    expect(db.y).toBeGreaterThan(picture.top + picture.h * 0.6); // lower part (lifted above the controls while paused)
    // \an1 + red: bottom left.
    const corner = a.getByText('Red corner note', { exact: true });
    expect(await corner.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 0, 0)');
    const cb = (await corner.boundingBox())!;
    expect(cb.x).toBeLessThan(video.x + video.width * 0.2);
    // Vector drawings and comments never appear as text.
    await expect(a.getByText(/m 0 0 l/)).toHaveCount(0);
    await expect(a.getByText(/this comment/)).toHaveCount(0);
    // Turn subtitles off again for the following tests.
    await a.mouse.move(400, 300);
    await a.getByRole('button', { name: 'Subtitles' }).click();
    await a.getByRole('menuitemradio', { name: 'Off' }).click();
    await a.keyboard.press('Escape');
  });

  test('seek bar shows preview thumbnails', async () => {
    const seek = b.locator('[aria-label="Seek"]');
    await expect.poll(async () => {
      const sb = (await seek.boundingBox())!;
      await seek.hover({ position: { x: 20, y: sb.height / 2 }, timeout: 3000 });
      await seek.hover({ position: { x: sb.width * 0.5, y: sb.height / 2 }, timeout: 3000 });
      return b.locator('[class*="thumbTip"]').evaluate((el) => getComputedStyle(el).backgroundImage).catch(() => 'none');
    }, { timeout: 20_000, intervals: [1000] }).toContain('/thumbs/');
  });

  test('host-only control mode stops guests from controlling playback', async () => {
    await h.getByRole('tab', { name: /Room/ }).click();
    await h.getByRole('radio', { name: 'Only me' }).click();
    await expect(a.getByText('made playback controls host-only')).toBeVisible();
    const before = await h.evaluate(() => document.querySelector('video')!.paused);
    await a.mouse.move(400, 300);
    await a.keyboard.press('k');
    await expect(a.getByText('The host is controlling playback in this room.')).toBeVisible();
    await h.waitForTimeout(800);
    expect(await h.evaluate(() => document.querySelector('video')!.paused)).toBe(before);
    await h.getByRole('radio', { name: 'Everyone' }).click();
    await expect(a.getByText('gave everyone playback controls')).toBeVisible();
  });

  test('locking the room keeps newcomers out', async ({ browser }) => {
    await h.getByRole('switch', { name: 'Lock the room' }).click();
    const late = await (await browser.newContext()).newPage();
    await late.goto(host.joinUrl);
    await expect(late.getByText('The host has locked this room.')).toBeVisible();
    await h.getByRole('switch', { name: 'Lock the room' }).click();
    await late.close();
  });

  test('people can rename themselves', async () => {
    await b.getByRole('tab', { name: /People/ }).click();
    await b.getByRole('button', { name: 'Change your name' }).click();
    await b.getByLabel('Your name').fill('Benjamin');
    await b.getByLabel('Your name').press('Enter');
    await h.getByRole('tab', { name: /Chat/ }).click();
    await expect(h.getByText('Ben is now Benjamin')).toBeVisible();
    await expect(b.getByText('Benjamin', { exact: true }).first()).toBeVisible();
    await b.getByRole('tab', { name: /Chat/ }).click();
  });

  test('on a phone in landscape the video fills the screen and new messages float over it', async ({ browser }) => {
    const phone = await joinGuest(browser, 'Lan', { ...devices['Pixel 7 landscape'] });
    await expect(phone.locator('header')).toBeHidden();
    await a.getByLabel('Chat message').fill('hello landscape');
    await a.getByLabel('Chat message').press('Enter');
    await expect(phone.getByText('hello landscape')).toBeVisible();
    await phone.close();
  });

  test('in full screen, messages and arrivals pop up over the video; replies are sent without leaving it', async ({ browser }) => {
    await a.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await a.keyboard.press('f');
    await expect.poll(() => a.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    // A message from Ben pops up as a card; the chat itself stays closed.
    await b.getByLabel('Chat message').fill('did you see that?');
    await b.getByLabel('Chat message').press('Enter');
    const card = a.getByRole('article', { name: 'Message from Benjamin' });
    await expect(card).toContainText('did you see that?');
    const box = (await card.boundingBox())!;
    const vp = a.viewportSize()!;
    expect(box.x + box.width).toBeGreaterThan(vp.width - 40); // bottom-right corner
    expect(box.y).toBeGreaterThan(vp.height / 2);
    expect(box.width).toBeLessThan(vp.width * 0.45);
    // Reply in place.
    await card.hover();
    await card.getByRole('button', { name: 'Reply' }).click();
    await a.getByRole('textbox', { name: 'Reply to Benjamin' }).fill('yes, wild');
    await a.getByRole('textbox', { name: 'Reply to Benjamin' }).press('Enter');
    await expect(card).toContainText('Reply sent');
    expect(await a.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    // Ben sees the reply quoting his message.
    const quote = b.getByRole('button', { name: /did you see that\?/ }).last();
    await expect(quote).toBeVisible();
    await expect(b.getByText('yes, wild')).toBeVisible();
    await a.mouse.move(20, 20);
    await expect(card).toBeHidden({ timeout: 5000 });

    // Cards leave on their own after a readable time.
    await b.getByLabel('Chat message').fill('short one');
    await b.getByLabel('Chat message').press('Enter');
    const second = a.getByRole('article', { name: 'Message from Benjamin' });
    await expect(second).toContainText('short one');
    await a.waitForTimeout(3000);
    await expect(second).toBeVisible(); // still readable after 3 s
    await expect(second).toBeHidden({ timeout: 4000 });

    // Arrivals show as a small notice.
    const cal = await joinGuest(browser, 'Cal');
    await expect(a.getByRole('log', { name: 'New messages' }).getByText('Cal joined')).toBeVisible();

    // Enter opens a message box for the room.
    await a.mouse.move(400, 300);
    await a.keyboard.press('Enter');
    await a.getByLabel('Message the room').fill('from full screen');
    await a.getByLabel('Message the room').press('Enter');
    await expect(b.getByText('from full screen')).toBeVisible();
    await expect(a.getByLabel('Message the room')).toBeHidden();

    // Clicking a card opens the chat drawer at that message.
    await b.getByLabel('Chat message').fill('open me');
    await b.getByLabel('Chat message').press('Enter');
    await a.getByRole('article', { name: 'Message from Benjamin' }).getByText('open me').click();
    const inDrawer = a.locator(':fullscreen [data-mid]', { hasText: 'open me' });
    await expect(inDrawer).toBeVisible();
    await expect(inDrawer).toHaveClass(/highlight/);
    await expect(a.getByRole('article', { name: 'Message from Benjamin' })).toHaveCount(0);
    await a.keyboard.press('c'); // close the drawer again
    await a.evaluate(() => document.exitFullscreen());
    await cal.close();
  });
});
