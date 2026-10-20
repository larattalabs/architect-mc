// (6c RS) Regions in survival, the kit's half (docs/CONTRACT.md "Phase 6c slice RS" §3, §4, §13 item 1): the free rule per written cell
// (a survival IR's ARTL v2 classes and groups), held parts, FREE_EXCEPT, the survival IR (free marks, the member, requires) and the
// artifact, the plan check's cost.survival and cost.bom, the SURVIVAL refusal, and a creative IR unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { region, TERRAIN_OPS } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile, KINDS_FORMAT2, MEMBERS_FORMAT2, staleReason, walkKinds } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_FREE, CLASS_HELD, CLASS_PAID, FREE_NATURAL, itemsOf as regionItemsOf } from '../lib/region/survival.mjs';
import { FREE_EXCEPT, CREATIVE_ONLY } from '../lib/vocab/survival.mjs';
import { itemsOf as bomItemsOf } from '../lib/connectors/bom.mjs';
import { BLOCKS } from '../lib/blocks.mjs';
import { columnsOf, windowOf, worldOf } from './region-helpers.mjs';
import { FIX, checkPlanVolumes, fixtureStyle, flatSurvey, stewardAnchors, asksSurvey } from './plan-helpers.mjs';

const flat = worldOf({ flat: 64 });
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

/** Plans an inline program over a flat claim, in survival or not; returns {ir, cells: Map "x,y,z" -> {state, cls, group, part}}. */
async function plan(fn, { survival = true } = {}) {
  const survey = columnsOf(flat, CLAIM.minX, CLAIM.minZ, 64, 64, 1);
  const program = { id: 'rs_inline', default: fn };
  const res = await planRegion({ program, programSource: fn.toString(), survey, seed: '42', claim: CLAIM, node: 'test', ...(survival ? { survival: true } : {}) });
  const ir = res.ir;
  const cells = new Map();
  for (const s of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[s][set]) {
    const e = evalTile(ir, key, windowOf(flat, key), { stage: s, set, blobs: (sha) => res.blobs.get(sha) });
    const u = unpack(e.payload);
    for (const c of u.cells) cells.set(`${c.x},${c.y},${c.z}`, { state: c.state, cls: c.cls, group: c.group === undefined ? null : ir.survival?.groups[c.group], v2: c.cls !== undefined });
  }
  return { ir, res, cells };
}

const anchors = (r) => { r.anchor('spawn', [2, 2]); r.anchor('entrance', [3, 2]); };

/** One program with every row of §7.1 and §7.2 that a program can write on a flat claim, each in its own part. */
function rows(ctx) {
  const r = region(ctx);
  anchors(r);
  r.stages(['ground', 'forms']);
  // a terrain kind's natural fill (a 6a fill with terrain: true): free, the free pass (its part has no paid cell)
  r.part('land', { stage: 'ground' }).fill({ kind: 'box', min: [4, { abs: 65 }, 4], max: [5, { abs: 66 }, 5] }, 'minecraft:stone', { terrain: true });
  // a cut (air): free
  r.part('cut', { stage: 'ground' }).fill({ kind: 'box', min: [8, { abs: 63 }, 4], max: [9, { abs: 64 }, 5] }, null, { cond: 0 });
  // a wall: its body paid (stone bricks), a natural stone it writes paid (not a terrain kind), and a terrain fill and a cut in the same
  // part held (they wait with the paid cells)
  const w = r.part('wall', { stage: 'ground' });
  w.fill({ kind: 'box', min: [12, { abs: 65 }, 4], max: [12, { abs: 67 }, 6] }, 'minecraft:stone_bricks', { cond: 0 });
  w.fill({ kind: 'box', min: [13, { abs: 65 }, 4], max: [13, { abs: 65 }, 6] }, 'minecraft:stone', { cond: 0 });
  w.fill({ kind: 'box', min: [14, { abs: 65 }, 4], max: [14, { abs: 65 }, 6] }, 'minecraft:dirt', { cond: 0, terrain: true });
  w.fill({ kind: 'box', min: [15, { abs: 63 }, 4], max: [15, { abs: 64 }, 6] }, null, { cond: 0 });
  // an ore in a terrain fill: paid (FREE_EXCEPT, N-RS-3); its part then holds its free cells
  const o = r.part('ore', { stage: 'ground' });
  o.fill({ kind: 'box', min: [20, { abs: 65 }, 4], max: [20, { abs: 65 }, 4] }, 'minecraft:iron_ore', { cond: 0, terrain: true });
  o.fill({ kind: 'box', min: [21, { abs: 65 }, 4], max: [21, { abs: 65 }, 4] }, 'minecraft:stone', { cond: 0, terrain: true });
  // a creative-only block: paid (it costs nothing) and named creativeOnly
  r.part('spawn', { stage: 'ground' }).fill({ kind: 'box', min: [24, { abs: 65 }, 4], max: [24, { abs: 65 }, 4] }, 'minecraft:spawner', { cond: 0 });
  // a path part: a dirt path on the column's surface is free (C16's freeCell, the frozen ground), one over it is paid (dirt)
  const p = r.part('walk', { stage: 'forms', set: 'path' });
  p.columns({ abs: 0 }, { abs: 0 }, [30, 4, 64, 64, 0, 31, 4, 66, 66, 0], ['minecraft:dirt_path']);
  // a pad: its cut and fill always the free pass, even though its part writes a paid cell
  const pad = r.part('pads', { stage: 'ground' });
  pad.lot('l1', { at: [40, 40], size: [6, 6], pad: { edge: 'slope', maxCut: 4, maxFill: 4 } });
  pad.fill({ kind: 'box', min: [50, { abs: 65 }, 50], max: [50, { abs: 65 }, 50] }, 'minecraft:oak_planks', { cond: 0 });
  // fluid bodies (as H writes them): a water source and its ice cap free, a lava source free (charged when the body is written)
  const fl = r.part('pondw', { stage: 'forms' });
  fl._push({ op: 'fluid', id: 'pondw', part: 'pondw', fluid: 'water', cells: [[44, 4, 63, 63]], ice: [[44, 4, 64, 64]], shell: [], spill: [], joins: [], watch: [], predicted: [], cond: 0, walk: false });
  const lv = r.part('pondl', { stage: 'forms' });
  lv._push({ op: 'fluid', id: 'pondl', part: 'pondl', fluid: 'lava', cells: [[46, 4, 63, 63]], shell: [], spill: [], joins: [], watch: [], predicted: [], cond: 0, walk: false });
  return r;
}

