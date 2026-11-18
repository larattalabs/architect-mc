// (8c WM) The water model on the virtual world (8c contract §2, slice WM): vanilla's flow rules as fixtures (the 7-cell spread, falling
// then spreading on landing, a 1-block step restarting the spread, the drop preference within 4, infinite-source conversion, a
// waterlogged block as a foreign source, kelp and seagrass, bubble columns, the wash rule, a typed UNSETTLED), determinism as property
// tests (the tie order, the source order, 1 vs 4 workers), ARVX version 4 (levels in the frozen volume) and the opt-in path end to end.
// Vanilla 26.3 rules cited from FlowingFluid's bytecode (javap -c of minecraft-merged-deobf-26.3.jar): getNewLiquid 0-284 (horizontal
// neighbours counted only through canPassThroughWall, 85-97; conversion at 2 sources with canConvertToSource (WaterFluid: the gamerule
// waterSourceConversion) and a solid or a source under, 126-184; falling from above, 185-254; amount - dropOff, 255-284),
// canPassThroughWall (a full collision shape on either side refuses, 22-59), sourceNeighborCount (no wall test, 0-53), spread (down
// first, then sideways when 3 sources beside or not over a hole, 0-161); BubbleColumnBlock.canExistIn (a LiquidBlock source of amount 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { simulate, steady, reach, mapWorld, WM_MODEL, FACE } from '../lib/fluids/sim.mjs';
import { wlMask, levelOf, wmKinds, kindOf } from '../lib/fluids/world.mjs';
import { encodeArvx, decodeArvx, levelAt, fluidAt, levelsMissing, FC, VC } from '../lib/region/volume.mjs';
import { surveyBase, Palette } from '../lib/region/vworld.mjs';
import { walkKinds } from '../lib/realise.mjs';
import { makeColumns } from '../lib/region/pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const k3 = (x, y, z) => `${x},${y},${z}`;
const lv = (res, x, y, z) => res.cells.get(k3(x, y, z));
// a flat floor: stop at and under y 63, open over it
const flat = (y0 = 63) => (x, y) => (y <= y0 ? 'stop' : 'open');
const WM = { order: 'yxz', onCap: 'result' };

test('WM vanilla: a source on level ground spreads 7 cells, its level the Manhattan distance (a diamond of 112 cells)', () => {
  const w = mapWorld(new Map(), flat());
  const st = steady(w.at, [[0, 64, 0]], 'water', WM);
  const flowing = [...st.cells].filter(([, l]) => l !== 0);
  assert.equal(flowing.length, 112);
  for (const [k, l] of flowing) { const [x, , z] = k.split(',').map(Number); assert.equal(l, Math.abs(x) + Math.abs(z), k); }
  assert.equal(lv(st, 7, 64, 0), 7);
  assert.equal(lv(st, 8, 64, 0), undefined, 'no 8th cell');
});

test('WM vanilla: flow off a ledge falls first (level 8, no limit) and spreads only once it lands', () => {
  // a source on a 1x1 pillar top at 0,80,0: its sides flow off (level 1) and fall to the floor at 63
  const pillar = new Map(); for (let y = 64; y <= 79; y++) pillar.set(k3(0, y, 0), 'stop');
  const w = mapWorld(pillar, flat());
  const st = steady(w.at, [[0, 80, 0]], 'water', WM);
  assert.equal(lv(st, 1, 80, 0), 1, 'off the pillar top');
  assert.equal(lv(st, 2, 80, 0), undefined, 'a cell over a hole falls, never spreads on');
  for (let y = 64; y <= 79; y++) assert.equal(lv(st, 1, y, 0), 8, `falling at ${y}`);
  for (let y = 65; y <= 79; y++) assert.equal(lv(st, 2, y, 0), undefined, `no sideways spread while falling (${y})`);
  assert.equal(lv(st, 2, 64, 0), 1, 'the landed cell spreads 7 (a falling cell gives 7 to its sides)');
  assert.equal(lv(st, 8, 64, 0), 7);
  assert.equal(lv(st, 9, 64, 0), undefined);
  // (a source in mid-air also spreads to its sides, as vanilla's spread does when the cell under it is already its own flow: a plus of
  // five falling columns, H's model too)
  const air = steady(mapWorld(new Map(), flat()).at, [[0, 80, 0]], 'water', WM);
  assert.equal(lv(air, 1, 79, 0), 8);
  assert.equal(lv(air, 2, 79, 0), undefined);
});

