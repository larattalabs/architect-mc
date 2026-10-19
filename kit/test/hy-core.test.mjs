// Phase 6c slice HY-core (docs/CONTRACT.md "Phase 6c slice HY" §1-§4, §6, §9, §12, §14 items 2, 12, 13, §15 step 1): catalogue 8 and its
// diff from catalogue 7 (catalogue-h.json), R24's path forms, the course members of the fluid op (requires courses; an H op unchanged),
// the overflow hook and the emit order, and hy_core_demo through the two-plan flow: M25 clean, the write order downstream first, and each
// broken variant caught by its rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, checkPlanLocal, flatSurvey, stewardAnchors } from './plan-helpers.mjs';
import { diffCatalogues, planCatalogue, PLAN_API } from '../lib/plan/catalogue.mjs';
import { validatePlan, channelForm, channelBlock } from '../lib/plan/schema.mjs';
import { emitOrder, dropOverflows, overflowsOn, registerOverflow, crossingsOf, registerCrossing } from '../lib/fluids/hooks.mjs';
import { isCourseOp, reachId, splitJoins } from '../lib/fluids/body.mjs';
import { walkKinds, staleReason, KINDS_FORMAT2 } from '../lib/realise.mjs';
import { writeOrder } from '../lib/region/checkFluids.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { planHy, checkHy } from './hy-helpers.mjs';

const FIX = path.join(ROOT, 'kit', 'test', 'fixtures', 'plan');

