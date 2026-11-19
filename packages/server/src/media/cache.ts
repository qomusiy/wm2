import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../util/log';

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

/**
 * Keep the segment cache under `maxBytes` by removing the least recently opened videos.
 * The current video's directory is never removed.
 */
export async function pruneCache(root: string, keep: string, maxBytes: number, log: Logger): Promise<void> {
  const now = new Date();
  await utimes(keep, now, now).catch(() => {});
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
    const p = join(root, e.name);
    return { path: p, size: await dirSize(p), mtime: (await stat(p).catch(() => null))?.mtimeMs ?? 0 };
  }));
  let total = dirs.reduce((a, d) => a + d.size, 0);
  for (const d of dirs.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (d.path === keep) continue;
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
    total -= d.size;
    log.info(`cache: removed ${d.path} (${(d.size / 1e9).toFixed(2)} GB)`);
  }
}
