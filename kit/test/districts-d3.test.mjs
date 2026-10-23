// 6c D3 (docs/CONTRACT.md "Phase 6c slice D3" §2-§10, §14 items 1, 2 and 17's kit half): districts beside a standing region town.
// The join's reach into the town's claim (a street end continuing its line, a street's side as a T), the contact columns and their hold
// cells, the candidates and the choice (thinning, the prune, the 48 cap), held and body columns hard, M28:beside and M25:clear's foreign
// bodies with the four broken variants, the land (D-S3), plan/0's endpoint.region reach, later plans keeping off a reach (§9), byte
// identity of a seam-step plan, determinism, and 300 seeded synthetic towns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { besideData, besideStanding, keyRuns, runKeys } from '../lib/region/beside.mjs';
import { LEAD, REACH_DRY_MAX, SIDE_EVERY, chooseReach, columnsApi, parseBesideReach, reachCandidates, reachClasses, streetNetwork, unionColumns } from '../lib/region/reach.mjs';
import { routePass, footprintOf } from '../lib/region/passes/route.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { encodeColumns, makeColumns } from '../lib/region/pack.mjs';
import { columnsOf, prng, realiseAll } from './region-helpers.mjs';
import { d3Town, planBeside, reachInputs } from './d3-helpers.mjs';

const flat = () => ({ g: 64, h: 64, f: 64, flags: 0 });
const EAST = [100, 13, 180, 93];
const NORTH = [0, -70, 90, -1];
const ONE = (id) => [{ id, size: [48, 48], lots: 4 }];
const check = (q, claimB, world, besideReach) => checkRegion({ ir: q.ir, survey: columnsOf(world, claimB[0], claimB[1], claimB[2] - claimB[0] + 1, claimB[3] - claimB[1] + 1), blobs: (s) => q.blobs.get(s), meta: q.meta, besideReach });
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error');

// ------------------------------------------------------------------ a synthetic town: one street along x (or z), its standing data

/**
 * A synthetic town: claim [0, 0, W-1, D-1], a street of width 3 along x at z = c from u0 to u1 (or along z at x = c), its two end
 * junctions and `mid` junctions, lots on one side (`lotSide`, boxes), the held set (the street with its verges, the lots, `held` extra
 * blocks as other sites, `terrain` blocks as the town's terrain), `bodies` (hard column rects), `lamps` [[x, z]], ground `g(x, z)`.
 */
function synthTown({ W = 96, D = 96, axis = 'x', c = 48, u0 = 12, u1 = 84, mid = [], lots = [], held = [], terrain = [], bodies = [], lamps = [], g = () => 64 } = {}) {
  const P = (u, v) => (axis === 'x' ? [u, v] : [v, u]);
  const a = P(u0, c), b = P(u1, c);
  const nodes = [{ id: 'street_start', kind: 'junction', at: [a[0], 64, a[1]], ports: [{ name: 'street' }] }, ...mid.map((u, i) => { const p = P(u, c); return { id: `street_j${i + 1}`, kind: 'junction', at: [p[0], 64, p[1]], ports: [{ name: 'street' }] }; }), { id: 'street_end', kind: 'junction', at: [b[0], 64, b[1]], ports: [{ name: 'street' }] }];
  const edges = [];
  for (let i = 0; i + 1 < nodes.length; i++) edges.push({ id: `street_x#${i + 1}`, from: `${nodes[i].id}.street`, to: `${nodes[i + 1].id}.street`, type: 'road', width: 5, path: 'street_x' });
  const road = { id: 'street_x', width: 3, points: [[a[0], 64, a[1]], [b[0], 64, b[1]]] };
  const ir = { roads: [road], lots: lots.map((q, i) => ({ id: `l${i}`, box: { minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3], minY: 65, maxY: 80 } })), paths: [], parts: [], graph: { nodes, edges } };
  const standing = besideStanding('rg9', [0, 0, W - 1, D - 1], ir);
  // the verges as a way (the street's footprint is road + 1 already)
  standing.lamps = keyRuns(lamps.map(([x, z]) => `${x},${z}`));
  standing.bodies = { hard: keyRuns(runKeys(bodies)), watch: [], list: bodies.length ? [{ id: 'pond', hard: keyRuns(runKeys(bodies)), watch: [] }] : [] };
  const town = new Set(), other = runKeys(held), terr = runKeys(terrain);
  for (const q of standing.footprint.keep) runKeys([q.rect], town);
  for (const q of standing.footprint.lots) runKeys([q], town);
  for (const k of terr) town.add(k);
  const all = new Set([...town, ...other]);
  const reachSurvey = makeColumns(0, 0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W, y = g(i, j); reachSurvey.ground[k] = y; reachSurvey.height[k] = y; reachSurvey.floor[k] = y; }
  const R = { survey: reachSurvey, held: { runs: keyRuns(all), town: keyRuns([...town].filter((k) => !other.has(k))), terrain: keyRuns([...terr].filter((k) => !other.has(k))) }, standing };
  const beside = { id: 'rg9', claim: [0, 0, W - 1, D - 1], lots: [], keep: [], graph: ir.graph };
  return { ir, R: parseBesideReach(R), beside, standing };
}

