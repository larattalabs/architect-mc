// (8a QX) A survival plan counts its staged terrain cells (ARTL class 3) apart, per target group: plan.json's survivalStaged, outside the
// IR, which Regions.quote reads into Quote.terrainCells (docs/CONTRACT.md "Phase 8a" §5). The cells stay inside `free` (survival.cells,
// cost.survival and asks-survival.md do not move) and bill nothing (survivalBom is the paid cells' only). F3's region-made trees stay paid
// (Noah, "Keep paid"): their groups have no staged count; a terrace's and a crater's held terrain is held, not staged, under 8aF.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_STAGED } from '../lib/region/survival.mjs';
import { windowOf } from '../lib/region/vworld.mjs';
import { asksSurvey, checkPlanVolumes, FIX, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';

async function planned(file) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, survival: true });
  const ir = r.res.ir;
  // the class 3 cells each tile emits, per group, read from the tiles' own payloads (not their notes)
  const staged = {};
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const e = evalTile(ir, key, windowOf(s.bytes, key), { stage, set, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    for (const c of unpack(e.payload).cells) if (c.cls === CLASS_STAGED) { const g = ir.survival.groups[c.group]; staged[g] = (staged[g] ?? 0) + 1; }
  }
  return { res: r.res, check: r.check, ir, staged };
}

const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

function common(name, p) {
  const { res, check, ir, staged } = p;
  assert.deepEqual(res.survivalStaged ?? {}, staged, `${name}: survivalStaged is the tiles' class 3 cells per group`);
  for (const [g, n] of Object.entries(res.survivalStaged ?? {})) {
    assert.ok(n > 0, `${name}: ${g} has staged cells`);
    assert.ok(n <= ir.survival.cells[g].free, `${name}: ${g}'s staged cells are inside its free cells`);
  }
  assert.deepEqual(Object.keys(res.survivalStaged ?? {}), Object.keys(res.survivalStaged ?? {}).sort(), `${name}: groups sorted`);
  assert.ok(!res.irJson.includes('survivalStaged') && !res.irJson.includes('"staged":' + '{'), `${name}: outside the IR`);
  for (const c of Object.values(ir.survival.cells)) assert.deepEqual(Object.keys(c), ['free', 'held', 'paid'], `${name}: survival.cells keeps its shape`);
  // nothing staged bills: the plan check's cost.bom is the paid cells' bill, as survivalBom per group sums it
  const bom = {};
  for (const g of Object.values(res.survivalBom ?? {})) for (const [i, n] of Object.entries(g)) bom[i] = (bom[i] ?? 0) + n;
  assert.deepEqual(Object.fromEntries(Object.entries(bom).filter(([, n]) => n).sort()), check.cost.bom, `${name}: the bill is the paid cells'`);
  return res;
}

test('QX: BF x01 hollow mountain: every cell staged, nothing billed', async () => {
  const res = common('x01', await planned('bf/x01_hollow_mountain.json'));
  assert.deepEqual(res.survivalStaged, { hold: 32035 });
  assert.deepEqual(res.survivalBom, { hold: {} });
});

test('QX: BF x03 island hamlet: the island and the hamlet\'s pads staged; the hamlet\'s bill unchanged', async () => {
  const res = common('x03', await planned('bf/x03_island_hamlet.json'));
  assert.deepEqual(res.survivalStaged, { hamlet: 8139, isle: 8884 });
  assert.equal(sum(res.survivalBom.hamlet), 57);
  assert.deepEqual(res.survivalBom.isle, {});
});

test('QX: v05 ice spikes: staged, nothing billed', async () => {
  const res = common('v05', await planned('valid/v05_ice_spike.json'));
  assert.deepEqual(res.survivalStaged, { ice: 1419 });
  assert.deepEqual(res.survivalBom.ice, {});
});

test('QX: v06 terrace: the town\'s pads staged; the steps\' cut and fill held with their walls (8aF), not staged', async () => {
  const res = common('v06', await planned('valid/v06_terrace.json'));
  assert.deepEqual(res.survivalStaged, { town: 10852 });
  assert.equal(res.ir.survival.cells.steps.held, 5506);
  assert.equal(sum(res.survivalBom.steps), 26);
});

test('QX: v72 F3 grove: the trees and mushrooms stay paid (Noah: "Keep paid"), none staged; the village\'s pads staged', async () => {
  const res = common('v72', await planned('valid/v72_f3_grove.json'));
  assert.deepEqual(res.survivalStaged, { village: 8139 });
  for (const [g, n] of Object.entries({ birch: 570, brown: 1751, oak: 1406, red: 743, spruce: 4768 })) {
    assert.equal(sum(res.survivalBom[g]), n, `${g}: billed as today`);
    assert.deepEqual(res.ir.survival.cells[g], { free: 0, held: 0, paid: n }, `${g}: paid cells`);
  }
});

test('QX: BF x02 crater: its terrain is held with the shell, so no group is staged and the field is absent', async () => {
  const res = common('x02', await planned('bf/x02_crater_lake.json'));
  assert.equal(res.survivalStaged, undefined);
});
