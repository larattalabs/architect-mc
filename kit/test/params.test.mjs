// Phase 2: parametric designs and palettes (docs/CONTRACT.md "Parametric designs"). Every example at every corner of
// its param domain, in every palette preset, passes the checker with no warnings; recorded palettes rebuild the same
// template; values and palettes are validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDesign, listDesigns } from '../build.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { Blueprint, PALETTES, PALETTE_PRESETS, palette, resolvePalette, stoneFamilyOf, woodFamilyOf } from '../lib/kit.mjs';
import { cornerValues, defaultValues, resolveValues, validateParams } from '../lib/params.mjs';
import { encode } from '../lib/nbt.mjs';

const EXAMPLES = ['cabin', 'tower', 'tavern', 'gatehouse'];
const PRESETS = Object.keys(PALETTE_PRESETS);

test('about ten palette presets, including cherry, mangrove, crimson and fortress', () => {
  assert.ok(PRESETS.length >= 10, PRESETS.join(', '));
  for (const n of ['rustic', 'oak', 'birch', 'dark', 'desert', 'brick', 'cherry', 'mangrove', 'crimson', 'fortress']) assert.ok(PRESETS.includes(n), n);
});

test('the examples are in kit/designs and each declares 2-4 params', async () => {
  for (const id of EXAMPLES) {
    assert.ok(listDesigns().includes(id), id);
    const mod = await import(`../designs/${id}.mjs`);
    validateParams(mod.params);
    const n = Object.keys(mod.params ?? {}).length;
    assert.ok(n >= 2 && n <= 4, `${id}: ${n} params`);
  }
});

for (const id of EXAMPLES) {
  test(`${id}: every corner of its params in every preset passes with no warnings`, async () => {
    const mod = await import(`../designs/${id}.mjs`);
    const corners = cornerValues(mod.params);
    const bad = [];
    for (const preset of PRESETS) {
      for (const values of corners) {
        const bp = await loadDesign(id, { palette: preset, values });
        const r = checkBlueprint(bp);
        if (!r.ok || r.warnings.length) bad.push(`${preset} ${JSON.stringify(values)}: ${[...r.errors, ...r.warnings].join(' | ')}`);
      }
    }
    assert.deepEqual(bad, [], `${bad.length} of ${PRESETS.length * corners.length} builds failed:\n${bad.slice(0, 8).join('\n')}`);
  });
}

test('the sidecar records the palette inputs, params and values', async () => {
  const bp = await loadDesign('tower', { palette: 'cherry', values: { floors: 5 } });
  const sc = bp.sidecar();
  assert.deepEqual(sc.palette, { preset: 'cherry', wood: 'cherry', stone: 'polished_tuff', roof: 'dark_oak', accent: 'dark_oak' });
  assert.equal(sc.params.floors.type, 'int');
  assert.deepEqual(sc.values, { floors: 5, width: 7, roof: 'hip' });
  for (const k of ['favorite', 'userTags', 'displayName']) assert.ok(!(k in sc), k);
  // without a palette the design's own default, recorded with its preset name
  assert.equal((await loadDesign('tower')).sidecar().palette.preset, 'fortress');
  assert.equal((await loadDesign('cabin')).sidecar().palette.preset, 'rustic');
});

test('a recorded palette rebuilds the same template', async () => {
  for (const [id, palette, values] of [['cabin', 'mangrove', { width: 11, porch: false }], ['tavern', { preset: 'rustic', wood: 'birch' }, {}], ['gatehouse', { wood: 'acacia', stone: 'red_sandstone' }, { passage: 5 }]]) {
    const a = await loadDesign(id, { palette, values });
    const sc = JSON.parse(JSON.stringify(a.sidecar()));
    const b = await loadDesign(id, { palette: sc.palette, values: sc.values });
    assert.ok(encode(a.toStructure()).equals(encode(b.toStructure())), `${id} ${JSON.stringify(palette)}`);
    assert.deepEqual(b.sidecar().palette, sc.palette);
  }
});

test('custom palettes: inputs only, validated', () => {
  assert.equal(resolvePalette({ wood: 'birch' }).planks, 'minecraft:birch_planks');
  assert.equal(resolvePalette({ preset: 'desert', wood: 'acacia' }).plaster, 'minecraft:smooth_sandstone');
  assert.equal(resolvePalette('crimson').door, 'minecraft:crimson_door');
  for (const bad of ['nope', { wood: 'plastic' }, { stone: 'calcite' }, { stone: 'minecraft:not_a_block' }, { roof: 'glass' }, { accent: 'cobblestone' }, { wall: 'minecraft:stone' }, { preset: 'nope' }, ['oak'], null]) {
    assert.throws(() => resolvePalette(bad), /palette/, JSON.stringify(bad));
  }
  // every recorded input set means the same palette again
  for (const n of PRESETS) assert.deepEqual(palette(PALETTES[n].inputs).inputs, PALETTES[n].inputs);
});

