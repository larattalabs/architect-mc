// Cost and time estimates (docs/CONTRACT.md phase 4b, "4b review folded in" item 2): `design.estimate` and
// `bible.estimate` answer { usdLow, usdHigh, minutesLow, minutesHigh, basis }, computed from a rolling per-model average
// of finished designs and bible jobs (the last 20 of each, persisted in state.json), the concurrency and the current
// usage-limit state. Until a model has measurements the seeds stand in, measured in the phase 4b gate (2026-10-05):
// an Opus design $2.0-3.2 and 8-13 min, a Sonnet design $0.8-2.5 and 4-10 min, a bible job $1.2-2.0 and 5-8 min (the
// phase 1-2 Opus figure of $1-1.5 was for smaller, simpler designs). Only the Claude backend records samples.
// Phase 4c adds the `massing` kind (seeded at $0.10-0.40 and 1-3 min, the contract's figure until the gate measures it);
// a group with massingFirst estimates both passes (redirects are not in the estimate: they are the player's choice).
import type { BibleRequest, DesignRequest, Estimate, GroupRequest } from './protocol.js';
import type { Store } from './store.js';

export interface Sample {
  usd: number;
  ms: number;
  at: number;
}

export type EstimateKind = 'design' | 'bible' | 'massing';
export interface EstimateData {
  design: Record<string, Sample[]>;
  bible: Record<string, Sample[]>;
  /** (4c) */
  massing: Record<string, Sample[]>;
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
}

export class Estimates {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  private get data(): EstimateData {
    const d = (this.store.data.estimates ??= { design: {}, bible: {}, massing: {} });
    d.design ??= {};
    d.bible ??= {};
    d.massing ??= {};
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
    const list = (this.data[kind][model] ??= []);
    list.push({ usd: Math.round(usd * 1e4) / 1e4, ms: Math.round(ms), at: this.now() });
    while (list.length > KEEP) list.shift();
    this.store.markDirty();
  }

  samples(kind: EstimateKind, model: string): Sample[] {
    return [...(this.data[kind][model] ?? [])];
  }

  /** The [low, high] cost and time of one job of a model, and how that is known. */
  perJob(kind: EstimateKind, model: string): { usd: [number, number]; ms: [number, number]; basis: string } {
    const list = this.data[kind][model] ?? [];
    if (!list.length) {
      if (kind === 'massing') return { usd: MASSING.usd, ms: MASSING.ms, basis: `${model}: seed, a massing ($0.10-0.40, 1-3 min)` };
      const { seed, family } = seedFor(model);
      return { usd: seed.usd, ms: seed.ms, basis: `${model}: seed, ${family}` };
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[], m: number) => Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    const mu = mean(list.map((s) => s.usd));
    const mt = mean(list.map((s) => s.ms));
    const du = Math.max(0.25 * mu, sd(list.map((s) => s.usd), mu));
    const dt = Math.max(0.25 * mt, sd(list.map((s) => s.ms), mt));
    return { usd: [Math.max(0, mu - du), mu + du], ms: [Math.max(MIN / 2, mt - dt), mt + dt], basis: `${model}: ${list.length} measured (avg $${mu.toFixed(2)}, ${(mt / MIN).toFixed(1)} min)` };
  }

  /** A design group's estimate (or one design's: a group of one); with massingFirst, the massing pass plus the detail pass. */
  group(g: Pick<GroupRequest, 'items' | 'concurrency'> & { massingFirst?: boolean | undefined }, ctx: EstimateCtx): Estimate {
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
    return { usdLow: r2(sum((p) => p.usd[0])), usdHigh: r2(sum((p) => p.usd[1])), minutesLow: r1((sum((p) => p.ms[0]) + wait) / MIN), minutesHigh: r1((sum((p) => p.ms[1]) + wait) / MIN), basis };
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
      const pj = this.perJob('massing', req.model ?? ctx.massingModel);
      const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
      return { usdLow: r2(pj.usd[0]), usdHigh: r2(pj.usd[1]), minutesLow: r1((pj.ms[0] + wait) / MIN), minutesHigh: r1((pj.ms[1] + wait) / MIN), basis: [pj.basis, 'one massing', ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ') };
    }
    return this.group({ items: [{ ...req, model: req.model ?? ctx.designModel } as GroupRequest['items'][number]], concurrency: 1 }, ctx);
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
