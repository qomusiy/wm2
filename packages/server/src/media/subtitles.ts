import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { SubtitleTrackInfo } from '@watchroom/protocol';
import { sha1 } from '../util/ids';
import type { Logger } from '../util/log';
import { lowPriority } from '../util/lowprio';
import { jailed } from '../util/sandbox';
import { run } from '../util/proc';
import { languageName, type ProbeResult } from './probe';
import { renameRetry } from '../util/fsx';

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'];

/**
 * Pick the text encoding of a legacy subtitle file. UTF-8/UTF-16 need nothing. Otherwise decide between
 * Windows-1251 (Cyrillic: nearly every letter is a high byte) and Windows-1252 (Western: accents are sparse).
 */
export function detectCharset(buf: Buffer): 'utf-8' | 'utf-16' | 'windows-1251' | 'windows-1252' {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return 'utf-16';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch { /* legacy single-byte */ }
  let high = 0;
  let asciiLetters = 0;
  for (const b of buf) {
    if (b >= 0x80) high++;
    else if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) asciiLetters++;
  }
  return high / Math.max(1, high + asciiLetters) > 0.3 ? 'windows-1251' : 'windows-1252';
}

interface ExternalCandidate {
  path: string;
  language: string | null;
  label: string;
  forced: boolean;
}

/** Subtitle files next to the video: movie.srt, movie.en.srt, movie.rus.forced.ass … */
export function findExternalSubtitles(videoPath: string): ExternalCandidate[] {
  const dir = dirname(videoPath);
  const base = basename(videoPath, extname(videoPath)).toLowerCase();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ExternalCandidate[] = [];
  for (const name of names.sort()) {
    const ext = extname(name).slice(1).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) continue;
    const stem = name.slice(0, name.length - ext.length - 1);
    if (!stem.toLowerCase().startsWith(base)) continue;
    const rest = stem.slice(base.length);
    if (rest && !/^[._\- ]/.test(rest)) continue; // "movie2.srt" belongs to another video
    const parts = rest.split(/[._\- ]+/).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => /^\d+$/.test(p))) continue; // "Movie 2.srt" is another video
    const forced = parts.some((p) => p.toLowerCase() === 'forced');
    const code = parts.find((p) => /^[a-z]{2,3}$/i.test(p) && languageName(p.toLowerCase()) && languageName(p.toLowerCase()) !== p.toLowerCase());
    const language = code ? code.toLowerCase() : null;
    const words = parts.filter((p) => p !== code && p.toLowerCase() !== 'forced');
    const lang = languageName(language);
    const label = [lang, words.join(' ')].filter(Boolean).join(' · ') || 'External subtitles';
    out.push({ path: join(dir, name), language, label: forced ? `${label} (forced)` : label, forced });
  }
  return out;
}

interface Track {
  info: SubtitleTrackInfo;
  vtt: string;
  /** Original ASS/SSA script kept next to the WebVTT (styled tracks only). */
  ass: string | null;
  /** External file this track is converted from. */
  source?: string;
}

const MAX_EXTERNAL_BYTES = 10 * 1024 * 1024;

/** Converts subtitle tracks (embedded text tracks and external files) to WebVTT for per-viewer display. */
export class SubtitleManager extends EventEmitter {
  private readonly tracks: Track[] = [];
  private closed = false;

  constructor(
    private readonly probe: ProbeResult,
    private readonly dir: string,
    private readonly ffmpeg: string,
    private readonly urlBase: string,
    private readonly log: Logger,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  list(): SubtitleTrackInfo[] {
    return this.tracks.map((t) => {
      const ready = t.info.status === 'ready';
      return {
        ...t.info,
        url: ready ? `${this.urlBase}/${t.info.id}.vtt` : null,
        assUrl: ready && t.ass && existsSync(t.ass) ? `${this.urlBase}/${t.info.id}.ass` : null,
      };
    });
  }

  path(id: string): string | null {
    const t = this.tracks.find((x) => x.info.id === id);
    return t && t.info.status === 'ready' ? t.vtt : null;
  }

  assPath(id: string): string | null {
    const t = this.tracks.find((x) => x.info.id === id);
    return t && t.info.status === 'ready' && t.ass && existsSync(t.ass) ? t.ass : null;
  }

  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }

