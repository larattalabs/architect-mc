// Importing structure-block saves (docs/CONTRACT.md "Import / export"): kit/import.mjs + the checker's import mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decode, encode, encodeGzip, nbt, parse, plain } from '../lib/nbt.mjs';
import { nameFromFile } from '../lib/importer.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-import-'));
const run = (args) => spawnSync(process.execPath, [path.join(KIT, 'import.mjs'), ...args], { encoding: 'utf8' });

/**
 * A structure-block save of a 5x4x5 stone hut (every cell written, air included, as the game saves them): an oak
 * door on the south face, no light inside. Options: an old-style palette (Name/Properties, a property left out), a
 * modded block, an armor stand, several palettes.
 */
export function hutSave({ oldKeys = false, modded = false, entity = false, palettes = false } = {}) {
  const pal = [];
  const idx = new Map();
  const state = (name, props = {}) => {
    const k = name + JSON.stringify(props);
    if (!idx.has(k)) {
      idx.set(k, pal.length);
      const e = oldKeys ? { Name: nbt.str(name) } : { id: nbt.str(name) };
      if (Object.keys(props).length) e[oldKeys ? 'Properties' : 'properties'] = nbt.compound(Object.fromEntries(Object.entries(props).map(([a, b]) => [a, nbt.str(b)])));
      pal.push(nbt.compound(e));
    }
    return idx.get(k);
  };
  const door = (half) => ({ facing: 'south', half, hinge: 'left', open: 'false', powered: 'false' });
  const blocks = [];
  for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
    let s;
    const wall = x === 0 || x === 4 || z === 0 || z === 4;
    if (y === 0 || y === 3) s = state('minecraft:cobblestone');
    else if (x === 2 && z === 4) s = state('minecraft:oak_door', door(y === 1 ? 'lower' : 'upper'));
    else if (wall) s = state(modded && x === 0 && z === 2 ? 'create:andesite_casing' : 'minecraft:oak_planks');
    else s = state('minecraft:air');
    blocks.push(nbt.compound({ pos: nbt.list('int', [nbt.int(x), nbt.int(y), nbt.int(z)]), state: nbt.int(s) }));
  }
  if (oldKeys) delete pal[idx.get('minecraft:oak_door' + JSON.stringify(door('lower')))].v.Properties.v.powered;
  const entities = entity
    ? [nbt.compound({ pos: nbt.list('double', [nbt.double(2.5), nbt.double(1), nbt.double(2.5)]), blockPos: nbt.list('int', [nbt.int(2), nbt.int(1), nbt.int(2)]), nbt: nbt.compound({ id: nbt.str('minecraft:armor_stand'), UUID: nbt.intArray([1, 2, 3, 4]) }) })]
    : [];
  const root = {
    DataVersion: nbt.int(oldKeys ? 3953 : 5023),
    size: nbt.list('int', [nbt.int(5), nbt.int(4), nbt.int(5)]),
    blocks: nbt.list('compound', blocks),
    entities: nbt.list('compound', entities),
  };
  if (palettes) root.palettes = nbt.list('list', [nbt.list('compound', pal), nbt.list('compound', pal)]);
  else root.palette = nbt.list('compound', pal);
  return encodeGzip(nbt.compound(root));
}

test('nbt: byte and long arrays round-trip', () => {
  const root = nbt.compound({ b: nbt.byteArray([1, -2, 127, -128]), l: nbt.longArray([1n, -2n, 2n ** 62n]), i: nbt.intArray([7]) });
  const back = decode(encode(root));
  assert.deepEqual(plain(back), { b: [1, -2, 127, -128], l: [1n, -2n, 2n ** 62n], i: [7] });
  assert.ok(encode(back).equals(encode(root)));
});

