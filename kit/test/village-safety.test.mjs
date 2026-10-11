// Phase 6c slice W (docs/CONTRACT.md "Phase 6c slice W: village safety"): item 4, gravity blocks over gaps. 500 seeded
// synthetic claims with random 1-3 deep gaps (water to its bed) under lanes, verges and aprons, with gravel, sand and concrete
// powder as `path`: 0 M3:gravity on the plan's virtual world. The broken variant: a gravel lane over a 2-deep gap with the rule
// off is caught (M3:gravity on the lanes part).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { isGravity } from '../lib/blocks.mjs';
import * as flatVillage from '../regions/flat_village.mjs';
import { build } from '../regions/flat_village.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROGRAM = path.join(KIT, 'regions', 'flat_village.mjs');

function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (l) => l[Math.floor(f() * l.length)];
  return f;
}

/** A flat survey at y with gap columns: "x,z" -> depth (water from the bed y - depth up to y). */
function gapSurvey(claim, gaps = new Map(), y = 64) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W, d = gaps.get(`${claim.minX + i},${claim.minZ + j}`) ?? 0;
    c.ground[k] = y; c.height[k] = y; c.floor[k] = y - d; c.flags[k] = d ? 1 : 0;
  }
  return c;
}

const LOTS = [
  { id: 'a', type: 'cottage', size: [11, 12], villager: 'dwelling' },
  { id: 'b', type: 'smithy', size: [9, 9], villager: 'job' },
  { id: 'c', type: 'cottage', size: [11, 12], villager: 'dwelling' },
  { id: 'd', type: 'shop', size: [9, 11], villager: 'none' },
];

test('blocks.mjs: the generated gravity flag (FallingBlock) covers the path blocks the rule must catch', () => {
  for (const b of ['minecraft:gravel', 'minecraft:sand', 'minecraft:red_sand', 'minecraft:white_concrete_powder', 'minecraft:anvil']) assert.ok(isGravity(b), b);
  for (const b of ['minecraft:dirt', 'minecraft:coarse_dirt', 'minecraft:packed_mud', 'minecraft:stone_bricks', 'minecraft:oak_planks', 'minecraft:dirt_path']) assert.ok(!isGravity(b), b);
});

