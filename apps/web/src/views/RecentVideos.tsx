import { Film, Play, RotateCcw, X } from 'lucide-react';
import type { RecentVideo } from '@watchroom/protocol';
import { YouTubeIcon } from '../components/YouTubeIcon';
import { formatDay, formatDuration, formatTime } from '../lib/format';
import s from './RecentVideos.module.css';

export interface RecentActions {
  open(id: string, fromStart: boolean): void;
  remove(id: string | null): void;
}

function caption(v: RecentVideo): string {
  if (v.missing) return 'File moved or deleted';
  if (v.position > 0) return v.duration > 0 ? `${formatTime(v.position)} of ${formatTime(v.duration)}` : `from ${formatTime(v.position)}`;
  if (v.finished) return `Watched · ${formatDuration(v.duration)}`;
  if (v.kind === 'youtube') return [v.folder, formatDuration(v.duration)].filter(Boolean).join(' · ') || 'YouTube';
  return formatDuration(v.duration);
}

/** Hover text: where the file is, or which channel the YouTube video is from. */
function origin(v: RecentVideo): string {
  if (v.kind === 'youtube') return v.folder ? `${v.title} · ${v.folder} on YouTube` : `${v.title} on YouTube`;
  return `${v.folder}${v.folder.includes('\\') ? '\\' : '/'}${v.fileName}`;
}

/** "Continue watching": posters, where you stopped, one click to pick up again. */
export function RecentVideos({ items, actions, busy }: { items: RecentVideo[]; actions: RecentActions; busy: boolean }) {
  if (!items.length) return null;
  return (
    <section className={s.recent} aria-label="Recent videos">
      <div className={s.head}>
        <h2>Continue watching</h2>
        <button className={s.clear} onClick={() => actions.remove(null)}>Clear list</button>
      </div>
      <div className={s.grid}>
        {items.map((v) => (
          <div key={v.id} className={`${s.card} ${v.missing ? s.missing : ''}`}>
            <button
              className={s.poster}
              disabled={v.missing || busy}
              onClick={() => actions.open(v.id, false)}
              aria-label={v.position > 0 ? `Continue ${v.title} from ${formatTime(v.position)}` : `Play ${v.title}`}
              title={origin(v)}
            >
              {v.poster ? <img src={v.poster} alt="" draggable={false} /> : <span className={s.placeholder}><Film size={26} /></span>}
              {!v.missing && <span className={s.playIcon}><Play size={20} fill="currentColor" /></span>}
              {v.current && <span className={s.tag}>Open now</span>}
              {v.kind === 'youtube' && <span className={s.source}><YouTubeIcon size={18} /></span>}
              {v.finished && !v.position && !v.missing && <span className={`${s.tag} ${s.tagDone}`}>Watched</span>}
              {v.position > 0 && v.duration > 0 && (
                <span className={s.progress}><span style={{ width: `${Math.min(100, (v.position / v.duration) * 100)}%` }} /></span>
              )}
            </button>
            <div className={s.meta}>
              <div className={s.title} title={v.title}>{v.title}</div>
              <div className={s.sub}>
                <span>{caption(v)}</span>
                <span className={s.day}>{formatDay(v.lastOpened)}</span>
              </div>
            </div>
            <div className={s.tools}>
              {v.position > 0 && !v.missing && (
                <button className={s.tool} onClick={() => actions.open(v.id, true)} disabled={busy} aria-label={`Start ${v.title} from the beginning`} title="Start from the beginning">
                  <RotateCcw size={14} />
                </button>
              )}
              <button className={s.tool} onClick={() => actions.remove(v.id)} aria-label={`Remove ${v.title} from the list`} title="Remove from list">
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
