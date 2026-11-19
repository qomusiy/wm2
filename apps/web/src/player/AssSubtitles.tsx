import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { activeAssCues, parseAss, type AssCue, type AssRun, type AssScript } from './ass';
import type { SubBackground, SubSize } from './Subtitles';
import s from './Player.module.css';

export function useAss(url: string | null): AssScript | null {
  const [script, setScript] = useState<AssScript | null>(null);
  useEffect(() => {
    setScript(null);
    if (!url) return;
    let cancelled = false;
    void fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (!cancelled) setScript(parseAss(t)); })
      .catch(() => { if (!cancelled) setScript({ playResX: 0, playResY: 0, cues: [] }); });
    return () => { cancelled = true; };
  }, [url]);
  return script;
}

const SIZE_FACTOR: Record<SubSize, number> = { s: 0.8, m: 1, l: 1.25 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the picture actually is inside the player (object-fit: contain leaves bars). */
function contentRect(box: { w: number; h: number }, video: HTMLVideoElement | null): { x: number; y: number; w: number; h: number } {
  const vw = video?.videoWidth || 16;
  const vh = video?.videoHeight || 9;
  const scale = Math.min(box.w / vw, box.h / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

function outlineShadow(width: number, color: string): string[] {
  if (width <= 0) return [];
  const steps = width > 1.5 ? 16 : 8;
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(`${(Math.cos(a) * width).toFixed(2)}px ${(Math.sin(a) * width).toFixed(2)}px 0 ${color}`);
  }
  return out;
}

function runStyle(r: AssRun, k: number, sizeFactor: number): CSSProperties {
  const shadows = [
    ...outlineShadow(r.outline * k, r.outlineColor),
    ...(r.shadow > 0 ? [`${(r.shadow * k).toFixed(2)}px ${(r.shadow * k).toFixed(2)}px ${(r.blur * k).toFixed(1)}px ${r.shadowColor}`] : []),
  ];
  const scaled = r.scaleX !== 100 || r.scaleY !== 100;
  return {
    color: r.color,
    fontSize: `${Math.max(6, r.size * k * sizeFactor).toFixed(2)}px`,
    fontFamily: r.font ? `"${r.font}", var(--font-sans, sans-serif)` : undefined,
    fontWeight: r.bold ? 700 : 500,
    fontStyle: r.italic ? 'italic' : 'normal',
    textDecoration: [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ') || undefined,
    textShadow: shadows.length ? shadows.join(',') : undefined,
    ...(scaled ? { display: 'inline-block', transform: `scale(${r.scaleX / 100}, ${r.scaleY / 100})` } : {}),
  };
}

function opacityAt(c: AssCue, t: number): number {
  if (!c.fade) return 1;
  const sinceStart = (t - c.start) * 1000;
  const untilEnd = (c.end - t) * 1000;
  let o = 1;
  if (c.fade.in > 0 && sinceStart < c.fade.in) o = Math.min(o, sinceStart / c.fade.in);
  if (c.fade.out > 0 && untilEnd < c.fade.out) o = Math.min(o, untilEnd / c.fade.out);
  return clamp(o, 0, 1);
}

function positionAt(c: AssCue, t: number): { x: number; y: number } | null {
  if (c.pos) return c.pos;
  if (!c.move) return null;
  const m = c.move;
  const elapsed = (t - c.start) * 1000;
  const [t1, t2] = m.t1 === 0 && m.t2 === 0 ? [0, (c.end - c.start) * 1000] : [m.t1, m.t2];
  const p = t2 > t1 ? clamp((elapsed - t1) / (t2 - t1), 0, 1) : 1;
  return { x: m.x1 + (m.x2 - m.x1) * p, y: m.y1 + (m.y2 - m.y1) * p };
}

/** Does this cue change between frames right now (moving, or fading)? */
function animating(c: AssCue, t: number): boolean {
  if (c.move) return true;
  if (!c.fade) return false;
  return (t - c.start) * 1000 < c.fade.in || (c.end - t) * 1000 < c.fade.out;
}

const H_ALIGN = ['left', 'center', 'right'] as const;

/** ASS/SSA subtitles with their styles and positions, drawn over the picture (works the same in full screen). */
export function StyledSubtitleOverlay({ video, script, size, background, raised }: {
  video: HTMLVideoElement | null; script: AssScript; size: SubSize; background: SubBackground; raised: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState<{ cues: AssCue[]; t: number }>({ cues: [], t: 0 });
  const last = useRef<AssCue[]>([]);
  const [, setVideoSize] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e?.contentRect.width ?? 0, h: e?.contentRect.height ?? 0 }));
    ro.observe(el);
    const onMeta = () => setVideoSize((n) => n + 1);
    video?.addEventListener('loadedmetadata', onMeta);
    video?.addEventListener('resize', onMeta);
    return () => {
      ro.disconnect();
      video?.removeEventListener('loadedmetadata', onMeta);
      video?.removeEventListener('resize', onMeta);
    };
  }, [video]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (video) {
        const t = video.currentTime;
        const now = activeAssCues(script.cues, t);
        const changed = now.length !== last.current.length || now.some((c, i) => c !== last.current[i]);
        if (changed || now.some((c) => animating(c, t))) {
          last.current = now;
          setFrame({ cues: now, t });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, script]);

  const rect = contentRect(box, video);
  const kx = rect.w / script.playResX;
  const ky = rect.h / script.playResY;
  const factor = SIZE_FACTOR[size];
  const lift = raised ? 88 : 0;

  const renderLines = (c: AssCue, sizeFactor: number, boxed: boolean) => {
    const textAlign = H_ALIGN[(c.align - 1) % 3];
    return c.lines.map((line, i) => (
      <div key={i} className={s.assLine} style={{ textAlign }}>
        {line.length === 0 ? ' ' : line.map((r, j) => (
          <span key={j} className={boxed ? s.assBoxed : undefined} style={{
            ...runStyle(r, ky, sizeFactor),
            ...(c.box ? { background: c.box, padding: `0 ${(r.outline * ky).toFixed(1)}px` } : {}),
          }}>{r.text}</span>
        ))}
      </div>
    ));
  };

  // Unpositioned cues flow into nine alignment areas (stacking like ASS collision handling); positioned ones are
  // placed exactly.
  const regions = new Map<number, AssCue[]>();
  const placed: AssCue[] = [];
  for (const c of frame.cues) {
    if (c.pos || c.move) placed.push(c);
    else regions.set(c.align, [...(regions.get(c.align) ?? []), c]);
  }

  return (
    <div ref={rootRef} className={s.assLayer} aria-live="off">
      {[...regions].map(([align, cues]) => {
        const row = Math.floor((align - 1) / 3); // 0 bottom, 1 middle, 2 top
        const col = (align - 1) % 3;
        const ref = cues[0]!;
        const style: CSSProperties = {
          left: rect.x + ref.margins.l * kx,
          width: Math.max(0, rect.w - (ref.margins.l + ref.margins.r) * kx),
          alignItems: col === 0 ? 'flex-start' : col === 1 ? 'center' : 'flex-end',
          ...(row === 0 ? { bottom: box.h - rect.y - rect.h + ref.margins.v * ky + lift, flexDirection: 'column-reverse' as const }
            : row === 2 ? { top: rect.y + ref.margins.v * ky }
              : { top: rect.y + rect.h / 2, transform: 'translateY(-50%)' }),
        };
        return (
          <div key={align} className={s.assRegion} style={style}>
            {cues.map((c) => (
              <div key={c.order} className={s.assCue} style={{ opacity: opacityAt(c, frame.t), transform: c.rotate ? `rotate(${-c.rotate}deg)` : undefined }}>
                {renderLines(c, factor, background === 'box')}
              </div>
            ))}
          </div>
        );
      })}
      {placed.map((c) => {
        const p = positionAt(c, frame.t)!;
        const col = (c.align - 1) % 3;
        const row = Math.floor((c.align - 1) / 3);
        const tx = col === 0 ? '0%' : col === 1 ? '-50%' : '-100%';
        const ty = row === 2 ? '0%' : row === 1 ? '-50%' : '-100%';
        return (
          <div key={c.order} className={s.assPlaced} style={{
            left: rect.x + p.x * kx, top: rect.y + p.y * ky, opacity: opacityAt(c, frame.t),
            transform: `translate(${tx}, ${ty})${c.rotate ? ` rotate(${-c.rotate}deg)` : ''}`,
            transformOrigin: `${col === 0 ? 'left' : col === 1 ? 'center' : 'right'} ${row === 2 ? 'top' : row === 1 ? 'center' : 'bottom'}`,
          }}>
            {renderLines(c, 1, false)}
          </div>
        );
      })}
    </div>
  );
}