/** The join a chosen candidate would write (its footprint, nothing behind the junction cell). */
function joinColumns(J) {
  const [gx, , gz] = J.cand.at, [fx, fz] = J.cand.facing;
  return footprintOf(J.best.path, 3).filter(([x, z]) => (x - gx) * fx + (z - gz) * fz >= 0).map(([x, z]) => `${x},${z}`);
}

// ------------------------------------------------------------------ item 1: geometry (§3.2-§3.4), row by row

test('item 1 (§3.1): the street network: terminal street ends, straight runs of 9+ cells, junctions on them; lanes and routes are not streets', () => {
  const t = synthTown({ mid: [40] });
  const net = streetNetwork(t.R.standing, t.beside.graph);
  assert.deepEqual(net.ends.map((e) => [e.node, e.end, e.dir]), [['street_end', [85, 48], [1, 0]], ['street_start', [11, 48], [-1, 0]]]);
  assert.deepEqual(net.runs.map((r) => [r.road, r.axis, r.c, r.u0, r.u1, r.hw, r.junctions]), [['street_x', 'x', 48, 12, 84, 2, [12, 40, 84]]]);
  // a lane edge ending at a junction makes it no terminal of a street; a route between districts or a join is no street
  const g = JSON.parse(JSON.stringify(t.beside.graph));
  g.edges.push({ id: 'lane_l0', from: 'street_end.street', to: 'lot:l0.entrance', type: 'path', path: 'lane_l0' });
  g.nodes.push({ id: 'lot:l0', kind: 'lot', at: [85, 65, 60], ports: [{ name: 'entrance' }] });
  assert.deepEqual(streetNetwork(t.R.standing, g).ends.map((e) => e.node), ['street_start']);
  const r2 = { ...t.R.standing, streets: [{ id: 'd_a__b', width: 3, points: [[0, 64, 10], [40, 64, 10]], flagged: false }] };
  const g2 = { nodes: t.beside.graph.nodes, edges: t.beside.graph.edges.map((e) => ({ ...e, path: 'd_a__b' })) };
  assert.equal(streetNetwork({ ...r2, streets: [] }, g2).ends.length, 0);
  // a short run (under 9 cells) offers no side; a diagonal one neither
  const short = synthTown({ u0: 40, u1: 47 });
  assert.equal(streetNetwork(short.R.standing, short.beside.graph).runs.length, 0);
  const diag = { ...t.R.standing, streets: [{ id: 'street_d', width: 3, points: [[10, 64, 10], [40, 64, 40]], flagged: false }] };
  assert.equal(streetNetwork(diag, { nodes: [], edges: [] }).runs.length, 0);
});

