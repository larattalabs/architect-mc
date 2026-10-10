// (6a) The tile evaluation pool (docs/CONTRACT.md "Phase 6 contract" §1 "Where programs run", §3 "Streaming"):
// `worker_threads` running src/region-worker.mjs, which imports only the kit's lib/realise.mjs (and
// lib/region/pack.mjs). Workers start on demand, up to `size`.
//
// Limits per tile: `tileMs` (default 2 s) and `heapMb` (default 256 MB, resourceLimits). A tile whose
// worker crashes or runs out of memory, or whose kit code throws, fails with a message (`code: 'error'`,
// no retry); the worker is replaced and the other tiles go on. (6c 0a, CONTRACT 0a §11) A tile over its
// time limit is evaluated again on a fresh worker, up to TILE_ATTEMPTS evaluations in all, the limit
// doubling each time (2, 4, 8, 16 s at the default tileMs) with 1, 2 and 4 s pauses between them; after
// the last it fails with `code: 'timeout'`. A retry is a fresh deterministic evaluation: the bytes are
// the same. Each worker caches the parsed IRs it was sent (by irSha), so
// an IR crosses the thread boundary once per worker, not once per tile.
//
// Determinism: the pool hands back the kit's payload hash and the gzip of the kit's payload unchanged;
// which worker evaluated a tile, and in what order, never shows in the bytes.
import { Worker } from 'node:worker_threads';

/** The worker module: next to this file in src/ (vitest, tsx) and next to dist/main.mjs (the build copies it). */
export const WORKER_URL = new URL('./region-worker.mjs', import.meta.url);
/** (6b) Plan surveys a worker keeps (ghost tiles); region-worker.mjs keeps the same number. */
export const WORKER_SURVEYS = 4;

export interface TileTask {
  irSha: string;
  /** the canonical IR JSON (sent to a worker that does not have it yet) */
  irJson: () => string;
  key: string;
  /** a ghost tile: every stage up to this one (absent: all) */
  stage: string | undefined;
  /** a ghost tile: this set only (absent: both) */
  set: 'terrain' | 'path' | undefined;
  /** the ARSV heights (copied before the transfer); absent for a ghost tile */
  heights?: Uint8Array;
  /** (6b) the IR's side blobs by sha, shipped with the IR (shared memory: not copied per worker) */
  blobs?: () => Record<string, Uint8Array>;
  /** (6b) a ghost tile: the plan survey (windows come from it, in the worker) */
  survey?: { id: string; bytes: () => Uint8Array };
}

export type TileResult =
  | { ok: true; gz: Buffer; count: number; sha: string; ms: number; attempts: number }
  | { ok: false; message: string; code: 'timeout' | 'error'; attempts: number };

/** (6c 0a) Evaluations of one tile at most: the first and 3 retries after a timeout (CONTRACT 0a §11). */
export const TILE_ATTEMPTS = 4;

/** (6c 0a) Attempt n's time limit (n from 1): tileMs doubling each time (2, 4, 8, 16 s at the default 2 s). Pure. */
export function attemptLimitMs(tileMs: number, attempt: number): number {
  return tileMs * 2 ** (attempt - 1);
}

/** (6c 0a) The pause after attempt n timed out (n from 1): pauseMs doubling (1, 2, 4 s at the default 1 s). Pure. */
export function retryPauseMs(pauseMs: number, attempt: number): number {
  return pauseMs * 2 ** (attempt - 1);
}

export interface PoolOptions {
  kitDir: string;
  size: number;
  tileMs: number;
  heapMb: number;
  /** (6c 0a) the first pause between timed-out attempts (default 1000 ms; tests shrink it) */
  retryPauseMs?: number;
  /** (6c 0a, test hook ARCHITECT_TEST_SLOW_TILES) the first n evaluations of each tile overrun (0: off) */
  slowTiles?: number;
  log?: { warn(m: string): void; debug(m: string): void };
}

interface Pending {
  id: number;
  task: TileTask;
  resolve: (r: TileResult) => void;
  /** (6c 0a) this evaluation's number, from 1 */
  attempt: number;
}

class Slot {
  worker: Worker;
  ready = false;
  /** irShas this worker has */
  irs = new Set<string>();
  /** (6b) plan surveys this worker has (ghost tiles; the worker keeps the last few) */
  surveys: string[] = [];
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
  /** (6c 0a) tasks in a pause between timed-out attempts (no worker, not queued) */
  private pausing = new Map<Pending, NodeJS.Timeout>();
  /**
   * (6c 0a, the slow-tiles hook) evaluations so far per tile (irSha, key, stage, set, preview). Test only, so never cleared (not
   * on dropIr either): a release while a tile waits TILE_SLOW must not restart its overruns.
   */
  private evals = new Map<string, number>();
  /** (tests, numbers) workers started, replaced after a crash or timeout; (6c 0a) retries after a timeout */
  stats = { started: 0, replaced: 0, tiles: 0, failed: 0, retries: 0 };

  constructor(private opts: PoolOptions) {}

  get size(): number {
    return this.opts.size;
  }