const at = (cells, x, y, z) => cells.get(`${x},${y},${z}`);

test('item 1: the free rule per written cell (§4.1, §7): every row on a flat claim, by class and group', async () => {
  const { ir, cells } = await plan(rows);
  assert.ok(ir.survival && ir.requires.includes('survival') && ir.format === 2, 'a survival IR: the member, requires survival, format 2');
  const cls = (x, y, z) => at(cells, x, y, z)?.cls;
  assert.equal(cls(4, 65, 4), CLASS_FREE, 'a terrain kind\'s natural fill: free, the free pass');
  assert.equal(cls(8, 64, 4), CLASS_FREE, 'a cut: free');
  assert.equal(cls(12, 66, 4), CLASS_PAID, 'a wall\'s body: paid');
  assert.equal(cls(13, 65, 4), CLASS_PAID, 'a natural stone a wall writes (not a terrain kind): paid');
  assert.equal(cls(14, 65, 4), CLASS_HELD, 'a terrain fill in a part with paid cells: held');
  assert.equal(cls(15, 64, 4), CLASS_HELD, 'a cut in a part with paid cells: held (no cut stands without its wall)');
  assert.equal(cls(20, 65, 4), CLASS_PAID, 'an ore (FREE_EXCEPT): paid');
  assert.equal(cls(21, 65, 4), CLASS_HELD, 'the stone beside it: held (its part writes a paid cell)');
  assert.equal(cls(24, 65, 4), CLASS_PAID, 'a creative-only block: paid');
  assert.equal(cls(30, 64, 4), CLASS_FREE, 'a dirt path on the surface: free (freeCell)');
  assert.equal(cls(31, 66, 4), CLASS_PAID, 'a dirt path over the surface: paid (dirt)');
  assert.equal(cls(50, 65, 50), CLASS_PAID, 'the pad part\'s planks: paid');
  const padCells = [...cells.values()].filter((c) => c.group === 'pads' && !c.state.startsWith('minecraft:oak_planks'));
  assert.ok(padCells.length > 30 && padCells.every((c) => c.cls === CLASS_FREE), `the pad's cut and fill: the free pass though its part holds (${padCells.length} cells)`);
  assert.equal(cls(44, 63, 4), CLASS_FREE, 'a water source: free');
  assert.equal(cls(44, 64, 4), CLASS_FREE, 'its ice cap: free (N-RS-4)');
  assert.equal(cls(46, 63, 4), CLASS_FREE, 'a lava source: no target cell (charged when its body is written)');
  assert.equal(at(cells, 46, 63, 4).group, 'pondl');
  assert.ok([...cells.values()].every((c) => c.v2), 'every cell carries its class and group (ARTL v2)');
});

