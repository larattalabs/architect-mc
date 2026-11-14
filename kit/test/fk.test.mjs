// (M5 FK, S-M5-3) A given program's fill: bp.fill's sidecar member (template coordinates; absent without one), the checker's rule `fill`
// (every refusal case of docs/CONTRACT.md "### FK contract" 1), and mirror/invert refusing a fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesign } from '../build.mjs';
import { Blueprint } from '../lib/kit.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { checkFill, FILL_CONTAINERS_MAX, normalizeFill } from '../lib/fill.mjs';
import { mirrorBlueprint } from '../lib/mirror.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'fk', 'fk_hall.mjs'), 'utf8');

function designDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-test-'));
  const lib = pathToFileURL(path.join(KIT, 'lib')).href;
  for (const [id, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${id}.mjs`), src.replaceAll("'../lib/", `'${lib}/`));
  return dir;
}

test('fk_hall builds clean; the sidecar records its fill in template coordinates', async () => {
  const dir = designDir({ fk_hall: SOURCE });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-out-'));
  try {
    const { bp, result } = await buildDesign('fk_hall', { dir, out, values: { slots: 3, count: 20 } });
    assert.deepEqual(result.errors, []);
    const side = JSON.parse(fs.readFileSync(path.join(out, 'fk_hall.blueprint.json'), 'utf8'));
    assert.equal(side.fill.containers.length, 3);
    assert.deepEqual(side.fill.containers[0], { at: [1, 2, 1], items: [{ slot: 0, id: 'minecraft:cobblestone', count: 20 },
      { slot: 1, id: 'minecraft:stick', count: 1 }, { slot: 2, id: 'minecraft:stick', count: 1 }, { slot: 3, id: 'minecraft:stick', count: 1 },
      { slot: 4, id: 'minecraft:stick', count: 1 }] });
    assert.deepEqual(side.fill.locks, [{ at: [0, 3, 1], locked: { powered: 'true' } }]);
    assert.equal(bp.get(0, 3, 1).state.props.powered, 'false', 'the template holds the unlocked state');
    assert.throws(() => mirrorBlueprint(bp), /can't be mirrored/);
    assert.throws(() => bp.invert(), /can't be inverted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a design without a fill has no fill member', () => {
  const bp = new Blueprint({ id: 'plain', size: [1, 1, 1], groundY: 0 });
  bp.set(0, 0, 0, 'minecraft:stone');
  assert.equal('fill' in bp.sidecar(), false);
});

test('design coordinates are moved to template coordinates; ids qualified; slots sorted', () => {
  const f = normalizeFill({ containers: [{ at: [0, 0, 0], items: [{ slot: 2, id: 'dirt', count: 3 }, { slot: 0, id: 'minecraft:sand', count: 1 }] }] }, [2, 1, 3]);
  assert.deepEqual(f, { containers: [{ at: [2, 1, 3], items: [{ slot: 0, id: 'minecraft:sand', count: 1 }, { slot: 2, id: 'minecraft:dirt', count: 3 }] }], locks: [] });
  assert.throws(() => normalizeFill({ containers: [{ at: [0, 0], items: [] }] }), /at must be/);
  const bp = new Blueprint({ id: 'twice', size: [1, 1, 1], groundY: 0 });
  bp.fill({ containers: [] });
  assert.throws(() => bp.fill({ containers: [] }), /declared twice/);
});

/** A grid of named cells for checkFill ("x,y,z" -> {name, props}), the props complete as the checker's palette has them. */
const cells = new Map([
  ['0,0,0', { name: 'minecraft:hopper', props: { enabled: 'true', facing: 'down' } }],
  ['1,0,0', { name: 'minecraft:chest', props: { facing: 'north', type: 'single', waterlogged: 'false' } }],
  ['2,0,0', { name: 'minecraft:stone', props: {} }],
  ['3,0,0', { name: 'minecraft:lever', props: { face: 'floor', facing: 'east', powered: 'false' } }],
  ['4,0,0', { name: 'minecraft:shulker_box', props: { facing: 'up' } }],
]);
const SIZE = [5, 1, 1];
const hop = (items, at = [0, 0, 0]) => ({ at, items });
const one = [{ slot: 0, id: 'minecraft:dirt', count: 1 }];
const run = (fill) => checkFill(fill, cells, SIZE);

test('the fill rule accepts a sound declaration', () => {
  assert.deepEqual(run({ containers: [hop(one), hop([{ slot: 26, id: 'minecraft:sand', count: 64 }], [1, 0, 0])], locks: [{ at: [3, 0, 0], locked: { powered: 'true' } }] }), []);
});

test('the fill rule refuses every bad case, each line prefixed fill:', () => {
  const cases = [
    [{ containers: [], locks: [] }, /declares no container/],
    [{ containers: Array.from({ length: FILL_CONTAINERS_MAX + 1 }, () => hop(one)), locks: [] }, /at most 64/],
    [{ containers: [hop(one, [9, 0, 0])], locks: [] }, /outside the template/],
    [{ containers: [hop(one), hop(one)], locks: [] }, /declared twice/],
    [{ containers: [hop(one, [2, 0, 0])], locks: [] }, /not a container a fill may declare/],
    [{ containers: [hop(one, [4, 0, 0])], locks: [] }, /not a container a fill may declare/],
    [{ containers: [hop([{ slot: 5, id: 'minecraft:dirt', count: 1 }])], locks: [] }, /slot 5 must be 0..4/],
    [{ containers: [hop([{ slot: 0, id: 'minecraft:dirt', count: 1 }, { slot: 0, id: 'minecraft:sand', count: 1 }])], locks: [] }, /filled twice/],
    [{ containers: [hop([{ slot: 0, id: 'minecraft:dirt', count: 65 }])], locks: [] }, /count 65/],
    [{ containers: [hop([{ slot: 0, id: 'minecraft:air', count: 1 }])], locks: [] }, /plain item id/],
    [{ containers: [hop([{ slot: 0, id: 'minecraft:dirt', count: 1, components: { custom_name: 'x' } }])], locks: [] }, /no components/],
    [{ containers: [hop(one)], locks: [{ at: [0, 0, 0], locked: { enabled: 'false' } }] }, /declared twice/],
    [{ containers: [hop(one)], locks: [{ at: [3, 0, 0], locked: { lit: 'true' } }] }, /not a state of minecraft:lever/],
    [{ containers: [hop(one)], locks: [{ at: [3, 0, 0], locked: { powered: 'false' } }] }, /the template's own state/],
    [{ containers: [hop(one)], locks: [{ at: [2, 0, 0], locked: {} }] }, /at least one property/],
  ];
  for (const [fill, re] of cases) {
    const errs = run(fill);
    assert.ok(errs.length > 0 && errs.every((e) => e.startsWith('fill: ')), `${JSON.stringify(fill).slice(0, 80)} -> ${errs}`);
    assert.ok(errs.some((e) => re.test(e)), `${re} in ${errs}`);
  }
});

test('the checker runs the fill rule', () => {
  const bp = new Blueprint({ id: 'bad_fill', size: [1, 1, 1], groundY: 0 });
  bp.set(0, 0, 0, 'minecraft:stone');
  bp.fill({ containers: [{ at: [0, 0, 0], items: one }] });
  const r = checkBlueprint(bp, {});
  assert.ok(r.errors.some((e) => /^fill: containers\[0\]: minecraft:stone/.test(e)), r.errors.join('\n'));
});
