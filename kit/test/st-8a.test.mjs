// (8a ST) Phase 8a slice ST, the kit's half (docs/CONTRACT.md "Phase 8a" §1 and its exception "F3 region-made trees stay paid"):
// - F3's s01_steward_glade plans and evaluates in survival (it threw `opMats[i] is not iterable` in compileSurvival: a fluid op's decor
//   bed is a second compiled op of one IR op, and the survival flags were read by IR op index), and its trees stay paid: no log or leaf
//   is a staged cell (class 3), every log is class 2 (Noah, 2026-11-15: "Keep paid");
// - the survival flags follow each compiled op's own IR op: in v73 (a coral pond and a fountain, both with a decor bed) every fluid op's
//   compiled ops, the bed's included, read as fluid, and no other op does;
// - x03h (the island hamlet): the check bills part `hamlet` 49 dirt for 49 paid grass cells of its green that the flat land already holds
//   (a realise skips them: no target bills them, nothing is consumed). They are the plan's kept paid terrain cells by position
//   (survivalTerrain), so Regions.quote leaves the standing ones out; the check's cost.survival.bom is their upper bound (SA/BC A11). ST's
//   gate compares what a build consumed with the quote, not with the check's per-part bill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compileIR, evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_PAID, CLASS_STAGED } from '../lib/region/survival.mjs';
import { windowOf } from '../lib/region/vworld.mjs';
import { asksSurvey, checkPlanVolumes, FIX, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';

async function survivalCheck(rel) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  return checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, survival: true });
}

async function survivalPlan(rel) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, survival: true });
  return { ir: r.res.ir, blobs: (sha) => r.res.blobs.get(sha) ?? null, s };
}

test('F3 s01_steward_glade evaluates in survival and its trees stay paid (no staged log or leaf)', async () => {
  const { ir, blobs, s } = await survivalPlan('f3/s01_steward_glade.json');
  assert.ok(ir.survival, 'a survival IR');
  let logs = 0, logsPaid = 0, stagedTree = 0;
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const e = evalTile(ir, key, windowOf(s.bytes, key), { stage, set, blobs });
    for (const c of unpack(e.payload).cells) {
      const name = c.state.split('[')[0];
      const tree = /_(log|wood|stem|hyphae)$/.test(name) || /_leaves$/.test(name);
      if (tree && c.cls === CLASS_STAGED) stagedTree++;
      if (/_(log|wood)$/.test(name)) { logs++; if (c.cls === CLASS_PAID) logsPaid++; }
    }
  }
  assert.ok(logs > 0, 'the glade has trees');
  assert.equal(stagedTree, 0, 'no tree cell is staged terrain');
  assert.equal(logsPaid, logs, `every log is paid (${logsPaid} of ${logs})`);
});

test('survival flags follow each compiled op\'s IR op (a decor bed shifts nothing)', async () => {
  const { ir, blobs } = await survivalPlan('valid/v73_f3_coral_pond.json');
  const irOps = ir.parts.flatMap((p) => p.ops ?? []);
  const c = compileIR(ir, { blobs });
  assert.ok(c.ops.length > irOps.length, 'v73 has a decor bed (an extra compiled op)');
  const fluidIr = irOps.filter((o) => o.op === 'fluid').length;
  const fluidCompiled = [...c.survival.opFluid].filter((x) => x === 1).length;
  assert.equal(fluidCompiled, fluidIr + (c.ops.length - irOps.length), 'every fluid op and its bed read as fluid, nothing else');
  // a fluid op's compiled ops come in order, each bed right after its op
  for (let i = 0; i < c.ops.length; i++) if (c.ops[i].cond === 3 && c.ops[i].kind === 2 && i > 0) assert.equal(c.survival.opFluid[i], c.survival.opFluid[i - 1]);
});

test('x03h: the check\'s terrain bill is kept by position, so the quote can leave out what the land holds', async () => {
  const r = await survivalCheck('bf/x03_island_hamlet.json');
  const parts = r.res.check?.parts ?? r.check?.parts ?? [];
  const hamlet = parts.find((p) => p.part === 'hamlet');
  assert.equal(hamlet?.cost?.survival?.bom?.['minecraft:dirt'], 49, 'the check bills the green\'s 49 grass cells as dirt (an upper bound)');
  const kept = (r.res.survivalTerrain?.hamlet ?? []).filter((e) => e.state === 'minecraft:grass_block');
  const cells = kept.reduce((a, e) => a + Buffer.from(e.cells, 'base64').length / 12, 0);
  assert.equal(cells, 49, 'every one is a kept paid terrain cell by position (plan.json survivalTerrain): Regions.quote reads them against the land');
  assert.equal(r.res.survivalTerrainWritten ?? null, null, 'none is always written first by an earlier evaluation (the quote may leave them out)');
});

test('an IR accepted before ST (no survival.opMap) evaluates with the legacy flag mapping it was quoted with', async () => {
  const { ir, blobs } = await survivalPlan('valid/v73_f3_coral_pond.json');
  assert.equal(ir.survival.opMap, 'compiled', 'a new survival IR with a decor bed carries the mark');
  const irOps = ir.parts.flatMap((p) => p.ops ?? []);
  const fresh = compileIR(ir, { blobs });
  const legacyIr = JSON.parse(JSON.stringify(ir));
  delete legacyIr.survival.opMap;
  const legacy = compileIR(legacyIr, { blobs });
  // the legacy mapping reads flags by IR op index: the compiled op after a bed takes the next IR op's flags
  const byIr = Uint8Array.from(irOps.map((o) => (o.op === 'fluid' ? 1 : 0)));
  assert.deepEqual([...legacy.survival.opFluid].slice(0, irOps.length), [...byIr], 'legacy: by IR op index, as v0.41.0-v0.74.0 billed');
  assert.notDeepEqual([...legacy.survival.opFluid], [...fresh.survival.opFluid], 'the two mappings differ on this IR');
  // an IR without a decor bed is never marked (its mappings agree)
  const { ir: x01 } = await survivalPlan('bf/x01_hollow_mountain.json');
  assert.equal(x01.survival.opMap, undefined);
});
