// Phase 6c slice KC (docs/CONTRACT.md "Phase 6c slice KC: parts keep clear of fluid bodies" §10 item 1): the footprint registry, every
// writer's rule on its fixture (kit/test/fixtures/plan/kc/), OVERLAP {kind: "body"} with its wouldFit re-checked alone, M25:clear on
// every broken variant and 0 on every KC fixture that is not one, OB.BODY never WATER (the harbour trap), the moat's berm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, asksSurvey, checkPlanVolumes, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { clearScan, bodiesOf } from '../lib/region/checkFluids.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { keepStore, keptBy, keptColumn, keptColumns, registerBody, release, reserve } from '../lib/fluids/keep.mjs';
import { OB, OB_CODE, obstacleGrid, placeRing } from '../lib/connectors/line.mjs';
import { makeColumns, FLAG_WATER } from '../lib/region/pack.mjs';

const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8'));
const styleOf = (fx) => (typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null);

/** A fixture through the two-plan flow, then the region check over its IR. */
async function run(fx, plan = fx.plan) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const style = styleOf(fx);
  const r = await checkPlanVolumes(plan, { volume: fx.volume ?? {}, survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, keepOut: fx.keepOut ?? [], ...(style ? { style } : {}) });
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v), meta: r.res.meta });
  return { r, rep, s, part: (id) => r.check.parts.find((p) => p.part === id) };
}
const cache = new Map();
const kc = (f) => { if (!cache.has(f)) cache.set(f, run(read('kc', f))); return cache.get(f); };
const clearOf = (rep) => rep.findings.filter((f) => f.rule === 'M25:clear');

// ------------------------------------------------------------------ the registry (§2)

test('the registry: a reservation at resolve, a body\'s exact sets at emit (replacing it), release, keptBy and keptColumns', () => {
  const X = {};
  const store = keepStore(X);
  assert.equal(store, X.keep);
  reserve(store, { part: 'pool', body: 'w_pool', rects: [[10, 10, 12, 11]], y0: 60, y1: 70 });
  assert.deepEqual(keptBy(store, 11, 64, 10), { body: 'w_pool', part: 'pool', set: 'reserved' });
  assert.equal(keptBy(store, 11, 71, 10), null, 'outside the y-span');
  assert.equal(keptBy(store, 13, 64, 10), null);
  assert.equal(keptColumns(store).length, 6);
  // the emit: exact sets replace the reservation
  registerBody(store, { id: 'w_pool', cells: [[11, 63, 10]], shell: [[11, 62, 10], [12, 63, 10]], spill: [], watch: [[13, 63, 10]], lining: [], grate: [], ice: [] }, 'pool');
  assert.equal(store.length, 1);
  assert.equal(store[0].kind, 'body');
  assert.deepEqual(keptBy(store, 11, 63, 10), { body: 'w_pool', part: 'pool', set: 'cells' });
  assert.deepEqual(keptBy(store, 12, 63, 10), { body: 'w_pool', part: 'pool', set: 'shell' });
  assert.deepEqual(keptBy(store, 13, 63, 10), { body: 'w_pool', part: 'pool', set: 'watch' });
  assert.equal(keptBy(store, 13, 63, 10, { watch: false }), null);
  assert.equal(keptBy(store, 10, 64, 10), null, 'the reservation is gone');
  assert.deepEqual(keptColumn(store, 12, 10), { body: 'w_pool', part: 'pool' });
  // rollback is compile.mjs's checkpoint (a copy); a part that fails releases its records
  const cp = [...store];
  reserve(store, { part: 'fount', rects: [[0, 0, 1, 1]], y0: 0, y1: 99 });
  store.length = 0; store.push(...cp);
  assert.equal(keptColumn(store, 0, 0), null, 'rolled back');
  assert.equal(release(store, 'pool'), 1);
  assert.equal(keptBy(store, 11, 63, 10), null, 'a body that fails frees its footprint');
});

