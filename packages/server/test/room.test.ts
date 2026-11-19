import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, SYNC, expectedPosition, type FileMediaDescriptor, type ServerMessage, type StatusMessage } from '@watchroom/protocol';
import { Room, type Participant, type RoomSocket } from '../src/room/room';
import { createLogger } from '../src/util/log';

class FakeSocket implements RoomSocket {
  sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage) { this.sent.push(msg); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
  all<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

const media: FileMediaDescriptor = {
  kind: 'file', id: 'media1', title: 'Movie', duration: 600, width: 1920, height: 1080, masterUrl: '/media/media1/master.m3u8',
  levels: [], audioTracks: [], subtitles: [], thumbnails: null, sourceSummary: 'MKV',
};

let room: Room;
let seq = 0;
const log = createLogger('test');

function join(name: string, opts: { host?: boolean; key?: string; device?: string; password?: string } = {}) {
  const socket = new FakeSocket();
  const res = room.join(socket, {
    type: 'join', protocol: PROTOCOL_VERSION, roomId: room.id, name, deviceId: opts.device ?? `device-${++seq}`,
    ...(opts.host ? { hostToken: room.hostToken } : { key: opts.key ?? room.key }),
    ...(opts.password ? { password: opts.password } : {}),
  });
  return { socket, res, p: res.ok ? res.participant : (null as unknown as Participant) };
}

function status(p: Participant, player: StatusMessage['player'], position = 0) {
  room.handle(p, { type: 'status', player, position, bufferAhead: 10, quality: '720p', rtt: 80 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  room = new Room(log);
});
afterEach(() => {
  room.end('test over');
  vi.useRealTimers();
});

describe('joining', () => {
  it('accepts the room key, rejects others, and gives the host token the host role', () => {
    expect(join('Host', { host: true }).p.info.role).toBe('host');
    expect(join('Aziz').p.info.role).toBe('guest');
    const bad = join('Eve', { key: 'wrong' });
    expect(bad.res.ok).toBe(false);
    if (!bad.res.ok) expect(bad.res.code).toBe('invalid_key');
  });

  it('deduplicates names and sanitises them', () => {
    join('Aziz');
    expect(join(' aziz ').p.info.name).toBe('aziz 2');
    expect(join('Bob‮').p.info.name).toBe('Bob');
  });

  it('enforces passwords, locks and bans; the host is exempt', () => {
    const host = join('Host', { host: true });
    room.handle(host.p, { type: 'settings', patch: { password: 'secret' } });
    expect(join('A').res).toMatchObject({ ok: false, code: 'password_required' });
    expect(join('A', { password: 'nope' }).res).toMatchObject({ ok: false, code: 'wrong_password' });
    const a = join('A', { password: 'secret', device: 'dev-a' });
    expect(a.res.ok).toBe(true);
    room.handle(host.p, { type: 'kick', participantId: a.p.info.id });
    expect(a.socket.last('kicked')).toBeDefined();
    expect(join('A', { password: 'secret', device: 'dev-a' }).res).toMatchObject({ ok: false, code: 'banned' });
    room.handle(host.p, { type: 'settings', patch: { locked: true } });
    expect(join('C', { password: 'secret' }).res).toMatchObject({ ok: false, code: 'room_locked' });
    expect(join('Host 2', { host: true }).res.ok).toBe(true);
  });

  it('only lets the host kick or change settings', () => {
    join('Host', { host: true });
    const a = join('A');
    const b = join('B');
    room.handle(a.p, { type: 'kick', participantId: b.p.info.id });
    expect(room.participants.has(b.p.info.id)).toBe(true);
    expect(a.socket.last('error')?.code).toBe('not_allowed');
  });

  it('resumes a session within the grace period without leave/join messages', () => {
    const a = join('A');
    const b = join('B');
    room.disconnect(a.p, a.socket);
    vi.advanceTimersByTime(SYNC.resumeGraceMs - 1000);
    const again = new FakeSocket();
    const res = room.join(again, {
      type: 'join', protocol: PROTOCOL_VERSION, roomId: room.id, key: room.key, name: 'A', deviceId: 'whatever',
      resume: { participantId: a.p.info.id, token: a.p.token },
    });
    expect(res).toMatchObject({ ok: true, resumed: true });
    vi.advanceTimersByTime(5000);
    const texts = b.socket.all('chat').map((m) => m.message.text);
    expect(texts.some((t) => t.includes('A left'))).toBe(false);
  });

  it('announces a leave once the grace period expires', () => {
    const a = join('A');
    const b = join('B');
    room.disconnect(a.p, a.socket);
    vi.advanceTimersByTime(SYNC.resumeGraceMs + 10);
    expect(room.participants.has(a.p.info.id)).toBe(false);
    expect(b.socket.all('chat').map((m) => m.message.text)).toContain('A left');
  });
});

describe('synchronized playback', () => {
  let host: ReturnType<typeof join>;
  let guest: ReturnType<typeof join>;

  beforeEach(() => {
    host = join('Host', { host: true });
    guest = join('Guest');
    room.setMedia(media);
    status(host.p, 'paused');
    status(guest.p, 'paused');
  });

  it('starts only when everyone is ready, at a scheduled time in the future', () => {
    room.handle(guest.p, { type: 'intent', action: 'play', version: room.playback.version });
    expect(room.playback.status).toBe('waiting');
    expect(room.playback.waitReason).toBe('starting');
    expect(new Set(room.playback.waitingFor)).toEqual(new Set([host.p.info.id, guest.p.info.id]));
    const v = room.playback.version;
    room.handle(host.p, { type: 'ready', version: v, ready: true });
    expect(room.playback.status).toBe('waiting');
    expect(room.playback.waitingFor).toEqual([guest.p.info.id]);
    expect(room.playback.version).toBe(v); // readiness updates don't invalidate other reports
    room.handle(guest.p, { type: 'ready', version: v, ready: true });
    expect(room.playback.status).toBe('playing');
    expect(room.playback.anchor).toBeGreaterThan(Date.now());
    expect(room.playback.anchor - Date.now()).toBeGreaterThanOrEqual(SYNC.minLeadMs);
  });

  it('ignores readiness for an outdated version', () => {
    room.handle(guest.p, { type: 'intent', action: 'play', version: 0 });
    const v = room.playback.version;
    room.handle(host.p, { type: 'ready', version: v - 1, ready: true });
    expect(room.playback.waitingFor).toContain(host.p.info.id);
  });

  it('starts anyway after the start timeout', () => {
    room.handle(host.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    expect(room.playback.status).toBe('playing');
  });

  it('pauses at the actor position (clamped near the timeline) for everyone', () => {
    room.handle(host.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    vi.advanceTimersByTime(10_000);
    room.handle(guest.p, { type: 'intent', action: 'pause', position: 9.5, version: room.playback.version });
    expect(room.playback.status).toBe('paused');
    expect(room.playback.position).toBeCloseTo(9.5, 3);
    expect(host.socket.last('playback')?.playback.status).toBe('paused');
    room.handle(guest.p, { type: 'intent', action: 'play', version: room.playback.version });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    vi.advanceTimersByTime(2000);
    const exp = expectedPosition(room.playback, Date.now(), media.duration);
    room.handle(guest.p, { type: 'intent', action: 'pause', position: 500, version: room.playback.version });
    expect(room.playback.position).toBeCloseTo(exp + 1, 3); // absurd positions are clamped to the timeline
  });

  it('seeks while paused without starting, and re-syncs a start when seeking while playing', () => {
    room.handle(guest.p, { type: 'intent', action: 'seek', position: 120, version: 0 });
    expect(room.playback).toMatchObject({ status: 'paused', position: 120, action: 'seek' });
    room.handle(guest.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    room.handle(host.p, { type: 'intent', action: 'seek', position: 300, version: room.playback.version });
    expect(room.playback).toMatchObject({ status: 'waiting', position: 300, waitReason: 'starting' });
  });

  it('re-anchors on rate changes without jumping', () => {
    room.handle(host.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    vi.advanceTimersByTime(4000);
    const before = room.playback;
    room.handle(guest.p, { type: 'intent', action: 'rate', rate: 1.5, version: before.version });
    expect(room.playback.rate).toBe(1.5);
    expect(room.playback.status).toBe('playing');
    expect(room.playback.anchor).toBe(Date.now());
  });

  it('holds the room for a buffering viewer, then resumes when they are ready', () => {
    room.handle(host.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    vi.advanceTimersByTime(20_000);
    status(host.p, 'playing', 20);
    status(guest.p, 'buffering', 18.5);
    vi.advanceTimersByTime(SYNC.stallGraceMs + 10);
    expect(room.playback).toMatchObject({ status: 'waiting', waitReason: 'buffering' });
    expect(room.playback.position).toBeCloseTo(18.5, 1);
    const v = room.playback.version;
    room.handle(host.p, { type: 'ready', version: v, ready: true });
    room.handle(guest.p, { type: 'ready', version: v, ready: true });
    expect(room.playback).toMatchObject({ status: 'playing', action: 'resume' });
  });

  it('does not let a chronically slow viewer hold the room forever', () => {
    room.handle(host.p, { type: 'intent', action: 'play', version: 0 });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    status(guest.p, 'buffering', 5);
    vi.advanceTimersByTime(SYNC.stallGraceMs + 10);
    expect(room.playback.status).toBe('waiting');
    status(host.p, 'paused', 5);
    room.handle(host.p, { type: 'ready', version: room.playback.version, ready: true });
    vi.advanceTimersByTime(SYNC.bufferWaitMaxMs + 10);
    expect(room.playback.status).toBe('playing');
    // The same viewer stalls again right away: the room keeps playing (catch-up exclusion).
    status(guest.p, 'playing', 6);
    status(guest.p, 'buffering', 6);
    vi.advanceTimersByTime(SYNC.stallGraceMs + 10);
    expect(room.playback.status).toBe('playing');
  });

  it('pauses the room at the end of the video', () => {
    room.handle(host.p, { type: 'intent', action: 'seek', position: 590, version: room.playback.version });
    room.handle(host.p, { type: 'intent', action: 'play', version: room.playback.version });
    vi.advanceTimersByTime(SYNC.startTimeoutMs + 1);
    expect(room.playback.status).toBe('playing');
    vi.advanceTimersByTime(11_000);
    expect(room.playback).toMatchObject({ status: 'paused', position: media.duration });
    expect(guest.socket.all('chat').map((m) => m.message.text)).toContain('The video ended');
    // Play at the end starts over.
    room.handle(guest.p, { type: 'intent', action: 'play', version: room.playback.version });
    expect(room.playback.position).toBe(0);
  });

  it('respects host-only control mode', () => {
    room.handle(host.p, { type: 'settings', patch: { controlMode: 'host' } });
    room.handle(guest.p, { type: 'intent', action: 'play', version: 0 });
    expect(room.playback.status).toBe('paused');
    expect(guest.socket.last('error')?.code).toBe('not_allowed');
  });

  it('announces actions in chat and coalesces rapid seeks', () => {
    for (const pos of [10, 20, 30, 40]) room.handle(guest.p, { type: 'intent', action: 'seek', position: pos, version: 0 });
    vi.advanceTimersByTime(1500);
    const seeks = host.socket.all('chat').filter((m) => m.message.kind === 'system' && m.message.icon === 'seek');
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.message.text).toBe('Guest jumped to 0:40');
  });
});

describe('phase 2 room features', () => {
  it('renames without duplicates and announces it', () => {
    const a = join('Aziz');
    const b = join('Bob');
    room.handle(a.p, { type: 'rename', name: 'Bob' });
    expect(a.p.info.name).toBe('Bob 2');
    vi.advanceTimersByTime(200);
    expect(b.socket.all('chat').map((m) => m.message.text)).toContain('Aziz is now Bob 2');
    expect(b.socket.last('participants')?.participants.find((p) => p.id === a.p.info.id)?.name).toBe('Bob 2');
  });

  it('broadcasts typing to others and expires it on its own', () => {
    const a = join('A');
    const b = join('B');
    room.handle(a.p, { type: 'typing', active: true });
    expect(b.socket.last('typing')).toMatchObject({ participantId: a.p.info.id, active: true });
    expect(a.socket.all('typing')).toHaveLength(0);
    vi.advanceTimersByTime(6500);
    expect(b.socket.last('typing')).toMatchObject({ participantId: a.p.info.id, active: false });
  });

  it('stops typing when the message is sent', () => {
    const a = join('A');
    const b = join('B');
    room.handle(a.p, { type: 'typing', active: true });
    room.handle(a.p, { type: 'chat', text: 'hi', nonce: 'n' });
    expect(b.socket.last('typing')).toMatchObject({ active: false });
  });

  it('broadcasts reactions to everyone and rate-limits floods', () => {
    const a = join('A');
    const b = join('B');
    for (let i = 0; i < 30; i++) room.handle(a.p, { type: 'reaction', emoji: '🔥' });
    const got = b.socket.all('reaction');
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(15);
    expect(a.socket.all('reaction').length).toBe(got.length);
  });

  it('sends stickers', () => {
    const a = join('A');
    room.handle(a.p, { type: 'chat', text: '', nonce: 'n', attachment: { kind: 'sticker', id: 'popcorn' } });
    expect(a.socket.last('chat')?.message).toMatchObject({ kind: 'user', attachment: { kind: 'sticker', id: 'popcorn' } });
  });

  it('refuses image attachments that do not exist (no image store, or not yours)', () => {
    const a = join('A');
    room.handle(a.p, { type: 'chat', text: '', nonce: 'n', attachment: { kind: 'image', id: 'AAAAAAAAAAAA' } });
    expect(a.socket.all('chat').filter((m) => m.message.kind === 'user')).toHaveLength(0);
    expect(a.socket.last('error')?.code).toBe('not_allowed');
  });

  it('announces setting changes and updates media without resetting playback', () => {
    const host = join('Host', { host: true });
    const g = join('G');
    room.setMedia(media);
    room.handle(host.p, { type: 'settings', patch: { controlMode: 'host', locked: true } });
    const texts = g.socket.all('chat').map((m) => m.message.text);
    expect(texts).toContain('Host made playback controls host-only');
    expect(texts).toContain('Host locked the room');
    room.handle(host.p, { type: 'intent', action: 'seek', position: 42, version: room.playback.version });
    const before = room.playback;
    room.updateMedia({ ...media, subtitles: [{ id: 's0', label: 'English', language: 'eng', default: false, forced: false, source: 'embedded', status: 'ready', url: '/x', assUrl: null }] });
    expect(room.playback).toBe(before);
    expect((g.socket.last('media')?.media as FileMediaDescriptor | undefined)?.subtitles).toHaveLength(1);
  });
});

describe('flood protection', () => {
  it('answers a flood with an occasional notice, then disconnects a sustained flooder and frees the seat', () => {
    const host = join('Host', { host: true });
    const a = join('Ana');
    for (let i = 0; i < 200; i++) room.handle(a.p, { type: 'typing', active: i % 2 === 0 });
    expect(a.socket.all('error').filter((e) => e.code === 'rate_limited').length).toBe(1);
    expect(room.participants.has(a.p.info.id)).toBe(true);
    for (let i = 0; i < 400; i++) room.handle(a.p, { type: 'typing', active: true });
    expect(room.participants.has(a.p.info.id)).toBe(false);
    expect(a.socket.closed).toBeTruthy();
    expect(host.socket.all('chat').map((m) => m.message.text)).toContain('Ana was disconnected (sending too much)');
  });
});

describe('direct connection signalling', () => {
  const offer = { type: 'offer' as const, sdp: 'v=0' };
  it('relays between viewers only, hands host-bound messages to the host peer, and stops when turned off', () => {
    const toHost: string[] = [];
    room.end('replace');
    room = new Room(log, { rtcToHost: (p) => toHost.push(p.info.name) });
    const host = join('Host', { host: true });
    const a = join('Ana');
    const b = join('Ben');
    room.handle(a.p, { type: 'rtc', to: b.p.info.id, sdp: offer });
    expect(b.socket.last('rtc')).toEqual({ type: 'rtc', from: a.p.info.id, sdp: offer });
    room.handle(a.p, { type: 'rtc', to: host.p.info.id, sdp: offer }); // never to the host's own browser
    room.handle(host.p, { type: 'rtc', to: a.p.info.id, sdp: offer }); // nor from it
    expect(host.socket.all('rtc')).toHaveLength(0);
    expect(a.socket.all('rtc')).toHaveLength(0);
    room.handle(a.p, { type: 'rtc', to: '@host', sdp: offer });
    room.handle(host.p, { type: 'rtc', to: '@host', sdp: offer });
    expect(toHost).toEqual(['Ana']);
    room.handle(host.p, { type: 'settings', patch: { p2p: false } });
    room.handle(a.p, { type: 'rtc', to: b.p.info.id, sdp: offer });
    room.handle(a.p, { type: 'rtc', to: '@host', sdp: offer });
    expect(b.socket.all('rtc')).toHaveLength(1);
    expect(toHost).toHaveLength(1);
    expect(host.socket.all('chat').map((m) => m.message.text)).toContain('Host turned off direct connections; video now comes through the link only');
  });

  it('rate-limits signalling floods', () => {
    const a = join('Ana');
    const b = join('Ben');
    for (let i = 0; i < 500; i++) room.handle(a.p, { type: 'rtc', to: b.p.info.id, candidate: { candidate: `candidate:${i}`, mid: '0' } });
    expect(b.socket.all('rtc').length).toBeLessThan(200);
  });

  it('keeps what viewers report about their connections and tells the room when it matters', () => {
    const host = join('Host', { host: true });
    const a = join('Ana');
    vi.advanceTimersByTime(500);
    const before = host.socket.all('participants').length;
    const p2p = { host: 'connected' as const, peers: 1, fromHost: 5e6, fromPeers: 2e6, fromLink: 1e5 };
    room.handle(a.p, { type: 'status', player: 'playing', position: 1, bufferAhead: 10, quality: '480p', rtt: 50, p2p });
    vi.advanceTimersByTime(500);
    expect(host.socket.all('participants').length).toBe(before + 1);
    expect(host.socket.last('participants')!.participants.find((p) => p.name === 'Ana')!.p2p).toEqual(p2p);
    room.handle(a.p, { type: 'status', player: 'playing', position: 3, bufferAhead: 10, quality: '480p', rtt: 50, p2p: { ...p2p, fromHost: 5.2e6 } });
    vi.advanceTimersByTime(500);
    expect(host.socket.all('participants').length).toBe(before + 1); // under a megabyte of change: no broadcast
  });
});

describe('host preferences and resuming', () => {
  it('opens a video at a saved position and says so', () => {
    const host = join('Host', { host: true });
    room.setMedia(media, 'Host', 345);
    expect(room.playback).toMatchObject({ status: 'paused', position: 345 });
    const texts = host.socket.all('chat').map((m) => m.message.text);
    expect(texts.some((t) => t.startsWith('Continuing from 5:45'))).toBe(true);
    room.setMedia(media, 'Host', 99999); // past the end: start over
    expect(room.playback.position).toBe(0);
  });

  it('applies saved defaults quietly and reports changes made by the host', () => {
    const changes: unknown[] = [];
    room.end('replace');
    room = new Room(log, { settingsChanged: (s) => changes.push(s) });
    room.applyDefaults({ controlMode: 'host', bufferingPolicy: 'continue', maxParticipants: 500 });
    expect(room.publicSettings()).toMatchObject({ controlMode: 'host', bufferingPolicy: 'continue', maxParticipants: 32 });
    const host = join('Host', { host: true });
    expect(host.socket.all('chat').filter((m) => m.message.kind === 'system' && m.message.icon === 'settings')).toHaveLength(0);
    room.handle(host.p, { type: 'settings', patch: { controlMode: 'everyone' } });
    expect(changes).toEqual([expect.objectContaining({ controlMode: 'everyone' })]);
  });
});

describe('chat', () => {
  it('sanitises, broadcasts with the sender nonce, and rate-limits floods', () => {
    const a = join('A');
    const b = join('B');
    room.handle(a.p, { type: 'chat', text: '  hello\u0007 ', nonce: 'n1' });
    const msg = b.socket.last('chat');
    expect(msg?.message).toMatchObject({ kind: 'user', text: 'hello', authorName: 'A' });
    expect(msg?.nonce).toBe('n1');
    for (let i = 0; i < 20; i++) room.handle(a.p, { type: 'chat', text: `spam ${i}`, nonce: `x${i}` });
    expect(a.socket.all('error').some((e) => e.code === 'rate_limited')).toBe(true);
  });

  it('quotes a snapshot of the message being answered', () => {
    const a = join('Aziz');
    const b = join('Bea');
    const long = `${'word '.repeat(60)}end`;
    room.handle(a.p, { type: 'chat', text: long, nonce: 'n1' });
    const original = b.socket.last('chat')!.message;
    room.handle(b.p, { type: 'chat', text: 'agreed', nonce: 'n2', replyTo: original.id });
    const reply = a.socket.last('chat')!.message;
    expect(reply).toMatchObject({
      kind: 'user', text: 'agreed', authorName: 'Bea',
      replyTo: { id: original.id, authorName: 'Aziz', authorId: a.p.info.id },
    });
    if (reply.kind !== 'user') throw new Error('expected a user message');
    expect(reply.replyTo!.excerpt.length).toBeLessThanOrEqual(141);
    expect(reply.replyTo!.excerpt.endsWith('…')).toBe(true);

    room.handle(a.p, { type: 'chat', text: '', nonce: 'n3', attachment: { kind: 'sticker', id: 'popcorn' } });
    const sticker = b.socket.last('chat')!.message;
    room.handle(b.p, { type: 'chat', text: 'lol', nonce: 'n4', replyTo: sticker.id });
    expect(a.socket.last('chat')!.message).toMatchObject({ replyTo: { excerpt: '', attachment: 'sticker' } });
  });

  it('sends a reply to an unknown or system message as a plain message', () => {
    const a = join('Aziz');
    const b = join('Bea');
    const joined = a.socket.all('chat').find((m) => m.message.kind === 'system')!.message;
    room.handle(a.p, { type: 'chat', text: 'one', nonce: 'n1', replyTo: joined.id });
    room.handle(a.p, { type: 'chat', text: 'two', nonce: 'n2', replyTo: 'doesnotexist' });
    const texts = b.socket.all('chat').filter((m) => m.message.kind === 'user').map((m) => m.message);
    expect(texts.map((m) => m.text)).toEqual(['one', 'two']);
    expect(texts.every((m) => m.kind === 'user' && m.replyTo === undefined)).toBe(true);
  });
});
