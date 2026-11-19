import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, CornerUpLeft, FastForward, Film, Gauge, ImagePlus, Info, LogIn, LogOut, MessageSquare, Pause, PenLine, Play, SendHorizontal,
  Settings2, ShieldX, Smile, Sticker, X,
} from 'lucide-react';
import { LIMITS, type ChatMessage, type ChatReplyRef, type SystemIcon, type UserChatMessage } from '@watchroom/protocol';
import { Avatar, Spinner } from '../components/misc';
import { describeMessage, sendChat } from '../lib/chat';
import type { RoomConnection } from '../lib/connection';
import { isTouch } from '../lib/device';
import { formatClock } from '../lib/format';
import { imageFromClipboard, prepareImage, uploadImage } from '../lib/images';
import { useTypingNotifier } from '../lib/typing';
import { focusChatMessage, useRoom, toast } from '../state/room';
import { EmojiPicker } from './EmojiPicker';
import { Lightbox } from './Lightbox';
import { linkify } from './linkify';
import { StickerPicker, stickerUrl } from './StickerPicker';
import { YouTubePreview } from './YouTubePreview';
import s from './Chat.module.css';

const SYSTEM_ICONS: Record<SystemIcon, typeof Play> = {
  join: LogIn, leave: LogOut, play: Play, pause: Pause, seek: FastForward, rate: Gauge, video: Film, kick: ShieldX, info: Info,
  settings: Settings2, rename: PenLine,
};

type Item =
  | { kind: 'group'; key: string; author: UserChatMessage; messages: UserChatMessage[] }
  | { kind: 'system'; key: string; message: Extract<ChatMessage, { kind: 'system' }> };

function groupMessages(chat: ChatMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of chat) {
    if (m.kind === 'system') {
      items.push({ kind: 'system', key: m.id, message: m });
      continue;
    }
    const prev = items[items.length - 1];
    if (prev?.kind === 'group' && prev.author.authorId === m.authorId && m.ts - prev.messages[prev.messages.length - 1]!.ts < 5 * 60_000) {
      prev.messages.push(m);
    } else {
      items.push({ kind: 'group', key: m.id, author: m, messages: [m] });
    }
  }
  return items;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** 1–3 emoji and nothing else are shown large. */
