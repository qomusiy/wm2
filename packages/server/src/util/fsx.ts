import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';

/*
 * On Windows a file can be briefly locked right after it was written (antivirus scanning it, the search indexer,
 * a process that hasn't fully let go of it yet), and renaming it then fails with EPERM/EBUSY/EACCES. Retry for a
 * short while instead of failing. Elsewhere this is a plain rename.
 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS = [20, 50, 100, 200, 400, 800, 1500];

export async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRYABLE.has(code) || i >= DELAYS.length) throw err;
      await new Promise((r) => setTimeout(r, DELAYS[i]));
    }
  }
}

export function renameRetrySync(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRYABLE.has(code) || i >= DELAYS.length) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAYS[i]);
    }
  }
}
