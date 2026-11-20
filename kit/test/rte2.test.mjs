// (RTE2) Ownership read from records, not id prefixes: district b never absorbs district b_1's parts, lots, roads or street (`b_` is a
// prefix of `b_1_`); a join road's long groups (`route_join_<n>_<k>`) are the join's; a districts route pass never lays a piece whose id
// is another edge's id or the start of one (b's `route_d_a__b_1` was edge b_1's id, b's group `route_d_a__b_1_1` b_1's first road).
// The land IRs are shared with the mod's DistrictLandRte2Test (the same numbers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { districtLand } from '../lib/region/land.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { emitGrowth } from '../lib/region/grow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IRS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'rte2', 'land-irs.json'), 'utf8'));
const ROUTE = 'architect_mc:route';

/** `kind:id` -> cells (and the join's district, a grown part's district). */
function summary(land) {
  const out = {};
  for (const p of land.parts) out[`${p.kind}:${p.id}`] = p.kind === 'join' || p.kind === 'grown' ? `${p.cells} ${p.district}` : p.cells;
  return out;
}

test('districtLand, tagged: b and b_1 each get only their own parts, lots, roads and street; the join\'s long groups are the join\'s, its district b_1', () => {
  assert.deepEqual(summary(districtLand(IRS.tagged)), { 'district:a': 25, 'district:b': 9, 'district:b_1': 18, 'join:join': '12 b_1' });
});

test('districtLand, untagged (an IR before RTE): parts by the longest district id; a street piece by the longest following district with that street edge', () => {
  // (route_st_b_1_1 is b's piece 1 group 1 or b_1's piece 1: untagged, the id can't tell; b_1, the district whose street the graph records
  // under the longest id. Never both, as before RTE2)
  assert.deepEqual(summary(districtLand(IRS.untagged)), { 'district:a': 25, 'district:b': 3, 'district:b_1': 24, 'join:join': '12 b_1' });
});

test('districtLand, grown: a revision\'s rv<n>_b_1_ part is b_1\'s alone', () => {
  const s = summary(districtLand(IRS.grown, null, { revised: true }));
  assert.equal(s['grown:rv1'], '1 b_1');
  assert.equal(s['district:b'], 9);
});

// ---- the districts route pass: piece ids never collide with another edge's (item 5)

function surveyOf(W, D, h = 64) {
  const c = makeColumns(0, 0, W, D, 1);
  for (let i = 0; i < W * D; i++) { c.ground[i] = h; c.height[i] = h; c.floor[i] = 0; c.flags[i] = 0; }
  return c;
}
const routeProg = (intent) => ({ id: 'rte2_test', passes: ['route'], default: (ctx) => {
  const r = region(ctx);
  r.stages(['ground']);
  r._route(intent);
  r.anchor('entrance', [4, 4]); r.anchor('spawn', [4, 4]);
  return r;
} });
const planOf = (intent, s) => planRegion({ program: routeProg(intent), programSource: 'x', survey: s, claim: { minX: 0, minZ: 0, maxX: s.width - 1, maxZ: s.depth - 1, minY: -64, maxY: 319 }, seed: '7' });

/**
 * No id reads two ways: every piece's id starts with its edge's id; its number's stem `<edge>_<n>` begins no other piece's id and no other
 * edge's id (b's stem route_d_a__b_1 would: b_1's id and its pieces); no id twice.
 */
function assertUnambiguous(ir) {
  const rids = (ir.graph?.edges ?? []).map((e) => e.id);
  const pieces = [...(ir.roads ?? []), ...(ir.paths ?? [])].filter((x) => x.ext?.[ROUTE]);
  assert.ok(pieces.length > 0);
  const at = (o, stem) => o.startsWith(stem) && !/[0-9]/.test(o.charAt(stem.length));
  for (const x of pieces) {
    const edge = x.ext[ROUTE].edge;
    assert.ok(x.id.startsWith(`${edge}_`), `${x.id} under its edge ${edge}`);
    const stem = `${edge}_${/^\d+/.exec(x.id.slice(edge.length + 1))[0]}`;
    for (const o of rids) if (o !== edge) assert.ok(!at(o, stem), `${x.id}: edge ${o} begins with its stem ${stem}`);
    for (const y of pieces) if (y.ext[ROUTE].edge !== edge) assert.ok(!at(y.id, stem), `${x.id}: ${y.id} (edge ${y.ext[ROUTE].edge}) begins with its stem ${stem}`);
  }
  const ids = pieces.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
}

test('a districts route pass (tagged): b\'s roads-only route never lays route_d_a__b_1, edge b_1\'s id', async () => {
  const s = surveyOf(96, 40);
  const intent = { tagEdges: true, nodes: { a: { at: [8, 65, 8], kind: 'junction' }, b: { at: [80, 65, 8], kind: 'junction' }, b1: { at: [80, 65, 30], kind: 'junction' }, a1: { at: [8, 65, 30], kind: 'junction' } },
    edges: [{ id: 'd_a__b', from: 'a', to: 'b' }, { id: 'd_a__b_1', from: 'a1', to: 'b1' }] };
  const p = await planOf(intent, s);
  assert.ok(p.meta.route.edges.every((e) => e.ok), JSON.stringify(p.meta.route.edges.map((e) => [e.id, e.ok, e.failed])));
  assertUnambiguous(p.ir);
  // (b's pieces skip the number 1: b_1 owns route_d_a__b_1; b_1's own pieces keep theirs)
  assert.ok(p.ir.roads.some((x) => x.id === 'route_d_a__b_1_1' && x.ext[ROUTE].edge === 'route_d_a__b_1'));
  assert.ok(!p.ir.roads.some((x) => x.ext[ROUTE].edge === 'route_d_a__b' && x.id.startsWith('route_d_a__b_1')));
});

