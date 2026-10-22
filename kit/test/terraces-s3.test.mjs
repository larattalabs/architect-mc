// Slice S3 (docs/CONTRACT.md "Phase 6c slice S3: the mountainside monastery v1, terraced, goes green" §2, §3, §9 item 2): the terrace's
// blended edge, the zone member `terraces` (levels, rise, retain, the flat-site note, the districts form and the standard zone form)
// and the broken variants `unretained` (a rim over 2 with no wall: the rims check and M8 catch it) and `spring_buried` (a fill over
// S3's kept spring columns: the program's own check refuses the plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { region } from '../lib/region/program.mjs';
import { makeColumns, encodeColumns } from '../lib/region/pack.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { validateLots } from '../lib/params.mjs';
import { layoutTerraces, parseTerraces, TERRACES, junctionOf } from '../lib/region/terraces.mjs';
import { checkPlanLocal, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';
import { columnsOf, windowOf } from './region-helpers.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A slope rising 1 every `per` cells in x from y (dry, treeless): its survey bytes and claim. */
function slope({ W = 160, D = 160, x0 = 0, z0 = 0, y = 64, per = 2 } = {}) {
  const c = makeColumns(x0, z0, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const k = i + j * W, g = y + Math.floor(i / per); c.ground[k] = g; c.height[k] = g; c.floor[k] = g; }
  return { bytes: encodeColumns(c), claim: { minX: x0, minZ: z0, maxX: x0 + W - 1, maxZ: z0 + D - 1, minY: -64, maxY: 319 } };
}
const LOTS = [['a', 'house', 9, 9], ['b', 'house', 9, 9], ['c', 'cottage', 9, 9], ['d', 'barn', 11, 9]].map(([id, type, w, d]) => ({ id, type, size: [w, d] }));
const plan = (zone, extra = {}) => ({ schemaVersion: 'plan/0', planId: 't_s3', zones: [zone], forms: [], connectors: [], ...extra });
const district = (T, more = {}) => ({ id: 'town', program: { districts: [{ id: 'hill', size: { w: 64, d: 64 }, terraces: T, lots: LOTS }] }, ...more });
const check = (p, s) => checkPlanLocal(p, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim) });
const reportOf = (r, s) => checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha), meta: r.res.meta });

/** The rims (CONTRACT S3 §7 bar 5) on the virtual world: each terraced lot's ring (Chebyshev 2 out of its footprint, its approach aside)
 * whose land stands more than 2 under the pad's top. */
function openRims(r, s, terraces) {
  const { vw } = buildVirtual({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) });
  const P = vw.pal;
  let open = 0, rims = 0;
  const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  for (const t of Object.values(terraces)) for (const tl of t.lots) {
    const l = r.res.ir.lots.find((q) => q.id === tl.id), b = l.box, top = b.minY - 1;
    const e = r.res.meta.lots[l.id].entrance, f = CARD[l.front];
    const inApproach = (x, z) => [...Array(8).keys()].some((k) => [-2, -1, 0, 1, 2].some((v) => e[0] + f[0] * k + f[1] * v === x && e[2] + f[1] * k + f[0] * v === z));
    for (let z = b.minZ - 2; z <= b.maxZ + 2; z++) for (let x = b.minX - 2; x <= b.maxX + 2; x++) {
      if (Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ) !== 2 || inApproach(x, z)) continue;
      let y = top;
      while (y > top - 12 && !P.solid[vw.get(x, y, z)]) y--;
      rims++;
      if (top - y > 2) open++;
    }
  }
  return { open, rims };
}

// ------------------------------------------------------------------ §2: the terrace's blended edge

