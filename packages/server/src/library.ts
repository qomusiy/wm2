import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { BufferingPolicy, ControlMode, LinkMode, RecentVideo } from '@watchroom/protocol';
import { LIMITS, isYouTubeVideoId } from '@watchroom/protocol';
import type { Logger } from './util/log';
import { renameRetrySync } from './util/fsx';

export interface RecentEntry {
  id: string;
  /** "file" when absent (entries saved before YouTube support). */
  kind?: 'file' | 'youtube';
  /** File path, or "youtube:<video id>". */
  path: string;
  videoId?: string;
  author?: string | null;
  title: string;
  size: number;
  mtimeMs: number;
  duration: number;
  /** Where the room was when this video was last closed (0 = start, or finished). */
  position: number;
  finished: boolean;
  lastOpened: number;
}

export interface RoomDefaults {
  controlMode: ControlMode;
  bufferingPolicy: BufferingPolicy;
  maxParticipants: number;
  p2p: boolean;
}

interface StoredSettings {
  version: 2;
  linkMode?: LinkMode;
  customBase?: string | null;
  room?: Partial<RoomDefaults>;
  recent?: RecentEntry[];
}

const MAX_RECENT = 12;
/** Positions this close to either end are not worth resuming. */
const RESUME_MIN = 30;
const RESUME_TAIL = 90;

export const recentId = (path: string) => createHash('sha1').update(path).digest('hex').slice(0, 16);
const youtubeKey = (videoId: string) => `youtube:${videoId}`;

/**
 * The host's own preferences and history, kept in `<dataDir>/settings.json` (written atomically). File paths and
 * posters live only here and in the desktop app's private IPC; nothing in this store is ever served over HTTP.
 */
