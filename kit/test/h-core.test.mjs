// Phase 6c slice H-core (docs/CONTRACT.md "Phase 6c slice H" §1, §2, §3.3, §9, §10, §14 items 1, 14(b), 15): the fluid body (column runs,
// the shell rule), M25's flow (the conservative reach and vanilla's steady state), the lint FLUID_STATE, ARVX version 3's fluid layer,
// and h_core_demo through the two-plan flow: its bodies clean, and every broken variant caught by its rule with its cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromRuns, lintFluidState, runCells, shellOf, toRuns, bufferOf, isRaised } from '../lib/fluids/body.mjs';
import { mapWorld, reach, settleBound, simulate, steady } from '../lib/fluids/sim.mjs';
import { decodeArvx, encodeArvx, fluidAt, FC, VC } from '../lib/region/volume.mjs';
import { evalTile, KINDS_FORMAT2, staleReason } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { columnsOf, worldOf, windowOf } from './region-helpers.mjs';
import { planTwice, synthVolume } from './h-helpers.mjs';
import * as demo from '../regions/h_core_demo.mjs';

const k3 = (c) => c.join(',');

test('column runs and the shell rule (§1.1): floor, sides, the rim one over each side wall; not the open top, not an outlet', () => {
  const cells = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { cells.push([x, 10, z]); if (x === 1 && z === 1) cells.push([x, 9, z]); }
  const runs = toRuns(cells);
  assert.equal(runCells(runs), 10);
  assert.deepEqual(fromRuns(runs).map(k3).sort(), cells.map(k3).sort());
  assert.deepEqual(runs.find((r) => r[0] === 1 && r[1] === 1), [1, 1, 9, 10]);
  const sh = new Set(shellOf(cells).map(k3));
  assert.ok(sh.has('1,8,1') && sh.has('0,9,0') && sh.has('-1,10,1') && sh.has('-1,11,1'), 'floor, side and rim');
  assert.ok(!sh.has('1,11,1') && !sh.has('0,11,0'), 'the cells over the surface stay open');
  assert.ok(!sh.has('1,10,1'), 'never a body cell');
  // an outlet is no shell cell, and a wall beside an outlet gets no rim over it
  const sh2 = new Set(shellOf([[5, 20, 5]], { open: [[6, 20, 5]] }).map(k3));
  assert.ok(!sh2.has('6,20,5') && !sh2.has('6,21,5') && sh2.has('4,20,5') && sh2.has('4,21,5') && sh2.has('5,19,5'));
  // the buffer: within 2 behind the shell, never over the open surface
  const buf = new Set(bufferOf(cells, shellOf(cells), [], 2).map(k3));
  assert.ok(buf.has('-3,10,1') && buf.has('1,6,1') && !buf.has('1,12,1'));
});