test('a districts route pass (tagged): b\'s long first road\'s groups no longer take b_1\'s first road id (was: road id used twice, the plan refused)', async () => {
  // (a ground road over 2048 cells splits into groups <id>_<k>: b's first walk route_d_a__b_1 -> route_d_a__b_1_1, _2)
  // (a diagonal over a 1100 square: 2182 cells, past the cap; a big region, as ARCHITECT_BIG_REGIONS allows)
  const big = process.env.ARCHITECT_BIG_REGIONS;
  process.env.ARCHITECT_BIG_REGIONS = '1';
  const s = surveyOf(1100, 1100);
  const intent = { tagEdges: true, nodes: { a: { at: [4, 65, 4], kind: 'junction' }, b: { at: [1095, 65, 1095], kind: 'junction' }, a1: { at: [40, 65, 4], kind: 'junction' }, b1: { at: [80, 65, 4], kind: 'junction' } },
    edges: [{ id: 'd_a__b', from: 'a', to: 'b' }, { id: 'd_a__b_1', from: 'a1', to: 'b1' }] };
  let p;
  try { p = await planOf(intent, s); } finally { if (big === undefined) delete process.env.ARCHITECT_BIG_REGIONS; else process.env.ARCHITECT_BIG_REGIONS = big; }
  assert.ok(p.meta.route.edges.every((e) => e.ok));
  assert.ok(p.ir.roads.filter((x) => x.ext[ROUTE].edge === 'route_d_a__b').length >= 2, 'b\'s road is grouped');
  assertUnambiguous(p.ir);
});

test('an untagged route pass (not the districts pass) keeps its piece numbers: route_d_a__b_1 is still b\'s first piece', async () => {
  const s = surveyOf(96, 40);
  const intent = { nodes: { a: { at: [8, 65, 8], kind: 'junction' }, b: { at: [80, 65, 8], kind: 'junction' }, b1: { at: [80, 65, 30], kind: 'junction' }, a1: { at: [8, 65, 30], kind: 'junction' } },
    edges: [{ id: 'd_a__b', from: 'a', to: 'b' }, { id: 'd_a__b_1', from: 'a1', to: 'b1' }] };
  const p = await planOf(intent, s);
  assert.ok(p.ir.roads.some((x) => x.id === 'route_d_a__b_1' && !x.ext?.[ROUTE]));
});

// ---- a boundary growth's new street: its flags on every piece the road laid (item 4)

test('a boundary growth\'s street laid as grouped ground roads (<newRoad>_1, _2): every group carries architect_mc:street and architect_mc:band', async () => {
  const big = process.env.ARCHITECT_BIG_REGIONS;
  process.env.ARCHITECT_BIG_REGIONS = '1';
  const s = surveyOf(1100, 1100);
  // (a diagonal band street of 2183 cells: past 4e's 2048-cell cap, so the ground road splits into groups)
  const P = [];
  for (let x = 4, z = 4; x <= 1095; ) { P.push([x, 64, z]); if (P.length % 2) x++; else z++; }
  const newRoad = 'route_st_quay_1_g1';
  const mask = [[4, 4, 10, 4]];
  const prog = { id: 'rte2_grow', passes: [], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'street']);
    r.graphNode({ id: 'quay_s1', kind: 'junction', ref: 'route_st_quay', at: [4, 65, 4], ports: [{ name: 'route', at: [4, 65, 4], facing: 'up', width: 3 }] });
    emitGrowth(r, { prefix: 'quay_', lots: [], extension: { kind: 'boundary', from: 'quay_s1', fromPort: 'route', road: 'route_st_quay_1', newRoad, run: [0, P.length - 1], path: P, mask, district: 'quay', zone: 'quay' } },
      { rid: 1, eff: { graph: { nodes: [], edges: [] } }, stages: { ground: 'ground', street: 'street' } });
    r.anchor('entrance', [4, 4]); r.anchor('spawn', [4, 4]);
    return r;
  } };
  let p;
  try { p = await planRegion({ program: prog, programSource: 'x', survey: s, claim: { minX: 0, minZ: 0, maxX: 1099, maxZ: 1099, minY: -64, maxY: 319 }, seed: '7' }); } finally { if (big === undefined) delete process.env.ARCHITECT_BIG_REGIONS; else process.env.ARCHITECT_BIG_REGIONS = big; }
  const mine = p.ir.roads.filter((x) => x.id === newRoad || x.id.startsWith(`${newRoad}_`));
  assert.ok(mine.length >= 2, `grouped: ${mine.map((x) => x.id)}`);
  for (const x of mine) {
    assert.deepEqual(x.ext?.['architect_mc:street'], { zone: 'quay', district: 'quay' }, x.id);
    assert.deepEqual(x.ext?.['architect_mc:band'], { district: 'quay', runs: mask }, x.id);
  }
});
