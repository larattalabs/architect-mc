// Cost and time estimates (docs/CONTRACT.md phase 4b, "4b review folded in" item 2): `design.estimate` and
// `bible.estimate` answer { usdLow, usdHigh, minutesLow, minutesHigh, basis }, computed from a rolling per-model average
// of finished designs and bible jobs (the last 20 of each, persisted in state.json), the concurrency and the current
// usage-limit state. Until a model has measurements the seeds stand in, measured in the phase 4b gate (2026-10-05):
// an Opus design $2.0-3.2 and 8-13 min, a Sonnet design $0.8-2.5 and 4-10 min, a bible job $1.2-2.0 and 5-8 min (the
// phase 1-2 Opus figure of $1-1.5 was for smaller, simpler designs). Only the Claude backend records samples.
// Phase 4c adds the `massing` kind (seeded at $0.10-0.40 and 1-3 min, the contract's figure until the gate measures it);
// a group with massingFirst estimates both passes (redirects are not in the estimate: they are the player's choice).
import { expandItems } from './copies.js';
import type { BibleRequest, CritiqueSpec, DesignRequest, Estimate, GroupRequest } from './protocol.js';
import type { Store } from './store.js';

export interface Sample {
  usd: number;
  ms: number;
  at: number;
}

export type EstimateKind = 'design' | 'bible' | 'massing' | 'critic' | 'revise' | 'polish' | 'scope' | 'scoping';
export interface EstimateData {
  design: Record<string, Sample[]>;
  bible: Record<string, Sample[]>;
  /** (4c) */
  massing: Record<string, Sample[]>;
  /** (5a) one critic call (by the critic's model) */
  critic: Record<string, Sample[]>;
  /** (5a) one revision turn with its check-fix turns (by the design's model) */
  revise: Record<string, Sample[]>;
  /** (5b) one polish step's turn (by the polish model), a scope/check fix turn, the scoping call */
  polish?: Record<string, Sample[]>;
  scope?: Record<string, Sample[]>;
  scoping?: Record<string, Sample[]>;
}

const KEEP = 20;
const MIN = 60_000;
interface Seed {
  usd: [number, number];
  ms: [number, number];
}
/**
 * (6c 0a, C5) Re-seeded from Steward's phase 1 (2026-10-09, docs/CONTRACT.md 6c slice 0a §3): a detail pass with its report
 * critique $2.5-4.6 and 8-15 min, a massing $0.12-0.30 and 1-3 min, a bible $1.16-1.55 and 5-8 min, a repair round $0.3-0.9.
 * The detail seed stands for Opus and Sonnet alike (the phase-1 mix); measured samples still replace it per model.
 */
