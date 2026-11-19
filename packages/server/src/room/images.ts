import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from '@watchroom/protocol';
import { randomId } from '../util/ids';
import type { Logger } from '../util/log';

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

export const IMAGE_MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * Identify an image from its bytes (never from a name or a client-supplied type) and read its size.
 * Only PNG, JPEG, GIF and WebP are accepted; anything else (SVG, HTML, executables…) returns null.
 */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length < 24) return null;
  // PNG: signature + IHDR
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF87a / GIF89a: logical screen size
  const head6 = buf.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP + VP8/VP8L/VP8X chunk
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const b0 = buf[21]!; const b1 = buf[22]!; const b2 = buf[23]!; const b3 = buf[24]!;
      return { type: 'webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') {
      return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    return null;
  }
  // JPEG: walk markers to the first SOFn frame header
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

interface StoredImage extends ImageInfo {
  id: string;
  owner: string;
  path: string;
  bytes: number;
}

/** Chat images for the current room session. Deleted when the room ends or the app restarts. */
export class ChatImageStore {
  private readonly images = new Map<string, StoredImage>();
  private total = 0;

  constructor(private readonly dir: string, private readonly log: Logger, private readonly capBytes = 400 * 1024 * 1024) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  async save(owner: string, data: Buffer): Promise<StoredImage> {
    if (data.length > LIMITS.imageMaxBytes) throw new Error('too_large');
    const info = sniffImage(data);
    if (!info) throw new Error('unsupported_type');
    if (info.width < 1 || info.height < 1 || info.width > LIMITS.imageMaxDimension || info.height > LIMITS.imageMaxDimension) throw new Error('bad_dimensions');
    if (this.total + data.length > this.capBytes) throw new Error('storage_full');
    const id = randomId(20);
    const path = join(this.dir, `${id}.${info.type}`);
    await writeFile(path, data, { mode: 0o600 });
    const img: StoredImage = { ...info, id, owner, path, bytes: data.length };
    this.images.set(id, img);
    this.total += data.length;
    this.log.debug(`chat image ${id} ${info.type} ${info.width}x${info.height} ${data.length}B`);
    return img;
  }

  get(id: string): StoredImage | undefined {
    return this.images.get(id);
  }

  clear(): void {
    this.images.clear();
    this.total = 0;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
}
