import type { HostStatus, LinkMode, MediaDescriptor, RecentVideo } from '@watchroom/protocol';

/** API exposed by the Electron preload script (host app only). */
export interface HostBridge {
  getStatus(): Promise<HostStatus>;
  hostJoin(): Promise<{ roomId: string; hostToken: string }>;
  openVideoDialog(): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string } | null>;
  openVideoFile(file: File): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }>;
  closeVideo(): Promise<void>;
  listRecent(): Promise<RecentVideo[]>;
  openRecent(id: string, fromStart: boolean): Promise<{ ok: true; media: MediaDescriptor } | { ok: false; error: string }>;
  removeRecent(id: string | null): Promise<void>;
  setLinkMode(mode: LinkMode, customBase?: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  retryTunnel(): Promise<void>;
  regenerateLink(): Promise<string | null>;
  addSubtitleDialog(): Promise<{ ok: true } | { ok: false; error: string } | null>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onStatus(cb: (status: HostStatus) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    watchroomHost?: HostBridge;
  }
}

export const bridge: HostBridge | null = typeof window !== 'undefined' ? window.watchroomHost ?? null : null;