test('WM vanilla: the drop preference within 4 (SLOPE) steers the spread, and a 1-block step restarts it', () => {
  // the floor steps down 1 at x >= 4: a hole 4 from the source (within SLOPE 4): the source spreads only toward it
  const at = (x, y) => (y <= (x >= 4 ? 62 : 63) ? 'stop' : 'open');
  const st = steady(at, [[0, 64, 0]], 'water', WM);
  assert.equal(lv(st, -1, 64, 0), undefined, 'not away from the drop');
  assert.equal(lv(st, 0, 64, 1), undefined, 'not sideways from the drop');
  assert.equal(lv(st, 3, 64, 0), 3);
  assert.equal(lv(st, 4, 64, 0), 4, 'the cell over the step');
  assert.equal(lv(st, 4, 63, 0), 8, 'it falls into the step');
  assert.equal(lv(st, 5, 63, 0), 1, 'the spread restarts on the lower bed');
  assert.equal(lv(st, 11, 63, 0), 7);
  assert.equal(lv(st, 12, 63, 0), undefined);
  // getSlopeDistance looks 4 past the neighbour: a hole 6 away is past it: no preference, the spread is the plain diamond
  const far = (x, y) => (y <= (x >= 6 ? 62 : 63) ? 'stop' : 'open');
  const st2 = steady(far, [[0, 64, 0]], 'water', WM);
  assert.equal(lv(st2, -1, 64, 0), 1);
  assert.equal(lv(st2, 0, 64, 1), 1);
});

test('WM vanilla: infinite sources: a gap between 2 sources over a solid converts; a wm body lists it as converted, M25:convert, never predicted', () => {
  const w = mapWorld(new Map(), flat());
  const st = steady(w.at, [[0, 64, 0], [2, 64, 0]], 'water', WM);
  assert.equal(lv(st, 1, 64, 0), 0, 'the gap is a source');
  // 3 of a 2x2 square: the fourth corner converts
  const sq = steady(w.at, [[0, 64, 0], [1, 64, 0], [0, 64, 1]], 'water', WM);
  assert.equal(lv(sq, 1, 64, 1), 0);
  // over air the gap does not convert (no solid, no source under): it falls
  const air = mapWorld(new Map([['0,63,0', 'stop'], ['2,63,0', 'stop']]), (x, y) => (y <= 60 ? 'stop' : 'open'));
  const st3 = steady(air.at, [[0, 64, 0], [2, 64, 0]], 'water', WM);
  assert.notEqual(lv(st3, 1, 64, 0), 0);
  const sim = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0], [2, 64, 0]], model: WM_MODEL }]);
  const b = sim.bodies[0];
  assert.deepEqual(b.converted, [[1, 64, 0]]);
  assert.ok(!b.predicted.some((p) => p[3] === 0), 'no level 0 in predicted');
  assert.ok(!b.predicted.some((p) => p[0] === 1 && p[1] === 64 && p[2] === 0));
  assert.ok(sim.findings.some((f) => f.rule === 'M25:convert' && f.sample.some((c) => k3(...c) === '1,64,0')));
  // the same body without the model: H's result (the converted cell at level 0 in predicted, as before)
  const h = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0], [2, 64, 0]] }]).bodies[0];
  assert.equal(h.converted, undefined);
  assert.ok(h.predicted.some((p) => k3(p[0], p[1], p[2]) === '1,64,0' && p[3] === 0));
});

