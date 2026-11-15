import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stewardCap, terrainShape } from '../../tools/lib/quote-terrain.mjs';

test('QL terrainShape: counts within bom and the tile pieces, 0 keys allowed, sorted', () => {
  const q = { bom: { 'minecraft:dirt': 9, 'minecraft:oak_planks': 20 }, bomParts: { 'tiles:g': { 'minecraft:dirt': 4 }, 'lot:a': { 'minecraft:dirt': 5, 'minecraft:oak_planks': 20 } }, terrain: { 'minecraft:dirt': 4, 'minecraft:gravel': 0 } };
  assert.deepEqual(terrainShape(q), []);
  assert.match(terrainShape({ ...q, terrain: { 'minecraft:dirt': 5 } })[0], /> its tile pieces 4/);
  assert.match(terrainShape({ ...q, terrain: { 'minecraft:dirt': 10 } })[0], /> bom 9/);
  assert.match(terrainShape({ ...q, terrain: { 'minecraft:gravel': 0, 'minecraft:dirt': 1 } })[0], /not sorted/);
  assert.deepEqual(terrainShape({ bom: {} }), ['no terrain object']);
});

test('QL stewardCap: terrain items get max(2, ceil(2%)), a 0 key included; other items exact', () => {
  assert.deepEqual(stewardCap({ bom: { 'minecraft:oak_planks': 156 }, terrain: { 'minecraft:dirt': 0 } }), { 'minecraft:dirt': 2, 'minecraft:oak_planks': 156 });
  assert.deepEqual(stewardCap({ bom: { 'minecraft:dirt': 450 }, terrain: { 'minecraft:dirt': 300 } }), { 'minecraft:dirt': 456 });
  assert.deepEqual(stewardCap({ bom: { 'minecraft:dirt': 3 } }), { 'minecraft:dirt': 3 });
});
