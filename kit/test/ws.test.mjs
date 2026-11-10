// (WS) The wall-level swing opt-in (docs/CONTRACT.md "Slice GM" §19, Noah 2026-11-04: "No, opt-in only"): `gateMech: "swing"` on a wall
// gives EVERY gate of that wall the K1 swing of §17, the auto gates (gates.min, the routes' crossings) included and a named gate that
// names no mech of its own; a gate's own `mech: "none"` stays plain; each gate falls back to the wooden door on its own (a villager edge,
// a thin wall, no 3-wide run) with deviation mechanism on the wall's answer; a wall that does not name it plans exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, part } from './plan-p0-shared.mjs';
import { K1_SWING } from '../lib/connectors/gmGate.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';

const fx = (n, dir = 'gm') => JSON.parse(fs.readFileSync(path.join(FIX, dir, `${n}.json`), 'utf8'));
const conn = (plan, id) => plan.connectors.find((c) => c.id === id);
/** gmb_k1_swing with its named gate dropped: the wall (3 thick) has the road's crossing and gates.min's gates, all auto; `edit` changes the plan. */
const autos = (name = 'gmb_k1_swing', min = 2, edit = () => {}) => {
  const f = fx(name);
  f.plan.connectors = f.plan.connectors.filter((c) => c.id !== 'east_gate');
  Object.assign(conn(f.plan, 'curtain'), { gateMech: 'swing', gates: { min } });
  edit(f.plan);
  return f;
};
const runOf = (f) => run(f);
const gatesOf = (r) => r.res.meta.walls.find((w) => w.id === 'curtain').gates;
const swingIds = (r) => (r.res.ir.gateMechanisms ?? []).map((q) => q.gate);

test('plan/0: connector.wall gateMech none | swing validates, another kind does not; the catalogue limit names it (sinceApi NEXT, schemaVersion 2)', () => {
  const p = autos().plan;
  const wallOf = (v) => v.parts.find((q) => q.id === 'curtain');
  assert.equal(validatePlan(p).malformed, null);
  assert.equal(wallOf(validatePlan(p)).verdict, 'compile');
  const bad = JSON.parse(JSON.stringify(p));
  conn(bad, 'curtain').gateMech = 'portcullis';
  const v = validatePlan(bad);
  assert.ok(v.malformed || wallOf(v).verdict !== 'compile', 'portcullis is not offered on a wall (§4)');
  conn(bad, 'curtain').gateMech = 'none';
  assert.equal(wallOf(validatePlan(bad)).verdict, 'compile');
  const e = planCatalogue().entries.find((x) => x.id === 'connector.wall');
  assert.deepEqual(e.limits.gateMech, ['none', 'swing']);
  assert.equal(e.schemaVersion, 2);
  assert.match(e.sinceApi, /^(NEXT|\d+\.\d+\.\d+)$/, e.sinceApi); // NEXT until release-version stamps it
});

test('a wall with gateMech swing and 2 auto gates (the road\'s crossing, one gates.min gate) gets 2 swings, each its own mech item', async () => {
  const r = await runOf(autos());
  assert.equal(r.check.overall, 'READY');
  const gs = gatesOf(r);
  assert.equal(gs.length, 2);
  assert.ok(gs.every((g) => g.auto), 'both auto');
  assert.deepEqual(gs.map((g) => g.id), ['curtain_g1', 'curtain_g2']);
  assert.deepEqual(swingIds(r), ['curtain_g1', 'curtain_g2']);
  const w = part(r, 'curtain');
  assert.equal(w.class, 'fits', JSON.stringify(w.deviations));
  assert.ok(w.notes.some((n) => /gateMech swing: 2 auto gate\(s\) are swings/.test(n)), JSON.stringify(w.notes));
  assert.deepEqual(w.geometry.gates.map((g) => g.mech), ['swing', 'swing']);
  for (const g of gs) { assert.equal(g.door, 'none'); assert.equal(g.mechanism.kind, 'swing'); assert.equal(g.width, K1_SWING.width); }
  // each write is its own: the stage of the wall's links, its own cells in its own opening, the bill 2 iron doors + a lever + button + plate
  const gw = r.res.ir.gateMechanisms;
  const wallPart = r.res.ir.parts.find((p) => p.id === 'w_curtain');
  const seen = new Set();
  for (const q of gw) {
    assert.equal(q.wall, 'curtain');
    assert.equal(q.stage, wallPart.stage);
    const meta = gs.find((g) => g.id === q.gate);
    const cols = new Set(meta.cells.map(([x, z]) => `${x},${z}`));
    for (let i = 0; i < q.base.length; i += 4) { const k = `${q.base[i]},${q.base[i + 1]},${q.base[i + 2]}`; assert.ok(cols.has(`${q.base[i]},${q.base[i + 2]}`), `${k}: in ${q.gate}'s opening`); assert.ok(!seen.has(k), `${k}: one swing's`); seen.add(k); }
    const bill = bomOf(q.base.filter((_, i) => i % 4 === 3).map((i) => q.palette[i]));
    assert.equal(bill['minecraft:iron_door'], 2, `${q.gate}: an iron door per half pair`);
    assert.equal(bill['minecraft:lever'], 1);
    assert.ok(Object.keys(bill).some((i) => /_button$/.test(i)) && Object.keys(bill).some((i) => /_pressure_plate$/.test(i)));
  }
  // the wall writes none of them
  for (const op of wallPart.ops) if (op.cols) for (let i = 0; i < op.cols.length; i += 5) for (let y = op.cols[i + 2]; y <= op.cols[i + 3]; y++) assert.ok(!seen.has(`${op.cols[i]},${y},${op.cols[i + 1]}`), 'the wall writes no swing cell');
  // the siteplan names both and validates
  const sp = sitePlan({ ir: r.res.ir, meta: r.res.meta });
  assert.deepEqual(validateSchema(sp), []);
  assert.deepEqual(sp.walls[0].gates.map((g) => g.mechanism), [{ kind: 'swing', rest: 'closed', who: 'player' }, { kind: 'swing', rest: 'closed', who: 'player' }]);
});

