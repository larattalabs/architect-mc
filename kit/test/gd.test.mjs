// (GD, Steward's S-PV1-1; docs/CONTRACT.md "Slice GD as built") grow.district on a plan_v0 region: a plan/0 plan with a D1 districts zone
// realised as plan_v0 grows one district by name (with grow.zone, or alone when one zone holds it) on that district's streets only; an
// ambiguous name without grow.zone and an unknown district refuse; a districts region's growth is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KIT } from './d3-helpers.mjs';
import { mergeEffective, revisionStanding, reviseIR } from '../lib/region/revise.mjs';
import { growPlan, streetRuns, zoneDistricts, graphCut } from '../lib/region/grow.mjs';
import { districtLand } from '../lib/region/land.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns, canonicalJson, makeColumns } from '../lib/region/pack.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import crypto from 'node:crypto';
import { finishCheck } from '../lib/plan/finish.mjs';
import { flatSurvey } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const PV0 = path.join(KIT, 'regions', 'plan_v0.mjs');
const lots = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: 'house', size: [9, 9] }));
const PLAN = { schemaVersion: 'plan/0', planId: 'gd_quarters', zones: [{ id: 'quarters', program: { loopiness: 0.15, districts: [
  { id: 'market', size: { w: 48, d: 40 }, lots: lots('mk', 3) },
  { id: 'crafts', size: { w: 40, d: 40 }, near: ['market'], lots: lots('cr', 2) },
] } }] };

