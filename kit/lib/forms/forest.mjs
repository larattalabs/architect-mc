// (6c F3 §10.3) A forest of giant trees over a share of a region's claim, with undergrowth: the forest-heavy benchmark variant
// (kit/regions/mega_bench_forest.mjs) and any program that wants one. Plan time only.
//
// The trees stand on the columns the region leaves free: none it wrote so far (the draft virtual world's written columns, grown by 1: a
// canopy never over a road or a terrace), no lot box + 3 (lot + 1 grown by 2), no survey water, lava or natural tree column, one free column between two canopies (their leaves never touch). A few
// variants per species are grown once at the origin and baked; every other tree of a variant places its blob again by origin (one side
// blob each: the IR and the blobs stay small). Each tree's foot (its trunk and roots) stands on level ground (a range of at most 3, F3's roughness).
// Then the undergrowth: F2's scatter under the canopies, off the trees' feet (bushes, ferns, moss carpets as raw items on the survey's
// ground, and stumps; the claim holds no frozen volume, so F2's bundled plants would not fire).
import { fnv64 } from '../noise.mjs';
import { draftIR } from '../region/plan.mjs';
import { buildVirtual } from '../region/vworld.mjs';
import { FLAG_LAVA, FLAG_TREE, FLAG_WATER } from '../region/pack.mjs';
import { sampleIndex } from '../region/survey.mjs';
import { scatter } from '../region/scatterPlan.mjs';
import { giantTree } from './giantTree.mjs';
import { eachColumn, runsRect, shiftRuns } from './states.mjs';

export const FOREST = Object.freeze({ species: ['oak', 'spruce', 'birch', 'dark_oak', 'jungle', 'cherry'], variants: 3, cover: 0.3, step: 2, margin: 1, lotMargin: 3 });

