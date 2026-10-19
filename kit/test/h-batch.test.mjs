// The H batch (H-core + H-a + H-b, v0.37.0), integration tests, $0 and offline:
//   the batch plan      one plan with a pond, a moat crossed by the road's bridge, a beam on wet piers over a river, a quay and a farm
//                       lot asking farmPond: READY, every check clean of errors and of M25, M20, M10 and M3 findings, a second check
//                       the same answers, IR and artifact. The claim has a river, so the farm lot's pond is not added (S-H-1: dry
//                       claims only) and says so; the dry batch below carries the farm pond with a pond and the moat
//   the farm pond       end to end: a plan whose only H is `farmPond: true` (v49) asks its ponds' volumes through r.fluidBody (each
//                       with the fluid layer), the two-plan flow runs on the farm pond alone (PlanChecks.hasH's trigger) and the
//                       second plan reads them: each pond `given`, guarded
//   the quay's answer   in a second plan holding another part's fluid volumes, a quay with no bank answers NO_ROOM, never an
//                       `unread` incomplete VOLUME
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flatSurvey, stewardAnchors, checkPlanVolumes, FIX } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const RIVER = { W: 256, D: 256, x0: 1000, z0: 2000, bands: [{ x0: 1000, z0: 2030, x1: 1255, z1: 2057, y: 57, water: 6 }] };
const DRY = { W: 256, D: 256, x0: 1000, z0: 2000 };
const ANCHORS = { a: [1180, 65, 2014], b: [1180, 65, 2072], garden: [1215, 65, 2110], tc: [1090, 65, 2170], fc: [1210, 65, 2200] };
const LOTS = [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'cottage', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }];
const town = { id: 'town', where: { near: { anchor: 'tc', within: 24 } }, program: { template: 'flat_village', params: { lots: LOTS } } };
const farms = { id: 'farms', farmPond: true, where: { near: { anchor: 'fc', within: 24 } }, program: { lots: [{ id: 'f1', type: 'farm', size: [13, 11], villager: 'farm' }, { id: 'h4', type: 'house', size: [9, 9] }] } };
const pond = { id: 'pond', kind: 'pond', where: { near: { anchor: 'garden', within: 16 } }, size: { w: 11, d: 9 }, depth: 3 };
const wall = { id: 'town_wall', kind: 'wall', where: { around: { feature: { part: 'town' }, ring: [4, 8] } }, height: 6 };
const moat = { id: 'moat', kind: 'channel', where: { around: { feature: { part: 'town' }, ring: [6, 16] } } };
const road = { id: 'in', kind: 'road', from: { anchor: 'street_e' }, to: { part: 'town' } };
const quay = { id: 'landing', kind: 'quay', where: { along: { feature: { water: {} } } }, length: 12, reach: 3 };
const crossing = { id: 'crossing', kind: 'bridge', from: { anchor: 'a' }, to: { anchor: 'b' }, width: 3 };
const BATCH = { schemaVersion: 'plan/0', planId: 'h_batch', zones: [town, farms], forms: [pond, quay], connectors: [wall, moat, road, crossing] };
const DRY_BATCH = { schemaVersion: 'plan/0', planId: 'h_batch_dry', zones: [town, farms], forms: [pond], connectors: [wall, moat, road] };

const part = (r, id) => r.check.parts.find((a) => a.part === id);
async function run(plan, terrain) {
  const s = flatSurvey(terrain);
  const r = await checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...ANCHORS }, volume: {} });
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded), prefix: false });
  return { r, rep };
}
const clean = (rep, tag) => {
  assert.deepEqual(rep.findings.filter((x) => (x.severity ?? x.level) === 'error').map((x) => `${x.rule} ${x.message}`), [], `${tag}: no error`);
  assert.deepEqual(rep.findings.filter((x) => /^M(25|20|10|3)\b|^M(25|20|10|3):/.test(x.rule)).map((x) => `${x.rule} ${x.message}`), [], `${tag}: M25, M20, M10, M3 clean`);
};

test('the H batch plan: a pond, a moat crossed by the road, a beam on wet piers, a quay and a farm lot: READY, clean, a second check the same', async () => {
  const { r, rep } = await run(BATCH, RIVER);
  assert.equal(r.check.overall, 'READY');
  for (const a of r.check.parts) assert.ok(['fits', 'adjusted'].includes(a.class), `${a.part}: ${a.class} ${JSON.stringify(a.reasons)}`);
  assert.ok(r.first.check.wetAsked || (r.first.res.meta.wet ?? []).length, 'the first plan asked the wet writes\' volumes');
  const m = r.res.meta;
  assert.deepEqual((m.waters ?? []).map((w) => w.kind).sort(), ['moat', 'pond']);
  assert.ok((m.waters ?? []).every((w) => w.volume === 'given'), JSON.stringify(m.waters));
  assert.deepEqual((m.wet ?? []).map((w) => w.kind).sort(), ['pier', 'quay']);
  assert.equal((m.quays ?? []).length, 1);
  const beam = (m.bridges ?? []).find((b) => b.wet);
  assert.ok(beam && beam.form === 'beam' && beam.over === 'water', 'the river crossing stands on wet piers');
  const overMoat = (m.bridges ?? []).find((b) => !b.wet);
  assert.ok(overMoat && overMoat.over === 'water', 'the road crosses the moat on a bridge');
  assert.ok(part(r, 'crossing').notes.some((n) => /wet piers/.test(n)));
  // S-H-1: a claim with surface water gets no farm pond, and the zone says so
  assert.ok(part(r, 'farms').notes.some((n) => /farmPond: the claim has surface water/.test(n)));
  clean(rep, 'batch');
  // a second check: the same answers, IR and artifact
  const { r: r2 } = await run(BATCH, RIVER);
  assert.equal(r2.check.artifactSha, r.check.artifactSha);
  assert.equal(r2.res.irSha, r.res.irSha);
  assert.deepEqual(r2.check.parts, r.check.parts);
});

