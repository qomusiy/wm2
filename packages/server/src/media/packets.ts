import { runLines } from '../util/proc';
import { jailed } from '../util/sandbox';

/** ffprobe on the video, sandboxed with read access to that file only. */
function jailedProbe(ffprobe: string, path: string, args: string[]): [string, string[]] {
  return jailed(ffprobe, args, { read: [path], write: [] });
}

/** Video packet index in decode order, timestamps absolute (source timebase, seconds). */
export interface PacketIndex {
  pts: Float64Array;
  key: Uint8Array;
  count: number;
}

export interface CopySegment {
  /** Absolute pts (source timeline) of the keyframe that starts the segment. */
  keyPts: number;
  /** Start relative to the file start (keyPts - startTime). */
  start: number;
  duration: number;
  /** Number of video packets (decode order) in the segment. */
  packets: number;
  /** Margin before keyPts used for the output-side seek (seconds). */
  margin: number;
  bytes: number;
}

export interface GopStats {
  keyframes: number;
  maxGap: number;
  meanGap: number;
  missingPts: boolean;
}

function parsePacketLine(line: string): { pts: number; key: boolean; size: number } | null {
  // csv: pts_time,size,flags
  const parts = line.split(',');
  const pts = Number.parseFloat(parts[0] ?? '');
  const size = Number.parseInt(parts[1] ?? '0', 10) || 0;
  const key = (parts[2] ?? '').startsWith('K');
  if (!Number.isFinite(pts)) return { pts: NaN, key, size };
  return { pts, key, size };
}

/** Quick look at the first `seconds` of the video to judge keyframe spacing (cheap: partial read). */
export async function sampleGop(ffprobe: string, path: string, streamIndex: number, seconds = 120): Promise<GopStats> {
  const keys: number[] = [];
  let missingPts = false;
  await runLines(...jailedProbe(ffprobe, path, [
    '-v', 'error', '-read_intervals', `%+${seconds}`, '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts_time,size,flags', '-of', 'csv=p=0', path,
  ]), (line) => {
    const p = parsePacketLine(line);
    if (!p) return;
    if (p.key) {
      if (Number.isNaN(p.pts)) missingPts = true;
      else keys.push(p.pts);
    }
  });
  keys.sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < keys.length; i++) maxGap = Math.max(maxGap, keys[i]! - keys[i - 1]!);
  const meanGap = keys.length > 1 ? (keys[keys.length - 1]! - keys[0]!) / (keys.length - 1) : 0;
  return { keyframes: keys.length, maxGap, meanGap, missingPts };
}

/**
 * Full scan of the video stream's packets (reads the whole file; I/O bound).
 * Progress is reported as a fraction of `duration`.
 */
export async function scanVideoPackets(
  ffprobe: string,
  path: string,
  streamIndex: number,
  duration: number,
  startTime: number,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ index: PacketIndex; sizes: Uint32Array }> {
  let cap = 1 << 16;
  let pts = new Float64Array(cap);
  let key = new Uint8Array(cap);
  let sizes = new Uint32Array(cap);
  let n = 0;
  let lastReport = 0;
  const res = await runLines(...jailedProbe(ffprobe, path, [
    '-v', 'error', '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts_time,size,flags', '-of', 'csv=p=0', path,
  ]), (line) => {
    const p = parsePacketLine(line);
    if (!p) return;
    if (n === cap) {
      cap *= 2;
      const np = new Float64Array(cap); np.set(pts); pts = np;
      const nk = new Uint8Array(cap); nk.set(key); key = nk;
      const ns = new Uint32Array(cap); ns.set(sizes); sizes = ns;
    }
    pts[n] = p.pts;
    key[n] = p.key ? 1 : 0;
    sizes[n] = p.size;
    n++;
    if (onProgress && (n & 1023) === 0 && Number.isFinite(p.pts)) {
      const f = Math.min(1, Math.max(0, (p.pts - startTime) / duration));
      if (f - lastReport >= 0.01) {
        lastReport = f;
        onProgress(f);
      }
    }
  }, { signal });
  if (signal?.aborted) throw new Error('aborted');
  if (res.code !== 0) throw new Error(`packet scan failed: ${res.stderr.slice(0, 300)}`);
  onProgress?.(1);
  return { index: { pts: pts.subarray(0, n), key: key.subarray(0, n), count: n }, sizes: sizes.subarray(0, n) };
}

