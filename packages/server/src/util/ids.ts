import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Unbiased random string from an unambiguous alphabet (no 0/O/1/l/I). */
export function randomId(length = 12): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** 128-bit+ secret encoded as base64url. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