test('item 1: notes.survival per group: free, held, paid, the paid bill, the charges, the creative-only blocks', async () => {
  const { ir, res } = await plan(rows);
  const survey = columnsOf(flat, 0, 0, 64, 64, 1);
  void survey;
  const sv = {};
  for (const s of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[s][set]) {
    const e = evalTile(ir, key, windowOf(flat, key), { stage: s, set, blobs: (sha) => res.blobs.get(sha) });
    for (const [g, x] of Object.entries(e.notes.survival)) {
      const t = (sv[g] ??= { free: 0, held: 0, paid: 0, bom: {}, charged: {}, creativeOnly: {} });
      t.free += x.free; t.held += x.held; t.paid += x.paid;
      for (const k of ['bom', 'charged', 'creativeOnly']) for (const [i, n] of Object.entries(x[k] ?? {})) t[k][i] = (t[k][i] ?? 0) + n;
    }
  }
  assert.deepEqual(sv.wall.bom, { 'minecraft:stone': 3, 'minecraft:stone_bricks': 9 });
  assert.equal(sv.wall.held, 3 + 6);
  assert.deepEqual(sv.ore.bom, { 'minecraft:iron_ore': 1 });
  assert.deepEqual(sv.spawn.creativeOnly, { 'minecraft:spawner': 1 });
  assert.deepEqual(sv.spawn.bom, {}, 'a creative-only block costs nothing (it is refused instead)');
  assert.deepEqual(sv.pondl.charged, { 'minecraft:lava_bucket': 1 });
  assert.deepEqual(sv.walk.bom, { 'minecraft:dirt': 1 });
  assert.equal(sv.land.paid + sv.land.held, 0);
  assert.deepEqual(ir.survival.creativeOnly, { spawn: { 'minecraft:spawner': 1 } }, 'the IR names the creative-only blocks per group (realise refuses CREATIVE_ONLY_BLOCK)');
  assert.equal(ir.survival.cells.wall.paid, 12);
});

test('item 1: free marks: the terrain kinds\' ops carry free: true in a survival IR only; TERRAIN_OPS never reach a creative IR', async () => {
  const { ir } = await plan(rows);
  const opsOf = (id) => ir.parts.find((p) => p.id === id).ops;
  assert.equal(opsOf('land')[0].free, true);
  assert.equal(opsOf('wall')[0].free, undefined, 'a wall\'s body is not a terrain kind\'s');
  assert.equal(opsOf('wall')[2].free, true);
  assert.equal(opsOf('pads').filter((o) => o.free).length >= 3, true, 'the pad\'s cut, fill and top');
  const c = await plan(rows, { survival: false });
  assert.equal(c.ir.survival, undefined);
  assert.ok(!JSON.stringify(c.ir).includes('"free"'), 'no free mark in a creative IR');
  assert.ok([...c.cells.values()].every((x) => !x.v2), 'a creative IR\'s tiles are ARTL v1');
  assert.ok(!(c.ir.requires ?? []).includes('survival'));
  assert.equal(TERRAIN_OPS instanceof WeakSet, true);
});

test('item 1: the kinds and members: survival in KINDS_FORMAT2 and MEMBERS_FORMAT2, walked from the member, read by this kit', () => {
  assert.ok(KINDS_FORMAT2.includes('survival'));
  assert.ok(MEMBERS_FORMAT2.includes('survival'));
  assert.deepEqual(walkKinds({ parts: [], survival: { groups: [] } }), ['survival']);
  assert.equal(staleReason({ format: 2, requires: ['survival'] }), null);
});

test('item 1: FREE_EXCEPT (N-RS-3): ores, amethyst, obsidian and crying obsidian; stone, dirt, logs and leaves free; one source', () => {
  for (const b of ['minecraft:iron_ore', 'minecraft:deepslate_diamond_ore', 'minecraft:obsidian', 'minecraft:crying_obsidian', 'minecraft:amethyst_block']) {
    assert.ok(FREE_EXCEPT.has(b), b);
    assert.ok(!FREE_NATURAL.has(b), b);
  }
  for (const b of ['minecraft:stone', 'minecraft:dirt', 'minecraft:oak_log', 'minecraft:oak_leaves', 'minecraft:sand', 'minecraft:packed_ice', 'minecraft:snow_block']) assert.ok(FREE_NATURAL.has(b), b);
  for (const b of ['minecraft:cobblestone', 'minecraft:stone_bricks', 'minecraft:oak_planks', 'minecraft:spawner', 'minecraft:bedrock']) assert.ok(!FREE_NATURAL.has(b), b);
  for (const b of CREATIVE_ONLY) assert.ok(!FREE_NATURAL.has(b), `${b} is never free`);
  const src = fs.readFileSync(path.join(FIX, '..', '..', '..', 'vocab', 'survival.json'), 'utf8');
  assert.ok(JSON.parse(src).free?.exceptTier === 'precious');
});