test('item 1 (§3.2, §3.3): candidates: the strip, the verge contact with and without a lamp, the height, the run ends and junctions, thinning', () => {
  const base = synthTown({ mid: [40] });
  const cands = (t, ends = []) => {
    const U = unionColumns(columnsOf(flat, 96, 0, 60, 96), t.R.survey, [96, 0, 155, 95], [0, 0, 95, 95]);
    return reachCandidates({ reach: t.R, K: reachClasses(t.R), api: columnsApi(U), net: streetNetwork(t.R.standing, t.beside.graph), frame: [[96, 0, 155, 95], [0, 0, 95, 95]], districtEnds: ends });
  };
  const c0 = cands(base);
  const ends = c0.candidates.filter((q) => q.kind === 'end'), sides = c0.candidates.filter((q) => q.kind === 'side');
  assert.deepEqual(ends.map((q) => [q.node, q.at, q.facing, q.contact.length]), [['street_start', [11, 65, 48], [-1, 0], 12], ['street_end', [85, 65, 48], [1, 0], 12]]);
  // sides: every SIDE_EVERY cells from u0 + 3 to u1 - 3, not within 3 of a junction (40), on both sides; E at c +- 3, facing away
  const us = [...new Set(sides.map((q) => q.u))].sort((a, b) => a - b);
  const want = [];
  for (let u = 15; u <= 81; u += SIDE_EVERY) if (Math.abs(u - 40) >= 3) want.push(u);
  assert.deepEqual(us, want);
  for (const q of sides) {
    assert.equal(q.at[2], q.side === 'n' ? 45 : 51);
    assert.deepEqual(q.facing, q.side === 'n' ? [0, -1] : [0, 1]);
    assert.equal(q.contact.length, 5 + 3 * LEAD, 'the strip (5 along) and the lead (3 deep, 3 wide)');
    assert.equal(q.verge.length, 3);
    assert.ok(q.verge.every((k) => Number(k.split(',')[1]) === (q.side === 'n' ? 46 : 50)));
  }
  // a district end's projection adds its point (clamped to the run)
  const c1 = cands(base, [{ x: 58, z: -30 }]);
  assert.ok(c1.candidates.some((q) => q.kind === 'side' && q.u === 58));
  // a lamp on the verge drops the T there (and only there); a lot on the south side drops that side
  const lamp = synthTown({ mid: [40], lamps: [[51, 46]] });
  const cl = cands(lamp);
  assert.ok(!cl.candidates.some((q) => q.kind === 'side' && q.side === 'n' && Math.abs(q.u - 51) <= 1));
  assert.ok(cl.candidates.some((q) => q.kind === 'side' && q.side === 'n' && q.u === 55));
  assert.ok(cl.dropped['side: a lamp or prop on the verge'] >= 1);
  const lot = synthTown({ mid: [40], lots: [[12, 52, 84, 60]] });
  assert.ok(!cands(lot).candidates.some((q) => q.side === 's'), 'the lot side (lots + 1 over the strip) offers no T');
  // the height: E more than 1 off the verge's surface drops it
  const step = synthTown({ mid: [40], g: (x, z) => (z <= 45 ? 66 : 64) });
  assert.ok(!cands(step).candidates.some((q) => q.side === 'n'), 'a strip 2 over the verge');
  const step1 = synthTown({ mid: [40], g: (x, z) => (z <= 45 ? 65 : 64) });
  assert.ok(cands(step1).candidates.some((q) => q.side === 'n'), 'within 1 of it');
  // held columns: another site's on the strip drops it; the town's terrain alone may hold a contact column (it is then a hold cell)
  const other = synthTown({ mid: [40], held: [[20, 44, 30, 45]] });
  assert.ok(!cands(other).candidates.some((q) => q.side === 'n' && q.u >= 18 && q.u <= 32));
  const terr = synthTown({ mid: [40], terrain: [[86, 47, 88, 49]] });
  const te = cands(terr).candidates.find((q) => q.node === 'street_end');
  assert.deepEqual(te.hold.sort(), ['86,47', '86,48', '86,49', '87,47', '87,48', '87,49', '88,47', '88,48', '88,49'].sort());
  // a body's column on a contact column drops it
  const body = synthTown({ mid: [40], bodies: [[87, 47, 88, 47]] });
  assert.ok(!cands(body).candidates.some((q) => q.node === 'street_end'));
});