export class HostStore {
  private data: StoredSettings;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir: string, private readonly log: Logger, legacyDir?: string) {
    // Early builds kept settings.json in the cache folder; carry it over once.
    const legacy = legacyDir && legacyDir !== dataDir ? join(legacyDir, 'settings.json') : null;
    if (legacy && !existsSync(this.file) && existsSync(legacy)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        copyFileSync(legacy, this.file);
      } catch (err) {
        log.warn('could not migrate old settings', err);
      }
    }
    this.data = this.load();
  }

  private get file(): string {
    return join(this.dataDir, 'settings.json');
  }

  private load(): StoredSettings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const linkMode = ['tunnel', 'lan', 'custom', 'local'].includes(raw.linkMode as string) ? raw.linkMode as LinkMode : undefined;
      const room = (raw.room && typeof raw.room === 'object' ? raw.room : {}) as Record<string, unknown>;
      const recent = Array.isArray(raw.recent) ? raw.recent.filter(isEntry).slice(0, MAX_RECENT) : [];
      return {
        version: 2,
        linkMode,
        customBase: typeof raw.customBase === 'string' ? raw.customBase : null,
        room: {
          ...(room.controlMode === 'host' || room.controlMode === 'everyone' ? { controlMode: room.controlMode } : {}),
          ...(room.bufferingPolicy === 'wait' || room.bufferingPolicy === 'continue' ? { bufferingPolicy: room.bufferingPolicy } : {}),
          ...(Number.isInteger(room.maxParticipants) && (room.maxParticipants as number) >= 1 && (room.maxParticipants as number) <= LIMITS.maxParticipantsHard
            ? { maxParticipants: room.maxParticipants as number } : {}),
          ...(typeof room.p2p === 'boolean' ? { p2p: room.p2p } : {}),
        },
        recent,
      };
    } catch {
      return { version: 2, recent: [] };
    }
  }

  /** Coalesces bursts of changes into one write. */
  save(immediate = false): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!immediate) {
      this.saveTimer = setTimeout(() => this.save(true), 1500);
      this.saveTimer.unref();
      return;
    }
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameRetrySync(tmp, this.file);
    } catch (err) {
      this.log.warn('could not save settings', err);
    }
  }

  // ---- link
  get linkMode(): LinkMode | undefined { return this.data.linkMode; }
  get customBase(): string | null { return this.data.customBase ?? null; }
  setLink(mode: LinkMode, customBase: string | null): void {
    this.data.linkMode = mode;
    this.data.customBase = customBase;
    this.save(true);
  }

  // ---- room defaults
  get roomDefaults(): Partial<RoomDefaults> { return { ...this.data.room }; }
  setRoomDefaults(d: RoomDefaults): void {
    this.data.room = { ...d };
    this.save();
  }

  // ---- recent videos
  recent(): RecentEntry[] {
    return [...(this.data.recent ?? [])];
  }

  get(id: string): RecentEntry | undefined {
    return this.data.recent?.find((e) => e.id === id);
  }

  /**
   * Records that a video was opened and returns where to resume it (0 when it is new, was changed on disk, was
   * finished, or was stopped near the start).
   */
  opened(path: string, info: { title: string; duration: number }): { entry: RecentEntry; resumeAt: number } {
    const st = statSync(path);
    const id = recentId(path);
    const prev = this.get(id);
    const same = prev && prev.size === st.size && Math.round(prev.mtimeMs) === Math.round(st.mtimeMs);
    const entry: RecentEntry = {
      id, path, title: info.title, size: st.size, mtimeMs: st.mtimeMs, duration: info.duration,
      position: same ? prev.position : 0, finished: same ? prev.finished : false, lastOpened: Date.now(),
    };
    const all = [entry, ...(this.data.recent ?? []).filter((e) => e.id !== id)];
    for (const dropped of all.slice(MAX_RECENT)) this.removePoster(dropped.id);
    this.data.recent = all.slice(0, MAX_RECENT);
    this.save();
    const resumeAt = resumable(entry) ? entry.position : 0;
    return { entry, resumeAt };
  }

  /** Records that a YouTube video was opened; resume works like for files (its length is filled in later). */
  openedYouTube(info: { videoId: string; title: string; author: string | null }): { entry: RecentEntry; resumeAt: number } {
    if (!isYouTubeVideoId(info.videoId)) throw new Error('not a YouTube video id');
    const path = youtubeKey(info.videoId);
    const id = recentId(path);
    const prev = this.get(id);
    const entry: RecentEntry = {
      id, kind: 'youtube', path, videoId: info.videoId, author: info.author, title: info.title, size: 0, mtimeMs: 0,
      duration: prev?.duration ?? 0, position: prev?.position ?? 0, finished: prev?.finished ?? false, lastOpened: Date.now(),
    };
    const all = [entry, ...(this.data.recent ?? []).filter((e) => e.id !== id)];
    for (const dropped of all.slice(MAX_RECENT)) this.removePoster(dropped.id);
    this.data.recent = all.slice(0, MAX_RECENT);
    this.save();
    return { entry, resumeAt: resumable(entry) ? entry.position : 0 };
  }

  /** A YouTube video's length, once a player has reported it. */
  setDuration(id: string, duration: number): void {
    const e = this.get(id);
    if (!e || !Number.isFinite(duration) || duration < 0 || Math.abs(e.duration - duration) < 0.5) return;
    e.duration = duration;
    this.save();
  }

  /** Remembers the room position for the video (called periodically and when the video is closed). */
  progress(id: string, position: number, flush = false): void {
    const e = this.get(id);
    if (!e || !Number.isFinite(position)) return;
    const finished = e.duration > 0 && position >= e.duration - RESUME_TAIL;
    const next = finished ? 0 : Math.max(0, position);
    if (Math.abs(next - e.position) < 1 && finished === e.finished && !flush) return;
    e.position = next;
    // Finished stays true until someone watches it again from somewhere in the middle.
    e.finished = finished || (e.finished && next < RESUME_MIN);
    this.save(flush);
  }

  remove(id: string | null): void {
    const gone = id === null ? this.recent() : this.recent().filter((e) => e.id === id);
    this.data.recent = id === null ? [] : (this.data.recent ?? []).filter((e) => e.id !== id);
    for (const e of gone) this.removePoster(e.id);
    this.save(true);
  }

  posterPath(id: string): string {
    return join(this.dataDir, 'posters', `${id}.jpg`);
  }

  private removePoster(id: string): void {
    rmSync(this.posterPath(id), { force: true });
  }

  /** The list the host's home screen shows, posters inlined (they never travel over the network). */
  async describe(currentId: string | null): Promise<RecentVideo[]> {
    return Promise.all(this.recent().map(async (e) => {
      const youtube = e.kind === 'youtube';
      let missing = false;
      if (!youtube) {
        try {
          const st = statSync(e.path);
          missing = !st.isFile();
        } catch {
          missing = true;
        }
      }
      const poster = await readFile(this.posterPath(e.id)).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`, () => null);
      return {
        id: e.id, kind: youtube ? 'youtube' as const : 'file' as const, title: e.title,
        fileName: youtube ? 'YouTube' : basename(e.path), folder: youtube ? (e.author ?? 'YouTube') : dirname(e.path),
        duration: e.duration, position: resumable(e) ? e.position : 0, finished: e.finished, lastOpened: e.lastOpened, missing,
        current: e.id === currentId, poster,
      };
    }));
  }

  hasPoster(id: string): boolean {
    return existsSync(this.posterPath(id));
  }
}

function resumable(e: RecentEntry): boolean {
  return e.position >= RESUME_MIN && (e.duration <= 0 || e.position < e.duration - RESUME_TAIL);
}

function isEntry(v: unknown): v is RecentEntry {
  const e = v as RecentEntry;
  if (!e || typeof e !== 'object') return false;
  if (e.kind !== undefined && e.kind !== 'file' && e.kind !== 'youtube') return false;
  if (e.kind === 'youtube' && (!isYouTubeVideoId(e.videoId) || e.path !== youtubeKey(e.videoId!))) return false;
  if (e.author !== undefined && e.author !== null && typeof e.author !== 'string') return false;
  return typeof e.id === 'string' && /^[0-9a-f]{16}$/.test(e.id) && typeof e.path === 'string' && e.path.length > 0
    && typeof e.title === 'string' && Number.isFinite(e.size) && Number.isFinite(e.mtimeMs) && Number.isFinite(e.duration)
    && Number.isFinite(e.position) && typeof e.finished === 'boolean' && Number.isFinite(e.lastOpened) && e.id === recentId(e.path);
}
