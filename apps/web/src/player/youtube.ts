/*
 * YouTube's embedded player as a media surface, driven through the player's message channel (the same channel
 * YouTube's own IFrame API script uses). No YouTube script runs in our page: the player lives in its own
 * cross-origin frame (privacy-enhanced youtube-nocookie.com), and we only exchange messages with it.
 */
import type { MediaSurface, SurfaceEvent } from './surface';

export const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';

/** YouTube player states. */
const UNSTARTED = -1;
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;

interface PlayerInfo {
  playerState?: number;
  currentTime?: number;
  /** Seconds since the epoch at which currentTime was measured (inside the frame). */
  currentTimeLastUpdated_?: number;
  duration?: number;
  playbackRate?: number;
  videoLoadedFraction?: number;
  volume?: number;
  muted?: boolean;
  playbackQuality?: string;
  videoData?: { isLive?: boolean; errorCode?: string | null };
}

const QUALITY: Record<string, string> = {
  tiny: '144p', small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '2160p', highres: '4K',
};

/** Is this page opened by a bare IP address (a same-network link such as http://192.168.1.5:47800)? */
const onIpAddress = (): boolean => /^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:.]+\]$/i.test(location.hostname);

export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2: return 'This YouTube link is not valid.';
    case 5: return 'This YouTube video can\'t be played in this browser.';
    case 100: return 'This YouTube video was removed or is private.';
    case 101:
    case 150:
      // YouTube refuses many videos (music especially) in pages opened by an IP address.
      return onIpAddress()
        ? 'YouTube doesn\'t allow this video on same-network links (an address made of numbers). Use the internet link to watch it together.'
        : 'The owner of this video doesn\'t allow playing it outside YouTube (or it is age-restricted).';
    case 153: return 'YouTube didn\'t accept this player. Reload the page.';
    default: return `YouTube couldn't play this video (error ${code}).`;
  }
}

export interface YouTubeSurfaceOptions {
  videoId: string;
  /** Where to begin (seconds). */
  start: number;
  volume: number;
  muted: boolean;
  /** Viewer's caption choice; null = YouTube's default for the video. */
  captions: boolean | null;
}

/** An "autoplay blocked" error like the one HTMLMediaElement.play() rejects with. */
function notAllowed(): DOMException {
  return new DOMException('YouTube did not start playing (autoplay blocked?)', 'NotAllowedError');
}

export class YouTubeSurface implements MediaSurface {
  readonly kind = 'youtube' as const;
  /** YouTube accepts speeds in 0.05 steps (it rounds anything else down). */
  readonly rateStep = 0.05;
  readonly iframe: HTMLIFrameElement;
  private info: PlayerInfo = {};
  private state = UNSTARTED;
  /** The player answered (its API works). */
  private apiReady = false;
  /** Loaded once silently (see prime()); only then is the surface ready for the room. */
  private primeState: 'waiting' | 'priming' | 'done' = 'waiting';
  private primeTimer: number | null = null;
  private fatalMessage: string | null = null;
  private captionsModule = false;
  /** Whether YouTube is showing captions right now (from its module reports; null until it says). */
  private captionsShown: boolean | null = null;
  private readonly listeners = new Map<SurfaceEvent, Set<() => void>>();
  private listenTimer: number | null = null;
  private readonly loadTimer: number;
  /** When the viewer last clicked inside the frame (the page loses focus to it). */
  private frameTouchedAt = -Infinity;
  /** One play/pause intent per click inside the frame (YouTube passes through several states on the way). */
  private touchHandled = true;
  /** Should the video be playing (our last command)? Bridges YouTube's in-between states. */
  private intendPlaying = false;
  private playPending: { resolve(): void; reject(e: DOMException): void; timer: number } | null = null;
  private seekTarget: number | null = null;
  private seekDeadline = 0;
  /** Where the loaded stretch around the playhead begins (YouTube only reports where it ends). */
  private rangeStart: number;
  private requestedRate: number | null = null;
  private wantVolume: number;
  private wantMuted: boolean;
  private captions: boolean | null;
  private readonly onMessage = (e: MessageEvent) => this.handleMessage(e);
  private readonly onWindowBlur = () => this.reclaimFocus();

