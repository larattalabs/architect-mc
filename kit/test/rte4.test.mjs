// (RTE4) The last id-prefix readers of RTE's class: grow.mjs's free-end reader (a following district's route ends for its boundary
// extension) reads ends and edges from the records; districts `b` and `b_street` (one id another's plus a word) get each district's roads
// recorded (ext architect_mc:district {id}), read by land.mjs (= the mod's DistrictLand) and streetRuns. Untagged IRs read as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grow from '../lib/region/grow.mjs';
import * as land from '../lib/region/land.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'architect_mc:route', DISTRICT = 'architect_mc:district';
const LAND = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'rte4', 'land-irs.json'), 'utf8'));

// ---- item 1: the free-end reader

/** v0.88.0's free-end reader (grow.mjs extendBoundary's routeEnds and free, copied verbatim): the oracle for untagged regions. */
function routeEndsMain(eff, district) {
  const adjacency = (graph) => {
    const adj = new Map();
    const add = (n, e, o) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push({ edge: e, other: o }); };
    for (const e of graph?.edges ?? []) { const a = String(e.from).split('.')[0], b = String(e.to).split('.')[0]; add(a, e, b); add(b, e, a); }
    return adj;
  };
  const endRe = new RegExp(`^(${district}_s\\d+|route_st_${district}_[a-z0-9_]*_g\\d+_end)$`);
  const routeEnds = (eff.graph?.nodes ?? []).filter((n) => n.kind === 'junction' && endRe.test(n.id) && Array.isArray(n.at));
  const adj = adjacency(eff.graph);
  const free = routeEnds.filter((n) => {
    const es = (adj.get(n.id) ?? []).filter(({ edge }) => !edge.along);
    if (!es.length || es.some(({ edge }) => edge.external || !String(edge.path ?? '').startsWith(`route_st_${district}`))) return false;
    return /_g\d+_end$/.test(n.id) ? es.length === 1 : !es.some(({ edge }) => /_g\d+$/.test(String(edge.path ?? '')));
  });
  return { ends: routeEnds.map((n) => n.id), free: free.map((n) => n.id) };
}
const arr = (a) => (Array.isArray(a) ? a : []);
/** An IR without the RTE records (route tags; (fix round) and the district tags RTE4's growths write): as a release before RTE saved it. */
const untagRoutes = (ir) => { const o = JSON.parse(JSON.stringify(ir)); for (const x of [...arr(o.roads), ...arr(o.paths)]) if (x?.ext) { delete x.ext[ROUTE]; delete x.ext[DISTRICT]; } return o; };
const endsOf = (eff, d) => { const r = grow.streetRouteEnds(eff, d); return { ends: r.ends.map((n) => n.id), free: r.free.map((n) => n.id) }; };

