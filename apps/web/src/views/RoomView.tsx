import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Columns2, FolderOpen, Globe, Link2, MessageSquare, PanelRightClose, PanelRightOpen, Play, Rows2, SlidersHorizontal, TvMinimalPlay, Upload, Users, Wifi, WifiOff,
} from 'lucide-react';
import type { HostStatus, RecentVideo } from '@watchroom/protocol';
import { Button, IconButton } from '../components/Button';
import { Avatar, Menu, Modal, Spinner } from '../components/misc';
import { YouTubeIcon } from '../components/YouTubeIcon';
import { ChatPanel } from '../chat/ChatPanel';
import { PeopleList } from '../chat/PeopleList';
import { copyText } from '../lib/clipboard';
import type { RoomConnection } from '../lib/connection';
import { formatBitrate, formatDuration, formatTime } from '../lib/format';
import { local } from '../lib/storage';
import { Player } from '../player/Player';
import { focusChatMessage, toast, useRoom } from '../state/room';
import { Popups } from './Popups';
import { RoomPanel } from './RoomPanel';
import { ShareDialog } from './ShareDialog';
import { YouTubeLinkForm } from './YouTubeLinkForm';
import s from './RoomView.module.css';

export interface HostControls {
  status: HostStatus | null;
  openVideo?(): void;
  setLinkMode?(mode: HostStatus['link']['mode'], customBase?: string | null): Promise<string | null>;
  retryTunnel?(): void;
  regenerateLink?(): void;
  addSubtitle?(): void;
  recent?: RecentVideo[];
  openRecent?(id: string, fromStart: boolean): void;
}

