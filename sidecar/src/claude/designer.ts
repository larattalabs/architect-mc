// The Claude designer: building design jobs with the Claude Agent SDK. A standalone extraction of
// AgentCraft's design job (agents/claude/design.ts DesignJobs + the aux turn runner in
// jobs/designTurns.ts, sessions.ts, holds.ts and the auth probe), without the agent roster.
//
// One job at a time, queued in request order. A job:
//   1. prepares <data>/designs/<id>/ (scratch.ts): a fresh copy of the kit, BRIEF.md, CONTRACT.md,
//      the remix source if any
//   2. runs a design agent turn there (claude_code preset, cwd = the scratch dir, AgentCraft's
//      worker policy but no prompts: whatever the policy would ask about is refused; no network,
//      no subagents, no git; edits only to kit/designs/<id>.mjs; a `design_status` tool)
//   3. re-checks the result itself with a PRISTINE kit in a child process with a minimal env
//      (build.mjs + checker, --max and --type from the request); a failed check goes back to the
//      agent (same session), up to MAX_DESIGN_ROUNDS turns in all
//   4. renders previews and installs the design into the library under a fresh id (never
//      overwriting), then reports done
// A usage limit puts the job back at the front of the queue (it resumes the same session once the
// limit resets); a sidecar shutdown leaves it unfinished and it is picked up on the next start,
// resuming its session.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { CanUseTool, McpServerConfig, Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { VERSION } from '../config.js';
import { checkDesign, designBaseId, freeLibraryId, installDesign, isFinalDesign, KIT, renderPreviews } from '../designs.js';
import { classifyToolUse, describeToolCall, foremanPrivateVerdict, GIT_REDIRECT_VARS, type PolicyContext } from '../policy.js';
import type { Design } from '../protocol.js';
import { prepareScratch } from '../scratch.js';
import type { Designer, Sidecar } from '../sidecar.js';
import type { DesignWork } from '../store.js';
import { scrubEnv, withPathFirst } from '../util/env.js';
import { descendantsOf, killSnapshot, killTree, orphansOf, processTable, type ProcEntry } from '../util/proc.js';
import { truncate } from '../util/text.js';
import { ARCHITECT_NO_API_AUTH_MESSAGE, authEnv, authSourceOf } from './auth.js';
import { designFixPrompt, designPrompt, designStepFor, designSystemPrompt, MAX_DESIGN_ROUNDS, RESTART_PROMPT } from './brief.js';
import { isAuthText, probeFailure } from './failures.js';
import { connectorHook, denyHook, designVerdict } from './permissions.js';
import { loadSdk, loadZod, type Sdk } from './sdk.js';
import { limitFromText, StreamMapper, type RateLimitReport, type TurnStats } from './stream.js';

export const MCP_SERVER = 'architect';
const DESIGN_TURN_TIMEOUT_MS = 30 * 60_000;
/** wait after a usage limit that did not say when it resets (doubles per hit, up to the max) */
const LIMIT_BACKOFF_MS = 5 * 60_000;
const LIMIT_BACKOFF_MAX_MS = 60 * 60_000;
/** auth probe retry after a network-type failure (doubles, up to the max) */
const AUTH_RETRY_MS = 30_000;
const AUTH_RETRY_MAX_MS = 10 * 60_000;
/** while the SDK is missing: look for it again this often */
const SDK_RETRY_MS = 30_000;

export type AbortReason = 'stop' | 'shutdown' | 'cancel' | 'timeout';
type QueryFn = Sdk['query'];

export interface ClaudeDesignerOptions {
  /** injectable for tests */
  queryFn?: QueryFn;
  /** skip the auth probe (tests) */
  skipAuthCheck?: boolean;
  /** first auth-probe retry delay after a network failure (tests) */
  authRetryMs?: number;
}

interface Running {
  abort: AbortController;
  reason?: AbortReason;
  child?: ChildProcess;
  spawnedAt?: number;
  tree?: Promise<ProcEntry[] | undefined>;
  reaping?: Promise<void>;
}

