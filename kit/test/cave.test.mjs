// (slice CAVE) feature.cave: an elevated zone located by a cave the land already has, its lots carved into the cave's walls (carve_into
// site lots): the window box (RegionDesigns.affordanceBox mirrored), the two-plan flow (the first plan asks the window), placement against
// the hall's walls (door on the cave floor, rock behind, fronts facing the hall), its refusals, a cave on any other part, the schema and
// the catalogue entry. Fixture: a flat claim at ground 64 with a hall dug at y 40..47 (fixtureVolume's edits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatSurvey, checkPlanLocal, checkPlanVolumes } from './plan-helpers.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { caveWindowBox, CAVE_WINDOW } from '../lib/plan/cave.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { FRONT_OF_ROTATION } from '../lib/region/siteLots.mjs';

const HALL = { x0: 1080, x1: 1140, y0: 40, y1: 47, z0: 2070, z1: 2081 };
const VOLUME = { edits: [{ box: [HALL.x0, HALL.y0, HALL.z0, HALL.x1, HALL.y1, HALL.z1], class: 'AIR' }] };
const LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11] }, { id: 'home_1', type: 'cottage', size: [9, 9] }, { id: 'home_2', type: 'cottage', size: [9, 9] }, { id: 'home_3', type: 'cottage', size: [9, 9] }];
const plan = (where, extra = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'carved', required: true, where, program: { lots: LOTS, layout: 'elevated' }, ...extra }] });
const CAVE = { near: { feature: { cave: {} } } };
const fx = () => flatSurvey();

test('caveWindowBox mirrors RegionDesigns.affordanceBox: the claim (at most 256 a side, centred), 48 under the lowest ground to 24 over the top', () => {
  const { bytes, claim } = fx();
  const env = { cols: surveyApi(bytes, claim).columns, claim };
  assert.deepEqual(caveWindowBox(env), { minX: 1000, minY: 64 - CAVE_WINDOW.below, minZ: 2000, maxX: 1239, maxY: 64 + CAVE_WINDOW.above, maxZ: 2159 });
  const big = flatSurvey({ W: 300, D: 100 });
  const e2 = { cols: surveyApi(big.bytes, big.claim).columns, claim: big.claim };
  const w = caveWindowBox(e2);
  assert.equal(w.maxX - w.minX + 1, 256);
  assert.equal(w.minX, 1000 + Math.trunc((300 - 256) / 2));
});

test('an elevated zone near a cave: the first plan asks the window and answers incomplete; the second carves every lot into the hall\'s walls', async () => {
  const { bytes: survey, claim } = fx();
  const out = await checkPlanVolumes(plan(CAVE), { survey, claim, volume: VOLUME });
  assert.equal(out.first.check.overall, 'INCOMPLETE');
  assert.deepEqual(out.asked, [{ minX: 1000, minY: 16, minZ: 2000, maxX: 1239, maxY: 88, maxZ: 2159 }]);
  assert.equal(out.check.overall, 'READY', JSON.stringify(out.check.parts));
  const z = out.check.parts.find((p) => p.part === 'carved');
  assert.equal(z.class, 'fits');
  assert.match(z.notes[0], /^cave cave_[0-9a-f]{16} \(floor \d+, ceiling 8; 1 cave\(s\) under the claim\); 4 of 4 lot\(s\) carved into its walls$/);
  const lots = out.res.ir.lots.filter((l) => LOTS.some((q) => q.id === l.id));
  assert.equal(lots.length, 4);
  for (const l of lots) {
    assert.equal(l.site.fit, 'carve_into');
    assert.equal(l.floorY, HALL.y0, `${l.id} stands on the hall floor`);
    const b = l.box, front = FRONT_OF_ROTATION[l.site.frame.rotation];
    assert.equal(l.front, front);
    // the front row is the hall's edge row: in the hall; every other row in the rock beside it
    const row = { south: [b.maxZ, 'z'], north: [b.minZ, 'z'], east: [b.maxX, 'x'], west: [b.minX, 'x'] }[front];
    if (row[1] === 'z') assert.ok(row[0] >= HALL.z0 && row[0] <= HALL.z1 && (front === 'south' ? b.minZ < HALL.z0 : b.maxZ > HALL.z1), `${l.id} front ${front}`);
    else assert.ok(row[0] >= HALL.x0 && row[0] <= HALL.x1 && (front === 'east' ? b.minX < HALL.x0 : b.maxX > HALL.x1), `${l.id} front ${front}`);
    assert.equal(l.site.ports[0].kind, 'door');
  }
  // boxes apart (gap 1)
  for (const a of lots) for (const c of lots) if (a !== c) assert.ok(a.box.maxX + 1 < c.box.minX || c.box.maxX + 1 < a.box.minX || a.box.maxZ + 1 < c.box.minZ || c.box.maxZ + 1 < a.box.minZ, `${a.id} ${c.id}`);
  // deterministic
  const again = await checkPlanVolumes(plan(CAVE), { survey, claim, volume: VOLUME });
  assert.equal(again.res.irSha, out.res.irSha);
});