type Layout = 'side' | 'stacked';

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function RoomView({ conn, host }: { conn: RoomConnection; host?: HostControls }) {
  const media = useRoom((st) => st.media);
  const me = useRoom((st) => st.me);
  const participants = useRoom((st) => st.participants);
  const unread = useRoom((st) => st.unread);
  const [layout, setLayout] = useState<Layout>(() => local.get<Layout>('wr:layout', 'side'));
  const [panelOpen, setPanelOpen] = useState(() => local.get('wr:panel', true));
  const [panelWidth, setPanelWidth] = useState(() => local.get('wr:panel-w', 360));
  const [resizing, setResizing] = useState(false);
  const [tab, setTab] = useState<'chat' | 'people' | 'room'>('chat');
  const [fullscreen, setFullscreen] = useState(false);
  // In full screen and on phones in landscape the video fills everything; chat is an overlay drawer.
  const [drawer, setDrawer] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const narrow = useMedia('(max-width: 760px), (orientation: portrait) and (max-width: 1100px)');
  const immersive = useMedia('(orientation: landscape) and (max-height: 520px) and (pointer: coarse)');
  const overlayMode = fullscreen || immersive;
  const effective: Layout = narrow ? 'stacked' : layout;
  const isHost = me?.role === 'host';
  const chatVisible = overlayMode ? drawer : panelOpen && tab === 'chat';

  // Unread counter while chat isn't visible.
  const chatLen = useRoom((st) => st.chat.length);
  const prevLen = useRef(chatLen);
  useEffect(() => {
    const added = chatLen - prevLen.current;
    prevLen.current = chatLen;
    const last = useRoom.getState().chat[chatLen - 1];
    if (added > 0 && !chatVisible && last?.kind === 'user' && last.authorId !== me?.id) useRoom.setState((st) => ({ unread: st.unread + added }));
  }, [chatLen, chatVisible, me?.id]);
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${media?.title ?? 'Watchroom'}` : media?.title ? `${media.title} · Watchroom` : 'Watchroom';
  }, [unread, media?.title]);
  useEffect(() => { if (!overlayMode) setDrawer(false); }, [overlayMode]);

  const togglePanel = useCallback(() => {
    setPanelOpen((open: boolean) => {
      local.set('wr:panel', !open);
      return !open;
    });
  }, []);
  const toggleChat = useCallback(() => {
    if (overlayMode) {
      setDrawer((d) => !d);
      return;
    }
    if (!panelOpen) {
      setTab('chat');
      togglePanel();
    } else if (tab !== 'chat') setTab('chat');
    else togglePanel();
  }, [overlayMode, panelOpen, tab, togglePanel]);

  // From a notification card: bring the chat into view and point at the message.
  const openChatAt = useCallback((messageId?: string) => {
    if (overlayMode) setDrawer(true);
    else {
      setTab('chat');
      if (!panelOpen) togglePanel();
    }
    if (messageId) focusChatMessage(messageId);
  }, [overlayMode, panelOpen, togglePanel]);

  // Drag the panel edge to resize (side-by-side layout); double-click resets.
  const startResize = (e: React.PointerEvent) => {
    const main = mainRef.current;
    if (!main) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setResizing(true);
    const rect = main.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(Math.max(rect.right - ev.clientX, 280), Math.min(720, rect.width * 0.6)));
      setPanelWidth(w);
    };
    const up = () => {
      setResizing(false);
      setPanelWidth((w: number) => { local.set('wr:panel-w', w); return w; });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const others = participants.filter((p) => p.id !== me?.id && p.connected);
  const guests = participants.filter((p) => p.role !== 'host');
  const showAside = panelOpen && !immersive;

  return (
    <div className={`${s.room} ${immersive ? s.immersive : ''}`}>
      <header className={s.titlebar}>
        <div className={s.brand}>
          <span className={s.logo}><Play size={12} fill="currentColor" /></span>
          <span className={s.brandName}>Watchroom</span>
        </div>
        <span className={`${s.sep} ${s.hideNarrow}`} />
        <div className={s.title}>
          {media?.kind === 'youtube' && <YouTubeIcon size={18} className={s.titleIcon} />}
          <span className={s.titleText}>{media?.title ?? 'Waiting for a video'}</span>
          {media && <span className={s.chip}>{media.sourceSummary}</span>}
        </div>
        <div className={s.actions}>
          <div className={s.avatars} title={participants.map((p) => p.name).join(', ')}>
            {participants.filter((p) => p.connected).slice(0, 4).map((p) => <Avatar key={p.id} name={p.name} color={p.color} size={26} />)}
            {participants.length > 4 && <span className={s.more}>+{participants.length - 4}</span>}
          </div>
          {isHost && host && <VideoMenu host={host} onYouTube={() => setYoutubeOpen(true)} />}
          {isHost && (
            <Button variant="primary" size="sm" icon={<Link2 size={14} />} onClick={() => setShareOpen(true)}>Invite</Button>
          )}
          {!narrow && (
            <IconButton
              label={layout === 'side' ? 'Chat below video' : 'Chat beside video'}
              onClick={() => {
                const next = layout === 'side' ? 'stacked' : 'side';
                setLayout(next);
                local.set('wr:layout', next);
              }}
            >
              {layout === 'side' ? <Rows2 size={17} /> : <Columns2 size={17} />}
            </IconButton>
          )}
          <IconButton label={panelOpen ? 'Hide side panel' : 'Show side panel'} onClick={togglePanel}>
            {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </IconButton>
        </div>
      </header>

      <main
        ref={mainRef}
        className={`${s.main} ${s[effective]} ${showAside ? '' : s.panelHidden} ${resizing ? s.resizing : ''}`}
        style={effective === 'side' ? ({ '--panel-w': `${panelWidth}px` } as React.CSSProperties) : undefined}
      >
        <section ref={stageRef} className={s.stage}>
          <Player
            conn={conn}
            stageRef={stageRef}
            chatVisible={chatVisible}
            onToggleChat={toggleChat}
            isFullscreen={fullscreen}
            setFullscreen={setFullscreen}
            overlay={overlayMode && drawer
              ? <div className={s.drawer}><ChatPanel conn={conn} active /></div>
              // Whenever the chat is out of sight, new messages pop up over the video.
              : !chatVisible ? <Popups conn={conn} onOpenChat={openChatAt} /> : null}
          />
        </section>
        {showAside && (
          <aside className={s.panel} aria-label="Side panel">
            {effective === 'side' && (
              <div className={s.resizer} role="separator" aria-orientation="vertical" aria-label="Resize side panel"
                onPointerDown={startResize} onDoubleClick={() => { setPanelWidth(360); local.set('wr:panel-w', 360); }} />
            )}
            <div className={s.tabs} role="tablist">
              <button role="tab" aria-selected={tab === 'chat'} className={`${s.tab} ${tab === 'chat' ? s.tabActive : ''}`} onClick={() => setTab('chat')}>
                <MessageSquare size={14} /> Chat
                {unread > 0 && tab !== 'chat' && <span className={`${s.count} ${s.unread}`}>{unread}</span>}
              </button>
              <button role="tab" aria-selected={tab === 'people'} className={`${s.tab} ${tab === 'people' ? s.tabActive : ''}`} onClick={() => setTab('people')}>
                <Users size={14} /> People <span className={s.count}>{participants.filter((p) => p.connected).length}</span>
              </button>
              {isHost && host && (
                <button role="tab" aria-selected={tab === 'room'} className={`${s.tab} ${tab === 'room' ? s.tabActive : ''}`} onClick={() => setTab('room')}>
                  <SlidersHorizontal size={14} /> Room
                </button>
              )}
            </div>
            {isHost && guests.length === 0 && media && host && tab === 'chat' && <InviteCard host={host} onMore={() => setShareOpen(true)} />}
            <div className={s.tabBody}>
              {tab === 'chat' && <ChatPanel conn={conn} active={!overlayMode} />}
              {tab === 'people' && <PeopleList conn={conn} />}
              {tab === 'room' && host && <RoomPanel conn={conn} host={host} />}
            </div>
          </aside>
        )}
      </main>

      <StatusBar isHost={isHost} host={host} others={others.length} onShare={() => setShareOpen(true)} />
      {shareOpen && host && <ShareDialog host={host} onClose={() => setShareOpen(false)} />}
      {youtubeOpen && (
        <Modal title="Watch a YouTube video" onClose={() => setYoutubeOpen(false)} width={460}>
          <div className={s.ytDialog}>
            <YouTubeLinkForm autoFocus onOpen={(url) => conn.openYouTube(url)} onDone={() => setYoutubeOpen(false)} />
            <p className={s.ytNote}>
              Everyone in the room switches to it. YouTube streams it to each person directly, so your upload isn't used.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Switch videos without leaving the room: open a file, paste a YouTube link, or pick up a recent one where it was left. */
function VideoMenu({ host, onYouTube }: { host: HostControls; onYouTube(): void }) {
  const [open, setOpen] = useState(false);
  const others = host.openRecent ? (host.recent ?? []).filter((v) => !v.current && !v.missing).slice(0, 6) : [];
  if (!host.openVideo && !others.length) {
    // Hosting from a browser (no file dialog): YouTube is the only choice.
    return <IconButton label="Watch a YouTube video" onClick={onYouTube}><TvMinimalPlay size={17} /></IconButton>;
  }
  return (
    <span style={{ position: 'relative' }}>
      <IconButton label="Open another video" onClick={() => setOpen((o) => !o)}><FolderOpen size={17} /></IconButton>
      {open && (
        <Menu
          title="Open a video"
          placement="bottom"
          options={[
            ...(host.openVideo ? [{ id: '__file', label: 'Choose a file…', hint: 'Ctrl+O' }] : []),
            { id: '__youtube', label: 'YouTube link…' },
            ...others.map((v) => ({
              id: v.id, label: v.title,
              hint: v.position > 0 ? `from ${formatTime(v.position)}` : v.kind === 'youtube' ? 'YouTube' : formatDuration(v.duration),
            })),
          ]}
          onSelect={(id) => (id === '__file' ? host.openVideo?.() : id === '__youtube' ? onYouTube() : host.openRecent?.(id, false))}
          onClose={() => setOpen(false)}
          note="Everyone in the room switches to the new video."
        />
      )}
    </span>
  );
}

function InviteCard({ host, onMore }: { host: HostControls; onMore(): void }) {
  const link = host.status?.link;
  const url = link?.shareUrl ?? null;
  return (
    <div className={s.invite}>
      <div className={s.inviteTitle}><Link2 size={15} /> Invite your friends</div>
      <div className={s.inviteText}>Send this link. They open it in a browser, type a name, and you watch together.</div>
      {url ? (
        <div className={s.inviteRow}>
          <div className={s.linkField} title={url}>{url}</div>
          <Button variant="primary" size="sm" onClick={async () => { if (await copyText(url)) toast('success', 'Link copied'); }}>Copy</Button>
        </div>
      ) : (
        <div className={s.inviteStatus}>
          {link?.tunnel.state === 'error' ? <>Link unavailable. <Button size="sm" variant="ghost" onClick={onMore}>Details</Button></> : <><Spinner size={13} /> {link?.tunnel.detail ?? 'Creating your link…'}</>}
        </div>
      )}
    </div>
  );
}

function StatusBar({ isHost, host, others, onShare }: { isHost: boolean; host?: HostControls; others: number; onShare(): void }) {
  const phase = useRoom((st) => st.phase);
  const rtt = useRoom((st) => st.rtt);
  const sync = useRoom((st) => st.sync);
  const player = useRoom((st) => st.player);
  const playback = useRoom((st) => st.playback);
  const participants = useRoom((st) => st.participants);
  const media = useRoom((st) => st.media);
  const connected = phase === 'joined';
  const waitingNames = playback?.status === 'waiting' && playback.waitReason === 'buffering'
    ? playback.waitingFor.map((id) => participants.find((p) => p.id === id)?.name).filter(Boolean).join(', ') : '';
  const syncText = !media ? '' : ({
    idle: '', loading: 'Loading video…', synced: 'In sync',
    correcting: sync.drift !== null && Math.abs(sync.drift) < 0.15 ? 'In sync' : `Syncing ${sync.drift !== null ? `(${sync.drift > 0 ? '+' : ''}${sync.drift.toFixed(2)}s)` : ''}`,
    seeking: 'Catching up…', waiting: waitingNames ? `Waiting for ${waitingNames}` : 'Starting…', paused: 'Paused',
    buffering: 'Buffering…', blocked: 'Tap the video to play',
  } as const)[sync.state];
  const link = host?.status?.link;
  const linkLabel = !link ? null
    : link.mode === 'tunnel'
      ? ({ idle: 'Link off', installing: 'Setting up link…', starting: 'Starting link…', verifying: 'Checking link…', online: 'Link ready', error: 'Link error', stopped: 'Link off' } as const)[link.tunnel.state]
      : link.mode === 'lan' ? 'Local network link' : link.mode === 'custom' ? 'Custom link' : 'This computer only';
  return (
    <footer className={s.statusbar}>
      <span className={s.item} title={connected ? 'Connected to the room' : 'Connection lost, retrying'}>
        {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
        <span className={`${s.dot} ${connected ? s.ok : phase === 'reconnecting' ? s.warn : s.bad}`} />
        {connected ? 'Connected' : phase === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        {connected && rtt !== null && <span className={`${s.muted} tabular`}>{Math.round(rtt)} ms</span>}
      </span>
      {syncText && <span className={s.item}>{syncText}</span>}
      <span className={s.spacer} />
      {isHost && host?.status && (
        <span className={s.item} title="Your current upload to viewers">
          <Upload size={13} /> <span className="tabular">{formatBitrate(host.status.stats.uploadBps)}</span>
        </span>
      )}
      {isHost && linkLabel && (
        <button className={s.item} onClick={onShare} title="Sharing link">
          <Globe size={13} />
          <span className={`${s.dot} ${link?.shareUrl ? s.ok : link?.tunnel.state === 'error' ? s.bad : s.warn}`} />
          {linkLabel}
        </button>
      )}
      {media && player.quality && <span className={`${s.item} ${s.hideNarrow}`}>{player.quality}</span>}
      <span className={s.item} title={`${others} other ${others === 1 ? 'person' : 'people'} connected`}><Users size={13} /> {others + 1}</span>
    </footer>
  );
}
