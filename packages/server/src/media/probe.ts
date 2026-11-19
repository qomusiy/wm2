import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { run } from '../util/proc';
import { jailed } from '../util/sandbox';

export type HdrKind = 'hdr10' | 'hlg' | 'dolbyvision' | null;

export interface VideoStreamInfo {
  index: number;
  codec: string;
  profile: string | null;
  level: number | null;
  pixFmt: string | null;
  bitDepth: number;
  width: number;
  height: number;
  /** Sample (pixel) aspect ratio as a number; 1 for square pixels. */
  sar: number;
  /** Display size after SAR and rotation are applied. */
  displayWidth: number;
  displayHeight: number;
  fps: number;
  fieldOrder: string | null;
  rotation: number;
  hdr: HdrKind;
  bitRate: number | null;
  startTime: number | null;
}

export interface AudioStreamInfo {
  index: number;
  typeIndex: number;
  codec: string;
  profile: string | null;
  channels: number;
  channelLayout: string | null;
  sampleRate: number;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  bitRate: number | null;
}

export interface SubtitleStreamInfo {
  index: number;
  typeIndex: number;
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  forced: boolean;
  textBased: boolean;
}

export interface ProbeResult {
  path: string;
  fileName: string;
  size: number;
  mtimeMs: number;
  formatName: string;
  duration: number;
  startTime: number;
  bitRate: number | null;
  title: string;
  video: VideoStreamInfo;
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  chapters: { start: number; end: number; title: string | null }[];
}

export class ProbeError extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message);
  }
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'stl', 'sami', 'realtext', 'mpl2', 'jacosub', 'pjs', 'vplayer']);

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function parseRatio(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const [a, b] = v.split(/[:/]/).map(Number);
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a / b;
}

function bitDepthOf(pixFmt: string | null, raw: unknown): number {
  const r = num(raw);
  if (r && r >= 8 && r <= 16) return r;
  if (!pixFmt) return 8;
  if (/^(yuvj?4[124][014]p|nv12|nv21|nv16|gray|rgb24|bgr24|rgba|bgra|argb|abgr|pal8|uyvy422|yuyv422)$/.test(pixFmt)) return 8;
  const m = /(?:p|le|be)?(9|10|12|14|16)(?:le|be)?$/.exec(pixFmt) || /p0(10|12|16)/.exec(pixFmt);
  return m?.[1] ? Number(m[1]) : 8;
}

const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

export function languageName(code: string | null): string | null {
  if (!code || code === 'und' || code === 'mis' || code === 'mul' || code === 'zxx') return null;
  try {
    const name = LANG_NAMES.of(code);
    return name && name !== code && name !== 'root' ? name : code;
  } catch {
    return code;
  }
}

const tag = (tags: Record<string, string> | undefined, key: string): string | null => {
  if (!tags) return null;
  const found = Object.keys(tags).find((k) => k.toLowerCase() === key);
  const value = found ? tags[found]?.trim() : '';
  return value ? value : null;
};

