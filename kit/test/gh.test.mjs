// (GH) A free layout stays strict (never read as street), but its NO_ROOM carries a street wouldFit when street would place the zone
// (docs/CONTRACT.md, the C37 orientation pattern): the fragment sets layout to street, re-checked; none when street fails too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, asksSurvey, checkPlanLocal, stewardAnchors } from './plan-helpers.mjs';

const A = asksSurvey();
const check = (plan) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
const cottages = (n, w, d) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, type: 'cottage', size: [w, d] }));
const gridPlan = (lots, size, layout = 'grid') => ({ schemaVersion: 'plan/0', zones: [{ id: 'town', size, program: { layout, lots } }] });
const part = (r) => r.check.parts[0];
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, 'gh', `${n}.json`), 'utf8')).plan;

test('GH: a grid zone refused NO_ROOM carries a street wouldFit that, applied, compiles READY', async () => {
  const plan = gridPlan(cottages(3, 13, 14), { w: 30, d: 90 });
  const p = part(await check(plan));
  assert.equal(p.class, 'refused');
  assert.equal(p.reasons[0].code, 'NO_ROOM');
  assert.equal(p.reasons[0].evidence.layout, 'grid');
  assert.match(p.reasons[0].message, /layout 'street' places 3$/);
  assert.equal(p.wouldFit.length, 1);
  const w = p.wouldFit[0];
  assert.equal(w.part, 'town');
  assert.deepEqual(w.fragment, { program: { layout: 'street', lots: plan.zones[0].program.lots } });
  const fixed = gridPlan(cottages(3, 13, 14), { w: 30, d: 90 });
  fixed.zones[0].program = w.fragment.program;
  const r = await check(fixed);
  assert.equal(r.check.overall, 'READY');
  assert.equal(part(r).class, 'fits');
  assert.deepEqual(part(r).geometry.rect, w.geometry.rect);
});

test('GH: a grid zone is never read as street: without the fragment it stays refused', async () => {
  const p = part(await check(gridPlan(cottages(3, 13, 14), { w: 30, d: 90 })));
  assert.equal(p.class, 'refused');
});

test('GH: when street fails too there is no wouldFit', async () => {
  const p = part(await check(gridPlan(cottages(3, 13, 14), { w: 40, d: 16 })));
  assert.equal(p.class, 'refused');
  assert.equal(p.reasons[0].code, 'NO_ROOM');
  assert.equal(p.wouldFit, undefined);
  assert.doesNotMatch(p.reasons[0].message, /street/);
  const ring = part(await check(gridPlan(cottages(3, 13, 14), { w: 20, d: 20 }, 'ring')));
  assert.equal(ring.wouldFit, undefined);
});

test('GH: determinism: the same plan answers the same twice', async () => {
  for (const size of [{ w: 30, d: 90 }, { w: 40, d: 16 }]) {
    const a = await check(gridPlan(cottages(3, 13, 14), size)), b = await check(gridPlan(cottages(3, 13, 14), size));
    assert.deepEqual(a.check.parts, b.check.parts);
  }
});

test('GH: a zone that fits is unchanged (no wouldFit, no street hint)', async () => {
  const p = part(await check(gridPlan(cottages(6, 13, 14), undefined)));
  assert.equal(p.class, 'fits');
  assert.equal(p.wouldFit, undefined);
});

test("GH: Steward's recorded grid towns (metropolis, walled_town): the street wouldFit is one step, exactly what the street answer places", async () => {
  // Steward's numbers on main 6b14fc18 with only layout rewritten to street: metropolis 13 of 35, walled_town 12 of 15
  const want = { metropolis: { zone: 'capital', placed: 13 }, walled_town: { zone: 'town', placed: 12, dropped: ['townhouse_4', 'smithy_1', 'chapel_1'] } };
  for (const n of ['metropolis', 'walled_town']) {
    const plan = fixture(n);
    const r = await check(plan);
    const z = r.check.parts[0];
    assert.equal(z.class, 'refused');
    assert.equal(z.reasons[0].code, 'NO_ROOM');
    assert.match(z.reasons[0].message, /no grid layout fits/);
    assert.equal(z.wouldFit.length, 1);
    const w = z.wouldFit[0];
    assert.equal(w.fragment.program.layout, 'street');
    assert.deepEqual(Object.keys(w.fragment), ['program']);
    const total = plan.zones[0].program.lots.length;
    const kept = w.fragment.program.lots.map((l) => l.id);
    const dropped = plan.zones[0].program.lots.map((l) => l.id).filter((id) => !kept.includes(id));
    assert.equal(kept.length, want[n].placed);
    assert.deepEqual(z.reasons[0].evidence.altDropped, dropped);
    if (want[n].dropped) assert.deepEqual(dropped, want[n].dropped);
    assert.ok(z.reasons[0].message.endsWith(`; layout 'street' places ${kept.length} of ${total} (drops ${dropped.join(', ')})`), z.reasons[0].message);
    const fixed = fixture(n);
    fixed.zones[0].program = w.fragment.program;
    const s = await check(fixed);
    const sp = s.check.parts[0];
    assert.equal(s.check.overall, 'READY');
    assert.ok(sp.class === 'fits' || sp.class === 'adjusted');
    assert.deepEqual(sp.geometry.rect, w.geometry.rect);
    assert.deepEqual(sp.geometry.lots.map((l) => l.id).sort(), [...kept].sort(), 'exactly the lots the wouldFit claims');
    assert.ok(!(sp.deviations ?? []).some((d) => d.what === 'count'));
    // the unmodified street rewrite (Steward's run) places the same lots as the wouldFit keeps
    const sw = fixture(n);
    sw.zones[0].program.layout = 'street';
    const sr = (await check(sw)).check.parts[0];
    assert.equal(sr.geometry.lots.length, want[n].placed);
    assert.deepEqual((await check(fixture(n))).check.parts[0], z, 'deterministic');
  }
});
