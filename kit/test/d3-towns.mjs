// 6c D3 item 1's synthetic towns (kit/test/districts-d3.test.mjs): the town builder and the 300 seeded towns, run on worker threads.
// (SPD) The 300 towns were one test on one thread (~370 s of CPU, the kit suite's critical path at ~13 min under load). Their inputs
// come from one prng sequence, drawn only before each town's chooseReach, so every worker draws the whole sequence (cheap) and checks
// the towns n with n % workers === k: the same 300 towns, the same assertions, the same counts, summed by the test.
import assert from 'node:assert/strict';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { besideStanding, keyRuns, runKeys } from '../lib/region/beside.mjs';
import { chooseReach, parseBesideReach } from '../lib/region/reach.mjs';
import { routePass, footprintOf } from '../lib/region/passes/route.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { columnsOf, prng } from './region-helpers.mjs';

export const flat = () => ({ g: 64, h: 64, f: 64, flags: 0 });

// ------------------------------------------------------------------ a synthetic town: one street along x (or z), its standing data

/**
 * A synthetic town: claim [0, 0, W-1, D-1], a street of width 3 along x at z = c from u0 to u1 (or along z at x = c), its two end
 * junctions and `mid` junctions, lots on one side (`lotSide`, boxes), the held set (the street with its verges, the lots, `held` extra
 * blocks as other sites, `terrain` blocks as the town's terrain), `bodies` (hard column rects), `lamps` [[x, z]], ground `g(x, z)`.
 */
export function synthTown({ W = 96, D = 96, axis = 'x', c = 48, u0 = 12, u1 = 84, mid = [], lots = [], held = [], terrain = [], bodies = [], lamps = [], g = () => 64 } = {}) {
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
export function joinColumns(J) {
  const [gx, , gz] = J.cand.at, [fx, fz] = J.cand.facing;
  return footprintOf(J.best.path, 3).filter(([x, z]) => (x - gx) * fx + (z - gz) * fz >= 0).map(([x, z]) => `${x},${z}`);
}

// ------------------------------------------------------------------ item 1: 300 seeded synthetic towns

export const TOWNS = 300;
export const TOWN_SEED = 20261023;

/**
 * Checks the towns n of the seeded sequence with n % workers === k (asserting as the one-thread test did); -> { joined, refused, sides,
 * holds, checked }. Each town's draws come before its chooseReach, so skipping another worker's town still draws its inputs.
 */
export function checkTowns(k = 0, workers = 1, total = TOWNS) {
  const rnd = prng(TOWN_SEED);
  let joined = 0, refused = 0, sides = 0, holds = 0, checked = 0;
  for (let n = 0; n < total; n++) {
    const mine = n % workers === k;
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
    const t = mine ? synthTown({ W: 64, D: 64, axis, c, u0, u1, mid: [Math.floor((u0 + u1) / 2)], lots, held, bodies, terrain }) : null;
    const east = rnd() < 0.5;
    const claim = east ? [64, 0, 103, 63] : [0, 64, 63, 103];
    const planCols = mine && columnsOf(flat, claim[0], claim[1], claim[2] - claim[0] + 1, claim[3] - claim[1] + 1);
    const ex = east ? 72 + Math.floor(rnd() * 24) : 6 + Math.floor(rnd() * 50), ez = east ? 6 + Math.floor(rnd() * 50) : 72 + Math.floor(rnd() * 24);
    const de = [{ x: ex, z: ez, at: [ex, 65, ez], facing: east ? [-1, 0] : [0, -1] }];
    if (!mine) continue; // every draw of this town is made: the next town's inputs are the one-thread test's
    checked++;
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
  return { joined, refused, sides, holds, checked };
}

// the worker: { k, workers, total } -> { ok: counts } | { error }
if (!isMainThread && workerData?.d3towns) {
  try {
    parentPort.postMessage({ ok: checkTowns(workerData.k, workerData.workers, workerData.total) });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.stack ?? e) });
  }
}
