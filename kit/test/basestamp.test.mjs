// Gate base worlds are stamped with a hash of their creation recipe (tools/lib/basestamp.mjs); a reused run dir's older world
// ("G6B Seed Base" made by an earlier creation path) is detected, moved aside (never deleted) and left for the driver to rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseRecipe, recipeHash, baseStatus, baseCurrent, writeStamp, readStamp, quarantineBase, STAMP_FILE } from '../../tools/lib/basestamp.mjs';

const MC = { minecraft: '26.3' };
function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basestamp-'));
  const saves = path.join(root, 'mod', 'run', 'saves');
  fs.mkdirSync(saves, { recursive: true });
  const world = (name) => { fs.mkdirSync(path.join(saves, name), { recursive: true }); fs.writeFileSync(path.join(saves, name, 'level.dat'), 'x'); };
  return { root, saves, world };
}
const spec = { preset: 'normal', seed: '2026100906' };

test('recipe hash: depends on preset, seed, Minecraft version and the recipe version, not on object order', () => {
  const h = (s, o = MC) => recipeHash(baseRecipe(s, o));
  assert.equal(h(spec), h({ seed: '2026100906', preset: 'normal' }), 'same recipe, same hash');
  assert.equal(h(spec), h({ preset: 'normal', seed: 2026100906 }), 'a numeric seed is the same recipe');
  assert.notEqual(h(spec), h({ preset: 'flat', seed: '2026100906' }));
  assert.notEqual(h(spec), h({ preset: 'normal', seed: '1' }));
  assert.notEqual(h(spec), h(spec, { minecraft: '26.4' }));
});

test('status: missing, unstamped (a world from before stamps), current and stale', () => {
  const { saves, world } = run();
  const recipe = baseRecipe(spec, MC);
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'missing');
  world('G6B Seed Base');
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'unstamped');
  writeStamp(saves, 'G6B Seed Base', recipe);
  assert.equal(readStamp(saves, 'G6B Seed Base').hash, recipeHash(recipe));
  assert.equal(baseStatus(saves, 'G6B Seed Base', recipe), 'current');
  assert.equal(baseStatus(saves, 'G6B Seed Base', baseRecipe(spec, { minecraft: '26.4' })), 'stale');
});

test('baseCurrent: a current world is kept; an unstamped or stale one is moved aside, not deleted, and reported missing after', () => {
  const { saves, world } = run();
  const logs = [];
  const o = { ...MC, log: (m) => logs.push(m) };
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), false, 'nothing there: rebuild');
  world('G6B Seed Base');
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), false, 'unstamped = the stale reused world');
  assert.ok(!fs.existsSync(path.join(saves, 'G6B Seed Base')), 'moved out of saves');
  const stale = path.join(path.dirname(saves), 'saves-stale');
  const kept = fs.readdirSync(stale);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith('G6B Seed Base-'));
  assert.ok(fs.existsSync(path.join(stale, kept[0], 'level.dat')), 'its files are all still there');
  assert.match(logs[0], /unstamped/);
  // rebuilt by the driver, then stamped: current
  world('G6B Seed Base');
  writeStamp(saves, 'G6B Seed Base', baseRecipe(spec, MC));
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, o), true);
  assert.ok(fs.existsSync(path.join(saves, 'G6B Seed Base', STAMP_FILE)));
  // a recipe change makes the same world stale
  assert.equal(baseCurrent(saves, 'G6B Seed Base', spec, { ...o, minecraft: '26.4' }), false);
  assert.match(logs.at(-1), /stale/);
  assert.equal(fs.readdirSync(stale).length, 2, 'a second quarantine does not overwrite the first');
});

test('quarantine refuses anything that is not a G6B world inside saves', () => {
  const { saves, world } = run();
  world('Precious');
  assert.throws(() => quarantineBase(saves, 'Precious'), /refusing/);
  assert.throws(() => quarantineBase(saves, '../outside'), /refusing/);
  assert.ok(fs.existsSync(path.join(saves, 'Precious', 'level.dat')));
});
