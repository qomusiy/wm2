import type { AudioRendition, VideoRendition } from './ladder';
import type { SegmentInfo } from './scheduler';

const q = (s: string) => s.replace(/["\r\n]/g, "'");

function audioGroup(audio: AudioRendition[]): string[] {
  return audio.map((a) => {
    const attrs = [
      'TYPE=AUDIO', 'GROUP-ID="aud"', `NAME="${q(a.label)}"`,
      ...(a.language && /^[a-z]{2,3}$/i.test(a.language) ? [`LANGUAGE="${a.language.toLowerCase()}"`] : []),
      `DEFAULT=${a.isDefault ? 'YES' : 'NO'}`, 'AUTOSELECT=YES', 'CHANNELS="2"', `URI="${a.id}/index.m3u8"`,
    ];
    return `#EXT-X-MEDIA:${attrs.join(',')}`;
  });
}

function streamInf(v: VideoRendition, hasAudio: boolean): string {
  const codecs = hasAudio ? `${v.codecs},mp4a.40.2` : v.codecs;
  const attrs = [
    `BANDWIDTH=${Math.round(v.bandwidth)}`, `AVERAGE-BANDWIDTH=${Math.round(v.averageBandwidth)}`,
    `RESOLUTION=${v.width}x${v.height}`, `FRAME-RATE=${v.fps.toFixed(3)}`, `CODECS="${codecs}"`,
    ...(hasAudio ? ['AUDIO="aud"'] : []),
  ];
  return `#EXT-X-STREAM-INF:${attrs.join(',')}\n${v.id}/index.m3u8`;
}

export function masterPlaylist(video: VideoRendition[], audio: AudioRendition[]): string {
  return ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-INDEPENDENT-SEGMENTS', ...audioGroup(audio), ...video.map((v) => streamInf(v, audio.length > 0)), ''].join('\n');
}

export function mediaPlaylist(segments: SegmentInfo[]): string {
  const target = Math.max(1, Math.ceil(Math.max(...segments.map((s) => s.duration)) - 1e-3));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  segments.forEach((s, i) => lines.push(`#EXTINF:${s.duration.toFixed(6)},`, `${i}.ts`));
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Fixed-length segmentation for transcoded renditions. The last segment is 1–(S+1) seconds long. */
export function fixedSegments(end: number, segSeconds: number): SegmentInfo[] {
  const n = Math.max(1, Math.ceil((end - 1) / segSeconds));
  const out: SegmentInfo[] = [];
  for (let k = 0; k < n; k++) {
    const start = k * segSeconds;
    out.push({ start, duration: k === n - 1 ? Math.max(0.1, end - start) : segSeconds });
  }
  return out;
}