/** Run ffprobe and normalise everything the pipeline needs. */
export async function probeFile(ffprobe: string, path: string): Promise<ProbeResult> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile()) throw new ProbeError(`not a file: ${path}`, 'The selected file could not be opened.');
  const [cmd, args] = jailed(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path,
  ], { read: [path], write: [] });
  const res = await run(cmd, args, { timeoutMs: 60_000 });
  if (res.code !== 0) {
    throw new ProbeError(`ffprobe failed: ${res.stderr.slice(0, 500)}`, 'This file is not a video format that can be read.');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new ProbeError('ffprobe returned invalid JSON', 'This file is not a video format that can be read.');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streams: any[] = Array.isArray(json.streams) ? json.streams : [];
  const format = json.format ?? {};

  const vRaw = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.codec_name !== 'mjpeg' && s.codec_name !== 'png')
    ?? streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!vRaw) throw new ProbeError('no video stream', 'This file has no video track.');

  const width = num(vRaw.width) ?? 0;
  const height = num(vRaw.height) ?? 0;
  if (width <= 0 || height <= 0) throw new ProbeError('video has no dimensions', 'The video track in this file is unreadable.');
  const sar = parseRatio(vRaw.sample_aspect_ratio) ?? 1;
  const sideRotation = Array.isArray(vRaw.side_data_list)
    ? vRaw.side_data_list.map((d: { rotation?: unknown }) => num(d.rotation)).find((r: number | null) => r !== null)
    : null;
  const rotation = (((Math.round(sideRotation ?? num(vRaw.tags?.rotate) ?? 0) % 360) + 360) % 360);
  let dispW = Math.round(width * (sar > 0 && sar < 10 ? sar : 1));
  let dispH = height;
  if (rotation === 90 || rotation === 270) [dispW, dispH] = [dispH, dispW];

  const fps = parseRatio(vRaw.avg_frame_rate) || parseRatio(vRaw.r_frame_rate) || 25;
  const pixFmt = typeof vRaw.pix_fmt === 'string' ? vRaw.pix_fmt : null;
  const transfer = String(vRaw.color_transfer ?? '');
  const isDovi = Array.isArray(vRaw.side_data_list) && vRaw.side_data_list.some((d: { side_data_type?: string }) => /DOVI|Dolby Vision/i.test(d.side_data_type ?? ''));
  const hdr: HdrKind = isDovi ? 'dolbyvision' : transfer === 'smpte2084' ? 'hdr10' : transfer === 'arib-std-b67' ? 'hlg' : null;

  const video: VideoStreamInfo = {
    index: vRaw.index,
    codec: String(vRaw.codec_name ?? 'unknown'),
    profile: typeof vRaw.profile === 'string' ? vRaw.profile : null,
    level: num(vRaw.level),
    pixFmt,
    bitDepth: bitDepthOf(pixFmt, vRaw.bits_per_raw_sample),
    width,
    height,
    sar: sar > 0 && sar < 10 ? sar : 1,
    displayWidth: dispW,
    displayHeight: dispH,
    fps: fps > 0 && fps < 1000 ? fps : 25,
    fieldOrder: typeof vRaw.field_order === 'string' ? vRaw.field_order : null,
    rotation,
    hdr,
    bitRate: num(vRaw.bit_rate),
    startTime: num(vRaw.start_time),
  };

  let aIdx = 0;
  let sIdx = 0;
  const audio: AudioStreamInfo[] = [];
  const subtitles: SubtitleStreamInfo[] = [];
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      audio.push({
        index: s.index,
        typeIndex: aIdx++,
        codec: String(s.codec_name ?? 'unknown'),
        profile: typeof s.profile === 'string' ? s.profile : null,
        channels: num(s.channels) ?? 2,
        channelLayout: typeof s.channel_layout === 'string' ? s.channel_layout : null,
        sampleRate: num(s.sample_rate) ?? 48000,
        language: tag(s.tags, 'language'),
        title: tag(s.tags, 'title'),
        isDefault: Boolean(s.disposition?.default),
        bitRate: num(s.bit_rate),
      });
    } else if (s.codec_type === 'subtitle') {
      const codec = String(s.codec_name ?? 'unknown');
      subtitles.push({
        index: s.index,
        typeIndex: sIdx++,
        codec,
        language: tag(s.tags, 'language'),
        title: tag(s.tags, 'title'),
        isDefault: Boolean(s.disposition?.default),
        forced: Boolean(s.disposition?.forced),
        textBased: TEXT_SUBS.has(codec),
      });
    }
  }

  let duration = num(format.duration);
  if (!duration || duration <= 0) {
    duration = Math.max(0, ...streams.map((s) => num(s.duration) ?? 0));
  }
  if (!duration || duration <= 0.5) {
    throw new ProbeError('unknown duration', 'The length of this video could not be determined.');
  }

  const fileName = basename(path);
  const title = tag(format.tags, 'title') ?? fileName.slice(0, fileName.length - extname(fileName).length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chapters = (Array.isArray(json.chapters) ? json.chapters : []).map((c: any) => ({
    start: num(c.start_time) ?? 0,
    end: num(c.end_time) ?? 0,
    title: tag(c.tags, 'title'),
  }));

  return {
    path,
    fileName,
    size: st.size,
    mtimeMs: st.mtimeMs,
    formatName: String(format.format_name ?? 'unknown'),
    duration,
    startTime: num(format.start_time) ?? 0,
    bitRate: num(format.bit_rate),
    title,
    video,
    audio,
    subtitles,
    chapters,
  };
}

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1', vc1: 'VC-1', wmv3: 'WMV', msmpeg4v3: 'DivX 3', prores: 'ProRes', theora: 'Theora',
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC', mp3: 'MP3', opus: 'Opus',
  vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM', alac: 'ALAC', mp2: 'MP2', wmav2: 'WMA',
};

export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

export function channelLabel(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

const CONTAINER_LABELS: [RegExp, string][] = [
  [/matroska/, 'MKV'], [/webm/, 'WebM'], [/mov|mp4|m4a|3gp/, 'MP4'], [/avi/, 'AVI'], [/mpegts/, 'MPEG-TS'],
  [/^mpeg$|mpegvideo/, 'MPEG-PS'], [/asf/, 'WMV'], [/flv/, 'FLV'], [/ogg/, 'Ogg'],
];

export function containerLabel(formatName: string, fileName: string): string {
  if (/\.mov$/i.test(fileName)) return 'MOV';
  for (const [re, label] of CONTAINER_LABELS) if (re.test(formatName)) return label;
  return extname(fileName).slice(1).toUpperCase() || formatName;
}
