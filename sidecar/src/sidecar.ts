// The sidecar core (the design part of AgentCraft's Foreman, foreman/src/foreman.ts): the design
// book, the status, the client messages, and the hooks a designer (claude or sim) reports through.
// Phase 4b adds the design pool (pool.ts, scheduler.ts), design groups (groups.ts), style bibles
// (bibles.ts), estimates (estimates.ts) and re-skins (variants.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { VERSION } from './config.js';
import type { Logger } from './context.js';
import { BibleIndex, Bibles, SimBibleBackend, type BibleBackend, type RunOutcome } from './bibles.js';
import { BlobError, BlobStore } from './blobs.js';
import { DesignBook, describeRequest, isFinalDesign, runNode, type Installed } from './designs.js';
import { Estimates, type EstimateCtx } from './estimates.js';
import { Groups } from './groups.js';
import { ClaudeJobDriver, type ClaudeHost } from './jobs/claude.js';
import type { JobDriver } from './jobs/driver.js';
import { JobRunner } from './jobs/runner.js';
import { SimJobDriver } from './jobs/sim.js';
import { Pool } from './pool.js';
import { FEATURES, KitPalettes, type BibleRef, type ClientMessage, type Cost, type PaletteInfo, type Design, type DesignRequest, type Outbound, type PaletteSpec, type ParamValues, type Protocol, type Status, type Variant } from './protocol.js';
import { DesignScheduler, designKey } from './scheduler.js';
import { readSecrets, updateSecrets, type Secrets } from './secrets.js';
import type { ClientHandle } from './server.js';
import type { Store } from './store.js';
import { truncate } from './util/text.js';
import { checkImportPath, findVariantSource, Reskins, VariantBook, VariantRefused, VariantRunner } from './variants.js';

export type { RunOutcome } from './bibles.js';

/** A message the client caused that cannot be done (answered with ack ok:false). */
export class ClientError extends Error {}

/**
 * Runs design jobs: the Claude designer (claude/designer.ts) or the sim (sim.ts). The scheduler hands it one design at a
 * time per pool slot (`run`); it never queues by itself.
 */
export interface Designer {
  readonly name: 'claude' | 'sim';
  /** check auth / the SDK; designs start once it is ready */
  start(): Promise<void>;
  /** may a design (or bible) turn start now? (auth ok, no usage limit, not stopping) */
  canRun(): boolean;
  /** auth failed for good (until auth.set): the reason; waiting designs fail with it */
  blocked(): string | undefined;
  /** run one design to its end: 'requeue' (a usage limit: back to the front of its lane) or 'stopped' (shutdown) */
  run(id: string): Promise<RunOutcome>;
  /** the design is already marked final (cancelled, or a group's budget stopped it): stop its turn */
  cancel(id: string): void;
  /** credentials or the login opt-in changed (auth.set) */
  authChanged(): void;
  /** the shared usage limit changed (a job hit one): re-arm the wake-up */
  limitChanged?(): void;
  /** the bible backend that runs on this designer's backend */
  bibleBackend?(): BibleBackend;
  stop(): Promise<void>;
}

export interface AuthView {
  auth: Status['auth'];
  authSource?: string;
  sdk: Status['sdk'];
  message?: string;
}

