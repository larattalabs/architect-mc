// Slice CF2 (compose follow-ups from PAY P2 S3): a required zone whose unplaced lots exceed its allowance (its own tolerance.count.max,
// else a third of its lots) keeps its adjusted class and geometry but carries a LOTS_SHORT reason, and the check answers NEEDS_REPAIR
// instead of READY. An optional zone, and a zone within its allowance, answer as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlanLocal, flatSurvey } from './plan-helpers.mjs';
import { LOTS_SHORT, lotsShort, lotsShortAllowed, markLotsShort, overallOf } from '../lib/plan/finish.mjs';

const land = flatSurvey({ W: 160, D: 160, x0: 0, z0: 0 });
const lots = (n) => Array.from({ length: n }, (_, i) => ({ id: `hall_${i + 1}`, type: 'hall', size: [17, 15] }));
const plan = (n, { required = true, tolerance } = {}) => ({ schemaVersion: 'plan/0', connectors: [], forms: [], rules: [],
  zones: [{ id: 'town', required, size: { preset: 'M' }, ...(tolerance ? { tolerance } : {}), program: { lots: lots(n), layout: 'street', shared: 'none' } }] });
const check = async (p) => (await checkPlanLocal(p, { survey: land.bytes, claim: land.claim })).check;

test('CF2: the allowance is the zone\'s own count max, else a third of its lots', () => {
  assert.equal(lotsShortAllowed({}, 9), 3);
  assert.equal(lotsShortAllowed({ tolerance: { count: { max: 0 } } }, 9), 0);
  assert.equal(lotsShortAllowed({ tolerance: { count: { max: 5 } } }, 9), 5);
  assert.equal(lotsShortAllowed(undefined, 2), 0);
});

test('CF2: markLotsShort marks only a required zone past its allowance; overallOf answers NEEDS_REPAIR for it', () => {
  const zone = (o) => ({ part: 'z', block: 'zone.standard', class: 'adjusted', required: true, deviations: [{ what: 'count', value: 6, max: 0, exceeds: true }],
    geometry: { lots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], unplaced: ['d', 'e', 'f', 'g', 'h', 'i'] }, ...o });
  const short = [zone()];
  markLotsShort(short, { zones: [{ id: 'z' }] });
  assert.equal(short[0].class, 'adjusted');
  assert.equal(short[0].reasons[0].code, LOTS_SHORT);
  assert.match(short[0].reasons[0].message, /^6 of the zone's 9 lots did not fit \(3 placed; at most 3 may be left out\)/);
  assert.deepEqual(short[0].reasons[0].evidence, { what: 'count', lots: 9, placed: 3, unplaced: 6, allowed: 3, ids: ['d', 'e', 'f', 'g', 'h', 'i'] });
  assert.ok(lotsShort(short[0]));
  assert.equal(overallOf(short), 'NEEDS_REPAIR');
  for (const a of [zone({ required: false }), zone({ block: 'form.crater' }), zone({ class: 'refused' }), zone({ deviations: [{ what: 'count', value: 3 }], geometry: { lots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }] } })]) {
    const xs = [a];
    markLotsShort(xs, { zones: [{ id: 'z' }] });
    assert.equal(xs[0].reasons, undefined, JSON.stringify(a));
  }
  // the zone's own tolerance wins: 6 unplaced within max 6
  const own = [zone()];
  markLotsShort(own, { zones: [{ id: 'z', tolerance: { count: { max: 6 } } }] });
  assert.equal(own[0].reasons, undefined);
  assert.equal(overallOf(own), 'READY');
});

test('CF2: a required zone with too few lots checks NEEDS_REPAIR (LOTS_SHORT), adjusted, with its geometry and artifact', async () => {
  const c = await check(plan(8));
  const z = c.parts.find((p) => p.part === 'town');
  assert.equal(c.overall, 'NEEDS_REPAIR');
  assert.equal(z.class, 'adjusted');
  assert.deepEqual(z.reasons.map((r) => r.code), [LOTS_SHORT]);
  assert.equal(z.reasons[0].evidence.lots, 8);
  assert.equal(z.reasons[0].evidence.unplaced, 4);
  assert.equal(z.geometry.lots.length, 4);
  assert.equal(typeof c.artifactSha, 'string');
});

test('CF2: an optional zone, a zone within a third and a zone within its own count max answer as before (READY, no reason)', async () => {
  for (const p of [plan(8, { required: false }), plan(6), plan(8, { tolerance: { count: { max: 4 } } })]) {
    const c = await check(p);
    const z = c.parts.find((q) => q.part === 'town');
    assert.equal(c.overall, 'READY', JSON.stringify(p.zones[0].tolerance ?? p.zones[0].required));
    assert.equal(z.class, 'adjusted');
    assert.equal(z.reasons, undefined);
  }
  // and a zone's own tighter count max makes 2 of 6 unplaced a repair target
  const c = await check(plan(6, { tolerance: { count: { max: 1 } } }));
  assert.equal(c.overall, 'NEEDS_REPAIR');
});
