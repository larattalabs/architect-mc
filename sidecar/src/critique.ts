// The critique loop (docs/CONTRACT.md "Phase 5a contract: critique loop and eval harness", with "Changes from Steward's
// review", which win). One loop for every designer (Claude and sim): the designer runs design and revision turns, the
// pristine check and the renders, then hands each passing round to `roundReady`; everything else happens here.
//
//   round 0 (the design as today) -> critic -> ship? install the best round
//                                          -> iterate: a revision turn (same session) -> check -> render -> critic ...
//
// State: DesignWork.critique (persisted), so the loop resumes after a restart: a critic call with no stored result runs
// again (its job is picked up by the job runner); a pending revision is queued again; an interrupted install runs again.
// Slot release (Steward SHOULD 2): a design gives its pool slot back while its critic call runs (the critic is a job, not
// a pool ticket) and re-enters its lane at the front for the revision turn, ahead of items not yet started.
// Files: <scratch>/rounds/<n>/ (the .nbt, the sidecar JSON, the source, previews/, check.json) for every round that
// passed the check; <scratch>/critique/<n>/ (the critic's renders, slices.txt, summary.json, verdict.json).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blueprintSummary, CRITIC_SYSTEM, criticPrompt, dimsFor, readVerdict, revisionPrompt, SLICES_MAX_CHARS, simVerdict, verdictSchema, type CriticContext } from './critic.js';
import { isFinalDesign, KIT, refreshKit, runNode, type CheckResult, type Sidecar as SidecarJson } from './designs.js';
import { addCost, zeroCost } from './jobs/cost.js';
import { isFinalJob } from './jobs/book.js';
import { CRITIQUE_VIEWS, DesignRequest as DesignRequestSchema, type Cost, type CritiqueRecord, type CritiqueRound, type CritiqueSpec, type Design, type DesignRequest, type EndReason, type Job } from './protocol.js';
import type { Sidecar } from './sidecar.js';
import { ClientError } from './sidecar.js';
import { truncate } from './util/text.js';

export const CRITIC_OWNER = 'architect:critic';
export const DEFAULT_SHIP_SCORE = 7.0;
export const DEFAULT_MAX_REVISIONS = 2;
export const DEFAULT_MAX_MINUTES = 15;
/** the critic renders' width */
export const CRITIC_WIDTH = 1000;
/** a revision's own check-fix turns (after its first) */
export const REVISION_FIX_TURNS = 2;
/** a critic call is tried twice before the loop ends with critic_failed */
const CRITIC_TRIES = 2;
/** regressed: a revision scored this much below the best round so far */
const REGRESSION = 1.0;

/** The spec with every default filled in. */
export interface ResolvedCritique {
  mode: 'report' | 'loop';
  maxRevisions: number;
  model: string;
  effort: 'low' | 'medium' | 'high';
  budgetUsd?: number | undefined;
  maxMinutes: number;
  shipScore: number;
  views: string[];
  neighbours: boolean;
  extraCriteria: string[];
}

/** The loop's own bookkeeping (DesignWork.critique). */
export interface CritiqueWork {
  spec: ResolvedCritique;
  /** what is next: a critic call, a revision turn, or installing the best round */
  pending: 'critic' | 'revise' | 'install';
  /** the round under critique (critic) or being made (revise) */
  round: number;
  /** revisions started */
  revisions: number;
  startedAt: number;
  /** the design turns' cost when the loop started (round 0) */
  round0: Cost;
  /** the critic calls' cost */
  critic: Cost;
  /** the critic job in flight */
  jobId?: string;
  criticFailures: number;
  criticStart?: number;
  /** a revision turn: when it started, and the design turns' USD then */
  reviseStart?: number;
  reviseTurnsUsd?: number;
  /** the revision's turns so far (the first is the revision, then its check-fix turns) */
  reviseTurns: number;
  bp: string;
  /** the critic's score keys and the parts of the round under critique */
  dims?: string[];
  parts?: string[];
  /** install meta from the designer */
  baseId: string;
  name?: string | undefined;
  description?: string | undefined;
  notes?: string[] | undefined;
  end?: EndReason;
  /** a report critique of a library entry */
  entry?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const MIN = 60_000;

function subCost(a: Cost, b: Cost): Cost {
  const z = (n: number) => Math.max(0, n);
  return { usd: z(Math.round((a.usd - b.usd) * 1e6) / 1e6), inputTokens: z(a.inputTokens - b.inputTokens), outputTokens: z(a.outputTokens - b.outputTokens), cacheReadTokens: z(a.cacheReadTokens - b.cacheReadTokens), cacheWriteTokens: z(a.cacheWriteTokens - b.cacheWriteTokens), turns: z(a.turns - b.turns) };
}

/** The best round: the kept round with the highest overall (ties: the later); none scored: the last kept round. */
export function bestRound(rounds: CritiqueRound[]): CritiqueRound | undefined {
  let best: CritiqueRound | undefined;
  for (const r of rounds) {
    if (!r.kept) continue;
    if (r.overall === null) {
      if (!best || best.overall === null) best = r;
      continue;
    }
    if (!best || best.overall === null || r.overall >= best.overall) best = r;
  }
  return best;
}

/** The step line once the loop ended. */
export function endStep(end: EndReason, best: CritiqueRound | undefined): string {
  const at = best ? `round ${best.n}${best.overall !== null ? ` (${best.overall})` : ''}` : 'round 0';
  if (end === 'ship') return `critique: shipped at ${at}`;
  return `critique: ended (${end.replace(/_/g, ' ')}), best ${at}`;
}

export class Critiques {
  constructor(private sc: Sidecar) {}

