import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../util/log';
import { lowPriority } from '../util/lowprio';
import { jailed } from '../util/sandbox';
import { run } from '../util/proc';
import type { ProbeResult } from './probe';
import { renameRetry } from '../util/fsx';

export interface ThumbnailManifest {
  version: number;
  interval: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  sheets: number;
  count: number;
}

const VERSION = 1;
const COLUMNS = 10;
const ROWS = 10;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export function thumbnailPlan(probe: ProbeResult): Omit<ThumbnailManifest, 'version' | 'sheets'> {
  const v = probe.video;
  const interval = Math.max(2, Math.min(20, Math.ceil(probe.duration / 300)));
  const portrait = v.displayHeight > v.displayWidth;
  const width = portrait ? even((160 * v.displayWidth) / v.displayHeight) : 160;
  const height = portrait ? 160 : even((160 * v.displayHeight) / v.displayWidth);
  return { interval, width, height, columns: COLUMNS, rows: ROWS, count: Math.max(1, Math.ceil(probe.duration / interval)) };
}

/**
 * Preview sprite sheets for the seek bar. Only keyframes are decoded (fast, approximate positions are fine
 * for previews), at low CPU priority. Cached next to the segments.
 */
export async function generateThumbnails(
  ffmpeg: string, probe: ProbeResult, dir: string, hdrChain: string, log: Logger, signal?: AbortSignal,
): Promise<ThumbnailManifest | null> {
  const manifestPath = join(dir, 'manifest.json');
  try {
    const m = JSON.parse(await readFile(manifestPath, 'utf8')) as ThumbnailManifest;
    if (m.version === VERSION && existsSync(join(dir, `${m.sheets - 1}.jpg`))) return m;
  } catch { /* not cached */ }
  await mkdir(dir, { recursive: true });
  const plan = thumbnailPlan(probe);
  const tmp = join(dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  const vf = `${hdrChain}fps=1/${plan.interval},scale=${plan.width}:${plan.height}:flags=bilinear,setsar=1,format=yuvj420p,tile=${COLUMNS}x${ROWS}`;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-skip_frame', 'nokey', '-i', probe.path,
    '-map', `0:${probe.video.index}`, '-an', '-sn', '-dn', '-vf', vf, '-q:v', '6', '-start_number', '0', '-f', 'image2', join(tmp, '%d.jpg'),
  ];
  const t0 = Date.now();
  const [cmd, cmdArgs] = jailed(...lowPriority(ffmpeg, args), { read: [probe.path], write: [dir] });
  const res = await run(cmd, cmdArgs, { timeoutMs: 60 * 60_000, signal }).catch((err: Error) => ({ code: -1, stderr: err.message }));
  if (res.code !== 0) {
    log.warn(`thumbnail generation failed: ${res.stderr.trim().slice(-300)}`);
    return null;
  }
  const sheets = readdirSync(tmp).filter((n) => /^\d+\.jpg$/.test(n)).length;
  if (sheets === 0) return null;
  for (let i = 0; i < sheets; i++) await renameRetry(join(tmp, `${i}.jpg`), join(dir, `${i}.jpg`));
  const manifest: ThumbnailManifest = { version: VERSION, ...plan, sheets };
  await writeFile(manifestPath, JSON.stringify(manifest));
  log.info(`thumbnails ready: ${plan.count} previews in ${sheets} sheets (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return manifest;
}
