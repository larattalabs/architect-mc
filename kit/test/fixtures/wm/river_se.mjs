// (8c SE) river_se: a test-only region (not in the catalogue; wm_demo's pattern) for slice SE's settle step: a stepped current (8c
// contract §2.6's shape) from one head reach into a terminal pool, the head simulated by the water model (`model: 'wm'`). Along +x from
// 12 in from the claim's west edge, on level ground g, `width` lanes (default 3), `runs` runs (default 8) of `run` cells (default 6) each ending
// in a 1-block step (handriver.mjs's river, generalised; the kinds flowingWater and volume:levels wait for 8cF/VS):
//   mound   stone dx 0..7 + run x (runs - 1) - 1, g + 1..g + runs + 1
//   r1      the head reach (wm): dx 1..6, 2 deep, surface H = g + runs; its outlets the first run's cells at dx 7
//   current run k at H - k over a bed at H - k - 1, dx 7 + run k .. 6 + run (k + 1), its overhang over the next run falling; the
//           banks are the head's lining (the face neighbours of the current's cells but the cells over it), all runs in the mound but
//           the last, on the natural ground between its lining walls
//   r2      the terminal pool (an H body): 8 long, g - 1..g, dug into the ground; the current falls onto its first row
// params: {runs, run, width, variant: 'none' | 'nowatch'}. 'nowatch' is not a plan variant: the lint tests drop the IR's watch instead.
import { region } from '../../../lib/region/program.mjs';

export const id = 'river_se';
export const catalogue = false;
export const params = { runs: { type: 'int', min: 1, max: 160, default: 8 }, run: { type: 'int', min: 2, max: 6, default: 6 }, width: { type: 'int', min: 1, max: 5, default: 3 } };

const box = (x0, y0, z0, x1, y1, z1) => { const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]); return out; };
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SHELL = 'minecraft:stone_bricks', BED = 'minecraft:clay', LINING = 'minecraft:polished_andesite';

/** The layout from an origin [x, z] and the ground g: {mound, carve, r1, r2, water, lining, join}. */
export function layout([ox, oz], g, { runs = 8, run = 6, width = 3 } = {}) {
  const X = (dx) => ox + dx, Z = (dz) => oz + dz, H = g + runs;
  const a = -((width - 1) >> 1);
  const lanes = Array.from({ length: width }, (_, i) => Z(a + i));
  const zl = lanes[0], zh = lanes[lanes.length - 1];
  const end = 7 + run * (runs - 1) - 1;
  const mound = [X(0), g + 1, zl - 3, X(end), g + runs + 1, zh + 3];
  const carve = [[X(1), H - 1, zl, X(6), g + runs + 1, zh]];
  const water = [];
  for (let k = 0; k < runs; k++) {
    const x0 = 7 + run * k, x1 = x0 + run - 1, y = H - k;
    if (k < runs - 1) carve.push([X(x0), y, zl, X(x1), g + runs + 1, zh]);
    for (let dx = x0; dx <= x1; dx++) for (const z of lanes) water.push([X(dx), y, z]);
    for (const z of lanes) water.push([X(x1 + 1), y, z]);
  }
  const p0 = 7 + run * runs;
  const r1 = { cells: box(X(1), H - 1, zl, X(6), H, zh), level: H, outlets: lanes.map((z) => [X(7), H, z]) };
  const r2 = { cells: box(X(p0 + 1), g - 1, zl, X(p0 + 8), g, zh), level: g, outlets: lanes.map((z) => [X(p0), g + 1, z]) };
  carve.push([X(p0 + 1), g - 1, zl, X(p0 + 8), g, zh]);
  const wet = new Set([...water, ...r1.cells, ...r2.cells].map(k3));
  const seen = new Set(), lining = [];
  for (const [x, y, z] of water) for (const [dx, dy, dz] of N6) {
    if (dy === 1) continue;
    const c = [x + dx, y + dy, z + dz], k = k3(c);
    if (wet.has(k) || seen.has(k)) continue;
    seen.add(k);
    lining.push(c);
  }
  return { mound, carve, r1, r2, water, lining, H, join: { body: 'river_r2', cells: lanes.map((z) => [X(p0 + 1), g, z]) }, length: p0 + 9 };
}

export default function riverSe(ctx) {
  const { claim, survey } = ctx;
  const P = { runs: ctx.params?.runs ?? 8, run: ctx.params?.run ?? 6, width: ctx.params?.width ?? 3 };
  const r = region(ctx);
  r.stages(['ground', 'fluids']);
  const ox = claim.minX + 12, oz = claim.minZ + ((claim.maxZ - claim.minZ + 1) >> 1);
  const g = survey.groundAt(ox, oz);
  r.anchor('entrance', [ox, g + 1, oz - 10]);
  r.anchor('spawn', [ox, g + 1, oz - 10]);
  const L = layout([ox, oz], g, P);
  const [mx0, my0, mz0, mx1, my1, mz1] = L.mound;
  const cols = [];
  for (let x = mx0; x <= mx1; x++) for (let z = mz0; z <= mz1; z++) cols.push(x, z, my0, my1, 0);
  r.part('river_mound', { stage: 'ground' }).columns({ abs: 0 }, { abs: 0 }, cols, ['minecraft:stone'], { cond: 3 });
  const cc = [];
  for (const [x0, y0, z0, x1, y1, z1] of L.carve) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cc.push(x, z, y0, y1, 0);
  r.part('river_carve', { stage: 'ground' }).columns({ abs: 0 }, { abs: 0 }, cc, [null], { cond: 3 });
  const shellRole = (x, y, z, where) => (where === 'lining' ? LINING : where === 'rim' ? SHELL : BED);
  r.fluidBody(L.r2.cells, { id: 'river_r2', part: 'river', kind: 'pool', stage: 'ground', level: L.r2.level, outlets: L.r2.outlets, shellRole });
  r.fluidBody(L.r1.cells, { id: 'river_r1', part: 'river', kind: 'river', stage: 'ground', level: L.r1.level, outlets: L.r1.outlets, lining: L.lining, joins: [L.join], shellRole, model: 'wm' });
  return r;
}
