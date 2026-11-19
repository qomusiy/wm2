import { useState } from 'react';
import { Check, Pencil, UserX } from 'lucide-react';
import { LIMITS } from '@watchroom/protocol';
import { local } from '../lib/storage';
import type { ParticipantInfo } from '@watchroom/protocol';
import { IconButton } from '../components/Button';
import { Avatar } from '../components/misc';
import type { RoomConnection } from '../lib/connection';
import { useRoom } from '../state/room';
import s from './Chat.module.css';

const STATUS: Record<ParticipantInfo['player'], { label: string; color: string }> = {
  loading: { label: 'Loading', color: 'var(--text-3)' },
  ready: { label: 'Ready', color: 'var(--success)' },
  playing: { label: 'Watching', color: 'var(--success)' },
  paused: { label: 'Paused', color: 'var(--text-2)' },
  buffering: { label: 'Buffering', color: 'var(--warning)' },
  blocked: { label: 'Needs a tap to play', color: 'var(--warning)' },
};

export function PeopleList({ conn }: { conn: RoomConnection }) {
  const participants = useRoom((st) => st.participants);
  const me = useRoom((st) => st.me);
  const media = useRoom((st) => st.media);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const rename = () => {
    const name = draft.trim();
    setEditing(false);
    if (!name) return;
    conn.send({ type: 'rename', name });
    local.set(me?.role === 'host' ? 'wr:hostname' : 'wr:name', name);
  };
  const sorted = [...participants].sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : a.joinedAt - b.joinedAt));
  return (
    <div className={s.people}>
      <div className={s.sectionTitle}>In the room · {participants.filter((p) => p.connected).length}</div>
      {sorted.map((p) => {
        const st = !p.connected ? { label: 'Reconnecting…', color: 'var(--warning)' } : !media ? { label: 'Waiting for a video', color: 'var(--text-3)' } : STATUS[p.player];
        return (
          <div key={p.id} className={`${s.person} ${p.connected ? '' : s.offline}`}>
            <Avatar name={p.name} color={p.color} size={30} />
            <div className={s.personMain}>
              {editing && p.id === me?.id ? (
                <form className={s.renameForm} onSubmit={(e) => { e.preventDefault(); rename(); }}>
                  <input className={s.renameInput} autoFocus value={draft} maxLength={LIMITS.nameMax} aria-label="Your name"
                    onChange={(e) => setDraft(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} />
                  <button type="submit" className={s.renameOk} aria-label="Save name"><Check size={14} /></button>
                </form>
              ) : (
                <div className={s.personName}>
                  <span>{p.name}</span>
                  {p.id === me?.id && <span className={s.you}>you</span>}
                  {p.role === 'host' && <span className={s.badge}>Host</span>}
                  {p.id === me?.id && (
                    <button className={s.editName} aria-label="Change your name" title="Change your name" onClick={() => { setDraft(p.name); setEditing(true); }}>
                      <Pencil size={12} />
                    </button>
                  )}
                </div>
              )}
              <div className={s.personSub}>
                <span className={s.dot} style={{ background: st.color }} />
                <span>{st.label}</span>
                {p.connected && media && p.quality && <span>· {p.quality}</span>}
                {p.connected && p.rtt !== null && <span>· {p.rtt} ms</span>}
              </div>
            </div>
            {me?.role === 'host' && p.role !== 'host' && (
              <IconButton
                className={s.kick} label={`Remove ${p.name}`} size="sm"
                onClick={() => {
                  if (window.confirm(`Remove ${p.name} from the room? They won't be able to rejoin with this link.`)) {
                    conn.send({ type: 'kick', participantId: p.id });
                  }
                }}
              >
                <UserX size={15} />
              </IconButton>
            )}
          </div>
        );
      })}
    </div>
  );
}
