import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION, type ServerMessage, type UserChatMessage, type YouTubeMediaDescriptor,
} from '@watchroom/protocol';
import { WatchroomServer } from '../src/app';
import { HostStore } from '../src/library';
import { YouTubeLookup } from '../src/net/youtube';
import { Room, type Participant, type RoomEvents, type RoomSocket } from '../src/room/room';
import { createLogger } from '../src/util/log';

const log = createLogger('test');
const VIDEO = 'M7lc1UVf-VE';

class FakeSocket implements RoomSocket {
  sent: ServerMessage[] = [];
  send(msg: ServerMessage) { this.sent.push(msg); }
  close() {}
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

const ytMedia = (patch: Partial<YouTubeMediaDescriptor> = {}): YouTubeMediaDescriptor => ({
  kind: 'youtube', id: 'yt1', videoId: VIDEO, title: 'A talk', author: 'Google for Developers', duration: null, isLive: false,
  thumbnail: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`, sourceSummary: 'YouTube · Google for Developers', ...patch,
});

/** Lets a test finish pending promise callbacks while fake timers are on. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('YouTube in the room', () => {
  let room: Room;
  let seq = 0;
  const join = (name: string, host = false) => {
    const socket = new FakeSocket();
    const res = room.join(socket, {
      type: 'join', protocol: PROTOCOL_VERSION, roomId: room.id, name, deviceId: `dev-${++seq}`,
      ...(host ? { hostToken: room.hostToken } : { key: room.key }),
    });
    if (!res.ok) throw new Error(res.code);
    return { socket, p: res.participant as Participant };
  };
  const make = (events: RoomEvents) => {
    room = new Room(log, events);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
  });
  afterEach(() => {
    room.end('test over');
    vi.useRealTimers();
  });

  it('lets the host open a link; guests only while everyone controls playback; rate-limits', async () => {
    const opened: string[] = [];
    make({ openYouTube: async (url) => { opened.push(url); return { ok: true }; } });
    const host = join('Host', true);
    const guest = join('Guest');
    room.handle(host.p, { type: 'settings', patch: { controlMode: 'host' } });
    room.handle(guest.p, { type: 'open-youtube', url: `https://youtu.be/${VIDEO}`, requestId: 'g1' });
    await settle();
    expect(guest.socket.last('open-result')).toMatchObject({ requestId: 'g1', ok: false });
    expect(opened).toHaveLength(0);
    room.handle(host.p, { type: 'open-youtube', url: `https://youtu.be/${VIDEO}`, requestId: 'h1' });
    await settle();
    expect(host.socket.last('open-result')).toEqual({ type: 'open-result', requestId: 'h1', ok: true });
    room.handle(host.p, { type: 'settings', patch: { controlMode: 'everyone' } });
    room.handle(guest.p, { type: 'open-youtube', url: `https://youtu.be/${VIDEO}`, requestId: 'g2' });
    await settle();
    expect(guest.socket.last('open-result')).toMatchObject({ requestId: 'g2', ok: true });
    // A burst of switches is refused politely.
    for (let i = 0; i < 6; i++) room.handle(guest.p, { type: 'open-youtube', url: `https://youtu.be/${VIDEO}`, requestId: `b${i}` });
    await settle();
    const refused = guest.socket.sent.filter((m) => m.type === 'open-result' && !m.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(opened.length).toBeLessThanOrEqual(4);
  });

  it('passes the host\'s error back to the one who asked', async () => {
    make({ openYouTube: async () => ({ ok: false, error: 'That YouTube video does not exist, or it is private.' }) });
    const host = join('Host', true);
    room.handle(host.p, { type: 'open-youtube', url: 'https://youtu.be/aaaaaaaaaaa', requestId: 'x' });
    await settle();
    expect(host.socket.last('open-result')).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
  });

  it('learns the length from the players: first report wins, the host may correct it, junk is ignored', () => {
    const infos: YouTubeMediaDescriptor[] = [];
    make({ mediaInfo: (m) => infos.push(m) });
    const host = join('Host', true);
    const a = join('A');
    const b = join('B');
    room.setMedia(ytMedia());
    room.handle(a.p, { type: 'media-info', mediaId: 'other', duration: 50, isLive: false });
    expect((room.media as YouTubeMediaDescriptor).duration).toBeNull();
    room.handle(a.p, { type: 'media-info', mediaId: 'yt1', duration: 1344.2, isLive: false });
    expect((room.media as YouTubeMediaDescriptor).duration).toBeCloseTo(1344.2);
    expect(b.socket.last('media')?.media).toMatchObject({ duration: 1344.2 });
    room.handle(b.p, { type: 'media-info', mediaId: 'yt1', duration: 12, isLive: false });
    expect((room.media as YouTubeMediaDescriptor).duration).toBeCloseTo(1344.2);
    room.handle(host.p, { type: 'media-info', mediaId: 'yt1', duration: 1343.661, isLive: false });
    expect((room.media as YouTubeMediaDescriptor).duration).toBeCloseTo(1343.661);
    expect(infos).toHaveLength(2);
  });

  it('pauses at the end once the length is known', () => {
    make({});
    const host = join('Host', true);
    room.setMedia(ytMedia({ duration: 20 }));
    room.handle(host.p, { type: 'intent', action: 'play', version: room.playback.version });
    vi.advanceTimersByTime(6000); // ready-check timeout, then playing
    expect(room.playback.status).toBe('playing');
    vi.advanceTimersByTime(25_000);
    expect(room.playback.status).toBe('paused');
    expect(room.playback.position).toBeCloseTo(20, 1);
  });

  it('treats a live stream as play/pause only', () => {
    make({});
    const host = join('Host', true);
    room.setMedia(ytMedia());
    room.handle(host.p, { type: 'media-info', mediaId: 'yt1', duration: 0, isLive: true });
    expect(room.media).toMatchObject({ isLive: true, duration: null });
    const before = room.playback.version;
    room.handle(host.p, { type: 'intent', action: 'seek', position: 120, version: room.playback.version });
    expect(room.playback.version).toBe(before);
    expect(room.playback.position).toBe(0);
  });

  it('starts at the link\'s time without the "continuing" note, and says when it resumes', () => {
    make({});
    const host = join('Host', true);
    room.setMedia(ytMedia(), 'Host', 95, 'link');
    expect(room.playback.position).toBe(95);
    expect(host.socket.sent.some((m) => m.type === 'chat' && m.message.text.startsWith('Continuing from'))).toBe(false);
    room.setMedia(ytMedia({ id: 'yt2' }), 'Host', 200, 'resume');
    expect(host.socket.sent.some((m) => m.type === 'chat' && m.message.text.startsWith('Continuing from 3:20'))).toBe(true);
    // A start beyond the known end is ignored.
    room.setMedia(ytMedia({ id: 'yt3', duration: 60 }), 'Host', 90, 'link');
    expect(room.playback.position).toBe(0);
  });

  it('attaches a preview to chat messages with a YouTube link and fills it in', async () => {
    const looked: string[] = [];
    make({
      lookupYouTube: async (id) => {
        looked.push(id);
        return id === VIDEO ? { status: 'ok', title: 'A talk', author: 'Google for Developers' } : { status: 'unavailable' };
      },
    });
    const host = join('Host', true);
    const guest = join('Guest');
    room.handle(guest.p, { type: 'chat', text: `look https://www.youtube.com/watch?v=${VIDEO}&t=1m5s !`, nonce: 'n1' });
    const msg = host.socket.last('chat')!.message as UserChatMessage;
    expect(msg.preview).toEqual({ kind: 'youtube', videoId: VIDEO, startAt: 65, status: 'pending', title: null, author: null });
    await settle();
    expect(host.socket.last('chat-preview')).toEqual({
      type: 'chat-preview', messageId: msg.id,
      preview: { kind: 'youtube', videoId: VIDEO, startAt: 65, status: 'ok', title: 'A talk', author: 'Google for Developers' },
    });
    // Late joiners get the filled preview with the history.
    expect((room.snapshot().chat.find((m) => m.id === msg.id) as UserChatMessage).preview?.status).toBe('ok');

    room.handle(guest.p, { type: 'chat', text: 'https://youtu.be/aaaaaaaaaaa', nonce: 'n2' });
    await settle();
    expect(host.socket.last('chat-preview')?.preview).toMatchObject({ status: 'unavailable', title: null });
    room.handle(guest.p, { type: 'chat', text: 'no links here, just youtube.com', nonce: 'n3' });
    expect((host.socket.last('chat')!.message as UserChatMessage).preview).toBeUndefined();
    expect(looked).toEqual([VIDEO, 'aaaaaaaaaaa']);
  });
});

