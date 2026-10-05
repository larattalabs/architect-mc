// The sidecar core (the design part of AgentCraft's Foreman, foreman/src/foreman.ts): the design
// book, the status, the client messages, and the hooks a designer (claude or sim) reports through.
import path from 'node:path';
import type { Config } from './config.js';
import { VERSION } from './config.js';
import type { Logger } from './context.js';
import { DesignBook, describeRequest, isFinalDesign, type Installed } from './designs.js';
import type { ClientMessage, Design, DesignRequest, Outbound, Status } from './protocol.js';
import { readSecrets, updateSecrets, type Secrets } from './secrets.js';
import type { Store } from './store.js';
import { truncate } from './util/text.js';

/** A message the client caused that cannot be done (answered with ack ok:false). */
export class ClientError extends Error {}

/** Runs design jobs: the Claude designer (claude/designer.ts) or the sim (sim.ts). */
export interface Designer {
  readonly name: 'claude' | 'sim';
  /** check auth / the SDK, then pick up queued designs */
  start(): Promise<void>;
  /** a queued design (new, or picked up again after a restart): run it when its turn comes */
  request(d: Design): void;
  /** the design is already marked cancelled: stop its turn, or drop it from the queue */
  cancel(id: string): void;
  /** the running design's id */
  runningId(): string | undefined;
  /** credentials or the login opt-in changed (auth.set) */
  authChanged(): void;
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
    // a design changing state changes the queue counts
    if (m.type === 'design.upsert') this.statusChanged();
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
  }

  status(): Status {
    const running = this.designer?.runningId();
    const limit = this.store.data.limit;
    const a = this.authView;
    return {
      auth: a.auth,
      ...(a.authSource ? { authSource: a.authSource } : {}),
      useClaudeLogin: this.useClaudeLogin,
      sdk: a.sdk,
      ...(running ? { designing: running } : {}),
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

  snapshot(): Outbound {
    return { type: 'snapshot', version: VERSION, status: this.status(), designs: this.designs.recent() };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /**
   * Hand the designer the designs that were queued or running when the sidecar stopped, then start
   * it (the Claude designer checks auth first; queued designs wait for that).
   */
  async start(designer: Designer): Promise<void> {
    this.designer = designer;
    for (const d of this.designs.active()) {
      this.designs.update(d.id, { status: 'queued', step: 'picked up again after a restart' });
      designer.request(d);
    }
    this.statusChanged();
    await designer.start();
    this.statusChanged();
  }

  async close(): Promise<void> {
    await this.designer?.stop();
    this.store.close();
  }

  // ---- client messages ------------------------------------------------------------------------

  async handle(msg: ClientMessage, reply: (m: Outbound) => void): Promise<void> {
    const ack = (ok: boolean, extra: { error?: string; result?: Record<string, unknown> } = {}) => {
      if (msg.id) reply({ type: 'ack', re: msg.id, ok, ...extra });
    };
    try {
      const result = this.dispatch(msg, reply);
      ack(true, result ? { result } : {});
    } catch (e) {
      const known = e instanceof ClientError;
      const message = known ? (e as Error).message : `internal error: ${(e as Error).message}`;
      if (!known) this.log.error(`${msg.type}: ${(e as Error).stack ?? e}`);
      reply({ type: 'error', message, ...(msg.id ? { re: msg.id } : {}) });
      ack(false, { error: message });
    }
  }

  private dispatch(msg: ClientMessage, reply: (m: Outbound) => void): Record<string, unknown> | undefined {
    switch (msg.type) {
      case 'hello':
        reply(this.snapshot());
        return undefined;
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
    }
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
    if (!this.designer) throw new ClientError('the designer is not running yet');
    if (this.authView.auth === 'failed' || this.authView.auth === 'missing') throw new ClientError(`Claude is not available: ${this.authView.message ?? `auth ${this.authView.auth}`}`);
    // (auth `checking`, also while the SDK is still being installed: the design queues and starts
    // once the check passes)
    const d = this.designs.create(request);
    const ahead = this.designs.active().filter((x) => x.id !== d.id).length;
    this.log.info(`design ${d.id} requested: ${describeRequest(request)}${ahead ? ` (${ahead} ahead in the queue)` : ''}`);
    this.designer.request(d);
    return d;
  }

  cancelDesign(id: string): Design {
    const d = this.designs.get(id);
    if (!d) throw new ClientError(`no design "${id}"`);
    if (isFinalDesign(d)) throw new ClientError(`design ${id} is already ${d.status}`);
    this.designs.update(id, { status: 'cancelled', step: 'cancelled' });
    this.log.info(`design ${id} cancelled`);
    try {
      this.designer?.cancel(id);
    } catch (e) {
      this.log.error(`designer.cancel: ${(e as Error).message}`);
    }
    return d;
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
    this.log.info(`design ${id} is ready: ${installed.blueprintId} (${size.x}x${size.y}x${size.z}) in ${path.dirname(installed.json)}`);
  }

  designFailed(id: string, error: string): void {
    const d = this.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    this.designs.update(id, { status: 'failed', step: `failed: ${error.split('\n')[0]}`, error });
    this.log.warn(`design ${id} failed: ${truncate(error.split('\n')[0] ?? error, 200)}`);
  }
}