const RELIEF = (fn) => ({ id: 't_blend', default: fn, passes: ['relief'] });
async function planBlend(build, { per = 6, passes = ['relief'] } = {}) {
  const world = (x) => { const g = 60 + Math.floor(x / per); return { g, h: g, f: g - 8, flags: 0 }; };
  const claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const survey = columnsOf(world, 0, 0, 192, 192, 1);
  const out = {};
  const fn = (ctx) => { const r = region(ctx); r.stages(['main']); build(r, out); r.anchor('spawn', [10, 70, 10]); r.anchor('entrance', [11, 70, 10]); return r; };
  const res = await planRegion({ program: { id: 't_blend', default: fn, passes }, programSource: fn.toString(), survey, seed: '1', claim, node: 't' });
  return { res, out, world };
}
const realise = (res, world) => {
  const cells = new Map();
  const blobs = Object.fromEntries([...res.blobs]);
  for (const st of res.ir.stages) for (const set of ['terrain', 'path']) for (const key of res.ir.tiles[st][set]) for (const c of unpack(evalTile(res.ir, key, windowOf(world, key), { stage: st, set, blobs }).payload).cells) cells.set(`${c.x},${c.y},${c.z}`, c.state);
  return cells;
};

test("terrace edge 'blend': only with the relief pass declared; an unpinned blend terrace refuses the plan", async () => {
  await assert.rejects(planBlend((r) => r.part('t').terrace({ polygon: [[40, 40], [100, 40], [100, 70], [40, 70]] }, [66, 70], { edge: 'blend' }), { passes: [] }), /terrace edge blend needs the relief pass/);
  await assert.rejects(planBlend((r) => r.part('t').terrace({ polygon: [[40, 40], [100, 40], [100, 70], [40, 70]] }, [66, 70], { edge: 'blend' })), /edge 'blend' needs the relief pass around its levels/);
  await assert.rejects(planBlend((r) => r.part('t').terrace({ polygon: [[40, 40], [100, 40], [100, 70], [40, 70]] }, [66, 70], { edge: 'bogus' })), /terrace edge must be slope, wall or blend/);
});

test("terrace edge 'blend': each level a pin at its y, no batters; the rim retained only where it stands more than 2 over the land outside", async () => {
  const { res, out, world } = await planBlend((r, o) => {
    o.levels = r.part('t').terrace({ polygon: [[40, 40], [100, 40], [100, 70], [40, 70]] }, [66, 70], { edge: 'blend', stairs: false });
    r.pass('relief', { around: o.levels.flatMap((l) => l.pins), radius: 8, maxFill: 2 });
  });
  // the pins: each level's cells as row runs at its y
  for (const l of out.levels) { assert.ok(l.pins.length > 0); assert.ok(l.pins.every((p) => p.y === l.y && p.terrace === 't' && p.rect[1] === p.rect[3])); }
  const cells = realise(res, world);
  const col = (x, z) => [...cells.entries()].filter(([k]) => { const [cx, , cz] = k.split(',').map(Number); return cx === x && cz === z; }).map(([k, st]) => [Number(k.split(',')[1]), st]).sort((a, b) => a[0] - b[0]);
  // level 1 (y 70) stands 4 over level 0 (y 66): its rim is the retain role from 66 to 70
  const rim = col(55, 55);
  assert.deepEqual(rim.filter(([y]) => y >= 66 && y <= 70).map(([, st]) => st), Array(5).fill('minecraft:stone_bricks'), 'the upper level\'s rim retained');
  // an inner cell of level 1 is the level's surface over its fill, no wall
  const inner = col(60, 55);
  assert.equal(inner.find(([y]) => y === 70)?.[1], 'minecraft:grass_block');
  assert.ok(!inner.some(([, st]) => st === 'minecraft:stone_bricks'));
  // level 0's west rim meets the land at its own height (x 40: ground 66): not retained
  assert.ok(!col(40, 55).some(([, st]) => st === 'minecraft:stone_bricks'), 'a rim within 2 of the land is not retained');
  assert.ok(res.meta.parts.t.terrace.retained > 0);
});

// ------------------------------------------------------------------ §3: the member, its layout

