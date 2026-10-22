// (6c close-out A) The kit items (docs/CONTRACT.md "Phase 6c close-out A" §4, §5, §7, §9; §11 items 4, 5, 7, 9): a route ending on a
// piece its zone could not place answers blocked; rule.palette's `over` and `exempt: ways | forms`; ponds choose a lot-clear site;
// district routes keep out of protected areas, other regions and builds. Fixtures in fixtures/plan/coa/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, asksSurvey, checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const A = asksSurvey();
const readJ = (...p) => ({ name: p.join('/'), ...JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8')) });
/** A fixture checked as the gates check it (its claim, Steward's anchors and its own, its protected areas, the two-plan flow). */
async function run(fx, { plan = fx.plan ?? fx.answer?.plan, ...o } = {}) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? A : flatSurvey();
  return checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], regions: fx.regions ?? [], builds: fx.builds ?? [], volume: fx.volume ?? {}, ...o });
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const irOf = (r) => JSON.parse(r.res.irJson);
const meets = (x, z, q, g = 0) => x >= q[0] - g && x <= q[2] + g && z >= q[1] - g && z <= q[3] + g;
/** The cells along a road's polyline (each segment stepped cell by cell). */
function roadCells(road) {
  const out = [];
  for (let i = 1; i < road.points.length; i++) {
    const [a, b] = [road.points[i - 1], road.points[i]];
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[2] - a[2]), 1);
    for (let k = 0; k <= n; k++) out.push([Math.round(a[0] + ((b[0] - a[0]) * k) / n), Math.round(a[2] + ((b[2] - a[2]) * k) / n)]);
  }
  return out;
}

// ------------------------------------------------------------------ §9 (item 9): district routes keep out

test('§9: a protected rect across a plain district\'s link: the districts zone\'s routes keep out of it (main routed through it)', async () => {
  const fx = readJ('coa', 'd01_protected_route.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const q = part(r, 'quarters');
  assert.equal(q.class, 'fits');
  assert.ok(q.geometry.edges.every((e) => e.ok), 'every district link routed');
  const orchard = fx.protected[0].rect;
  const links = irOf(r).roads.filter((x) => x.part === 'routes_quarters');
  assert.ok(links.length >= 2, 'the links are written');
  for (const road of links) for (const [x, z] of roadCells(road)) assert.ok(!meets(x, z, orchard, (road.width - 1) >> 1), `${road.id} at ${x} ${z} meets the protected orchard`);
  // the tree goes round it: market joins crafts (main's tree joined market to homes across the orchard)
  assert.deepEqual(q.geometry.edges.map((e) => e.id).sort(), ['d_crafts__homes', 'd_market__crafts']);
});

// ------------------------------------------------------------------ §4 (item 4): a route ending on a piece its zone could not place

/** §4's answer: blocked by the zone, DEPENDENCY with evidence {kind: unplaced, lot | district, zone, blockedBy, classes}. */
function assertUnplaced(r, id, { zone, lot = undefined, district = undefined }) {
  const a = part(r, id);
  assert.equal(a.class, 'blocked', `${id}: ${JSON.stringify(a.reasons)}`);
  assert.deepEqual(a.blockedBy, [zone]);
  assert.equal(a.reasons.length, 1);
  const [why] = a.reasons;
  assert.equal(why.code, 'DEPENDENCY');
  const piece = lot !== undefined ? { lot } : { district };
  assert.equal(why.message, `ends on ${lot !== undefined ? `lot ${lot}` : `district ${district}`}, which zone ${zone} could not place`);
  assert.deepEqual(why.evidence, { kind: 'unplaced', ...piece, zone, blockedBy: [zone], classes: { [zone]: part(r, zone).class } });
  assert.ok(['fits', 'adjusted'].includes(part(r, zone).class), `${zone} is ${part(r, zone).class}: the piece, not the zone, holds the route`);
}

test('§4: a street zone\'s unplaced lot as a lot part and as the zone\'s port: blocked by the zone; a dependant stays blocked by the route', async () => {
  const r = await run(readJ('coa', 'b01_unplaced_street_lot.json'));
  const town = part(r, 'town');
  assert.equal(town.class, 'adjusted');
  assert.ok(town.geometry.unplaced.includes('l8'));
  assertUnplaced(r, 'r_lot', { zone: 'town', lot: 'l8' });
  assertUnplaced(r, 'r_port', { zone: 'town', lot: 'l8' });
  const after = part(r, 'after');
  assert.equal(after.class, 'blocked');
  assert.deepEqual(after.blockedBy, ['r_lot']);
  assert.deepEqual(after.reasons[0].evidence, { blockedBy: ['r_lot'], classes: { r_lot: 'blocked' } });
});

test('§4: a free layout\'s unplaced lot (port), a districts zone\'s unplaced lot (port) and unplaced district (port): blocked by the zone', async () => {
  const r = await run(readJ('coa', 'b02_unplaced_free_districts.json'));
  assert.ok(part(r, 'ring').geometry.unplaced.includes('g40'));
  assert.ok(part(r, 'quarters').geometry.unplaced.includes('huge'));
  assert.ok(part(r, 'quarters').geometry.districts.small.unplaced.includes('q8'));
  assertUnplaced(r, 'r_free', { zone: 'ring', lot: 'g40' });
  assertUnplaced(r, 'r_dlot', { zone: 'quarters', lot: 'q8' });
  assertUnplaced(r, 'r_dist', { zone: 'quarters', district: 'huge' });
  // the answers validate against plan.json's partAnswer (blockedBy, the reason's members)
  for (const id of ['r_free', 'r_dlot', 'r_dist']) assert.deepEqual(Object.keys(part(r, id)).filter((k) => !['part', 'block', 'class', 'required', 'reasons', 'blockedBy'].includes(k)), []);
});
