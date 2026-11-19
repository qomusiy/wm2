import type { IncomingHttpHeaders } from 'node:http';

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // YouTube thumbnails (chat link cards, the YouTube player's poster).
    "img-src 'self' data: blob: https://i.ytimg.com",
    "media-src 'self' blob:",
    // 'self' covers ws:/wss: to this same host (CSP level 3); nothing else may be contacted.
    "connect-src 'self'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    // Only YouTube's privacy-enhanced embedded player may be framed (it runs isolated, in its own origin).
    "frame-src https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export const SESSION_COOKIE = 'wr_s';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** True when the browser reached us over HTTPS (directly or via the tunnel). */
export function isSecureRequest(headers: IncomingHttpHeaders, encrypted: boolean): boolean {
  if (encrypted) return true;
  const proto = headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true;
  const visitor = headers['cf-visitor'];
  return typeof visitor === 'string' && visitor.includes('"https"');
}

/** Best-effort client address for rate limiting (trusts Cloudflare's header only on loopback connections). */
export function clientAddress(headers: IncomingHttpHeaders, remote: string | undefined): string {
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const cf = headers['cf-connecting-ip'];
  if (loopback && typeof cf === 'string' && cf) return cf;
  return remote ?? 'unknown';
}
