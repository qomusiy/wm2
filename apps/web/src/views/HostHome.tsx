import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Play } from 'lucide-react';
import { LIMITS, parseYouTubeUrl, type HostStatus, type RecentVideo } from '@watchroom/protocol';
import { Button } from '../components/Button';
import { Spinner } from '../components/misc';
import type { OpenResult } from '../lib/connection';
import { RecentVideos, type RecentActions } from './RecentVideos';
import { YouTubeLinkForm } from './YouTubeLinkForm';
import s from './Screens.module.css';

interface Props {
  status: HostStatus | null;
  canOpen: boolean;
  dragging: boolean;
  onOpen(): void;
  name: string;
  onRename(name: string): void;
  recent: RecentVideo[];
  recentActions: RecentActions;
  /** Play a YouTube video in the room (available once the host is connected to it). */
  onOpenYouTube?(url: string): Promise<OpenResult>;
}

export function HostHome({ status, canOpen, dragging, onOpen, name, onRename, recent, recentActions, onOpenYouTube }: Props) {
  const [draft, setDraft] = useState(name);
  const [ytLink, setYtLink] = useState('');
  const ytInput = useRef<HTMLInputElement>(null);
  // Pasting a YouTube link anywhere on this screen puts it in the YouTube box.
  useEffect(() => {
    if (!onOpenYouTube) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = e.clipboardData?.getData('text')?.trim() ?? '';
      if (!parseYouTubeUrl(text)) return;
      e.preventDefault();
      setYtLink(text);
      ytInput.current?.focus();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onOpenYouTube]);
  const ff = status?.system.ffmpeg;
  const link = status?.link;
  const loading = status?.media.loading;
  const linkState = !link ? null : link.mode !== 'tunnel' ? { cls: s.ok, text: link.mode === 'lan' ? 'Local network' : link.mode === 'custom' ? 'Custom address' : 'This computer' }
    : link.tunnel.state === 'online' ? { cls: s.ok, text: 'Internet link ready' }
      : link.tunnel.state === 'error' ? { cls: s.bad, text: 'Link unavailable' }
        : { cls: s.warn, text: link.tunnel.detail ?? 'Starting…' };
  return (
    <div className={s.home}>
      <div className={s.homeInner}>
        <div className={s.hero}>
          <div className={s.brand}><span className={s.logo}><Play size={13} fill="currentColor" /></span> Watchroom</div>
          <h1>Watch together, in sync.</h1>
          <p>Pick a video on this computer, or paste a YouTube link. Friends join from their browser with a link and watch with you, wherever they are.</p>
          <Button variant="primary" size="lg" icon={<FolderOpen size={17} />} onClick={onOpen} disabled={!canOpen || loading || ff?.ok === false}>
            Open video…
          </Button>
          {onOpenYouTube && (
            <div className={s.ytBlock}>
              <div className={s.or}><span>or watch from YouTube</span></div>
              <YouTubeLinkForm ref={ytInput} onOpen={onOpenYouTube} value={ytLink} onValueChange={setYtLink} />
            </div>
          )}
          {loading && <div className={s.loading}><Spinner size={15} /> Preparing {status?.media.fileName ?? 'video'}…</div>}
          {status?.media.error && <div className={s.error} style={{ marginTop: 14 }}>{status.media.error}</div>}
          {!canOpen && <div className={s.loading}>Running in a browser: open a video file from the command line with <code>--video</code>.</div>}
          {canOpen && (
            <div className={`${s.drop} ${dragging ? s.dropActive : ''}`}>
              <FolderOpen size={20} />
              <span>{dragging ? 'Drop to open' : 'or drop a video file anywhere in this window'}</span>
              <span style={{ fontSize: 12 }}>MKV, MP4, AVI, MOV, WebM, TS and more</span>
            </div>
          )}
          {recent.length === 0 && <div className={s.steps}>
            <div className={s.step}><span className={s.stepNum}>1</span><span><strong>Open a video</strong>It stays on your computer; friends get a stream.</span></div>
            <div className={s.step}><span className={s.stepNum}>2</span><span><strong>Send the invite link</strong>It works from anywhere, phones included.</span></div>
            <div className={s.step}><span className={s.stepNum}>3</span><span><strong>Press play</strong>Everyone can play, pause and seek; each picks their own quality.</span></div>
          </div>}
        </div>
        <div className={s.side}>
          <div className={s.panel}>
            <div className={s.panelHead}>You</div>
            <div className={s.panelBody}>
              <form className={s.nameRow} onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onRename(draft.trim()); }}>
                <input className={s.input} style={{ flex: 1, height: 34, fontSize: 13 }} value={draft} maxLength={LIMITS.nameMax} onChange={(e) => setDraft(e.target.value)} aria-label="Your display name" />
                <Button type="submit" size="sm" disabled={!draft.trim() || draft.trim() === name}>Save</Button>
              </form>
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>This is the name friends see in chat.</span>
            </div>
          </div>
          <div className={s.panel}>
            <div className={s.panelHead}>Status</div>
            <div className={s.panelBody}>
              <div className={s.kv}><span>Sharing link</span><span>{linkState ? <><span className={`${s.dot} ${linkState.cls}`} />{linkState.text}</> : <Spinner size={12} />}</span></div>
              <div className={s.kv}><span>Video engine</span><span>{ff === null || ff === undefined ? <Spinner size={12} /> : ff.ok ? <><span className={`${s.dot} ${s.ok}`} />ffmpeg {ff.version.split('-')[0]}</> : <><span className={`${s.dot} ${s.bad}`} />Missing</>}</span></div>
              <div className={s.kv}><span>Encoder</span><span>{status?.system.encoder ?? '…'}</span></div>
              {status?.system.sandbox && status.system.sandbox.state !== 'unsupported' && (
                <div className={s.kv} title={status.system.sandbox.detail}>
                  <span>Isolation</span>
                  <span>{status.system.sandbox.state === 'on'
                    ? <><span className={`${s.dot} ${s.ok}`} />Video tools sandboxed</>
                    : <><span className={`${s.dot} ${s.warn}`} />Not sandboxed</>}</span>
                </div>
              )}
              {ff && !ff.ok && <div className={s.error}>{ff.error}</div>}
            </div>
          </div>
        </div>
        <RecentVideos items={recent} actions={recentActions} busy={Boolean(loading) || ff?.ok === false} />
      </div>
    </div>
  );
}
