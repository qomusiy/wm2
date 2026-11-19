import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileMediaDescriptor } from '@watchroom/protocol';
import { inspectFfmpeg, locateFfmpeg, type FfmpegInfo } from '../../src/media/ffmpeg';
import { MediaSession } from '../../src/media/session';
import { createLogger } from '../../src/util/log';
import { initSandbox } from '../../src/util/sandbox';

const here = dirname(fileURLToPath(import.meta.url));
let ff: FfmpegInfo;
let work: string;
let session: MediaSession;

async function until(pred: (d: FileMediaDescriptor) => boolean, timeout = 90_000): Promise<FileMediaDescriptor> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const d = session.descriptor();
    if (pred(d)) return d;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout: ${JSON.stringify(session.descriptor().subtitles)} thumbs=${JSON.stringify(session.descriptor().thumbnails)}`);
}

beforeAll(async () => {
  ff = await inspectFfmpeg(locateFfmpeg()!);
  await initSandbox(ff.ffmpeg, createLogger('sandbox'));
  work = mkdtempSync(join(tmpdir(), 'wr-p2-'));
  copyFileSync(join(here, '..', 'fixtures', 'media', 'h264_ac3_51_multi.mkv'), join(work, 'movie.mkv'));
  // Russian subtitles saved by an old Windows tool: Windows-1251, not UTF-8.
  const ru = '1\r\n00:00:02,000 --> 00:00:05,000\r\nПривет, это тестовый фильм\r\n\r\n';
  writeFileSync(join(work, 'movie.ru.srt'), Buffer.from(new TextEncoder().encode(ru).length ? encodeCp1251(ru) : []));
  writeFileSync(join(work, 'movie.en.srt'), '1\n00:00:06,000 --> 00:00:08,500\nEnglish external line\n\n');
  session = await MediaSession.open(join(work, 'movie.mkv'), {
    ff, encoder: { kind: 'libx264' }, cacheRoot: join(work, 'cache'), maxRunningJobs: 2, log: createLogger('p2'),
  });
});

afterAll(() => {
  session?.close();
  rmSync(work, { recursive: true, force: true });
});

function encodeCp1251(text: string): Uint8Array {
  // Minimal Windows-1251 encoder for the test (Cyrillic block + ASCII).
  return Uint8Array.from([...text].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (c === 0x401) return 0xa8;
    if (c === 0x451) return 0xb8;
    return 0x3f;
  }));
}

describe('subtitles', () => {
  it('lists embedded and external tracks immediately, then makes them ready', async () => {
    const d = await until((x) => x.subtitles.length === 3 && x.subtitles.every((s) => s.status === 'ready'));
    const labels = d.subtitles.map((s) => s.label);
    expect(labels).toContain('English');
    expect(labels.some((l) => l.includes('Russian'))).toBe(true);
    expect(d.subtitles.every((s) => s.url?.startsWith(`/media/${d.id}/subs/`))).toBe(true);
  });

  it('extracts embedded text subtitles to WebVTT with correct timing', () => {
    const vtt = readFileSync(session.subtitlePath('s0')!, 'utf8');
    expect(vtt).toMatch(/^WEBVTT/);
    expect(vtt).toContain('Hello from the test movie');
    // Cue times are on the playback timeline (file start = 0), here 1.0s + the file's 21ms start offset.
    expect(vtt).toMatch(/00:01\.0[0-3]\d --> 00:04\.0[0-3]\d/);
  });

  it('converts Windows-1251 external subtitles to proper UTF-8', () => {
    const track = session.descriptor().subtitles.find((s) => s.language === 'ru')!;
    const vtt = readFileSync(session.subtitlePath(track.id)!, 'utf8');
    expect(vtt).toContain('Привет, это тестовый фильм');
  });

  it('accepts a subtitle file added by the host and rejects other files', async () => {
    const extra = join(work, 'added.vtt');
    writeFileSync(extra, 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nAdded by host\n');
    const info = await session.subtitles.addExternal(extra);
    expect(info.status).toBe('ready');
    expect(readFileSync(session.subtitlePath(info.id)!, 'utf8')).toContain('Added by host');
    await expect(session.subtitles.addExternal(join(work, 'movie.mkv'))).rejects.toThrow();
  });
});

describe('encoder slots', () => {
  it('queues requests when every encoder is busy instead of killing one, and never exceeds the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-slots-'));
    const s = await MediaSession.open(join(here, '..', 'fixtures', 'media', 'h264_ac3_51_multi.mkv'), {
      ff, encoder: { kind: 'libx264' }, cacheRoot: join(dir, 'cache'), maxRunningJobs: 2, log: createLogger('slots'),
    });
    try {
      const transcodes = s.plan.video.filter((v) => v.mode === 'transcode').map((v) => v.id);
      const ids = [...transcodes, ...s.plan.audio.map((a) => a.id)];
      expect(ids.length).toBeGreaterThanOrEqual(5);
      let peak = 0;
      const sampler = setInterval(() => { peak = Math.max(peak, s.scheduler.stats().running); }, 20);
      // Everyone starts at once at a mid-file position (two segments each, in order).
      const results = await Promise.allSettled(ids.map(async (id) => {
        await s.segment(id, 3, `viewer-${id}`);
        return s.segment(id, 4, `viewer-${id}`);
      }));
      clearInterval(sampler);
      expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('styled (ASS) subtitles', () => {
  it('keeps the original script for embedded and external ASS tracks, next to the WebVTT fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-ass-'));
    const fixtures = join(here, '..', 'fixtures', 'media');
    copyFileSync(join(fixtures, 'ass_embedded.mkv'), join(dir, 'show.mkv'));
    // An external script saved as UTF-16 with a byte-order mark (some Windows editors do this).
    const ext = readFileSync(join(fixtures, 'long_h264_aac.signs.ass'), 'utf8').replace('ROAD SIGN', 'ДОРОЖНЫЙ ЗНАК');
    writeFileSync(join(dir, 'show.ru.ass'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ext, 'utf16le')]));
    const s = await MediaSession.open(join(dir, 'show.mkv'), {
      ff, encoder: { kind: 'libx264' }, cacheRoot: join(dir, 'cache'), maxRunningJobs: 1, log: createLogger('ass'),
    });
    try {
      const start = Date.now();
      let subs = s.descriptor().subtitles;
      while (Date.now() - start < 60_000 && !(subs.length === 2 && subs.every((t) => t.status === 'ready'))) {
        await new Promise((r) => setTimeout(r, 200));
        subs = s.descriptor().subtitles;
      }
      expect(subs.map((t) => [t.source, Boolean(t.assUrl), Boolean(t.url)])).toEqual([['embedded', true, true], ['external', true, true]]);
      expect(subs[0]!.label).toContain('Signs & Songs');
      const embedded = readFileSync(s.subtitleScriptPath(subs[0]!.id)!, 'utf8');
      expect(embedded).toMatch(/\[V4\+ Styles\][\s\S]*Style: Sign,Arial,36,&H0000FFFF/);
      expect(embedded).toContain('{\\pos(640,100)}ROAD SIGN');
      const external = readFileSync(s.subtitleScriptPath(subs[1]!.id)!, 'utf8');
      expect(external.startsWith('[Script Info]')).toBe(true); // UTF-8 now, no byte-order mark
      expect(external).toContain('ДОРОЖНЫЙ ЗНАК');
      // The WebVTT fallback still exists for players that don't use the script.
      expect(readFileSync(s.subtitlePath(subs[0]!.id)!, 'utf8')).toContain('WEBVTT');
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('thumbnails', () => {
  it('generates sprite sheets covering the whole video', async () => {
    const d = await until((x) => x.thumbnails !== null);
    const t = d.thumbnails!;
    expect(t.interval).toBe(2);
    expect(t.count).toBe(Math.ceil(40.04 / 2));
    expect(t.sheets).toHaveLength(1);
    const sheet = session.thumbnailPath(0)!;
    const [w, h] = execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet]).toString().trim().split(',').map(Number);
    expect(w).toBe(t.width * t.columns);
    expect(h).toBe(t.height * t.rows);
    expect(t.width / t.height).toBeCloseTo(16 / 9, 1);
    expect(session.thumbnailPath(1)).toBeNull();
  });
});
