import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CornerUpLeft, Film, Info, LogIn, LogOut, MessageSquare, PenLine, SendHorizontal, Settings2, ShieldX, X, type LucideIcon,
} from 'lucide-react';
import { LIMITS, type SystemChatMessage, type SystemIcon, type UserChatMessage } from '@watchroom/protocol';
import { isJumbo } from '../chat/ChatPanel';
import { stickerUrl } from '../chat/StickerPicker';
import { YouTubePreview } from '../chat/YouTubePreview';
import { Avatar } from '../components/misc';
import { describeMessage, sendChat } from '../lib/chat';
import type { RoomConnection } from '../lib/connection';
import { isTouch } from '../lib/device';
import { useTypingNotifier } from '../lib/typing';
import { usePlayerChrome } from '../player/chrome';
import { toast, useRoom } from '../state/room';
import s from './Popups.module.css';

/** Room events worth a card. Play/pause/seek/speed already show as a flash in the middle of the picture. */
const EVENT_ICONS: Partial<Record<SystemIcon, LucideIcon>> = {
  join: LogIn, leave: LogOut, kick: ShieldX, video: Film, rename: PenLine, settings: Settings2, info: Info,
};

interface Card {
  key: string;
  kind: 'message' | 'event';
  authorId: string | null;
  messages: UserChatMessage[];
  event: SystemChatMessage | null;
  /** Display time left (ms); it only runs down while nobody is looking at or answering the card. */
  remaining: number;
  leavingAt: number | null;
  sent: boolean;
}

/** How many cards fit: fewer on short players (a phone in landscape is ~400 px tall). */
function maxCardsFor(height: number): number {
  return height < 300 ? 1 : height < 520 ? 2 : 3;
}
const MAX_LINES = 3;
const LEAVE_MS = 240;
const EVENT_MS = 4000;
const TICK_MS = 200;

/** Long enough to read comfortably (~200 words a minute plus a glance), between 4.5 and 15 seconds. */
export function readTime(m: Pick<UserChatMessage, 'text' | 'attachment' | 'replyTo' | 'preview'>): number {
  const chars = m.text.length + (m.replyTo ? 24 : 0);
  // A video link stays a little longer: there's a button to press.
  return Math.min(15_000, Math.max(m.preview ? 9000 : m.attachment ? 6000 : 4500, 3500 + chars * 60));
}

/**
 * Chat notifications over the video while the chat itself is out of sight (full screen, phone landscape, hidden side
 * panel): new messages and room events slide in at the bottom right, stay long enough to read, pause while hovered or
 * answered, and can be replied to in place. Enter opens a one-line message to the room.
 */
