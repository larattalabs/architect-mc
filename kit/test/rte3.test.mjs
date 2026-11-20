// (RTE3) RTE2's leftovers: a following street's pieces read by the route pass's record on them (ext architect_mc:route), not the
// `route_st_<d>` id regex (a long road's groups `route_st_<d>_<n>_<k>`); a grouped growth street's graph identity; Layouts on IRs the
// numbering skip renumbered (the IR fixture shared with the mod's LayoutsRte3Test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emitGrowth, followStreetOf, streetRuns } from '../lib/region/grow.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { districtLand } from '../lib/region/land.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAND = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rte3', 'land-irs.json'), 'utf8'));
/** `kind:id[@revision]` -> cells (a join's or a grown part's: "cells district"), every part listed (a duplicate shows as a second key). */
function summary(land) {
  const out = {};
  for (const p of land.parts) {
    let k = `${p.kind}:${p.id}${p.revision ? `@${p.revision}` : ''}`;
    while (k in out) k += '+';
    out[k] = p.kind === 'join' || p.kind === 'grown' ? `${p.cells} ${p.district}` : p.cells;
  }
  return out;
}

const ROUTE = 'architect_mc:route';

/** A straight east-west road of `len` cells at row z (a run of MIN_RUN or more), with ext. */
const road = (id, z, ext, len = 16) => ({ id, stage: 'routes', part: 'routes', points: [[0, 64, z], [len - 1, 64, z]], width: 3, lanterns: true, ...(ext ? { ext } : {}) });
const runsOf = (roads) => Object.fromEntries(streetRuns({ roads }).map((r) => [r.road, `${r.follow ? 'follow' : 'street'} ${r.district}`]));

// ---- item 1: streetRuns and compile's stampStreets read a following street's district from its route tag

test('followStreetOf: the route tag\'s street edge names the district; another edge\'s piece is no street; untagged is undefined', () => {
  assert.equal(followStreetOf(road('route_st_b_1_2', 0, { [ROUTE]: { edge: 'route_st_b' } })), 'b');
  assert.equal(followStreetOf(road('route_st_b_1_2', 0, { [ROUTE]: { edge: 'route_st_b_1' } })), 'b_1');
  assert.equal(followStreetOf(road('route_st_b_1_2', 0, { [ROUTE]: { edge: 'route_st_b' } }), ['a', 'b_1']), null, 'a district the zone lacks');
  assert.equal(followStreetOf(road('route_d_a__b_1', 0, { [ROUTE]: { edge: 'route_d_a__b' } })), null);
  assert.equal(followStreetOf(road('route_st_b_1', 0)), undefined);
});

test('streetRuns, tagged: a following street\'s long-road groups route_st_<d>_<n>_<k> are d\'s (were read as district <d>_<n>)', () => {
  const st = (d) => ({ [ROUTE]: { edge: `route_st_${d}` }, 'architect_mc:street': { zone: 'z', district: d } });
  assert.deepEqual(runsOf([
    road('route_st_quay_1_1', 0, st('quay')), road('route_st_quay_1_2', 4, st('quay')),
    // (b beside b_1: b's piece 2 group 1, b_1's piece 1 group 2; each its own tag's)
    road('route_st_b_2_1', 8, st('b')), road('route_st_b_1_1_2', 12, st('b_1')),
    // (a district route's piece is never a street run, whatever its id)
    road('route_d_a__b_1', 16, { [ROUTE]: { edge: 'route_d_a__b' } }),
  ]), { route_st_b_1_1_2: 'follow b_1', route_st_b_2_1: 'follow b', route_st_quay_1_1: 'follow quay', route_st_quay_1_2: 'follow quay' });
});

