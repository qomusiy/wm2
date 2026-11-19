import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util/proc';
import { jailed } from '../util/sandbox';
import { createLogger } from '../util/log';
import type { EncoderChoice } from './encoder';
import type { FfmpegInfo } from './ffmpeg';

const log = createLogger('hwaccel');

export interface EncoderDetection {
  choice: EncoderChoice;
  label: string;
  tried: { kind: string; ok: boolean; error?: string }[];
}

function renderNodes(): string[] {
  try {
    return readdirSync('/dev/dri').filter((n) => n.startsWith('renderD')).map((n) => join('/dev/dri', n));
  } catch {
    return [];
  }
}

/**
 * Pick the fastest H.264 encoder that actually works, by running a real 1-second test encode with the same
 * options the pipeline uses (forced keyframes, scaling). "Listed by ffmpeg" does not mean "works".
 */
export async function detectEncoder(ff: FfmpegInfo, opts: { allowHardware?: boolean } = {}): Promise<EncoderDetection> {
  const tried: EncoderDetection['tried'] = [];
  // Hardware encoders are validated by the media test suite on Linux (VAAPI). On Windows the well-tested software
  // encoder is used unless hardware encoding is asked for explicitly (WATCHROOM_HWACCEL=1).
  const allowHardware = opts.allowHardware ?? (process.platform === 'win32'
    ? process.env.WATCHROOM_HWACCEL === '1'
    : process.env.WATCHROOM_HWACCEL !== '0');
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1'];
  const sink = ['-f', 'null', '-'];
  const kf = ['-g', '100000', '-force_key_frames', 'expr:gte(t,n_forced*0.5)'];
  const candidates: { choice: EncoderChoice; label: string; args: string[] }[] = [];

  if (allowHardware && ff.encoders.has('h264_nvenc') && (existsSync('/dev/nvidia0') || process.platform === 'win32')) {
    candidates.push({
      choice: { kind: 'h264_nvenc' }, label: 'NVIDIA NVENC',
      args: [...src, '-vf', 'scale=854:480,format=yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p4', '-forced-idr', '1', '-no-scenecut', '1', ...kf, ...sink],
    });
  }
  if (allowHardware && ff.encoders.has('h264_vaapi')) {
    for (const device of renderNodes()) {
      candidates.push({
        choice: { kind: 'h264_vaapi', device }, label: `VAAPI (${device})`,
        args: ['-vaapi_device', device, ...src, '-vf', 'scale=854:480,format=nv12,hwupload', '-c:v', 'h264_vaapi', ...kf, ...sink],
      });
    }
  }

  for (const c of candidates) {
    try {
      // Tested the way it will run: inside the sandbox (when there is one), with the GPU but nothing else.
      const [cmd, args] = jailed(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...c.args], { read: [], write: [] });
      const res = await run(cmd, args, { timeoutMs: 15_000 });
      const ok = res.code === 0;
      tried.push({ kind: c.label, ok, error: ok ? undefined : res.stderr.trim().split('\n').pop()?.slice(0, 200) });
      if (ok) {
        log.info(`using hardware encoder: ${c.label}`);
        return { choice: c.choice, label: c.label, tried };
      }
    } catch (err) {
      tried.push({ kind: c.label, ok: false, error: (err as Error).message });
    }
  }
  if (tried.length) log.info('hardware encoders unavailable, using libx264', tried);
  tried.push({ kind: 'libx264', ok: true });
  return { choice: { kind: 'libx264' }, label: 'Software (x264)', tried };
}
