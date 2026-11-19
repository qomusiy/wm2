import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  AudioLines, Captions, Ellipsis, ExternalLink, Gauge, Maximize, MessageSquare, Minimize, Pause, Play, RotateCcw, RotateCw, Settings2, SmilePlus, Volume1, Volume2, VolumeX,
} from 'lucide-react';
import { PLAYBACK_RATES, expectedPosition, youtubeWatchUrl, type MediaDescriptor, type SubtitleTrackInfo } from '@watchroom/protocol';
import { Menu, Spinner } from '../components/misc';
import { YouTubeIcon } from '../components/YouTubeIcon';
import type { RoomConnection } from '../lib/connection';
import { isTouch } from '../lib/device';
import { formatBitrate, formatTime } from '../lib/format';
import { local } from '../lib/storage';
import { toast, useRoom } from '../state/room';
import type { PlayerEngine } from './engine';
import { canFullscreenElement, fullscreenElement, onFullscreenChange, toggleFullscreen } from './fullscreen';
import { PlayerChromeContext, type PlayerChrome } from './chrome';
import { ReactionBar, ReactionsOverlay } from './Reactions';
import { Scrubber } from './Scrubber';
import { StyledSubtitleOverlay, useAss } from './AssSubtitles';
import { SubtitleOverlay, useCues, type SubBackground, type SubSize } from './Subtitles';
import { SyncController, type SyncOptions } from './sync';
import { usePlayerShortcuts } from './shortcuts';
import { VideoSurface, type MediaSurface } from './surface';
import { YouTubeSurface } from './youtube';
import s from './Player.module.css';

interface PlayerProps {
  conn: RoomConnection;
  /** Element to put in fullscreen (the stage, so overlays such as chat can come along). */
  stageRef: React.RefObject<HTMLElement | null>;
  chatVisible: boolean;
  onToggleChat(): void;
  isFullscreen: boolean;
  setFullscreen(v: boolean): void;
  overlay?: ReactNode;
}

export function Player(props: PlayerProps) {
  const media = useRoom((st) => st.media);
  const sessionReady = useRoom((st) => st.sessionReady);
  if (!media) {
    return (
      <div className={s.empty}>
        <div className={s.emptyIcon}><Play size={26} /></div>
        <div className={s.emptyTitle}>No video yet</div>
        <div className={s.emptyText}>The host hasn't picked a video. It will appear here automatically.</div>
      </div>
    );
  }
  if (!sessionReady && media.kind === 'file') {
    return <div className={s.empty}><Spinner size={22} /></div>;
  }
  return <PlayerInner key={media.id} media={media} {...props} />;
}

type MenuKind = 'quality' | 'audio' | 'speed' | 'subs' | 'react' | 'more' | null;

/** Auto-pick: the language this person chose before, else forced subtitles, else off. */
function autoSubtitle(tracks: SubtitleTrackInfo[]): string | null {
  const pref = local.get<{ lang: string | null } | null>('wr:subs', null);
  const ready = tracks.filter((t) => t.status === 'ready');
  if (pref) {
    if (pref.lang === null) return null;
    const match = ready.find((t) => t.language === pref.lang) ?? ready.find((t) => t.language?.slice(0, 2) === pref.lang?.slice(0, 2));
    if (match) return match.id;
  }
  return ready.find((t) => t.forced)?.id ?? null;
}
interface Flash { id: number; icon: 'play' | 'pause' | 'seek' | 'rate'; text: string }
const NO_SUBTITLES: SubtitleTrackInfo[] = [];

/** The player on this page, for `__watchroomPlayer()` in the browser console (and the browser tests). */
let activeSurface: MediaSurface | null = null;
(window as unknown as { __watchroomPlayer?: () => unknown }).__watchroomPlayer = () => {
  const m = activeSurface;
  return m && {
    kind: m.kind, ready: m.ready, fatal: m.fatal, t: m.currentTime, paused: m.paused, rate: m.playbackRate,
    muted: m.muted, quality: m.qualityLabel(), sync: useRoom.getState().sync,
  };
};

