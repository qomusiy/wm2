import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TunnelState } from '@watchroom/protocol';
import type { Logger } from '../util/log';
import { renameRetry } from '../util/fsx';
import { run } from '../util/proc';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  error: string | null;
  detail: string | null;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const EXE = process.platform === 'win32' ? '.exe' : '';

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name + EXE);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export function assetName(): string | null {
  const map: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
  const a = map[arch()];
  if (!a) return null;
  if (platform() === 'linux') return `cloudflared-linux-${a}`;
  if (platform() === 'win32' && (a === 'amd64' || a === '386')) return `cloudflared-windows-${a}.exe`;
  return null;
}

/** Is `pid` a running cloudflared tunnel (one we started in an earlier run)? */
async function isStaleTunnel(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    return cmdline.includes('cloudflared') && cmdline.includes('tunnel');
  }
  if (process.platform === 'win32') {
    const res = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 }).catch(() => null);
    return Boolean(res && /^"cloudflared/i.test(res.stdout.trim()));
  }
  return false;
}

/**
 * Cloudflare "quick tunnel": an outbound connection from this computer to Cloudflare that gives a public
 * HTTPS URL, with no account, no router configuration, and working behind CGNAT.
 */
export class CloudflareTunnel extends EventEmitter {
  status: TunnelStatus = { state: 'idle', url: null, error: null, detail: null };
  private proc: ChildProcess | null = null;
  private wanted = false;
  private port = 0;
  private restartDelay = 3000;
  private restartTimer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly binDir: string, private readonly log: Logger) {
    super();
  }

  private set(patch: Partial<TunnelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  async start(port: number): Promise<void> {
    this.port = port;
    this.wanted = true;
    if (this.proc) return;
    const gen = ++this.generation;
    let bin: string;
    try {
      bin = await this.ensureBinary();
    } catch (err) {
      this.set({ state: 'error', url: null, error: (err as Error).message, detail: null });
      this.scheduleRestart();
      return;
    }
    if (!this.wanted || gen !== this.generation) return;
    this.set({ state: 'starting', url: null, error: null, detail: 'Connecting to Cloudflare…' });
    // The folder may not exist yet when cloudflared is bundled (nothing was downloaded into it).
    await mkdir(this.binDir, { recursive: true }).catch(() => {});
    const emptyConfig = join(this.binDir, 'empty-config.yml');
    await writeFile(emptyConfig, '# intentionally empty: quick tunnel must not pick up ~/.cloudflared/config.yml\n').catch(() => {});
    const args = ['tunnel', '--no-autoupdate', '--config', emptyConfig, '--url', `http://127.0.0.1:${port}`];
    await this.killStale();
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    if (proc.pid) void writeFile(this.pidFile(), String(proc.pid)).catch(() => {});
    let registered = false;
    let url: string | null = null;
    let lastError = '';
    const onLine = (line: string) => {
      const m = URL_RE.exec(line);
      if (m && !url) {
        url = m[0];
        this.set({ state: 'starting', url, detail: 'Registering tunnel…' });
      }
      if (/Registered tunnel connection/i.test(line) && !registered && url) {
        registered = true;
        void this.verify(url, gen);
      }
      if (/\bERR\b|error|failed/i.test(line)) lastError = line.replace(/^\S+\s+\S+\s+/, '').slice(0, 300);
    };
    for (const stream of [proc.stdout, proc.stderr]) {
      let rest = '';
      stream?.setEncoding('utf8').on('data', (d: string) => {
        rest += d;
        let i: number;
        while ((i = rest.indexOf('\n')) >= 0) {
          onLine(rest.slice(0, i));
          rest = rest.slice(i + 1);
        }
      });
    }
    proc.on('error', (err) => { lastError = err.message; });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (!this.wanted || gen !== this.generation) {
        this.set({ state: 'stopped', url: null, detail: null });
        return;
      }
      this.log.warn(`cloudflared exited (${code}): ${lastError}`);
      this.set({ state: 'error', url: null, error: lastError || `cloudflared exited with code ${code}`, detail: null });
      this.scheduleRestart();
    });
  }

  /**
   * The hostname needs a moment to resolve publicly; confirm the tunnel really reaches us, and that the big public
   * resolvers (which most friends' devices use) already know the name. Otherwise a friend who opens the link
   * straight away gets a "site can't be reached" page, and their device may remember that failure for a while.
   */
  private async verify(url: string, gen: number): Promise<void> {
    this.set({ state: 'verifying', url, detail: 'Checking the link works…' });
    const deadline = Date.now() + 45_000;
    const host = new URL(url).hostname;
    let publicDns = false;
    while (Date.now() < deadline && this.wanted && gen === this.generation) {
      try {
        if (!publicDns) publicDns = await resolvesPublicly(host);
        const res = publicDns ? await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }) : null;
        if (res?.ok) {
          this.restartDelay = 3000;
          this.set({ state: 'online', url, error: null, detail: null });
          this.log.info(`tunnel online: ${url}`);
          return;
        }
      } catch { /* DNS not propagated yet */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (this.wanted && gen === this.generation) {
      // Registered with Cloudflare but not confirmed from here (some networks block self-access); still usable.
      this.set({ state: 'online', url, error: null, detail: 'Could not confirm the link from this computer; it may take a minute to start working.' });
    }
  }

  private pidFile(): string {
    return join(this.binDir, 'cloudflared.pid');
  }

  /** If a previous run was force-killed, its tunnel process may still be alive: stop it. */
  private async killStale(): Promise<void> {
    try {
      const pid = Number((await readFile(this.pidFile(), 'utf8')).trim());
      if (!pid || pid === this.proc?.pid) return;
      if (await isStaleTunnel(pid)) {
        process.kill(pid, 'SIGTERM');
        this.log.info(`stopped a leftover cloudflared process (${pid})`);
      }
    } catch { /* no stale process */ }
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(60_000, this.restartDelay * 2);
    this.set({ detail: `Retrying in ${Math.round(delay / 1000)}s…` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) void this.start(this.port);
    }, delay);
  }

  async restart(): Promise<void> {
    this.stop();
    this.restartDelay = 3000;
    await this.start(this.port);
  }

  stop(): void {
    this.wanted = false;
    this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    void unlink(this.pidFile()).catch(() => {});
    if (this.proc) {
      this.proc.kill('SIGTERM');
      const p = this.proc;
      setTimeout(() => p.kill('SIGKILL'), 3000).unref();
      this.proc = null;
    }
    this.set({ state: 'stopped', url: null, error: null, detail: null });
  }

  /** Use a system cloudflared if installed, else a verified download into our data directory. */
  private async ensureBinary(): Promise<string> {
    const envBin = process.env.WATCHROOM_CLOUDFLARED;
    if (envBin && existsSync(envBin)) return envBin;
    const local = join(this.binDir, `cloudflared${EXE}`);
    if (existsSync(local)) return local;
    const system = findOnPath('cloudflared');
    if (system) return system;
    const asset = assetName();
    if (!asset) throw new Error('Automatic tunnel setup is not available on this system. Install cloudflared manually.');
    this.set({ state: 'installing', url: null, error: null, detail: 'Downloading Cloudflare tunnel (one time, ~40 MB)…' });
    await mkdir(this.binDir, { recursive: true });
    const headers = { 'User-Agent': 'watchroom-host', Accept: 'application/vnd.github+json' };
    const rel = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers, signal: AbortSignal.timeout(20_000) });
    if (!rel.ok) throw new Error(`Could not look up cloudflared release (HTTP ${rel.status}).`);
    const json = await rel.json() as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string; digest?: string }[] };
    const a = json.assets?.find((x) => x.name === asset);
    if (!a) throw new Error(`No cloudflared build named ${asset} in the latest release.`);
    const fromBody = new RegExp(`^${asset}:\\s*([0-9a-f]{64})\\s*$`, 'mi').exec(json.body ?? '')?.[1];
    const fromDigest = a.digest?.startsWith('sha256:') ? a.digest.slice(7) : undefined;
    const expected = (fromBody ?? fromDigest)?.toLowerCase();
    if (!expected) throw new Error('Could not find a checksum to verify the cloudflared download.');
    // Slow home connections are common: no total time limit, but give up after 60s without any data.
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), 60_000);
    const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'watchroom-host' }, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`cloudflared download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = `${local}.download`;
    const hash = createHash('sha256');
    let received = 0;
    let lastPct = -1;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), 60_000);
      const pct = total ? Math.floor((received / total) * 100) : -1;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        this.set({ detail: `Downloading Cloudflare tunnel (one time): ${pct}% of ${(total / 1e6).toFixed(0)} MB…` });
      }
    });
    try {
      await pipeline(body, createWriteStream(tmp, { mode: 0o700 }));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new Error(abort.signal.aborted ? 'The cloudflared download stalled. Check your internet connection and try again.' : `cloudflared download failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(idle);
    }
    const actual = hash.digest('hex');
    if (actual !== expected) {
      await unlink(tmp).catch(() => {});
      throw new Error('The cloudflared download failed verification and was discarded.');
    }
    if (process.platform !== 'win32') await chmod(tmp, 0o755);
    await renameRetry(tmp, local);
    this.log.info(`installed cloudflared ${json.tag_name ?? ''} (sha256 verified)`);
    return local;
  }
}

/**
 * True when the public resolvers we can reach (Cloudflare's and Google's, over HTTPS by IP so local DNS filtering
 * can't get in the way) all answer for the name. Resolvers that can't be reached don't count; if none can, the
 * check is skipped.
 */
export async function resolvesPublicly(host: string): Promise<boolean> {
  const ask = async (endpoint: string): Promise<boolean | null> => {
    try {
      const res = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`, {
        headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000), cache: 'no-store',
      });
      if (!res.ok) return null;
      const body = await res.json() as { Status?: number; Answer?: unknown[] };
      return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
    } catch {
      return null;
    }
  };
  const answers = (await Promise.all([ask('https://1.1.1.1/dns-query'), ask('https://8.8.8.8/resolve')])).filter((a) => a !== null);
  return answers.every(Boolean);
}