  private changed(): void {
    if (!this.closed) this.emit('change');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Register every track right away (so viewers see what is coming), then convert in the background. */
  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const embeddedText: Track[] = [];
    for (const s of this.probe.subtitles) {
      const lang = languageName(s.language);
      const label = [s.title && lang && !s.title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} · ${s.title}` : (s.title ?? lang ?? `Subtitles ${s.typeIndex + 1}`)]
        .concat(s.forced ? ['(forced)'] : []).join(' ');
      const vtt = join(this.dir, `s${s.typeIndex}.vtt`);
      const ass = ['ass', 'ssa'].includes(s.codec) ? join(this.dir, `s${s.typeIndex}.ass`) : null;
      const t: Track = {
        info: {
          id: `s${s.typeIndex}`, label, language: s.language && s.language !== 'und' ? s.language : null, default: s.isDefault, forced: s.forced,
          source: 'embedded', status: s.textBased ? (existsSync(vtt) && (!ass || existsSync(ass)) ? 'ready' : 'extracting') : 'unsupported',
          url: null, assUrl: null,
        },
        vtt,
        ass,
      };
      this.tracks.push(t);
      if (s.textBased && t.info.status === 'extracting') embeddedText.push(t);
    }
    const externals = findExternalSubtitles(this.probe.path);
    for (const c of externals) this.registerExternal(c);
    this.changed();

    if (embeddedText.length) await this.extractEmbedded(embeddedText);
    for (const t of this.tracks.filter((x) => x.info.source === 'external' && x.info.status === 'extracting')) {
      await this.convertExternal(t, t.source ?? '');
    }
  }

  private registerExternal(c: ExternalCandidate): Track {
    const id = `x${sha1(c.path).slice(0, 8)}`;
    const existing = this.tracks.find((t) => t.info.id === id);
    if (existing) return existing;
    const styled = ['.ass', '.ssa'].includes(extname(c.path).toLowerCase());
    const t: Track = {
      info: { id, label: c.label, language: c.language, default: false, forced: c.forced, source: 'external', status: 'extracting', url: null, assUrl: null },
      vtt: join(this.dir, `${id}.vtt`),
      ass: styled ? join(this.dir, `${id}.ass`) : null,
      source: c.path,
    };
    this.tracks.push(t);
    return t;
  }

  /** Host picked a subtitle file explicitly. */
  async addExternal(path: string): Promise<SubtitleTrackInfo> {
    const ext = extname(path).slice(1).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.includes(ext)) throw new Error('Choose an .srt, .vtt, .ass or .ssa file.');
    const name = basename(path, extname(path));
    const parts = name.split(/[._\- ]+/);
    const code = parts.reverse().find((p) => /^[a-z]{2,3}$/i.test(p) && languageName(p.toLowerCase()) !== p.toLowerCase());
    const language = code?.toLowerCase() ?? null;
    const t = this.registerExternal({ path, language, label: languageName(language) ?? name, forced: false });
    t.info.status = 'extracting';
    this.changed();
    await this.convertExternal(t, path);
    if ((t.info.status as SubtitleTrackInfo['status']) !== 'ready') throw new Error('That subtitle file could not be read.');
    return t.info;
  }

  private async extractEmbedded(tracks: Track[]): Promise<void> {
    // One pass over the file for all text tracks (the file is read once, video is not decoded).
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', this.probe.path];
    for (const t of tracks) {
      const s = this.probe.subtitles.find((x) => `s${x.typeIndex}` === t.info.id)!;
      args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', `${t.vtt}.part`);
      // Styled tracks: also keep the script itself, untouched, for the styled renderer.
      if (t.ass) args.push('-map', `0:${s.index}`, '-c:s', 'copy', '-f', 'ass', `${t.ass}.part`);
    }
    const [cmd, cmdArgs] = jailed(...lowPriority(this.ffmpeg, args), { read: [this.probe.path], write: [this.dir] });
    const res = await run(cmd, cmdArgs, { timeoutMs: 30 * 60_000, signal: this.signal }).catch((err: Error) => ({ code: -1, stderr: err.message, stdout: '', signal: null }));
    for (const t of tracks) {
      if (res.code === 0 && existsSync(`${t.vtt}.part`)) {
        await renameRetry(`${t.vtt}.part`, t.vtt);
        if (t.ass) {
          if (existsSync(`${t.ass}.part`)) await renameRetry(`${t.ass}.part`, t.ass);
          else t.ass = null;
        }
        t.info.status = 'ready';
      } else {
        await unlink(`${t.vtt}.part`).catch(() => {});
        if (t.ass) await unlink(`${t.ass}.part`).catch(() => {});
        t.info.status = 'failed';
      }
    }
    if (res.code !== 0) this.log.warn(`subtitle extraction failed: ${res.stderr.trim().slice(-300)}`);
    this.changed();
  }

  private async convertExternal(t: Track, source: string): Promise<void> {
    try {
      const st = await stat(source);
      if (st.size > MAX_EXTERNAL_BYTES) throw new Error('subtitle file too large');
      const raw = await readFile(source);
      const charset = detectCharset(raw);
      let input = source;
      let tmp: string | null = null;
      if (charset === 'windows-1251' || charset === 'windows-1252') {
        // Re-encode legacy text to UTF-8 ourselves (robust, no reliance on ffmpeg's iconv).
        tmp = join(this.dir, `${t.info.id}.utf8${extname(source)}`);
        await writeFile(tmp, new TextDecoder(charset).decode(raw), 'utf8');
        input = tmp;
      }
      if (t.ass) {
        // The styled renderer reads the script directly: keep a UTF-8 copy (without a byte-order mark).
        const encoding = charset === 'utf-16' ? (raw[0] === 0xfe ? 'utf-16be' : 'utf-16le') : charset;
        const text = new TextDecoder(encoding).decode(raw).replace(/^﻿/, '');
        if (!/^\s*\[Script Info\]/i.test(text)) t.ass = null;
        else await writeFile(t.ass, text, 'utf8');
      }
      const [cmd, cmdArgs] = jailed(this.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input, '-c:s', 'webvtt', '-f', 'webvtt', `${t.vtt}.part`], { read: [input], write: [this.dir] });
      const res = await run(cmd, cmdArgs, { timeoutMs: 60_000, signal: this.signal });
      if (tmp) await unlink(tmp).catch(() => {});
      if (res.code !== 0) throw new Error(res.stderr.trim().slice(-200));
      await renameRetry(`${t.vtt}.part`, t.vtt);
      t.info.status = 'ready';
      this.log.info(`subtitles ready: ${t.info.label}${charset.startsWith('windows') ? ` (converted from ${charset})` : ''}`);
    } catch (err) {
      await unlink(`${t.vtt}.part`).catch(() => {});
      t.info.status = 'failed';
      this.log.warn(`could not convert subtitles ${source}`, err);
    }
    this.changed();
  }
}
