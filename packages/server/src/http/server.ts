import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@watchroom/protocol';
import type { MediaSession } from '../media/session';
import { IMAGE_MIME, type ChatImageStore } from '../room/images';
import { SegmentError } from '../media/scheduler';
import type { Room, Participant } from '../room/room';
import type { Logger } from '../util/log';
import { TokenBucket } from '../util/ratelimit';
import { SECURITY_HEADERS, SESSION_COOKIE, clientAddress, isSecureRequest, parseCookies } from './headers';

export interface HttpContext {
  room(): Room | null;
  media(): MediaSession | null;
  recordUpload(bytes: number, participantId: string): void;
  images: ChatImageStore;
  log: Logger;
}

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const RID_RE = /^[a-z0-9-]{1,16}$/;

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}

export async function buildHttp(ctx: HttpContext, staticDir: string | null): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    // Routes may set a stricter policy (chat images are sandboxed); never loosen it.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });

  const indexFile = staticDir ? join(staticDir, 'index.html') : null;
  const hasStatic = Boolean(indexFile && existsSync(indexFile));
  if (staticDir && hasStatic) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      index: false,
      wildcard: true,
      preCompressed: true,
      cacheControl: false,
      setHeaders(res, path) {
        res.header('Cache-Control', /[\/]assets[\/]/.test(path) ? 'public, max-age=31536000, immutable'
          : /[\/]stickers[\/]/.test(path) ? 'public, max-age=604800' : 'no-cache');
      },
    });
  }

  const sendIndex = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!hasStatic) return reply.code(503).type('text/plain').send('Web client not built. Run `npm run build`.');
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  };
  app.get('/', sendIndex);
  app.get('/join/:roomId', sendIndex);

  app.get('/healthz', async (_req, reply) => noStore(reply).send({ ok: true }));

  // ---- room preview (join page) ------------------------------------------------
  const previewLimiter = new Map<string, TokenBucket>();
  app.post<{ Params: { roomId: string }; Body: { key?: unknown } }>('/api/rooms/:roomId/preview', async (req, reply) => {
    noStore(reply);
    const ip = clientAddress(req.headers, req.socket.remoteAddress);
    let bucket = previewLimiter.get(ip);
    if (!bucket) {
      if (previewLimiter.size > 5000) previewLimiter.clear();
      bucket = new TokenBucket(20, 0.5);
      previewLimiter.set(ip, bucket);
    }
    if (!bucket.take()) return reply.code(429).send({ error: 'rate_limited' });
    const room = ctx.room();
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!room || req.params.roomId !== room.id) return reply.code(404).send({ error: 'room_not_found' });
    const preview = room.preview(key);
    if (!preview) return reply.code(403).send({ error: 'invalid_key' });
    return preview;
  });

  // ---- session cookie for media requests -------------------------------------------
  app.post<{ Body: { token?: unknown } }>('/api/session', async (req, reply) => {
    noStore(reply);
    const room = ctx.room();
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const p = room && token ? room.participantByToken(token) : undefined;
    if (!p) return reply.code(401).send({ error: 'invalid_session' });
    const secure = isSecureRequest(req.headers, Boolean((req.socket as { encrypted?: boolean }).encrypted));
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    return { ok: true };
  });

  // ---- chat images ------------------------------------------------------------------
  const participantFrom = (req: FastifyRequest): Participant | undefined => {
    const room = ctx.room();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return room && token ? room.participantByToken(token) : undefined;
  };
  // Raw image bodies only (the browser already resized and re-encoded them, which also strips EXIF/GPS).
  app.addContentTypeParser(/^image\/(png|jpeg|gif|webp)$/, { parseAs: 'buffer', bodyLimit: LIMITS.imageMaxBytes }, (_req, body, done) => done(null, body));
  const uploadLimiter = new Map<string, TokenBucket>();
  app.post('/api/chat/images', { bodyLimit: LIMITS.imageMaxBytes }, async (req, reply) => {
    noStore(reply);
    const p = participantFrom(req);
    if (!p) return reply.code(401).send({ error: 'not_joined' });
    let bucket = uploadLimiter.get(p.info.id);
    if (!bucket) {
      bucket = new TokenBucket(6, 0.1);
      uploadLimiter.set(p.info.id, bucket);
    }
    if (!bucket.take()) return reply.code(429).send({ error: 'rate_limited' });
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'unsupported_type' });
    try {
      const img = await ctx.images.save(p.info.id, req.body);
      return { id: img.id, width: img.width, height: img.height };
    } catch (err) {
      const code = (err as Error).message;
      return reply.code(code === 'storage_full' ? 507 : 400).send({ error: code });
    }
  });
  app.get<{ Params: { id: string } }>('/api/chat/images/:id', async (req, reply) => {
    if (!participantFrom(req)) return noStore(reply).code(401).send({ error: 'not_joined' });
    if (!/^[A-Za-z0-9]{8,40}$/.test(req.params.id)) return reply.code(404).send();
    const img = ctx.images.get(req.params.id);
    if (!img) return noStore(reply).code(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', IMAGE_MIME[img.type])
      .header('Content-Length', String(img.bytes))
      .header('Cache-Control', 'private, max-age=86400, immutable')
      .header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(createReadStream(img.path));
  });

  // ---- media ------------------------------------------------------------------------
  const authorize = (req: FastifyRequest, reply: FastifyReply, mediaId: string): { media: MediaSession; participant: Participant } | null => {
    const room = ctx.room();
    const media = ctx.media();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const participant = room && token ? room.participantByToken(token) : undefined;
    if (!participant) {
      void noStore(reply).code(401).send({ error: 'not_joined' });
      return null;
    }
    if (!media || media.id !== mediaId) {
      void noStore(reply).code(404).send({ error: 'media_not_found' });
      return null;
    }
    return { media, participant };
  };

  const playlistReply = (reply: FastifyReply, body: string) =>
    noStore(reply).type('application/vnd.apple.mpegurl').send(body);

  const segmentErrorReply = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SegmentError) {
      if (err.status === 503) reply.header('Retry-After', '1');
      return noStore(reply).code(err.status).send({ error: err.message });
    }
    ctx.log.error('media request failed', err);
    return noStore(reply).code(500).send({ error: 'internal' });
  };

  app.get<{ Params: { mediaId: string; file: string } }>('/media/:mediaId/:file', async (req, reply) => {
    const { mediaId, file } = req.params;
    if (!ID_RE.test(mediaId)) return reply.code(404).send();
    const auth = authorize(req, reply, mediaId);
    if (!auth) return reply;
    if (file === 'master.m3u8') return playlistReply(reply, auth.media.masterPlaylist());
    const m = /^master-([a-z0-9-]{1,16})\.m3u8$/.exec(file);
    if (m) {
      try {
        return playlistReply(reply, auth.media.masterPlaylist(m[1]));
      } catch (err) {
        return segmentErrorReply(reply, err);
      }
    }
    return reply.code(404).send();
  });

  app.get<{ Params: { mediaId: string; rid: string; file: string } }>('/media/:mediaId/:rid/:file', async (req, reply) => {
    const { mediaId, rid, file } = req.params;
    if (!ID_RE.test(mediaId) || !RID_RE.test(rid)) return reply.code(404).send();
    const auth = authorize(req, reply, mediaId);
    if (!auth) return reply;
    if (rid === 'subs') {
      const m = /^([a-z0-9]{1,16})\.(vtt|ass)$/.exec(file);
      const path = !m ? null : m[2] === 'vtt' ? auth.media.subtitlePath(m[1]!) : auth.media.subtitleScriptPath(m[1]!);
      if (!path) return noStore(reply).code(404).send({ error: 'not_found' });
      // ASS scripts are plain text to us (parsed by the player, never rendered as a document).
      const type = m![2] === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8';
      return reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=3600').send(createReadStream(path));
    }
    if (rid === 'thumbs') {
      const m = /^(\d{1,4})\.jpg$/.exec(file);
      const path = m ? auth.media.thumbnailPath(Number(m[1])) : null;
      if (!path) return noStore(reply).code(404).send({ error: 'not_found' });
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
    }
    if (file === 'index.m3u8') {
      try {
        const body = await Promise.race([
          auth.media.mediaPlaylist(rid),
          new Promise<never>((_, rej) => setTimeout(() => rej(new SegmentError('playlist not ready', 503)), 20_000)),
        ]);
        return playlistReply(reply, body);
      } catch (err) {
        return segmentErrorReply(reply, err);
      }
    }
    // Fingerprint of an existing segment, so a viewer can verify bytes another viewer sent it.
    const sum = /^(\d{1,6})\.ts\.sha256$/.exec(file);
    if (sum) {
      const hash = await auth.media.segmentHash(rid, Number(sum[1]), auth.participant.info.id);
      if (!hash) return noStore(reply).code(404).send({ error: 'not_ready' });
      return reply.header('Cache-Control', 'private, max-age=86400').type('text/plain').send(hash);
    }
    const seg = /^(\d{1,6})\.ts$/.exec(file);
    if (!seg) return reply.code(404).send();
    let path: string;
    try {
      path = await auth.media.segment(rid, Number(seg[1]), auth.participant.info.id);
    } catch (err) {
      return segmentErrorReply(reply, err);
    }
    const info = await stat(path).catch(() => null);
    if (!info) return segmentErrorReply(reply, new SegmentError('segment vanished', 503));
    const stream = createReadStream(path);
    const pid = auth.participant.info.id;
    // The host's own playback is local disk -> local window, not upload; keep it out of the bandwidth meter.
    if (auth.participant.info.role !== 'host') stream.on('data', (chunk) => ctx.recordUpload(chunk.length, pid));
    return reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', String(info.size))
      .header('Cache-Control', 'private, max-age=86400')
      .send(stream);
  });

  app.setNotFoundHandler((_req, reply) => noStore(reply).code(404).type('text/plain').send('Not found'));
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) ctx.log.error('http error', err);
    return noStore(reply).code(status).send({ error: status >= 500 ? 'internal' : 'bad_request' });
  });
  return app;
}
