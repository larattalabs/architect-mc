// (M5 FC, S-M5-4) A module lot's field: `field {cells, crops}` on a plan lot, validated (params.mjs), recorded on the IR's lot as world runs
// (lots[].field) by the compiler, and absent everywhere else: a plan that asks no field compiles to the same IR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey, stewardAnchors, checkPlanVolumes, FIX } from './plan-helpers.mjs';
import { validateLots } from '../lib/params.mjs';
import { emitFields, parseField, FIELD_CROPS } from '../lib/region/field.mjs';
import { lotFrame } from '../lib/fluids/irrigate.mjs';

const load = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
async function compile(plan) {
  const s = flatSurvey();
  return checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
}
const cellsOf = (runs) => runs.flatMap(([x, z, y0, y1]) => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i, z]));
/** f1's field (13 x 11 farm lot): the IRR field u 1..11, v 1..7 at the floor. */
const FIELD = { cells: [], crops: ['minecraft:wheat', 'minecraft:carrots'] };
for (let v = 1; v <= 7; v++) for (let u = 1; u <= 11; u++) FIELD.cells.push([u, 0, v]);

test('parseField and validateLots: the shape, unique cells, known crops; a lot without one has no member', () => {
  assert.deepEqual(parseField({ cells: [[1, 0, 1], [1, 0, 1], [2, 0, 1]], crops: ['minecraft:wheat', 'minecraft:wheat'] }), { cells: [[1, 0, 1], [2, 0, 1]], crops: ['minecraft:wheat'] });
  for (const bad of [null, [], { cells: [], crops: ['minecraft:wheat'] }, { cells: [[1, 0]], crops: ['minecraft:wheat'] }, { cells: [[1, 0, 1]], crops: [] },
    { cells: [[1, 0, 1]], crops: ['minecraft:melon'] }, { cells: [[1, 0, 1]], crops: ['minecraft:wheat'], more: 1 }, { cells: [[-1, 0, 1]], crops: ['minecraft:wheat'] }]) {
    assert.throws(() => parseField(bad), /field/, JSON.stringify(bad));
  }
  assert.equal(FIELD_CROPS.length, 5);
  const [a, b] = validateLots([{ id: 'f1', type: 'farm', size: [13, 11], field: FIELD }, { id: 'h1', type: 'house', size: [9, 9] }]);
  assert.equal(a.field.cells.length, 77);
  assert.ok(!('field' in b));
  assert.throws(() => validateLots([{ id: 'f1', type: 'farm', size: [13, 11], field: { cells: [[0, 0, 0]], crops: ['minecraft:stone'] } }]), /lots\[0\]\.field\.crops/);
});

test('emitFields: frame to world for every front; a cell off the lot or under an irrigation cell dropped, a note each', () => {
  for (const front of ['north', 'east', 'south', 'west']) {
    const lot = { id: 'z_f', front, floorY: 65, box: { minX: 100, minY: 65, minZ: 200, maxX: 104, maxY: 90, maxZ: 206 } };
    const F = lotFrame(lot);
    const cells = [[0, 0, 0], [1, 0, 2], [40, 0, 0]];
    const out = emitFields([lot], [{ zone: 'z', def: { id: 'f', field: { cells, crops: ['minecraft:potatoes'] } } }]);
    assert.deepEqual(out.lots, ['z_f']);
    const world = cellsOf(lot.field.cells).sort();
    assert.deepEqual(world, [F.toWorld(0, 0, 0), F.toWorld(1, 0, 2)].sort(), front);
    assert.deepEqual(lot.field.frame, F.size);
    assert.deepEqual(lot.field.crops, ['minecraft:potatoes']);
    assert.ok(out.notes.get('z').some((n) => /1 cell\(s\) off the lot/.test(n)));
  }
  // a source at (101, 65, 201): its cell over its bed and over itself are irrigation cells, so the farmland at the bed's cell and the
  // source's own cell are dropped; the side shell's farmland (102, 65, 201) stays
  const lot = { id: 'f', front: 'south', floorY: 65, box: { minX: 100, minY: 65, minZ: 200, maxX: 104, maxY: 90, maxZ: 206 },
    irrigation: { cells: [[101, 201, 64, 66], [102, 201, 65, 65]] } };
  const out = emitFields([lot], [{ zone: 'z', def: { id: 'f', field: { cells: [[1, 0, 1], [1, -1, 1], [2, 0, 1]], crops: ['minecraft:wheat'] } } }]);
  assert.deepEqual(cellsOf(lot.field.cells), [[102, 65, 201]]);
  assert.ok(out.notes.get('z').some((n) => /2 cell\(s\) under an irrigation cell/.test(n)));
  const none = emitFields([], [{ zone: 'z', def: { id: 'q', field: FIELD } }]);
  assert.ok(none.notes.get('z').some((n) => /q was not placed/.test(n)));
});

