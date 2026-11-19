import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerSaveBlocker, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin, type HostStatus, type LinkMode } from '@watchroom/protocol';

const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mts', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'divx', 'xvid', 'asf', 'rm', 'rmvb'];
const hidden = process.env.WATCHROOM_HIDDEN === '1';

const repoRoot = resolve(__dirname, '../../..');
const paths = app.isPackaged
  ? { server: join(process.resourcesPath, 'server', 'utility.cjs'), web: join(process.resourcesPath, 'web'), icon: join(process.resourcesPath, 'icon.png') }
  : { server: join(repoRoot, 'packages/server/dist/utility.cjs'), web: join(repoRoot, 'apps/web/dist'), icon: join(__dirname, '../assets/icon.png') };
const isWindows = process.platform === 'win32';
// Cache (segments, downloaded tools) and state (settings, recent videos): the XDG layout on Linux, AppData on
// Windows. Tests point both elsewhere so they never touch the real ones.
const dataDir = process.env.WATCHROOM_DATA_DIR || (isWindows
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Watchroom', 'Cache')
  : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'watchroom'));
const stateDir = process.env.WATCHROOM_STATE_DIR || (isWindows
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Watchroom', 'Settings')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'watchroom'));
const logDir = join(dataDir, 'logs');
const logFile = join(logDir, 'watchroom.log');

/** The streaming server's output also goes to a log file (a packaged app has no terminal to show it in). */
function openLog(): void {
  try {
    mkdirSync(logDir, { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `\n==== Watchroom ${app.getVersion()} started ${new Date().toISOString()} on ${process.platform} ${process.arch} ====\n`);
  } catch { /* logging is best effort */ }
}
function log(text: string): void {
  try {
    appendFileSync(logFile, text);
  } catch { /* best effort */ }
}

/** Tools shipped inside the package (Windows: ffmpeg and cloudflared), passed to the server by path. */
function bundledTools(): Record<string, string> {
  if (!app.isPackaged) return {};
  const exe = isWindows ? '.exe' : '';
  const env: Record<string, string> = {};
  const tools: [string, string][] = [
    ['WATCHROOM_FFMPEG', join(process.resourcesPath, 'ffmpeg', `ffmpeg${exe}`)],
    ['WATCHROOM_FFPROBE', join(process.resourcesPath, 'ffmpeg', `ffprobe${exe}`)],
    ['WATCHROOM_CLOUDFLARED', join(process.resourcesPath, 'bin', `cloudflared${exe}`)],
  ];
  for (const [key, path] of tools) if (!process.env[key] && existsSync(path)) env[key] = path;
  return env;
}

let server: UtilityProcess | null = null;
let serverPort = 0;
let win: BrowserWindow | null = null;
let lastStatus: HostStatus | null = null;
let blockerId: number | null = null;
let quitting = false;
let rpcId = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function rpc<T>(method: string, ...params: unknown[]): Promise<T> {
  return new Promise((res, rej) => {
    if (!server) return rej(new Error('server not running'));
    const id = ++rpcId;
    pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
    server.postMessage({ id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`${method} timed out`));
    }, method === 'openVideo' || method === 'openRecent' ? 120_000 : 15_000);
  });
}

function startServer(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    if (!existsSync(paths.server)) return reject(new Error(`Server bundle missing at ${paths.server}. Run "npm run build".`));
    const child = utilityProcess.fork(paths.server, [], {
      serviceName: 'Watchroom Server',
      stdio: 'pipe',
      env: { ...process.env, ...bundledTools(), WATCHROOM_STATIC_DIR: paths.web, WATCHROOM_DATA_DIR: dataDir, WATCHROOM_STATE_DIR: stateDir },
    });
    server = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (d: Buffer) => {
        log(d.toString());
        if (!app.isPackaged) process.stdout.write(d);
      });
    }
    child.on('message', (msg: { event?: string; id?: number; result?: unknown; error?: string; data?: unknown; port?: number }) => {
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.event === 'ready' && msg.port) resolvePort(msg.port);
      if (msg.event === 'fatal') reject(new Error(String((msg as { error?: string }).error)));
      if (msg.event === 'status') onStatus(msg.data as HostStatus);
    });
    child.on('exit', (code) => {
      log(`server process exited (code ${code})\n`);
      server = null;
      for (const p of pending.values()) p.reject(new Error('server stopped'));
      pending.clear();
      if (!quitting) {
        dialog.showErrorBox('Watchroom', `The streaming server stopped unexpectedly (code ${code}). Watchroom will restart it.`);
        void startServer().then((port) => {
          serverPort = port;
          void win?.loadURL(`${localOrigin(port)}/`);
        }).catch(() => app.quit());
      }
    });
  });
}

