import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run } from '../util/proc';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

export interface FfmpegInfo extends FfmpegPaths {
  version: string;
  filters: Set<string>;
  encoders: Set<string>;
}

function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve ffmpeg/ffprobe: explicit env vars (bundled builds) first, then PATH. */
export function locateFfmpeg(): FfmpegPaths | null {
  const ffmpeg = process.env.WATCHROOM_FFMPEG || findOnPath('ffmpeg');
  const ffprobe = process.env.WATCHROOM_FFPROBE || findOnPath('ffprobe');
  if (!ffmpeg || !ffprobe) return null;
  return { ffmpeg, ffprobe };
}

export async function inspectFfmpeg(paths: FfmpegPaths): Promise<FfmpegInfo> {
  const [ver, filters, encoders] = await Promise.all([
    run(paths.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
    run(paths.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 }),
    run(paths.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }),
  ]);
  if (ver.code !== 0) throw new Error(`ffmpeg failed to run: ${ver.stderr.slice(0, 300)}`);
  const version = /ffmpeg version (\S+)/.exec(ver.stdout)?.[1] ?? 'unknown';
  const parseNames = (text: string, re: RegExp) => {
    const set = new Set<string>();
    for (const line of text.split('\n')) {
      const m = re.exec(line);
      if (m?.[1]) set.add(m[1]);
    }
    return set;
  };
  return {
    ...paths,
    version,
    filters: parseNames(filters.stdout, /^\s*[TSC.|]{3}\s+(\S+)\s/),
    encoders: parseNames(encoders.stdout, /^\s*[VAS][A-Z.]{5}\s+(\S+)\s/),
  };
}