/** Following districts `a` and `b` on one shore (water x 90..99), planned by the bundled districts program; `b` grown once along its boundary. */
async function shorePair(a, b) {
  const W = 192, D = 320, claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W, w = i >= 90 && i < 100; c.ground[k] = 64; c.height[k] = 64; c.floor[k] = w ? 61 : 64; c.flags[k] = w ? 1 : 0; }
  const ds = [a, b].map((id) => ({ id, size: [48, 24], follow: { shore: {} }, lots: 2 }));
  const q = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: ds }, lamps: false }, survey: c, claim, seed: '1' });
  const st = (eff) => revisionStanding({ id: 'rg3', claim: [0, 0, W - 1, D - 1], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const eff0 = mergeEffective(q.ir);
  const r1 = await reviseIR(eff0, { grow: { district: b, lots: 2, prefer: 'extend' } }, { rid: 1, position: 1, parent: { rid: 0, irSha: q.irSha }, base: { irSha: q.irSha }, survey: c, standing: st(eff0) });
  assert.equal(r1.ir.revision.grow.extension?.kind, 'boundary', `${b} grew along its boundary`);
  const eff = mergeEffective(q.ir, [{ rid: 1, position: 1, ir: r1.ir }]);
  return { eff, c, claim, st, grownEnd: `${r1.ir.revision.grow.extension.road}_end` };
}

test('growPlan: district b\'s boundary extension never starts at b_1\'s grown end route_st_b_1_1_g1_end (v0.88.0: it did)', async () => {
  const { eff, c, claim, st, grownEnd } = await shorePair('b', 'b_1');
  assert.equal(grownEnd, 'route_st_b_1_1_g1_end');
  const p = grow.growPlan({ eff, standing: st(eff), survey: surveyApi(c, claim), grow: { district: 'b', lots: 2, prefer: 'extend' }, rid: 2 });
  assert.notEqual(p.extension?.from, grownEnd, 'b extended from b_1\'s grown end');
  assert.ok(!p.extension || /^b_s\d+$/.test(p.extension.from), JSON.stringify(p.extension));
  assert.deepEqual(p.lots.map((l) => l.spec.id), ['b_3', 'b_4']);
});

test('streetRouteEnds, recorded: each district\'s own ends, a grown end its growth\'s (its pieces name b_1) (b: b_s0, b_s1; b_1: its ends and its grown end)', async () => {
  const { eff } = await shorePair('b', 'b_1');
  assert.deepEqual(endsOf(eff, 'b'), { ends: ['b_s0', 'b_s1'], free: ['b_s1'] });
  assert.deepEqual(endsOf(eff, 'b_1'), { ends: ['b_1_s0', 'b_1_s1', 'route_st_b_1_1_g1_end'], free: ['route_st_b_1_1_g1_end'] });
  // (untagged, a region planned before RTE: v0.88.0's reading, b taking b_1's grown end included)
  const u = untagRoutes(eff);
  assert.deepEqual(endsOf(u, 'b'), routeEndsMain(u, 'b'));
  assert.ok(routeEndsMain(u, 'b').free.includes('route_st_b_1_1_g1_end'), 'the legacy reading kept');
});

test('streetRouteEnds, tagged (no-regression; v0.88.0 read this plan the same): district quay beside quayside keeps only its own ends', async () => {
  const { eff } = await shorePair('quay', 'quayside');
  const mine = endsOf(eff, 'quay');
  assert.ok([...mine.ends, ...mine.free].every((id) => /^quay_s\d+$/.test(id)), JSON.stringify(mine));
  assert.deepEqual(mine, routeEndsMain(eff, 'quay'), 'quayside\'s grown end route_st_quayside_1_g1_end never matched v0.88.0\'s end rule either');
});

test('streetRouteEnds, untagged: exactly v0.88.0\'s reader on every IR in the kit fixtures and scenario goldens (route tags removed), every district', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json')) files.push(f); } };
  walk(path.join(KIT, 'test', 'fixtures'));
  walk(path.join(KIT, '..', 'scenarios', 'goldens'));
  const irs = [];
  const find = (o, where) => {
    if (!o || typeof o !== 'object') return;
    if (o.graph && Array.isArray(o.graph.nodes) && Array.isArray(o.graph.edges) && (o.roads === undefined || Array.isArray(o.roads)) && (o.paths === undefined || Array.isArray(o.paths))) irs.push([where, o]);
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && k !== 'graph') find(v, `${where}.${k}`);
  };
  for (const f of files) { let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; } find(j, path.relative(KIT, f)); }
  assert.ok(irs.length >= 10, `IRs with a graph: ${irs.length}`);
  let n = 0;
  for (const [where, ir] of irs) {
    const u = untagRoutes(ir);
    const ds = new Set([...(ir.params?.spec?.districts ?? ir.params?.districts ?? []).map((d) => d?.id), 'quay', 'b', 'a']);
    for (const d of ds) if (typeof d === 'string') { assert.deepEqual(endsOf(u, d), routeEndsMain(u, d), `${where} ${d}`); n++; }
  }
  assert.ok(n > 0);
});

// ---- item 2: b and b_street

const summary = (l) => Object.fromEntries(l.parts.map((p) => [`${p.kind}:${p.id}`, p.kind === 'join' || p.kind === 'grown' ? `${p.cells} ${p.district}` : p.cells]));
/** The fixture with every district tag edited by `f` (deleted: an untagged IR, as planned before RTE4). */
const retag = (f) => { const o = JSON.parse(JSON.stringify(LAND.bStreet)); for (const r of o.roads) if (r.ext?.[DISTRICT]) { f(r); if (!Object.keys(r.ext).length) delete r.ext; } return o; };

