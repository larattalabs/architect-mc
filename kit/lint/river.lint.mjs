// (8c CL) The water lint's W5 over rivers and E-normal's refed class (kit/lint/water.mjs riverCases, flowClasses): the committed
// kit/lint/fixtures/river-cases.json equals what riverCases() generates, and each of the 8c contract §3's fixtures carries its classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RIVER_CASES, riverCases, riverCasesJson, flowClasses, fedBy } from './water.mjs';
import { mapWorld, FACE } from '../lib/fluids/sim.mjs';

const by = Object.fromEntries(riverCases().map((c) => [c.name, c]));
const cls = (c, name) => c.cells.filter((q) => q.class === name);
const at = (c, x, y, z) => c.cells.find((q) => q.at[0] === x && q.at[1] === y && q.at[2] === z);

test('CL: the committed river cases equal the generated ones (node kit/lint/water.mjs --write)', () => {
  assert.equal(fs.readFileSync(RIVER_CASES, 'utf8'), riverCasesJson());
  assert.deepEqual(Object.keys(by), ['river/stream', 'river/bucket', 'river/waterlogged', 'river/cauldron', 'river/converted']);
});

test('CL: every case: the drain takes sources, own-only and raised cells (raised down to the foreign level) and never a joint, foreign or block cell', () => {
  for (const c of Object.values(by)) {
    for (const q of c.cells) {
      const take = ['source', 'own', 'raised'].includes(q.class);
      assert.equal(q.drain, take ? 'take' : 'keep', `${c.name} ${q.at}: ${q.class}`);
      if (q.class === 'joint') assert.equal(q.after, q.now, `${c.name} ${q.at}: a joint cell keeps the foreign level`);
      if (q.class === 'own' || q.class === 'source') assert.equal(q.after, null, `${c.name} ${q.at}: drained to its before (air)`);
      if (q.class === 'raised') assert.ok(q.after !== null && q.after !== q.now, `${c.name} ${q.at}: down to the foreign level`);
    }
    assert.ok(cls(c, 'source').length >= 9, c.name);
  }
});

test('CL: a river over a natural stream: joint and raised where the stream meets it; the stream\'s stale frozen levels outside the watch set are refed', () => {
  const c = by['river/stream'];
  assert.ok(cls(c, 'joint').length > 10 && cls(c, 'raised').length > 0 && cls(c, 'own').length > 10);
  assert.deepEqual(cls(c, 'refed').map((q) => [q.at, q.now]), [[[14, 64, 3], 5], [[15, 64, 3], 6]], 'frozen at level 1, the spring alone holds 5 and 6');
  assert.ok(cls(c, 'refed').every((q) => q.drain === 'keep'));
});

test('CL: a player\'s bucket beside a bank: its source and every cell it feeds at its own level are never taken', () => {
  const c = by['river/bucket'];
  assert.equal(at(c, 6, 64, 3).class, 'foreign');
  assert.ok(cls(c, 'joint').length > 20);
  assert.equal(cls(c, 'refed').length, 0);
});

test('CL: a waterlogged stair in the reach is a foreign source (the body\'s foreign list): a block, never written; the flow it feeds joint', () => {
  const c = by['river/waterlogged'];
  assert.deepEqual(c.foreign, [[2, 64, 0]], 'the body\'s foreign list names it');
  assert.equal(at(c, 2, 64, 0).class, 'block');
  assert.equal(at(c, 2, 64, 0).drain, 'keep');
  assert.ok(cls(c, 'joint').length > 20 && cls(c, 'own').length === 0, 'the stair feeds every cell past it');
});

test('CL: a drained river with a rain-filled cauldron: a volatile level, still ours, never written', () => {
  const c = by['river/cauldron'];
  assert.deepEqual(cls(c, 'volatile').map((q) => [q.at, q.before, q.now, q.drain]), [[[3, 64, -1], 'minecraft:cauldron', 'minecraft:water_cauldron[level=1]', 'keep']]);
});

test('CL: a converted cell is lifted into the body\'s written sources (until none is left): a source the drain takes, never a prediction', () => {
  const c = by['river/converted'];
  assert.ok(c.lifted.some((q) => q.join() === '0,64,0'));
  for (const q of c.lifted) {
    const e = at(c, ...q);
    assert.equal(e.class, 'source');
    assert.equal(e.lifted, true);
    assert.ok(c.own.some((o) => o.join() === q.join()));
  }
});

