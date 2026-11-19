import Hls, { type ErrorData, type HlsConfig } from 'hls.js';
import type { FileMediaDescriptor } from '@watchroom/protocol';
import { createFragmentLoader } from '../p2p/loader';
import { bufferedAhead } from './sync';

export interface EngineLevel {
  index: number;
  id: string;
  label: string;
  height: number;
  bitrate: number;
  copy: boolean;
}

export interface EngineAudio {
  index: number;
  id: string;
  label: string;
}

type Listener = () => void;

const RID_RE = /\/([a-z0-9-]+)\/index\.m3u8/;

function levelId(url: unknown): string | null {
  const u = Array.isArray(url) ? url[0] : url;
  return typeof u === 'string' ? (RID_RE.exec(u)?.[1] ?? null) : null;
}

function hlsConfig(startPosition: number, capToSize: boolean, bufferAhead: () => number): Partial<HlsConfig> {
  const retry = (ttfb: number, load: number, errors: number) => ({
    default: {
      maxTimeToFirstByteMs: ttfb,
      maxLoadTimeMs: load,
      timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000 },
      errorRetry: { maxNumRetry: errors, retryDelayMs: 800, maxRetryDelayMs: 8000 },
    },
  });
  return {
    startPosition,
    enableWorker: true,
    // Segments may come directly from the host or other viewers (when the room allows it), else over HTTP.
    fLoader: createFragmentLoader(bufferAhead) as unknown as HlsConfig['fLoader'],
    lowLatencyMode: false,
    // Read ahead 1–2 minutes: enough to ride out network hiccups, without hoarding the host's limited upload
    // (low-bitrate levels would otherwise read ahead up to maxMaxBufferLength, which seeking throws away).
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    maxBufferSize: 150 * 1000 * 1000,
    backBufferLength: 90,
    maxBufferHole: 0.3,
    nudgeMaxRetry: 6,
    // Assume a modest link until measured, so the first segments arrive quickly.
    abrEwmaDefaultEstimate: 1_200_000,
    abrBandWidthFactor: 0.85,
    abrBandWidthUpFactor: 0.6,
    capLevelToPlayerSize: capToSize,
    startLevel: -1,
    testBandwidth: true,
    // On-demand transcoding can take a moment for the first byte after a seek.
    fragLoadPolicy: retry(30_000, 120_000, 8),
    playlistLoadPolicy: retry(25_000, 30_000, 6),
    manifestLoadPolicy: retry(15_000, 20_000, 4),
  };
}

