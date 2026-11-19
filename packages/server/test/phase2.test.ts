import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/room/images';
import { detectCharset, findExternalSubtitles } from '../src/media/subtitles';

describe('sniffImage', () => {
  it('reads PNG and GIF sizes from the bytes', () => {
    const png = Buffer.alloc(32);
    png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.write('IHDR', 12, 'latin1');
    png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
    expect(sniffImage(png)).toEqual({ type: 'png', width: 640, height: 480 });
    const gif = Buffer.alloc(32);
    gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
    expect(sniffImage(gif)).toEqual({ type: 'gif', width: 320, height: 200 });
  });
  it('rejects things that only claim to be images', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00\x01\x00\x00\x00', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.alloc(10))).toBeNull();
    const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(30)]);
    expect(sniffImage(truncatedJpeg)).toBeNull();
  });
});

describe('detectCharset', () => {
  it('recognises UTF-8, UTF-16 and legacy Cyrillic vs Western text', () => {
    expect(detectCharset(Buffer.from('Привет, мир!', 'utf8'))).toBe('utf-8');
    expect(detectCharset(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16');
    // "Привет мир" in Windows-1251
    expect(detectCharset(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0]))).toBe('windows-1251');
    // "Café crème brûlée, très bon" in Windows-1252: accents are sparse
    expect(detectCharset(Buffer.from('Caf\xe9 cr\xe8me br\xfbl\xe9e, tr\xe8s bon et d\xe9licieux', 'latin1'))).toBe('windows-1252');
  });
});

describe('findExternalSubtitles', () => {
  it('matches subtitle files that belong to the video, with language and forced flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-subs-'));
    for (const n of ['Movie.mkv', 'Movie.srt', 'Movie.en.srt', 'Movie.rus.forced.ass', 'Movie 2.srt', 'Movie2.srt', 'Other.srt', 'Movie.txt']) writeFileSync(join(dir, n), '');
    const found = findExternalSubtitles(join(dir, 'Movie.mkv'));
    expect(found.map((f) => f.path.split('/').pop())).toEqual(['Movie.en.srt', 'Movie.rus.forced.ass', 'Movie.srt']);
    expect(found[0]).toMatchObject({ language: 'en', label: 'English', forced: false });
    expect(found[1]).toMatchObject({ language: 'rus', forced: true });
    expect(found[1]!.label).toContain('Russian');
  });
});