interface Current {
  id: string;
  turn?: Running;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (c: ChildProcess | undefined): c is ChildProcess => !!c && c.exitCode === null && c.signalCode === null;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export class ClaudeDesigner implements Designer {
  readonly name = 'claude' as const;
  private queue: string[] = [];
  private current: Current | undefined;
  private stopping = false;
  private sdk: Sdk | undefined;
  /** sticky until auth.set: the key / login is not valid */
  private authFailed = false;
  private authOk = false;
  /** the auth probe could not reach Claude: retried with backoff */
  private offline: { delayMs: number } | undefined;
  private authTimer: NodeJS.Timeout | undefined;
  private sdkTimer: NodeJS.Timeout | undefined;
  private limitTimer: NodeJS.Timeout | undefined;
  private limitBackoffMs = LIMIT_BACKOFF_MS;
  /** bumps on every auth (re)check, so an older probe's answer is dropped */
  private authGen = 0;
  private lastCost = new Map<string, number>();

  constructor(
    private sc: Sidecar,
    private opts: ClaudeDesignerOptions = {},
  ) {}

  private get cfg() {
    return this.sc.config.claude;
  }

  private get work(): Record<string, DesignWork> {
    return (this.sc.store.data.work ??= {});
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.checkAuth();
    this.armLimitTimer();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of [this.authTimer, this.sdkTimer, this.limitTimer]) if (t) clearTimeout(t);
    const cur = this.current;
    if (!cur) return;
    if (cur.turn) this.abortTurn(cur.turn, 'shutdown');
    await cur.done.catch(() => undefined);
  }

  runningId(): string | undefined {
    return this.current?.id;
  }

  request(d: Design): void {
    if (this.queue.includes(d.id) || this.current?.id === d.id) return;
    this.queue.push(d.id);
    this.kick();
  }

  cancel(id: string): void {
    this.queue = this.queue.filter((x) => x !== id);
    if (this.current?.id === id && this.current.turn) this.abortTurn(this.current.turn, 'cancel');
  }

  authChanged(): void {
    this.authFailed = false;
    this.offline = undefined;
    void this.checkAuth().then(() => this.kick());
  }

  // ---- auth -----------------------------------------------------------------------------------

  private authInputs() {
    return { useClaudeLogin: this.sc.useClaudeLogin, storedKey: this.sc.secrets().apiKey };
  }