export function Popups({ conn, onOpenChat }: { conn: RoomConnection; onOpenChat(messageId?: string): void }) {
  const chat = useRoom((st) => st.chat);
  const me = useRoom((st) => st.me);
  const typingIds = useRoom((st) => st.typing);
  const participants = useRoom((st) => st.participants);
  const chrome = usePlayerChrome();
  const touch = isTouch();
  // Only what arrives from now on: entering full screen must not replay the history.
  const lastSeq = useRef(chat[chat.length - 1]?.seq ?? 0);
  const [cards, setCards] = useState<Card[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const maxCards = useRef(3);
  useEffect(() => {
    const player = rootRef.current?.parentElement;
    if (!player) return;
    const ro = new ResizeObserver(([e]) => { maxCards.current = maxCardsFor(e?.contentRect.height ?? 720); });
    ro.observe(player);
    return () => ro.disconnect();
  }, []);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [drag, setDrag] = useState<{ key: string; dx: number } | null>(null);
  // Mouse users get a short reminder that Enter opens a message box, each time the video takes over the screen.
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setIntro(false), 4000);
    return () => window.clearTimeout(t);
  }, []);
  const replyingRef = useRef(replying);
  replyingRef.current = replying;

  // ---- new messages and events become cards
  useEffect(() => {
    const fresh = chat.filter((m) => m.seq > lastSeq.current);
    if (!fresh.length) return;
    lastSeq.current = fresh[fresh.length - 1]!.seq;
    const myId = useRoom.getState().me?.id;
    setCards((current) => {
      let next = current;
      for (const m of fresh) {
        if (m.kind === 'user') {
          if (m.authorId === myId) continue;
          const last = next[next.length - 1];
          if (last && last.kind === 'message' && last.authorId === m.authorId && last.leavingAt === null && !last.sent) {
            // Consecutive messages from one person grow the same card instead of stacking new ones.
            next = [...next.slice(0, -1), {
              ...last, messages: [...last.messages, m], remaining: Math.min(20_000, Math.max(last.remaining, readTime(m)) + 1000),
            }];
          } else {
            next = [...next, {
              key: m.id, kind: 'message', authorId: m.authorId, messages: [m], event: null, remaining: readTime(m), leavingAt: null, sent: false,
            }];
          }
        } else if (EVENT_ICONS[m.icon] && m.actorId !== myId) {
          next = [...next, {
            key: m.id, kind: 'event', authorId: m.actorId, messages: [], event: m, remaining: EVENT_MS, leavingAt: null, sent: false,
          }];
        }
      }
      // Keep the stack short. Room notices make way before messages, oldest first; the newest card and a card being
      // answered always stay.
      const now = performance.now();
      const newest = next[next.length - 1]?.key;
      const live = next.filter((c) => c.leavingAt === null && c.key !== replyingRef.current && c.key !== newest);
      const excess = next.filter((c) => c.leavingAt === null).length - maxCards.current;
      if (excess > 0) {
        const victims = new Set([...live.filter((c) => c.kind === 'event'), ...live.filter((c) => c.kind === 'message')]
          .slice(0, excess).map((c) => c.key));
        next = next.map((c) => (victims.has(c.key) ? { ...c, leavingAt: now } : c));
      }
      return next;
    });
  }, [chat]);

  // ---- timers: run down only while nobody is reading or answering
  const pausedRef = useRef<(c: Card) => boolean>(() => false);
  // Focus is read live: an element removed while focused (a reply box after sending) fires no blur event.
  pausedRef.current = (c) => hovered || c.key === expanded || c.key === replying || document.hidden
    || Boolean(rootRef.current?.contains(document.activeElement));
  const hasCards = cards.length > 0;
  useEffect(() => {
    if (!hasCards) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setCards((cs) => {
        let changed = false;
        const next: Card[] = [];
        for (const c of cs) {
          if (c.leavingAt !== null) {
            if (now - c.leavingAt < LEAVE_MS) next.push(c);
            else changed = true;
            continue;
          }
          if (pausedRef.current(c)) {
            next.push(c);
            continue;
          }
          changed = true;
          const remaining = c.remaining - dt;
          next.push(remaining <= 0 ? { ...c, remaining: 0, leavingAt: now } : { ...c, remaining });
        }
        return changed ? next : cs;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [hasCards]);

  const dismiss = useCallback((key: string) => {
    const now = performance.now();
    setCards((cs) => cs.map((c) => (c.key === key && c.leavingAt === null ? { ...c, leavingAt: now } : c)));
    setExpanded((k) => (k === key ? null : k));
    setReplying((k) => (k === key ? null : k));
  }, []);

  // ---- Enter: message the room without leaving full screen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || composing || replying) return;
      const el = e.target as HTMLElement;
      if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (el.closest('button, a, [role="menu"], [role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setComposing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composing, replying]);

  // ---- touch: swipe a card sideways to dismiss it, tap to show its actions
  const start = useRef<{ key: string; x: number; y: number; id: number; moved: boolean } | null>(null);
  const onCardPointerDown = (key: string) => (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('button, input, a')) return;
    start.current = { key, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  };
  const onCardPointerMove = (e: React.PointerEvent) => {
    const st = start.current;
    if (!st || st.id !== e.pointerId) return;
    const dx = e.clientX - st.x;
    if (!st.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - st.y)) {
      st.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (st.moved) setDrag({ key: st.key, dx: Math.max(-40, dx) });
  };
  const onCardPointerUp = (e: React.PointerEvent) => {
    const st = start.current;
    start.current = null;
    if (!st || st.id !== e.pointerId) return;
    const dx = e.clientX - st.x;
    setDrag(null);
    if (st.moved) {
      if (dx > 70) dismiss(st.key);
      return;
    }
    setExpanded((k) => (k === st.key ? null : st.key));
  };

  const sendReply = (card: Card, text: string): boolean => {
    const target = card.messages[card.messages.length - 1];
    if (!sendChat(conn, { text, replyTo: target?.id })) {
      toast('warning', 'Not connected. Your reply was not sent.');
      return false;
    }
    setReplying(null);
    setExpanded(null);
    setCards((cs) => cs.map((c) => (c.key === card.key ? { ...c, sent: true, remaining: 1400 } : c)));
    return true;
  };

  const typingNames = typingIds.map((id) => participants.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const active = cards.length > 0 || composing || typingNames.length > 0;

  return (
    <div
      ref={rootRef}
      className={s.popups}
      data-popups={active ? 'active' : 'idle'}
      role="log"
      aria-live="polite"
      aria-label="New messages"
      onPointerEnter={(e) => { if (e.pointerType !== 'touch') { setHovered(true); chrome.pinControls(true); } }}
      onPointerLeave={(e) => { if (e.pointerType !== 'touch') { setHovered(false); chrome.pinControls(false); } }}
    >
      {cards.map((card) => {
        const leaving = card.leavingAt !== null;
        const dragging = drag?.key === card.key ? drag.dx : 0;
        const style = dragging ? { transform: `translateX(${dragging}px)`, opacity: Math.max(0.2, 1 - Math.max(0, dragging) / 160) } : undefined;
        if (card.kind === 'event' && card.event) {
          const Icon = EVENT_ICONS[card.event.icon] ?? Info;
          return (
            <div key={card.key} className={`${s.event} ${s[`ev_${card.event.icon}`] ?? ''} ${leaving ? s.leaving : ''}`} style={style}
              onPointerDown={onCardPointerDown(card.key)} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp}
              onPointerCancel={() => { start.current = null; setDrag(null); }}>
              <Icon size={14} className={s.eventIcon} />
              <span className={s.eventText}>{card.event.text}</span>
              <button className={s.close} onClick={() => dismiss(card.key)} aria-label="Dismiss"><X size={13} /></button>
            </div>
          );
        }
        const first = card.messages[0]!;
        const shown = card.messages.slice(-MAX_LINES);
        const hidden = card.messages.length - shown.length;
        const toMe = card.messages.some((m) => m.replyTo?.authorId === me?.id);
        const isOpen = expanded === card.key || replying === card.key;
        return (
          <article
            key={card.key}
            className={`${s.card} ${toMe ? s.toMe : ''} ${leaving ? s.leaving : ''} ${isOpen ? s.open : ''}`}
            style={style}
            aria-label={`Message from ${first.authorName}`}
            onPointerDown={onCardPointerDown(card.key)}
            onPointerMove={onCardPointerMove}
            onPointerUp={onCardPointerUp}
            onPointerCancel={() => { start.current = null; setDrag(null); }}
          >
            <button className={s.close} onClick={() => dismiss(card.key)} aria-label="Dismiss"><X size={13} /></button>
            <div
              className={s.body}
              onClick={touch ? undefined : () => onOpenChat(card.messages[card.messages.length - 1]?.id)}
              title={touch ? undefined : 'Open in chat'}
            >
              <Avatar name={first.authorName} color={first.authorColor} size={28} />
              <div className={s.content}>
                <div className={s.head}>
                  <span className={s.name} style={{ color: first.authorColor }}>{first.authorName}</span>
                  {toMe && <span className={s.badge}>replied to you</span>}
                </div>
                {hidden > 0 && <div className={s.more}>+{hidden} earlier</div>}
                {shown.map((m) => (
                  <div key={m.id} className={s.line}>
                    {m.replyTo && (
                      <div className={s.quote} style={{ '--quote': m.replyTo.authorColor } as React.CSSProperties}>
                        <CornerUpLeft size={11} /> <b>{m.replyTo.authorId === me?.id ? 'You' : m.replyTo.authorName}</b> {describeMessage(m.replyTo)}
                      </div>
                    )}
                    {m.attachment?.kind === 'sticker' && <img className={s.sticker} src={stickerUrl(m.attachment.id)} alt="Sticker" draggable={false} />}
                    {m.attachment?.kind === 'image' && (
                      <img className={s.picture} src={m.attachment.url} alt="Picture" draggable={false}
                        style={{ aspectRatio: `${m.attachment.width} / ${m.attachment.height}` }} />
                    )}
                    {m.text && <div className={`${s.text} ${isJumbo(m.text) ? s.jumbo : ''}`}>{m.text}</div>}
                    {m.preview && <YouTubePreview preview={m.preview} conn={conn} compact />}
                  </div>
                ))}
              </div>
            </div>
            {card.sent ? (
              <div className={s.sent}>Reply sent</div>
            ) : replying === card.key ? (
              <QuickInput
                conn={conn}
                placeholder={`Reply to ${first.authorName}`}
                onSend={(text) => sendReply(card, text)}
                onCancel={() => setReplying(null)}
              />
            ) : (
              <div className={s.actions}>
                <button className={s.action} onClick={() => { setReplying(card.key); setExpanded(null); }}>
                  <CornerUpLeft size={14} /> Reply
                </button>
                <button className={s.action} onClick={() => onOpenChat(card.messages[card.messages.length - 1]?.id)}>
                  <MessageSquare size={14} /> Open chat
                </button>
              </div>
            )}
          </article>
        );
      })}
      {typingNames.length > 0 && !composing && (
        <div className={s.typing}><span className={s.dots}><i /><i /><i /></span>
          {typingNames.length === 1 ? `${typingNames[0]} is typing…` : `${typingNames.length} people are typing…`}
        </div>
      )}
      {composing ? (
        <QuickInput
          conn={conn}
          room
          placeholder="Message the room"
          onSend={(text) => {
            if (!sendChat(conn, { text })) {
              toast('warning', 'Not connected. Your message was not sent.');
              return false;
            }
            setComposing(false);
            return true;
          }}
          onCancel={() => setComposing(false)}
        />
      ) : (
        !touch && !replying && <div className={`${s.hint} ${intro ? s.hintShow : ''}`}>Press <kbd>Enter</kbd> to chat</div>
      )}
    </div>
  );
}

/** One-line composer used for replies and for messages to the room. Enter sends; Escape or an empty blur closes it. */
function QuickInput({ conn, placeholder, room, onSend, onCancel }: {
  conn: RoomConnection; placeholder: string; room?: boolean; onSend(text: string): boolean; onCancel(): void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const typing = useTypingNotifier(conn);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => {
    const v = text.trim();
    if (!v) return onCancel();
    if (v.length > LIMITS.chatMax) {
      toast('warning', `Messages can be up to ${LIMITS.chatMax} characters.`);
      return;
    }
    if (onSend(v)) typing.sent();
  };
  return (
    <form className={`${s.quick} ${room ? s.quickRoom : ''}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input
        ref={ref}
        value={text}
        onChange={(e) => { setText(e.target.value); typing.input(e.target.value); }}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={LIMITS.chatMax}
        enterKeyHint="send"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            typing.stop();
            onCancel();
          }
        }}
        onBlur={(e) => {
          if (e.currentTarget.form?.contains(e.relatedTarget as Node)) return;
          if (!text.trim()) onCancel();
        }}
      />
      <button type="submit" aria-label="Send" disabled={!text.trim()}><SendHorizontal size={15} /></button>
    </form>
  );
}
