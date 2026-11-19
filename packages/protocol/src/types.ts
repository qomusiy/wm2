export type PlaybackStatus = 'playing' | 'paused' | 'waiting';
export type PlaybackAction = 'play' | 'pause' | 'seek' | 'rate' | 'load' | 'wait' | 'resume';
export type WaitReason = 'starting' | 'buffering';

/**
 * Server-authoritative room timeline.
 * For `playing`, media position at server time t is `position + (t - anchor)/1000 * rate`
 * (clamped so it never runs backwards before `anchor`, which supports scheduled starts).
 */
export interface PlaybackState {
  status: PlaybackStatus;
  position: number;
  anchor: number;
  rate: number;
  version: number;
  action: PlaybackAction | null;
  actor: { id: string; name: string } | null;
  waitReason: WaitReason | null;
  waitingFor: string[];
}

export type ParticipantRole = 'host' | 'guest';
export type DeviceKind = 'desktop' | 'mobile' | 'tablet';
export type ClientPlayerState = 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'blocked';

export interface ParticipantInfo {
  id: string;
  name: string;
  color: string;
  role: ParticipantRole;
  connected: boolean;
  joinedAt: number;
  player: ClientPlayerState;
  quality: string | null;
  rtt: number | null;
  device: DeviceKind | null;
  /** Direct-delivery state reported by the viewer (null when it isn't taking part). */
  p2p: ParticipantP2P | null;
}

export interface ParticipantP2P {
  /** Direct connection to the host's computer. */
  host: 'off' | 'connecting' | 'connected' | 'failed';
  /** Other viewers connected directly. */
  peers: number;
  /** Bytes received so far, by source. */
  fromHost: number;
  fromPeers: number;
  fromLink: number;
}

export interface VideoLevelInfo {
  id: string;
  label: string;
  height: number;
  width: number;
  bandwidth: number;
  copy: boolean;
  /** HEVC levels only play where the browser can decode HEVC (players skip them elsewhere). */
  codec: 'h264' | 'hevc';
}

export interface AudioTrackInfo {
  id: string;
  label: string;
  language: string | null;
  default: boolean;
}

export interface SubtitleTrackInfo {
  id: string;
  label: string;
  language: string | null;
  default: boolean;
  forced: boolean;
  /** Where it came from: embedded in the video, or a separate file next to it / added by the host. */
  source: 'embedded' | 'external';
  /** Image-based subtitles (PGS/VobSub) cannot be shown per viewer. */
  status: 'ready' | 'extracting' | 'unsupported' | 'failed';
  url: string | null;
  /** The original ASS/SSA script (styles, positions), when the track has one; `url` is the plain WebVTT version. */
  assUrl: string | null;
}

export interface ThumbnailInfo {
  /** Seconds between thumbnails. */
  interval: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** One URL per sprite sheet; sheet i holds thumbnails [i*columns*rows, (i+1)*columns*rows). */
  sheets: string[];
  count: number;
}

/** A video file on the host's computer, streamed to everyone (HLS, transcoded on demand). */
export interface FileMediaDescriptor {
  kind: 'file';
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  masterUrl: string;
  levels: VideoLevelInfo[];
  audioTracks: AudioTrackInfo[];
  subtitles: SubtitleTrackInfo[];
  thumbnails: ThumbnailInfo | null;
  /** Human-readable source info, e.g. "MKV · H.264 · AC-3 5.1". */
  sourceSummary: string;
}

/**
 * A YouTube video. Every viewer's browser plays it straight from YouTube (official embedded player); the room only
 * keeps everyone on the same moment. Nothing goes through the host's upload.
 */
export interface YouTubeMediaDescriptor {
  kind: 'youtube';
  /** Unique per opening (not the YouTube id), so reopening the same video starts a fresh player. */
  id: string;
  videoId: string;
  title: string;
  author: string | null;
  /** Seconds; null until a viewer's player has reported it. */
  duration: number | null;
  isLive: boolean;
  thumbnail: string;
  /** e.g. "YouTube · Channel name". */
  sourceSummary: string;
}

export type MediaDescriptor = FileMediaDescriptor | YouTubeMediaDescriptor;

/** A link in a chat message, shown as a card (title filled in by the host shortly after). */
/** A YouTube link found in a chat message, looked up by the host (title and channel from YouTube). */
export interface LinkPreview {
  kind: 'youtube';
  videoId: string;
  startAt: number;
  /** pending: being looked up; ok: playable here; unavailable: private, removed or not allowed outside YouTube;
   *  unknown: YouTube couldn't be asked (it may still play). */
  status: 'pending' | 'ok' | 'unavailable' | 'unknown';
  title: string | null;
  author: string | null;
}

export type SystemIcon = 'join' | 'leave' | 'play' | 'pause' | 'seek' | 'rate' | 'video' | 'kick' | 'info' | 'settings' | 'rename';

export type ChatAttachment =
  | { kind: 'image'; url: string; width: number; height: number }
  | { kind: 'sticker'; id: string };

/** A snapshot of the message being answered, so the quote survives edits to history. */
export interface ChatReplyRef {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  /** Up to ~140 characters of the original text ('' for a bare picture or sticker). */
  excerpt: string;
  attachment?: ChatAttachment['kind'];
}

export interface UserChatMessage {
  kind: 'user';
  id: string;
  seq: number;
  ts: number;
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  attachment?: ChatAttachment;
  replyTo?: ChatReplyRef;
  preview?: LinkPreview;
}

export interface SystemChatMessage {
  kind: 'system';
  id: string;
  seq: number;
  ts: number;
  icon: SystemIcon;
  text: string;
  actorId: string | null;
}

export type ChatMessage = UserChatMessage | SystemChatMessage;

export type ControlMode = 'everyone' | 'host';
export type BufferingPolicy = 'wait' | 'continue';

export interface RoomSettings {
  controlMode: ControlMode;
  bufferingPolicy: BufferingPolicy;
  locked: boolean;
  passwordRequired: boolean;
  maxParticipants: number;
  /** Video may travel directly (WebRTC) between the host and viewers and between viewers. */
  p2p: boolean;
}

export interface RoomSnapshot {
  roomId: string;
  participants: ParticipantInfo[];
  playback: PlaybackState;
  media: MediaDescriptor | null;
  chat: ChatMessage[];
  settings: RoomSettings;
  serverTime: number;
}

export interface RoomPreview {
  roomId: string;
  title: string | null;
  duration: number | null;
  hostName: string | null;
  participants: { name: string; color: string }[];
  passwordRequired: boolean;
  locked: boolean;
  full: boolean;
}

export type ErrorCode =
  | 'bad_request'
  | 'room_not_found'
  | 'invalid_key'
  | 'password_required'
  | 'wrong_password'
  | 'room_locked'
  | 'room_full'
  | 'banned'
  | 'kicked'
  | 'not_allowed'
  | 'rate_limited'
  | 'resume_failed'
  | 'protocol_mismatch'
  | 'server_error';
