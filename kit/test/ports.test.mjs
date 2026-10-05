// Ports and ext (docs/CONTRACT.md phase 4a, R5): bp.port() writes `ports`, the checker validates them, a rebuild keeps ext.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blueprint, palette } from '../lib/kit.mjs';
import { checkBlueprint, checkPorts } from '../lib/check.mjs';
import { writeBlueprint } from '../lib/write.mjs';

const P = palette({ wood: 'oak', stone: 'cobblestone' });

function hut() {
  const bp = new Blueprint({ id: 'hut', type: 'custom', size: [5, 5, 7], palette: P, interior: [1, 1, 1, 3, 3, 3], front: 'south' });
  bp.floor(0, 0, 4, 6, 0, P.stone);
  bp.carve([1, 1, 1, 3, 3, 3]);
  bp.walls(0, 0, 4, 4, 1, 3);
  bp.floor(0, 0, 4, 4, 4, P.planks);
  bp.door(2, 1, 4, 'south');
  bp.lantern(2, 3, 2, true);
  bp.spot('entrance', 2, 5, 180);
  bp.spot('spawn', 2, 6, 180);
  return bp;
}

test('bp.port writes ports into the blueprint JSON and a valid set passes', () => {
  const bp = hut().port('chest', 'item_out', 1, 1, 1, 'north').port('mill', 'steward_mc:grain_in', 3, 1, 3, 'east');
  const s = bp.sidecar();
  assert.deepEqual(s.ports, [
    { name: 'chest', kind: 'item_out', x: 1, y: 1, z: 1, facing: 'north' },
    { name: 'mill', kind: 'steward_mc:grain_in', x: 3, y: 1, z: 3, facing: 'east' },
  ]);
  const r = checkBlueprint(bp);
  assert.deepEqual(r.errors, []);
  // the same name again replaces the port
  assert.equal(hut().port('a', 'bed', 1, 1, 1, 'south').port('a', 'door', 2, 1, 2, 'west').sidecar().ports.length, 1);
});

test('the checker refuses ports outside the template, vertical facings and unknown kinds', () => {
  const size = [5, 5, 7];
  const one = (p) => checkPorts([{ name: 'p', kind: 'item_in', x: 1, y: 1, z: 1, facing: 'north', ...p }], size);
  assert.deepEqual(one({}), []);
  assert.match(one({ x: 5 })[0], /outside the template/);
  assert.match(one({ y: -1 })[0], /outside the template/);
  assert.match(one({ facing: 'up' })[0], /horizontal/);
  assert.match(one({ kind: 'conveyor' })[0], /<modid>:<kind>/);
  assert.deepEqual(one({ kind: 'create:belt_in' }), []);
  assert.match(one({ x: 1.5 })[0], /integers/);
  assert.match(checkPorts([{ name: 'a', kind: 'bed', x: 0, y: 0, z: 0, facing: 'north' }, { name: 'a', kind: 'bed', x: 1, y: 0, z: 0, facing: 'north' }], size)[0], /twice/);
  assert.match(checkPorts({}, size)[0], /must be a list/);
  assert.deepEqual(checkPorts(undefined, size), []);
  // through the full checker: an error
  const bad = hut().port('x', 'item_out', 9, 1, 1, 'north');
  const r = checkBlueprint(bad);
  assert.ok(r.errors.some((m) => /port 'x'/.test(m)), r.errors.join('\n'));
});

test('ext: the design may set it, a rebuild keeps what the mod wrote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ext-'));
  const bp = hut();
  bp.ext['kit:from_design'] = 1;
  writeBlueprint(bp, dir);
  const file = path.join(dir, 'hut.blueprint.json');
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(first.ext, { 'kit:from_design': 1 });
  // the mod (Library.setExt) edits the file in place
  first.ext['steward_mc:lot'] = 'L3';
  fs.writeFileSync(file, JSON.stringify(first));
  writeBlueprint(hut(), dir); // a rebuild of a design without ext
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(again.ext, { 'kit:from_design': 1, 'steward_mc:lot': 'L3' });
  fs.rmSync(dir, { recursive: true, force: true });
});
