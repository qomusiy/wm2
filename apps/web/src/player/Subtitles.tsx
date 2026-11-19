import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { activeCues, parseVtt, type Cue } from './vtt';
import s from './Player.module.css';

export type SubSize = 's' | 'm' | 'l';
export type SubBackground = 'shadow' | 'box';

function renderInline(text: string): ReactNode[] {
  // Only <i>, <b>, <u> survive parsing; turn them into elements without ever using innerHTML.
  const out: ReactNode[] = [];
  const stack: string[] = [];
  let key = 0;
  for (const part of text.split(/(<\/?[ibu]>)/)) {
    const tag = /^<(\/?)([ibu])>$/.exec(part);
    if (tag) {
      if (tag[1]) stack.splice(stack.lastIndexOf(tag[2]!), 1);
      else stack.push(tag[2]!);
      continue;
    }
    if (!part) continue;
    let node: ReactNode = part;
    for (const t of [...stack].reverse()) node = t === 'i' ? <i key={key++}>{node}</i> : t === 'b' ? <b key={key++}>{node}</b> : <u key={key++}>{node}</u>;
    out.push(<Fragment key={key++}>{node}</Fragment>);
  }
  return out;
}

export function useCues(url: string | null): Cue[] | null {
  const [cues, setCues] = useState<Cue[] | null>(null);
  useEffect(() => {
    setCues(null);
    if (!url) return;
    let cancelled = false;
    void fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (!cancelled) setCues(parseVtt(t)); })
      .catch(() => { if (!cancelled) setCues([]); });
    return () => { cancelled = true; };
  }, [url]);
  return cues;
}

export function SubtitleOverlay({ video, cues, size, background, raised }: {
  video: HTMLVideoElement | null; cues: Cue[]; size: SubSize; background: SubBackground; raised: boolean;
}) {
  const [active, setActive] = useState<Cue[]>([]);
  const last = useRef<Cue[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (video) {
        const now = activeCues(cues, video.currentTime);
        if (now.length !== last.current.length || now.some((c, i) => c !== last.current[i])) {
          last.current = now;
          setActive(now);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, cues]);
  if (active.length === 0) return null;
  return (
    <div className={`${s.subs} ${s[`subs_${size}`]} ${raised ? s.subsRaised : ''}`} aria-live="off">
      {active.map((c, i) => (
        <div key={`${c.start}-${i}`} className={`${s.subLine} ${background === 'box' ? s.subBox : s.subShadow}`}>
          {c.text.split('\n').map((line, j) => <span key={j} className={s.subRow}>{renderInline(line)}</span>)}
        </div>
      ))}
    </div>
  );
}
