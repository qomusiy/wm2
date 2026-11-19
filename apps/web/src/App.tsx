import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DoorOpen, Link2Off, MonitorX, PartyPopper, UserX } from 'lucide-react';
import type { HostStatus, LinkMode, RecentVideo } from '@watchroom/protocol';
import { Button } from './components/Button';
import { Toasts } from './components/misc';
import { bridge } from './lib/bridge';
import { RoomConnection } from './lib/connection';
import { PeerSwarm } from './p2p/swarm';
import { local, session } from './lib/storage';
import { toast, useRoom } from './state/room';
import { HostHome } from './views/HostHome';
import { JoinView } from './views/JoinView';
import { RoomView, type HostControls } from './views/RoomView';
import { StateScreen } from './views/StateScreen';

type Route =
  | { kind: 'host'; roomId?: string; token?: string }
  | { kind: 'join'; roomId: string; key: string }
  | { kind: 'landing' };

function parseRoute(): Route {
  if (bridge) return { kind: 'host' };
  const hash = location.hash.slice(1);
  const hostMatch = /^host=([A-Za-z0-9]+)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (hostMatch) return { kind: 'host', roomId: hostMatch[1]!, token: hostMatch[2]! };
  const join = /^\/join\/([A-Za-z0-9]{4,32})\/?$/.exec(location.pathname);
  if (join && /^[A-Za-z0-9_-]{8,128}$/.test(hash)) return { kind: 'join', roomId: join[1]!, key: hash };
  return { kind: 'landing' };
}

export function App() {
  const route = useMemo(parseRoute, []);
  return (
    <>
      {route.kind === 'host' && <HostApp roomId={route.roomId} token={route.token} />}
      {route.kind === 'join' && <GuestApp roomId={route.roomId} roomKey={route.key} />}
      {route.kind === 'landing' && (
        <StateScreen icon={<Link2Off size={24} />} title="You need an invite link" text="Ask the person hosting the watch party to send you their link, then open it here." />
      )}
      <Toasts />
    </>
  );
}

// ------------------------------------------------------------------------------------------ host

function HostApp({ roomId, token }: { roomId?: string; token?: string }) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [conn, setConn] = useState<RoomConnection | null>(null);
  const [name, setName] = useState(() => local.get('wr:hostname', 'Host'));
  const joinName = useRef(name);
  const [dragging, setDragging] = useState(false);
  const media = useRoom((st) => st.media);
  const phase = useRoom((st) => st.phase);

  // The recent list is fetched separately (it carries poster images) whenever the server says it changed.
  const [recent, setRecent] = useState<RecentVideo[]>([]);
  const recentVersion = status?.recentVersion;
  useEffect(() => {
    if (!bridge || recentVersion === undefined) return;
    let stale = false;
    void bridge.listRecent().then((list) => { if (!stale) setRecent(list); }, () => {});
    return () => { stale = true; };
  }, [recentVersion]);
  const recentActions = useMemo(() => ({
    open: (id: string, fromStart: boolean) => {
      void bridge?.openRecent(id, fromStart).then((res) => { if (!res.ok) toast('error', res.error, 6000); });
    },
    remove: (id: string | null) => { void bridge?.removeRecent(id); },
  }), []);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getStatus().then(setStatus);
    return bridge.onStatus(setStatus);
  }, []);

  useEffect(() => {
    let c: RoomConnection | null = null;
    let cancelled = false;
    void (async () => {
      const creds = bridge ? await bridge.hostJoin() : roomId && token ? { roomId, hostToken: token } : null;
      if (!creds || cancelled) return;
      c = new RoomConnection({ roomId: creds.roomId, hostToken: creds.hostToken, name: joinName.current });
      c.start();
      setConn(c);
    })();
    return () => {
      cancelled = true;
      c?.stop(true);
    };
  }, [roomId, token]);

  const openVideo = useCallback(async () => {
    if (!bridge) return;
    const res = await bridge.openVideoDialog();
    if (res && !res.ok) toast('error', res.error, 6000);
  }, []);

  // Drag & drop a file anywhere; Ctrl/Cmd+O opens the picker.
  useEffect(() => {
    if (!bridge) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const res = await bridge!.openVideoFile(file);
      if (!res.ok) toast('error', res.error, 6000);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openVideo();
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('keydown', key);
    };
  }, [openVideo]);

  const controls: HostControls = {
    status,
    openVideo: bridge ? () => void openVideo() : undefined,
    setLinkMode: bridge ? async (mode: LinkMode, base?: string | null) => {
      const res = await bridge!.setLinkMode(mode, base);
      return res.ok ? null : res.error;
    } : undefined,
    retryTunnel: bridge ? () => void bridge!.retryTunnel() : undefined,
    regenerateLink: bridge ? () => void bridge!.regenerateLink().then(() => toast('success', 'New link created. The old one no longer works.')) : undefined,
    addSubtitle: bridge ? () => void bridge!.addSubtitleDialog().then((res) => {
      if (res && !res.ok) toast('error', res.error, 6000);
      else if (res) toast('success', 'Subtitles added. Everyone can turn them on from the CC button.');
    }) : undefined,
    recent: bridge ? recent : undefined,
    openRecent: bridge ? recentActions.open : undefined,
  };

  if (phase === 'failed' || phase === 'ended') {
    return <StateScreen icon={<MonitorX size={24} />} title="Disconnected" text={useRoom.getState().error?.message ?? 'The host session stopped.'} action={<Button onClick={() => location.reload()}>Reload</Button>} />;
  }
  if (!conn || !media) {
    return (
      <HostHome
        status={status} canOpen={Boolean(bridge)} dragging={dragging} onOpen={() => void openVideo()} name={name}
        recent={recent} recentActions={recentActions}
        onOpenYouTube={conn ? (url) => conn.openYouTube(url) : undefined}
        onRename={(n) => {
          local.set('wr:hostname', n);
          setName(n);
          joinName.current = n;
          conn?.send({ type: 'rename', name: n });
        }}
      />
    );
  }
  return <RoomView conn={conn} host={controls} />;
}

