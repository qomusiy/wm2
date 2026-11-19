// Generates the media test matrix with ffmpeg. Idempotent: skips files that already exist.
// Usage: node generate.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, 'media');
mkdirSync(out, { recursive: true });
const ff = process.env.FFMPEG_PATH ?? 'ffmpeg';

const video = (size, rate, dur) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
const tone = (freq, dur, layout = 'stereo') =>
  ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${dur},aformat=channel_layouts=${layout}`];

export const FIXTURES = {
  'h264_aac.mp4': [...video('1280x720', 24, 30), ...tone(440, 30),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  // Typical movie rip: irregular GOPs (scenecut on), 5.1 AC-3 + second stereo track, SRT subs.
  'h264_ac3_51_multi.mkv': [...video('1920x1080', '24000/1001', 40), ...tone(440, 40, '5.1'), ...tone(880, 40),
    '-f', 'srt', '-i', join(out, 'subs.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '120', '-keyint_min', '24', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'ac3', '-b:a:0', '384k', '-c:a:1', 'aac', '-b:a:1', '128k', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 5.1',
    '-metadata:s:a:1', 'language=rus', '-metadata:s:a:1', 'title=Russian dub',
    '-metadata:s:s:0', 'language=eng', '-metadata', 'title=Test Movie'],
  'hevc10_eac3.mkv': [...video('1920x1080', 24, 30), ...tone(523, 30, '5.1'),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error',
    '-c:a', 'eac3', '-b:a', '256k'],
  'vp9_opus.webm': [...video('640x360', 30, 30), ...tone(660, 30),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k', '-c:a', 'libopus'],
  'mpeg4_mp3.avi': [...video('640x480', 25, 30), ...tone(330, 30),
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-b:a', '128k'],
  // MPEG-TS has no index and a non-zero start time: exercises seeking and timestamp normalisation.
  'h264_aac.ts': [...video('1280x720', 25, 30), ...tone(392, 30),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'mpegts'],
  // DVD-like: MPEG-2, interlaced, anamorphic 16:9 (720x576 with SAR 64:45), AC-3 stereo.
  'dvd_mpeg2_anamorphic.mkv': [...video('720x576', 25, 30), ...tone(294, 30),
    '-map', '0:v', '-map', '1:a', '-vf', 'setsar=64/45', '-c:v', 'mpeg2video', '-b:v', '4M', '-flags', '+ilme+ildct', '-top', '1',
    '-c:a', 'ac3', '-b:a', '192k'],
  // Phone video: H.264 with 90° rotation metadata (must not be stream-copied into TS).
  'rotated_phone.mp4': [...video('1280x720', 30, 20), ...tone(370, 20),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  // Longer clip for end-to-end tests (seeks beyond what a viewer has buffered).
  'long_h264_aac.mkv': [...video('854x480', 24, 240), ...tone(500, 240),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-metadata', 'title=Long Test Movie'],
  'h264_noaudio.mp4': [...video('854x480', 24, 20),
    '-map', '0:v', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
  // An MKV with an embedded ASS track (styles must survive extraction).
  'ass_embedded.mkv': [...video('640x360', 24, 16), ...tone(440, 16), '-i', join(out, 'long_h264_aac.signs.ass'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-c:s', 'copy', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Signs & Songs'],
};

// External subtitles next to the long end-to-end clip (exercises discovery next to the video).
writeFileSync(join(out, 'long_h264_aac.en.srt'),
  '1\n00:00:01,000 --> 00:00:30,000\nExternal English subtitle line\n\n2\n00:01:00,000 --> 00:01:10,000\nSecond external line\n\n');
// Styled ASS next to the same clip (kept in signs.ass, which the web client's parser tests also read): a positioned
// yellow sign at the top, italic dialogue, a fade, karaoke and a vector drawing (which must not show up as text).
copyFileSync(join(here, 'signs.ass'), join(out, 'long_h264_aac.signs.ass'));
writeFileSync(join(out, 'subs.srt'),
  '1\n00:00:01,000 --> 00:00:04,000\nHello from the test movie\n\n2\n00:00:10,500 --> 00:00:13,000\nSecond line, <i>italic</i>\n\n');

for (const [name, args] of Object.entries(FIXTURES)) {
  const target = join(out, name);
  if (existsSync(target)) continue;
  const finalArgs = ['-hide_banner', '-loglevel', 'error', '-y', ...args];
  finalArgs.push(target);
  process.stdout.write(`generating ${name} ... `);
  execFileSync(ff, finalArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (name === 'rotated_phone.mp4') {
    // Real phones store rotation as a display matrix; -display_rotation is an input option, so remux.
    const tmp = join(out, 'rotated_tmp.mp4');
    execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation:v:0', '90', '-i', target,
      '-c', 'copy', tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
    execFileSync('mv', [tmp, target]);
  }
  console.log('ok');
}