test('the survival bill: one mech:<gate> bill per swing (the Java check adds each IR gateMechanisms entry; here the entries and their bills)', async () => {
  const r = await run(autos('gmb_k1_swing', 3), { survival: true });
  assert.equal(r.check.overall, 'READY');
  const gw = r.res.ir.gateMechanisms;
  assert.equal(gw.length, 3);
  assert.equal(new Set(gw.map((q) => q.gate)).size, 3, 'a distinct gate id, so a distinct mech:<gate> item');
  for (const q of gw) assert.ok(bomOf(q.base.filter((_, i) => i % 4 === 3).map((i) => q.palette[i]))['minecraft:iron_door'] >= 1);
});

test('a named gate with mech none stays plain beside the wall\'s swings; a named gate with no mech of its own gets one', async () => {
  const none = await runOf(autos('gmb_k1_swing', 2, (p) => p.connectors.push({ id: 'east_gate', kind: 'gate', crossing: 'in', mech: 'none' })));
  const g = part(none, 'east_gate');
  assert.equal(g.class, 'fits', JSON.stringify(g.deviations ?? g.reasons));
  assert.equal(g.geometry.mechanism, undefined);
  assert.equal(g.geometry.door, 'none');
  assert.ok(!swingIds(none).includes('east_gate'));
  // the road's crossing is the named gate; gates.min 2 adds one more, which the wall swings
  assert.equal(swingIds(none).length, 1);
  assert.ok(gatesOf(none).find((q) => q.id === 'east_gate' && !q.mechanism));
  // no mech member: the wall's opt-in applies, its answer is the plain fits
  const open = await runOf(autos('gmb_k1_swing', 2, (p) => p.connectors.push({ id: 'east_gate', kind: 'gate', crossing: 'in' })));
  const go = part(open, 'east_gate');
  assert.equal(go.class, 'fits', JSON.stringify(go.deviations ?? go.reasons));
  assert.equal(go.geometry.mechanism.kind, 'swing');
  assert.ok(swingIds(open).includes('east_gate'));
  assert.equal(swingIds(open).length, 2);
  // an at gate with no mech of its own: placed 3 wide and 3 high like a named swing
  const at = await runOf(autos('gmb_k1_swing', 0, (p) => p.connectors.push({ id: 'north_gate', kind: 'gate', at: { anchor: 'claim_n' }, width: 2, height: 2 })));
  const ga = part(at, 'north_gate');
  assert.equal(ga.class, 'adjusted');
  assert.deepEqual(ga.deviations.filter((d) => d.what !== 'move'), [{ what: 'width', value: 3, from: 2 }, { what: 'height', value: 3, from: 2 }]);
  assert.equal(ga.geometry.mechanism.kind, 'swing');
  assert.ok(swingIds(at).includes('north_gate'));
  // and its own mech none is plain
  const atNone = await runOf(autos('gmb_k1_swing', 0, (p) => p.connectors.push({ id: 'north_gate', kind: 'gate', at: { anchor: 'claim_n' }, mech: 'none' })));
  assert.equal(part(atNone, 'north_gate').geometry.mechanism, undefined);
  assert.ok(!swingIds(atNone).includes('north_gate'));
  // a styling gate's mech none keeps the autos it styles plain
  const sty = await runOf(autos('gmb_k1_swing', 1, (p) => p.connectors.push({ id: 'style', kind: 'gate', mech: 'none' })));
  assert.equal(sty.res.ir.gateMechanisms, undefined, 'the one auto gate is styled plain');
});