test('WM vanilla: a waterlogged block is a foreign source: never entered, it feeds and spreads through its open faces only', () => {
  // a waterlogged bottom slab at 5,64,0 (its bottom face full): the body's flow wakes it; it spreads past itself
  const slab = 'minecraft:stone_slab[type=bottom,waterlogged=true]';
  assert.equal(wlMask(slab), FACE.down);
  const cells = new Map([['5,64,0', 'stop']]);
  const wl = (x, y, z) => (k3(x, y, z) === '5,64,0' ? wlMask(slab) : null);
  const w = mapWorld(cells, flat(), { wl });
  const src = [[0, 64, 0]];
  const plain = steady(w.at, src, 'water', WM);
  const woke = steady(w.at, src, 'water', { ...WM, wl });
  assert.equal(lv(plain, 5, 64, 0), undefined);
  assert.equal(lv(woke, 5, 64, 0), undefined, 'never entered');
  assert.equal(lv(plain, 6, 64, 0), undefined, 'the slab stops the plain flow (6 is 6 cells round it, level 7 is past it)');
  assert.equal(lv(woke, 6, 64, 0), 1, 'the slab feeds 6,64,0 as a source');
  assert.equal(lv(woke, 4, 64, 0), 1, 'and raises 4,64,0 to 1');
  assert.deepEqual(woke.foreign, [[5, 64, 0]]);
  // the reach covers the woken spread (a superset: never M25:model), and never includes the slab
  const r = reach(w.at, src, 'water', { wl });
  assert.ok(r.amt.has('6,64,0') && !r.amt.has('5,64,0'));
  assert.deepEqual(r.foreign, [[5, 64, 0]]);
  const sim = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: src, model: WM_MODEL }]);
  assert.deepEqual(sim.bodies[0].foreign, [[5, 64, 0]]);
  assert.ok(!sim.findings.some((f) => f.rule === 'M25:model'), JSON.stringify(sim.findings));
  // a stair's full back toward the flow: it neither feeds that side nor spreads through it
  const stair = 'minecraft:oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=true]';
  assert.equal(wlMask(stair), FACE.west | FACE.down);
  const ws = (x, y, z) => (k3(x, y, z) === '5,64,0' ? wlMask(stair) : null);
  const st = steady(w.at, src, 'water', { ...WM, wl: ws });
  assert.equal(lv(st, 6, 64, 0), 1, 'the open east face spreads');
  assert.equal(lv(st, 5, 64, 1), 1, 'and the open north and south faces');
  assert.equal(lv(st, 4, 64, 0), 3, 'the back face feeds nothing: 4,64,0 is fed round the stair (from 4,64,1 at 2), not to 1 as beside the slab');
});

test('WM vanilla: kelp and seagrass hold a source as a block: never a predicted cell, a foreign source', () => {
  assert.equal(wlMask('minecraft:kelp'), 0);
  assert.equal(wlMask('minecraft:seagrass'), 0);
  assert.equal(wlMask('minecraft:tall_seagrass[half=lower]'), 0);
  assert.equal(wlMask('minecraft:oak_stairs[facing=west]'), null, 'a dry stair holds no water');
  const cells = new Map([['3,64,0', 'stop']]);
  const wl = (x, y, z) => (k3(x, y, z) === '3,64,0' ? 0 : null);
  const w = mapWorld(cells, flat(), { wl });
  const sim = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0]], model: WM_MODEL }]);
  assert.ok(!sim.bodies[0].predicted.some((p) => k3(p[0], p[1], p[2]) === '3,64,0'));
  assert.deepEqual(sim.bodies[0].foreign, [[3, 64, 0]]);
});