test('CL: fedBy under the water model ticks a foreign waterlogged block without writing it (its faces hold); flowClasses on a small world', () => {
  // a 1-wide channel x 1..12; a waterlogged slab (bottom: its down face full) at 6 as the only foreign source
  const ch = new Map();
  for (let x = 1; x <= 12; x++) ch.set(`${x},64,0`, 'open');
  ch.set('6,64,0', 'stop');
  const w = mapWorld(ch, () => 'stop');
  const wm = { wl: (x, y, z) => (x === 6 && y === 64 && z === 0 ? FACE.down : null), level: () => null };
  const f = fedBy(w.at, [[0, 64, 0]], [[6, 64, 0]], 'water', wm);
  assert.ok(f.foreignOnly.has('7,64,0') && f.foreignOnly.has('5,64,0'), 'the slab spreads both ways once ticked');
  assert.ok(!f.all.has('6,64,0'), 'never written');
  const watch = new Set([...Array(14).keys()].map((x) => `${x},64,0`));
  const fl = flowClasses(w.at, [[0, 64, 0]], [[6, 64, 0]], watch, wm);
  assert.equal(fl.get('6,64,0').class, 'block');
  assert.equal(fl.get('1,64,0').class, 'raised');
  assert.equal(fl.get('8,64,0').class, 'joint');
});

/** A seeded LCG (no clock, no Math.random). */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test('CL property: over random scenes, one class per cell; the drain takes exactly source, own and raised; raised goes to the foreign level; refed only outside the watch set', async () => {
  const { simulate, WATCH_GROW } = await import('../lib/fluids/sim.mjs');
  let n = 0, seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = lcg(seed);
    const extra = new Map(), wls = new Map(), levels = new Map();
    for (let i = 0; i < 10; i++) extra.set(`${Math.floor(rnd() * 25) - 12},64,${Math.floor(rnd() * 25) - 12}`, 'stop');
    for (let i = 0; i < 2; i++) { const k = `${Math.floor(rnd() * 25) - 12},64,${Math.floor(rnd() * 25) - 12}`; extra.set(k, 'stop'); if (rnd() < 0.6) wls.set(k, rnd() < 0.5 ? 0 : FACE.down); }
    for (let i = 0; i < 3; i++) { const k = `${Math.floor(rnd() * 25) - 12},64,${Math.floor(rnd() * 25) - 12}`; if (!extra.has(k)) { extra.set(k, 'flowing_water'); levels.set(k, 1 + Math.floor(rnd() * 7)); } }
    const at = (x, y, z) => extra.get(`${x},${y},${z}`) ?? (y <= 63 || Math.abs(x) > 14 || Math.abs(z) > 14 ? 'stop' : 'open');
    const own = [[0, 64, 0], [1, 64, 0]].filter((c) => at(...c) === 'open');
    if (!own.length) continue;
    const foreign = [];
    for (let i = 0; i < Math.floor(rnd() * 3); i++) { const c = [Math.floor(rnd() * 25) - 12, 64, Math.floor(rnd() * 25) - 12]; if (at(...c) === 'open' && !own.some((o) => o.join() === c.join())) foreign.push(c); }
    const wm = { wl: (x, y, z) => wls.get(`${x},${y},${z}`) ?? null, level: (x, y, z) => levels.get(`${x},${y},${z}`) ?? null };
    const body = simulate({ at, wl: wm.wl, level: wm.level }, [{ id: 'b', fluid: 'water', level: 64, cells: own, model: 'wm' }]).bodies[0];
    const watch = new Set();
    for (const c of [...body.reached, ...own]) for (let dx = -WATCH_GROW; dx <= WATCH_GROW; dx++) for (let dy = -WATCH_GROW; dy <= WATCH_GROW; dy++) for (let dz = -WATCH_GROW; dz <= WATCH_GROW; dz++) watch.add(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
    const all = [...foreign, ...body.foreign];
    const fl = flowClasses(at, own, all, watch, wm);
    const f = fedBy(at, own, all, 'water', wm);
    for (const [k, v] of fl) {
      n++;
      seen.add(v.class);
      assert.equal(v.drain === 'take', ['source', 'own', 'raised'].includes(v.class), `seed ${seed} ${k}: ${v.class} ${v.drain}`);
      if (v.class === 'raised') assert.equal(v.after, f.foreignOnly.get(k), `seed ${seed} ${k}`);
      if (v.class === 'refed' || v.class === 'eflat') assert.ok(!watch.has(k), `seed ${seed} ${k}: ${v.class} inside the watch set`);
      else assert.ok(watch.has(k), `seed ${seed} ${k}: ${v.class} outside the watch set`);
      if (v.class === 'source' || v.class === 'own') { const [x, y, z] = k.split(',').map(Number); assert.equal(v.after, at(x, y, z) === 'flowing_water' ? levels.get(k) : null, `seed ${seed} ${k}: back to its before`); }
    }
  }
  assert.ok(n > 1000, `${n} cells`);
  for (const c of ['source', 'own', 'joint', 'raised', 'foreign']) assert.ok(seen.has(c), `class ${c} seen`);
});