test('§17 per gate: a villager edge keeps the wooden door (deviation mechanism, why villager, the edge named) while the other gates swing; a written villager route never refuses MOVER here', async () => {
  const r = await runOf(autos('gmb_k1_villager', 2));
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'curtain');
  assert.equal(w.class, 'adjusted');
  const dev = w.deviations.filter((d) => d.what === 'mechanism');
  assert.deepEqual(dev, [{ what: 'mechanism', kind: 'swing', gate: 'curtain_g1', why: 'villager', edge: 'in' }]);
  assert.ok(w.notes.some((n) => /villager edge/.test(n) && /wall curtain's first gate/.test(n) && !/curtain_g1/.test(n) && /\bin\b/.test(n)), JSON.stringify(w.notes));
  const gs = gatesOf(r);
  assert.equal(gs.find((g) => g.id === 'curtain_g1').door, 'door');
  assert.equal(gs.find((g) => g.id === 'curtain_g2').mechanism.kind, 'swing');
  assert.deepEqual(swingIds(r), ['curtain_g2']);
  // written movers naming villager: the wall asked, not the gate, so the wooden door, not MOVER
  const m = await runOf(autos('gmb_k1_villager', 2, (p) => { conn(p, 'in').movers = ['player', 'villager']; }));
  const wm = part(m, 'curtain');
  assert.notEqual(wm.class, 'refused');
  assert.equal(m.check.overall, 'READY');
  assert.deepEqual(wm.deviations.filter((d) => d.what === 'mechanism').map((d) => [d.gate, d.why]), [['curtain_g1', 'villager']]);
  // a named swing on the same route still refuses MOVER (§17 unchanged)
  const named = await runOf(autos('gmb_k1_villager', 2, (p) => { conn(p, 'in').movers = ['player', 'villager']; p.connectors.push({ id: 'east_gate', kind: 'gate', crossing: 'in', mech: 'swing' }); }));
  assert.equal(part(named, 'east_gate').class, 'refused');
  assert.equal(part(named, 'east_gate').reasons[0].code, 'MOVER');
});

test('§17 per gate: a wall 2 thick keeps the wooden door on every gate (deviation mechanism, why thickness, per gate); no IR member', async () => {
  const r = await runOf(autos('gmb_k1_thin', 3));
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'curtain');
  assert.equal(w.class, 'adjusted');
  assert.deepEqual(w.deviations.filter((d) => d.what === 'mechanism').map((d) => [d.gate, d.why, d.need, d.thickness]), [['curtain_g1', 'thickness', 3, 2], ['curtain_g2', 'thickness', 3, 2], ['curtain_g3', 'thickness', 3, 2]]);
  assert.ok(gatesOf(r).every((g) => g.door === 'door' && !g.mechanism));
  assert.equal(r.res.ir.gateMechanisms, undefined);
  // (NM) a wall with 3 auto gates: each note names its gate by its place in the wall's gate order, not its id; the deviations keep the id (data)
  const thick = w.notes.filter((n) => /thick and the swing needs/.test(n)).map((n) => n.split(':')[0]);
  assert.deepEqual(thick, ["wall curtain's first gate", "wall curtain's second gate", "wall curtain's third gate"], JSON.stringify(w.notes));
  assert.ok(!w.notes.some((n) => /curtain_g\d/.test(n)), JSON.stringify(w.notes));
});

test('the default: a wall that does not name gateMech (or names none) plans as before: its auto gates stay plain, byte for byte', async () => {
  const none = autos('gmb_k1_swing', 2, (p) => { conn(p, 'curtain').gateMech = 'none'; });
  const absent = autos('gmb_k1_swing', 2, (p) => { delete conn(p, 'curtain').gateMech; });
  const a = await runOf(none), b = await runOf(absent);
  const w = (r) => JSON.stringify(r.res.ir.parts.find((p) => p.id === 'w_curtain'));
  assert.equal(w(a), w(b));
  assert.deepEqual(part(a, 'curtain'), part(b, 'curtain'));
  assert.equal(a.res.ir.gateMechanisms, undefined);
  assert.equal(b.res.ir.gateMechanisms, undefined);
  assert.equal(part(b, 'curtain').class, 'fits');
  // a named swing on a wall with no opt-in still leaves its auto gates plain (the 2 min gates)
  const f = fx('gmb_k1_swing');
  conn(f.plan, 'curtain').gates = { min: 3 };
  const named = await runOf(f);
  assert.deepEqual(swingIds(named), ['east_gate']);
  assert.equal(gatesOf(named).filter((g) => g.auto && g.mechanism).length, 0);
});