test('gravity: 500 seeded claims, 1-3 deep gaps under lanes, verges and aprons, gravel / sand / concrete powder paths: 0 M3:gravity', async () => {
  const paths = ['minecraft:gravel', 'minecraft:sand', 'minecraft:lime_concrete_powder'];
  let planned = 0, gapCells = 0, fixed = 0;
  for (let n = 0; n < 500; n++) {
    const R = rng(7000 + n);
    const W = R.int(72, 104), D = R.int(72, 104);
    const claim = { minX: R.int(-200, 200), minZ: R.int(-200, 200), minY: -64, maxY: 319 };
    claim.maxX = claim.minX + W - 1; claim.maxZ = claim.minZ + D - 1;
    const roles = { path: paths[n % 3] };
    const params = { lots: LOTS.slice(0, R.int(2, 4)), squareSize: R.pick([9, 11]), laneWidth: R.int(1, 3), lamps: 'none', apronLamps: false };
    // the dry plan gives the lanes, verges and aprons; gaps go under a random share of them, then the claim is planned again
    const dry = await planRegion({ programFile: PROGRAM, node: 'test', params, survey: gapSurvey(claim), claim, roles, seed: String(n) });
    const v = dry.meta.village;
    const under = [];
    for (const cells of Object.values(v.lanes)) for (const [x, , z] of cells) under.push([x, z]);
    for (const l of dry.ir.lots) {
      const b = l.box;
      for (let x = b.minX - 1; x <= b.maxX + 1; x++) under.push([x, b.minZ - 1], [x, b.maxZ + 1]);
      for (let z = b.minZ; z <= b.maxZ; z++) under.push([b.minX - 1, z], [b.maxX + 1, z]);
    }
    const road = v.roads.length ? dry.ir.roads : [];
    for (const r of road) {
      const [a, b] = [r.points[0], r.points[r.points.length - 1]];
      const along = a[0] !== b[0];
      for (let t = Math.min(along ? a[0] : a[2], along ? b[0] : b[2]); t <= Math.max(along ? a[0] : a[2], along ? b[0] : b[2]); t++) for (const dv of [-2, 2]) under.push(along ? [t, a[2] + dv] : [a[0] + dv, t]);
    }
    const gaps = new Map();
    for (const [x, z] of under) if (R() < 0.15) gaps.set(`${x},${z}`, R.int(1, 3));
    let p;
    try {
      p = await planRegion({ programFile: PROGRAM, node: 'test', params, survey: gapSurvey(claim, gaps), claim, roles, seed: String(n) });
    } catch (e) {
      assert.match(e.message, /^flat village:/, `claim ${n}: ${e.message}`);
      continue;
    }
    planned++;
    gapCells += gaps.size;
    for (const g of Object.values(p.meta.gravity ?? {})) fixed += g.under + g.swap;
    const rep = checkRegion({ ir: p.ir, survey: gapSurvey(claim, gaps), meta: p.meta, prefix: false, rules: ['M3'] });
    const grav = rep.findings.filter((f) => f.rule === 'M3:gravity');
    assert.equal(grav.length, 0, `claim ${n} (${roles.path}): ${grav.map((f) => `${f.part} x${f.count} ${JSON.stringify(f.sample.slice(0, 3))}`).join('; ')}`);
  }
  assert.ok(planned >= 400, `most claims plan (${planned})`);
  assert.ok(fixed > 1000, `the rule did work (${fixed} cells fixed over ${gapCells} gap columns)`);
});

test('gravity broken variant: a gravel verge (where the lanes meet the street) over a 2-deep gap, the rule off: M3:gravity on the verges', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 95, maxZ: 95, minY: -64, maxY: 319 };
  const params = { lots: LOTS.slice(0, 2), laneWidth: 2, lamps: 'none' };
  const dry = await planRegion({ programFile: PROGRAM, node: 'test', params, survey: gapSurvey(claim), claim, roles: { path: 'minecraft:gravel' } });
  // 2 fluid cells under the verge's top (water from the bed at y - 3 up to the ground y), away from the lots' aprons
  const gaps = new Map();
  const nearLot = (x, z) => dry.ir.lots.some((l) => x >= l.box.minX - 2 && x <= l.box.maxX + 2 && z >= l.box.minZ - 2 && z <= l.box.maxZ + 2);
  for (const r of dry.ir.roads) {
    const [a, b] = [r.points[0], r.points[r.points.length - 1]];
    const along = a[0] !== b[0];
    for (let t = Math.min(along ? a[0] : a[2], along ? b[0] : b[2]); t <= Math.max(along ? a[0] : a[2], along ? b[0] : b[2]); t++) for (const dv of [-2, 2]) {
      const [x, z] = along ? [t, a[2] + dv] : [a[0] + dv, t];
      if (!nearLot(x, z)) gaps.set(`${x},${z}`, 3);
    }
  }
  assert.ok(gaps.size > 10);
  const survey = gapSurvey(claim, gaps);
  const run = (off) => planRegion({ program: { id: 'flat_village_gravity_off', params: flatVillage.params, roles: flatVillage.roles, default: (ctx) => build(ctx, { _unsafe: { noGravityRule: off } }) },
    programSource: `gravity ${off}`, params, survey, claim, roles: { path: 'minecraft:gravel' }, node: 'test' });
  const off = await run(true);
  const bad = checkRegion({ ir: off.ir, survey, meta: off.meta, prefix: false, rules: ['M3'] });
  const f = bad.findings.find((x) => x.rule === 'M3:gravity');
  assert.ok(f && f.part === 'verges' && f.severity === 'warning', JSON.stringify(bad.findings.map((x) => [x.rule, x.part, x.count])));
  const good = await run(false);
  assert.equal(checkRegion({ ir: good.ir, survey, meta: good.meta, prefix: false, rules: ['M3'] }).findings.filter((x) => x.rule === 'M3:gravity').length, 0);
});

