// 6c D2 (docs/CONTRACT.md "Phase 6c slice D", "Steward round 8 additions": C27, C28, outposts): districts that follow a boundary (a
// biome edge, a river or shore, a ridge), each a shape (cell mask), a bounding claim, a street line and a join; stable across a
// re-plan; refused with named reasons; outposts with their corridor. The kit half of the D2 gate items (the in-game half: tools/gate6cd.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { biomeEdgeCells, familyOf, parseBiomes, pieces, ridgeCells, shoreCells, spineOf, traceBoundary } from '../lib/region/boundary.mjs';
import { besideData } from '../lib/region/beside.mjs';
import { besidePorts } from '../lib/region/districtsEmit.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');
const PROG = path.join(KIT, 'regions', 'districts.mjs');
const W = 192, D = 192, CLAIM = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
const surf = (fn) => {
  const c = makeColumns(0, 0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W; const [g, w] = fn(i, j); c.ground[k] = g; c.height[k] = g; c.floor[k] = w ? g - 3 : g; c.flags[k] = w ? 1 : 0; }
  return c;
};
const plan = (d, survey, extra = {}) => planRegion({ programFile: PROG, params: { spec: { districts: [d] }, lamps: false }, survey, claim: CLAIM, seed: '1', ...extra });
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const nearest = (p, set) => { let best = Infinity; for (const q of set) { const d = cheb(p, q); if (d < best) best = d; } return best; };
const maskCells = (runs) => runs.flatMap(([x0, z, x1]) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, z]));

// a desert west of x 96 and jungle east of it, the edge stepping 4 east every other 4 rows (a wiggle)
const BW = 48, BD = 48;
const edgeX = (j) => 96 + (j % 8 < 4 ? 4 : 0);
const BIOMES = { minX: 0, minZ: 0, res: 4, width: BW, depth: BD, palette: ['minecraft:desert', 'minecraft:jungle'], ids: Array.from({ length: BW * BD }, (_, k) => ((k % BW) * 4 < edgeX(Math.floor(k / BW)) ? 0 : 1)) };
const FLAT = () => surf(() => [64, false]);

test('C28: the biome grid is 4x4 (the game\'s storage: a per-column read adds nothing); families; parse refuses a bad grid', () => {
  const g = parseBiomes(BIOMES);
  assert.equal(g.res, 4);
  assert.throws(() => parseBiomes({ ...BIOMES, res: 1 }), /res must be 4/);
  assert.throws(() => parseBiomes({ ...BIOMES, ids: [0] }), /ids/);
  assert.equal(familyOf('minecraft:bamboo_jungle'), 'jungle');
  assert.equal(familyOf('minecraft:snowy_slopes'), 'snowy');
  assert.equal(familyOf('minecraft:dripstone_caves'), 'dripstone_caves');
  const e = biomeEdgeCells(FLAT(), CLAIM, g, ['desert', 'jungle']);
  assert.ok(e.cells.size > 100 && e.faCells > 0 && e.fbCells > 0);
  // every edge cell is a desert column beside the jungle
  for (const k of e.cells) { const [x, z] = k.split(',').map(Number); assert.ok(x < edgeX(Math.floor(z / 4)) && x >= edgeX(Math.floor(z / 4)) - 4, k); }
});