  /** Resolve the SDK, then check the credentials with a live `accountInfo()` (the AgentCraft probe). */
  async checkAuth(): Promise<boolean> {
    const gen = ++this.authGen;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.authOk = false;
    this.sdk = await loadSdk();
    if (gen !== this.authGen) return false;
    const sdkState = this.sdk ? 'ready' : 'missing';
    const a = this.authInputs();
    const src = authSourceOf(process.env, a);
    if (!src.ok) {
      this.sc.setAuth({ auth: 'missing', sdk: sdkState, message: ARCHITECT_NO_API_AUTH_MESSAGE });
      return false;
    }
    if (!this.sdk && !this.opts.queryFn) {
      // the launcher may still be installing it: look again later
      this.sc.setAuth({ auth: 'checking', authSource: src.source!, sdk: 'missing', message: 'Waiting for the Claude Agent SDK (the launcher installs it with npm ci).' });
      if (this.sdkTimer) clearTimeout(this.sdkTimer);
      this.sdkTimer = setTimeout(() => {
        this.sdkTimer = undefined;
        if (!this.stopping) void this.checkAuth().then((ok) => ok && this.kick());
      }, SDK_RETRY_MS);
      this.sdkTimer.unref?.();
      return false;
    }
    if (this.opts.skipAuthCheck) {
      this.authOk = true;
      this.sc.setAuth({ auth: 'ok', authSource: src.source!, sdk: sdkState });
      return true;
    }
    this.sc.setAuth({ auth: 'checking', authSource: src.source!, sdk: sdkState, message: a.useClaudeLogin ? 'Checking your Claude login...' : 'Checking Claude API access...' });
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const queryFn = this.queryFn();
    let q: Query | undefined;
    try {
      q = queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: this.env(this.sc.config.dataDir), spawnClaudeCodeProcess: this.spawner(undefined, 'auth') } });
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timed out after 45s')), 45_000).unref?.())]);
      if (gen !== this.authGen) return false;
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      const account = a.useClaudeLogin ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') : info.organization ?? '';
      this.authFailed = false;
      this.authOk = true;
      this.offline = undefined;
      this.sc.setAuth({ auth: 'ok', authSource: src.source!, sdk: 'ready', ...(account ? { message: account } : {}) });
      this.sc.log.info(`claude auth ok (${src.source}${account ? `, ${account}` : ''})`);
      return true;
    } catch (e) {
      if (gen !== this.authGen) return false;
      const why = (e as Error).message ?? String(e);
      if (probeFailure(why) === 'retry') {
        this.goOffline(why, src.source!);
        return false;
      }
      this.markAuthFailed(
        a.useClaudeLogin
          ? `Claude login check failed: ${truncate(why, 200)}. Run \`claude\` and /login, then try again.`
          : `Claude API check failed: ${truncate(why, 200)}. Check the API key (or your cloud provider settings).`,
        src.source,
      );
      return false;
    } finally {
      try {
        q?.close();
      } catch {
        /* ignore */
      }
    }
  }

  private markAuthFailed(message: string, source?: string): void {
    this.authFailed = true;
    this.authOk = false;
    this.offline = undefined;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.sc.setAuth({ auth: 'failed', ...(source ? { authSource: source } : {}), sdk: this.sdk || this.opts.queryFn ? 'ready' : 'missing', message });
    this.sc.log.error(message);
  }

  /** The probe could not reach Claude: hold new turns and probe again later (backoff). */
  private goOffline(why: string, source: string): void {
    const delayMs = this.offline ? Math.min(AUTH_RETRY_MAX_MS, this.offline.delayMs * 2) : (this.opts.authRetryMs ?? AUTH_RETRY_MS);
    this.offline = { delayMs };
    const message = `Claude could not be reached (${truncate(why, 120)}); trying again at ${clock(Date.now() + delayMs)}.`;
    this.sc.setAuth({ auth: 'checking', authSource: source, sdk: 'ready', message });
    this.sc.log.warn(message);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      this.authTimer = undefined;
      if (!this.stopping) void this.checkAuth().then((ok) => ok && this.kick());
    }, delayMs);
    this.authTimer.unref?.();
  }

  private queryFn(): QueryFn {
    const q = this.opts.queryFn ?? this.sdk?.query;
    if (!q) throw new Error('the Claude Agent SDK is not installed');
    return q;
  }

  // ---- usage limits ---------------------------------------------------------------------------

  private limited(now = Date.now()): boolean {
    const l = this.sc.store.data.limit;
    return !!l && now < l.until;
  }

  private setLimit(resetsAt: number | undefined, type: string | undefined): void {
    const until = resetsAt ?? Date.now() + this.limitBackoffMs;
    if (!resetsAt) this.limitBackoffMs = Math.min(LIMIT_BACKOFF_MAX_MS, this.limitBackoffMs * 2);
    const prev = this.sc.store.data.limit;
    if (prev && prev.until >= until) return;
    this.sc.store.data.limit = { until, ...(type ? { type } : {}) };
    this.sc.store.markDirty();
    this.sc.log.warn(`usage limit reached${type ? ` (${type.replace(/_/g, ' ')})` : ''}: designs wait until ${clock(until)}`);
    this.armLimitTimer();
    this.sc.statusChanged();
  }

  private onRateLimit(r: RateLimitReport): void {
    if (r.status === 'rejected') this.setLimit(r.resetsAt, r.type);
  }

  /** Wake up when the limit ends: queued designs start again. */
  private armLimitTimer(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    const l = this.sc.store.data.limit;
    if (!l) return;
    const left = l.until - Date.now();
    if (left <= 0) {
      delete this.sc.store.data.limit;
      this.sc.store.markDirty();
      this.sc.statusChanged();
      this.kick();
      return;
    }
    this.limitTimer = setTimeout(() => this.armLimitTimer(), Math.min(left + 1000, 2 ** 31 - 1));
    this.limitTimer.unref?.();
  }

  // ---- the queue ------------------------------------------------------------------------------

  private canStart(): boolean {
    return !this.stopping && this.authOk && !this.authFailed && !this.limited();
  }

  /** Start the next queued job if nothing runs and turns may start. */
  kick(): void {
    if (this.current || this.stopping || !this.queue.length) return;
    if (this.authFailed) {
      // nothing can run until auth.set: fail what waits, so the player sees why
      for (const id of this.queue.splice(0)) this.sc.designFailed(id, `Claude is not available: ${this.sc.status().message ?? 'authentication failed'}`);
      return;
    }
    if (!this.canStart()) return;
    const id = this.queue.shift()!;
    const cur: Current = { id, done: Promise.resolve() };
    this.current = cur;
    this.sc.statusChanged();
    cur.done = this.run(cur)
      .catch((e) => {
        this.sc.log.error(`design ${id}: ${(e as Error).stack ?? e}`);
        this.sc.designFailed(id, (e as Error).message);
      })
      .finally(() => {
        if (this.current === cur) this.current = undefined;
        this.sc.statusChanged();
        if (!this.stopping) this.kick();
      });
  }

  private takenIds(except: string): Set<string> {
    return new Set(Object.entries(this.work).filter(([k]) => k !== except).map(([, w]) => w.bp));
  }

  private cancelled(id: string): boolean {
    const d = this.sc.designs.get(id);
    return !d || d.status === 'cancelled';
  }

  private async designMcp(id: string): Promise<McpServerConfig> {
    const sdk = this.sdk ?? (await loadSdk());
    if (!sdk) throw new Error('the Claude Agent SDK is not installed');
    const { z } = await loadZod();
    // the sidecar's own server: mcpGate lets exactly this one through
    return sdk.createSdkMcpServer({
      name: MCP_SERVER,
      version: VERSION,
      tools: [
        sdk.tool('design_status', 'Report one short line of progress on the design (shown to the player in the Designs tab).', { step: z.string().min(1).max(200) }, async ({ step }) => {
          this.sc.designStep(id, 'designing', step);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        }),
      ],
    });
  }

  private async run(cur: Current): Promise<void> {
    const sc = this.sc;
    const cfg = sc.config;
    const id = cur.id;
    const d = sc.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    const req = d.request;
    const w = (this.work[id] ??= { bp: freeLibraryId(cfg.libraryDir, designBaseId(req), this.takenIds(id)), round: 0 });
    sc.store.markDirty();
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp: w.bp });
    const sessionKey = `design:${id}`;
    for (;;) {
      if (this.cancelled(id)) return;
      const resume = sc.store.data.sessions[sessionKey]?.sessionId;
      const prompt = w.pending ?? (resume ? RESTART_PROMPT : designPrompt(w.bp));
      w.round++;
      sc.store.markDirty();
      sc.designStep(id, 'designing', w.round === 1 ? 'the designer is reading the brief' : `revising the design (round ${w.round} of ${MAX_DESIGN_ROUNDS})`);
      const turn: Running = { abort: new AbortController() };
      cur.turn = turn;
      const { stats, reason } = await this.runTurn(turn, {
        id,
        bp: w.bp,
        sessionKey,
        cwd: scratch,
        prompt,
        mcp: await this.designMcp(id),
        ...(resume ? { resume } : {}),
        onMessage: (msg) => {
          const step = designStepFor(msg, w.bp);
          if (step) sc.designStep(id, 'designing', step);
        },
      });
      cur.turn = undefined;
      if (reason === 'cancel' || this.cancelled(id)) return;
      if (reason === 'shutdown' || this.stopping) {
        // picked up again on the next start (resuming this session)
        w.round--;
        sc.store.markDirty();
        return;
      }
      if (stats.limited) {
        w.round--;
        sc.store.markDirty();
        if (!this.limited()) this.setLimit(stats.rateLimit?.resetsAt, stats.rateLimit?.type);
        const until = sc.store.data.limit?.until;
        sc.designStep(id, 'queued', `usage limit - resumes ${until ? clock(until) : 'later'}`);
        this.queue.unshift(id);
        return;
      }
      if (stats.authFailed) {
        sc.designFailed(id, `Claude authentication failed (${stats.authFailed})`);
        return;
      }
      delete w.pending;
      sc.designStep(id, 'checking', `checking the design (round ${w.round})`);
      const res = await checkDesign(cfg.kitDir, scratch, w.bp, { maxSize: req.maxSize, type: req.type });
      if (this.cancelled(id)) return;
      if (!res.ok) {
        const problem = res.problem ?? 'the check failed';
        if (w.round < MAX_DESIGN_ROUNDS) {
          w.pending = designFixPrompt(w.bp, problem, w.round + 1);
          sc.store.markDirty();
          sc.designStep(id, 'designing', `check failed: ${truncate(problem.split('\n')[0] ?? problem, 80)}`);
          continue;
        }
        const ended = stats.isError ? ` (the designer's last turn ended: ${stats.subtype ?? stats.errors[0] ?? 'error'})` : '';
        sc.designFailed(id, `${problem}${ended}`);
        return;
      }
      sc.designStep(id, 'rendering', 'rendering previews');
      const r = await renderPreviews(scratch, res.nbt!);
      if (this.cancelled(id)) return;
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: designBaseId(req),
        taken: this.takenIds(id),
        nbt: res.nbt!,
        sidecar: res.sidecar!,
        source: path.join(scratch, KIT, 'designs', `${w.bp}.mjs`),
        previews: r.files,
        meta: { name: req.name, request: req, createdAt: sc.now() },
      });
      const s = res.sidecar!.size!;
      const notes = [r.skipped ? 'no renderer' : r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; ');
      sc.designDone(id, installed, { x: s.x, y: s.y, z: s.z }, notes);
      return;
    }
  }

  // ---- one SDK turn ---------------------------------------------------------------------------

  /**
   * The environment of the design agent's CLI (and every command it runs): this node first on
   * PATH, git kept inside the scratch dir and never prompting, the auth mode's variables only, and
   * the client token variable scrubbed.
   */
  env(cwd: string): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = withPathFirst({ ...process.env }, path.dirname(process.execPath));
    for (const k of Object.keys(base)) if (GIT_REDIRECT_VARS.includes(k.toUpperCase())) delete base[k];
    Object.assign(base, {
      CLAUDE_AGENT_SDK_CLIENT_APP: `architect-sidecar/${VERSION}`,
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)),
      GIT_TERMINAL_PROMPT: '0',
    });
    return scrubEnv(authEnv(base, this.authInputs()));
  }

  private policyContext(cwd: string): PolicyContext {
    const e = this.sc.endpoint;
    return {
      role: 'worker',
      cwd,
      readDirs: [],
      tempDirs: [],
      mcpServer: MCP_SERVER,
      foreman: { home: this.sc.config.dataDir, ...(e ? { port: e.port, tokenFile: e.tokenFile } : {}) },
    };
  }

  /**
   * The design turn's tool calls: AgentCraft's worker policy in `cwd`, but nobody can answer a
   * permission prompt, so whatever the policy would ask about is refused with a reason the agent
   * can work with.
   */
  canUseTool(cwd: string, bp: string, turn: Running): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      if (turn.abort.signal.aborted) return { behavior: 'deny', message: 'The job was stopped.', interrupt: true };
      const own = designVerdict(toolName, input, { cwd, bp });
      if (own) {
        this.sc.log.info(`designer blocked: ${describeToolCall(toolName, input)} (${truncate(own.reason, 160)})`);
        return { behavior: 'deny', message: own.reason };
      }
      const v = classifyToolUse(toolName, input, this.policyContext(cwd));
      if (v.action === 'allow') return { behavior: 'allow', updatedInput: input };
      this.sc.log.info(`designer blocked: ${truncate(describeToolCall(toolName, input), 200)} (${truncate(v.reason, 160)})`);
      return {
        behavior: 'deny',
        message: v.action === 'deny' ? v.reason : `Not allowed in a design job (${v.reason}). Nobody can approve permission prompts here: work only inside ${cwd} with the kit and node, without network access or installs.`,
      };
    };
  }

  /** The SDK options of a design turn (exported for tests through runTurn's queryFn). */
  turnOptions(turn: Running, spec: { bp: string; cwd: string; mcp: McpServerConfig; resume?: string }): Options {
    const cwd = spec.cwd;
    const report = (tool: string, why: string) => this.sc.log.info(`designer blocked: ${tool} (${truncate(why, 160)})`);
    return {
      cwd,
      model: this.cfg.designModel,
      effort: this.cfg.effort,
      maxTurns: this.cfg.maxTurns,
      settingSources: [],
      // never auto mode: every call the CLI does not allow by itself reaches canUseTool
      permissionMode: 'default',
      canUseTool: this.canUseTool(cwd, spec.bp, turn),
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      disallowedTools: ['Agent', 'Task', 'WebFetch', 'WebSearch', 'Skill', 'NotebookEdit', 'Bash(git:*)'],
      strictMcpConfig: true,
      mcpServers: { [MCP_SERVER]: spec.mcp },
      hooks: {
        PreToolUse: [
          { hooks: [denyHook((tool, input) => foremanPrivateVerdict(tool, input, this.policyContext(cwd)), report)] },
          { hooks: [connectorHook([MCP_SERVER], (tool, server) => report(tool, `MCP server "${server}" is not available`))] },
          { hooks: [denyHook((tool, input) => designVerdict(tool, input, { cwd, bp: spec.bp }), report)] },
        ],
      },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: designSystemPrompt() },
      abortController: turn.abort,
      env: this.env(cwd),
      spawnClaudeCodeProcess: this.spawner(turn, 'designer'),
      ...(spec.resume ? { resume: spec.resume } : {}),
      ...(this.cfg.maxBudgetUsd ? { maxBudgetUsd: this.cfg.maxBudgetUsd } : {}),
    };
  }

  private async runTurn(
    turn: Running,
    spec: { id: string; bp: string; sessionKey: string; cwd: string; prompt: string; mcp: McpServerConfig; resume?: string; onMessage?(msg: SDKMessage): void },
  ): Promise<{ stats: TurnStats; reason?: AbortReason }> {
    const label = `designer ${spec.id}`;
    const mapper = new StreamMapper(this.sc.log, label, (r) => this.onRateLimit(r));
    this.sc.log.info(`${label}: ${spec.resume ? 'resuming' : 'starting'} (${this.cfg.designModel}, effort ${this.cfg.effort})`);
    let stats: TurnStats;
    const timer = setTimeout(() => this.abortTurn(turn, 'timeout'), DESIGN_TURN_TIMEOUT_MS);
    timer.unref?.();
    try {
      const q = this.queryFn()({ prompt: spec.prompt, options: this.turnOptions(turn, spec) });
      const closeQuery = () => {
        try {
          q.close();
        } catch {
          /* already closed */
        }
      };
      if (turn.abort.signal.aborted) closeQuery();
      else turn.abort.signal.addEventListener('abort', closeQuery, { once: true });
      for await (const msg of q) {
        if (turn.abort.signal.aborted) break;
        mapper.handle(msg);
        try {
          spec.onMessage?.(msg);
        } catch (e) {
          this.sc.log.warn(`${label}: ${(e as Error).message}`);
        }
        if (mapper.stats.sessionId && this.sc.store.data.sessions[spec.sessionKey]?.sessionId !== mapper.stats.sessionId) this.recordSession(spec.sessionKey, mapper.stats.sessionId);
      }
      stats = mapper.stats;
      if (stats.sessionId) this.recordSession(spec.sessionKey, stats.sessionId, stats);
      if (stats.authFailed) this.markAuthFailed(`Claude authentication failed (${stats.authFailed}).`);
    } catch (e) {
      stats = { ...mapper.stats };
      if (!turn.abort.signal.aborted) {
        const msg = (e as Error).message ?? String(e);
        this.sc.log.error(`${label} failed: ${truncate(msg, 400)}`);
        if (isAuthText(msg)) {
          stats.authFailed = truncate(msg, 160);
          this.markAuthFailed(`Claude authentication failed: ${truncate(msg, 160)}`);
        }
        stats.isError = true;
        stats.errors = [...stats.errors, msg];
        const l = limitFromText(msg);
        if (l.limited) {
          stats.limited = true;
          if (l.resetsAt) stats.rateLimit = { status: 'rejected', resetsAt: l.resetsAt };
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (turn.reason) void this.reap(turn);
    else if (!stats.isError) this.limitBackoffMs = LIMIT_BACKOFF_MS;
    return { stats, ...(turn.reason ? { reason: turn.reason } : {}) };
  }

  private recordSession(key: string, sessionId: string, stats?: TurnStats): void {
    const s = (this.sc.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    s.model = this.cfg.designModel;
    s.updatedAt = Date.now();
    if (stats) {
      s.turns += stats.numTurns ?? 0;
      s.lastResult = stats.subtype;
      if (typeof stats.costUsd === 'number') {
        // total_cost_usd is cumulative per session (a resume continues from the saved total)
        const prev = this.lastCost.get(sessionId) ?? s.costUsd;
        const delta = Math.max(0, stats.costUsd - prev);
        this.lastCost.set(sessionId, stats.costUsd);
        s.costUsd = Math.max(s.costUsd, stats.costUsd);
        this.sc.store.data.costUsd = Math.round(((this.sc.store.data.costUsd ?? 0) + delta) * 1000) / 1000;
      }
    }
    this.sc.store.markDirty();
  }

  // ---- the CLI process ------------------------------------------------------------------------

  /**
   * The CLI is spawned by us (same as the SDK's local spawn) so its pid is known: an aborted turn's
   * whole process tree can be ended. A bare `node` command becomes this node (minimal PATH).
   */
  private spawner(entry: Running | undefined, label: string): NonNullable<Options['spawnClaudeCodeProcess']> {
    return (o) => {
      const command = o.command === 'node' ? process.execPath : o.command;
      const child = spawn(command, o.args, { cwd: o.cwd, env: scrubEnv(o.env as NodeJS.ProcessEnv), stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (s: string) => this.sc.log.debug(`[${label} stderr] ${s.trim().slice(0, 300)}`));
      child.on('error', (e) => this.sc.log.debug(`[${label}] CLI process error: ${e.message}`));
      if (entry) {
        entry.child = child;
        entry.spawnedAt = Date.now();
      }
      return child;
    };
  }

  /** Abort a turn: remember why, snapshot its process tree while the CLI is still alive, close it. */
  private abortTurn(r: Running, reason: AbortReason): void {
    r.reason ??= reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
  }

  /**
   * Make sure an aborted turn's CLI process and everything it started are gone (the SDK's close()
   * gives the CLI ~2 s; then its tree is killed, and orphans that outlived it).
   */
  private reap(r: Running, graceMs = 4000): Promise<void> {
    r.reaping ??= this.doReap(r, graceMs).catch((e) => this.sc.log.warn(`clean-up of a stopped design turn: ${(e as Error).message}`));
    return r.reaping;
  }

  private async doReap(r: Running, graceMs: number): Promise<void> {
    const child = r.child;
    if (!child?.pid) return;
    if (alive(child)) {
      await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(graceMs)]);
      if (alive(child)) {
        killTree(child);
        await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(2000)]);
      }
    }
    const snapshot = r.tree ? await r.tree : undefined;
    const table = await processTable();
    if (!table) return;
    const targets = new Map<number, ProcEntry>();
    for (const e of [...(snapshot ?? []), ...orphansOf(table, child.pid, r.spawnedAt ?? 0)]) targets.set(e.pid, e);
    const killed = (await killSnapshot([...targets.values()], table)) ?? [];
    if (killed.length) this.sc.log.info(`killed ${killed.length} leftover process(es) of a stopped design turn`);
  }
}
