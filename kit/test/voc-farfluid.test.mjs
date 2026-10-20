// (fix/voc-natural) voc-natural item 9's `farfluid` class (tools/lib/gate6cvoc-b.mjs farFluidOf): S3's own fluids settling far from
// the plan are the world's; anything else (another kind, a source block, a written cell, a lot, within 7 of a write) stays unclassified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { farFluidOf } from '../../tools/lib/gate6cvoc-b.mjs';

const written = new Set(['100,64,100', '101,64,100']);
const lots = [{ id: 'c1', box: { minX: 200, minY: 60, minZ: 200, maxX: 210, maxY: 80, maxZ: 210 } }];
const one = (pos, was, now) => farFluidOf({ mismatches: 1, classes: { none: 1 }, list: [{ pos, was, now, class: 'none' }] }, { written, lots });
const cls = (d) => d.list[0].class;

test('far flowing water and lava over air (both ways) are classed farfluid', () => {
  for (const [was, now] of [['minecraft:air', 'minecraft:water[level=8]'], ['minecraft:cave_air', 'minecraft:water[level=1]'],
    ['minecraft:air', 'minecraft:lava[level=6]'], ['minecraft:water[level=3]', 'minecraft:air'], ['minecraft:water[level=5]', 'minecraft:water[level=2]']]) {
    const d = one('190,37,124', was, now);
    assert.equal(cls(d), 'farfluid', `${was} -> ${now}`);
    assert.deepEqual(d.classes, { farfluid: 1 });
  }
});

test('a source block on either side stays none', () => {
  assert.equal(cls(one('190,37,124', 'minecraft:air', 'minecraft:water[level=0]')), 'none');
  assert.equal(cls(one('190,37,124', 'minecraft:lava[level=0]', 'minecraft:air')), 'none');
  assert.equal(cls(one('190,37,124', 'minecraft:water', 'minecraft:air')), 'none');
});

test('a far change of another kind stays none', () => {
  assert.equal(cls(one('190,37,124', 'minecraft:stone', 'minecraft:air')), 'none');
  assert.equal(cls(one('190,37,124', 'minecraft:air', 'minecraft:cobblestone')), 'none');
  assert.equal(cls(one('190,37,124', 'minecraft:stone', 'minecraft:water[level=1]')), 'none');
  assert.equal(cls(one('190,37,124', 'minecraft:air', 'minecraft:cave_air')), 'none');
});

test('the same fluid change at a written cell, within 7 of one, or in a lot stays none', () => {
  assert.equal(cls(one('100,64,100', 'minecraft:air', 'minecraft:water[level=8]')), 'none');
  assert.equal(cls(one('104,67,101', 'minecraft:air', 'minecraft:water[level=8]')), 'none'); // Manhattan 7 from 101,64,100
  assert.equal(cls(one('105,67,101', 'minecraft:air', 'minecraft:water[level=8]')), 'farfluid'); // Manhattan 8
  assert.equal(cls(one('205,70,205', 'minecraft:air', 'minecraft:water[level=8]')), 'none');
});

test('other classes and the counts are kept', () => {
  const d = farFluidOf({ mismatches: 3, classes: { none: 2, live: 1 }, list: [
    { pos: '190,37,124', was: 'minecraft:air', now: 'minecraft:water[level=8]', class: 'none' },
    { pos: '190,38,124', was: 'minecraft:stone', now: 'minecraft:air', class: 'none' },
    { pos: '100,65,100', was: 'minecraft:bee_nest', now: 'minecraft:bee_nest', class: 'live' },
  ] }, { written, lots });
  assert.deepEqual(d.classes, { none: 1, live: 1, farfluid: 1 });
  assert.deepEqual(d.list.map((m) => m.class), ['farfluid', 'none', 'live']);
  assert.equal(d.mismatches, 3);
});