test('item 1 (§2.2): the choice: cheapest by T2 cost, the lead (3 straight cells into the junction), held and body columns hard, the 48 cap', () => {
  const t = synthTown({ mid: [40] });
  const planCols = columnsOf(flat, 96, 0, 60, 96);
  const end = (x, z) => ({ x, z, at: [x, 65, z], facing: [-1, 0] });
  const J = chooseReach({ planCols, R: t.R, beside: t.beside, claim: [96, 0, 155, 95], districtEnds: [end(110, 48)], route: routePass });
  assert.equal(J.cand.node, 'street_end');
  const P = J.best.path, n = P.length;
  assert.deepEqual(P.slice(n - LEAD - 1).map((q) => [q[0], q[2]]), [[88, 48], [87, 48], [86, 48], [85, 48]], 'the lead runs straight into the past-end cell');
  // a district end north of the street's middle: a T on the north side is cheaper than either end
  const Jn = chooseReach({ planCols: columnsOf(flat, 0, -60, 96, 60), R: t.R, beside: t.beside, claim: [0, -60, 95, -1], districtEnds: [{ x: 60, z: -20, at: [60, 65, -20], facing: [0, 1] }], route: routePass });
  assert.equal(Jn.cand.kind, 'side');
  assert.equal(Jn.cand.side, 'n');
  // held columns (another site) across the T's way: the join keeps off them
  const h = synthTown({ mid: [40], held: [[57, 30, 63, 43]] });
  const Jh = chooseReach({ planCols: columnsOf(flat, 0, -60, 96, 60), R: h.R, beside: h.beside, claim: [0, -60, 95, -1], districtEnds: [{ x: 60, z: -20, at: [60, 65, -20], facing: [0, 1] }], route: routePass });
  const held = runKeys([[57, 30, 63, 43]]);
  assert.ok(joinColumns(Jh).every((k) => !held.has(k)));
  // ... and so do a body's columns
  const b = synthTown({ mid: [40], bodies: [[57, 30, 63, 43]] });
  const Jb = chooseReach({ planCols: columnsOf(flat, 0, -60, 96, 60), R: b.R, beside: b.beside, claim: [0, -60, 95, -1], districtEnds: [{ x: 60, z: -20, at: [60, 65, -20], facing: [0, 1] }], route: routePass });
  assert.ok(joinColumns(Jb).every((k) => !held.has(k)));
  // the cap: a district end walled in (every dry route fails) on a street with more than 48 candidates: NO_JOIN [budget]
  const longT = synthTown({ W: 200, D: 40, u0: 10, u1: 190, c: 20 });
  // (ringed by water: a walk reaches out over it, no route crosses it: every dry route fails, and the 49th is never run)
  const pc = columnsOf(flat, 200, 0, 24, 40);
  for (let j = 0; j < 40; j++) for (let i = 0; i < 24; i++) { const d = Math.max(Math.abs(200 + i - 211), Math.abs(j - 20)); if (d >= 5 && d <= 7) pc.flags[i + j * 24] = 1; }
  assert.throws(() => chooseReach({ planCols: pc, R: longT.R, beside: longT.beside, claim: [200, 0, 223, 39], districtEnds: [{ x: 211, z: 20, at: [211, 65, 20], facing: [-1, 0] }], route: routePass }), /NO_JOIN: \[budget\]/);
  assert.equal(REACH_DRY_MAX, 48);
  // apart: a claim neither meeting nor touching the town's
  assert.throws(() => chooseReach({ planCols: columnsOf(flat, 98, 0, 60, 96), R: t.R, beside: t.beside, claim: [98, 0, 157, 95], districtEnds: [end(110, 48)], route: routePass }), /NO_JOIN: \[apart\]/);
  // street: a graph with no street run
  const ns = { ...t.R, standing: { ...t.R.standing, streets: [] } };
  assert.throws(() => chooseReach({ planCols, R: ns, beside: { ...t.beside, graph: { nodes: [], edges: [] } }, claim: [96, 0, 155, 95], districtEnds: [end(110, 48)], route: routePass }), /NO_JOIN: \[street\]/);
  // wall: another owner's held ring round the town's streets
  const ring = synthTown({ held: [[4, 4, 91, 4], [4, 91, 91, 91], [4, 4, 4, 91], [91, 4, 91, 91]] });
  assert.throws(() => chooseReach({ planCols, R: ring.R, beside: ring.beside, claim: [96, 0, 155, 95], districtEnds: [end(110, 48)], route: routePass }), /NO_JOIN: \[wall\]/);
});

