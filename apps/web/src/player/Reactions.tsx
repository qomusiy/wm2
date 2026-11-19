import { useEffect, useRef } from 'react';
import { useDismiss } from '../lib/hooks';
import { REACTIONS } from '@watchroom/protocol';
import { useRoom } from '../state/room';
import s from './Player.module.css';

function hash(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** Emoji reactions rising over the video (everyone sees them; they are not kept in chat). */
export function ReactionsOverlay() {
  const reactions = useRoom((st) => st.reactions);
  const participants = useRoom((st) => st.participants);
  const me = useRoom((st) => st.me);
  return (
    <div className={s.reactions} aria-hidden>
      {reactions.map((r) => {
        const h = hash(r.id);
        const who = r.participantId === me?.id ? 'You' : participants.find((p) => p.id === r.participantId)?.name ?? '';
        return (
          <div key={r.id} className={s.reaction} style={{ right: `${4 + (h % 22)}%`, animationDuration: `${2.6 + (h % 7) / 10}s`, ['--drift' as string]: `${(h % 41) - 20}px` }}>
            <span className={s.reactionEmoji}>{r.emoji}</span>
            {who && <span className={s.reactionName}>{who}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ReactionBar({ onReact, onClose }: { onReact(emoji: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, { container: 'parent' });
  // Close after a few idle seconds so the controls can hide again.
  const idle = useRef<number | null>(null);
  const arm = () => {
    if (idle.current) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(onClose, 4000);
  };
  useEffect(() => {
    arm();
    return () => { if (idle.current) window.clearTimeout(idle.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={s.reactionBar} role="toolbar" aria-label="React">
      {REACTIONS.map((e) => (
        <button key={e} className={s.reactionBtn} onClick={() => { onReact(e); arm(); }} aria-label={`React ${e}`}>{e}</button>
      ))}
    </div>
  );
}
