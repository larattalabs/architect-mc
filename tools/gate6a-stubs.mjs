#!/usr/bin/env node
// mega_bench's 4 stub blueprints (docs/CONTRACT.md §8: "children from 4 stub blueprints (boxes 9-24 wide, 6-14 tall) and the
// 4 kit examples"): plain walled boxes with a door, an entrance and a short approach, built with the kit and written into a
// library folder (the gate client's <gameDir>/architect/library).
//
//   node tools/gate6a-stubs.mjs <libraryDir>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Blueprint, PALETTES } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'kit.mjs')).href);
const { writeBlueprint } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'write.mjs')).href);

// footprints w x d include the 3 path rows in front (what fitToLot measures), so the 9x9 stub fits every mega_bench lot
export const STUBS = [
  { id: 'g6a_stub_9', w: 9, h: 6, d: 9 },
  { id: 'g6a_stub_14', w: 14, h: 8, d: 12 },
  { id: 'g6a_stub_19', w: 19, h: 11, d: 15 },
  { id: 'g6a_stub_24', w: 24, h: 14, d: 20 },
];

function stub({ id, w, h, d }) {
  const p = PALETTES.rustic;
  const X = w - 1;
  const Z = d - 4; // the room; 3 path rows in front of it
  const bp = new Blueprint({ id, type: 'custom', size: [w, h, d], origin: [0, 0, 0], palette: p, interior: [1, 1, 1, X - 1, h - 2, Z - 1] });
  bp.room([0, 0, 0, X, h - 1, Z]);
  const D = Math.floor(X / 2);
  bp.door(D, 1, Z, 'south');
  bp.ceilingLights(1, 1, X - 1, Z - 1, h - 2);
  for (let x = 2; x < X - 1; x += 5) for (let z = 2; z < Z - 1; z += 5) bp.lantern(x, 1, z); // floor light under a tall ceiling
  bp.floor(D - 1, Z + 1, D + 1, Z + 3, 0, p.path);
  bp.spot('entrance', D, Z + 1, 180);
  bp.spot('spawn', D, Z + 3, 180);
  bp.name = `Stub ${w}x${h}x${d}`;
  return bp;
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/gate6a-stubs.mjs <libraryDir>');
  process.exit(2);
}
for (const s of STUBS) {
  const bp = stub(s);
  const dir = path.join(out, s.id);
  writeBlueprint(bp, dir);
  console.log(`wrote ${dir}`);
}
