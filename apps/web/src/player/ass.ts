/*
 * A compact ASS/SSA subtitle parser for our own renderer. Supported: styles, colours and transparency, bold, italic,
 * underline, strike-out, font size and family, outline, shadow, alignment (\an, \a, style), margins, \pos, \move,
 * \fad / \fade, rotation (\frz), scaling (\fscx/\fscy), \r resets, \N line breaks and hard spaces. Karaoke timing
 * (\k), clipping and vector drawings (\p) are not drawn: karaoke text shows plainly, drawings are dropped.
 * The script is untrusted: it only ever becomes text and validated numbers/colours, never markup.
 */

export interface AssRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** CSS colours (rgba). */
  color: string;
  outlineColor: string;
  shadowColor: string;
  /** Script units (scaled with PlayResY when drawn). */
  size: number;
  outline: number;
  shadow: number;
  blur: number;
  font: string | null;
  scaleX: number;
  scaleY: number;
}

export interface AssCue {
  start: number;
  end: number;
  layer: number;
  /** Order in the file (ties are drawn in file order). */
  order: number;
  lines: AssRun[][];
  /** Numpad alignment 1–9 (1 = bottom left, 5 = middle, 9 = top right). */
  align: number;
  pos: { x: number; y: number } | null;
  move: { x1: number; y1: number; x2: number; y2: number; t1: number; t2: number } | null;
  /** Fade in / out lengths in milliseconds. */
  fade: { in: number; out: number } | null;
  /** Degrees, counter-clockwise (ASS convention). */
  rotate: number;
  margins: { l: number; r: number; v: number };
  /** BorderStyle 3: an opaque box behind the text in this colour. */
  box: string | null;
}

export interface AssScript {
  playResX: number;
  playResY: number;
  cues: AssCue[];
}

