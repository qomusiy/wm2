import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeAssCues, assColor, parseAss } from './ass';

const fixture = readFileSync(join(__dirname, '../../../../packages/server/test/fixtures/signs.ass'), 'utf8');

describe('ASS parser', () => {
  it('reads resolution, styles, positions and inline styling from a real script', () => {
    const s = parseAss(fixture);
    expect([s.playResX, s.playResY]).toEqual([1280, 720]);
    const at = activeAssCues(s.cues, 5);
    const texts = at.map((c) => c.lines.map((l) => l.map((r) => r.text).join('')).join(' / '));
    expect(texts).toEqual(['Styled dialogue line / second row', 'Red corner note', 'ROAD SIGN']); // layer 1 last
    const dialogue = at[0]!;
    expect(dialogue.align).toBe(2);
    expect(dialogue.lines[0]!.map((r) => [r.text, r.italic])).toEqual([['Styled ', false], ['dialogue', true], [' line', false]]);
    expect(dialogue.lines[0]![0]!.size).toBe(48);
    const sign = at[2]!;
    expect(sign.pos).toEqual({ x: 640, y: 100 });
    expect(sign.align).toBe(8);
    expect(sign.lines[0]![0]).toMatchObject({ bold: true, color: 'rgba(255,255,0,1)', size: 36 });
    const corner = at[1]!;
    expect(corner.align).toBe(1);
    expect(corner.lines[0]![0]!.color).toBe('rgba(255,0,0,1)');
  });

  it('drops drawings and comments, shows karaoke as plain text, and keeps fades', () => {
    const s = parseAss(fixture);
    expect(s.cues.some((c) => c.lines.flat().some((r) => /m 0 0|comment/.test(r.text)))).toBe(false);
    expect(activeAssCues(s.cues, 42)[0]!.lines[0]!.map((r) => r.text).join('')).toBe('Karaoke');
    expect(activeAssCues(s.cues, 52)[0]!.fade).toEqual({ in: 300, out: 300 });
  });

  it('converts colours, including transparency and decimal SSA colours', () => {
    expect(assColor('&H00FFFFFF', 'x')).toBe('rgba(255,255,255,1)');
    expect(assColor('&H800000FF&', 'x')).toBe('rgba(255,0,0,0.498)');
    expect(assColor('&HFF00FF', 'x')).toBe('rgba(255,0,255,1)');
    expect(assColor('65535', 'x')).toBe('rgba(255,255,0,1)');
    expect(assColor('javascript:alert(1)', 'fallback')).toBe('fallback');
  });

  it('handles SSA v4 scripts, missing resolution, moves, soft breaks and malformed lines', () => {
    const ssa = [
      '[Script Info]', 'ScriptType: v4.00', '',
      '[V4 Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding',
      'Style: Default,Arial,24,16777215,0,0,0,0,0,1,2,2,6,10,10,10,0,0', '',
      '[Events]', 'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: Marked=0,0:00:01.00,0:00:05.00,Default,,0000,0000,0000,,Top {\\move(10,20,110,220)}moving\\nline',
      'Dialogue: broken line without fields',
      'Dialogue: Marked=0,0:00:09.00,0:00:02.00,Default,,0,0,0,,ends before it starts',
    ].join('\n');
    const s = parseAss(ssa);
    expect([s.playResX, s.playResY]).toEqual([384, 288]);
    expect(s.cues).toHaveLength(1);
    const c = s.cues[0]!;
    expect(c.align).toBe(8); // SSA 6 = top centre
    expect(c.move).toEqual({ x1: 10, y1: 20, x2: 110, y2: 220, t1: 0, t2: 0 });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]!.map((r) => r.text).join('')).toBe('Top moving line');
  });

  it('never produces markup or unsafe font names from hostile input', () => {
    const s = parseAss([
      '[Script Info]', 'PlayResY: 720', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour',
      'Style: Default,Arial";background:url(x),40,&H00FFFFFF', '[Events]', 'Format: Layer, Start, End, Style, Text',
      'Dialogue: 0,0:00:00.00,0:00:09.00,Default,<img src=x onerror=alert(1)>{\\fnEvil;}"}x{\\c&Hzz&}',
    ].join('\n'));
    const runs = s.cues[0]!.lines.flat();
    expect(runs.map((r) => r.text).join('')).toBe('<img src=x onerror=alert(1)>"}x'); // stays text; React escapes it
    expect(runs.every((r) => !r.font || /^[\p{L}\p{N} _-]+$/u.test(r.font))).toBe(true);
    expect(runs[0]!.font).toBe('Arialbackgroundurlx');
    expect(runs.every((r) => /^rgba\(\d+,\d+,\d+,[\d.]+\)$/.test(r.color))).toBe(true);
  });
});
