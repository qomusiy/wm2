import { LIMITS, type ChatReplyRef, type UserChatMessage } from '@watchroom/protocol';
import type { RoomConnection } from './connection';
import { nonce } from './device';

export interface OutgoingChat {
  text: string;
  attachment?: { kind: 'image'; id: string } | { kind: 'sticker'; id: string };
  replyTo?: string | null;
}

/** Sends a chat message; false when the socket is down (nothing was queued). */
export function sendChat(conn: RoomConnection, msg: OutgoingChat): boolean {
  return conn.send({
    type: 'chat',
    text: msg.text.slice(0, LIMITS.chatMax),
    nonce: nonce(),
    ...(msg.attachment ? { attachment: msg.attachment as never } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
  });
}

/** Short description of a message for quotes and notifications. */
export function describeMessage(m: Pick<UserChatMessage, 'text' | 'attachment'> | ChatReplyRef): string {
  const kind = typeof m.attachment === 'string' ? m.attachment : m.attachment?.kind;
  const text = ('excerpt' in m ? m.excerpt : m.text).replace(/\s+/g, ' ').trim();
  if (text) return kind === 'image' ? `🖼 ${text}` : text;
  return kind === 'image' ? 'Picture' : kind === 'sticker' ? 'Sticker' : '';
}
