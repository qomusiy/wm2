/*
 * YouTube links: recognising them (in the "open" box and in chat) and turning them into a video id and start time.
 * Strict on purpose: the id must be exactly YouTube's 11-character form and the host must be YouTube's own.
 */

export interface YouTubeRef {
  videoId: string;
  /** Start time from the link (t= / start=), in seconds; 0 when absent. */
  startAt: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const PATH_ID = /^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
const MAX_URL = 2048;

export function isYouTubeVideoId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID.test(id);
}

/** "90", "90s", "1m30s", "1h2m3s", "1:30", "01:02:03" → seconds (0 when unreadable). */
export function parseYouTubeTime(raw: string | null | undefined): number {
  if (!raw) return 0;
  const v = raw.trim().toLowerCase();
  let seconds = 0;
  if (/^\d+(\.\d+)?$/.test(v)) seconds = Number(v);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(v)) seconds = v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(v);
    if (!m || !(m[1] || m[2] || m[3])) return 0;
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return Number.isFinite(seconds) ? Math.min(Math.max(0, Math.floor(seconds)), 7 * 24 * 3600) : 0;
}

function queryParams(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.replace(/^[?#]/, '').split('&')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!key || out.has(key)) continue;
    let value = eq < 0 ? '' : part.slice(eq + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch { /* keep raw */ }
    out.set(key, value);
  }
  return out;
}

/**
 * A YouTube video link → id and start time, or null for anything else. Accepts watch, short (youtu.be), Shorts,
 * embed, live and music links, with or without "https://".
 */
export function parseYouTubeUrl(input: string): YouTubeRef | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text || text.length > MAX_URL || /\s/.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text.replace(/^\/+/, '')}`;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);
  if (!m) return null;
  const host = m[1]!.toLowerCase().replace(/:\d+$/, '').replace(/^[^@]*@/, '');
  if (!HOSTS.has(host)) return null;
  const path = m[2] || '/';
  const query = queryParams(m[3] ?? '');
  const hash = queryParams(m[4] ?? '');
  let videoId: string | null = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = /^\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(path)?.[1];
    if (id) videoId = id;
  } else if (/^\/watch\/?$/.test(path)) {
    const id = query.get('v');
    if (isYouTubeVideoId(id)) videoId = id;
  } else {
    const id = PATH_ID.exec(path)?.[1];
    if (id) videoId = id;
  }
  if (!videoId) return null;
  const startAt = parseYouTubeTime(query.get('t') ?? query.get('start') ?? hash.get('t') ?? null);
  return { videoId, startAt };
}

/** The first YouTube video link in a piece of text (a chat message), if any. */
export function findYouTubeLink(text: string): YouTubeRef | null {
  if (typeof text !== 'string') return null;
  const candidates = text.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube(?:-nocookie)?\.com|youtu\.be)\/[^\s<>"'`]+/gi) ?? [];
  for (const raw of candidates.slice(0, 5)) {
    const ref = parseYouTubeUrl(raw.replace(/[),.!?;:]+$/, ''));
    if (ref) return ref;
  }
  return null;
}

export const youtubeWatchUrl = (videoId: string, startAt = 0): string =>
  `https://www.youtube.com/watch?v=${videoId}${startAt > 0 ? `&t=${Math.floor(startAt)}s` : ''}`;

/** A small thumbnail YouTube publishes for every video (320×180). */
export const youtubeThumbnail = (videoId: string, size: 'mq' | 'hq' = 'mq'): string =>
  `https://i.ytimg.com/vi/${videoId}/${size}default.jpg`;