test('refusals: no cave under the claim, none big enough, more lots than the walls hold under a hard count; a cave on a street zone', async () => {
  const { bytes: survey, claim } = fx();
  const none = await checkPlanVolumes(plan(CAVE), { survey, claim, volume: {} });
  const zn = none.check.parts.find((p) => p.part === 'carved');
  assert.equal(zn.class, 'refused');
  assert.equal(zn.reasons[0].code, 'NO_FEATURE');
  assert.match(zn.reasons[0].message, /no cave under the claim/);
  const small = await checkPlanVolumes(plan({ near: { feature: { cave: { minFloor: 65536 } } } }), { survey, claim, volume: VOLUME });
  assert.match(small.check.parts[0].reasons[0].message, /no cave with a floor of at least 65536/);
  const many = { schemaVersion: 'plan/0', zones: [{ id: 'carved', required: true, where: CAVE, tolerance: { count: { max: 0, hard: true } }, program: { layout: 'elevated', lots: Array.from({ length: 40 }, (_, i) => ({ id: `home_${i + 1}`, type: 'cottage', size: [9, 9] })) } }] };
  const m = (await checkPlanVolumes(many, { survey, claim, volume: VOLUME })).check.parts[0];
  assert.equal(m.class, 'refused');
  assert.match(m.reasons[0].message, /found no wall of rock to carve into/);
  assert.ok(m.wouldFit?.[0]?.fragment?.program?.lots?.length > 0);
  const street = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, where: CAVE, program: { lots: [{ id: 'cottage_1', type: 'cottage', size: [9, 9] }] } }] };
  const s = (await checkPlanLocal(street, { survey, claim })).check.parts[0];
  assert.equal(s.class, 'refused');
  assert.match(s.reasons[0].message, /a cave feature locates a lots zone with layout elevated/);
});

test('the schema and the catalogue: feature.cave supported (NEXT until the release); an unknown `to` anchor is malformed', () => {
  const e = planCatalogue().entries.find((x) => x.id === 'feature.cave');
  assert.equal(e.state, 'supported');
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi));
  assert.equal(validatePlan(plan({ near: { feature: { cave: { minFloor: 400, pick: 'nearest', to: 'claim_center' } } } })).malformed, null);
  const bad = validatePlan(plan({ near: { feature: { cave: { to: 'nowhere' } } } }));
  assert.ok(bad.malformed || bad.parts.some((p) => p.verdict === 'malformed'));
  const extra = validatePlan(plan({ near: { feature: { cave: { ceiling: 6 } } } }));
  assert.ok(extra.malformed || extra.parts.some((p) => p.verdict === 'malformed'));
});

test('a carved zone\'s footprint is the box round its lots: a street zone resolved after it still places on the surface', async () => {
  const { bytes: survey, claim } = fx();
  const two = { schemaVersion: 'plan/0', zones: [{ id: 'a_carved', required: true, where: CAVE, program: { lots: LOTS, layout: 'elevated' } },
    { id: 'b_town', required: true, where: { near: { anchor: 'claim_center' } }, program: { lots: [{ id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }] } }] };
  const out = await checkPlanVolumes(two, { survey, claim, volume: VOLUME });
  const a = out.check.parts.find((p) => p.part === 'a_carved'), b = out.check.parts.find((p) => p.part === 'b_town');
  assert.equal(a.class, 'fits');
  assert.ok(['fits', 'adjusted'].includes(b.class), JSON.stringify(b));
  const r = a.geometry.rect;
  assert.ok(r[2] - r[0] < 120 && r[0] >= HALL.x0 - 16 && r[2] <= HALL.x1 + 16, `the carved rect ${r} hugs the hall`);
});