test('OB.BODY: a footprint over clear and natural-water cells is BODY (never WATER: no harbour fallback), refused as OVERLAP; placeRing names it', () => {
  const c = makeColumns(0, 0, 40, 40, 1);
  for (let i = 0; i < 1600; i++) { c.ground[i] = 64; c.height[i] = 64; c.floor[i] = 64; }
  // natural water in the band's north-west corner
  for (let x = 10; x <= 14; x++) for (let z = 8; z <= 9; z++) { const k = x + z * 40; c.flags[k] = FLAG_WATER; c.floor[k] = 60; }
  const claim = { minX: 0, minZ: 0, maxX: 39, maxZ: 39 };
  const bodies = [];
  for (let x = 8; x <= 31; x++) for (let z = 6; z <= 10; z++) bodies.push([x, z, 'w_pool']);
  const G = obstacleGrid({ claim, cols: c, bodies });
  assert.equal(G.ob[G.at(12, 8)], OB.BODY, 'natural water under a footprint is BODY');
  assert.equal(G.ob[G.at(20, 7)], OB.BODY);
  assert.equal(G.bodyAt(G.at(20, 7)), 'w_pool');
  assert.equal(OB_CODE[OB.BODY], 'OVERLAP');
  const Gw = obstacleGrid({ claim, cols: c, bodies, wet: { waterDepth: 6, vols: [], plan: [] } });
  assert.equal(Gw.ob[Gw.at(12, 8)], OB.BODY, 'the wet grid too');
  assert.equal(Gw.wetAt(Gw.at(12, 8)), null, 'never a wet (harbour) cell');
  // a ring whose north side can only fall on the footprint: refused with BODY's code
  const pl = placeRing(G, { minX: 14, minZ: 14, maxX: 25, maxZ: 25 }, [4, 5, 6], 2);
  assert.equal(pl.ok, false);
  assert.equal(pl.code, 'OVERLAP');
  assert.ok(pl.blockers.BODY > 0);
});

// ------------------------------------------------------------------ every writer's rule on its fixture (§4, §10)

test('k01_forge (v51 as VOC committed it): the wall refused OVERLAP {kind: body} naming the fountain; its wouldFit ring [4, 17] re-checked alone is READY and M25:clear 0', async () => {
  const { r, rep, part } = await kc('k01_forge.json');
  const w = part('forge_wall');
  assert.equal(w.class, 'refused');
  assert.equal(w.reasons[0].code, 'OVERLAP');
  assert.equal(w.reasons[0].evidence.kind, 'body');
  assert.equal(w.reasons[0].evidence.part, 'fount');
  assert.equal(w.reasons[0].evidence.body, 'w_fount');
  assert.ok(w.reasons[0].evidence.cells.length > 0 && w.reasons[0].evidence.cells.length <= 16);
  assert.deepEqual(w.wouldFit[0].fragment.where.around.ring, [4, 17]);
  assert.equal(part('fount').class, 'fits', 'the body never moves (S-KC-1)');
  assert.equal(part('forge').class, 'fits');
  assert.equal(clearOf(rep).length, 0);
  assert.equal(r.check.overall, 'NEEDS_REPAIR');
  // the wouldFit, alone: the plan with the wall's fragment
  const fx = read('kc', 'k01_forge.json');
  const plan = { ...fx.plan, connectors: fx.plan.connectors.map((q) => (q.id === 'forge_wall' ? w.wouldFit[0].fragment : q)) };
  const again = await run(fx, plan);
  assert.equal(again.r.check.overall, 'READY');
  assert.equal(again.part('forge_wall').class, 'fits');
  assert.equal(clearOf(again.rep).length, 0);
  assert.deepEqual(again.rep.metrics.M25.clear, { hard: 0, watch: 0, exempt: 0 });
  // and that is valid/v51_voc_forge's plan now (Steward's repair)
  assert.deepEqual(read('valid', 'v51_voc_forge.json').plan.connectors[0].where.around.ring, [4, 17]);
});

test('k02_ring_tight: a ring [4, 4] whose band holds a pond: OVERLAP {kind: body}, the wider ring\'s wouldFit READY alone', async () => {
  const { part, rep } = await kc('k02_ring_tight.json');
  const w = part('yard_wall');
  assert.equal(w.class, 'refused');
  assert.deepEqual([w.reasons[0].code, w.reasons[0].evidence.kind, w.reasons[0].evidence.part], ['OVERLAP', 'body', 'pool']);
  assert.equal(part('pool').class, 'fits');
  assert.equal(clearOf(rep).length, 0);
  const fx = read('kc', 'k02_ring_tight.json');
  const again = await run(fx, { ...fx.plan, connectors: [w.wouldFit[0].fragment] });
  assert.equal(again.r.check.overall, 'READY');
  assert.equal(clearOf(again.rep).length, 0);
});

