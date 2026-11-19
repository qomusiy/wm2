export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseTime(t: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(t.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '‎', '&rlm;': '‏', '&quot;': '"', '&#39;': "'" };

/** Minimal, safe WebVTT parser: timings + text. Markup other than <i>/<b>/<u> is dropped. */
export function parseVtt(src: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, rest] = lines[i]!.split('-->');
    const start = parseTime(a ?? '');
    const end = parseTime((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const text = lines.slice(i + 1).join('\n')
      .replace(/<(?!\/?[ibu]>)[^>]*>/g, '')
      .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Cues active at time t (handles overlaps). */
export function activeCues(cues: Cue[], t: number): Cue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: Cue[] = [];
  for (let k = lo - 1; k >= 0 && k >= lo - 20; k--) if (cues[k]!.end > t) out.unshift(cues[k]!);
  return out;
}