test('item 1: 300 seeded synthetic towns: every chosen join\'s reach cells unheld (but its terrain-held contact columns), outside the footprint and bodies; deterministic', () => {
  const rnd = prng(20261023);
  let joined = 0, refused = 0, sides = 0, holds = 0;
  for (let n = 0; n < 300; n++) {
    // a 64 x 64 town, its street 30..50 long; the district's claim (40 wide) east or south of it
    const axis = rnd() < 0.5 ? 'x' : 'z';
    const c = 22 + Math.floor(rnd() * 20), u0 = 6 + Math.floor(rnd() * 8), u1 = 40 + Math.floor(rnd() * 16);
    const lotSide = rnd() < 0.5 ? -1 : 1;
    const lots = [];
    for (let u = u0 + 2; u + 9 < u1; u += 12 + Math.floor(rnd() * 4)) { const v0 = lotSide > 0 ? c + 4 : c - 13; lots.push(axis === 'x' ? [u, v0, u + 8, v0 + 8] : [v0, u, v0 + 8, u + 8]); }
    const held = [], bodies = [], terrain = [];
    for (let k = 0; k < 3; k++) { const x = Math.floor(rnd() * 56), z = Math.floor(rnd() * 56); held.push([x, z, x + 2 + Math.floor(rnd() * 5), z + 2 + Math.floor(rnd() * 5)]); }
    if (rnd() < 0.3) { const x = Math.floor(rnd() * 56), z = Math.floor(rnd() * 56); bodies.push([x, z, x + 4, z + 4]); }
    if (rnd() < 0.5) { const e = axis === 'x' ? [u1 + 1, c - 1, u1 + 3, c + 1] : [c - 1, u1 + 1, c + 1, u1 + 3]; terrain.push(e); }
    const t = synthTown({ W: 64, D: 64, axis, c, u0, u1, mid: [Math.floor((u0 + u1) / 2)], lots, held, bodies, terrain });
    const east = rnd() < 0.5;
    const claim = east ? [64, 0, 103, 63] : [0, 64, 63, 103];
    const planCols = columnsOf(flat, claim[0], claim[1], claim[2] - claim[0] + 1, claim[3] - claim[1] + 1);
    const ex = east ? 72 + Math.floor(rnd() * 24) : 6 + Math.floor(rnd() * 50), ez = east ? 6 + Math.floor(rnd() * 50) : 72 + Math.floor(rnd() * 24);
    const de = [{ x: ex, z: ez, at: [ex, 65, ez], facing: east ? [-1, 0] : [0, -1] }];
    let J = null;
    try { J = chooseReach({ planCols, R: t.R, beside: t.beside, claim, districtEnds: de, route: routePass }); } catch (e) { assert.match(e.message, /^NO_JOIN: \[(route|wall|budget)\]/); refused++; continue; }
    joined++;
    if (J.cand.kind === 'side') sides++;
    const K = J.K, contact = new Set(J.cand.contact);
    for (const k of joinColumns(J)) {
      const [x, z] = k.split(',').map(Number);
      if (x >= claim[0] && x <= claim[2] && z >= claim[1] && z <= claim[3]) continue;
      assert.ok(x >= 0 && x <= 63 && z >= 0 && z <= 63, `town ${n}: ${k} inside the town's claim`);
      assert.ok(!K.lot.has(k) && !K.keep.has(k), `town ${n}: ${k} outside the footprint`);
      assert.ok(!K.body.has(k), `town ${n}: ${k} outside the bodies`);
      if (K.held.has(k)) { assert.ok(contact.has(k) && K.terrain.has(k), `town ${n}: ${k} held only as a terrain contact column`); holds++; }
    }
    // deterministic: the same inputs choose the same join
    if (n % 25 === 0) {
      const J2 = chooseReach({ planCols, R: t.R, beside: t.beside, claim, districtEnds: de, route: routePass });
      assert.deepEqual([J2.cand.kind, J2.cand.at, J2.best.dry.cost, J2.best.path], [J.cand.kind, J.cand.at, J.best.dry.cost, J.best.path]);
    }
  }
  assert.ok(joined >= 200, `${joined} joined, ${refused} refused`);
  assert.ok(sides > 0 && holds > 0, `${sides} side joins, ${holds} hold cells`);
  console.log(`# 300 synthetic towns: ${joined} joined (${sides} at a side), ${refused} refused NO_JOIN, ${holds} terrain-held contact cells`);
});

// ------------------------------------------------------------------ full plans: the reach step in the districts pass

test('items 1-2 (§2.1, §10): the two-step order: a seam-step plan is today\'s byte for byte (no reach read); without the reach inputs, D1\'s refusals', async () => {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  // the D1 seam fixture: a street end in the seam (the west end), with and without the reach inputs: the same IR
  const B = [-60, 13, 11, 93];
  const a = await planBeside({ town, districts: ONE('east'), claimB: B });
  const b = await planBeside({ town, districts: ONE('east'), claimB: B, besideReach: R.besideReach });
  assert.equal(a.irSha, b.irSha);
  assert.equal(b.ir.reach, undefined);
  assert.ok(!b.ir.graph.edges.some((e) => e.junction));
  assert.equal(b.meta.districts.join.step, undefined);
  // no street end in the seam: D1's refusal without the reach inputs, the reach with them
  await assert.rejects(planBeside({ town, districts: ONE('east'), claimB: EAST }), /^Error: NO_JOIN: no street end of region rg1 lies inside this claim/);
  const q = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach });
  assert.equal(q.meta.districts.join.step, 'reach');
  assert.equal(q.ir.reach.standing, 'rg1');
  assert.match(q.ir.reach.heldSha, /^[0-9a-f]{64}$/);
});

