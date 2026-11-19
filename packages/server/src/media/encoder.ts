import type { AudioRendition, VideoRendition } from './ladder';
import type { CopySegment } from './packets';
import type { ProbeResult } from './probe';

/** Every media timestamp is shifted by this many seconds, so B-frame/priming offsets never go negative. */
export const TS_BASE = 10;
/** Input seek pre-roll: demuxers can land late or drop audio right after a seek; we trim precisely on output. */
export const PREROLL = 2;

export type EncoderKind = 'libx264' | 'h264_nvenc' | 'h264_vaapi';

export interface EncoderChoice {
  kind: EncoderKind;
  /** VAAPI render node, when kind is h264_vaapi. */
  device?: string;
}

export interface JobTiming {
  /** First segment index produced by the job. */
  startIndex: number;
  /** Total segments in the rendition. */
  total: number;
  /** Nominal segment length (seconds). */
  segSeconds: number;
}

const f6 = (n: number) => n.toFixed(6);

/** Seek/timestamp arguments shared by transcode and audio jobs (validated on MP4, MKV, TS, AVI, WebM). */
function timelineArgs(probe: ProbeResult, t: JobTiming): { input: string[]; output: string[] } {
  const T = t.startIndex * t.segSeconds;
  const st = probe.startTime;
  if (t.startIndex === 0) {
    // No seek at all: some demuxers drop the first audio packets after any seek, even to 0.
    return { input: ['-copyts'], output: ['-output_ts_offset', f6(TS_BASE - st)] };
  }
  return {
    input: ['-copyts', '-ss', f6(Math.max(0, T - PREROLL))],
    // Output-side seek trims exactly at the absolute boundary; result = (src - st) + TS_BASE.
    output: ['-ss', f6(T + st), '-output_ts_offset', f6(T + TS_BASE)],
  };
}

/**
 * `timeDelta`: forced keyframes can land a rounding error *before* the requested time, which makes the
 * segment muxer skip that cut (ffmpeg documents this; the fix is half a frame of tolerance).
 */
function segmentMuxerArgs(t: JobTiming, listFile: string, pattern: string, timeDelta = 0): string[] {
  const remaining = t.total - t.startIndex;
  const times: string[] = [];
  for (let i = 1; i < remaining; i++) times.push(f6(i * t.segSeconds));
  return [
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'segment', '-segment_format', 'mpegts', '-reset_timestamps', '0',
    ...(timeDelta > 0 ? ['-segment_time_delta', f6(timeDelta)] : []),
    '-segment_list', listFile, '-segment_list_type', 'csv',
    ...(times.length ? ['-segment_times', times.join(',')] : ['-segment_time', '1000000']),
    pattern,
  ];
}

export function videoFilter(probe: ProbeResult, r: VideoRendition, enc: EncoderChoice, hasTonemap: boolean): string {
  const v = probe.video;
  const chain: string[] = [];
  if (v.fieldOrder && !['progressive', 'unknown'].includes(v.fieldOrder)) chain.push('bwdif=mode=send_frame:parity=auto:deint=interlaced');
  if (v.hdr && hasTonemap) {
    chain.push(
      'zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    );
  }
  if (r.fps < v.fps - 0.01) chain.push(`fps=${r.fps.toFixed(5)}`);
  chain.push(`scale=${r.width}:${r.height}:flags=bicubic`, 'setsar=1');
  if (enc.kind === 'h264_vaapi') chain.push('format=nv12', 'hwupload');
  else chain.push('format=yuv420p');
  return chain.join(',');
}

function videoEncoderArgs(r: VideoRendition, enc: EncoderChoice, keyframeExpr: string): string[] {
  const lvl = (r.level / 10).toFixed(1);
  const rc = ['-maxrate', `${r.maxrateKbps}k`, '-bufsize', `${r.maxrateKbps * 2}k`];
  // Only our forced keyframes may start a segment: no periodic or scene-cut keyframes.
  const gop = ['-g', '100000', '-force_key_frames', keyframeExpr];
  switch (enc.kind) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', String(r.crf), '-b:v', '0', ...rc,
        '-profile:v', 'high', '-level:v', lvl, '-forced-idr', '1', '-no-scenecut', '1', '-bf', '2', ...gop];
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'QVBR', '-global_quality', String(r.crf), '-b:v', `${Math.round(r.maxrateKbps * 0.7)}k`, ...rc,
        '-profile:v', 'high', '-level', String(r.level), ...gop];
    default:
      return ['-c:v', 'libx264', '-preset', r.preset, '-profile:v', 'high', '-level:v', lvl, '-crf', String(r.crf), ...rc,
        '-sc_threshold', '0', '-x264-params', 'rc-lookahead=20', ...gop];
  }
}

export interface JobArgs {
  args: string[];
}

export function buildVideoJobArgs(
  probe: ProbeResult, r: VideoRendition, t: JobTiming, enc: EncoderChoice, hasTonemap: boolean,
  listFile: string, pattern: string,
): string[] {
  const tl = timelineArgs(probe, t);
  const remaining = t.total - t.startIndex;
  // `t` in the expression is relative to the job's first output frame (verified empirically).
  const keyframeExpr = `expr:gte(t,n_forced*${t.segSeconds})*lt(t,${f6((remaining - 1) * t.segSeconds + 0.5)})`;
  const hw = enc.kind === 'h264_vaapi' && enc.device ? ['-vaapi_device', enc.device] : [];
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...hw,
    ...tl.input, '-i', probe.path,
    '-map', `0:${probe.video.index}`, '-an', '-sn', '-dn',
    '-vf', videoFilter(probe, r, enc, hasTonemap),
    ...videoEncoderArgs(r, enc, keyframeExpr),
    ...tl.output,
    ...segmentMuxerArgs(t, listFile, pattern, 0.5 / r.fps),
  ];
}

export function buildAudioJobArgs(probe: ProbeResult, r: AudioRendition, t: JobTiming, listFile: string, pattern: string): string[] {
  const tl = timelineArgs(probe, t);
  const src = probe.audio.find((a) => a.index === r.streamIndex);
  const rate = src && (src.sampleRate === 44100 || src.sampleRate === 48000) ? src.sampleRate : 48000;
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    ...tl.input, '-i', probe.path,
    '-map', `0:${r.streamIndex}`, '-vn', '-sn', '-dn',
    '-c:a', 'aac', '-b:a', String(r.bitrate), '-ac', '2', '-ar', String(rate),
    ...tl.output,
    ...segmentMuxerArgs(t, listFile, pattern),
  ];
}

/** One stream-copied segment, cut exactly at source keyframes regardless of container seek accuracy. */
export function buildCopySegmentArgs(probe: ProbeResult, seg: CopySegment, out: string): string[] {
  const st = probe.startTime;
  const sOut = seg.keyPts - seg.margin;
  const outputSeek = sOut > 0
    ? ['-ss', f6(sOut), '-output_ts_offset', f6(sOut - st + TS_BASE)]
    : ['-output_ts_offset', f6(TS_BASE - st)];
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-copyts', '-ss', f6(Math.max(0, seg.start - 3)), '-i', probe.path,
    '-map', `0:${probe.video.index}`, '-c:v', 'copy', '-frames:v', String(seg.packets),
    ...outputSeek,
    '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', out,
  ];
}
