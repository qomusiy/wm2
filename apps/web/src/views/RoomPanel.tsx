import { useState } from 'react';
import { Captions, KeyRound, Lock, UserX, Zap } from 'lucide-react';
import type { ParticipantInfo, RoomSettings } from '@watchroom/protocol';
import { Button, IconButton } from '../components/Button';
import { Avatar } from '../components/misc';
import type { RoomConnection } from '../lib/connection';
import { formatBitrate } from '../lib/format';
import { toast, useRoom } from '../state/room';
import type { HostControls } from './RoomView';
import s from './RoomPanel.module.css';

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className={s.spark} />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${40 - (v / max) * 36}`).join(' ');
  return (
    <svg className={s.spark} viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,42 ${pts} 100,42`} fill="rgba(79,140,255,0.16)" stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const PLAYER_COLOR: Record<ParticipantInfo['player'], string> = {
  loading: 'var(--text-3)', ready: 'var(--success)', playing: 'var(--success)', paused: 'var(--text-2)', buffering: 'var(--warning)', blocked: 'var(--warning)',
};

/** How a viewer is receiving video, in a word or two. */
function routeLabel(p: ParticipantInfo): { text: string; tone: 'ok' | 'warn' | 'muted'; title: string } {
  const d = p.p2p;
  if (!d) return { text: 'via link', tone: 'muted', title: 'Video comes through the sharing link.' };
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const so = ` So far: ${mb(d.fromHost)} direct, ${mb(d.fromPeers)} from other viewers, ${mb(d.fromLink)} via link.`;
  const peers = d.peers > 0 ? ` · ${d.peers} friend${d.peers === 1 ? '' : 's'}` : '';
  if (d.host === 'connected') return { text: `direct${peers}`, tone: 'ok', title: `Connected directly to this computer.${so}` };
  if (d.host === 'connecting') return { text: `connecting…${peers}`, tone: 'muted', title: `Setting up a direct connection.${so}` };
  return { text: `via link${peers}`, tone: 'warn', title: `A direct connection is not possible on their network; video comes through the link.${so}` };
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className={s.seg} role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={`${s.segBtn} ${value === v ? s.segOn : ''}`} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export function RoomPanel({ conn, host }: { conn: RoomConnection; host: HostControls }) {
  const settings = useRoom((st) => st.settings);
  const participants = useRoom((st) => st.participants);
  const media = useRoom((st) => st.media);
  const [password, setPassword] = useState('');
  const stats = host.status?.stats;
  const guests = participants.filter((p) => p.role !== 'host');
  const patch = (p: Partial<RoomSettings> & { password?: string | null }) => {
    if (!conn.send({ type: 'settings', patch: p })) toast('warning', 'Not connected.');
  };
  if (!settings) return null;
  return (
    <div className={s.panel}>
      <section className={s.section}>
        <div className={s.head}><span className={s.title}>Your upload</span><span className={s.sub}>last 2 minutes</span></div>
        <div className={s.big}>{formatBitrate(stats?.uploadBps ?? 0)}</div>
        <div className={s.sub}>{guests.filter((g) => g.connected).length === 0 ? 'Nobody is watching from another device yet.' : 'Shared by everyone watching. Lower qualities use less.'}</div>
        <Sparkline values={stats?.uploadHistory ?? []} />
      </section>

      <section className={s.section}>
        <div className={s.head}><span className={s.title}>Viewers · {guests.filter((g) => g.connected).length}</span></div>
        {guests.length === 0 && <div className={s.empty}>Invite friends with the Invite button. They will appear here.</div>}
        <div role="list" aria-label="Viewers">
        {guests.map((p) => {
          const v = stats?.perViewer[p.id];
          return (
            <div key={p.id} className={s.row} role="listitem" aria-label={p.name}>
              <Avatar name={p.name} color={p.color} size={28} />
              <div className={s.rowMain}>
                <div className={s.name}>{p.name}</div>
                <div className={s.meta}>
                  <span><span className={s.dot} style={{ background: p.connected ? PLAYER_COLOR[p.player] : 'var(--warning)' }} />{p.connected ? p.player : 'reconnecting'}</span>
                  {p.quality && <span>{p.quality}</span>}
                  {p.rtt !== null && <span>{p.rtt} ms</span>}
                  {v && <span>{formatBitrate(v.bps)}</span>}
                  {v && <span>{(v.bytes / 1e6).toFixed(v.bytes > 1e8 ? 0 : 1)} MB sent</span>}
                  {p.connected && settings.p2p && (() => {
                    const r = routeLabel(p);
                    return <span className={s[`route_${r.tone}`]} title={r.title}>{r.text}</span>;
                  })()}
                </div>
              </div>
              <IconButton label={`Remove ${p.name}`} size="sm" onClick={() => {
                if (window.confirm(`Remove ${p.name} from the room? They won't be able to rejoin with this link.`)) conn.send({ type: 'kick', participantId: p.id });
              }}><UserX size={15} /></IconButton>
            </div>
          );
        })}
        </div>
      </section>

      <section className={s.section}>
        <div className={s.head}><span className={s.title}>Playback</span></div>
        <label className={s.label}>Who can play, pause and seek</label>
        <Seg value={settings.controlMode} options={[['everyone', 'Everyone'], ['host', 'Only me']]} onChange={(v) => patch({ controlMode: v })} />
        <label className={s.label}>When someone's video is loading</label>
        <Seg value={settings.bufferingPolicy} options={[['wait', 'Wait for them'], ['continue', 'Keep playing']]} onChange={(v) => patch({ bufferingPolicy: v })} />
      </section>

      <section className={s.section}>
        <div className={s.head}><span className={s.title}>Connections</span></div>
        <div className={s.line}>
          <span className={s.lineText}>
            <span><Zap size={12} /> Direct connections</span>
            <span className={s.sub}>
              {stats?.directAvailable === false
                ? 'Not available on this computer: the WebRTC component could not be loaded. Video uses the link.'
                : 'Video goes straight to your friends, and friends watching the same quality pass it on to each other, so you upload less. People in the room can see each other’s IP address.'}
            </span>
          </span>
          <button role="switch" aria-checked={settings.p2p} aria-label="Direct connections" className={`${s.switch} ${settings.p2p ? s.switchOn : ''}`}
            disabled={stats?.directAvailable === false} onClick={() => patch({ p2p: !settings.p2p })} />
        </div>
        {settings.p2p && guests.some((g) => g.connected) && (() => {
          const fromPeers = guests.reduce((a, g) => a + (g.p2p?.fromPeers ?? 0), 0);
          const direct = guests.filter((g) => g.connected && g.p2p?.host === 'connected').length;
          return (
            <div className={s.sub} style={{ marginTop: 6 }}>
              {direct} of {guests.filter((g) => g.connected).length} connected directly
              {fromPeers > 0 && <> · {(fromPeers / 1e6).toFixed(fromPeers > 1e8 ? 0 : 1)} MB shared between friends instead of uploaded by you</>}
            </div>
          );
        })()}
      </section>

      <section className={s.section}>
        <div className={s.head}><span className={s.title}>Access</span></div>
        <div className={s.line}>
          <span className={s.lineText}><span><Lock size={12} /> Lock the room</span><span className={s.sub}>Nobody new can join; people inside stay.</span></span>
          <button role="switch" aria-checked={settings.locked} aria-label="Lock the room" className={`${s.switch} ${settings.locked ? s.switchOn : ''}`}
            onClick={() => patch({ locked: !settings.locked })} />
        </div>
        <label className={s.label}><KeyRound size={12} /> Room password {settings.passwordRequired && <span className={s.sub}>(set)</span>}</label>
        <form className={s.inputRow} onSubmit={(e) => {
          e.preventDefault();
          if (!password) return;
          patch({ password });
          setPassword('');
          toast('success', 'Password set. New people will need it to join.');
        }}>
          <input className={s.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={settings.passwordRequired ? 'New password' : 'Optional'} autoComplete="new-password" aria-label="Room password" />
          <Button size="sm" type="submit" disabled={!password}>Set</Button>
          {settings.passwordRequired && <Button size="sm" variant="ghost" onClick={() => patch({ password: null })}>Remove</Button>}
        </form>
        <div className={s.line} style={{ marginTop: 8 }}>
          <span>Maximum viewers</span>
          <select className={s.select} value={settings.maxParticipants} onChange={(e) => patch({ maxParticipants: Number(e.target.value) })} aria-label="Maximum viewers">
            {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </section>

      {media?.kind === 'file' && (
        <section className={s.section}>
          <div className={s.head}>
            <span className={s.title}>Subtitles</span>
            {host.addSubtitle && <Button size="sm" variant="ghost" icon={<Captions size={13} />} onClick={host.addSubtitle}>Add file…</Button>}
          </div>
          {media.subtitles.length === 0 && <div className={s.empty}>This video has no subtitles. Add an .srt, .vtt or .ass file; it shows up for everyone to turn on.</div>}
          {media.subtitles.map((t) => (
            <div key={t.id} className={s.track}>
              <span className={s.trackLabel}>{t.label}</span>
              <span className={`${s.badge} ${t.status === 'ready' ? s.badgeOk : t.status === 'extracting' ? '' : s.badgeWarn}`}>
                {t.status === 'ready' ? 'Ready' : t.status === 'extracting' ? 'Preparing…' : t.status === 'unsupported' ? 'Picture-based' : 'Unreadable'}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
