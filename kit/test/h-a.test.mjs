// Phase 6c slice H-a (docs/CONTRACT.md "Phase 6c slice H" §5, §7, §11, §13, §14 items 1, 4, 10, 11, 13, 15): the water bodies in the
// kit. The valid fixtures (v41 pond, v42 lava pit, v43 fountain, v44 waterfall, v45 moat, v49 farm pond) fit through the two-plan flow
// with M25, M20 and M17 clean; the refusals (fixtures/plan/h) answer their codes with evidence and a wouldFit that fits alone; a road
// crosses a moat on T3's fallback, clear 1 over the plan's water (N-H-5); ice caps (R23), the farm pond (opt-in, dry claims), the wet
// well, the bible's fluids roles, Steward's recorded waterfall and moat (§13) and the asks' gap table; determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, asksSurvey, checkPlanLocal, checkPlanVolumes, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';
import { planTwice } from './h-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { sealedByPlanWater } from '../lib/region/passes/route.mjs';
import { biomeFreezes, fluidRoles, fluidsError, FLUID_DEFAULTS } from '../lib/fluids/place.mjs';
import { outline } from '../lib/fluids/pond.mjs';
import { validateBible } from '../lib/bible.mjs';
import { sitePlan } from '../lib/region/siteplan.mjs';
import * as village from '../regions/flat_village.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';

const read = (dir, re = /./) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && re.test(f)).sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const svOf = (fx) => (fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' ? flatSurvey() : fx.on ? goldenSurvey(fx.on) : flatSurvey());
const optsOf = (fx, s = svOf(fx)) => ({ survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.biomes ? { biomes: fx.biomes } : {}) });
const run = (fx, plan = fx.plan) => (fx.volume ? checkPlanVolumes(plan, { ...optsOf(fx), volume: fx.volume }) : checkPlanLocal(plan, optsOf(fx)));
const checkOf = (fx, r) => checkRegion({ ir: r.res.ir, survey: svOf(fx).bytes, blobs: r.res.blobs, volumes: (r.volumes ?? []).map((v) => v.decoded), meta: r.res.meta });
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const H_RULES = /^(M25|M20|M17)/;

test('items 1, 11: the valid water bodies fit through the two-plan flow; M25, M20 and M17 clean over their frozen volumes', async () => {
  // (the H batch: v46-v48 are H-b's wet structures, tested in h-wet.test.mjs; H-a's water bodies are these)
  const fx = read('valid', /^v4[1-59]_/);
  assert.deepEqual(fx.map((f) => f.name.slice(0, 3)), ['v41', 'v42', 'v43', 'v44', 'v45', 'v49']);
  for (const f of fx) {
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', f.name);
    for (const a of r.check.parts) assert.equal(a.class, 'fits', `${f.name} ${a.part}: ${JSON.stringify(a.reasons ?? a.deviations)}`);
    assert.ok(r.first.res.needVolumes.every((b) => b.fluids === true), `${f.name}: every body asks a volume with its fluid layer`);
    assert.ok(r.res.ir.stages.at(-1) === 'fluids', `${f.name}: the fluids stage last`);
    const rep = checkOf(f, r);
    assert.deepEqual(rep.findings.filter((x) => H_RULES.test(x.rule)).map((x) => `${x.rule} ${x.message}`), [], f.name);
    assert.ok(rep.metrics.M25.bodies.length >= 1, f.name);
    f.r = r; f.rep = rep;
  }
  const by = Object.fromEntries(fx.map((f) => [f.name.slice(0, 3), f]));
  // v41: a natural pond, sunk, 3 deep in the middle, a clay bed and a moss rim (shell cells unlike the ground they replace)
  const g41 = part(by.v41.r, 'pond').geometry;
  assert.equal(g41.bodies.length, 1);
  assert.equal(g41.bodies[0].raised, false);
  assert.equal(g41.edge, 'natural');
  assert.ok(part(by.v41.r, 'pond').cost.bom['minecraft:clay'] > 0 && part(by.v41.r, 'pond').cost.bom['minecraft:moss_block'] > 0);
  // v42: a lava pit, one lava bucket per source (N-H-1), M20 clean with a tree beyond its reach
  const a42 = part(by.v42.r, 'pit');
  assert.equal(a42.geometry.fluid, 'lava');
  assert.equal(a42.cost.bom['minecraft:lava_bucket'], a42.geometry.bodies[0].cells);
  assert.equal(by.v42.rep.metrics.M20.flammable, 0);
  // v43: the fountain's basin and its spout, both raised; the spout's four sides fall into the basin (its spill)
  const g43 = part(by.v43.r, 'fount').geometry;
  assert.equal(g43.bodies.length, 2);
  assert.ok(g43.bodies.every((b) => b.raised));
  assert.equal(g43.bodies[1].spill, 4 * 4);
  // v44: a sculpted outcrop whose fall joins the lake (basin auto -> join)
  const g44 = part(by.v44.r, 'falls').geometry;
  assert.deepEqual([g44.lip, g44.basin, g44.drop, g44.width, g44.joins], ['sculpt', 'join', 6, 3, 3]);
  // v45: the moat outside the wall's ring, its thickness and the berm
  const g45 = part(by.v45.r, 'moat').geometry;
  assert.equal(g45.block, 'channel.moat');
  assert.ok(g45.ring >= 8 + 2 + 5, `ring ${g45.ring}`);
  // v49: two farm ponds (S-H-2: farmPond on the zone), outside the boxes, M24 counting their water
  assert.equal(by.v49.r.res.meta.waters.filter((w) => w.kind === 'farm_pond').length, 2);
  assert.ok(Object.values(by.v49.rep.metrics.M24.planWater).every((d) => d <= 4), JSON.stringify(by.v49.rep.metrics.M24));
  assert.ok(part(by.v49.r, 'farms').notes.some((n) => /farmPond: f1 gets a 3x3 pond/.test(n)));
});

