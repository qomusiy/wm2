/*
 * Facts about YouTube videos, from YouTube's public oEmbed service: title and channel, and whether a video can be
 * played on other websites (it answers 401 when the owner disabled embedding or the video is private, 400/404 when
 * it doesn't exist). Only the 11-character video id ever goes into a request (no user-supplied URL is fetched).
 */
import { isYouTubeVideoId, youtubeThumbnail } from '@watchroom/protocol';
import type { Logger } from '../util/log';

export interface YouTubeInfo {
  title: string;
  author: string | null;
}

export type YouTubeLookupResult =
  | { status: 'ok'; info: YouTubeInfo }
  /** Embedding disabled by the owner, private, or age-restricted. */
  | { status: 'unavailable' }
  | { status: 'not-found' }
  /** YouTube didn't answer (offline, blocked, slow): the video may still play. */
  | { status: 'unknown' };

type Fetch = typeof fetch;

const TTL_MS = 60 * 60_000;
const MAX_CACHE = 500;
const TIMEOUT_MS = 8000;

function clean(text: unknown, max: number): string | null {
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = text.normalize('NFC').replace(/[\t\n\r\v\f]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

export class YouTubeLookup {
  private readonly cache = new Map<string, { at: number; result: Promise<YouTubeLookupResult> }>();

  constructor(private readonly log: Logger, private readonly fetchImpl: Fetch = fetch) {}

  lookup(videoId: string): Promise<YouTubeLookupResult> {
    if (!isYouTubeVideoId(videoId)) return Promise.resolve({ status: 'not-found' });
    const hit = this.cache.get(videoId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
    const result = this.fetchInfo(videoId);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(videoId, { at: Date.now(), result });
    // Don't remember "YouTube didn't answer": the next try may work.
    void result.then((r) => { if (r.status === 'unknown') this.cache.delete(videoId); });
    return result;
  }

  private async fetchInfo(videoId: string): Promise<YouTubeLookupResult> {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      const res = await this.fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, {
        headers: { 'User-Agent': 'watchroom-host', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 401 || res.status === 403) return { status: 'unavailable' };
      if (res.status === 400 || res.status === 404) return { status: 'not-found' };
      if (!res.ok) return { status: 'unknown' };
      const text = await res.text();
      if (text.length > 64 * 1024) return { status: 'unknown' };
      const body = JSON.parse(text) as { title?: unknown; author_name?: unknown };
      const title = clean(body.title, 200);
      if (!title) return { status: 'unknown' };
      return { status: 'ok', info: { title, author: clean(body.author_name, 100) } };
    } catch (err) {
      this.log.debug(`YouTube lookup for ${videoId} failed: ${(err as Error).message}`);
      return { status: 'unknown' };
    }
  }

  /** YouTube's small JPEG thumbnail (for the host's recent list), or null. */
  async thumbnail(videoId: string): Promise<Buffer | null> {
    if (!isYouTubeVideoId(videoId)) return null;
    try {
      const res = await this.fetchImpl(youtubeThumbnail(videoId, 'mq'), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      return isJpeg && buf.length < 512 * 1024 ? buf : null;
    } catch {
      return null;
    }
  }
}