  /** Evaluate one tile. Never rejects: a failure is `{ok: false, message}`. */
  evaluate(task: TileTask): Promise<TileResult> {
    if (this.closed) return Promise.resolve({ ok: false, message: 'the sidecar is shutting down', code: 'error', attempts: 0 });
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, task, resolve, attempt: 1 });
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
    const down = (p: Pending): void => p.resolve({ ok: false, message: 'the sidecar is shutting down', code: 'error', attempts: p.attempt });
    for (const p of this.queue.splice(0)) down(p);
    for (const [p, t] of this.pausing) {
      clearTimeout(t);
      down(p);
    }
    this.pausing.clear();
    const slots = this.slots.splice(0);
    for (const s of slots) {
      s.dead = true;
      if (s.timer) clearTimeout(s.timer);
      if (s.busy) down(s.busy);
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
        p?.resolve({ ok: false, message: m.message ?? 'the worker failed to start', code: 'error', attempts: p.attempt });
        this.retire(s, false);
      } else if ((m.type === 'done' || m.type === 'fail') && s.busy && s.busy.id === m.id) {
        const p = s.busy;
        s.busy = undefined;
        if (s.timer) clearTimeout(s.timer);
        s.timer = undefined;
        if (m.type === 'done') {
          this.stats.tiles++;
          const gz = Buffer.from(m.gz!.buffer, m.gz!.byteOffset, m.gz!.byteLength);
          p.resolve({ ok: true, gz, count: m.count ?? 0, sha: m.sha!, ms: m.ms ?? 0, attempts: p.attempt });
        } else {
          this.stats.failed++;
          p.resolve({ ok: false, message: m.message ?? 'evaluation failed', code: 'error', attempts: p.attempt });
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
      p.resolve({ ok: false, message: `${why} (tile ${p.task.key})`, code: 'error', attempts: p.attempt });
    }
    this.retire(s, true);
  }

  /**
   * (6c 0a) The tile ran over its limit: its worker is replaced; the tile is evaluated again on a fresh worker after a pause
   * (which holds no worker), or, after the last attempt, fails with `code: 'timeout'`.
   */
  private timedOut(s: Slot, p: Pending, limitMs: number): void {
    s.busy = undefined;
    this.retire(s, true);
    if (p.attempt >= TILE_ATTEMPTS) {
      this.stats.failed++;
      const limits = Array.from({ length: TILE_ATTEMPTS }, (_, i) => attemptLimitMs(this.opts.tileMs, i + 1) / 1000).join(', ');
      p.resolve({ ok: false, message: `the tile took longer than its limit in each of ${p.attempt} attempts (${limits} s) (tile ${p.task.key})`, code: 'timeout', attempts: p.attempt });
      return;
    }
    this.stats.retries++;
    const pause = retryPauseMs(this.opts.retryPauseMs ?? 1000, p.attempt);
    this.opts.log?.warn(`region tile ${p.task.key} took longer than ${limitMs} ms (attempt ${p.attempt} of ${TILE_ATTEMPTS}): evaluated again on a fresh worker in ${pause} ms`);
    const t = setTimeout(() => {
      if (!this.pausing.delete(p) || this.closed) return;
      this.queue.unshift({ ...p, attempt: p.attempt + 1 });
      this.pump();
    }, pause);
    t.unref();
    this.pausing.set(p, t);
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
    const limitMs = attemptLimitMs(this.opts.tileMs, p.attempt);
    // (6c 0a, test hook) the first n evaluations of each tile overrun: the worker stalls until the timer replaces it
    let slow = false;
    if (this.opts.slowTiles && this.opts.slowTiles > 0) {
      const k = `${t.irSha}|${t.key}|${t.stage ?? '*'}|${t.set ?? '*'}|${t.survey ? 'ghost' : 'tile'}`;
      const n = this.evals.get(k) ?? 0;
      this.evals.set(k, n + 1);
      slow = n < this.opts.slowTiles;
    }
    try {
      if (!s.irs.has(t.irSha)) {
        s.worker.postMessage({ type: 'ir', irSha: t.irSha, irJson: t.irJson(), ...(t.blobs ? { blobs: t.blobs() } : {}) });
        s.irs.add(t.irSha);
      }
      if (t.survey) {
        if (!s.surveys.includes(t.survey.id)) {
          s.worker.postMessage({ type: 'survey', id: t.survey.id, bytes: t.survey.bytes() });
          s.surveys.push(t.survey.id);
          // the worker keeps as many (WORKER_SURVEYS)
          while (s.surveys.length > WORKER_SURVEYS) s.surveys.shift();
        }
        s.worker.postMessage({ type: 'tile', id: p.id, irSha: t.irSha, key: t.key, stage: t.stage, set: t.set, preview: true, surveyId: t.survey.id, ...(slow ? { slow: true } : {}) });
      } else {
        if (!t.heights) throw new Error('a tile needs heights');
        const heights = new Uint8Array(t.heights.byteLength);
        heights.set(t.heights);
        s.worker.postMessage({ type: 'tile', id: p.id, irSha: t.irSha, key: t.key, stage: t.stage, set: t.set, heights, ...(slow ? { slow: true } : {}) }, [heights.buffer]);
      }
    } catch (e) {
      this.fail(s, `could not hand the tile to a worker: ${(e as Error).message}`);
      return;
    }
    s.timer = setTimeout(() => {
      if (s.busy !== p || s.dead) return;
      this.timedOut(s, p, limitMs);
    }, limitMs);
  }
}