/** hls.js (MSE) or native HLS, behind one small interface. */
export class PlayerEngine {
  readonly native: boolean;
  private hls: Hls | null = null;
  levels: EngineLevel[] = [];
  audio: EngineAudio[] = [];
  /** Index of the level currently playing (-1 unknown). */
  currentLevel = -1;
  auto = true;
  currentAudio = -1;
  ready = false;
  fatal: string | null = null;
  private listeners = new Set<Listener>();
  private recoveries = 0;
  private networkRetries = 0;
  private nativeLevel: string | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly media: FileMediaDescriptor,
    private readonly opts: { startPosition: number; preferLevel: string; preferAudio: string | null; capToSize: boolean },
  ) {
    const mse = Hls.isSupported();
    this.native = !mse && video.canPlayType('application/vnd.apple.mpegurl') !== '';
    // Native HLS players get the H.264 levels only (see nativeUrl); hls.js filters by codec support itself.
    this.levels = [...media.levels].filter((l) => mse || l.codec !== 'hevc').sort((a, b) => a.bandwidth - b.bandwidth).map((l, index) => ({
      index, id: l.id, label: l.label, height: Math.min(l.width, l.height), bitrate: l.bandwidth, copy: l.copy,
    }));
    this.audio = media.audioTracks.map((a, index) => ({ index, id: a.id, label: a.label }));
    if (mse) this.initHls();
    else if (this.native) this.initNative();
    else this.fatal = 'This browser cannot play streaming video. Try Chrome, Firefox, Edge or Safari.';
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private initHls(): void {
    const hls = new Hls(hlsConfig(this.opts.startPosition, this.opts.capToSize, () => bufferedAhead(this.video)));
    this.hls = hls;
    // ManagedMediaSource (iOS 17.1+) requires opting out of AirPlay for MSE playback.
    if ('ManagedMediaSource' in window) this.video.disableRemotePlayback = true;
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      this.levels = data.levels.map((lvl, index) => {
        const id = levelId((lvl as unknown as { url?: unknown }).url ?? lvl.uri) ?? `l${index}`;
        const desc = this.media.levels.find((x) => x.id === id);
        return {
          index, id, label: desc?.label ?? `${lvl.height}p`, height: Math.min(lvl.width || lvl.height, lvl.height),
          bitrate: lvl.bitrate, copy: desc?.copy ?? false,
        };
      });
      const pref = this.levels.find((l) => l.id === this.opts.preferLevel);
      if (pref) {
        hls.currentLevel = pref.index;
        this.auto = false;
      }
      this.ready = true;
      this.emit();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      this.currentLevel = data.level;
      this.emit();
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
      this.audio = data.audioTracks.map((t, index) => {
        const id = /\/(a\d+)\/index\.m3u8/.exec(String((t as unknown as { url?: string }).url ?? ''))?.[1] ?? `a${index}`;
        return { index, id, label: this.media.audioTracks.find((x) => x.id === id)?.label ?? t.name };
      });
      const pref = this.audio.find((a) => a.id === this.opts.preferAudio);
      if (pref && hls.audioTrack !== pref.index) hls.audioTrack = pref.index;
      this.currentAudio = hls.audioTrack;
      this.emit();
    });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => {
      this.currentAudio = data.id;
      this.emit();
    });
    hls.on(Hls.Events.FRAG_LOADED, () => {
      this.networkRetries = 0;
    });
    hls.on(Hls.Events.ERROR, (_e, data) => this.onHlsError(data));
    hls.attachMedia(this.video);
    hls.loadSource(this.media.masterUrl);
  }

  private onHlsError(data: ErrorData): void {
    if (!data.fatal || !this.hls) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.networkRetries < 20) {
      this.networkRetries++;
      window.setTimeout(() => this.hls?.startLoad(), Math.min(10_000, 1000 * this.networkRetries));
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoveries < 3) {
      this.recoveries++;
      if (this.recoveries === 2) this.hls.swapAudioCodec();
      this.hls.recoverMediaError();
      return;
    }
    this.fatal = data.type === Hls.ErrorTypes.NETWORK_ERROR
      ? 'Lost the connection to the video stream.'
      : 'The video could not be decoded in this browser.';
    this.emit();
  }

  private initNative(): void {
    const pref = this.levels.find((l) => l.id === this.opts.preferLevel);
    this.nativeLevel = pref?.id ?? null;
    this.auto = !pref;
    this.video.src = this.nativeUrl();
    const onMeta = () => {
      if (this.opts.startPosition > 0) this.video.currentTime = this.opts.startPosition;
      this.ready = true;
      this.currentLevel = this.levels.findIndex((l) => l.id === this.nativeLevel);
      this.emit();
    };
    this.video.addEventListener('loadedmetadata', onMeta, { once: true });
    this.video.addEventListener('error', () => {
      this.fatal = 'The video could not be played in this browser.';
      this.emit();
    });
  }

  private nativeUrl(): string {
    return this.media.masterUrl.replace('master.m3u8', `master-${this.nativeLevel ?? 'compat'}.m3u8`);
  }

  /** `auto` or a level id. Only affects this viewer. */
  setLevel(id: string): void {
    if (this.native) {
      const t = this.video.currentTime;
      const wasPaused = this.video.paused;
      this.nativeLevel = id === 'auto' ? null : id;
      this.auto = id === 'auto';
      this.video.src = this.nativeUrl();
      this.video.addEventListener('loadedmetadata', () => {
        this.video.currentTime = t;
        if (!wasPaused) void this.video.play().catch(() => {});
      }, { once: true });
      this.currentLevel = this.levels.findIndex((l) => l.id === this.nativeLevel);
      this.emit();
      return;
    }
    if (!this.hls) return;
    if (id === 'auto') {
      this.hls.nextLevel = -1;
      this.hls.loadLevel = -1;
      this.auto = true;
    } else {
      const lvl = this.levels.find((l) => l.id === id);
      if (!lvl) return;
      // Smooth switch: keeps what is already buffered at the playhead, replaces what comes next.
      this.hls.nextLevel = lvl.index;
      this.auto = false;
    }
    this.emit();
  }

  setAudio(id: string): void {
    const t = this.audio.find((a) => a.id === id);
    if (!t) return;
    if (this.hls) this.hls.audioTrack = t.index;
    else {
      const tracks = (this.video as unknown as { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
      if (tracks) for (let i = 0; i < tracks.length; i++) tracks[i]!.enabled = i === t.index;
      this.currentAudio = t.index;
      this.emit();
    }
  }

  /** Label for the status bar, e.g. "720p" or "Auto · 480p". */
  qualityLabel(): string | null {
    const lvl = this.levels[this.currentLevel];
    if (!lvl) return this.auto ? 'Auto' : null;
    return this.auto ? `Auto · ${lvl.label.replace('Original · ', '')}` : lvl.label;
  }

  bandwidthEstimate(): number | null {
    return this.hls ? this.hls.bandwidthEstimate : null;
  }

  destroy(): void {
    this.listeners.clear();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    } else {
      this.video.removeAttribute('src');
      this.video.load();
    }
  }
}
