// (GM-b) The K1 swing gate (docs/CONTRACT.md "Slice GM" §17, binding over §4's K1 bullet): the opt-in plan member and its catalogue
// limit, the swing placed in a wall 3 thick (3 wide, at least 3 high, the 3 planes centred on the wall), the wooden door with deviation
// mechanism on a villager crossing, in a thin wall or with no run for it, MOVER on a route whose written movers name villager, the IR's
// write data (gateMechanisms) and the wall writing none of its cells, the bill, the siteplan, S-THEME and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, part, svOf } from './plan-p0-shared.mjs';
import { k1SwingPlan, k1SwingRecord, gmMatsOf, K1_SWING } from '../lib/connectors/gmGate.mjs';
import { gmToWorld } from '../lib/connectors/gmCircuit.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { traceRole } from '../lib/connectors/style.mjs';
import { resolveRoles } from '../lib/region/plan.mjs';

const ROOT = path.join(FIX, '..', '..', '..', '..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, 'gm', `${n}.json`), 'utf8'));
const runOf = (n, mut = null) => { const f = fx(n); if (mut) mut(f.plan); return run(f); };
const conn = (plan, id) => plan.connectors.find((c) => c.id === id);
const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < flat.length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
const bibles = () => fs.readdirSync(path.join(ROOT, 'scenarios', 'bibles')).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', f), 'utf8')).roles ?? {}]);

test('plan/0: connector.gate mech none | swing validates, another kind does not; the catalogue limit names it (sinceApi NEXT)', () => {
  const p = fx('gmb_k1_swing').plan;
  const gateOf = (v) => v.parts.find((q) => q.id === 'east_gate');
  assert.equal(validatePlan(p).malformed, null);
  assert.equal(gateOf(validatePlan(p)).verdict, 'compile');
  const bad = JSON.parse(JSON.stringify(p));
  conn(bad, 'east_gate').mech = 'portcullis';
  const v = validatePlan(bad);
  assert.ok(v.malformed || gateOf(v).verdict !== 'compile', 'portcullis is not offered on a K1 gate (§4)');
  conn(bad, 'east_gate').mech = 'none';
  assert.equal(gateOf(validatePlan(bad)).verdict, 'compile');
  const e = planCatalogue().entries.find((x) => x.id === 'connector.gate');
  assert.deepEqual(e.limits.mech, ['none', 'swing']);
  assert.ok(e.schemaVersion >= 2);
});

test('k1SwingPlan: the doors in the middle plane, the button outside on the mullion, the lever and plate inside; a taller gate sealed over the transom, the arch\'s middle cell filled', () => {
  const p = k1SwingPlan(gmMatsOf({}), { height: 3, arch: false });
  const at = (u, d, r) => p.base.find((c) => c[0] === u && c[1] === d && c[2] === r)?.[3] ?? null;
  for (const u of [-1, 1]) { assert.match(at(u, 1, 0), /iron_door.*half=lower/); assert.match(at(u, 1, 1), /iron_door.*half=upper/); assert.ok(at(u, 1, 2), 'the transom'); }
  // the transom joins the mullion and the jambs, not the open lanes in front of and behind it
  assert.match(at(-1, 1, 2), /north=false.*south=false/);
  assert.match(at(0, 0, 1), /button/);
  assert.match(at(0, 2, 1), /lever/);
  assert.match(at(-1, 2, 0), /pressure_plate/);
  for (const c of p.base) assert.ok(Math.abs(c[0]) <= 1 && c[1] >= 0 && c[1] <= 2 && c[2] >= -1 && c[2] <= 2, `${c}: in the 3 x 3 x 3 and its sill`);
  for (const u of [-1, 0, 1]) assert.equal(at(u, 1, -1), gmMatsOf({}).structure, `${u}: the sill under the door plane`);
  const tall = k1SwingPlan(gmMatsOf({}), { height: 5, arch: true });
  const ta = (u, d, r) => tall.base.find((c) => c[0] === u && c[1] === d && c[2] === r)?.[3] ?? null;
  for (const r of [3, 4]) for (const u of [-1, 0, 1]) assert.equal(ta(u, 1, r), gmMatsOf({}).structure, `${u},1,${r}: sealed over the transom`);
  assert.equal(ta(0, 1, 5), gmMatsOf({}).structure, 'the arch\'s middle cell over the mullion');
  // the write order: structure first, triggers last
  const rank = tall.base.map((c) => (/lever|button|plate/.test(c[3]) ? 2 : /door|fence|bars|_wall/.test(c[3]) ? 1 : 0));
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
});

test('k1SwingRecord: every facing puts the button on the outer face and the lever and plate on the inner, the doors between', () => {
  const p = k1SwingPlan(gmMatsOf({}), { height: 3 });
  for (const facing of ['north', 'east', 'south', 'west']) {
    const at = { cx: 100, fy: 64, cz: 200, facing };
    const { record, write } = k1SwingRecord(p, at);
    const out = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[facing];
    // d from the outer face along the inward direction: the outer face cell is (cx, cz), d 1 one step in
    const dOf = ([x, , z]) => 0 - ((x - 100) * out[0] + (z - 200) * out[1]) + 0;
    const t = (k) => record.triggers.find((q) => q.kind === k).at;
    assert.equal(dOf(t('button')), 0, `${facing}: the button outside`);
    assert.equal(dOf(t('lever')), 2, `${facing}: the lever inside`);
    assert.equal(dOf(t('plate')), 2, `${facing}: the plate inside`);
    const doors = [];
    for (let i = 0; i < write.base.length; i += 4) if (/iron_door/.test(write.palette[write.base[i + 3]])) doors.push([write.base[i], write.base[i + 1], write.base[i + 2]]);
    assert.equal(doors.length, 4);
    for (const d of doors) assert.equal(dOf(d), 1, `${facing}: a door in the middle plane`);
    assert.deepEqual(gmToWorld([0, 0, 0, null], at).slice(0, 3), [100, 64, 200]);
    assert.equal(record.rest, 'closed');
    assert.deepEqual(record.movers, ['player']);
    assert.deepEqual(record.cost.bom.min, record.cost.bom.max, 'one case: exact at plan time');
  }
});

test('gmb_k1_swing: READY, the gate fits with its swing; the IR\'s gateMechanisms write; the wall writes none of its cells; the bill; the siteplan', async () => {
  const r = await runOf('gmb_k1_swing');
  assert.equal(r.check.overall, 'READY');
  const g = part(r, 'east_gate');
  assert.equal(g.class, 'fits', JSON.stringify(g.deviations ?? g.reasons));
  const m = g.geometry.mechanism;
  assert.equal(m.kind, 'swing');
  assert.equal(g.geometry.width, K1_SWING.width);
  assert.ok(g.geometry.height >= K1_SWING.height);
  assert.equal(g.geometry.door, 'none');
  assert.equal(part(r, 'curtain').geometry.gates.find((q) => q.id === 'east_gate').mech, 'swing');
  // the IR member, its stage the wall's
  const gw = r.res.ir.gateMechanisms;
  assert.equal(gw.length, 1);
  assert.equal(gw[0].gate, 'east_gate');
  assert.equal(gw[0].wall, 'curtain');
  const wallPart = r.res.ir.parts.find((p) => p.id === 'w_curtain');
  assert.equal(gw[0].stage, wallPart.stage);
  // the swing's cells are in the opening's columns at the gate's rows; none of them is a wall op
  const meta = r.res.meta.walls[0].gates.find((q) => q.id === 'east_gate');
  const cols = new Set(meta.cells.map(([x, z]) => `${x},${z}`));
  const mine = new Set();
  for (let i = 0; i < gw[0].base.length; i += 4) { const [x, y, z] = gw[0].base.slice(i, i + 3); assert.ok(cols.has(`${x},${z}`), `${x},${z}: in the opening`); assert.ok(y >= meta.y, `${x},${y},${z}: the sill or over the walk`); mine.add(`${x},${y},${z}`); }
  for (const op of wallPart.ops) if (op.cols) for (let i = 0; i < op.cols.length; i += 5) for (let y = op.cols[i + 2]; y <= op.cols[i + 3]; y++) assert.ok(!mine.has(`${op.cols[i]},${y},${op.cols[i + 1]}`), `the wall writes no swing cell (${op.cols[i]},${y},${op.cols[i + 1]})`);
  assert.deepEqual(meta.mechanismWrite.base, gw[0].base);
  // the gate's bill holds the swing: 2 iron doors, a lever, the button and the plate
  for (const [i, n] of Object.entries({ 'minecraft:iron_door': 2, 'minecraft:lever': 1 })) assert.ok((g.cost.bom[i] ?? 0) >= n, `${i}: ${g.cost.bom[i]}`);
  assert.ok(Object.keys(g.cost.bom).some((i) => /_button$/.test(i)) && Object.keys(g.cost.bom).some((i) => /_pressure_plate$/.test(i)));
  // the siteplan names it, and validates
  const sp = sitePlan({ ir: r.res.ir, meta: r.res.meta });
  assert.deepEqual(validateSchema(sp), []);
  assert.deepEqual(sp.walls[0].gates.find((q) => q.id === 'east_gate').mechanism, { kind: 'swing', rest: 'closed', who: 'player' });
});

test('S-THEME: the swing traces to the roles in the default and every bible (the lint judges the IR write as gm_<gate>)', async () => {
  const r = await runOf('gmb_k1_swing');
  const vw = buildVirtual({ ir: r.res.ir, survey: svOf(fx('gmb_k1_swing')).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null }).vw;
  assert.deepEqual(themeOffenders(r.res.ir, vw).offenders.filter((o) => /^gm_/.test(o.part)), []);
  // a block no role traces to is caught (the lint reads the member)
  const ir2 = JSON.parse(JSON.stringify(r.res.ir));
  ir2.gateMechanisms[0].palette[0] = 'minecraft:crimson_hyphae';
  assert.ok(themeOffenders(ir2, vw).offenders.some((o) => o.part === 'gm_east_gate' && o.block === 'minecraft:crimson_hyphae'));
  for (const [f, roles0] of bibles()) {
    const roles = resolveRoles(roles0);
    const p = k1SwingPlan(gmMatsOf(roles), { height: 4, arch: true });
    for (const c of p.base) if (!/iron_door|lever/.test(c[3])) assert.ok(traceRole(c[3].replace(/\[.*$/, ''), roles), `${f}: ${c[3]} traces to a role`);
  }
});

test('§17 item 2: a villager crossing (inferred movers) falls back to the wooden door, adjusted, deviation mechanism; written villager movers refuse MOVER', async () => {
  const r = await runOf('gmb_k1_villager');
  assert.equal(r.check.overall, 'READY');
  const g = part(r, 'east_gate');
  assert.equal(g.class, 'adjusted');
  assert.deepEqual(g.deviations, [{ what: 'mechanism', kind: 'swing', gate: 'east_gate', why: 'villager', edge: 'in' }]);
  assert.ok(g.notes.some((n) => /villager edge/.test(n) && /east_gate/.test(n) && /\bin\b/.test(n)));
  assert.equal(g.geometry.door, 'door');
  assert.equal(g.geometry.mechanism, undefined);
  assert.equal(r.res.ir.gateMechanisms, undefined, 'no swing: no IR member');
  // the wooden door covers the whole 3-wide opening (a double door and a single)
  const meta = r.res.meta.walls[0].gates[0];
  const wallPart = r.res.ir.parts.find((p) => p.id === 'w_curtain');
  const cols = new Set(meta.cells.map(([x, z]) => `${x},${z}`));
  let lower = 0;
  for (const op of wallPart.ops) if (op.cols) for (let i = 0; i < op.cols.length; i += 5) if (cols.has(`${op.cols[i]},${op.cols[i + 1]}`) && /_door\[.*half=lower/.test(op.materials[op.cols[i + 4]] ?? '')) lower++;
  assert.equal(lower, 3);
  const m = await runOf('gmb_k1_villager', (p) => { conn(p, 'in').movers = ['player', 'villager']; });
  const gm = part(m, 'east_gate');
  assert.equal(gm.class, 'refused');
  assert.equal(gm.reasons[0].code, 'MOVER');
  assert.deepEqual(gm.reasons[0].evidence.crossing, ['in']);
});

test('§17 item 3: a wall 2 thick keeps the wooden door (deviation mechanism, why thickness); a crossing opened 2 wide (why width)', async () => {
  const r = await runOf('gmb_k1_thin');
  const g = part(r, 'east_gate');
  assert.equal(r.check.overall, 'READY');
  assert.equal(g.class, 'adjusted');
  assert.deepEqual(g.deviations, [{ what: 'mechanism', kind: 'swing', gate: 'east_gate', why: 'thickness', need: 3, thickness: 2 }]);
  assert.equal(g.geometry.door, 'door');
  assert.equal(r.res.ir.gateMechanisms, undefined);
  const w = await runOf('gmb_k1_swing', (p) => { conn(p, 'in').width = 2; });
  const gw = part(w, 'east_gate');
  if (gw.geometry?.width !== 3) {
    assert.equal(gw.class, 'adjusted');
    assert.equal(gw.deviations[0].why, 'width');
    assert.equal(w.res.ir.gateMechanisms, undefined);
  }
});

test('§17 item 3: an at gate is placed 3 wide (its width adjusted), at least 3 high; in a thin wall the wooden door', async () => {
  const at = (p, extra = {}) => {
    p.connectors = p.connectors.filter((c) => c.id !== 'east_gate');
    p.connectors.push({ id: 'north_gate', kind: 'gate', at: { anchor: 'claim_n' }, mech: 'swing', width: 2, height: 2, ...extra });
  };
  const r = await runOf('gmb_k1_swing', (p) => at(p));
  const g = part(r, 'north_gate');
  assert.equal(r.check.overall, 'READY');
  assert.equal(g.class, 'adjusted');
  assert.deepEqual(g.deviations.filter((d) => d.what !== 'move'), [{ what: 'width', value: 3, from: 2 }, { what: 'height', value: 3, from: 2 }]);
  assert.equal(g.geometry.width, 3);
  assert.equal(g.geometry.height, 3);
  assert.equal(g.geometry.mechanism.kind, 'swing');
  assert.ok(r.res.ir.gateMechanisms.some((q) => q.gate === 'north_gate'));
  const t = await runOf('gmb_k1_thin', (p) => at(p, { width: undefined, height: undefined }));
  const gt = part(t, 'north_gate');
  assert.equal(gt.class, 'adjusted');
  assert.ok(gt.deviations.some((d) => d.what === 'mechanism' && d.why === 'thickness'));
  assert.equal(gt.geometry.door, 'door');
});

test('no swing named: every recorded K1 gate plans as before (mech none is the default)', async () => {
  const a = await runOf('gmb_k1_swing', (p) => { delete conn(p, 'east_gate').mech; });
  const b = await runOf('gmb_k1_swing', (p) => { conn(p, 'east_gate').mech = 'none'; });
  // (the plan's text seeds the props, so compare the wall and the gate)
  const w = (r) => JSON.stringify(r.res.ir.parts.find((p) => p.id === 'w_curtain'));
  assert.equal(w(a), w(b));
  assert.deepEqual(part(a, 'east_gate').geometry, part(b, 'east_gate').geometry);
  assert.equal(a.res.ir.gateMechanisms, undefined);
  assert.equal(part(a, 'east_gate').class, 'fits');
});

test('determinism: 3 checks of gmb_k1_swing give one artifact sha', async () => {
  const shas = new Set();
  for (let i = 0; i < 3; i++) shas.add((await runOf('gmb_k1_swing')).check.artifactSha);
  assert.equal(shas.size, 1);
});
