// (M5 QT) A survival plan keeps its paid cells' bill per target group (plan.json's survivalBom, docs/CONTRACT.md "M5 support" slice QT):
// Regions.quote bills the region's cells by it. The bill equals the tiles' own (evalTile's notes.survival, the plan check's cost.bom of the
// cells); a creative plan has none; the IR is unchanged by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { region } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile } from '../lib/realise.mjs';
import { columnsOf, windowOf, worldOf } from './region-helpers.mjs';

const flat = worldOf({ flat: 64 });
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

function prog(ctx) {
  const r = region(ctx);
  r.anchor('spawn', [2, 2]);
  r.anchor('entrance', [3, 2]);
  r.stages(['ground', 'top']);
  const w = r.part('wall', { stage: 'ground' });
  w.fill({ kind: 'box', min: [12, { abs: 65 }, 4], max: [12, { abs: 67 }, 6] }, 'minecraft:stone_bricks', { cond: 0 });
  w.fill({ kind: 'box', min: [14, { abs: 65 }, 4], max: [14, { abs: 65 }, 6] }, 'minecraft:dirt', { cond: 0, terrain: true });
  r.part('tower', { stage: 'top' }).fill({ kind: 'box', min: [30, { abs: 65 }, 30], max: [31, { abs: 70 }, 31] }, 'minecraft:oak_planks', { cond: 0 });
  r.part('land', { stage: 'ground' }).fill({ kind: 'box', min: [4, { abs: 65 }, 4], max: [5, { abs: 66 }, 5] }, 'minecraft:stone', { terrain: true });
  return r;
}

async function plan(survival) {
  const survey = columnsOf(flat, CLAIM.minX, CLAIM.minZ, 64, 64, 1);
  return planRegion({ program: { id: 'qt_inline', default: prog }, programSource: prog.toString(), survey, seed: '42', claim: CLAIM, node: 'test', ...(survival ? { survival: true } : {}) });
}

test('a survival plan keeps survivalBom: per group, the paid cells\' bill the tiles carry', async () => {
  const res = await plan(true);
  const ir = res.ir;
  assert.ok(res.survivalBom, 'survivalBom is there');
  const want = {};
  for (const s of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[s][set]) {
    const e = evalTile(ir, key, windowOf(flat, key), { stage: s, set, countOnly: true, blobs: (sha) => res.blobs.get(sha) });
    for (const [g, x] of Object.entries(e.notes.survival ?? {})) {
      want[g] ??= {};
      for (const [i, n] of Object.entries(x.bom ?? {})) want[g][i] = (want[g][i] ?? 0) + n;
    }
  }
  assert.deepEqual(Object.keys(res.survivalBom), Object.keys(ir.survival.cells), 'one entry per target group, as the IR\'s cells');
  for (const g of Object.keys(res.survivalBom)) assert.deepEqual(res.survivalBom[g], want[g] ?? {}, `group ${g}`);
  assert.deepEqual(res.survivalBom.wall, { 'minecraft:stone_bricks': 9 }, 'the wall\'s body paid; its terrain dirt held, not billed');
  assert.deepEqual(res.survivalBom.tower, { 'minecraft:oak_planks': 24 });
  assert.deepEqual(res.survivalBom.land ?? {}, {}, 'a terrain fill is free');
  for (const g of Object.values(res.survivalBom)) assert.deepEqual(Object.keys(g), [...Object.keys(g)].sort(), 'items sorted');
});

test('a creative plan has no survivalBom', async () => {
  const res = await plan(false);
  assert.equal(res.survivalBom, undefined);
  assert.equal(res.ir.survival, undefined);
});

test('survivalBom lies outside the IR: the survival IR\'s JSON and sha do not carry it', async () => {
  const a = await plan(true);
  const b = await plan(true);
  assert.equal(a.irSha, b.irSha, 'deterministic');
  assert.ok(!a.irJson.includes('survivalBom'));
  assert.deepEqual(Object.keys(a.ir.survival.cells.wall), ['free', 'held', 'paid'], 'the IR\'s cells member keeps its shape');
});