test('streetRuns, untagged: an IR before RTE reads the id as before; a grouped growth street (route_st_quay_1_g1_1) is no follow run, as its ungrouped id is not', () => {
  const band = { 'architect_mc:street': { zone: 'quay', district: 'quay' }, 'architect_mc:band': { district: 'quay', runs: [[0, 0, 15, 0]] } };
  const r = runsOf([
    road('route_st_quay_1', 0, { 'architect_mc:street': { zone: 'quay', district: 'quay' } }),
    road('route_st_b_1_1', 2),
    road('route_st_quay_1_g1', 4, band),
    road('route_st_quay_1_g1_1', 8, band), road('route_st_quay_1_g1_2', 12, band),
    // (an RTE2-era growth's groups that lost their band: a revision's piece (rid) with a _g<n> stem, no district of that id)
    { ...road('route_st_quay_1_g2_1', 16), rid: 2 },
  ]);
  assert.deepEqual(r, { route_st_b_1_1: 'follow b_1', route_st_quay_1: 'follow quay' });
});

test('streetRuns, untagged: a district whose own id ends in _g<n> (quay_g1) keeps its street; a _g<n> stem is a growth only when no district has that id (v0.88.0 review P2)', () => {
  const plan = (ids) => ({ plan: { zones: [{ id: 'z', program: { districts: ids.map((id) => ({ id })) } }] } });
  const legacy = (d) => road(`route_st_${d}_1`, 0, { 'architect_mc:street': { zone: 'z', district: d } });
  // (the plan's districts list names quay_g1; its legacy street, untagged, flagged by the old stampStreets)
  assert.deepEqual(Object.fromEntries(streetRuns({ params: plan(['quay_g1']), roads: [legacy('quay_g1')] }).map((r) => [r.road, `${r.follow} ${r.district}`])), { route_st_quay_g1_1: 'true quay_g1' });
  // (unflagged: the plan's list alone)
  assert.deepEqual(streetRuns({ params: plan(['quay_g1']), roads: [road('route_st_quay_g1_1', 0)] }).map((r) => r.district), ['quay_g1']);
  // (no plan record, no rid: as before RTE3, the id's district)
  assert.deepEqual(streetRuns({ roads: [road('route_st_quay_g1_1', 0)] }).map((r) => r.district), ['quay_g1']);
  // (quay's grown street beside: no district quay_g1, so its _g1 stem is a growth, never a follow run)
  assert.deepEqual(streetRuns({ params: plan(['quay']), roads: [road('route_st_quay_g1_1', 0)] }).map((r) => r.road), []);
});

// ---- item 2: a grouped growth street's graph identity

function surveyOf(W, D, h = 64) {
  const c = makeColumns(0, 0, W, D, 1);
  for (let i = 0; i < W * D; i++) { c.ground[i] = h; c.height[i] = h; c.floor[i] = 0; c.flags[i] = 0; }
  return c;
}

