import { z } from 'zod';
import { LIMITS, PLAYBACK_RATES, REACTIONS, STICKERS } from './constants';

const id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);
const position = z.number().finite().min(0).max(1e7);

export const JoinMessage = z.object({
  type: z.literal('join'),
  protocol: z.number().int(),
  roomId: id,
  key: z.string().max(128).optional(),
  hostToken: z.string().max(128).optional(),
  name: z.string().max(200),
  deviceId: id,
  device: z.enum(['desktop', 'mobile', 'tablet']).optional(),
  password: z.string().max(LIMITS.passwordMax).optional(),
  resume: z.object({ participantId: id, token: z.string().max(128) }).optional(),
});

export const PingMessage = z.object({ type: z.literal('ping'), id: z.number().int(), t0: z.number().finite() });

export const IntentMessage = z.object({
  type: z.literal('intent'),
  action: z.enum(['play', 'pause', 'seek', 'rate']),
  position: position.optional(),
  rate: z.number().refine((r) => (PLAYBACK_RATES as readonly number[]).includes(r), 'unsupported rate').optional(),
  version: z.number().int().min(0),
});

export const ReadyMessage = z.object({
  type: z.literal('ready'),
  version: z.number().int().min(0),
  ready: z.boolean(),
});

export const StatusMessage = z.object({
  type: z.literal('status'),
  player: z.enum(['loading', 'ready', 'playing', 'paused', 'buffering', 'blocked']),
  position: position,
  bufferAhead: z.number().finite().min(0).max(1e5),
  quality: z.string().max(40).nullable(),
  rtt: z.number().finite().min(0).max(60000).nullable(),
  p2p: z.object({
    host: z.enum(['off', 'connecting', 'connected', 'failed']),
    peers: z.number().int().min(0).max(64),
    fromHost: z.number().finite().min(0).max(1e13),
    fromPeers: z.number().finite().min(0).max(1e13),
    fromLink: z.number().finite().min(0).max(1e13),
  }).nullable().optional(),
});

/** WebRTC signalling, relayed by the server to another participant (or handled by the host's own peer). */
export const RtcMessage = z.object({
  type: z.literal('rtc'),
  to: z.union([id, z.literal('@host')]),
  sdp: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(16_000) }).optional(),
  candidate: z.object({ candidate: z.string().max(512), mid: z.string().max(32) }).optional(),
}).refine((m) => (m.sdp === undefined) !== (m.candidate === undefined), 'exactly one of sdp or candidate');

export const ChatSendMessage = z.object({
  type: z.literal('chat'),
  text: z.string().max(LIMITS.chatMax * 2),
  nonce: z.string().max(64),
  attachment: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('image'), id: z.string().regex(/^[A-Za-z0-9]{8,40}$/) }),
    z.object({ kind: z.literal('sticker'), id: z.enum(STICKERS) }),
  ]).optional(),
  replyTo: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
}).refine((m) => m.text.trim().length > 0 || m.attachment !== undefined, 'empty message');

export const TypingMessage = z.object({ type: z.literal('typing'), active: z.boolean() });
export const ReactionMessage = z.object({ type: z.literal('reaction'), emoji: z.enum(REACTIONS) });
export const RenameMessage = z.object({ type: z.literal('rename'), name: z.string().max(200) });

export const KickMessage = z.object({ type: z.literal('kick'), participantId: id });

/** Switch the room to a YouTube video (host, or anyone while everyone may control playback). */
export const OpenYouTubeMessage = z.object({
  type: z.literal('open-youtube'),
  url: z.string().min(1).max(2048),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
});

/** A viewer's YouTube player reporting what YouTube told it about the video (the room learns its length this way). */
export const MediaInfoMessage = z.object({
  type: z.literal('media-info'),
  mediaId: id,
  duration: z.number().finite().min(0).max(30 * 24 * 3600),
  isLive: z.boolean(),
});

export const SettingsMessage = z.object({
  type: z.literal('settings'),
  patch: z.object({
    controlMode: z.enum(['everyone', 'host']).optional(),
    bufferingPolicy: z.enum(['wait', 'continue']).optional(),
    locked: z.boolean().optional(),
    maxParticipants: z.number().int().min(1).max(LIMITS.maxParticipantsHard).optional(),
    password: z.string().max(LIMITS.passwordMax).nullable().optional(),
    p2p: z.boolean().optional(),
  }),
});

export const LeaveMessage = z.object({ type: z.literal('leave') });

export const ClientMessage = z.union([
  JoinMessage, PingMessage, IntentMessage, ReadyMessage, StatusMessage,
  ChatSendMessage, KickMessage, SettingsMessage, LeaveMessage, TypingMessage, ReactionMessage, RenameMessage, RtcMessage,
  OpenYouTubeMessage, MediaInfoMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type JoinMessage = z.infer<typeof JoinMessage>;
export type IntentMessage = z.infer<typeof IntentMessage>;
export type StatusMessage = z.infer<typeof StatusMessage>;
export type SettingsMessage = z.infer<typeof SettingsMessage>;
export type RtcMessage = z.infer<typeof RtcMessage>;

