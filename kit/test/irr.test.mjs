// (6c IRR) Farm irrigation, offline and $0 (docs/CONTRACT.md "Phase 6c slice IRR" §10 item 1): detection (a lot, a zone, false on a
// lot over its zone, type-implied farms, template lots, district lots), the grid (every field column within 4 of a source on every
// field size 3..62 and every front), the cells the lot's design leaves (the mask), the lot's frame and the design checker's reserved
// cells, the notes, the checker's field model and M25:keep's own-lot exemption, and the broken variants caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey, stewardAnchors, checkPlanVolumes, FIX } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { asksIrrigate, axisSources, fieldFrame, fieldOf, gridOf, irrigateZones, irrigationCells, irrBodyId, lotFrame, zoneLots, HYDRATE } from '../lib/fluids/irrigate.mjs';
import { frameToTemplate, parseReserved, reservedHits, rotateBlock, templateToFrame, turnsToFace } from '../lib/reserved.mjs';

const load = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
const FRONTS = ['north', 'east', 'south', 'west'];
const lotOf = (W, D, front, at = [1000, 2000], floorY = 65) => ({ id: 'f', front, floorY, box: { minX: at[0], minY: floorY, minZ: at[1], maxX: at[0] + W - 1, maxY: floorY + 31, maxZ: at[1] + D - 1 } });

async function run(rel) {
  const fx = load(rel);
  const s = fx.terrain ? flatSurvey(fx.terrain) : flatSurvey();
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, ...(fx.biomes ? { biomes: fx.biomes } : {}) });
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded), prefix: false });
  return { r, rep };
}
const errors = (rep) => rep.findings.filter((f) => (f.severity ?? f.level) === 'error').map((f) => `${f.rule} ${f.message}`);
const notesOf = (r, part) => r.check.parts.find((a) => a.part === part)?.notes ?? [];
const irrWaters = (r) => (r.res.meta.waters ?? []).filter((w) => w.kind === 'irrigation');

test('detection: a lot, a zone, false over the zone, type-implied farms, template lots and district lots; structural, never a string', () => {
  const okAll = () => true;
  const zone = (z) => ({ family: 'zone', id: z.id, part: z });
  const order = [
    zone({ id: 'a', irrigate: true, program: { lots: [{ id: 'f1', type: 'farm' }, { id: 'f2', type: 'field', irrigate: false }, { id: 'h1', type: 'house' }] } }),
    zone({ id: 'b', program: { template: 'flat_village', params: { lots: [{ id: 'f3', type: 'orchard', irrigate: true }, { id: 'h2', type: 'house', irrigate: true }] } } }),
    zone({ id: 'c', program: { districts: [{ id: 'd', lots: [{ id: 'f4', type: 'barn', villager: 'farm', irrigate: true }] }] } }),
    zone({ id: 'd', irrigate: true, program: { lots: [{ id: 'h3', type: 'house' }] } }),
    zone({ id: 'e', notes: '"irrigate":true', program: { lots: [{ id: 'f5', type: 'farm' }] } }),
  ];
  const z = Object.fromEntries(irrigateZones(order, okAll).map((q) => [q.zone.id, q]));
  assert.deepEqual(z.a.lots.map((l) => l.id), ['f1'], 'the zone asks; f2 says false; the house is no farm (no note: only a lot asking itself gets one)');
  assert.deepEqual(z.a.notes, []);
  assert.deepEqual(z.b.lots.map((l) => l.id), ['f3'], 'a template\'s params.lots; an orchard is a farm by its type');
  assert.deepEqual(z.b.notes, ['irrigate: h2 is not a farm lot']);
  assert.deepEqual(z.c.lots.map((l) => l.id), ['f4'], 'a district\'s lots');
  assert.equal(z.d.lots.length, 0);
  assert.ok(/no farm lot/.test(z.d.notes[0]));
  assert.equal(z.e, undefined, 'a string is no irrigate');
  assert.equal(asksIrrigate(order), true);
  assert.equal(asksIrrigate([order[4]]), false);
  assert.deepEqual(zoneLots(order[2].part).map((l) => l.id), ['f4']);
});

