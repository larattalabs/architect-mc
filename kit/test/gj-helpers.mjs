// Shared helpers for the 7a GJ tests (not a test file itself): a walled town (D3's flat_village town with a ring round it: a C38 wall
// region `wall.around {feature: {region}}`, or the town's own K1 wall as a part of the town region) and the reach inputs the mod would
// send for a district beside it (a map {town, wall region} when the ring is its own region, §4).
import { planRegion } from '../lib/region/plan.mjs';
import { besideData, besideGates, besideStanding, keyRuns } from '../lib/region/beside.mjs';
import { encodeColumns, makeColumns } from '../lib/region/pack.mjs';
import { columnsOf, realiseAll } from './region-helpers.mjs';
import { afterWorld, d3Town, reachInputs, KIT } from './d3-helpers.mjs';
import { checkPlanLocal } from './plan-helpers.mjs';
import path from 'node:path';

export const GJ_ONE = (id) => [{ id, size: [48, 48], lots: 4 }];
/** The district's claim east of the 112 town: it touches the town's claim, the ring sits inside the town's. */
export const GJ_EAST = [112, 30, 201, 81];

/** The columns of a set of realised cells. */
const colsOf = (cells) => new Set([...cells.values()].map((c) => `${c.x},${c.z}`));

/**
 * A walled town: `ring` the C38 wall plan's connectors after the wall (gate parts: [{id, kind: 'gate', ...}]); `wallOpts` the wall's
 * own members (gates, height). Returns {town, A, C, ringIr, world, besideReach (the map), townOnly (the town's inputs alone)}.
 */
export async function walledTown({ gates = [], wallOpts = {}, anchors = { e: [100, 65, 53] } } = {}) {
  const town = await d3Town();
  const A = town.claim, C = [A[0] - 24, A[1] - 24, A[2] + 24, A[3] + 24];
  const tCells = realiseAll(town.p.ir, town.world);
  const w1 = afterWorld(town.world, tCells);
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'ring', kind: 'wall', where: { around: { feature: { region: 'rg1' }, ring: [4, 12] } }, height: 5, ...wallOpts }, ...gates] };
  const r = await checkPlanLocal(plan, { survey: encodeColumns(columnsOf(w1, C[0], C[1], C[2] - C[0] + 1, C[3] - C[1] + 1)), claim: { minX: C[0], minZ: C[1], maxX: C[2], maxZ: C[3], minY: -64, maxY: 319 }, anchors, standing: [besideData('rg1', A, town.p.ir, C)] });
  const ringIr = r.res.ir;
  const rCells = realiseAll(ringIr, w1);
  const world = afterWorld(w1, rCells);
  const ringCols = colsOf(rCells), townCols = colsOf(tCells);
  // the town's inputs: its claim's survey after both, the ring's columns another owner's (the wall region's group)
  const t = reachInputs({ id: 'rg1', ir: town.p.ir, world: town.world, claim: A, others: keyRuns([...ringCols].filter((k) => { const [x, z] = k.split(',').map(Number); return x >= A[0] && x <= A[2] && z >= A[1] && z <= A[3]; })) });
  const townIn = { ...t.besideReach, survey: columnsOf(world, A[0], A[1], A[2] - A[0] + 1, A[3] - A[1] + 1) };
  // the wall region's inputs over its claim: every held column; its own (the ring's); its gates
  const all = new Set([...ringCols, ...townCols]);
  const inC = (k) => { const [x, z] = k.split(',').map(Number); return x >= C[0] && x <= C[2] && z >= C[1] && z <= C[3]; };
  const wallIn = {
    survey: columnsOf(world, C[0], C[1], C[2] - C[0] + 1, C[3] - C[1] + 1),
    held: { runs: keyRuns([...all].filter(inC)), town: keyRuns([...ringCols].filter(inC)), terrain: [] },
    standing: besideStanding('rgW', C, ringIr),
    gates: besideGates('rgW', ringIr),
  };
  return { town, A, C, ringIr, ringMeta: r.res.meta, check: r.check, world, besideReach: { rg1: townIn, rgW: wallIn }, townOnly: townIn };
}

