/** Wire protocol version. Bump on breaking message changes. */
export const PROTOCOL_VERSION = 1;

/** Nominal HLS segment length (seconds) for transcoded renditions. */
export const SEGMENT_SECONDS = 4;

export const LIMITS = {
  nameMin: 1,
  nameMax: 32,
  chatMax: 2000,
  /** Largest chat image accepted by the server (bytes, after the browser has compressed it). */
  imageMaxBytes: 8 * 1024 * 1024,
  imageMaxDimension: 8192,
  chatHistory: 500,
  maxParticipantsDefault: 8,
  maxParticipantsHard: 32,
  passwordMax: 128,
} as const;

/** Playback speeds offered in the UI. Speed is room-wide. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Direct (WebRTC) delivery of video segments between the host and viewers, and between viewers. */
export const P2P = {
  /** Public STUN servers used to find each side's public address (no media goes through them). */
  stun: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
  /** Data-channel payload per message. 16 KB works with every browser's SCTP stack. */
  chunk: 16 * 1024,
  /** Other viewers a viewer connects to directly (the host is always one extra). */
  maxPeers: 6,
  /** Pseudo participant id of the host's server-side peer. */
  hostPeer: '@host',
} as const;

/** Sync tuning. Shared so server-side tests and the client use the same numbers. */
export const SYNC = {
  /** Drift below this (seconds) is ignored when not already correcting. */
  deadband: 0.08,
  /** While correcting, stop once drift is below this. */
  release: 0.03,
  /** Drift above this triggers a hard seek instead of a rate nudge. */
  hardSeek: 1.0,
  /** Maximum relative playbackRate adjustment while nudging (8%). */
  maxNudge: 0.08,
  /** Proportional gain: rate adjustment per second of drift. */
  gain: 0.5,
  /** How long a "starting" ready-check may hold the room (ms). */
  startTimeoutMs: 5000,
  /** A stall must last this long before the room waits for the stalled viewer (ms). */
  stallGraceMs: 1500,
  /** Longest the room waits for a buffering viewer before continuing (ms). */
  bufferWaitMaxMs: 10000,
  /** A viewer that exhausted the wait is excluded from waits for this long (ms). */
  catchUpExclusionMs: 60000,
  /** Lead time bounds for scheduled starts (ms). */
  minLeadMs: 200,
  maxLeadMs: 1000,
  /** Grace period before a disconnected participant is announced as gone (ms). */
  resumeGraceMs: 30000,
} as const;

/**
 * Sync tuning for YouTube's player: it takes speeds only in 0.05 steps (each nudge corrects at least 50 ms a second,
 * so it stops a little earlier), and a seek costs a moment of loading, so it is the last resort.
 */
export const YOUTUBE_SYNC = {
  deadband: 0.1,
  release: 0.04,
  hardSeek: 1.5,
  /** Pause between corrective seeks (ms). */
  seekCooldownMs: 4000,
  /** Its start takes about this long after the play command (ms); issued that much early. */
  startLatencyMs: 150,
} as const;

export const PARTICIPANT_COLORS = [
  '#4f8cff', '#f2994a', '#3ecf8e', '#e5609a', '#a78bfa',
  '#f5c542', '#2ec4d6', '#ff6b6b', '#8bc34a', '#c084fc',
] as const;

/** Quick reactions that float over the video for everyone. */
export const REACTIONS = ['😂', '❤️', '🔥', '👏', '😮', '😢', '👍', '🎉'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Built-in sticker pack (Microsoft Fluent Emoji 3D, MIT). Files live in the web client at /stickers/<id>.webp. */
export const STICKERS = [
  'popcorn', 'tears-of-joy', 'rofl', 'heart-eyes', 'star-struck', 'screaming', 'loudly-crying', 'crying',
  'thinking', 'open-mouth', 'astonished', 'exploding-head', 'sleeping', 'yawning', 'pleading', 'smirking',
  'rolling-eyes', 'zany', 'partying', 'sunglasses', 'skull', 'ghost', 'clown', 'pouting', 'hand-over-mouth',
  'grimacing', 'nauseated', 'hugging', 'red-heart', 'broken-heart', 'fire', 'hundred', 'party-popper',
  'clapper-board', 'film-projector', 'eyes', 'thumbs-up', 'clapping', 'waving', 'folded-hands', 'sparkles',
  'collision', 'trophy', 'crown', 'rocket', 'pizza', 'hot-beverage', 'soft-ice-cream',
] as const;
export type StickerId = (typeof STICKERS)[number];