test('WM: soul sand or magma under a source or predicted cell is M25:bubble, a lift\'s carried cells aside', () => {
  const bub = new Set(['2,63,0', '0,63,0']);
  const w = mapWorld(new Map(), flat(), { bubbler: (x, y, z) => bub.has(k3(x, y, z)) });
  const sim = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0]], model: WM_MODEL }]);
  const f = sim.findings.find((q) => q.rule === 'M25:bubble');
  assert.ok(f, 'raised');
  assert.deepEqual(f.sample, [[0, 64, 0], [2, 64, 0]]);
  const lift = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0]], model: WM_MODEL, carried: [[0, 64, 0]] }]);
  assert.deepEqual(lift.findings.find((q) => q.rule === 'M25:bubble').sample, [[2, 64, 0]]);
  // H's bodies: no bubble rule (byte-identical findings)
  assert.ok(!simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0]] }]).findings.some((q) => q.rule === 'M25:bubble'));
});

test('WM: the wash rule: a natural plant in a predicted cell is to clear; another owner\'s block is M25:wash', () => {
  const wash = (x, y, z) => (k3(x, y, z) === '2,64,0' ? 'clear' : k3(x, y, z) === '0,64,3' ? "the plan's own block" : null);
  const w = mapWorld(new Map(), flat(), { wash });
  const sim = simulate(w, [{ id: 'b', fluid: 'water', level: 64, cells: [[0, 64, 0]], model: WM_MODEL }]);
  assert.deepEqual(sim.bodies[0].wash, [[2, 64, 0]]);
  const f = sim.findings.find((q) => q.rule === 'M25:wash');
  assert.deepEqual(f.sample, [[0, 64, 3]]);
  assert.match(f.message, /the plan's own block 1/);
});

test('WM: the wash classifier over a virtual world (wmKinds): air none, a natural plant clear (refused once cleared is due), a plan torch refused', () => {
  const P = new Palette();
  const grass = P.of('minecraft:short_grass'), torch = P.of('minecraft:torch'), air = P.of('minecraft:air'), stone = P.of('minecraft:stone');
  const cells = new Map([['1,64,0', grass], ['2,64,0', torch], ['3,64,0', stone]]);
  const written = new Set(['2,64,0']);
  const vw = { pal: P, get: (x, y, z) => cells.get(k3(x, y, z)) ?? air, flags: (x, y, z) => (written.has(k3(x, y, z)) ? 1 : 0) };
  const K = wmKinds(vw);
  assert.equal(K.wash(0, 64, 0), null);
  assert.equal(K.wash(1, 64, 0), 'clear');
  assert.equal(K.wash(2, 64, 0), "the plan's own block");
  assert.equal(K.wash(3, 64, 0), null, 'a stone is no wash cell (it stops the flow)');
  assert.match(wmKinds(vw, { cleared: true }).wash(1, 64, 0), /not cleared/);
});

test('WM: levels from the world: a natural flowing cell at its recorded level, not amount 7', () => {
  // a natural flowing cell at 3,64,0 (level 6, a weak trickle); the body's source at 0,64,0 raises it to 3 either way, but the cell
  // beyond, 4,64,0, sees the right amount only with levels: from a level-1 guess (amount 7) it would be fed to 2 before the body's flow
  const cells = new Map([['3,64,0', 'flowing_water']]);
  const level = (x, y, z) => (k3(x, y, z) === '3,64,0' ? 6 : null);
  const w = mapWorld(cells, flat(), { level });
  const withLv = steady(w.at, [[0, 64, 0]], 'water', { ...WM, level });
  const without = steady(w.at, [[0, 64, 0]], 'water', WM);
  assert.equal(lv(withLv, 3, 64, 0), 3);
  assert.equal(lv(without, 3, 64, 0), 3);
  assert.equal(lv(withLv, 4, 64, 0), 4);
  assert.equal(levelOf('minecraft:water[level=6]'), 6);
  assert.equal(levelOf('minecraft:water[level=0]'), null);
  assert.equal(levelOf('minecraft:water'), null);
  assert.equal(levelOf('minecraft:lava[level=4]'), 4);
});

test('WM: the steady state past its round cap is a typed UNSETTLED result for a wm body, never a throw; H keeps the throw', () => {
  const w = mapWorld(new Map(), flat());
  assert.throws(() => steady(w.at, [[0, 64, 0]], 'water', { maxTicks: 2 }), /did not settle/);
  const st = steady(w.at, [[0, 64, 0]], 'water', { ...WM, maxTicks: 2 });
  assert.ok(st.unsettled);
  assert.equal(st.unsettled.rounds, 3);
  assert.ok(st.unsettled.cells > 0 && st.unsettled.sample.length > 0 && st.unsettled.sample.length <= 16);
});

// ------------------------------------------------------------------ determinism (§2.3)

/** A seeded LCG (no clock, no Math.random). */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** A random scene: a stepped floor, some walls, wl blocks, natural flowing cells; 1-4 sources. */
function scene(seed) {
  const rnd = lcg(seed);
  const floor = new Map();
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) floor.set(`${x},${z}`, 60 + Math.floor(rnd() * 3) + (x > 4 ? -1 : 0));
  const cells = new Map();
  const wls = new Map();
  for (let i = 0; i < 12; i++) { const x = Math.floor(rnd() * 21) - 10, z = Math.floor(rnd() * 21) - 10; cells.set(k3(x, floor.get(`${x},${z}`) + 1, z), 'stop'); }
  for (let i = 0; i < 3; i++) { const x = Math.floor(rnd() * 21) - 10, z = Math.floor(rnd() * 21) - 10; const k = k3(x, floor.get(`${x},${z}`) + 1, z); cells.set(k, 'stop'); wls.set(k, rnd() < 0.5 ? 0 : FACE.down); }
  const at = (x, y, z) => cells.get(k3(x, y, z)) ?? (Math.abs(x) > 10 || Math.abs(z) > 10 ? 'stop' : y <= floor.get(`${x},${z}`) ? 'stop' : 'open');
  const srcs = [];
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rnd() * 9) - 4, z = Math.floor(rnd() * 9) - 4;
    const y = floor.get(`${x},${z}`) + 1 + Math.floor(rnd() * 3);
    if (!cells.has(k3(x, y, z)) && !srcs.some((c) => k3(...c) === k3(x, y, z))) srcs.push([x, y, z]);
  }
  // pairs of sources a gap apart (conversion candidates)
  if (rnd() < 0.5 && srcs.length) { const [x, y, z] = srcs[0]; if (at(x + 2, y, z) === 'open') srcs.push([x + 2, y, z]); }
  return { at, srcs, wl: (x, y, z) => wls.get(k3(x, y, z)) ?? null };
}