/**
 * Cut the stream into segments at keyframes, each at least `target` seconds long
 * (except the last). Returns null when the stream can't be cut reliably.
 */
export function buildCopySegments(
  index: PacketIndex,
  sizes: Uint32Array,
  startTime: number,
  endTime: number,
  target: number,
): CopySegment[] | null {
  const keyIdx: number[] = [];
  for (let i = 0; i < index.count; i++) {
    if (index.key[i]) {
      if (!Number.isFinite(index.pts[i]!)) return null;
      keyIdx.push(i);
    }
  }
  if (keyIdx.length === 0 || keyIdx[0] !== 0) {
    // Leading non-key packets can't be decoded on their own; tolerate a few by starting at the first keyframe.
    if (keyIdx.length === 0) return null;
  }
  // Keyframe pts must be strictly increasing in decode order for clean cuts.
  for (let k = 1; k < keyIdx.length; k++) {
    if (index.pts[keyIdx[k]!]! <= index.pts[keyIdx[k - 1]!]!) return null;
  }
  const segments: CopySegment[] = [];
  let segStartK = 0;
  const pushSegment = (fromK: number, toPacket: number, nextKeyPts: number | null) => {
    const startPacket = keyIdx[fromK]!;
    const keyPts = index.pts[startPacket]!;
    const prevKeyPts = fromK > 0 ? index.pts[keyIdx[fromK - 1]!]! : keyPts - 10;
    let bytes = 0;
    for (let i = startPacket; i < toPacket; i++) bytes += sizes[i]!;
    const segEnd = nextKeyPts ?? endTime;
    segments.push({
      keyPts,
      start: keyPts - startTime,
      duration: Math.max(0.001, segEnd - keyPts),
      packets: toPacket - startPacket,
      margin: Math.min(0.5, 0.5 * (keyPts - prevKeyPts)),
      bytes,
    });
  };
  for (let k = 1; k < keyIdx.length; k++) {
    const segStartPts = index.pts[keyIdx[segStartK]!]!;
    const pts = index.pts[keyIdx[k]!]!;
    if (pts - segStartPts >= target - 1e-6) {
      pushSegment(segStartK, keyIdx[k]!, pts);
      segStartK = k;
    }
  }
  pushSegment(segStartK, index.count, null);
  // Merge a tiny trailing segment into the previous one.
  if (segments.length > 1 && segments[segments.length - 1]!.duration < 1) {
    const last = segments.pop()!;
    const prev = segments[segments.length - 1]!;
    prev.duration += last.duration;
    prev.packets += last.packets;
    prev.bytes += last.bytes;
  }
  return segments;
}

/** Read the tail of the file to find where each stream really ends (absolute seconds). */
export async function scanStreamEnds(ffprobe: string, path: string, duration: number, startTime: number): Promise<Map<number, number>> {
  const ends = new Map<number, number>();
  const from = Math.max(0, startTime + duration - 40);
  await runLines(...jailedProbe(ffprobe, path, [
    '-v', 'error', '-read_intervals', `${from.toFixed(3)}%`, '-show_entries', 'packet=stream_index,pts_time,duration_time',
    '-of', 'csv=p=0', path,
  ]), (line) => {
    const [si, p, d] = line.split(',');
    const s = Number.parseInt(si ?? '', 10);
    const pts = Number.parseFloat(p ?? '');
    const dur = Number.parseFloat(d ?? '');
    if (!Number.isFinite(s) || !Number.isFinite(pts)) return;
    const end = pts + (Number.isFinite(dur) ? dur : 0);
    if (end > (ends.get(s) ?? -Infinity)) ends.set(s, end);
  });
  return ends;
}