test('the land fixture is current: districts b and b_street, each district\'s roads tagged with it', async () => {
  const { makeIrs, FIXTURE } = await import('../tools/rte4-fixture.mjs');
  assert.equal(fs.readFileSync(FIXTURE, 'utf8'), `${JSON.stringify(await makeIrs(), null, 1)}\n`, 'kit/test/fixtures/rte4/land-irs.json is stale: node kit/tools/rte4-fixture.mjs');
  const tags = Object.fromEntries(LAND.bStreet.roads.map((r) => [r.id, r.ext?.[DISTRICT]?.id ?? null]));
  assert.deepEqual(tags, { b_street_w: 'b', b_street_e: 'b', b_street_street_w: 'b_street', b_street_street_e: 'b_street', route_d_b__b_street_1: null });
});

test('districtLand, b and b_street: b_street\'s part holds only its own roads (v0.88.0: b\'s b_street_w and b_street_e too, 1411 cells)', () => {
  assert.deepEqual(summary(land.districtLand(LAND.bStreet)), { 'district:b': 408, 'district:b_street': 408, 'route:d_b__b_street': 185 });
});

test('districtLand, untagged (planned before RTE4) and malformed tags (id 17, false): read by id exactly as v0.88.0; a tag naming no district: nobody\'s', () => {
  const legacy = { 'district:b': 408, 'district:b_street': 1411, 'route:d_b__b_street': 185 };
  assert.deepEqual(summary(land.districtLand(retag((r) => delete r.ext[DISTRICT]))), legacy);
  assert.deepEqual(summary(land.districtLand(retag((r) => { r.ext[DISTRICT] = { id: r.ext[DISTRICT].id === 'b' ? 17 : false }; }))), legacy);
  assert.deepEqual(summary(land.districtLand(retag((r) => { r.ext[DISTRICT] = { id: 'c' }; }))), { 'district:b': 408, 'district:b_street': 408, 'route:d_b__b_street': 185 });
});

