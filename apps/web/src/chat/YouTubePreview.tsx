import { useEffect, useState } from 'react';
import { Check, ExternalLink, Play } from 'lucide-react';
import { formatTime, youtubeThumbnail, youtubeWatchUrl, type LinkPreview } from '@watchroom/protocol';
import { Spinner } from '../components/misc';
import { YouTubeIcon } from '../components/YouTubeIcon';
import type { RoomConnection } from '../lib/connection';
import { toast, useRoom } from '../state/room';
import s from './YouTubePreview.module.css';

/**
 * A YouTube link posted in the chat: its picture, title and channel, and a button to watch it together (for the host,
 * and for everyone when the host lets everyone control playback).
 */
export function YouTubePreview({ preview, conn, compact = false }: { preview: LinkPreview; conn: RoomConnection; compact?: boolean }) {
  const media = useRoom((st) => st.media);
  const isHost = useRoom((st) => st.me?.role === 'host');
  const everyone = useRoom((st) => st.settings?.controlMode !== 'host');
  const busyPlaying = useRoom((st) => st.playback?.status === 'playing');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [thumbOk, setThumbOk] = useState(true);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  const playingNow = media?.kind === 'youtube' && media.videoId === preview.videoId;
  const canOpen = isHost || everyone;
  const unavailable = preview.status === 'unavailable';
  const watchUrl = youtubeWatchUrl(preview.videoId, preview.startAt);

  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    // Something else is playing right now: ask once more before switching everyone over.
    if (media && !playingNow && busyPlaying && !confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setBusy(true);
    const r = await conn.openYouTube(watchUrl);
    setBusy(false);
    if (!r.ok) toast('error', r.error ?? 'Couldn\'t open this video.');
  };

  if (unavailable) {
    return (
      <div className={`${s.card} ${s.unavailable} ${compact ? s.compact : ''}`} onClick={(e) => e.stopPropagation()}>
        <YouTubeIcon size={16} />
        <span>Can't be watched here: the video is private, removed, or its owner allows it only on YouTube.</span>
      </div>
    );
  }

  const title = preview.title ?? (preview.status === 'pending' ? null : 'YouTube video');
  return (
    <div className={`${s.card} ${compact ? s.compact : ''}`} onClick={(e) => e.stopPropagation()}>
      <button
        className={s.thumb}
        onClick={canOpen && !playingNow ? open : (e) => { e.stopPropagation(); window.open(watchUrl, '_blank', 'noopener,noreferrer'); }}
        aria-label={canOpen && !playingNow ? `Watch ${title ?? 'this video'} together` : `Open ${title ?? 'this video'} on YouTube`}
        tabIndex={-1}
      >
        {thumbOk && <img src={youtubeThumbnail(preview.videoId)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setThumbOk(false)} />}
        <span className={s.playMark}><Play size={compact ? 13 : 18} fill="currentColor" /></span>
        {preview.startAt > 0 && <span className={s.startAt}>from {formatTime(preview.startAt)}</span>}
      </button>
      <div className={s.body}>
        {title !== null ? <div className={s.title} title={title}>{title}</div> : <div className={s.skeleton} aria-label="Looking up the video" />}
        <div className={s.channel}><YouTubeIcon size={13} /><span>{preview.author ?? 'YouTube'}</span></div>
        <div className={s.actions}>
          {playingNow ? (
            <span className={s.now}><Check size={13} /> Playing now</span>
          ) : canOpen ? (
            <button className={`${s.watch} ${confirm ? s.confirm : ''}`} onClick={open} disabled={busy}>
              {busy ? <Spinner size={12} /> : <Play size={12} fill="currentColor" />}
              {busy ? 'Opening…' : confirm ? 'Switch for everyone?' : 'Watch together'}
            </button>
          ) : (
            <span className={s.hint}>The host can play it for everyone</span>
          )}
          {!compact && (
            <a className={s.external} href={watchUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open on YouTube" aria-label="Open on YouTube">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
