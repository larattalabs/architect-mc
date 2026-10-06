// Claude jobs (docs/CONTRACT.md "Jobs (R2): protocol 2"): the queues, the tool-call bridge, the
// paused clock, budget, cost, usage-limit holds and resume after a restart.
//
//   - structured jobs run up to `jobConcurrency` (default 4) at once; agent jobs share the design
//     queue's single slot (Sidecar.heavy) with design jobs
//   - every query goes through a JobDriver: the Agent SDK's query() (claude.ts) or the sim (sim.ts)
//   - a mod-provided tool call becomes `job.tool.call` to the client that started the job (its
//     hello `client` name; after a reconnect, the same name), and its `job.tool.result` becomes the
//     tool's return. The call's timeout (tool `timeoutMs`, default 60 s) counts only while that
//     client is connected and not paused (`client.paused`). A call is persisted while it waits:
//     after a sidecar restart it is re-sent when the client says hello again, and its answer goes
//     into the resumed session's prompt.
//   - budget: the SDK's maxBudgetUsd gets what is left of `budgetUsd` (it counts only the current
//     query()), and the runner checks the cumulative cost before every query and after each one
//   - results over 256 KB go into a blob (`resultBlob`)
import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BlobError } from '../blobs.js';
import { StreamMapper } from '../claude/stream.js';
import { JOB_STATUS_TOOL, MAX_IMAGE_BYTES, MAX_RESULT_BYTES, type Cost, type Job, type JobSpec, type JobTool } from '../protocol.js';
import type { ClientHandle } from '../server.js';
import type { Sidecar } from '../sidecar.js';
import { ClientError } from '../sidecar.js';
import type { JobWork, PendingCall } from '../store.js';
import { truncate } from '../util/text.js';
import { isFinalJob, JobBook } from './book.js';
import { costFromResult, CostMeter } from './cost.js';
import type { DriverTool, JobDriver, ResumeAnswer, ToolAnswer } from './driver.js';
import { validateJson } from './schema.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_STRUCTURED_MAX_TURNS = 4;
export const DEFAULT_AGENT_MAX_TURNS = 40;
/** wait after a usage limit that did not say when it resets */
const LIMIT_WAIT_MS = 5 * 60_000;
const TICK_MS = 100;

export const JOB_STATUS_SCHEMA = { type: 'object', properties: { step: { type: 'string', minLength: 1, maxLength: 200, description: 'one short line of progress' } }, required: ['step'], additionalProperties: false };

export const STRUCTURED_SYSTEM = 'You work inside the Architect Minecraft mod. Answer the request with your structured output, exactly as its schema asks. You have no other tools.';
export const AGENT_SYSTEM = 'You work inside the Architect Minecraft mod. Use only the tools you are given; report progress with job_status (one short line). When the task is done, give your final answer as text.';
export const RESUME_PROMPT = 'The job was interrupted (the helper restarted). Continue the task from where you left off.';

export function continuationPrompt(answers: ResumeAnswer[]): string {
  const lines = answers.map((a) => `- ${a.name} (call ${a.callId}): ${a.error !== undefined ? `error: ${a.error}` : `result: ${truncate(JSON.stringify(a.result ?? null), MAX_RESULT_BYTES)}`}`);
  return `The helper restarted while your tool call${answers.length === 1 ? ' was' : 's were'} waiting. ${answers.length === 1 ? 'Its result' : 'Their results'}:\n${lines.join('\n')}\nContinue the task from here.`;
}

export function schemaRetryPrompt(errors: string[]): string {
  return `Your structured answer did not validate against the schema:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again, matching the schema exactly.`;
}

type StopReason = 'cancel' | 'shutdown';

interface Running {
  id: string;
  kind: JobSpec['kind'];
  abort: AbortController;
  reason?: StopReason;
  /** held by a usage limit: queue it again when this run ends */
  requeue?: boolean;
  /** the connection that sent job.run (tool calls go there first) */
  client?: ClientHandle | undefined;
  done: Promise<void>;
}

