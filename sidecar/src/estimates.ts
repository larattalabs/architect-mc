// Cost and time estimates (docs/CONTRACT.md phase 4b, "4b review folded in" item 2): `design.estimate` and
// `bible.estimate` answer { usdLow, usdHigh, minutesLow, minutesHigh, basis }, computed from a rolling per-model average
// of finished designs and bible jobs (the last 20 of each, persisted in state.json), the concurrency and the current
// usage-limit state. Until a model has measurements the seeds stand in: an Opus design costs about $1.0-1.5 and takes
// 4-6 minutes (measured in phases 1-2); Sonnet is unmeasured and seeded at 0.4x the Opus cost (same time); a bible
// job is about one design. Only the Claude backend records samples (the sim would poison the averages).
import type { BibleRequest, DesignRequest, Estimate, GroupRequest } from './protocol.js';
import type { Store } from './store.js';

export interface Sample {
  usd: number;
  ms: number;
  at: number;
}

export type EstimateKind = 'design' | 'bible';
export interface EstimateData {
  design: Record<string, Sample[]>;
  bible: Record<string, Sample[]>;
}

const KEEP = 20;
const MIN = 60_000;
interface Seed {
  usd: [number, number];
  ms: [number, number];
}
const OPUS: Seed = { usd: [1.0, 1.5], ms: [4 * MIN, 6 * MIN] };

/** The seed of a model family (by its id). */
export function seedFor(model: string): { seed: Seed; family: string } {
  const m = model.toLowerCase();
  if (m.includes('sonnet')) return { seed: { usd: [OPUS.usd[0] * 0.4, OPUS.usd[1] * 0.4], ms: OPUS.ms }, family: 'sonnet (0.4x the Opus cost, unmeasured)' };
  if (m.includes('haiku')) return { seed: { usd: [OPUS.usd[0] * 0.15, OPUS.usd[1] * 0.15], ms: [OPUS.ms[0] * 0.6, OPUS.ms[1] * 0.6] }, family: 'haiku (0.15x the Opus cost, unmeasured)' };
  return { seed: OPUS, family: 'opus ($1.0-1.5, 4-6 min per design)' };
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
}

export class Estimates {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  private get data(): EstimateData {
    const d = (this.store.data.estimates ??= { design: {}, bible: {} });
    d.design ??= {};
    d.bible ??= {};
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

  /** A design group's estimate (or one design's: a group of one). */
  group(g: Pick<GroupRequest, 'items' | 'concurrency'>, ctx: EstimateCtx): Estimate {
    const slots = Math.max(1, Math.min(g.concurrency ?? 3, ctx.designConcurrency));
    let usdLo = 0;
    let usdHi = 0;
    const waves = new Map<number, Array<{ ms: [number, number] }>>();
    const bases = new Map<string, string>();
    for (const it of g.items) {
      const model = itemModel(it, ctx);
      const pj = this.perJob('design', model);
      bases.set(model, pj.basis);
      usdLo += pj.usd[0];
      usdHi += pj.usd[1];
      const w = it.anchor ? 0 : (it.wave ?? 1);
      if (!waves.has(w)) waves.set(w, []);
      waves.get(w)!.push({ ms: pj.ms });
    }
    // each wave runs in batches of `slots`; a batch takes as long as its slowest item
    let msLo = 0;
    let msHi = 0;
    for (const items of waves.values()) {
      const batches = Math.ceil(items.length / slots);
      msLo += batches * Math.max(...items.map((i) => i.ms[0]));
      msHi += batches * Math.max(...items.map((i) => i.ms[1]));
    }
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    const basis = [...bases.values(), `${g.items.length} design${g.items.length === 1 ? '' : 's'} in ${waves.size} wave${waves.size === 1 ? '' : 's'}, ${slots} at a time`, ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ');
    return { usdLow: r2(usdLo), usdHigh: r2(usdHi), minutesLow: r1((msLo + wait) / MIN), minutesHigh: r1((msHi + wait) / MIN), basis };
  }

  /** One design's estimate. */
  design(req: DesignRequest, ctx: EstimateCtx): Estimate {
    return this.group({ items: [{ ...req, model: req.model ?? ctx.designModel } as GroupRequest['items'][number]], concurrency: 1 }, ctx);
  }

  /** A bible job's estimate (about one design; measured separately once bibles finish). */
  bible(req: Partial<BibleRequest>, ctx: EstimateCtx): Estimate {
    const model = req.model ?? ctx.bibleModel;
    const measured = this.data.bible[model]?.length;
    const pj = measured ? this.perJob('bible', model) : { ...this.perJob('design', model), basis: `${model}: about one design (no bible measured yet): ${this.perJob('design', model).basis}` };
    const wait = ctx.limitUntil && ctx.limitUntil > ctx.now ? ctx.limitUntil - ctx.now : 0;
    return { usdLow: r2(pj.usd[0]), usdHigh: r2(pj.usd[1]), minutesLow: r1((pj.ms[0] + wait) / MIN), minutesHigh: r1((pj.ms[1] + wait) / MIN), basis: [pj.basis, ...(wait ? [`a usage limit holds new turns for ${Math.ceil(wait / MIN)} min`] : [])].join('; ') };
  }
}

/** The model a group item designs with: its own, else its role's default (landmark / ordinary). */
export function itemModel(it: { model?: string | undefined; role?: string | undefined }, ctx: Pick<EstimateCtx, 'landmarkModel' | 'ordinaryModel'>): string {
  return it.model ?? (it.role === 'landmark' ? ctx.landmarkModel : ctx.ordinaryModel);
}
