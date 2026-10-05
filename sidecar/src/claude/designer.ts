// The Claude designer: building design jobs with the Claude Agent SDK. A standalone extraction of
// AgentCraft's design job (agents/claude/design.ts DesignJobs + the aux turn runner in
// jobs/designTurns.ts, sessions.ts, holds.ts and the auth probe), without the agent roster.
//
// Design jobs run in the sidecar's pool (pool.ts, scheduler.ts: `designConcurrency` at once, round-robin across groups
// and single designs); this designer runs the one it is handed (`run(id)`). A job:
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
import type { Designer, RunOutcome, Sidecar } from '../sidecar.js';
import type { DesignWork } from '../store.js';
import { scrubEnv, withPathFirst } from '../util/env.js';
import { descendantsOf, killSnapshot, killTree, orphansOf, processTable, type ProcEntry } from '../util/proc.js';
import { truncate } from '../util/text.js';
import { ClaudeBibleBackend } from './bible.js';
import { ARCHITECT_NO_API_AUTH_MESSAGE, authEnv, authSourceOf, checkApiKey, directApiKey, type KeyCheck } from './auth.js';
import { designFixPrompt, designPrompt, designStepFor, designSystemPrompt, MAX_DESIGN_ROUNDS, RESTART_PROMPT } from './brief.js';
import { isAuthText, probeFailure } from './failures.js';
import { costFromResult, CostMeter, zeroCost } from '../jobs/cost.js';
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
  /** validates an API key against the API (tests inject a fake) */
  keyCheck?: KeyCheck;
}

/** A running CLI turn (a design turn or a job query): its abort and its process. */
export interface Running {
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

/** What an agent turn runs with. */
export interface TurnSpec {
  bp: string;
  cwd: string;
  mcp: McpServerConfig;
  resume?: string;
  model?: string;
  maxBudgetUsd?: number;
  /** the one file the agent may write, relative to cwd (default kit/designs/<bp>.mjs) */
  own?: string;
  /** the system prompt's appendix (default the designer's) */
  system?: string;
  /** the log label */
  label?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (c: ChildProcess | undefined): c is ChildProcess => !!c && c.exitCode === null && c.signalCode === null;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export class ClaudeDesigner implements Designer {
  readonly name = 'claude' as const;
  /** the designs running now (each holds a pool slot) */
  private runs = new Map<string, Current>();
  private bibles: ClaudeBibleBackend | undefined;
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

  /** The bible backend on this designer (its SDK, auth, turn runner and policy). */
  bibleBackend(): ClaudeBibleBackend {
    return (this.bibles ??= new ClaudeBibleBackend(this.sc, this));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of [this.authTimer, this.sdkTimer, this.limitTimer]) if (t) clearTimeout(t);
    this.bibles?.stopAll();
    const runs = [...this.runs.values()];
    for (const cur of runs) if (cur.turn) this.abortTurn(cur.turn, 'shutdown');
    await Promise.all(runs.map((cur) => cur.done.catch(() => undefined)));
  }

  cancel(id: string): void {
    const cur = this.runs.get(id);
    if (cur?.turn) this.abortTurn(cur.turn, 'cancel');
  }

  /** May a design turn start now (auth checked and fine, no usage limit, not stopping)? */
  canRun(): boolean {
    return this.canStart();
  }

  /** The reason designs cannot run until auth.set (auth failed), else undefined. */
  blocked(): string | undefined {
    return this.authFailed ? `Claude is not available: ${this.sc.status().message ?? 'authentication failed'}` : undefined;
  }

