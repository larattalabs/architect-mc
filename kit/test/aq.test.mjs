// (7c AQ, docs/CONTRACT.md "Phase 7c" §3 row 9 and "Slice AQ as built") Aqueducts: channel.aqueduct supported; where HY's course router
// answered "deeper than fill" (unsupported channel.aqueduct until 7c), the course is carried over the low ground on piers or arches, its
// lanes and banks kept (the trough's side walls 2 thick at the top), in the Style's roles. Valley crossings at depths 3, 8 and 16 and the
// builder-written example fixtures/plan/aq/x01 checked clean; RM's span type `aqueduct` (meta.aqueducts); survival: the piers, arches,
// walls and lining are the part's construction target (its bill = its cost.bom); the refusal past AQUEDUCT.rise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalogue, planCatalogueKinds } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { M15_SPAN_TYPES, regionM15Limits } from '../lib/region/checkM15.mjs';
import { AQUEDUCT, aqueductEvery } from '../lib/fluids/course.mjs';
import { checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'plan');
const fixture = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, `${rel}.json`), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

async function planFx(fx, { survival = false } = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, volume: fx.volume ?? {}, ...(survival ? { survival: true } : {}) });
  const blobs = (sha) => r.res?.blobs?.get(sha) ?? null;
  const volumes = (r.volumes ?? []).map((v) => v.decoded);
  return { ...r, s, report: () => checkRegion({ ir: r.res.ir, survey: s.bytes, blobs, meta: r.res.meta, volumes }), world: () => buildVirtual({ ir: r.res.ir, survey: s.bytes, blobs, volumes }).vw };
}
const partOf = (r, id) => r.check.parts.find((a) => a.part === id);
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.part}: ${f.message}`);
const name = (vw, x, y, z) => String(vw.pal.states[vw.get(x, y, z)] ?? 'minecraft:air').replace(/\[.*$/, '');
const groundOf = (T) => (x, z) => { let y = T.y; for (const b of T.bands) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) y = b.y; return y; };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

test('catalogue: channel.aqueduct supported with its def and limits (schemaVersion 1, sinceApi NEXT or stamped, no until); served on demand', () => {
  const e = planCatalogue().entries.find((x) => x.id === 'channel.aqueduct');
  assert.equal(e.state, 'supported');
  assert.equal(e.schemaVersion, 1);
  assert.equal(e.until, undefined);
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
  assert.deepEqual(e.limits, { rise: [3, AQUEDUCT.rise], spans: ['piers', 'arches'], every: { piers: 6, arches: 8 } });
  const raw = PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === 'channel.aqueduct');
  assert.equal(raw.def, '#/$defs/channel.aqueduct');
  assert.equal(raw.draft, undefined);
  assert.equal(PLAN_SCHEMA.$defs['channel.aqueduct']['x-state'], undefined);
  assert.deepEqual(PLAN_SCHEMA.$defs['channel.aqueduct'].properties.params.properties.span.enum, ['piers', 'arches']);
  const k = planCatalogueKinds(['channel.aqueduct']);
  assert.deepEqual(k.entries[0].def, PLAN_SCHEMA.$defs['channel.aqueduct']);
  assert.deepEqual(M15_SPAN_TYPES, { rope_bridge: 'ropes', aqueduct: 'aqueducts' }, 'RM\'s span types: aqueduct appended, with its own record list');
});

test('aqueductEvery: arches every 8, piers every 6; a Style\'s aqueduct.maxSpan (RM\'s limits) caps the clear run (every - 1)', () => {
  assert.equal(aqueductEvery('arches'), 8);
  assert.equal(aqueductEvery('piers'), 6);
  assert.equal(aqueductEvery('arches', regionM15Limits()), 8, 'no Style: unbounded, the default');
  assert.equal(aqueductEvery('arches', regionM15Limits({ aqueduct: { maxSpan: 4 } })), 5);
  assert.equal(aqueductEvery('piers', regionM15Limits({ aqueduct: { maxSpan: 12 } })), 6, 'never wider than the default');
  assert.equal(aqueductEvery('piers', regionM15Limits(null, { span: { aqueduct: 0 } })), 2);
});

/**
 * One crossing, judged over the virtual world: READY, fits, block channel.aqueduct, the answer's aqueduct row; the region check without an
 * error and without any M15 or M25 finding; along the course's centre line over the span, nothing under the trough's floor but its
 * supports (no fill: every cell there air, a pier or an arch), the piers `every` apart, standing on the ground, an arch's soffit never
 * on the ground; the trough's side walls 2 thick at its water.
 */
async function crossing(rel, { span, every, deep }) {
  const fx = fixture(rel);
  const r = await planFx(fx);
  const a = partOf(r, 'canal');
  assert.equal(r.check.overall, 'READY', `${rel}: ${JSON.stringify(r.check.parts.map((p) => [p.part, p.class, p.reasons]))}`);
  assert.equal(a.class, 'fits', rel);
  assert.equal(a.block, 'channel.aqueduct', rel);
  const aq = a.geometry.aqueduct;
  assert.deepEqual([aq.span, aq.every], [span, every], rel);
  assert.ok(aq.length >= 30, `${rel}: ${JSON.stringify(aq)}`);
  assert.ok(a.notes.some((n) => /^an aqueduct \(channel\.aqueduct\)/.test(n)), rel);
  const rep = r.report();
  assert.deepEqual(errors(rep), [], rel);
  assert.deepEqual(rep.findings.filter((f) => /^M1[5]|^M25/.test(f.rule)).map((f) => `${f.rule} ${f.part}: ${f.message}`), [], `${rel}: M15 and M25 clean`);
  // RM's record list: the span part and the shell of the reach over it, the aqueduct's span type
  const recs = r.res.meta.aqueducts;
  assert.ok(recs.some((q) => q.part === 'canal_span') && recs.some((q) => /_shell$/.test(q.part)) && recs.every((q) => q.course === 'canal'), JSON.stringify(recs));
  const vw = r.world();
  const g = groundOf(fx.terrain);
  const z = fx.anchors.a[2];
  // the water line and the trough's floor
  const xs = [];
  for (let x = fx.terrain.x0; x < fx.terrain.x0 + fx.terrain.W; x++) if (name(vw, x, 71, z) === 'minecraft:water') xs.push(x);
  const valley = xs.filter((x) => g(x, z) < 72);
  assert.ok(valley.length >= 30, `${rel}: the water crosses the valley (${valley.length})`);
  const floor = 69;
  const piers = [];
  for (const x of valley) {
    assert.equal(name(vw, x, floor, z), 'minecraft:stone_bricks', `${rel}: the floor at ${x}`);
    // the side walls: the shell and the bank course, both solid, at the water
    for (const dz of [-3, -2, 2, 3]) for (const y of [70, 71]) assert.notEqual(name(vw, x, y, z + dz), 'minecraft:air', `${rel}: the wall at ${x} ${y} ${z + dz}`);
    let pier = true;
    for (let y = g(x, z) + 1; y < floor; y++) {
      const b = name(vw, x, y, z);
      assert.ok(b === 'minecraft:air' || b === 'minecraft:cobblestone' || b === 'minecraft:stone_bricks', `${rel}: under the floor at ${x} ${y}: ${b} (no fill)`);
      if (b === 'minecraft:air') pier = false;
    }
    if (pier && g(x, z) + 1 < floor) piers.push(x);
    // (an arch's soffit is never on the ground: the cell over the valley floor is air where no pier stands)
    if (!pier && span === 'arches') assert.equal(name(vw, x, g(x, z) + 1, z), 'minecraft:air', `${rel}: the soffit clear of the ground at ${x}`);
  }
  if (deep) {
    assert.ok(piers.length >= 3, `${rel}: piers ${piers.join(',')}`);
    const gaps = piers.slice(1).map((x, i) => x - piers[i]).filter((d) => d > 1);
    assert.ok(gaps.every((d) => d <= every), `${rel}: piers at most ${every} apart: ${piers.join(',')}`);
    // the piers stand on the ground and reach the floor
    for (const x of piers) assert.notEqual(name(vw, x, g(x, z) + 1, z), 'minecraft:air', `${rel}: the pier at ${x} on the ground`);
  }
  return { r, a, aq, vw, piers };
}

test('a valley 8 deep (x01, the builder-written example): arches between piers every 8, the trough built, checks clean; the same IR twice', async () => {
  const { aq, r } = await crossing('aq/x01_valley_aqueduct', { span: 'arches', every: 8, deep: true });
  assert.equal(aq.rise, 4, 'up to 4 clear under the floor (69 over 64)');
  const again = await planFx(fixture('aq/x01_valley_aqueduct'));
  assert.equal(again.res.irJson, r.res.irJson, 'deterministic');
  assert.equal(again.artifactSha, r.artifactSha);
});

test('a valley 8 deep, params.span piers: a pier every 6 (clear 5), no arch', async () => {
  const { aq, vw } = await crossing('aq/d08_piers', { span: 'piers', every: 6, deep: true });
  assert.ok(aq.piers >= 5, JSON.stringify(aq));
  // no arch: between two piers the cell under the floor is air
  let open = 0;
  for (let x = 1026; x < 1054; x++) if (name(vw, x, 68, 2020) === 'minecraft:air') open++;
  assert.ok(open >= 18, `${open} open cells under the floor`);
});

test('a valley 16 deep: arches, the piers 12 high, the soffit never on the ground', async () => {
  const { aq } = await crossing('aq/d16_deep', { span: 'arches', every: 8, deep: true });
  assert.equal(aq.rise, 12);
});

test('a valley 3 deep (params.cut 0: the canal keeps its level): past fill, an aqueduct whose trough rests on the valley floor, no pier', async () => {
  const { aq } = await crossing('aq/d03_shallow', { span: 'arches', every: 8, deep: false });
  assert.deepEqual([aq.rise, aq.piers], [0, 0]);
  // the same valley with the trench allowed (cut 6, the default) is HY's course: no aqueduct
  const fx = clone(fixture('aq/d03_shallow'));
  delete fx.plan.connectors[0].params;
  const r = await planFx(fx);
  assert.equal(partOf(r, 'canal').block, 'connector.channel');
  assert.equal(r.res.meta.aqueducts, undefined);
});

test('S-THEME: every block the aqueducts write traces to a role or is natural (the span in the lining, foundation and structure roles)', async () => {
  for (const n of ['x01_valley_aqueduct', 'd08_piers', 'd16_deep', 'd03_shallow']) {
    const r = await planFx(fixture(`aq/${n}`));
    assert.deepEqual(themeOffenders(r.res.ir, r.world(), { meta: r.res.meta }).offenders, [], n);
  }
});

test('survival: the span (piers, arches, walls) and the trough\'s lining are the part\'s construction target: its bill is its cost.bom; the water free', async () => {
  for (const n of ['x01_valley_aqueduct', 'd16_deep']) {
    const r = await planFx(fixture(`aq/${n}`), { survival: true });
    const a = partOf(r, 'canal');
    const sv = a.cost.survival;
    assert.ok(r.check.survival === true || r.res.ir.survival, n);
    assert.ok(sv.free > 0, JSON.stringify(sv));
    assert.deepEqual(sv.bom, a.cost.bom, `${n}: the survival bill is the part's bill, item for item`);
    assert.ok(sum(sv.bom) > 500 && sv.bom['minecraft:cobblestone'] > 0, `${n}: the piers (the foundation role) billed: ${JSON.stringify(sv.bom)}`);
    assert.ok(r.res.ir.survival.groups.includes('canal'), JSON.stringify(r.res.ir.survival.groups));
    assert.ok('canal_span' in r.res.ir.survival.parts, JSON.stringify(r.res.ir.survival.parts));
    assert.equal(r.res.ir.survival.cells.canal.paid, sum(sv.bom), `${n}: one paid cell an item`);
  }
});