// ------------------------------------------------------------------ item 3: frozen water

/** A flat survey at y with a frozen river (ice over 3 water, bed at y - 4) along z in [z0, z1]; `asGround`: the old reading. */
function riverSurvey(claim, [z0, z1], { asGround = false, y = 64 } = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const c = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W, z = claim.minZ + j, ice = z >= z0 && z <= z1;
    c.ground[k] = y; c.height[k] = y;
    c.floor[k] = ice && !asGround ? y - 4 : y;
    c.flags[k] = ice && !asGround ? 1 | 16 : 0; // WATER | FROZEN
  }
  return c;
}

test('frozen water: FROZEN is water (the street keeps off the frozen river, or the plan is refused naming a frozen column)', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const params = { lots: LOTS, lamps: 'none' };
  // frozen water over most of the claim: no street or square fits, and the refusal names a frozen column
  let refused = null;
  try { await planRegion({ programFile: PROGRAM, node: 'test', params, survey: riverSurvey(claim, [8, 103]), claim }); } catch (e) { refused = e.message; }
  assert.match(refused ?? '', /^flat village: .*frozen water (under the shared space )?at -?\d+,-?\d+/, refused);
  // the broken reading (ice as dry ground, FROZEN ignored): the plan is clean over the river (4e then refuses DEEP_WATER at realise)
  const blind = await planRegion({ programFile: PROGRAM, node: 'test', params, survey: riverSurvey(claim, [8, 103], { asGround: true }), claim });
  assert.ok(blind.ir.roads.length > 0);
  // a river across the claim: the plan places the street and the lots off it (no lot, lane or street column stands on it)
  for (const band of [[0, 9], [40, 52]]) {
    const ok = await planRegion({ programFile: PROGRAM, node: 'test', params, survey: riverSurvey(claim, band), claim });
    const on = (z) => z >= band[0] && z <= band[1];
    for (const l of ok.ir.lots) for (let z = l.box.minZ - 1; z <= l.box.maxZ + 1; z++) assert.ok(!on(z), `lot ${l.id} off the river ${band}`);
    for (const r of ok.ir.roads) for (const p of r.points) assert.ok(!on(p[2]), `road ${r.id} off the river ${band}`);
    for (const cells of Object.values(ok.meta.village.lanes)) for (const c of cells) assert.ok(!on(c[2]), `lanes off the river ${band}`);
  }
});

test('frozen water: a farm needs unfrozen water (M24 counts WATER without FROZEN); near_water counts frozen water', async () => {
  const claim = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
  const lots = [{ id: 'farm_1', type: 'farm', size: [14, 17], villager: 'farm', placement: 'near_water' }, ...LOTS.slice(0, 2)];
  const p = await planRegion({ programFile: PROGRAM, node: 'test', params: { lots, lamps: 'none' }, survey: riverSurvey(claim, [0, 6]), claim });
  const f = p.meta.village.lots.farm_1;
  assert.equal(f.water, null, 'M24: no unfrozen water');
  assert.equal(p.meta.village.waterAny, false);
  const ext = p.ir.lots.find((l) => l.id === 'farm_1').ext['architect_mc:village'];
  assert.ok(ext.water !== null, 'the ext\'s near_water distance counts the frozen river');
});

// ------------------------------------------------------------------ item 1 and the coordinator's addition: fixtures, lightCover

import fs from 'node:fs';
import { DEFAULT_FIXTURE, fixtureCells, fixtureFor, roadLamp } from '../lib/region/fixtures.mjs';
import { buildVirtual, F_WALK } from '../lib/region/vworld.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';