test('catalogue 8: the golden; the H -> HY diff is exactly the one flip, the four new ids, connector.channel\'s limits and five notes', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  assert.equal(golden.catalogueVersion, 8);
  assert.equal(golden.api, PLAN_API);
  const h = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-h.json'), 'utf8'));
  assert.equal(h.catalogueVersion, 7);
  const d = diffCatalogues(h, golden, { pending: [{ part: 'canal', block: 'channel.course' }] });
  assert.deepEqual(d.reservedToSupported, ['channel.course']);
  assert.deepEqual(d.added, [{ id: 'channel.aqueduct', state: 'reserved' }, { id: 'channel.ditch', state: 'supported' }, { id: 'channel.race', state: 'supported' }, { id: 'wall.water_gate', state: 'supported' }]);
  assert.deepEqual(d.limitsChanged.map((x) => [x.id, x.to.forms]), [['connector.channel', ['moat', 'course', 'race', 'ditch']]]);
  assert.deepEqual(d.notesChanged.map((x) => x.id).sort(), ['channel.moat', 'connector.channel', 'connector.wall', 'form.fountain', 'form.pond']);
  assert.deepEqual([d.removed, d.retired, d.otherStateChanges, d.untilChanged], [[], [], [], []]);
  assert.deepEqual(d.schemaVersionBumps.map((x) => x.id), ['channel.course'], 'only the flip bumps');
  assert.deepEqual(d.recheck, [{ part: 'canal', block: 'channel.course' }]);
  const e = Object.fromEntries(golden.entries.map((x) => [x.id, x]));
  assert.deepEqual(e['channel.course'].limits, { width: [1, 5], depth: [1, 3], length: [4, 512], drop: [1, 8], riffle: [2, 6], cut: [0, 6], fill: [0, 2], flows: ['level', 'pools', 'riffles'], looks: ['natural', 'built'] });
  assert.deepEqual(e['channel.ditch'].limits, { width: [1, 1], depth: [1, 1], length: [3, 64] });
  assert.deepEqual([e['channel.aqueduct'].state, e['channel.aqueduct'].until], ['reserved', '7c']);
  for (const id of ['channel.course', 'channel.race', 'channel.ditch', 'wall.water_gate', 'channel.aqueduct', 'connector.channel']) assert.equal(e[id].sinceApi, PLAN_API, id);
  // nothing waits for HY any more (§14 item 12's search over the catalogue: the archived ones aside)
  for (const x of golden.entries) assert.ok(x.until !== 'HY' && !/until HY\b/.test(x.note ?? ''), x.id);
  assert.ok(!/"until":\s*"HY"/.test(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8')));
});

test('R24: a channel\'s path forms (moat, course, race with a lot in via, ditch); none or two malformed; the course members validate', () => {
  assert.equal(channelForm({ where: { around: {} } }), 'moat');
  assert.equal(channelForm({ where: { along: {} } }), 'ditch');
  assert.equal(channelForm({ from: {}, to: {} }), 'course');
  assert.equal(channelForm({ from: {}, to: {}, where: { along: {} } }), null);
  assert.equal(channelForm({ where: { around: {}, along: {} } }), null);
  assert.equal(channelBlock({ from: { anchor: 'a' }, via: [{ part: 'mill' }], to: { anchor: 'b' } }, ['mill']), 'channel.race');
  assert.equal(channelBlock({ from: { anchor: 'a' }, via: [{ part: 'pond' }], to: { anchor: 'b' } }, ['mill']), 'channel.course');
  const base = { schemaVersion: 'plan/0', zones: [], connectors: [], forms: [], rules: [] };
  const one = (c) => validatePlan({ ...base, connectors: [c] }, { anchors: ['claim_n', 'claim_s'] }).parts[0];
  assert.equal(one({ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, look: 'natural', flow: 'riffles', drop: 4, width: 2, depth: 2 }).verdict, 'compile');
  assert.equal(one({ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, drop: 9 }).verdict, 'malformed');
  assert.equal(one({ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, flow: 'rapids' }).verdict, 'malformed');
  const two = one({ id: 'c', kind: 'channel', from: { anchor: 'claim_n' }, to: { anchor: 'claim_s' }, where: { along: { feature: { part: 'p' } } } });
  assert.equal(two.verdict, 'malformed');
  assert.match(two.reason.message, /R24/);
});

test('the stubs: a course, race or ditch answers refused UNREACHABLE until HYb, never throws; h/r08 too; r.course lays nothing', async () => {
  const sv = flatSurvey();
  const o = { survey: sv.bytes, claim: sv.claim, anchors: stewardAnchors(sv.claim) };
  const plan = { schemaVersion: 'plan/0', zones: [], forms: [], rules: [], connectors: [{ id: 'canal', kind: 'channel', from: { anchor: 'street_w' }, to: { anchor: 'street_e' } }] };
  const r = await checkPlanLocal(plan, o);
  const a = r.check.parts[0];
  assert.deepEqual([a.class, a.reasons[0].code, a.reasons[0].until], ['refused', 'UNREACHABLE', 'HYb']);
  assert.ok(Object.keys(a.reasons[0].evidence).length);
  const r08 = JSON.parse(fs.readFileSync(path.join(FIX, 'h', 'r08_course.json'), 'utf8'));
  assert.deepEqual([r08.expect.class, r08.expect.code, r08.expect.until], ['refused', 'UNREACHABLE', 'HYb']);
  const { course } = await import('../lib/fluids/course.mjs');
  const rec = course({}, [[0, 0], [5, 0]], { id: 'c' });
  assert.deepEqual([rec.bodies, rec.refused.until], [[], 'HYb']);
});

test('the fluid op\'s course members: requires courses only with one; joins split; reachId; the write order', () => {
  const h = { op: 'fluid', joins: [[1, 2, 3, 4]] };
  assert.equal(isCourseOp(h), false);
  assert.equal(isCourseOp({ op: 'fluid', joins: [{ body: 'x', cells: [] }] }), true);
  assert.equal(isCourseOp({ op: 'fluid', lining: [[0, 0, 1, 1]] }), true);
  assert.deepEqual(splitJoins([[1, 2, 3, 4], { body: 'b', cells: [[0, 0, 5, 5]] }]), { natural: [[1, 2, 3, 4]], plan: [{ body: 'b', cells: [[0, 0, 5, 5]] }] });
  const ir = (o) => ({ parts: [{ id: 'p', ops: [o] }] });
  assert.ok(!walkKinds(ir(h)).includes('courses'));
  assert.ok(walkKinds(ir({ op: 'fluid', after: ['x'] })).includes('courses'));
  assert.equal(KINDS_FORMAT2.at(-1), 'courses');
  assert.equal(staleReason({ format: 2, requires: ['fluid', 'courses'] }), null, 'this kit reads it');
  assert.match(staleReason({ format: 2, requires: ['fluid', 'courses-v2'] }) ?? '', /courses-v2/, 'an unknown kind is refused');
  assert.equal(reachId('stream', 3), 'stream_r3');
  assert.equal(reachId('x'.repeat(60), 1).length, 48);
  const w = writeOrder([{ id: 'r1', after: ['r2'] }, { id: 'r2', after: ['r3'] }, { id: 'r3', after: [] }, { id: 'feed', after: ['r1'] }]);
  assert.deepEqual([w.order, w.cycle, w.unknown], [['r3', 'r2', 'r1', 'feed'], null, []]);
  const c = writeOrder([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a', 'zz'] }]);
  assert.deepEqual([c.order, c.cycle, c.unknown], [['a', 'b'], ['a', 'b'], [['b', 'zz']]]);
});

test('the overflow hook: registered on a part that accepts it, read by its generator, dropped with the course; the emit order', () => {
  const parts = [{ id: 'pond', family: 'form', kind: 'pond', part: {} }, { id: 'stream', family: 'connector', kind: 'channel', part: { from: { part: 'pond' }, to: { anchor: 'a' } } }, { id: 'tower', family: 'form', kind: 'tower', part: {} }];
  const C = { plan: { zones: [] }, byId: new Map(parts.map((p) => [p.id, p])), overflows: [] };
  assert.equal(registerOverflow(C, { from: 'pond', course: 'stream', cells: [[0, 1, 0]], lining: [], into: { body: 'stream_r1', cells: [[0, 0, 2]] } }), false, 'H-a\'s pond does not accept an overflow until HY-b says so');
  assert.equal(registerOverflow(C, { from: 'stream', course: 'other', cells: [], into: { body: 'other_r1', cells: [] } }), true, 'a course accepts one (a branch)');
  assert.equal(registerOverflow(C, { from: 'tower', course: 'stream', into: { body: 'stream_r1' } }), false, 'no H part: a dry end');
  assert.deepEqual(overflowsOn(C, 'stream').map((o) => o.course), ['other']);
  const order = emitOrder([parts[1], { id: 'other' }], C.overflows);
  assert.deepEqual(order.map((p) => p.id), ['other', 'stream'], 'the feeder emits after the course it feeds');
  assert.deepEqual(emitOrder(parts, []), parts, 'no overflow: plan order');
  assert.equal(dropOverflows(C.overflows, 'other'), 1);
  assert.equal(C.overflows.length, 0);
  const K = {};
  registerCrossing(K, { course: 'stream', body: 'stream_r2', wall: 'w', cells: [[1, 2]], level: 64, lintel: 65, grate: [[1, 64, 2]] });
  assert.equal(crossingsOf(K).length, 1);
  assert.deepEqual(crossingsOf({}), []);
});

test('hy_core_demo through the two-plan flow: the reaches, the feed, downstream first; M25 clean; per-body volumes; siteplan courses', async () => {
  const p = await planHy();
  assert.ok(p.first.needVolumes.length >= 4 && p.first.needVolumes.every((b) => b.fluids === true));
  assert.deepEqual(p.meta.planCheck.answers.map((a) => [a.part, a.class]), [['feed', 'fits'], ['stream', 'fits']]);
  assert.ok(p.ir.requires.includes('courses'));
  const ops = p.ir.parts.flatMap((q) => q.ops.filter((o) => o.op === 'fluid'));
  assert.deepEqual(ops.map((o) => [o.id, o.part, o.after ?? []]), [['stream_r3', 'stream', []], ['stream_r2', 'stream', ['stream_r3']], ['stream_r1', 'stream', ['stream_r2']], ['w_feed', 'feed', ['stream_r1']]]);
  const r1 = ops.find((o) => o.id === 'stream_r1');
  assert.deepEqual(r1.joins.map((j) => (Array.isArray(j) ? 'natural' : j.body)), ['stream_r2']);
  assert.ok(r1.lining.length >= 2, 'the lip lining and the weir course');
  assert.equal(r1.predicted.length, 12, 'the lip (3) and the column (9), at their levels');
  const rep = checkHy(p);
  const bad = rep.findings.filter((f) => /^M(25|20)/.test(f.rule) || f.severity === 'error');
  assert.deepEqual(bad.map((f) => `${f.rule} ${f.message}`), []);
  // per body guards, flat (H RC3), one per reach and the feed
  const g = p.meta.planCheck.links?.guards ?? [];
  const gb = g.filter((x) => x.kind === 'body');
  assert.deepEqual(gb.map((x) => x.body).sort(), ['stream_r1', 'stream_r2', 'stream_r3', 'w_feed']);
  assert.ok(gb.every((x) => x.runs.every((v) => Number.isInteger(v))), 'flat runs');
  const sp = sitePlan({ ir: p.ir, meta: p.meta, planId: 'p', irSha: 'x'.repeat(64) });
  assert.deepEqual(sp.courses.map((c) => [c.id, c.bodies, c.steps.map((s) => s.kind)]), [['stream', ['stream_r1', 'stream_r2', 'stream_r3'], ['fall', 'spillway']]]);
  assert.deepEqual(sp.waters.map((w) => w.kind), ['course', 'course', 'course', 'pond']);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, sp), []);
  const again = await planHy();
  assert.equal(again.irSha, p.irSha, 'deterministic');
});

test('the broken variants (§14): each caught by its rule, naming its cells; flowing_state refused by the lint', async () => {
  const want = { predict_short: ['M25:leak'], no_lining_cell: ['M25:shell', 'M25:leak'], sand_lining: ['M25:shell'], thin_weir: ['M25:shell', 'M25:keep'], wrong_order: ['M25:order'] };
  for (const [variant, rules] of Object.entries(want)) {
    const rep = checkHy(await planHy({ variant }));
    for (const rule of rules) {
      const f = rep.findings.find((x) => x.rule === rule);
      assert.ok(f && f.severity === 'error', `${variant}: ${rule} (${rep.findings.map((x) => `${x.rule} ${x.message}`).join('; ')})`);
    }
  }
  const tw = checkHy(await planHy({ variant: 'thin_weir' }));
  assert.ok(tw.findings.some((f) => f.rule === 'M25:shell' && /weir 1 thick/.test(f.message)));
  const wo = checkHy(await planHy({ variant: 'wrong_order' }));
  assert.ok(wo.findings.some((f) => f.rule === 'M25:order' && /stream_r1: its spill lands in stream_r2/.test(f.message)));
  await assert.rejects(() => planHy({ variant: 'flowing_state' }), /FLUID_STATE/);
});