  constructor(host: HTMLElement, private readonly opts: YouTubeSurfaceOptions) {
    this.rangeStart = Math.max(0, opts.start);
    this.wantVolume = opts.volume;
    this.wantMuted = opts.muted;
    this.captions = opts.captions;
    const params = new URLSearchParams({
      enablejsapi: '1', origin: location.origin, widget_referrer: location.origin,
      // Our own controls drive the player; YouTube's are off, its keyboard and fullscreen too (ours keep the chat).
      controls: '0', disablekb: '1', fs: '0', rel: '0', playsinline: '1', iv_load_policy: '3', modestbranding: '1',
      autoplay: '0', start: String(Math.max(0, Math.floor(opts.start))), hl: (navigator.language || 'en').slice(0, 5),
      ...(opts.captions === true ? { cc_load_policy: '1' } : {}),
    });
    const f = document.createElement('iframe');
    f.title = 'YouTube video player';
    f.src = `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(opts.videoId)}?${params}`;
    // YouTube requires to know which site embeds it (our page otherwise sends no referrer at all).
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    // It may open YouTube in a new tab (logo, title), but never navigate or script our page.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation');
    f.setAttribute('frameborder', '0');
    f.className = 'yt-frame';
    window.addEventListener('message', this.onMessage);
    window.addEventListener('blur', this.onWindowBlur);
    f.addEventListener('load', () => this.startListening());
    host.appendChild(f);
    this.iframe = f;
    this.loadTimer = window.setTimeout(() => {
      if (!this.apiReady && !this.fatalMessage) this.fail('YouTube didn\'t load. Check the internet connection (YouTube may be blocked on this network).');
    }, 25_000);
  }

  // ---------------------------------------------------------------- messaging

  private send(func: string, ...args: unknown[]): void {
    this.post({ event: 'command', func, args });
  }

  /** A command that changes the player's state (play, pause, seek, load). */
  private command(func: 'playVideo' | 'pauseVideo' | 'seekTo' | 'cueVideoById', ...args: unknown[]): void {
    this.send(func, ...args);
  }