test('k03_harbour_trap: a wall line across a pond on a claim with natural water: no harbour wall over plan water, the line round it, M25:clear 0', async () => {
  const { r, rep, part } = await kc('k03_harbour_trap.json');
  const w = part('divide');
  assert.ok(['fits', 'adjusted'].includes(w.class));
  assert.equal(w.geometry.wet, undefined, 'no wet section');
  assert.equal((r.res.meta.wet ?? []).length, 0);
  assert.ok(w.geometry.line.length > 2, 'the line turns round the pond');
  assert.equal(clearOf(rep).length, 0);
});

test('k04_rope_landing: a rope bridge whose straight landing is a fountain\'s apron keeps clear of it (or is refused OVERLAP body); the fountain unchanged', async () => {
  const { rep, part } = await kc('k04_rope_landing.json');
  const s = part('span');
  assert.ok(['fits', 'adjusted'].includes(s.class) || (s.reasons?.[0]?.code === 'OVERLAP' && s.reasons[0].evidence.kind === 'body'));
  assert.equal(part('fount').class, 'fits');
  assert.equal(clearOf(rep).length, 0);
});

test('k05_tunnel_buffer: a bore within 2 of a pond\'s shell: T3\'s WATER, kind body, with the cells', async () => {
  const { part } = await kc('k05_tunnel_buffer.json');
  const b = part('bore');
  assert.equal(b.class, 'refused');
  assert.equal(b.reasons[0].code, 'WATER');
  assert.equal(b.reasons[0].evidence.kind, 'body');
  assert.ok(b.reasons[0].evidence.cells > 0);
  assert.equal(part('pool').class, 'fits');
});

test('k06_lamp: a lamp candidate in a fountain\'s apron is skipped; M25:clear 0, READY', async () => {
  const { r, rep } = await kc('k06_lamp.json');
  assert.equal(r.check.overall, 'READY');
  assert.ok(r.res.meta.village.apronLamps.keptSkipped > 0);
  assert.equal(clearOf(rep).length, 0);
});

test('k07: a course along a wall kept clear and one across it under its water gate: READY; k07b: a course against the wall refused UNREACHABLE wall, never the wall', async () => {
  const a = await kc('k07_course_wall.json');
  assert.equal(a.r.check.overall, 'READY');
  assert.ok(a.r.res.meta.walls.find((w) => w.id === 'town_wall').waterGates.some((g) => g.course === 'brook'));
  assert.equal(clearOf(a.rep).length, 0);
  const b = await kc('k07b_course_against_wall.json');
  const c = b.part('brook2');
  assert.equal(c.class, 'refused');
  assert.equal(c.reasons[0].code, 'UNREACHABLE');
  assert.equal(c.reasons[0].evidence.kind, 'wall');
  assert.equal(b.part('town_wall').class, 'fits');
  assert.equal(clearOf(b.rep).length, 0);
});

test('k08_farm_props: a farm pond whose first site holds the wall\'s planned cells takes its next side; M25:clear 0', async () => {
  const { r, rep, part } = await kc('k08_farm_props.json');
  assert.equal(r.check.overall, 'READY');
  const notes = part('farms').notes.filter((n) => /farmPond/.test(n));
  assert.ok(notes.length === 2 && notes.every((n) => !/north side/.test(n)), notes.join(' | '));
  assert.equal(clearOf(rep).length, 0);
});

test('v61_kc_village: a walled village, a fountain, a pond, a moat, a course under a water gate and bridged roads: READY, M25 clean', async () => {
  const { r, rep, part } = await kc('v61_kc_village.json');
  assert.equal(r.check.overall, 'READY');
  for (const p of r.check.parts) assert.ok(['fits', 'adjusted'].includes(p.class), `${p.part} ${p.class}`);
  assert.ok(r.res.meta.walls[0].waterGates.some((g) => g.course === 'brook'));
  assert.equal(bodiesOf(r.res.ir).length >= 5, true);
  assert.deepEqual(rep.findings.filter((f) => /^M25/.test(f.rule)).map((f) => f.message), []);
  assert.equal(rep.metrics.M25.clear.hard + rep.metrics.M25.clear.watch, 0);
  void part;
});

