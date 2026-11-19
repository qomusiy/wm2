/*
 * Runs ffmpeg/ffprobe inside a bubblewrap sandbox: the tools see the system's programs and libraries (read-only),
 * the GPU (for hardware encoding), the one video or subtitle file they were asked to read, and the one cache folder
 * they write to. No home folder, no other files, no network, no inherited environment. A malicious video that
 * exploited a bug in ffmpeg's decoders would find nothing to read and nowhere to send it.
 *
 * Linux only. When bubblewrap is missing or can't create a sandbox (some locked-down systems), tools run normally
 * and the host's status says so.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Logger } from './log';
import { run } from './proc';

export interface Jail {
  /** Files or folders the tool may read. */
  read: string[];
  /** Folders the tool may write (created if missing). */
  write: string[];
}

export type SandboxState = 'on' | 'off' | 'disabled' | 'unsupported';

let bwrap: string | null = null;
let state: SandboxState = 'off';
let reason = 'not checked yet';

export function sandboxStatus(): { state: SandboxState; detail: string } {
  return { state, detail: reason };
}

const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const PASS_ENV = ['LANG', 'LC_ALL', 'LIBVA_DRIVER_NAME', 'LIBVA_DRIVERS_PATH', 'VDPAU_DRIVER', 'MESA_LOADER_DRIVER_OVERRIDE'];

function baseArgs(): string[] {
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  ];
  for (const name of PASS_ENV) if (process.env[name]) args.push('--setenv', name, process.env[name]!);
  for (const d of SYSTEM_DIRS) {
    try {
      const st = lstatSync(d);
      if (st.isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else if (st.isDirectory()) args.push('--ro-bind', d, d);
    } catch { /* not on this system */ }
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--dev-bind-try', '/dev/dri', '/dev/dri', '--ro-bind-try', '/sys', '/sys', '--tmpfs', '/tmp');
  return args;
}

/** Wraps a command so it runs in the sandbox with access to exactly `jail`'s paths (same absolute paths inside). */
export function jailed(cmd: string, args: string[], jail: Jail): [string, string[]] {
  if (state !== 'on' || !bwrap) return [cmd, args];
  const extra: string[] = [];
  // A tool installed outside /usr (e.g. /opt/ffmpeg/bin) must be visible too.
  for (const bin of [cmd, ...(cmd.endsWith('nice') ? [args[2] ?? ''] : [])]) {
    if (isAbsolute(bin) && !bin.startsWith('/usr/') && existsSync(bin)) extra.push('--ro-bind', dirname(bin), dirname(bin));
  }
  for (const p of jail.read) {
    const abs = resolve(p);
    if (existsSync(abs)) extra.push('--ro-bind', abs, abs);
  }
  for (const p of jail.write) {
    const abs = resolve(p);
    mkdirSync(abs, { recursive: true });
    extra.push('--bind', abs, abs);
  }
  return [bwrap, [...baseArgs(), ...extra, '--chdir', '/tmp', '--', cmd, ...args]];
}

/**
 * Finds bubblewrap and proves the sandbox works here: a sandboxed tool must run, and must not see a file outside
 * its jail. WATCHROOM_SANDBOX=0 turns it off.
 */
export async function initSandbox(ffmpeg: string, log: Logger): Promise<{ state: SandboxState; detail: string }> {
  if (process.env.WATCHROOM_SANDBOX === '0') {
    state = 'disabled';
    reason = 'turned off with WATCHROOM_SANDBOX=0';
    return sandboxStatus();
  }
  if (process.platform !== 'linux') {
    state = 'unsupported';
    reason = 'the ffmpeg sandbox is available on Linux only';
    return sandboxStatus();
  }
  const found = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((p) => existsSync(p));
  if (!found) {
    reason = 'bubblewrap is not installed (sudo apt install bubblewrap)';
    log.warn(`video tools are not sandboxed: ${reason}`);
    return sandboxStatus();
  }
  bwrap = found;
  state = 'on';
  try {
    const [cmd, args] = jailed(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-version'], { read: [], write: [] });
    const res = await run(cmd, args, { timeoutMs: 10_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').pop() ?? `exit ${res.code}`);
    // The jail really hides the rest of the computer: the user's home folder must not exist inside.
    const home = process.env.HOME;
    if (home && !/^\/(usr|etc|tmp)(\/|$)/.test(home) && existsSync(home)) {
      const [c2, a2] = jailed('/usr/bin/test', ['-e', home], { read: [], write: [] });
      const peek = await run(c2, a2, { timeoutMs: 10_000 });
      if (peek.code === 0) throw new Error('the home folder is visible inside the sandbox');
    }
    reason = 'video tools run isolated (bubblewrap)';
    log.info('video tools will run in a sandbox (bubblewrap)');
  } catch (err) {
    state = 'off';
    bwrap = null;
    reason = `bubblewrap could not create a sandbox here: ${(err as Error).message}`;
    log.warn(`video tools are not sandboxed: ${reason}`);
  }
  return sandboxStatus();
}

/** Every descendant of a process (Linux /proc), deepest first. */
function descendants(pid: number): number[] {
  const out: number[] = [];
  const walk = (p: number) => {
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${p}/task`);
    } catch {
      return;
    }
    for (const t of tasks) {
      let children: string[] = [];
      try {
        children = readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      } catch { /* exited */ }
      for (const c of children) {
        walk(Number(c));
        out.push(Number(c));
      }
    }
  };
  walk(pid);
  return out;
}

/**
 * Sends a signal to a process and everything it started. Needed because a sandboxed tool runs as a grandchild of
 * the process we spawn (the sandbox launcher), and pausing the launcher alone would not pause the encoder.
 */
export function signalTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  const targets = process.platform === 'linux' ? [...descendants(pid), pid] : [pid];
  for (const p of targets) {
    try {
      process.kill(p, sig);
    } catch { /* already gone */ }
  }
}