  /** Run one design to its end (the scheduler holds a pool slot for it). */
  async run(id: string): Promise<RunOutcome> {
    const cur: Current = { id, done: Promise.resolve() };
    this.runs.set(id, cur);
    this.sc.statusChanged();
    let outcome: RunOutcome = 'finished';
    cur.done = this.runDesign(cur)
      .then((o) => {
        outcome = o;
      })
      .catch((e) => {
        this.sc.log.error(`design ${id}: ${(e as Error).stack ?? e}`);
        this.sc.designFailed(id, (e as Error).message);
      })
      .finally(() => {
        if (this.runs.get(id) === cur) this.runs.delete(id);
        this.sc.statusChanged();
      });
    await cur.done;
    return outcome;
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
      this.sc.log.debug(`claude account info: apiKeySource ${info.apiKeySource ?? '-'}, tokenSource ${info.tokenSource ?? '-'}, apiProvider ${info.apiProvider ?? '-'}`);
      if (!ok) throw new Error('not logged in');
      // the CLI only reports that it found a key: ask the API whether the key is valid
      const key = directApiKey(process.env, a);
      if (key) {
        const v = await (this.opts.keyCheck ?? checkApiKey)(key);
        if (gen !== this.authGen) return false;
        if (v === 'invalid') throw new Error('Invalid API key (the Claude API refused it)');
        if (v !== 'ok') {
          this.goOffline(v.unreachable, src.source!);
          return false;
        }
      }
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
    // nothing can run until auth.set: what waits fails, so the player sees why
    this.kick();
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

  /** The SDK's query() (or the injected one), for the job driver. */
  queryFunction(): QueryFn {
    return this.queryFn();
  }

  /** The CLI env for a job query (the same as a design turn's). */
  cliEnv(cwd: string): Record<string, string | undefined> {
    return this.env(cwd);
  }

  /** The shared usage limit changed elsewhere (a job hit it): wake up when it ends. */
  limitChanged(): void {
    this.armLimitTimer();
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
    this.sc.jobs.limitChanged();
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
    if (!l) {
      // (cleared elsewhere, e.g. by the job runner's own wake-up)
      this.kick();
      return;
    }
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

  /** Something changed (auth, the limit): the scheduler re-checks what can start (and fails what is blocked). */
  kick(): void {
    if (this.stopping) return;
    this.sc.scheduler.kick();
  }

  private takenIds(except: string): Set<string> {
    return new Set(Object.entries(this.work).filter(([k]) => k !== except).map(([, w]) => w.bp));
  }

  /** cancelled, or ended otherwise (a group's hard budget fails a running item): stop working on it */
  private cancelled(id: string): boolean {
    const d = this.sc.designs.get(id);
    return !d || isFinalDesign(d);
  }

  private designMcp(id: string): Promise<McpServerConfig> {
    return this.statusMcp('design_status', 'Report one short line of progress on the design (shown to the player in the Designs tab).', (step) => this.sc.designStep(id, 'designing', step));
  }

  /** The sidecar's own MCP server with one progress tool (mcpGate lets exactly this server through). */
  async statusMcp(name: string, description: string, onStep: (step: string) => void): Promise<McpServerConfig> {
    const sdk = this.sdk ?? (await loadSdk());
    if (!sdk) throw new Error('the Claude Agent SDK is not installed');
    const { z } = await loadZod();
    return sdk.createSdkMcpServer({
      name: MCP_SERVER,
      version: VERSION,
      tools: [
        sdk.tool(name, description, { step: z.string().min(1).max(200) }, async ({ step }) => {
          onStep(step);
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        }),
      ],
    });
  }

  /** (bibles) is the turn runner usable now: auth ok, no limit */
  get usable(): boolean {
    return this.canStart();
  }

  /** (bibles) the usage limit a turn reported: hold everything until it resets */
  noteLimit(stats: TurnStats): void {
    if (!this.limited()) this.setLimit(stats.rateLimit?.resetsAt, stats.rateLimit?.type);
  }

  private async runDesign(cur: Current): Promise<RunOutcome> {
    const sc = this.sc;
    const cfg = sc.config;
    const id = cur.id;
    const d = sc.designs.get(id);
    if (!d || isFinalDesign(d)) return 'finished';
    const req = d.request;
    const w = (this.work[id] ??= { bp: freeLibraryId(cfg.libraryDir, designBaseId(req), this.takenIds(id)), round: 0 });
    sc.store.markDirty();
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp: w.bp, ...sc.scratchExtras(d) });
    const sessionKey = `design:${id}`;
    const meter = new CostMeter(w.cost ?? zeroCost());
    const model = req.model ?? this.cfg.designModel;
    for (;;) {
      if (this.cancelled(id)) return 'finished';
      // a group item's budget is what is left of the group's (Sidecar.designBudget)
      const budget = sc.designBudget(id);
      if (budget !== undefined && meter.remaining(budget) <= 0) {
        sc.designFailed(id, 'budget', `failed: budget ($${meter.total().usd.toFixed(4)} of $${budget})`);
        return 'finished';
      }
      const resume = sc.store.data.sessions[sessionKey]?.sessionId;
      const prompt = w.pending ?? (resume ? RESTART_PROMPT : designPrompt(w.bp));
      w.round++;
      sc.store.markDirty();
      sc.designStep(id, 'designing', w.round === 1 ? 'the designer is reading the brief' : `revising the design (round ${w.round} of ${MAX_DESIGN_ROUNDS})`);
      const turn: Running = { abort: new AbortController() };
      cur.turn = turn;
      // the SDK's maxBudgetUsd counts only this query(): give it what is left
      const caps = [this.cfg.maxBudgetUsd, budget !== undefined ? meter.remaining(budget) : undefined].filter((n): n is number => typeof n === 'number' && n > 0);
      meter.begin(!!resume);
      const { stats, reason } = await this.runTurn(turn, {
        id,
        bp: w.bp,
        sessionKey,
        cwd: scratch,
        prompt,
        model,
        ...(caps.length ? { maxBudgetUsd: Math.min(...caps) } : {}),
        mcp: await this.designMcp(id),
        ...(resume ? { resume } : {}),
        onMessage: (msg) => {
          const step = designStepFor(msg, w.bp);
          if (step) sc.designStep(id, 'designing', step);
          if (msg.type === 'result') sc.designCost(id, meter.observe(costFromResult(msg as unknown as Record<string, unknown>)));
        },
      });
      cur.turn = undefined;
      w.cost = meter.commit();
      sc.store.markDirty();
      if (reason === 'cancel' || this.cancelled(id)) return 'finished';
      if (stats.subtype === 'error_max_budget_usd' && budget !== undefined && reason !== 'shutdown' && !this.stopping) {
        sc.designFailed(id, 'budget', `failed: budget ($${w.cost.usd.toFixed(4)} of $${budget})`);
        return 'finished';
      }
      if (reason === 'shutdown' || this.stopping) {
        // picked up again on the next start (resuming this session)
        w.round--;
        sc.store.markDirty();
        return 'stopped';
      }
      if (stats.limited) {
        w.round--;
        sc.store.markDirty();
        if (!this.limited()) this.setLimit(stats.rateLimit?.resetsAt, stats.rateLimit?.type);
        const until = sc.store.data.limit?.until;
        sc.designStep(id, 'queued', `usage limit - resumes ${until ? clock(until) : 'later'}`);
        return 'requeue';
      }
      if (stats.authFailed) {
        sc.designFailed(id, `Claude authentication failed (${stats.authFailed})`);
        return 'finished';
      }
      delete w.pending;
      sc.designStep(id, 'checking', `checking the design (round ${w.round})`);
      // the bible files again from their source (Bash in the scratch dir could have changed them)
      sc.syncScratchBible(scratch, d);
      const res = await checkDesign(cfg.kitDir, scratch, w.bp, { maxSize: req.maxSize, type: req.type, profile: req.profile });
      if (this.cancelled(id)) return 'finished';
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
        return 'finished';
      }
      sc.designStep(id, 'rendering', 'rendering previews');
      const r = await renderPreviews(scratch, res.nbt!);
      if (this.cancelled(id)) return 'finished';
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: designBaseId(req),
        taken: this.takenIds(id),
        nbt: res.nbt!,
        sidecar: res.sidecar!,
        source: path.join(scratch, KIT, 'designs', `${w.bp}.mjs`),
        previews: r.files,
        files: sc.entryFiles(d, scratch),
        meta: { name: req.name, request: req, createdAt: sc.now(), extra: sc.entryExtra(d) },
      });
      const s = res.sidecar!.size!;
      const notes = [r.skipped ? 'no renderer' : r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; ');
      sc.designDone(id, installed, { x: s.x, y: s.y, z: s.z }, notes);
      return 'finished';
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

  policyContext(cwd: string, mcpServer = MCP_SERVER): PolicyContext {
    const e = this.sc.endpoint;
    return {
      role: 'worker',
      cwd,
      readDirs: [],
      tempDirs: [],
      mcpServer,
      foreman: { home: this.sc.config.dataDir, ...(e ? { port: e.port, tokenFile: e.tokenFile } : {}) },
    };
  }

  /**
   * The design turn's tool calls: AgentCraft's worker policy in `cwd`, but nobody can answer a
   * permission prompt, so whatever the policy would ask about is refused with a reason the agent
   * can work with.
   */
  canUseTool(cwd: string, bp: string, turn: Running, ownFile?: string): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      if (turn.abort.signal.aborted) return { behavior: 'deny', message: 'The job was stopped.', interrupt: true };
      const own = designVerdict(toolName, input, { cwd, bp, own: ownFile });
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
  turnOptions(turn: Running, spec: TurnSpec): Options {
    const cwd = spec.cwd;
    const report = (tool: string, why: string) => this.sc.log.info(`designer blocked: ${tool} (${truncate(why, 160)})`);
    return {
      cwd,
      model: spec.model ?? this.cfg.designModel,
      effort: this.cfg.effort,
      maxTurns: this.cfg.maxTurns,
      settingSources: [],
      // never auto mode: every call the CLI does not allow by itself reaches canUseTool
      permissionMode: 'default',
      canUseTool: this.canUseTool(cwd, spec.bp, turn, spec.own),
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      disallowedTools: ['Agent', 'Task', 'WebFetch', 'WebSearch', 'Skill', 'NotebookEdit', 'Bash(git:*)'],
      strictMcpConfig: true,
      mcpServers: { [MCP_SERVER]: spec.mcp },
      hooks: {
        PreToolUse: [
          { hooks: [denyHook((tool, input) => foremanPrivateVerdict(tool, input, this.policyContext(cwd)), report)] },
          { hooks: [connectorHook([MCP_SERVER], (tool, server) => report(tool, `MCP server "${server}" is not available`))] },
          { hooks: [denyHook((tool, input) => designVerdict(tool, input, { cwd, bp: spec.bp, own: spec.own }), report)] },
        ],
      },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.system ?? designSystemPrompt() },
      abortController: turn.abort,
      env: this.env(cwd),
      spawnClaudeCodeProcess: this.spawner(turn, 'designer'),
      ...(spec.resume ? { resume: spec.resume } : {}),
      ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : this.cfg.maxBudgetUsd ? { maxBudgetUsd: this.cfg.maxBudgetUsd } : {}),
    };
  }

  /** One agent turn (a design's, or a bible job's component pass): the CLI with the design policy, streamed. */
  async runTurn(turn: Running, spec: TurnSpec & { id: string; sessionKey: string; prompt: string; onMessage?(msg: SDKMessage): void }): Promise<{ stats: TurnStats; reason?: AbortReason }> {
    const label = spec.label ?? `designer ${spec.id}`;
    const mapper = new StreamMapper(this.sc.log, label, (r) => this.onRateLimit(r));
    this.sc.log.info(`${label}: ${spec.resume ? 'resuming' : 'starting'} (${spec.model ?? this.cfg.designModel}, effort ${this.cfg.effort}${spec.maxBudgetUsd !== undefined ? `, budget left $${spec.maxBudgetUsd}` : ''})`);
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
        if (mapper.stats.sessionId && this.sc.store.data.sessions[spec.sessionKey]?.sessionId !== mapper.stats.sessionId) this.recordSession(spec.sessionKey, mapper.stats.sessionId, undefined, spec.model);
      }
      stats = mapper.stats;
      if (stats.sessionId) this.recordSession(spec.sessionKey, stats.sessionId, stats, spec.model);
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

  private recordSession(key: string, sessionId: string, stats?: TurnStats, model?: string): void {
    const s = (this.sc.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    s.model = model ?? this.cfg.designModel;
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
  spawner(entry: Running | undefined, label: string): NonNullable<Options['spawnClaudeCodeProcess']> {
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
  abortTurn(r: Running, reason: AbortReason): void {
    r.reason ??= reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
  }

  /**
   * Make sure an aborted turn's CLI process and everything it started are gone (the SDK's close()
   * gives the CLI ~2 s; then its tree is killed, and orphans that outlived it).
   */
  reap(r: Running, graceMs = 4000): Promise<void> {
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
