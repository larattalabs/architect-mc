// Phase 6c slice HY-c (docs/CONTRACT.md "Phase 6c slice HY" §8.3, §9, §14 items 2, 9 and 14): the water gate. A still reach laid across a
// K1 wall (hy_gate_demo, kit/lib/fluids/handgate.mjs) through the two-plan flow: the crossing, the grate (body cells as waterlogged iron
// bars), the lintel at the reach's open top, the wall never on a cell of the course, M2:wall closure with the grate, gates.max and sealed
// walls, the broken variants each caught by its rule, the wire shapes, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './plan-helpers.mjs';
import { planGate, checkGate } from './hy-c-helpers.mjs';
import { GRATE_STATE } from '../lib/fluids/body.mjs';
import { grateState, waterGate, waterGates } from '../lib/fluids/gate.mjs';
import { crossingsOf } from '../lib/fluids/hooks.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const k2 = (x, z) => `${x},${z}`, k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const cellsOf = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };
/** Every cell a part's columns ops write: Map "x,y,z" -> material (null: air). */
function writes(ir, partId) {
  const m = new Map();
  for (const p of ir.parts) if (p.id === partId) for (const o of p.ops) if (o.op === 'columns') for (let i = 0; i < o.cols.length; i += 5) for (let y = o.cols[i + 2]; y <= o.cols[i + 3]; y++) m.set(`${o.cols[i]},${y},${o.cols[i + 1]}`, o.materials[o.cols[i + 4]]);
  return m;
}
const findingsOf = (rep, re) => rep.findings.filter((f) => re.test(f.rule));

let base;
const plan = async () => (base ??= await planGate({}));

test('the grate state is body.mjs GRATE_STATE (gate.mjs keeps no import of body.mjs)', () => {
  assert.equal(grateState(), GRATE_STATE);
});

test('item 14 (plan): a still reach across a closed wall: READY, the grate in the wall\'s thickness, the lintel at the open top, closure holds', async () => {
  const p = await plan();
  const pc = p.meta.planCheck;
  assert.deepEqual(pc.answers.map((a) => [a.part, a.class]), [['yard', 'fits'], ['castle', 'fits'], ['race', 'fits']]);
  const op = p.ir.parts.flatMap((q) => q.ops).find((o) => o.op === 'fluid' && o.id === 'race_r1');
  assert.ok(op && op.grate?.length, 'the reach carries a grate');
  assert.ok(p.ir.requires.includes('courses'), 'a grate makes the IR require courses');
  const wall = p.meta.walls.find((w) => w.id === 'castle');
  assert.equal(wall.waterGates.length, 1);
  const wg = wall.waterGates[0];
  assert.equal(wg.lintel, op.level + 1, 'the lintel at the reach\'s open top');
  // the grate is exactly the reach's cells under the wall: every body cell of the crossing's columns, in all its courses
  const grate = cellsOf(op.grate), body = cellsOf(op.cells);
  const wallCols = new Set(wall.cells.map((c) => k2(c[0], c[1])));
  assert.deepEqual(new Set(grate.map(k3)), new Set(body.filter(([x, , z]) => wallCols.has(k2(x, z))).map(k3)));
  assert.equal(wg.cells.length, 6, '3 wide through a wall 2 thick');
  assert.equal(grate.length, 12, '2 deep');
  // the wall: the lintel in the frame role over each grate column, the body above, never a cell of the course's body, shell or lining
  const W = writes(p.ir, 'w_castle');
  const course = new Set([...body, ...cellsOf(op.shell), ...cellsOf(op.lining)].map(k3));
  assert.deepEqual([...W.keys()].filter((k) => course.has(k)), [], 'the wall writes no cell of the course');
  for (const [x, z] of wg.cells) {
    const lintel = W.get(`${x},${wg.lintel},${z}`);
    assert.ok(lintel, `a lintel at ${x}, ${wg.lintel}, ${z}`);
    const ys = [...W.keys()].map((k) => k.split(',').map(Number)).filter((c) => c[0] === x && c[2] === z).map((c) => c[1]);
    assert.equal(Math.min(...ys), wg.lintel, 'nothing of the wall under the lintel');
  }
  // its footing on the banks: in a bank column of the crossing the wall starts over the course's rim
  const rep = checkGate(p);
  assert.deepEqual(findingsOf(rep, /^M(25|20|2:wall|8:wall)|^M1$/).map((f) => `${f.rule} ${f.message}`), []);
  const m = rep.metrics.walls.castle;
  assert.equal(m.waterGates, 1);
  for (const mover of ['player', 'villager']) assert.equal(m.closure[mover].leaks, 0, `${mover}: no leak through the water gate`);
  assert.equal(m.closure.player.across, m.closure.player.nodes, 'every node across by the walk gates');
  // a water gate is no walk gate: the wall's gates are its walk gates only, none on the water gate's positions or beside them
  assert.ok(wall.gates.every((g) => g.cells.every(([x, z]) => !wg.cells.some((c) => Math.abs(c[0] - x) + Math.abs(c[1] - z) <= 1))));
});