test('M25\'s flow: the conservative reach, vanilla\'s steady state with levels, the settle bound; a leak, a spout', () => {
  const ground = (x, y) => (y <= 63 ? 'stop' : 'open');
  const cells = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) cells.push([x, 63, z]);
  const carved = new Map(cells.map((c) => [k3(c), 'open']));
  let r = simulate(mapWorld(carved, ground), [{ id: 'p', fluid: 'water', level: 63, cells, spill: [] }]);
  assert.deepEqual([r.bodies[0].spill.length, r.bodies[0].predicted.length, r.findings.length], [0, 0, 0], 'a sunk pond: nothing spills');
  assert.equal(r.bodies[0].settleTicks, settleBound('water', 0));
  assert.equal(settleBound('water', 3), 5 * 5 + 20);
  assert.equal(settleBound('lava', 0), 30 * 2 + 20);
  // a hole in the wall at the surface: one cell reached, the leak names it
  carved.set('3,63,1', 'open');
  r = simulate(mapWorld(carved, ground), [{ id: 'p', fluid: 'water', level: 63, cells, spill: [] }]);
  assert.deepEqual(r.findings.map((f) => [f.rule, f.sample]), [['M25:leak', [[3, 63, 1]]]]);
  // a 1-wide channel on a floor: vanilla's levels 1..7 away from a source, then dry; the reach agrees
  const ch = new Map();
  for (let x = 1; x <= 12; x++) ch.set(`${x},64,0`, 'open');
  const chWorld = (x, y, z) => ch.get(`${x},${y},${z}`) ?? 'stop';
  const st = steady(chWorld, [[0, 64, 0]], 'water');
  assert.deepEqual([...st.cells].filter(([k]) => k !== '0,64,0').map(([k, lv]) => [Number(k.split(',')[0]), lv]).sort((a, b) => a[0] - b[0]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]);
  const rc = reach(chWorld, [[0, 64, 0]], 'water');
  assert.equal(rc.amt.size, 8);
  // lava: 3 cells
  assert.equal(reach(chWorld, [[0, 64, 0]], 'lava').amt.size, 4);
  // a spout on a pillar over a basin: its four sides at level 1, falling (8) down to the basin's water
  const m = new Map();
  for (let x = 8; x <= 12; x++) for (let z = 8; z <= 12; z++) if (x !== 10 || z !== 10) m.set(`${x},63,${z}`, 'water');
  m.set('10,63,10', 'stop'); m.set('10,64,10', 'stop'); m.set('10,65,10', 'stop');
  r = simulate(mapWorld(m, ground), [{ id: 's', fluid: 'water', level: 66, cells: [[10, 66, 10]] }]);
  const pred = new Map(r.bodies[0].predicted.map(([x, y, z, lv]) => [`${x},${y},${z}`, lv]));
  assert.deepEqual([pred.get('9,66,10'), pred.get('9,65,10'), pred.get('9,64,10'), pred.size], [1, 8, 8, 12]);
  assert.equal(r.bodies[0].spill.length, 12);
  assert.equal(r.bodies[0].settleTicks, settleBound('water', 3));
});

test('lint FLUID_STATE (§1.1): a flowing or falling water or lava state in any op is found', () => {
  const ir = { parts: [{ id: 'a', ops: [{ op: 'shape', material: 'minecraft:water' }, { op: 'shape', material: 'minecraft:water[level=8]' }] }, { id: 'b', ops: [{ op: 'columns', materials: ['minecraft:stone', 'minecraft:lava[level=2]'] }, { op: 'fluid', state: 'minecraft:water' }] }] };
  assert.deepEqual(lintFluidState(ir).map((f) => [f.part, f.op, f.state]), [['a', 1, 'minecraft:water[level=8]'], ['b', 0, 'minecraft:lava[level=2]']]);
  assert.deepEqual(lintFluidState({ parts: [{ id: 'c', ops: [{ op: 'shape', material: 'minecraft:water[level=0]' }] }] }), []);
});