interface Style {
  font: string;
  size: number;
  primary: string;
  outlineColor: string;
  back: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  scaleX: number;
  scaleY: number;
  angle: number;
  borderStyle: number;
  outline: number;
  shadow: number;
  align: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

const DEFAULT_STYLE: Style = {
  font: 'Arial', size: 20, primary: 'rgba(255,255,255,1)', outlineColor: 'rgba(0,0,0,1)', back: 'rgba(0,0,0,0.5)',
  bold: false, italic: false, underline: false, strike: false, scaleX: 100, scaleY: 100, angle: 0, borderStyle: 1,
  outline: 2, shadow: 2, align: 2, marginL: 10, marginR: 10, marginV: 10,
};

const MAX_CUES = 20_000;
const num = (v: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** ASS colour (&HAABBGGRR&, &HBBGGRR, or a decimal number) to CSS rgba; ASS alpha 00 is opaque. */
export function assColor(raw: string | undefined, fallback: string, alphaOverride?: number): string {
  if (!raw) return fallback;
  const v = raw.trim().replace(/&$/, '');
  let n: number;
  if (/^&H[0-9a-f]+$/i.test(v)) n = Number.parseInt(v.slice(2), 16);
  else if (/^-?\d+$/.test(v)) n = Number.parseInt(v, 10) >>> 0;
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  const r = n & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = (n >>> 16) & 0xff;
  const a = alphaOverride ?? ((n >>> 24) & 0xff);
  return `rgba(${r},${g},${b},${Math.round(((255 - a) / 255) * 1000) / 1000})`;
}

function withAlpha(rgba: string, assAlpha: number): string {
  const m = /^rgba\((\d+),(\d+),(\d+),[\d.]+\)$/.exec(rgba);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${Math.round(((255 - assAlpha) / 255) * 1000) / 1000})` : rgba;
}

function parseAlpha(v: string): number | null {
  const m = /^&?H?([0-9a-f]{1,2})&?$/i.exec(v.trim());
  return m ? Number.parseInt(m[1]!, 16) : null;
}

function parseTime(t: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(t.trim());
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** SSA ("v4") alignment numbering to numpad. */
function legacyAlign(a: number): number {
  const base = a & 3 || 2;
  if (a & 4) return base + 6; // top
  if (a & 8) return base + 3; // middle
  return base;
}

function splitFields(line: string, count: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < count - 1; i++) {
    const c = rest.indexOf(',');
    if (c < 0) break;
    out.push(rest.slice(0, c));
    rest = rest.slice(c + 1);
  }
  out.push(rest);
  return out;
}

function cleanFont(name: string | undefined): string | null {
  const f = (name ?? '').replace(/^@/, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 64);
  return f || null;
}

export function parseAss(src: string): AssScript {
  const text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let section = '';
  let playResX = 0;
  let playResY = 0;
  let wrapStyle = 0;
  let legacy = false;
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  const styles = new Map<string, Style>();
  const cues: AssCue[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      if (section === 'v4 styles') legacy = true;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (section === 'script info') {
      if (key === 'playresx') playResX = num(value, 0);
      else if (key === 'playresy') playResY = num(value, 0);
      else if (key === 'wrapstyle') wrapStyle = num(value, 0);
      else if (key === 'scripttype' && /v4\.00$/i.test(value)) legacy = true;
    } else if (section.endsWith('styles')) {
      if (key === 'format') styleFormat = value.split(',').map((s) => s.trim().toLowerCase());
      else if (key === 'style' && styleFormat.length) {
        const f = splitFields(value, styleFormat.length);
        const get = (name: string) => f[styleFormat.indexOf(name)]?.trim();
        const alignRaw = num(get('alignment'), 2);
        const style: Style = {
          font: cleanFont(get('fontname')) ?? 'Arial',
          size: clampNum(num(get('fontsize'), 20), 1, 1000),
          primary: assColor(get('primarycolour'), DEFAULT_STYLE.primary),
          outlineColor: assColor(get('outlinecolour') ?? get('tertiarycolour'), DEFAULT_STYLE.outlineColor),
          back: assColor(get('backcolour'), DEFAULT_STYLE.back),
          bold: num(get('bold'), 0) !== 0, italic: num(get('italic'), 0) !== 0,
          underline: num(get('underline'), 0) !== 0, strike: num(get('strikeout'), 0) !== 0,
          scaleX: clampNum(num(get('scalex'), 100), 1, 1000), scaleY: clampNum(num(get('scaley'), 100), 1, 1000),
          angle: num(get('angle'), 0), borderStyle: num(get('borderstyle'), 1),
          outline: clampNum(num(get('outline'), 2), 0, 50), shadow: clampNum(num(get('shadow'), 2), 0, 50),
          align: clampNum(Math.round(legacy ? legacyAlign(alignRaw) : alignRaw), 1, 9),
          marginL: num(get('marginl'), 10), marginR: num(get('marginr'), 10), marginV: num(get('marginv'), 10),
        };
        styles.set((get('name') ?? 'Default').replace(/^\*/, ''), style);
      }
    } else if (section === 'events') {
      if (key === 'format') eventFormat = value.split(',').map((s) => s.trim().toLowerCase());
      else if (key === 'dialogue' && eventFormat.length && cues.length < MAX_CUES) {
        const f = splitFields(value, eventFormat.length);
        const get = (name: string) => f[eventFormat.indexOf(name)];
        const start = parseTime(get('start') ?? '');
        const end = parseTime(get('end') ?? '');
        if (start === null || end === null || end <= start) continue;
        const style = styles.get((get('style') ?? '').trim().replace(/^\*/, '')) ?? styles.get('Default') ?? DEFAULT_STYLE;
        const cue = parseText(get('text') ?? '', style, styles, wrapStyle, legacy);
        if (!cue) continue;
        const ml = num(get('marginl'), 0);
        const mr = num(get('marginr'), 0);
        const mv = num(get('marginv'), 0);
        cues.push({
          ...cue, start, end, layer: num(get('layer'), 0), order: cues.length,
          margins: { l: ml || style.marginL, r: mr || style.marginR, v: mv || style.marginV },
        });
      }
    }
  }
  // Missing resolution: ASS defaults (and libass) assume 4:3 when only one side is given.
  if (!playResX && !playResY) { playResX = 384; playResY = 288; }
  else if (!playResY) playResY = playResX === 1280 ? 1024 : (playResX * 3) / 4;
  else if (!playResX) playResX = playResY === 1024 ? 1280 : (playResY * 4) / 3;
  cues.sort((a, b) => a.start - b.start || a.order - b.order);
  return { playResX, playResY, cues };
}

type CueBody = Omit<AssCue, 'start' | 'end' | 'layer' | 'order' | 'margins'>;

function runFromStyle(s: Style): AssRun {
  return {
    text: '', bold: s.bold, italic: s.italic, underline: s.underline, strike: s.strike, color: s.primary,
    outlineColor: s.outlineColor, shadowColor: s.back, size: s.size, outline: s.outline, shadow: s.shadow, blur: 0,
    font: s.font, scaleX: s.scaleX, scaleY: s.scaleY,
  };
}

const TAG_RE = /\\(\d?[a-z]+)(\([^)]*\)|[^\\]*)/gi;

function parseText(raw: string, style: Style, styles: Map<string, Style>, wrapStyle: number, legacy: boolean): CueBody | null {
  let run = runFromStyle(style);
  const lines: AssRun[][] = [[]];
  let align: number | null = null;
  let pos: CueBody['pos'] = null;
  let move: CueBody['move'] = null;
  let fade: CueBody['fade'] = null;
  let rotate = style.angle;
  let drawing = false;
  let i = 0;
  // \N is a hard line break; \n is soft (a break only with WrapStyle 2, otherwise a space); \h a hard space.
  let pendingSoft = false;

  const pushText = (t: string) => {
    if (!t || drawing) return;
    for (const p of t.replace(/\\h/g, ' ').split(/(\\N|\\n)/)) {
      if (p === '\\N') {
        lines.push([]);
        pendingSoft = false;
      } else if (p === '\\n') {
        if (wrapStyle === 2) lines.push([]);
        else pendingSoft = true;
      } else if (p) {
        lines[lines.length - 1]!.push({ ...run, text: (pendingSoft ? ' ' : '') + p });
        pendingSoft = false;
      }
    }
  };

  while (i < raw.length) {
    const open = raw.indexOf('{', i);
    if (open < 0) {
      pushText(raw.slice(i));
      break;
    }
    pushText(raw.slice(i, open));
    const close = raw.indexOf('}', open);
    if (close < 0) {
      pushText(raw.slice(open));
      break;
    }
    const block = raw.slice(open + 1, close);
    i = close + 1;
    if (!block.includes('\\')) continue; // a comment
    for (const m of block.matchAll(TAG_RE)) {
      const tag = m[1]!.toLowerCase();
      const arg = m[2]!.trim();
      const args = arg.startsWith('(') ? arg.slice(1, -1).split(',').map((s) => s.trim()) : [];
      switch (tag) {
        case 'b': run = { ...run, bold: arg === '' ? style.bold : num(arg, 0) === 1 || num(arg, 0) >= 600 }; break;
        case 'i': run = { ...run, italic: arg === '' ? style.italic : num(arg, 0) === 1 }; break;
        case 'u': run = { ...run, underline: arg === '' ? style.underline : num(arg, 0) === 1 }; break;
        case 's': run = { ...run, strike: arg === '' ? style.strike : num(arg, 0) === 1 }; break;
        case 'c': case '1c': run = { ...run, color: arg ? assColor(arg, run.color, alphaOf(run.color)) : style.primary }; break;
        case '3c': run = { ...run, outlineColor: arg ? assColor(arg, run.outlineColor, alphaOf(run.outlineColor)) : style.outlineColor }; break;
        case '4c': run = { ...run, shadowColor: arg ? assColor(arg, run.shadowColor, alphaOf(run.shadowColor)) : style.back }; break;
        case 'alpha': {
          const a = parseAlpha(arg);
          if (a !== null) run = { ...run, color: withAlpha(run.color, a), outlineColor: withAlpha(run.outlineColor, a), shadowColor: withAlpha(run.shadowColor, a) };
          break;
        }
        case '1a': { const a = parseAlpha(arg); if (a !== null) run = { ...run, color: withAlpha(run.color, a) }; break; }
        case '3a': { const a = parseAlpha(arg); if (a !== null) run = { ...run, outlineColor: withAlpha(run.outlineColor, a) }; break; }
        case 'fs': if (/^\d+(\.\d+)?$/.test(arg)) run = { ...run, size: clampNum(num(arg, style.size), 1, 1000) }; break;
        case 'fn': run = { ...run, font: cleanFont(arg) ?? style.font }; break;
        case 'bord': run = { ...run, outline: clampNum(num(arg, style.outline), 0, 50) }; break;
        case 'shad': run = { ...run, shadow: clampNum(num(arg, style.shadow), 0, 50) }; break;
        case 'blur': case 'be': run = { ...run, blur: clampNum(num(arg, 0), 0, 20) }; break;
        case 'fscx': run = { ...run, scaleX: clampNum(num(arg, 100), 1, 1000) }; break;
        case 'fscy': run = { ...run, scaleY: clampNum(num(arg, 100), 1, 1000) }; break;
        case 'frz': case 'fr': rotate = num(arg, rotate); break;
        case 'an': if (align === null) { const a = Math.round(num(arg, 0)); if (a >= 1 && a <= 9) align = a; } break;
        case 'a': if (align === null) { const a = Math.round(num(arg, 0)); if (a > 0) align = clampNum(legacyAlign(a), 1, 9); } break;
        case 'pos':
          if (!pos && !move && args.length === 2) pos = { x: num(args[0], 0), y: num(args[1], 0) };
          break;
        case 'move':
          if (!pos && !move && (args.length === 4 || args.length === 6)) {
            move = { x1: num(args[0], 0), y1: num(args[1], 0), x2: num(args[2], 0), y2: num(args[3], 0), t1: num(args[4], 0), t2: num(args[5], 0) };
          }
          break;
        case 'fad': if (args.length === 2) fade = { in: Math.max(0, num(args[0], 0)), out: Math.max(0, num(args[1], 0)) }; break;
        case 'fade':
          if (args.length === 7) fade = { in: Math.max(0, num(args[4], 0) - num(args[3], 0)), out: Math.max(0, num(args[6], 0) - num(args[5], 0)) };
          break;
        case 'p': drawing = num(arg, 0) > 0; break;
        case 'r': {
          const named = arg ? styles.get(arg) : undefined;
          run = runFromStyle(named ?? style);
          break;
        }
        default: break; // \k, \clip, \org, \q, \fax… are not drawn
      }
    }
  }
  const kept = lines.map((l) => l.filter((r) => r.text.length > 0)).filter((l, idx, all) => l.length > 0 || (idx > 0 && idx < all.length - 1));
  if (!kept.some((l) => l.some((r) => r.text.trim()))) return null;
  return {
    lines: kept, align: align ?? style.align, pos, move, fade, rotate,
    box: style.borderStyle === 3 ? style.outlineColor : null,
  };
  void legacy;
}

function alphaOf(rgba: string): number {
  const m = /,([\d.]+)\)$/.exec(rgba);
  return m ? Math.round(255 - Number(m[1]) * 255) : 0;
}

/** Cues active at time t, drawn bottom layer first. */
export function activeAssCues(cues: AssCue[], t: number): AssCue[] {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: AssCue[] = [];
  // Long cues can start well before shorter ones; scan back a bounded distance.
  for (let k = lo - 1; k >= 0 && k >= lo - 400; k--) if (cues[k]!.end > t) out.push(cues[k]!);
  return out.sort((a, b) => a.layer - b.layer || a.order - b.order);
}