  private work(id: string): CritiqueWork | undefined {
    return this.sc.store.data.work?.[id]?.critique as CritiqueWork | undefined;
  }

  /** The effective spec of a design (undefined: critique off). */
  resolve(d: Design): ResolvedCritique | undefined {
    const c: CritiqueSpec | undefined = d.request.critique;
    if (!c || c.mode === 'off') return undefined;
    const cfg = this.sc.config.critique;
    return {
      mode: c.mode,
      maxRevisions: c.mode === 'report' ? 0 : Math.min(3, c.maxRevisions ?? (d.request.massing ? 1 : DEFAULT_MAX_REVISIONS)),
      model: c.model ?? cfg.model,
      effort: c.effort ?? cfg.effort,
      ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}),
      maxMinutes: c.maxMinutes ?? DEFAULT_MAX_MINUTES,
      shipScore: c.shipScore ?? DEFAULT_SHIP_SCORE,
      views: c.views ?? [...CRITIQUE_VIEWS],
      neighbours: c.neighbours ?? !!d.request.group,
      extraCriteria: c.extraCriteria ?? [],
    };
  }

  /** Is this design waiting for (or in) a revision turn? */
  revising(id: string): boolean {
    return this.work(id)?.pending === 'revise';
  }

  /** Is this design's loop waiting for its critic call (it holds no slot then)? */
  critiquing(id: string): boolean {
    return this.work(id)?.pending === 'critic';
  }

  /** The design turns' cost so far (design.cost minus the critic calls). */
  turnsCost(d: Design): Cost {
    const cw = this.work(d.id);
    return cw ? subCost(d.cost ?? zeroCost(), cw.critic) : (d.cost ?? zeroCost());
  }

  /** What the critic calls cost so far (0 without a loop). */
  criticUsd(id: string): number {
    return this.work(id)?.critic.usd ?? 0;
  }

  /** The record for the client (rounds are kept in Design.critique; this updates the totals). */
  private record(d: Design, cw: CritiqueWork, patch: Partial<CritiqueRecord> = {}): CritiqueRecord {
    const prev = d.critique;
    const rounds = patch.rounds ?? prev?.rounds ?? [];
    const best = bestRound(rounds);
    const rec: CritiqueRecord = {
      mode: cw.spec.mode,
      rounds,
      ...(best ? { best: best.n, overall: best.overall } : {}),
      ...(cw.end ? { end: cw.end } : {}),
      ...(cw.pending === 'critic' || cw.pending === 'revise' ? { pending: cw.pending } : {}),
      cost: { critic: { ...cw.critic }, revise: subCost(this.turnsCost(d), cw.round0) },
      ...patch,
    };
    return rec;
  }

  private save(d: Design, cw: CritiqueWork, patch: Partial<CritiqueRecord> = {}, status?: Design['status'], step?: string): void {
    this.sc.store.markDirty();
    const fresh = this.sc.designs.get(d.id) ?? d;
    this.sc.designs.update(d.id, { critique: this.record(fresh, cw, patch), ...(status ? { status } : {}), ...(step ? { step } : {}) });
  }

  // ---- seeds and caps ------------------------------------------------------------------------------

  /** The high seed (USD) of a critic call and of a revision turn for this design. */
  highs(d: Design, cw: CritiqueWork): { critic: number; revise: number } {
    if (this.sc.designerName() === 'sim') {
      // sim-scale: one job step for the critic, three design steps for a revision
      return { critic: this.sc.config.jobs.simStepUsd, revise: 3 * this.sc.config.simDesignUsd };
    }
    const model = d.request.model ?? (d.request.massing ? this.sc.config.massing.model : this.sc.config.claude.designModel);
    return { critic: this.sc.estimates.perJob('critic', cw.spec.model).usd[1], revise: this.sc.estimates.perJob('revise', model).usd[1] };
  }

  /** What is left of the loop's cap (critique.budgetUsd, else 1.0x round 0) and of the hard caps (design, group). */
  remaining(d: Design, cw: CritiqueWork): { loop: number; hard: number | undefined } {
    const loopCap = cw.spec.budgetUsd ?? cw.round0.usd;
    const spent = cw.critic.usd + subCost(this.turnsCost(d), cw.round0).usd;
    const hardCap = this.sc.designBudget(d.id);
    const hard = hardCap !== undefined ? hardCap - (d.cost?.usd ?? 0) : undefined;
    return { loop: Math.round((loopCap - spent) * 1e6) / 1e6, hard: hard !== undefined ? Math.round(hard * 1e6) / 1e6 : undefined };
  }

  /** The SDK budget of a revision turn: what is left of the caps, keeping a critic call's high seed for the round's critique. */
  revisionBudget(d: Design): number | undefined {
    const cw = this.work(d.id);
    if (!cw) return undefined;
    const r = this.remaining(d, cw);
    const h = this.highs(d, cw);
    const loop = r.loop - h.critic;
    return Math.max(0.0001, Math.min(loop, r.hard ?? Infinity));
  }

  // ---- the designer's side ---------------------------------------------------------------------------

  /**
   * A round passed the pristine check and rendered. Critique off: 'install' (the designer installs as before). Else the
   * round is saved and its critic call starts: 'critique' (the designer returns, giving its slot back).
   */
  async roundReady(d: Design, r: { scratch: string; bp: string; res: CheckResult; previews: string[]; baseId: string; name?: string | undefined; description?: string | undefined; notes?: string[] | undefined }): Promise<'install' | 'critique'> {
    const spec = this.resolve(d);
    if (!spec) return 'install';
    const sc = this.sc;
    const works = (sc.store.data.work ??= {});
    const w = (works[d.id] ??= { bp: r.bp, round: 1 });
    let cw = w.critique as CritiqueWork | undefined;
    const now = sc.now();
    if (!cw) {
      cw = { spec, pending: 'critic', round: 0, revisions: 0, startedAt: now, round0: { ...(d.cost ?? zeroCost()) }, critic: zeroCost(), criticFailures: 0, reviseTurns: 0, bp: r.bp, baseId: r.baseId, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}), ...(r.notes ? { notes: r.notes } : {}) };
      w.critique = cw;
    }
    const n = cw.round;
    const rounds = [...(sc.designs.get(d.id)?.critique?.rounds ?? [])].filter((x) => x.n !== n);
    // the revision that made this round: its cost and time
    let cost = 0;
    let ms = 0;
    if (n > 0 && cw.reviseStart !== undefined) {
      cost = Math.max(0, this.turnsCost(sc.designs.get(d.id) ?? d).usd - (cw.reviseTurnsUsd ?? 0));
      ms = Math.max(0, now - cw.reviseStart);
      if (sc.designerName() === 'claude') sc.estimates.record('revise', d.request.model ?? sc.config.claude.designModel, cost, ms);
    }
    // keep the round: <scratch>/rounds/<n>/
    const dir = path.join(r.scratch, 'rounds', String(n));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'previews'), { recursive: true });
    fs.copyFileSync(r.res.nbt!, path.join(dir, `${r.bp}.nbt`));
    fs.copyFileSync(r.res.json!, path.join(dir, `${r.bp}.blueprint.json`));
    const src = path.join(r.scratch, KIT, 'designs', `${r.bp}.mjs`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, `${r.bp}.mjs`));
    for (const p of r.previews) fs.copyFileSync(p, path.join(dir, 'previews', path.basename(p)));
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ warnings: r.res.warnings, metrics: r.res.metrics ?? null, conformance: r.res.conformance ?? null }, null, 2));
    rounds.push({ n, verdict: null, overall: null, scores: {}, issues: [], resolved: [], ship: false, cost: round2(cost), ms, kept: true });
    rounds.sort((a, b) => a.n - b.n);
    delete cw.reviseStart;
    delete cw.reviseTurnsUsd;
    cw.pending = 'critic';
    cw.criticFailures = 0;
    this.save(d, cw, { rounds });
    await this.submitCritic(d.id);
    return 'critique';
  }

  /** Before a revision turn starts: false when the loop ended instead (the group's soft budget). */
  beforeRevision(d: Design): boolean {
    const cw = this.work(d.id);
    if (!cw || cw.pending !== 'revise') return true;
    if (this.sc.groups.pausedFor(d)) {
      this.end(d.id, 'budget', 'the group reached its soft budget');
      return false;
    }
    if (!cw.reviseStart) {
      cw.reviseStart = this.sc.now();
      cw.reviseTurnsUsd = this.turnsCost(d).usd;
      cw.reviseTurns = 0;
      this.sc.store.markDirty();
    }
    cw.reviseTurns++;
    return true;
  }

  /** A revision turn did not run to its end (a usage limit, a shutdown): it does not count against the allowance. */
  undoTurn(id: string): void {
    const cw = this.work(id);
    if (cw?.pending === 'revise' && cw.reviseTurns > 0) {
      cw.reviseTurns--;
      this.sc.store.markDirty();
    }
  }

  /** The step line of a revision turn. */
  revisionStep(d: Design): string {
    const cw = this.work(d.id);
    const prev = d.critique?.rounds.find((r) => r.n === (cw?.round ?? 1) - 1);
    const fix = cw && cw.reviseTurns > 1 ? `, fixing the check (${cw.reviseTurns - 1} of ${REVISION_FIX_TURNS})` : `: ${prev?.issues.length ?? 0} issue${prev?.issues.length === 1 ? '' : 's'}`;
    return `revising after critique (${cw?.revisions ?? 1} of ${cw?.spec.maxRevisions ?? 1})${fix}`;
  }

  /** May a failed revision check try again? (its own allowance: REVISION_FIX_TURNS more turns) */
  mayFixRevision(id: string): boolean {
    const cw = this.work(id);
    return !!cw && cw.reviseTurns <= REVISION_FIX_TURNS;
  }

  /** A revision ended without a new round (its check kept failing, or the hard budget stopped it): install the best. */
  revisionEnded(id: string, reason: 'check_failed' | 'budget', error: string): void {
    const d = this.sc.designs.get(id);
    const cw = this.work(id);
    if (!d || !cw) return;
    const rounds = [...(d.critique?.rounds ?? []).filter((x) => x.n !== cw.round)];
    const cost = Math.max(0, this.turnsCost(d).usd - (cw.reviseTurnsUsd ?? this.turnsCost(d).usd));
    rounds.push({ n: cw.round, verdict: null, overall: null, scores: {}, issues: [], resolved: [], ship: false, cost: round2(cost), ms: cw.reviseStart ? this.sc.now() - cw.reviseStart : 0, kept: false, error: truncate(error, 300) });
    this.save(d, cw, { rounds });
    this.end(id, reason, truncate(error, 200));
  }

  // ---- the critic call --------------------------------------------------------------------------------

  /** Render the critic's views, build its inputs and start its job (or end the loop when it would not fit the budget). */
  async submitCritic(id: string): Promise<void> {
    const sc = this.sc;
    const d = sc.designs.get(id);
    const cw = this.work(id);
    if (!d || !cw || isFinalDesign(d)) return;
    const n = cw.round;
    const rem = this.remaining(d, cw);
    const high = this.highs(d, cw).critic;
    if (!cw.entry && (rem.loop < high || (rem.hard !== undefined && rem.hard < high))) {
      this.end(id, 'budget', `a critic call ($${high.toFixed(2)} high) does not fit what is left ($${Math.min(rem.loop, rem.hard ?? Infinity).toFixed(2)})`);
      return;
    }
    if (rem.hard !== undefined && rem.hard < high) {
      this.end(id, 'budget', 'the design budget is spent');
      return;
    }
    const scratch = this.scratchOf(d);
    const roundDir = path.join(scratch, 'rounds', String(n));
    const outDir = path.join(scratch, 'critique', String(n));
    fs.mkdirSync(outDir, { recursive: true });
    const nbt = path.join(roundDir, `${cw.bp}.nbt`);
    const json = path.join(roundDir, `${cw.bp}.blueprint.json`);
    sc.designs.update(id, { status: 'critiquing', step: `critic: round ${n}` });
    // the critic's renders (flat colour, fixed cameras, 1000 px wide)
    const views = cw.spec.views;
    const renderer = path.join(scratch, KIT, 'render.mjs');
    if (fs.existsSync(renderer)) {
      const rr = await runNode(renderer, [nbt, '--out', outDir, '--views', views.join(','), '--width', String(CRITIC_WIDTH)], scratch, 120_000);
      if (!rr.ok) sc.log.warn(`design ${id}: critic renders: ${truncate(rr.output, 200)}`);
    }
    const images: Array<{ file: string; label: string }> = [];
    const usedViews: string[] = [];
    for (const v of views) {
      let f = path.join(outDir, `${cw.bp}.preview-${v}.png`);
      if (!fs.existsSync(f)) f = path.join(roundDir, 'previews', `${cw.bp}.preview-${v}.png`);
      if (!fs.existsSync(f)) continue;
      images.push({ file: f, label: v });
      usedViews.push(v);
    }
    // neighbours (a group item: the finished siblings' iso renders, at most 4)
    let neighbours = 0;
    if (cw.spec.neighbours) {
      const nb = path.join(scratch, 'neighbours');
      for (const f of fs.existsSync(nb) ? fs.readdirSync(nb).filter((x) => x.endsWith('.png')).sort().slice(0, 4) : []) {
        images.push({ file: path.join(nb, f), label: `neighbour ${f.replace(/\.png$/, '')} (iso)` });
        neighbours++;
      }
    }
    // the slices (exact doors, stairwells, holes)
    let slices: string | undefined;
    const slicer = path.join(scratch, KIT, 'tools', 'slices.mjs');
    if (fs.existsSync(slicer)) {
      const sr = await runNode(slicer, [nbt, '--sidecar', json, '--storeys', '--max-chars', String(SLICES_MAX_CHARS)], scratch, 60_000);
      if (sr.ok) slices = sr.stdout.trim().slice(0, SLICES_MAX_CHARS);
      else sc.log.warn(`design ${id}: slices: ${truncate(sr.output, 200)}`);
    }
    if (slices) fs.writeFileSync(path.join(outDir, 'slices.txt'), slices);
    const sidecar = JSON.parse(fs.readFileSync(json, 'utf8')) as SidecarJson;
    const check = readJsonSafe(path.join(roundDir, 'check.json')) as { warnings?: string[]; metrics?: Record<string, unknown>; conformance?: unknown } | undefined;
    const summary = blueprintSummary({ sidecar, request: d.request, warnings: check?.warnings ?? [], metrics: check?.metrics ?? undefined, conformance: check?.conformance ?? undefined });
    fs.writeFileSync(path.join(outDir, 'summary.json'), summary);
    const parts = sidecar.parts && typeof sidecar.parts === 'object' ? Object.keys(sidecar.parts as object) : [];
    const bible = this.bibleText(d, scratch);
    const prev = n > 0 ? d.critique?.rounds.filter((r) => r.n < n && r.overall !== null).at(-1) : undefined;
    const ctx: CriticContext = {
      kind: d.request.massing ? 'massing' : 'design',
      request: d.request,
      ...(bible ? { bible } : {}),
      neighbours,
      views: usedViews,
      parts,
      extraCriteria: cw.spec.extraCriteria,
      summary,
      ...(slices ? { slices } : {}),
      ...(prev?.issues.length ? { previous: prev.issues } : {}),
      round: n,
      ...(cw.entry ? { report: true } : {}),
    };
    const dims = dimsFor(ctx);
    cw.dims = dims;
    cw.parts = parts;
    const loopLeft = cw.entry ? Infinity : rem.loop;
    const budget = Math.min(loopLeft, rem.hard ?? Infinity);
    const job = sc.jobs.runInternal(
      {
        kind: 'structured',
        prompt: criticPrompt(ctx),
        system: CRITIC_SYSTEM,
        model: cw.spec.model,
        effort: cw.spec.effort,
        schema: verdictSchema(dims, usedViews),
        maxTurns: 3,
        ...(Number.isFinite(budget) ? { budgetUsd: Math.max(0.01, round4(budget)) } : {}),
        owner: CRITIC_OWNER,
        tag: `design ${id} round ${n}`,
      },
      { images, ...(sc.designerName() === 'sim' ? { simAnswer: simVerdict(d.request.notes, n, dims, parts) } : {}) },
    );
    cw.pending = 'critic';
    cw.jobId = job.id;
    cw.criticStart = sc.now();
    this.save(d, cw, {}, 'critiquing', `critic: round ${n}`);
    sc.log.info(`design ${id}: critic call for round ${n} (job ${job.id}, ${images.length} image${images.length === 1 ? '' : 's'}, ${dims.join('/')})`);
  }

  private bibleText(d: Design, scratch: string): CriticContext['bible'] | undefined {
    const f = path.join(scratch, 'bible', 'bible.json');
    if (!d.request.bible || !fs.existsSync(f)) return undefined;
    const json = fs.readFileSync(f, 'utf8');
    let name = d.request.bible;
    try {
      name = (JSON.parse(json) as { name?: string }).name ?? name;
    } catch {
      /* the id */
    }
    const md = path.join(scratch, 'bible', 'bible.md');
    return { name, json, ...(fs.existsSync(md) ? { prose: fs.readFileSync(md, 'utf8') } : {}) };
  }

  private scratchOf(d: Design): string {
    return fs.realpathSync(path.join(this.sc.config.dataDir, 'designs', d.id));
  }

  /** A job changed (Sidecar.emit): a finished critic call moves its loop on. */
  jobChanged(job: Job): void {
    if (!isFinalJob(job) || (job.spec as { owner?: string }).owner !== CRITIC_OWNER) return;
    for (const d of this.sc.designs.active()) {
      const cw = this.work(d.id);
      if (cw?.pending === 'critic' && cw.jobId === job.id) setImmediate(() => this.criticDone(d.id, job.id));
    }
  }

  /** The critic call ended: read the verdict, then decide (ship, another revision, or the end). */
  criticDone(id: string, jobId: string): void {
    const sc = this.sc;
    const d = sc.designs.get(id);
    const cw = this.work(id);
    const job = sc.jobs.book.get(jobId);
    if (!d || !cw || !job || isFinalDesign(d) || cw.pending !== 'critic' || cw.jobId !== jobId) return;
    delete cw.jobId;
    const turns = this.turnsCost(d);
    cw.critic = addCost(cw.critic, job.cost);
    sc.designCost(id, turns);
    const fresh = sc.designs.get(id)!;
    const n = cw.round;
    const rounds = [...(fresh.critique?.rounds ?? [])];
    const idx = rounds.findIndex((r) => r.n === n);
    const r: CritiqueRound = idx >= 0 ? { ...rounds[idx]! } : { n, verdict: null, overall: null, scores: {}, issues: [], resolved: [], ship: false, cost: 0, ms: 0, kept: true };
    const ms = cw.criticStart !== undefined ? Math.max(0, sc.now() - cw.criticStart) : 0;
    r.cost = round2(r.cost + job.cost.usd);
    r.ms += ms;
    if (sc.designerName() === 'claude' && job.status === 'done') sc.estimates.record('critic', cw.spec.model, job.cost.usd, ms);
    if (job.status !== 'done') {
      cw.criticFailures++;
      const why = job.error ?? job.status;
      if (idx >= 0) rounds[idx] = r;
      else rounds.push(r);
      if (cw.criticFailures < CRITIC_TRIES && job.status !== 'cancelled') {
        sc.log.warn(`design ${id}: the critic call for round ${n} failed (${truncate(why, 120)}); trying once more`);
        this.save(d, cw, { rounds });
        void this.submitCritic(id).catch((e) => this.crash(id, e));
        return;
      }
      r.error = truncate(`the critic failed: ${why}`, 300);
      rounds[idx >= 0 ? idx : rounds.length - 1] = r;
      this.save(d, cw, { rounds });
      this.end(id, 'critic_failed', `the critic call failed twice (${truncate(why, 120)})`);
      return;
    }
    const prev = n > 0 ? rounds.filter((x) => x.n < n && x.overall !== null).at(-1) : undefined;
    const v = readVerdict(job.result, { dims: cw.dims ?? [], parts: cw.parts ?? [], shipScore: cw.spec.shipScore, previousCount: prev?.issues.length ?? 0 });
    Object.assign(r, { verdict: v.verdict, overall: v.overall, scores: v.scores, issues: v.issues, resolved: v.resolved, ship: v.ship, ...(v.summary ? { summary: v.summary } : {}), ...(v.notes.length ? { notes: v.notes } : {}), unknownParts: v.unknownParts });
    if (idx >= 0) rounds[idx] = r;
    else rounds.push(r);
    try {
      fs.writeFileSync(path.join(this.scratchOf(d), 'critique', String(n), 'verdict.json'), JSON.stringify({ raw: job.result, read: v }, null, 2));
    } catch {
      /* the scratch dir is gone */
    }
    this.save(d, cw, { rounds });
    sc.log.info(`design ${id}: round ${n} scored ${v.overall ?? '-'} (${Object.entries(v.scores).map(([k, x]) => `${k} ${x}`).join(', ')}), ${v.issues.length} issue(s), ship ${v.ship ? 'yes' : 'no'} (critic said ${v.verdict ?? '-'})`);
    this.decide(id);
  }

  /** After a verdict: end the loop or queue a revision. */
  private decide(id: string): void {
    const sc = this.sc;
    const d = sc.designs.get(id)!;
    const cw = this.work(id)!;
    const rounds = d.critique?.rounds ?? [];
    const r = rounds.find((x) => x.n === cw.round)!;
    if (cw.spec.mode === 'report') return this.end(id, r.ship ? 'ship' : 'max_revisions');
    if (r.ship) return this.end(id, 'ship');
    const earlier = bestRound(rounds.filter((x) => x.n < r.n));
    if (r.n > 0 && r.overall !== null && earlier?.overall != null && r.overall <= earlier.overall - REGRESSION) return this.end(id, 'regressed', `round ${r.n} scored ${r.overall}, ${round2(earlier.overall - r.overall)} below round ${earlier.n}`);
    if (cw.revisions >= cw.spec.maxRevisions) return this.end(id, 'max_revisions');
    if (sc.now() - cw.startedAt >= cw.spec.maxMinutes * MIN) return this.end(id, 'time', `the loop has run ${Math.round((sc.now() - cw.startedAt) / MIN)} min`);
    if (sc.groups.pausedFor(d)) return this.end(id, 'budget', 'the group reached its soft budget');
    const rem = this.remaining(d, cw);
    const h = this.highs(d, cw);
    const need = h.revise + h.critic;
    const left = Math.min(rem.loop, rem.hard ?? Infinity);
    if (need > left + 1e-9) return this.end(id, 'budget', `the next revision and critic ($${need.toFixed(2)} high) do not fit what is left ($${left.toFixed(2)})`);
    // a revision: the designer's same session, at the front of its lane
    cw.revisions++;
    cw.round = r.n + 1;
    cw.pending = 'revise';
    cw.reviseTurns = 0;
    delete cw.reviseStart;
    delete cw.reviseTurnsUsd;
    const w = sc.store.data.work[id]!;
    w.pending = revisionPrompt(cw.bp, r, cw.revisions, cw.spec.maxRevisions);
    this.save(d, cw, {}, 'queued', `waiting to revise after critique (${cw.revisions} of ${cw.spec.maxRevisions}): ${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}`);
    sc.log.info(`design ${id}: revision ${cw.revisions} of ${cw.spec.maxRevisions} queued (round ${r.n}: ${r.overall ?? '-'}, ${r.issues.length} issue(s))`);
    sc.scheduler.enqueue(id, true);
  }

  /** End the loop: install the best round (a report of an entry: write its critique.json). */
  end(id: string, reason: EndReason, why?: string): void {
    const sc = this.sc;
    const d = sc.designs.get(id);
    const cw = this.work(id);
    if (!d || !cw || isFinalDesign(d)) return;
    if (cw.jobId) {
      const j = sc.jobs.book.get(cw.jobId);
      if (j && !isFinalJob(j)) sc.jobs.cancel(cw.jobId);
      delete cw.jobId;
    }
    cw.pending = 'install';
    cw.end = reason;
    const rounds = d.critique?.rounds ?? [];
    const best = bestRound(rounds);
    this.save(d, cw, {});
    sc.log.info(`design ${id}: critique ended (${reason}${why ? `: ${why}` : ''}); best round ${best?.n ?? '-'} (${best?.overall ?? '-'})`);
    try {
      if (cw.entry) this.finishReport(d, cw, best);
      else this.installBest(d, cw, best);
    } catch (e) {
      this.crash(id, e);
    }
  }

  private crash(id: string, e: unknown): void {
    this.sc.log.error(`design ${id}: critique: ${(e as Error).stack ?? e}`);
    this.sc.designFailed(id, `critique: ${(e as Error).message}`);
  }

  /** Install a round from <scratch>/rounds/<n>/ (the library never sees the other rounds). */
  private installBest(d: Design, cw: CritiqueWork, best: CritiqueRound | undefined): void {
    const scratch = this.scratchOf(d);
    const n = best?.n ?? 0;
    const dir = path.join(scratch, 'rounds', String(n));
    const nbt = path.join(dir, `${cw.bp}.nbt`);
    const json = path.join(dir, `${cw.bp}.blueprint.json`);
    if (!fs.existsSync(nbt)) throw new Error(`round ${n} has no ${cw.bp}.nbt to install`);
    const check = readJsonSafe(path.join(dir, 'check.json')) as { warnings?: string[]; conformance?: CheckResult['conformance'] } | undefined;
    const res: CheckResult = { ok: true, output: '', warnings: check?.warnings ?? [], sidecar: JSON.parse(fs.readFileSync(json, 'utf8')) as SidecarJson, nbt, json, ...(check?.conformance ? { conformance: check.conformance } : {}) };
    const previews = fs.existsSync(path.join(dir, 'previews')) ? fs.readdirSync(path.join(dir, 'previews')).sort().map((f) => path.join(dir, 'previews', f)) : [];
    const note = endStep(cw.end ?? 'ship', best);
    this.sc.installChecked(this.sc.designs.get(d.id)!, { scratch, bp: cw.bp, baseId: cw.baseId, res, previews, name: cw.name, description: cw.description, notes: [...(cw.notes ?? []), note], source: path.join(dir, `${cw.bp}.mjs`) });
  }

  /** The entry fields an installed design keeps of its critique (blueprint JSON `critique`). */
  entrySummary(d: Design): Record<string, unknown> | undefined {
    const c = d.critique;
    if (!c?.end) return undefined;
    const best = c.rounds.find((r) => r.n === c.best);
    return { mode: c.mode, end: c.end, best: c.best ?? 0, rounds: c.rounds.length, overall: best?.overall ?? null, scores: best?.scores ?? {}, openIssues: openIssues(c, best) };
  }

  /**
   * <entry>/critique.json (Steward SHOULD 3): the verdict, the renders' hashes, the bible version and the entry revision
   * (a hash of the .nbt). A later "polish" job starts from it; a verdict whose entry revision changed is stale.
   */
  writeEntryCritique(entryDir: string, entryId: string, d: Design, cw: CritiqueWork | undefined): void {
    const c = this.sc.designs.get(d.id)?.critique ?? d.critique;
    if (!c) return;
    const best = c.rounds.find((r) => r.n === c.best);
    const nbt = path.join(entryDir, `${entryId}.nbt`);
    const renders: Record<string, string> = {};
    const scratch = (() => {
      try {
        return this.scratchOf(d);
      } catch {
        return undefined;
      }
    })();
    if (scratch && best) {
      const dir = path.join(scratch, 'critique', String(best.n));
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort() : []) renders[/\.preview-([a-z0-9_-]+)\.png$/.exec(f)?.[1] ?? f] = sha256(path.join(dir, f));
    }
    const out = {
      format: 1,
      entryId,
      entryRevision: fs.existsSync(nbt) ? sha256(nbt) : null,
      at: this.sc.now(),
      designId: d.id,
      mode: c.mode,
      end: c.end ?? null,
      best: c.best ?? null,
      model: cw?.spec.model ?? this.sc.config.critique.model,
      effort: cw?.spec.effort ?? this.sc.config.critique.effort,
      bible: d.request.bible ? { id: d.request.bible, version: d.request.bibleVersion ?? 1 } : null,
      renders,
      verdict: best ? { overall: best.overall, scores: best.scores, issues: best.issues, summary: best.summary ?? null, modelVerdict: best.verdict, ship: best.ship } : null,
      openIssues: openIssues(c, best),
      rounds: c.rounds.map((r) => ({ n: r.n, overall: r.overall, ship: r.ship, issues: r.issues.length, kept: r.kept })),
      cost: { critic: c.cost.critic.usd, revise: c.cost.revise.usd },
    };
    fs.writeFileSync(path.join(entryDir, 'critique.json'), `${JSON.stringify(out, null, 2)}\n`);
  }

  // ---- report critique of a library entry (design.critique) -------------------------------------------

  /** design.critique { entryId, spec }: one critic call on the entry's installed files; no new entry. */
  reportEntry(entryId: string, spec: CritiqueSpec | undefined): Design {
    const sc = this.sc;
    sc.ensureClaudeAvailable();
    if (spec && spec.mode !== 'report') throw new ClientError('design.critique runs a report (mode "report"); a loop on an installed entry ("polish") is not in 5a');
    const dir = path.join(sc.config.libraryDir, entryId);
    const nbt = path.join(dir, `${entryId}.nbt`);
    const json = path.join(dir, `${entryId}.blueprint.json`);
    if (!fs.existsSync(nbt) || !fs.existsSync(json)) throw new ClientError(`no library entry "${entryId}" (with ${entryId}.nbt and ${entryId}.blueprint.json)`);
    const bp = JSON.parse(fs.readFileSync(json, 'utf8')) as Record<string, unknown>;
    const parsed = DesignRequestSchema.safeParse(bp.request);
    const size = (bp.size ?? {}) as { x?: number; y?: number; z?: number };
    const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, typeof v === 'number' ? Math.round(v) : hi));
    const base: DesignRequest = parsed.success
      ? { ...parsed.data }
      : ({ type: typeof bp.type === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(bp.type) ? bp.type : 'custom', style: 'as built', features: [], maxSize: { x: clamp(size.x, 7, 96), y: clamp(size.y, 6, 64), z: clamp(size.z, 7, 96) }, ...(typeof bp.name === 'string' ? { name: bp.name.slice(0, 40) } : {}) } as DesignRequest);
    const pin = bp.bible && typeof bp.bible === 'object' ? (bp.bible as { id?: string; version?: number }) : undefined;
    const { group: _g, itemKey: _k, wave: _w, role: _r, redirect: _re, massing: _m, fromMassing: _f, massingVersion: _mv, ...clean } = base;
    const req: DesignRequest = { ...clean, ...(pin?.id ? { bible: pin.id, bibleVersion: pin.version ?? 1 } : {}), critique: { ...(spec ?? {}), mode: 'report' } };
    const d = sc.designs.create(req);
    sc.designs.update(d.id, { critiqueOf: entryId, status: 'critiquing', step: 'critic: preparing the renders' });
    sc.log.info(`design ${d.id}: report critique of ${entryId}`);
    void this.startReport(d.id, entryId).catch((e) => this.crash(d.id, e));
    return sc.designs.get(d.id)!;
  }

  private async startReport(id: string, entryId: string): Promise<void> {
    const sc = this.sc;
    const d = sc.designs.get(id)!;
    const spec = this.resolve(d)!;
    const dir = path.join(sc.config.libraryDir, entryId);
    const scratch = path.join(sc.config.dataDir, 'designs', id);
    fs.mkdirSync(scratch, { recursive: true });
    refreshKit(sc.config.kitDir, scratch);
    const round = path.join(scratch, 'rounds', '0');
    fs.mkdirSync(path.join(round, 'previews'), { recursive: true });
    const nbt = path.join(round, `${entryId}.nbt`);
    const json = path.join(round, `${entryId}.blueprint.json`);
    fs.copyFileSync(path.join(dir, `${entryId}.nbt`), nbt);
    fs.copyFileSync(path.join(dir, `${entryId}.blueprint.json`), json);
    for (const f of fs.readdirSync(dir).filter((x) => /\.preview-[a-z0-9_-]+\.png$/.test(x))) fs.copyFileSync(path.join(dir, f), path.join(round, 'previews', f));
    // the bible files the entry carries (bible/), for the critic's bible line
    if (fs.existsSync(path.join(dir, 'bible'))) fs.cpSync(path.join(dir, 'bible'), path.join(scratch, 'bible'), { recursive: true });
    // the checker's warnings and metrics on the installed files (a pristine kit)
    const args = [nbt, json, '--json', ...(fs.existsSync(path.join(scratch, 'bible', 'bible.json')) ? ['--restraint', path.join(scratch, 'bible', 'bible.json')] : [])];
    let r = await runNode(path.join(scratch, KIT, 'check.mjs'), args, scratch, 120_000);
    if (!r.stdout.trim() && args.includes('--restraint')) r = await runNode(path.join(scratch, KIT, 'check.mjs'), [nbt, json, '--json'], scratch, 120_000);
    const line = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    const parsed = line ? (readJsonText(line) as { warnings?: string[]; metrics?: unknown; conformance?: unknown } | undefined) : undefined;
    fs.writeFileSync(path.join(round, 'check.json'), JSON.stringify({ warnings: parsed?.warnings ?? [], metrics: parsed?.metrics ?? null, conformance: null }, null, 2));
    const w = ((sc.store.data.work ??= {})[id] ??= { bp: entryId, round: 0 });
    const cw: CritiqueWork = { spec, pending: 'critic', round: 0, revisions: 0, startedAt: sc.now(), round0: zeroCost(), critic: zeroCost(), criticFailures: 0, reviseTurns: 0, bp: entryId, baseId: entryId, entry: entryId };
    w.critique = cw;
    this.save(d, cw, { rounds: [{ n: 0, verdict: null, overall: null, scores: {}, issues: [], resolved: [], ship: false, cost: 0, ms: 0, kept: true }] });
    await this.submitCritic(id);
  }

  private finishReport(d: Design, cw: CritiqueWork, best: CritiqueRound | undefined): void {
    const sc = this.sc;
    const entryDir = path.join(sc.config.libraryDir, cw.entry!);
    if (best?.overall != null && fs.existsSync(entryDir)) this.writeEntryCritique(entryDir, cw.entry!, d, cw);
    const ok = best?.overall != null;
    const step = ok ? `report: ${cw.entry} scored ${best!.overall} (${best!.issues.length} issue${best!.issues.length === 1 ? '' : 's'}${best!.ship ? ', ships' : ''})` : `report: the critic did not answer`;
    if (!ok) {
      sc.designFailed(d.id, 'the critic call failed twice', `failed: ${step}`);
      return;
    }
    sc.designs.update(d.id, { status: 'done', step, blueprintId: cw.entry! });
    sc.store.flush();
  }

  // ---- restart -------------------------------------------------------------------------------------------

  /**
   * After a restart: a design whose loop waits for its critic keeps its job (the job runner resumes it) or gets a new
   * one; an interrupted install runs again. Returns whether the design needs the designer (a revision, or no loop).
   */
  resume(d: Design): boolean {
    const cw = this.work(d.id);
    if (!cw) return true;
    if (cw.pending === 'revise') return true;
    if (cw.pending === 'install') {
      cw.pending = 'critic';
      this.end(d.id, cw.end ?? 'ship', 'picked up again after a restart');
      return false;
    }
    // critic
    const j = cw.jobId ? this.sc.jobs.book.get(cw.jobId) : undefined;
    this.sc.designs.update(d.id, { status: 'critiquing', step: `critic: round ${cw.round} (picked up again after a restart)` });
    if (j && !isFinalJob(j)) return false;
    if (j && isFinalJob(j)) {
      setImmediate(() => this.criticDone(d.id, j.id));
      return false;
    }
    void this.submitCritic(d.id).catch((e) => this.crash(d.id, e));
    return false;
  }

  /** A design is cancelled or stopped: its critic call goes too. */
  stopped(id: string): void {
    const cw = this.work(id);
    if (!cw?.jobId) return;
    const j = this.sc.jobs.book.get(cw.jobId);
    if (j && !isFinalJob(j)) {
      try {
        this.sc.jobs.cancel(cw.jobId);
      } catch {
        /* already ending */
      }
    }
  }
}

/** The unresolved P0/P1/P2 issues of the best round. */
export function openIssues(c: CritiqueRecord, best: CritiqueRound | undefined): CritiqueRound['issues'] {
  return best ? best.issues : [];
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readJsonText(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}
