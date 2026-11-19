import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SEGMENT_SECONDS, type FileMediaDescriptor } from '@watchroom/protocol';
import { randomId, sha1 } from '../util/ids';
import { pruneCache } from './cache';
import type { Logger } from '../util/log';
import { lowPriority } from '../util/lowprio';
import { jailed } from '../util/sandbox';
import { run } from '../util/proc';
import { buildAudioJobArgs, buildCopySegmentArgs, buildVideoJobArgs, type EncoderChoice } from './encoder';
import type { FfmpegInfo } from './ffmpeg';
import { copyIneligibility, fitInto, labelFor, planLadder, type LadderPlan, type VideoRendition } from './ladder';
import { buildCopySegments, sampleGop, scanStreamEnds, scanVideoPackets, type CopySegment } from './packets';
import { fixedSegments, masterPlaylist, mediaPlaylist } from './playlists';
import { channelLabel, codecLabel, containerLabel, probeFile, type ProbeResult } from './probe';
import { SegmentError, SegmentScheduler, type SegmentInfo } from './scheduler';
import { SubtitleManager } from './subtitles';
import { generateThumbnails, type ThumbnailManifest } from './thumbnails';
import { renameRetry } from '../util/fsx';

/** Bump when segment output changes, so stale caches are not reused. */
export const PIPELINE_VERSION = 3;

export interface MediaSessionDeps {
  ff: FfmpegInfo;
  encoder: EncoderChoice;
  cacheRoot: string;
  maxRunningJobs: number;
  log: Logger;
}

export interface MediaStatus {
  indexing: boolean;
  indexProgress: number;
  copyAvailable: boolean | null;
  copyReason: string | null;
}

export class MediaSession extends EventEmitter {
  readonly id = randomId(16);
  readonly scheduler: SegmentScheduler;
  readonly dir: string;
  status: MediaStatus;
  private copySegments: Promise<SegmentInfo[] | null>;
  private readonly abort = new AbortController();
  private closed = false;
  readonly subtitles: SubtitleManager;
  private thumbs: ThumbnailManifest | null = null;
  bytesServed = 0;

  private constructor(
    readonly probe: ProbeResult,
    readonly plan: LadderPlan,
    private readonly deps: MediaSessionDeps,
    private readonly ends: { video: number; audio: Map<number, number> },
  ) {
    super();
    const fp = sha1([probe.path, probe.size, Math.round(probe.mtimeMs), PIPELINE_VERSION].join('|')).slice(0, 20);
    this.dir = join(deps.cacheRoot, fp);
    this.scheduler = new SegmentScheduler({
      ffmpeg: deps.ff.ffmpeg, maxRunningJobs: deps.maxRunningJobs, log: deps.log.child('sched'),
      jail: { read: [probe.path], write: [this.dir] },
    });
    const hasCopy = plan.video.some((v) => v.mode === 'copy');
    this.status = { indexing: hasCopy, indexProgress: 0, copyAvailable: hasCopy ? null : false, copyReason: plan.copyReason };
    this.registerFixedRenditions();
    this.copySegments = hasCopy ? this.prepareCopy() : Promise.resolve(null);
    this.subtitles = new SubtitleManager(probe, join(this.dir, 'subs'), deps.ff.ffmpeg, `/media/${this.id}/subs`, deps.log.child('subs'), this.abort.signal);
    this.subtitles.on('change', () => this.emit('update'));
  }

  /**
   * Work that improves the experience but isn't needed to start watching. Runs after the keyframe index,
   * one task at a time, at low priority (all of it reads the whole file).
   */
  private async background(): Promise<void> {
    await this.copySegments;
    if (this.closed) return;
    await this.subtitles.start().catch((err) => this.deps.log.warn('subtitles failed', err));
    if (this.closed) return;
    this.thumbs = await generateThumbnails(this.deps.ff.ffmpeg, this.probe, join(this.dir, 'thumbs'), this.hdrChain(), this.deps.log.child('thumbs'), this.abort.signal)
      .catch(() => null);
    if (!this.closed && this.thumbs) this.emit('update');
  }

  /** Tone-mapping filters for HDR sources (empty for SDR, or when this ffmpeg lacks zscale/tonemap). */
  private hdrChain(): string {
    return this.probe.video.hdr && this.deps.ff.filters.has('zscale') && this.deps.ff.filters.has('tonemap')
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,' : '';
  }

