// Phase 6c slice H, the shared interface H-core freezes for H-a and H-b (docs/CONTRACT.md "Phase 6c slice H" §5, §6, §12, §15): catalogue
// 7 and its diff from T3's, the schema's new defs and R21's path form, the reason codes, the compiler's H hooks (the foundation's stubs
// answer, never throw, and add no stage), the wet fallback hooks, siteplan's waters and quays.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, asksSurvey, checkPlanLocal, flatSurvey, stewardAnchors } from './plan-helpers.mjs';
import { diffCatalogues, planCatalogue, PLAN_API } from '../lib/plan/catalogue.mjs';
import { validatePlan, PLAN_SCHEMA, channelForm } from '../lib/plan/schema.mjs';
import { BODY_FORM_KINDS, H_CONNECTOR_KINDS, H_FORM_KINDS, FLUIDS_STAGE } from '../lib/fluids/kinds.mjs';
import { fluidStageWanted, wetBridgeFallback, wetWallFallback } from '../lib/fluids/hooks.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';

const FIX = path.join(ROOT, 'kit', 'test', 'fixtures', 'plan');

test('catalogue 7: the golden, and the T3 -> H diff is exactly the three flips, the four new ids, the two limits and the two notes', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  assert.equal(golden.catalogueVersion, 7);
  assert.equal(golden.api, PLAN_API);
  const t3 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-t3.json'), 'utf8'));
  assert.equal(t3.catalogueVersion, 6);
  const pending = [{ part: 'waterfall_curtain', block: 'form.waterfall' }, { part: 'moat', block: 'connector.channel' }, { part: 'drawbridge', block: 'connector.drawbridge' }];
  const d = diffCatalogues(t3, golden, { pending });
  assert.deepEqual(d.reservedToSupported, ['connector.channel', 'form.pond', 'form.waterfall']);
  assert.deepEqual(d.added, [{ id: 'channel.course', state: 'reserved' }, { id: 'channel.moat', state: 'supported' }, { id: 'form.fountain', state: 'supported' }, { id: 'form.quay', state: 'supported' }]);
  assert.deepEqual(d.limitsChanged.map((x) => [x.id, x.to.waterDepth]), [['connector.bridge', [0, 16]], ['connector.wall', [0, 8]]]);
  assert.deepEqual(d.notesChanged.map((x) => x.id).sort(), ['bridge.beam', 'connector.tube']);
  assert.deepEqual([d.removed, d.retired, d.otherStateChanges, d.untilChanged], [[], [], [], []]);
  assert.deepEqual(d.schemaVersionBumps.map((x) => x.id), ['connector.channel', 'form.pond', 'form.waterfall'], 'only the flips bump');
  assert.deepEqual(d.recheck, [{ part: 'waterfall_curtain', block: 'form.waterfall' }, { part: 'moat', block: 'connector.channel' }]);
  const e = Object.fromEntries(golden.entries.map((x) => [x.id, x]));
  assert.deepEqual(e['form.pond'].limits, { depth: [1, 6], lavaDepth: [1, 2], area: [4, 1024], fluids: ['water', 'lava'], edges: ['natural', 'built'] });
  assert.deepEqual(e['form.waterfall'].limits, { drop: [3, 24], width: [1, 5], sculpt: 12 });
  assert.deepEqual(e['form.fountain'].limits, { basin: [3, 9], spout: [1, 4] });
  assert.deepEqual(e['form.quay'].limits, { length: [4, 48], reach: [1, 6], waterDepth: [0, 8] });
  assert.deepEqual(e['connector.channel'].limits, { width: [1, 7], depth: [1, 4], forms: ['moat'] });
  assert.equal(e['channel.course'].until, 'HY');
  assert.match(e['connector.channel'].note, /channel\.course.*HY/);
  // the new, flipped and re-limited entries carry the branch's API placeholder (a real semver; the merge restamps it)
  for (const id of ['form.pond', 'form.waterfall', 'form.fountain', 'form.quay', 'connector.channel', 'channel.moat', 'channel.course', 'connector.wall', 'connector.bridge']) assert.equal(e[id].sinceApi, PLAN_API, id);
  // no catalogue entry or note waits for H any more
  for (const x of golden.entries) assert.ok(x.until !== 'H' && !/until H\b/.test(x.note ?? ''), x.id);
  // the reason codes LEAK and FIRE are appended (additive output)
  const codes = PLAN_SCHEMA.$defs.reason.properties.code.enum;
  assert.deepEqual(codes.slice(-2), ['LEAK', 'FIRE']);
});