export function isJumbo(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40 || !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(t) || /^[\d#*\s]+$/.test(t)) return false;
  const count = segmenter ? [...segmenter.segment(t.replace(/\s+/g, ''))].length : t.length / 2;
  return count <= 3;
}

function typingText(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

export function ChatPanel({ conn, active }: { conn: RoomConnection; active: boolean }) {
  const chat = useRoom((st) => st.chat);
  const me = useRoom((st) => st.me);
  const phase = useRoom((st) => st.phase);
  const typingIds = useRoom((st) => st.typing);
  const participants = useRoom((st) => st.participants);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [picker, setPicker] = useState<'emoji' | 'sticker' | null>(null);
  const [pending, setPending] = useState<{ preview: string; label: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const replyDraft = useRoom((st) => st.replyDraft);
  const focusMessage = useRoom((st) => st.focusMessage);
  const [highlight, setHighlight] = useState<string | null>(null);
  // Touch screens have no hover: tapping a message reveals its actions.
  const [selected, setSelected] = useState<string | null>(null);
  const touch = isTouch();
  const seenCount = useRef(chat.length);
  const typing = useTypingNotifier(conn);
  const items = useMemo(() => groupMessages(chat), [chat]);
  const typingNames = typingIds.map((id) => participants.find((p) => p.id === id)?.name).filter(Boolean) as string[];

  // Stick to the bottom unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const added = chat.length - seenCount.current;
    seenCount.current = chat.length;
    const last = chat[chat.length - 1];
    const mine = last?.kind === 'user' && last.authorId === me?.id;
    if (atBottom || mine) {
      el.scrollTop = el.scrollHeight;
      setNewCount(0);
    } else if (added > 0) setNewCount((n) => n + added);
  }, [chat, atBottom, me?.id]);

  useEffect(() => {
    if (active) useRoom.setState({ unread: 0 });
  }, [active, chat.length]);

  // Jump to a message (from a quote or a notification card) and flash it.
  // The request is consumed here, so a later mount of the panel doesn't jump again.
  useEffect(() => {
    if (!focusMessage) return;
    useRoom.setState({ focusMessage: null });
    const el = listRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focusMessage.id)}"]`);
    if (!el) {
      toast('info', 'That message is no longer in the chat history.');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(focusMessage.id);
  }, [focusMessage]);
  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const startReply = (m: UserChatMessage) => {
    useRoom.setState({ replyDraft: m });
    setSelected(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const cancelReply = () => useRoom.setState({ replyDraft: null });

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  }, [text]);

  const onTextChange = (value: string) => {
    setText(value);
    typing.input(value);
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    if (value.length > LIMITS.chatMax) {
      toast('warning', `Messages can be up to ${LIMITS.chatMax} characters.`);
      return;
    }
    if (!sendChat(conn, { text: value, replyTo: replyDraft?.id })) {
      toast('warning', 'Not connected. Your message was not sent.');
      return;
    }
    typing.sent();
    setText('');
    cancelReply();
    setAtBottom(true);
  };

  const resetTyping = typing.sent;

  const sendSticker = (id: string) => {
    setPicker(null);
    resetTyping();
    if (!sendChat(conn, { text: '', attachment: { kind: 'sticker', id }, replyTo: replyDraft?.id })) toast('warning', 'Not connected.');
    else cancelReply();
    setAtBottom(true);
  };

  const sendImage = async (file: File) => {
    if (pending) return;
    const preview = URL.createObjectURL(file);
    setPending({ preview, label: 'Preparing…' });
    try {
      const img = await prepareImage(file);
      setPending({ preview, label: 'Sending…' });
      const up = await uploadImage(img);
      const caption = text.trim().slice(0, LIMITS.chatMax);
      if (!sendChat(conn, { text: caption, attachment: { kind: 'image', id: up.id }, replyTo: useRoom.getState().replyDraft?.id })) {
        throw new Error('Not connected.');
      }
      resetTyping();
      cancelReply();
      if (caption) setText('');
      setAtBottom(true);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setPending(null);
      // Release the preview only after React has removed the element using it.
      window.setTimeout(() => URL.revokeObjectURL(preview), 1000);
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    onTextChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    });
  };

  return (
    <div
      className={`${s.chat} ${dragOver ? s.dragOver : ''}`}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
        setDragOver(false);
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        void sendImage(file);
      }}
    >
      <div
        ref={listRef}
        className={s.list}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (bottom !== atBottom) setAtBottom(bottom);
          if (bottom) setNewCount(0);
        }}
        aria-live="polite"
      >
        {items.length === 0 && (
          <div className={s.emptyChat}>
            <MessageSquare size={22} />
            <strong>No messages yet</strong>
            <span>Say hi while you get the movie ready.</span>
          </div>
        )}
        {items.map((item) => item.kind === 'system' ? (
          <SystemLine key={item.key} message={item.message} />
        ) : (
          <div key={item.key} className={s.group}>
            <Avatar name={item.author.authorName} color={item.author.authorColor} />
            <div className={s.groupBody}>
              <div className={s.meta}>
                <span className={s.author} style={{ color: item.author.authorColor }}>{item.author.authorName}</span>
                {item.author.authorId === me?.id && <span className={s.you}>you</span>}
                <span className={s.time}>{formatClock(item.author.ts)}</span>
              </div>
              {item.messages.map((m) => (
                <div
                  key={m.id}
                  data-mid={m.id}
                  className={`${s.message} ${highlight === m.id ? s.highlight : ''} ${selected === m.id ? s.selected : ''}`}
                  onClick={touch ? (e) => {
                    if ((e.target as HTMLElement).closest('a, button')) return;
                    setSelected((cur) => (cur === m.id ? null : m.id));
                  } : undefined}
                >
                  <div className={s.msgActions}>
                    <button className={s.msgAction} onClick={() => startReply(m)} aria-label={`Reply to ${m.authorName}`} title="Reply">
                      <CornerUpLeft size={14} />
                    </button>
                  </div>
                  {m.replyTo && <Quote reply={m.replyTo} mine={m.replyTo.authorId === me?.id} />}
                  {m.attachment?.kind === 'image' && (
                    <button className={s.imageBtn} onClick={() => setLightbox({ src: m.attachment!.kind === 'image' ? m.attachment!.url : '', alt: `Picture from ${m.authorName}` })}
                      style={{ aspectRatio: `${m.attachment.width} / ${m.attachment.height}` }} aria-label={`Open picture from ${m.authorName}`}>
                      <img src={m.attachment.url} alt="" loading="lazy" decoding="async" />
                    </button>
                  )}
                  {m.attachment?.kind === 'sticker' && (
                    <img className={s.sticker} src={stickerUrl(m.attachment.id)} alt={`${m.attachment.id.replace(/-/g, ' ')} sticker`} draggable={false} />
                  )}
                  {m.text && <div className={`${s.text} ${isJumbo(m.text) ? s.jumbo : ''}`}>{linkify(m.text)}</div>}
                  {m.preview && <YouTubePreview preview={m.preview} conn={conn} />}
                </div>
              ))}
            </div>
          </div>
        ))}
        {newCount > 0 && !atBottom && (
          <div className={s.jumpWrap}>
            <button
              className={s.jump}
              onClick={() => {
                const el = listRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setAtBottom(true);
                setNewCount(0);
              }}
            >
              <ArrowDown size={13} /> {newCount} new
            </button>
          </div>
        )}
      </div>
      <div className={s.composer}>
        <div className={s.typing} aria-live="polite">{typingNames.length > 0 && <><span className={s.dots}><i /><i /><i /></span>{typingText(typingNames)}</>}</div>
        {replyDraft && (
          <div className={s.replyBar}>
            <CornerUpLeft size={15} className={s.replyIcon} />
            <div className={s.replyBody}>
              <span className={s.replyName} style={{ color: replyDraft.authorColor }}>
                Replying to {replyDraft.authorId === me?.id ? 'yourself' : replyDraft.authorName}
              </span>
              <span className={s.replyText}>{describeMessage(replyDraft)}</span>
            </div>
            <button className={s.tool} onClick={cancelReply} aria-label="Cancel reply" title="Cancel reply (Esc)"><X size={15} /></button>
          </div>
        )}
        {pending && (
          <div className={s.pending}>
            <img src={pending.preview} alt="" />
            <span>{pending.label}</span>
            <Spinner size={14} />
          </div>
        )}
        <div className={s.inputWrap}>
          <textarea
            ref={inputRef}
            className={s.input}
            rows={1}
            value={text}
            placeholder={phase === 'joined' ? 'Message the room' : 'Reconnecting…'}
            aria-label="Chat message"
            maxLength={LIMITS.chatMax + 200}
            onChange={(e) => onTextChange(e.target.value)}
            onPaste={(e) => {
              const file = imageFromClipboard(e);
              if (file) {
                e.preventDefault();
                void sendImage(file);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
              if (e.key === 'Escape') {
                if (useRoom.getState().replyDraft) cancelReply();
                else inputRef.current?.blur();
              }
            }}
          />
          <div className={s.tools}>
            <button className={`${s.tool} ${picker === 'emoji' ? s.toolActive : ''}`} data-picker-toggle aria-label="Emoji" title="Emoji"
              onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}><Smile size={17} /></button>
            <button className={`${s.tool} ${picker === 'sticker' ? s.toolActive : ''}`} data-picker-toggle aria-label="Stickers" title="Stickers"
              onClick={() => setPicker(picker === 'sticker' ? null : 'sticker')}><Sticker size={17} /></button>
            <button className={s.tool} aria-label="Send a picture" title="Send a picture (or paste / drop one)" disabled={Boolean(pending)}
              onClick={() => fileRef.current?.click()}><ImagePlus size={17} /></button>
            <button className={`${s.send} ${text.trim() ? s.sendActive : ''}`} onClick={send} aria-label="Send" disabled={!text.trim()}>
              <SendHorizontal size={16} />
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void sendImage(f);
          }} />
        </div>
        {text.length > LIMITS.chatMax - 200 && (
          <div className={`${s.counter} ${text.length > LIMITS.chatMax ? s.counterOver : ''}`}>{text.length} / {LIMITS.chatMax}</div>
        )}
        {picker === 'emoji' && <EmojiPicker onPick={insertEmoji} onClose={() => setPicker(null)} />}
        {picker === 'sticker' && <StickerPicker onPick={sendSticker} onClose={() => setPicker(null)} />}
      </div>
      {dragOver && <div className={s.dropHint}><ImagePlus size={22} /> Drop to send the picture</div>}
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function Quote({ reply, mine }: { reply: ChatReplyRef; mine: boolean }) {
  return (
    <button className={s.quote} style={{ '--quote': reply.authorColor } as React.CSSProperties}
      onClick={(e) => { e.stopPropagation(); focusChatMessage(reply.id); }} title="Show the original message">
      <span className={s.quoteName}>{mine ? 'You' : reply.authorName}</span>
      <span className={s.quoteText}>{describeMessage(reply) || '…'}</span>
    </button>
  );
}

function SystemLine({ message }: { message: Extract<ChatMessage, { kind: 'system' }> }) {
  const Icon = SYSTEM_ICONS[message.icon] ?? Info;
  return (
    <div className={s.system}>
      <Icon size={12} />
      <span className={s.systemText}>{message.text}</span>
      <span className={s.systemTime}>· {formatClock(message.ts)}</span>
    </div>
  );
}