test('a boundary growth\'s street laid as groups: its record lists the groups laid (was the base newRoad, no road\'s id); the graph names the street by its base id', async () => {
  const big = process.env.ARCHITECT_BIG_REGIONS;
  process.env.ARCHITECT_BIG_REGIONS = '1';
  const s = surveyOf(1100, 1100);
  // (a diagonal band street of 2183 cells, past 4e's 2048-cell cap: the ground road splits into groups; RTE2's case)
  const P = [];
  for (let x = 4, z = 4; x <= 1095; ) { P.push([x, 64, z]); if (P.length % 2) x++; else z++; }
  const newRoad = 'route_st_quay_1_g1';
  let out = null;
  const prog = { id: 'rte3_grow', passes: [], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'street']);
    r.graphNode({ id: 'quay_s1', kind: 'junction', ref: 'route_st_quay', at: [4, 65, 4], ports: [{ name: 'route', at: [4, 65, 4], facing: 'up', width: 3 }] });
    out = emitGrowth(r, { prefix: 'quay_', lots: [], extension: { kind: 'boundary', from: 'quay_s1', fromPort: 'route', road: 'route_st_quay_1', newRoad, run: [0, P.length - 1], path: P, mask: [[4, 4, 10, 4]], district: 'quay', zone: 'quay' } },
      { rid: 1, eff: { graph: { nodes: [], edges: [] } }, stages: { ground: 'ground', street: 'street' } });
    r.anchor('entrance', [4, 4]); r.anchor('spawn', [4, 4]);
    return r;
  } };
  let p;
  try { p = await planRegion({ program: prog, programSource: 'x', survey: s, claim: { minX: 0, minZ: 0, maxX: 1099, maxZ: 1099, minY: -64, maxY: 319 }, seed: '7' }); } finally { if (big === undefined) delete process.env.ARCHITECT_BIG_REGIONS; else process.env.ARCHITECT_BIG_REGIONS = big; }
  const laid = p.ir.roads.filter((x) => x.id.startsWith(`${newRoad}_`)).map((x) => x.id);
  assert.ok(laid.length >= 2 && !p.ir.roads.some((x) => x.id === newRoad), `grouped: ${laid}`);
  assert.deepEqual(out.roads, laid, 'the record names what was laid');
  // (the graph: the street's one identity, the base id, as a route edge route_<edge> names its pieces' stem; the end node growPlan's
  // free-end reader finds)
  const mine = p.ir.graph.edges.filter((e) => e.id.startsWith(`${newRoad}#`));
  assert.ok(mine.length >= 1);
  for (const e of mine) assert.equal(e.path, newRoad, e.id);
  for (const n of p.ir.graph.nodes.filter((q) => q.id.startsWith(`${newRoad}_`))) assert.equal(n.ref, newRoad, n.id);
  assert.ok(p.ir.graph.nodes.some((q) => q.id === `${newRoad}_end`));
  // ((v0.87.0 review P2, item 5) through land recomputation, as the effective IR carries the revision: one band, one district part)
  const eff = { ...p.ir, params: { spec: { districts: [{ id: 'quay', follow: { shore: {} } }] } }, roads: p.ir.roads.map((x) => (laid.includes(x.id) ? { ...x, rid: 1 } : x)) };
  const parts = districtLand(eff, null, { revised: true }).parts.filter((q) => q.kind === 'district' && q.id === 'quay' && q.revision === 1);
  assert.equal(parts.length, 1, 'the grouped street\'s band is one district part (was one per group)');
});

// ---- items 5 and 6 (the v0.87.0 review): land's bands once per revision; a malformed route tag reads as untagged (DistrictLandRte3Test)

test('districtLand, grown by a grouped street: its groups\' one band is one district part, revision 1 (was two equal parts)', () => {
  assert.deepEqual(summary(districtLand(LAND.grownGrouped, null, { revised: true })), { 'district:quay@1': 16, 'grown:rv1@1': '311 quay' });
});

test('districtLand, malformed route tags (edge false, edge 17): read as untagged, the same land as rte2\'s untagged IR', () => {
  assert.deepEqual(summary(districtLand(LAND.malformed)), { 'district:a': 25, 'district:b': 3, 'district:b_1': 24, 'join:join': '12 b_1' });
});

// ---- item 4: the renumbered IR the mod's LayoutsRte3Test reads (Regions.layout on it)

test('the Layouts fixture is current and renumbered: b\'s pieces skip n = 1 (route_d_a__b_1 is edge b_1\'s id), each route mixed', async () => {
  const { makeIr, FIXTURE } = await import('../tools/rte3-fixture.mjs');
  const ir = await makeIr();
  assert.equal(fs.readFileSync(FIXTURE, 'utf8'), `${JSON.stringify(ir, null, 1)}\n`, 'kit/test/fixtures/rte3/layout-ir.json is stale: node kit/tools/rte3-fixture.mjs');
  const of = (edge) => [...ir.roads, ...ir.paths].filter((x) => x.ext?.[ROUTE]?.edge === edge).map((x) => x.id).sort();
  assert.deepEqual(of('route_d_a__b'), ['route_d_a__b_2', 'route_d_a__b_3', 'route_d_a__b_4']);
  assert.deepEqual(of('route_d_a__b_1'), ['route_d_a__b_1_1', 'route_d_a__b_1_2', 'route_d_a__b_1_3']);
  assert.ok(ir.paths.every((x) => x.box), 'each route has a boxed section (drawn whole)');
});
