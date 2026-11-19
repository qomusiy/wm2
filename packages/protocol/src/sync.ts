import { SYNC } from './constants';
import type { PlaybackState } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Where the room timeline is at `serverNow` (ms). Before a scheduled `anchor`
 * the position holds still, so every client starts from the same frame.
 */
export function expectedPosition(state: PlaybackState, serverNow: number, duration = Infinity): number {
  if (state.status !== 'playing') return clamp(state.position, 0, duration);
  const elapsed = Math.max(0, serverNow - state.anchor) / 1000;
  return clamp(state.position + elapsed * state.rate, 0, duration);
}

export type DriftAction =
  | { kind: 'seek' }
  | { kind: 'rate'; rate: number; correcting: boolean };

/**
 * Decide how to correct drift (local - expected, seconds).
 * Small drift is corrected by nudging playbackRate (inaudible with pitch preservation);
 * large drift by a hard seek. Hysteresis via `correcting` prevents flapping.
 */
/**
 * Speed nudges for players that only take speeds in fixed steps (YouTube: 0.05, rounding anything else down):
 * round away from the base speed, so a small nudge is never lost.
 */
export function quantizeRate(rate: number, base: number, step: number): number {
  if (step <= 0 || Math.abs(rate - base) < 1e-6) return rate;
  const d = rate - base;
  const n = Math.ceil(Math.abs(d) / step - 1e-9);
  return Math.round((base + Math.sign(d) * n * step) * 100) / 100;
}

export interface DriftTuning {
  deadband: number;
  release: number;
  hardSeek: number;
}

export function driftCorrection(drift: number, baseRate: number, correcting: boolean, tuning: DriftTuning = SYNC): DriftAction {
  const abs = Math.abs(drift);
  if (abs > tuning.hardSeek) return { kind: 'seek' };
  const threshold = correcting ? tuning.release : tuning.deadband;
  if (abs <= threshold) return { kind: 'rate', rate: baseRate, correcting: false };
  const adj = clamp(drift * SYNC.gain, -SYNC.maxNudge, SYNC.maxNudge);
  return { kind: 'rate', rate: baseRate * (1 - adj), correcting: true };
}

interface ClockSample { offset: number; rtt: number; at: number }

/**
 * NTP-style clock offset estimator. offset = serverTime - localTime.
 * Uses the lowest-RTT samples, where asymmetric delay (the main error source) is smallest.
 */
export class ClockSync {
  private samples: ClockSample[] = [];
  private readonly maxSamples: number;
  offset = 0;
  rtt: number | null = null;

  constructor(maxSamples = 20) {
    this.maxSamples = maxSamples;
  }

  /** t0: local send time, serverTime: server's clock at reply, t1: local receive time. */
  addSample(t0: number, serverTime: number, t1: number): void {
    const rtt = Math.max(0, t1 - t0);
    const offset = serverTime - (t0 + t1) / 2;
    this.samples.push({ offset, rtt, at: t1 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offsets[Math.floor(offsets.length / 2)] ?? offset;
    // Report a smoothed recent RTT (median of last 5), which is what users feel.
    const recent = this.samples.slice(-5).map((s) => s.rtt).sort((a, b) => a - b);
    this.rtt = recent[Math.floor(recent.length / 2)] ?? rtt;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
    this.offset = 0;
    this.rtt = null;
  }

  serverNow(localNow: number): number {
    return localNow + this.offset;
  }

  toLocal(serverTime: number): number {
    return serverTime - this.offset;
  }
}

/** Format seconds as H:MM:SS or M:SS. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
