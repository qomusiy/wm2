/*
 * Entry point for the Electron utility process. The server runs isolated from the UI and is driven over
 * Electron's private parentPort channel: host powers never travel over the network.
 */
import type { HostRpc, LinkMode } from '@watchroom/protocol';
import { WatchroomServer } from './app';
import { createLogger } from './util/log';

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('utility.cjs must run as an Electron utility process');
const log = createLogger('utility');

const ALLOWED: (keyof HostRpc)[] = [
  'getStatus', 'hostJoin', 'openVideo', 'closeVideo', 'setLinkMode', 'retryTunnel', 'regenerateLink', 'addSubtitle',
  'listRecent', 'openRecent', 'removeRecent',
];

async function main(): Promise<void> {
  const server = new WatchroomServer({
    port: Number(process.env.WATCHROOM_PORT ?? 0),
    staticDir: process.env.WATCHROOM_STATIC_DIR ?? null,
    dataDir: process.env.WATCHROOM_DATA_DIR ?? '.watchroom',
    ...(process.env.WATCHROOM_STATE_DIR ? { stateDir: process.env.WATCHROOM_STATE_DIR } : {}),
    ...(['tunnel', 'lan', 'local', 'custom'].includes(process.env.WATCHROOM_LINK ?? '') ? { linkMode: process.env.WATCHROOM_LINK as LinkMode } : {}),
  });
  await server.start();
  server.on('status', (status) => parentPort!.postMessage({ event: 'status', data: status }));
  parentPort!.on('message', async ({ data }) => {
    const msg = data as { id?: number; method?: string; params?: unknown[]; shutdown?: boolean };
    if (msg.shutdown) {
      await server.stop().catch(() => {});
      parentPort!.postMessage({ event: 'stopped' });
      process.exit(0);
    }
    if (typeof msg.id !== 'number' || !ALLOWED.includes(msg.method as keyof HostRpc)) return;
    try {
      const fn = (server[msg.method as keyof HostRpc] as (...a: unknown[]) => unknown).bind(server);
      const result = await fn(...(Array.isArray(msg.params) ? msg.params : []));
      parentPort!.postMessage({ id: msg.id, result });
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: (err as Error).message });
    }
  });
  parentPort!.postMessage({ event: 'ready', port: server.port });
  log.info('utility process ready');
}

main().catch((err) => {
  log.error('fatal', err);
  parentPort.postMessage({ event: 'fatal', error: (err as Error).message });
  process.exit(1);
});
