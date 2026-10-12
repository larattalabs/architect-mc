// Slice W item 0 (docs/CONTRACT.md "Phase 6c slice W" §2): the COPY line's ms is the span from each copy's variant job start
// to its done, taken from the job's own timestamps, not from refresh sampling.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateBreakdown, type BreakdownWork } from '../src/breakdown.js';
import type { Group } from '../src/protocol.js';
import type { Sidecar } from '../src/sidecar.js';
import { VariantBook } from '../src/variants.js';
import type { Store } from '../src/store.js';

interface Fx {
  group: Group;
  bd: BreakdownWork;
  designs: Array<{ id: string }>;
  work: Record<string, unknown>;
  variants: Array<{ id: string; status: string; createdAt: number; updatedAt: number; copy?: unknown }>;
}

function fakeSc(now: () => number, fx: Pick<Fx, 'designs' | 'work' | 'variants'>, starts: Record<string, number> = {}): Sidecar {
  return {
    now,
    store: { data: { work: fx.work, variantStarts: starts } },
    designs: { get: (id: string) => fx.designs.find((d) => d.id === id) },
    variants: { get: (id: string) => fx.variants.find((v) => v.id === id) },
  } as unknown as Sidecar;
}

const isOpen = () => true;

describe('the COPY line (W item 0)', () => {
  it("R's recorded group: copy.ms is the sum of its copies' spans; every other line byte-identical", () => {
    const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'breakdown-r.json'), 'utf8')) as Fx;
    const recorded = structuredClone(fx.group.breakdown!);
    const g = structuredClone(fx.group);
    const bw = structuredClone(fx.bd);
    // a refresh at the recorded last tick: no time passes
    updateBreakdown(fakeSc(() => bw.lastTick, fx), g, bw, false, isOpen);
    const spans = fx.variants.reduce((a, v) => a + (v.updatedAt - v.createdAt), 0);
    expect(spans).toBeGreaterThan(0);
    expect(g.breakdown!.stages.copy).toEqual({ usd: 0, ms: spans, count: 4 });
    const other = (b: NonNullable<Group['breakdown']>) => JSON.stringify({ ...b, stages: { ...b.stages, copy: undefined } });
    expect(other(g.breakdown!)).toBe(other(recorded));
  });

  it('4 copies queued, built and done inside one refresh interval: copy.ms > 0, equal to the sum of their spans', () => {
    let t = 1_000_000;
    // the real VariantBook records each job's start (its first non-queued status) in the store
    const data = { variants: [] } as unknown as Store['data'];
    let n = 0;
    const store = { data, markDirty() {}, flush() {}, nextId: (p: string) => `${p}${++n}` } as unknown as Store;
    const book = new VariantBook({ store, emit() {}, now: () => t });
    const variants = [1, 2, 3, 4].map((k) => book.create({ kind: 'variant', from: 'src', copy: { group: 'g1', itemKey: `h#${k + 1}`, archetype: 'h', ordinal: k } }));
    const g = {
      id: 'g1', createdAt: t, cost: { usd: 0 }, bible: { id: 'b', version: 1 },
      items: variants.map((v, i) => ({ itemKey: `h#${i + 2}`, kind: 'copy', status: 'queued', stage: 'copy', designId: '', variantJob: v.id })),
    } as unknown as Group;
    const bw: BreakdownWork = { designs: {}, items: {}, lastTick: t };
    const sc = { now: () => t, store, designs: { get: () => undefined }, variants: book } as unknown as Sidecar;
    updateBreakdown(sc, g, bw, false, isOpen);
    expect(g.breakdown!.stages.copy!.ms).toBe(0);
    // between two refreshes (the refresh interval: 10 s), each copy waits, starts and finishes
    const t0 = t;
    let want = 0;
    variants.forEach((v, i) => {
      t = t0 + 500 + i * 1000;
      book.update(v.id, { status: 'building', step: 'building' });
      const s = t;
      t += 300 + i * 50;
      book.update(v.id, { status: 'done', step: 'done', blueprintId: `c${i}` });
      want += t - s;
    });
    for (const it of g.items) it.status = 'done';
    t = t0 + 10_000;
    updateBreakdown(sc, g, bw, false, isOpen);
    expect(want).toBe(300 * 4 + 50 * 6);
    expect(g.breakdown!.stages.copy).toEqual({ usd: 0, ms: want, count: 4 });
    // later refreshes don't add to it
    t += 10_000;
    updateBreakdown(sc, g, bw, false, isOpen);
    expect(g.breakdown!.stages.copy!.ms).toBe(want);
    expect(g.breakdown!.stages.queued!.ms).toBe(0);
  });
});