test('item 14 (wire shapes): the wall\'s crossing {type: wall, over: course, gate: water}, meta walls[].waterGates, siteplan courses', async () => {
  const p = await plan();
  const a = p.meta.planCheck.answers.find((q) => q.part === 'castle');
  assert.deepEqual(a.geometry.crossing, { type: 'wall', over: 'course', gate: 'water', course: 'race' });
  assert.deepEqual(a.geometry.waterGates, [{ course: 'race', cells: 6, lintel: 64 }]);
  const r = p.meta.planCheck.answers.find((q) => q.part === 'race');
  assert.deepEqual(r.geometry.waterGates, [{ wall: 'castle', cells: 6, lintel: 64, grate: 12 }]);
  assert.ok(p.meta.planCheck.links.bom.race['minecraft:iron_bars'] >= 12 || Object.entries(p.meta.planCheck.links.bom.race).some(([k, v]) => /iron_bars/.test(k) && v >= 12), JSON.stringify(p.meta.planCheck.links.bom.race));
  const sp = sitePlan({ ir: p.ir, meta: p.meta, planId: 'p', irSha: 'x'.repeat(64) });
  assert.deepEqual(sp.courses.map((c) => [c.id, c.bodies, c.waterGates]), [['race', ['race_r1'], ['castle']]]);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, sp), []);
});

test('item 14: a sealed wall refuses the water gate UNREACHABLE {kind: wall}; so does a wall at its gates.max', async () => {
  const s = await planGate({ variant: 'sealed' });
  const r = s.meta.planCheck.answers.find((q) => q.part === 'race');
  assert.equal(r.class, 'refused');
  assert.equal(r.reasons[0].code, 'UNREACHABLE');
  assert.deepEqual([r.reasons[0].evidence.kind, r.reasons[0].evidence.wall, r.reasons[0].evidence.why], ['wall', 'castle', 'sealed']);
  assert.ok(!(s.meta.walls[0].waterGates ?? []).length, 'no water gate on the sealed wall');
  assert.ok(!s.ir.parts.some((q) => q.ops.some((o) => o.op === 'fluid')), 'the refused reach rolled back');
  const m = await planGate({ variant: 'max' });
  const rm = m.meta.planCheck.answers.find((q) => q.part === 'race');
  assert.equal(rm.class, 'refused');
  assert.deepEqual([rm.reasons[0].code, rm.reasons[0].evidence.kind, rm.reasons[0].evidence.why, rm.reasons[0].evidence.max], ['UNREACHABLE', 'wall', 'max', 1]);
  assert.equal(m.meta.planCheck.answers.find((q) => q.part === 'west_gate').class, 'fits');
});

test('item 14: the broken variants, each caught by its rule (no_lintel: M2:wall closure; lintel_low: M25:trap; no_grate: closure)', async () => {
  const nl = checkGate(await planGate({ variant: 'no_lintel' }));
  assert.ok(nl.metrics.walls.castle.closure.player.leaks > 0 && nl.metrics.walls.castle.closure.villager.leaks > 0);
  assert.ok(findingsOf(nl, /^M2:wall$/).some((f) => /gates blocked/.test(f.message)));
  const ll = checkGate(await planGate({ variant: 'lintel_low' }));
  assert.ok(findingsOf(ll, /^M25:trap$/).some((f) => f.part === 'race_r1'), JSON.stringify(ll.findings.map((f) => f.rule)));
  const ng = checkGate(await planGate({ variant: 'no_grate' }));
  assert.ok(ng.metrics.walls.castle.closure.player.leaks > 0, 'open water under the lintel: a swimmer gets out');
});

