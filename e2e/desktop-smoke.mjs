// Launches the real desktop app hidden (offscreen) and captures screens.
// Usage: node e2e/desktop-smoke.mjs <outDir> [video file | YouTube link]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
const [outDir, arg] = process.argv.slice(2);
const youtube = arg && /^https:\/\//.test(arg) ? arg : null;
const video = youtube ? null : arg;
// Throwaway cache and settings folders: the smoke test must never touch the real recent list or cache.
const scratch = mkdtempSync(join(tmpdir(), 'watchroom-smoke-'));
const app = await electron.launch({
  executablePath: 'node_modules/electron/dist/electron',
  args: ['apps/desktop', ...(video ? [video] : [])],
  env: Object.fromEntries(Object.entries({
    ...process.env, WATCHROOM_HIDDEN: '1', WATCHROOM_LINK: 'local',
    WATCHROOM_DATA_DIR: join(scratch, 'cache'), WATCHROOM_STATE_DIR: join(scratch, 'state'),
  }).filter(([k]) => !k.startsWith('ELECTRON_'))),
  timeout: 30000,
});
const errors = [];
const shot = async (path) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage();
    return img.toPNG().toString('base64');
  });
  (await import('node:fs')).writeFileSync(path, Buffer.from(b64, 'base64'));
};
const win = await app.firstWindow();
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);
const hasBridge = await win.evaluate(() => typeof window.watchroomHost === 'object' && typeof window.watchroomHost.openVideoDialog === 'function');
const nodeLeak = await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined');
console.log('bridge exposed:', hasBridge, '| node globals leaked into page:', nodeLeak);
if (video) {
  await win.waitForSelector('video', { timeout: 20000 });
  await win.waitForTimeout(2500);
  await shot(`${outDir}/e2-host-room.png`);
  await win.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Invite').click());
  await win.waitForTimeout(800);
  await shot(`${outDir}/e3-share.png`);
  await win.keyboard.press('Escape');
  await win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.includes('Room')).click());
  await win.waitForTimeout(6000);
  await shot(`${outDir}/e4-room-panel.png`);
  const st = await win.evaluate(() => window.watchroomHost.getStatus());
  console.log('subtitles:', st.media.descriptor?.subtitles.map((t) => `${t.label}:${t.status}`).join(', '), '| thumbnails:', st.media.descriptor?.thumbnails?.count, '| upload history samples:', st.stats.uploadHistory.length);
  const status = await win.evaluate(() => window.watchroomHost.getStatus());
  console.log('media:', status.media.descriptor?.title, '| levels:', status.media.descriptor?.levels.map((l) => l.label).join(', '), '| encoder:', status.system.encoder, '| copy:', status.media.copyAvailable);
  console.log('direct connections available:', status.stats.directAvailable, '| sandbox:', status.system.sandbox?.state, `(${status.system.sandbox?.detail})`);
  // Back to the home screen: the video is now on the recent list, with its poster.
  await win.evaluate(() => window.watchroomHost.closeVideo());
  await win.waitForSelector('section[aria-label="Recent videos"] img', { timeout: 20000 });
  await win.waitForTimeout(400);
  await shot(`${outDir}/e5-home-recent.png`);
  const recent = await win.evaluate(() => window.watchroomHost.listRecent());
  console.log('recent:', recent.map((r) => `${r.title} (${r.fileName}) poster=${Boolean(r.poster)}`).join(', '));
} else if (youtube) {
  // The host pastes a YouTube link on the home screen; the window plays it in YouTube's player.
  const origin = await win.evaluate(() => location.origin);
  console.log('window origin:', origin);
  await win.getByLabel('YouTube link').fill(youtube);
  await win.getByRole('button', { name: 'Watch', exact: true }).click();
  await win.waitForSelector('iframe.yt-frame', { timeout: 20000 });
  const ready = await win.waitForFunction(() => {
    const s = window.__watchroomPlayer?.();
    return s && (s.ready || s.fatal) ? s : null;
  }, null, { timeout: 60000 }).then((h) => h.jsonValue());
  console.log('youtube player:', JSON.stringify(ready));
  await win.evaluate(() => document.activeElement?.blur());
  await win.keyboard.press('k');
  await win.waitForTimeout(5000);
  const playing = await win.evaluate(() => window.__watchroomPlayer());
  console.log('after play:', JSON.stringify({ t: playing.t.toFixed(2), paused: playing.paused, quality: playing.quality, sync: playing.sync.state }));
  await shot(`${outDir}/y1-host-youtube.png`);
  const status = await win.evaluate(() => window.watchroomHost.getStatus());
  console.log('media:', status.media.descriptor?.kind, status.media.descriptor?.title, '| duration:', status.media.descriptor?.duration);
  await win.evaluate(() => window.watchroomHost.closeVideo());
  await win.waitForSelector('section[aria-label="Recent videos"]', { timeout: 20000 });
  await win.waitForTimeout(3000);
  await shot(`${outDir}/y2-home-recent.png`);
  const recent = await win.evaluate(() => window.watchroomHost.listRecent());
  console.log('recent:', recent.map((r) => `${r.kind}: ${r.title} (${r.folder}) at ${Math.round(r.position)}s poster=${Boolean(r.poster)}`).join(', '));
} else {
  await shot(`${outDir}/e1-host-home.png`);
}
console.log('errors:', errors.length ? errors : 'none');
await app.close();