test('ARVX version 3 (§10): the fluid layer round-trips; versions 1 and 2 are unchanged without it', () => {
  const box = { minX: 0, minY: 60, minZ: 0, maxX: 2, maxY: 63, maxZ: 1 };
  const n = 3 * 4 * 2;
  const classes = new Uint8Array(n).fill(VC.ROCK);
  const fl = new Uint8Array(n);
  const idx = (x, y, z) => ((x - box.minX) * 2 + (z - box.minZ)) * 4 + (y - box.minY);
  classes[idx(1, 63, 0)] = VC.WATER; fl[idx(1, 63, 0)] = FC.water_source;
  classes[idx(2, 63, 1)] = VC.WATER; fl[idx(2, 63, 1)] = FC.water_falling;
  classes[idx(0, 62, 0)] = VC.LAVA; fl[idx(0, 62, 0)] = FC.lava_flowing;
  const blocks = { palette: ['minecraft:air', 'minecraft:stone', 'minecraft:water', 'minecraft:lava'], index: new Uint16Array(n).fill(1) };
  const v3 = decodeArvx(encodeArvx(box, classes, [], new Map(), blocks, fl));
  assert.equal(v3.version, 3);
  assert.deepEqual([fluidAt(v3, 1, 63, 0), fluidAt(v3, 2, 63, 1), fluidAt(v3, 0, 62, 0), fluidAt(v3, 0, 60, 0), fluidAt(v3, 9, 60, 0)], [1, 3, 6, 0, null]);
  const v2 = decodeArvx(encodeArvx(box, classes, [], new Map(), blocks));
  assert.equal(v2.version, 2);
  assert.equal(fluidAt(v2, 1, 63, 0), null);
  assert.equal(decodeArvx(encodeArvx(box, classes)).version, 1);
  assert.throws(() => encodeArvx(box, classes, [], new Map(), null, fl), /version-3/);
  // a kit before 0.35.0 can't read a fluid op or a fluid volume: PLAN_STALE
  assert.deepEqual(KINDS_FORMAT2.slice(-2), ['fluid', 'volume:fluids']);
  assert.match(staleReason({ format: 2, requires: ['fluid'], kitVersion: '0.35.0' }, '0.34.0') ?? '', /kit 0\.35\.0/);
});

const CLAIM = { minX: 0, minZ: 0, maxX: 95, maxZ: 95, minY: -64, maxY: 319 };
const SURVEY = columnsOf(worldOf({ flat: 64 }), 0, 0, 96, 96, 1);
const planDemo = (params) => planTwice({ program: demo, programSource: fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'regions', 'h_core_demo.mjs'), 'utf8'), params, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' });
const checkOf = (p) => checkRegion({ ir: p.ir, survey: SURVEY, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), meta: p.meta });

test('h_core_demo through the two-plan flow: each body asks its volume (fluid layer), the fluids stage last, M25 and M20 clean', async () => {
  const p = await planDemo({ lava: true });
  assert.equal(p.first.needVolumes.length, 4);
  assert.ok(p.first.needVolumes.every((b) => b.fluids === true));
  assert.deepEqual(p.ir.stages, ['ground', 'fluids']);
  assert.deepEqual(p.ir.requires, ['blobs:side', 'fluid', 'volume:blocks', 'volume:fluids', 'volumes']);
  const rep = checkOf(p);
  const bad = rep.findings.filter((f) => /^M(25|20)/.test(f.rule) || f.severity === 'error');
  assert.deepEqual(bad.map((f) => `${f.rule} ${f.message}`), []);
  const bodies = rep.metrics.M25.bodies;
  assert.deepEqual(bodies.map((b) => b.id), ['pond', 'spout_basin', 'spout', 'lava_pit']);
  const spout = bodies.find((b) => b.id === 'spout');
  assert.deepEqual([spout.spill, spout.predicted, spout.settleTicks], [12, 12, settleBound('water', 3)]);
  assert.equal(rep.metrics.M20.flammable, 0);
  assert.deepEqual(p.meta.waters.map((w) => [w.id, w.cells, w.spill, w.volume]), [['pond', 50, 0, 'given'], ['spout_basin', 24, 0, 'given'], ['spout', 1, 12, 'given'], ['lava_pit', 9, 0, 'given']]);
  // the evaluator writes the sources (IF_AIR_OR_FLUID) in the fluids stage only
  const fl = p.ir.parts.find((q) => q.id === 'pond');
  assert.equal(fl.stage, 'fluids');
  const op = fl.ops[0];
  const key = `${Math.floor(op.cells[0][0] / 64)},${Math.floor(op.cells[0][1] / 64)}`;
  const e = evalTile(p.ir, key, windowOf(worldOf({ flat: 64 }), key), { stage: 'fluids', set: 'terrain', blobs: (s) => p.blobs.get(s) });
  const cells = unpack(e.payload).cells.filter((c) => fromRuns(op.cells).some((q) => q[0] === c.x && q[1] === c.y && q[2] === c.z));
  assert.equal(cells.length, 50);
  assert.ok(cells.every((c) => c.state === 'minecraft:water' && c.cond === 2));
  // not raised: every pond here is sunk (its volume box grown by 2)
  assert.equal(isRaised({ groundAt: () => 64 }, fromRuns(op.cells)), false);
  // deterministic: the same plan twice
  const again = await planDemo({ lava: true });
  assert.equal(again.irSha, p.irSha);
});