/** Plan a districts region beside the walled town (rg1) with the given reach inputs over `world`. */
export async function planBesideWalled({ W, districts = GJ_ONE('east'), claimB = GJ_EAST, besideReach = W.besideReach, unsafe = null, seed = '1' }) {
  const claim = { minX: claimB[0], minZ: claimB[1], maxX: claimB[2], maxZ: claimB[3], minY: -64, maxY: 319 };
  const survey = columnsOf(W.world, claimB[0], claimB[1], claimB[2] - claimB[0] + 1, claimB[3] - claimB[1] + 1);
  return planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts, ...(unsafe ? { _unsafe: unsafe } : {}) } }, survey, claim, seed, beside: besideData('rg1', W.A, W.town.p.ir, claimB), besideReach });
}

/**
 * A synthetic walled town for the seeded tests: D3's synthetic street town (W x D, a street along x at z = c from u0 to u1) inside a ring
 * of another owner's held columns 2 thick at `ring` (inset from the claim), with one gate through its east side at z = gz, `width` wide
 * (its cells held, as a wall part's are), its record as besideGates gives it. `bodies`: town body rects.
 */
export function synthWalled({ W = 96, D = 96, c = 48, u0 = 20, u1 = 70, ring = 8, gz = 48, width = 3, door = 'none', doorBlock = null, bodies = [], g = () => 64 }) {
  const P = (u, v) => [u, v];
  const nodes = [{ id: 'street_start', kind: 'junction', at: [u0, 64, c], ports: [{ name: 'street' }] }, { id: 'street_end', kind: 'junction', at: [u1, 64, c], ports: [{ name: 'street' }] }];
  const edges = [{ id: 'street_x#1', from: 'street_start.street', to: 'street_end.street', type: 'road', width: 5, path: 'street_x' }];
  const ir = { roads: [{ id: 'street_x', width: 3, points: [[u0, 64, c], [u1, 64, c]] }], lots: [], paths: [], parts: [], graph: { nodes, edges } };
  void P;
  const standing = besideStanding('rg9', [0, 0, W - 1, D - 1], ir);
  standing.bodies = { hard: keyRuns(runKeysOf(bodies)), watch: [], list: bodies.length ? [{ id: 'fount', hard: keyRuns(runKeysOf(bodies)), watch: [] }] : [] };
  const x0 = ring, z0 = ring, x1 = W - 1 - ring, z1 = D - 1 - ring;
  const wall = new Set();
  for (let t = 0; t < 2; t++) {
    for (let x = x0 + t; x <= x1 - t; x++) { wall.add(`${x},${z0 + t}`); wall.add(`${x},${z1 - t}`); }
    for (let z = z0 + t; z <= z1 - t; z++) { wall.add(`${x0 + t},${z}`); wall.add(`${x1 - t},${z}`); }
  }
  const lo = gz - ((width - 1) >> 1);
  const cells = [];
  for (let z = lo; z < lo + width; z++) for (const x of [x1 - 1, x1]) cells.push([x, z]);
  const gate = { region: 'rgW', wall: 'ring', id: 'ring_g1', at: [x1 - 1, 65, gz], y: 64, h: 3, width, facing: [1, 0], door, doorBlock, cells: cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]), outer: [x1 + 1, gz], inner: [x1 - 2, gz] };
  const town = new Set();
  for (const q of standing.footprint.keep) for (const k of runKeysOf([q.rect])) town.add(k);
  const all = new Set([...town, ...wall]);
  const survey = makeColumns(0, 0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W, y = g(i, j); survey.ground[k] = y; survey.height[k] = y; survey.floor[k] = y; }
  for (const k of wall) { const [x, z] = k.split(',').map(Number); if (!cells.some((q) => q[0] === x && q[1] === z)) { const i = x + z * W; survey.ground[i] = 70; survey.height[i] = 70; } }
  const R = { survey, held: { runs: keyRuns(all), town: keyRuns([...town].filter((k) => !wall.has(k))), terrain: [] }, standing, gates: [gate] };
  const beside = { id: 'rg9', claim: [0, 0, W - 1, D - 1], lots: [], keep: [], graph: ir.graph };
  return { ir, R, beside, gate, wall };
}

/** The "x,z" keys of rects [x0, z0, x1, z1]. */
export function runKeysOf(rects, into = new Set()) {
  for (const q of rects ?? []) for (let z = q[1]; z <= q[3]; z++) for (let x = q[0]; x <= q[2]; x++) into.add(`${x},${z}`);
  return into;
}
