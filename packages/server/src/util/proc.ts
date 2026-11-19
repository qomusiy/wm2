import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run a process to completion, capturing output (bounded). Rejects only on spawn failure or timeout. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxOutput?: number; input?: Buffer; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const max = opts.maxOutput ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    const abort = () => child.kill('SIGKILL');
    if (opts.signal?.aborted) abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code, signal, stdout, stderr });
    });
    if (opts.input && child.stdin) child.stdin.end(opts.input);
  });
}

/** Spawn and stream stdout line-by-line to `onLine`. Resolves with the exit code. */
export function runLines(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  opts: { signal?: AbortSignal } & SpawnOptions = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let rest = '';
    let stderr = '';
    const abort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      rest += chunk;
      let nl: number;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 32 * 1024) stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort);
      if (rest.trim()) onLine(rest.trim());
      resolve({ code, stderr });
    });
  });
}
