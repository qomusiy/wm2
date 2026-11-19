import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFfmpeg, locateFfmpeg, type FfmpegInfo } from '../../src/media/ffmpeg';
import { MediaSession } from '../../src/media/session';
import { createLogger } from '../../src/util/log';

const here = dirname(fileURLToPath(import.meta.url));
let ff: FfmpegInfo;
let cacheRoot: string;
beforeAll(async () => {
  ff = await inspectFfmpeg(locateFfmpeg()!);
  cacheRoot = mkdtempSync(join(tmpdir(), 'watchroom-tail-'));
});
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));

describe('a job that runs to the end of the file', () => {
  it.each(['long_h264_aac.mkv', 'h264_ac3_51_multi.mkv', 'hevc10_eac3.mkv', 'mpeg4_mp3.avi'])('%s produces every last segment', async (file) => {
    const session = await MediaSession.open(join(here, '..', 'fixtures', 'media', file), {
      ff, encoder: { kind: 'libx264' }, cacheRoot, maxRunningJobs: 3, log: createLogger('tail'),
    });
    try {
      const ids = [...session.plan.video.filter((v) => v.mode === 'transcode').map((v) => v.id).slice(-1), ...session.plan.audio.map((a) => a.id)];
      for (const id of ids) {
        const n = (await session.segmentsFor(id)).length;
        for (let i = Math.max(0, n - 6); i < n; i++) {
          await expect(session.segment(id, i, 'tail'), `${file} ${id}#${i} of ${n}`).resolves.toMatch(/\.ts$/);
        }
      }
    } finally {
      session.close();
    }
  });
});
