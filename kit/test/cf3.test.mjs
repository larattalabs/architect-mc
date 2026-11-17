// Slice CF3 (compose follow-up from PAY P2 S3): a LOTS_SHORT zone whose short parts stand on ground too steep for a street (an M lot
// on it would rise more than STREET_RULES.maxSlope) with no terraces of their own nor from the zone gets a terrace suggestion in the
// reason's message and evidence (`terraces: {ids, rise}`). Terraced parts, flat ground and a call without a survey answer as CF2's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeColumns, FLAG_WATER } from '../lib/region/pack.mjs';
import { LOTS_SHORT, groundRise, markLotsShort, steepFor, terraceNudge } from '../lib/plan/finish.mjs';

/** A 160x160 grid at resolution 1 from (0, 0): ground 64 + floor(x * grade). */
const grid = (grade) => { const c = makeColumns(0, 0, 160, 160, 1); for (let j = 0; j < 160; j++) for (let i = 0; i < 160; i++) c.ground[i + j * 160] = 64 + Math.floor(i * grade); return c; };
const ramp = grid(0.5), flat = grid(0);
const districts = (terr = {}) => [
  { id: 'upper', lots: [{ id: 'a', type: 'house', size: [9, 9] }, { id: 'b', type: 'house', size: [9, 9] }], ...(terr.upper !== undefined ? { terraces: terr.upper } : {}) },
  { id: 'lower', lots: [{ id: 'c', type: 'house', size: [9, 9] }, { id: 'd', type: 'house', size: [9, 9] }], ...(terr.lower !== undefined ? { terraces: terr.lower } : {}) },
  { id: 'gate', lots: [{ id: 'e', type: 'house', size: [9, 9] }], ...(terr.gate !== undefined ? { terraces: terr.gate } : {}) },
];
const planOf = (zoneTerr, terr) => ({ zones: [{ id: 'town', required: true, ...(zoneTerr !== undefined ? { terraces: zoneTerr } : {}), program: { districts: districts(terr) } }] });
// upper placed (one lot short), lower placed whole, gate unplaced: 4 of 5 unplaced, past a third
const answer = () => ({ part: 'town', block: 'zone.standard', class: 'adjusted', required: true, deviations: [{ what: 'count', value: 4, max: 0, exceeds: true }],
  geometry: { rect: [0, 0, 111, 47], districts: { upper: { rect: [0, 0, 55, 47], lots: [{ id: 'a' }], unplaced: ['b'] }, lower: { rect: [56, 0, 111, 47], lots: [{ id: 'c' }, { id: 'd' }], unplaced: [] } },
    unplaced: ['gate'], lots: [{ id: 'a' }] } });
const mark = (plan, cols) => { const xs = [answer()]; markLotsShort(xs, plan, cols); return xs[0].reasons.find((r) => r.code === LOTS_SHORT); };

test('CF3: the slope measure: the ground\'s rise over a rect (dry known columns) and steep for a street past an M lot\'s maxSlope', () => {
  assert.equal(groundRise(ramp, [0, 0, 55, 47]), 27);
  assert.equal(groundRise(flat, [0, 0, 55, 47]), 0);
  const wet = grid(0.5); for (let j = 0; j < 160; j++) wet.flags[55 + j * 160] = FLAG_WATER;
  assert.equal(groundRise(wet, [0, 0, 55, 47]), 27); // column 55 (water) is skipped; column 54 still rises 27
  assert.equal(steepFor(27, [0, 0, 55, 47]), true);
  assert.equal(steepFor(12, [0, 0, 55, 47]), false); // 12 x 13 = 156 <= 3 x 56
  assert.equal(steepFor(13, [0, 0, 55, 47]), true);
  assert.equal(steepFor(null, [0, 0, 55, 47]), false);
});

test('CF3: a sloped LOTS_SHORT district without terraces gets the suggestion (an unplaced one measured over the zone)', () => {
  const r = mark(planOf(), ramp);
  assert.match(r.message, /; upper, gate stand on ground rising \d+ blocks, too steep for a street, without terraces: add `terraces` to the zone \(so every district is terraced\) or to each district$/);
  assert.deepEqual(r.evidence.terraces, { ids: ['upper', 'gate'], rise: 55 });
  // the district that placed all its lots is not named
  assert.ok(!r.evidence.terraces.ids.includes('lower'));
  // one terraced district: only the other
  assert.deepEqual(mark(planOf(undefined, { upper: {} }), ramp).evidence.terraces.ids, ['gate']);
});

test('CF3: zone terraces, terraces on every district, flat ground and no survey: no suggestion (CF2\'s reason as it was)', () => {
  const plain = mark(planOf(), null);
  assert.equal(plain.evidence.terraces, undefined);
  assert.match(plain.message, /or fewer lots$/);
  for (const [plan, cols] of [[planOf({}), ramp], [planOf(true), ramp], [planOf(undefined, { upper: {}, lower: {}, gate: { rise: 4 } }), ramp], [planOf(), flat]]) {
    assert.deepEqual(mark(plan, cols), plain, JSON.stringify(plan.zones[0].terraces ?? plan.zones[0].program.districts.map((d) => d.terraces)));
  }
});

test('CF3: a lots zone on steep ground without terraces: add terraces to the zone', () => {
  const a = { part: 'town', block: 'zone.standard', class: 'adjusted', required: true, deviations: [{ what: 'count', value: 6 }], geometry: { rect: [0, 0, 47, 47], lots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } };
  const zone = { id: 'town', required: true, program: { lots: [] } };
  const xs = [a];
  markLotsShort(xs, { zones: [zone] }, ramp);
  assert.match(xs[0].reasons[0].message, /; the zone stands on ground rising 23 blocks, too steep for a street, without terraces: add `terraces` to the zone$/);
  assert.deepEqual(xs[0].reasons[0].evidence.terraces, { ids: ['town'], rise: 23 });
  assert.equal(terraceNudge(a, { ...zone, terraces: {} }, ramp), null);
  assert.equal(terraceNudge(a, zone, flat), null);
});
