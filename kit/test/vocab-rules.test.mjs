// (6c VOC-b) Budgets and rules, the kit half of the VOC gate (docs/CONTRACT.md "Phase 6c slice VOC" §8 items 6 and 7, and the batch test of
// §11): the building rules (state and hazard errors, rarity and coherence warnings only with an opted-in bible, metrics.rarity and
// metrics.drift), the region rules (M26, M27, M20 widened), the compile pass's VOCAB and FIRE refusals (fixtures/plan/voc), the answers'
// cost.rarity, and the bible's rarity member and role warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, asksSurvey, checkPlanVolumes, fixtureVolume, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { BUILTIN_BIBLES, builtinBible, restraintOf, validateBible } from '../lib/bible.mjs';
import { measureRarity, styleOf } from '../lib/vocab/budget.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { BROKEN, DESIGNS, DESIGN_BIBLE, vocBible } from './fixtures/vocab/voc-designs.mjs';

const readJ = (...p) => ({ name: p[p.length - 1], ...JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8')) });
/** A fixture's style: a scenario bible's name, or an inline bible. */
export const styleOfFixture = (fx) => (typeof fx.style === 'string' ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${fx.style}.json`), 'utf8')) : fx.style ?? null);
const svOf = (fx) => (fx.on === 'asks' ? asksSurvey() : fx.on === 's3' ? goldenSurvey('s3') : flatSurvey());
async function run(fx, { style = styleOfFixture(fx), survey = svOf(fx), plan = fx.plan } = {}) {
  const r = await checkPlanVolumes(plan, { survey: survey.bytes, claim: survey.claim, anchors: { ...stewardAnchors(survey.claim), ...(fx.anchors ?? {}) }, volume: fx.volume ?? {}, style });
  const report = checkRegion({ ir: r.res.ir, survey: survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded), prefix: false });
  return { ...r, report };
}
const rules = (rep, re) => rep.findings.filter((f) => re.test(f.rule));

// ------------------------------------------------------------------ item 6: the building rules

test('item 6 (buildings): each broken variant caught by its rule with its cells; rarity and coherence only with the opted-in bible', () => {
  for (const [name, v] of Object.entries(BROKEN)) {
    const bible = vocBible(v.bible ?? 'g6cvoc_modern');
    const twin = vocBible(`${v.bible ?? 'g6cvoc_modern'}_free`);
    const r = checkBlueprint(v.make(), { style: styleOf(bible) });
    if (v.rule === 'state' || v.rule === 'hazard') {
      const e = r.errors.filter((m) => m.startsWith(`${v.rule}: `));
      assert.ok(!r.ok && e.length >= 1 && /\d+,\d+,\d+/.test(e[0]), `${name}: an error of ${v.rule} naming cells: ${JSON.stringify(r.errors)}`);
    } else {
      const w = r.warnings.filter((m) => m.startsWith(`${v.rule}: `));
      assert.ok(w.length >= 1, `${name}: a ${v.rule} warning with the opted-in bible: ${JSON.stringify(r.warnings)}`);
      const t = checkBlueprint(v.make(), { style: styleOf(twin) });
      assert.equal(t.warnings.filter((m) => /^(rarity|coherence): /.test(m)).length, 0, `${name}: no budget warning with the twin`);
      assert.ok(t.metrics.rarity.over.some((o) => o.rule === v.rule), `${name}: the twin's metrics.rarity.over names ${v.rule}: ${JSON.stringify(t.metrics.rarity.over)}`);
    }
  }
});