export const SEED_BASIS = 'seed (Steward phase 1, 2026-10-09)';
const OPUS: Seed = { usd: [2.5, 4.6], ms: [8 * MIN, 15 * MIN] };
/** (6c 0a) One repair-sized turn: a repair round, and the seed of an "adapted" building (unmeasured until 7b). */
export const REPAIR_SEED: Seed = { usd: [0.3, 0.9], ms: [1 * MIN, 3 * MIN] };
/** (0b, C8) A SMALL detail pass (2 rounds, 40 turns, medium, $1.50): seeded at $0.6-1.5 and 3-6 min, unmeasured until §6. */
export const SMALL_SEED: Seed = { usd: [0.6, 1.5], ms: [3 * MIN, 6 * MIN] };
export const SMALL_BASIS = 'SMALL pass (config small: 2 rounds, 40 turns, effort medium, $1.50): seed $0.6-1.5, 3-6 min, unmeasured until §6';
/** (0b, C13) A change (versionOf): seeded from the polish step ($0.4-1.2, Sonnet). */
export const CHANGE_SEED: Seed = { usd: [0.4, 1.2], ms: [2 * MIN, 8 * MIN] };
export const CHANGE_BASIS = 'a change (versionOf): seed from the polish step ($0.4-1.2, Sonnet)';
/** (0b, C1) A copy: $0 and the variant build time (measured in the 0b sim gate: seconds). */
export const COPY_BASIS = '$0 and the variant build time (a copy: no Claude)';
/** Sonnet design seed, measured 2026-10-05 (4 real designs in the phase 4b gate: $0.86-2.45, 4-10 min). */
/** Bible job seed, measured 2026-10-05 (one real bible: $1.40, 6.4 min). */
const BIBLE: Seed = { usd: [1.16, 1.55], ms: [5 * MIN, 8 * MIN] };
const SONNET: Seed = OPUS;
/** (4c) Massing job seed, (6c 0a) re-seeded from Steward's phase 1. */
const MASSING: Seed = { usd: [0.12, 0.3], ms: [1 * MIN, 3 * MIN] };
/**
 * (5a) Seeds calibrated on the smoke tier (2026-10-06, 4 Sonnet designs, claude login): 8 critic calls (Sonnet 5.5,
 * medium, 5 views) $0.023-0.072 (mean $0.045), 4-19 s; 4 revisions $0.29-0.96 (mean $0.54), 0.8-3.3 min. The contract's
 * seeds were $0.04-0.15 / 0.5-2 min and $0.25-0.9 / 2-5 min. The Opus revision is scaled from Sonnet's (unmeasured).
 */
export const CRITIC_SEED: Seed = { usd: [0.02, 0.08], ms: [0.1 * MIN, 0.4 * MIN] };
export const REVISE_SONNET_SEED: Seed = { usd: [0.25, 1.0], ms: [1 * MIN, 4 * MIN] };
export const REVISE_OPUS_SEED: Seed = { usd: [0.4, 1.6], ms: [1.5 * MIN, 6 * MIN] };
/**
 * (5b) Polish seeds (docs/CONTRACT.md "Budgets and cost seeds"; measured samples replace them): a polish step is a fresh
 * session with a cold cache (5a's warm revision turns were $0.47-0.49).
 */
export const POLISH_SONNET_SEED: Seed = { usd: [0.4, 1.2], ms: [2 * MIN, 6 * MIN] };
export const POLISH_OPUS_SEED: Seed = { usd: [0.8, 2.4], ms: [3 * MIN, 8 * MIN] };
export const SCOPE_FIX_SEED: Seed = { usd: [0.1, 0.4], ms: [1 * MIN, 2 * MIN] };
export const SCOPING_SEED: Seed = { usd: [0.01, 0.03], ms: [0.05 * MIN, 0.3 * MIN] };