test('values: defaults, overrides, and every kind of bad value', () => {
  const params = { floors: { type: 'int', min: 1, max: 3, default: 1 }, porch: { type: 'bool', default: true }, roof: { type: 'enum', options: ['gable', 'hip'], default: 'gable' } };
  validateParams(params);
  assert.deepEqual(defaultValues(params), { floors: 1, porch: true, roof: 'gable' });
  assert.deepEqual(resolveValues(params, { floors: 3, roof: 'hip' }), { floors: 3, porch: true, roof: 'hip' });
  for (const bad of [{ floors: 4 }, { floors: 1.5 }, { floors: '2' }, { porch: 'yes' }, { roof: 'dome' }, { towers: 2 }]) assert.throws(() => resolveValues(params, bad), /values/, JSON.stringify(bad));
  assert.throws(() => resolveValues({}, { floors: 1 }), /no params/);
  assert.equal(cornerValues(params).length, 2 * 2 * 2);
  for (const bad of [{ a: { type: 'int', min: 3, max: 1, default: 2 } }, { a: { type: 'int', min: 1, max: 3, default: 5 } }, { a: { type: 'bool', default: 'no' } }, { a: { type: 'enum', options: ['x'], default: 'x' } }, { a: { type: 'float', default: 1 } }, { palette: { type: 'bool', default: true } }]) {
    assert.throws(() => validateParams(bad), undefined, JSON.stringify(bad));
  }
});

test('families: woods and stone families of blocks', () => {
  assert.equal(woodFamilyOf('minecraft:dark_oak_planks'), 'dark_oak');
  assert.equal(woodFamilyOf('stripped_spruce_log'), 'spruce');
  assert.equal(woodFamilyOf('minecraft:crimson_hyphae'), 'crimson');
  assert.equal(woodFamilyOf('minecraft:oak_leaves'), null);
  assert.equal(woodFamilyOf('minecraft:crafting_table'), null);
  assert.equal(stoneFamilyOf('minecraft:deepslate_tile_stairs'), 'deepslate');
  assert.equal(stoneFamilyOf('minecraft:stone_brick_wall'), 'stone');
  assert.equal(stoneFamilyOf('minecraft:smooth_stone_slab'), 'stone');
  assert.equal(stoneFamilyOf('minecraft:quartz_slab'), 'quartz');
  assert.equal(stoneFamilyOf('minecraft:cobblestone'), 'cobblestone');
  assert.equal(stoneFamilyOf('minecraft:stone_button'), null);
  assert.equal(stoneFamilyOf('minecraft:grindstone'), null);
});

test('checker: a wood or stone family not from the palette is a warning', () => {
  const p = palette({ preset: 'rustic' });
  const hut = (extra) => {
    const bp = new Blueprint({ id: 'hut', type: 'custom', size: [5, 5, 7], palette: p, interior: [1, 1, 1, 3, 3, 3] });
    bp.floor(0, 0, 4, 6, 0, p.stone);
    bp.carve([1, 1, 1, 3, 3, 3]);
    bp.walls(0, 0, 4, 4, 1, 3);
    bp.floor(0, 0, 4, 4, 4, p.planks);
    bp.door(2, 1, 4, 'south');
    bp.lantern(2, 3, 2, true);
    bp.spot('entrance', 2, 5, 180);
    bp.spot('spawn', 2, 6, 180);
    extra?.(bp);
    return checkBlueprint(bp);
  };
  assert.deepEqual(hut().warnings, []);
  const oak = hut((bp) => bp.set(1, 1, 1, 'minecraft:oak_planks'));
  assert.ok(oak.ok);
  assert.ok(oak.warnings.some((w) => /wood 'oak'/.test(w)), oak.warnings.join(' | '));
  const sand = hut((bp) => bp.set(1, 1, 1, 'minecraft:sandstone_stairs', { facing: 'north' }));
  assert.ok(sand.warnings.some((w) => /stone family 'sandstone'/.test(w)), sand.warnings.join(' | '));
  // the accent (dark oak) and buttons are fine
  assert.deepEqual(hut((bp) => { bp.set(1, 1, 1, p.accentPlanks); bp.set(1, 2, 1, 'minecraft:stone_button', { face: 'floor', facing: 'north' }); }).warnings, []);
});
