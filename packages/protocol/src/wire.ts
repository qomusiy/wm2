import { LIMITS } from './constants';
import type {
  ChatMessage, ErrorCode, LinkPreview, MediaDescriptor, ParticipantInfo, PlaybackState, RoomSettings, RoomSnapshot,
} from './types';

/** Strip control characters and collapse whitespace in display names. */
export function sanitizeName(raw: string): string {
  return raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.nameMax);
}

/** Remove control characters except newlines/tabs from chat text; trim and cap length. */
export function sanitizeChat(raw: string): string {
  return raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, LIMITS.chatMax);
}

/** One-line preview of a message: whitespace collapsed, cut at a word boundary near `max` characters. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Messages the server sends. Not validated on the client (trusted origin), only typed. */
export type ServerMessage =
  | { type: 'welcome'; participantId: string; token: string; role: 'host' | 'guest'; snapshot: RoomSnapshot }
  | { type: 'pong'; id: number; t0: number; serverTime: number }
  | { type: 'playback'; playback: PlaybackState; serverTime: number }
  | { type: 'participants'; participants: ParticipantInfo[] }
  | { type: 'chat'; message: ChatMessage; nonce?: string }
  | { type: 'media'; media: MediaDescriptor | null }
  | { type: 'settings'; settings: RoomSettings }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'error'; code: ErrorCode; message: string; fatal: boolean }
  | { type: 'typing'; participantId: string; active: boolean }
  | { type: 'reaction'; id: string; participantId: string; emoji: string }
  | { type: 'rtc'; from: string; sdp?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; mid: string } }
  | { type: 'chat-preview'; messageId: string; preview: LinkPreview }
  /** Answer to a client's open-youtube request. */
  | { type: 'open-result'; requestId: string; ok: boolean; error?: string }
  | { type: 'kicked' }
  | { type: 'ended'; reason: string };

/** WebSocket close codes used by the server (4000-4999 are application-defined). */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  joinFailed: 4001,
  kicked: 4002,
  ended: 4003,
  replaced: 4004,
  protocol: 4005,
  joinTimeout: 4006,
} as const;