const sameCells = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

test('WM determinism: the fixed point is independent of the tie order (scheduling order, (due, y desc, x, z), random permutations) and of the source order', () => {
  let differ = 0, scenes = 0, conversions = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const S = scene(seed);
    const base = steady(S.at, S.srcs, 'water', { wl: S.wl, onCap: 'result' });
    const yxz = steady(S.at, S.srcs, 'water', { wl: S.wl, order: 'yxz', onCap: 'result' });
    assert.ok(!base.unsettled && !yxz.unsettled);
    scenes++;
    if ([...yxz.cells].some(([k, v]) => v === 0 && !S.srcs.some((c) => k3(...c) === k))) conversions++;
    // the yxz result never depends on the order the sources are given in
    const rnd = lcg(seed * 7);
    const shuffled = [...S.srcs].sort(() => rnd() - 0.5);
    assert.ok(sameCells(steady(S.at, shuffled, 'water', { wl: S.wl, order: 'yxz' }).cells, yxz.cells), `seed ${seed}: source order`);
    if (!sameCells(base.cells, yxz.cells)) differ++;
    // random permutations of every tick batch
    for (let p = 0; p < 3; p++) {
      const pr = lcg(seed * 31 + p);
      const perm = (batch) => { for (let i = batch.length - 1; i > 0; i--) { const j = Math.floor(pr() * (i + 1)); [batch[i], batch[j]] = [batch[j], batch[i]]; } };
      const q = steady(S.at, S.srcs, 'water', { wl: S.wl, order: perm });
      if (!sameCells(q.cells, yxz.cells)) differ++;
    }
  }
  // the builder reading (§11): the tie order did not matter in any scene, conversions included
  assert.equal(differ, 0, `${differ} order-dependent fixed points over ${scenes} scenes (${conversions} with a conversion)`);
  assert.ok(conversions > 0, 'some scenes convert');
});