test('item 6 (buildings): the four VOC designs check clean; the opted-in bibles warn where the budget breaks, their twins never', () => {
  for (const [id, mk] of Object.entries(DESIGNS)) {
    const b = vocBible(DESIGN_BIBLE[id]), t = vocBible(`${DESIGN_BIBLE[id]}_free`);
    const r = checkBlueprint(mk(), { style: styleOf(b), restraint: restraintOf(b) });
    const f = checkBlueprint(mk(), { style: styleOf(t), restraint: restraintOf(t) });
    assert.ok(r.ok && f.ok, `${id}: ${JSON.stringify([...r.errors, ...f.errors])}`);
    assert.equal(f.warnings.filter((m) => /^(rarity|coherence): /.test(m)).length, 0, `${id}: the twin never warns a budget`);
    const warned = r.warnings.filter((m) => /^(rarity|coherence): /.test(m)).length;
    assert.equal(warned > 0, r.metrics.rarity.over.length > 0, `${id}: warnings exactly when over (${JSON.stringify(r.metrics.rarity.over)})`);
    assert.ok(r.metrics.rarity && typeof r.metrics.rarity.cells === 'number' && r.metrics.drift && typeof r.metrics.drift === 'object');
  }
  // the shrine's one beacon: inside its bible's preciousMax 1; its twin (the defaults, preciousMax 0): over in metrics only
  const s = checkBlueprint(DESIGNS.voc_shrine(), { style: styleOf(vocBible('g6cvoc_modern_free')) });
  assert.deepEqual(s.metrics.rarity.preciousBlocks, { 'minecraft:beacon': 1 });
  assert.ok(s.metrics.rarity.over.some((o) => o.what === 'precious'));
  // the tent: four colours over the modern bible's three (coherence); the copper hall's unwaxed copper drifts
  const tent = checkBlueprint(DESIGNS.voc_tent(), { style: styleOf(vocBible('g6cvoc_modern')) });
  assert.ok(tent.warnings.some((m) => /^coherence: 4 dye colours/.test(m)), JSON.stringify(tent.warnings));
  const hall = checkBlueprint(DESIGNS.voc_copper_hall(), { style: styleOf(vocBible('g6cvoc_copper')) });
  assert.ok(hall.metrics.drift['minecraft:copper_block'] > 0 && !hall.metrics.drift['minecraft:waxed_cut_copper'], JSON.stringify(hall.metrics.drift));
  // without any bible: measured at the defaults, never a warning
  const none = checkBlueprint(DESIGNS.voc_tent());
  assert.equal(none.warnings.filter((m) => /^(rarity|coherence): /.test(m)).length, 0);
  assert.ok(none.metrics.rarity.over.length > 0);
});

test('measureRarity: the style\'s own blocks are exempt from the shares, precious cells are counted everywhere (S-VOC-3)', () => {
  const own = styleOf({ roles: { wall: 'minecraft:purpur_block' }, rarity: { allow: ['minecraft:beacon'] } });
  const m = measureRarity({ 'minecraft:purpur_block': 90, 'minecraft:beacon': 1, 'minecraft:gold_block': 9 }, own, 'building');
  assert.equal(m.rare, 9);
  assert.equal(m.precious, 1);
  assert.deepEqual(m.over.map((o) => o.what).sort(), ['precious', 'rareShare']);
  assert.ok(own.own.has('minecraft:purpur_stairs') || own.own.has('minecraft:purpur_block'));
});

// ------------------------------------------------------------------ item 6: the region rules and the refusals

test('item 6 (plans): r01-r03 refused with their codes and evidence; nothing written for the refused part', async () => {
  const dir = path.join(FIX, 'voc');
  const files = fs.readdirSync(dir).filter((f) => /^r0\d_.*\.json$/.test(f)).sort();
  assert.equal(files.length, 3, files.join(', '));
  for (const f of files) {
    const fx = readJ('voc', f);
    const r = await run(fx);
    const a = r.check.parts.find((p) => p.part === fx.expect.part);
    assert.equal(a?.class, 'refused', `${f}: ${JSON.stringify(a)}`);
    const why = a.reasons[0];
    assert.equal(why.code, fx.expect.code, `${f}: ${JSON.stringify(why)}`);
    assert.equal(why.evidence.rule, fx.expect.rule);
    assert.ok(typeof why.evidence.block === 'string' && Array.isArray(why.evidence.cells) && why.evidence.cells.length > 0 && why.evidence.cells.length <= 16, `${f}: evidence ${JSON.stringify(why.evidence)}`);
    assert.ok(!Object.values(r.res.meta.planCheck.partOf).includes(fx.expect.part), `${f}: the refused part owns no IR part`);
    assert.equal(rules(r.report, /^M27:(state|convert)$|^M20$/).length, 0, `${f}: the realised plan has no M27 or M20 error left`);
  }
});