/** The seed of a model family (by its id). */
export function seedFor(model: string): { seed: Seed; family: string } {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return { seed: { usd: [OPUS.usd[0] * 0.15, OPUS.usd[1] * 0.15], ms: [OPUS.ms[0] * 0.6, OPUS.ms[1] * 0.6] }, family: 'haiku (0.15x the detail seed, unmeasured)' };
  return { seed: m.includes('sonnet') ? SONNET : OPUS, family: `a detail with its report critique ($2.5-4.6, 8-15 min), ${SEED_BASIS}` };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface EstimateCtx {
  /** the sidecar-wide designConcurrency */
  designConcurrency: number;
  /** a usage limit holds new turns until (epoch ms) */
  limitUntil?: number | undefined;
  now: number;
  /** default models */
  designModel: string;
  landmarkModel: string;
  ordinaryModel: string;
  bibleModel: string;
  /** (4c) the default model of a massing job */
  massingModel: string;
  /** (5a) the default critic model */
  criticModel?: string;
}

export class Estimates {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  private get data(): EstimateData {
    const d = (this.store.data.estimates ??= { design: {}, bible: {}, massing: {}, critic: {}, revise: {} });
    d.polish ??= {};
    d.scope ??= {};
    d.scoping ??= {};
    d.design ??= {};
    d.bible ??= {};
    d.massing ??= {};
    d.critic ??= {};
    d.revise ??= {};
    return d;
  }

  /** A design started (first time only): its time counts from here. */
  started(designId: string): void {
    const s = (this.store.data.runStarts ??= {});
    if (s[designId] === undefined) {
      s[designId] = this.now();
      this.store.markDirty();
    }
  }

  startedAt(designId: string): number | undefined {
    return this.store.data.runStarts?.[designId];
  }

  forget(designId: string): void {
    if (this.store.data.runStarts?.[designId] !== undefined) {
      delete this.store.data.runStarts[designId];
      this.store.markDirty();
    }
  }

  /** Add a measurement (a finished design or bible job). */
  record(kind: EstimateKind, model: string, usd: number, ms: number): void {
    if (!(usd >= 0) || !(ms > 0)) return;
    const list = (this.data[kind]![model] ??= []);
    list.push({ usd: Math.round(usd * 1e4) / 1e4, ms: Math.round(ms), at: this.now() });
    while (list.length > KEEP) list.shift();
    this.store.markDirty();
  }

  samples(kind: EstimateKind, model: string): Sample[] {
    return [...(this.data[kind]?.[model] ?? [])];
  }

  /** The [low, high] cost and time of one job of a model, and how that is known. */
  perJob(kind: EstimateKind, model: string): { usd: [number, number]; ms: [number, number]; basis: string } {
    const list = this.data[kind]?.[model] ?? [];
    if (!list.length) {
      if (kind === 'polish') {
        const opus = !model.toLowerCase().includes('sonnet') && !model.toLowerCase().includes('haiku');
        const sd = opus ? POLISH_OPUS_SEED : POLISH_SONNET_SEED;
        return { usd: sd.usd, ms: sd.ms, basis: `polish step ${model}: seed ($${sd.usd[0]}-${sd.usd[1]}, ${sd.ms[0] / MIN}-${sd.ms[1] / MIN} min per step)` };
      }
      if (kind === 'scope') return { usd: SCOPE_FIX_SEED.usd, ms: SCOPE_FIX_SEED.ms, basis: `fix turn ${model}: seed ($0.1-0.4, 1-2 min)` };
      if (kind === 'scoping') return { usd: SCOPING_SEED.usd, ms: SCOPING_SEED.ms, basis: `scoping call ${model}: seed ($0.01-0.03, < 0.3 min)` };
      if (kind === 'massing') return { usd: MASSING.usd, ms: MASSING.ms, basis: `${model}: a massing ($0.12-0.30, 1-3 min), ${SEED_BASIS}` };
      if (kind === 'critic') return { usd: CRITIC_SEED.usd, ms: CRITIC_SEED.ms, basis: `critic ${model}: seed ($${CRITIC_SEED.usd[0]}-${CRITIC_SEED.usd[1]}, ${CRITIC_SEED.ms[0] / MIN}-${CRITIC_SEED.ms[1] / MIN} min per call, smoke 2026-10-06)` };
      if (kind === 'revise') {
        const opus = !model.toLowerCase().includes('sonnet') && !model.toLowerCase().includes('haiku');
        const sd = opus ? REVISE_OPUS_SEED : REVISE_SONNET_SEED;
        return { usd: sd.usd, ms: sd.ms, basis: `revision ${model}: seed ($${sd.usd[0]}-${sd.usd[1]}, ${sd.ms[0] / MIN}-${sd.ms[1] / MIN} min per revision)` };
      }
      const { seed, family } = seedFor(model);
      return { usd: seed.usd, ms: seed.ms, basis: `${model}: seed, ${family}` };
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[], m: number) => Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    const mu = mean(list.map((s) => s.usd));
    const mt = mean(list.map((s) => s.ms));
    const du = Math.max(0.25 * mu, sd(list.map((s) => s.usd), mu));
    const dt = Math.max(0.25 * mt, sd(list.map((s) => s.ms), mt));
    const label = kind === 'critic' ? `critic ${model}` : kind === 'revise' ? `revision ${model}` : kind === 'polish' ? `polish step ${model}` : kind === 'scope' ? `fix turn ${model}` : kind === 'scoping' ? `scoping call ${model}` : model;
    const minMs = kind === 'critic' || kind === 'scoping' ? 5_000 : MIN / 2;
    return { usd: [Math.max(0, mu - du), mu + du], ms: [Math.max(minMs, mt - dt), mt + dt], basis: `${label}: ${list.length} measured (avg $${mu.toFixed(2)}, ${(mt / MIN).toFixed(1)} min)` };
  }

  /**
   * (5a) The critique of one design on top of its design figures: low = one critic call (it ships at once); high = round
   * 0 plus maxRevisions x (revision + critic) + 1 critic, the loop's spend clipped by its cap (critique.budgetUsd, else
   * 1.0x round 0's high) and its time by maxMinutes plus one revision and critic.
   */
  critique(spec: CritiqueSpec | undefined, designModel: string, round0: { usd: [number, number] }, ctx: EstimateCtx, massing = false): { usd: [number, number]; ms: [number, number]; basis: string } | undefined {
    if (!spec || spec.mode === 'off') return undefined;
    const critic = this.perJob('critic', spec.model ?? ctx.criticModel ?? 'claude-sonnet-5-5');
    if (spec.mode === 'report') return { usd: critic.usd, ms: critic.ms, basis: `critique: a report (one critic call; ${critic.basis})` };
    if (spec.mode === 'polish') {
      // (5b) round 0 with a report, then a polish of the new entry: maxSteps x (step + fix turn + critic)
      const step = this.perJob('polish', designModel);
      const fix = this.perJob('scope', designModel);
      const n = Math.max(1, Math.min(3, spec.maxRevisions ?? 2));
      const cap = spec.budgetUsd ?? round0.usd[1];
      const usdHigh = Math.min(cap, critic.usd[1] + n * (step.usd[1] + fix.usd[1] + critic.usd[1]));
      const msHigh = Math.min((spec.maxMinutes ?? 15) * MIN + step.ms[1] + critic.ms[1], critic.ms[1] + n * (step.ms[1] + fix.ms[1] + critic.ms[1]));
      return { usd: [Math.min(critic.usd[0] + step.usd[0] + critic.usd[0], usdHigh), usdHigh], ms: [critic.ms[0] + step.ms[0] + critic.ms[0], msHigh], basis: `critique: a report, then a polish of up to ${n} step${n === 1 ? '' : 's'} (capped at ${spec.budgetUsd !== undefined ? `$${spec.budgetUsd}` : '1.0x the design'}; ${critic.basis}; ${step.basis})` };
    }
    const rev = this.perJob('revise', designModel);
    const n = Math.min(3, spec.maxRevisions ?? (massing ? 1 : 2));
    const cap = spec.budgetUsd ?? round0.usd[1];
    const usdHigh = Math.min(cap, n * (rev.usd[1] + critic.usd[1]) + critic.usd[1]);
    const maxMs = (spec.maxMinutes ?? 15) * MIN + rev.ms[1] + critic.ms[1];
    const msHigh = Math.min(maxMs, n * (rev.ms[1] + critic.ms[1]) + critic.ms[1]);
    return {
      usd: [Math.min(critic.usd[0], usdHigh), usdHigh],
      ms: [critic.ms[0], msHigh],
      basis: `critique: up to ${n} revision${n === 1 ? '' : 's'}, the loop capped at ${spec.budgetUsd !== undefined ? `$${spec.budgetUsd}` : '1.0x the design'} (${critic.basis}; ${rev.basis})`,
    };
  }

  /** A design group's estimate (or one design's: a group of one); with massingFirst, the massing pass plus the detail pass. */
  group(g: Pick<GroupRequest, 'items' | 'concurrency'> & { massingFirst?: boolean | undefined; critique?: CritiqueSpec | undefined }, ctx: EstimateCtx): Estimate {
    const slots = Math.max(1, Math.min(g.concurrency ?? 3, ctx.designConcurrency));
    const passes = [...(g.massingFirst ? [this.pass(g.items, 'massing', () => ctx.massingModel, slots)] : []), this.pass(g.items, 'design', (it) => itemModel(it, ctx), slots)];
    const sum = (f: (p: PassEstimate) => number) => passes.reduce((a, p) => a + f(p), 0);
    const waves = new Set(g.items.map((it) => (it.anchor ? 0 : (it.wave ?? 1)))).size;
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    const n = g.items.length;
    const basis = [
      ...new Set(passes.flatMap((p) => p.bases)),
      `${n} design${n === 1 ? '' : 's'} in ${waves} wave${waves === 1 ? '' : 's'}, ${slots} at a time`,
      ...(g.massingFirst ? [`massing first: ${n} massing${n === 1 ? '' : 's'} before the detail pass (redirects not included)`] : []),
      ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : []),
    ].join('; ');
    const out: Estimate = { usdLow: r2(sum((p) => p.usd[0])), usdHigh: r2(sum((p) => p.usd[1])), minutesLow: r1((sum((p) => p.ms[0]) + wait) / MIN), minutesHigh: r1((sum((p) => p.ms[1]) + wait) / MIN), basis };
    // (5a) critique as separate figures, per item and in total (Steward SHOULD 1)
    const per = g.items.map((it) => {
      const model = itemModel(it, ctx);
      const pj = this.perJob('design', model);
      const c = this.critique((it as { critique?: CritiqueSpec }).critique ?? g.critique, model, pj, ctx);
      return { it, pj, c };
    });
    if (per.some((p) => p.c)) {
      const cs = per.map((p) => p.c);
      out.critiqueUsdLow = r2(cs.reduce((a, c) => a + (c?.usd[0] ?? 0), 0));
      out.critiqueUsdHigh = r2(cs.reduce((a, c) => a + (c?.usd[1] ?? 0), 0));
      // the added wall time: per wave, batches of `slots` (a critic call holds no slot, the revisions do)
      const waveMs = new Map<number, Array<[number, number]>>();
      for (const p of per) {
        const w = p.it.anchor ? 0 : (p.it.wave ?? 1);
        if (!waveMs.has(w)) waveMs.set(w, []);
        waveMs.get(w)!.push(p.c ? p.c.ms : [0, 0]);
      }
      let lo = 0;
      let hi = 0;
      for (const list of waveMs.values()) {
        const batches = Math.ceil(list.length / slots);
        lo += batches * Math.max(...list.map((x) => x[0]));
        hi += batches * Math.max(...list.map((x) => x[1]));
      }
      out.critiqueMinutesLow = r1(lo / MIN);
      out.critiqueMinutesHigh = r1(hi / MIN);
      out.items = per.map((p, i) => ({
        ...((p.it as { itemKey?: string }).itemKey ? { itemKey: (p.it as { itemKey?: string }).itemKey } : g.items.length > 1 ? { itemKey: `item${i + 1}` } : {}),
        usdLow: r2(p.pj.usd[0]),
        usdHigh: r2(p.pj.usd[1]),
        minutesLow: r1(p.pj.ms[0] / MIN),
        minutesHigh: r1(p.pj.ms[1] / MIN),
        ...(p.c ? { critiqueUsdLow: r2(p.c.usd[0]), critiqueUsdHigh: r2(p.c.usd[1]), critiqueMinutesLow: r1(p.c.ms[0] / MIN), critiqueMinutesHigh: r1(p.c.ms[1] / MIN) } : {}),
      }));
      const bases = [...new Set(cs.flatMap((c) => (c ? [c.basis] : [])))];
      out.basis = `${out.basis}; ${bases.join('; ')}; with critique $${r2(out.usdLow + out.critiqueUsdLow)}-${r2(out.usdHigh + out.critiqueUsdHigh)}, ${r1(out.minutesLow + out.critiqueMinutesLow)}-${r1(out.minutesHigh + out.critiqueMinutesHigh)} min`;
    }
    return out;
  }

  /** One pass over the items (massings or designs): the cost adds up, each wave runs in batches of `slots` (a batch takes as long as its slowest item). */
  private pass(items: GroupRequest['items'], kind: 'design' | 'massing', model: (it: GroupRequest['items'][number]) => string, slots: number): PassEstimate {
    const usd: [number, number] = [0, 0];
    const waves = new Map<number, Array<[number, number]>>();
    const bases: string[] = [];
    for (const it of items) {
      const m = model(it);
      const pj = this.perJob(kind, m);
      if (!bases.includes(pj.basis)) bases.push(pj.basis);
      usd[0] += pj.usd[0];
      usd[1] += pj.usd[1];
      const w = it.anchor ? 0 : (it.wave ?? 1);
      if (!waves.has(w)) waves.set(w, []);
      waves.get(w)!.push(pj.ms);
    }
    const ms: [number, number] = [0, 0];
    for (const list of waves.values()) {
      const batches = Math.ceil(list.length / slots);
      ms[0] += batches * Math.max(...list.map((x) => x[0]));
      ms[1] += batches * Math.max(...list.map((x) => x[1]));
    }
    return { usd, ms, bases };
  }

  /** One design's estimate (a massing job's when the request is one). */
  design(req: DesignRequest, ctx: EstimateCtx): Estimate {
    // (0b, C13) a change of an entry (versionOf): the CHANGE seed
    if (req.versionOf) {
      const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
      return { usdLow: CHANGE_SEED.usd[0], usdHigh: CHANGE_SEED.usd[1], minutesLow: r1((CHANGE_SEED.ms[0] + wait) / MIN), minutesHigh: r1((CHANGE_SEED.ms[1] + wait) / MIN), basis: CHANGE_BASIS };
    }
    // (0b, C8) a SMALL detail pass
    if (req.effort === 'small') return { usdLow: SMALL_SEED.usd[0], usdHigh: SMALL_SEED.usd[1], minutesLow: r1(SMALL_SEED.ms[0] / MIN), minutesHigh: r1(SMALL_SEED.ms[1] / MIN), basis: SMALL_BASIS };
    if (req.massing) {
      const model = req.model ?? ctx.massingModel;
      const pj = this.perJob('massing', model);
      const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
      const out: Estimate = { usdLow: r2(pj.usd[0]), usdHigh: r2(pj.usd[1]), minutesLow: r1((pj.ms[0] + wait) / MIN), minutesHigh: r1((pj.ms[1] + wait) / MIN), basis: [pj.basis, 'one massing', ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ') };
      const c = this.critique(req.critique, model, pj, ctx, true);
      if (c) Object.assign(out, { critiqueUsdLow: r2(c.usd[0]), critiqueUsdHigh: r2(c.usd[1]), critiqueMinutesLow: r1(c.ms[0] / MIN), critiqueMinutesHigh: r1(c.ms[1] / MIN), basis: `${out.basis}; ${c.basis}` });
      return out;
    }
    const est = this.group({ items: [{ ...req, model: req.model ?? ctx.designModel } as GroupRequest['items'][number]], concurrency: 1 }, ctx);
    delete est.items;
    return est;
  }

  /**
   * (6c 0a, C5) A mix: a new bible, originals (a massing with massingFirst, a detail pass, its report critique), adapted
   * buildings (a placed design refitted to a new lot: one repair-sized turn, unmeasured until 7b) and copies ($0 and the
   * variant build time). A line per kind; the totals are the sums of the lines. Time: the bible, then the massing pass and
   * the detail pass in batches of the concurrency, then the adapted turns in batches; copies take seconds.
   */
  mix(m0: { group?: Pick<GroupRequest, 'items' | 'massingFirst' | 'critique' | 'concurrency' | 'copyCap' | 'smallBySize'> | undefined; originals: number; adapted: number; copies: number; newBible: boolean; massingFirst: boolean; reportCritique: boolean; model?: string | undefined; smallOriginals?: number | undefined; changes?: number | undefined }, ctx: EstimateCtx): Estimate & { byKind: Partial<Record<MixKind, MixLine>> } {
    // (0b) a group's placements: copies count as COPY, small originals as SMALL, the rest as ORIGINAL
    let m = m0;
    let smallModels = m0.smallOriginals ?? 0;
    if (m0.group && (m0.group.items.some((it) => it.count !== undefined || it.copyOf !== undefined || it.effort !== undefined) || m0.group.smallBySize)) {
      const ex = expandItems({ name: 'estimate', bible: 'x', ...m0.group } as GroupRequest);
      const originals = ex.filter((e) => e.kind === 'original' && e.effort === 'standard').map((e) => ({ ...e.input, itemKey: e.itemKey }));
      smallModels += ex.filter((e) => e.kind === 'original' && e.effort === 'small').length;
      m = { ...m0, group: { ...m0.group, items: originals as GroupRequest['items'] }, copies: m0.copies + ex.filter((e) => e.kind === 'copy').length };
    }
    const slots = Math.max(1, Math.min(m.group?.concurrency ?? 3, ctx.designConcurrency));
    const byKind: Partial<Record<MixKind, MixLine>> = {};
    const bases: string[] = [];
    const line = (k: MixKind, usd: [number, number], ms: [number, number], count: number, basis: string) => {
      byKind[k] = { usdLow: r2(usd[0]), usdHigh: r2(usd[1]), minutesLow: r1(ms[0] / MIN), minutesHigh: r1(ms[1] / MIN), count, basis };
      bases.push(`${k} x${count}: ${basis}`);
    };
    if (m.newBible) {
      const b = this.bible({}, ctx);
      line('bible', [b.usdLow, b.usdHigh], [b.minutesLow * MIN, b.minutesHigh * MIN], 1, b.basis);
    }
    // originals: the group's items (their own models) plus `originals` more of the default model
    const models: string[] = [...(m.group?.items ?? []).map((it) => itemModel(it, ctx)), ...Array.from({ length: m.originals }, () => m.model ?? ctx.ordinaryModel)];
    if (models.length) {
      const massingFirst = m.massingFirst || !!m.group?.massingFirst;
      const report = m.reportCritique || m.group?.critique?.mode === 'report';
      const usd: [number, number] = [0, 0];
      const lb = new Set<string>();
      let detailMs: [number, number] = [0, 0];
      let massMs: [number, number] = [0, 0];
      for (const model of models) {
        const d = this.perJob('design', model);
        lb.add(d.basis);
        usd[0] += d.usd[0];
        usd[1] += d.usd[1];
        detailMs = [Math.max(detailMs[0], d.ms[0]), Math.max(detailMs[1], d.ms[1])];
        // measured samples are design turns only: the report critique is added; the seed already includes it
        if (report && this.samples('design', model).length) {
          const c = this.perJob('critic', ctx.criticModel ?? 'claude-sonnet-5-5');
          usd[0] += c.usd[0];
          usd[1] += c.usd[1];
          lb.add(`report critique: ${c.basis}`);
        }
        if (massingFirst) {
          const ms = this.perJob('massing', ctx.massingModel);
          lb.add(ms.basis);
          usd[0] += ms.usd[0];
          usd[1] += ms.usd[1];
          massMs = [Math.max(massMs[0], ms.ms[0]), Math.max(massMs[1], ms.ms[1])];
        }
      }
      const batches = Math.ceil(models.length / slots);
      line('original', usd, [batches * (detailMs[0] + massMs[0]), batches * (detailMs[1] + massMs[1])], models.length, [...lb].join('; '));
    }
    if (m.adapted > 0) {
      const b = Math.ceil(m.adapted / slots);
      line('adapted', [m.adapted * REPAIR_SEED.usd[0], m.adapted * REPAIR_SEED.usd[1]], [b * REPAIR_SEED.ms[0], b * REPAIR_SEED.ms[1]], m.adapted, 'one repair-sized turn ($0.3-0.9, 1-3 min), unmeasured until 7b');
    }
    if (smallModels > 0) {
      // a SMALL item still gets its massing under massingFirst; it never gets the default report critique
      const ms = m.massingFirst || !!m.group?.massingFirst ? this.perJob('massing', ctx.massingModel) : { usd: [0, 0] as [number, number], ms: [0, 0] as [number, number] };
      const b = Math.ceil(smallModels / slots);
      line('small', [smallModels * (SMALL_SEED.usd[0] + ms.usd[0]), smallModels * (SMALL_SEED.usd[1] + ms.usd[1])], [b * (SMALL_SEED.ms[0] + ms.ms[0]), b * (SMALL_SEED.ms[1] + ms.ms[1])], smallModels, SMALL_BASIS);
    }
    if ((m.changes ?? 0) > 0) {
      const n = m.changes!;
      const b = Math.ceil(n / slots);
      line('change', [n * CHANGE_SEED.usd[0], n * CHANGE_SEED.usd[1]], [b * CHANGE_SEED.ms[0], b * CHANGE_SEED.ms[1]], n, CHANGE_BASIS);
    }
    if (m.copies > 0) line('copy', [0, 0], [m.copies * 200, m.copies * 2000], m.copies, COPY_BASIS);
    const lines = Object.values(byKind);
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    const sum = (f: (l: MixLine) => number) => lines.reduce((a, l) => a + f(l), 0);
    return {
      usdLow: r2(sum((l) => l.usdLow)),
      usdHigh: r2(sum((l) => l.usdHigh)),
      minutesLow: r1(sum((l) => l.minutesLow) + wait / MIN),
      minutesHigh: r1(sum((l) => l.minutesHigh) + wait / MIN),
      basis: [...bases, `${slots} at a time`, ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; '),
      byKind,
    };
  }

  /** A bible job's estimate (about one design; measured separately once bibles finish). */
  bible(req: Partial<BibleRequest>, ctx: EstimateCtx): Estimate {
    const model = req.model ?? ctx.bibleModel;
    const measured = this.data.bible[model]?.length;
    const pj = measured ? this.perJob('bible', model) : { usd: BIBLE.usd, ms: BIBLE.ms, basis: `${model}: a bible job ($1.16-1.55, 5-8 min), ${SEED_BASIS}` };
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    return { usdLow: r2(pj.usd[0]), usdHigh: r2(pj.usd[1]), minutesLow: r1((pj.ms[0] + wait) / MIN), minutesHigh: r1((pj.ms[1] + wait) / MIN), basis: [pj.basis, ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ') };
  }
}

export type MixKind = 'bible' | 'original' | 'adapted' | 'copy' | 'small' | 'change';
export interface MixLine {
  usdLow: number;
  usdHigh: number;
  minutesLow: number;
  minutesHigh: number;
  count: number;
  basis: string;
}

interface PassEstimate {
  usd: [number, number];
  ms: [number, number];
  bases: string[];
}

/** The model a group item designs with: its own, else its role's default (landmark / ordinary). */
export function itemModel(it: { model?: string | undefined; role?: string | undefined }, ctx: Pick<EstimateCtx, 'landmarkModel' | 'ordinaryModel'>): string {
  return it.model ?? (it.role === 'landmark' ? ctx.landmarkModel : ctx.ordinaryModel);
}