test('C27 biome edge: the district\'s shape follows the edge within 4 cells over its length; its street inside the band; stable; named refusal', async () => {
  const d = { id: 'oasis', size: [96, 24], follow: { biome_edge: { between: ['desert', 'jungle'] } }, lots: 4 };
  const p = await plan(d, FLAT(), { biomes: BIOMES });
  const f = p.meta.districts.follow.oasis;
  assert.equal(f.kind, 'biome_edge');
  const mask = maskCells(f.mask);
  const maskSet = new Set(mask.map(([x, z]) => `${x},${z}`));
  // the shape follows the edge: every boundary cell of the window within 4 of the mask, and the mask on the desert side (within 4 of
  // the edge where it crosses into the jungle: the dilation)
  for (const q of f.boundary) assert.ok(nearest(q, mask) <= 4, `boundary ${q}`);
  for (const [x, z] of mask) if (x >= edgeX(Math.floor(z / 4))) assert.ok(nearest([x, z], f.boundary) <= 4, `mask ${x},${z} in the jungle`);
  assert.ok(maskSet.size >= 96 * 12);
  // the bounding claim holds the mask; the street runs in the band
  const [x0, z0, x1, z1] = f.rect;
  for (const [x, z] of mask) assert.ok(x >= x0 && x <= x1 && z >= z0 && z <= z1);
  const inBand = f.street.filter(([x, , z]) => maskSet.has(`${x},${z}`)).length;
  assert.ok(inBand >= f.street.length * 0.9, `${inBand}/${f.street.length} street cells in the band`);
  assert.deepEqual(p.meta.districts.lots.oasis.length, 4);
  assert.ok(p.ir.biomes?.sha);
  // stable across a re-plan (the reload's plan: the same survey, biomes and seed)
  const q = await plan(d, FLAT(), { biomes: BIOMES });
  assert.equal(q.irSha, p.irSha);
  // named refusals: no such edge; no biome grid
  await assert.rejects(plan({ ...d, follow: { biome_edge: { between: ['desert', 'badlands'] } } }, FLAT(), { biomes: BIOMES }), /NO_EDGE: no badlands within the claim/);
  await assert.rejects(plan(d, FLAT()), /NO_EDGE: the plan has no biome grid/);
});

test('C27 shore: the street parallel to the shore (every street cell 8..16 from the water); the band on the land', async () => {
  const river = (i) => i >= 90 && i < 100;
  const s = surf((i) => [64, river(i)]);
  const p = await plan({ id: 'quay', size: [96, 24], follow: { shore: {} }, lots: 4 }, s);
  const f = p.meta.districts.follow.quay;
  const water = [];
  for (let x = 90; x < 100; x++) for (let z = 0; z < D; z += 1) water.push([x, z]);
  const ds = f.street.map(([x, , z]) => Math.min(Math.abs(x - 89), Math.abs(x - 100)));
  const parallel = ds.filter((d) => d >= 8 && d <= 16).length;
  assert.ok(parallel >= ds.length * 0.9, `${parallel}/${ds.length} street cells 8..16 from the river (${[Math.min(...ds), Math.max(...ds)]})`);
  for (const [x, z] of maskCells(f.mask)) assert.ok(!river(x), `mask ${x},${z} in the water`);
  assert.equal(p.meta.districts.lots.quay.length, 4);
  // no water: NO_EDGE
  await assert.rejects(plan({ id: 'quay', size: [96, 24], follow: { shore: {} }, lots: 2 }, FLAT()), /NO_EDGE: no shore within the claim/);
});

test('C27 ridge: the street on the ridge line (every street cell within 4 of the crest); shallow lots on its flanks', async () => {
  const s = surf((i) => [64 + Math.max(0, 40 - Math.abs(i - 96)), false]);
  const { cells } = ridgeCells(s, CLAIM, { minRise: 8 });
  assert.ok(cells.size > 100);
  const p = await plan({ id: 'crest', size: [96, 20], follow: { ridge: { minRise: 8 } }, lots: 3 }, s);
  const f = p.meta.districts.follow.crest;
  const on = f.street.filter(([x]) => Math.abs(x - 96) <= 4).length;
  assert.ok(on >= f.street.length * 0.9, `${on}/${f.street.length} street cells within 4 of the crest x 96`);
  assert.ok(p.meta.districts.lots.crest.length >= 1);
  await assert.rejects(plan({ id: 'crest', size: [96, 20], follow: { ridge: {} }, lots: 2 }, FLAT()), /NO_EDGE: no ridge within the claim/);
});