/** Grow the forest into region `r` (stage `stage`). Returns its record (also `r.meta.forest`). */
export function growForest(r, ctx, { stage, cover = FOREST.cover, species = FOREST.species, variants: nv = FOREST.variants, undergrowth = true } = {}) {
  const claim = r.claim;
  const cols = ctx.survey.columns;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const at = (x, z) => (z - claim.minZ) * W + (x - claim.minX);
  const inC = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  const taken = new Uint8Array(W * D);
  // the region so far: its written columns (the draft virtual world), grown by the margin
  const { ir, blobs } = draftIR(r);
  const { vw } = buildVirtual({ ir, survey: cols, blobs });
  const written = new Uint8Array(W * D);
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) if (vw.wHi[vw.colIndex(x, z)] >= vw.wLo[vw.colIndex(x, z)]) written[at(x, z)] = 1;
  const M = FOREST.margin;
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
    if (!written[at(x, z)]) continue;
    for (let dz = -M; dz <= M; dz++) for (let dx = -M; dx <= M; dx++) if (inC(x + dx, z + dz)) taken[at(x + dx, z + dz)] = 1;
  }
  const LM = FOREST.lotMargin;
  for (const l of r.lots) { const b = l.box; for (let z = b.minZ - LM; z <= b.maxZ + LM; z++) for (let x = b.minX - LM; x <= b.maxX + LM; x++) if (inC(x, z)) taken[at(x, z)] = 1; }
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
    if (cols.flags[sampleIndex(cols, x, z)] & (FLAG_WATER | FLAG_LAVA | FLAG_TREE)) taken[at(x, z)] = 1;
    if (x < claim.minX + 2 || x > claim.maxX - 2 || z < claim.minZ + 2 || z > claim.maxZ - 2) taken[at(x, z)] = 1;
  }
  let free = 0;
  for (let i = 0; i < W * D; i++) if (!taken[i]) free++;
  // the variants: grown once at the origin on flat ground (a seed per species and variant), largest first
  const variants = [];
  for (const sp of species) for (let v = 0; v < nv; v++) {
    const g = giantTree({ at: [0, 64, 0], preset: sp, seed: fnv64(ctx.seed, 'forest', sp, v).hex });
    const foot = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const k of g.cells.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      if (y <= 65) foot.push([x, z]);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    }
    variants.push({ sp, v, g, foot, min: [minX, minY, minZ], blob: `fv_${sp}_${v}`, placed: 0 });
  }
  const order = [];
  for (let z = claim.minZ + 2; z <= claim.maxZ - 2; z += FOREST.step) for (let x = claim.minX + 2; x <= claim.maxX - 2; x += FOREST.step) order.push([x, z]);
  const fr = ctx.rng('forest');
  const want = Math.ceil(cover * W * D);
  const ground = (x, z) => ctx.survey.heightAt(x, z);
  const sites = [];
  let covered = 0;
  // a raster scan: at each free column, the variants in a seeded order (each species' variants together), each anchored by its mask's
  // north-west corner at that column (so a large crown fits beside the trees placed before it); the first that fits is taken
  const fits = (V, ox, oz) => {
    let ok = true, n = 0;
    eachColumn(V.g.columns, (dx, dz) => { if (!ok) return; const X = ox + dx, Z = oz + dz; if (!inC(X, Z) || taken[at(X, Z)]) ok = false; else n++; });
    if (!ok) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const [dx, dz] of V.foot) { const g = ground(ox + dx, oz + dz); if (g < lo) lo = g; if (g > hi) hi = g; }
    return hi - lo > 3 ? 0 : n;
  };
  for (const [x, z] of order) {
    if (covered >= want) break;
    if (taken[at(x, z)]) continue;
    const v0 = Math.floor(fr() * variants.length);
    for (let t = 0; t < variants.length; t++) {
      const V = variants[(v0 + t) % variants.length];
      const rel = V.rect ??= runsRect(V.g.columns);
      // the mask's north-west column at (x, z): its first row's first run
      const ox = x - V.g.columns[1], oz = z - V.g.columns[0];
      const n = fits(V, ox, oz);
      if (!n) continue;
      eachColumn(V.g.columns, (dx, dz) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (inC(ox + dx + a, oz + dz + b)) taken[at(ox + dx + a, oz + dz + b)] = 1; });
      sites.push({ x: ox, z: oz, g: ground(ox, oz), V });
      covered += n;
      void rel;
      break;
    }
  }
  // the trees: the first of a variant bakes its blob, the rest place it again by origin
  const canopy = new Uint8Array(W * D), footCol = new Uint8Array(W * D);
  sites.forEach((s, i) => {
    const { V } = s;
    const dy = s.g - 64;
    const columns = shiftRuns(V.g.columns, s.x, s.z);
    const b = V.g.bounds;
    const bounds = { minX: b.minX + s.x, maxX: b.maxX + s.x, minZ: b.minZ + s.z, maxZ: b.maxZ + s.z, minY: b.minY + dy, maxY: b.maxY + dy };
    const id = `forest_${String(i + 1).padStart(4, '0')}`;
    const gen = { generator: V.g.generator, version: V.g.version, seed: V.g.seed, params: { ...V.g.params, at: [s.x, s.g, s.z] }, ops: V.g.ops, columns, bounds, blob: V.blob };
    if (V.placed === 0) {
      const cells = new Map();
      for (const [k, st] of V.g.cells) { const [x, y, z] = k.split(',').map(Number); cells.set(`${x + s.x},${y + dy},${z + s.z}`, st); }
      r.form(id, { ...gen, cells }, { stage });
    } else r.form(id, { ...gen, cells: V.g.cells, reuse: { origin: [V.min[0] + s.x, V.min[1] + dy, V.min[2] + s.z], cells: V.g.cells.size } }, { stage });
    V.placed++;
    eachColumn(columns, (X, Z) => { if (inC(X, Z)) canopy[at(X, Z)] = 1; });
    for (const [dx, dz] of V.foot) if (inC(s.x + dx, s.z + dz)) footCol[at(s.x + dx, s.z + dz)] = 1;
  });
  if (undergrowth && sites.length) {
    const values = new Uint8Array(W * D);
    for (let i = 0; i < W * D; i++) values[i] = canopy[i] && !footCol[i] ? 255 : 0;
    r.field('forest_under', { type: 'u8', minX: claim.minX, minZ: claim.minZ, width: W, depth: D, res: 1, values });
    const soil = ['SOIL', 'LOOSE'];
    scatter(r, 'forest_floor', {
      grid: 4, jitter: 1, density: { field: 'forest_under', scale: [0, 0.4] }, avoidWritten: false,
      items: [{ w: 4, block: 'minecraft:bush', anchor: 'ground', on: soil }, { w: 3, block: 'minecraft:fern', anchor: 'ground', on: soil }, { w: 3, block: 'minecraft:moss_carpet', anchor: 'ground', on: [...soil, 'ROCK'] }, { w: 1, item: 'stump' }],
    }, { stage });
  }
  const rec = { free: Math.round((1000 * free) / (W * D)) / 1000, trees: sites.length, variants: variants.length, cover: covered, coverShare: Math.round((1000 * covered) / (W * D)) / 1000,
    bySpecies: Object.fromEntries(species.map((sp) => [sp, sites.filter((s) => s.V.sp === sp).length])), cells: sites.reduce((n, s) => n + s.V.g.cells.size, 0) };
  r.meta.forest = rec;
  r.note(`forest: ${sites.length} giant trees over ${(100 * covered / (W * D)).toFixed(1)}% of the claim (${variants.length} baked variants, ${rec.cells} tree cells)`);
  return rec;
}
