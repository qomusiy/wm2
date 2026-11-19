import {
  LoadStats, XhrLoader, type FragmentLoaderContext, type HlsConfig, type Loader, type LoaderCallbacks, type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js';
import { segmentKeyFromUrl } from '@watchroom/protocol';
import { activeSwarm } from './swarm';

/**
 * hls.js fragment loader that asks the swarm first (cache, other viewers, the host directly) and falls back to the
 * normal HTTP request. hls.js reads this loader's `stats` for its bandwidth estimate, so both paths fill it in.
 */
export function createFragmentLoader(bufferAhead: () => number): new (config: HlsConfig) => Loader<LoaderContext> {
  return class SwarmLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats = new LoadStats();
    private http: XhrLoader | null = null;
    private ctrl: AbortController | null = null;
    private callbacks: LoaderCallbacks<LoaderContext> | null = null;
    private done = false;

    constructor(private readonly config: HlsConfig) {}

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      this.callbacks = callbacks;
      const key = segmentKeyFromUrl(context.url);
      const swarm = activeSwarm();
      // hls.js always sets rangeStart/rangeEnd (0 = whole file); only a real byte range goes straight to HTTP.
      const ranged = (context.rangeStart ?? 0) > 0 || (context.rangeEnd ?? 0) > 0;
      if (!swarm || !key || ranged) {
        this.loadHttp(context, config, callbacks, key);
        return;
      }
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      const start = performance.now();
      const fragDuration = (context as FragmentLoaderContext).frag?.duration ?? 4;
      swarm.fetch(key, { signal: ctrl.signal, bufferAhead: bufferAhead(), fragDuration }).then((res) => {
        if (this.done || ctrl.signal.aborted) return;
        if (!res) {
          this.loadHttp(context, config, callbacks, key);
          return;
        }
        const end = performance.now();
        const s = this.stats;
        s.loading.start = start;
        s.loading.first = Math.max(start, end - 1);
        s.loading.end = end;
        s.loaded = s.total = res.data.byteLength;
        s.chunkCount = 1;
        this.done = true;
        // hls.js hands the buffer to its worker (detaching it); give it a copy and keep ours for sharing.
        callbacks.onSuccess({ url: context.url, data: res.data.slice().buffer }, s, context, null);
      }, () => {
        if (!this.done && !ctrl.signal.aborted) this.loadHttp(context, config, callbacks, key);
      });
    }

    private loadHttp(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>, key: string | null): void {
      const http = new XhrLoader(this.config);
      this.http = http;
      // Share one stats object with hls.js (it captured ours); reset timings left by a direct attempt.
      this.stats.loading = { start: 0, first: 0, end: 0 };
      this.stats.loaded = 0;
      http.stats = this.stats;
      http.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          this.done = true;
          const swarm = activeSwarm();
          if (key && swarm && response.data instanceof ArrayBuffer) {
            swarm.recordLink(key, new Uint8Array(response.data.slice(0)), stats.loading.end - stats.loading.start);
          }
          callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }

    abort(): void {
      if (this.http) {
        this.http.abort(); // XhrLoader reports onAbort itself
        return;
      }
      if (this.done || !this.ctrl) return;
      this.done = true;
      this.ctrl.abort();
      this.stats.aborted = true;
      if (this.context) this.callbacks?.onAbort?.(this.stats, this.context, null);
    }

    /** Silent teardown: hls.js calls this from its own abort handling, so no callbacks may fire from here. */
    destroy(): void {
      this.done = true;
      this.ctrl?.abort();
      this.http?.destroy();
      this.http = null;
      this.callbacks = null;
      this.context = null;
    }
  };
}