test('v62 with a field on f1: the IR lot carries it (77 cells less the 2 sources\' and their beds\'), the same lots and irrigation; without one no member', async () => {
  const base = load('valid/v62_irr_farm.json').plan;
  const withField = structuredClone(base);
  withField.zones[0].program.lots[0].field = FIELD;
  const [r0, r1] = [await compile(base), await compile(withField)];
  assert.equal(r1.check.overall, 'READY');
  const f1 = r1.res.ir.lots.find((l) => l.id === 'f1');
  assert.deepEqual(f1.field.crops, ['minecraft:wheat', 'minecraft:carrots']);
  assert.deepEqual(f1.field.frame, [13, 11]);
  const world = cellsOf(f1.field.cells);
  assert.equal(world.length, 77 - 2, 'the two sources\' cells dropped (their cell above is kept open)');
  const F = lotFrame(f1);
  assert.ok(world.every(([x, y, z]) => { const [u, fy, v] = F.toFrame(x, y, z); return fy === 0 && u >= 1 && u <= 11 && v >= 1 && v <= 7; }));
  assert.ok(!r0.res.ir.lots.some((l) => 'field' in l), 'no field asked: no member');
  // the layout is the same (the seed follows the plan's bytes, so scatter differs; a plan with no field is the goldens' business)
  const boxes = (ir) => JSON.stringify(ir.lots.map((l) => [l.id, l.box, l.front, l.irrigation ?? null]));
  assert.equal(boxes(r1.res.ir), boxes(r0.res.ir));
});

test('planRevision growth: a grown lot with a field carries it on the revision IR (its frame, at its floor); a bad field refuses NOT_ALLOWED [call]', async () => {
  const { d3Town, reachInputs } = await import('./d3-helpers.mjs');
  const { mergeEffective, revisionStanding, reviseIR } = await import('../lib/region/revise.mjs');
  const t = await d3Town();
  const RI = reachInputs({ ir: t.p.ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(t.p.ir);
  const standing = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held });
  const ctx = { rid: 1, position: 1, parent: { rid: 0, irSha: t.p.irSha }, base: { irSha: t.p.irSha }, survey: RI.besideReach.survey, standing };
  const field = { cells: [[1, 0, 1], [2, 0, 1], [3, 0, 1], [1, 0, 2]], crops: ['minecraft:beetroots'] };
  const r = await reviseIR(eff, { grow: { lots: [{ id: 'crop_farm', type: 'farm', size: [9, 11], villager: 'farm', field }, { id: 'bakery', type: 'bakery', size: [9, 9] }] } }, ctx);
  const lot = r.ir.lots.find((l) => l.id === 'crop_farm');
  assert.ok(lot, 'grown');
  const F = lotFrame(lot);
  assert.deepEqual(cellsOf(lot.field.cells).map(([x, y, z]) => F.toFrame(x, y, z)).sort(), field.cells.map((c) => [...c]).sort());
  assert.deepEqual(lot.field.crops, ['minecraft:beetroots']);
  assert.ok(Number.isInteger(lot.floorY) && cellsOf(lot.field.cells).every(([, y]) => y === lot.floorY), 'at the lot\'s floor');
  assert.ok(!('field' in r.ir.lots.find((l) => l.id === 'bakery')));
  const bad = { grow: { lots: [{ id: 'crop_farm', type: 'farm', size: [9, 11], field: { cells: [[1, 0, 1]], crops: ['minecraft:stone'] } }] } };
  await assert.rejects(reviseIR(eff, bad, ctx), /NOT_ALLOWED: \[call\] grow\.lots\[0\] crop_farm\.field\.crops/);
});
