import type { MediaDescriptor, ParticipantInfo } from './types';

/** State the desktop host UI renders. Delivered over the private Electron IPC channel only. */
export type LinkMode = 'tunnel' | 'lan' | 'custom' | 'local';

/**
 * Where the host's own window (and anything else on this computer) opens the app. "localhost", not 127.0.0.1:
 * YouTube refuses many videos (music, labels) inside pages whose address is a bare IP address.
 */
export const localOrigin = (port: number): string => `http://localhost:${port}`;
export type TunnelState = 'idle' | 'installing' | 'starting' | 'verifying' | 'online' | 'error' | 'stopped';

export interface HostStatus {
  ready: boolean;
  system: {
    ffmpeg: { ok: true; version: string } | { ok: false; error: string } | null;
    encoder: string | null;
    maxJobs: number;
    /** Whether ffmpeg runs isolated from the rest of the computer (bubblewrap). */
    sandbox: { state: 'on' | 'off' | 'disabled' | 'unsupported'; detail: string };
  };
  link: {
    mode: LinkMode;
    /** The link to share right now (null while not available). */
    shareUrl: string | null;
    localUrl: string;
    lanUrls: { label: string; url: string }[];
    customBase: string | null;
    tunnel: { state: TunnelState; url: string | null; error: string | null; detail: string | null };
  };
  media: {
    loading: boolean;
    error: string | null;
    fileName: string | null;
    descriptor: MediaDescriptor | null;
    indexing: boolean;
    indexProgress: number;
    copyAvailable: boolean | null;
    copyReason: string | null;
  };
  /** Changes whenever the recent list does (the list itself is fetched with listRecent). */
  recentVersion: number;
  stats: {
    uploadBps: number;
    /** Upload history, one sample per 2 seconds, oldest first (bit/s). */
    uploadHistory: number[];
    viewers: number;
    runningJobs: number;
    pausedJobs: number;
    /** Viewers connected directly (WebRTC) to this computer right now. */
    directConnections: number;
    /** Whether direct connections can work at all here (the WebRTC library loaded). */
    directAvailable: boolean;
    /** Per participant: current and total bytes sent to them. */
    perViewer: Record<string, { bps: number; bytes: number }>;
  };
  participants: ParticipantInfo[];
}

/** A video on the host's "Recent" list (desktop IPC only: contains local paths and posters). */
export interface RecentVideo {
  id: string;
  kind: 'file' | 'youtube';
  title: string;
  fileName: string;
  folder: string;
  duration: number;
  /** Where to continue from (0 = from the start). */
  position: number;
  finished: boolean;
  lastOpened: number;
  /** The file is no longer where it was. */
  missing: boolean;
  /** This is the video open right now. */
  current: boolean;
  /** Small JPEG as a data: URL, when one has been made. */
  poster: string | null;
}

/** Methods the desktop main process may invoke on the server (never exposed over the network). */
export interface HostRpc {
  getStatus(): HostStatus;
  hostJoin(): { roomId: string; hostToken: string };
  openVideo(path: string): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }>;
  closeVideo(): void;
  setLinkMode(mode: LinkMode, customBase?: string | null): Promise<void>;
  retryTunnel(): Promise<void>;
  regenerateLink(): string | null;
  addSubtitle(path: string): Promise<{ ok: true } | { ok: false; error: string }>;
  listRecent(): Promise<RecentVideo[]>;
  openRecent(id: string, fromStart: boolean): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }>;
  /** Forget one video (or all of them with null). Nothing on disk is touched except our own poster images. */
  removeRecent(id: string | null): void;
}
