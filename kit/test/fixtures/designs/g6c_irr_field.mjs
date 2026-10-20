// (6c IRR gate fixture, not a catalogue design) A working field for a farm lot of `width` x `depth`: a dirt layer under it (row 0, the
// pad's level, so the lot's design writes the irrigation sources' beds too and the mask must drop them), farmland over the field with
// wheat on it, an oak fence on coarse dirt round its border with a gate in the front row's middle, a dirt path along the front row, and a composter
// beside the gate (in the fence line) (a farmer villager's job site). It knows nothing of irrigation: the mask drops what it writes on the sources' cells
// (the realise reports irrigationDropped). `crop` picks the crop; the gate's v2 ("add a floor" stand-in, a versionOf) swaps it.
// Front south, groundY 1: row 1 is the lot's floor (the field's farmland level), row 2 the crops.
import { Blueprint, PALETTES } from '../../../lib/kit.mjs';

export const id = 'g6c_irr_field';

export const params = {
  width: { type: 'int', min: 5, max: 64, default: 13, label: 'Width' },
  depth: { type: 'int', min: 5, max: 64, default: 11, label: 'Depth' },
  crop: { type: 'enum', options: ['wheat', 'carrots'], default: 'wheat', label: 'Crop' },
};

export default function build({ palette: p = PALETTES.rustic, width = 13, depth = 11, crop = 'wheat' } = {}) {
  const X = width - 1, Z = depth - 1;
  const gx = Math.floor(X / 2);
  const bp = new Blueprint({
    id, name: 'Irrigation test field', description: `A ${width} x ${depth} field of ${crop} behind an oak fence (the IRR gate's lot entry).`,
    type: 'farm', profile: ['no_floating'], tags: ['gate', 'field'], size: [width, 3, depth], origin: [0, 0, 0], groundY: 1, front: 'south',
    palette: p, approach: false,
  });
  bp.part('ground', () => {
    bp.floor(0, 0, X, Z, 0, 'minecraft:dirt');
    for (let x = 0; x <= X; x++) bp.set(x, 1, Z, 'minecraft:dirt_path');
  });
  bp.part('field', () => {
    for (let x = 1; x < X; x++) for (let z = 1; z < Z - 1; z++) {
      bp.set(x, 1, z, 'minecraft:farmland', { moisture: 0 });
      bp.set(x, 2, z, crop === 'carrots' ? 'minecraft:carrots' : 'minecraft:wheat', { age: (x + z) % 8 });
    }
  });
  bp.part('fence', () => {
    for (let x = 0; x <= X; x++) for (const z of [0, Z - 1]) if (!(z === Z - 1 && x === gx)) bp.set(x, 1, z, 'minecraft:coarse_dirt');
    for (let x = 0; x <= X; x++) { bp.set(x, 2, 0, 'minecraft:oak_fence'); if (x !== gx) bp.set(x, 2, Z - 1, 'minecraft:oak_fence'); }
    for (let z = 1; z < Z - 1; z++) for (const x of [0, X]) { bp.set(x, 1, z, 'minecraft:coarse_dirt'); bp.set(x, 2, z, 'minecraft:oak_fence'); }
    bp.set(gx, 1, Z - 1, 'minecraft:dirt_path');
    bp.set(gx, 2, Z - 1, 'minecraft:oak_fence_gate', { facing: 'south' });
    bp.set(gx + 1, 2, Z - 1, 'minecraft:composter'); // (in the fence line beside the gate, on its coarse dirt: never on the path)
  });
  bp.spot('entrance', gx, Z, 180, { y: 2 });
  bp.spot('spawn', gx, Z, 180, { y: 2 });
  return bp;
}