describe('YouTubeLookup', () => {
  const reply = (status: number, body: unknown = '') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('reads the title and channel, and maps YouTube\'s answers', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const id = new URL(new URL(u).searchParams.get('url')!).searchParams.get('v');
      if (id === 'okokokokokA') return reply(200, { title: '  A‮title\n with\tspace  ', author_name: 'Channel\u0007' });
      if (id === 'privateVid1') return reply(401, 'Unauthorized');
      if (id === 'missingVid1') return reply(404, 'Not Found');
      if (id === 'brokenVid11') return reply(500, 'oops');
      if (id === 'garbageVid1') return reply(200, '<html>');
      throw new Error('offline');
    }) as typeof fetch;
    const yt = new YouTubeLookup(log, fetchImpl);
    expect(await yt.lookup('okokokokokA')).toEqual({ status: 'ok', info: { title: 'Atitle with space', author: 'Channel' } });
    expect(await yt.lookup('privateVid1')).toEqual({ status: 'unavailable' });
    expect(await yt.lookup('missingVid1')).toEqual({ status: 'not-found' });
    expect(await yt.lookup('brokenVid11')).toEqual({ status: 'unknown' });
    expect(await yt.lookup('garbageVid1')).toEqual({ status: 'unknown' });
    expect(await yt.lookup('offlineVid1')).toEqual({ status: 'unknown' });
    // Only well-formed ids are ever sent, and only inside YouTube's own oEmbed URL.
    expect(await yt.lookup('../etc/passwd')).toEqual({ status: 'not-found' });
    expect(calls.every((u) => u.startsWith('https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D'))).toBe(true);
  });

  it('remembers answers, but asks again after a failure', async () => {
    let n = 0;
    let online = false;
    const yt = new YouTubeLookup(log, (async () => {
      n++;
      if (!online) throw new Error('offline');
      return reply(200, { title: 'T', author_name: 'A' });
    }) as typeof fetch);
    expect((await yt.lookup('okokokokokA')).status).toBe('unknown');
    online = true;
    expect((await yt.lookup('okokokokokA')).status).toBe('ok');
    expect((await yt.lookup('okokokokokA')).status).toBe('ok');
    expect(n).toBe(2);
  });

  it('accepts only a small JPEG as a thumbnail', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const yt = new YouTubeLookup(log, (async (url: string | URL | Request) => {
      if (String(url).includes('okokokokokA')) return new Response(jpeg, { status: 200 });
      return new Response('<svg/>', { status: 200 });
    }) as typeof fetch);
    expect((await yt.thumbnail('okokokokokA'))?.length).toBe(jpeg.length);
    expect(await yt.thumbnail('notajpegVid')).toBeNull();
    expect(await yt.thumbnail('bad id')).toBeNull();
  });
});

