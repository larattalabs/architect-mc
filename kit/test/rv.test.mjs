// (8c RV) The planner's rivers (the 8c contract §2.6, §5; slice RV): connector.channel `flow: "current"` (currentProfile: few source
// reaches joined by currents of runs of at most 6 cells, each ending in a 1-block step), its current reaches simulated by the water
// model (op model wm, 8cF's members flow current and kind river), conversions lifted into written sources, the wash clears, VOLUME
// {why: levels} over a version-3 volume, the region's 8 river bodies (UNSETTLED with its say and the pools course as its wouldFit), a
// river through a settlement (lots keep off its cells, spill and breach; the road bridges it; no water past the claim). Every other
// course is planned as before (the corpus shards and the byte-identity check cover that).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentProfile, profileOf, CURRENT_RUN } from '../lib/fluids/profile.mjs';
import { fromRuns } from '../lib/fluids/body.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { fillMissing } from '../lib/region/plan.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RV = path.join(HERE, 'fixtures', 'river');
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const fluidOps = (ir) => ir.parts.flatMap((q) => (q.ops ?? []).filter((o) => o.op === 'fluid'));

async function plan(name) {
  const { planEntry, lintPlanned } = await import('../lint/water.mjs');
  const fx = JSON.parse(fs.readFileSync(path.join(RV, name), 'utf8'));
  const p = await planEntry({ name: `river/${name}`, kind: 'fixture', fx, dir: 'river' });
  return { p, fx, lint: () => lintPlanned({ ...p, name: `river/${name}` }) };
}

/** Terraces: the router's level for a path over ground stepping down 1 every `every` cells after `flat` cells at `g`. */
function terraces({ n = 140, g = 74, flat = 20, every = 10, low = 65 } = {}) {
  const cols = [];
  for (let i = 0; i < n; i++) { const gg = i < flat ? g : Math.max(low, g - 1 - Math.floor((i - flat) / every)); cols.push({ g: gg, top: gg, level: gg - 1, straight: true }); }
  return cols;
}

test('RV profile: a current follows the ground down in runs of at most 6, from few source reaches; a path it cannot lay is pools', () => {
  const cols = terraces();
  const pr = currentProfile(cols, { minReach: 4, drop: 6, cut: 6 });
  assert.equal(pr.fallback, undefined);
  assert.ok(pr.reaches.length <= 4, `${pr.reaches.length} reaches (pools: ${profileOf(cols, { flow: 'pools' }).reaches.length})`);
  assert.ok(profileOf(cols, { flow: 'pools' }).reaches.length >= 9);
  assert.ok(pr.steps.length >= 2 && pr.steps.every((s) => s.kind === 'current' && s.seg === CURRENT_RUN));
  for (const st of pr.steps) {
    const runs = new Map();
    st.levels.forEach((l) => runs.set(l, (runs.get(l) ?? 0) + 1));
    assert.ok([...runs.values()].every((n) => n <= CURRENT_RUN), 'each run at most 6 cells');
    for (let i = 1; i < st.levels.length; i++) assert.ok(st.levels[i] === st.levels[i - 1] || st.levels[i] === st.levels[i - 1] - 1, '1-block steps');
    const up = pr.reaches.find((r) => r.k === st.k);
    assert.ok(st.i0 - up.i0 >= 4, 'the upper reach keeps 4 source cells');
    assert.ok(st.levels.every((l, j) => l <= cols[st.i0 + j].level), 'never over the ground the router allows');
  }
  assert.ok(pr.cut <= 6);
  // the same entry point: profileOf(flow current) is currentProfile
  assert.deepEqual(profileOf(cols, { flow: 'current' }), pr);
  // a cliff past the drop: the pools profile
  const cliff = [...terraces({ n: 30, flat: 30 }), ...terraces({ n: 30, g: 60, flat: 30 })];
  assert.equal(currentProfile(cliff, { minReach: 4, drop: 6, cut: 6 }).fallback, 'pools');
  // a winding path: no current where it turns (a turn ends the current: a fall or spillway instead, or pools)
  const bent = terraces().map((c, i) => ({ ...c, straight: i % 5 !== 0 }));
  const pb = currentProfile(bent, { minReach: 4, drop: 6, cut: 6 });
  assert.ok(pb.fallback === 'pools' || pb.steps.every((s) => s.levels.length >= 2));
});

