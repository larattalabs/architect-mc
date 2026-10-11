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
    const params = { lots: LOTS.slice(0, R.int(2, 4)), squareSize: R.pick([9, 11]), laneWidth: R.int(1, 3), lamps: 'none' };
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