test('the dry H batch: the farm pond beside a pond and the moat crossed by the road: READY, clean, a second check the same', async () => {
  const { r, rep } = await run(DRY_BATCH, DRY);
  assert.equal(r.check.overall, 'READY');
  for (const a of r.check.parts) assert.ok(['fits', 'adjusted'].includes(a.class), `${a.part}: ${a.class} ${JSON.stringify(a.reasons)}`);
  assert.deepEqual((r.res.meta.waters ?? []).map((w) => w.kind).sort(), ['farm_pond', 'moat', 'pond']);
  assert.ok(part(r, 'farms').notes.some((n) => /farmPond: f1 gets a 3x3 pond/.test(n)));
  clean(rep, 'dry batch');
  const { r: r2 } = await run(DRY_BATCH, DRY);
  assert.equal(r2.check.artifactSha, r.check.artifactSha);
  assert.equal(r2.res.irSha, r.res.irSha);
});

test('the farm pond end to end (v49): its only H is farmPond; the ponds ask their volumes through r.fluidBody; the two-plan flow reads them', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v49_farm_pond.json'), 'utf8'));
  const parts = [...(fx.plan.forms ?? []), ...(fx.plan.connectors ?? [])];
  assert.ok(!parts.some((p) => ['pond', 'fountain', 'waterfall', 'quay', 'channel'].includes(p.kind)), 'no H part kind: farmPond is the trigger');
  const s = flatSurvey();
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
  const asked = r.first.res.needVolumes ?? [];
  const ponds = (r.res.meta.waters ?? []).filter((w) => w.kind === 'farm_pond');
  assert.equal(ponds.length, 2);
  assert.equal(asked.length, ponds.length, 'one volume per farm pond');
  assert.ok(asked.every((b) => b.fluids === true), 'each with the fluid layer (r.fluidBody\'s needVolume)');
  assert.equal(r.volumes.length, asked.length, 'the second plan read them');
  assert.ok(ponds.every((w) => w.volume === 'given'), JSON.stringify(ponds));
  assert.equal(r.check.overall, 'READY');
  const guards = r.artifact?.guards ?? [];
  assert.deepEqual(guards.filter((g) => g.kind === 'body' && g.fluids).map((g) => g.body).sort(), ponds.map((w) => w.id).sort(), 'each pond guarded over its volume');
});

test('a quay with no bank, in a second plan holding another part\'s fluid volumes, answers NO_ROOM (never an unread VOLUME)', async () => {
  // the river's surface 6 under the bank: no quay fits; the beam's wet piers bring the fluid volumes into the second plan
  const terrain = { ...RIVER, bands: [{ ...RIVER.bands[0], y: 52 }] };
  const s = flatSurvey(terrain);
  const r = await checkPlanVolumes({ schemaVersion: 'plan/0', forms: [quay], connectors: [crossing] }, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...ANCHORS }, volume: {} });
  assert.ok(r.volumes.some((v) => v.decoded?.fluids), 'the second plan holds fluid volumes');
  const a = part(r, 'landing');
  assert.deepEqual([a.class, a.reasons[0].code], ['refused', 'NO_ROOM'], JSON.stringify(a.reasons));
  assert.equal(part(r, 'crossing').class, 'fits');
});

// Steward's RC check (0.37.0-rc1): its farm hamlet (a template zone with farmPond: true and lots whose villager use is implied by
// their type, not given) placed no pond and said nothing. The farm lot is found by its implied villager use now, and a zone that
// asks for a farm pond with no farm lot says so in its answer.
const HAMLET = { schemaVersion: 'plan/0', planId: 'farm_hamlet', zones: [{ id: 'town', kind: 'standard', required: true, farmPond: true,
  program: { template: 'flat_village', params: { lots: [{ id: 'farm_1', type: 'farm', role: 'farm', size: [13, 14] }, { id: 'cottage_1', type: 'cottage', role: 'cottage', size: [13, 14] }] } } }] };

test('Steward\'s farm hamlet: a farm lot whose villager use is implied by its type gets its farm pond', async () => {
  const s = flatSurvey();
  const r = await checkPlanVolumes(HAMLET, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
  const ponds = (r.res.meta.waters ?? []).filter((w) => w.kind === 'farm_pond');
  assert.equal(ponds.length, 1, JSON.stringify(r.check.parts?.map((p) => [p.part, p.class, p.notes])));
  assert.equal(r.check.overall, 'READY');
});

test('a zone asking farmPond with no farm lot says so (never silent)', async () => {
  const plan = structuredClone(HAMLET);
  plan.zones[0].program.params.lots = plan.zones[0].program.params.lots.filter((l) => l.type !== 'farm');
  const s = flatSurvey();
  const r = await checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
  assert.equal((r.res.meta.waters ?? []).filter((w) => w.kind === 'farm_pond').length, 0);
  const notes = JSON.stringify(r.check.parts?.find((p) => p.part === 'town')?.notes ?? r.check);
  assert.match(notes, /farmPond: no farm lot/);
});