test('item 2 (§10, §4.3): the pinned seam-step joins (D1\'s beside fixture, D2\'s outpost) share no column with the town\'s held set', async () => {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const held = runKeys(R.besideReach.held.runs);
  const shared = {};
  for (const [name, ds, B] of [['d1_seam', ONE('east'), [-60, 13, 11, 93]], ['d2_outpost', [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 40 } }], [-150, -20, 11, 130]]]) {
    let q;
    try { q = await planBeside({ town, districts: ds, claimB: B }); } catch (e) { shared[name] = `not planned: ${e.message.slice(0, 80)}`; continue; }
    if (q.ir.reach) { shared[name] = 'a reach plan'; continue; }
    // the join's written columns: its ops' cells and its 4e road items' width and verge
    const cols = new Set();
    for (const c of realiseAll({ ...q.ir, parts: q.ir.parts.filter((p) => p.id === 'routes') }, town.world).values()) cols.add(`${c.x},${c.z}`);
    for (const rd of q.ir.roads.filter((r) => r.id.startsWith('route_join'))) {
      const pts = rd.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]], h = Math.floor((rd.width ?? 3) / 2) + 1;
        for (let x = Math.min(a[0], b[0]) - (a[2] === b[2] ? 0 : h); x <= Math.max(a[0], b[0]) + (a[2] === b[2] ? 0 : h); x++) for (let z = Math.min(a[2], b[2]) - (a[0] === b[0] ? 0 : h); z <= Math.max(a[2], b[2]) + (a[0] === b[0] ? 0 : h); z++) cols.add(`${x},${z}`);
      }
    }
    shared[name] = [...cols].filter((k) => held.has(k)).length;
  }
  console.log(`# pinned seam-step joins, columns shared with the town's held set: ${JSON.stringify(shared)}`);
  assert.equal(shared.d1_seam, 0);
});

test('items 3-4 (kit): a street end continuing its line, a side T into the lot-free side; the external edge, the reach, M28 clean', async () => {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const e = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach });
  const je = e.meta.districts.join;
  assert.deepEqual([je.node, je.junction.kind, je.junction.at], ['street_e_end', 'end', [75, 65, 53]]);
  const ext = e.ir.graph.edges.filter((x) => x.external);
  assert.deepEqual(ext.map((x) => [x.to, x.junction.kind]), [['rg1:street_e_end.street', 'end']]);
  const mp = e.meta.route.edges.find((x) => x.id === 'join').path;
  assert.deepEqual(mp.slice(-4).map((q) => [q[0], q[2]]), [[78, 53], [77, 53], [76, 53], [75, 53]], 'the join continues the street\'s line for 3 cells');
  // its reach: in the town's claim, outside its footprint, unheld; written by route_join only
  const K = reachClasses(parseBesideReach(R.besideReach));
  for (const k of runKeys(e.ir.reach.runs)) assert.ok(!K.lot.has(k) && !K.keep.has(k) && !K.held.has(k), k);
  const rep = check(e, EAST, town.world, R.besideReach);
  assert.deepEqual(errors(rep).map((f) => f.rule), []);
  assert.equal(rep.metrics.M28.outside, e.ir.reach.cells);
  // the tiles hold the reach: the realised cells outside the claim are exactly reach columns
  const cells = realiseAll(e.ir, R.after);
  const reach = runKeys(e.ir.reach.runs);
  const out = [...cells.values()].filter((c) => c.x < EAST[0] || c.x > EAST[2] || c.z < EAST[1] || c.z > EAST[3]);
  assert.ok(out.length > 0 && out.every((c) => reach.has(`${c.x},${c.z}`)));
  // a district north: a T into the street's lot-free side; the verge and road never written
  const n = await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R.besideReach });
  const jn = n.meta.districts.join;
  assert.deepEqual([jn.junction.kind, jn.junction.side, jn.road], ['side', 'n', 'street_w']);
  assert.equal(jn.junction.at[2], 50);
  const xn = n.ir.graph.edges.find((x) => x.external);
  assert.equal(xn.to, 'rg1:street_w');
  assert.deepEqual(xn.junction, jn.junction);
  const verge = runKeys(R.besideReach.standing.footprint.keep.filter((p) => p.id === 'verges' || p.id === 'street_w').map((p) => p.rect));
  for (const k of runKeys(n.ir.reach.runs)) assert.ok(!verge.has(k), `${k} is no verge or road column`);
  assert.deepEqual(errors(check(n, NORTH, town.world, R.besideReach)).map((f) => f.rule), []);
});