// ------------------------------------------------------------------ the broken variants: each caught by M25:clear (§10)

for (const [f, sets, why] of [['u01_wall_through_body.json', ['cells', 'shell', 'watch'], null], ['u02_lamp_on_rim.json', ['shell'], null], ['u03_slab_in_watch.json', ['watch'], null], ['u04_owner_unknown.json', ['shell'], 'owner unknown']]) {
  test(`broken variant ${f}: M25:clear (an error) names ${sets.join(', ')}`, async () => {
    const { rep } = await kc(f);
    const cl = clearOf(rep);
    assert.ok(cl.length > 0);
    assert.ok(cl.every((x) => x.severity === 'error'));
    for (const s of sets) assert.ok(cl.some((x) => x.message.includes(`of its ${s} `)), `${s}: ${cl.map((x) => x.message).join(' | ')}`);
    if (why) {
      assert.ok(cl.some((x) => x.message.includes(why)));
      assert.ok(rep.findings.some((x) => x.rule === 'M25:shell' && x.message.includes('owner unknown')), 'shellCheck: a missing part id is a finding');
    }
  });
}

// ------------------------------------------------------------------ the moat's berm (§4's moat row, S-KC-2)

test('the moat\'s berm: v45\'s wall writes no cell of the moat\'s sets, and every wall cell within 2 of its shell is fluid-stopping', async () => {
  const fx = read('valid', 'v45_moat.json');
  const { r, rep } = await run(fx);
  assert.equal(clearOf(rep).length, 0);
  const ir = r.res.ir;
  const { vw } = buildVirtual({ ir, survey: flatSurvey().bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v) });
  const moat = bodiesOf(ir).find((b) => b.part === 'moat');
  const near = new Set();
  for (const [x, y, z] of moat.shell) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) near.add(`${x + dx},${y + dy},${z + dz}`);
  const wallIdx = ir.parts.findIndex((p) => p.id === 'w_town_wall');
  let n = 0;
  for (const k of near) {
    const [x, y, z] = k.split(',').map(Number);
    if (vw.partAt(x, y, z) !== wallIdx) continue;
    n++;
    assert.ok(vw.pal.fs[vw.get(x, y, z)], `${k} ${vw.pal.states[vw.get(x, y, z)]}`);
  }
  const sc = clearScan({ ir, vw, meta: r.res.meta });
  assert.deepEqual(sc.counts, { hard: 0, watch: 0, exempt: 0 });
  void n;
});

// ------------------------------------------------------------------ the backstop's order rule (§3, S-KC-1)

test('the backstop refuses the part placed later: the writer after a body, the body after a zone or relief, the course after a wall', async () => {
  const { clearRefusals } = await import('../lib/region/checkFluids.mjs');
  const plan = { zones: [{ id: 'town' }], forms: [{ id: 'fount', kind: 'fountain' }, { id: 'hill', kind: 'relief' }, { id: 'bad', kind: 'pond', ext: { 'architect_mc:unsafe': { x: 1 } } }], connectors: [{ id: 'w', kind: 'wall' }, { id: 'brook', kind: 'channel' }, { id: 'r', kind: 'rope_bridge' }] };
  const f = (writerPart, part, body, set = 'watch') => ({ writerPart, part, body, set, count: 2, cells: [[0, 0, 0]] });
  const out = clearRefusals({ plan, courses: new Set(['brook_r1']), findings: [f('w', 'fount', 'w_fount', 'shell'), f('town', 'fount', 'w_fount'), f('w', 'brook', 'brook_r1'), f('hill', 'bad', 'w_bad'), f('__lamps__', 'fount', 'w_fount'), f('town', 'town', 'w_f1_pond')] });
  assert.deepEqual(Object.keys(out).sort(), ['brook', 'fount', 'w']);
  assert.deepEqual([out.w.code, out.w.evidence.kind], ['OVERLAP', 'body']);
  assert.deepEqual([out.fount.code, out.fount.evidence.kind, out.fount.evidence.writer], ['NO_ROOM', 'clear', 'town'], 'the zone placed first, the body keeps clear (never the zone)');
  assert.deepEqual([out.brook.code, out.brook.evidence.kind, out.brook.evidence.wall], ['UNREACHABLE', 'wall', 'w']);
  assert.equal(out.town, undefined);
  assert.equal(out.bad, undefined, 'never an unsafe part');
});