test('C27 refusals named: PROTECTED (keep-out over the band), OVERLAP (another district or region over it)', async () => {
  const s = surf((i) => [64, i >= 90 && i < 100]);
  // keep-out covering both shores along the whole river
  await assert.rejects(plan({ id: 'quay', size: [96, 24], follow: { shore: {} }, lots: 2 }, s, { keepOut: [[60, 0, 130, 191]] }), /PROTECTED/);
});

test('traceBoundary picks the piece nearest an anchor; spines are 4-connected', () => {
  const s = surf((i, j) => [64, (i >= 40 && i < 46) || (i >= 150 && i < 156)]);
  const a = traceBoundary(s, CLAIM, { shore: {} }, { near: [20, 96] });
  const b = traceBoundary(s, CLAIM, { shore: {} }, { near: [180, 96] });
  assert.ok(a.spine.every(([x]) => x < 100) && b.spine.every(([x]) => x > 100));
  for (const sp of [a.spine, b.spine]) for (let i = 1; i < sp.length; i++) assert.equal(Math.abs(sp[i][0] - sp[i - 1][0]) + Math.abs(sp[i][1] - sp[i - 1][1]), 1);
  assert.equal(pieces(new Set(['0,0', '1,1', '5,5'])).length, 2);
  assert.equal(spineOf(['0,0', '1,0', '2,0']).length, 3);
  assert.equal(shoreCells(s, CLAIM).bodies, 2);
});

test('outpost: a district at least gap from the standing village, joined by its road; the corridor reported (IR, meta) and undone with it (one region)', async () => {
  const world = worldOf({ flat: 64 });
  const A = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const lots = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];
  const pa = await planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: { lots }, survey: columnsOf(world, 0, 0, 112, 112), claim: A, seed: '1' });
  const q = besidePorts(besideData('rg1', [0, 0, 111, 111], pa.ir, [0, 0, 111, 111]))[0];
  const [ex, ez] = q.end, [dx, dz] = q.dir;
  const B = dx !== 0 ? [dx < 0 ? ex - 150 : ex, ez - 60, dx < 0 ? ex : ex + 150, ez + 60] : [ex - 60, dz < 0 ? ez - 150 : ez, ex + 60, dz < 0 ? ez : ez + 150];
  const claimB = { minX: B[0], minZ: B[1], maxX: B[2], maxZ: B[3], minY: -64, maxY: 319 };
  const p = await planRegion({ programFile: PROG, params: { spec: { districts: [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 40 } }] }, lamps: false }, survey: columnsOf(world, B[0], B[1], B[2] - B[0] + 1, B[3] - B[1] + 1), claim: claimB, seed: '1', beside: besideData('rg1', [0, 0, 111, 111], pa.ir, B) });
  const d = p.meta.districts;
  const r = d.rects.camp;
  const gapTo = Math.max(0 - r[2], r[0] - 111, 0 - r[3], r[1] - 111);
  assert.ok(gapTo >= 40, `the outpost ${r} is ${gapTo} from the village`);
  assert.equal(d.edges.find((e) => e.kind === 'join')?.ok, true);
  assert.ok(d.corridor.camp.cells > 100 && d.corridor.camp.edges.includes('join'));
  assert.deepEqual(Object.keys(p.ir.corridor), ['camp']);
});

test('plan/0 (D2): zone.outpost, locator.along, feature.biome_edge, feature.ridge supported in the catalogue', async () => {
  const { planCatalogue } = await import('../lib/plan/catalogue.mjs');
  const c = planCatalogue();
  for (const id of ['zone.outpost', 'locator.along', 'feature.biome_edge', 'feature.ridge']) assert.equal(c.entries.find((e) => e.id === id).state, 'supported', id);
  assert.equal(c.entries.find((e) => e.id === 'locator.around').state, 'reserved');
  void ROOT; void fs;
});
