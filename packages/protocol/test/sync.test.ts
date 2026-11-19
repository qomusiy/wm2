import { describe, expect, it } from 'vitest';
import {
  ClockSync, driftCorrection, excerpt, expectedPosition, formatTime, quantizeRate, sanitizeChat, sanitizeName, SYNC, YOUTUBE_SYNC,
  type PlaybackState,
} from '../src';
import { ClientMessage } from '../src/schemas';

const base: PlaybackState = {
  status: 'playing', position: 100, anchor: 1_000_000, rate: 1, version: 3,
  action: 'play', actor: null, waitReason: null, waitingFor: [],
};

describe('expectedPosition', () => {
  it('advances with server time while playing', () => {
    expect(expectedPosition(base, 1_002_500)).toBeCloseTo(102.5, 6);
  });
  it('applies the playback rate', () => {
    expect(expectedPosition({ ...base, rate: 1.5 }, 1_002_000)).toBeCloseTo(103, 6);
  });
  it('holds still before a scheduled anchor', () => {
    expect(expectedPosition(base, 999_400)).toBe(100);
  });
  it('does not move while paused or waiting', () => {
    expect(expectedPosition({ ...base, status: 'paused' }, 1_009_000)).toBe(100);
    expect(expectedPosition({ ...base, status: 'waiting' }, 1_009_000)).toBe(100);
  });
  it('clamps to the media duration', () => {
    expect(expectedPosition(base, 1_100_000, 120)).toBe(120);
  });
});

describe('YouTube drift correction', () => {
  it('leaves small drift alone and seeks only on large drift', () => {
    expect(driftCorrection(0.09, 1, false, YOUTUBE_SYNC)).toEqual({ kind: 'rate', rate: 1, correcting: false });
    expect(driftCorrection(0.05, 1, true, YOUTUBE_SYNC)).toMatchObject({ kind: 'rate', correcting: true });
    expect(driftCorrection(1.2, 1, false, YOUTUBE_SYNC).kind).toBe('rate');
    expect(driftCorrection(1.6, 1, false, YOUTUBE_SYNC)).toEqual({ kind: 'seek' });
  });
  it('turns nudges into speeds YouTube accepts (0.05 steps, away from the base speed)', () => {
    expect(quantizeRate(1.02, 1, 0.05)).toBe(1.05);
    expect(quantizeRate(0.97, 1, 0.05)).toBe(0.95);
    expect(quantizeRate(1.08, 1, 0.05)).toBe(1.1);
    expect(quantizeRate(1.05, 1, 0.05)).toBe(1.05);
    expect(quantizeRate(1, 1, 0.05)).toBe(1);
    expect(quantizeRate(1.27, 1.25, 0.05)).toBe(1.3);
    expect(quantizeRate(1.47, 1.5, 0.05)).toBe(1.45);
    expect(quantizeRate(1.03, 1, 0)).toBe(1.03); // other players take any speed
  });
});

describe('driftCorrection', () => {
  it('ignores drift inside the deadband', () => {
    expect(driftCorrection(0.05, 1, false)).toEqual({ kind: 'rate', rate: 1, correcting: false });
  });
  it('slows down when ahead and speeds up when behind', () => {
    const ahead = driftCorrection(0.3, 1, false);
    const behind = driftCorrection(-0.3, 1, false);
    expect(ahead.kind).toBe('rate');
    expect(behind.kind).toBe('rate');
    if (ahead.kind === 'rate' && behind.kind === 'rate') {
      expect(ahead.rate).toBeLessThan(1);
      expect(behind.rate).toBeGreaterThan(1);
      expect(Math.abs(1 - ahead.rate)).toBeLessThanOrEqual(SYNC.maxNudge + 1e-9);
    }
  });
  it('keeps correcting until the release threshold (hysteresis)', () => {
    const r = driftCorrection(0.05, 1, true);
    expect(r.kind === 'rate' && r.correcting).toBe(true);
    const done = driftCorrection(0.02, 1, true);
    expect(done).toEqual({ kind: 'rate', rate: 1, correcting: false });
  });
  it('hard-seeks on large drift', () => {
    expect(driftCorrection(1.5, 1, false)).toEqual({ kind: 'seek' });
    expect(driftCorrection(-3, 1, true)).toEqual({ kind: 'seek' });
  });
  it('scales nudges by the room rate', () => {
    const r = driftCorrection(-0.5, 2, false);
    expect(r.kind === 'rate' && r.rate > 2).toBe(true);
  });
});

describe('ClockSync', () => {
  it('estimates offset from symmetric samples', () => {
    const c = new ClockSync();
    // local clock is 5000ms behind server, 80ms RTT
    c.addSample(1000, 6040, 1080);
    expect(c.offset).toBe(5000);
    expect(c.serverNow(2000)).toBe(7000);
    expect(c.toLocal(7000)).toBe(2000);
  });
  it('prefers low-RTT samples over congested ones', () => {
    const c = new ClockSync();
    for (let i = 0; i < 6; i++) c.addSample(i * 1000, i * 1000 + 5000 + 20, i * 1000 + 40); // clean: offset 5000
    // congested samples with asymmetric delay skew the naive offset by +400ms
    for (let i = 6; i < 12; i++) c.addSample(i * 1000, i * 1000 + 5000 + 800, i * 1000 + 800);
    expect(Math.abs(c.offset - 5000)).toBeLessThan(5);
  });
});

describe('sanitizers and schemas', () => {
  it('cleans names', () => {
    expect(sanitizeName('  Aziz‮ \n  K  ')).toBe('Aziz K');
    expect(sanitizeName('x'.repeat(100))).toHaveLength(32);
  });
  it('cleans chat text but keeps newlines', () => {
    expect(sanitizeChat(' hi\u0007\nthere ')).toBe('hi\nthere');
  });
  it('validates client messages strictly', () => {
    expect(ClientMessage.safeParse({ type: 'intent', action: 'seek', position: 12, version: 1 }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'intent', action: 'rate', rate: 3, version: 1 }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'intent', action: 'seek', position: -1, version: 1 }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'intent', action: 'seek', position: Infinity, version: 1 }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'nope' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'chat', text: 'hi', nonce: 'n', replyTo: 'abcDEF123_-' }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'chat', text: 'hi', nonce: 'n', replyTo: '../etc' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'chat', text: 'hi', nonce: 'n', replyTo: 'x'.repeat(41) }).success).toBe(false);
  });
  it('makes one-line excerpts cut at a word boundary', () => {
    expect(excerpt('  short\n text ', 20)).toBe('short text');
    expect(excerpt('the quick brown fox jumps over the lazy dog', 20)).toBe('the quick brown fox…');
    expect(excerpt('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`);
  });
  it('formats time', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('0:00');
  });
});