test('streetRuns and growPlan, b and b_street: b_street\'s street b_street_street_* is its own (v0.88.0: b\'s, and b_street had no street, NO_ROOM)', async () => {
  const W = 160, claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: W - 1, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, W, W, 1);
  c.ground.fill(64); c.height.fill(64); c.floor.fill(62); c.flags.fill(0);
  const eff = mergeEffective({ ...LAND.bStreet, claim, seed: '7' });
  assert.deepEqual(Object.fromEntries(grow.streetRuns(eff).map((r) => [r.road, r.district])), { b_street_e: 'b', b_street_street_e: 'b_street', b_street_street_w: 'b_street', b_street_w: 'b' });
  const st = revisionStanding({ id: 'r', claim: [0, 0, W - 1, W - 1], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const p = grow.growPlan({ eff, standing: st, survey: surveyApi(c, claim), grow: { district: 'b_street', lots: 1 }, rid: 1 });
  assert.ok(p.lots.length === 1 && p.lots[0].slot.street.startsWith('b_street_street_'), JSON.stringify(p.lots.map((l) => l.slot)));
  // (untagged: v0.88.0's reading kept)
  const u = mergeEffective({ ...retag((r) => delete r.ext[DISTRICT]), claim, seed: '7' });
  assert.deepEqual([...new Set(grow.streetRuns(u).map((r) => r.district))], ['b']);
});

test('untaggedMisreads: a road the longest id or the street rule gives another district (b_street_w beside b_street; a lone b_street\'s b_street_street_w); b / b_1 and a lone b read right', () => {
  const o = (id, district) => ({ id, district });
  assert.equal(land.untaggedMisreads([o('b_street_w', 'b'), o('b_street_street_w', 'b_street')], ['b', 'b_street']), true);
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street')], ['b_street']), true);
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street'), o('c_street_w', 'c')], ['b_street', 'c']), true);
  assert.equal(land.untaggedMisreads([o('b_street_w', 'b'), o('b_1_street_w', 'b_1')], ['b', 'b_1']), false);
  assert.equal(land.untaggedMisreads([o('quay_g1_street_e', 'quay_g1')], ['quay_g1']), false);
  assert.equal(land.untaggedMisreads([o('b_street_w', 'b')], ['b']), false);
});

/** A districts plan of V districts `ids` (40 x 40, one lot, a square) on flat 160 x 160 land, seed 7, its effective IR and a growth's plan per district. */
async function flatPlan(ids) {
  const W = 160, claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: W - 1, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, W, W, 1);
  c.ground.fill(64); c.height.fill(64); c.floor.fill(62); c.flags.fill(0);
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), survey: c, claim, params: { spec: { districts: ids.map((id) => ({ id, size: [40, 40], lots: 1, shared: 'square' })) } }, seed: '7' });
  const eff = mergeEffective(p.ir);
  const st = revisionStanding({ id: 'r', claim: [0, 0, W - 1, W - 1], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const grows = Object.fromEntries(ids.map((d) => { try { return [d, grow.growPlan({ eff, standing: st, survey: surveyApi(c, claim), grow: { district: d, lots: 1 }, rid: 1 }).lots.map((l) => l.slot.street)]; } catch (e) { return [d, e.message.split(':').slice(0, 2).join(':')]; } }));
  return { ir: p.ir, eff, grows };
}

test('(v0.89.0 review P2-2) a lone district b_street: its roads are tagged, its street is its own, it grows on it (was NO_ROOM "no standing street")', async () => {
  const { ir, eff, grows } = await flatPlan(['b_street']);
  assert.deepEqual(Object.fromEntries(ir.roads.map((r) => [r.id, r.ext?.[DISTRICT]?.id ?? null])), { b_street_street_w: 'b_street', b_street_street_e: 'b_street' });
  assert.deepEqual([...new Set(grow.streetRuns(eff).map((r) => r.district))], ['b_street']);
  assert.ok(Array.isArray(grows.b_street) && grows.b_street.every((st) => st.startsWith('b_street_street_')), JSON.stringify(grows));
});

test('(v0.89.0 review P2-2) b_street beside c: both districts\' roads tagged; b_street grows on its own street, c on its', async () => {
  const { ir, eff, grows } = await flatPlan(['b_street', 'c']);
  assert.ok(ir.roads.filter((r) => !r.id.startsWith('route_')).every((r) => r.ext?.[DISTRICT]?.id === (r.id.startsWith('c_') ? 'c' : 'b_street')), JSON.stringify(ir.roads.map((r) => [r.id, r.ext])));
  assert.deepEqual(Object.fromEntries(grow.streetRuns(eff).map((r) => [r.road, r.district])), Object.fromEntries(ir.roads.filter((r) => !r.id.startsWith('route_')).map((r) => [r.id, r.id.startsWith('c_') ? 'c' : 'b_street'])));
  assert.ok(Array.isArray(grows.b_street) && grows.b_street.every((st) => st.startsWith('b_street_street_')), JSON.stringify(grows));
  assert.ok(Array.isArray(grows.c) && grows.c.every((st) => st.startsWith('c_street_')), JSON.stringify(grows));
});

test('the district tag only where an untagged reader misreads: districts b and b_1, a lone b, and c beside d stay untagged (their IRs unchanged)', async () => {
  for (const ids of [['b', 'b_1'], ['b'], ['c', 'd']]) {
    const { ir } = await flatPlan(ids);
    assert.ok(ir.roads.length > 0 && ir.roads.every((r) => !r.ext?.[DISTRICT]), `${ids}: no district tag`);
  }
});

test('no fixture or scenario golden carries the district tag (their IRs are unchanged)', () => {
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json') && fs.readFileSync(f, 'utf8').includes(DISTRICT)) hits.push(path.relative(KIT, f)); } };
  walk(path.join(KIT, 'test', 'fixtures'));
  walk(path.join(KIT, '..', 'scenarios', 'goldens'));
  assert.deepEqual(hits, [path.join('test', 'fixtures', 'rte4', 'land-irs.json')]);
});