test('WM determinism: 1 worker and 4 workers (shuffled bodies) give the same predicted', async () => {
  const worker = new URL('./fixtures/wm/sim-worker.mjs', import.meta.url);
  const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
  const run = (js) => new Promise((resolve, reject) => {
    const w = new Worker(worker, { workerData: { seeds: js } });
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  });
  const one = await run(seeds);
  const rnd = lcg(99);
  const order = [...seeds].sort(() => rnd() - 0.5);
  const four = (await Promise.all([0, 1, 2, 3].map((k) => run(order.filter((_, i) => i % 4 === k))))).flat();
  const m1 = Object.fromEntries(one.map((r) => [r.seed, r.sha]));
  const m4 = Object.fromEntries(four.map((r) => [r.seed, r.sha]));
  assert.deepEqual(m4, m1);
});

// ------------------------------------------------------------------ ARVX version 4 (§2.1)

test('WM ARVX v4: levels round-trip in the fluid runs; v3 decodes as before; a bad level is refused', () => {
  const box = { minX: 0, minY: 60, minZ: 0, maxX: 1, maxY: 65, maxZ: 0 };
  const H = 6, n = 2 * H;
  const classes = new Uint8Array(n), index = new Uint16Array(n), fl = new Uint8Array(n), levels = new Uint8Array(n);
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:water', 'minecraft:oak_stairs'];
  // column 0: stone 60, water flowing 61 (level 3), 62 (level 2), falling 63 (level 8), air above; column 1: stone, a waterlogged stair, water source
  const set = (col, y, c, b, f, l) => { const i = col * H + (y - 60); classes[i] = c; index[i] = b; fl[i] = f; levels[i] = l; };
  set(0, 60, VC.ROCK, 1, FC.none, 0); set(0, 61, VC.WATER, 2, FC.water_flowing, 3); set(0, 62, VC.WATER, 2, FC.water_flowing, 2); set(0, 63, VC.WATER, 2, FC.water_falling, 8);
  set(1, 60, VC.ROCK, 1, FC.none, 0); set(1, 61, VC.BLOCK_ENTITY, 3, FC.waterlogged, 0); set(1, 62, VC.WATER, 2, FC.water_source, 0);
  const bytes = encodeArvx(box, classes, [], new Map(), { palette, index }, fl, levels);
  assert.equal(bytes[4], 4);
  const v = decodeArvx(bytes);
  assert.equal(v.version, 4);
  assert.equal(levelAt(v, 0, 61, 0), 3);
  assert.equal(levelAt(v, 0, 62, 0), 2);
  assert.equal(levelAt(v, 0, 63, 0), 8);
  assert.equal(levelAt(v, 1, 62, 0), 0);
  assert.equal(fluidAt(v, 0, 61, 0), FC.water_flowing);
  assert.equal(levelsMissing(v), null);
  // the same cells as v3: no levels
  const v3 = decodeArvx(encodeArvx(box, classes, [], new Map(), { palette, index }, fl));
  assert.equal(v3.version, 3);
  assert.equal(levelAt(v3, 0, 61, 0), null);
  assert.deepEqual(levelsMissing(v3), { why: 'levels', version: 3 });
  // a flowing run at level 0 is refused
  const bad = Uint8Array.from(levels); bad[1] = 0;
  assert.throws(() => decodeArvx(encodeArvx(box, classes, [], new Map(), { palette, index }, fl, bad)), /level 0 for fluid code water_flowing/);
  assert.throws(() => encodeArvx(box, classes, [], new Map(), null, null, levels), /also carries fluids/);
});

