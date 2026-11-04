// (GC) Gatehouse coverage hints in the plan check: a wall that rings a zone with a gatehouse lot no wall names answers adjusted with a
// note; a named gate lot too small for a mechanism gets a note naming the need (and the swapped order when that fits). Notes only: the
// plan is never changed and nothing is refused; the notes are stable across runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, asksSurvey, stewardAnchors, checkPlanLocal } from './plan-helpers.mjs';
import { run, part } from './plan-p0-shared.mjs';
import { gateHints, gateSizeHint, isGatehouseLot } from '../lib/connectors/wallLots.mjs';

const base = () => JSON.parse(fs.readFileSync(path.join(FIX, 'gm', 'gm_castle_13x7.json'), 'utf8'));
/** The 13 x 7 castle with its gatehouse's size and gate entry edited: `lots` (the wall's lots member) and `size`. */
const variantOf = ({ size = [13, 7], lots, mech = false } = {}) => {
  const f = base();
  const wall = f.plan.connectors.find((c) => c.kind === 'wall');
  const gh = f.plan.zones.flatMap((z) => z.program.lots).find((l) => l.id === 'gatehouse_1');
  gh.size = size;
  wall.lots = (lots ?? wall.lots).map((q) => { const { mech: m, ...rest } = q; return mech && m ? q : rest; });
  return f;
};
const notesOf = (r) => part(r, 'curtain_wall').notes ?? [];
const HINT = /not on the wall|gate mechanism needs/;

test('a gatehouse of the ringed zone that no wall names: the wall answers adjusted with the note, no deviation, no refusal', async () => {
  const f = variantOf({ lots: base().plan.connectors.find((c) => c.kind === 'wall').lots.filter((q) => q.lot !== 'gatehouse_1') });
  const r = await run(f);
  const w = part(r, 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  assert.deepEqual(w.notes.filter((n) => HINT.test(n)), ['gatehouse_1 is not on the wall: name it in lots (at: gate)']);
  assert.ok(!(w.deviations ?? []).length, 'a note, not a deviation');
  assert.ok(!(w.reasons ?? []).length);
  assert.equal(r.check.overall, 'READY');
});

test('the gatehouse named in lots (at: gate), big enough: no hint, the wall as before', async () => {
  const r = await run(variantOf());
  assert.deepEqual(notesOf(r).filter((n) => HINT.test(n)), []);
  assert.notEqual(part(r, 'curtain_wall').class, 'refused');
});

test('a named gate lot under the mechanism box: the need is named; the swapped order is said only when it fits', async () => {
  const a = notesOf(await run(variantOf({ size: [11, 13] }))).filter((n) => HINT.test(n));
  assert.deepEqual(a, ['gatehouse_1 is 11 x 13: a gate mechanism needs 13 along the wall x 7 deep (written 13 x 11 it would fit: swap the order)']);
  const b = notesOf(await run(variantOf({ size: [11, 9] }))).filter((n) => HINT.test(n));
  assert.deepEqual(b, ['gatehouse_1 is 11 x 9: a gate mechanism needs 13 along the wall x 7 deep']);
  const c = notesOf(await run(variantOf({ size: [15, 5] }))).filter((n) => HINT.test(n));
  assert.deepEqual(c, ['gatehouse_1 is 15 x 5: a gate mechanism needs 13 along the wall x 7 deep']);
  const w = part(await run(variantOf({ size: [11, 13] })), 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  assert.ok(!(w.deviations ?? []).length && !(w.reasons ?? []).length);
});

test('a lot that already writes its mechanism keeps GM\'s own note (no second hint)', async () => {
  const r = await run(JSON.parse(fs.readFileSync(path.join(FIX, 'gm', 'gm_castle_11x13.json'), 'utf8')));
  assert.deepEqual(notesOf(r).filter((n) => HINT.test(n)), []);
});

test('the notes are the same on every run, and the plan checked is the plan given', async () => {
  const f = variantOf({ size: [11, 13], lots: base().plan.connectors.find((c) => c.kind === 'wall').lots.filter((q) => q.lot !== 'tower_4') });
  const before = JSON.stringify(f.plan);
  const rs = [await run(f), await run(f), await run(f)];
  assert.equal(JSON.stringify(f.plan), before);
  assert.equal(JSON.stringify(rs[1].check), JSON.stringify(rs[0].check));
  assert.equal(JSON.stringify(rs[2].check), JSON.stringify(rs[0].check));
  assert.equal(rs[1].artifactSha, rs[0].artifactSha);
});

test('a sealed wall (gates 0) is not asked for a gatehouse', async () => {
  const f = variantOf({ lots: [] });
  const wall = f.plan.connectors.find((c) => c.kind === 'wall');
  wall.gates = 0;
  const r = await run(f);
  assert.deepEqual(notesOf(r).filter((n) => HINT.test(n)), []);
});

test('Steward\'s recorded redstone_gate plan: curtain_wall asks for gatehouse_1', async () => {
  const A = asksSurvey();
  const plan = JSON.parse(fs.readFileSync(path.join(FIX, 'asks', 'redstone_gate.json'), 'utf8')).answer.plan;
  const r = await checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
  const w = r.check.parts.find((a) => a.part === 'curtain_wall');
  assert.equal(w.class, 'adjusted');
  assert.deepEqual(w.notes.filter((n) => HINT.test(n)), ['gatehouse_1 is not on the wall: name it in lots (at: gate)']);
});

test('gateHints: pure; the zone\'s gatehouses on the first wall only; types and id stems; mech lots skipped', () => {
  const spec = { gh: { type: 'gatehouse', size: [13, 7] }, gate_2: { type: null }, hut: { type: 'house' } };
  const specOf = (id) => spec[id] ?? null;
  assert.equal(isGatehouseLot('gh', spec.gh), true);
  assert.equal(isGatehouseLot('gatehouse_9', null), true);
  assert.equal(isGatehouseLot('hut', spec.hut), false);
  const args = { zoneLotIds: ['hut', 'gh', 'gatehouse_2'], namedAnywhere: new Set(), named: [], specOf, first: true };
  assert.deepEqual(gateHints(args), ['gh is not on the wall: name it in lots (at: gate)', 'gatehouse_2 is not on the wall: name it in lots (at: gate)']);
  assert.deepEqual(gateHints({ ...args, first: false }), []);
  assert.deepEqual(gateHints({ ...args, namedAnywhere: new Set(['gh', 'gatehouse_2']) }), []);
  assert.deepEqual(gateHints({ ...args, zoneLotIds: null }), []);
  const small = { ...spec, gh: { type: 'gatehouse', size: [11, 13] } };
  assert.deepEqual(gateHints({ ...args, zoneLotIds: [], named: [{ lot: 'gh', at: 'gate' }], specOf: (id) => small[id] ?? null }), ['gh is 11 x 13: a gate mechanism needs 13 along the wall x 7 deep (written 13 x 11 it would fit: swap the order)']);
  assert.deepEqual(gateHints({ ...args, zoneLots: [], named: [{ lot: 'gh', at: 'gate', mech: 'swing' }], specOf: (id) => small[id] ?? null, zoneLotIds: [] }), []);
  assert.equal(gateSizeHint('gh', [13, 7]), null);
  assert.equal(gateSizeHint('gh', null), null);
});