test('the schema: the H defs, waterDepth, farmPond, R21\'s path form, an odd basin, a lava pit 1..2 deep', () => {
  for (const d of ['form.pond', 'form.fountain', 'form.waterfall', 'form.quay', 'connector.channel']) assert.ok(PLAN_SCHEMA.$defs[d], d);
  assert.deepEqual(PLAN_SCHEMA.$defs['connector.wall'].properties.waterDepth, { type: 'integer', minimum: 0, maximum: 8, description: PLAN_SCHEMA.$defs['connector.wall'].properties.waterDepth.description });
  assert.equal(PLAN_SCHEMA.$defs['connector.bridge'].properties.waterDepth.maximum, 16);
  assert.ok(PLAN_SCHEMA.$defs.lot.properties.farmPond && PLAN_SCHEMA.$defs['zone.standard'].properties.farmPond);
  assert.deepEqual([...BODY_FORM_KINDS, ...H_CONNECTOR_KINDS], ['pond', 'fountain', 'waterfall', 'channel']);
  assert.deepEqual([...H_FORM_KINDS], ['pond', 'fountain', 'waterfall', 'quay']);
  const base = { schemaVersion: 'plan/0', zones: [], connectors: [], forms: [], rules: [] };
  const v = (o) => validatePlan({ ...base, ...o }, { anchors: [] });
  const one = (o) => v(o).parts[0];
  // R21
  const moat = { id: 'moat', kind: 'channel', where: { around: { feature: { part: 'p' } }, ring: [6, 12] } };
  assert.equal(channelForm({ where: {} }), 'moat');
  assert.equal(channelForm({ from: {}, to: {} }), 'course');
  assert.equal(channelForm({ from: {}, where: {} }), null);
  let p = one({ connectors: [{ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' } }] });
  assert.equal(p.verdict, 'unsupported');
  assert.equal(p.block, 'channel.course');
  assert.equal(p.reason.until, 'HY');
  p = one({ connectors: [{ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, where: { around: { feature: { water: {} } } } }] });
  assert.equal(p.verdict, 'malformed');
  assert.match(p.reason.message, /R21/);
  p = one({ connectors: [{ id: 'c', kind: 'channel' }] });
  assert.equal(p.verdict, 'malformed');
  p = one({ connectors: [{ id: 'c', kind: 'channel', where: { around: { feature: { water: {} }, ring: [6, 12], closed: true } }, width: 5, depth: 3 }] });
  assert.equal(p.verdict, 'compile');
  void moat;
  p = one({ forms: [{ id: 'f', kind: 'fountain', basin: 4 }] });
  assert.equal(p.verdict, 'malformed');
  assert.match(p.reason.message, /odd/);
  assert.equal(one({ forms: [{ id: 'f', kind: 'fountain', basin: 5, spout: 2 }] }).verdict, 'compile');
  p = one({ forms: [{ id: 'f', kind: 'pond', fluid: 'lava', depth: 3 }] });
  assert.equal(p.verdict, 'malformed');
  assert.equal(one({ forms: [{ id: 'f', kind: 'pond', fluid: 'lava', depth: 2, edge: 'built' }] }).verdict, 'compile');
  assert.equal(one({ forms: [{ id: 'f', kind: 'waterfall', drop: 6, width: 3, lip: 'auto', basin: 'join' }] }).verdict, 'compile');
  assert.equal(one({ forms: [{ id: 'f', kind: 'quay', length: 12, reach: 3 }] }).verdict, 'compile');
  assert.equal(one({ connectors: [{ id: 'w', kind: 'wall', where: { inside: { claim: true } }, waterDepth: 4 }] }).verdict, 'compile');
  assert.equal(one({ connectors: [{ id: 'w', kind: 'wall', where: { inside: { claim: true } }, waterDepth: 9 }] }).verdict, 'malformed');
});

test('the compiler\'s H hooks: the foundation\'s parts answer refused (until Ha, Hb) and add no fluids stage; the wet fallback offers nothing', async () => {
  const sv = flatSurvey();
  const o = { survey: sv.bytes, claim: sv.claim, anchors: stewardAnchors(sv.claim) };
  const plan = { schemaVersion: 'plan/0', zones: [], connectors: [{ id: 'moat', kind: 'channel', where: { around: { feature: { water: {} } } } }], forms: [{ id: 'pond', kind: 'pond', where: { near: { anchor: 'claim_center' } } }, { id: 'fall', kind: 'waterfall' }, { id: 'jet', kind: 'fountain' }, { id: 'quay', kind: 'quay' }], rules: [] };
  const r = await checkPlanLocal(plan, o);
  const by = Object.fromEntries(r.check.parts.map((a) => [a.part, a]));
  // ((6c H-b) the quay is built: on this dry claim it answers NO_FEATURE (no natural water), never malformed)
  assert.deepEqual([by.quay.class, by.quay.reasons[0].code], ['refused', 'NO_FEATURE']);
  for (const [id, until] of [['moat', 'Ha'], ['pond', 'Ha'], ['fall', 'Ha'], ['jet', 'Ha']]) {
    assert.equal(by[id].class, 'refused', id);
    assert.equal(by[id].reasons[0].code, 'UNREACHABLE', id);
    assert.equal(by[id].reasons[0].until, until, id);
  }
  assert.ok(!r.res.ir.stages.includes(FLUIDS_STAGE), 'no body fits: no fluids stage');
  assert.equal(wetBridgeFallback({}, {}, {}, 'ROUTE_WATER'), null);
  assert.equal(wetWallFallback({}, {}, {}), null);
  assert.equal(fluidStageWanted({ order: [], okClass: () => true }), false);
  // the asks claim's recorded H parts answer the foundation's refusal, not malformed (§13's bar)
  const asks = asksSurvey();
  const r2 = await checkPlanLocal({ ...plan, forms: [], connectors: [plan.connectors[0]] }, { survey: asks.bytes, claim: asks.claim, anchors: stewardAnchors(asks.claim) });
  assert.notEqual(r2.check.parts[0].class, 'malformed');
});

test('siteplan/1: waters and quays (§12)', () => {
  const meta = { format: 1, paths: {}, lots: {}, parts: {}, waters: [{ id: 'pond', part: 'pond', kind: 'pond', fluid: 'water', level: 63, cells: 35, spill: 0, ice: 0 }], quays: [{ id: 'q', part: 'quay', along: [[0, 64, 0], [11, 64, 0]], length: 12, reach: 3, wetCells: 40 }] };
  const ir = { claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 0, maxY: 128 }, stages: ['ground', 'fluids'], lots: [], roads: [], paths: [], anchors: { entrance: [1, 65, 1], spawn: [1, 65, 1] }, parts: [] };
  const sp = sitePlan({ ir, meta, planId: 'p1', irSha: 'x'.repeat(64) });
  assert.deepEqual(sp.waters, [{ id: 'pond', part: 'pond', kind: 'pond', fluid: 'water', level: 63, cells: 35, spill: 0, ice: 0 }]);
  assert.equal(sp.quays[0].wetCells, 40);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, sp), []);
});
