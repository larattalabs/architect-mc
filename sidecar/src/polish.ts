// (5b) Polish (docs/CONTRACT.md "Phase 5b", §3, with "Changes from Steward's review of 5b"): a critique, then up to
// maxSteps targeted revision steps of an installed entry, each confined to named parts by a deterministic scope check
// (kit/tools/diff.mjs --scope), accepted only when a fresh critic marks the targeted issue resolved, and at most ONE new
// version of the same entry.
//
//   prepare: refusals (bundled, no_source, massing); the base (version `fromVersion`) is rebuilt from source in the
//            polish scratch kit; a drift from the installed .nbt ends `base_drift` before any model call
//   critique: the head's critique.json when it is fresh (not stale: version, .nbt sha, critic hash), else a report
//   targets: the highest-priority open issue that names a part (P0, P1, P2, verdict order; a failed issue is skipped;
//            part null = untargetable); explicit `target.issues`; or `target.notes` -> a scoping call (fits / suggest)
//   steps:   POLISH.md + the base renders -> a designer turn (a fresh session) -> the pristine check (0 errors, warnings
//            per rule not above the base, >= 2 parts) and the scope check -> up to 2 fix turns -> render -> the critic
//            (5a's, a fresh query with the base's issues) -> accepted when the target is in `resolved`, no new P0, and
//            overall >= base - 0.5; an accepted step is the next step's base
//   install: the last accepted result as one version (by "polish"; delta.json; critique.json format 2); none accepted:
//            nothing installs (a fresh report becomes the head's critique.json)
//
// State: DesignWork.polish (persisted), so a polish resumes after a restart (a step's interrupted turn runs again, a
// critic call waits for its job or runs again). It runs in the design pool like a design (designer.run delegates here
// through a PolishBackend: the Claude designer's turn runner, or the sim's scripted edits).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { blueprintSummary, CRITIC_SYSTEM, criticPrompt, dimsFor, readVerdict, SLICES_MAX_CHARS, verdictSchema, type CriticContext } from './critic.js';
import { criticHash } from './critichash.js';
import { checkDesign, isFinalDesign, KIT, refreshKit, renderPreviews, runNode, type CheckResult } from './designs.js';
import { ClientError } from './errors.js';
import { isFinalJob } from './jobs/book.js';
import { addCost, zeroCost } from './jobs/cost.js';
import { CRITIQUE_VIEWS, DesignRequest as DesignRequestSchema, type Cost, type CritiqueIssue, type Design, type DesignRequest, type Estimate, type Ext, type Job, type PolishEnd, type PolishRecord, type PolishSpec, type PolishStep } from './protocol.js';
import type { RunOutcome } from './bibles.js';
import type { Sidecar } from './sidecar.js';
import { POLISH_PROMPT_HASHES, polishBrief, polishFixPrompt, polishStepPrompt, SCOPING_SYSTEM, scopingPrompt, scopingSchema } from './claude/polishprompts.js';
import { readEntryCritique, sha256File, staleReason, VersionRefused } from './versions.js';
import { truncate } from './util/text.js';
import { writeFileAtomic } from './util/fsx.js';

export const POLISH_OWNER = 'architect:polish';
export const SCOPING_OWNER = 'architect:polish-scope';
export const DEFAULT_MAX_STEPS = 2;
export const POLISH_FIX_TURNS = 2;
export const DEFAULT_POLISH_MINUTES = 15;
const CRITIC_TRIES = 2;
const OVERALL_SLACK = 0.5;
const MIN = 60_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The spec with its defaults. */
export interface ResolvedPolish {
  fromVersion: number;
  critique: 'reuse' | 'fresh';
  issues?: number[] | undefined;
  parts?: string[] | undefined;
  notes?: string | undefined;
  maxSteps: number;
  maxNewParts: number;
  maxChangedShare: number;
  model: string;
  effort: 'low' | 'medium' | 'high';
  budgetUsd?: number | undefined;
  maxMinutes: number;
  apply?: PolishSpec['apply'];
  /** the critic's model and effort (config critique) and views */
  criticModel: string;
  criticEffort: 'low' | 'medium' | 'high';
  views: string[];
}

interface Verdict {
  overall: number | null;
  scores: Record<string, number>;
  issues: CritiqueIssue[];
  resolved: number[];
  summary?: string | undefined;
  modelVerdict: 'ship' | 'iterate' | null;
  ship: boolean;
}

/** One base (the rebuilt fromVersion, or an accepted step's result): its files and its verdict. */
interface Base {
  /** a folder with <bp>.nbt, <bp>.blueprint.json, <bp>.parts.nbt, <bp>.mjs, critique/ (renders, slices) */
  dir: string;
  verdict?: Verdict | undefined;
  /** warnings by rule (the pristine check: a new version may not have more of any) */
  warnings: Record<string, number>;
  cells: number;
}

interface CurrentStep {
  n: number;
  target: CritiqueIssue | null;
  targetIndex: number | null;
  allowed: string[];
  phase: 'turn' | 'critic';
  /** turns run so far (1 = the step, 2.. = fix turns) */
  turns: number;
  /** the next turn's prompt (a fix turn) */
  pending?: string | undefined;
  startedAt: number;
  costAtStart: number;
  jobId?: string | undefined;
  criticFailures: number;
  changedCells: number;
}

export interface PolishWork {
  entryId: string;
  bp: string;
  spec: ResolvedPolish;
  phase: 'prepare' | 'critique' | 'steps' | 'install' | 'ended';
  startedAt: number;
  base0?: Base | undefined;
  base?: Base | undefined;
  /** the fresh report ran (its verdict is base0.verdict) */
  reported: boolean;
  reportJobId?: string | undefined;
  reportFailures: number;
  /** issue keys a step failed on (not targeted again) */
  failed: string[];
  /** explicit targets (issue objects of the first verdict), not yet tried */
  queue?: CritiqueIssue[] | undefined;
  scoping?: PolishRecord['scoping'];
  scopingJobId?: string | undefined;
  current?: CurrentStep | undefined;
  accepted: number[];
  /** what the polish spent: turns, critic calls, the scoping call */
  turns: Cost;
  critic: Cost;
  end?: PolishEnd | undefined;
  endNote?: string | undefined;
  installedVersion?: number | undefined;
  /** sim: the usage limit a step token asked for has been hit */
  simLimited?: string[] | undefined;
}

/** A designer turn of a polish step (the Claude designer's runner, or the sim's scripted edit). */
export interface PolishTurnSpec {
  id: string;
  scratch: string;
  bp: string;
  prompt: string;
  /** the step's session: a fix turn resumes it */
  sessionKey: string;
  resume: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high';
  budgetUsd?: number | undefined;
  step: number;
  turn: number;
  /** the step's target and allowed parts (the sim scripts its edit from them) */
  target: CritiqueIssue | null;
  allowed: string[];
  baseDir: string;
  notes?: string | undefined;
}

export interface PolishTurnResult {
  outcome: 'done' | 'limit' | 'stopped' | 'cancelled' | 'budget' | 'error';
  /** this turn's cost */
  cost: Cost;
  error?: string | undefined;
}

export interface PolishBackend {
  readonly name: 'claude' | 'sim';
  turn(spec: PolishTurnSpec): Promise<PolishTurnResult>;
  /** the designer is stopping (a shutdown): leave the polish to resume on the next start */
  stopping(): boolean;
}

class Stop extends Error {
  constructor(readonly outcome: RunOutcome) {
    super(outcome);
  }
}

const issueKey = (i: CritiqueIssue) => `${i.priority}|${i.part ?? '-'}|${i.what}`;
const PRIO: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

/** The default target: the highest-priority open issue that names a part and was not failed on (P0, P1, P2, verdict order). */
export function defaultTarget(issues: CritiqueIssue[], failed: ReadonlySet<string>, parts?: string[]): { issue: CritiqueIssue; index: number } | undefined {
  const cands = issues.map((issue, index) => ({ issue, index })).filter((x) => x.issue.part !== null && !failed.has(issueKey(x.issue)) && (!parts || parts.includes(x.issue.part!)));
  cands.sort((a, b) => (PRIO[a.issue.priority] ?? 3) - (PRIO[b.issue.priority] ?? 3) || a.index - b.index);
  return cands[0];
}

/** The acceptance rule (the sidecar decides): the target resolved, no new P0, overall >= base - 0.5. */
export function acceptStep(base: Verdict, fresh: Verdict, targetIndex: number | null): { accepted: boolean; failure: string | null } {
  if (targetIndex === null || !fresh.resolved.includes(targetIndex)) return { accepted: false, failure: 'not_resolved' };
  const baseP0 = new Set(base.issues.filter((i) => i.priority === 'P0').map((i) => i.part ?? '-'));
  if (fresh.issues.some((i) => i.priority === 'P0' && !baseP0.has(i.part ?? '-'))) return { accepted: false, failure: 'new_p0' };
  if (fresh.overall === null || base.overall === null || fresh.overall < base.overall - OVERALL_SLACK - 1e-9) return { accepted: false, failure: 'regressed' };
  return { accepted: true, failure: null };
}

/** Warnings by rule (`rule: message` -> rule), as the eval harness counts them. */
export function warningsByRule(warnings: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of warnings) {
    const rule = /^([a-z_ ]+):/.exec(w)?.[1]?.trim().replace(/ /g, '_') ?? 'other';
    out[rule] = (out[rule] ?? 0) + 1;
  }
  return out;
}

