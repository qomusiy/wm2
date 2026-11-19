/* Headless host: `node dist/cli.cjs --video movie.mkv|<YouTube link> [--link tunnel|lan|local|custom] [--port 0]` */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { localOrigin, parseYouTubeUrl, type LinkMode } from '@watchroom/protocol';
import { WatchroomServer } from './app';
import { createLogger } from './util/log';

const { values } = parseArgs({
  options: {
    video: { type: 'string' },
    link: { type: 'string', default: 'tunnel' },
    custom: { type: 'string' },
    port: { type: 'string', default: '0' },
    'lan-port': { type: 'string', default: '47800' },
    static: { type: 'string' },
    data: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const log = createLogger('cli');
// --data keeps everything in one folder (tests, portable use); otherwise cache and settings follow the XDG layout.
const win = process.platform === 'win32';
const dataDir = values.data ? resolve(values.data) : win
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Watchroom', 'Cache')
  : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'watchroom');
const stateDir = values.data ? dataDir : win
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Watchroom', 'Settings')
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'watchroom');
const staticDir = values.static ? resolve(values.static) : resolve(__dirname, '../../../apps/web/dist');

async function main(): Promise<void> {
  const server = new WatchroomServer({
    port: Number(values.port), lanPort: Number(values['lan-port']), staticDir, dataDir, stateDir,
    linkMode: values.link as LinkMode, customBase: values.custom ?? null,
  });
  await server.start();
  const host = server.hostJoin();
  const hostUrl = `${localOrigin(server.port)}/#host=${host.roomId}.${host.hostToken}`;
  if (values.json) console.log(JSON.stringify({ event: 'ready', port: server.port, hostUrl, roomId: host.roomId }));
  else log.info(`host view: ${hostUrl}`);
  if (values.video) {
    // --video takes a file, or a YouTube link.
    const res = parseYouTubeUrl(values.video) ? await server.openYouTube(values.video) : await server.openVideo(resolve(values.video));
    if (!res.ok) log.error(res.error);
    else if (values.json) console.log(JSON.stringify({ event: 'media', media: res.media }));
  }
  let lastShare: string | null = null;
  server.on('status', (s) => {
    if (s.link.shareUrl && s.link.shareUrl !== lastShare) {
      lastShare = s.link.shareUrl;
      if (values.json) console.log(JSON.stringify({ event: 'share', url: s.link.shareUrl, localUrl: s.link.localUrl }));
      else log.info(`share this link: ${s.link.shareUrl}`);
    }
  });
  if (values.json) console.log(JSON.stringify({ event: 'local', url: server.getStatus().link.localUrl }));
  const shutdown = async () => {
    log.info('shutting down');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
