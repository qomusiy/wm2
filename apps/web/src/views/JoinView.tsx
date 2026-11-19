import { useEffect, useState } from 'react';
import { AlertCircle, Clock, Play, Lock, User } from 'lucide-react';
import { LIMITS, type RoomPreview } from '@watchroom/protocol';
import { Button } from '../components/Button';
import { Avatar, Spinner } from '../components/misc';
import { isTouch } from '../lib/device';
import { formatTime } from '../lib/format';
import { local } from '../lib/storage';
import s from './Screens.module.css';

interface Props {
  roomId: string;
  roomKey: string;
  busy: boolean;
  error: string | null;
  needPassword: boolean;
  onJoin(name: string, password?: string): void;
}

export function JoinView({ roomId, roomKey, busy, error, needPassword, onJoin }: Props) {
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [name, setName] = useState(() => local.get('wr:name', ''));
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/preview`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: roomKey }),
        });
        if (cancelled) return;
        if (res.status === 404) setPreviewError('This room has ended or the link is wrong.');
        else if (res.status === 403) setPreviewError('This invite link is no longer valid. Ask the host for a new one.');
        else if (res.status === 429) setPreviewError('Too many attempts. Wait a minute and reload.');
        else if (!res.ok) setPreviewError('The host could not be reached.');
        else setPreview(await res.json() as RoomPreview);
      } catch {
        if (!cancelled) setPreviewError('The host could not be reached. Their computer may be off or offline.');
      }
    };
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [roomId, roomKey]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    local.set('wr:name', n);
    onJoin(n, needPassword || preview?.passwordRequired ? password : undefined);
  };

  const others = preview?.participants ?? [];
  const showPassword = needPassword || preview?.passwordRequired;
  return (
    <div className={s.screen}>
      <div className={s.card}>
        <div className={s.brand}><span className={s.logo}><Play size={13} fill="currentColor" /></span> Watchroom</div>
        {previewError ? (
          <div className={s.center}>
            <div className={s.bigIcon}><AlertCircle size={24} /></div>
            <div className={s.title}>Can't open this room</div>
            <div className={s.text}>{previewError}</div>
          </div>
        ) : !preview ? (
          <div className={s.center}><Spinner size={22} /></div>
        ) : (
          <>
            <div className={s.eyebrow}>You're invited to watch</div>
            <div className={s.title}>{preview.title ?? 'A movie night'}</div>
            <div className={s.meta}>
              {preview.duration ? <span><Clock size={13} /> {formatTime(preview.duration)}</span> : <span>The host is picking a video</span>}
              {preview.hostName && <span><User size={13} /> Hosted by {preview.hostName}</span>}
            </div>
            {others.length > 0 && (
              <div className={s.people}>
                <div className={s.stack}>{others.slice(0, 5).map((p, i) => <Avatar key={i} name={p.name} color={p.color} size={24} />)}</div>
                <span>{others.length === 1 ? `${others[0]!.name} is here` : `${others[0]!.name} and ${others.length - 1} more are here`}</span>
              </div>
            )}
            <form className={s.form} onSubmit={submit}>
              <label className={s.label}>
                Your name
                <input
                  className={s.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.nameMax}
                  placeholder="How friends will see you" autoFocus={!isTouch()} autoComplete="nickname" enterKeyHint="go"
                />
              </label>
              {showPassword && (
                <label className={s.label}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Lock size={12} /> Room password</span>
                  <input className={s.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </label>
              )}
              {error && <div className={s.error}><AlertCircle size={15} /> {error}</div>}
              {preview.locked && <div className={s.error}><Lock size={15} /> The host has locked this room.</div>}
              {preview.full && <div className={s.error}><AlertCircle size={15} /> This room is full.</div>}
              <Button type="submit" variant="primary" size="lg" block disabled={!name.trim() || busy || preview.locked || preview.full}>
                {busy ? <Spinner size={16} /> : 'Join'}
              </Button>
            </form>
            <div className={s.foot}>The video streams from the host's computer. Nothing to install.</div>
          </>
        )}
      </div>
    </div>
  );
}