test('the grid: every field column within 4 (Chebyshev) of a source, every source\'s four sides in its field, on field sides 3..62 and every front', () => {
  // 20 field sizes from 3 to 62 per axis (a lot is the field + 2 across, + 3 deep), crossed both ways, every front
  const sides = [3, 4, 5, 6, 8, 9, 10, 11, 13, 17, 18, 19, 26, 27, 28, 37, 44, 45, 55, 62];
  assert.equal(sides.length, 20);
  let lots = 0;
  for (const a of sides) for (const b of sides) for (const front of FRONTS) {
    const W = a + 2, D = b + 3;
    const [w, d] = front === 'east' || front === 'west' ? [D, W] : [W, D];
    const lot = lotOf(w, d, front);
    const f = fieldOf(lot);
    const g = gridOf(lot);
    assert.equal(g.length, Math.ceil(a / 9) * Math.ceil(b / 9), `${a} x ${b} ${front}: ceil(L / 9) a side`);
    for (let x = f.x0; x <= f.x1; x++) for (let z = f.z0; z <= f.z1; z++) {
      assert.ok(g.some(([sx, sz]) => Math.max(Math.abs(sx - x), Math.abs(sz - z)) <= HYDRATE), `${a} x ${b} ${front}: ${x} ${z} within ${HYDRATE}`);
    }
    for (const [sx, sz] of g) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      assert.ok(sx + dx >= f.x0 && sx + dx <= f.x1 && sz + dz >= f.z0 && sz + dz <= f.z1, `${a} x ${b} ${front}: a side of ${sx} ${sz} in the field`);
    }
    lots++;
  }
  assert.equal(lots, 1600);
  // the field: the border and the front row off (south front: the row before the apron's entrance side)
  const l = lotOf(13, 11, 'south');
  assert.deepEqual(fieldOf(l), { x0: 1001, z0: 2001, x1: 1011, z1: 2008 });
  assert.deepEqual(fieldOf(lotOf(13, 11, 'north')), { x0: 1001, z0: 2002, x1: 1011, z1: 2009 });
  assert.equal(fieldFrame(lotOf(5, 5, 'south')), null, 'a field side under 3 asks nothing');
  // ties to the back and to the left seen from the entrance: an even segment's centre rounds to the low end of the frame
  assert.deepEqual(axisSources(1, 8), [4]);
  assert.deepEqual(axisSources(1, 11), [3, 8]);
  assert.deepEqual(gridOf(lotOf(13, 11, 'south')).map((q) => q.slice(0, 2)), [[1003, 2004], [1008, 2004]]);
  assert.deepEqual(gridOf(lotOf(13, 11, 'north')).map((q) => q.slice(0, 2)), [[1009, 2006], [1004, 2006]], 'north: the back is +z, the left +x');
  assert.equal(irrBodyId('f1', 1, 0), 'f1_irr_1_0');
  assert.ok(irrBodyId('a'.repeat(60), 10, 10).length <= 48);
});

test('the irrigation cells (the mask): each source, its bed, its four sides and the cell over it; the lot\'s frame round trips', () => {
  const lot = lotOf(13, 11, 'east');
  const g = gridOf(lot);
  const cells = irrigationCells(lot, g);
  assert.equal(cells.length, 7 * g.length);
  for (const [x, z] of g) for (const c of [[x, 65, z], [x, 64, z], [x, 66, z], [x + 1, 65, z], [x - 1, 65, z], [x, 65, z + 1], [x, 65, z - 1]]) assert.ok(cells.some((q) => q.join() === c.join()), c.join());
  for (const front of FRONTS) {
    const F = lotFrame(lotOf(13, 11, front));
    for (const c of [[1000, 65, 2000], [1012, 66, 2010], [1005, 64, 2003]]) assert.deepEqual(F.toWorld(...F.toFrame(...c)), c, `${front} ${c}`);
    // the front row is the frame's last v
    const fr = { south: [1006, 65, 2010], north: [1006, 65, 2000], east: [1012, 65, 2005], west: [1000, 65, 2005] }[front];
    assert.equal(F.toFrame(...fr)[2], F.size[1] - 1, front);
  }
});