test('parseTerraces: the defaults (rise 3, walls, stairs) and the ranges', () => {
  assert.deepEqual(parseTerraces({}), { rise: TERRACES.rise, retain: 'wall', stairs: true });
  assert.deepEqual(parseTerraces({ rise: 5, retain: 'blend', stairs: false }), { rise: 5, retain: 'blend', stairs: false });
  assert.throws(() => parseTerraces({ rise: 1 }), /rise must be 2..6/);
  assert.throws(() => parseTerraces({ rise: 7 }), /rise must be 2..6/);
  assert.throws(() => parseTerraces({ retain: 'slope' }), /retain must be wall or blend/);
  assert.throws(() => parseTerraces({ steps: 3 }), /unknown member 'steps'/);
});

test('layoutTerraces: every lot on the ladder (the rect\'s lowest ground plus k x rise), within its pad limits, deterministic', () => {
  const s = slope({ per: 2 });
  const S = surveyApi(s.bytes, s.claim);
  const specs = validateLots(LOTS);
  for (const rise of [2, 3, 5]) {
    const L = layoutTerraces({ claim: { ...s.claim, minX: 40, minZ: 40, maxX: 119, maxZ: 119 }, survey: S, specs, terraces: parseTerraces({ rise }) });
    assert.ok(!L.fail && L.lots.length >= 3, `rise ${rise}: ${L.lots.length} lots`);
    for (const l of L.lots) {
      assert.equal((l.floorY - 1 - L.base) % rise, 0, `rise ${rise}: ${l.spec.id} on the ladder`);
      assert.ok(l.cut <= 6 && l.fill <= 6);
    }
    assert.ok(L.levels.every((y, i) => i === 0 || (y - L.levels[i - 1]) % rise === 0));
    assert.deepEqual(layoutTerraces({ claim: { ...s.claim, minX: 40, minZ: 40, maxX: 119, maxZ: 119 }, survey: S, specs, terraces: parseTerraces({ rise }) }).lots.map((l) => [l.spec.id, l.rect, l.floorY]), L.lots.map((l) => [l.spec.id, l.rect, l.floorY]));
  }
  const flat = layoutTerraces({ claim: { ...s.claim, minX: 40, minZ: 40, maxX: 119, maxZ: 119 }, survey: surveyApi(slope({ per: 10000 }).bytes, s.claim), specs, terraces: parseTerraces({}) });
  assert.equal(flat.flat, true);
  assert.equal(flat.levels.length, 1);
});

test('a districts zone with terraces (plan/0): READY, each lot on its level, every route between the junctions routed, the checker clean', async () => {
  const s = slope({ per: 2 });
  const r = await check(plan(district({})), s);
  assert.equal(r.check.overall, 'READY');
  const a = r.check.parts.find((q) => q.part === 'town');
  assert.equal(a.class, 'fits');
  const t = a.geometry.terraces.hill;
  assert.deepEqual([t.rise, t.retain], [3, 'wall']);
  assert.ok(t.levels.length >= 2, `levels ${t.levels}`);
  assert.equal(t.lots.length, 4);
  for (const l of t.lots) assert.ok(t.levels.includes(l.y));
  assert.ok(t.retained > 0, 'rims over 2 retained');
  const edges = r.res.meta.route.edges;
  assert.ok(edges.length >= 4 && edges.every((e) => e.ok), edges.map((e) => `${e.id} ${e.ok}`).join(', '));
  // every lot reaches its junction, the junctions join (graph)
  for (const l of t.lots) assert.ok(r.res.ir.graph.nodes.some((n) => n.id === `${l.id}_j`), `${l.id}'s junction`);
  const rep = reportOf(r, s);
  assert.equal(rep.errors, 0);
  assert.equal(rep.metrics.M2.reached, rep.metrics.M2.nodes);
  assert.equal(openRims(r, s, a.geometry.terraces).open, 0);
});

