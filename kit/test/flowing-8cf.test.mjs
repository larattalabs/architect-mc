// (8cF, docs/CONTRACT.md "Phase 8c" slice 8cF) The frozen shapes: the flowing members of a fluid op (only when given), the kinds
// flowingWater and volume:levels, the UNSETTLED answer (Steward's S-8c-2), and the in-game lane's hand IRs river_demo and fall_island
// through the two-plan flow: clean M25, stable body ids <part>_r<k>, every predicted cell in the declared spill, the requires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey } from './plan-helpers.mjs';
import { planTwice } from './h-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { KINDS_FORMAT2, walkKinds } from '../lib/realise.mjs';
import { FLOWS, LIMITS, UNSETTLED_CAPS, isFlowingOp, unsettledAnswer } from '../lib/fluids/flowing.mjs';
import { fromRuns } from '../lib/fluids/body.mjs';
import * as river from '../regions/river_demo.mjs';
import * as fall from '../regions/fall_island.mjs';

const G = 64;
const CLAIM = { minX: 1000, minZ: 2000, maxX: 1095, maxZ: 2063, minY: -64, maxY: 319 };
const here = path.dirname(new URL(import.meta.url).pathname);

async function plan(mod, file, params = {}, edits = []) {
  const sv = flatSurvey({ W: CLAIM.maxX - CLAIM.minX + 1, D: CLAIM.maxZ - CLAIM.minZ + 1, x0: CLAIM.minX, z0: CLAIM.minZ, y: G, bands: [] });
  const src = fs.readFileSync(path.join(here, '..', 'regions', file), 'utf8');
  const p = await planTwice({ program: mod, programSource: src, params, survey: sv.bytes, seed: '7', claim: sv.claim, node: 'test' }, { edits });
  return { ...p, survey: sv.bytes };
}
const fluidOps = (ir) => ir.parts.flatMap((p) => p.ops.filter((o) => o.op === 'fluid'));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;

test('8cF: the kinds are appended after stagedTerrain and walked from a flow or lip member, never from an H op', () => {
  const i = KINDS_FORMAT2.indexOf('stagedTerrain');
  assert.deepEqual(KINDS_FORMAT2.slice(i, i + 3), ['stagedTerrain', 'flowingWater', 'volume:levels']);
  const op = { op: 'fluid', id: 'b', cells: [] };
  assert.deepEqual(walkKinds({ parts: [{ ops: [op] }] }), ['fluid']);
  assert.ok(walkKinds({ parts: [{ ops: [{ ...op, flow: 'current' }] }] }).includes('flowingWater'));
  assert.ok(walkKinds({ parts: [{ ops: [{ ...op, lip: 'form' }] }] }).includes('flowingWater'));
  assert.ok(walkKinds({ parts: [], volumes: { v: { levels: true, fluids: true } } }).includes('volume:levels'));
  assert.ok(isFlowingOp({ ...op, flow: 'whatever' }), 'an open enum: an unknown flow is still flowing water');
  assert.ok(!isFlowingOp(op));
});

test('8cF: UNSETTLED carries say, the cap that was hit, regionWide and wouldFit; an unknown cap throws', () => {
  const a = unsettledAnswer({ part: 'river', body: 'river_r1', cap: 'cells', cells: 5000, rounds: 12, sample: [[1, 2, 3]] });
  assert.equal(a.class, 'refused');
  const r = a.reasons[0];
  assert.equal(r.code, 'UNSETTLED');
  assert.equal(r.evidence.cap, 'cells');
  assert.equal(r.evidence.limit, LIMITS.cellsPerBody);
  assert.equal(r.evidence.regionWide, false);
  assert.match(r.say, /too long to settle here; it waits/);
  assert.equal(a.wouldFit, undefined);
  const b = unsettledAnswer({ part: 'river', cap: 'regionCells', wouldFit: [{ fragment: { id: 'river', kind: 'channel' }, why: 'shorter', cells: 900 }] });
  assert.equal(b.reasons[0].evidence.regionWide, true);
  assert.match(b.reasons[0].say, /a shorter one fits/);
  assert.equal(b.wouldFit[0].part, 'river');
  assert.deepEqual(unsettledAnswer({ part: 'p', cap: 'rounds', maxRounds: 80 }).reasons[0].evidence.limit, 80);
  assert.throws(() => unsettledAnswer({ part: 'p', cap: 'nope' }));
  assert.deepEqual(UNSETTLED_CAPS, ['rounds', 'cells', 'chunks', 'regionCells', 'regionBodies']);
  assert.ok(FLOWS.includes('current'));
});

