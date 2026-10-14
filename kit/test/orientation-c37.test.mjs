// C37: the street-orientation preference (docs/CONTRACT.md "C37 as built"): orientation "ew" | "ns" | "auto" on street layouts
// (plan/0 program.flat_village params, a lots program, the Regions flat_village program), strict when forced, "auto" = today.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { layoutStreet } from '../lib/region/village.mjs';
import { asksSurvey, checkPlanLocal, stewardAnchors, KIT } from './plan-helpers.mjs';

const A = asksSurvey();
const check = (plan) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
const cottages = (n, w, d) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, type: 'cottage', size: [w, d] }));
const lotsPlan = (lots, extra = {}, zone = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'town', ...zone, program: { lots, ...extra } }] });
const tplPlan = (lots, params = {}, zone = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'town', ...zone, program: { template: 'flat_village', params: { lots, ...params } } }] });
const part = (r) => r.check.parts[0];

test('C37: Steward\'s cases: 9x9 cottages give ew and 13x14 give ns under auto; "ew" forces ew on 13x14, "ns" forces ns on 9x9', async () => {
  const auto9 = part(await check(lotsPlan(cottages(4, 9, 9)))), auto13 = part(await check(lotsPlan(cottages(4, 13, 14))));
  assert.equal(auto9.geometry.orientation, 'ew');
  assert.equal(auto13.geometry.orientation, 'ns');
  for (const mk of [(l, o) => lotsPlan(l, { orientation: o }), (l, o) => tplPlan(l, { orientation: o })]) {
    const ew13 = part(await check(mk(cottages(4, 13, 14), 'ew')));
    assert.equal(ew13.class, 'fits'); assert.equal(ew13.geometry.orientation, 'ew'); assert.equal(ew13.geometry.lots.length, 4);
    const ns9 = part(await check(mk(cottages(4, 9, 9), 'ns')));
    assert.equal(ns9.class, 'fits'); assert.equal(ns9.geometry.orientation, 'ns'); assert.equal(ns9.geometry.lots.length, 4);
  }
});

test('C37: "auto" and omitted are the same answer, byte for byte', async () => {
  for (const [w, d] of [[9, 9], [13, 14]]) {
    const a = await check(lotsPlan(cottages(4, w, d))), b = await check(lotsPlan(cottages(4, w, d), { orientation: 'auto' }));
    assert.deepEqual(part(a).geometry, part(b).geometry);
    const t1 = await check(tplPlan(cottages(4, w, d))), t2 = await check(tplPlan(cottages(4, w, d), { orientation: 'auto' }));
    assert.deepEqual(part(t1).geometry, part(t2).geometry);
  }
});

test('C37: a forced orientation that places nothing where the other would is refused NO_ROOM, with wouldFit the other orientation', async () => {
  const noRot = { tolerance: { rotate: { allowed: false } } };
  for (const [size, forced, other] of [[{ w: 30, d: 90 }, 'ew', 'ns'], [{ w: 90, d: 30 }, 'ns', 'ew']]) {
    for (const tpl of [false, true]) {
      const mk = (o) => (tpl ? tplPlan(cottages(3, 13, 14), { shared: 'well', orientation: o }, { size, ...noRot }) : lotsPlan(cottages(3, 13, 14), { shared: 'well', orientation: o }, { size, ...noRot }));
      const auto = part(await check(mk(undefined)));
      assert.equal(auto.geometry.orientation, other, 'auto finds the other');
      const p = part(await check(mk(forced)));
      assert.equal(p.class, 'refused');
      assert.equal(p.reasons[0].code, 'NO_ROOM');
      assert.equal(p.reasons[0].evidence.orientation, forced);
      assert.equal(p.wouldFit.length, 1);
      assert.equal(p.wouldFit[0].part, 'town');
      const o2 = tpl ? p.wouldFit[0].fragment.program.params.orientation : p.wouldFit[0].fragment.program.orientation;
      assert.equal(o2, other);
      // the wouldFit fragment, applied, fits
      const fixed = mk(forced); const z = fixed.zones[0];
      z.program = p.wouldFit[0].fragment.program;
      const q = part(await check(fixed));
      assert.equal(q.class, 'fits'); assert.equal(q.geometry.orientation, other);
    }
  }
});

test('C37: layoutStreet is strict: a forced orientation never falls back; unplaced lots are the usual unplaced', () => {
  const claim = { minX: 0, minZ: 0, maxX: 99, maxZ: 39, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, 100, 40, 1);
  for (let k = 0; k < 4000; k++) { c.ground[k] = 64; c.height[k] = 64; c.floor[k] = 64; }
  const survey = surveyApi(c, claim);
  const specs = cottages(4, 13, 14);
  const auto = layoutStreet({ claim, survey, specs: specs.map(clean) });
  const ew = layoutStreet({ claim, survey, specs: specs.map(clean), orientation: 'ew' });
  const ns = layoutStreet({ claim, survey, specs: specs.map(clean), orientation: 'ns' });
  assert.equal(ew.orientation, 'ew');
  assert.ok(ns.fail || ns.lots.length < ew.lots.length, 'a 40-deep claim holds no ns street of 13x14 lots');
  if (!ns.fail) assert.equal(ns.orientation, 'ns');
  assert.equal(auto.orientation, 'ew');
  assert.throws(() => layoutStreet({ claim, survey, specs: specs.map(clean), orientation: 'up' }), /orientation must be/);
  function clean(s) { return { id: s.id, type: s.type, size: s.size, role: 'home', villager: 'dwelling' }; }
});

test('C37: the Regions flat_village program takes params.orientation; omitting it or "auto" keeps the seed, IR and tiles', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, 112, 112, 1);
  for (let k = 0; k < 112 * 112; k++) { c.ground[k] = 64; c.height[k] = 64; c.floor[k] = 64; }
  const lots = [{ id: 'a', type: 'cottage', size: [9, 9] }, { id: 'b', type: 'cottage', size: [9, 9] }, { id: 'c', type: 'cottage', size: [9, 9] }];
  const run = (params) => planRegion({ programFile: path.join(KIT, 'regions', 'flat_village.mjs'), params: { lots, ...params }, survey: c, claim });
  const base = await run({}), auto = await run({ orientation: 'auto' }), ns = await run({ orientation: 'ns' }), ew = await run({ orientation: 'ew' });
  assert.equal(base.seed, auto.seed);
  assert.equal(JSON.stringify(base.ir), JSON.stringify(auto.ir));
  const roads = (p) => p.ir.roads.map((r) => r.points);
  assert.deepEqual(roads(base), roads(ew), 'a 9x9 auto street is ew');
  assert.notDeepEqual(roads(base), roads(ns));
  const dx = (pts) => Math.abs(pts[0][0] - pts.at(-1)[0]), dz = (pts) => Math.abs(pts[0][2] - pts.at(-1)[2]);
  assert.ok(roads(ew).every((p) => dx(p) >= dz(p)), 'ew: the street runs along x');
  assert.ok(roads(ns).every((p) => dz(p) >= dx(p)), 'ns: the street runs along z');
  await assert.rejects(run({ orientation: 'diagonal' }), /orientation must be one of/);
});
