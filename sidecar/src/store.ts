// Durable state (slimmed from AgentCraft's foreman/src/store.ts). Everything lives under the data
// dir and survives restarts:
//
//   <data>/state.json            designs, id counters, SDK sessions, design job progress, usage limit
//   <data>/designs/<designId>/   scratch dirs of design jobs (designs.ts)
//   <data>/logs/sidecar.log      the log (main.ts)
//
// state.json is written atomically (temp + fsync + rename), debounced, and flushed on exit. It
// never holds credentials (those are in secrets.json, see secrets.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { Design } from './protocol.js';
import { ensureDir, readJson, writeJsonAtomic } from './util/fsx.js';

export interface SessionRecord {
  sessionId?: string;
  model?: string;
  turns: number;
  costUsd: number;
  updatedAt: number;
  lastResult?: string;
}

/** A design job's own progress (the Claude designer). */
export interface DesignWork {
  /** the id the agent builds under (the installed id may get a suffix) */
  bp: string;
  /** turns started so far */
  round: number;
  /** the next turn's prompt (a follow-up after a failed check) */
  pending?: string;
}

export interface StateData {
  version: 1;
  createdAt: number;
  /** design jobs, oldest first */
  designs: Design[];
  counters: Record<string, number>;
  /** "design:<id>" -> the SDK session of that design's agent */
  sessions: Record<string, SessionRecord>;
  /** design id -> its job progress */
  work: Record<string, DesignWork>;
  /** a usage limit was hit: no turn starts until `until` (epoch ms) */
  limit?: { until: number; type?: string };
  /** total estimated spend (USD) of all design turns */
  costUsd?: number;
}

function emptyState(now: number): StateData {
  return { version: 1, createdAt: now, designs: [], counters: {}, sessions: {}, work: {} };
}

export class Store {
  readonly dir: string;
  readonly file: string;
  data: StateData;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private readonly debounceMs: number;

  constructor(dir: string, opts: { debounceMs?: number; now?: number } = {}) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 100;
    ensureDir(this.dir);
    const loaded = this.loadFile();
    this.data = loaded ?? emptyState(opts.now ?? Date.now());
    if (!loaded) this.flush();
  }

  private loadFile(): StateData | undefined {
    try {
      const d = readJson<StateData>(this.file);
      if (!d) return undefined;
      if (d.version !== 1) throw new Error(`unsupported state version ${String((d as { version?: unknown }).version)}`);
      return { ...emptyState(d.createdAt ?? Date.now()), ...d };
    } catch (e) {
      // keep the corrupt file for inspection and start fresh rather than crash-looping
      const bad = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, bad);
      } catch {
        /* ignore */
      }
      console.error(`[store] could not read ${this.file} (${(e as Error).message}); moved to ${bad}`);
      return undefined;
    }
  }

  /** The next id for a counter: nextId('d') -> "d1", "d2", ... */
  nextId(prefix: string): string {
    const n = (this.data.counters[prefix] ?? 0) + 1;
    this.data.counters[prefix] = n;
    this.markDirty();
    return `${prefix}${n}`;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    writeJsonAtomic(this.file, this.data);
    this.dirty = false;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  close(): void {
    this.flush();
  }
}
