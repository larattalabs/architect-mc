// (6c HY-b) Courses (docs/CONTRACT.md "Phase 6c slice HY" §7, §14 items 2, 12, 13): the profile, the refusal fixtures (fixtures/plan/hy/:
// each answers its code and evidence kind, a wouldFit re-checked alone fits), and the HY valid fixtures M25-clean in the checker with their
// siteplan `courses` rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { profileOf } from '../lib/fluids/profile.mjs';
import { fourConnected, laneOffsets } from '../lib/fluids/course.mjs';
import { read, run, svOf } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { FIX } from './plan-helpers.mjs';

const col = (level, g = level + 1, straight = true) => ({ g, top: g, level, straight });

test('profile: runs into reaches, short runs merged downward, steps by drop', () => {
  // 6 at 70, 2 at 68 (short: merged into the run below), 6 at 66
  const cols = [...Array(6).fill(70), 68, 68, ...Array(6).fill(66)].map((l) => col(l, 72));
  const p = profileOf(cols, { minReach: 4 });
  assert.deepEqual(p.reaches.map((r) => [r.i0, r.i1, r.level]), [[0, 5, 70], [6, 13, 66]]);
  assert.deepEqual(p.steps.map((s) => [s.kind, s.k, s.drop, s.i0]), [['fall', 1, 4, 5]]);
  // a spillway for 1
  const q = profileOf([...Array(6).fill(70), ...Array(6).fill(69)].map((l) => col(l, 72)), {});
  assert.deepEqual(q.steps.map((s) => [s.kind, s.drop]), [['spillway', 1]]);
});

test('profile: a drop past `drop` becomes falls with a reach between them; the cut is judged', () => {
  const cols = [...Array(12).fill(80), ...Array(8).fill(70)].map((l) => col(l, 81));
  const p = profileOf(cols, { drop: 6, cut: 20 });
  assert.ok(p.steps.every((s) => s.drop <= 6), JSON.stringify(p.steps));
  assert.equal(p.steps.reduce((a, s) => a + s.drop, 0), 10);
  const c = profileOf(cols, { drop: 6, cut: 2 });
  assert.equal(c.refused?.evidence?.kind, 'cut');
});

test('profile: riffles under flow riffles, at most 3 drops and 16 cells, the bed stepping 1 every seg', () => {
  const cols = [...Array(20).fill(70), ...Array(8).fill(67)].map((l) => col(l, 71));
  const p = profileOf(cols, { flow: 'riffles', riffle: 4 });
  const r = p.steps.find((s) => s.kind === 'riffle');
  assert.ok(r, JSON.stringify(p.steps));
  assert.equal(r.drop, 3);
  assert.ok(r.i1 - r.i0 + 1 <= 16);
  assert.deepEqual([...new Set(r.levels)], [70, 69, 68]);
  // pools by default: a fall
  assert.equal(profileOf(cols, {}).steps[0].kind, 'fall');
});

test('lanes and paths: centred lanes, 4-connected polylines', () => {
  assert.deepEqual(laneOffsets(1), [0]);
  assert.deepEqual(laneOffsets(2), [0, 1]);
  assert.deepEqual(laneOffsets(3), [-1, 0, 1]);
  assert.deepEqual(fourConnected([[0, 0], [2, 1]]), [[0, 0], [1, 0], [2, 0], [2, 1]]);
});

const HY = read('hy');

test('item 12: every HY refusal fixture answers its code and evidence kind; a wouldFit, re-checked alone, fits', async () => {
  assert.ok(HY.length >= 11, `${HY.length} refusal fixtures`);
  for (const f of HY) {
    const r = await run(f);
    const a = r.check.parts.find((p) => p.part === f.expect.part);
    assert.ok(a, `${f.name}: no answer for ${f.expect.part}`);
    assert.equal(a.class, f.expect.class ?? a.class, `${f.name}: ${a.class} ${JSON.stringify(a.reasons)}`);
    if (['fits', 'adjusted'].includes(f.expect.class)) {
      // (a road crossing a course or a moat on T3's bridge fallback, clearance 1 over plan water, N-H-5)
      assert.equal(r.check.overall, 'READY', `${f.name}: ${JSON.stringify(r.check.parts.map((p) => [p.part, p.class]))}`);
      const crossings = JSON.stringify(a.geometry ?? {}).match(/"crossing":\{[^}]*\}/g) ?? [];
      if (f.expect.crossing) assert.ok(crossings.some((c) => /"over":"water"/.test(c) && /"clearance":1/.test(c)), `${f.name}: ${crossings.join(' ')}`);
      continue;
    }
    assert.equal(a.reasons?.[0]?.code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    if (f.expect.kind) assert.equal(a.reasons[0].evidence?.kind, f.expect.kind, `${f.name}: ${JSON.stringify(a.reasons[0])}`);
    if (f.expect.why) assert.equal(a.reasons[0].evidence?.why, f.expect.why, `${f.name}: ${JSON.stringify(a.reasons[0])}`);
    if (f.expect.until) assert.equal(a.reasons[0].until ?? a.reasons[0].evidence?.until, f.expect.until, f.name);
    if (f.expect.wouldFit) {
      assert.ok(a.wouldFit?.length, `${f.name}: a wouldFit`);
      const plan = JSON.parse(JSON.stringify(f.plan));
      for (const fam of ['zones', 'forms', 'connectors']) plan[fam] = (plan[fam] ?? []).map((p) => (p.id === f.expect.part ? { ...a.wouldFit[0].fragment, id: p.id } : p));
      const again = await run({ ...f, plan });
      const b = again.check.parts.find((p) => p.part === f.expect.part);
      assert.ok(['fits', 'adjusted'].includes(b.class), `${f.name}: the wouldFit alone answers ${b.class} ${JSON.stringify(b.reasons)}`);
    }
  }
});

