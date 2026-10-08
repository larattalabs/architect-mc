// Cost and time estimates (docs/CONTRACT.md phase 4b, "4b review folded in" item 2): `design.estimate` and
// `bible.estimate` answer { usdLow, usdHigh, minutesLow, minutesHigh, basis }, computed from a rolling per-model average
// of finished designs and bible jobs (the last 20 of each, persisted in state.json), the concurrency and the current
// usage-limit state. Until a model has measurements the seeds stand in, measured in the phase 4b gate (2026-10-05):
// an Opus design $2.0-3.2 and 8-13 min, a Sonnet design $0.8-2.5 and 4-10 min, a bible job $1.2-2.0 and 5-8 min (the
// phase 1-2 Opus figure of $1-1.5 was for smaller, simpler designs). Only the Claude backend records samples.
// Phase 4c adds the `massing` kind (seeded at $0.10-0.40 and 1-3 min, the contract's figure until the gate measures it);
// a group with massingFirst estimates both passes (redirects are not in the estimate: they are the player's choice).
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
const OPUS: Seed = { usd: [2.0, 3.2], ms: [8 * MIN, 13 * MIN] };
/** Sonnet design seed, measured 2026-10-05 (4 real designs in the phase 4b gate: $0.86-2.45, 4-10 min). */
/** Bible job seed, measured 2026-10-05 (one real bible: $1.40, 6.4 min). */
const BIBLE: Seed = { usd: [1.2, 2.0], ms: [5 * MIN, 8 * MIN] };
const SONNET: Seed = { usd: [0.8, 2.5], ms: [4 * MIN, 10 * MIN] };
/** (4c) Massing job seed: the contract's $0.10-0.40 and 1-3 min (Sonnet, effort low), to be measured in the 4c gate. */
const MASSING: Seed = { usd: [0.1, 0.4], ms: [1 * MIN, 3 * MIN] };
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
  if (m.includes('sonnet')) return { seed: SONNET, family: 'sonnet ($0.8-2.5, 4-10 min per design, measured 2026-10-05)' };
  if (m.includes('haiku')) return { seed: { usd: [OPUS.usd[0] * 0.15, OPUS.usd[1] * 0.15], ms: [OPUS.ms[0] * 0.6, OPUS.ms[1] * 0.6] }, family: 'haiku (0.15x the Opus cost, unmeasured)' };
  return { seed: OPUS, family: 'opus ($2.0-3.2, 8-13 min per design, measured 2026-10-05)' };
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
      if (kind === 'massing') return { usd: MASSING.usd, ms: MASSING.ms, basis: `${model}: seed, a massing ($0.10-0.40, 1-3 min)` };
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

  /** A bible job's estimate (about one design; measured separately once bibles finish). */
  bible(req: Partial<BibleRequest>, ctx: EstimateCtx): Estimate {
    const model = req.model ?? ctx.bibleModel;
    const measured = this.data.bible[model]?.length;
    const pj = measured ? this.perJob('bible', model) : { usd: BIBLE.usd, ms: BIBLE.ms, basis: `${model}: seed, a bible job ($1.2-2.0, 5-8 min, measured 2026-10-05)` };
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    return { usdLow: r2(pj.usd[0]), usdHigh: r2(pj.usd[1]), minutesLow: r1((pj.ms[0] + wait) / MIN), minutesHigh: r1((pj.ms[1] + wait) / MIN), basis: [pj.basis, ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ') };
  }
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