test('§3.4: the contact columns: a pad\'s fill under the street end is held (reach.hold), never left to the town\'s undo', async () => {
  // a 4-deep dip past the east street end: the smithy's pad fills the contact columns (lamps off on the aprons: none stands there)
  const dip = (x, z) => (x >= 75 && x <= 78 && z >= 52 && z <= 54 ? { g: 60, h: 60, f: 60, flags: 0 } : flat(x, z));
  const town = await d3Town({ world: dip, params: { apronLamps: false } });
  const R = reachInputs({ ir: town.p.ir, world: dip, claim: town.claim });
  const q = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach, world: dip });
  assert.equal(q.meta.districts.join.junction.kind, 'end');
  const terr = runKeys(R.besideReach.held.terrain);
  const contact = runKeys(q.ir.reach.contact), hold = runKeys(q.ir.reach.hold);
  const want = [...contact].filter((k) => terr.has(k)).sort();
  assert.ok(want.length >= 3, `${want.length} terrain-held contact columns`);
  assert.deepEqual([...hold].sort(), want);
  for (const k of hold) assert.ok(runKeys(q.ir.reach.runs).has(k), 'the hold columns are reach columns');
  assert.deepEqual(errors(check(q, EAST, dip, R.besideReach)).map((f) => f.rule), []);
  // the broken variant: no hold cells
  const b = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach, world: dip, unsafe: { noHold: true } });
  assert.ok(errors(check(b, EAST, dip, R.besideReach)).some((f) => f.rule === 'M28:beside' && /not hold-written/.test(f.message)));
});

test('§5.3: M28:beside catches the broken variants (ignoreHeld, writeVerge, wideReach); M25:clear names a town body', async () => {
  const town = await d3Town();
  // another site's build across the north district's cheapest way to the street (a Steward addition in the town's claim)
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim, others: [[30, 10, 60, 40]] });
  const ok = await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R.besideReach });
  const held = runKeys([[30, 10, 60, 40]]);
  assert.ok([...runKeys(ok.ir.reach.runs)].every((k) => !held.has(k)), 'the join keeps off the site');
  assert.deepEqual(errors(check(ok, NORTH, town.world, R.besideReach)).map((f) => f.rule), []);
  const ih = await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R.besideReach, unsafe: { ignoreHeld: true } });
  assert.ok(errors(check(ih, NORTH, town.world, R.besideReach)).some((f) => f.rule === 'M28:beside' && /are held/.test(f.message)), 'ignoreHeld caught');
  const R0 = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const wv = await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R0.besideReach, unsafe: { writeVerge: true } });
  assert.equal(wv.meta.districts.join.junction.kind, 'side');
  const fw = errors(check(wv, NORTH, town.world, R0.besideReach));
  assert.ok(fw.some((f) => f.rule === 'M28:beside' && /footprint/.test(f.message)), 'writeVerge caught');
  const wr = await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R0.besideReach, unsafe: { wideReach: true } });
  assert.ok(errors(check(wr, NORTH, town.world, R0.besideReach)).some((f) => f.rule === 'M28:beside' && /part other than route_join/.test(f.message)), 'wideReach caught');
  // M25:clear: a write into a town body's columns, named <town>:<id>
  const Rb = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const reachKeys = [...runKeys(ok.ir.reach.runs)].slice(0, 4).map((k) => k.split(',').map(Number));
  Rb.besideReach.standing.bodies.list = [{ id: 'pond1', hard: keyRuns(reachKeys.map(([x, z]) => `${x},${z}`)), watch: [] }];
  const fb = errors(check(ok, NORTH, town.world, Rb.besideReach));
  assert.ok(fb.some((f) => f.rule === 'M25:clear' && /rg1:pond1/.test(f.message)));
});

test('§6 (D-S3): architect_mc:land for a reach join, a seam join and an outpost: union holds every written column, outside misses the town, inside the reach and seam', async () => {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const e = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach });
  const L = districtLand(e.ir, town.claim);
  assert.equal(L.v, 1);
  assert.deepEqual([L.standing, L.standingClaim, L.standingRemoved], ['rg1', [0, 0, 111, 111], null]);
  const union = runKeys(L.union.runs), inside = runKeys(L.inside.runs), outside = runKeys(L.outside.runs);
  const inTown = (k) => { const [x, z] = k.split(',').map(Number); return x >= 0 && x <= 111 && z >= 0 && z <= 111; };
  for (const c of realiseAll(e.ir, R.after).values()) assert.ok(union.has(`${c.x},${c.z}`), `written ${c.x},${c.z} in union`);
  assert.ok([...outside].every((k) => !inTown(k)));
  assert.ok([...inside].every((k) => inTown(k)));
  for (const k of runKeys(e.ir.reach.runs)) assert.ok(inside.has(k));
  const jp = L.parts.find((p) => p.kind === 'join');
  assert.deepEqual([jp.district, jp.junction], ['east', 'end']);
  assert.equal(L.union.cells, L.outside.cells + L.inside.cells);
  // standingRemoved: set, the geometry kept
  const L2 = districtLand(e.ir, town.claim, { standingRemoved: 12345 });
  assert.equal(L2.standingRemoved, 12345);
  assert.deepEqual(L2.inside, L.inside);
  // a seam join (D1) and a plain region with no standing one
  const s = await planBeside({ town, districts: ONE('east'), claimB: [-60, 13, 11, 93], besideReach: R.besideReach });
  const Ls = districtLand(s.ir, town.claim);
  assert.equal(Ls.parts.find((p) => p.kind === 'join').junction, 'end');
  assert.ok(Ls.inside.cells > 0, 'the seam join\'s cells in the town\'s claim');
  const Lp = districtLand(s.ir, null);
  assert.equal(Lp.inside.cells, 0);
  assert.equal(Lp.standingClaim, null);
});

