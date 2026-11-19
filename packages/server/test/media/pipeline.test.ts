import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFfmpeg, locateFfmpeg, type FfmpegInfo } from '../../src/media/ffmpeg';
import { MediaSession } from '../../src/media/session';
import { TS_BASE } from '../../src/media/encoder';
import { detectEncoder } from '../../src/media/hwaccel';
import { createLogger } from '../../src/util/log';
import { initSandbox } from '../../src/util/sandbox';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'media');
let ff: FfmpegInfo;
let cacheRoot: string;

beforeAll(async () => {
  execFileSync('node', [join(here, '..', 'fixtures', 'generate.mjs'), fixtures], { stdio: 'inherit' });
  const paths = locateFfmpeg();
  if (!paths) throw new Error('ffmpeg not found');
  ff = await inspectFfmpeg(paths);
  // Everything below runs the way the app does: ffmpeg inside the sandbox (when this machine supports one).
  await initSandbox(ff.ffmpeg, createLogger('sandbox'));
  cacheRoot = mkdtempSync(join(tmpdir(), 'watchroom-test-'));
});

afterAll(() => {
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
});

interface PacketInfo { pts: number[]; keyframes: number; firstKeyPts: number; codecType: string | null; streams: string[] }

function inspectSegment(path: string): PacketInfo {
  // JSON keeps top-level streams separate from MPEG-TS program listings (csv would duplicate them).
  const json = JSON.parse(execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path]).toString()) as { streams?: { codec_type: string }[] };
  const streams = (json.streams ?? []).map((s) => s.codec_type);
  const rows = execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path]).toString()
    .split('\n').filter(Boolean);
  const pts = rows.map((l) => Number.parseFloat(l)).filter((n) => Number.isFinite(n));
  const keyRows = rows.filter((l) => l.split(',')[1]?.startsWith('K'));
  const firstKeyPts = keyRows.length ? Number.parseFloat(keyRows[0]!) : NaN;
  return { pts, keyframes: keyRows.length, firstKeyPts, codecType: streams[0] ?? null, streams };
}

