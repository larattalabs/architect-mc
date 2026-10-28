// Shared helpers for the 7a GJ tests (not a test file itself): a walled town (D3's flat_village town with a ring round it: a C38 wall
// region `wall.around {feature: {region}}`, or the town's own K1 wall as a part of the town region) and the reach inputs the mod would
// send for a district beside it (a map {town, wall region} when the ring is its own region, §4).
import { planRegion } from '../lib/region/plan.mjs';
import { besideData, besideGates, besideStanding, keyRuns } from '../lib/region/beside.mjs';
import { encodeColumns } from '../lib/region/pack.mjs';
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
  return { town, A, C, ringIr, check: r.check, world, besideReach: { rg1: townIn, rgW: wallIn }, townOnly: townIn };
}

/** Plan a districts region beside the walled town (rg1) with the given reach inputs over `world`. */
export async function planBesideWalled({ W, districts = GJ_ONE('east'), claimB = GJ_EAST, besideReach = W.besideReach, unsafe = null, seed = '1' }) {
  const claim = { minX: claimB[0], minZ: claimB[1], maxX: claimB[2], maxZ: claimB[3], minY: -64, maxY: 319 };
  const survey = columnsOf(W.world, claimB[0], claimB[1], claimB[2] - claimB[0] + 1, claimB[3] - claimB[1] + 1);
  return planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts, ...(unsafe ? { _unsafe: unsafe } : {}) } }, survey, claim, seed, beside: besideData('rg1', W.A, W.town.p.ir, claimB), besideReach });
}