  private post(msg: Record<string, unknown>): void {
    try {
      this.iframe.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), YOUTUBE_ORIGIN);
    } catch { /* frame gone */ }
  }

  /** The player announces itself only after we say we're listening (repeat until it answers). */
  private startListening(): void {
    if (this.apiReady || this.listenTimer !== null) return;
    this.post({ event: 'listening' });
    this.listenTimer = window.setInterval(() => this.post({ event: 'listening' }), 250);
  }

  private handleMessage(e: MessageEvent): void {
    if (e.origin !== YOUTUBE_ORIGIN || e.source !== this.iframe.contentWindow || typeof e.data !== 'string') return;
    let msg: { event?: unknown; info?: unknown };
    try {
      msg = JSON.parse(e.data) as { event?: unknown; info?: unknown };
    } catch {
      return;
    }
    switch (msg.event) {
      case 'initialDelivery':
      case 'infoDelivery':
        if (msg.info && typeof msg.info === 'object') this.update(msg.info as PlayerInfo);
        if (msg.event === 'initialDelivery') this.becomeReady();
        break;
      case 'onReady':
        this.becomeReady();
        break;
      case 'onStateChange':
        if (typeof msg.info === 'number') this.setState(msg.info);
        break;
      case 'onPlaybackRateChange':
        if (typeof msg.info === 'number') {
          this.info.playbackRate = msg.info;
          this.emit('ratechange');
        }
        break;
      case 'onPlaybackQualityChange':
        if (typeof msg.info === 'string') {
          this.info.playbackQuality = msg.info;
          this.emit('change');
        }
        break;
      case 'onError':
        if (typeof msg.info === 'number') this.fail(youtubeErrorMessage(msg.info));
        break;
      case 'apiInfoDelivery': {
        // Modules loaded for the video; "captions" means it has subtitles, and its "track" is the one showing.
        const info = msg.info as { namespaces?: unknown; captions?: { track?: unknown } } | null;
        if (!info || !Array.isArray(info.namespaces)) break;
        const loaded = info.namespaces.includes('captions');
        const track = info.captions?.track;
        const shown = loaded && typeof track === 'object' && track !== null && typeof (track as { languageCode?: unknown }).languageCode === 'string'
          && (track as { languageCode: string }).languageCode !== '';
        if ((loaded && !this.captionsModule) || shown !== this.captionsShown) {
          this.captionsModule ||= loaded;
          this.captionsShown = shown;
          this.emit('change');
        }
        break;
      }
      default:
        break;
    }
  }

  private becomeReady(): void {
    if (this.apiReady) return;
    this.apiReady = true;
    if (this.listenTimer !== null) window.clearInterval(this.listenTimer);
    this.listenTimer = null;
    window.clearTimeout(this.loadTimer);
    for (const ev of ['onStateChange', 'onPlaybackRateChange', 'onPlaybackQualityChange', 'onError', 'onApiChange']) this.send('addEventListener', ev);
    this.send('setVolume', Math.round(this.wantVolume * 100));
    if (this.captions === false) this.send('unloadModule', 'captions');
    // Let the error (if any) arrive first: an unplayable video reports it right after it says it's ready.
    window.setTimeout(() => this.prime(), 150);
  }

  /**
   * Play the video for a moment, muted, then pause. YouTube starts out "cued" (nothing loaded, and a seek would start
   * playback); afterwards pauses, seeks and starts behave like a normal paused video and the first start is quick.
   * The viewer sees our poster meanwhile.
   */
  private prime(): void {
    if (this.primeState !== 'waiting' || this.fatalMessage) return;
    this.primeState = 'priming';
    this.send('mute');
    this.command('playVideo');
    this.primeTimer = window.setTimeout(() => this.finishPrime(), 8000);
  }

  private finishPrime(): void {
    if (this.primeState !== 'priming') return;
    this.primeState = 'done';
    if (this.primeTimer !== null) window.clearTimeout(this.primeTimer);
    this.primeTimer = null;
    if (this.state !== PAUSED && this.state !== CUED && this.state !== ENDED) this.command('pauseVideo');
    this.send(this.wantMuted ? 'mute' : 'unMute');
    if (this.fatalMessage) return;
    this.emit('change');
  }

  private update(incoming: PlayerInfo): void {
    const info = { ...incoming };
    const prevLoaded = this.info.videoLoadedFraction;
    const prevDuration = this.info.duration;
    const prevQuality = this.info.playbackQuality;
    // While starting up, YouTube briefly reports position 0; keep the position we know.
    const st = typeof info.playerState === 'number' ? info.playerState : this.state;
    if (info.currentTime === 0 && (st === UNSTARTED || st === BUFFERING) && (this.info.currentTime ?? 0) > 0.5) delete info.currentTime;
    Object.assign(this.info, info);
    if (typeof info.playerState === 'number' && info.playerState !== this.state) this.setState(info.playerState);
    if (this.seekTarget !== null && typeof info.currentTime === 'number' && Math.abs(info.currentTime - this.seekTarget) < 1.2 && this.state !== BUFFERING) {
      this.seekTarget = null;
      this.emit('seeked');
    }
    if (info.videoLoadedFraction !== undefined && info.videoLoadedFraction !== prevLoaded) this.emit('progress');
    if (info.duration !== prevDuration || info.playbackQuality !== prevQuality) this.emit('change');
  }

  private setState(next: number): void {
    const prev = this.state;
    if (next === prev) return;
    this.state = next;
    const now = performance.now();
    if (this.primeState === 'priming') {
      if (next === PLAYING) this.finishPrime();
      return;
    }
    if (this.playPending && (next === PLAYING || next === BUFFERING)) {
      window.clearTimeout(this.playPending.timer);
      this.playPending.resolve();
      this.playPending = null;
    }
    if (next === BUFFERING) this.emit('waiting');
    if (next === PLAYING) {
      this.emit('playing');
      this.emit('canplay');
    }
    if (next === PAUSED || next === CUED || next === ENDED) {
      this.emit('pause');
      this.emit('canplay');
    }
    // The viewer clicked the picture inside YouTube's frame (that toggles playback there): tell the room. It is the
    // viewer's doing when it goes against what we last asked for, right after a click into the frame (so the browser
    // pausing a video by itself isn't mistaken for a person).
    // (While the frame has the focus, the viewer is still clicking in it.)
    const touched = document.activeElement === this.iframe || (!this.touchHandled && now - this.frameTouchedAt < 2500);
    if (touched && this.primeState === 'done') {
      const running = next === PLAYING || next === BUFFERING;
      const stopped = prev === PAUSED || prev === CUED || prev === ENDED || prev === UNSTARTED;
      if (next === PAUSED && (prev === PLAYING || prev === BUFFERING) && this.intendPlaying) {
        this.touchHandled = true;
        this.intendPlaying = false;
        this.emit('userpause');
      } else if (running && stopped && !this.intendPlaying) {
        this.touchHandled = true;
        this.intendPlaying = true;
        this.emit('userplay');
      }
    }
  }

  private fail(message: string): void {
    if (this.fatalMessage) return;
    this.fatalMessage = message;
    window.clearTimeout(this.loadTimer);
    if (this.playPending) {
      window.clearTimeout(this.playPending.timer);
      this.playPending.reject(notAllowed());
      this.playPending = null;
    }
    this.emit('change');
  }

  /** After a click into the frame, give the keyboard back to our page (our shortcuts; YouTube's are off anyway). */
  private reclaimFocus(): void {
    if (document.activeElement !== this.iframe) return;
    this.frameTouchedAt = performance.now();
    this.touchHandled = false;
    window.setTimeout(() => {
      if (document.activeElement === this.iframe) this.iframe.blur();
    }, 350);
  }

  private emit(ev: SurfaceEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  on(event: SurfaceEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  // ---------------------------------------------------------------- media surface

  get ready(): boolean { return this.primeState === 'done' && !this.fatalMessage; }
  get fatal(): string | null { return this.fatalMessage; }
  get isLive(): boolean { return Boolean(this.info.videoData?.isLive); }
  /** The video has YouTube captions (known once it has started loading). */
  get captionsAvailable(): boolean { return this.captionsModule; }

  get currentTime(): number {
    if (this.seekTarget !== null && performance.now() < this.seekDeadline) return this.seekTarget;
    const t = this.info.currentTime ?? this.opts.start;
    if (this.state !== PLAYING || !this.info.currentTimeLastUpdated_) return t;
    // The player reports every ~250 ms; between reports, advance at the playback speed (capped if it goes quiet).
    const elapsed = Math.min(2, Math.max(0, Date.now() / 1000 - this.info.currentTimeLastUpdated_));
    return t + elapsed * (this.info.playbackRate ?? 1);
  }

  seek(t: number): void {
    const target = Math.max(0, t);
    if (target < this.rangeStart || target > this.loadedUntil()) this.rangeStart = target;
    this.seekTarget = target;
    this.seekDeadline = performance.now() + 8000;
    // From the cued or ended state a seek starts playback; when it shouldn't, cue the video at that point instead.
    const stopped = this.state === CUED || this.state === ENDED || this.state === UNSTARTED;
    if (stopped && !this.intendPlaying && !this.playPending) this.command('cueVideoById', { videoId: this.opts.videoId, startSeconds: target });
    else this.command('seekTo', target, true);
  }

  get seeking(): boolean {
    if (this.seekTarget === null) return false;
    if (performance.now() > this.seekDeadline) {
      this.seekTarget = null;
      return false;
    }
    return true;
  }

  get paused(): boolean {
    if (this.state === PLAYING || this.state === BUFFERING || this.playPending !== null) return false;
    // On its way to playing, YouTube passes through "unstarted".
    return !(this.state === UNSTARTED && this.intendPlaying);
  }

  get ended(): boolean { return this.state === ENDED; }

  get readyState(): number {
    if (!this.ready) return 0;
    if (this.seeking || this.state === BUFFERING || this.state === UNSTARTED) return 1;
    // Paused or cued: ready once a little is loaded at the playhead (YouTube keeps loading while paused).
    if (this.state !== PLAYING && this.bufferedAhead() < 1.5 && this.duration - this.currentTime > 2) return 2;
    return 4;
  }

  play(): Promise<void> {
    if (this.fatalMessage) return Promise.reject(notAllowed());
    this.intendPlaying = true;
    if (this.state === PLAYING) return Promise.resolve();
    if (this.playPending) return new Promise((resolve, reject) => {
      const p = this.playPending!;
      const done = p.resolve;
      const fail = p.reject;
      p.resolve = () => { done(); resolve(); };
      p.reject = (e) => { fail(e); reject(e); };
    });
    this.command('playVideo');
    return new Promise((resolve, reject) => {
      // Not playing (or at least loading) within a few seconds: the browser blocked autoplay.
      const timer = window.setTimeout(() => {
        if (this.playPending?.timer !== timer) return;
        this.playPending = null;
        reject(notAllowed());
        this.emit('change');
      }, 4000);
      this.playPending = { resolve, reject, timer };
    });
  }

  pause(): void {
    this.intendPlaying = false;
    if (this.playPending) {
      window.clearTimeout(this.playPending.timer);
      this.playPending.reject(new DOMException('paused', 'AbortError'));
      this.playPending = null;
    }
    // Also while starting up ("unstarted"/buffering): otherwise it would go on to play.
    if (this.state !== PAUSED && this.state !== CUED && this.state !== ENDED) this.command('pauseVideo');
  }

  get playbackRate(): number { return this.requestedRate ?? this.info.playbackRate ?? 1; }
  set playbackRate(r: number) {
    if (this.requestedRate !== null && Math.abs(this.requestedRate - r) < 0.001) return;
    this.requestedRate = r;
    // Speed nudges (drift correction) come often and never change play/pause: not a "command" for click detection.
    this.send('setPlaybackRate', r);
  }

  get muted(): boolean { return this.wantMuted; }
  set muted(m: boolean) {
    if (m === this.wantMuted) return;
    this.wantMuted = m;
    // While priming the player stays muted; the choice is applied when priming ends.
    if (this.primeState === 'done') this.send(m ? 'mute' : 'unMute');
  }

  get volume(): number { return this.wantVolume; }
  set volume(v: number) {
    this.wantVolume = Math.min(1, Math.max(0, v));
    if (this.apiReady) this.send('setVolume', Math.round(this.wantVolume * 100));
  }

  /** Turn YouTube's own captions on or off for this viewer. */
  setCaptions(on: boolean): void {
    this.captions = on;
    this.captionsShown = on;
    this.emit('change');
    if (!this.apiReady) return;
    if (on) {
      this.send('loadModule', 'captions');
      this.send('setOption', 'captions', 'reload', true);
    } else this.send('unloadModule', 'captions');
  }

  /** Captions showing right now, as far as YouTube has said (else what this viewer chose). */
  get captionsOn(): boolean | null { return this.captionsShown ?? this.captions; }

  get duration(): number {
    const d = this.info.duration;
    return typeof d === 'number' && d > 0 ? d : NaN;
  }

  private loadedUntil(): number {
    const d = this.duration;
    const f = this.info.videoLoadedFraction;
    return Number.isFinite(d) && typeof f === 'number' ? f * d : 0;
  }

  bufferedRanges(): [number, number][] {
    const end = this.loadedUntil();
    const start = Math.min(this.rangeStart, this.currentTime);
    return end > start ? [[start, end]] : [];
  }

  bufferedAhead(): number {
    return Math.max(0, this.loadedUntil() - this.currentTime);
  }

  isBuffered(t: number): boolean {
    return t >= 0 && t + 0.5 <= this.loadedUntil();
  }

  get autoQuality(): boolean { return true; }

  qualityLabel(): string | null {
    const q = this.info.playbackQuality;
    return q && QUALITY[q] ? `YouTube · ${QUALITY[q]}` : 'YouTube';
  }

  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('blur', this.onWindowBlur);
    if (this.listenTimer !== null) window.clearInterval(this.listenTimer);
    if (this.primeTimer !== null) window.clearTimeout(this.primeTimer);
    window.clearTimeout(this.loadTimer);
    if (this.playPending) window.clearTimeout(this.playPending.timer);
    this.playPending = null;
    this.listeners.clear();
    this.iframe.src = 'about:blank';
    this.iframe.remove();
  }
}