test('refusals and params: past AQUEDUCT.rise refused UNREACHABLE fill; params.span not piers or arches noted (the default); HY\'s note where no aqueduct', async () => {
  const fx = clone(fixture('aq/x01_valley_aqueduct'));
  fx.terrain.y = 40;
  const r = await planFx(fx);
  const a = partOf(r, 'canal');
  assert.equal(a.class, 'refused', JSON.stringify(a));
  assert.equal(a.block, 'channel.aqueduct');
  assert.deepEqual([a.reasons[0].code, a.reasons[0].evidence.kind, a.reasons[0].evidence.limit], ['UNREACHABLE', 'fill', AQUEDUCT.rise]);
  const b = clone(fixture('aq/x01_valley_aqueduct'));
  b.plan.connectors[0].params = { span: 'trestle' };
  const rb = await planFx(b);
  const ab = partOf(rb, 'canal');
  assert.equal(ab.geometry.aqueduct.span, 'arches');
  assert.ok(ab.notes.some((x) => /^params\.span "trestle" not read/.test(x)), JSON.stringify(ab.notes));
  assert.ok(!ab.notes.some((x) => /^params\.span not read/.test(x)));
  // a course that needs no aqueduct keeps HY's lenient note for params.span
  const c = clone(fixture('aq/d03_shallow'));
  c.plan.connectors[0].params = { span: 'piers' };
  const rc = await planFx(c);
  const ac = partOf(rc, 'canal');
  assert.equal(ac.block, 'connector.channel');
  assert.ok(ac.notes.some((x) => /^params\.span not read/.test(x)), JSON.stringify(ac.notes));
});

test('HY\'s movers by name: hy/r03 and extension/e18 (the same plan) answer fits as an aqueduct, where they answered unsupported until 7c', async () => {
  for (const rel of ['hy/r03_aqueduct', 'extension/e18_aqueduct']) {
    const fx = fixture(rel);
    const r = await planFx(fx);
    const a = partOf(r, 'canal');
    assert.deepEqual([r.check.overall, a.class, a.block], ['READY', 'fits', 'channel.aqueduct'], rel);
    assert.deepEqual([fx.expect.class, fx.expect.block], ['fits', 'channel.aqueduct'], rel);
    assert.deepEqual(errors(r.report()), [], rel);
  }
});
