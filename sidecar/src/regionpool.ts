// (6a) The tile evaluation pool (docs/CONTRACT.md "Phase 6 contract" §1 "Where programs run", §3 "Streaming"):
// `worker_threads` running src/region-worker.mjs, which imports only the kit's lib/realise.mjs (and
// lib/region/pack.mjs). Workers start on demand, up to `size`.
//
// Limits per tile: `tileMs` (default 2 s) and `heapMb` (default 256 MB, resourceLimits). A tile that
// runs over its time, or whose worker crashes or runs out of memory, fails with a message; the worker
// is replaced and the other tiles go on. Each worker caches the parsed IRs it was sent (by irSha), so
// an IR crosses the thread boundary once per worker, not once per tile.
//
// Determinism: the pool hands back the kit's payload hash and the gzip of the kit's payload unchanged;
// which worker evaluated a tile, and in what order, never shows in the bytes.
import { Worker } from 'node:worker_threads';

/** The worker module: next to this file in src/ (vitest, tsx) and next to dist/main.mjs (the build copies it). */
export const WORKER_URL = new URL('./region-worker.mjs', import.meta.url);

export interface TileTask {
  irSha: string;
  /** the canonical IR JSON (sent to a worker that does not have it yet) */
  irJson: () => string;
  key: string;
  stage: string;
  set: 'terrain' | 'path';
  /** the ARSV heights (copied before the transfer) */
  heights: Uint8Array;
}

export type TileResult = { ok: true; gz: Buffer; count: number; sha: string; ms: number } | { ok: false; message: string };

export interface PoolOptions {
  kitDir: string;
  size: number;
  tileMs: number;
  heapMb: number;
  log?: { warn(m: string): void; debug(m: string): void };
}

interface Pending {
  id: number;
  task: TileTask;
  resolve: (r: TileResult) => void;
}

class Slot {
  worker: Worker;
  ready = false;
  /** irShas this worker has */
  irs = new Set<string>();
  busy: Pending | undefined;
  timer: NodeJS.Timeout | undefined;
  dead = false;

  constructor(opts: PoolOptions) {
    this.worker = new Worker(WORKER_URL, {
      workerData: { kitDir: opts.kitDir },
      resourceLimits: { maxOldGenerationSizeMb: opts.heapMb, maxYoungGenerationSizeMb: Math.max(16, Math.min(64, Math.floor(opts.heapMb / 4))) },
      // nothing secret reaches kit code
      env: {},
      stdout: false,
      stderr: false,
    });
    this.worker.unref();
  }
}

export class TilePool {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  /** (tests, numbers) workers started, replaced after a crash or timeout */
  stats = { started: 0, replaced: 0, tiles: 0, failed: 0 };

  constructor(private opts: PoolOptions) {}

  get size(): number {
    return this.opts.size;
  }