function PlayerInner({ media, conn, stageRef, chatVisible, onToggleChat, isFullscreen, setFullscreen, overlay }: PlayerProps & { media: MediaDescriptor }) {
  // A file from the host (hls.js into our <video>) or a YouTube video (YouTube's player in a frame).
  const file = media.kind === 'file' ? media : null;
  const youtube = media.kind === 'youtube' ? media : null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<MediaSurface | null>(null);
  const ctrlRef = useRef<SyncController | null>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const me = useRoom((st) => st.me);
  const playback = useRoom((st) => st.playback);
  const participants = useRoom((st) => st.participants);
  const syncState = useRoom((st) => st.sync.state);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volume, setVolume] = useState(() => local.get('wr:volume', 1));
  const [muted, setMuted] = useState(() => local.get('wr:muted', false));
  const [menu, setMenu] = useState<MenuKind>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [showRemaining, setShowRemaining] = useState(false);
  const [localWaiting, setLocalWaiting] = useState(false);
  const subtitles = file?.subtitles ?? NO_SUBTITLES;
  const [subId, setSubId] = useState<string | null>(() => autoSubtitle(subtitles));
  // YouTube's own captions: on/off per viewer (null = YouTube's default for the video).
  const [ytCaptions, setYtCaptions] = useState<boolean | null>(() => local.get<boolean | null>('wr:yt-captions', null));
  const subChosen = useRef(false);
  const [subSize, setSubSize] = useState<SubSize>(() => local.get('wr:subsize', 'm'));
  const [subBg, setSubBg] = useState<SubBackground>(() => local.get('wr:subbg', 'shadow'));
  const settings = useRoom((st) => st.settings);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // Small players (phones in portrait) get a compact bar; menus open as bottom sheets.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 1000) < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hideTimer = useRef<number | null>(null);
  const hoveringControls = useRef(false);
  const touch = isTouch();
  const isHost = me?.role === 'host';
  const locked = settings?.controlMode === 'host' && !isHost;
  const notifyLocked = useCallback(() => toast('info', 'The host is controlling playback in this room.'), []);

  // Subtitles appear as they finish extracting: pick one automatically until this person chooses.
  useEffect(() => {
    if (subChosen.current) return;
    setSubId((cur) => (cur && subtitles.some((t) => t.id === cur && t.status === 'ready') ? cur : autoSubtitle(subtitles)));
  }, [subtitles]);
  const subTrack = subtitles.find((t) => t.id === subId && t.status === 'ready') ?? null;
  // Styled (ASS/SSA) tracks are drawn with their styles and positions; the plain WebVTT version is the fallback.
  const script = useAss(subTrack?.assUrl ?? null);
  const styled = script !== null && script.cues.length > 0;
  const cues = useCues(subTrack && (!subTrack.assUrl || (script !== null && !styled)) ? subTrack.url : null);

  // ---- player + sync lifecycle (hls.js is loaded on demand to keep the join page light)
  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    const canControl = () => {
      const st = useRoom.getState();
      return st.settings?.controlMode !== 'host' || st.me?.role === 'host';
    };
    const begin = (surface: MediaSurface, opts: SyncOptions, extraCleanup?: () => void) => {
      const ctrl = new SyncController(surface, conn, { canControl, onLocked: notifyLocked, ...opts });
      ctrl.onFlagsChange(rerender);
      const off = surface.on('change', rerender);
      surfaceRef.current = surface;
      ctrlRef.current = ctrl;
      activeSurface = surface;
      rerender();
      teardown = () => {
        if (activeSurface === surface) activeSurface = null;
        off();
        ctrl.destroy();
        surface.destroy();
        extraCleanup?.();
      };
    };

    if (media.kind === 'youtube') {
      const yt = media;
      const pb = useRoom.getState().playback;
      // Load where the room will be once the player is ready (that takes a few seconds).
      const start = pb && !yt.isLive ? expectedPosition(pb, conn.serverNow() + (pb.status === 'playing' ? 4000 : 0), yt.duration ?? Infinity) : 0;
      const surface = new YouTubeSurface(ytHostRef.current!, {
        videoId: yt.videoId, start, volume, muted, captions: local.get<boolean | null>('wr:yt-captions', null),
      });
      const roomYouTube = () => {
        const m = useRoom.getState().media;
        return m?.kind === 'youtube' && m.id === yt.id ? m : null;
      };
      // The room learns the length (and whether it is live) from the viewers' players.
      let reported = '';
      const offInfo = surface.on('change', () => {
        const m = roomYouTube();
        const live = surface.isLive;
        const d = surface.duration;
        if (!m || (!live && !(Number.isFinite(d) && d >= 1))) return;
        const amHost = useRoom.getState().me?.role === 'host';
        const differs = live !== m.isLive || (!live && (m.duration === null || (amHost && Math.abs(m.duration - d) > 0.5)));
        const key = live ? 'live' : String(Math.round(d * 10));
        if (!differs || key === reported) return;
        reported = key;
        conn.send({ type: 'media-info', mediaId: m.id, duration: live ? 0 : d, isLive: live });
      });
      begin(surface, {
        duration: () => {
          const known = roomYouTube()?.duration;
          if (known) return known;
          return Number.isFinite(surface.duration) ? surface.duration : Infinity;
        },
        live: () => Boolean(roomYouTube()?.isLive) || surface.isLive,
      }, offInfo);
    } else {
      const fm = media;
      const v = videoRef.current!;
      v.volume = volume;
      v.muted = muted;
      void import('./engine').then(({ PlayerEngine }) => {
        if (cancelled) return;
        const pb = useRoom.getState().playback;
        const start = pb ? expectedPosition(pb, conn.serverNow() + (pb.status === 'playing' ? 1500 : 0), fm.duration) : 0;
        const prefKey = isHost ? 'wr:quality:host' : 'wr:quality:guest';
        let preferLevel = local.get<string>(prefKey, isHost ? (fm.levels[0]?.id ?? 'auto') : 'auto');
        if (preferLevel !== 'auto' && !fm.levels.some((l) => l.id === preferLevel)) preferLevel = isHost ? (fm.levels[0]?.id ?? 'auto') : 'auto';
        const engine = new PlayerEngine(v, fm, {
          startPosition: start, preferLevel, preferAudio: local.get<string | null>('wr:audio', null), capToSize: !isHost,
        });
        engineRef.current = engine;
        begin(new VideoSurface(v, engine), { duration: () => fm.duration }, () => engine.destroy());
      }).catch(() => toast('error', 'The video player failed to load. Reload the page.'));
    }
    return () => {
      cancelled = true;
      teardown?.();
      surfaceRef.current = null;
      engineRef.current = null;
      ctrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.id]);

  // ---- time + buffer display
  useEffect(() => {
    let timer = 0;
    let attached: MediaSurface | null = null;
    let offs: (() => void)[] = [];
    const onWaiting = () => setLocalWaiting(true);
    const onPlaying = () => setLocalWaiting(false);
    const loop = () => {
      const m = surfaceRef.current;
      if (m !== attached) {
        for (const off of offs) off();
        offs = m ? [m.on('waiting', onWaiting), m.on('playing', onPlaying), m.on('canplay', onPlaying), m.on('pause', onPlaying)] : [];
        attached = m;
      }
      if (m) {
        setTime(m.currentTime);
        const ranges = m.bufferedRanges();
        setBuffered((prev) => (prev.length === ranges.length && prev.every((r, i) => Math.abs(r[0] - ranges[i]![0]) < 0.5 && Math.abs(r[1] - ranges[i]![1]) < 0.5) ? prev : ranges));
      }
      timer = window.setTimeout(loop, 250);
    };
    loop();
    return () => {
      window.clearTimeout(timer);
      for (const off of offs) off();
    };
  }, []);

  // ---- fullscreen state
  useEffect(() => onFullscreenChange(() => setFullscreen(Boolean(fullscreenElement()))), [setFullscreen]);

  // ---- action flashes ("Aziz paused")
  const lastVersion = useRef(playback?.version ?? 0);
  useEffect(() => {
    if (!playback || playback.version === lastVersion.current) return;
    lastVersion.current = playback.version;
    const verbs: Record<string, [Flash['icon'], string]> = {
      play: ['play', 'pressed play'], pause: ['pause', 'paused'], seek: ['seek', 'jumped'], rate: ['rate', `set speed ${playback.rate}×`],
    };
    const entry = playback.action && playback.status !== 'waiting' ? verbs[playback.action] : undefined;
    if (!entry || !playback.actor) return;
    if (playback.action === 'play' && playback.status !== 'playing') return;
    const who = playback.actor.id === me?.id ? 'You' : playback.actor.name;
    const id = Date.now();
    setFlash({ id, icon: entry[0], text: `${who} ${entry[1]}` });
    const t = window.setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), 1100);
    return () => window.clearTimeout(t);
  }, [playback, me?.id]);

  // ---- controls auto-hide
  const playing = playback?.status === 'playing';
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hoveringControls.current) setControlsVisible(false);
    }, touch ? 3500 : 2600);
  }, [touch]);
  const chrome = useMemo<PlayerChrome>(() => ({
    pinControls: (on) => {
      hoveringControls.current = on;
      pokeControls();
    },
  }), [pokeControls]);
  useEffect(() => {
    if (!playing || menu || scrubbing || youtube) {
      setControlsVisible(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    } else pokeControls();
  }, [playing, menu, scrubbing, pokeControls, youtube]);

  // ---- what the player shows
  const surface = surfaceRef.current;
  const engine = engineRef.current;
  const ready = surface?.ready ?? false;
  const fatal = surface?.fatal ?? null;
  const live = Boolean(youtube?.isLive) || Boolean(surface instanceof YouTubeSurface && surface.isLive);
  const ownDuration = surface?.duration ?? NaN;
  const duration = file ? file.duration : youtube?.duration ?? (Number.isFinite(ownDuration) ? ownDuration : NaN);
  const durationKnown = !live && Number.isFinite(duration) && duration > 0;
  const waiting = playback?.status === 'waiting';

  // ---- actions
  const ctrl = () => ctrlRef.current;
  const seekBy = useCallback((delta: number) => {
    if (locked) return notifyLocked();
    const m = surfaceRef.current;
    if (m) ctrlRef.current?.requestSeek(m.currentTime + delta);
  }, [locked, notifyLocked]);
  const togglePlay = useCallback(() => {
    if (locked) return notifyLocked();
    ctrlRef.current?.togglePlay();
  }, [locked, notifyLocked]);
  // The player's volume: the surface once it exists (the <video> itself while hls.js is still loading).
  const output = () => surfaceRef.current ?? videoRef.current;
  const changeVolume = useCallback((next: number, mute?: boolean) => {
    const out = surfaceRef.current ?? videoRef.current;
    const vol = Math.min(1, Math.max(0, next));
    if (out) out.volume = vol;
    setVolume(vol);
    local.set('wr:volume', vol);
    const m = mute ?? (vol === 0);
    if (out) out.muted = m;
    setMuted(m);
    local.set('wr:muted', m);
    if (!m && ctrlRef.current?.mutedByPolicy) ctrlRef.current.unlock();
  }, []);
  const toggleMute = useCallback(() => {
    const out = surfaceRef.current ?? videoRef.current;
    if (ctrlRef.current?.mutedByPolicy) {
      ctrlRef.current.unlock();
      setMuted(false);
      return;
    }
    changeVolume(out?.volume || 0.6, !(out?.muted ?? false));
  }, [changeVolume]);
  const fullscreen = useCallback(() => {
    if (stageRef.current) void toggleFullscreen(stageRef.current, videoRef.current);
  }, [stageRef]);
  const setRate = useCallback((delta: number) => {
    if (locked) return notifyLocked();
    const cur = useRoom.getState().playback?.rate ?? 1;
    const i = PLAYBACK_RATES.indexOf(cur as (typeof PLAYBACK_RATES)[number]);
    const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, (i < 0 ? 2 : i) + delta))];
    if (next !== undefined && next !== cur) ctrlRef.current?.requestRate(next);
  }, [locked, notifyLocked]);

  usePlayerShortcuts({
    togglePlay,
    seekBy,
    seekToFraction: (f) => (locked ? notifyLocked() : durationKnown ? ctrl()?.requestSeek(f * duration) : undefined),
    volumeBy: (d) => changeVolume((output()?.volume ?? 1) + d, false),
    toggleMute,
    fullscreen,
    toggleChat: onToggleChat,
    rateBy: setRate,
    poke: pokeControls,
  });

  // ---- click / tap handling on the video surface
  const clickTimer = useRef<number | null>(null);
  const lastTap = useRef<{ t: number; x: number } | null>(null);
  const onSurfaceClick = (e: React.MouseEvent) => {
    if (touch) return;
    if (clickTimer.current) return;
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      if (!locked) ctrl()?.togglePlay();
    }, 220);
    void e;
  };
  const onSurfaceDoubleClick = () => {
    if (touch) return;
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
    fullscreen();
  };
  const onSurfacePointerUp = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const now = Date.now();
    if (!locked && lastTap.current && now - lastTap.current.t < 300 && Math.abs(lastTap.current.x - x) < 0.15 && (x < 0.35 || x > 0.65)) {
      seekBy(x < 0.5 ? -10 : 10);
      lastTap.current = null;
      pokeControls();
      return;
    }
    lastTap.current = { t: now, x };
    if (controlsVisible && playing) setControlsVisible(false);
    else pokeControls();
  };

  const c = ctrlRef.current;
  const current = time;
  const blocked = c?.blocked ?? false;
  const mutedByPolicy = c?.mutedByPolicy ?? false;
  const waitingNames = waiting && playback?.waitReason === 'buffering'
    ? playback.waitingFor.filter((id) => id !== me?.id).map((id) => participants.find((p) => p.id === id)?.name).filter(Boolean) as string[]
    : [];
  const loading = !ready && !fatal;
  // YouTube shows its own loading circle while it buffers; ours covers the file player and the shared start.
  const showSpinner = !fatal && (
    (loading && !youtube)
    || (!loading && !youtube && playing && (localWaiting || syncState === 'buffering' || syncState === 'seeking'))
    || (!loading && waiting && playback?.waitReason === 'starting'));
  const showControls = Boolean(youtube) || controlsVisible || !playing || Boolean(menu);
  const ended = durationKnown && current >= duration - 0.3;
  const yt = surface instanceof YouTubeSurface ? surface : null;
  const ytCaptionsOn = Boolean(yt?.captionsOn ?? ytCaptions);
  const ytQuality = yt?.qualityLabel()?.replace(/^YouTube( · )?/, '') ?? '';
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const qualityOptions = engine ? [
    { id: 'auto', label: engine.auto && engine.levels[engine.currentLevel] ? `Auto (${engine.levels[engine.currentLevel]!.label.replace('Original · ', '')})` : 'Auto', checked: engine.auto },
    ...[...engine.levels].sort((a, b) => b.bitrate - a.bitrate).map((l) => ({
      id: l.id, label: l.label, hint: formatBitrate(l.bitrate), checked: !engine.auto && engine.levels[engine.currentLevel]?.id === l.id,
    })),
  ] : [];
  const qualityLabel = engine ? (engine.auto ? 'Auto' : (engine.levels.find((l, i) => i === engine.currentLevel)?.label.replace('Original · ', '') ?? '…')) : '';

  const fileMenus = file !== null;
  const subtitleButton = file && subtitles.length > 0;
  return (
    <div
      ref={rootRef}
      className={`${s.player} ${youtube ? s.ytMode : showControls ? s.controlsOn : s.controlsOff}`}
      data-mode={media.kind}
      // YouTube: the bar sits below the picture and stays (the frame keeps mouse moves to itself).
      data-controls={youtube ? 'docked' : showControls ? 'visible' : 'hidden'}
      onPointerMove={youtube ? undefined : (e) => { if (e.pointerType !== 'touch') pokeControls(); }}
      // Touch browsers fire pointerleave right after every pointerup (the finger "leaves"); only a mouse
      // really leaving the player should hide the controls.
      onPointerLeave={youtube ? undefined : (e) => { if (e.pointerType !== 'touch' && playing && !menu) setControlsVisible(false); }}
    >
      <div className={s.screen}>
        {youtube ? (
          <>
            <div ref={ytHostRef} className={s.ytHost} />
            {loading && (
              <div className={s.ytPoster}>
                <img className={s.ytPosterImg} src={youtube.thumbnail} alt="" draggable={false} />
                <div className={s.ytPosterInfo}>
                  <Spinner size={34} />
                  <span className={s.ytPosterText}><YouTubeIcon size={18} /> Loading from YouTube…</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <video
              ref={videoRef}
              className={s.video}
              playsInline
              preload="auto"
              controls={false}
              disablePictureInPicture={false}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div
              className={s.surface}
              onClick={onSurfaceClick}
              onDoubleClick={onSurfaceDoubleClick}
              onPointerUp={onSurfacePointerUp}
            />
          </>
        )}

        {showSpinner && !blocked && <div className={`${s.center} ${s.passive}`}><Spinner size={44} /></div>}

        {flash && (
          <div key={flash.id} className={s.flash}>
            <span className={s.flashIcon}>
              {flash.icon === 'play' && <Play size={26} fill="currentColor" />}
              {flash.icon === 'pause' && <Pause size={26} fill="currentColor" />}
              {flash.icon === 'seek' && <RotateCw size={24} />}
              {flash.icon === 'rate' && <Gauge size={24} />}
            </span>
            <span className={s.flashText}>{flash.text}</span>
          </div>
        )}

        {waitingNames.length > 0 && (
          <div className={s.banner}><Spinner size={13} /> Waiting for {waitingNames.join(', ')}…</div>
        )}

        {blocked && !youtube && (
          <div className={s.center}>
            <button className={s.bigPlay} onClick={() => c?.unlock()} aria-label="Start playback">
              <Play size={34} fill="currentColor" />
            </button>
            <div className={s.centerHint}>Your browser needs one tap to start the video</div>
          </div>
        )}
        {blocked && youtube && (
          // The tap has to land in YouTube's own player (a tap on our page doesn't count for it on some phones).
          <div className={s.banner} role="status"><Play size={13} fill="currentColor" /> Tap the video to start it</div>
        )}

        {!blocked && mutedByPolicy && (
          <button className={s.unmuteChip} onClick={() => { c?.unlock(); setMuted(false); }}>
            <VolumeX size={15} /> Sound is off. Tap to unmute
          </button>
        )}

        {fatal && (
          <div className={s.center}>
            <div className={s.errorBox}>
              <strong>{youtube ? 'YouTube can\'t play this video here' : 'Playback problem'}</strong>
              <span>{fatal}</span>
              <div className={s.errorActions}>
                {youtube && (
                  <a className={s.errorLink} href={youtubeWatchUrl(youtube.videoId)} target="_blank" rel="noopener noreferrer">
                    Open on YouTube <ExternalLink size={13} />
                  </a>
                )}
                <button className={s.errorBtn} onClick={() => location.reload()}>Reload</button>
              </div>
            </div>
          </div>
        )}

        {isFullscreen && file && <div className={s.topBar}><span className={s.topTitle}>{media.title}</span></div>}

        {styled && <StyledSubtitleOverlay video={videoRef.current} script={script} size={subSize} background={subBg} raised={showControls} />}
        {!styled && cues && cues.length > 0 && <SubtitleOverlay video={videoRef.current} cues={cues} size={subSize} background={subBg} raised={showControls} />}
        <ReactionsOverlay />
        <PlayerChromeContext.Provider value={chrome}>{overlay}</PlayerChromeContext.Provider>
      </div>

      <div
        className={s.controls}
        onPointerEnter={(e) => { if (e.pointerType !== 'touch') hoveringControls.current = true; }}
        onPointerLeave={() => { hoveringControls.current = false; }}
        // Using a control counts as activity: keep the bar up a little longer.
        onPointerDown={youtube ? undefined : pokeControls}
      >
        {live ? (
          <div className={s.liveTrack} aria-hidden="true" />
        ) : (
          <Scrubber
            current={current} duration={durationKnown ? duration : 0} buffered={buffered} onSeek={(t) => c?.requestSeek(t)} onScrubChange={setScrubbing}
            thumbnails={file?.thumbnails ?? null} disabled={locked || !durationKnown} onBlocked={locked ? notifyLocked : undefined}
          />
        )}
        <div className={s.row}>
          <div className={s.group}>
            <button className={`${s.ctl} ${locked ? s.lockedCtl : ''}`} onClick={togglePlay} aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
              title={locked ? 'The host controls playback' : playing ? 'Pause (Space)' : 'Play (Space)'}>
              {playing || waiting ? <Pause size={22} fill="currentColor" /> : ended ? <RotateCcw size={21} /> : <Play size={22} fill="currentColor" />}
            </button>
            {!live && (
              <>
                <button className={`${s.ctl} ${s.wideOnly} ${locked ? s.lockedCtl : ''}`} onClick={() => seekBy(-10)} aria-label="Back 10 seconds" title="Back 10s (J)">
                  <RotateCcw size={20} /><span className={s.skipNum}>10</span>
                </button>
                <button className={`${s.ctl} ${s.wideOnly} ${locked ? s.lockedCtl : ''}`} onClick={() => seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10s (L)">
                  <RotateCw size={20} /><span className={s.skipNum}>10</span>
                </button>
              </>
            )}
            <div className={`${s.volume} ${touch ? s.wideOnly : ''}`}>
              <button className={s.ctl} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)"><VolumeIcon size={21} /></button>
              {!touch && (
                <input
                  className={s.volumeSlider}
                  type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume}
                  aria-label="Volume"
                  style={{ ['--fill' as string]: `${(muted ? 0 : volume) * 100}%` }}
                  onChange={(e) => changeVolume(Number(e.target.value), Number(e.target.value) === 0)}
                />
              )}
            </div>
            {live ? (
              <span className={s.liveChip} title="A live stream: everyone watches it live"><span className={s.liveDot} />LIVE</span>
            ) : (
              <button className={`${s.time} tabular`} onClick={() => setShowRemaining((x) => !x)} title="Toggle remaining time">
                {showRemaining && durationKnown ? `-${formatTime(Math.max(0, duration - current))}` : formatTime(current)}
                <span className={s.timeSep}>/</span>
                <span className={s.timeTotal}>{durationKnown ? formatTime(duration) : '--:--'}</span>
              </button>
            )}
          </div>
          <div className={s.group}>
            <div className={s.menuAnchor}>
              <button className={s.ctl} onClick={() => setMenu(menu === 'react' ? null : 'react')} aria-label="React" title="React">
                <SmilePlus size={20} />
              </button>
              {menu === 'react' && <ReactionBar onReact={(emoji) => conn.send({ type: 'reaction', emoji: emoji as never })} onClose={() => setMenu(null)} />}
            </div>
            {yt?.captionsAvailable && (
              <button
                className={`${s.ctl} ${ytCaptionsOn ? s.ctlOn : ''}`}
                onClick={() => {
                  const next = !ytCaptionsOn;
                  yt.setCaptions(next);
                  setYtCaptions(next);
                  local.set('wr:yt-captions', next);
                }}
                aria-label="Subtitles" title="Subtitles (YouTube's, only on your device)" aria-pressed={ytCaptionsOn}
              >
                <Captions size={20} />
              </button>
            )}
            {subtitleButton && (
              <div className={s.menuAnchor}>
                <button className={`${s.ctl} ${subTrack ? s.ctlOn : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles" title="Subtitles" aria-pressed={Boolean(subTrack)}>
                  <Captions size={20} />
                </button>
                {menu === 'subs' && (
                  <Menu
                    title="Subtitles" keepOpen sheet={narrow}
                    options={[
                      { id: 'off', label: 'Off', checked: !subTrack },
                      ...subtitles.map((t) => ({
                        id: t.id, label: t.label, checked: subTrack?.id === t.id, disabled: t.status !== 'ready',
                        hint: t.status === 'extracting' ? 'Preparing…' : t.status === 'unsupported' ? 'Picture-based' : t.status === 'failed' ? 'Unreadable' : undefined,
                      })),
                    ]}
                    onSelect={(id) => {
                      subChosen.current = true;
                      const t = subtitles.find((x) => x.id === id);
                      setSubId(t ? t.id : null);
                      local.set('wr:subs', { lang: t ? t.language ?? t.label : null });
                    }}
                    extra={(
                      <>
                        <div className={s.chips} role="radiogroup" aria-label="Subtitle size">
                          {(['s', 'm', 'l'] as const).map((z) => (
                            <button key={z} className={`${s.chip} ${subSize === z ? s.chipOn : ''}`} role="radio" aria-checked={subSize === z}
                              onClick={() => { setSubSize(z); local.set('wr:subsize', z); }}>{z === 's' ? 'Small' : z === 'm' ? 'Medium' : 'Large'}</button>
                          ))}
                        </div>
                        <div className={s.chips} role="radiogroup" aria-label="Subtitle background">
                          {(['shadow', 'box'] as const).map((b) => (
                            <button key={b} className={`${s.chip} ${subBg === b ? s.chipOn : ''}`} role="radio" aria-checked={subBg === b}
                              onClick={() => { setSubBg(b); local.set('wr:subbg', b); }}>{b === 'shadow' ? 'Outline' : 'Dark box'}</button>
                          ))}
                        </div>
                      </>
                    )}
                    note="Only changes the subtitles on your device."
                    onClose={() => setMenu(null)}
                  />
                )}
              </div>
            )}
            {!live && (
              <div className={`${s.menuAnchor} ${s.wideOnly}`}>
                <button className={`${s.ctl} ${s.textCtl} ${locked ? s.lockedCtl : ''}`} onClick={() => (locked ? notifyLocked() : setMenu(menu === 'speed' ? null : 'speed'))} aria-label="Playback speed" title="Speed (shared)">
                  {playback?.rate ?? 1}×
                </button>
                {menu === 'speed' && (
                  <Menu
                    title="Speed" note="Speed changes for everyone in the room." sheet={narrow}
                    options={PLAYBACK_RATES.map((r) => ({ id: String(r), label: r === 1 ? 'Normal' : `${r}×`, checked: (playback?.rate ?? 1) === r }))}
                    onSelect={(id) => c?.requestRate(Number(id))} onClose={() => setMenu(null)}
                  />
                )}
              </div>
            )}
            {fileMenus && engine && engine.audio.length > 1 && (
              <div className={`${s.menuAnchor} ${s.wideOnly}`}>
                <button className={s.ctl} onClick={() => setMenu(menu === 'audio' ? null : 'audio')} aria-label="Audio track" title="Audio track">
                  <AudioLines size={20} />
                </button>
                {menu === 'audio' && (
                  <Menu
                    title="Audio" note="Only changes the audio on your device." sheet={narrow}
                    options={engine.audio.map((a, i) => ({ id: a.id, label: a.label, checked: engine.currentAudio >= 0 ? engine.audio[engine.currentAudio]?.id === a.id : i === 0 }))}
                    onSelect={(id) => { engine.setAudio(id); local.set('wr:audio', id); }} onClose={() => setMenu(null)}
                  />
                )}
              </div>
            )}
            {fileMenus ? (
              <div className={s.menuAnchor}>
                <button className={`${s.ctl} ${s.qualityCtl}`} onClick={() => setMenu(menu === 'quality' ? null : 'quality')} aria-label="Quality" title="Quality">
                  <Settings2 size={19} /><span className={s.qualityText}>{qualityLabel}</span>
                </button>
                {menu === 'quality' && (
                  <Menu
                    title="Quality" note="Only changes the quality on your device." sheet={narrow}
                    options={qualityOptions}
                    onSelect={(id) => { engine?.setLevel(id); local.set(isHost ? 'wr:quality:host' : 'wr:quality:guest', id); }}
                    onClose={() => setMenu(null)}
                  />
                )}
              </div>
            ) : (
              <span className={s.sourceChip} title="Streams from YouTube to each viewer; YouTube picks the quality for each connection">
                <YouTubeIcon size={17} />{ytQuality && <span className={s.qualityText}>{ytQuality}</span>}
              </span>
            )}
            <div className={`${s.menuAnchor} ${s.narrowOnly}`}>
              <button className={s.ctl} onClick={() => setMenu(menu === 'more' ? null : 'more')} aria-label="More options" title="More">
                <Ellipsis size={20} />
              </button>
              {menu === 'more' && (
                <Menu
                  title="More" keepOpen sheet
                  options={[
                    ...(!live ? [{ id: 'speed', label: `Speed · ${playback?.rate ?? 1}×`, disabled: locked, hint: 'everyone' }] : []),
                    ...(engine && engine.audio.length > 1 ? [{ id: 'audio', label: `Audio · ${(engine.audio[engine.currentAudio] ?? engine.audio[0])?.label ?? ''}` }] : []),
                    ...(!live ? [{ id: 'back', label: 'Back 10 seconds', disabled: locked }, { id: 'forward', label: 'Forward 10 seconds', disabled: locked }] : []),
                    ...(youtube ? [{ id: 'youtube', label: 'Open on YouTube' }] : []),
                  ]}
                  onSelect={(id) => {
                    if (id === 'back' || id === 'forward') { seekBy(id === 'back' ? -10 : 10); setMenu(null); }
                    else if (id === 'youtube' && youtube) { window.open(youtubeWatchUrl(youtube.videoId, Math.floor(current)), '_blank', 'noopener,noreferrer'); setMenu(null); }
                    else setMenu(id as MenuKind);
                  }}
                  onClose={() => setMenu(null)}
                />
              )}
            </div>
            <button className={s.ctl} onClick={onToggleChat} aria-label={chatVisible ? 'Hide chat' : 'Show chat'} title="Chat (C)" aria-pressed={chatVisible}>
              <MessageSquare size={20} />
            </button>
            {(canFullscreenElement() || touch) && (
              <button className={s.ctl} onClick={fullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)">
                {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