test('item 6 (plans): the checker catches the same defects in an unsafe twin (M27:state, M27:convert, M20 errors with cells)', async () => {
  for (const [f, rule] of [['r01_state_waterlogged_slab.json', 'M27:state'], ['r02_convert_sponge_quay.json', 'M27:convert'], ['r03_fire_pattern.json', 'M20']]) {
    const fx = readJ('voc', f);
    const plan = JSON.parse(JSON.stringify(fx.plan));
    for (const k of ['zones', 'forms', 'connectors']) for (const p of plan[k] ?? []) if (p.id === fx.expect.part) p.ext = { ...(p.ext ?? {}), 'architect_mc:unsafe': { vocab: true } };
    const r = await run(fx, { plan });
    const hit = rules(r.report, new RegExp(`^${rule}$`));
    assert.ok(hit.length && hit[0].severity === 'error' && hit[0].sample.length > 0, `${f}: ${rule} ${JSON.stringify(r.report.findings.map((x) => x.rule))}`);
  }
});

test('item 6 (plans): v50 READY, M26 0 findings with its bible and 1 with its over-budget twin; gravelPathRole M27:role; natLavaFence M20 (b) a warning', async () => {
  const fx = readJ('valid', 'v50_voc_village.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  assert.equal(rules(r.report, /^M26$/).length, 0, JSON.stringify(r.report.findings));
  assert.ok(r.report.metrics.M26.opted);
  // the batch test (§11): the answers' cost.rarity equals M26's numbers (one part writes every measured cell)
  const cr = r.check.parts[0].cost.rarity;
  const { opted, ...m26 } = r.report.metrics.M26;
  assert.ok(opted);
  assert.deepEqual(cr, m26);
  // _unsafe.overRare: the same village under a budget it breaks (uncommon and rare at 0)
  const over = { ...styleOfFixture(fx), rarity: { ...styleOfFixture(fx).rarity, uncommonShareMax: 0, rareShareMax: 0 } };
  const r2 = await run(fx, { style: over });
  assert.equal(r2.check.overall, 'READY', 'a budget never refuses');
  assert.equal(rules(r2.report, /^M26$/).length, 1, JSON.stringify(rules(r2.report, /^M26$/)));
  assert.ok(r2.check.parts[0].cost.rarity.over.length >= 1);
  // the same village with no bible: no M26 finding (no precious cell), no cost.rarity: the answers as before
  const r3 = await run(fx, { style: null });
  assert.equal(rules(r3.report, /^M26$/).length, 0);
  assert.equal(r3.check.parts[0].cost.rarity, undefined);
  // _unsafe.gravelPathRole: a bible path role of gravel (W's finding) is M27:role, a warning
  const gravel = { ...styleOfFixture(fx), roles: { ...styleOfFixture(fx).roles, path: 'minecraft:gravel' } };
  const r4 = await run(fx, { style: gravel });
  const role = rules(r4.report, /^M27:role$/);
  assert.ok(role.length === 1 && role[0].severity === 'warning' && /path is minecraft:gravel, which fails notGravity/.test(role[0].message), JSON.stringify(role));
  // _unsafe.natLavaFence: natural lava (a frozen volume's lava pocket under the square's planters: the plan never wrote it) within the
  // fire reach of plan-written flammable blocks (the planters' oak trapdoors): M20 (b), a warning; the plan's answers don't move
  const fl = [];
  const { buildVirtual } = await import('../lib/region/vworld.mjs');
  const sv = svOf(fx);
  const { vw } = buildVirtual({ ir: r.res.ir, survey: sv.bytes, blobs: (sha) => r.res.blobs.get(sha) });
  vw.eachWritten((x, y, z, idx) => { if (vw.pal.flammable[idx]) fl.push([x, y, z]); });
  assert.ok(fl.length > 0, 'v50 writes flammable blocks (the planters)');
  const [fx0, fy0, fz0] = fl[0];
  const box = { minX: fx0 - 4, minY: fy0 - 6, minZ: fz0 - 4, maxX: fx0 + 4, maxY: fy0 + 4, maxZ: fz0 + 4 };
  const vol = await fixtureVolume(box, { edits: [{ box: [fx0 + 2, fy0 - 2, fz0 - 1, fx0 + 3, fy0 - 2, fz0 + 1], class: 'LAVA' }] }, sv.bytes, sv.claim);
  const rep = checkRegion({ ir: r.res.ir, survey: sv.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: [vol.decoded], prefix: false });
  const nat = rules(rep, /^M20:natural$/);
  assert.ok(nat.length >= 1 && nat.every((x) => x.severity === 'warning' && x.sample.length > 0), JSON.stringify(rep.findings.map((x) => [x.rule, x.severity])));
  assert.equal(rules(rep, /^M20$/).length, 0, 'not M20 (a): the plan wrote no fire or lava');
});

test('item 6 (plans): v51 READY in g6cvoc_forge: the forge\'s blackstone, nether brick and magma are its own (no M26), the wall keeps its cost.bom', async () => {
  const r = await run(readJ('valid', 'v51_voc_forge.json'));
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  assert.equal(rules(r.report, /^M26$|^M27:(state|convert)$|^M20/).length, 0, JSON.stringify(r.report.findings));
  for (const a of r.check.parts) assert.ok(a.cost.rarity && a.cost.rarity.over.length === 0, `${a.part}: ${JSON.stringify(a.cost.rarity)}`);
  assert.ok(r.check.parts.find((a) => a.part === 'forge_wall').cost.bom);
});

test('cost.creativeOnly and cost.rarity without a bible: only for a part that writes a creative-only or a foreign precious block', async () => {
  const { vocabCostOf } = await import('../lib/plan/finish.mjs');
  const pc = { partOf: { a: 'p', b: 'q' }, vocabCells: { a: { hist: { 'minecraft:stone_bricks': 10, 'minecraft:beacon': 1 }, creative: { 'minecraft:barrier': 2 } }, b: { hist: { 'minecraft:lantern': 4 }, creative: {} } } };
  const p = vocabCostOf('p', pc, { opted: false, own: [] });
  assert.deepEqual(p.creativeOnly, { 'minecraft:barrier': 2 });
  assert.equal(p.rarity.precious, 1);
  assert.deepEqual(vocabCostOf('q', pc, { opted: false, own: [] }), {}, 'uncommon alone (lanterns) never adds cost.rarity');
  assert.equal(vocabCostOf('p', pc, { opted: false, own: ['minecraft:beacon'] }).rarity, undefined, 'the style\'s own precious block: no cost.rarity');
});

// ------------------------------------------------------------------ item 7: bibles

test('item 7 (kit): format-2 bibles with and without rarity validate; a bad rarity is a bible error naming its path; built-in bibles 0 errors', () => {
  for (const n of ['g6cvoc_modern', 'g6cvoc_grotto', 'g6cvoc_forge', 'g6cvoc_copper']) {
    for (const b of [vocBible(n), vocBible(`${n}_free`)]) {
      const v = validateBible(b);
      assert.ok(v.ok, `${b.id}: ${JSON.stringify(v.errors)}`);
      assert.ok(Array.isArray(v.warnings));
    }
  }
  const m = vocBible('g6cvoc_modern');
  const bad = validateBible({ ...m, rarity: { rareShareMax: 0.9, colours: ['teal'], wat: 1 } });
  assert.ok(!bad.ok && bad.errors.some((e) => /^rarity\.rareShareMax /.test(e)) && bad.errors.some((e) => /rarity\.colours: 'teal'/.test(e)) && bad.errors.some((e) => /rarity: unknown field 'wat'/.test(e)), JSON.stringify(bad.errors));
  const f1 = validateBible({ ...m, format: undefined, restraint: undefined, rarity: { preciousMax: 1 } });
  assert.ok(f1.errors.includes('rarity needs format: 2'), JSON.stringify(f1.errors));
  // a format-1 bible or a format-2 one without rarity validates exactly as before: no warnings for sound roles
  for (const n of BUILTIN_BIBLES) {
    const v = validateBible(builtinBible(n));
    assert.equal(v.errors.length, 0, `${n}: ${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.warnings, [], `${n}: role warnings ${JSON.stringify(v.warnings)}`);
  }
  // role fitness is a warning, never an error
  const g = validateBible({ ...m, roles: { ...m.roles, rail: 'minecraft:stone' } });
  assert.ok(g.ok && g.warnings.some((w) => w === 'roles.rail: minecraft:stone fails thin|tall (kit/vocab/roles.json)'), JSON.stringify(g.warnings));
});