  /** Evaluate one tile. Never rejects: a failure is `{ok: false, message}`. */
  evaluate(task: TileTask): Promise<TileResult> {
    if (this.closed) return Promise.resolve({ ok: false, message: 'the sidecar is shutting down' });
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, task, resolve });
      this.pump();
    });
  }

  /** Forget an IR in every worker (region.release, or the IR cache dropped it). */
  dropIr(irSha: string): void {
    for (const s of this.slots) {
      if (!s.irs.delete(irSha)) continue;
      try {
        s.worker.postMessage({ type: 'drop', irSha });
      } catch {
        /* a dying worker */
      }
    }
  }

  /** Workers alive now. */
  get workers(): number {
    return this.slots.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.resolve({ ok: false, message: 'the sidecar is shutting down' });
    const slots = this.slots.splice(0);
    for (const s of slots) {
      s.dead = true;
      if (s.timer) clearTimeout(s.timer);
      s.busy?.resolve({ ok: false, message: 'the sidecar is shutting down' });
      s.busy = undefined;
    }
    await Promise.all(slots.map((s) => s.worker.terminate().catch(() => undefined)));
  }

  private spawn(): Slot {
    const s = new Slot(this.opts);
    this.stats.started++;
    s.worker.on('message', (m: { type: string; id?: number; message?: string; gz?: Uint8Array; count?: number; sha?: string; ms?: number }) => {
      if (s.dead) return;
      if (m.type === 'ready') {
        s.ready = true;
        this.pump();
      } else if (m.type === 'fatal') {
        // the kit cannot be loaded: the next waiting tile carries the message; the worker is replaced
        const p = this.queue.shift();
        p?.resolve({ ok: false, message: m.message ?? 'the worker failed to start' });
        this.retire(s, false);
      } else if ((m.type === 'done' || m.type === 'fail') && s.busy && s.busy.id === m.id) {
        const p = s.busy;
        s.busy = undefined;
        if (s.timer) clearTimeout(s.timer);
        s.timer = undefined;
        if (m.type === 'done') {
          this.stats.tiles++;
          const gz = Buffer.from(m.gz!.buffer, m.gz!.byteOffset, m.gz!.byteLength);
          p.resolve({ ok: true, gz, count: m.count ?? 0, sha: m.sha!, ms: m.ms ?? 0 });
        } else {
          this.stats.failed++;
          p.resolve({ ok: false, message: m.message ?? 'evaluation failed' });
        }
        this.pump();
      }
    });
    s.worker.on('error', (e: Error & { code?: string }) => {
      if (s.dead) return;
      const why = e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `the tile ran out of memory (${this.opts.heapMb} MB per worker)` : `the worker crashed: ${e.message}`;
      this.fail(s, why);
    });
    s.worker.on('exit', (code) => {
      if (s.dead) return;
      this.fail(s, `the worker exited (code ${code})`);
    });
    this.slots.push(s);
    return s;
  }

  /** A worker died or was stopped: its tile fails with `why`, and it is replaced on demand. */
  private fail(s: Slot, why: string): void {
    const p = s.busy;
    s.busy = undefined;
    if (p) {
      this.stats.failed++;
      p.resolve({ ok: false, message: `${why} (tile ${p.task.key})` });
    }
    this.retire(s, true);
  }

  private retire(s: Slot, replaced: boolean): void {
    if (s.dead) return;
    s.dead = true;
    if (s.timer) clearTimeout(s.timer);
    this.slots = this.slots.filter((x) => x !== s);
    if (replaced) this.stats.replaced++;
    void s.worker.terminate().catch(() => undefined);
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length) {
      let s = this.slots.find((x) => x.ready && !x.busy && !x.dead);
      if (!s) {
        // start another worker if there is room (it takes the next tile once it reports ready)
        const starting = this.slots.filter((x) => !x.ready).length;
        if (this.slots.length < this.opts.size && starting < this.queue.length) this.spawn();
        return;
      }
      const p = this.queue.shift()!;
      this.dispatch(s, p);
      s = undefined;
    }
  }

  private dispatch(s: Slot, p: Pending): void {
    s.busy = p;
    const t = p.task;
    try {
      if (!s.irs.has(t.irSha)) {
        s.worker.postMessage({ type: 'ir', irSha: t.irSha, irJson: t.irJson() });
        s.irs.add(t.irSha);
      }
      const heights = new Uint8Array(t.heights.byteLength);
      heights.set(t.heights);
      s.worker.postMessage({ type: 'tile', id: p.id, irSha: t.irSha, key: t.key, stage: t.stage, set: t.set, heights }, [heights.buffer]);
    } catch (e) {
      this.fail(s, `could not hand the tile to a worker: ${(e as Error).message}`);
      return;
    }
    s.timer = setTimeout(() => {
      if (s.busy !== p) return;
      this.opts.log?.warn(`region tile ${t.key} took longer than ${this.opts.tileMs} ms: its worker is replaced`);
      this.fail(s, `the tile took longer than ${this.opts.tileMs / 1000} s`);
    }, this.opts.tileMs);
  }
}
