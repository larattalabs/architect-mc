#!/usr/bin/env node
// The phase 5b gate's size-cap delta fixture (docs/CONTRACT.md "Phase 5b gate" 5): a 96x64x96 block, version 1 of stone bricks,
// version 2 of polished andesite (every cell changed), as installable version folders of entry g5b_cap.
//   node tools/gate5b-sizecap.mjs <outDir>     writes <outDir>/v1 and <outDir>/v2
import path from 'node:path';
import { Blueprint, PALETTES } from '../kit/lib/kit.mjs';
import { writeBlueprint } from '../kit/lib/write.mjs';

const out = process.argv[2] ?? '.';
for (const [v, block] of [['v1', 'minecraft:stone_bricks'], ['v2', 'minecraft:polished_andesite']]) {
  const bp = new Blueprint({
    id: 'g5b_cap', name: 'Gate cap block', description: 'The phase 5b gate size-cap delta fixture.', type: 'custom', tags: ['gate', 'fixture'],
    size: [96, 64, 96], groundY: 1, front: 'south', palette: PALETTES.rustic, approach: false,
  });
  bp.part('main', () => bp.fill([0, 0, 0, 95, 63, 95], block));
  bp.part('mark', () => bp.set(47, 63, 47, 'minecraft:glowstone'));
  bp.spot('entrance', 47, 96, 180);
  bp.spot('spawn', 47, 97, 180);
  const dir = path.join(out, v);
  writeBlueprint(bp, dir);
  console.log(JSON.stringify({ dir, cells: bp.cells.size }));
}