function onStatus(status: HostStatus): void {
  lastStatus = status;
  win?.webContents.send('host:status', status);
  // Keep the computer awake while a video is loaded and someone is watching.
  const active = Boolean(status.media.descriptor) && status.stats.viewers > 0;
  if (active && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

/** IPC is only honoured from our own top-level page served by the local server. */
function trusted(e: IpcMainInvokeEvent): boolean {
  try {
    const url = new URL(e.senderFrame?.url ?? '');
    return url.origin === localOrigin(serverPort) && e.senderFrame === win?.webContents.mainFrame;
  } catch {
    return false;
  }
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

async function openVideoPath(p: unknown) {
  if (typeof p !== 'string' || !p) return { ok: false, error: 'No file selected.' };
  try {
    if (!statSync(p).isFile()) return { ok: false, error: 'That is not a file.' };
  } catch {
    return { ok: false, error: 'The file could not be opened.' };
  }
  win?.setTitle('Watchroom');
  return rpc('openVideo', p);
}

function registerIpc(): void {
  handle('host:getStatus', () => lastStatus ?? rpc('getStatus'));
  handle('host:hostJoin', () => rpc('hostJoin'));
  handle('host:openVideoDialog', async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a video',
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return openVideoPath(res.filePaths[0]);
  });
  handle('host:openVideoPath', (p) => openVideoPath(p));
  handle('host:addSubtitleDialog', async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Add subtitles',
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return rpc('addSubtitle', res.filePaths[0]);
  });
  handle('host:closeVideo', () => rpc('closeVideo'));
  handle('host:listRecent', () => rpc('listRecent'));
  handle('host:openRecent', (id, fromStart) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return { ok: false, error: 'Unknown video.' };
    win?.setTitle('Watchroom');
    return rpc('openRecent', id, fromStart === true);
  });
  handle('host:removeRecent', (id) => {
    if (id !== null && (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id))) return;
    return rpc('removeRecent', id as string | null);
  });
  handle('host:setLinkMode', async (mode, base) => {
    try {
      await rpc('setLinkMode', mode as LinkMode, (base as string | null) ?? null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('host:retryTunnel', () => rpc('retryTunnel'));
  handle('host:regenerateLink', () => rpc('regenerateLink'));
  handle('host:copyText', (text) => {
    if (typeof text === 'string' && text.length < 10_000) clipboard.writeText(text);
  });
  handle('host:openExternal', (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

function createWindow(port: number): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 580,
    show: false,
    backgroundColor: '#0e0e11',
    title: 'Watchroom',
    icon: existsSync(paths.icon) ? paths.icon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      // Automated tests run without a display: render offscreen so frames can still be captured.
      ...(hidden ? { offscreen: true } : {}),
    },
  });
  if (hidden) win.webContents.setFrameRate(30);
  const origin = localOrigin(port);
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${origin}/`)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
  win.once('ready-to-show', () => {
    if (!hidden) win?.show();
  });
  win.on('closed', () => { win = null; });
  void win.loadURL(`${origin}/`);
}

/** A video path passed on the command line ("Open with Watchroom", or `watchroom movie.mkv`). */
function videoFromArgv(argv: string[]): string | null {
  for (const raw of argv.slice(1).reverse()) {
    if (raw.startsWith('-')) continue;
    // File managers pass "Open with" files as paths (%F) or file:// URIs (%U).
    let arg = raw;
    if (/^file:\/\//i.test(arg)) {
      try {
        arg = fileURLToPath(arg);
      } catch {
        continue;
      }
    }
    const ext = arg.split('.').pop()?.toLowerCase() ?? '';
    if (!VIDEO_EXTENSIONS.includes(ext)) continue;
    try {
      if (statSync(arg).isFile()) return resolve(arg);
    } catch { /* not a file */ }
  }
  return null;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keydown",{key:"o",ctrlKey:true}))') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const])],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open Log Folder', click: () => { mkdirSync(logDir, { recursive: true }); void shell.openPath(logDir); } },
        { label: `Watchroom ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const file = videoFromArgv(argv);
    if (file) void openVideoPath(file);
  });
  app.setName('Watchroom');
  // Windows: taskbar grouping and notifications belong to the installed app's identity.
  if (isWindows) app.setAppUserModelId('app.watchroom.desktop');
  openLog();
  app.whenReady().then(async () => {
    registerIpc();
    buildMenu();
    try {
      serverPort = await startServer();
    } catch (err) {
      log(`could not start: ${(err as Error).message}\n`);
      dialog.showErrorBox('Watchroom could not start', `${(err as Error).message}\n\nDetails are in ${logFile}`);
      app.quit();
      return;
    }
    createWindow(serverPort);
    const file = videoFromArgv(process.argv);
    if (file) win?.webContents.once('did-finish-load', () => void openVideoPath(file));
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    const child = server;
    const done = () => app.exit(0);
    child.once('exit', done);
    child.postMessage({ shutdown: true });
    setTimeout(() => { child.kill(); done(); }, 4000);
  });
}
