// (BC, A11) A survival plan keeps its paid terrain cells by position (plan.json's survivalTerrain): Regions.quote reads the world at each and
// leaves out the cells the land already holds (a realise skips them), so the quote is what the realise consumes. The kept cells are exactly
// the paid terrain cells the bill counts; a building block is never kept; a group past the cap keeps none; the IR is unchanged by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { region } from '../lib/region/program.mjs';
import { TERRAIN_CELLS_MAX, planRegion, survivalTerrainOf } from '../lib/region/plan.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';

const flat = worldOf({ flat: 64 });
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

function prog(ctx) {
  const r = region(ctx);
  r.anchor('spawn', [2, 2]);
  r.anchor('entrance', [3, 2]);
  r.stages(['ground', 'top']);
  r.part('wall', { stage: 'ground' }).fill({ kind: 'box', min: [12, { abs: 65 }, 4], max: [12, { abs: 67 }, 6] }, 'minecraft:stone_bricks', { cond: 0 });
  r.part('mound', { stage: 'ground' }).fill({ kind: 'box', min: [20, { abs: 65 }, 20], max: [22, { abs: 66 }, 21] }, 'minecraft:dirt', { cond: 0 });
  return r;
}

async function plan(survival) {
  const survey = columnsOf(flat, CLAIM.minX, CLAIM.minZ, 64, 64, 1);
  return planRegion({ program: { id: 'bc_inline', default: prog }, programSource: prog.toString(), survey, seed: '42', claim: CLAIM, node: 'test', ...(survival ? { survival: true } : {}) });
}

const decode = (b64) => {
  const b = Buffer.from(b64, 'base64'), out = [];
  for (let i = 0; i + 12 <= b.length; i += 12) out.push([b.readInt32LE(i), b.readInt32LE(i + 4), b.readInt32LE(i + 8)]);
  return out;
};

test('the paid terrain cells are kept by position, one per billed item; building blocks are not', async () => {
  const res = await plan(true);
  assert.ok(res.survivalTerrain, 'survivalTerrain is there');
  assert.equal(res.survivalTerrain.wall, undefined, 'stone bricks are not terrain');
  const rows = res.survivalTerrain.mound;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'minecraft:dirt');
  assert.deepEqual(rows[0].items, { 'minecraft:dirt': 1 });
  const cells = decode(rows[0].cells);
  assert.equal(cells.length, res.survivalBom.mound['minecraft:dirt'], 'one kept cell per billed dirt');
  const want = [];
  for (let x = 20; x <= 22; x++) for (let y = 65; y <= 66; y++) for (let z = 20; z <= 21; z++) want.push(`${x},${y},${z}`);
  assert.deepEqual(cells.map((c) => c.join(',')).sort(), want.sort(), 'the mound\'s cells, in world coordinates');
  assert.ok(!res.irJson.includes('survivalTerrain'), 'outside the IR');
});

test('a creative plan keeps none', async () => {
  assert.equal((await plan(false)).survivalTerrain, undefined);
});

test('a group past the cap keeps none; rows merge by state and sort', () => {
  const big = { g: { terrain: [{ state: 'minecraft:dirt', items: { 'minecraft:dirt': 1 }, cells: new Array((TERRAIN_CELLS_MAX + 1) * 3).fill(0) }] } };
  assert.equal(survivalTerrainOf(big), null);
  const two = { g: { terrain: [{ state: 'minecraft:stone', items: { 'minecraft:cobblestone': 1 }, cells: [1, 2, 3] }, { state: 'minecraft:dirt', items: { 'minecraft:dirt': 1 }, cells: [4, 5, 6] }, { state: 'minecraft:dirt', items: { 'minecraft:dirt': 1 }, cells: [-7, 8, -9] }] } };
  const out = survivalTerrainOf(two);
  assert.deepEqual(out.g.map((r) => r.state), ['minecraft:dirt', 'minecraft:stone']);
  assert.deepEqual(decode(out.g[0].cells), [[4, 5, 6], [-7, 8, -9]]);
});