test('reserved: the design checker places a design as LotFitting does (rotated, centred, the other rounding for a north or east front)', () => {
  // a 5 x 3 design facing west on a 9 x 8 lot (in the frame): it turns 3 quarters to face south; its rotated footprint is 3 x 5
  const t = { size: [5, 4, 3], groundY: 1, front: 'west' };
  assert.equal(turnsToFace('west', 'south'), 3);
  assert.deepEqual(rotateBlock(0, 0, 5, 3, 3), [0, 4]);
  for (const front of FRONTS) {
    const r = parseReserved({ front, size: [9, 8], cells: [] });
    const u0 = front === 'north' || front === 'east' ? 3 : 3; // (9 - 3) / 2 = 3 exactly: no rounding
    assert.deepEqual(templateToFrame(0, 1, 0, t, r), [u0 + 0, 0, 3 + 4]);
    for (const c of [[0, 1, 0], [4, 2, 2], [2, 0, 1]]) assert.deepEqual(frameToTemplate(...templateToFrame(...c, t, r), t, r), c, `${front} ${c}`);
  }
  // an odd margin: a 4-wide design on a 9-wide lot: 2 from the left for a south or west front, 3 for a north or east one
  const t4 = { size: [4, 3, 3], groundY: 0, front: 'south' };
  assert.equal(templateToFrame(0, 0, 0, t4, { front: 'south', size: [9, 6] })[0], 2);
  assert.equal(templateToFrame(0, 0, 0, t4, { front: 'west', size: [9, 6] })[0], 2);
  assert.equal(templateToFrame(0, 0, 0, t4, { front: 'north', size: [9, 6] })[0], 3);
  assert.equal(templateToFrame(0, 0, 0, t4, { front: 'east', size: [9, 6] })[0], 3);
  // the hits: non-air blocks on a reserved cell; air is fine
  const r = { front: 'south', size: [9, 6], cells: [[2, 0, 3], [3, 0, 3]] };
  const hits = reservedHits([[0, 0, 0, 'minecraft:farmland'], [1, 0, 0, 'minecraft:air'], [2, 0, 0, 'minecraft:wheat']], t4, r);
  assert.deepEqual(hits.map((h) => h.at), [[2, 0, 3]]);
  assert.throws(() => parseReserved({ front: 'up', size: [1, 1], cells: [] }));
});

/**
 * The cross-check with the mod: LotFitting.fit + BlueprintTransform.rotateBlock on a lot in world coordinates (the table the mod's
 * LotMaskTest asserts too), through the kit's frame: the same world cell for a smaller design, rotated, on every front.
 */
export const FIT_TABLE = Object.freeze([
  // [lot front, lot box [x0, z0, x1, z1], design {size [sx, sz], front}, template cell [bx, bz], world [x, z]]
  ['south', [100, 200, 108, 205], { size: [4, 3], front: 'south' }, [0, 0], [102, 203]],
  ['north', [100, 200, 108, 205], { size: [4, 3], front: 'south' }, [0, 0], [105, 202]],
  ['east', [100, 200, 105, 208], { size: [4, 3], front: 'south' }, [0, 0], [103, 205]],
  ['west', [100, 200, 105, 208], { size: [4, 3], front: 'south' }, [0, 0], [102, 202]],
  ['south', [100, 200, 108, 205], { size: [5, 3], front: 'west' }, [4, 2], [105, 201]],
  ['east', [100, 200, 105, 208], { size: [5, 3], front: 'north' }, [1, 0], [105, 203]],
  ['north', [100, 200, 109, 205], { size: [3, 2], front: 'east' }, [2, 1], [105, 200]],
  ['west', [100, 200, 106, 209], { size: [4, 2], front: 'west' }, [3, 1], [103, 205]],
]);