test('a standard zone with terraces: laid out as one terraced district on its locator (noted), a connector ends at a lot\'s junction', async () => {
  const s = slope({ per: 2 });
  const r = await check(plan({ id: 'town', terraces: {}, program: { lots: LOTS } }), s);
  const a = r.check.parts.find((q) => q.part === 'town');
  assert.ok(['fits', 'adjusted'].includes(a.class), JSON.stringify(a.reasons));
  assert.ok(a.notes.some((n) => /one terraced district/.test(n)));
  assert.equal(a.geometry.terraces.town.lots.length, 4);
  // a locator moves it: near an anchor at the claim's east, within its move tolerance
  const r2 = await checkPlanLocal(plan({ id: 'town', terraces: {}, where: { near: { anchor: 'east_end', within: 16 } }, program: { lots: LOTS } }), { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), east_end: [130, 100, 80] } });
  const g2 = r2.check.parts.find((q) => q.part === 'town').geometry;
  assert.ok(g2.rect[2] > 100, `rect ${g2.rect}`);
});

test("a flat site: one level, noted 'terraces: flat site, one level' (a district's notes name it)", async () => {
  const s = slope({ per: 100000 });
  const z = (await check(plan({ id: 'town', terraces: {}, program: { lots: LOTS } }), s)).check.parts.find((q) => q.part === 'town');
  assert.ok(z.notes.includes('terraces: flat site, one level'), JSON.stringify(z.notes));
  const d = (await check(plan(district({})), s)).check.parts.find((q) => q.part === 'town');
  assert.ok(d.notes.some((n) => n === 'terraces: district hill: flat site, one level'), JSON.stringify(d.notes));
  assert.equal(d.geometry.terraces.hill.levels.length, 1);
});

test("retain 'blend': the lots on blend pads, blended by the relief (the default relief when no relief form names the zone)", async () => {
  const s = slope({ per: 2 });
  const r = await check(plan(district({ retain: 'blend' })), s);
  assert.equal(r.check.overall, 'READY');
  const lots = r.res.ir.lots;
  assert.ok(lots.length >= 3 && lots.every((l) => l.pad.edge === 'blend'));
  assert.ok(r.res.ir.parts.some((p) => /^relief/.test(p.id)), 'a relief blends them');
  assert.equal(r.check.parts.find((q) => q.part === 'town').geometry.terraces.hill.retained, 0);
});

test('the broken variant unretained (no ring, no rail): the rims check finds rims over 2, M8 catches a drop over 3', async () => {
  const s = slope({ per: 1 });
  const ok = await check(plan(district({})), s);
  const okA = ok.check.parts.find((q) => q.part === 'town');
  assert.equal(openRims(ok, s, okA.geometry.terraces).open, 0, 'the walls hold every rim');
  const bad = await check(plan(district({}, { ext: { 'architect_mc:unsafe': { unretained: true } } })), s);
  const a = bad.check.parts.find((q) => q.part === 'town');
  assert.equal(a.geometry.terraces.hill.retained, 0);
  assert.ok(openRims(bad, s, a.geometry.terraces).open > 0, 'open rims');
  const rep = reportOf(bad, s);
  assert.ok((rep.metrics.M8?.unguarded ?? 0) > 0, `M8 ${JSON.stringify({ ...rep.metrics.M8, unguardedSample: undefined })}`);
});

test("the broken variant spring_buried: a fill over S3's spring columns is refused by the program's own check", async () => {
  const s = goldenSurvey('districts_demo');
  const opts = { programFile: path.join(KIT, 'regions', 'terraced_monastery.mjs'), survey: s.bytes, seed: '7', claim: s.claim };
  await assert.rejects(planRegion({ ...opts, params: { unsafe: 'spring_buried', fountain: false, spires: 0, scatter: false } }), /SPRING: \d+ cell\(s\) written over the spring's columns/);
});

test('junctionOf: JUNCTION cells out of the front at the floor', () => {
  const l = { spec: { id: 'x' }, front: 'east', entrance: [10, 70, 20] };
  assert.deepEqual(junctionOf(l), { name: 'x_j', at: [14, 70, 20] });
});