for (const [name, mod, file, kinds] of [['river_demo', river, 'river_demo.mjs', ['river', 'pool']], ['fall_island', fall, 'fall_island.mjs', ['header', 'basin']]]) {
  test(`8cF: ${name} plans clean through the two-plan flow; ids <part>_r<k>; its predicted flow in the spill; requires flowingWater`, async () => {
    const p = await plan(mod, file);
    const rep = checkRegion({ ir: p.ir, survey: p.survey, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), meta: p.meta });
    const bad = rep.findings.filter((f) => f.severity === 'error' || f.rule?.startsWith('M25'));
    assert.deepEqual(bad.map((f) => `${f.rule} ${f.message}`), []);
    const ops = fluidOps(p.ir);
    const part = name === 'river_demo' ? 'river' : 'fall';
    assert.deepEqual(ops.map((o) => o.id).sort(), [`${part}_r1`, `${part}_r2`]);
    assert.deepEqual(ops.map((o) => o.kind).sort(), [...kinds].sort());
    assert.ok(p.ir.requires.includes('flowingWater') && p.ir.requires.includes('courses'));
    const head = ops.find((o) => o.id === `${part}_r1`);
    if (name === 'river_demo') assert.equal(head.flow, 'current'); else { assert.equal(head.lip, 'form'); assert.equal(head.on.part, 'fall_island'); }
    const spill = new Set(fromRuns(head.spill).map(k3));
    const flowing = head.predicted.filter((q) => q[3] > 0);
    assert.ok(flowing.length >= (name === 'river_demo' ? 100 : 30), `a long flow (${flowing.length} cells)`);
    for (const q of head.predicted) assert.ok(spill.has(k3(q)), `predicted ${q} is in the declared spill`);
    if (name === 'river_demo') {
      assert.equal(fromRuns(head.wash).length, 4, 'the meadow\'s 4 flower cells are washed');
      for (const c of fromRuns(head.wash)) assert.ok(spill.has(k3(c)), 'a wash cell is a predicted cell');
    }
  });
}

test('8cF: river_demo nowash leaves the wash list out (the mint case\'s control)', async () => {
  const p = await plan(river, 'river_demo.mjs', { variant: 'nowash' });
  assert.equal(fluidOps(p.ir).find((o) => o.id === 'river_r1').wash, undefined);
});

test('8c: W3 breach cells feed KC keep-out: a lot over the head\'s breach reach (its watch) is met (LEAK), and the registry keeps the reach', async () => {
  const { reachMeetsKeep } = await import('../lib/fluids/place.mjs');
  const { keepStore, registerBody, keptBy } = await import('../lib/fluids/keep.mjs');
  const p = await plan(river, 'river_demo.mjs');
  const op = fluidOps(p.ir).find((o) => o.id === 'river_r1');
  const rec = { id: op.id, part: op.part, cells: fromRuns(op.cells), shell: fromRuns(op.shell), spill: fromRuns(op.spill), watch: fromRuns(op.watch), lining: fromRuns(op.lining ?? []) };
  assert.ok(rec.watch.length > 0, 'the head has a single-breach reach');
  const own = new Set([...rec.cells, ...rec.shell, ...rec.spill, ...rec.lining].map(k3));
  // a breach cell no other set holds, and a 1 x 1 module lot two cells past it (keepReason grows a lot's box by 1)
  const w = rec.watch.find((c) => !own.has(k3(c)));
  assert.ok(w, 'a breach cell outside the body\'s other sets');
  const env = { claim: { minX: CLAIM.minX, minZ: CLAIM.minZ, maxX: CLAIM.maxX, maxZ: CLAIM.maxZ }, protectedAreas: [], keepOut: [], buildRects: [], regions: [] };
  const lot = { id: 'm1', box: { minX: w[0] + 1, maxX: w[0] + 1, minZ: w[2], maxZ: w[2], minY: w[1], maxY: w[1] } };
  const hit = reachMeetsKeep({ lots: [lot] }, env, { ...rec, cells: [], shell: [], spill: [], watch: [w] });
  assert.ok(hit && hit.reasons.includes('lot m1'), `the breach reach meets the lot (${JSON.stringify(hit)})`);
  assert.equal(reachMeetsKeep({ lots: [] }, env, rec), null, 'river_demo on its own claim meets nothing');
  const store = keepStore({});
  registerBody(store, rec);
  assert.equal(keptBy(store, ...w).set, 'watch', 'the registry keeps the breach reach (KC: no later part stands there)');
});