test('fixtures: picked from the bible\'s light role, light levels from the blocks\' own emission', () => {
  const lv = (l) => fixtureFor(l).level;
  assert.equal(lv('minecraft:lantern'), 15);
  assert.equal(lv('minecraft:soul_lantern'), 10);
  assert.equal(lv('minecraft:torch'), 14);
  assert.equal(lv('minecraft:soul_torch'), 10);
  assert.equal(lv('minecraft:end_rod'), 14);
  assert.equal(lv('minecraft:sea_lantern'), 15);
  const kinds = ['minecraft:lantern', 'minecraft:soul_lantern', 'minecraft:torch', 'minecraft:end_rod', 'minecraft:sea_lantern', 'minecraft:lantern[hanging=true]'].map((l) => fixtureFor(l).kind);
  assert.deepEqual(kinds, ['lantern_post', 'soul_lantern_post', 'torch_post', 'end_rod', 'bollard', 'hanging_lantern']);
  assert.equal(fixtureFor(undefined).kind, 'lantern_post', 'no light role: the lantern post');
  assert.equal(fixtureFor('minecraft:lantern', 'minecraft:spruce_fence').post.replace(/\[.*$/, ''), 'minecraft:spruce_fence', 'the post in the bible\'s wood');
  assert.equal(roadLamp(DEFAULT_FIXTURE), null, '4e\'s own fence and lantern: no road lamp member');
  assert.equal(roadLamp(fixtureFor('minecraft:soul_lantern')).every, 8, 'a weaker light: closer street lamps');
  // the gibbet: 3 posts, the arm one cell out at the top (joined), the lantern hanging under the arm
  const g = fixtureCells(fixtureFor('minecraft:lantern[hanging=true]'), [0, 65, 0], { arm: 'east' });
  assert.deepEqual(g.lightAt, [1, 66, 0]);
  assert.match(g.cells[2][3], /east=true/);
  assert.match(g.cells[3][3], /west=true/);
  assert.match(g.cells[4][3], /hanging=true/);
});

const GOLD = path.join(KIT, '..', 'scenarios', 'goldens', 's7');
const s7 = () => {
  const ir = JSON.parse(fs.readFileSync(path.join(GOLD, 'ir.json'), 'utf8'));
  return { ir, survey: fs.readFileSync(path.join(GOLD, 'survey.bin')) };
};
const planS7 = (roles, hooks = null) => {
  const { ir, survey } = s7();
  const claim = { ...ir.claim, minY: -64, maxY: 319 };
  const o = { params: ir.params, roles: { ...ir.roles, ...roles }, survey, claim, seed: ir.seed, node: 'test' };
  if (!hooks) return planRegion({ programFile: PROGRAM, ...o });
  return planRegion({ program: { id: 'flat_village_broken', params: flatVillage.params, roles: flatVillage.roles, default: (ctx) => build(ctx, hooks) }, programSource: 'broken lamps', ...o });
};

test('lightCover on S7 (its pinned survey and lots): the lots\' aprons and batters lit, at most 4 lamps a lot, never on a walk cell, a lot box, the bell area or golem space; ext lamps; siteplan props; deterministic', async () => {
  const p = await planS7({});
  const v = p.meta.village, a = v.apronLamps;
  assert.ok(a.before.share > 0.01, `dark before ${a.before.share}`);
  assert.ok(a.after.share < 0.005, `dark after ${a.after.share}`);
  assert.equal(a.capped, false);
  for (const n of Object.values(a.perLot)) assert.ok(n <= 4);
  const lamps = v.props.filter((q) => q.kind === 'apron_lamp');
  assert.equal(lamps.length, Object.values(a.perLot).reduce((x, y) => x + y, 0));
  assert.ok(p.notes.some((n) => /^apron lamps \(lantern_post, light 15\): /.test(n)), 'the per-lot counts in the notes');
  const { vw } = buildVirtual({ ir: p.ir, survey: s7().survey, blobs: () => null });
  const area = new Set(v.bellArea.map(([x, z]) => `${x},${z}`)), golem = new Set(v.golem.map(([x, z]) => `${x},${z}`));
  for (const l of lamps) for (const [x, y, z] of l.cells) {
    assert.ok(!p.ir.lots.some((b) => x >= b.box.minX && x <= b.box.maxX && z >= b.box.minZ && z <= b.box.maxZ), `${l.id} outside the lot boxes`);
    assert.ok(!(vw.flags(x, y - 1, z) & F_WALK) && !(vw.flags(x, y, z) & F_WALK), `${l.id} not on a walk cell`);
    assert.ok(!area.has(`${x},${z}`) && !golem.has(`${x},${z}`), `${l.id} off the bell area and golem space`);
  }
  // each lot's ext carries its lamp positions
  for (const l of p.ir.lots) assert.deepEqual(l.ext['architect_mc:village'].lamps, lamps.filter((q) => q.lot === l.id).map((q) => q.cells[0].slice(0, 3)));
  // the checker: every walk node still reached, no M3 on the lamps
  const rep = checkRegion({ ir: p.ir, survey: s7().survey, meta: p.meta, prefix: false });
  assert.equal(rep.metrics.M2.reached, rep.metrics.M2.nodes);
  assert.ok(!rep.findings.some((f) => f.part === 'props_apron'), rep.findings.map((f) => `${f.rule} ${f.part}`).join('; '));
  const sp = sitePlan({ ir: p.ir, meta: p.meta, vw });
  assert.deepEqual(validateSchema(sp), []);
  assert.equal(sp.props.filter((q) => q.kind === 'apron_lamp').length, lamps.length);
  for (const l of sp.lots) assert.equal(l.lamps, a.perLot[l.id]);
  assert.equal((await planS7({})).irSha, p.irSha, 'deterministic');
  // the broken variant: no apron lamps
  const off = await planS7({}, { _unsafe: { noApronLamps: true } });
  assert.ok(!off.ir.parts.some((q) => q.id === 'props_apron'));
});

test('lightCover with the bible\'s fixtures: infernal (soul lantern), coastal (sea lantern), gibbet; a weak light takes more lamps, never over 4 a lot', async () => {
  const counts = {};
  for (const [name, light, rail] of [['infernal', 'minecraft:soul_lantern', 'minecraft:crimson_fence'], ['coastal', 'minecraft:sea_lantern', 'minecraft:birch_fence'], ['gibbet', 'minecraft:lantern[hanging=true]', 'minecraft:dark_oak_fence']]) {
    const p = await planS7({ light, rail });
    const a = p.meta.village.apronLamps;
    counts[name] = Object.values(a.perLot).reduce((x, y) => x + y, 0);
    for (const n of Object.values(a.perLot)) assert.ok(n <= 4, name);
    // a weak light that can't cover within 4 says so in the note
    if (a.capped) assert.ok(p.notes.some((n) => /capped at 4 per lot: not covered/.test(n)), name);
    else assert.ok(a.after.share < 0.005, `${name}: ${a.after.share}`);
    const block = (s) => s.replace(/\[.*$/, '');
    const lamps = p.meta.village.props.filter((q) => q.kind === 'apron_lamp' || q.kind === 'lamp');
    assert.ok(lamps.length && lamps.every((q) => q.cells.some((c) => block(c[3]) === block(light))), `${name}: the lamps carry the bible's light`);
    assert.ok(lamps.every((q) => q.cells.every((c) => block(c[3]) === block(light) || block(c[3]) === rail)), `${name}: the posts in the bible's wood`);
    // the street's lanterns: the bible's fixture (format 2, road:lamp) unless it is 4e's own
    for (const r of p.ir.roads) assert.ok(r.lamp && r.lamp.cells.some((c) => block(c[2]) === block(light)), `${name}: road ${r.id}`);
    assert.ok(p.ir.requires.includes('road:lamp'));
  }
  assert.ok(counts.infernal > counts.coastal, `the soul lantern (10) needs more lamps than the sea lantern (15): ${JSON.stringify(counts)}`);
});