test('§8: plan/0 endpoint.region reaches into the standing region\'s claim (to an end or a side); the answer notes the reach; M28 clean', async () => {
  const { checkPlanLocal } = await import('./plan-helpers.mjs');
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const B = [100, 13, 200, 93];
  const claim = { minX: B[0], minZ: B[1], maxX: B[2], maxZ: B[3], minY: -64, maxY: 319 };
  const survey = encodeColumns(columnsOf(flat, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1));
  const standing = [besideData('rg1', town.claim, town.p.ir, B)];
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'to_rg1', kind: 'road', from: { anchor: 'street_e' }, to: { region: 'rg1' } }] };
  const anchors = { street_e: [190, 65, 53], stone: [150, 65, 53] };
  const n = await checkPlanLocal(plan, { survey, claim, anchors, standing });
  assert.equal(n.check.parts[0].reasons[0].code, 'NO_FEATURE');
  const y = await checkPlanLocal(plan, { survey, claim, anchors, standing, besideReach: { rg1: R.besideReach } });
  assert.equal(y.check.overall, 'READY');
  const a = y.check.parts[0];
  assert.equal(a.class, 'fits');
  assert.ok((a.notes ?? []).some((t) => /reach: true/.test(t)));
  assert.equal(a.geometry.legs[0].junction.kind, 'end');
  const ext = y.res.ir.graph.edges.filter((e) => e.external);
  assert.deepEqual(ext.map((e) => [e.to, e.path]), [['rg1:street_e_end.street', 'route_join']]);
  assert.equal(y.res.ir.reach.standing, 'rg1');
  const rep = checkRegion({ ir: y.res.ir, survey, blobs: (s) => y.res.blobs.get(s), meta: y.res.meta, besideReach: { rg1: R.besideReach } });
  assert.deepEqual(errors(rep).map((f) => f.rule), []);
});

test('§9: a later plan keeps off a standing district\'s reach (plan/0 standing data: its reach runs are hard)', async () => {
  const { checkPlanLocal } = await import('./plan-helpers.mjs');
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const e = await planBeside({ town, districts: ONE('east'), claimB: EAST, besideReach: R.besideReach });
  // a zone over the town's east, with the district standing beside it: no lot of it on the district's reach
  const B = [60, 0, 111, 111];
  const claim = { minX: B[0], minZ: B[1], maxX: B[2], maxZ: B[3], minY: -64, maxY: 319 };
  const survey = encodeColumns(columnsOf(flat, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1));
  const district = { ...besideData('rg2', EAST, e.ir, B), reach: e.ir.reach.runs };
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'yard', program: { lots: [{ id: 'y1', type: 'house', size: [9, 9] }, { id: 'y2', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'stone', within: 64 } } }] };
  const r = await checkPlanLocal(plan, { survey, claim, anchors: { stone: [92, 65, 45] }, standing: [district] });
  const reach = runKeys(e.ir.reach.runs);
  for (const l of r.res.ir.lots) for (let z = l.box.minZ; z <= l.box.maxZ; z++) for (let x = l.box.minX; x <= l.box.maxX; x++) assert.ok(!reach.has(`${x},${z}`), `lot ${l.id} on the reach at ${x},${z}`);
});

test('item 17 (kit half): a reach plan plans to one IR sha three times', async () => {
  const town = await d3Town();
  const R = reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim });
  const shas = [];
  for (let i = 0; i < 3; i++) shas.push((await planBeside({ town, districts: ONE('north'), claimB: NORTH, besideReach: R.besideReach })).irSha);
  assert.equal(new Set(shas).size, 1);
});
