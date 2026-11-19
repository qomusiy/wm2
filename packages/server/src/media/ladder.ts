import { channelLabel, codecLabel, languageName, type ProbeResult, type VideoStreamInfo } from './probe';

export interface VideoRendition {
  kind: 'video';
  id: string;
  label: string;
  mode: 'copy' | 'transcode';
  width: number;
  height: number;
  /** Output frame rate (transcode); source rate for copy. */
  fps: number;
  /** Rate-control cap for transcodes (kbit/s). */
  maxrateKbps: number;
  crf: number;
  preset: string;
  /** H.264 level as an integer (e.g. 40 for 4.0). */
  level: number;
  /** Peak bandwidth advertised in the playlist (bit/s, video + audio). */
  bandwidth: number;
  averageBandwidth: number;
  codecs: string;
}

export interface AudioRendition {
  kind: 'audio';
  id: string;
  streamIndex: number;
  typeIndex: number;
  label: string;
  language: string | null;
  isDefault: boolean;
  bitrate: number;
}

export interface LadderPlan {
  video: VideoRendition[];
  audio: AudioRendition[];
  copyReason: string | null;
}

interface Tier { name: string; w: number; h: number; maxrate: number }

/** Bounding boxes (landscape). Bitrate caps are tuned for low-upload home connections. */
export const TIERS: Tier[] = [
  { name: '1080p', w: 1920, h: 1080, maxrate: 5000 },
  { name: '720p', w: 1280, h: 720, maxrate: 2800 },
  { name: '480p', w: 854, h: 480, maxrate: 1200 },
  { name: '360p', w: 640, h: 360, maxrate: 700 },
  { name: '240p', w: 426, h: 240, maxrate: 400 },
];

export const AUDIO_BITRATE = 128_000;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Fit display size into a bounding box (orientation-aware), never upscaling. */
export function fitInto(dispW: number, dispH: number, boxW: number, boxH: number): { w: number; h: number } {
  const portrait = dispH > dispW;
  const bw = portrait ? boxH : boxW;
  const bh = portrait ? boxW : boxH;
  const scale = Math.min(1, bw / dispW, bh / dispH);
  return { w: even(dispW * scale), h: even(dispH * scale) };
}

/** Human label: tier name when the size matches a tier, else the short side ("576p"). */
export function labelFor(w: number, h: number): string {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  for (const t of TIERS) {
    if (long >= t.w * 0.9 || short >= t.h * 0.9) {
      return short > t.h * 1.1 ? `${short}p` : t.name;
    }
  }
  return `${short}p`;
}

function h264Level(w: number, h: number, fps: number): number {
  const mbps = Math.ceil(w / 16) * Math.ceil(h / 16) * fps; // macroblocks per second
  if (mbps <= 108_000) return 31;
  if (mbps <= 216_000) return 32;
  if (mbps <= 245_760) return 40;
  if (mbps <= 522_240) return 42;
  return 51;
}

function presetFor(h: number): string {
  if (h >= 1000) return 'veryfast';
  if (h >= 700) return 'faster';
  return 'medium';
}