let S = null;
async function standing() {
  if (S) return S;
  const sv = flatSurvey({ W: 256, D: 256, x0: 0, z0: 0 });
  const params = { plan: PLAN, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await planRegion({ programFile: PV0, params, survey: sv.bytes, claim: sv.claim, roles: {} });
  const f = finishCheck({ res, survey: fillMissing(asColumns(sv.bytes)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  const eff = mergeEffective(res.ir);
  const st = revisionStanding({ id: 'gd1', claim: [0, 0, 255, 255], effective: eff, lots: Object.fromEntries(res.ir.lots.map((l) => [l.id, { state: 'placed' }])) });
  S = { sv, res, check: f.check, eff, st };
  return S;
}

const ctxOf = (s) => ({ rid: 1, position: 1, parent: { rid: 0, irSha: s.res.irSha }, base: { irSha: s.res.irSha }, survey: s.sv.bytes, standing: s.st });
const CLAIM = { minX: 0, minZ: 0, maxX: 255, maxZ: 255, minY: -64, maxY: 319 };
const ctxSurvey = (s) => surveyApi(s.sv.bytes, CLAIM);
const strip = (g) => JSON.parse(JSON.stringify(g));
const growPlanP = async (o) => growPlan(o);
/** growPlan's answer for GD (5)'s districts-region growth, pinned from origin/main b003c214 (before GD): unchanged byte for byte. */
const DISTRICTS_GROWTH_SHA = 'c63b30b370ae8ba2149a4d512ab38db3c6444f5e345e704ff25ced6659b17d26';
const errOf = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const rectsMeet = (a, b, m = 0) => a.minX - m <= b.maxX && b.minX - m <= a.maxX && a.minZ - m <= b.maxZ && b.minZ - m <= a.maxZ;

/** A grown district: every frontage slot on the district's own streets, its extension (if any) from one, its lots apart from every standing lot. */
function onlyDistrict(s, r, d) {
  const g = r.ir.revision.grow;
  assert.equal(g.district, d);
  assert.ok(g.lots.length >= 1, JSON.stringify(g));
  const own = new Set(streetRuns(s.eff).filter((q) => q.district === d).map((q) => q.road));
  for (const f of g.frontage ?? []) assert.ok(own.has(f.street), `${f.lot} on ${f.street}, not a ${d} street`);
  if (g.extension) assert.ok(own.has(g.extension.road.replace(/_g\d+$/, '')), `extension ${g.extension.road}`);
  for (const rd of r.ir.roads ?? []) assert.equal(rd.ext?.['architect_mc:street']?.district, d, rd.id);
  // no overlaps: the grown lots stay lotGap (3) off every standing lot and each other; the parts are the revision's own
  const L = r.ir.lots;
  for (const l of L) for (const q of s.res.ir.lots) assert.ok(!rectsMeet(l.box, q.box, 3), `${l.id} meets standing ${q.id}`);
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) assert.ok(!rectsMeet(L[i].box, L[j].box, 3), `${L[i].id} meets ${L[j].id}`);
  assert.ok(r.ir.parts.every((p) => p.id.startsWith('rv1_')));
  // the checker over the revision: no M29 (nothing written on a standing cell) and no error finding
  const chk = checkRegion({ ir: r.ir, survey: fillMissing(asColumns(s.sv.bytes)).columns, blobs: (sha) => r.blobs.get(sha), standing: s.st });
  assert.deepEqual(chk.findings.filter((f) => f.rule === 'M29:revision' || f.severity === 'error').map((f) => `${f.rule} ${f.message}`), []);
  // every grown lot joins the graph (no lot cut off from a plaza); plan_v0 keeps no district land record (districts regions only)
  const m = mergeEffective(s.res.ir, [{ rid: 1, position: 1, ir: r.ir }]);
  assert.ok(m.graph.nodes.some((n) => n.kind === 'plaza'));
  assert.deepEqual(graphCut(m), []);
  assert.equal(districtLand(m), null);
  return g;
}

test('GD (1): grow.district + grow.zone on a plan_v0 region grows only that district (its streets, its numbering); the plan checks READY', async () => {
  const s = await standing();
  assert.equal(s.check.overall, 'READY');
  assert.deepEqual([...zoneDistricts(s.eff)].map(([z, d]) => [z, [...d].sort()]), [['quarters', ['crafts', 'market']]]);
  for (const d of ['market', 'crafts']) {
    const r = await reviseIR(s.eff, { grow: { zone: 'quarters', district: d, lots: 2 } }, ctxOf(s));
    const g = onlyDistrict(s, r, d);
    // (market sits by the claim's north-west corner: one frontage slot, its free end runs into the claim edge; crafts extends east)
    assert.deepEqual(g.lots, d === 'market' ? ['market_1'] : ['crafts_1', 'crafts_2']);
    assert.deepEqual(g.unplaced.map((u) => [u.id, u.kind]), d === 'market' ? [['market_2', 'street']] : []);
  }
  // a lot list as Steward sends it, prefer extend: still that district's streets only
  const r = await reviseIR(s.eff, { grow: { zone: 'quarters', district: 'crafts', lots: [{ id: 'cr3', type: 'house', size: [9, 9] }, { id: 'cr4', type: 'smithy', size: [9, 11] }], prefer: 'extend' } }, ctxOf(s));
  onlyDistrict(s, r, 'crafts');
});

test('GD (2): grow.district alone, when one zone holds it, plans exactly the growth with grow.zone', async () => {
  const s = await standing();
  const a = growPlan({ eff: s.eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'market', lots: 3 }, rid: 1 });
  const b = growPlan({ eff: s.eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'market', zone: 'quarters', lots: 3 }, rid: 1 });
  assert.deepEqual(strip(a), strip(b));
  const r1 = await reviseIR(s.eff, { grow: { district: 'market', lots: 3 } }, ctxOf(s));
  const r2 = await reviseIR(s.eff, { grow: { district: 'market', zone: 'quarters', lots: 3 } }, ctxOf(s));
  onlyDistrict(s, r1, 'market');
  assert.equal(canonicalJson(r1.ir.revision.grow), canonicalJson(r2.ir.revision.grow));
  assert.equal(canonicalJson(r1.ir.parts), canonicalJson(r2.ir.parts));
  // the zone alone (today's call) still grows the whole zone's streets, unchanged
  // (the zone alone, today's call, still takes any street of the zone: its 3 lots reach crafts' streets, market's alone never does)
  const z = await reviseIR(s.eff, { grow: { zone: 'quarters', lots: 3 } }, ctxOf(s));
  assert.equal(z.ir.revision.grow.district, null);
  assert.ok(z.ir.revision.grow.frontage.some((f) => f.street.startsWith('crafts_')) || z.ir.revision.grow.extension?.road.startsWith('crafts_'), JSON.stringify(z.ir.revision.grow));
});

test('GD (3): a name two zones hold refuses without grow.zone, naming the zones; with grow.zone it grows that zone\'s district', async () => {
  const s = await standing();
  // (plan/0 keeps district ids unique across a plan, so the second zone holding `crafts` is the street flags' alone: a tag-only zone)
  const eff = JSON.parse(JSON.stringify(s.eff));
  for (const rd of eff.roads) if (rd.id === 'crafts_street_w') rd.ext['architect_mc:street'] = { zone: 'annex', district: 'crafts' };
  const m = await errOf(growPlanP({ eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'crafts', lots: 1 }, rid: 1 }));
  assert.match(m, /^NOT_ALLOWED: \[call\] grow\.district 'crafts' is a district of zones annex, quarters: name one with grow\.zone$/);
  const a = growPlan({ eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'crafts', zone: 'annex', lots: 1 }, rid: 1 });
  assert.ok(a.lots.every((l) => l.slot.street === 'crafts_street_w'), JSON.stringify(a.lots.map((l) => l.slot)));
  const b = growPlan({ eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'crafts', zone: 'quarters', lots: 1 }, rid: 1 });
  assert.ok(b.lots.every((l) => l.slot.street === 'crafts_street_e'), JSON.stringify(b.lots.map((l) => l.slot)));
  // a zone that doesn't hold the district refuses, naming whose it is
  assert.match(await errOf(growPlanP({ eff: s.eff, standing: s.st, survey: ctxSurvey(s), grow: { district: 'crafts', zone: 'town', lots: 1 }, rid: 1 })),
    /^NOT_ALLOWED: \[call\] grow\.district 'crafts' is not a district of zone town \(it is quarters's; town's: none\)$/);
});