test('WM ARVX v4: the committed kit fixture decodes to its recorded cells and sha (fixtures/wm/levels.{bin,json})', () => {
  const dir = path.join(HERE, 'fixtures', 'wm');
  const exp = JSON.parse(fs.readFileSync(path.join(dir, 'levels.json'), 'utf8'));
  const v = decodeArvx(fs.readFileSync(path.join(dir, 'levels.bin')));
  assert.equal(v.sha, exp.sha);
  assert.equal(v.version, 4);
  for (const [x, y, z, fluid, level] of exp.cells) {
    assert.equal(fluidAt(v, x, y, z), FC[fluid], `${x} ${y} ${z}`);
    assert.equal(levelAt(v, x, y, z), level, `${x} ${y} ${z}`);
  }
});

test('WM ARVX v4: the virtual world reads its levels and waterlogged cells; a v3 volume reads as before', () => {
  const box = { minX: 0, minY: 60, minZ: 0, maxX: 0, maxY: 63, maxZ: 1 };
  const H = 4, n = 2 * H;
  const classes = new Uint8Array(n), index = new Uint16Array(n), fl = new Uint8Array(n), levels = new Uint8Array(n);
  const palette = ['minecraft:air', 'minecraft:stone', 'minecraft:water', 'minecraft:oak_fence', 'minecraft:kelp'];
  classes.fill(VC.ROCK, 0, 1); index[0] = 1;
  classes[1] = VC.WATER; index[1] = 2; fl[1] = FC.water_flowing; levels[1] = 5;
  classes[2] = VC.WATER; index[2] = 2; fl[2] = FC.water_falling; levels[2] = 8;
  classes[4] = VC.ROCK; index[4] = 1;
  classes[5] = VC.BLOCK_ENTITY; index[5] = 3; fl[5] = FC.waterlogged;
  classes[6] = VC.PLANT; index[6] = 4; fl[6] = FC.waterlogged;
  const survey = makeColumns(0, 0, 1, 2, 1);
  survey.ground.fill(59); survey.height.fill(59); survey.floor.fill(59);
  const P4 = new Palette();
  const b4 = surveyBase(survey, P4, [decodeArvx(encodeArvx(box, classes, [], new Map(), { palette, index }, fl, levels))]).base;
  assert.equal(P4.states[b4(0, 61, 0)], 'minecraft:water[level=5]');
  assert.equal(P4.states[b4(0, 62, 0)], 'minecraft:water[level=8]');
  assert.equal(P4.states[b4(0, 61, 1)], 'minecraft:oak_fence[waterlogged=true]');
  assert.equal(P4.states[b4(0, 62, 1)], 'minecraft:kelp');
  assert.equal(wlMask(P4.states[b4(0, 61, 1)]), 0);
  assert.equal(kindOf(P4, b4(0, 61, 1)), 'stop');
  const P3 = new Palette();
  const b3 = surveyBase(survey, P3, [decodeArvx(encodeArvx(box, classes, [], new Map(), { palette, index }, fl))]).base;
  assert.equal(P3.states[b3(0, 61, 0)], 'minecraft:water[level=1]', 'v3: flowing at 1');
  assert.equal(P3.states[b3(0, 62, 0)], 'minecraft:water[level=8]', 'v3: falling at 8');
  assert.notEqual(P3.states[b3(0, 61, 1)], 'minecraft:oak_fence[waterlogged=true]', 'v3: the class block, as before');
});

test('WM: the kit walks no new IR kind yet (KINDS_FORMAT2 equals the mod\'s IrStale; 8cF/VS add flowingWater and volume:levels on both sides)', () => {
  const ir = { parts: [{ id: 'p', ops: [{ op: 'fluid', model: 'wm' }] }], volumes: { a: { fluids: true, levels: true } } };
  assert.deepEqual(walkKinds(ir).filter((k) => k === 'flowingWater' || k === 'volume:levels'), []);
});

// ------------------------------------------------------------------ the opt-in path end to end

