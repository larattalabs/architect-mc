// (8c RV-b) Waterfalls off forms (the 8c contract §6, N-8c-3; slice RV-b): form.waterfall `lip: "form"` on a form part (formfall.mjs),
// the header pool in the form's top (op kind header, lip form, on {part}), the curtain clear of the form, the basin a plain HY body (kind
// basin, flow level: only `flow: "current"` is the water model's) 3 deep past a 24 drop; each limit fits at its limit and is refused at
// limit + 1 with a typed reason (drop 48, 4 falls per region, a 5-wide curtain, the basin's depth, 2 off lots); a hidden room behind the
// fall outside the bodies' watch set; the staged island in survival (8a's terrain wait, planned); KC's keep-out with lots on a river's
// line. Fixtures: kit/test/fixtures/river/c05-c09 (the 8c lane's shards).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromRuns } from '../lib/fluids/body.mjs';
import { basinDepthFor, formFallLimits, FORM_FALL } from '../lib/fluids/formfall.mjs';
import { outsideWatch } from '../lib/forms/hiddenRoom.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RV = path.join(HERE, 'fixtures', 'river');
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const fluidOps = (ir) => ir.parts.flatMap((q) => (q.ops ?? []).filter((o) => o.op === 'fluid'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(RV, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

async function planFx(fx, name = 'x', extra = {}) {
  const { planEntry, lintPlanned } = await import('../lint/water.mjs');
  if (extra.survival) {
    const H = await import('./plan-helpers.mjs');
    const s = H.flatSurvey(fx.terrain);
    const r = await H.checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...H.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, volume: fx.volume ?? {}, survival: true });
    return { p: { ir: r.res.ir, answers: r.check.parts } };
  }
  const p = await planEntry({ name: `river/${name}`, kind: 'fixture', fx, dir: 'river' });
  return { p, lint: () => lintPlanned({ ...p, name: `river/${name}` }) };
}
const answerOf = (p, id) => p.answers.find((a) => a.part === id);

test('RV-b c05: a fall off a floating island: header kind header, lip form, on isle; the curtain clear down to a basin 3 deep (a plain HY body); clean, deterministic', async () => {
  const fx = fixture('c05_island_fall.json');
  const { p, lint } = await planFx(fx, 'c05');
  assert.equal(p.overall, 'READY');
  const a = answerOf(p, 'fall');
  assert.equal(a.class, 'fits');
  assert.deepEqual([a.geometry.lip, a.geometry.on, a.geometry.basin, a.geometry.width], ['form', 'isle', 'pond', 3]);
  assert.ok(a.geometry.drop > 24 && a.geometry.drop <= 48, `drop ${a.geometry.drop}`);
  assert.equal(a.geometry.basinDepth, 3, 'past a 24 drop');
  const ops = fluidOps(p.ir);
  const head = ops.find((o) => o.id === 'fall_r1'), basin = ops.find((o) => o.id === 'fall_r2');
  assert.deepEqual([head.kind, head.lip, head.on, head.flow, head.model], ['header', 'form', { part: 'isle' }, undefined, undefined]);
  assert.deepEqual([basin.kind, basin.flow, basin.model], ['basin', 'level', undefined], 'only flow current is the water model (the coordinator\'s mapping)');
  assert.deepEqual(head.after, ['fall_r2'], 'the basin is written (and settles) before the header pool');
  // the curtain: the header's spill falls the whole drop; under each curtain column the basin holds 3 sources
  const spill = fromRuns(head.spill);
  const level = a.geometry.level;
  const cols = new Map();
  for (const q of spill) { const k = `${q[0]},${q[2]}`; cols.set(k, (cols.get(k) ?? 0) + 1); }
  const curtain = [...cols].filter(([, n]) => n >= a.geometry.drop - 1);
  assert.equal(curtain.length, 3, 'a 3-wide curtain');
  const bcells = new Set(fromRuns(basin.cells).map(k3));
  for (const [k] of curtain) { const [x, z] = k.split(',').map(Number); for (let d = 0; d < 3; d++) assert.ok(bcells.has(k3([x, level - a.geometry.drop - d, z])), `basin under ${k} at depth ${d + 1}`); }
  // no island cell in the curtain (the plan's own world)
  const { buildVirtual } = await import('../lib/region/vworld.mjs');
  const { vw } = buildVirtual({ ir: p.ir, survey: p.survey, blobs: (s) => (p.blobs?.get ? p.blobs.get(s) : p.blobs?.[s]) ?? null, volumes: p.volumes });
  for (const q of spill) assert.ok(!vw.pal.solid[vw.get(q[0], q[1], q[2])], `curtain cell ${q} is open`);
  const l = lint();
  assert.deepEqual(l.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
  assert.deepEqual(l.checker.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.message}`), []);
  const again = await planFx(fixture('c05_island_fall.json'), 'c05');
  assert.equal(JSON.stringify(again.p.ir), JSON.stringify(p.ir), 'no clock, no random numbers');
});

test('RV-b hidden room: a form.hidden_room behind a fall off a form lies outside the fall\'s watch set (and a room meeting it is not)', async () => {
  const { p } = await planFx(fixture('c05_island_fall.json'), 'c05');
  assert.equal(answerOf(p, 'grotto').class, 'fits');
  const room = p.ir.parts.find((q) => q.id === 'f_grotto');
  assert.ok(room, 'the hollow part');
  const carved = [];
  for (const o of room.ops) if (o.op === 'columns') for (let i = 0; i < o.cols.length; i += 5) if (o.materials[o.cols[i + 4]] === null) for (let y = o.cols[i + 2]; y <= o.cols[i + 3]; y++) carved.push([o.cols[i], y, o.cols[i + 1]]);
  assert.ok(carved.length >= 27);
  const sets = new Set();
  for (const o of fluidOps(p.ir).filter((q) => q.part === 'fall')) for (const k of ['cells', 'shell', 'spill', 'watch']) for (const c of fromRuns(o[k] ?? [])) sets.add(k3(c));
  for (const o of fluidOps(p.ir).filter((q) => q.part === 'fall')) for (const c of o.predicted ?? []) sets.add(k3(c));
  // (the doorway cells already open in the island's thin rim are air before the carve: the carve opens only rock)
  const { buildVirtual } = await import('../lib/region/vworld.mjs');
  const pre = clone(p.ir);
  pre.parts = pre.parts.filter((q) => !q.id.startsWith('f_grotto'));
  const { vw } = buildVirtual({ ir: pre, survey: p.survey, blobs: (s) => (p.blobs?.get ? p.blobs.get(s) : p.blobs?.[s]) ?? null, volumes: p.volumes });
  const opened = carved.filter((c) => vw.pal.solid[vw.get(c[0], c[1], c[2])]);
  assert.ok(opened.length >= 27);
  assert.equal(outsideWatch(opened, sets), true);
  // the predicate: a room cell in the watch, or beside the header's shell, is inside
  const head = fluidOps(p.ir).find((o) => o.id === 'fall_r1');
  const floor = fromRuns(head.shell).find((c) => c[1] === head.level - 1);
  assert.equal(outsideWatch([[floor[0], floor[1] - 1, floor[2]]], sets), false, 'under the pool\'s floor');
  const w = fromRuns(head.watch)[0] ?? fromRuns(head.spill)[0];
  assert.equal(outsideWatch([w], sets), false);
  assert.ok((p.ir.secrets ?? p.meta?.secrets ?? []).length >= 0);
});

test('RV-b limits: formFallLimits refuses each limit at limit + 1 with a typed reason, and passes it at the limit', () => {
  assert.equal(formFallLimits({ drop: 48, width: 5, falls: 4, basinDepth: 3, lotGap: 3 }), null);
  const at = (o) => formFallLimits(o);
  assert.deepEqual(at({ drop: 49 }).evidence, { limit: 'drop', max: 48, value: 49 });
  assert.equal(at({ drop: 49 }).code, 'LIMIT');
  assert.deepEqual(at({ width: 6 }).evidence, { limit: 'width', max: 5, value: 6 });
  assert.deepEqual(at({ falls: 5 }).evidence, { limit: 'falls', max: 4, value: 5 });
  assert.deepEqual([at({ drop: 25, basinDepth: 2 }).code, at({ drop: 25, basinDepth: 2 }).evidence], ['NO_FEATURE', { limit: 'basinDepth', min: 3, value: 2 }]);
  assert.equal(at({ drop: 24, basinDepth: 2 }), null, 'at 24 a basin 2 deep holds');
  assert.equal(at({ drop: 24, basinDepth: 1 }).evidence.min, 2);
  assert.deepEqual([at({ lotGap: 2 }).code, at({ lotGap: 2 }).evidence], ['KEEP_OUT', { limit: 'lots', min: 3, value: 2 }]);
  assert.equal(basinDepthFor(24), 2);
  assert.equal(basinDepthFor(25), 3);
});

/** A seeded LCG (no clock, no Math.random). */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test('RV-b property: over random falls, formFallLimits refuses exactly past each limit, the first limit past naming it', () => {
  let refused = 0, passed = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const rnd = lcg(seed);
    const o = { drop: 3 + Math.floor(rnd() * 60), width: 1 + Math.floor(rnd() * 7), falls: 1 + Math.floor(rnd() * 7), basinDepth: 1 + Math.floor(rnd() * 4), lotGap: Math.floor(rnd() * 6) };
    const r = formFallLimits(o);
    const past = [];
    if (o.width > FORM_FALL.width) past.push('width');
    if (o.drop > FORM_FALL.drop) past.push('drop');
    if (o.falls > FORM_FALL.perRegion) past.push('falls');
    if (o.basinDepth < (o.drop > FORM_FALL.deepPast ? 3 : 2)) past.push('basinDepth');
    if (o.lotGap <= FORM_FALL.near) past.push('lots');
    if (!past.length) { assert.equal(r, null, `seed ${seed}`); passed++; continue; }
    refused++;
    assert.equal(r.evidence.limit, past[0], `seed ${seed}: ${JSON.stringify(o)}`);
    assert.ok(['LIMIT', 'NO_FEATURE', 'KEEP_OUT'].includes(r.code));
    assert.equal(r.evidence.value, { width: o.width, drop: o.drop, falls: o.falls, basinDepth: o.basinDepth, lots: o.lotGap }[past[0]]);
  }
  assert.ok(refused > 500 && passed > 100, `${refused} refused, ${passed} passed`);
});

test('RV-b drop: an island whose lowest site drops 48 fits; one more over the land (every site 49) is refused LIMIT {drop, max 48, value 49}', async () => {
  const fx = fixture('c06_fall_drop48.json');
  const { p } = await planFx(fx, 'c06');
  const a = answerOf(p, 'fall');
  assert.equal(a.class, 'fits');
  assert.equal(a.geometry.drop, 48);
  assert.equal(a.geometry.basinDepth, 3);
  const up = clone(fx);
  up.plan.forms[0].height += 1;
  const r = answerOf((await planFx(up, 'c06+1')).p, 'fall');
  assert.equal(r.class, 'refused');
  assert.deepEqual([r.reasons[0].code, r.reasons[0].evidence.limit, r.reasons[0].evidence.max, r.reasons[0].evidence.value], ['LIMIT', 'drop', 48, 49]);
  assert.equal(fluidOps((await planFx(up, 'c06+1')).p.ir).length, 0, 'nothing written');
  // the part's own drop caps it lower (at most that)
  const lo = clone(fx);
  lo.plan.forms[1].drop = 40;
  const q = answerOf((await planFx(lo, 'c06d')).p, 'fall');
  assert.equal(q.class, 'refused');
  assert.deepEqual([q.reasons[0].code, q.reasons[0].evidence.limit, q.reasons[0].evidence.max], ['LIMIT', 'drop', 40]);
  assert.ok(q.reasons[0].evidence.value > 40);
});

test('RV-b falls: four falls fit; a fifth (off the island, after four sculpted ones) is refused LIMIT {falls, max 4, value 5}; the sculpted ones are never refused by it', async () => {
  const fx = fixture('c07_five_falls.json');
  const { p, lint } = await planFx(fx, 'c07');
  for (const id of ['sculpt1', 'sculpt2', 'sculpt3', 'sculpt4', 'isle']) assert.equal(answerOf(p, id).class, 'fits', id);
  const a = answerOf(p, 'fall');
  assert.equal(a.class, 'refused');
  assert.deepEqual([a.reasons[0].code, a.reasons[0].evidence], ['LIMIT', { limit: 'falls', max: 4, value: 5 }]);
  assert.ok(!fluidOps(p.ir).some((o) => o.part === 'fall'), 'rolled back whole');
  assert.deepEqual(lint().findings.map((f) => f.rule), []);
  const four = clone(fx);
  four.plan.forms = four.plan.forms.filter((f) => f.id !== 'sculpt4');
  assert.equal(answerOf((await planFx(four, 'c07-1')).p, 'fall').class, 'fits', 'the fourth fall');
});

test('RV-b falls property: whatever the plan order, the first four falls stand and only a fifth off a form is refused', async () => {
  const fx = fixture('c07_five_falls.json');
  for (const seed of [1, 2, 3]) {
    const rnd = lcg(seed);
    const f = clone(fx);
    f.plan.forms = f.plan.forms.map((q) => [rnd(), q]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const { p } = await planFx(f, `c07:${seed}`);
    const falls = ['sculpt1', 'sculpt2', 'sculpt3', 'sculpt4', 'fall'].map((id) => answerOf(p, id));
    assert.equal(falls.filter((x) => x.class === 'fits').length, 4, `seed ${seed}`);
    assert.equal(answerOf(p, 'fall').class, 'refused', 'every sculpted fall counts, wherever it stands');
  }
});

test('RV-b width: the curtain fits 5 wide; 6 is malformed (SCHEMA at $.width), and params.width 6 is not read', async () => {
  const fx = fixture('c05_island_fall.json');
  const v = validatePlan({ schemaVersion: 'plan/0', planId: 't', forms: [{ id: 'isle', kind: 'floating_island', where: { inside: { claim: true } } }, { id: 'fall', kind: 'waterfall', lip: 'form', on: { part: 'isle' }, width: 6 }] });
  const bad = v.parts.find((q) => q.id === 'fall');
  assert.equal(bad.verdict, 'malformed');
  assert.match(JSON.stringify(bad), /width/);
  const five = clone(fx);
  five.plan.forms = five.plan.forms.slice(0, 2);
  five.plan.forms[1].width = 5;
  const a = answerOf((await planFx(five, 'c05w5')).p, 'fall');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.equal(a.geometry.width, 5);
});

test('RV-b basin: a join into water 2 deep under a drop past 24 is refused NO_FEATURE {basinDepth, min 3, value 2}; 3 deep joins', async () => {
  const fx = fixture('c08_fall_join.json');
  const a = answerOf((await planFx(fx, 'c08')).p, 'fall');
  assert.equal(a.class, 'refused');
  assert.deepEqual([a.reasons[0].code, a.reasons[0].evidence.limit, a.reasons[0].evidence.min, a.reasons[0].evidence.value], ['NO_FEATURE', 'basinDepth', 3, 2]);
  const deep = clone(fx);
  deep.terrain.bands[0] = { ...deep.terrain.bands[0], y: 60, water: 3 };
  const { p } = await planFx(deep, 'c08d');
  const b = answerOf(p, 'fall');
  assert.equal(b.class, 'fits');
  assert.equal(b.geometry.basin, 'join');
  assert.equal(fluidOps(p.ir).filter((o) => o.part === 'fall').length, 1, 'the header only: it lands in natural water');
});

test('RV-b hosts: a fall names a BF form of the plan; a hollow mountain\'s and a crater\'s slopes give no clear drop (NO_ROOM with its whys); a lip form waterfall without a host is refused', async () => {
  const fx = fixture('c05_island_fall.json');
  for (const kind of ['hollow_mountain', 'crater']) {
    const f = clone(fx);
    f.plan.forms = [{ id: 'isle', kind, required: true, where: { near: { anchor: 'isle_at', within: 8 } }, size: { preset: 'M' } }, { id: 'fall', kind: 'waterfall', lip: 'form', on: { part: 'isle' } }];
    const a = answerOf((await planFx(f, `host:${kind}`)).p, 'fall');
    assert.equal(a.class, 'refused', kind);
    assert.equal(a.reasons[0].code, 'NO_ROOM');
    assert.ok(a.reasons[0].evidence.whys.edge > 0, kind);
  }
  const none = clone(fx);
  none.plan.forms = [{ id: 'fall', kind: 'waterfall', lip: 'form', on: { part: 'pond1' } }, { id: 'pond1', kind: 'pond', where: { inside: { claim: true } } }];
  const a = answerOf((await planFx(none, 'host:pond')).p, 'fall');
  assert.equal(a.class, 'refused');
  assert.equal(a.reasons[0].code, 'NO_FEATURE');
  // an H waterfall past 24 (the schema now reads 48 for lip form): LIMIT, typed
  const h = clone(fx);
  h.plan.forms = [{ id: 'fall', kind: 'waterfall', lip: 'sculpt', drop: 25, where: { inside: { claim: true } } }];
  const b = answerOf((await planFx(h, 'h25')).p, 'fall');
  assert.deepEqual([b.class, b.reasons[0].code, b.reasons[0].evidence.max], ['refused', 'LIMIT', 24]);
});

test('RV-b survival: the island\'s ops are staged (8a\'s terrain half), the fall\'s fluid ops never are, the header names the island part it waits on (on.part), the fluids stage last', async () => {
  const { p } = await planFx(fixture('c05_island_fall.json'), 'c05s', { survival: true });
  assert.equal(answerOf(p, 'fall').class, 'fits');
  const isl = p.ir.parts.find((q) => q.id === 'f_isle');
  assert.ok(isl.ops.length && isl.ops.every((o) => o.staged === true), 'the island is a staged terrain target');
  const ops = fluidOps(p.ir);
  assert.ok(ops.length === 2 && ops.every((o) => o.staged === undefined));
  const head = ops.find((o) => o.kind === 'header');
  assert.deepEqual(head.on, { part: 'isle' });
  assert.ok(p.ir.requires.includes('stagedTerrain'));
  assert.equal(p.ir.stages.at(-1), 'fluids');
  const stageOf = (id) => p.ir.parts.find((q) => q.id === id).stage;
  assert.ok(p.ir.stages.indexOf(stageOf('f_isle')) < p.ir.stages.indexOf('fluids'));
});

test('RV-b KC c09: lots set on a river\'s line: the river is routed round them, every water set off each lot\'s box and apron, the nearest at most 4 off', async () => {
  const { p, lint } = await planFx(fixture('c09_lots_by_river.json'), 'c09');
  assert.equal(answerOf(p, 'river').class, 'fits');
  assert.equal(answerOf(p, 'hamlet').class, 'fits');
  const lots = p.ir.lots ?? [];
  assert.equal(lots.length, 3);
  // c03's river (straight along z 2030) would run through a lot's apron here: KC's keep-out is what moved the river
  const straight = (await planFx(fixture('c03_river_town.json'), 'c03')).p;
  const c03 = fluidOps(straight.ir).filter((o) => o.part === 'river').flatMap((o) => [...fromRuns(o.cells), ...fromRuns(o.spill)]);
  assert.ok(lots.some((L) => c03.some((q) => q[0] >= L.box.minX - 1 && q[0] <= L.box.maxX + 1 && q[2] >= L.box.minZ - 1 && q[2] <= L.box.maxZ + 1)), 'c03\'s river line meets a lot\'s apron');
  const ops = fluidOps(p.ir).filter((o) => o.part === 'river');
  let near = Infinity;
  for (const o of ops) for (const q of [...fromRuns(o.cells), ...fromRuns(o.shell), ...fromRuns(o.lining ?? []), ...fromRuns(o.spill), ...fromRuns(o.watch), ...(o.predicted ?? [])]) for (const L of lots) {
    const b = L.box;
    assert.ok(!(q[0] >= b.minX - 1 && q[0] <= b.maxX + 1 && q[2] >= b.minZ - 1 && q[2] <= b.maxZ + 1 && q[1] >= b.minY - 1 && q[1] <= b.maxY + 1), `${o.id} ${q} in lot ${L.id}'s box or apron`);
    near = Math.min(near, Math.max(b.minX - q[0], q[0] - b.maxX, b.minZ - q[2], q[2] - b.maxZ, 0));
  }
  assert.ok(near <= 4, `the nearest water ${near} off a lot`);
  assert.deepEqual(lint().findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
});

test('RV-b catalogue: form.waterfall lists lip form\'s limits (drop 48, 4 per region, deep past 24); the def takes lip form, on and a drop to 48', () => {
  const e = planCatalogue().entries.find((q) => q.id === 'form.waterfall');
  assert.deepEqual(e.limits.form, { drop: 48, perRegion: 4, deepPast: 24 });
  const v = (f) => validatePlan({ schemaVersion: 'plan/0', planId: 't', forms: [{ id: 'isle', kind: 'floating_island', where: { inside: { claim: true } } }, { id: 'fall', kind: 'waterfall', ...f }] }).parts.find((q) => q.id === 'fall').verdict;
  assert.equal(v({ lip: 'form', on: { part: 'isle' }, drop: 48 }), 'compile');
  assert.equal(v({ lip: 'form', on: { part: 'isle' }, drop: 49 }), 'malformed');
  assert.equal(v({ lip: 'form', on: { part: 'isle', x: 1 } }), 'malformed');
});
