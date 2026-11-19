import type { PlayerEngine } from './engine';

/** Things a media surface reports; `change` covers readiness, errors, duration and quality. */
export type SurfaceEvent =
  | 'waiting' | 'playing' | 'canplay' | 'seeked' | 'progress' | 'pause' | 'ratechange' | 'change'
  /** The viewer played or paused inside the YouTube frame itself (not through our controls). */
  | 'userplay' | 'userpause';

/**
 * What the sync engine and the controls need from "the thing that shows the video": a <video> element fed by
 * hls.js (files from the host) or YouTube's embedded player (YouTube videos). Mirrors HTMLMediaElement semantics.
 */
export interface MediaSurface {
  readonly kind: 'file' | 'youtube';
  /** Can be controlled (manifest parsed / YouTube player ready). */
  readonly ready: boolean;
  readonly fatal: string | null;
  readonly currentTime: number;
  seek(t: number): void;
  /** Like HTMLMediaElement.paused: false from play() on, even while still buffering. */
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  /** HTMLMediaElement readyState scale: 4 = can play through, 3 = can play, 1 = metadata only. */
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  playbackRate: number;
  /** Speed changes are only possible in steps of this size (0 = any speed). */
  readonly rateStep: number;
  muted: boolean;
  volume: number;
  bufferedRanges(): [number, number][];
  /** Seconds buffered from the playhead on. */
  bufferedAhead(): number;
  isBuffered(t: number): boolean;
  /** Length as the player knows it (NaN while unknown). */
  readonly duration: number;
  qualityLabel(): string | null;
  readonly autoQuality: boolean;
  on(event: SurfaceEvent, fn: () => void): () => void;
  destroy(): void;
}

/** A <video> element played by hls.js (or natively): the host's files. */
export class VideoSurface implements MediaSurface {
  readonly kind = 'file' as const;
  readonly rateStep = 0;
  private readonly offEngine: () => void;
  private readonly listeners = new Map<SurfaceEvent, Set<() => void>>();

  constructor(readonly video: HTMLVideoElement, readonly engine: PlayerEngine) {
    this.offEngine = engine.on(() => this.emit('change'));
    const forward: [keyof HTMLMediaElementEventMap, SurfaceEvent][] = [
      ['waiting', 'waiting'], ['stalled', 'waiting'], ['playing', 'playing'], ['canplay', 'canplay'], ['seeked', 'seeked'],
      ['progress', 'progress'], ['loadeddata', 'progress'], ['pause', 'pause'], ['ratechange', 'ratechange'],
    ];
    for (const [dom, ev] of forward) {
      const fn = () => this.emit(ev);
      video.addEventListener(dom, fn);
      this.cleanup.push(() => video.removeEventListener(dom, fn));
    }
  }

  private readonly cleanup: (() => void)[] = [];

  private emit(ev: SurfaceEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  on(event: SurfaceEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  get ready(): boolean { return this.engine.ready; }
  get fatal(): string | null { return this.engine.fatal; }
  get currentTime(): number { return this.video.currentTime; }
  seek(t: number): void { this.video.currentTime = t; }
  get paused(): boolean { return this.video.paused; }
  get seeking(): boolean { return this.video.seeking; }
  get ended(): boolean { return this.video.ended; }
  get readyState(): number { return this.video.readyState; }
  play(): Promise<void> { return this.video.play() ?? Promise.resolve(); }
  pause(): void { this.video.pause(); }
  get playbackRate(): number { return this.video.playbackRate; }
  set playbackRate(r: number) {
    this.video.defaultPlaybackRate = r;
    this.video.playbackRate = r;
  }
  get muted(): boolean { return this.video.muted; }
  set muted(m: boolean) { this.video.muted = m; }
  get volume(): number { return this.video.volume; }
  set volume(v: number) { this.video.volume = v; }
  get duration(): number { return this.video.duration; }
  get autoQuality(): boolean { return this.engine.auto; }
  qualityLabel(): string | null { return this.engine.qualityLabel(); }

  bufferedRanges(): [number, number][] {
    const b = this.video.buffered;
    const out: [number, number][] = [];
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    return out;
  }

  bufferedAhead(): number {
    const t = this.video.currentTime;
    for (const [s, e] of this.bufferedRanges()) if (s <= t + 0.25 && e >= t) return e - t;
    return 0;
  }

  isBuffered(t: number): boolean {
    return this.bufferedRanges().some(([s, e]) => s <= t && e >= t + 0.5);
  }

  destroy(): void {
    this.offEngine();
    for (const c of this.cleanup) c();
    this.listeners.clear();
  }
}