/** RFC 6381 codec string for an H.264 stream. */
export function avcCodecString(profile: string | null, level: number | null): string {
  const p = (profile ?? 'High').toLowerCase();
  let profileIdc = 0x64;
  let constraints = 0x00;
  if (p.includes('constrained baseline')) { profileIdc = 0x42; constraints = 0xe0; }
  else if (p.includes('baseline')) { profileIdc = 0x42; constraints = 0x00; }
  else if (p.includes('main')) { profileIdc = 0x4d; constraints = 0x40; }
  else if (p.includes('extended')) { profileIdc = 0x58; }
  else if (p.includes('high')) { profileIdc = 0x64; }
  const lvl = level && level > 0 && level < 70 ? level : 40;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(profileIdc)}${hex(constraints)}${hex(lvl)}`;
}

/**
 * RFC 6381 codec string for an HEVC stream (Main or Main 10, main tier). Browsers use it to decide whether they can
 * play the level at all; hls.js drops levels whose codecs the browser can't decode.
 */
export function hevcCodecString(profile: string | null, level: number | null): string {
  const main10 = /main 10/i.test(profile ?? '');
  const lvl = level && level > 0 && level <= 186 ? level : 120;
  return main10 ? `hvc1.2.4.L${lvl}.B0` : `hvc1.1.6.L${lvl}.B0`;
}

/**
 * Can the original video stream be sent untouched (stream copy)? H.264 (8-bit 4:2:0) plays everywhere; HEVC (Main /
 * Main 10, 4:2:0, SDR) is offered as an extra level that only browsers able to decode it will pick.
 */
export function copyIneligibility(v: VideoStreamInfo): string | null {
  if (v.codec === 'hevc') {
    if (!/^main( 10)?$/i.test((v.profile ?? '').trim())) return `HEVC profile ${v.profile ?? 'unknown'}`;
    if (v.pixFmt && !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(v.pixFmt)) return `pixel format ${v.pixFmt}`;
  } else {
    if (v.codec !== 'h264') return `video codec is ${v.codec}`;
    if (v.bitDepth !== 8) return `${v.bitDepth}-bit video`;
    if (v.pixFmt && !['yuv420p', 'yuvj420p'].includes(v.pixFmt)) return `pixel format ${v.pixFmt}`;
  }
  const prof = (v.profile ?? '').toLowerCase();
  if (/high 10|4:2:2|4:4:4|high 422|high 444/.test(prof)) return `profile ${v.profile}`;
  if (v.rotation !== 0) return 'rotated video';
  if (v.fieldOrder && !['progressive', 'unknown'].includes(v.fieldOrder)) return 'interlaced video';
  if (Math.abs(v.sar - 1) > 0.01) return 'non-square pixels';
  // Levels are written differently: H.264 4.0 is "40", HEVC 4.0 is "120" (30 × level).
  if (v.level && v.level > (v.codec === 'hevc' ? 186 : 52)) return `level ${v.level}`;
  if (v.hdr) return 'HDR video';
  if (v.width > 4096 || v.height > 2304) return 'resolution too high';
  return null;
}

export function planLadder(probe: ProbeResult, opts: { copyAllowed: boolean; copyReason?: string | null }): LadderPlan {
  const v = probe.video;
  const ineligible = copyIneligibility(v);
  const copy = opts.copyAllowed && !ineligible;
  // An HEVC original doesn't play everywhere, so the H.264 ladder must stand on its own (full size included).
  const universalCopy = copy && v.codec === 'h264';
  const copyReason = copy ? null : (ineligible ?? opts.copyReason ?? 'keyframes too far apart');
  const audioBw = probe.audio.length > 0 ? AUDIO_BITRATE : 0;
  const video: VideoRendition[] = [];

  const srcBitrate = v.bitRate ?? (probe.bitRate ? Math.max(probe.bitRate - probe.audio.reduce((a, s) => a + (s.bitRate ?? 192_000), 0), probe.bitRate * 0.7) : 8_000_000);

  if (copy) {
    const label = `Original · ${labelFor(v.displayWidth, v.displayHeight)}`;
    video.push({
      kind: 'video', id: 'src', label, mode: 'copy',
      width: v.width, height: v.height, fps: v.fps, maxrateKbps: 0, crf: 0, preset: '', level: v.level ?? 40,
      bandwidth: Math.round(srcBitrate * 1.6 + audioBw),
      averageBandwidth: Math.round(srcBitrate + audioBw),
      codecs: v.codec === 'hevc' ? hevcCodecString(v.profile, v.level) : avcCodecString(v.profile, v.level),
    });
  }

  // Top transcode: source display size capped to 1080p. With copy present, only clearly smaller tiers.
  const top = fitInto(v.displayWidth, v.displayHeight, 1920, 1080);
  const sizes: { w: number; h: number; maxrate: number; name: string }[] = [];
  if (!universalCopy) {
    const tier = TIERS.find((t) => labelFor(top.w, top.h) === t.name);
    const px = top.w * top.h;
    const maxrate = tier?.maxrate ?? Math.round(Math.min(6000, Math.max(400, 5000 * (px / (1920 * 1080)) ** 0.75)));
    sizes.push({ ...top, maxrate, name: labelFor(top.w, top.h) });
  }
  for (const t of TIERS) {
    const fit = fitInto(v.displayWidth, v.displayHeight, t.w, t.h);
    const ref = universalCopy ? { w: v.displayWidth, h: v.displayHeight } : top;
    if (fit.w * fit.h < ref.w * ref.h * 0.75 && !sizes.some((s) => s.name === t.name)) {
      sizes.push({ ...fit, maxrate: t.maxrate, name: t.name });
    }
  }

  for (const s of sizes) {
    const short = Math.min(s.w, s.h);
    // Halve high frame rates at 720p and below: big bandwidth saving, little visible loss.
    const fps = v.fps > 31 && short <= 720 ? v.fps / 2 : Math.min(v.fps, 60);
    const level = h264Level(s.w, s.h, fps);
    video.push({
      kind: 'video', id: `v${short}`, label: s.name, mode: 'transcode',
      width: s.w, height: s.h, fps, maxrateKbps: s.maxrate, crf: 23, preset: presetFor(short), level,
      bandwidth: s.maxrate * 1000 + audioBw,
      averageBandwidth: Math.round(s.maxrate * 1000 * 0.65 + audioBw),
      codecs: avcCodecString('High', level),
    });
  }

  const defaultAudio = probe.audio.find((a) => a.isDefault) ?? probe.audio[0];
  const audio: AudioRendition[] = probe.audio.slice(0, 8).map((a) => {
    const lang = languageName(a.language);
    const detail = `${codecLabel(a.codec)} ${channelLabel(a.channels)}`;
    const base = a.title && lang && !a.title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} · ${a.title}` : (a.title ?? lang ?? `Track ${a.typeIndex + 1}`);
    return {
      kind: 'audio', id: `a${a.typeIndex}`, streamIndex: a.index, typeIndex: a.typeIndex,
      label: `${base} (${detail})`, language: a.language && a.language !== 'und' ? a.language : null,
      isDefault: a === defaultAudio, bitrate: AUDIO_BITRATE,
    };
  });

  return { video, audio, copyReason };
}