  /** A small still for the host's recent list: one frame about a tenth of the way in, at low priority. */
  async writePoster(out: string): Promise<boolean> {
    const at = Math.min(300, Math.max(0, this.probe.duration * 0.1));
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    await mkdir(dirname(out), { recursive: true });
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', this.probe.path,
      '-map', `0:${this.probe.video.index}`, '-an', '-sn', '-dn', '-frames:v', '1',
      '-vf', `${this.hdrChain()}scale=320:-2:flags=bicubic,setsar=1,format=yuvj420p`, '-q:v', '4', tmp,
    ];
    const [cmd, cmdArgs] = jailed(...lowPriority(this.deps.ff.ffmpeg, args), { read: [this.probe.path], write: [dirname(out)] });
    // Not tied to this session's lifetime: one frame is cheap, and the poster should exist even if the host
    // switches videos straight away.
    const res = await run(cmd, cmdArgs, { timeoutMs: 60_000 }).catch(() => ({ code: -1 }));
    if (res.code !== 0) {
      await rm(tmp, { force: true });
      return false;
    }
    await renameRetry(tmp, out);
    return true;
  }

  subtitlePath(id: string): string | null {
    return this.subtitles.path(id);
  }

  subtitleScriptPath(id: string): string | null {
    return this.subtitles.assPath(id);
  }

  thumbnailPath(n: number): string | null {
    return this.thumbs && Number.isInteger(n) && n >= 0 && n < this.thumbs.sheets ? join(this.dir, 'thumbs', `${n}.jpg`) : null;
  }

  static async open(path: string, deps: MediaSessionDeps): Promise<MediaSession> {
    const probe = await probeFile(deps.ff.ffprobe, path);
    const v = probe.video;
    const absEnds = await scanStreamEnds(deps.ff.ffprobe, path, probe.duration, probe.startTime).catch(() => new Map<number, number>());
    const rel = (abs: number | undefined) => {
      if (abs === undefined) return probe.duration;
      const r = abs - probe.startTime;
      return r > 1 && r <= probe.duration + 5 ? r : probe.duration;
    };
    const audioEnds = new Map<number, number>();
    for (const a of probe.audio) audioEnds.set(a.index, rel(absEnds.get(a.index)));
    const ends = { video: rel(absEnds.get(v.index)), audio: audioEnds };

    let copyAllowed = false;
    let copyReason: string | null = copyIneligibility(v);
    if (!copyReason) {
      const gop = await sampleGop(deps.ff.ffprobe, path, v.index).catch(() => null);
      if (!gop || gop.missingPts) copyReason = 'missing timestamps';
      else if (gop.keyframes === 0) copyReason = 'no keyframes found';
      else if (gop.maxGap > 12) copyReason = `keyframes ${gop.maxGap.toFixed(0)}s apart`;
      else copyAllowed = true;
    }
    const plan = planLadder(probe, { copyAllowed, copyReason });
    const session = new MediaSession(probe, plan, deps, ends);
    await mkdir(session.dir, { recursive: true });
    void session.background();
    const cap = Number(process.env.WATCHROOM_CACHE_GB ?? 10) * 1e9;
    void pruneCache(deps.cacheRoot, session.dir, cap, deps.log).catch(() => {});
    deps.log.info(`opened "${probe.fileName}": ${plan.video.map((x) => `${x.id}(${x.mode})`).join(' ')} audio=${plan.audio.length}${plan.copyReason ? ` (no copy: ${plan.copyReason})` : ''}`);
    return session;
  }

  private registerFixedRenditions(): void {
    const S = SEGMENT_SECONDS;
    const hasTonemap = this.deps.ff.filters.has('zscale') && this.deps.ff.filters.has('tonemap');
    for (const r of this.plan.video) {
      if (r.mode !== 'transcode') continue;
      const segments = fixedSegments(this.ends.video, S);
      this.scheduler.addRendition({
        id: r.id, kind: 'video', dir: join(this.dir, r.id), segments, maxLead: 30, resumeLead: 20,
        buildArgs: (start, list, pattern) => buildVideoJobArgs(this.probe, r, { startIndex: start, total: segments.length, segSeconds: S },
          this.deps.encoder, hasTonemap, list, pattern),
      });
    }
    for (const a of this.plan.audio) {
      const segments = fixedSegments(this.ends.audio.get(a.streamIndex) ?? this.probe.duration, S);
      this.scheduler.addRendition({
        id: a.id, kind: 'audio', dir: join(this.dir, a.id), segments, maxLead: 90, resumeLead: 60,
        buildArgs: (start, list, pattern) => buildAudioJobArgs(this.probe, a, { startIndex: start, total: segments.length, segSeconds: S }, list, pattern),
      });
    }
  }

  /** Build (or load from cache) the keyframe index, then register the stream-copy rendition. */
  private async prepareCopy(): Promise<SegmentInfo[] | null> {
    const r = this.plan.video.find((v) => v.mode === 'copy')!;
    const indexFile = join(this.dir, 'copy-index.json');
    let segs: CopySegment[] | null = null;
    try {
      const cached = JSON.parse(await readFile(indexFile, 'utf8')) as { version: number; segments: CopySegment[] };
      if (cached.version === PIPELINE_VERSION && Array.isArray(cached.segments) && cached.segments.length) segs = cached.segments;
    } catch { /* no cache */ }
    if (!segs) {
      try {
        const { index, sizes } = await scanVideoPackets(this.deps.ff.ffprobe, this.probe.path, this.probe.video.index,
          this.probe.duration, this.probe.startTime, (f) => {
            this.status = { ...this.status, indexProgress: f };
            this.emit('status', this.status);
          }, this.abort.signal);
        segs = buildCopySegments(index, sizes, this.probe.startTime, this.probe.startTime + this.ends.video, SEGMENT_SECONDS);
        if (segs) await mkdir(this.dir, { recursive: true }).then(() => writeFile(indexFile, JSON.stringify({ version: PIPELINE_VERSION, segments: segs })));
      } catch (err) {
        if (this.closed) return null;
        this.deps.log.warn('keyframe index failed; original quality will be transcoded', err);
        segs = null;
      }
    }
    if (this.closed) return null;
    if (!segs) return this.fallbackCopyToTranscode(r);
    const finalSegs = segs;
    const peak = Math.max(...finalSegs.map((s) => (s.bytes * 8) / s.duration));
    const avg = finalSegs.reduce((a, s) => a + s.bytes, 0) * 8 / Math.max(1, this.ends.video);
    r.bandwidth = Math.round(peak + (this.plan.audio.length ? 128_000 : 0));
    r.averageBandwidth = Math.round(avg + (this.plan.audio.length ? 128_000 : 0));
    this.scheduler.addRendition({
      id: r.id, kind: 'copy', dir: join(this.dir, r.id), segments: finalSegs.map((s) => ({ start: s.start, duration: s.duration })),
      buildArgs: (i, out) => buildCopySegmentArgs(this.probe, finalSegs[i]!, out),
    });
    this.status = { ...this.status, indexing: false, indexProgress: 1, copyAvailable: true };
    this.emit('status', this.status);
    return finalSegs.map((s) => ({ start: s.start, duration: s.duration }));
  }

  /** If the index can't be built, serve the "Original" level as a high-quality transcode instead. */
  private fallbackCopyToTranscode(r: VideoRendition): SegmentInfo[] {
    const size = fitInto(this.probe.video.displayWidth, this.probe.video.displayHeight, 1920, 1080);
    Object.assign(r, { mode: 'transcode', width: size.w, height: size.h, maxrateKbps: 5000, crf: 21, preset: 'veryfast', level: 40, label: labelFor(size.w, size.h) });
    const segments = fixedSegments(this.ends.video, SEGMENT_SECONDS);
    const hasTonemap = this.deps.ff.filters.has('zscale') && this.deps.ff.filters.has('tonemap');
    this.scheduler.addRendition({
      id: r.id, kind: 'video', dir: join(this.dir, `${r.id}-t`), segments, maxLead: 30, resumeLead: 20,
      buildArgs: (start, list, pattern) => buildVideoJobArgs(this.probe, r, { startIndex: start, total: segments.length, segSeconds: SEGMENT_SECONDS },
        this.deps.encoder, hasTonemap, list, pattern),
    });
    this.status = { ...this.status, indexing: false, indexProgress: 1, copyAvailable: false, copyReason: 'could not index keyframes' };
    this.emit('status', this.status);
    return segments;
  }

  descriptor(): FileMediaDescriptor {
    const p = this.probe;
    const v = p.video;
    const a = p.audio[0];
    const parts = [containerLabel(p.formatName, p.fileName), `${codecLabel(v.codec)} ${labelFor(v.displayWidth, v.displayHeight)}${v.hdr ? ' HDR' : ''}`];
    if (a) parts.push(`${codecLabel(a.codec)} ${channelLabel(a.channels)}`);
    return {
      kind: 'file',
      id: this.id,
      title: p.title,
      duration: Math.min(p.duration, Math.max(this.ends.video, ...[...this.ends.audio.values()])),
      width: v.displayWidth,
      height: v.displayHeight,
      masterUrl: `/media/${this.id}/master.m3u8`,
      levels: [...this.plan.video].sort((x, y) => y.height * y.width - x.height * x.width).map((r) => ({
        id: r.id, label: r.label, width: r.width, height: r.height, bandwidth: r.bandwidth, copy: r.mode === 'copy',
        codec: r.codecs.startsWith('hvc1') ? 'hevc' as const : 'h264' as const,
      })),
      audioTracks: this.plan.audio.map((x) => ({ id: x.id, label: x.label, language: x.language, default: x.isDefault })),
      subtitles: this.subtitles.list(),
      thumbnails: this.thumbs ? {
        interval: this.thumbs.interval, width: this.thumbs.width, height: this.thumbs.height, columns: this.thumbs.columns,
        rows: this.thumbs.rows, count: this.thumbs.count,
        sheets: Array.from({ length: this.thumbs.sheets }, (_, i) => `/media/${this.id}/thumbs/${i}.jpg`),
      } : null,
      sourceSummary: parts.join(' · '),
    };
  }

  /**
   * The master playlist; `onlyVideo` restricts it to one level, and "compat" to levels every player can decode (for
   * native HLS players, which may not cope with HEVC in MPEG-TS).
   */
  masterPlaylist(onlyVideo?: string): string {
    const video = onlyVideo === 'compat' ? this.plan.video.filter((v) => !v.codecs.startsWith('hvc1'))
      : onlyVideo ? this.plan.video.filter((v) => v.id === onlyVideo) : this.plan.video;
    if (onlyVideo && video.length === 0) throw new SegmentError('unknown rendition', 404);
    return masterPlaylist(video, this.plan.audio);
  }

  async mediaPlaylist(id: string): Promise<string> {
    const v = this.plan.video.find((x) => x.id === id);
    if (v && (v.mode === 'copy' || !this.scheduler.hasRendition(id))) {
      // Copy rendition: wait for the keyframe index (bounded by the HTTP layer's timeout).
      const segs = await this.copySegments;
      if (segs) return mediaPlaylist(segs);
    }
    if (!this.scheduler.hasRendition(id)) throw new SegmentError('unknown rendition', 404);
    return mediaPlaylist(this.renditionSegments(id));
  }

  /** Segment timeline of a rendition (start is relative to the file start). */
  async segmentsFor(id: string): Promise<SegmentInfo[]> {
    const v = this.plan.video.find((x) => x.id === id);
    if (v?.mode === 'copy' || (v && !this.scheduler.hasRendition(id))) {
      const segs = await this.copySegments;
      if (segs) return segs;
    }
    return this.renditionSegments(id);
  }

  private renditionSegments(id: string): SegmentInfo[] {
    const a = this.plan.audio.find((x) => x.id === id);
    if (a) return fixedSegments(this.ends.audio.get(a.streamIndex) ?? this.probe.duration, SEGMENT_SECONDS);
    return fixedSegments(this.ends.video, SEGMENT_SECONDS);
  }

  async segment(id: string, index: number, viewer: string): Promise<string> {
    if (this.closed) throw new SegmentError('closed', 404);
    if (!this.scheduler.hasRendition(id)) {
      const v = this.plan.video.find((x) => x.id === id);
      if (!v) throw new SegmentError('unknown rendition', 404);
      await this.copySegments;
    }
    return this.scheduler.getSegment(id, index, viewer);
  }

  private readonly hashes = new Map<string, string>();

  /**
   * SHA-256 of a segment that already exists (null otherwise; nothing is encoded for this). Viewers use it to check
   * segments they received from other viewers before playing them.
   */
  async segmentHash(id: string, index: number, viewer: string): Promise<string | null> {
    if (this.closed) return null;
    const key = `${id}/${index}`;
    const known = this.hashes.get(key);
    if (known) {
      this.scheduler.peekSegment(id, index, viewer);
      return known;
    }
    const path = this.scheduler.hasRendition(id) ? this.scheduler.peekSegment(id, index, viewer) : null;
    if (!path) return null;
    const data = await readFile(path).catch(() => null);
    if (!data) return null;
    const hash = createHash('sha256').update(data).digest('base64');
    if (this.hashes.size > 20_000) this.hashes.clear();
    this.hashes.set(key, hash);
    return hash;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.scheduler.stop();
    this.subtitles.close();
    this.removeAllListeners();
  }
}
