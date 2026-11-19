/** Recently downloaded segments kept in memory so this viewer can pass them on to others (least recently used out). */
export class SegmentCache {
  private readonly map = new Map<string, Uint8Array>();
  bytes = 0;

  constructor(readonly maxBytes: number, private readonly onEvict: (keys: string[]) => void) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  /** Returns true when the segment was new. */
  put(key: string, data: Uint8Array): boolean {
    if (this.map.has(key) || data.byteLength === 0 || data.byteLength > this.maxBytes / 4) return false;
    this.map.set(key, data);
    this.bytes += data.byteLength;
    const evicted: string[] = [];
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.byteLength;
      evicted.push(k);
    }
    if (evicted.length) this.onEvict(evicted);
    return true;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  /** Drops everything not belonging to the given video. */
  retainMedia(mediaId: string | null): string[] {
    const gone: string[] = [];
    for (const [k, v] of this.map) {
      if (mediaId && k.startsWith(`${mediaId}/`)) continue;
      this.map.delete(k);
      this.bytes -= v.byteLength;
      gone.push(k);
    }
    return gone;
  }
}

/** Memory budget for shared segments: modest on phones, more on desktops. */
export function cacheBudget(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
  if (mobile || (mem !== undefined && mem <= 2)) return 48 * 1024 * 1024;
  if (mem !== undefined && mem <= 4) return 96 * 1024 * 1024;
  return 160 * 1024 * 1024;
}
