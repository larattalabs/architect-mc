// Shared helpers for the 6c D3 tests (not a test file itself): a standing town and its reach inputs (the town claim's survey after the
// town, the held columns from its realised cells, the standing data), as the mod would send them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { besideData, besideStanding, keyRuns } from '../lib/region/beside.mjs';
import { columnsOf, realiseAll, worldOf } from './region-helpers.mjs';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const D3_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }, { id: 'smithy_1', type: 'smithy', size: [9, 9] }, { id: 'farm_1', type: 'farm', size: [13, 13] }];

/** A world after a plan's cells: each column's ground raised to its top written solid cell (air cells cut it down to below them). */
export function afterWorld(world, cells) {
  const top = new Map();
  for (const c of cells.values()) {
    const k = `${c.x},${c.z}`;
    const air = /^minecraft:(air|cave_air)$/.test(c.state) || c.state === 'air';
    const t = top.get(k) ?? { solid: -Infinity, air: Infinity };
    if (air) t.air = Math.min(t.air, c.y); else t.solid = Math.max(t.solid, c.y);
    top.set(k, t);
  }
  return (x, z) => {
    const v = world(x, z), t = top.get(`${x},${z}`);
    if (!t) return v;
    let g = v.g;
    if (t.solid > g) g = t.solid;
    if (t.air <= g && t.solid < t.air) g = Math.min(g, t.air - 1);
    return { ...v, g, h: Math.max(v.h, g), f: Math.min(v.f, g) };
  };
}

/** The reach inputs of a standing town: its realised cells' columns are held (by the town; `terrain` the ones its non-props terrain parts alone write). */
export function reachInputs({ id = 'rg1', ir, world, claim, others = [] }) {
  const cells = realiseAll(ir, world);
  const terrainIr = { ...ir, parts: ir.parts.filter((p) => p.set === 'terrain' && !/^props/.test(p.id)) };
  const tCells = realiseAll(terrainIr, world);
  const all = new Set([...cells.values()].map((c) => `${c.x},${c.z}`));
  // the road items the mod lays (4e: the road's width and its verge) are the town's too, never terrain
  const roads = new Set();
  for (const rd of ir.roads ?? []) {
    const pts = rd.points.map((q) => [q[0], q[2]]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]], h = Math.floor((rd.width ?? 3) / 2) + 1;
      for (let x = Math.min(a[0], b[0]) - (a[1] === b[1] ? 0 : h); x <= Math.max(a[0], b[0]) + (a[1] === b[1] ? 0 : h); x++) for (let z = Math.min(a[1], b[1]) - (a[0] === b[0] ? 0 : h); z <= Math.max(a[1], b[1]) + (a[0] === b[0] ? 0 : h); z++) roads.add(`${x},${z}`);
    }
  }
  for (const k of roads) all.add(k);
  const tcols = new Set([...tCells.values()].map((c) => `${c.x},${c.z}`));
  // a column is terrain-only when every cell the town wrote there is a terrain cell
  const nonTerrain = new Set();
  for (const [k, c] of cells) if (!tCells.has(k)) nonTerrain.add(`${c.x},${c.z}`);
  const terrain = [...tcols].filter((k) => !nonTerrain.has(k) && !roads.has(k));
  const otherKeys = new Set();
  for (const q of others) for (let z = q[1]; z <= q[3]; z++) for (let x = q[0]; x <= q[2]; x++) otherKeys.add(`${x},${z}`);
  const after = afterWorld(world, cells);
  return {
    cells,
    besideReach: {
      survey: columnsOf(after, claim[0], claim[1], claim[2] - claim[0] + 1, claim[3] - claim[1] + 1),
      held: { runs: keyRuns(new Set([...all, ...otherKeys])), town: keyRuns([...all].filter((k) => !otherKeys.has(k))), terrain: keyRuns(terrain.filter((k) => !otherKeys.has(k))) },
      standing: besideStanding(id, claim, ir),
    },
    after,
  };
}

/** A flat_village town on a flat world (the D1 beside fixture: 112 x 112, 5 lots; its street ends at x 12 and 74, z 53). */
export async function d3Town({ world = worldOf({ flat: 64 }), claim = [0, 0, 111, 111], lots = D3_LOTS, seed = '1', params = {} } = {}) {
  const A = { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3], minY: -64, maxY: 319 };
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: { lots, ...params }, survey: columnsOf(world, claim[0], claim[1], claim[2] - claim[0] + 1, claim[3] - claim[1] + 1), claim: A, seed });
  return { world, p, claim };
}

/** Plan a districts region beside a town (with the reach inputs). */
export async function planBeside({ town, districts, claimB, besideReach = null, world = town.world, seed = '1', unsafe = null, id = 'rg1' }) {
  const claim = { minX: claimB[0], minZ: claimB[1], maxX: claimB[2], maxZ: claimB[3], minY: -64, maxY: 319 };
  const survey = columnsOf(world, claimB[0], claimB[1], claimB[2] - claimB[0] + 1, claimB[3] - claimB[1] + 1);
  return planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts, ...(unsafe ? { _unsafe: unsafe } : {}) } }, survey, claim, seed, beside: besideData(id, town.claim, town.p.ir, claimB), ...(besideReach ? { besideReach } : {}) });
}
