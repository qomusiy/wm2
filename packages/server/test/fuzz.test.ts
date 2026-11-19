/*
 * Room state machine under thousands of random (schema-valid) actions from several people: it must never throw,
 * and its invariants must hold after every step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, REACTIONS, STICKERS, type ClientMessage, type FileMediaDescriptor } from '@watchroom/protocol';
import { ClientMessage as ClientSchema } from '@watchroom/protocol/schemas';
import { Room, type Participant, type RoomSocket } from '../src/room/room';
import { createLogger } from '../src/util/log';

/** Small deterministic PRNG (mulberry32) so failures can be replayed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    bool: (p = 0.5) => next() < p,
  };
}

const media: FileMediaDescriptor = {
  kind: 'file', id: 'fuzzmedia', title: 'Fuzz', duration: 600, width: 1280, height: 720, masterUrl: '/media/fuzzmedia/master.m3u8',
  levels: [], audioTracks: [], subtitles: [], thumbnails: null, sourceSummary: 'MKV',
};

class Sink implements RoomSocket {
  sent = 0;
  closed = false;
  send() { this.sent++; }
  close() { this.closed = true; }
}

function randomMessage(r: ReturnType<typeof rng>, ids: string[]): ClientMessage {
  const pos = () => r.pick([0, r.next() * 600, 599.99, 600, r.next() * 1e5]);
  switch (r.int(0, 12)) {
    case 0: return { type: 'intent', action: 'play', version: r.int(0, 50) };
    case 1: return { type: 'intent', action: 'pause', position: pos(), version: r.int(0, 50) };
    case 2: return { type: 'intent', action: 'seek', position: pos(), version: r.int(0, 50) };
    case 3: return { type: 'intent', action: 'rate', rate: r.pick([0.5, 0.75, 1, 1.25, 1.5, 2]), version: r.int(0, 50) };
    case 4: return { type: 'ready', version: r.int(0, 60), ready: r.bool() };
    case 5: return {
      type: 'status', player: r.pick(['loading', 'ready', 'playing', 'paused', 'buffering', 'blocked'] as const), position: pos(),
      bufferAhead: r.next() * 60, quality: r.pick([null, '480p', 'Original · 1080p']), rtt: r.pick([null, r.next() * 2000]),
      p2p: r.pick([null, { host: r.pick(['off', 'connecting', 'connected', 'failed'] as const), peers: r.int(0, 5), fromHost: r.next() * 1e9, fromPeers: r.next() * 1e9, fromLink: r.next() * 1e9 }]),
    };
    case 6: return { type: 'chat', text: r.pick(['hi', 'x'.repeat(r.int(1, 2500)), '‮evil', 'line\n\n\n\n\nbreaks']), nonce: String(r.int(0, 1e9)), ...(r.bool(0.2) ? { replyTo: r.pick(['nope', 'AAAA']) } : {}) };
    case 7: return { type: 'chat', text: '', nonce: 'n', attachment: { kind: 'sticker', id: r.pick(STICKERS) } };
    case 8: return { type: 'reaction', emoji: r.pick(REACTIONS) };
    case 9: return { type: 'typing', active: r.bool() };
    case 10: return { type: 'rename', name: r.pick(['Neo', '  ', 'a'.repeat(100), 'Host']) };
    case 11: return { type: 'rtc', to: r.pick([...ids, '@host']), candidate: { candidate: 'candidate:1 1 UDP 1 1.2.3.4 5 typ srflx', mid: '0' } };
    default: return { type: 'settings', patch: { controlMode: r.pick(['everyone', 'host'] as const), bufferingPolicy: r.pick(['wait', 'continue'] as const), p2p: r.bool() } };
  }
}

describe('room invariants under random actions', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  for (const seed of [1, 2, 3, 42, 1337]) {
    it(`seed ${seed}: never throws; position, version and waiting list stay consistent`, () => {
      const r = rng(seed);
      const room = new Room(createLogger('fuzz'));
      room.setMedia(media);
      const people: { p: Participant; sock: Sink }[] = [];
      const join = (host: boolean) => {
        const sock = new Sink();
        const res = room.join(sock, {
          type: 'join', protocol: PROTOCOL_VERSION, roomId: room.id, name: `P${people.length}`, deviceId: `dev-${seed}-${people.length}-${r.int(0, 1e6)}`,
          ...(host ? { hostToken: room.hostToken } : { key: room.key }),
        });
        if (res.ok) people.push({ p: res.participant, sock });
      };
      join(true);
      for (let i = 0; i < 4; i++) join(false);
      let lastVersion = room.playback.version;
      for (let step = 0; step < 3000; step++) {
        const who = r.pick(people);
        const roll = r.next();
        if (roll < 0.02 && people.length < 8) join(false);
        else if (roll < 0.03 && people.length > 2) {
          const gone = people.splice(r.int(1, people.length - 1), 1)[0]!;
          if (r.bool()) room.leave(gone.p);
          else room.disconnect(gone.p, gone.sock as never);
        } else {
          const msg = randomMessage(r, people.map((x) => x.p.info.id));
          // Only what the WebSocket gateway would let through reaches the room.
          if (ClientSchema.safeParse(msg).success && room.participants.has(who.p.info.id)) room.handle(who.p, msg);
        }
        vi.advanceTimersByTime(r.int(0, 1500));
        const pb = room.playback;
        const pos = room.currentPosition();
        expect(Number.isFinite(pos) && pos >= 0 && pos <= media.duration, `step ${step}: position ${pos}`).toBe(true);
        expect(pb.version, `step ${step}: version went back`).toBeGreaterThanOrEqual(lastVersion);
        lastVersion = pb.version;
        expect(['playing', 'paused', 'waiting']).toContain(pb.status);
        expect([0.5, 0.75, 1, 1.25, 1.5, 2]).toContain(pb.rate);
        for (const id of pb.waitingFor) expect(room.participants.has(id), `step ${step}: waiting for someone gone`).toBe(true);
        expect(room.participants.size).toBeLessThanOrEqual(32);
      }
      room.end('done');
    });
  }
});