test('WM end to end: a wm body asks a levels volume (ARVX v4), its op carries model wm, the IR records the levels volume; the checker and the water lint are clean; 1 and 4 tile workers agree', async () => {
  const { planTwice } = await import('./h-helpers.mjs');
  const { columnsOf, worldOf } = await import('./region-helpers.mjs');
  const { checkRegion } = await import('../lib/region/check.mjs');
  const { lintPlanned } = await import('../lint/water.mjs');
  const demo = await import('./fixtures/wm/wm_demo.mjs');
  const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };
  const SURVEY = columnsOf(worldOf({ flat: 64 }), 0, 0, 64, 64, 1);
  const file = path.join(HERE, 'fixtures', 'wm', 'wm_demo.mjs');
  const p = await planTwice({ program: demo, programSource: fs.readFileSync(file, 'utf8'), params: {}, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' });
  assert.ok(p.first.needVolumes.some((v) => v.levels === true), 'the spout asks levels');
  assert.ok(p.first.needVolumes.some((v) => v.fluids === true && !v.levels), 'the H basin asks fluids only');
  assert.ok(p.volumes.some((v) => v.decoded.version === 4) && p.volumes.some((v) => v.decoded.version === 3));
  assert.ok(Object.values(p.ir.volumes).some((v) => v.levels === true) && Object.values(p.ir.volumes).some((v) => v.fluids === true && !v.levels));
  const ops = p.ir.parts.flatMap((q) => (q.ops ?? []).filter((o) => o.op === 'fluid'));
  assert.equal(ops.find((o) => o.id === 'spout').model, 'wm');
  assert.equal(ops.find((o) => o.id === 'basin').model, undefined);
  const spout = ops.find((o) => o.id === 'spout');
  assert.ok(spout.predicted.length > 0 && spout.predicted.every((q) => q[3] >= 1 && q[3] <= 8));
  const rep = checkRegion({ ir: p.ir, survey: SURVEY, blobs: (sha) => p.blobs?.[sha] ?? null, volumes: p.volumes.map((v) => v.decoded), meta: p.meta, prefix: false, rules: ['M25', 'M20'] });
  const errs = rep.findings.filter((f) => f.severity === 'error');
  assert.deepEqual(errs.map((f) => `${f.rule}: ${f.message}`), []);
  const l = lintPlanned({ ir: p.ir, meta: p.meta, blobs: p.blobs, volumes: p.volumes.map((v) => v.decoded), survey: SURVEY, name: 'wm_demo' });
  assert.deepEqual(l.findings.map((f) => `${f.rule} ${f.body}: ${f.message}`), []);
  // tile shas: 1 worker in order = 4 workers shuffled (the region-golden harness)
  const WORKER = new URL('./fixtures/regions/eval-worker.mjs', import.meta.url);
  const evalIn = (jobs) => new Promise((resolve, reject) => { const w = new Worker(WORKER, { workerData: { irJson: p.irJson, seed: '7', jobs, blobs: p.blobs } }); w.once('message', (m) => { resolve(m); void w.terminate(); }); w.once('error', reject); });
  const jobs = [];
  for (const stage of p.ir.stages) for (const set of ['terrain', 'path']) for (const key of p.ir.tiles[stage][set]) jobs.push({ key, stage, set });
  const one = await evalIn(jobs);
  const rnd = lcg(5);
  const order = [...jobs].sort(() => rnd() - 0.5);
  const four = (await Promise.all([0, 1, 2, 3].map((k) => evalIn(order.filter((_, i) => i % 4 === k))))).flat();
  const id = (j) => `${j.stage}|${j.set}|${j.key}`;
  assert.deepEqual(Object.fromEntries(four.map((r) => [id(r), r.sha])), Object.fromEntries(one.map((r) => [id(r), r.sha])));
  // planning twice gives the same IR (no clock, no random numbers)
  const again = await planTwice({ program: demo, programSource: fs.readFileSync(file, 'utf8'), params: {}, survey: SURVEY, seed: '7', claim: CLAIM, node: 'test' });
  assert.equal(again.irSha, p.irSha);
});
