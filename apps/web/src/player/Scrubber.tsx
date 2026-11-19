import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThumbnailInfo } from '@watchroom/protocol';
import { formatTime } from '../lib/format';
import s from './Player.module.css';

interface Props {
  current: number;
  duration: number;
  buffered: [number, number][];
  onSeek(t: number): void;
  onScrubChange?(scrubbing: boolean): void;
  thumbnails?: ThumbnailInfo | null;
  /** Viewing only (host-only control mode): previews still work, seeking does not. */
  disabled?: boolean;
  onBlocked?(): void;
}

function thumbStyle(t: ThumbnailInfo, time: number, left: number): React.CSSProperties {
  const i = Math.min(t.count - 1, Math.max(0, Math.floor(time / t.interval)));
  const perSheet = t.columns * t.rows;
  const sheet = t.sheets[Math.floor(i / perSheet)];
  const k = i % perSheet;
  return {
    left, width: t.width, height: t.height,
    backgroundImage: sheet ? `url("${sheet}")` : undefined,
    backgroundPosition: `-${(k % t.columns) * t.width}px -${Math.floor(k / t.columns) * t.height}px`,
    backgroundSize: `${t.width * t.columns}px ${t.height * t.rows}px`,
    marginLeft: -t.width / 2,
  };
}

export function Scrubber({ current, duration, buffered, onSeek, onScrubChange, thumbnails, disabled, onBlocked }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const timeAt = useCallback((clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  }, [duration]);

  useEffect(() => onScrubChange?.(drag !== null), [drag !== null, onScrubChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const pct = (t: number) => `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`;
  const shown = drag ?? current;
  return (
    <div
      ref={ref}
      className={`${s.scrubber} ${drag !== null ? s.scrubbing : ''} ${disabled ? s.lockedScrub : ''}`}
      aria-disabled={disabled || undefined}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (disabled) {
          onBlocked?.();
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        const t = timeAt(e.clientX);
        setHover(t);
        if (drag !== null) setDrag(t);
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const t = timeAt(e.clientX);
        setDrag(null);
        onSeek(t);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.min(duration, Math.max(0, current + (e.key === 'ArrowLeft' ? -5 : 5))));
        }
      }}
    >
      <div className={s.track}>
        {buffered.map(([a, b], i) => (
          <div key={i} className={s.bufferedRange} style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />
        ))}
        {hover !== null && drag === null && <div className={s.hoverFill} style={{ width: pct(hover) }} />}
        <div className={s.played} style={{ width: pct(shown) }} />
      </div>
      <div className={s.thumb} style={{ left: pct(shown) }} />
      {(hover !== null || drag !== null) && (() => {
        const t = drag ?? hover ?? 0;
        const width = ref.current?.clientWidth ?? 0;
        const x = duration > 0 ? (t / duration) * width : 0;
        const tw = thumbnails?.width ?? 0;
        const left = thumbnails ? Math.min(Math.max(x, tw / 2), Math.max(tw / 2, width - tw / 2)) : x;
        return (
          <>
            {thumbnails && <div className={s.thumbTip} style={thumbStyle(thumbnails, t, left)} />}
            <div className={s.timeTip} style={{ left }}>{formatTime(t)}</div>
          </>
        );
      })()}
    </div>
  );
}