test('RV c01: a river down a stepped meadow: its current reaches are wm bodies (flow current, kind river), clean, inside the claim, deterministic', async () => {
  const { p, fx, lint } = await plan('c01_river.json');
  assert.equal(p.overall, 'READY');
  const a = p.answers.find((q) => q.part === 'river');
  assert.equal(a.class, 'fits');
  assert.equal(a.geometry.flow, 'current');
  assert.ok(a.geometry.steps.length >= 2 && a.geometry.steps.every((s) => s.kind === 'current'), JSON.stringify(a.geometry.steps));
  const ops = fluidOps(p.ir);
  const cur = ops.filter((o) => o.flow === 'current');
  assert.ok(cur.length >= 2 && cur.length <= 4, `${cur.length} current reaches`);
  for (const o of cur) {
    assert.deepEqual([o.model, o.kind], ['wm', 'river']);
    assert.ok(o.predicted.length > 0 && o.predicted.every((q) => q[3] >= 1 && q[3] <= 8));
    assert.match(o.id, /^river_r\d+$/);
  }
  const tail = ops.find((o) => !cur.includes(o));
  assert.equal(tail.model, undefined, 'the terminal pool is a plain reach');
  assert.equal(tail.flow, undefined);
  // the claim boundary (M25:keep, N-8c-1): no cell, spill, watch or predicted cell on or past the claim's outer ring
  const t = fx.terrain, c = { minX: t.x0, maxX: t.x0 + t.W - 1, minZ: t.z0, maxZ: t.z0 + t.D - 1 };
  for (const o of ops) for (const q of [...fromRuns(o.cells), ...fromRuns(o.spill), ...fromRuns(o.watch), ...o.predicted]) assert.ok(q[0] > c.minX && q[0] < c.maxX && q[2] > c.minZ && q[2] < c.maxZ, `${o.id} ${q}`);
  const l = lint();
  assert.deepEqual(l.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
  assert.deepEqual(l.checker.filter((f) => f.severity === 'error').map((f) => f.rule), []);
  assert.ok(l.breaches.segments > 0);
  const again = await plan('c01_river.json');
  assert.equal(JSON.stringify(again.p.ir), JSON.stringify(p.ir), 'no clock, no random numbers');
});

test('RV c02: a river over volumes without levels (ARVX version 3) is refused VOLUME {why: levels}', async () => {
  const { p } = await plan('c02_levels_v3.json');
  const a = p.answers.find((q) => q.part === 'river');
  assert.equal(a.class, 'refused');
  assert.equal(a.reasons[0].code, 'VOLUME');
  assert.deepEqual([a.reasons[0].evidence.why, a.reasons[0].evidence.version], ['levels', 3]);
});

test('RV c03: a river through a settlement: lots off its cells, spill and breach (KC keep-out); the road bridges it; nothing solid in a predicted cell', async () => {
  const { p, lint } = await plan('c03_river_town.json');
  assert.equal(p.overall, 'READY');
  assert.equal(p.answers.find((q) => q.part === 'river').class, 'fits');
  assert.equal(p.answers.find((q) => q.part === 'hamlet').class, 'fits');
  const road = p.answers.find((q) => q.part === 'road');
  assert.equal(road.class, 'adjusted', 'over plan water on the bridge fallback');
  assert.ok((JSON.stringify(road.geometry ?? {}).match(/"crossing":\{[^}]*\}/g) ?? []).some((q) => /"over":"water"/.test(q) && /"clearance":1/.test(q)));
  const ops = fluidOps(p.ir).filter((o) => o.part === 'river');
  assert.ok(ops.some((o) => o.model === 'wm'));
  const lots = p.ir.lots ?? [];
  assert.equal(lots.length, 3);
  // the river's hard cells (cells, shell, lining, spill, joins), its watch (the W3 breach per bank segment) and its predicted cells: none in
  // or beside a lot's box (M25:keep's lot rule; KC's registry holds them, so no basin or spill lands on a module lot)
  for (const o of ops) {
    const all = [...fromRuns(o.cells), ...fromRuns(o.shell), ...fromRuns(o.lining ?? []), ...fromRuns(o.spill), ...fromRuns(o.watch), ...o.predicted];
    for (const L of lots) { const b = L.box; for (const q of all) assert.ok(!(q[0] >= b.minX - 1 && q[0] <= b.maxX + 1 && q[2] >= b.minZ - 1 && q[2] <= b.maxZ + 1 && q[1] >= b.minY - 1 && q[1] <= b.maxY + 1), `${o.id} ${q} in lot ${L.id}`); }
  }
  // the bridge's deck and piers: never in a predicted flowing cell (a pier stands in a source reach, a beam spans the current)
  const { vw } = buildVirtual({ ir: p.ir, survey: p.survey, filled: fillMissing(p.survey).columns, blobs: (s) => p.blobs?.[s] ?? null, volumes: p.volumes });
  for (const o of ops) for (const q of o.predicted) assert.ok(vw.pal.air[vw.get(q[0], q[1], q[2])], `${o.id}: ${q} holds ${vw.pal.states[vw.get(q[0], q[1], q[2])]}`);
  const l = lint();
  assert.deepEqual(l.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
  assert.deepEqual(l.checker.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.message}`), []);
});

test('RV c04: a ninth river body in the region is refused UNSETTLED {cap: regionBodies}: say, regionWide, the pools course as wouldFit', async () => {
  const { p } = await plan('c04_three_rivers.json');
  assert.deepEqual(['river1', 'river2'].map((id) => p.answers.find((q) => q.part === id).class), ['fits', 'fits']);
  const a = p.answers.find((q) => q.part === 'river3');
  assert.equal(a.class, 'refused');
  const r = a.reasons[0];
  assert.equal(r.code, 'UNSETTLED');
  assert.deepEqual(Object.keys(r).sort(), ['code', 'evidence', 'message', 'say'], 'plan.json reason members only');
  assert.deepEqual([r.evidence.cap, r.evidence.limit, r.evidence.regionWide], ['regionBodies', 8, true]);
  assert.equal(r.say, 'The river was too long to settle here; a shorter one fits');
  assert.equal(a.wouldFit.length, 1);
  assert.deepEqual([a.wouldFit[0].part, a.wouldFit[0].fragment.flow, a.wouldFit[0].why], ['river3', 'pools', 'source']);
  assert.ok(fluidOps(p.ir).filter((o) => o.model === 'wm').length === 6 && !fluidOps(p.ir).some((o) => o.part === 'river3'), 'river3 rolled back whole');
});

// ------------------------------------------------------------------ the lift and the wash (test-only regions)

async function planDemo(file, params, { edits = [], claim = [64, 48] } = {}) {
  const { planTwice } = await import('./h-helpers.mjs');
  const { columnsOf, worldOf } = await import('./region-helpers.mjs');
  const src = path.join(HERE, 'fixtures', 'wm', file);
  const demo = await import(src);
  const CLAIM = { minX: 0, minZ: 0, maxX: claim[0] - 1, maxZ: claim[1] - 1, minY: -64, maxY: 319 };
  const SURVEY = columnsOf(worldOf({ flat: 64 }), 0, 0, claim[0], claim[1], 1);
  const p = await planTwice({ program: demo, programSource: fs.readFileSync(src, 'utf8'), params, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' }, { edits });
  return { p, SURVEY };
}

test('RV lift: a simulated conversion is lifted into the body\'s written sources (op converted, one of its cells); lift false leaves M25:convert', async () => {
  const { lintPlanned } = await import('../lint/water.mjs');
  const { checkRegion } = await import('../lib/region/check.mjs');
  for (const lift of [true, false]) {
    const { p, SURVEY } = await planDemo('lift_demo.mjs', { lift }, { claim: [48, 48] });
    const o = fluidOps(p.ir).find((q) => q.id === 'pair');
    const cells = new Set(fromRuns(o.cells).map(k3));
    const rep = checkRegion({ ir: p.ir, survey: SURVEY, blobs: (s) => p.blobs?.[s] ?? null, volumes: p.volumes.map((v) => v.decoded), meta: p.meta, prefix: false, rules: ['M25'] });
    const l = lintPlanned({ ir: p.ir, meta: p.meta, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), survey: SURVEY, name: 'lift_demo' });
    if (lift) {
      assert.deepEqual(fromRuns(o.converted), [[24, 64, 24]]);
      assert.ok(cells.has('24,64,24') && cells.size === 3);
      assert.ok(!o.predicted.some((q) => q[3] === 0));
      assert.ok(!rep.findings.some((f) => f.rule === 'M25:convert'));
      assert.ok(!l.findings.some((f) => f.rule === 'W6:convert'));
    } else {
      assert.equal(o.converted, undefined);
      assert.equal(cells.size, 2);
      assert.ok(rep.findings.some((f) => f.rule === 'M25:convert') || l.findings.some((f) => f.rule === 'W6:convert'), 'named');
    }
  }
});

test('RV wash: natural plants in a river\'s predicted cells are cleared IF_NATURAL in the shell\'s stage (op wash); the checker and W7 are clean', async () => {
  const { lintPlanned } = await import('../lint/water.mjs');
  const { checkRegion } = await import('../lib/region/check.mjs');
  const { layout } = await import('./fixtures/wm/river_se.mjs');
  // river_se's last run crosses the natural ground: short grass on its middle lane's predicted cells
  const L = layout([12, 24], 64, { runs: 8 });
  const last = L.water.filter((c) => c[1] === 64 + 1 && c[2] === 24 && c[0] < 12 + 7 + 6 * 8);
  assert.ok(last.length >= 4);
  const edits = last.map((c) => ({ box: [c[0], c[1], c[2], c[0], c[1], c[2]], class: 'PLANT', block: 'minecraft:short_grass' }));
  const { p, SURVEY } = await planDemo('river_se.mjs', {}, { edits, claim: [128, 48] });
  const head = fluidOps(p.ir).find((o) => o.id === 'river_r1');
  const wash = fromRuns(head.wash ?? []).map(k3).sort();
  assert.deepEqual(wash, last.map(k3).sort());
  const wp = p.ir.parts.find((q) => q.id === 'river_r1_wash');
  assert.ok(wp, 'the clear part');
  assert.equal(wp.stage, 'ground');
  assert.ok(wp.ops.every((o) => o.op === 'columns' && o.cond === 0 && o.materials.every((m) => m === null)), 'IF_NATURAL air');
  const rep = checkRegion({ ir: p.ir, survey: SURVEY, blobs: (s) => p.blobs?.[s] ?? null, volumes: p.volumes.map((v) => v.decoded), meta: p.meta, prefix: false, rules: ['M25'] });
  assert.deepEqual(rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.message}`), []);
  const l = lintPlanned({ ir: p.ir, meta: p.meta, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), survey: SURVEY, name: 'river_se:wash' });
  assert.deepEqual(l.findings.map((f) => `${f.rule}: ${f.message}`), []);
});

test('RV catalogue: channel.course lists flow current (plan.json flow enum, siteplan flow and step kinds)', () => {
  const e = planCatalogue().entries.find((q) => q.id === 'channel.course');
  assert.deepEqual(e.limits.flows, ['level', 'pools', 'riffles', 'current']);
  const S = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.match(JSON.stringify(S), /"flow":\{"enum":\["level","pools","riffles","current"\]\}/);
});
