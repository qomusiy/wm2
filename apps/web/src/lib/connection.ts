import {
  ClockSync, CloseCode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage,
} from '@watchroom/protocol';
import { useRoom, toast } from '../state/room';
import { deviceId, deviceKind } from './device';
import { session } from './storage';

export interface JoinParams {
  roomId: string;
  key?: string;
  hostToken?: string;
  name: string;
  password?: string;
}

type Outgoing = Exclude<ClientMessage, { type: 'join' }>;
type Listener = (msg: ServerMessage) => void;

export interface OpenResult {
  ok: boolean;
  error?: string;
}

/** Monotonic local clock in ms (immune to wall-clock adjustments). */
export const localNow = () => performance.now();

/**
 * One WebSocket session with automatic reconnect + seamless resume, and continuous clock sync.
 */
export class RoomConnection {
  readonly clock = new ClockSync(24);
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private fatal = false;
  private pingTimer: number | null = null;
  private burstTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private pingId = 0;
  private readonly listeners = new Set<Listener>();
  private readonly pendingOpens = new Map<string, (r: OpenResult) => void>();
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') {
      if (this.ws?.readyState === WebSocket.OPEN) this.pingBurst();
      else this.reconnectNow();
    }
  };
  private readonly onOnline = () => this.reconnectNow();

  constructor(private readonly params: JoinParams) {}

  start(): void {
    useRoom.setState({ phase: 'connecting', error: null, roomId: this.params.roomId });
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
    this.open();
  }

  stop(leave = true): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    this.clearTimers();
    if (leave) this.send({ type: 'leave' });
    this.ws?.close(CloseCode.normal, 'bye');
    this.ws = null;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(msg: Outgoing): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  serverNow(): number {
    return this.clock.serverNow(localNow());
  }

  /** Ask the room to play a YouTube video (the host checks the link with YouTube first). */
  openYouTube(url: string, timeoutMs = 20_000): Promise<OpenResult> {
    const requestId = Math.random().toString(36).slice(2, 12) || 'r';
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingOpens.delete(requestId);
        resolve({ ok: false, error: 'No answer from the host. Try again.' });
      }, timeoutMs);
      this.pendingOpens.set(requestId, (r) => {
        window.clearTimeout(timer);
        this.pendingOpens.delete(requestId);
        resolve(r);
      });
      if (!this.send({ type: 'open-youtube', url, requestId })) this.pendingOpens.get(requestId)?.({ ok: false, error: 'Not connected right now. Try again in a moment.' });
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && useRoom.getState().phase === 'joined';
  }

  private resumeKey(): string {
    return `wr:resume:${this.params.roomId}`;
  }

  private open(): void {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const resume = session.get<{ participantId: string; token: string } | null>(this.resumeKey(), null);
      ws.send(JSON.stringify({
        type: 'join', protocol: PROTOCOL_VERSION, roomId: this.params.roomId, name: this.params.name,
        deviceId: deviceId(), device: deviceKind(),
        ...(this.params.key ? { key: this.params.key } : {}),
        ...(this.params.hostToken ? { hostToken: this.params.hostToken } : {}),
        ...(this.params.password ? { password: this.params.password } : {}),
        ...(resume ? { resume } : {}),
      }));
      this.pingBurst();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      void this.handle(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(e);
    };
  }

  private async handle(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case 'welcome': {
        const s = msg.snapshot;
        session.set(this.resumeKey(), { participantId: msg.participantId, token: msg.token });
        this.attempts = 0;
        useRoom.setState({
          phase: 'joined', error: null, me: { id: msg.participantId, role: msg.role }, participants: s.participants,
          playback: s.playback, media: s.media, chat: s.chat, settings: s.settings,
        });
        const ok = await fetch('/api/session', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ token: msg.token }),
        }).then((r) => r.ok).catch(() => false);
        useRoom.setState({ sessionReady: ok });
        if (!ok) toast('error', 'Could not authorise video playback. Reload the page.');
        break;
      }
      case 'pong':
        this.clock.addSample(msg.t0, msg.serverTime, localNow());
        useRoom.setState({ rtt: this.clock.rtt });
        break;
      case 'playback':
        useRoom.setState({ playback: msg.playback });
        break;
      case 'participants':
        useRoom.setState((st) => ({
          participants: msg.participants,
          typing: st.typing.filter((id) => msg.participants.some((p) => p.id === id && p.connected)),
        }));
        break;
      case 'chat':
        useRoom.setState((st) => (st.chat.some((m) => m.id === msg.message.id) ? st : { chat: [...st.chat, msg.message].slice(-500) }));
        break;
      case 'media':
        useRoom.setState({ media: msg.media });
        break;
      case 'chat-preview':
        // The host looked up a YouTube link from a chat message: show its title and picture.
        useRoom.setState((st) => ({
          chat: st.chat.map((m) => (m.id === msg.messageId && m.kind === 'user' ? { ...m, preview: msg.preview } : m)),
        }));
        break;
      case 'open-result':
        this.pendingOpens.get(msg.requestId)?.({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
        break;
      case 'settings':
        useRoom.setState({ settings: msg.settings });
        break;
      case 'notice':
        toast(msg.level === 'error' ? 'error' : msg.level === 'warning' ? 'warning' : 'info', msg.text);
        break;
      case 'error':
        if (msg.fatal) {
          this.fatal = true;
          useRoom.setState({ phase: 'failed', error: { code: msg.code, message: msg.message } });
        } else {
          toast('warning', msg.message);
        }
        break;
      case 'typing':
        useRoom.setState((st) => ({
          typing: msg.active ? [...new Set([...st.typing, msg.participantId])] : st.typing.filter((x) => x !== msg.participantId),
        }));
        break;
      case 'reaction':
        useRoom.setState((st) => ({ reactions: [...st.reactions, { id: msg.id, emoji: msg.emoji, participantId: msg.participantId }].slice(-40) }));
        window.setTimeout(() => useRoom.setState((st) => ({ reactions: st.reactions.filter((r) => r.id !== msg.id) })), 3200);
        break;
      case 'kicked':
        this.fatal = true;
        session.remove(this.resumeKey());
        useRoom.setState({ phase: 'kicked' });
        break;
      case 'ended':
        this.fatal = true;
        session.remove(this.resumeKey());
        useRoom.setState({ phase: 'ended', error: { code: 'ended', message: msg.reason } });
        break;
    }
    for (const l of this.listeners) l(msg);
  }

  private onClose(e: CloseEvent): void {
    this.clearPings();
    if (this.stopped || this.fatal) return;
    if (e.code === CloseCode.kicked) {
      useRoom.setState({ phase: 'kicked' });
      return;
    }
    if (e.code === CloseCode.ended) {
      useRoom.setState({ phase: 'ended' });
      return;
    }
    if (e.code === CloseCode.replaced) {
      this.fatal = true;
      useRoom.setState({ phase: 'failed', error: { code: 'replaced', message: 'This room was opened in another tab.' } });
      return;
    }
    const joined = useRoom.getState().me !== null;
    useRoom.setState({ phase: joined ? 'reconnecting' : 'connecting' });
    const base = Math.min(8000, 500 * 2 ** this.attempts);
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private reconnectNow(): void {
    if (this.stopped || this.fatal || this.ws) return;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.attempts = 0;
    this.open();
  }

  /** Several quick pings to (re)establish the clock offset, then a steady cadence. */
  private pingBurst(): void {
    this.clearPings();
    let n = 0;
    const burst = () => {
      this.ping();
      if (++n < 6) this.burstTimer = window.setTimeout(burst, 200);
    };
    burst();
    this.pingTimer = window.setInterval(() => this.ping(), 4000);
  }

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'ping', id: ++this.pingId, t0: localNow() }));
  }

  private clearPings(): void {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.burstTimer) window.clearTimeout(this.burstTimer);
    this.pingTimer = null;
    this.burstTimer = null;
  }

  private clearTimers(): void {
    this.clearPings();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