test('determinism: 3 checks of an opted-in wall give one artifact sha', async () => {
  const shas = new Set();
  for (let i = 0; i < 3; i++) shas.add((await runOf(autos())).check.artifactSha);
  assert.equal(shas.size, 1);
});

// ((WL, §18 item 4) the opted-in auto gates stand on the adjusted ring, re-sited or not, like a named gate)
const wl = (hard = false) => {
  const f = fx('w01_recheck_protected', 'k3');
  const w = f.plan.connectors[0];
  Object.assign(w, { thickness: 3, gateMech: 'swing', gates: { min: 3 } });
  if (hard) f.plan.zones = f.plan.zones.map((z) => ({ ...z, tolerance: { ...(z.tolerance ?? {}), size: { max: 10, hard: true } } }));
  return f;
};

test('WL: the re-sited ring\'s auto gates get their swings (the gatehouse\'s passage counts toward gates.min and keeps its portcullis)', async () => {
  const r = await run(wl(), { survival: true });
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  const z = part(r, 'castle'), w = part(r, 'curtain_wall');
  assert.ok(z.notes.some((n) => /^placed \d+ in from the claim's margin/.test(n)), JSON.stringify(z.notes));
  const gs = r.res.meta.walls.find((q) => q.id === 'curtain_wall').gates;
  const autos2 = gs.filter((g) => g.auto);
  assert.equal(autos2.length, 2, JSON.stringify(gs.map((g) => [g.id, g.auto])));
  assert.ok(autos2.every((g) => g.mechanism?.kind === 'swing'), 'every auto gate swings');
  assert.deepEqual((r.res.ir.gateMechanisms ?? []).map((q) => q.gate).sort(), autos2.map((g) => g.id).sort());
  assert.equal(w.geometry.wallLots.find((q) => q.lot === 'gatehouse_1').passage.mechanism.kind, 'portcullis');
  assert.ok(!(w.deviations ?? []).some((d) => d.what === 'mechanism'), JSON.stringify(w.deviations));
});

test('WL: with no place to re-site, the lots go back to the zone and the wall\'s gates (3 auto, no gatehouse on the line) still swing', async () => {
  const r = await run(wl(true), { survival: true });
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'curtain_wall');
  const gs = r.res.meta.walls.find((q) => q.id === 'curtain_wall').gates;
  assert.equal(gs.length, 3);
  assert.ok(gs.every((g) => g.auto && g.mechanism?.kind === 'swing'));
  assert.equal(r.res.ir.gateMechanisms.length, 3);
  assert.ok(w.deviations.some((d) => d.what === 'mechanism' && d.lot === 'gatehouse_1' && d.why === 'off_wall'));
});

test('an at gate with no mech of its own in a thin wall: the wooden door, deviation mechanism (thickness), on the gate', async () => {
  const r = await runOf(autos('gmb_k1_thin', 0, (p) => p.connectors.push({ id: 'north_gate', kind: 'gate', at: { anchor: 'claim_n' } })));
  const g = part(r, 'north_gate');
  assert.equal(g.class, 'adjusted');
  assert.ok(g.deviations.some((d) => d.what === 'mechanism' && d.why === 'thickness'));
  assert.equal(g.geometry.door, 'door');
  assert.equal(r.res.ir.gateMechanisms, undefined);
});

test('(NM) gateSays: an unnamed gate reads as an ordinal of its wall (its place in the wall\'s gate order), a named gate keeps its id', async () => {
  const { gateSays } = await import('../lib/connectors/wall.mjs');
  const W = { id: 'curtain', gates: [{ id: 'curtain_g1' }, { id: 'north_gate', part: 'north_gate' }, { id: 'curtain_g3' }] };
  assert.equal(gateSays(W, 'curtain_g1'), "wall curtain's first gate");
  assert.equal(gateSays(W, 'curtain_g3'), "wall curtain's third gate");
  assert.equal(gateSays(W, 'curtain_g11'), "wall curtain's 11th gate");
  assert.equal(gateSays(W, 'north_gate'), 'gate north_gate');
  assert.equal(gateSays({ ...W, gates: [{ id: 'curtain_g2', part: 'curtain_g2' }] }, 'curtain_g2'), 'gate curtain_g2', 'a gate the plan named that way keeps its name');
  assert.equal(gateSays(W, 'other_g1'), 'gate other_g1', "another wall's id is not this wall's gate");
});
