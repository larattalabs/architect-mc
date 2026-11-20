// (RTE4) The RTE readers' compatibility corpus (kit/tools/rte-compat-fixture.mjs): every IR v0.85.0..v0.88.0 planned and grew there, as
// each release wrote it (route tags and its numbering included), reads in this tree exactly as v0.88.0 read it: each district's route ends
// and free ends (grow.mjs streetRouteEnds), a growth's plan (growPlan, prefer extend), streetRuns and architect_mc:land.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../tools/rte-compat-fixture.mjs';
import { kitAt, readers, rounds, surveyOf } from '../tools/rte-compat-worker.mjs';
import { streetRouteEnds } from '../lib/region/grow.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('rte-compat: every corpus IR (v0.85.0..v0.88.0, each round) reads exactly as v0.88.0 read it', async () => {
  const corpus = loadCorpus();
  const K = await kitAt(ROOT);
  assert.ok(corpus.cases.length >= 100, `cases: ${corpus.cases.length}`);
  assert.deepEqual(corpus.versions, ['v0.85.0', 'v0.86.0', 'v0.87.0', 'v0.88.0']);
  const bad = [];
  let n = 0;
  for (const c of corpus.cases) {
    const effs = rounds(K, c);
    assert.equal(effs.length, c.expected.length, c.key);
    effs.forEach((eff, k) => {
      n++;
      const got = readers(K, eff, surveyOf(K, c.recipe)), want = c.expected[k];
      for (const key of Object.keys(want)) if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) bad.push(`${c.key} round ${k} ${key}: got ${JSON.stringify(got[key])}, v0.88.0 ${JSON.stringify(want[key])}`);
    });
  }
  assert.ok(n >= 300, `effective IRs: ${n}`);
  assert.deepEqual(bad, []);
});

// ---- (v0.89.0 release review P2-1) v0.86.0's numbering, route tags present: district b's growth street route_st_b_1_g1 beside district
// b_1_g1's route edge route_st_b_1_g1. v0.88.0 gives the grown end to b; RTE4's first reader gave it to b_1_g1 (a route edge its pieces name)

const ids = (r) => ({ ends: r.ends.map((n) => n.id), free: r.free.map((n) => n.id) });

test('rte-compat, the reviewer\'s case: v0.86.0\'s b / b_1_g1 plan grown once, b\'s grown end route_st_b_1_g1_end is b\'s, as v0.88.0', async () => {
  const c = loadCorpus().cases.find((x) => x.key === 'v0.86.0/shore_b_1_g1-b_1');
  const K = await kitAt(ROOT);
  const eff = rounds(K, c)[1];
  assert.ok(eff.roads.some((r) => r.id === 'route_st_b_1_1' || r.id === 'route_st_b_1') && eff.graph.edges.some((e) => e.id === 'route_st_b_1_g1'), 'b_1_g1\'s route edge beside b\'s growth');
  assert.deepEqual(ids(streetRouteEnds(eff, 'b')), { ends: ['b_s0', 'b_s1', 'route_st_b_1_g1_end'], free: ['route_st_b_1_g1_end'] });
  assert.deepEqual(ids(streetRouteEnds(eff, 'b_1_g1')), { ends: ['b_1_g1_s0', 'b_1_g1_s1'], free: [] });
});

test('rte-compat: this tree grows b on v0.86.0\'s b / b_1_g1 plan: its street\'s pieces name b, so its end is b\'s, never b_1_g1\'s (same ids as the reviewer\'s case)', async () => {
  const c = loadCorpus().cases.find((x) => x.key === 'v0.86.0/shore_b_1_g1-b_1');
  const K = await kitAt(ROOT);
  const S = surveyOf(K, c.recipe);
  const eff0 = mergeEffective(c.ir);
  const st = revisionStanding({ id: 'rc', claim: [S.claim.minX, S.claim.minZ, S.claim.maxX, S.claim.maxZ], effective: eff0, held: { runs: [], town: [], terrain: [] } });
  const r = await reviseIR(eff0, { grow: { district: 'b', lots: 2, prefer: 'extend' } }, { rid: 1, position: 1, parent: { rid: 0, irSha: null }, base: { irSha: null }, survey: S.cols, standing: st });
  assert.equal(r.ir.revision.grow.extension.road, 'route_st_b_1_g1');
  assert.ok(r.ir.roads.every((x) => x.ext?.['architect_mc:district']?.id === 'b'), 'the growth\'s pieces name b');
  const eff = mergeEffective(c.ir, [{ rid: 1, position: 1, ir: r.ir }]);
  assert.deepEqual(ids(streetRouteEnds(eff, 'b')).free, ['route_st_b_1_g1_end']);
  assert.deepEqual(ids(streetRouteEnds(eff, 'b_1_g1')), { ends: ['b_1_g1_s0', 'b_1_g1_s1'], free: [] });
});