test('item 2: every HY valid fixture fits, its plan M25-clean in the checker, one siteplan courses row per course part', async () => {
  // (the HY valid fixtures: v50..v69 with a channel part; VOC's v50_voc_village and v51_voc_forge share the numbers, not the kind)
  const hy = [...read('valid').filter((f) => /^v[56][0-9]_/.test(f.name) && (f.plan.connectors ?? []).some((c) => c.kind === 'channel')), ...HY.filter((f) => ['fits', 'adjusted'].includes(f.expect?.class))];
  assert.ok(hy.length >= 6, hy.map((f) => f.name).join(', '));
  for (const f of hy) {
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${JSON.stringify(r.check.parts.map((p) => [p.part, p.class, p.reasons]))}`);
    const ir = JSON.parse(r.res.irJson);
    const rep = checkRegion({ ir, survey: svOf(f).bytes, blobs: r.res.blobs, volumes: (r.volumes ?? []).map((v) => v.decoded), meta: r.res.meta });
    const bad = (rep.findings ?? []).filter((x) => /^M25/.test(x.rule));
    assert.deepEqual(bad.map((x) => [x.rule, x.part, x.message]), [], f.name);
    const courses = r.res.meta.courses ?? [];
    const parts = f.plan.connectors.filter((c) => c.kind === 'channel' && !c.where?.around);
    assert.equal(courses.length, parts.length, `${f.name}: ${JSON.stringify(courses)}`);
    for (const c of courses) {
      assert.ok(['course', 'race', 'ditch'].includes(c.kind) && ['natural', 'built'].includes(c.look) && ['level', 'pools', 'riffles'].includes(c.flow), JSON.stringify(c));
      assert.ok(c.bodies.length >= 1 && c.ends.length === 2 && c.ends.every((e) => ['spring', 'pool', 'weir', 'join', 'overflow', 'rim'].includes(e.kind)), JSON.stringify(c));
      for (const s of c.steps) assert.ok(['fall', 'spillway', 'riffle'].includes(s.kind) && s.drop >= 1, JSON.stringify(s));
    }
  }
});

test('item 12: no answer carries until HY; the pending placeholder is gone once the valid fixtures landed', () => {
  assert.equal(fs.existsSync(path.join(FIX, 'hy-pending-b.json')), false);
  assert.equal(fs.existsSync(path.join(FIX, 'h', 'r08_course.json')), false, 'r08 is valid/v51_canal now');
});

test('hydro_demo (r.course over sculpted terraces): a brook through two falls and two riffles and a built canal, M25-clean, the same IR twice', async () => {
  const { planTwice } = await import('./h-helpers.mjs');
  const { flatSurvey } = await import('./plan-helpers.mjs');
  const demo = await import('../regions/hydro_demo.mjs');
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'regions', 'hydro_demo.mjs'), 'utf8');
  const sv = flatSurvey();
  const plan = () => planTwice({ program: demo, programSource: src, params: {}, survey: sv.bytes, seed: '7', claim: sv.claim, node: 'test' });
  const [a, b] = [await plan(), await plan()];
  assert.equal(a.irJson, b.irJson, 'the same IR');
  const brook = a.meta.courses.find((c) => c.id === 'brook');
  assert.deepEqual(brook.steps.map((s) => s.kind), ['fall', 'fall', 'riffle', 'riffle']);
  assert.equal(a.meta.courses.find((c) => c.id === 'canal').look, 'built');
  const rep = checkRegion({ ir: a.ir, survey: sv.bytes, blobs: a.blobs, volumes: a.volumes.map((v) => v.decoded), meta: a.meta });
  assert.deepEqual((rep.findings ?? []).filter((x) => /^M25/.test(x.rule)).map((x) => [x.rule, x.part, x.message]), []);
});