test('reserved: the kit\'s frame agrees with the mod\'s placement table (LotFitting + rotateBlock) for smaller, rotated designs', () => {
  for (const [front, [x0, z0, x1, z1], d, [bx, bz], [wx, wz]] of FIT_TABLE) {
    const lot = { id: 'l', front, floorY: 65, box: { minX: x0, minY: 65, minZ: z0, maxX: x1, maxY: 80, maxZ: z1 } };
    const F = lotFrame(lot);
    const r = { front, size: F.size, cells: [] };
    const t = { size: [d.size[0], 4, d.size[1]], groundY: 0, front: d.front };
    const [u, y, v] = templateToFrame(bx, 0, bz, t, r);
    assert.deepEqual(F.toWorld(u, y, v), [wx, 65, wz], `${front} ${JSON.stringify(d)} ${bx},${bz}`);
  }
});

test('v62: v49\'s farms with irrigate: 2 + 1 sources, READY, clean (M25 and M1), the farm ponds beside, the artifact\'s lots[].irrigation', async () => {
  const { r, rep } = await run('valid/v62_irr_farm.json');
  assert.equal(r.check.overall, 'READY');
  assert.deepEqual(errors(rep), []);
  const w = irrWaters(r);
  assert.deepEqual(w.map((q) => q.id), ['f1_irr_0_0', 'f1_irr_1_0', 'f2_irr_0_0']);
  assert.ok(w.every((q) => q.volume === 'given' && q.cells === 1 && q.shell === 5 && q.spill === 0 && q.raised === false), JSON.stringify(w));
  assert.equal((r.res.meta.waters ?? []).filter((q) => q.kind === 'farm_pond').length, 2, 'both: the ponds outside the boxes too');
  // one frozen volume per lot, shared by its sources' guards
  const guards = (r.res.meta.planCheck?.links?.guards ?? []).filter((g) => /_irr_/.test(g.body));
  assert.equal(guards.length, 3);
  assert.equal(new Set(guards.filter((g) => /^f1_/.test(g.body)).map((g) => g.volume.sha)).size, 1);
  assert.ok(guards.every((g) => g.runs.every((v) => typeof v === 'number')), 'flat guard runs (H RC3)');
  const f1 = r.res.ir.lots.find((l) => l.id === 'f1');
  assert.equal(f1.irrigation.sources, 2);
  assert.equal(f1.irrigation.cells.reduce((n, q) => n + q[3] - q[2] + 1, 0), 14);
  const al = r.artifact.lots.find((l) => l.id === 'f1');
  assert.deepEqual(al.irrigation.cells, f1.irrigation.cells, 'the artifact lot carries the world cells');
  assert.deepEqual(al.irrigation.frame, [13, 11]);
  assert.equal(al.irrigation.lotCells.reduce((n, q) => n + q[3] - q[2] + 1, 0), 14, 'and the same cells in the lot\'s frame');
  assert.ok(!r.artifact.lots.find((l) => l.id === 'h1').irrigation, 'a lot without irrigation: no member');
  assert.ok(notesOf(r, 'farms').some((n) => /irrigate: f1 gets 2 sources \(2 x 1\)/.test(n)));
  // the shell: the bed (not the pad's top block) and four moisture-7 farmland sides, written by the source's own shell part
  const sp = r.res.ir.parts.find((p) => p.id === 'f1_irr_0_0_shell');
  assert.ok(sp.ops[0].materials.includes('minecraft:farmland[moisture=7]'));
  assert.equal(sp.stage, 'street');
  assert.equal(r.res.meta.planCheck.partOf['f1_irr_0_0_shell'], 'farms');
  // §7: the zone's bill: water free, each source's bed and its 4 farmland sides (farmland costs dirt)
  const bom = r.check.parts.find((a) => a.part === 'farms').cost.bom;
  assert.equal(Object.values(bom).reduce((t, n) => t + n, 0), 3 * 5, JSON.stringify(bom));
  assert.ok(bom['minecraft:dirt'] >= 12 && !bom['minecraft:farmland'] && !bom['minecraft:water'], JSON.stringify(bom));
});