// ------------------------------------------------------------------------------------------ guest

const RETRYABLE = new Set(['password_required', 'wrong_password', 'room_full', 'room_locked', 'rate_limited', 'bad_request']);

function GuestApp({ roomId, roomKey }: { roomId: string; roomKey: string }) {
  const [conn, setConn] = useState<RoomConnection | null>(null);
  const phase = useRoom((st) => st.phase);
  const error = useRoom((st) => st.error);
  const me = useRoom((st) => st.me);
  const connRef = useRef<RoomConnection | null>(null);

  const join = useCallback((name: string, password?: string) => {
    connRef.current?.stop(false);
    useRoom.setState({ error: null, phase: 'connecting' });
    const c = new RoomConnection({ roomId, key: roomKey, name, ...(password ? { password } : {}) });
    connRef.current = c;
    setConn(c);
    c.start();
  }, [roomId, roomKey]);

  // Direct delivery (WebRTC) lives as long as the connection; it switches itself on and off with the room setting.
  useEffect(() => {
    if (!conn) return;
    const swarm = new PeerSwarm(conn);
    return () => swarm.destroy();
  }, [conn]);

  // A page refresh rejoins silently with the same seat.
  useEffect(() => {
    const resume = session.get<{ participantId: string } | null>(`wr:resume:${roomId}`, null);
    const name = local.get('wr:name', '');
    if (resume && name) join(name);
    const leave = () => connRef.current?.stop(true);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      connRef.current?.stop(false);
    };
  }, [join, roomId]);

  if (phase === 'kicked') {
    return <StateScreen icon={<UserX size={24} />} title="You were removed" text="The host removed you from this watch party." />;
  }
  if (phase === 'ended') {
    return <StateScreen icon={<PartyPopper size={24} />} title="The watch party has ended" text={error?.message ?? 'The host closed the room. Thanks for watching!'} />;
  }
  if (phase === 'failed' && error && !RETRYABLE.has(error.code)) {
    return <StateScreen icon={<DoorOpen size={24} />} title="Can't join this room" text={error.message} action={<Button onClick={() => location.reload()}>Try again</Button>} />;
  }
  if (conn && me && (phase === 'joined' || phase === 'reconnecting')) return <RoomView conn={conn} />;
  return (
    <JoinView
      roomId={roomId} roomKey={roomKey}
      busy={phase === 'connecting' && Boolean(conn)}
      error={phase === 'failed' ? error?.message ?? null : null}
      needPassword={error?.code === 'password_required' || error?.code === 'wrong_password'}
      onJoin={join}
    />
  );
}
