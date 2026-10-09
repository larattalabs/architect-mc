// The job records (docs/CONTRACT.md "Jobs (R2)": Job, `job.upsert`, `snapshot.jobs`): kept in
// state.json, broadcast on every change. done, failed and cancelled are final and never change.
import fs from 'node:fs';
import path from 'node:path';
import type { Cost, Job, JobSpec, JobStatus, Outbound } from '../protocol.js';
import type { JobWork, Store } from '../store.js';
import { truncate } from '../util/text.js';
import { zeroCost } from './cost.js';

export const JOB_SNAPSHOT_LIMIT = 20;
const JOB_KEEP = 100;
/** the Job record's copy of the prompt is cut here */
export const SPEC_PROMPT_CHARS = 2000;
const FINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'cancelled']);

export const isFinalJob = (j: Job): boolean => FINAL.has(j.status);

export type JobPatch = Partial<Pick<Job, 'status' | 'step' | 'result' | 'resultBlob' | 'error' | 'cost' | 'usageLimitUntil'>>;

export interface JobBookCtx {
  store: Store;
  emit(msg: Outbound): void;
  now(): number;
  /** <data>/jobs */
  dir: string;
}

/** The spec as the Job record carries it (prompt cut at 2000 chars). */
export function specView(spec: JobSpec): Record<string, unknown> {
  const v: Record<string, unknown> = { ...structuredClone(spec) };
  if (spec.prompt.length > SPEC_PROMPT_CHARS) v.prompt = `${spec.prompt.slice(0, SPEC_PROMPT_CHARS - 1)}…`;
  return v;
}

export class JobBook {
  constructor(private ctx: JobBookCtx) {}

  private get all(): Job[] {
    return (this.ctx.store.data.jobs ??= []);
  }

  get works(): Record<string, JobWork> {
    return (this.ctx.store.data.jobWork ??= {});
  }

  list(): Job[] {
    return this.all;
  }

  get(id: string): Job | undefined {
    return this.all.find((j) => j.id === id);
  }

  work(id: string): JobWork | undefined {
    return this.works[id];
  }

  active(): Job[] {
    return this.all.filter((j) => !isFinalJob(j));
  }

  /** the last JOB_SNAPSHOT_LIMIT plus every unfinished one, oldest first */
  recent(): Job[] {
    const tail = this.all.slice(-JOB_SNAPSHOT_LIMIT);
    const extra = this.active().filter((j) => !tail.includes(j));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((j) => structuredClone(j));
  }

  create(spec: JobSpec, starter: string): Job {
    const now = this.ctx.now();
    const j: Job = { id: this.ctx.store.nextId('j'), spec: specView(spec), status: 'queued', step: 'waiting to start', cost: zeroCost(), createdAt: now, updatedAt: now };
    this.all.push(j);
    this.works[j.id] = { spec: structuredClone(spec), starter, cost: zeroCost(), pending: [], queries: 0, schemaRetries: 0 };
    this.trim();
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'job.upsert', job: structuredClone(j) });
    return j;
  }

  /** Patch and broadcast. A final job is never changed. `usageLimitUntil: undefined` in the patch is ignored; use clearHold. */
  update(id: string, patch: JobPatch): Job | undefined {
    const j = this.get(id);
    if (!j || isFinalJob(j)) return j;
    let changed = false;
    for (const [k, v] of Object.entries(patch) as Array<[keyof JobPatch, unknown]>) {
      if (v === undefined) continue;
      const val = k === 'step' || k === 'error' ? truncate(String(v).replace(/\s+/g, ' ').trim(), k === 'step' ? 160 : 2000) : v;
      if (JSON.stringify(j[k]) !== JSON.stringify(val)) {
        (j as Record<string, unknown>)[k] = val;
        changed = true;
      }
    }
    if (patch.status && patch.status !== 'held' && j.usageLimitUntil !== undefined) {
      delete j.usageLimitUntil;
      changed = true;
    }
    if (changed) {
      j.updatedAt = this.ctx.now();
      // a job that just became final is on disk before any client hears of it (as DesignBook.update): after a crash
      // between the emit and a later flush the restart would re-queue it and run its paid query again, although the
      // client (or the critique loop) already has the result
      if (isFinalJob(j)) this.ctx.store.flush();
      else this.ctx.store.markDirty();
      this.ctx.emit({ type: 'job.upsert', job: structuredClone(j) });
    }
    return j;
  }

  setCost(id: string, cost: Cost): void {
    this.update(id, { cost });
  }

  scratchDir(id: string): string {
    return path.join(this.ctx.dir, id);
  }

  private trim(): void {
    const all = this.all;
    while (all.length > JOB_KEEP) {
      const i = all.findIndex((j) => isFinalJob(j));
      if (i < 0) break;
      const [gone] = all.splice(i, 1);
      if (gone) {
        delete this.works[gone.id];
        fs.rmSync(this.scratchDir(gone.id), { recursive: true, force: true });
      }
    }
  }
}