function readObj(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const costOf = (usd: number): Cost => ({ ...zeroCost(), usd });

export class Polishes {
  constructor(private sc: Sidecar) {}

  private work(id: string): PolishWork | undefined {
    return this.sc.store.data.work?.[id]?.polish;
  }

  /** "<entry>:<version>" of every unfinished polish (GC keeps them). */
  versionsInUse(): Set<string> {
    const out = new Set<string>();
    for (const d of this.sc.designs.active()) if (d.kind === 'polish' && d.polish) out.add(`${d.polish.entryId}:${d.polish.fromVersion}`);
    return out;
  }

  // ---- the request ---------------------------------------------------------------------------------------------

  /** The defaults of a spec for an entry (its designer model, the critic's config). */
  resolve(entryId: string, spec: PolishSpec, json: Record<string, unknown>): ResolvedPolish {
    const req = DesignRequestSchema.safeParse(json.request);
    const model = spec.model ?? this.sc.config.polish.model ?? (req.success ? req.data.model : undefined) ?? this.sc.config.claude.designModel;
    const t = spec.target ?? {};
    return {
      fromVersion: spec.fromVersion ?? this.sc.versions.head(entryId),
      critique: spec.critique ?? 'reuse',
      ...(t.issues ? { issues: [...t.issues] } : {}),
      ...(t.parts ? { parts: [...t.parts] } : {}),
      ...(t.notes ? { notes: t.notes } : {}),
      maxSteps: spec.maxSteps ?? DEFAULT_MAX_STEPS,
      maxNewParts: spec.maxNewParts ?? 2,
      maxChangedShare: spec.maxChangedShare ?? 0.5,
      model,
      effort: spec.effort ?? 'medium',
      ...(spec.budgetUsd !== undefined ? { budgetUsd: spec.budgetUsd } : {}),
      maxMinutes: spec.maxMinutes ?? DEFAULT_POLISH_MINUTES,
      ...(spec.apply ? { apply: { sites: spec.apply.sites, preview: spec.apply.preview ?? true } } : {}),
      criticModel: this.sc.config.critique.model,
      criticEffort: this.sc.config.critique.effort,
      views: [...CRITIQUE_VIEWS],
    };
  }

  /** The request a polish design carries (the entry's own, cleaned; a pre-4b entry gets one from its sidecar). */
  requestOf(json: Record<string, unknown>, model: string): DesignRequest {
    const parsed = DesignRequestSchema.safeParse(json.request);
    const size = (json.size ?? {}) as { x?: number; y?: number; z?: number };
    const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, typeof v === 'number' ? Math.round(v) : hi));
    const base: DesignRequest = parsed.success
      ? { ...parsed.data }
      : ({ type: typeof json.type === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(json.type) ? json.type : 'custom', style: 'as built', features: [], maxSize: { x: clamp(size.x, 7, 96), y: clamp(size.y, 6, 64), z: clamp(size.z, 7, 96) }, ...(typeof json.name === 'string' ? { name: json.name.slice(0, 40) } : {}) } as DesignRequest);
    const { group: _g, itemKey: _k, wave: _w, role: _r, redirect: _re, massing: _m, fromMassing: _f, massingVersion: _mv, critique: _c, budgetUsd: _b, ...clean } = base;
    const pin = json.bible && typeof json.bible === 'object' ? (json.bible as { id?: string; version?: number }) : undefined;
    return { ...clean, model, ...(pin?.id ? { bible: pin.id, bibleVersion: pin.version ?? 1 } : {}) };
  }

  /** design.polish: refused at once (bundled, no_source, massing, a polish already running), else queued. */
  request(entryId: string, spec: PolishSpec, opts: { owner?: string; ext?: Ext; parentDesign?: string } = {}): Design {
    const sc = this.sc;
    sc.ensureClaudeAvailable();
    const json = sc.versions.checkVersionable(entryId);
    const r = this.resolve(entryId, spec, json);
    if (!sc.versions.versionDir(entryId, r.fromVersion)) throw new VersionRefused('no_version', `${entryId} has no version ${r.fromVersion}`);
    if (r.fromVersion > sc.versions.head(entryId)) throw new VersionRefused('no_version', `${entryId} has no version ${r.fromVersion}`);
    const open = sc.designs.active().find((d) => d.kind === 'polish' && d.polish?.entryId === entryId);
    if (open) throw new ClientError(`${entryId} is being polished already (design ${open.id})`);
    const req: DesignRequest = { ...this.requestOf(json, r.model), ...(opts.owner ? { owner: opts.owner } : {}), ...(opts.ext ? { ext: opts.ext } : {}) };
    const record: PolishRecord = { entryId, fromVersion: r.fromVersion, steps: [], installedVersion: null, ...(r.apply ? { apply: r.apply } : {}), prompts: { ...POLISH_PROMPT_HASHES } };
    // kind and polish from the first upsert on (a protocol-1 client never sees it)
    const d = sc.designs.create(req, undefined, { kind: 'polish', polish: record });
    const works = (sc.store.data.work ??= {});
    works[d.id] = { bp: entryId, round: 0, polish: { entryId, bp: entryId, spec: r, phase: 'prepare', startedAt: sc.now(), reported: false, reportFailures: 0, failed: [], accepted: [], turns: zeroCost(), critic: zeroCost() } };
    sc.designs.update(d.id, { step: `polish of ${entryId} v${r.fromVersion}: waiting for the designer` });
    sc.store.markDirty();
    sc.log.info(`design ${d.id}: polish of ${entryId} v${r.fromVersion} requested (${r.maxSteps} step${r.maxSteps === 1 ? '' : 's'}, ${r.model}${r.notes ? `, notes "${truncate(r.notes, 80)}"` : ''}${opts.parentDesign ? `, after design ${opts.parentDesign}` : ''})`);
    sc.scheduler.enqueue(d.id);
    return sc.designs.get(d.id)!;
  }

  /** (critique.mode "polish") a design's round 0 installed with its report: polish the new entry. */
  afterDesign(d: Design, entryId: string): void {
    const c = d.request.critique;
    if (c?.mode !== 'polish') return;
    try {
      this.request(entryId, { maxSteps: Math.max(1, Math.min(3, c.maxRevisions ?? DEFAULT_MAX_STEPS)), ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}), ...(d.request.model ? { model: d.request.model } : {}) }, { ...(d.request.owner ? { owner: d.request.owner } : {}), parentDesign: d.id });
    } catch (e) {
      this.sc.log.warn(`design ${d.id}: the polish of ${entryId} did not start: ${(e as Error).message}`);
    }
  }

  // ---- estimates and caps --------------------------------------------------------------------------------------

  /** The entry's recorded round-0 design cost (a design of this sidecar), else undefined. */
  private round0Usd(entryId: string): number | undefined {
    const d = [...this.sc.designs.list()].reverse().find((x) => x.blueprintId === entryId && x.kind !== 'polish' && !x.critiqueOf && x.status === 'done');
    if (!d?.cost) return undefined;
    const c = d.critique?.cost;
    const u = d.cost.usd - (c ? c.critic.usd + c.revise.usd : 0);
    return u > 0 ? u : undefined;
  }

  /** The polish cap: budgetUsd, else 1.0x the entry's round-0 cost, else $2 (Sonnet) / $4 (Opus); the sim: none. */
  cap(entryId: string, r: ResolvedPolish): number {
    if (r.budgetUsd !== undefined) return r.budgetUsd;
    if (this.sc.designerName() === 'sim' && this.sc.config.simDesignUsd === 0) return Infinity;
    return this.round0Usd(entryId) ?? (r.model.toLowerCase().includes('opus') ? 4.0 : 2.0);
  }

  /** The seeded highs of a step turn, a fix turn, a critic call and the scoping call. */
  highs(r: ResolvedPolish): { step: number; fix: number; critic: number; scoping: number } {
    if (this.sc.designerName() === 'sim') return { step: this.sc.config.simDesignUsd, fix: this.sc.config.simDesignUsd, critic: this.sc.config.jobs.simStepUsd, scoping: this.sc.config.jobs.simStepUsd };
    const e = this.sc.estimates;
    return { step: e.perJob('polish', r.model).usd[1], fix: e.perJob('scope', r.model).usd[1], critic: e.perJob('critic', r.criticModel).usd[1], scoping: e.perJob('scoping', this.sc.config.polish.scopingModel).usd[1] };
  }

  /** design.estimate {polish}: polish as its own fields (low = 1 step + 1 critic; high = maxSteps x (step + fix + critic) + a report if stale), clipped by the caps. */
  estimate(entryId: string, spec: PolishSpec): Estimate {
    const json = this.sc.versions.checkVersionable(entryId);
    const r = this.resolve(entryId, spec, json);
    const e = this.sc.estimates;
    const step = e.perJob('polish', r.model);
    const fix = e.perJob('scope', r.model);
    const critic = e.perJob('critic', r.criticModel);
    const scoping = r.notes && !r.parts ? e.perJob('scoping', this.sc.config.polish.scopingModel) : undefined;
    const stale = r.critique === 'fresh' || this.freshCritique(entryId, r.fromVersion) === undefined;
    const cap = this.cap(entryId, r);
    const lo = step.usd[0] + critic.usd[0] + (scoping?.usd[0] ?? 0);
    const hiRaw = r.maxSteps * (step.usd[1] + fix.usd[1] + critic.usd[1]) + (stale ? critic.usd[1] : 0) + (scoping?.usd[1] ?? 0);
    const hi = Math.min(cap, hiRaw);
    const msLo = step.ms[0] + critic.ms[0] + (scoping?.ms[0] ?? 0);
    const msHi = Math.min((r.maxMinutes * MIN) + step.ms[1] + critic.ms[1], r.maxSteps * (step.ms[1] + fix.ms[1] + critic.ms[1]) + (stale ? critic.ms[1] : 0) + (scoping?.ms[1] ?? 0));
    const limit = this.sc.store.data.limit;
    const wait = limit && limit.until > this.sc.now() ? limit.until - this.sc.now() : 0;
    const basis = [`polish of ${entryId} v${r.fromVersion}: up to ${r.maxSteps} step${r.maxSteps === 1 ? '' : 's'}`, `cap $${Number.isFinite(cap) ? r2(cap) : 'none'}${r.budgetUsd !== undefined ? ' (budgetUsd)' : ''}`, stale ? 'a report first (no fresh critique.json)' : "the head's critique.json is reused", step.basis, fix.basis, critic.basis, ...(scoping ? [scoping.basis] : []), ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ');
    return {
      usdLow: 0,
      usdHigh: 0,
      minutesLow: 0,
      minutesHigh: 0,
      polishUsdLow: r2(Math.min(lo, hi)),
      polishUsdHigh: r2(hi),
      polishMinutesLow: Math.round(((msLo + wait) / MIN) * 10) / 10,
      polishMinutesHigh: Math.round(((msHi + wait) / MIN) * 10) / 10,
      basis,
    };
  }

  /** The version's critique.json when it is fresh (made for it, for its .nbt, by this critic). */
  freshCritique(entryId: string, version: number): ReturnType<typeof readEntryCritique> | undefined {
    const dir = this.sc.versions.versionDir(entryId, version);
    if (!dir) return undefined;
    const c = readEntryCritique(path.join(dir, 'critique.json'));
    const nbt = path.join(dir, `${entryId}.nbt`);
    if (!c || !c.verdict || !fs.existsSync(nbt)) return undefined;
    return staleReason(c, { version, nbtSha256: sha256File(nbt), criticHash: criticHash() }) ? undefined : c;
  }

  // ---- running -------------------------------------------------------------------------------------------------

  private scratchOf(id: string): string {
    const d = path.join(this.sc.config.dataDir, 'designs', id);
    fs.mkdirSync(d, { recursive: true });
    return fs.realpathSync(d);
  }

  private record(id: string, patch: Partial<PolishRecord>, step?: string): void {
    const d = this.sc.designs.get(id);
    if (!d?.polish) return;
    const w = this.work(id);
    const cost = w ? addCost(w.turns, w.critic) : undefined;
    this.sc.designs.update(id, { polish: { ...d.polish, ...patch }, ...(step ? { step } : {}), ...(cost ? { cost } : {}) });
    this.sc.store.markDirty();
  }

  private spent(w: PolishWork): number {
    return w.turns.usd + w.critic.usd;
  }

  /** Run (or resume) a polish to its end. The designer's run(id) delegates here. */
  async run(id: string, backend: PolishBackend): Promise<RunOutcome> {
    const sc = this.sc;
    const d = sc.designs.get(id);
    const w = this.work(id);
    if (!d || isFinalDesign(d) || !w) return 'finished';
    if (!sc.estimates.startedAt(id)) sc.estimates.started(id);
    sc.designStep(id, 'designing', w.phase === 'prepare' ? `polish of ${w.entryId}: preparing the base` : `polish of ${w.entryId}: picked up again`);
    try {
      if (w.phase === 'prepare') await this.prepare(id, w, backend);
      if (w.phase === 'critique') await this.critique(id, w, backend);
      if (w.phase === 'steps') await this.steps(id, w, backend);
      if (w.phase === 'install') this.install(id, w);
      return 'finished';
    } catch (e) {
      if (e instanceof Stop) return e.outcome;
      sc.log.error(`design ${id}: polish: ${(e as Error).stack ?? e}`);
      sc.designFailed(id, `polish: ${(e as Error).message}`);
      return 'finished';
    } finally {
      sc.store.markDirty();
    }
  }

  private checkGone(id: string, backend: PolishBackend): void {
    const d = this.sc.designs.get(id);
    if (!d || isFinalDesign(d)) throw new Stop('finished');
    if (backend.stopping()) throw new Stop('stopped');
  }

  /** End the polish: the steps' end reason; the install (or the report) follows. */
  private end(id: string, w: PolishWork, end: PolishEnd, note?: string): void {
    w.end = end;
    if (note) w.endNote = note;
    w.phase = 'install';
    delete w.current;
    this.record(id, { end }, `polish: ${end.replace(/_/g, ' ')}${note ? ` (${truncate(note, 80)})` : ''}`);
    this.sc.log.info(`design ${id}: polish of ${w.entryId} ended (${end}${note ? `: ${note}` : ''}); ${w.accepted.length} step(s) accepted`);
  }

  // ---- prepare: the base, rebuilt from source -------------------------------------------------------------------

  private async prepare(id: string, w: PolishWork, backend: PolishBackend): Promise<void> {
    const sc = this.sc;
    const scratch = this.scratchOf(id);
    const vdir = sc.versions.versionDir(w.entryId, w.spec.fromVersion);
    if (!vdir) throw new Error(`${w.entryId} has no version ${w.spec.fromVersion} any more`);
    refreshKit(sc.config.kitDir, scratch);
    // the installed base (as installed) and the rebuilt one
    const installed = path.join(scratch, 'base', 'installed');
    const rebuilt = path.join(scratch, 'base', '0');
    fs.rmSync(path.join(scratch, 'base'), { recursive: true, force: true });
    fs.mkdirSync(installed, { recursive: true });
    for (const f of fs.readdirSync(vdir)) {
      const p = path.join(vdir, f);
      if (f === 'versions' || f.startsWith('.')) continue;
      if (fs.statSync(p).isDirectory()) fs.cpSync(p, path.join(installed, f), { recursive: true });
      else fs.copyFileSync(p, path.join(installed, f));
    }
    if (fs.existsSync(path.join(installed, 'bible'))) fs.cpSync(path.join(installed, 'bible'), path.join(scratch, 'bible'), { recursive: true });
    sc.designStep(id, 'checking', `polish of ${w.entryId}: rebuilding v${w.spec.fromVersion} from its source`);
    const tool = path.join(sc.config.kitDir, 'tools', 'rebuild.mjs');
    if (!fs.existsSync(tool)) throw new Error('the kit has no tools/rebuild.mjs (an older kit)');
    const out = path.join(scratch, 'base', 'rebuild');
    const r = await runNode(tool, [installed, '--out', out, '--json', ...(fs.existsSync(path.join(installed, 'bible', 'bible.json')) ? ['--bible', path.join(installed, 'bible')] : [])], scratch, 180_000);
    this.checkGone(id, backend);
    const j = lastJsonLine(r.stdout) as { results?: Array<{ same?: boolean; error?: string; stored?: string; rebuilt?: string }> } | undefined;
    const res = j?.results?.[0];
    if (!res || res.error) throw new Error(`the base did not rebuild: ${res?.error ?? truncate(r.output, 300)}`);
    fs.mkdirSync(rebuilt, { recursive: true });
    for (const f of fs.readdirSync(path.join(out, '0'))) fs.copyFileSync(path.join(out, '0', f), path.join(rebuilt, f));
    fs.copyFileSync(path.join(installed, `${w.bp}.mjs`), path.join(rebuilt, `${w.bp}.mjs`));
    if (!res.same) {
      // the cells decide (a byte drift with equal cells is not a drift): diff the installed template against the
      // rebuild, in the rebuild's frame
      const frame = ((readObj(path.join(rebuilt, `${w.bp}.blueprint.json`))?.frame as { origin?: number[] } | undefined)?.origin ?? [0, 0, 0]).join(',');
      const dr = await runNode(path.join(sc.config.kitDir, 'tools', 'diff.mjs'), [path.join(installed, `${w.bp}.nbt`), path.join(rebuilt, `${w.bp}.nbt`), '--frame-a', frame, '--parts-a', path.join(rebuilt, `${w.bp}.parts.nbt`), '--cells', '--json'], scratch, 120_000);
      const dj = lastJsonLine(dr.stdout) as { added?: number; removed?: number; changed?: number; cells?: { added: number[][]; removed: number[][]; changed: number[][] } } | undefined;
      const n = (dj?.added ?? 0) + (dj?.removed ?? 0) + (dj?.changed ?? 0);
      if (!dj || n > 0) {
        const sample = dj?.cells ? [...dj.cells.changed.map((c) => `~${c.join(',')}`), ...dj.cells.added.map((c) => `+${c.join(',')}`), ...dj.cells.removed.map((c) => `-${c.join(',')}`)].slice(0, 12).join(' ') : truncate(dr.output, 200);
        w.phase = 'ended';
        this.end(id, w, 'base_drift', `the rebuilt v${w.spec.fromVersion} differs from the installed one in ${n} cells: ${sample}`);
        this.finishNothing(id, w);
        throw new Stop('finished');
      }
    }
    const check = await this.checkFiles(scratch, rebuilt, w.bp);
    w.base0 = { dir: rebuilt, warnings: warningsByRule(check.warnings), cells: this.cellCount(rebuilt, w.bp) };
    w.base = w.base0;
    w.phase = 'critique';
    sc.store.markDirty();
  }

  private cellCount(dir: string, bp: string): number {
    const j = readObj(path.join(dir, `${bp}.blueprint.json`));
    const parts = (j?.parts ?? {}) as Record<string, { cells?: number }>;
    return Object.values(parts).reduce((a, p) => a + (p.cells ?? 0), 0);
  }

  /** The checker's warnings and metrics on a build (check.mjs with a pristine kit). */
  private async checkFiles(scratch: string, dir: string, bp: string): Promise<{ warnings: string[]; metrics?: Record<string, unknown> }> {
    const bible = path.join(scratch, 'bible', 'bible.json');
    const args = [path.join(dir, `${bp}.nbt`), path.join(dir, `${bp}.blueprint.json`), '--json', ...(fs.existsSync(bible) ? ['--restraint', bible] : [])];
    const r = await runNode(path.join(this.sc.config.kitDir, 'check.mjs'), args, scratch, 120_000);
    const j = lastJsonLine(r.stdout) as { warnings?: string[]; metrics?: Record<string, unknown> } | undefined;
    const out = { warnings: j?.warnings ?? [], ...(j?.metrics ? { metrics: j.metrics } : {}) };
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ warnings: out.warnings, metrics: out.metrics ?? null }, null, 2));
    return out;
  }

  // ---- the critique: reuse, or a report ---------------------------------------------------------------------------

  private async critique(id: string, w: PolishWork, backend: PolishBackend): Promise<void> {
    const sc = this.sc;
    const base = w.base0!;
    if (!base.verdict) {
      const fresh = w.spec.critique === 'reuse' ? this.freshCritique(w.entryId, w.spec.fromVersion) : undefined;
      if (fresh?.verdict) {
        const v = fresh.verdict;
        base.verdict = { overall: v.overall, scores: v.scores ?? {}, issues: (v.issues ?? []) as CritiqueIssue[], resolved: [], summary: v.summary ?? undefined, modelVerdict: null, ship: false };
        await this.renderBase(id, w, base);
      } else {
        await this.renderBase(id, w, base);
        const v = await this.criticCall(id, w, backend, base, { report: true, previous: undefined, round: 0, tag: 'report', jobKey: 'report' });
        if (!v) {
          this.end(id, w, 'critic_failed', 'the report critic call failed twice');
          this.finishNothing(id, w);
          throw new Stop('finished');
        }
        base.verdict = v;
        w.reported = true;
      }
      sc.store.markDirty();
    }
    const v = base.verdict!;
    const untargetable = v.issues.filter((i) => i.part === null).length;
    this.record(id, { baseOverall: v.overall, untargetable, ...(w.reported ? { report: true } : {}) });
    // explicit targets: the issue objects, in the order given
    if (w.spec.issues && !w.queue) w.queue = w.spec.issues.flatMap((k) => (v.issues[k] ? [v.issues[k]!] : []));
    // notes without parts: the scoping call (whole-look and structural requests are declined here, before any step)
    if (w.spec.notes && !w.spec.parts && !w.scoping) {
      const s = await this.scopingCall(id, w, backend, base);
      w.scoping = s;
      this.record(id, { scoping: s });
      if (!s.fits || s.suggest !== 'polish') {
        this.end(id, w, 'no_target', `the request is not a polish: suggest ${s.suggest} (${s.reason})`);
        this.finishNothing(id, w);
        throw new Stop('finished');
      }
    }
    w.phase = 'steps';
    sc.store.markDirty();
  }

  /** The critic's renders and slices of a base (in <base>/critique/). */
  private async renderBase(id: string, w: PolishWork, base: Base): Promise<void> {
    const scratch = this.scratchOf(id);
    const out = path.join(base.dir, 'critique');
    fs.mkdirSync(out, { recursive: true });
    const nbt = path.join(base.dir, `${w.bp}.nbt`);
    const r = await runNode(path.join(this.sc.config.kitDir, 'render.mjs'), [nbt, '--out', out, '--views', w.spec.views.join(','), '--width', '1000'], scratch, 120_000);
    if (!r.ok) this.sc.log.warn(`design ${id}: polish renders: ${truncate(r.output, 200)}`);
    const sr = await runNode(path.join(this.sc.config.kitDir, 'tools', 'slices.mjs'), [nbt, '--sidecar', path.join(base.dir, `${w.bp}.blueprint.json`), '--storeys', '--max-chars', String(SLICES_MAX_CHARS)], scratch, 60_000);
    if (sr.ok) fs.writeFileSync(path.join(out, 'slices.txt'), sr.stdout.trim().slice(0, SLICES_MAX_CHARS));
  }

  private bibleText(scratch: string): CriticContext['bible'] | undefined {
    const f = path.join(scratch, 'bible', 'bible.json');
    if (!fs.existsSync(f)) return undefined;
    const json = fs.readFileSync(f, 'utf8');
    let name = 'bible';
    try {
      name = (JSON.parse(json) as { name?: string; id?: string }).name ?? (JSON.parse(json) as { id?: string }).id ?? name;
    } catch {
      /* the default */
    }
    const md = path.join(scratch, 'bible', 'bible.md');
    return { name, json, ...(fs.existsSync(md) ? { prose: fs.readFileSync(md, 'utf8') } : {}) };
  }

  /** Wait for an internal job, or stop (shutdown, cancel). */
  private async waitJob(id: string, jobId: string, backend: PolishBackend): Promise<Job> {
    for (;;) {
      const j = this.sc.jobs.book.get(jobId);
      if (!j) return { id: jobId, status: 'failed', error: 'the job is gone' } as unknown as Job;
      if (isFinalJob(j)) return j;
      this.checkGone(id, backend);
      await new Promise((r) => setTimeout(r, backend.name === 'sim' ? 20 : 500));
    }
  }

  /**
   * A critic call (5a's critic, a fresh query) on a build: the base's report, or a step's result with the base's issues
   * as `previous` (so it fills `resolved`). Twice on a failure; undefined when both failed.
   */
  private async criticCall(id: string, w: PolishWork, backend: PolishBackend, build: Base, o: { report: boolean; previous: CritiqueIssue[] | undefined; round: number; tag: string; jobKey: 'report' | 'step'; sim?: ((dims: string[]) => unknown) | undefined }): Promise<Verdict | undefined> {
    const sc = this.sc;
    const scratch = this.scratchOf(id);
    const d = sc.designs.get(id)!;
    const json = readObj(path.join(build.dir, `${w.bp}.blueprint.json`)) ?? {};
    const parts = json.parts && typeof json.parts === 'object' ? Object.keys(json.parts as object) : [];
    const outDir = path.join(build.dir, 'critique');
    const images: Array<{ file: string; label: string }> = [];
    const views: string[] = [];
    for (const v of w.spec.views) {
      const f = path.join(outDir, `${w.bp}.preview-${v}.png`);
      if (fs.existsSync(f)) {
        images.push({ file: f, label: v });
        views.push(v);
      }
    }
    const slices = fs.existsSync(path.join(outDir, 'slices.txt')) ? fs.readFileSync(path.join(outDir, 'slices.txt'), 'utf8') : undefined;
    const check = readObj(path.join(build.dir, 'check.json')) as { warnings?: string[]; metrics?: Record<string, unknown> } | undefined;
    const summary = blueprintSummary({ sidecar: json, request: d.request, warnings: check?.warnings ?? [], metrics: check?.metrics ?? undefined });
    const bible = this.bibleText(scratch);
    const ctx: CriticContext = { kind: 'design', request: d.request, ...(bible ? { bible } : {}), neighbours: 0, views, parts, extraCriteria: d.request.critique?.extraCriteria ?? [], summary, ...(slices ? { slices } : {}), ...(o.previous?.length ? { previous: o.previous } : {}), round: o.round, ...(o.report ? { report: true } : {}) };
    const dims = dimsFor(ctx);
    const left = this.cap(w.entryId, w.spec) - this.spent(w);
    for (;;) {
      const cur = w.current;
      let jobId = o.jobKey === 'report' ? w.reportJobId : cur?.jobId;
      if (!jobId || !sc.jobs.book.get(jobId)) {
        const job = sc.jobs.runInternal(
          { kind: 'structured', prompt: criticPrompt(ctx), system: CRITIC_SYSTEM, model: w.spec.criticModel, effort: w.spec.criticEffort, schema: verdictSchema(dims, views), maxTurns: 3, ...(Number.isFinite(left) ? { budgetUsd: Math.max(0.01, r4(left)) } : {}), owner: POLISH_OWNER, tag: `design ${id} polish ${o.tag}` },
          { images, ...(backend.name === 'sim' ? { simAnswer: o.sim ? o.sim(dims) : this.simBaseVerdict(d.request.notes, dims, parts, views) } : {}) },
        );
        jobId = job.id;
        if (o.jobKey === 'report') w.reportJobId = jobId;
        else if (cur) cur.jobId = jobId;
        sc.store.markDirty();
        sc.designStep(id, 'critiquing', `polish of ${w.entryId}: critic (${o.tag})`);
      }
      const started = sc.now();
      const job = await this.waitJob(id, jobId, backend);
      w.critic = addCost(w.critic, job.cost ?? zeroCost());
      if (o.jobKey === 'report') delete w.reportJobId;
      else if (cur) delete cur.jobId;
      this.record(id, {});
      if (job.status === 'done') {
        if (sc.designerName() === 'claude') sc.estimates.record('critic', w.spec.criticModel, job.cost.usd, Math.max(1, sc.now() - started));
        const v = readVerdict(job.result, { dims, parts, shipScore: 7, previousCount: o.previous?.length ?? 0 });
        fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify({ raw: job.result, read: v }, null, 2));
        return { overall: v.overall, scores: v.scores, issues: v.issues, resolved: v.resolved, ...(v.summary ? { summary: v.summary } : {}), modelVerdict: v.verdict, ship: v.ship };
      }
      const failures = o.jobKey === 'report' ? ++w.reportFailures : cur ? ++cur.criticFailures : CRITIC_TRIES;
      sc.log.warn(`design ${id}: polish critic (${o.tag}) failed (${truncate(job.error ?? job.status, 120)})${failures < CRITIC_TRIES ? '; once more' : ''}`);
      if (failures >= CRITIC_TRIES || job.status === 'cancelled') return undefined;
    }
  }

  /** The scoping call: { parts, newParts, restated, fits, suggest, reason } (a structured job with the iso and front renders). */
  private async scopingCall(id: string, w: PolishWork, backend: PolishBackend, base: Base): Promise<NonNullable<PolishRecord['scoping']>> {
    const sc = this.sc;
    const json = readObj(path.join(base.dir, `${w.bp}.blueprint.json`)) ?? {};
    const partsObj = (json.parts ?? {}) as Record<string, { box?: number[]; cells?: number }>;
    const names = Object.keys(partsObj);
    const images = ['iso', 'front'].map((v) => ({ file: path.join(base.dir, 'critique', `${w.bp}.preview-${v}.png`), label: v })).filter((x) => fs.existsSync(x.file));
    let jobId = w.scopingJobId;
    if (!jobId || !sc.jobs.book.get(jobId)) {
      const job = sc.jobs.runInternal(
        { kind: 'structured', prompt: scopingPrompt({ request: w.spec.notes!, parts: names.map((n) => ({ name: n, ...partsObj[n] })), type: String(json.type ?? 'building'), maxNewParts: w.spec.maxNewParts }), system: SCOPING_SYSTEM, model: sc.config.polish.scopingModel, effort: 'low', schema: scopingSchema(w.spec.maxNewParts), maxTurns: 3, owner: SCOPING_OWNER, tag: `design ${id} polish scoping` },
        { images, ...(backend.name === 'sim' ? { simAnswer: simScoping(w.spec.notes!, names, w.spec.maxNewParts) } : {}) },
      );
      jobId = job.id;
      w.scopingJobId = jobId;
      sc.store.markDirty();
      sc.designStep(id, 'critiquing', `polish of ${w.entryId}: scoping the request`);
    }
    const started = sc.now();
    const job = await this.waitJob(id, jobId, backend);
    w.critic = addCost(w.critic, job.cost ?? zeroCost());
    delete w.scopingJobId;
    if (job.status !== 'done') return { parts: [], newParts: [], restated: w.spec.notes!, fits: false, suggest: 'polish', reason: `the scoping call failed: ${truncate(job.error ?? job.status, 120)}` };
    if (sc.designerName() === 'claude') sc.estimates.record('scoping', sc.config.polish.scopingModel, job.cost.usd, Math.max(1, sc.now() - started));
    const a = (job.result ?? {}) as { parts?: string[]; newParts?: string[]; restated?: string; fits?: boolean; suggest?: string; reason?: string };
    const parts = (a.parts ?? []).filter((p) => names.includes(p)).slice(0, 3);
    const newParts = (a.newParts ?? []).filter((p) => /^[a-z][a-z0-9_]{0,39}$/.test(p) && !names.includes(p)).slice(0, w.spec.maxNewParts);
    const suggest = a.suggest === 'reskin' || a.suggest === 'remix' ? a.suggest : 'polish';
    return { parts, newParts, restated: truncate(a.restated ?? w.spec.notes!, 200), fits: a.fits !== false && (parts.length > 0 || newParts.length > 0), suggest, reason: truncate(a.reason ?? '', 300) };
  }

  // ---- the steps ---------------------------------------------------------------------------------------------------

  /** The next target: explicit issues, the notes' scope (once), or the default rule. */
  private nextTarget(w: PolishWork): { target: CritiqueIssue | null; index: number | null; allowed: string[] } | undefined {
    const v = w.base!.verdict!;
    const failed = new Set(w.failed);
    const extra = [...(w.spec.parts ?? []), ...(w.scoping?.parts ?? [])];
    if (w.spec.notes) {
      // one target: the request itself (restated by the scoping call), in its parts
      if (w.failed.includes('notes') || w.accepted.length) return undefined;
      const parts = [...new Set(extra)];
      const target: CritiqueIssue = { priority: 'P1', part: parts[0] ?? null, view: 'iso', what: truncate(w.scoping?.restated ?? w.spec.notes, 200), fix: truncate(w.spec.notes, 200) };
      return { target, index: null, allowed: parts };
    }
    if (w.queue) {
      while (w.queue.length) {
        const t = w.queue.shift()!;
        const index = v.issues.findIndex((i) => issueKey(i) === issueKey(t));
        if (index < 0 || failed.has(issueKey(t))) continue;
        if (t.part === null && !extra.length) continue;
        return { target: t, index, allowed: [...new Set([...(t.part ? [t.part] : []), ...extra])] };
      }
      return undefined;
    }
    const t = defaultTarget(v.issues, failed, w.spec.parts);
    if (!t) return undefined;
    return { target: t.issue, index: t.index, allowed: [...new Set([t.issue.part!, ...extra])] };
  }

  private async steps(id: string, w: PolishWork, backend: PolishBackend): Promise<void> {
    const sc = this.sc;
    for (;;) {
      this.checkGone(id, backend);
      if (!w.current) {
        const done = sc.designs.get(id)!.polish!.steps.length;
        if (done >= w.spec.maxSteps) return this.end(id, w, w.accepted.length ? 'polished' : this.failEnd(id));
        const next = this.nextTarget(w);
        if (!next) return this.end(id, w, w.accepted.length ? 'polished' : done ? this.failEnd(id) : 'no_target', done ? undefined : 'no open issue names a part');
        if (sc.now() - w.startedAt >= w.spec.maxMinutes * MIN) return this.end(id, w, 'time', `the polish has run ${Math.round((sc.now() - w.startedAt) / MIN)} min`);
        const h = this.highs(w.spec);
        const left = this.cap(w.entryId, w.spec) - this.spent(w);
        if (h.step + h.critic > left + 1e-9) return this.end(id, w, 'budget', `a step and its critic ($${r2(h.step + h.critic)} high) do not fit what is left ($${r2(left)})`);
        w.current = { n: done + 1, target: next.target, targetIndex: next.index, allowed: next.allowed, phase: 'turn', turns: 0, startedAt: sc.now(), costAtStart: this.spent(w), criticFailures: 0, changedCells: 0 };
        this.prepareStep(id, w);
        sc.store.markDirty();
      }
      const outcome = await this.runStep(id, w, backend);
      if (outcome === 'ended') return;
    }
  }

  /** No step accepted: the last step's failure (scope_failed / check_failed) or not_resolved. */
  private failEnd(id: string): PolishEnd {
    const last = this.sc.designs.get(id)?.polish?.steps.at(-1);
    return last?.failure === 'scope_failed' || last?.failure === 'check_failed' ? last.failure : 'not_resolved';
  }

  /** The step's scratch: the kit with the base source, BRIEF.md, PLAYBOOK, POLISH.md, the base renders in polish/base/. */
  private prepareStep(id: string, w: PolishWork): void {
    const sc = this.sc;
    const scratch = this.scratchOf(id);
    const cur = w.current!;
    const base = w.base!;
    refreshKit(sc.config.kitDir, scratch);
    fs.copyFileSync(path.join(base.dir, `${w.bp}.mjs`), path.join(scratch, KIT, 'designs', `${w.bp}.mjs`));
    const pb = path.join(scratch, 'polish', 'base');
    fs.rmSync(path.join(scratch, 'polish'), { recursive: true, force: true });
    fs.mkdirSync(pb, { recursive: true });
    for (const f of ['nbt', 'blueprint.json', 'parts.nbt']) if (fs.existsSync(path.join(base.dir, `${w.bp}.${f}`))) fs.copyFileSync(path.join(base.dir, `${w.bp}.${f}`), path.join(pb, `${w.bp}.${f}`));
    const crit = path.join(base.dir, 'critique');
    for (const f of fs.existsSync(crit) ? fs.readdirSync(crit).filter((x) => x.endsWith('.png') || x === 'slices.txt') : []) fs.copyFileSync(path.join(crit, f), path.join(pb, f));
    const d = sc.designs.get(id)!;
    const req = d.request;
    const json = readObj(path.join(base.dir, `${w.bp}.blueprint.json`)) ?? {};
    fs.writeFileSync(path.join(scratch, 'BRIEF.md'), briefText(req, w.bp, json));
    const maxSize = req.maxSize;
    const buildArgs = this.buildArgs(w, json).map((a) => (/[\s{}"]/.test(a) ? `'${a}'` : a)).join(' ');
    fs.writeFileSync(
      path.join(scratch, 'POLISH.md'),
      polishBrief({
        bp: w.bp,
        issue: cur.target,
        ...(w.spec.notes ? { request: w.scoping?.restated ?? w.spec.notes } : {}),
        allowed: cur.allowed,
        maxNewParts: w.spec.maxNewParts,
        maxChangedShare: w.spec.maxChangedShare,
        maxSize,
        baseWarnings: base.warnings,
        views: w.spec.views,
        step: cur.n,
        maxSteps: w.spec.maxSteps,
        buildCommand: `node kit/build.mjs ${w.bp} ${buildArgs}`.trim(),
        diffCommand: `node kit/tools/diff.mjs polish/base/${w.bp}.nbt kit/out/${w.bp}.nbt ${this.scopeArgs(w, cur, req).join(' ')}`,
      }),
    );
  }

  /** The build args of a polish (the recorded palette and values; the type and profile; a bible's restraint). */
  private buildArgs(w: PolishWork, json: Record<string, unknown>): string[] {
    const args: string[] = [];
    if (json.palette !== undefined) args.push('--palette', typeof json.palette === 'string' ? json.palette : JSON.stringify(json.palette));
    if (json.values && typeof json.values === 'object' && Object.keys(json.values).length) args.push('--values', JSON.stringify(json.values));
    if (typeof json.type === 'string') args.push('--type', json.type);
    if (Array.isArray(json.profile) && json.profile.length && !['house', 'cabin', 'cottage', 'tower', 'shop', 'tavern', 'barn', 'smithy', 'chapel', 'gatehouse', 'custom'].includes(String(json.type))) args.push('--profile', (json.profile as string[]).join(','));
    void w;
    return args;
  }

  private scopeArgs(w: PolishWork, cur: CurrentStep, req: DesignRequest): string[] {
    const m = req.maxSize;
    return ['--scope', cur.allowed.join(',') || '-', '--new-parts', String(w.spec.maxNewParts), '--max-share', String(w.spec.maxChangedShare), ...(m ? ['--max', `${m.x},${m.y},${m.z}`] : [])];
  }

  /** Run the current step from where it is: turns (with fix turns), then its critic call, then the decision. */
  private async runStep(id: string, w: PolishWork, backend: PolishBackend): Promise<'next' | 'ended'> {
    const sc = this.sc;
    const cur = w.current!;
    const scratch = this.scratchOf(id);
    const d = sc.designs.get(id)!;
    const stepDir = path.join(scratch, 'steps', String(cur.n));
    if (cur.phase === 'turn') {
      for (;;) {
        this.checkGone(id, backend);
        const turnNo = cur.turns + 1;
        const fix = turnNo > 1;
        sc.designStep(id, 'designing', `polish of ${w.entryId}: step ${cur.n} of ${w.spec.maxSteps}${cur.target ? ` (${cur.target.priority} ${cur.target.part ?? 'building'})` : ''}${fix ? `, fix turn ${turnNo - 1} of ${POLISH_FIX_TURNS}` : ''}`);
        const left = this.cap(w.entryId, w.spec) - this.spent(w) - this.highs(w.spec).critic;
        if (left <= 0) return this.stepFailed(id, w, 'budget', 'the budget is spent', true);
        const res = await backend.turn({ id, scratch, bp: w.bp, prompt: cur.pending ?? polishStepPrompt(w.bp), sessionKey: `polish:${id}:${cur.n}`, resume: fix, model: w.spec.model, effort: w.spec.effort, ...(Number.isFinite(left) ? { budgetUsd: Math.max(0.01, r4(left)) } : {}), step: cur.n, turn: turnNo, target: cur.target, allowed: cur.allowed, baseDir: w.base!.dir, notes: d.request.notes });
        w.turns = addCost(w.turns, res.cost);
        this.record(id, {});
        if (res.outcome === 'cancelled') throw new Stop('finished');
        if (res.outcome === 'stopped') throw new Stop('stopped');
        if (res.outcome === 'limit') throw new Stop('requeue');
        if (res.outcome === 'budget') return this.stepFailed(id, w, 'budget', res.error ?? 'the step hit its budget', true);
        cur.turns = turnNo;
        sc.store.markDirty();
        // the pristine check and the scope check
        const problem = await this.checkStep(id, w, cur, d.request, res.outcome === 'error' ? res.error : undefined);
        this.checkGone(id, backend);
        if (!problem) break;
        if (cur.turns <= POLISH_FIX_TURNS) {
          cur.pending = polishFixPrompt(w.bp, problem.text, cur.turns, POLISH_FIX_TURNS);
          sc.store.markDirty();
          continue;
        }
        return this.stepFailed(id, w, problem.kind, problem.text, false);
      }
      // keep the result, render it, then the critic
      fs.rmSync(stepDir, { recursive: true, force: true });
      fs.mkdirSync(stepDir, { recursive: true });
      const check = path.join(scratch, 'check');
      for (const f of ['nbt', 'blueprint.json', 'parts.nbt']) if (fs.existsSync(path.join(check, `${w.bp}.${f}`))) fs.copyFileSync(path.join(check, `${w.bp}.${f}`), path.join(stepDir, `${w.bp}.${f}`));
      fs.copyFileSync(path.join(scratch, KIT, 'designs', `${w.bp}.mjs`), path.join(stepDir, `${w.bp}.mjs`));
      if (fs.existsSync(path.join(check, 'check.json'))) fs.copyFileSync(path.join(check, 'check.json'), path.join(stepDir, 'check.json'));
      cur.phase = 'critic';
      delete cur.pending;
      sc.store.markDirty();
      await this.renderBase(id, w, { dir: stepDir, warnings: {}, cells: 0 });
      // the default previews (iso, top, front) the new version installs with
      const pv = await renderPreviews(scratch, path.join(stepDir, `${w.bp}.nbt`));
      if (pv.files.length) {
        fs.mkdirSync(path.join(stepDir, 'previews'), { recursive: true });
        for (const f of pv.files) fs.copyFileSync(f, path.join(stepDir, 'previews', path.basename(f)));
      }
      if (sc.designerName() === 'claude') sc.estimates.record(cur.turns > 1 ? 'scope' : 'polish', w.spec.model, Math.max(0, this.spent(w) - cur.costAtStart), Math.max(1, sc.now() - cur.startedAt));
    }
    const result: Base = { dir: stepDir, warnings: warningsByRule((readObj(path.join(stepDir, 'check.json'))?.warnings as string[] | undefined) ?? []), cells: this.cellCount(stepDir, w.bp) };
    const base = w.base!;
    const v = await this.criticCall(id, w, backend, result, { report: false, previous: base.verdict!.issues, round: cur.n, tag: `step ${cur.n}`, jobKey: 'step', sim: backend.name === 'sim' ? (dims) => this.simStepVerdict(d.request.notes, w, cur, dims) : undefined });
    if (!v) {
      this.pushStep(id, w, cur, false, null, 'critic_failed');
      delete w.current;
      this.end(id, w, 'critic_failed', `the critic call of step ${cur.n} failed twice`);
      return 'ended';
    }
    result.verdict = v;
    // a notes target has no issue index to resolve: no new P0 and the overall within 0.5 decide
    const acc = w.spec.notes && cur.targetIndex === null ? acceptNotes(base.verdict!, v) : acceptStep(base.verdict!, v, cur.targetIndex);
    this.pushStep(id, w, cur, acc.accepted, v.overall, acc.failure);
    if (acc.accepted) {
      w.accepted.push(cur.n);
      w.base = result;
    } else w.failed.push(cur.target ? (w.spec.notes && cur.targetIndex === null ? 'notes' : issueKey(cur.target)) : 'notes');
    sc.log.info(`design ${id}: polish step ${cur.n} ${acc.accepted ? 'accepted' : `rejected (${acc.failure})`}: overall ${v.overall ?? '-'} (base ${base.verdict!.overall ?? '-'}), resolved ${JSON.stringify(v.resolved)}, ${cur.changedCells} changed cells`);
    delete w.current;
    sc.store.markDirty();
    return 'next';
  }

  /** A step ended without a verdict (its checks kept failing, or the budget): discarded; `final` ends the polish. */
  private stepFailed(id: string, w: PolishWork, kind: 'scope_failed' | 'check_failed' | 'budget', text: string, final: boolean): 'next' | 'ended' {
    const cur = w.current!;
    this.pushStep(id, w, cur, false, null, kind);
    if (cur.target) w.failed.push(w.spec.notes && cur.targetIndex === null ? 'notes' : issueKey(cur.target));
    this.sc.log.info(`design ${id}: polish step ${cur.n} ${kind}: ${truncate(text.replace(/\s+/g, ' '), 400)}`);
    delete w.current;
    if (final) {
      this.end(id, w, 'budget', truncate(text, 120));
      return 'ended';
    }
    return 'next';
  }

  private pushStep(id: string, w: PolishWork, cur: CurrentStep, accepted: boolean, overall: number | null, failure: string | null): void {
    const steps = [...(this.sc.designs.get(id)?.polish?.steps ?? [])].filter((s) => s.n !== cur.n);
    const step: PolishStep = { n: cur.n, target: cur.target, targetIndex: cur.targetIndex, allowedParts: [...cur.allowed], accepted, overall, changedCells: cur.changedCells, cost: costOf(r4(Math.max(0, this.spent(w) - cur.costAtStart))), ms: Math.max(0, this.sc.now() - cur.startedAt), failure, fixTurns: Math.max(0, cur.turns - 1) };
    steps.push(step);
    steps.sort((a, b) => a.n - b.n);
    this.record(id, { steps, overall: w.base?.verdict?.overall ?? null });
  }

  /** The pristine check (0 errors, warnings per rule not above the base, >= 2 parts) and the scope check (diff.mjs --scope). */
  private async checkStep(id: string, w: PolishWork, cur: CurrentStep, req: DesignRequest, turnError?: string): Promise<{ kind: 'scope_failed' | 'check_failed'; text: string } | undefined> {
    const sc = this.sc;
    const scratch = this.scratchOf(id);
    const base = w.base!;
    const json = readObj(path.join(base.dir, `${w.bp}.blueprint.json`)) ?? {};
    sc.designStep(id, 'checking', `polish of ${w.entryId}: checking step ${cur.n}`);
    // the bible files again from the entry (Bash in the scratch dir could have changed them)
    const ib = path.join(scratch, 'base', 'installed', 'bible');
    if (fs.existsSync(ib)) fs.cpSync(ib, path.join(scratch, 'bible'), { recursive: true });
    const args = this.buildArgs(w, json);
    const typeAt = args.indexOf('--type');
    const type = typeAt >= 0 ? args[typeAt + 1] : undefined;
    const profAt = args.indexOf('--profile');
    const drop = new Set([...(typeAt >= 0 ? [typeAt, typeAt + 1] : []), ...(profAt >= 0 ? [profAt, profAt + 1] : [])]);
    const extra = args.filter((_a, i) => !drop.has(i));
    const restraint = fs.existsSync(path.join(scratch, 'bible', 'bible.json')) ? ['--restraint', path.join('bible', 'bible.json')] : [];
    const res: CheckResult = await checkDesign(sc.config.kitDir, scratch, w.bp, { ...(type ? { type } : {}), ...(profAt >= 0 ? { profile: args[profAt + 1]!.split(',') } : {}) }, 120_000, [...extra, ...restraint]);
    if (!res.ok) return { kind: 'check_failed', text: `${res.problem ?? 'the check failed'}${turnError ? ` (the turn ended: ${truncate(turnError, 120)})` : ''}` };
    fs.writeFileSync(path.join(scratch, 'check', 'check.json'), JSON.stringify({ warnings: res.warnings, metrics: res.metrics ?? null }, null, 2));
    const byRule = warningsByRule(res.warnings);
    const worse = Object.entries(byRule).filter(([k, n]) => n > (base.warnings[k] ?? 0));
    const parts = res.sidecar?.parts && typeof res.sidecar.parts === 'object' ? Object.keys(res.sidecar.parts as object) : [];
    const checkProblems = [...worse.map(([k, n]) => `more "${k}" warnings than the base (${n} > ${base.warnings[k] ?? 0}): ${res.warnings.filter((x) => x.startsWith(k.replace(/_/g, ' ')) || x.startsWith(k)).slice(0, 3).join(' | ')}`), ...(parts.length < 2 ? [`fewer than 2 parts (${parts.length})`] : [])];
    // the scope check
    const dr = await runNode(path.join(sc.config.kitDir, 'tools', 'diff.mjs'), [path.join(base.dir, `${w.bp}.nbt`), res.nbt!, ...this.scopeArgs(w, cur, req), '--json'], scratch, 120_000);
    const dj = lastJsonLine(dr.stdout) as { added?: number; removed?: number; changed?: number; violations?: Array<{ kind: string; part?: string; cells?: number; message: string }>; error?: string } | undefined;
    if (!dj || dj.error) return { kind: 'scope_failed', text: `the scope check failed to run: ${truncate(dj?.error ?? dr.output, 200)}` };
    cur.changedCells = (dj.added ?? 0) + (dj.removed ?? 0) + (dj.changed ?? 0);
    const violations = dj.violations ?? [];
    if (violations.length) return { kind: 'scope_failed', text: ['The scope check (kit/tools/diff.mjs) found:', ...violations.map((v) => `- ${v.kind}: ${v.message}`), ...(checkProblems.length ? ['The pristine check found:', ...checkProblems.map((p) => `- ${p}`)] : [])].join('\n') };
    if (checkProblems.length) return { kind: 'check_failed', text: ['The pristine check found:', ...checkProblems.map((p) => `- ${p}`)].join('\n') };
    if (cur.changedCells === 0) return { kind: 'scope_failed', text: 'Nothing changed: the build equals the base. Make the fix POLISH.md asks for.' };
    return undefined;
  }

  // ---- install ------------------------------------------------------------------------------------------------------

  private install(id: string, w: PolishWork): void {
    const sc = this.sc;
    const d = sc.designs.get(id)!;
    if (!w.accepted.length || !w.base || w.base === w.base0 || !w.base.verdict) {
      this.finishNothing(id, w);
      return;
    }
    const scratch = this.scratchOf(id);
    const final = w.base;
    const fromDir = sc.versions.versionDir(w.entryId, w.spec.fromVersion);
    const fromJson = (fromDir && readObj(path.join(fromDir, `${w.entryId}.blueprint.json`))) || {};
    const built = readObj(path.join(final.dir, `${w.bp}.blueprint.json`)) ?? {};
    const json: Record<string, unknown> = { ...built };
    for (const k of Object.keys(fromJson)) if (!(k in json)) json[k] = fromJson[k];
    for (const k of ['name', 'description', 'createdAt', 'request', 'ext', 'bible', 'group', 'groupItem', 'profile', 'variantOf', 'variantOfVersion']) if (fromJson[k] !== undefined) json[k] = fromJson[k];
    const v = final.verdict!;
    json.critique = { mode: 'polish', end: w.end ?? 'polished', overall: v.overall, scores: v.scores, openIssues: v.issues, steps: d.polish?.steps.length ?? 0 };
    const head = sc.versions.head(w.entryId);
    const next = head + 1;
    // previews (the default views) of the result
    const resolvedWhat = (d.polish?.steps ?? []).filter((s) => s.accepted && s.target).map((s) => s.target!.what);
    const summary = truncate(`polish: resolved ${resolvedWhat.length} issue${resolvedWhat.length === 1 ? '' : 's'}: ${resolvedWhat.join('; ')}`, 200);
    const nbt = path.join(final.dir, `${w.bp}.nbt`);
    const renders: Record<string, string> = {};
    const crit = path.join(final.dir, 'critique');
    for (const f of fs.existsSync(crit) ? fs.readdirSync(crit).filter((x) => x.endsWith('.png')).sort() : []) renders[/\.preview-([a-z0-9_-]+)\.png$/.exec(f)?.[1] ?? f] = sha256File(path.join(crit, f));
    const critique = {
      format: 2,
      entryId: w.entryId,
      entryVersion: next,
      criticHash: criticHash(),
      entryRevision: sha256File(nbt),
      at: sc.now(),
      designId: id,
      mode: 'polish',
      end: w.end ?? 'polished',
      model: w.spec.criticModel,
      effort: w.spec.criticEffort,
      bible: d.request.bible ? { id: d.request.bible, version: d.request.bibleVersion ?? 1 } : null,
      renders,
      verdict: { overall: v.overall, scores: v.scores, issues: v.issues, summary: v.summary ?? null, modelVerdict: v.modelVerdict, ship: v.ship },
      openIssues: v.issues,
      polish: { fromVersion: w.spec.fromVersion, steps: (d.polish?.steps ?? []).length, accepted: w.accepted },
      cost: { critic: w.critic.usd, polish: w.turns.usd },
    };
    // delta.json: the kit's summary from the version polished to the result (written synchronously by install below)
    const delta = this.deltaSync(w, fromDir ? path.join(fromDir, `${w.entryId}.nbt`) : path.join(w.base0!.dir, `${w.bp}.nbt`), nbt, next);
    const version = sc.versions.install(
      w.entryId,
      {
        nbt,
        json,
        parts: path.join(final.dir, `${w.bp}.parts.nbt`),
        source: path.join(final.dir, `${w.bp}.mjs`),
        previews: fs.existsSync(path.join(final.dir, 'previews')) ? fs.readdirSync(path.join(final.dir, 'previews')).map((f) => path.join(final.dir, 'previews', f)) : [],
        critique,
        ...(delta ? { delta } : {}),
        files: fs.existsSync(path.join(scratch, 'base', 'installed', 'bible')) ? fs.readdirSync(path.join(scratch, 'base', 'installed', 'bible')).map((f) => ({ from: path.join(scratch, 'base', 'installed', 'bible', f), to: path.join('bible', f) })) : [],
      },
      { by: 'polish', parent: w.spec.fromVersion, designId: id, summary, criticHash: criticHash() },
    );
    w.installedVersion = version;
    w.phase = 'ended';
    sc.store.markDirty();
    this.record(id, { installedVersion: version, end: w.end ?? 'polished', overall: v.overall });
    sc.entryVersioned(w.entryId, version, head, 'polish', id);
    const s = this.sc.designs.get(id)!;
    const startedAt = sc.estimates.startedAt(id);
    sc.estimates.forget(id);
    sc.designs.update(id, { status: 'done', step: `done: ${w.entryId} v${version} (polish, ${w.accepted.length} of ${s.polish?.steps.length ?? 0} step${(s.polish?.steps.length ?? 0) === 1 ? '' : 's'} accepted, ${w.end ?? 'polished'})`, blueprintId: w.entryId, size: (json.size as Design['size']) ?? undefined });
    void startedAt;
    sc.store.flush();
    sc.log.info(`design ${id}: polish of ${w.entryId}: v${version} installed (${summary})`);
  }

  /** delta.json, computed now (the kit's diff, synchronously through a child process). */
  private deltaSync(w: PolishWork, a: string, b: string, to: number): Record<string, unknown> | undefined {
    try {
      const r = spawnSync(process.execPath, [path.join(this.sc.config.kitDir, 'tools', 'diff.mjs'), a, b, '--json'], { encoding: 'utf8', timeout: 120_000 });
      const j = lastJsonLine(r.stdout ?? '');
      if (!j || j.error) return undefined;
      const { ok: _o, violations: _v, cells: _c, ...rest } = j;
      return { entryId: w.entryId, from: w.spec.fromVersion, to, ...rest };
    } catch {
      return undefined;
    }
  }

  /** Nothing installs: a fresh report becomes the head's critique.json; the design ends done (no new version). */
  private finishNothing(id: string, w: PolishWork): void {
    const sc = this.sc;
    w.phase = 'ended';
    const v = w.base0?.verdict;
    const head = sc.versions.head(w.entryId);
    if (w.reported && v && w.spec.fromVersion === head) {
      const top = sc.versions.dir(w.entryId);
      const nbt = path.join(top, `${w.entryId}.nbt`);
      const crit = path.join(w.base0!.dir, 'critique');
      const renders: Record<string, string> = {};
      for (const f of fs.existsSync(crit) ? fs.readdirSync(crit).filter((x) => x.endsWith('.png')).sort() : []) renders[/\.preview-([a-z0-9_-]+)\.png$/.exec(f)?.[1] ?? f] = sha256File(path.join(crit, f));
      const d = sc.designs.get(id)!;
      try {
        writeFileAtomic(
          path.join(top, 'critique.json'),
          `${JSON.stringify({ format: 2, entryId: w.entryId, entryVersion: head, criticHash: criticHash(), entryRevision: fs.existsSync(nbt) ? sha256File(nbt) : null, at: sc.now(), designId: id, mode: 'report', end: 'report', model: w.spec.criticModel, effort: w.spec.criticEffort, bible: d.request.bible ? { id: d.request.bible, version: d.request.bibleVersion ?? 1 } : null, renders, verdict: { overall: v.overall, scores: v.scores, issues: v.issues, summary: v.summary ?? null, modelVerdict: v.modelVerdict, ship: v.ship }, openIssues: v.issues, cost: { critic: w.critic.usd } }, null, 2)}\n`,
        );
      } catch (e) {
        sc.log.warn(`design ${id}: critique.json: ${(e as Error).message}`);
      }
    }
    this.record(id, { installedVersion: null, ...(w.end ? { end: w.end } : {}), overall: v?.overall ?? null });
    sc.estimates.forget(id);
    sc.designs.update(id, { status: 'done', step: `done: ${w.entryId} unchanged (polish ${(w.end ?? 'not_resolved').replace(/_/g, ' ')}${w.endNote ? `: ${truncate(w.endNote, 100)}` : ''})`, blueprintId: w.entryId });
    sc.store.flush();
  }

  // ---- the sim's scripted verdicts ------------------------------------------------------------------------------------

  /**
   * (sim) The base report: notes `sim:issues=P1@roof,P2@-` (part `-` = null) and `sim:base=<score>` (default 5); without
   * `sim:issues`, one P1 on the first part.
   */
  simBaseVerdict(notes: string | undefined, dims: string[], parts: string[], views: string[]): unknown {
    const score = Number(/sim:base=([\d.]+)/.exec(notes ?? '')?.[1] ?? '5');
    const spec = /sim:issues=([^\s;]+)/.exec(notes ?? '')?.[1];
    const issues = spec
      ? spec.split(',').filter(Boolean).map((t, k) => {
          const [pr, part] = t.split('@');
          return { priority: pr === 'P0' || pr === 'P2' ? pr : 'P1', part: !part || part === '-' ? null : part, view: views[0] ?? 'iso', what: `simulated issue ${k} on ${part ?? 'the building'}`, fix: `fix ${part ?? 'it'}` };
        })
      : [{ priority: 'P1', part: parts[0] ?? null, view: views[0] ?? 'iso', what: 'simulated issue on the first part', fix: 'fix it' }];
    const s = Math.max(1, Math.min(10, Math.round(score)));
    return { scores: Object.fromEntries(dims.map((d, i) => [d, Number.isInteger(score) ? s : i % 2 ? Math.ceil(score) : Math.floor(score)])), issues, resolved: [], verdict: score >= 7 ? 'ship' : 'iterate', summary: `simulated base verdict (${score})` };
  }

  /**
   * (sim) A step's verdict from its token (notes `sim:polish=<t1>/<t2>/...`): `r` resolves the target (default), `n`
   * does not, `P` adds a new P0, `d<+-x>` moves the overall from the base's (default +1), `F` makes the critic fail.
   */
  simStepVerdict(notes: string | undefined, w: PolishWork, cur: CurrentStep, dimsNow: string[]): unknown {
    const tok = simToken(notes, cur.n);
    if (tok.includes('F')) return { simFail: 'the simulated polish critic failed' };
    const base = w.base!.verdict!;
    const delta = Number(/d([+-]?[\d.]+)/.exec(tok)?.[1] ?? '1');
    const overall = Math.max(1, Math.min(10, (base.overall ?? 5) + delta));
    const dims = dimsNow;
    const resolvedIdx = !tok.includes('n') && cur.targetIndex !== null ? [cur.targetIndex] : [];
    const issues = base.issues.filter((_i, k) => !resolvedIdx.includes(k));
    if (tok.includes('P')) issues.unshift({ priority: 'P0', part: 'simulated_new_p0', view: 'iso', what: 'a new P0 (simulated)', fix: 'undo it' });
    const s = Math.round(overall);
    const scores = Object.fromEntries(dims.map((d, i) => [d, Number.isInteger(overall) ? s : i % 2 ? Math.ceil(overall) : Math.floor(overall)]));
    return { scores, issues: issues.slice(0, 6), resolved: resolvedIdx, verdict: overall >= 7 ? 'ship' : 'iterate', summary: `simulated polish verdict (step ${cur.n}: ${tok})` };
  }
}

/** The sim's token for step n (1-based): `sim:polish=t1/t2/...`; default `er` (an edit in scope, resolved). */
export function simToken(notes: string | undefined, n: number): string {
  const m = /sim:polish=([^\s;]+)/.exec(notes ?? '');
  const tokens = m ? m[1]!.split('/') : ['er'];
  return tokens[Math.min(n - 1, tokens.length - 1)] ?? 'er';
}

/** (sim) The scoping call: a whole-look request is a re-skin, a rebuild a remix; else the parts the notes name. */
export function simScoping(notes: string, names: string[], maxNewParts: number): unknown {
  const n = notes.toLowerCase();
  if (/whole look|re-?skin|another style|all materials/.test(n)) return { parts: [], newParts: [], restated: notes, fits: false, suggest: 'reskin', reason: 'a whole-look change (simulated)' };
  if (/rebuild|another storey|move the entrance|restructure/.test(n)) return { parts: [], newParts: [], restated: notes, fits: false, suggest: 'remix', reason: 'a structural rebuild (simulated)' };
  const parts = names.filter((p) => n.includes(p.replace(/_/g, ' ')) || n.includes(p)).slice(0, 3);
  const wing = /add (a|an) ([a-z]+) (wing|annex)/.exec(n);
  const newParts = wing && maxNewParts > 0 ? [`wing_${wing[2]}`] : [];
  return { parts: parts.length ? parts : names.slice(0, 1), newParts, restated: notes, fits: true, suggest: 'polish', reason: 'a local change (simulated)' };
}

/** A notes target (no issue index): accepted when the critic finds no new P0 and the overall does not drop over 0.5. */
function acceptNotes(base: Verdict, fresh: Verdict): { accepted: boolean; failure: string | null } {
  const baseP0 = new Set(base.issues.filter((i) => i.priority === 'P0').map((i) => i.part ?? '-'));
  if (fresh.issues.some((i) => i.priority === 'P0' && !baseP0.has(i.part ?? '-'))) return { accepted: false, failure: 'new_p0' };
  if (fresh.overall === null || base.overall === null || fresh.overall < base.overall - OVERALL_SLACK - 1e-9) return { accepted: false, failure: 'regressed' };
  return { accepted: true, failure: null };
}

/** BRIEF.md of a polish: the original request (what the entry was designed for). */
function briefText(req: DesignRequest, bp: string, json: Record<string, unknown>): string {
  return [
    `# The original request of ${bp}`,
    '',
    `- type: ${req.type}${req.profile ? ` (profile ${req.profile.join(', ')})` : ''}; style: "${req.style}"${req.materials ? `; materials: "${req.materials}"` : ''}`,
    req.features.length ? `- features: ${req.features.join(', ')}` : '',
    `- maximum size: ${req.maxSize.x}x${req.maxSize.y}x${req.maxSize.z}${req.name ? `; name: "${req.name}"` : ''}`,
    req.notes ? `- notes: ${req.notes.replace(/sim:[^\s;]+/g, '').trim()}` : '',
    req.bible ? `- style bible: ${req.bible} v${req.bibleVersion ?? 1} (bible/bible.json, bible/bible.md, bible/components.mjs)` : '',
    '',
    `The installed design: kit/designs/${bp}.mjs (its params, palette and values are recorded in polish/base/${bp}.blueprint.json: ${JSON.stringify({ palette: json.palette ?? null, values: json.values ?? null }).slice(0, 600)}).`,
    'The kit: kit/README.md (the API), kit/PLAYBOOK.md (how to look at a design and critique it). POLISH.md says what to change.',
    '',
  ]
    .filter((l, k, a) => !(l === '' && a[k - 1] === ''))
    .join('\n');
}