test('item 9 (plan): the castle with a moat round it: READY, the water gate standing; deterministic', async () => {
  const p = await planGate({ moat: true });
  assert.deepEqual(p.meta.planCheck.answers.map((a) => [a.part, a.class]), [['yard', 'fits'], ['castle', 'fits'], ['moat', 'fits'], ['race', 'fits']]);
  const rep = checkGate(p);
  assert.deepEqual(findingsOf(rep, /^M(25|20|2:wall|8:wall)|^M1$/).map((f) => `${f.rule} ${f.message}`), []);
  assert.equal(p.meta.walls[0].waterGates.length, 1);
  const again = await planGate({});
  assert.equal(again.irSha, (await plan()).irSha, 'deterministic');
});

test('waterGate (unit): the checks on a straight wall 2 thick along x', () => {
  // a wall line along x at z 10..11 (depth 0 at z 10, inside north), positions x 0..20
  const positions = [], cells = [];
  for (let x = 0; x <= 20; x++) { positions.push({ x, z: 10, axis: x === 0 || x === 20 ? 3 : 1 }); cells.push({ x, z: 10, pos: x, depth: 0 }, { x, z: 11, pos: x, depth: 1 }); }
  const mk = (st = {}, gates = []) => {
    const W = { id: 'w', positions, cells, ends: [0, 20], gates, opened: gates.length, st: { thickness: 2, sealed: false, gatesMax: 16, ...st }, closed: false };
    W.cellAt = new Map(cells.map((c) => [k2(c.x, c.z), c]));
    return { walls: [W], answers: new Map([['w', { class: 'fits' }], ['c', { class: 'fits' }]]), okClass: () => true };
  };
  const reach = (x0, x1, z0, z1, level = 63) => { const out = []; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = level - 1; y <= level; y++) out.push([x, y, z]); return out; };
  const code = (f) => { try { f(); return null; } catch (e) { return e.evidence?.why ?? e.message; } };
  // a good one: 3 wide, 2 past each face
  const K = mk();
  const g = waterGate(K, { course: 'c', body: 'c_r1', cells: reach(5, 7, 8, 13), level: 63 });
  assert.equal(g.grate.length, 12);
  assert.deepEqual(crossingsOf(K).map((q) => [q.wall, q.lintel, q.cells.length]), [['w', 64, 6]]);
  assert.equal(waterGates(K, 'w').length, 1);
  assert.equal(code(() => waterGate(mk(), { course: 'c', body: 'b', cells: reach(5, 8, 8, 13), level: 63 })), 'width', 'at most 3 wide');
  assert.equal(code(() => waterGate(mk(), { course: 'c', body: 'b', cells: reach(5, 7, 9, 13), level: 63 })), 'still', 'less than 2 still cells inside');
  assert.equal(code(() => waterGate(mk(), { course: 'c', body: 'b', cells: reach(5, 7, 8, 10), level: 63 })), 'still', 'the reach ends under the wall');
  assert.equal(code(() => waterGate(mk(), { course: 'c', body: 'b', cells: reach(5, 7, 8, 13), level: 63, outlets: [[6, 63, 13]] })), 'step', 'a step within 2 of the wall');
  assert.equal(code(() => waterGate(mk({ sealed: true, gatesMax: 0 }), { course: 'c', body: 'b', cells: reach(5, 7, 8, 13), level: 63 })), 'sealed');
  assert.equal(code(() => waterGate(mk({ gatesMax: 1 }, [{ a: 14, b: 16 }]), { course: 'c', body: 'b', cells: reach(5, 7, 8, 13), level: 63 })), 'max');
  assert.equal(code(() => waterGate(mk({}, [{ a: 8, b: 10 }]), { course: 'c', body: 'b', cells: reach(5, 7, 8, 13), level: 63 })), 'gate', 'beside a walk gate\'s jamb');
  assert.equal(code(() => waterGate(mk(), { course: 'c', body: 'b', cells: reach(0, 1, 8, 13), level: 63 })), 'corner', 'at the end of the line');
  // a rolled-back course keeps no water gate (waterGates reads standing courses only)
  const K2 = mk();
  waterGate(K2, { course: 'c', body: 'c_r1', cells: reach(5, 7, 8, 13), level: 63 });
  K2.okClass = () => false;
  assert.equal(waterGates(K2, 'w').length, 0);
  // no wall met: no grate
  assert.deepEqual(waterGate(mk(), { course: 'c', body: 'b', cells: reach(5, 7, 0, 6), level: 63 }), { grate: [], crossings: [] });
});

