/*
 * Wire format of the "seg" data channel used for direct (WebRTC) segment delivery.
 *
 * Text frames carry JSON control messages; binary frames carry segment bytes prefixed with the 4-byte request id
 * they belong to, so several transfers can interleave on one ordered, reliable channel. Everything received from a
 * peer is untrusted and goes through parseControl / decodeChunk.
 */

export type PeerControl =
  /** Ask for a segment. key = "<mediaId>/<rendition>/<n>.ts". */
  | { t: 'get'; id: number; key: string }
  /** Answer to a get: on 200, exactly `size` bytes follow in binary frames tagged with `id`. */
  | { t: 'res'; id: number; status: 200 | 404 | 429 | 503; size: number }
  /** The requester no longer wants it (seek, quality switch, it came faster from elsewhere). */
  | { t: 'cancel'; id: number }
  /** Segments this peer can serve (reset = the list replaces the previous one). */
  | { t: 'have'; keys: string[]; reset?: boolean }
  /** Segments this peer no longer has. */
  | { t: 'lost'; keys: string[] };

export const SEGMENT_KEY_RE = /^([A-Za-z0-9_-]{4,64})\/([a-z0-9-]{1,16})\/(\d{1,6})\.ts$/;
const MAX_KEYS = 4000;
const MAX_ID = 0xffffffff;

export function isSegmentKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 100 && SEGMENT_KEY_RE.test(key);
}

/** "/media/<mediaId>/<rid>/<n>.ts" (absolute or relative URL) -> segment key, or null for anything else. */
export function segmentKeyFromUrl(url: string): string | null {
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? '';
  const m = /^\/media\/(.+)$/.exec(path);
  return m && isSegmentKey(m[1]) ? m[1]! : null;
}

export function parseSegmentKey(key: string): { mediaId: string; rid: string; index: number } | null {
  const m = SEGMENT_KEY_RE.exec(key);
  return m ? { mediaId: m[1]!, rid: m[2]!, index: Number(m[3]) } : null;
}

const validId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_ID;

export function parseControl(text: string): PeerControl | null {
  if (typeof text !== 'string' || text.length > 256 * 1024) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'get':
      return validId(m.id) && isSegmentKey(m.key) ? { t: 'get', id: m.id, key: m.key } : null;
    case 'res':
      return validId(m.id) && [200, 404, 429, 503].includes(m.status as number) && Number.isInteger(m.size)
        && (m.size as number) >= 0 && (m.size as number) <= 64 * 1024 * 1024
        ? { t: 'res', id: m.id, status: m.status as 200 | 404 | 429 | 503, size: m.size as number } : null;
    case 'cancel':
      return validId(m.id) ? { t: 'cancel', id: m.id } : null;
    case 'have':
    case 'lost': {
      if (!Array.isArray(m.keys) || m.keys.length > MAX_KEYS || !m.keys.every(isSegmentKey)) return null;
      return m.t === 'have' ? { t: 'have', keys: m.keys as string[], ...(m.reset === true ? { reset: true } : {}) } : { t: 'lost', keys: m.keys as string[] };
    }
    default:
      return null;
  }
}

export function encodeChunk(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, id >>> 0);
  out.set(payload, 4);
  return out;
}

export function decodeChunk(data: ArrayBuffer | Uint8Array): { id: number; payload: Uint8Array } | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < 4) return null;
  return { id: new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0), payload: u8.subarray(4) };
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];

/** True for addresses nobody outside this network could use (and which would only leak network layout). */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.endsWith('.local')) return true;
  if (a.includes(':')) return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:') && isPrivateAddress(a.slice(7));
  return PRIVATE_V4.some((re) => re.test(a));
}

/** Parses "candidate:..." (with or without "a=") into its address and type. */
export function candidateInfo(candidate: string): { address: string; type: string } | null {
  const m = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/i.exec(candidate);
  return m ? { address: m[1]!, type: m[2]!.toLowerCase() } : null;
}