test('a structure-block save imports: custom, groundY 1, front south, entrance + spawn in front, imported', () => {
  const file = path.join(tmp, 'my_old-hut.nbt');
  fs.writeFileSync(file, hutSave({ entity: true }));
  const out = path.join(tmp, 'a');
  const r = run([file, '--id', 'imp_my_old_hut', '--out', out, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.deepEqual(j.errors, []);
  // the player's own build: no light and the like are warnings, never errors; the entity is dropped
  assert.ok(j.warnings.some((w) => /1 entity dropped \(armor_stand x1\)/.test(w)), j.warnings.join(' | '));
  const sc = JSON.parse(fs.readFileSync(j.sidecar, 'utf8'));
  assert.equal(sc.id, 'imp_my_old_hut');
  assert.equal(sc.name, 'My Old Hut');
  assert.equal(sc.type, 'custom');
  assert.equal(sc.groundY, 1);
  assert.equal(sc.front, 'south');
  assert.equal(sc.imported, true);
  assert.deepEqual(sc.size, { x: 5, y: 4, z: 5 });
  assert.deepEqual(sc.anchors.entrance, { x: 2.5, y: 1, z: 5.5, yaw: 180, pitch: 0 });
  assert.deepEqual(sc.anchors.spawn, { x: 2.5, y: 1, z: 7.5, yaw: 180, pitch: 0 });
  assert.equal(sc.foundationBlock, 'minecraft:cobblestone');
  for (const k of ['source', 'palette', 'params', 'values', 'request', 'favorite', 'userTags', 'displayName']) assert.ok(!(k in sc), k);
  const st = plain(parse(fs.readFileSync(j.nbt)));
  assert.deepEqual(st.entities, []);
  assert.equal(st.blocks.length, 100);
});

test('import: an older save (Name/Properties, a missing property, several palettes) still imports', () => {
  const file = path.join(tmp, 'legacy.nbt');
  fs.writeFileSync(file, hutSave({ oldKeys: true, palettes: true }));
  const r = run([file, '--id', 'imp_legacy', '--out', path.join(tmp, 'b'), '--name', 'Grandpa\'s Hut', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.warnings.some((w) => /2 palettes/.test(w)), j.warnings.join(' | '));
  assert.ok(j.warnings.some((w) => /properties not written/.test(w)), j.warnings.join(' | '));
  assert.equal(JSON.parse(fs.readFileSync(j.sidecar, 'utf8')).name, 'Grandpa\'s Hut');
  const st = plain(parse(fs.readFileSync(j.nbt)));
  assert.equal(st.DataVersion, 3953); // kept: the game's data fixer upgrades it on load
  assert.ok(Array.isArray(st.palette) && !('palettes' in st));
});

test('import: non-vanilla blocks fail with the list of them', () => {
  const file = path.join(tmp, 'modded.nbt');
  fs.writeFileSync(file, hutSave({ modded: true }));
  const r = run([file, '--id', 'imp_modded', '--out', path.join(tmp, 'c'), '--json']);
  assert.equal(r.status, 1, r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.errors.length, 1, j.errors.join(' | '));
  assert.match(j.errors[0], /unknown or non-vanilla blocks \(1\): create:andesite_casing x2/);
  // human output too
  const h = run([file, '--id', 'imp_modded', '--out', path.join(tmp, 'c')]);
  assert.match(h.stdout, /^error: unknown or non-vanilla blocks/m);
  assert.match(h.stdout, /^check: FAILED$/m);
});

test('import: size cap, not a structure file, bad usage', () => {
  const file = path.join(tmp, 'hut.nbt');
  fs.writeFileSync(file, hutSave());
  const big = run([file, '--id', 'imp_hut', '--out', path.join(tmp, 'd'), '--max', '4,4,4', '--json']);
  assert.equal(big.status, 1);
  assert.match(JSON.parse(big.stdout).errors.join(' '), /exceeds the limit/);
  const junk = path.join(tmp, 'junk.nbt');
  fs.writeFileSync(junk, 'not nbt at all');
  const r = run([junk, '--id', 'imp_junk', '--out', path.join(tmp, 'e'), '--json']);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).errors[0], /cannot read it as a structure file/);
  const notStructure = path.join(tmp, 'level.nbt');
  fs.writeFileSync(notStructure, encodeGzip(nbt.compound({ Data: nbt.compound({}) })));
  assert.match(JSON.parse(run([notStructure, '--id', 'imp_x', '--out', path.join(tmp, 'f'), '--json']).stdout).errors[0], /no valid size/);
  assert.equal(run([file, '--out', path.join(tmp, 'g')]).status, 2); // no --id
  assert.equal(run([file, '--id', 'Bad Id', '--out', path.join(tmp, 'g')]).status, 2);
});

test('names from file names', () => {
  assert.equal(nameFromFile('/x/y/my_old-hut v2.nbt'), 'My Old Hut V2');
  assert.equal(nameFromFile('___.nbt'), 'Imported Structure');
});
