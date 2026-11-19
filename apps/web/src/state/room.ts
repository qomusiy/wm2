import { create } from 'zustand';
import type { ChatMessage, MediaDescriptor, ParticipantInfo, PlaybackState, RoomSettings, UserChatMessage } from '@watchroom/protocol';

export type Phase = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'failed' | 'ended' | 'kicked';
export type SyncState = 'idle' | 'loading' | 'synced' | 'correcting' | 'seeking' | 'waiting' | 'paused' | 'buffering' | 'blocked';

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface RoomStore {
  phase: Phase;
  error: { code: string; message: string } | null;
  roomId: string | null;
  me: { id: string; role: 'host' | 'guest' } | null;
  sessionReady: boolean;
  participants: ParticipantInfo[];
  playback: PlaybackState | null;
  media: MediaDescriptor | null;
  chat: ChatMessage[];
  settings: RoomSettings | null;
  rtt: number | null;
  sync: { state: SyncState; drift: number | null };
  player: { quality: string | null; auto: boolean };
  toasts: Toast[];
  unread: number;
  /** Participant ids currently typing (others only). */
  typing: string[];
  /** Recent reactions for the floating overlay (removed after their animation). */
  reactions: { id: string; emoji: string; participantId: string }[];
  /** The message the chat composer is replying to. */
  replyDraft: UserChatMessage | null;
  /** Ask the chat list to scroll to a message and highlight it (n changes on every request). */
  focusMessage: { id: string; n: number } | null;
}

export const useRoom = create<RoomStore>(() => ({
  phase: 'idle',
  error: null,
  roomId: null,
  me: null,
  sessionReady: false,
  participants: [],
  playback: null,
  media: null,
  chat: [],
  settings: null,
  rtt: null,
  sync: { state: 'idle', drift: null },
  player: { quality: null, auto: true },
  toasts: [],
  unread: 0,
  typing: [],
  reactions: [],
  replyDraft: null,
  focusMessage: null,
}));

let focusN = 0;
export function focusChatMessage(id: string): void {
  useRoom.setState({ focusMessage: { id, n: ++focusN } });
}

let toastId = 0;
export function toast(level: Toast['level'], text: string, ms = 3500): void {
  const id = ++toastId;
  useRoom.setState((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, level, text }].slice(-4) }));
  window.setTimeout(() => useRoom.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function participantName(id: string | null | undefined): string | null {
  if (!id) return null;
  return useRoom.getState().participants.find((p) => p.id === id)?.name ?? null;
}
