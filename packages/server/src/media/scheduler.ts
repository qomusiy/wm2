import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../util/log';
import { jailed, signalTree, type Jail } from '../util/sandbox';
import { renameRetry } from '../util/fsx';

export interface SegmentInfo {
  start: number;
  duration: number;
}

export interface JobRenditionSpec {
  id: string;
  kind: 'video' | 'audio';
  dir: string;
  segments: SegmentInfo[];
  /** Build ffmpeg args for a job that starts at segment `startIndex`. */
  buildArgs(startIndex: number, listFile: string, pattern: string): string[];
  /** Pause a job once it is this many segments ahead of the furthest viewer; resume below `resumeLead`. */
  maxLead: number;
  resumeLead: number;
}

export interface CopyRenditionSpec {
  id: string;
  kind: 'copy';
  dir: string;
  segments: SegmentInfo[];
  buildArgs(index: number, outFile: string): string[];
}

export type RenditionSpec = JobRenditionSpec | CopyRenditionSpec;

export class SegmentError extends Error {
  constructor(message: string, readonly status: 404 | 500 | 503) {
    super(message);
  }
}

interface Waiter {
  resolve(path: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Job {
  id: number;
  rendition: RenditionState;
  start: number;
  /** Next segment index this job will produce. */
  next: number;
  proc: ChildProcess;
  state: 'running' | 'paused' | 'exited';
  killed: boolean;
  listOffset: number;
  pendingEntries: number[];
  lastUseful: number;
  stderr: string;
  poll: NodeJS.Timeout;
  /** Polls are serialized: the exit handler must see the result of any poll already in flight. */
  polling: Promise<void>;
}

interface RenditionState {
  spec: RenditionSpec;
  done: Set<number>;
  waiters: Map<number, Waiter[]>;
  jobs: Set<Job>;
  failures: Map<number, number>;
  demand: Map<string, { index: number; at: number }>;
  inflight: Map<number, Promise<string>>;
  /** First index known not to exist (encoder hit end of stream early). */
  eofIndex: number;
}

export interface SchedulerOptions {
  ffmpeg: string;
  maxRunningJobs: number;
  waitTimeoutMs?: number;
  log: Logger;
  /** What encoders may touch when sandboxed: the source video (read) and this video's cache folder (write). */
  jail?: Jail;
  /** Override for tests. */
  now?: () => number;
}

const REUSE_AHEAD = 4;
const IDLE_KILL_MS = 90_000;
const DEMAND_WINDOW_MS = 120_000;
const COPY_CONCURRENCY = 2;
const COPY_PREFETCH = 2;

export class SegmentScheduler {
  private readonly renditions = new Map<string, RenditionState>();
  private readonly jobs = new Set<Job>();
  private nextJobId = 1;
  private readonly tick: NodeJS.Timeout;
  private stopped = false;
  private readonly now: () => number;
  private copyActive = 0;
  private readonly copyQueue: (() => void)[] = [];

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.tick = setInterval(() => this.housekeeping(), 1000);
    this.tick.unref();
  }

  addRendition(spec: RenditionSpec): void {
    mkdirSync(spec.dir, { recursive: true });
    const done = new Set<number>();
    for (const name of readdirSync(spec.dir)) {
      const m = /^(\d+)\.ts$/.exec(name);
      if (m) done.add(Number(m[1]));
      else if (/^job\d+/.test(name) || name.endsWith('.part')) void unlink(join(spec.dir, name)).catch(() => {});
    }
    this.renditions.set(spec.id, {
      spec, done, waiters: new Map(), jobs: new Set(), failures: new Map(), demand: new Map(), inflight: new Map(),
      eofIndex: spec.segments.length,
    });
  }

  hasRendition(id: string): boolean {
    return this.renditions.has(id);
  }

  segmentPath(id: string, index: number): string {
    const r = this.renditions.get(id);
    if (!r) throw new SegmentError('unknown rendition', 404);
    return join(r.spec.dir, `${index}.ts`);
  }

  stats(): { running: number; paused: number; renditions: Record<string, { cached: number; total: number }> } {
    let running = 0;
    let paused = 0;
    for (const j of this.jobs) {
      if (j.state === 'running') running++;
      else if (j.state === 'paused') paused++;
    }
    const renditions: Record<string, { cached: number; total: number }> = {};
    for (const [id, r] of this.renditions) renditions[id] = { cached: r.done.size, total: r.spec.segments.length };
    return { running, paused, renditions };
  }

  /**
   * The path of a segment that already exists, without producing anything (null when it hasn't been made). Counts
   * as demand from `viewer`, so encoders keep pace with people who got earlier segments from other viewers.
   */
  peekSegment(id: string, index: number, viewer: string): string | null {
    const r = this.renditions.get(id);
    if (!r || !Number.isInteger(index) || index < 0 || index >= r.spec.segments.length) return null;
    r.demand.set(viewer, { index, at: this.now() });
    return r.done.has(index) ? join(r.spec.dir, `${index}.ts`) : null;
  }

  /** Resolve with the path of a complete segment file, producing it on demand. */
  async getSegment(id: string, index: number, viewer: string): Promise<string> {
    if (this.stopped) throw new SegmentError('stopped', 503);
    const r = this.renditions.get(id);
    if (!r) throw new SegmentError('unknown rendition', 404);
    if (!Number.isInteger(index) || index < 0 || index >= r.spec.segments.length) throw new SegmentError('no such segment', 404);
    r.demand.set(viewer, { index, at: this.now() });
    const path = join(r.spec.dir, `${index}.ts`);
    if (r.done.has(index)) {
      if (r.spec.kind === 'copy') this.prefetchCopy(r, index);
      return path;
    }
    if (r.spec.kind === 'copy') {
      const p = this.produceCopy(r, index);
      this.prefetchCopy(r, index);
      return p;
    }
    if (index >= r.eofIndex) throw new SegmentError('past end of stream', 404);
    let job = this.coveringJob(r, index);
    if (!job) {
      job = this.startJobIfRoom(r, index) ?? undefined;
      if (!job) {
        // Every encoder is busy producing something someone is waiting for: queue rather than evict.
        this.queueStart(r, index);
        return this.waitFor(r, index);
      }
    } else if (job.state === 'paused') this.resume(job);
    job.lastUseful = this.now();
    return this.waitFor(r, index);
  }

  private readonly startQueue: { r: RenditionState; index: number }[] = [];

  /**
   * Starts an encoder when there's a free slot, or one held by a job nobody is waiting on (that one is stopped).
   * Returns null when all running encoders are serving waiting viewers.
   */
  private startJobIfRoom(r: RenditionState, index: number): Job | null {
    while (this.runningCount() >= this.opts.maxRunningJobs) {
      const candidates = [...this.jobs].filter((j) => j.state === 'running');
      candidates.sort((a, b) => Number(this.hasWaiters(a)) - Number(this.hasWaiters(b)) || a.lastUseful - b.lastUseful);
      const victim = candidates[0];
      if (!victim) break;
      if (this.hasWaiters(victim)) return null;
      this.opts.log.debug(`evicting job ${victim.id} (${victim.rendition.spec.id}) to make room`);
      this.kill(victim);
    }
    return this.startJob(r, index);
  }

  private queueStart(r: RenditionState, index: number): void {
    if (this.startQueue.some((q) => q.r === r && index >= q.index && index <= q.index + REUSE_AHEAD)) return;
    this.startQueue.push({ r, index });
  }

  /** Starts queued encoders as slots free up (oldest request first). */
  private drainQueue(): void {
    while (this.startQueue.length && !this.stopped) {
      const q = this.startQueue[0]!;
      const wanted = [...q.r.waiters.keys()].filter((i) => i >= q.index && i <= q.index + REUSE_AHEAD);
      if (wanted.length === 0 || this.coveringJob(q.r, Math.min(...wanted))) {
        this.startQueue.shift();
        continue;
      }
      if (!this.startJobIfRoom(q.r, Math.min(...wanted))) return;
      this.startQueue.shift();
    }
  }

  /** Stop every encoder and reject pending requests. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.tick);
    for (const j of [...this.jobs]) this.kill(j);
    for (const r of this.renditions.values()) {
      for (const [, list] of r.waiters) for (const w of list) { clearTimeout(w.timer); w.reject(new SegmentError('stopped', 503)); }
      r.waiters.clear();
    }
  }

  // ---------------------------------------------------------------- jobs

  private coveringJob(r: RenditionState, index: number): Job | undefined {
    let best: Job | undefined;
    for (const j of r.jobs) {
      if (j.state === 'exited') continue;
      if (j.start <= index && index <= j.next + REUSE_AHEAD) {
        if (!best || j.next > best.next) best = j;
      }
    }
    return best;
  }

  private runningCount(): number {
    let n = 0;
    for (const j of this.jobs) if (j.state === 'running') n++;
    return n;
  }

  private hasWaiters(j: Job): boolean {
    for (const idx of j.rendition.waiters.keys()) if (idx >= j.start && idx <= j.next + REUSE_AHEAD) return true;
    return false;
  }

  private startJob(r: RenditionState, index: number): Job {
    const spec = r.spec as JobRenditionSpec;
    // Per rendition at most 2 live jobs (a seek replaces the older one).
    const liveForRendition = [...r.jobs].filter((j) => j.state !== 'exited');
    if (liveForRendition.length >= 2) {
      const victim = liveForRendition.sort((a, b) => a.lastUseful - b.lastUseful)[0];
      if (victim) this.kill(victim);
    }
    const id = this.nextJobId++;
    const listFile = join(spec.dir, `job${id}.csv`);
    const pattern = join(spec.dir, `job${id}_%d.ts`);
    const args = spec.buildArgs(index, listFile, pattern);
    const [cmd, cmdArgs] = jailed(this.opts.ffmpeg, args, this.opts.jail ?? { read: [], write: [] });
    const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const job: Job = {
      id, rendition: r, start: index, next: index, proc, state: 'running', killed: false, listOffset: 0,
      pendingEntries: [], lastUseful: this.now(), stderr: '', poll: setInterval(() => void this.pollJob(job), 150),
      polling: Promise.resolve(),
    };
    proc.stderr?.setEncoding('utf8').on('data', (d: string) => {
      job.stderr = (job.stderr + d).slice(-4000);
    });
    proc.on('error', (err) => {
      job.stderr += `\nspawn error: ${err.message}`;
    });
    proc.on('exit', (code) => void this.onJobExit(job, code));
    this.jobs.add(job);
    r.jobs.add(job);
    this.opts.log.debug(`job ${id} start ${spec.id}@${index}: ffmpeg ${args.join(' ')}`);
    return job;
  }

  private pollJob(job: Job): Promise<void> {
    job.polling = job.polling.then(() => this.pollOnce(job)).catch((err) => {
      this.opts.log.warn(`polling job ${job.id} failed`, err);
    });
    return job.polling;
  }

  private async pollOnce(job: Job): Promise<void> {
    const spec = job.rendition.spec;
    const listFile = join(spec.dir, `job${job.id}.csv`);
    try {
      const fh = await open(listFile, 'r');
      try {
        const { size } = await fh.stat();
        if (size > job.listOffset) {
          const buf = Buffer.alloc(size - job.listOffset);
          await fh.read(buf, 0, buf.length, job.listOffset);
          const text = buf.toString('utf8');
          const lastNl = text.lastIndexOf('\n');
          if (lastNl >= 0) {
            job.listOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
            for (const line of text.slice(0, lastNl).split('\n')) {
              const m = /_(\d+)\.ts/.exec(line);
              if (m) job.pendingEntries.push(Number(m[1]));
            }
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      // list not created yet
    }
    await this.commitEntries(job, job.state === 'exited');
  }

  /**
   * A listed segment is only complete once ffmpeg has opened the *next* segment file (segment N is
   * closed before N+1 is opened) or the process has exited. Then it is atomically renamed into place.
   */
  private async commitEntries(job: Job, exited: boolean): Promise<void> {
    const spec = job.rendition.spec;
    while (job.pendingEntries.length) {
      const rel = job.pendingEntries[0]!;
      const nextFile = join(spec.dir, `job${job.id}_${rel + 1}.ts`);
      if (!exited && !existsSync(nextFile)) return;
      job.pendingEntries.shift();
      const abs = job.start + rel;
      const from = join(spec.dir, `job${job.id}_${rel}.ts`);
      const to = join(spec.dir, `${abs}.ts`);
      const r = job.rendition;
      try {
        if (r.done.has(abs)) await unlink(from).catch(() => {});
        else await renameRetry(from, to);
      } catch (err) {
        this.opts.log.warn(`could not commit segment ${spec.id}/${abs}`, err);
        continue;
      }
      r.done.add(abs);
      r.failures.delete(abs);
      job.next = Math.max(job.next, abs + 1);
      this.resolveWaiters(r, abs, to);
      // Another job already produced what comes next: this one is redundant.
      if (!exited && job.state !== 'exited' && r.done.has(job.next) && job.next < r.spec.segments.length) {
        this.opts.log.debug(`job ${job.id} caught up with cached segments at ${job.next}, stopping`);
        this.kill(job);
        return;
      }
    }
  }

  private async onJobExit(job: Job, code: number | null): Promise<void> {
    const wasKilled = job.killed;
    job.state = 'exited';
    clearInterval(job.poll);
    if (!wasKilled) await this.pollJob(job);
    this.jobs.delete(job);
    job.rendition.jobs.delete(job);
    const r = job.rendition;
    const spec = r.spec as JobRenditionSpec;
    // Remove leftovers (partial segment of a killed job, the list file).
    void (async () => {
      let names: string[] = [];
      try {
        names = readdirSync(spec.dir);
      } catch {
        return; // cache directory already removed
      }
      for (const name of names) {
        if (name.startsWith(`job${job.id}_`) || name === `job${job.id}.csv`) await unlink(join(spec.dir, name)).catch(() => {});
      }
    })();
    queueMicrotask(() => this.drainQueue());
    if (wasKilled || this.stopped) return;
    if (code === 0) {
      if (job.next < spec.segments.length) {
        this.opts.log.warn(`${spec.id}: stream ended at segment ${job.next} of ${spec.segments.length}`);
        r.eofIndex = Math.min(r.eofIndex, job.next);
        for (const [idx, list] of r.waiters) {
          if (idx >= r.eofIndex) {
            for (const w of list) { clearTimeout(w.timer); w.reject(new SegmentError('past end of stream', 404)); }
            r.waiters.delete(idx);
          }
        }
      }
      return;
    }
    const failedAt = job.next;
    const count = (r.failures.get(failedAt) ?? 0) + 1;
    r.failures.set(failedAt, count);
    this.opts.log.warn(`job ${job.id} (${spec.id}@${job.start}) failed at ${failedAt} (exit ${code}, attempt ${count}): ${job.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    const pending = [...r.waiters.keys()].filter((i) => i >= failedAt);
    if (pending.length === 0) return;
    if (count < 3) {
      if (!this.startJobIfRoom(r, Math.min(...pending))) this.queueStart(r, Math.min(...pending));
    } else {
      for (const idx of pending) {
        for (const w of r.waiters.get(idx) ?? []) { clearTimeout(w.timer); w.reject(new SegmentError('encoding failed', 500)); }
        r.waiters.delete(idx);
      }
    }
  }

  private kill(job: Job): void {
    if (job.state === 'exited') return;
    job.killed = true;
    // SIGKILL on purpose: a graceful stop would make ffmpeg finalise a truncated segment. The whole tree: a sandboxed
    // encoder runs under the sandbox launcher.
    signalTree(job.proc.pid, 'SIGKILL');
    job.state = 'exited';
    clearInterval(job.poll);
  }

  private pause(job: Job): void {
    if (job.state !== 'running') return;
    if (process.platform === 'win32') {
      this.kill(job);
      return;
    }
    try {
      signalTree(job.proc.pid, 'SIGSTOP');
      job.state = 'paused';
      this.opts.log.debug(`job ${job.id} paused at ${job.next}`);
    } catch { /* ignore */ }
  }

  private resume(job: Job): void {
    if (job.state !== 'paused') return;
    try {
      signalTree(job.proc.pid, 'SIGCONT');
      job.state = 'running';
      this.opts.log.debug(`job ${job.id} resumed at ${job.next}`);
    } catch { /* ignore */ }
  }

  private housekeeping(): void {
    const now = this.now();
    for (const r of this.renditions.values()) {
      for (const [viewer, d] of r.demand) if (now - d.at > DEMAND_WINDOW_MS) r.demand.delete(viewer);
    }
    for (const job of [...this.jobs]) {
      if (job.state === 'exited') continue;
      const r = job.rendition;
      const spec = r.spec as JobRenditionSpec;
      let furthest = -1;
      for (const d of r.demand.values()) {
        if (d.index >= job.start - 2 && d.index <= job.next + spec.maxLead) furthest = Math.max(furthest, d.index);
      }
      if (furthest >= 0 || this.hasWaiters(job)) job.lastUseful = now;
      if (now - job.lastUseful > IDLE_KILL_MS) {
        this.opts.log.debug(`job ${job.id} idle, stopping`);
        this.kill(job);
        continue;
      }
      if (furthest < 0) continue;
      const lead = job.next - furthest;
      if (job.state === 'running' && lead > spec.maxLead && !this.hasWaiters(job)) this.pause(job);
      else if (job.state === 'paused' && lead <= spec.resumeLead && this.runningCount() < this.opts.maxRunningJobs) this.resume(job);
    }
    this.drainQueue();
  }

  // ---------------------------------------------------------------- waiting

  private waitFor(r: RenditionState, index: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = r.waiters.get(index);
        if (list) {
          const i = list.findIndex((w) => w.timer === timer);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) r.waiters.delete(index);
        }
        reject(new SegmentError('segment not ready in time', 503));
      }, this.opts.waitTimeoutMs ?? 30_000);
      const list = r.waiters.get(index) ?? [];
      list.push({ resolve, reject, timer });
      r.waiters.set(index, list);
    });
  }

  private resolveWaiters(r: RenditionState, index: number, path: string): void {
    const list = r.waiters.get(index);
    if (!list) return;
    r.waiters.delete(index);
    for (const w of list) {
      clearTimeout(w.timer);
      w.resolve(path);
    }
    // A job that just served its last waiter may now give its slot to a queued request.
    if (this.startQueue.length) queueMicrotask(() => this.drainQueue());
  }

  // ---------------------------------------------------------------- copy renditions

  private prefetchCopy(r: RenditionState, index: number): void {
    for (let i = index + 1; i <= index + COPY_PREFETCH && i < r.spec.segments.length; i++) {
      if (!r.done.has(i) && !r.inflight.has(i)) void this.produceCopy(r, i).catch(() => {});
    }
  }

  private produceCopy(r: RenditionState, index: number): Promise<string> {
    const existing = r.inflight.get(index);
    if (existing) return existing;
    const spec = r.spec as CopyRenditionSpec;
    const final = join(spec.dir, `${index}.ts`);
    const part = join(spec.dir, `${index}.ts.part`);
    const p = this.withCopySlot(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const code = await new Promise<number | null>((resolve) => {
          const [cmd, cmdArgs] = jailed(this.opts.ffmpeg, spec.buildArgs(index, part), this.opts.jail ?? { read: [], write: [] });
          const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
          let err = '';
          proc.stderr?.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-2000); });
          proc.on('error', () => resolve(-1));
          proc.on('exit', (c) => {
            if (c !== 0) this.opts.log.warn(`copy segment ${spec.id}/${index} failed (exit ${c}): ${err.trim().slice(-300)}`);
            resolve(c);
          });
        });
        if (code === 0) {
          await renameRetry(part, final);
          r.done.add(index);
          return final;
        }
        await unlink(part).catch(() => {});
      }
      throw new SegmentError('could not extract segment', 500);
    }).finally(() => r.inflight.delete(index));
    r.inflight.set(index, p);
    return p;
  }

  private async withCopySlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.copyActive >= COPY_CONCURRENCY) await new Promise<void>((res) => this.copyQueue.push(res));
    this.copyActive++;
    try {
      return await fn();
    } finally {
      this.copyActive--;
      this.copyQueue.shift()?.();
    }
  }
}