interface LiveCall {
  jobId: string;
  pc: PendingCall;
  resolve(a: ToolAnswer): void;
  sentTo?: ClientHandle | undefined;
  lastTick: number;
  lastSaved: number;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export class JobRunner {
  readonly book: JobBook;
  private structuredQueue: string[] = [];
  private agentQueue: string[] = [];
  private running = new Map<string, Running>();
  private live = new Map<string, LiveCall>();
  private ticker: NodeJS.Timeout | undefined;
  private limitTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private callSeq = 0;

  constructor(
    private sc: Sidecar,
    public driver: JobDriver | undefined = undefined,
  ) {
    this.book = new JobBook({ store: sc.store, emit: (m) => sc.emit(m), now: () => sc.now(), dir: path.join(sc.config.dataDir, 'jobs') });
  }

  private get log() {
    return this.sc.log;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Pick up the jobs that were unfinished when the sidecar stopped, then start what can start. */
  start(driver: JobDriver): void {
    this.driver = driver;
    this.sc.blobs.sweep();
    this.sweepTimer = setInterval(() => this.sc.blobs.sweep(), 3600_000);
    this.sweepTimer.unref?.();
    for (const j of this.book.active()) {
      const w = this.book.work(j.id);
      if (!w) {
        this.book.update(j.id, { status: 'failed', step: 'failed: its state was lost', error: 'its state was lost' });
        continue;
      }
      this.book.update(j.id, { status: 'queued', step: w.pending.length ? 'picked up again after a restart (a tool call is waiting)' : 'picked up again after a restart' });
      this.enqueue(j.id, w.spec.kind);
    }
    this.limitChanged();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of [this.limitTimer, this.sweepTimer]) if (t) clearTimeout(t);
    for (const r of this.running.values()) this.abort(r, 'shutdown');
    // calls the SDK is waiting on: settle them so the runs end (they stay persisted in JobWork.pending)
    for (const lc of [...this.live.values()]) this.settle(lc, { ok: false, error: 'the helper is shutting down' }, false);
    await Promise.all([...this.running.values()].map((r) => r.done.catch(() => undefined)));
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** resolves when nothing runs (tests) */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.done.catch(() => undefined)));
  }

  // ---- client messages ------------------------------------------------------------------------

  /** job.run: validated by zod; refused at once when its blobs are missing or Claude is not available. */
  run(spec: JobSpec, client: ClientHandle | undefined): Job {
    if (!this.driver) throw new ClientError('jobs are not running yet');
    const auth = this.sc.status();
    if (auth.auth === 'failed' || auth.auth === 'missing') throw new ClientError(`Claude is not available: ${auth.message ?? `auth ${auth.auth}`}`);
    const missing = this.sc.blobs.missing([...(spec.blobs ?? []), ...(spec.images ?? []).map((i) => i.blob)]);
    if (missing) throw new ClientError(missing);
    // (5a) images: PNG or JPEG blobs of at most 5 MB, checked now (refused at once otherwise)
    const images = (spec.images ?? []).map((im) => {
      let buf: Buffer;
      try {
        buf = this.sc.blobs.read(im.blob);
      } catch (e) {
        throw new ClientError(`image ${im.blob}: ${(e as Error).message}`);
      }
      const mediaType = imageType(buf);
      if (!mediaType) throw new ClientError(`image ${im.blob} is not a PNG or JPEG`);
      if (buf.length > MAX_IMAGE_BYTES) throw new ClientError(`image ${im.blob} is ${buf.length} bytes, more than ${MAX_IMAGE_BYTES}`);
      return { buf, label: im.label, mediaType };
    });
    const j = this.book.create(spec, client?.name ?? 'client');
    if (images.length) this.storeImages(j.id, images);
    this.log.info(`job ${j.id} (${spec.kind}${spec.owner ? `, ${spec.owner}` : ''}${spec.tag ? `, ${spec.tag}` : ''}) requested`);
    this.starterClients.set(j.id, client);
    this.enqueue(j.id, spec.kind);
    this.kick();
    return j;
  }

  /**
   * (5a) A job the sidecar runs for itself (the critic, the bible sheet critique): no client, the images are files
   * (copied into the job's scratch dir now), and on the sim backend an optional scripted answer.
   */
  runInternal(spec: JobSpec, opts: { images?: Array<{ file: string; label: string }>; simAnswer?: unknown } = {}): Job {
    if (!this.driver) throw new Error('jobs are not running yet');
    const images = (opts.images ?? []).map((im) => {
      const buf = fs.readFileSync(im.file);
      return { buf, label: im.label, mediaType: imageType(buf) ?? ('image/png' as const) };
    });
    const j = this.book.create(spec, 'sidecar');
    if (images.length) this.storeImages(j.id, images);
    const w = this.book.work(j.id)!;
    if (opts.simAnswer !== undefined) w.simAnswer = opts.simAnswer;
    this.sc.store.markDirty();
    this.log.info(`job ${j.id} (${spec.kind}, ${spec.owner ?? 'sidecar'}${spec.tag ? `, ${spec.tag}` : ''}${images.length ? `, ${images.length} image${images.length === 1 ? '' : 's'}` : ''}) started by the sidecar`);
    this.enqueue(j.id, spec.kind);
    this.kick();
    return j;
  }

  /** (5a) Write a job's images into <scratch>/images/ and record them in its work. */
  private storeImages(id: string, images: Array<{ buf: Buffer; label: string; mediaType: 'image/png' | 'image/jpeg' }>): void {
    const dir = path.join(this.book.scratchDir(id), 'images');
    fs.mkdirSync(dir, { recursive: true });
    const w = this.book.work(id)!;
    w.images = images.map((im, i) => {
      const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.${im.mediaType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, im.buf);
      return { file, label: im.label, mediaType: im.mediaType };
    });
    this.sc.store.markDirty();
  }

  /** the connection that sent job.run, while it lasts */
  private starterClients = new Map<string, ClientHandle | undefined>();

  cancel(id: string): Job {
    const j = this.book.get(id);
    if (!j) throw new ClientError(`no job "${id}"`);
    if (isFinalJob(j)) throw new ClientError(`job ${id} is already ${j.status}`);
    this.book.update(id, { status: 'cancelled', step: 'cancelled' });
    this.log.info(`job ${id} cancelled`);
    this.structuredQueue = this.structuredQueue.filter((x) => x !== id);
    this.agentQueue = this.agentQueue.filter((x) => x !== id);
    this.sc.pool.withdraw(`job:${id}`);
    const w = this.book.work(id);
    if (w) {
      w.pending = [];
      this.sc.store.markDirty();
    }
    for (const lc of [...this.live.values()]) if (lc.jobId === id) this.settle(lc, { ok: false, error: 'the job was cancelled' });
    const r = this.running.get(id);
    if (r) this.abort(r, 'cancel');
    return j;
  }

  /** job.tool.result: the client's answer to a pending call. */
  toolResult(jobId: string, callId: string, result: unknown, error: string | undefined): void {
    const lc = this.live.get(callId);
    // a call persisted before a restart whose job has not started again yet (waiting for auth or the slot)
    const stored = !lc ? this.book.work(jobId)?.pending.find((p) => p.callId === callId && !p.answer) : undefined;
    if ((!lc || lc.jobId !== jobId) && !stored) throw new ClientError(`job ${jobId} has no pending tool call "${callId}" (answered, timed out or cancelled)`);
    let answer: ToolAnswer;
    if (error !== undefined) answer = { ok: false, error };
    else {
      const json = JSON.stringify(result ?? null);
      const size = Buffer.byteLength(json);
      if (size > MAX_RESULT_BYTES) throw new ClientError(`the result is ${size} bytes, more than ${MAX_RESULT_BYTES}: put it in a blob (blob.put) and return its id; the call is still waiting`);
      answer = { ok: true, result: JSON.parse(json) as unknown };
    }
    if (lc) return this.settle(lc, answer);
    stored!.answer = answer.ok ? { result: answer.result } : { error: answer.error };
    this.sc.store.flush();
    this.log.info(`job ${jobId}: ${stored!.name} answered before the job started again; kept for its resume`);
  }

  /** A client said hello: re-send the tool calls waiting for a client of its name. */
  clientReady(c: ClientHandle): void {
    if (c.protocol < 2) return;
    for (const lc of this.live.values()) {
      if (lc.sentTo?.open) continue;
      const w = this.book.work(lc.jobId);
      if (!w || w.starter !== c.name) continue;
      this.deliver(lc, c);
    }
  }

  clientGone(c: ClientHandle): void {
    for (const [id, cl] of this.starterClients) if (cl === c) this.starterClients.set(id, undefined);
    for (const lc of this.live.values()) {
      if (lc.sentTo !== c) continue;
      lc.sentTo = undefined;
      // another connection of the same client name may take it
      const other = this.sc.clients().find((x) => x.open && x.protocol >= 2 && x.name === this.book.work(lc.jobId)?.starter);
      if (other) this.deliver(lc, other);
      else this.log.info(`job ${lc.jobId}: tool call ${lc.pc.callId} (${lc.pc.name}) waits for its client to reconnect`);
    }
  }

  /** client.paused: nothing to do but log; the clock reads `client.paused` on every tick. */
  pausedChanged(c: ClientHandle): void {
    this.tick();
    this.log.debug(`client ${c.name}#${c.id} ${c.paused ? 'paused' : 'resumed'}`);
  }

  // ---- usage limits ---------------------------------------------------------------------------

  private limitedUntil(): number | undefined {
    const l = this.sc.store.data.limit;
    return l && l.until > this.sc.now() ? l.until : undefined;
  }

  /** The shared usage limit changed (a design or a job hit one, or it was cleared). */
  limitChanged(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    const l = this.sc.store.data.limit;
    if (!l) return this.kick();
    const left = l.until - Date.now();
    if (left <= 0) {
      delete this.sc.store.data.limit;
      this.sc.store.markDirty();
      this.sc.statusChanged();
      // the designer wakes up too (sc.limitChanged comes back here with no limit: just a kick)
      this.sc.limitChanged();
      return;
    }
    // waiting jobs show the hold
    for (const id of [...this.structuredQueue, ...this.agentQueue]) {
      const j = this.book.get(id);
      if (j && !isFinalJob(j)) this.book.update(id, { status: 'held', step: `usage limit - resumes ${clock(l.until)}`, usageLimitUntil: l.until });
    }
    this.limitTimer = setTimeout(() => this.limitChanged(), Math.min(left + 500, 2 ** 31 - 1));
    this.limitTimer.unref?.();
  }

  private hold(id: string, resetsAt: number | undefined, type: string | undefined): void {
    const until = resetsAt ?? Date.now() + LIMIT_WAIT_MS;
    const prev = this.sc.store.data.limit;
    if (!prev || prev.until < until) {
      this.sc.store.data.limit = { until, ...(type ? { type } : {}) };
      this.sc.store.markDirty();
      this.log.warn(`usage limit reached${type ? ` (${type.replace(/_/g, ' ')})` : ''}: jobs and designs wait until ${clock(until)}`);
    }
    const at = this.sc.store.data.limit!.until;
    this.book.update(id, { status: 'held', step: `usage limit - resumes ${clock(at)}`, usageLimitUntil: at });
    this.sc.statusChanged();
    this.sc.limitChanged();
  }

  // ---- the queues -----------------------------------------------------------------------------

  private enqueue(id: string, kind: JobSpec['kind'], front = false): void {
    const q = kind === 'structured' ? this.structuredQueue : this.agentQueue;
    if (q.includes(id) || this.running.has(id)) return;
    if (front) q.unshift(id);
    else q.push(id);
    // (4b) an agent job takes a slot of the design pool (lane `jobs`), round-robin with designs and groups
    if (kind === 'agent') this.sc.pool.submit({ key: `job:${id}`, lane: 'jobs', ready: () => this.agentReady(), start: () => this.startAgent(id) }, front);
  }

  private agentReady(): boolean {
    if (this.stopping || !this.driver) return false;
    return this.sc.status().auth === 'ok' && !this.limitedUntil();
  }

  /** The pool gave an agent job its slot: run it (the slot is held until it ends). */
  private startAgent(id: string): Promise<void> {
    this.agentQueue = this.agentQueue.filter((x) => x !== id);
    const j = this.book.get(id);
    if (!j || isFinalJob(j) || this.running.has(id)) return Promise.resolve();
    this.launch(id, 'agent');
    return this.running.get(id)?.done ?? Promise.resolve();
  }

  kick(): void {
    if (this.stopping || !this.driver) return;
    const auth = this.sc.status();
    if (auth.auth === 'failed' || auth.auth === 'missing') {
      for (const id of [...this.structuredQueue.splice(0), ...this.agentQueue.splice(0)]) {
        this.sc.pool.withdraw(`job:${id}`);
        const msg = `Claude is not available: ${auth.message ?? `auth ${auth.auth}`}`;
        this.book.update(id, { status: 'failed', step: `failed: ${msg}`, error: msg });
      }
      return;
    }
    if (auth.auth !== 'ok' || this.limitedUntil()) return;
    const runningStructured = [...this.running.values()].filter((r) => r.kind === 'structured').length;
    for (let n = runningStructured; n < this.sc.config.jobs.concurrency && this.structuredQueue.length; n++) this.launch(this.structuredQueue.shift()!, 'structured');
    if (this.agentQueue.length) this.sc.pool.kick();
  }

  private launch(id: string, kind: JobSpec['kind']): void {
    const r: Running = { id, kind, abort: new AbortController(), client: this.starterClients.get(id), done: Promise.resolve() };
    this.running.set(id, r);
    r.done = this.runJob(r)
      .catch((e) => {
        this.log.error(`job ${id}: ${(e as Error).stack ?? e}`);
        this.fail(id, (e as Error).message);
      })
      .finally(() => {
        this.running.delete(id);
        // (an agent job: after the pool has released its slot)
        if (r.requeue) {
          if (kind === 'agent') setImmediate(() => this.enqueue(id, kind, true));
          else this.enqueue(id, kind, true);
        }
        const j = this.book.get(id);
        if (j && isFinalJob(j)) this.starterClients.delete(id);
        if (!this.stopping) this.kick();
      });
  }

  private abort(r: Running, reason: StopReason): void {
    r.reason ??= reason;
    r.abort.abort();
  }

  private fail(id: string, error: string, step?: string): void {
    const j = this.book.get(id);
    if (!j || isFinalJob(j)) return;
    this.book.update(id, { status: 'failed', step: step ?? `failed: ${error.split('\n')[0]}`, error });
    this.log.warn(`job ${id} failed: ${truncate(error.split('\n')[0] ?? error, 200)}`);
  }

  private done(id: string, result: unknown, owner: string | undefined): void {
    const j = this.book.get(id);
    if (!j || isFinalJob(j)) return;
    const json = JSON.stringify(result ?? null);
    if (Buffer.byteLength(json) > MAX_RESULT_BYTES) {
      const blobId = this.sc.blobs.putJson(result, 'job.result', owner);
      this.book.update(id, { status: 'done', step: `done (result in blob ${blobId}, ${Buffer.byteLength(json)} bytes)`, resultBlob: blobId });
    } else this.book.update(id, { status: 'done', step: 'done', result });
    this.log.info(`job ${id} done ($${j.cost.usd.toFixed(4)}, ${j.cost.turns} turns)`);
  }

  // ---- scratch dir ----------------------------------------------------------------------------

  /**
   * <data>/jobs/<id>/ with the job's blobs in blobs/<id>.<ext> (no file tools by default). A blob
   * copied on an earlier start is kept, so a resumed job does not need the blob any more.
   */
  prepareScratch(id: string, blobs: string[]): string {
    const dir = this.book.scratchDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(dir);
    let have: string[] = [];
    try {
      have = fs.readdirSync(path.join(real, 'blobs'));
    } catch {
      /* none yet */
    }
    const missing = blobs.filter((b) => !have.some((f) => f.startsWith(`${b}.`)));
    try {
      this.sc.blobs.copyInto(missing, real);
    } catch (e) {
      if (e instanceof BlobError) throw new Error(`${e.message} (it expired or was deleted)`);
      throw e;
    }
    return real;
  }

  // ---- the tool-call bridge -------------------------------------------------------------------

  private target(jobId: string): ClientHandle | undefined {
    const first = this.running.get(jobId)?.client;
    if (first?.open) return first;
    const name = this.book.work(jobId)?.starter;
    return this.sc.clients().find((c) => c.open && c.protocol >= 2 && c.name === name);
  }

  private deliver(lc: LiveCall, c: ClientHandle): void {
    lc.sentTo = c;
    lc.lastTick = Date.now();
    const w = this.book.work(lc.jobId);
    c.send({ type: 'job.tool.call', jobId: lc.jobId, callId: lc.pc.callId, name: lc.pc.name, input: lc.pc.input, ...(w?.spec.owner ? { owner: w.spec.owner } : {}), timeoutMs: lc.pc.timeoutMs });
  }

  /** Wait for the client's answer to a pending call (new, or persisted from before a restart). */
  private waitCall(jobId: string, pc: PendingCall): Promise<ToolAnswer> {
    return new Promise<ToolAnswer>((resolve) => {
      const lc: LiveCall = { jobId, pc, resolve, lastTick: Date.now(), lastSaved: Date.now() };
      this.live.set(pc.callId, lc);
      this.book.update(jobId, { status: 'waiting_tool', step: `waiting for ${pc.name}` });
      this.sc.emit({ type: 'job.event', jobId, kind: 'tool', data: { phase: 'call', name: pc.name, callId: pc.callId } });
      const c = this.target(jobId);
      if (c) this.deliver(lc, c);
      else this.log.info(`job ${jobId}: tool call ${pc.callId} (${pc.name}) waits for its client to connect`);
      this.ensureTicker();
    });
  }

  /** Settle a live call. `forget`: drop it from the persisted pending list (false on shutdown). */
  private settle(lc: LiveCall, a: ToolAnswer, forget = true, phase?: 'timeout'): void {
    if (this.live.get(lc.pc.callId) !== lc) return;
    this.live.delete(lc.pc.callId);
    if (forget) {
      const w = this.book.work(lc.jobId);
      if (w) {
        const p = w.pending.find((x) => x.callId === lc.pc.callId);
        if (p) p.answer = a.ok ? { result: a.result } : { error: a.error };
        this.sc.store.markDirty();
      }
      this.sc.emit({ type: 'job.event', jobId: lc.jobId, kind: 'tool', data: { phase: phase ?? (a.ok ? 'result' : 'error'), name: lc.pc.name, callId: lc.pc.callId } });
      const j = this.book.get(lc.jobId);
      if (j && j.status === 'waiting_tool' && ![...this.live.values()].some((x) => x.jobId === lc.jobId)) this.book.update(lc.jobId, { status: 'running', step: `${lc.pc.name} answered` });
    }
    lc.resolve(a);
    if (!this.live.size && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  /** The paused clock: a call's time counts only while its client is connected and not paused. */
  private tick(): void {
    const now = Date.now();
    for (const lc of [...this.live.values()]) {
      const counting = !!lc.sentTo?.open && !lc.sentTo.paused;
      if (counting) lc.pc.elapsedMs += Math.max(0, now - lc.lastTick);
      lc.lastTick = now;
      if (now - lc.lastSaved > 2000) {
        lc.lastSaved = now;
        this.sc.store.markDirty();
      }
      if (lc.pc.elapsedMs >= lc.pc.timeoutMs) {
        this.log.warn(`job ${lc.jobId}: tool call ${lc.pc.callId} (${lc.pc.name}) timed out after ${Math.round(lc.pc.timeoutMs / 1000)}s`);
        this.settle(lc, { ok: false, error: `the tool ${lc.pc.name} timed out after ${Math.round(lc.pc.timeoutMs / 1000)}s (game time, pauses excluded)` }, true, 'timeout');
      }
    }
  }

  /** A mod-provided tool for the driver: each call is persisted, sent to the client and awaited. */
  private modTool(jobId: string, t: JobTool, r: Running): DriverTool {
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      call: async (input) => {
        if (r.abort.signal.aborted) return { ok: false, error: 'the job was stopped' };
        const w = this.book.work(jobId);
        if (!w) return { ok: false, error: 'the job is gone' };
        const pc: PendingCall = { callId: `c${++this.callSeq}_${Date.now().toString(36)}`, name: t.name, input: input ?? {}, timeoutMs: t.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, elapsedMs: 0, startedAt: Date.now() };
        w.pending.push(pc);
        // on disk before the client sees the call: a crash from here on still re-sends it
        this.sc.store.flush();
        const a = await this.waitCall(jobId, pc);
        // the SDK takes the answer now: it no longer needs to survive a restart (unless we are stopping)
        if (!(r.reason === 'shutdown' || this.stopping)) {
          w.pending = w.pending.filter((x) => x.callId !== pc.callId);
          this.sc.store.markDirty();
        }
        return a;
      },
    };
  }

  private statusTool(jobId: string): DriverTool {
    return {
      name: JOB_STATUS_TOOL,
      description: 'Report one short line of progress on the job (shown to the player and the mod that asked).',
      inputSchema: JOB_STATUS_SCHEMA,
      call: async (input) => {
        const step = typeof (input as { step?: unknown })?.step === 'string' ? (input as { step: string }).step : '';
        if (!step.trim()) return { ok: false, error: 'step must be a short non-empty line' };
        this.book.update(jobId, { step: truncate(step.trim(), 200) });
        this.sc.emit({ type: 'job.event', jobId, kind: 'step', data: { step: truncate(step.trim(), 200) } });
        return { ok: true, result: 'ok' };
      },
    };
  }

  // ---- one job --------------------------------------------------------------------------------

  private stopped(r: Running): boolean {
    const j = this.book.get(r.id);
    return r.abort.signal.aborted || this.stopping || !j || isFinalJob(j);
  }

  private async runJob(r: Running): Promise<void> {
    const id = r.id;
    const j = this.book.get(id);
    const w = this.book.work(id);
    if (!j || isFinalJob(j) || !w) return;
    const spec = w.spec;
    const cwd = this.prepareScratch(id, spec.blobs ?? []);
    const meter = new CostMeter(w.cost);
    // a restart while tool calls waited: get their answers first (re-sent when the client says hello)
    let answers: ResumeAnswer[] | undefined;
    if (w.pending.length && !w.sessionId) {
      // (no session to give the answers to: start over)
      w.pending = [];
      this.sc.store.markDirty();
    }
    if (w.pending.length) {
      const pending = [...w.pending];
      const got = await Promise.all(pending.map((pc) => (pc.answer ? Promise.resolve<ToolAnswer>(pc.answer.error !== undefined ? { ok: false, error: pc.answer.error } : { ok: true, result: pc.answer.result }) : this.waitCall(id, pc))));
      if (this.stopped(r)) return;
      answers = pending.map((pc, i) => {
        const a = got[i]!;
        return { callId: pc.callId, name: pc.name, ...(a.ok ? { result: a.result } : { error: a.error }) };
      });
    }
    let retryPrompt: string | undefined;
    for (;;) {
      if (this.stopped(r)) return;
      if (spec.budgetUsd !== undefined && meter.remaining(spec.budgetUsd) <= 0) {
        this.fail(id, 'budget', `failed: budget ($${meter.total().usd.toFixed(4)} of $${spec.budgetUsd})`);
        return;
      }
      const resume = w.sessionId;
      const prompt = answers && resume ? continuationPrompt(answers) : retryPrompt ?? (resume ? RESUME_PROMPT : spec.prompt);
      const tools = spec.kind === 'agent' ? [...(spec.tools ?? []).map((t) => this.modTool(id, t, r)), this.statusTool(id)] : [];
      w.queries++;
      this.sc.store.markDirty();
      this.book.update(id, { status: 'running', step: w.queries === 1 ? 'starting' : resume ? 'resuming' : 'starting again' });
      const mapper = new StreamMapper(this.log, `job ${id}`, (rl) => {
        if (rl.status === 'rejected') this.hold(id, rl.resetsAt, rl.type);
      });
      meter.begin(!!resume);
      let structured: unknown;
      let thrown: string | undefined;
      try {
        const q = this.driver!.query({
          jobId: id,
          kind: spec.kind,
          prompt,
          system: spec.system ?? (spec.kind === 'structured' ? STRUCTURED_SYSTEM : AGENT_SYSTEM),
          model: spec.model ?? this.sc.config.jobs.model,
          effort: spec.effort,
          maxTurns: spec.maxTurns ?? (spec.kind === 'structured' ? DEFAULT_STRUCTURED_MAX_TURNS : DEFAULT_AGENT_MAX_TURNS),
          maxBudgetUsd: spec.budgetUsd !== undefined ? meter.remaining(spec.budgetUsd) : undefined,
          schema: spec.schema,
          tools,
          cwd,
          resume,
          resumeAnswers: answers && resume ? answers : undefined,
          abort: r.abort,
          ...(w.images?.length ? { images: w.images } : {}),
          ...(w.simAnswer !== undefined && this.driver!.name === 'sim' ? { simAnswer: w.simAnswer } : {}),
        });
        for await (const msg of q) {
          if (r.abort.signal.aborted) break;
          mapper.handle(msg);
          this.onMessage(id, w, msg, answers !== undefined);
          if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init' && answers) {
            // the resumed session has the answers now
            answers = undefined;
            w.pending = [];
            this.sc.store.markDirty();
          }
          if (msg.type === 'result') {
            const total = meter.observe(costFromResult(msg as unknown as Record<string, unknown>));
            this.book.setCost(id, total);
            structured = (msg as { structured_output?: unknown }).structured_output;
          }
        }
      } catch (e) {
        if (!r.abort.signal.aborted) thrown = (e as Error).message ?? String(e);
      }
      w.cost = meter.commit();
      this.sc.store.markDirty();
      if (r.reason === 'shutdown' || this.stopping) return; // resumes on the next start
      if (r.reason === 'cancel' || this.stopped(r)) return;
      const stats = mapper.stats;
      if (thrown) {
        stats.isError = true;
        stats.errors.push(thrown);
      }
      if (stats.limited) {
        w.queries--;
        if (this.book.get(id)?.status !== 'held') this.hold(id, stats.rateLimit?.resetsAt, stats.rateLimit?.type);
        r.requeue = true; // back at the front of its queue once this run has ended
        return;
      }
      if (stats.authFailed) return this.fail(id, `Claude authentication failed (${stats.authFailed})`);
      if (stats.subtype === 'error_max_budget_usd' || (spec.budgetUsd !== undefined && w.cost.usd >= spec.budgetUsd && stats.subtype !== 'success')) {
        return this.fail(id, 'budget', `failed: budget ($${w.cost.usd.toFixed(4)} of $${spec.budgetUsd ?? '?'})`);
      }
      if (stats.subtype === 'error_max_structured_output_retries') return this.fail(id, 'the answer did not match the schema (error_max_structured_output_retries)');
      if (stats.subtype === 'error_max_turns') return this.fail(id, `the job ran out of turns (maxTurns ${spec.maxTurns ?? (spec.kind === 'structured' ? DEFAULT_STRUCTURED_MAX_TURNS : DEFAULT_AGENT_MAX_TURNS)})`);
      if (stats.isError || stats.subtype !== 'success') return this.fail(id, truncate([stats.subtype && stats.subtype !== 'success' ? stats.subtype : '', ...stats.errors].filter(Boolean).join(': ') || 'the query ended without a result', 1500));
      // success
      if (spec.kind === 'structured') {
        let out = structured;
        if (out === undefined && stats.resultText) out = tryJson(stats.resultText);
        const errors = out === undefined ? ['there is no structured output'] : validateJson(out, spec.schema!);
        if (errors.length) {
          if (w.schemaRetries < 1 && w.sessionId) {
            w.schemaRetries++;
            this.sc.store.markDirty();
            this.log.warn(`job ${id}: the answer does not validate (${truncate(errors.join('; '), 200)}); asking once more`);
            retryPrompt = schemaRetryPrompt(errors);
            continue;
          }
          return this.fail(id, `the answer did not match the schema: ${truncate(errors.join('; '), 1000)}`);
        }
        return this.done(id, out, spec.owner);
      }
      const text = stats.resultText ?? '';
      let json: unknown = structured;
      if (json === undefined) json = tryJson(text);
      if (spec.schema && json !== undefined) {
        const errors = validateJson(json, spec.schema);
        if (errors.length) {
          this.log.warn(`job ${id}: the final JSON does not validate (${truncate(errors.join('; '), 200)}); returned without it`);
          json = undefined;
        }
      }
      return this.done(id, { text, ...(json !== undefined ? { json } : {}) }, spec.owner);
    }
  }

  /** Streamed progress (job.event) and the session id. */
  private onMessage(id: string, w: JobWork, msg: SDKMessage, _resuming: boolean): void {
    const sid = (msg as { session_id?: string }).session_id;
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init' && sid && w.sessionId !== sid) {
      w.sessionId = sid;
      this.sc.store.markDirty();
    }
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const b of (msg.message?.content ?? []) as Array<{ type: string; text?: string }>) {
        if (b.type === 'text' && b.text?.trim()) this.sc.emit({ type: 'job.event', jobId: id, kind: 'text', data: { text: truncate(b.text.trim(), 2000) } });
      }
    }
  }

  /** cost so far of a job (tests, logs) */
  cost(id: string): Cost | undefined {
    return this.book.get(id)?.cost;
  }
}

/** (5a) PNG or JPEG by the file's magic bytes. */
export function imageType(buf: Buffer): 'image/png' | 'image/jpeg' | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return undefined;
}

function tryJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)?.[1];
  for (const s of [fenced, t]) {
    if (!s) continue;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}