test('item 1: the region evaluator\'s bill per cell equals bom.mjs\'s (C26) over every block and its states', () => {
  const ids = (BLOCKS instanceof Map ? [...BLOCKS.keys()] : Object.keys(BLOCKS)).map((id) => (id.includes(':') ? id : `minecraft:${id}`));
  let n = 0;
  for (const id of ids) {
    for (const st of [id, `${id}[half=upper]`, `${id}[type=double]`, `${id}[part=head]`]) {
      assert.deepEqual(regionItemsOf(st), bomItemsOf(st), st);
      n++;
    }
  }
  assert.ok(n > 4000);
});

// ------------------------------------------------------------------ the fixtures through the plan check, in survival

const RS = path.join(FIX, 'rs');
const fixtures = () => fs.readdirSync(RS).filter((f) => f.endsWith('.json')).sort().map((f) => [f, JSON.parse(fs.readFileSync(path.join(RS, f), 'utf8'))]).filter(([, fx]) => !fx.game); // (game: a fixture the gate fills in, rs05's region)

async function check(fx, survival) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : flatSurvey();
  return checkPlanVolumes(fx.plan ?? fx.answer?.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, style: fixtureStyle(fx), volume: fx.volume ?? {}, survival });
}

test('item 3: every RS fixture in survival: survival: true, cost.survival per answered part, the plan\'s cost.bom their sum, the artifact checked in survival', async () => {
  for (const [name, fx] of fixtures()) {
    const r = await check(fx, true);
    assert.notEqual(r.check.overall, 'MALFORMED', name);
    assert.equal(r.check.survival, true, name);
    const ok = r.check.parts.filter((a) => a.class === 'fits' || a.class === 'adjusted');
    for (const a of ok) assert.ok(a.cost?.survival && typeof a.cost.survival.free === 'number' && typeof a.cost.survival.held === 'number' && a.cost.survival.bom, `${name} ${a.part}`);
    // the plan's bill: every group's paid cells and charges (the parts' and the plan's own helper parts')
    const want = {};
    for (const g of Object.keys(r.res.ir.survival.cells ?? {})) void g;
    for (const a of ok) for (const k of ['bom', 'charged']) for (const [i, n] of Object.entries(a.cost.survival[k] ?? {})) want[i] = (want[i] ?? 0) + n;
    for (const [i, n] of Object.entries(want)) assert.ok((r.check.cost.bom[i] ?? 0) >= n, `${name}: cost.bom ${i} ${r.check.cost.bom[i]} covers the parts' ${n}`);
    if (r.artifact) assert.equal(r.artifact.survival, true, name);
    const c = await check(fx, false);
    assert.equal(c.check.survival, undefined, `${name}: a creative check says nothing of survival`);
    assert.equal(c.check.cost.bom, null);
    assert.equal(c.res.ir.survival, undefined);
    if (c.artifact) assert.equal(c.artifact.survival, undefined);
  }
});

test('item 13: a creative-only block in survival: the part refused SURVIVAL {kind: creativeOnly, blocks}, fits in creative', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(RS, 'u_spawner.json'), 'utf8'));
  const r = await check(fx, true);
  const a = r.check.parts.find((x) => x.part === 'town');
  assert.equal(a.class, 'refused');
  assert.equal(a.reasons[0].code, 'SURVIVAL');
  assert.equal(a.reasons[0].evidence.kind, 'creativeOnly');
  assert.ok(a.reasons[0].evidence.blocks['minecraft:spawner'] > 0);
  assert.equal(r.res.ir.survival.creativeOnly, undefined, 'the replan writes nothing of it');
  const c = await check(fx, false);
  assert.equal(c.check.parts.find((x) => x.part === 'town').class, 'fits');
});

test('item 4 (kit): rs01\'s land: the relief\'s cells and the pads free; the spire and the terrace held whole (their paid cobblestone and stairs)', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(RS, 'rs01_land.json'), 'utf8'));
  const r = await check(fx, true);
  const by = Object.fromEntries(r.check.parts.map((a) => [a.part, a.cost?.survival]));
  assert.equal(by.blend.held, 0);
  assert.ok(by.blend.free > 0);
  assert.deepEqual(by.blend.bom, {});
  assert.equal(by.steps.free, 0, 'the terrace: no free pass');
  assert.ok(by.steps.held > 1000 && Object.keys(by.steps.bom).length > 0, 'its cut and fill held with its stairs');
  assert.ok(by.town.free > 1000, 'the zone\'s pads free');
});