test('GD (4): an unknown district refuses as today, listing the region\'s districts; a region without districts lists none', async () => {
  const s = await standing();
  assert.equal(await errOf(reviseIR(s.eff, { grow: { district: 'docks', lots: 1 } }, ctxOf(s))), "NOT_ALLOWED: [call] grow.district 'docks' is not a district of the region (crafts, market)");
  const bare = { ...s.eff, params: {}, roads: s.eff.roads.map((rd) => ({ ...rd, ext: { 'architect_mc:street': { zone: 'town' } } })) };
  assert.equal(await errOf(growPlanP({ eff: bare, standing: s.st, survey: ctxSurvey(s), grow: { district: 'docks', lots: 1 }, rid: 1 })), "NOT_ALLOWED: [call] grow.district 'docks' is not a district of the region (none)");
});

test('GD (5): a districts region grows as before (byte identity of one growth, pinned from main before GD)', async () => {
  const W = 192, D = 192, claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const c = makeColumns(0, 0, W, D, 1);
  for (let k = 0; k < W * D; k++) { c.ground[k] = 64; c.height[k] = 64; c.floor[k] = 64; c.flags[k] = 0; }
  const q = await planRegion({ programFile: path.join(KIT, 'regions', 'districts.mjs'), params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 2 }, { id: 'west', size: [48, 48], lots: 2 }] }, lamps: false }, survey: c, claim, seed: '1' });
  const eff = mergeEffective(q.ir);
  const st = revisionStanding({ id: 'rg5', claim: [0, 0, 191, 191], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const g = growPlan({ eff, standing: st, survey: surveyApi(c, claim), grow: { district: 'east', lots: 3, prefer: 'extend' }, rid: 1 });
  const sha = crypto.createHash('sha256').update(canonicalJson(strip(g))).digest('hex');
  assert.equal(sha, DISTRICTS_GROWTH_SHA);
  // the districts region still asks for a district, and refuses one it lacks
  assert.match(await errOf(growPlanP({ eff, standing: st, survey: surveyApi(c, claim), grow: { lots: 1 }, rid: 1 })), /a districts region grows one district/);
  assert.equal(await errOf(growPlanP({ eff, standing: st, survey: surveyApi(c, claim), grow: { district: 'north', lots: 1 }, rid: 1 })), "NOT_ALLOWED: [call] grow.district 'north' is not a district of the region (east, west)");
});
