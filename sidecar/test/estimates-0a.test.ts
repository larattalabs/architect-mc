// Phase 6c slice 0a, C5 (docs/CONTRACT.md "Phase 6c slice 0a" §3, §13 item 2): estimates by kind, re-seeded from Steward's
// phase 1. Steward's runs replayed through the estimator with no samples: the cost band contains the real figure and its
// midpoint is within ±25%; the lines per kind sum to the totals. Greywater's time is recorded, not judged (S-0a-5).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Estimates, type EstimateCtx } from '../src/estimates.js';
import { EstimateMix } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { rmrf, tempDir } from './helpers.js';

const ctx: EstimateCtx = {
  designConcurrency: 3,
  now: Date.now(),
  designModel: 'claude-opus-5-5',
  landmarkModel: 'claude-opus-5-5',
  ordinaryModel: 'claude-sonnet-5-5',
  bibleModel: 'claude-opus-5-5',
  massingModel: 'claude-sonnet-5-5',
  criticModel: 'claude-sonnet-5-5',
};

const OUT = process.env.GATE6C0A_OUT;

function withEst<T>(f: (e: Estimates) => T): T {
  const root = tempDir('arch-0a-est-');
  try {
    return f(new Estimates(new Store(root, { debounceMs: 5 })));
  } finally {
    rmrf(root);
  }
}

const sumLines = (e: { byKind: Record<string, { usdLow: number; usdHigh: number; minutesLow: number; minutesHigh: number }> }) =>
  Object.values(e.byKind).reduce((a, l) => ({ usdLow: a.usdLow + l.usdLow, usdHigh: a.usdHigh + l.usdHigh, minutesLow: a.minutesLow + l.minutesLow, minutesHigh: a.minutesHigh + l.minutesHigh }), { usdLow: 0, usdHigh: 0, minutesLow: 0, minutesHigh: 0 });

describe('C5: estimates by kind (seeds, Steward phase 1)', () => {
  it("Steward's runs replayed: Phase 1 ($31.03) and Greywater Hamlet ($13.76) inside the band, midpoint within ±25%", () => {
    const evidence: Record<string, unknown> = {};
    withEst((est) => {
      const p1 = est.mix(EstimateMix.parse({ originals: 8, newBible: true, massingFirst: true, reportCritique: true }), ctx);
      const gw = est.mix(EstimateMix.parse({ originals: 3, newBible: true }), ctx);
      for (const [name, e, real] of [['phase1', p1, 31.03], ['greywater', gw, 13.76]] as const) {
        const mid = (e.usdLow + e.usdHigh) / 2;
        evidence[name] = { real, usdLow: e.usdLow, usdHigh: e.usdHigh, midpoint: Math.round(mid * 100) / 100, off: Math.round(((mid - real) / real) * 1000) / 10, minutes: [e.minutesLow, e.minutesHigh], byKind: e.byKind, basis: e.basis };
        expect(e.usdLow).toBeLessThanOrEqual(real);
        expect(e.usdHigh).toBeGreaterThanOrEqual(real);
        expect(Math.abs(mid - real) / real).toBeLessThanOrEqual(0.25);
        const s = sumLines(e);
        expect(s.usdLow).toBeCloseTo(e.usdLow, 1);
        expect(s.usdHigh).toBeCloseTo(e.usdHigh, 1);
        expect(s.minutesLow).toBeCloseTo(e.minutesLow, 0);
        expect(s.minutesHigh).toBeCloseTo(e.minutesHigh, 0);
        expect(e.basis).toMatch(/Steward phase 1, 2026-10-09/);
      }
      expect(p1.byKind.bible).toMatchObject({ count: 1, usdLow: 1.16, usdHigh: 1.55 });
      expect(p1.byKind.original).toMatchObject({ count: 8 });
      // Greywater's ~70 min was wall clock with the approval wait and play: recorded beside the estimate, not judged
      evidence.greywaterTime = { realMinutes: 70, estimate: [gw.minutesLow, gw.minutesHigh], judged: false };
    });
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'c5.json'), JSON.stringify(evidence, null, 2));
    }
  });

  it('adapted and copy kinds; a group counts as originals', () => {
    withEst((est) => {
      const e = est.mix(EstimateMix.parse({ adapted: 2, copies: 5 }), ctx);
      expect(e.byKind.adapted).toMatchObject({ count: 2, usdLow: 0.6, usdHigh: 1.8 });
      expect(e.byKind.adapted!.basis).toMatch(/unmeasured until 7b/);
      expect(e.byKind.copy).toMatchObject({ count: 5, usdLow: 0, usdHigh: 0 });
      expect(e.byKind.bible).toBeUndefined();
      expect(e.usdLow).toBeCloseTo(0.6, 5);
      const g = est.mix(
        EstimateMix.parse({ group: { name: 'G', bible: 'rustic', massingFirst: true, items: [1, 2, 3].map((i) => ({ itemKey: `i${i}`, type: 'cabin', style: 's', materials: 'm', features: [], maxSize: { x: 20, y: 20, z: 20 } })) }, originals: 1 }),
        ctx,
      );
      expect(g.byKind.original!.count).toBe(4);
      // 4 x (massing + detail)
      expect(g.byKind.original!.usdLow).toBeCloseTo(4 * (0.12 + 2.5), 2);
    });
  });

  it('measured samples replace the detail seed, and then a report critique is added on top', () => {
    withEst((est) => {
      for (const usd of [3, 3, 3]) est.record('design', 'claude-sonnet-5-5', usd, 10 * 60_000);
      const e = est.mix(EstimateMix.parse({ originals: 1, reportCritique: true }), ctx);
      expect(e.byKind.original!.basis).toMatch(/3 measured/);
      expect(e.byKind.original!.basis).toMatch(/report critique/);
      expect(e.usdLow).toBeCloseTo(2.25 + 0.02, 2);
    });
  });
});