test('item 9 (the batch): valid/v58 (v30 plus a brook through the ring) READY; the reach crossing the ring under a water gate, the wall on its lintel', async () => {
  const { run, svOf } = await import('./plan-p0-shared.mjs');
  const { FIX } = await import('./plan-helpers.mjs');
  const f = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v58_water_gate.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(FIX, 'hy-pending-c.json')), false, 'v58 replaced hy-pending-c.json');
  const r = await run(f);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((p) => [p.part, p.class, p.reasons])));
  const p = r.res;
  const wall = p.meta.walls.find((w) => w.id === 'town_wall');
  assert.equal(wall.waterGates.length, 1);
  const wg = wall.waterGates[0];
  const op = p.ir.parts.flatMap((q) => q.ops).find((o) => o.op === 'fluid' && o.id === wg.body);
  assert.ok(op?.grate?.length, `${wg.body} carries the grate`);
  assert.equal(wg.lintel, op.level + 1, 'the lintel at the reach\'s open top');
  // the grate is exactly the reach's cells in the wall's thickness
  const wallCols = new Set(wall.cells.map((c) => k2(c[0], c[1])));
  assert.deepEqual(new Set(cellsOf(op.grate).map(k3)), new Set(cellsOf(op.cells).filter(([x, , z]) => wallCols.has(k2(x, z))).map(k3)));
  // the wall writes no cell of any reach's body, shell or lining; nothing of it under the lintel in a crossing column
  const W = writes(p.ir, 'w_town_wall');
  const course = new Set(p.ir.parts.flatMap((q) => q.ops).filter((o) => o.op === 'fluid').flatMap((o) => [...cellsOf(o.cells), ...cellsOf(o.shell), ...cellsOf(o.lining)]).map(k3));
  assert.deepEqual([...W.keys()].filter((k) => course.has(k)), [], 'the wall writes no cell of the course');
  for (const [x, z] of wg.cells) {
    assert.ok(W.get(`${x},${wg.lintel},${z}`), `a lintel at ${x}, ${wg.lintel}, ${z}`);
    const ys = [...W.keys()].map((k) => k.split(',').map(Number)).filter((c) => c[0] === x && c[2] === z).map((c) => c[1]);
    assert.equal(Math.min(...ys), wg.lintel, 'nothing of the wall under the lintel');
  }
  // the checker: M25, M2:wall, M8:wall, M1 clean; closure holds for both movers; walk gates off the water gate's positions
  const rep = checkRegion({ ir: p.ir, survey: svOf(f).bytes, blobs: p.blobs, volumes: (r.volumes ?? []).map((v) => v.decoded), meta: p.meta });
  assert.deepEqual(findingsOf(rep, /^M(25|20|2:wall|8:wall)|^M1$/).map((x) => `${x.rule} ${x.message}`), []);
  const m = rep.metrics.walls.town_wall;
  assert.equal(m.waterGates, 1);
  for (const mover of ['player', 'villager']) assert.equal(m.closure[mover].leaks, 0, `${mover}: no leak through the water gate`);
  assert.ok(wall.gates.every((g) => g.cells.every(([x, z]) => !wg.cells.some((c) => Math.abs(c[0] - x) + Math.abs(c[1] - z) <= 1))));
  // the wire: the brook's answer and siteplan name the water gate; its bill holds the grate's bars
  const a = p.meta.planCheck.answers.find((q) => q.part === 'brook');
  assert.deepEqual(a.geometry.waterGates, [{ wall: 'town_wall', cells: wg.cells.length, lintel: wg.lintel, grate: cellsOf(op.grate).length }]);
  assert.deepEqual(p.meta.planCheck.answers.find((q) => q.part === 'town_wall').geometry.crossing, { type: 'wall', over: 'course', gate: 'water', course: 'brook' });
  assert.equal(p.meta.planCheck.links.bom.brook['minecraft:iron_bars'], cellsOf(op.grate).length);
  const sp = sitePlan({ ir: p.ir, meta: p.meta, planId: 'p', irSha: 'x'.repeat(64) });
  assert.deepEqual(sp.courses.find((c) => c.id === 'brook').waterGates, ['town_wall']);
  // the same plan on v30's own site (s7): READY, the brook under a water gate of the ring
  const s7 = await run({ ...f, terrain: undefined, on: 's7' });
  assert.equal(s7.check.overall, 'READY', JSON.stringify(s7.check.parts.map((q) => [q.part, q.class, q.reasons])));
  assert.equal(s7.res.meta.walls.find((w) => w.id === 'town_wall').waterGates.length, 1);
});
