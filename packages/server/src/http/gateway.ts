import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CloseCode, type ServerMessage } from '@watchroom/protocol';
import { ClientMessage } from '@watchroom/protocol/schemas';
import type { Participant, Room, RoomSocket } from '../room/room';
import type { Logger } from '../util/log';
import { TokenBucket } from '../util/ratelimit';
import { clientAddress } from './headers';

const MAX_CONNECTIONS = 64;
const MAX_PER_ADDRESS = 12;
const JOIN_TIMEOUT_MS = 20_000;
const HEARTBEAT_MS = 15_000;

export class Gateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private readonly perAddress = new Map<string, number>();
  private connections = 0;

  constructor(private readonly getRoom: () => Room | null, private readonly log: Logger) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch { /* fallthrough */ }
    const addr = clientAddress(req.headers, req.socket.remoteAddress);
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (pathname !== '/ws') return reject('404 Not Found');
    // Browsers always say where a page came from: a page on another site may not open a room connection here.
    // (Joining needs the room key anyway; this is defence in depth.) Non-browser clients send no Origin.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch { /* "null" or garbage */ }
      if (!originHost || originHost.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) return reject('403 Forbidden');
    }
    if (this.connections >= MAX_CONNECTIONS || (this.perAddress.get(addr) ?? 0) >= MAX_PER_ADDRESS) return reject('503 Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, addr));
  }

  closeAll(): void {
    for (const ws of this.wss.clients) ws.close(CloseCode.goingAway, 'server shutting down');
  }

  private onConnection(ws: WebSocket, addr: string): void {
    this.connections++;
    this.perAddress.set(addr, (this.perAddress.get(addr) ?? 0) + 1);
    let participant: Participant | null = null;
    let room: Room | null = null;
    const preJoin = new TokenBucket(40, 10);
    // Malformed messages get a short answer; a client that keeps sending them is cut off.
    const malformed = new TokenBucket(10, 1);
    // Set when we cut a client off for misbehaving: its seat is freed at once instead of being held for a reconnect.
    // (Close codes can't tell us: a client still sending usually loses the connection before the close handshake.)
    let expelled = false;
    const expel = (reason: string) => {
      expelled = true;
      socket.close(CloseCode.protocol, reason);
    };
    const socket: RoomSocket = {
      send: (msg: ServerMessage) => {
        if (ws.readyState !== ws.OPEN) return;
        // A client that cannot keep up gets dropped rather than buffering unboundedly.
        if (ws.bufferedAmount > 4 * 1024 * 1024) {
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
      },
    };
    const joinTimer = setTimeout(() => socket.close(CloseCode.joinTimeout, 'join timeout'), JOIN_TIMEOUT_MS);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return expel('binary not supported');
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString('utf8'));
      } catch {
        return expel('invalid json');
      }
      const parsed = ClientMessage.safeParse(raw);
      if (!parsed.success) {
        if (!malformed.take()) return expel('too many malformed messages');
        socket.send({ type: 'error', code: 'bad_request', message: 'Malformed message.', fatal: false });
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'ping') {
        if (!participant && !preJoin.take()) return expel('too many messages');
        socket.send({ type: 'pong', id: msg.id, t0: msg.t0, serverTime: Date.now() });
        return;
      }
      if (!participant) {
        if (!preJoin.take()) return expel('too many messages');
        if (msg.type !== 'join') return;
        room = this.getRoom();
        if (!room) {
          socket.send({ type: 'error', code: 'room_not_found', message: 'This room does not exist anymore.', fatal: true });
          return socket.close(CloseCode.joinFailed, 'room_not_found');
        }
        const res = room.join(socket, msg);
        if (!res.ok) {
          socket.send({ type: 'error', code: res.code, message: res.message, fatal: true });
          return socket.close(CloseCode.joinFailed, res.code);
        }
        participant = res.participant;
        clearTimeout(joinTimer);
        socket.send({
          type: 'welcome', participantId: participant.info.id, token: participant.token, role: participant.info.role, snapshot: room.snapshot(),
        });
        return;
      }
      if (msg.type === 'join') return;
      try {
        room!.handle(participant, msg);
      } catch (err) {
        this.log.error('message handler failed', err);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(joinTimer);
      clearInterval(heartbeat);
      this.connections--;
      const n = (this.perAddress.get(addr) ?? 1) - 1;
      if (n <= 0) this.perAddress.delete(addr);
      else this.perAddress.set(addr, n);
      if (!participant || !room) return;
      // Cut off for breaking the protocol (or oversized/invalid frames): the seat is freed at once. Ordinary drops
      // keep it for the reconnect grace period.
      if (expelled || code === CloseCode.protocol || code === 1009 || code === 1007) room.leave(participant);
      else room.disconnect(participant, socket);
    });
    // Protocol errors from the ws library (oversized frame, invalid UTF-8…) end the connection: treat as expelled.
    ws.on('error', (err) => {
      expelled = true;
      this.log.debug('socket error', err);
    });
  }
}
