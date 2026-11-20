// (RTE3) RTE2's leftovers: a following street's pieces read by the route pass's record on them (ext architect_mc:route), not the
// `route_st_<d>` id regex (a long road's groups `route_st_<d>_<n>_<k>`); a grouped growth street's graph identity; Layouts on IRs the
// numbering skip renumbered (the IR fixture shared with the mod's LayoutsRte3Test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emitGrowth, followStreetOf, growPlan, streetRuns, MIN_RUN } from '../lib/region/grow.mjs';
import { toLocal } from '../lib/region/village.mjs';
import { isStreetId } from '../lib/region/beside.mjs';
import { mergeEffective, revisionStanding } from '../lib/region/revise.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
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

// ---- (the coordinator's call, v0.88.0 fix check) untagged pieces read exactly as origin/main's streetRuns: the oracle below is main's
// function (v0.87.0, grow.mjs streetRuns and districtOfRoad, copied verbatim); a tagged piece reads its route tag

function districtOfRoadMain(rd) {
  const f = rd.ext?.['architect_mc:street'];
  if (f && typeof f.district === 'string') return f.district;
  const m = /^(.*?)_?street_[a-z0-9_]*$/.exec(rd.id);
  return m && m[1] ? m[1] : null;
}
function streetRunsMain(eff) {
  const out = [];
  for (const rd of eff.roads ?? []) {
    const flagged = !!rd.ext?.['architect_mc:street'];
    if (!flagged && !isStreetId(rd.id)) continue;
    const fm = /^route_st_([a-z][a-z0-9_]*?)_\d+$/.exec(rd.id);
    if (!fm && (/^(route_)?st_/.test(rd.id) || /^route_/.test(rd.id))) continue;
    const pts = rd.points ?? [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      let o;
      if (a[2] === b[2] && a[0] !== b[0]) o = 'ew'; else if (a[0] === b[0] && a[2] !== b[2]) o = 'ns'; else continue;
      const [ua, c] = toLocal(o, a[0], a[2]), [ub] = toLocal(o, b[0], b[2]);
      const u0 = Math.min(ua, ub), u1 = Math.max(ua, ub);
      if (u1 - u0 + 1 < MIN_RUN && pts.length > 2) continue;
      if (fm && u1 - u0 + 1 < MIN_RUN) continue;
      const d = fm ? fm[1] : districtOfRoadMain(rd);
      out.push({ road: rd.id, seg: i, o, c, u0, u1, y: a[1] ?? b[1] ?? null, width: rd.width ?? 3, lanterns: rd.lanterns !== false, lamp: rd.lamp ?? null, surface: rd.surface ?? null,
        ext: rd.ext ?? null, district: d, prefix: d ? `${d}_` : '', twoPoint: pts.length === 2 && !fm, follow: !!fm, grown: Number.isInteger(rd.rid) && rd.rid > 0 });
    }
  }
  return out.sort((p, q) => (p.road < q.road ? -1 : p.road > q.road ? 1 : p.seg - q.seg));
}
/** An IR with every route tag removed (untagged, as a region planned before RTE). */
const untag = (ir) => { const o = JSON.parse(JSON.stringify(ir)); for (const x of [...(o.roads ?? []), ...(o.paths ?? [])]) if (x.ext) delete x.ext[ROUTE]; return o; };

test('streetRuns, untagged: exactly origin/main\'s output, grouped growth pieces (band or not, rid or not) and _g<n> district ids included', () => {
  const band = { 'architect_mc:street': { zone: 'quay', district: 'quay' }, 'architect_mc:band': { district: 'quay', runs: [[0, 0, 15, 0]] } };
  const plan = (ids) => ({ spec: { districts: ids.map((id) => ({ id })) } });
  const cases = [
    { roads: [road('route_st_quay_1', 0, { 'architect_mc:street': { zone: 'quay', district: 'quay' } }), road('route_st_b_1_1', 2), road('route_st_quay_1_g1', 4, band),
      road('route_st_quay_1_g1_1', 8, band), road('route_st_quay_1_g1_2', 12, band), { ...road('route_st_quay_1_g2_1', 16), rid: 2 }] },
    { params: plan(['quay_g1']), roads: [road('route_st_quay_g1_1', 0, { 'architect_mc:street': { zone: 'z', district: 'quay_g1' } })] },
    { params: plan(['quay']), roads: [road('route_st_quay_g1_1', 0)] },
    { roads: [road('route_st_quay_g1_1', 0)] },
  ];
  for (const eff of cases) assert.deepEqual(streetRuns(eff), streetRunsMain(eff), JSON.stringify(eff.roads.map((x) => x.id)));
});

