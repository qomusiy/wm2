import { expect, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * Cuts the page's network for real: HTTP via offline mode, and the room WebSocket by routing it through Playwright
 * (offline mode alone leaves an already-open WebSocket working). Cutting closes both ends of the WebSocket (the
 * server sees the viewer vanish); while cut, reconnect attempts are refused.
 */
export async function controllableNetwork(page: Page) {
  let blocked = false;
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (blocked) {
      void ws.close({ code: 1006, reason: 'network down' }).catch(() => {});
      return;
    }
    const server = ws.connectToServer();
    const pair = { page: ws, server };
    open.add(pair);
    ws.onClose(() => { open.delete(pair); void server.close().catch(() => {}); });
    server.onClose(() => { open.delete(pair); void ws.close().catch(() => {}); });
  });
  return {
    async cut() {
      blocked = true;
      await page.context().setOffline(true);
      for (const pair of [...open]) {
        open.delete(pair);
        await pair.server.close({ code: 1001, reason: 'network down' }).catch(() => {});
        await pair.page.close({ code: 1006, reason: 'network down' }).catch(() => {});
      }
    },
    async restore() {
      blocked = false;
      await page.context().setOffline(false);
    },
  };
}

export type NetworkControl = Awaited<ReturnType<typeof controllableNetwork>>;

/** Puts the shared room into a known state (specs share one host, so a previous spec may have left it playing). */
export async function setRoomPlaying(host: Page, playing: boolean): Promise<void> {
  // The play/pause button is labelled from the room's state ("Pause" while the room plays).
  const button = host.getByRole('button', { name: /^(Play|Pause|Replay)$/ }).first();
  await button.waitFor({ state: 'attached', timeout: 30_000 });
  const isPaused = async () => (await button.getAttribute('aria-label')) !== 'Pause';
  if ((await isPaused()) === !playing) return;
  await host.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await host.keyboard.press('k');
  await expect.poll(isPaused, { timeout: 20_000 }).toBe(!playing);
}
