// Durable state (slimmed from AgentCraft's foreman/src/store.ts). Everything lives under the data
// dir and survives restarts:
//
//   <data>/state.json            designs, id counters, SDK sessions, design job progress, usage limit
//   <data>/designs/<designId>/   scratch dirs of design jobs (designs.ts)
//   <data>/variants/<variantId>/ scratch dirs of variant and import jobs (variants.ts)
//   <data>/jobs/<jobId>/         scratch dirs of Claude jobs (jobs/runner.ts), with blobs/
//   <data>/blobs/<blobId>        blobs (blobs.ts)
//   <data>/logs/sidecar.log      the log (main.ts)
//
// state.json is written atomically (temp + fsync + rename), debounced, and flushed on exit. It
// never holds credentials (those are in secrets.json, see secrets.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { BlobMeta } from './blobs.js';
import type { BibleWork } from './bibles.js';
import type { EstimateData } from './estimates.js';
import type { GroupWork } from './groups.js';
import type { BibleJob, Cost, Design, Group, Job, JobSpec, Massing, Reskin, Variant } from './protocol.js';
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
  /** (protocol 2) the cost committed by finished turns */
  cost?: Cost;
  /** (5a) the critique loop's state (critique.ts CritiqueWork) */
  critique?: import('./critique.js').CritiqueWork;
  /** (5b) a polish's state (polish.ts PolishWork) */
  polish?: import('./polish.js').PolishWork;
}

/** A mod-provided tool call the client has not answered yet (survives a restart). */
export interface PendingCall {
  callId: string;
  name: string;
  input: unknown;
  timeoutMs: number;
  /** time counted against the timeout (only while the client is connected and not paused) */
  elapsedMs: number;
  startedAt: number;
  /** answered after a restart, waiting for the resumed session to take it */
  answer?: { result?: unknown; error?: string };
}

/** A job's own progress (jobs/runner.ts). */
export interface JobWork {
  /** the full spec (the Job record's copy has the prompt cut at 2000 chars) */
  spec: JobSpec;
  /** the hello `client` name of the client that started it: its tool calls go there */
  starter: string;
  sessionId?: string;
  /** cost committed by finished query() calls */
  cost: Cost;
  pending: PendingCall[];
  /** query() calls started so far */
  queries: number;
  /** structured: re-asks after the sidecar's own schema check failed */
  schemaRetries: number;
  /** (5a) the job's images, copied into its scratch dir (images/) when it was made */
  images?: Array<{ file: string; label: string; mediaType: 'image/png' | 'image/jpeg' }>;
  /** (5a) sim only: a scripted structured answer (the critic's verdicts) */
  simAnswer?: unknown;
}

export interface StateData {
  version: 1;
  createdAt: number;
  /** design jobs, oldest first */
  designs: Design[];
  /** variant and import jobs, oldest first */
  variants: Variant[];
  /** (protocol 2) Claude jobs, oldest first */
  jobs: Job[];
  /** job id -> its progress */
  jobWork: Record<string, JobWork>;
  /** blob id -> its record (blobs.ts) */
  blobs: Record<string, BlobMeta>;
  counters: Record<string, number>;
  /** "design:<id>" -> the SDK session of that design's agent */
  sessions: Record<string, SessionRecord>;
  /** design id -> its job progress */
  work: Record<string, DesignWork>;
  /** a usage limit was hit: no turn starts until `until` (epoch ms) */
  limit?: { until: number; type?: string };
  /** total estimated spend (USD) of all design turns */
  costUsd?: number;
  /** (4b) design groups, oldest first, and their own bookkeeping */
  groups?: Group[];
  groupWork?: Record<string, GroupWork>;
  /** (4b) bible jobs, oldest first, and their progress */
  bibleJobs?: BibleJob[];
  bibleWork?: Record<string, BibleWork>;
  /** (4b) re-skins of a collection */
  reskins?: Reskin[];
  /** (4b) the rolling per-model averages behind design.estimate / bible.estimate */
  estimates?: EstimateData;
  /** (4b) design id -> when it first started (for the time estimates) */
  runStarts?: Record<string, number>;
  /** (4c) massing versions (massings.ts), oldest first */
  massings?: Massing[];
}

function emptyState(now: number): StateData {
  return { version: 1, createdAt: now, designs: [], variants: [], jobs: [], jobWork: {}, blobs: {}, counters: {}, sessions: {}, work: {} };
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