test('(6c VOC batch) the fountain\'s cost.bom is the items of every cell its IR parts write (v43 with a 1-thick coping; a 2-thick one)', async () => {
  // v51's fountain stood 49 nether bricks against a bill of 46: the pillar's foot and its cells over the rim (the spout's shell among
  // them) were written but never billed
  const v43 = read('valid', /^v43_/)[0];
  const sv = svOf(v43);
  const standing = (r, id) => {
    const mine = new Set(Object.entries(r.res.meta.planCheck.partOf).filter(([, o]) => o === id).map(([k]) => k));
    const idx = new Set(r.res.ir.parts.map((p, i) => (mine.has(p.id) ? i : -1)).filter((i) => i >= 0));
    const { vw } = buildVirtual({ ir: r.res.ir, survey: sv.bytes, blobs: (s) => r.res.blobs.get(s) ?? null });
    const states = [];
    vw.eachWritten((x, y, z, vi, _f, pi) => { if (idx.has(pi) && !/^minecraft:(air|cave_air|water|lava)$/.test(vw.pal.states[vi].replace(/\[.*$/, ''))) states.push(vw.pal.states[vi]); });
    return bomOf(states);
  };
  const thin = await run(v43);
  const a = part(thin, 'fount');
  assert.equal(a.geometry.coping, 1);
  assert.deepEqual(a.cost.bom, standing(thin, 'fount'));
  // a protected grove 4 east of the fountain's square: a 1-thick coping's single breach would reach it, so the coping is 2 thick
  const [, z0, x1, z1] = a.geometry.rect;
  const thick = await run({ ...v43, protected: [{ id: 'grove', rect: [x1 + 4, z0, x1 + 10, z1] }] });
  const b = part(thick, 'fount');
  assert.equal(b.class, 'fits');
  assert.equal(b.geometry.coping, 2);
  assert.deepEqual(b.cost.bom, standing(thick, 'fount'));
});

test('item 11: the refusals answer their codes with evidence; each wouldFit fits re-checked alone', async () => {
  const fx = read('h', /^r\d/);
  assert.ok(fx.length >= 10);
  for (const f of fx) {
    const r = await run(f);
    const a = part(r, f.expect.part);
    assert.equal(a.class, f.expect.class ?? 'refused', `${f.name}: ${JSON.stringify(a)}`);
    if (f.expect.code) assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f.name}: evidence`);
    if (f.expect.kind) assert.equal(a.reasons[0].evidence.kind, f.expect.kind, f.name);
    if (f.expect.block) assert.deepEqual([a.block, a.reasons[0].until], [f.expect.block, f.expect.until], f.name);
    assert.ok(!/until.{0,4}\bH\b/.test(JSON.stringify(a)), `${f.name}: no until H`);
    if (f.expect.wouldFit) {
      assert.ok(a.wouldFit?.length, `${f.name}: a wouldFit`);
      const frag = a.wouldFit[0].fragment;
      assert.equal(frag.kind, f.expect.wouldFit, f.name);
      const fam = frag.kind === 'channel' ? 'connectors' : 'forms';
      const plan = { ...f.plan, [fam]: (f.plan[fam] ?? []).map((q) => (q.id === frag.id ? frag : q)) };
      const again = await run(f, plan);
      assert.ok(['fits', 'adjusted'].includes(part(again, frag.id).class), `${f.name}: the wouldFit alone: ${JSON.stringify(part(again, frag.id))}`);
    }
  }
});

test('§7.4, N-H-5: a road crosses the moat on T3\'s fallback (adjusted), clear 1 over the plan\'s water, landing near the wall\'s gate; a closed moat fails a walk at once', async () => {
  const [f] = read('h', /^v45b_/);
  const r = await run(f);
  const a = part(r, 'in');
  assert.equal(a.class, 'adjusted');
  assert.equal(a.deviations[0].what, 'crossing');
  const br = a.geometry.bridges[0];
  assert.equal(br.crossing.over, 'water');
  assert.equal(br.crossing.clearance, 1);
  const gate = part(r, 'town_wall').geometry.gates.find((g) => g.auto);
  assert.ok(Math.abs(br.to[0] - gate.at[0]) + Math.abs(br.to[2] - gate.at[2]) <= 12, `the far landing ${br.to} near the gate ${gate.at}`);
  assert.deepEqual(checkOf(f, r).findings.filter((x) => H_RULES.test(x.rule) || x.rule.startsWith('M10')), []);
  // the seal test: a ring of plan water round one end
  const W = 9, pw = new Uint8Array(81);
  for (let i = 1; i < 8; i++) for (const [x, z] of [[i, 1], [i, 7], [1, i], [7, i]]) pw[x + z * W] = 1;
  assert.equal(sealedByPlanWater(pw, W, 9, 4 + 4 * W, 0), true);
  pw[4 + W] = 0;
  assert.equal(sealedByPlanWater(pw, W, 9, 4 + 4 * W, 0), false);
});

test('§1.3, R23: an ice cap where the biome freezes; ice: true elsewhere noted, not read; the interim freezing table', async () => {
  const s = flatSurvey();
  const snowy = { minX: 1000, minZ: 2000, res: 4, width: 60, depth: 40, palette: ['minecraft:snowy_plains'], ids: Array(2400).fill(0) };
  const plan = { schemaVersion: 'plan/0', forms: [{ id: 'pond', kind: 'pond' }] };
  const o = { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} };
  const cold = await checkPlanVolumes(plan, { ...o, biomes: snowy });
  const b = part(cold, 'pond').geometry.bodies[0];
  assert.ok(b.ice > 0 && part(cold, 'pond').cost.bom['minecraft:ice'] === b.ice);
  assert.ok(part(cold, 'pond').notes.some((n) => /capped with ice/.test(n)));
  assert.equal(cold.res.meta.waters[0].ice, b.ice);
  const warm = await checkPlanVolumes({ ...plan, forms: [{ id: 'pond', kind: 'pond', ice: true }] }, o);
  assert.equal(part(warm, 'pond').geometry.bodies[0].ice, 0);
  assert.ok(part(warm, 'pond').notes.some((n) => /R23/.test(n)));
  assert.equal(biomeFreezes('minecraft:snowy_plains', 64), true);
  assert.equal(biomeFreezes('minecraft:plains', 64), false);
  assert.equal(biomeFreezes('minecraft:taiga', 64), false);
  assert.equal(biomeFreezes('minecraft:taiga', 200), true);
});

test('§7.5, S-H-2: the farm pond is opt-in; never on a claim with surface water; farmPond false plans as before', async () => {
  const s = flatSurvey();
  const o = { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim) };
  const zone = (extra = {}) => ({ schemaVersion: 'plan/0', zones: [{ id: 'farms', ...extra, program: { lots: [{ id: 'f1', type: 'farm', size: [13, 11], villager: 'farm' }, { id: 'h1', type: 'house', size: [9, 9] }] } }] });
  const plain = await checkPlanLocal(zone(), o);
  const off = await checkPlanLocal(zone({ farmPond: false }), o);
  assert.ok(!plain.res.ir.stages.includes('fluids'));
  const strip = (r) => r.res.irJson.replace(/"params":\{.*?"plan":/, '');
  assert.equal(strip(off).length > 0, true);
  assert.deepEqual(off.res.ir.stages, plain.res.ir.stages);
  assert.equal(off.res.meta.waters, undefined);
  // a claim with surface water (the asks' lake): no farm pond, the note says why
  const A = asksSurvey();
  const wet = await checkPlanVolumes(zone({ farmPond: true }), { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim), volume: {} });
  assert.equal(wet.res.meta.waters, undefined);
  assert.ok(part(wet, 'farms').notes.some((n) => /S-H-1: dry claims only/.test(n)));
});

test('§7.6: the wet well (flat_village wellWater, off by default: the stage list unchanged)', async () => {
  const s = flatSurvey();
  const lots = [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'cottage', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }, { id: 'h4', type: 'house', size: [9, 9] }];
  const src = fs.readFileSync(path.join(ROOT, 'kit', 'regions', 'flat_village.mjs'), 'utf8');
  const o = { program: village, programSource: src, survey: s.bytes, claim: s.claim, seed: '7', node: 'test' };
  const wet = await planTwice({ ...o, params: { lots, wellWater: true } });
  assert.deepEqual(wet.ir.stages, ['ground', 'street', 'lots', 'props', 'fluids']);
  assert.deepEqual(wet.meta.waters.map((w) => [w.kind, w.cells, w.shell]), [['well', 1, 9]]);
  const rep = checkRegion({ ir: wet.ir, survey: s.bytes, blobs: wet.blobs, volumes: wet.volumes.map((v) => v.decoded), meta: wet.meta });
  assert.deepEqual(rep.findings.filter((x) => H_RULES.test(x.rule)), []);
  const dry = await planTwice({ ...o, params: { lots } });
  assert.deepEqual(dry.ir.stages, ['ground', 'street', 'lots', 'props']);
  assert.equal(dry.ir.params.wellWater, undefined, 'omitted at its default');
  assert.ok(JSON.stringify(dry.ir).includes('water_cauldron'));
});

test('§11: the bible\'s fluids member (format 2): checked against the roles, the default chains, a bible slot restyles the bed', async () => {
  assert.equal(fluidsError(undefined), null);
  assert.match(fluidsError({ pool: 'trim' }), /unknown slot/);
  assert.match(fluidsError({ bed: 'nope' }, { trim: 'minecraft:stone' }), /not a role/);
  assert.deepEqual(Object.keys(FLUID_DEFAULTS), ['bed', 'rim', 'coping', 'spout', 'quay', 'mooring']);
  const roles = { subsurface: 'minecraft:dirt', foundation: 'minecraft:cobblestone', surface: 'minecraft:grass_block', trim: 'minecraft:sand', structure: 'minecraft:stone_bricks', path: 'minecraft:gravel', frame: 'minecraft:oak_log' };
  const fr = fluidRoles(roles);
  assert.deepEqual([fr.bed.role, fr.rim.role, fr.coping.role, fr.spout.role], ['subsurface', 'surface', 'structure', 'structure'], 'sand (a gravity block) never lines a body: the coping falls to structure');
  assert.equal(fluidRoles(roles, { bed: 'foundation' }).bed.block, 'minecraft:cobblestone');
  const s = flatSurvey();
  const plan = { schemaVersion: 'plan/0', forms: [{ id: 'pond', kind: 'pond', where: { near: { anchor: 'stone', within: 16 } } }] };
  const { planRegion } = await import('../lib/region/plan.mjs');
  const base = { programFile: path.join(ROOT, 'kit', 'regions', 'plan_v0.mjs'), params: { plan, anchors: { anchors: stewardAnchors(s.claim) } }, survey: s.bytes, claim: s.claim, roles: {} };
  const a = await planRegion(base);
  const b = await planRegion({ ...base, fluids: { bed: 'foundation' } });
  assert.ok(!a.irJson.includes('cobblestone') || a.irJson !== b.irJson);
  assert.notEqual(a.irSha, b.irSha);
  await assert.rejects(planRegion({ ...base, fluids: { bed: 'nope' } }), /not a role/);
  const bib = validateBible({ id: 'b', name: 'b', version: 1, format: 2, prompt: 'p', scope: 'building', roles: { ...roles, wall: 'minecraft:stone', wall_alt: 'minecraft:stone', roof: 'minecraft:stone', floor: 'minecraft:stone', accent: 'minecraft:stone', light: 'minecraft:lantern', glass: 'minecraft:glass', rock: 'minecraft:stone', rubble: 'minecraft:cobblestone', rail: 'minecraft:oak_fence' }, fluids: { bed: 'nope' } });
  assert.ok(bib.errors.some((e) => /fluids\.bed/.test(e)), JSON.stringify(bib.errors));
});

test('item 10, §13: Steward\'s recorded waterfall and moat; the asks\' gap table (form.waterfall 1 -> 0, connector.channel 1 -> 0)', async () => {
  const A = asksSurvey();
  const o = { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim), volume: {} };
  const ask = (n) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks', `${n}.json`), 'utf8')).answer.plan;
  const hv = await checkPlanVolumes(ask('hidden_village'), o);
  const wf = part(hv, 'waterfall_curtain');
  assert.equal(wf.class, 'adjusted');
  assert.deepEqual([wf.geometry.lip, wf.geometry.basin, wf.geometry.outcrop], ['sculpt', 'join', 6]);
  assert.ok(wf.deviations.some((d) => d.kind === 'hollow' && d.block === 'form.hidden_room'), 'S-H-7: the hollow named');
  assert.ok(wf.notes.some((n) => /existing waterfall/.test(n)));
  const rg = await checkPlanVolumes(ask('redstone_gate'), o);
  const moat = part(rg, 'moat');
  assert.equal(moat.class, 'fits');
  assert.equal(moat.geometry.width, 5);
  assert.equal(moat.geometry.depth, 3);
  assert.equal(part(rg, 'drawbridge').class, 'unsupported');
  const before = fs.readFileSync(path.join(FIX, 'h', 'asks-gap-before.txt'), 'utf8'), after = fs.readFileSync(path.join(FIX, 'h', 'asks-gap-after-ha.txt'), 'utf8');
  const gapOf = (t, id) => Number((new RegExp(`^  ${id.replace('.', '\\.')}\\s+(\\d+)$`, 'm').exec(t) ?? [0, 0])[1]);
  // (before: v0.36.0's table, origin/main; asks-gap-hcore.txt records h/core round 1's, where both answered UNREACHABLE until Ha)
  assert.deepEqual([gapOf(before, 'form.waterfall'), gapOf(after, 'form.waterfall'), gapOf(before, 'connector.channel'), gapOf(after, 'connector.channel')], [1, 0, 1, 0]);
  // the classes that changed between the two tables: only H-a's two recorded parts
  const lines = (t) => new Map(t.split('\n').filter((l) => !l.startsWith('#') && l.includes('/') && !l.startsWith('  ')).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before), la = lines(after);
  const changed = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k).sort();
  assert.deepEqual(changed, ['hidden_village/waterfall_curtain', 'redstone_gate/moat']);
  assert.ok(!/until H\b/.test(after));
});

test('item 15: determinism: three checks of a waterfall give the same answers and artifact', async () => {
  const [f] = read('valid', /^v44_/);
  const shas = new Set();
  for (let i = 0; i < 3; i++) { const r = await run(f); shas.add(`${r.artifactSha} ${r.res.irSha}`); }
  assert.equal(shas.size, 1);
});

test('the outline, siteplan waters (farm_pond, well), and lava only in a pit (R22)', async () => {
  const o = outline({ minX: 0, minZ: 0, maxX: 8, maxZ: 6 }, 'round');
  assert.ok(o.length < 63 && o.length > 40);
  assert.equal(Math.max(...o.map((c) => c.ring)), 4);
  const meta = { format: 1, paths: {}, lots: {}, parts: {}, waters: [{ id: 'w_f1_pond', part: 'farms', kind: 'farm_pond', fluid: 'water', level: 63, cells: 9, spill: 0, ice: 0 }, { id: 'well_1_water', part: null, kind: 'well', fluid: 'water', level: 64, cells: 1, spill: 0, ice: 0 }] };
  const ir = { claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 0, maxY: 128 }, stages: ['ground', 'fluids'], lots: [], roads: [], paths: [], anchors: { entrance: [1, 65, 1], spawn: [1, 65, 1] }, parts: [] };
  assert.deepEqual(sitePlan({ ir, meta, planId: 'p', irSha: 'x'.repeat(64) }).waters.map((w) => w.kind), ['farm_pond', 'well']);
  const s = flatSurvey();
  const r = await checkPlanLocal({ schemaVersion: 'plan/0', forms: [{ id: 'falls', kind: 'waterfall', params: { fluid: 'lava' } }] }, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim) });
  assert.deepEqual([part(r, 'falls').class, part(r, 'falls').reasons[0].code, part(r, 'falls').reasons[0].evidence.kind], ['refused', 'FIRE', 'lava']);
});