describe('opening YouTube videos on the host', () => {
  const oembed = (async (url: string | URL | Request) => {
    const id = new URL(new URL(String(url)).searchParams.get('url') ?? 'https://x/?v=').searchParams.get('v');
    if (String(url).includes('i.ytimg.com')) return new Response('nope', { status: 404 });
    if (id === VIDEO) return new Response(JSON.stringify({ title: 'A talk', author_name: 'Google for Developers' }), { status: 200 });
    if (id === 'privateVid1') return new Response('Unauthorized', { status: 401 });
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  const server = () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-yt-'));
    return new WatchroomServer({ staticDir: null, dataDir: dir, linkMode: 'local', log, fetch: oembed });
  };

  it('opens a link for the room and remembers it with its position', async () => {
    const s = server();
    const r = await s.openYouTube(`https://www.youtube.com/watch?v=${VIDEO}&t=42`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.media).toMatchObject({ kind: 'youtube', videoId: VIDEO, title: 'A talk', author: 'Google for Developers', duration: null });
    expect(s.room.media).toBe(r.media);
    expect(s.room.playback.position).toBe(42);
    const recent = await s.listRecent();
    expect(recent[0]).toMatchObject({ kind: 'youtube', title: 'A talk', folder: 'Google for Developers', current: true });
  });

  it('explains links that can\'t be played', async () => {
    const s = server();
    expect(await s.openYouTube('https://example.com/watch?v=M7lc1UVf-VE')).toMatchObject({ ok: false, error: expect.stringContaining('not a YouTube') });
    expect(await s.openYouTube('https://youtu.be/missingVid1')).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
    expect(await s.openYouTube('https://youtu.be/privateVid1')).toMatchObject({ ok: false, error: expect.stringContaining('does not allow') });
    expect(s.room.media).toBeNull();
  });
});

describe('recent YouTube videos', () => {
  it('records, resumes and validates YouTube entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-yt-store-'));
    const store = () => new HostStore(join(dir, 'data'), log);
    const s = store();
    const { entry, resumeAt } = s.openedYouTube({ videoId: VIDEO, title: 'A talk', author: 'Channel' });
    expect(resumeAt).toBe(0);
    s.setDuration(entry.id, 1343.6);
    s.progress(entry.id, 600, true);
    const again = store().openedYouTube({ videoId: VIDEO, title: 'A talk', author: 'Channel' });
    expect(again.resumeAt).toBe(600);
    expect(again.entry.duration).toBeCloseTo(1343.6);
    expect(() => s.openedYouTube({ videoId: 'not an id', title: 'x', author: null })).toThrow();
  });
});
