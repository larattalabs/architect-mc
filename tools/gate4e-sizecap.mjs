#!/usr/bin/env node
// The phase 4e gate's size-cap fixture (docs/CONTRACT.md "Phase 4e gate" 8): a 96x64x96 keep built with the kit, written as
// a user library entry (<gameDir>/architect/library/g4e_keep/). Walls, eight floors, a room grid, windows, fences and
// lanterns, so its capture is near the cap and its cells are shape-sensitive.
//   node tools/gate4e-sizecap.mjs <gameDir>
import path from 'node:path';
import { Blueprint, PALETTES } from '../kit/lib/kit.mjs';
import { writeBlueprint } from '../kit/lib/write.mjs';
import { checkFiles } from '../kit/lib/check.mjs';

const p = PALETTES.rustic;
const X = 95;
const Z = 93; // the path row at z = 95
const bp = new Blueprint({
  id: 'g4e_keep', name: 'Gate keep (size cap)', description: 'The phase 4e gate size-cap fixture: a 96x64x96 keep.', type: 'castle',
  tags: ['gate', 'fixture'], size: [96, 64, 96], groundY: 1, front: 'south', palette: p, interior: [1, 1, 1, X - 1, 56, Z - 1],
  approach: { length: 2, width: 3 },
});
bp.part('main', () => {
  bp.floor(0, 0, X, Z, 0, p.stone);
  for (let f = 0; f < 7; f++) {
    const y0 = 1 + f * 8;
    bp.walls(0, 0, X, Z, y0, y0 + 7, { block: p.wall ?? p.stone, corners: p.frame });
    bp.floor(1, 1, X - 1, Z - 1, y0 + 7, p.planks);
    // a room grid every 16 blocks, with doorway gaps
    for (let x = 16; x < X; x += 16) bp.fill([x, y0, 1, x, y0 + 6, Z - 1], p.planks);
    for (let z = 16; z < Z; z += 16) bp.fill([1, y0, z, X - 1, y0 + 6, z], p.planks);
    for (let x = 16; x < X; x += 16) for (let z = 8; z < Z; z += 16) bp.carve([x, y0, z, x, y0 + 2, z]);
    for (let z = 16; z < Z; z += 16) for (let x = 8; x < X; x += 16) bp.carve([x, y0, z, x, y0 + 2, z]);
    bp.windows(0, 0, X, Z, y0 + 2, y0 + 4, { every: 4, width: 2 });
    for (let x = 3; x < X; x += 5) for (let z = 3; z < Z; z += 5) bp.lantern(x, y0 + 6, z, true);
  }
  bp.part('parapet', () => {
  for (let x = 0; x <= X; x++) for (const z of [0, Z]) bp.set(x, 57, z, p.fence ?? 'minecraft:spruce_fence');
  for (let z = 0; z <= Z; z++) for (const x of [0, X]) bp.set(x, 57, z, p.fence ?? 'minecraft:spruce_fence');
  });
  bp.carve([47, 1, Z, 48, 3, Z]);
  bp.door(47, 1, Z, 'south');
  bp.fill([46, 0, Z + 1, 49, 0, Z + 2], p.path ?? 'minecraft:dirt_path');
  bp.fill([47, 57, 47, 47, 63, 47], p.frame); // a mast: the template is 64 high
  bp.spot('entrance', 47, Z + 1, 180);
  bp.spot('spawn', 47, Z + 2, 180);
});
const dir = path.join(process.argv[2] ?? '.', 'architect', 'library', 'g4e_keep');
writeBlueprint(bp, dir);
const r = checkFiles(path.join(dir, 'g4e_keep.nbt'), path.join(dir, 'g4e_keep.blueprint.json'));
console.log(JSON.stringify({ dir, ok: r.ok, errors: r.errors, warnings: r.warnings.slice(0, 8), cells: bp.cells.size }));
