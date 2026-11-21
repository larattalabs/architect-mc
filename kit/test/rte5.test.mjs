// (RTE5) RTE4's leftover P3 (v0.89.0 fix check): plan_v0's districts zone stamps its streets (`architect_mc:street {zone, district}`)
// after the districts pass, and streetRuns reads that flag before the id. The districts pass decided whether to record each district on
// its roads (ext architect_mc:district, land.mjs untaggedMisreads) before the stamp, so a lone `b_street` in a plan_v0 zone got tags it
// does not need. The check now runs after the stamp, on the roads as written, and a plan_v0 IR has no architect_mc:land record (land
// reads districts plans only), so there only streetRuns counts. Ownership is unchanged either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grow from '../lib/region/grow.mjs';
import * as land from '../lib/region/land.mjs';
import { mergeEffective } from '../lib/region/revise.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { flatSurvey } from './plan-helpers.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISTRICT = 'architect_mc:district', STREET = 'architect_mc:street';

/** A plan_v0 plan of one districts zone `town` holding V districts `ids` (40 x 40, one house) on flat 160 x 160 land, seed 7: its IR. */
async function planV0(ids) {
  const sv = flatSurvey({ W: 160, D: 160, x0: 0, z0: 0 });
  const plan = { schemaVersion: 'plan/0', planId: 'rte5', zones: [{ id: 'town', program: { districts: ids.map((id) => ({ id, size: { w: 40, d: 40 }, lots: [{ id: `${id}_h1`, type: 'house', size: [9, 9] }] })) } }] };
  const params = { plan, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  return (await planRegion({ programFile: path.join(KIT, 'regions', 'plan_v0.mjs'), params, survey: sv.bytes, claim: sv.claim, roles: {}, seed: '7' })).ir;
}
const tags = (ir) => Object.fromEntries(ir.roads.map((r) => [r.id, [r.ext?.[STREET]?.district ?? null, r.ext?.[DISTRICT]?.id ?? null]]));
/** The readers the tag is for: streetRuns's district per road and architect_mc:land's parts (exact runs). */
const reads = (ir) => {
  const eff = mergeEffective(ir);
  const L = land.districtLand(eff);
  return { runs: grow.streetRuns(eff).map((r) => [r.road, r.seg, r.district]), land: L && L.parts.map((p) => [p.kind, p.id, p.cells, JSON.stringify(p.runs)]) };
};
const withTags = (ir, owner) => ({ ...ir, roads: ir.roads.map((r) => (owner(r.id) ? { ...r, ext: { ...(r.ext ?? {}), [DISTRICT]: { id: owner(r.id) } } } : r)) });

test('(v0.89.0 fix check P3) plan_v0, a lone district b_street in zone town: its stamped streets read right, so no road carries the district tag', async () => {
  const ir = await planV0(['b_street']);
  assert.deepEqual(tags(ir), { b_street_street_w: ['b_street', null], b_street_street_e: ['b_street', null] });
  assert.deepEqual([...new Set(grow.streetRuns(mergeEffective(ir)).map((r) => r.district))], ['b_street']);
});

test('(v0.89.0 fix check P3) plan_v0, b_street beside c: both read right through the stamp and the longest id, no tag', async () => {
  const ir = await planV0(['b_street', 'c']);
  assert.ok(ir.roads.every((r) => !r.ext?.[DISTRICT]), JSON.stringify(tags(ir)));
  assert.deepEqual(Object.fromEntries(ir.roads.filter((r) => r.ext?.[STREET]).map((r) => [r.id, r.ext[STREET].district])), { b_street_street_w: 'b_street', b_street_street_e: 'b_street', c_street_w: 'c', c_street_e: 'c' });
});

test('plan_v0, b and b_street: streetRuns reads both through the stamp, and architect_mc:land is not a plan_v0 IR\'s record (no spec.districts), so no tag either', async () => {
  const ir = await planV0(['b', 'b_street']);
  assert.equal(land.districtLand(mergeEffective(ir)), null, 'land reads districts plans only (as DistrictLand)');
  assert.deepEqual(tags(ir), { b_street_w: ['b', null], b_street_e: ['b', null], b_street_street_w: ['b_street', null], b_street_street_e: ['b_street', null], route_d_b__b_street_1: [null, null] });
  assert.deepEqual(Object.fromEntries(grow.streetRuns(mergeEffective(ir)).map((r) => [r.road, r.district])), { b_street_e: 'b', b_street_street_e: 'b_street', b_street_street_w: 'b_street', b_street_w: 'b' });
});

test('ownership is unchanged: the untagged plan_v0 IRs read exactly as with v0.89.0\'s tags (streetRuns, land with exact runs)', async () => {
  for (const ids of [['b_street'], ['b_street', 'c'], ['b', 'b_street']]) {
    const ir = await planV0(ids);
    const owner = (id) => (id.startsWith('route_') ? null : id.startsWith('c_') ? 'c' : id.startsWith('b_street_street_') || ids.length === 1 || ids.includes('c') ? 'b_street' : 'b');
    const tagged = withTags(ir, owner), untagged = withTags(ir, () => null);
    assert.deepEqual(reads(untagged), reads(tagged), ids.join('+'));
  }
});

test('untaggedMisreads reads a road\'s street flag first, as streetRuns does; untagged rows ({id, district}) read as RTE4', () => {
  const o = (id, district, flag) => ({ id, district, ...(flag !== undefined ? { x: { id, ext: { [STREET]: { zone: 'town', ...(flag ? { district: flag } : {}) } } } } : {}) });
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street', 'b_street')], ['b_street']), false);
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street', 'b')], ['b_street']), true, 'a flag naming another district');
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street', null)], ['b_street']), true, 'a zone-only flag: the street rule');
  assert.equal(land.untaggedMisreads([o('b_street_w', 'b', 'b'), o('b_street_street_w', 'b_street', 'b_street')], ['b', 'b_street']), true, 'land\'s longest id ignores the flag');
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street')], ['b_street']), true);
  // (plan_v0: no land record, so only streetRuns's reading counts)
  assert.equal(land.untaggedMisreads([o('b_street_w', 'b', 'b'), o('b_street_street_w', 'b_street', 'b_street')], ['b', 'b_street'], { land: false }), false);
  assert.equal(land.untaggedMisreads([o('b_street_street_w', 'b_street')], ['b_street'], { land: false }), true, 'unflagged: the street rule still');
});