function decodeErrors(paths: string[]): string {
  const data = Buffer.concat(paths.map((p) => readFileSync(p)));
  try {
    return execFileSync(ff.ffmpeg, ['-v', 'error', '-f', 'mpegts', '-i', '-', '-f', 'null', '-'], { input: data, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? err);
  }
}

const CASES: { file: string; copy: boolean; audioTracks: number; topLabel: RegExp }[] = [
  { file: 'long_h264_aac.mkv', copy: true, audioTracks: 1, topLabel: /Original · 480p/ },
  { file: 'h264_aac.mp4', copy: true, audioTracks: 1, topLabel: /Original · 720p/ },
  { file: 'h264_ac3_51_multi.mkv', copy: true, audioTracks: 2, topLabel: /Original · 1080p/ },
  { file: 'h264_aac.ts', copy: true, audioTracks: 1, topLabel: /Original · 720p/ },
  { file: 'h264_noaudio.mp4', copy: true, audioTracks: 0, topLabel: /Original · 480p/ },
  { file: 'hevc10_eac3.mkv', copy: true, audioTracks: 1, topLabel: /Original · 1080p/ },
  { file: 'vp9_opus.webm', copy: false, audioTracks: 1, topLabel: /^360p$/ },
  { file: 'mpeg4_mp3.avi', copy: false, audioTracks: 1, topLabel: /^480p$/ },
  { file: 'dvd_mpeg2_anamorphic.mkv', copy: false, audioTracks: 1, topLabel: /^576p$/ },
  { file: 'rotated_phone.mp4', copy: false, audioTracks: 1, topLabel: /^720p$/ },
];

const HW_CASES = CASES.filter((c) => ['long_h264_aac.mkv', 'hevc10_eac3.mkv', 'dvd_mpeg2_anamorphic.mkv'].includes(c.file));

describe.each([
  ...CASES.map((c) => ({ ...c, hw: false })),
  ...HW_CASES.map((c) => ({ ...c, hw: true })),
])('media pipeline: $file (hardware: $hw)', ({ file, copy, audioTracks, topLabel, hw }) => {
  let session: MediaSession;

  beforeAll(async () => {
    const encoder = hw ? (await detectEncoder(ff)).choice : { kind: 'libx264' as const };
    if (hw && encoder.kind === 'libx264') return; // no working hardware encoder on this machine
    session = await MediaSession.open(join(fixtures, file), {
      ff, encoder, cacheRoot, maxRunningJobs: 3, log: createLogger('test'),
    });
  });
  afterAll(() => session?.close());

  it('plans the expected ladder', (ctx) => {
    if (!session) return ctx.skip();
    const d = session.descriptor();
    expect(d.levels.length).toBeGreaterThanOrEqual(2);
    expect(d.levels[0]!.copy).toBe(copy);
    expect(d.levels[0]!.label).toMatch(topLabel);
    expect(d.audioTracks).toHaveLength(audioTracks);
    expect(d.duration).toBeGreaterThan(15);
    // Display aspect is preserved by every level (anamorphic and rotated sources included).
    const aspect = d.width / d.height;
    for (const l of d.levels) if (!l.copy) expect(Math.abs(l.width / l.height - aspect)).toBeLessThan(0.02);
  });

  it('serves a valid master playlist', (ctx) => {
    if (!session) return ctx.skip();
    const m = session.masterPlaylist();
    expect(m).toContain('#EXTM3U');
    expect((m.match(/#EXT-X-STREAM-INF/g) ?? []).length).toBe(session.descriptor().levels.length);
    expect((m.match(/TYPE=AUDIO/g) ?? []).length).toBe(audioTracks);
    if (session.probe.video.codec === 'hevc') {
      // The untouched HEVC original is an extra level for browsers that can decode it; a full H.264 ladder remains.
      const d = session.descriptor();
      expect(d.levels.filter((l) => l.codec === 'hevc')).toEqual([expect.objectContaining({ copy: true, height: 1080 })]);
      expect(d.levels.find((l) => l.codec === 'h264' && l.height === 1080 && !l.copy)).toBeDefined();
      expect(m).toMatch(/CODECS="hvc1\.2\.4\.L\d+\.B0,mp4a\.40\.2"/);
      const compat = session.masterPlaylist('compat');
      expect(compat).not.toContain('hvc1');
      expect((compat.match(/#EXT-X-STREAM-INF/g) ?? []).length).toBe(d.levels.length - 1);
    }
  });

  it('produces aligned, decodable segments for every rendition, including seeks', async (ctx) => {
    if (!session) return ctx.skip();
    const renditions = [
      ...session.plan.video.filter((v, i, all) => i === 0 || i === all.length - 1).map((v) => ({ id: v.id, kind: 'video' as const, copy: v.mode === 'copy' })),
      ...session.plan.audio.map((a) => ({ id: a.id, kind: 'audio' as const, copy: false })),
    ];
    const frame = 1 / session.probe.video.fps;
    for (const r of renditions) {
      const playlist = await session.mediaPlaylist(r.id);
      const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
      const timeline = await session.segmentsFor(r.id);
      expect(timeline.map((t) => t.duration.toFixed(6))).toEqual(durations.map((d) => d.toFixed(6)));
      const starts = timeline.map((t) => t.start);
      const n = durations.length;
      expect(n).toBeGreaterThanOrEqual(2);
      const order = [...new Set([0, 1, Math.floor(n / 2), n - 1, Math.min(2, n - 1)])];
      const paths: Record<number, string> = {};
      for (const idx of order) {
        paths[idx] = await session.segment(r.id, idx, 'tester');
        const info = inspectSegment(paths[idx]!);
        expect(info.streams, `${r.id}#${idx} streams`).toEqual([r.kind]);
        expect(info.pts.length, `${r.id}#${idx} packets`).toBeGreaterThan(0);
        const first = Math.min(...info.pts);
        const tolerance = r.kind === 'audio' ? 0.03 : frame * 1.6 + 0.002;
        // Copy segments start exactly on source keyframes; their nominal start is the keyframe time. With open GOPs
        // (x265's default) a few "leading" frames shown just before the keyframe are stored after it, so for copies
        // the keyframe itself is what must be on time.
        if (r.copy) {
          expect(Math.abs(info.firstKeyPts - (starts[idx]! + TS_BASE)), `${r.id}#${idx} keyframe pts ${info.firstKeyPts} vs ${starts[idx]! + TS_BASE}`).toBeLessThanOrEqual(0.002);
          expect(first, `${r.id}#${idx} leading frames`).toBeGreaterThan(starts[idx]! + TS_BASE - 0.5);
          // Each copy segment also decodes on its own (what a viewer jumping straight to it needs).
          expect(decodeErrors([paths[idx]!]).trim(), `${r.id}#${idx} decodes alone`).toBe('');
        } else {
          expect(Math.abs(first - (starts[idx]! + TS_BASE)), `${r.id}#${idx} first pts ${first} vs ${starts[idx]! + TS_BASE}`).toBeLessThanOrEqual(tolerance);
        }
        if (r.kind === 'video' && !r.copy) {
          // Exactly one keyframe per segment, and the segment spans its playlist duration (no skipped cuts).
          expect(info.keyframes, `${r.id}#${idx} keyframes`).toBe(1);
          const span = Math.max(...info.pts) - first + frame;
          expect(Math.abs(span - durations[idx]!), `${r.id}#${idx} span ${span} vs ${durations[idx]}`).toBeLessThanOrEqual(frame * 1.6 + 0.01);
        }
      }
      // Consecutive segments (from different encoder runs) must decode cleanly back to back.
      const consecutive = [0, 1, 2].filter((i) => paths[i]).map((i) => paths[i]!);
      expect(decodeErrors(consecutive).trim(), `${r.id} decode`).toBe('');
    }
  });
});