test('the broken variants (§14): each caught by its rule, naming its cells', async () => {
  const want = {
    no_shell_cell: ['M25:shell', 'M25:leak'], predict_short: ['M25:leak'], sand_shell: ['M25:shell'], two_source_corner: ['M25:convert'],
    lava_near_water: ['M25:mix'], flammable_rim: ['M20'], roofed_pond: ['M25:trap'], no_exit: ['M25:exit'],
  };
  for (const [variant, rules] of Object.entries(want)) {
    const p = await planDemo({ variant, lava: ['lava_near_water', 'flammable_rim'].includes(variant) });
    const rep = checkOf(p);
    for (const rule of rules) {
      const f = rep.findings.find((x) => x.rule === rule);
      assert.ok(f && f.severity === 'error' && f.sample.length > 0, `${variant}: ${rule} (${rep.findings.map((x) => x.rule).join(', ')})`);
    }
  }
  // no_shell_cell names the one rim cell left open; predict_short the one spill cell left out
  const ns = checkOf(await planDemo({ variant: 'no_shell_cell' }));
  assert.deepEqual(ns.findings.find((f) => f.rule === 'M25:leak').sample, [[35, 63, 48]]);
  const ps = checkOf(await planDemo({ variant: 'predict_short' }));
  assert.deepEqual(ps.findings.find((f) => f.rule === 'M25:leak').sample, [[55, 66, 48]]);
  // flowing_state: the lint refuses the plan itself
  await assert.rejects(() => planDemo({ variant: 'flowing_state' }), /FLUID_STATE/);
});

test('a body checked without a frozen volume is a finding, never a pass (§9)', async () => {
  const p = await planRegion({ program: demo, programSource: 'h_core_demo', params: {}, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' });
  const rep = checkRegion({ ir: p.ir, survey: SURVEY, blobs: p.blobs, meta: p.meta });
  assert.ok(rep.findings.some((f) => f.rule === 'M25:shell' && /no volume/.test(f.message)));
  // and a synthetic volume reads back as the survey: dirt and grass at the ground, rock under
  const v = synthVolume({ minX: 0, minY: 60, minZ: 0, maxX: 1, maxY: 66, maxZ: 1 }, SURVEY, CLAIM);
  assert.deepEqual([v.decoded.version, fluidAt(v.decoded, 0, 64, 0), v.decoded.classes[4], v.decoded.classes[5]], [3, 0, VC.SOIL, VC.AIR]);
});

test('ARVX version 3, cross-language: the mod\'s fixture (ArvxFluidsTest) decodes to its sha, classes, blocks and fluid codes', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'mod', 'src', 'test', 'resources', 'arvx');
  const exp = JSON.parse(fs.readFileSync(path.join(dir, 'fluids.json'), 'utf8'));
  const v = decodeArvx(fs.readFileSync(path.join(dir, 'fluids.bin')));
  assert.equal(v.sha, exp.sha);
  assert.equal(v.version, 3);
  const CODES = ['none', 'water_source', 'water_flowing', 'water_falling', 'waterlogged', 'lava_source', 'lava_flowing'];
  for (const [x, y, z, cls, block, fluid] of exp.cells) {
    const c = v.classes[((x - v.box.minX) * v.depth + (z - v.box.minZ)) * v.height + (y - v.box.minY)];
    assert.equal(['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING'][c], cls, `${x},${y},${z}`);
    const f = fluidAt(v, x, y, z);
    assert.equal(f === null ? null : CODES[f], fluid, `${x},${y},${z} fluid`);
    void block;
  }
});