test('streetRuns, untagged: the v0.88.0 fix check\'s collision (quay\'s bandless grouped growth route_st_quay_1_g2_1, rid 2, beside a district quay_1_g2) reads as origin/main reads it', () => {
  // (an RTE2-era growth's groups: no band, no flag (they lost both), rid 2 from the effective merge; the plan records quay and quay_1_g2.
  // main's id rule reads them as quay_1_g2's following street; untagged, RTE3 changes nothing, so it reads the same, whatever that is)
  const g = (id, z) => ({ ...road(id, z, null, 64), rid: 2 });
  const eff = { params: { spec: { districts: [{ id: 'quay' }, { id: 'quay_1_g2' }] } }, roads: [g('route_st_quay_1_g2_1', 60), g('route_st_quay_1_g2_2', 61)] };
  assert.deepEqual(streetRuns(eff), streetRunsMain(eff));
  assert.deepEqual([...new Set(streetRunsMain(eff).map((r) => `${r.road} ${r.district} ${r.follow}`))], ['route_st_quay_1_g2_1 quay_1_g2 true', 'route_st_quay_1_g2_2 quay_1_g2 true'], 'main\'s reading');
});

test('streetRuns, untagged: equal to origin/main\'s on every IR in the kit fixtures and scenario goldens, their route tags removed', () => {
  const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json')) files.push(f); } };
  walk(path.join(KIT, 'test', 'fixtures'));
  walk(path.join(KIT, '..', 'scenarios', 'goldens'));
  // (every object with a roads array of road records, at any depth: IRs, effective IRs, embedded fixture IRs)
  const irs = [];
  const find = (o, where) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o.roads) && o.roads.length && o.roads.every((r) => r && typeof r.id === 'string' && Array.isArray(r.points))) irs.push([where, o]);
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') find(v, `${where}.${k}`);
  };
  for (const f of files) { let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; } find(j, path.relative(KIT, f)); }
  assert.ok(irs.length >= 20, `IRs found: ${irs.length}`);
  let streets = 0;
  for (const [where, ir] of irs) {
    const u = untag(ir);
    const want = streetRunsMain(u);
    streets += want.length;
    assert.deepEqual(streetRuns(u), want, where);
  }
  assert.ok(streets > 0);
});

test('growPlan, untagged legacy IR (the v0.88.0 reviewer\'s case): district quay_g1 grows 3 frontage lots on its street route_st_quay_g1_1, as origin/main (v0.88.0: NO_ROOM, no standing street)', async () => {
  // (a following district quay_g1 along a shore (water x 90..99), planned by the bundled districts program, its route tags stripped: a
  // region planned before RTE; origin/main placed quay_g1_3, _4, _5 as frontage on its one street run, no extension)
  const c = makeColumns(0, 0, 192, 192, 1), claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 }, d = 'quay_g1';
  for (let z = 0; z < 192; z++) for (let x = 0; x < 192; x++) { const i = x + z * 192, w = x >= 90 && x < 100; c.ground[i] = 64; c.height[i] = 64; c.floor[i] = w ? 61 : 64; c.flags[i] = w ? 1 : 0; }
  const q = await planRegion({ programFile: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: d, size: [64, 24], follow: { shore: {} }, lots: 2 }] }, lamps: false }, survey: c, claim, seed: '1' });
  const eff = mergeEffective(q.ir);
  eff.kitVersion = '0.74.0';
  for (const rd of [...eff.roads, ...eff.paths]) if (rd.ext) delete rd.ext[ROUTE];
  assert.deepEqual(eff.roads.filter((x) => x.id.startsWith('route_st_')).map((x) => x.id), ['route_st_quay_g1_1'], 'its legacy street, untagged');
  const standing = revisionStanding({ id: 'rg3', claim: [0, 0, 191, 191], effective: eff, held: { runs: [], town: [], terrain: [] } });
  let p = null, err = null;
  try { p = growPlan({ eff, standing, survey: surveyApi(c, claim), grow: { district: d, lots: 3 }, rid: 1 }); } catch (e) { err = e.message; }
  assert.equal(err, null, 'never NO_ROOM');
  assert.deepEqual(p.lots.map((l) => l.spec.id), ['quay_g1_3', 'quay_g1_4', 'quay_g1_5']);
  assert.ok(p.lots.every((l) => l.slot.kind === 'frontage' && l.slot.street === 'route_st_quay_g1_1'), JSON.stringify(p.lots.map((l) => l.slot)));
  assert.deepEqual(p.lots.map((l) => l.slot.u), [67, 125, 113], 'main\'s frontage positions');
  assert.equal(p.extension, null);
  assert.deepEqual(streetRuns(eff).map((r) => [r.road, r.district, r.follow]), [['route_st_quay_g1_1', d, true]]);
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
