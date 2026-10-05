// Spot checks of the generated block table (kit/lib/blocks.mjs) per block family.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS, normalize, qualify, collisionOf, isCube, emissionOf, opticsOf, isConductor, supportOf, isFloor, isPassable,
  isClimbable, itemOf, familyOf, topOf,
} from '../lib/blocks.mjs';
import { COLORS } from '../lib/colors.mjs';

const st = (name, props = {}) => normalize(name, props);
const coll = (name, props) => collisionOf(st(name, props));

test('every vanilla block, no AgentCraft blocks', () => {
  const ids = Object.keys(BLOCKS);
  assert.ok(ids.length > 1200, `${ids.length} blocks`);
  assert.ok(ids.every((k) => k.startsWith('minecraft:')));
  for (const k of ['minecraft:stone', 'minecraft:oak_planks', 'minecraft:deepslate_tiles', 'minecraft:cherry_stairs', 'minecraft:bamboo_mosaic', 'minecraft:copper_bulb', 'minecraft:pale_oak_door']) assert.ok(BLOCKS[k], k);
});

test('defaults come from the report default state', () => {
  assert.deepEqual(st('oak_stairs').props, { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
  assert.deepEqual(st('oak_door').props, { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' });
  assert.equal(st('oak_log').props.axis, 'y');
  assert.equal(st('oak_slab').props.type, 'bottom');
  assert.equal(st('oak_leaves').props.persistent, 'false');
});

test('normalize validates names, properties and values', () => {
  assert.equal(qualify('stone'), 'minecraft:stone');
  assert.throws(() => normalize('stone_brick'), /unknown block/);
  assert.throws(() => normalize('oak_stairs', { facing: 'up' }), /invalid value 'up'/);
  assert.throws(() => normalize('oak_planks', { axis: 'y' }), /unknown property/);
  assert.equal(normalize('candle', { candles: 3, lit: true }).props.candles, '3');
});

test('collision classes per family', () => {
  for (const n of ['stone', 'oak_planks', 'glass', 'oak_leaves', 'bookshelf', 'barrel', 'oak_log', 'white_wool', 'glowstone']) assert.equal(coll(n), 'full', n);
  for (const n of ['air', 'torch', 'wall_torch', 'oak_button', 'oak_sign', 'oak_wall_sign', 'poppy', 'short_grass', 'rail', 'water', 'light', 'snow', 'redstone_wire']) assert.equal(coll(n), 'none', n);
  for (const n of ['white_carpet', 'moss_carpet', 'lily_pad']) assert.equal(coll(n), 'low', n);
  for (const n of ['oak_fence', 'cobblestone_wall', 'glass_pane', 'iron_bars', 'red_stained_glass_pane']) assert.equal(coll(n), 'thin', n);
  for (const n of ['lantern', 'chest', 'ladder', 'red_bed', 'flower_pot', 'candle', 'anvil', 'lectern']) assert.equal(coll(n), 'partial', n);
  for (const n of ['oak_stairs', 'stone_brick_stairs', 'cut_copper_stairs']) assert.equal(coll(n), 'stairs', n);
  assert.equal(coll('oak_slab'), 'slab');
  assert.equal(coll('oak_slab', { type: 'double' }), 'full');
  assert.equal(coll('oak_door'), 'full');
  assert.equal(coll('oak_door', { open: true }), 'none');
  assert.equal(coll('iron_door'), 'full');
  assert.equal(coll('oak_fence_gate', { open: true }), 'none');
  assert.equal(coll('oak_trapdoor'), 'full');
  assert.ok(isCube(st('stone')) && !isCube(st('oak_slab')));
});

test('floors, passability and climbing', () => {
  for (const n of ['stone', 'oak_stairs', 'dirt_path', 'chest']) assert.ok(isFloor(st(n)), n);
  assert.ok(isFloor(st('oak_slab', { type: 'top' })));
  assert.ok(!isFloor(st('oak_slab')));
  assert.equal(topOf(st('oak_slab')), 0.5);
  for (const n of ['oak_fence', 'white_carpet', 'air', 'glass_pane']) assert.ok(!isFloor(st(n)), n);
  for (const n of ['air', 'white_carpet', 'oak_door', 'iron_door', 'ladder', 'torch', 'vine']) assert.ok(isPassable(st(n)), n);
  for (const n of ['stone', 'oak_fence', 'chest', 'oak_stairs']) assert.ok(!isPassable(st(n)), n);
  assert.ok(isClimbable(st('ladder')) && isClimbable(st('scaffolding')) && !isClimbable(st('oak_planks')));
});

test('light emission from the game, per state', () => {
  assert.equal(emissionOf(st('torch')), 14);
  assert.equal(emissionOf(st('wall_torch')), 14);
  assert.equal(emissionOf(st('lantern')), 15);
  assert.equal(emissionOf(st('soul_lantern')), 10);
  assert.equal(emissionOf(st('glowstone')), 15);
  assert.equal(emissionOf(st('sea_lantern')), 15);
  assert.equal(emissionOf(st('ochre_froglight')), 15);
  assert.equal(emissionOf(st('candle')), 0);
  assert.equal(emissionOf(st('candle', { lit: true, candles: 3 })), 9);
  assert.equal(emissionOf(st('redstone_lamp')), 0);
  assert.equal(emissionOf(st('redstone_lamp', { lit: true })), 15);
  assert.equal(emissionOf(st('campfire')), 15);
  assert.equal(emissionOf(st('light')), 0, 'the invisible light block never counts');
  assert.equal(emissionOf(st('stone')), 0);
});

test('light optics and redstone conductors', () => {
  assert.equal(opticsOf(st('stone')), 'opaque');
  assert.equal(opticsOf(st('glass')), 'clear');
  assert.equal(opticsOf(st('oak_leaves')), 'clear');
  assert.equal(opticsOf(st('oak_stairs')), 'shape');
  assert.equal(opticsOf(st('oak_slab', { type: 'double' })), 'opaque');
  for (const n of ['stone', 'oak_planks', 'stone_bricks', 'cobblestone', 'stripped_oak_log']) assert.ok(isConductor(st(n)), n);
  for (const n of ['glass', 'glowstone', 'sea_lantern', 'oak_slab', 'oak_leaves', 'air']) assert.ok(!isConductor(st(n)), n);
});

test('attachables name their support', () => {
  assert.deepEqual(supportOf(st('torch')), [[0, -1, 0]]);
  assert.deepEqual(supportOf(st('wall_torch', { facing: 'south' })), [[0, 0, -1]]);
  assert.deepEqual(supportOf(st('ladder', { facing: 'east' })), [[-1, 0, 0]]);
  assert.deepEqual(supportOf(st('stone_button', { face: 'wall', facing: 'north' })), [[0, 0, 1]]);
  assert.deepEqual(supportOf(st('stone_button', { face: 'floor' })), [[0, -1, 0]]);
  assert.deepEqual(supportOf(st('lantern', { hanging: true })), [[0, 1, 0]]);
  assert.deepEqual(supportOf(st('lantern')), [[0, -1, 0]]);
  assert.deepEqual(supportOf(st('white_carpet')), [[0, -1, 0]]);
  assert.deepEqual(supportOf(st('oak_door', { half: 'upper' })), [[0, -1, 0]]);
  assert.equal(supportOf(st('stone')), null);
  assert.equal(supportOf(st('oak_fence')), null);
  assert.equal(supportOf(st('oak_stairs')), null);
  assert.equal(familyOf('oak_wall_sign'), 'wall_sign');
  assert.equal(itemOf('wall_torch'), 'minecraft:torch');
  assert.equal(itemOf('water'), '');
});

test('classifier helpers (kit/tools/classify.mjs)', async () => {
  const { collisionFromBoxes, emissionRule, familyOf: fam, encodeProps } = await import('../tools/classify.mjs');
  assert.equal(collisionFromBoxes([]), 'none');
  assert.equal(collisionFromBoxes([[0, 0, 0, 1, 1, 1]]), 'full');
  assert.equal(collisionFromBoxes([[0, 0, 0, 1, 0.0625, 1]]), 'low');
  assert.equal(collisionFromBoxes([[0, 0, 0, 1, 0.5, 1]]), 'partial');
  assert.equal(fam(['WeatheringCopperStairBlock', 'StairBlock', 'Block']), 'stairs');
  assert.equal(fam(['WallTorchBlock', 'TorchBlock', 'BaseTorchBlock']), 'wall_torch');
  assert.equal(fam(['Block']), 'block');
  const report = { properties: { lit: ['true', 'false'], w: ['true', 'false'] }, states: [
    { properties: { lit: 'true', w: 'true' } }, { properties: { lit: 'true', w: 'false' } },
    { properties: { lit: 'false', w: 'true' } }, { properties: { lit: 'false', w: 'false' }, default: true }] };
  assert.deepEqual(emissionRule(report, [[{ lit: 'true', w: 'true' }, 15], [{ lit: 'true', w: 'false' }, 15]]), { by: ['lit'], v: { true: 15 } });
  assert.equal(emissionRule(report, report.states.map((s) => [s.properties, 7])), 7);
  assert.equal(encodeProps({ a: ['x', 'y'] }, { a: 'y' }), 'a=x|*y');
});

test('colours exist for common building blocks', () => {
  for (const n of ['oak_planks', 'spruce_log', 'cobblestone', 'stone_bricks', 'glass', 'oak_leaves', 'bricks', 'deepslate_tiles', 'white_wool']) assert.ok(COLORS[n], n);
  assert.ok(Array.isArray(COLORS.glass) && COLORS.glass[2] < 0.5, 'glass is see-through');
});