export class Sidecar {
  readonly designs: DesignBook;
  /** variant and import jobs (no Claude), on their own queue */
  readonly variants: VariantBook;
  readonly variantRunner: VariantRunner;
  /** (4b) re-skins of a collection: N variants with another bible */
  readonly reskins: Reskins;
  /** (protocol 2) blobs: job inputs such as a survey, and big job results */
  readonly blobs: BlobStore;
  /** (protocol 2) Claude jobs */
  readonly jobs: JobRunner;
  /** (4b) the design pool: designConcurrency slots, round-robin across groups, single designs, bibles and agent jobs */
  readonly pool: Pool;
  readonly scheduler: DesignScheduler;
  /** (4b) design groups */
  readonly groups: Groups;
  /** (4b) style bibles: the installed ones and the jobs that make them */
  readonly bibleIndex: BibleIndex;
  readonly bibles: Bibles;
  /** (4b) cost and time estimates */
  readonly estimates: Estimates;
  /** trusted connections */
  private connected = new Set<ClientHandle>();
  /** the kit's palette presets and choices, for the snapshot (loaded at start) */
  private palettes: PaletteInfo | undefined;
  private listeners = new Set<(m: Outbound) => void>();
  private designer: Designer | undefined;
  private authView: AuthView = { auth: 'checking', sdk: 'missing' };
  private lastStatus = '';
  /** shutdown requested by a client (main.ts sets it) */
  onShutdown: (() => void) | undefined;
  /** the run's client token file and port (the policy keeps the agent away from them) */
  endpoint: { port: number; tokenFile: string } | undefined;

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly log: Logger,
    readonly now: () => number = Date.now,
  ) {
    this.designs = new DesignBook({ store, emit: (m) => this.emit(m), now: () => this.now() });
    this.variants = new VariantBook({ store, emit: (m) => this.emit(m), now: () => this.now() });
    this.variantRunner = new VariantRunner(this);
    this.reskins = new Reskins(this);
    this.blobs = new BlobStore(config.dataDir, store, () => this.now());
    this.pool = new Pool(() => this.config.designConcurrency, (key, e) => this.log.error(`${key}: ${(e as Error)?.stack ?? e}`));
    this.scheduler = new DesignScheduler(this);
    this.groups = new Groups(this);
    this.bibleIndex = new BibleIndex(this);
    this.bibles = new Bibles(this);
    this.estimates = new Estimates(store, () => this.now());
    this.jobs = new JobRunner(this);
  }

  /** trusted, open connections */
  clients(): ClientHandle[] {
    return [...this.connected].filter((c) => c.open);
  }

  clientGone(c: ClientHandle): void {
    this.connected.delete(c);
    this.jobs.clientGone(c);
  }

  /** The shared usage limit changed: the queues re-arm their wake-ups, groups show the hold. */
  limitChanged(): void {
    this.designer?.limitChanged?.();
    this.jobs.limitChanged();
    this.groups.refreshActive();
  }

  // ---- outbound -------------------------------------------------------------------------------

  subscribe(fn: (m: Outbound) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(m: Outbound): void {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch (e) {
        this.log.error(`listener: ${(e as Error).message}`);
      }
    }
    // a design changing state changes the queue counts, and its group
    if (m.type === 'design.upsert') {
      this.groups.designChanged(m.design);
      this.statusChanged();
    }
    if (m.type === 'variant.upsert') this.reskins.variantChanged(m.variant);
  }

  // ---- status ---------------------------------------------------------------------------------

  /** --use-claude-login, or the in-game toggle (secrets.json) */
  get useClaudeLogin(): boolean {
    return this.config.claude.useClaudeLoginFlag || readSecrets(this.config.dataDir).useClaudeLogin === true;
  }

  secrets(): Secrets {
    return readSecrets(this.config.dataDir);
  }

  setAuth(view: AuthView): void {
    this.authView = { ...view };
    this.statusChanged();
    this.jobs.kick();
    this.scheduler.kick();
  }

  status(): Status {
    const running = this.scheduler.runningIds();
    const limit = this.store.data.limit;
    const a = this.authView;
    return {
      auth: a.auth,
      ...(a.authSource ? { authSource: a.authSource } : {}),
      useClaudeLogin: this.useClaudeLogin,
      sdk: a.sdk,
      ...(running.length ? { designing: running[0]!, designingIds: running } : {}),
      queued: this.designs.active().filter((d) => d.status === 'queued').length,
      ...(limit && limit.until > this.now() ? { usageLimitUntil: limit.until } : {}),
      ...(this.designer ? { backend: this.designer.name } : {}),
      ...(a.message ? { message: a.message } : {}),
    };
  }

  /** Broadcast `status` if it changed. */
  statusChanged(): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    for (const fn of this.listeners) fn({ type: 'status', status: s });
  }

  /** The snapshot for a connection (the server strips the protocol-2 parts for a protocol-1 client). */
  snapshot(protocol: Protocol = 2): Outbound {
    return {
      type: 'snapshot',
      version: VERSION,
      status: this.status(),
      designs: this.designs.recent(),
      variants: this.variants.recent(),
      ...(this.palettes ? { palettes: this.palettes } : {}),
      ...(protocol >= 2
        ? { protocol, features: [...FEATURES], jobs: this.jobs.book.recent(), groups: this.groups.recent(), bibles: this.bibles.recent(), bibleIndex: this.bibleIndex.list(), reskins: this.reskins.recent() }
        : {}),
    } as Outbound;
  }

  /** A bible was installed: every client gets the new index. */
  bibleIndexChanged(): void {
    this.emit({ type: 'bible.index', bibles: this.bibleIndex.list() } as Outbound);
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /**
   * Queue the designs, bible jobs and groups that were unfinished when the sidecar stopped, then start the designer
   * (the Claude designer checks auth first; queued work waits for that).
   */
  async start(designer: Designer, jobDriver?: JobDriver): Promise<void> {
    this.designer = designer;
    this.bibles.backend = designer.bibleBackend?.() ?? new SimBibleBackend(this, this.config.simStepMs);
    fs.mkdirSync(this.config.biblesDir, { recursive: true });
    this.variantRunner.start();
    void this.loadKitInfo();
    for (const d of [...this.designs.active()].sort((a, b) => a.createdAt - b.createdAt)) {
      this.designs.update(d.id, { status: 'queued', step: 'picked up again after a restart' });
      this.scheduler.enqueue(d.id);
    }
    this.groups.start();
    this.bibles.start();
    this.reskins.start();
    // jobs run on the designer's backend: the sim, or Claude through the designer's SDK and auth
    this.jobs.start(jobDriver ?? (designer.name === 'sim' ? new SimJobDriver(this.config.simStepMs, this.config.jobs.simStepUsd) : new ClaudeJobDriver(designer as unknown as ClaudeHost, this.log)));
    this.statusChanged();
    await designer.start();
    this.statusChanged();
    this.scheduler.kick();
  }

  /** `node kit/tools/describe.mjs --palettes` once: the presets and choices for the mod's palette picker. */
  async loadKitInfo(): Promise<void> {
    const script = path.join(this.config.kitDir, 'tools', 'describe.mjs');
    if (!fs.existsSync(script)) return;
    const r = await runNode(script, ['--palettes'], this.config.kitDir, 30_000);
    try {
      const parsed = KitPalettes.safeParse(JSON.parse(r.stdout.trim().split('\n').pop() ?? ''));
      if (parsed.success) {
        const k = parsed.data;
        this.palettes = { presets: Object.fromEntries(k.palettes.map((p) => [p.name, { wood: p.wood, stone: p.stone, roof: p.roof, accent: p.accent }])), ...k.choices };
      }
      else this.log.warn(`kit describe --palettes: unexpected output (${parsed.error.issues[0]?.message ?? '?'})`);
    } catch {
      this.log.warn(`kit describe --palettes failed: ${truncate(r.output, 200)}`);
    }
  }

  async close(): Promise<void> {
    this.pool.stop();
    await this.variantRunner.stop();
    await this.jobs.stop();
    await this.designer?.stop();
    this.store.close();
  }

  // ---- the designer, through the scheduler ------------------------------------------------------

  designerReady(): boolean {
    return !!this.designer?.canRun();
  }

  designerBlocked(): string | undefined {
    return this.designer?.blocked();
  }

  designerName(): 'claude' | 'sim' | undefined {
    return this.designer?.name;
  }

  async runDesign(id: string): Promise<RunOutcome> {
    if (!this.designer) return 'requeue';
    return this.designer.run(id);
  }

  /** Claude must be usable for a new job (auth not missing or failed; `checking` queues it). */
  ensureClaudeAvailable(): void {
    if (!this.designer) throw new ClientError('the designer is not running yet');
    if (this.authView.auth === 'failed' || this.authView.auth === 'missing') throw new ClientError(`Claude is not available: ${this.authView.message ?? `auth ${this.authView.auth}`}`);
  }

  // ---- client messages ------------------------------------------------------------------------

  async handle(msg: ClientMessage, reply: (m: Outbound) => void, client?: ClientHandle): Promise<void> {
    const ack = (ok: boolean, extra: { error?: string; result?: Record<string, unknown> } = {}) => {
      if (msg.id) reply({ type: 'ack', re: msg.id, ok, ...extra });
    };
    try {
      const result = this.dispatch(msg, reply, client);
      ack(true, result ? { result } : {});
    } catch (e) {
      const known = e instanceof ClientError || e instanceof BlobError;
      const message = known ? (e as Error).message : `internal error: ${(e as Error).message}`;
      if (!known) this.log.error(`${msg.type}: ${(e as Error).stack ?? e}`);
      reply({ type: 'error', message, ...(msg.id ? { re: msg.id } : {}) });
      ack(false, { error: message });
    }
  }

  private dispatch(msg: ClientMessage, reply: (m: Outbound) => void, client?: ClientHandle): Record<string, unknown> | undefined {
    switch (msg.type) {
      case 'hello':
        reply(this.snapshot(client?.protocol ?? 1));
        if (client) {
          this.connected.add(client);
          // tool calls that wait for a client of this name (it reconnected, or the sidecar restarted)
          this.jobs.clientReady(client);
        }
        return undefined;
      case 'job.run':
        return { jobId: this.jobs.run(msg.job, client).id };
      case 'job.cancel':
        this.jobs.cancel(msg.jobId);
        return { jobId: msg.jobId };
      case 'job.tool.result':
        this.jobs.toolResult(msg.jobId, msg.callId, msg.result, msg.error);
        return {};
      case 'blob.put': {
        const r = this.blobs.put(msg);
        if (r.complete) this.log.info(`blob ${r.blobId} (${msg.kind ?? this.blobs.get(r.blobId)?.kind ?? '?'}, ${r.size} bytes) stored`);
        return r;
      }
      case 'blob.delete':
        if (!this.blobs.delete(msg.blobId)) throw new ClientError(`no blob "${msg.blobId}"`);
        return { blobId: msg.blobId };
      case 'client.paused':
        if (client) {
          client.paused = msg.paused;
          this.jobs.pausedChanged(client);
        }
        return {};
      case 'design.request':
        return { designId: this.requestDesign(msg.request).id };
      case 'design.cancel':
        this.cancelDesign(msg.designId);
        return { designId: msg.designId };
      case 'auth.set':
        this.setAuthSettings(msg.apiKey, msg.useClaudeLogin);
        return {};
      case 'shutdown':
        this.log.info('shutdown requested by a client');
        setImmediate(() => this.onShutdown?.());
        return {};
      case 'variant.request':
        return { variantId: this.requestVariant(msg.from, msg.palette, msg.values, msg.name, msg.bible).id };
      case 'import.request':
        return { variantId: this.requestImport(msg.path).id };
      // ---- 4b
      case 'design.group': {
        this.ensureClaudeAvailable();
        const g = this.groups.create(msg.group);
        return { groupId: g.id, designIds: g.items.map((it) => it.designId), itemKeys: g.items.map((it) => it.itemKey), bible: g.bible };
      }
      case 'group.cancel':
        return { groupId: this.groups.cancel(msg.groupId).id };
      case 'group.extend': {
        const g = this.groups.extend(msg.groupId, msg.budgetUsd);
        return { groupId: g.id, budgetUsd: g.budgetUsd };
      }
      case 'group.resume':
        return { groupId: this.groups.resume(msg.groupId).id, status: this.groups.get(msg.groupId)?.status };
      case 'design.estimate':
        if (msg.group) this.bibleIndex.resolve(msg.group.bible);
        return { ...(msg.group ? this.estimates.group(msg.group, this.estimateCtx()) : this.estimates.design(msg.request!, this.estimateCtx())) };
      case 'bible.request': {
        const j = this.bibles.request(msg.request);
        return { jobId: j.id, bibleId: j.bibleId, version: j.version };
      }
      case 'bible.revise': {
        const j = this.bibles.revise(msg.id, msg.notes, msg.model, msg.budgetUsd);
        return { jobId: j.id, bibleId: j.bibleId, version: j.version };
      }
      case 'bible.estimate':
        return { ...this.estimates.bible(msg.request ?? {}, this.estimateCtx()) };
      case 'bible.cancel':
        return { jobId: this.bibles.cancel(msg.jobId).id };
      case 'reskin.request': {
        const r = this.reskins.request(msg.bibleId, msg.version, msg.from);
        return { reskinId: r.id, variantIds: r.variants, bible: r.bible };
      }
    }
  }

  estimateCtx(): EstimateCtx {
    const limit = this.store.data.limit;
    return {
      designConcurrency: this.config.designConcurrency,
      ...(limit ? { limitUntil: limit.until } : {}),
      now: this.now(),
      designModel: this.config.claude.designModel,
      landmarkModel: this.config.groups.landmarkModel,
      ordinaryModel: this.config.groups.ordinaryModel,
      bibleModel: this.config.bibleModel,
    };
  }

  /** variant.request: refused at once (ack ok:false) when the entry has no source or the bible is unknown; else queued. */
  requestVariant(from: string, palette?: PaletteSpec, values?: ParamValues, name?: string, bible?: BibleRef, reskin?: string): Variant {
    try {
      findVariantSource(this.config.libraryDir, this.config.kitDir, from);
    } catch (e) {
      if (e instanceof VariantRefused) throw new ClientError(e.message);
      throw e;
    }
    if (bible !== undefined && palette !== undefined) throw new ClientError('a variant takes a palette or a bible (a re-skin), not both');
    const pin = bible !== undefined ? this.bibleIndex.resolve(bible).pin : undefined;
    const v = this.variants.create({ kind: 'variant', from, ...(palette !== undefined ? { palette } : {}), ...(values !== undefined ? { values } : {}), ...(name !== undefined ? { name } : {}), ...(pin ? { bible: pin } : {}), ...(reskin ? { reskin } : {}) });
    this.log.info(`variant ${v.id} of ${from} requested${palette !== undefined ? `: palette ${JSON.stringify(palette)}` : ''}${pin ? `: bible ${pin.id} v${pin.version}` : ''}${values ? `, values ${JSON.stringify(values)}` : ''}`);
    this.variantRunner.enqueue(v.id);
    return v;
  }

  /** import.request: refused at once unless the path is an .nbt in the import folders. */
  requestImport(file: string): Variant {
    try {
      checkImportPath(file, this.config.libraryDir);
    } catch (e) {
      if (e instanceof VariantRefused) throw new ClientError(e.message);
      throw e;
    }
    const v = this.variants.create({ kind: 'import', from: file });
    this.log.info(`import ${v.id} requested: ${file}`);
    this.variantRunner.enqueue(v.id);
    return v;
  }

  /** auth.set: store the settings (0600), never log or echo the key, then re-check auth. */
  setAuthSettings(apiKey: string | null | undefined, useClaudeLogin: boolean | undefined): void {
    if (apiKey === undefined && useClaudeLogin === undefined) throw new ClientError('auth.set needs apiKey and/or useClaudeLogin');
    updateSecrets(this.config.dataDir, { apiKey, useClaudeLogin });
    const what = [apiKey === null ? 'API key cleared' : apiKey !== undefined ? 'API key set' : '', useClaudeLogin !== undefined ? `use claude login: ${useClaudeLogin ? 'on' : 'off'}` : ''].filter(Boolean).join(', ');
    this.log.info(`auth settings changed (${what})`);
    this.designer?.authChanged();
    this.statusChanged();
  }

  requestDesign(request: DesignRequest): Design {
    this.ensureClaudeAvailable();
    if (request.group || request.itemKey) throw new ClientError('group, itemKey, wave and role are set by design.group, not by design.request');
    // (auth `checking`, also while the SDK is still being installed: the design queues and starts
    // once the check passes)
    let req = request;
    if (req.bible) {
      const pin = this.bibleIndex.resolve(req.bibleVersion ? { id: req.bible, version: req.bibleVersion } : req.bible).pin;
      req = { ...req, bible: pin.id, bibleVersion: pin.version };
    }
    const d = this.designs.create(req);
    const ahead = this.designs.active().filter((x) => x.id !== d.id).length;
    this.log.info(`design ${d.id} requested: ${describeRequest(req)}${ahead ? ` (${ahead} ahead in the queue)` : ''}`);
    this.scheduler.enqueue(d.id);
    return d;
  }

  cancelDesign(id: string): Design {
    const d = this.designs.get(id);
    if (!d) throw new ClientError(`no design "${id}"`);
    if (isFinalDesign(d)) throw new ClientError(`design ${id} is already ${d.status}`);
    this.stopDesign(id, 'cancelled', undefined, 'cancelled');
    this.log.info(`design ${id} cancelled`);
    return d;
  }

  /**
   * End a design that has not finished: `cancelled`, or `budget` (its group's hard cap: a queued one is cancelled with
   * error "budget", a running one fails with it). Withdraws it from the pool and stops its turn.
   */
  stopDesign(id: string, kind: 'cancelled' | 'budget', error: string | undefined, step: string): void {
    const d = this.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    const running = this.pool.isRunning(designKey(id));
    if (kind === 'budget' && running) this.designFailed(id, 'budget', step);
    else this.designs.update(id, { status: 'cancelled', step, ...(kind === 'budget' ? { error: 'budget' } : error ? { error } : {}) });
    this.scheduler.withdraw(id);
    if (running) {
      try {
        this.designer?.cancel(id);
      } catch (e) {
        this.log.error(`designer.cancel: ${(e as Error).message}`);
      }
    }
  }

  // ---- what a design job gets (4b): budget, bible, neighbours, entry fields --------------------

  /** What a design may spend: its own budgetUsd, capped by what is left of its group's. */
  designBudget(id: string): number | undefined {
    const d = this.designs.get(id);
    if (!d) return undefined;
    const caps = [d.request.budgetUsd, this.groups.budgetFor(d)].filter((n): n is number => typeof n === 'number');
    return caps.length ? Math.min(...caps) : undefined;
  }

  /** The bible a design builds with (resolved), if any. */
  private designBible(d: Design) {
    if (!d.request.bible) return undefined;
    try {
      return this.bibleIndex.resolve({ id: d.request.bible, version: d.request.bibleVersion ?? 1 });
    } catch (e) {
      this.log.warn(`design ${d.id}: its bible ${d.request.bible} v${d.request.bibleVersion} is gone (${(e as Error).message})`);
      return undefined;
    }
  }

  /** prepareScratch's extras: the bible's files and up to 4 iso renders of finished earlier-wave siblings. */
  scratchExtras(d: Design): { bible?: { files: import('./bibles.js').BibleFiles; info: import('./protocol.js').BibleInfo; pin: import('./protocol.js').BiblePin }; neighbours?: Array<{ entryId: string; name?: string; type: string; png: string }> } {
    const b = this.designBible(d);
    const neighbours = this.groups
      .earlierFinished(d)
      .map((it) => ({ entryId: it.entryId!, ...(it.name ? { name: it.name } : {}), type: it.type, png: path.join(this.config.libraryDir, it.entryId!, `${it.entryId}.preview-iso.png`) }))
      .filter((n) => fs.existsSync(n.png))
      .slice(0, 4);
    return { ...(b ? { bible: { files: b.files, info: b.info, pin: b.pin } } : {}), ...(neighbours.length ? { neighbours } : {}) };
  }

  /** Before the pristine check: the bible files again from their source (Bash in the scratch dir could change them). */
  syncScratchBible(scratch: string, d: Design): void {
    const b = this.designBible(d);
    if (b) this.bibleIndex.copyInto(b.files, scratch);
  }

  /** Files an installed entry keeps: the bible files its source imports (bible/bible.json, bible/components.mjs). */
  entryFiles(d: Design, scratch: string): Array<{ from: string; to: string }> {
    if (!d.request.bible) return [];
    return ['bible.json', 'bible.md', 'components.mjs'].map((f) => ({ from: path.join(scratch, 'bible', f), to: path.join('bible', f) }));
  }

  /** The entry's extra sidecar fields: ext, the bible pin and the group (collections, R10), the item key. */
  entryExtra(d: Design): Record<string, unknown> {
    const r = d.request;
    return {
      ...(r.ext && Object.keys(r.ext).length ? { ext: r.ext } : {}),
      ...(r.bible ? { bible: { id: r.bible, version: r.bibleVersion ?? 1 } } : {}),
      ...(r.group ? { group: r.group } : {}),
      ...(r.itemKey ? { groupItem: r.itemKey } : {}),
      ...(r.profile ? { profile: r.profile } : {}),
    };
  }

  // ---- what designers report ------------------------------------------------------------------

  /** A design job's progress (status + one line). Ignored once the design is final. */
  designStep(id: string, status: 'queued' | 'designing' | 'checking' | 'rendering', step: string): void {
    const before = this.designs.get(id);
    const first = before?.status === 'queued' && status === 'designing';
    this.designs.update(id, { status, step });
    if (first && before) this.log.info(`design ${id} started: ${describeRequest(before.request)}`);
  }

  designDone(id: string, installed: Installed, size: { x: number; y: number; z: number }, note = ''): void {
    const d = this.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    this.designs.update(id, {
      status: 'done',
      step: `done: ${installed.blueprintId} (${size.x}x${size.y}x${size.z}), ${installed.previews.length} preview${installed.previews.length === 1 ? '' : 's'}${note ? `; ${note}` : ''}`,
      blueprintId: installed.blueprintId,
      size,
      previews: installed.previews,
    });
    // the rolling averages behind the estimates (real Claude designs only)
    const started = this.estimates.startedAt(id);
    if (this.designer?.name === 'claude' && started !== undefined) this.estimates.record('design', d.request.model ?? this.config.claude.designModel, d.cost?.usd ?? 0, this.now() - started);
    this.estimates.forget(id);
    this.log.info(`design ${id} is ready: ${installed.blueprintId} (${size.x}x${size.y}x${size.z}) in ${path.dirname(installed.json)}`);
  }

  designFailed(id: string, error: string, step?: string): void {
    const d = this.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    this.designs.update(id, { status: 'failed', step: step ?? `failed: ${error.split('\n')[0]}`, error });
    this.estimates.forget(id);
    this.log.warn(`design ${id} failed: ${truncate(step ?? error.split('\n')[0] ?? error, 200)}`);
  }

  /** (protocol 2) a design's cost so far */
  designCost(id: string, cost: Cost): void {
    this.designs.update(id, { cost });
  }
}