test('v63: a 40 x 40 farm lot: 5 x 5 sources, one volume for the lot; the barn (irrigate false) none', async () => {
  const { r, rep } = await run('valid/v63_irr_large.json');
  assert.equal(r.check.overall, 'READY');
  assert.deepEqual(errors(rep), []);
  const w = irrWaters(r);
  assert.equal(w.length, 25);
  assert.ok(w.every((q) => /^big_irr_/.test(q.id)));
  const guards = (r.res.meta.planCheck?.links?.guards ?? []).filter((g) => /_irr_/.test(g.body));
  assert.equal(new Set(guards.map((g) => g.volume.sha)).size, 1, 'one frozen volume for the lot (the 16-volume limit)');
});

test('Steward\'s hamlet (irr/s01), a district farm lot (irr/d01): type-implied farms, READY, sources; the notes (r01-r03)', async () => {
  const s01 = await run('irr/s01_hamlet.json');
  assert.equal(s01.r.check.overall, 'READY');
  assert.deepEqual(errors(s01.rep), []);
  assert.equal(irrWaters(s01.r).length, 4);
  assert.ok(notesOf(s01.r, 'town').some((n) => /farmPond: farm_1 gets/.test(n)) && notesOf(s01.r, 'town').some((n) => /irrigate: farm_1 gets 4 sources/.test(n)));
  const d01 = await run('irr/d01_district.json');
  assert.equal(d01.r.check.overall, 'READY');
  assert.deepEqual(errors(d01.rep), []);
  assert.equal(irrWaters(d01.r).length, 2);
  assert.ok(d01.r.first.asked?.length || d01.r.asked?.length, 'the district lot\'s sources asked volumes (the two-plan flow)');
  for (const [rel, part, re] of [['irr/r01_not_farm.json', 'homes', /irrigate: h1 is not a farm lot/], ['irr/r02_cold.json', 'farms', /irrigate: the biome freezes the sources/], ['irr/r03_small.json', 'farms', /irrigate: f1's field is too small/]]) {
    const x = await run(rel);
    assert.equal(x.r.check.overall, 'READY', rel);
    assert.ok(notesOf(x.r, part).some((n) => re.test(n)), `${rel}: ${JSON.stringify(notesOf(x.r, part))}`);
    assert.equal(irrWaters(x.r).length, 0, `${rel}: nothing written`);
    assert.ok(!x.r.res.ir.lots.some((l) => l.irrigation), rel);
  }
});

test('the broken variants are caught: irrUnmasked (M25:clear), irrNoBed (M25:shell), irrBreachOut (M25:keep: outside its lot)', async () => {
  const u01 = await run('irr/u01_unmasked.json');
  assert.ok(errors(u01.rep).some((e) => /^M25:clear .*f1_irr_0_0/.test(e)), JSON.stringify(errors(u01.rep)));
  assert.equal(u01.r.res.ir.lots.find((l) => l.id === 'f1').irrigation.unmasked, true);
  const u02 = await run('irr/u02_nobed.json');
  assert.ok(errors(u02.rep).some((e) => /^M25:shell .*f1_irr_0_0.*not fluid-stopping/.test(e)), JSON.stringify(errors(u02.rep)));
  const u03 = await run('irr/u03_breach_out.json');
  assert.ok(errors(u03.rep).some((e) => /^M25:keep .*f1_irr_0_0.*outside its lot/.test(e)), JSON.stringify(errors(u03.rep)));
  // the exemption is the own lot's only: v62's sources stand inside their boxes, and no keep finding names a lot
  const v62 = await run('valid/v62_irr_farm.json');
  assert.ok(!v62.rep.findings.some((f) => /^M25:keep/.test(f.rule)));
});
