// PA treehouse lodge (fit wrap_trunk): a woodcutter's lodge wrapped round the trunk of a great tree, under its crown.
//
// Plan (design frame, read from the site: trunk axis (cx, cz), the walk port on the west, the lot's height):
// - Levels: the floor deck on the port's floor row (feet = the port's feet row), walls 3 rows, a sleeping loft over the north
//   band one storey up (its floor on the wall-plate row), reached by a straight stair in the east band.
// - Massing: one square timber room (walls 2 cells in from the lot edge) round the trunk; the trunk passes through the room and
//   the roof. Under the deck, a log sill ring and log joists run out from the trunk (they bear on it).
// - Roof: the lot is only 8 tall, so a short hip roof (pitch 1, overhang 1, three courses) that levels out into a flat collar
//   round the trunk, which carries on up into the crown.
// - Openings: the door on the west face where the branch walk arrives (front = west), windows every 4 cells on every face.
// - Rooms: the workroom (woodpile, chopping stump, grindstone, crafting table), a kitchen corner on the south wall (smoker,
//   furnace, barrel, cauldron, a table), the loft with the bed (or the bed downstairs without the loft).
// - Roles: frame spruce logs, wall planks (or plaster / logs), dark oak roof, mossy trim, lanterns.
import { Blueprint, palette } from '../lib/kit.mjs';
import { loadBible } from '../lib/bible.mjs';
import * as C from '../../bible/components.mjs';

const BIBLE = loadBible(new URL('../../bible/bible.json', import.meta.url));

export const id = 'gen_pa_treehouse_lodge';
export const fit = 'wrap_trunk';

export const params = {
  loft: { type: 'bool', default: true, label: 'Sleeping loft' },
  walls: { type: 'enum', options: ['planks', 'plaster', 'logs'], default: 'planks', label: 'Wall infill' },
  underframe: { type: 'bool', default: true, label: 'Log underframe' },
};

export default function build({ palette: p = palette({ bible: BIBLE }), site, loft = true, walls = 'planks', underframe = true } = {}) {
  const t = site.trunk();
  const { cx, cz } = t;
  const walk = site.port('walk_w');
  const [px, py, pz] = walk.at;
  const SX = site.size.x, SY = site.size.y, SZ = site.size.z;
  const F = py; // feet row of the main floor (the port's feet)
  const FL = F - 1; // floor row
  const TOP = SY - 1; // the collar row (the lot's top row)
  const EAVE = TOP - 3; // eave row: three courses up to the collar
  const PLATE = EAVE; // the walls' top row (wall plate), under the second course
  const LOFT = PLATE; // the loft's floor row
  const E0 = 1, E1 = SX - 2, N0 = 1, N1 = SZ - 2; // eave rectangle
  const W0 = E0 + 1, W1 = E1 - 1, Z0 = N0 + 1, Z1 = N1 - 1; // wall ring
  const AIR = 'minecraft:air';

  const bp = new Blueprint({
    id, name: 'PA treehouse lodge',
    description: "A woodcutter's timber lodge wrapped round a great tree's trunk under its crown, with a workroom, a kitchen corner and a sleeping loft, opening west onto the branch walks.",
    type: 'house', tags: ['rustic', 'treehouse', 'small'], site, fit, size: site.size, palette: p, groundY: F, front: 'west',
    interior: [W0 + 1, F, Z0 + 1, W1 - 1, TOP - 1, Z1 - 1],
  });
  bp.keep(site.cellsOf('LOG'));
  const trunkAt = (x, y, z) => bp.isKeep(x, y, z) || site.solid(x, y, z);
  const ring = (x, z) => Math.min(x - E0, E1 - x, z - N0, N1 - z); // roof course index (0 = eave)
  const onWall = (x, z) => x >= W0 && x <= W1 && z >= Z0 && z <= Z1 && (x === W0 || x === W1 || z === Z0 || z === Z1);
  // windows every 4 cells, centred on the trunk's axis; the door takes the west face's middle one
  const winAt = [-4, 0, 4];
  const doorZ = pz;
  const posts = [W0, cx - 2, cx + 2, W1]; // timber posts between the windows
  const stairX = cx + 4, stairZ = cz + 1; // the loft stair: three steps rising north in the east band

  bp.part('underframe', () => {
    if (!underframe) return;
    // a log sill ring under the walls and log joists out from the trunk on the four axes (they bear on it)
    for (let x = W0; x <= W1; x++) for (const z of [Z0, Z1]) bp.put(x, FL - 1, z, p.frame, { axis: 'x' });
    for (let z = Z0 + 1; z < Z1; z++) for (const x of [W0, W1]) bp.put(x, FL - 1, z, p.frame, { axis: 'z' });
    for (let x = W0 + 1; x < W1; x++) if (!trunkAt(x, FL - 1, cz)) bp.put(x, FL - 1, cz, p.frame, { axis: 'x' });
    for (let z = Z0 + 1; z < Z1; z++) if (!trunkAt(cx, FL - 1, z)) bp.put(cx, FL - 1, z, p.frame, { axis: 'z' });
  });

  bp.part('deck', () => {
    for (let x = W0; x <= W1; x++) for (let z = Z0; z <= Z1; z++) if (!trunkAt(x, FL, z)) bp.put(x, FL, z, p.floor);
    // the landing where the branch walk arrives: the port's own column and the strip under the eave
    for (let z = doorZ - 1; z <= doorZ + 2; z++) bp.put(W0 - 1, FL, z, p.floor);
    for (let z = doorZ - 1; z <= doorZ + walk.width; z++) bp.put(px, FL, z, p.floor);
  });

  bp.part('main', () => {
    for (let x = W0; x <= W1; x++) for (let z = Z0; z <= Z1; z++) {
      if (!onWall(x, z)) continue;
      const u = x === W0 || x === W1 ? z : x; // position along the face
      const corner = (x === W0 || x === W1) && (z === Z0 || z === Z1);
      const axis = x === W0 || x === W1 ? 'z' : 'x';
      for (let y = F; y <= PLATE; y++) {
        if (corner || posts.includes(u)) bp.put(x, y, z, p.frame, { axis: 'y' });
        else if (walls === 'logs') bp.put(x, y, z, p.log, { axis });
        else if (y === PLATE) bp.put(x, y, z, p.frame, { axis });
        else bp.put(x, y, z, walls === 'plaster' ? p.plaster : p.wall);
      }
    }
  });

  bp.part('roof', () => {
    for (let x = E0; x <= E1; x++) for (let z = N0; z <= N1; z++) {
      const m = ring(x, z);
      if (m >= 3) { if (!trunkAt(x, TOP, z)) bp.put(x, TOP, z, p.roofBlock); continue; }
      const dN = z - N0, dS = N1 - z, dW = x - E0, dE = E1 - x;
      const sides = [dN === m && 'north', dS === m && 'south', dW === m && 'west', dE === m && 'east'].filter(Boolean);
      const OPP = { north: 'south', south: 'north', west: 'east', east: 'west' };
      let facing = OPP[sides[0]];
      let shape = 'straight';
      const ns = sides.find((q) => q === 'north' || q === 'south');
      const we = sides.find((q) => q === 'west' || q === 'east');
      if (ns && we) {
        facing = ns === 'north' ? 'south' : 'north';
        shape = { 'north,west': 'outer_left', 'north,east': 'outer_right', 'south,east': 'outer_left', 'south,west': 'outer_right' }[`${ns},${we}`];
      }
      bp.put(x, EAVE + m, z, p.roofStairs, { facing, half: 'bottom', shape });
      // the second course inside the walls rests on a lining that steps it down onto the first
      if (m === 2) bp.put(x, EAVE + m - 1, z, p.roofBlock);
    }
    // a shadow line of accent slabs under the eaves (not over the landing's headroom)
    for (const [x, z, facing, length] of [[E0 + 1, N0, 'north', E1 - E0 - 1], [E0 + 1, N1, 'south', E1 - E0 - 1], [E1, N0 + 1, 'east', N1 - N0 - 1]]) {
      C.roof_trim(bp, { x, y: EAVE, z, facing, length });
    }
    C.roof_trim(bp, { x: E0, y: EAVE, z: N0 + 1, facing: 'west', length: doorZ - 2 - N0 - 1 });
    C.roof_trim(bp, { x: E0, y: EAVE, z: doorZ + 3, facing: 'west', length: N1 - 1 - doorZ - 2 });
  }, { roof: 'hip' });

  bp.part('openings', () => {
    bp.door(W0, F, doorZ, 'west');
    C.door_surround(bp, { x: W0, y: F, z: doorZ, facing: 'west' });
    for (const d of winAt) {
      if (d !== 0) C.window(bp, { x: W0, y: F, z: cz + d, facing: 'west', width: 1, height: 2 });
      C.window(bp, { x: W1, y: F, z: cz + d, facing: 'east', width: 1, height: 2 });
      C.window(bp, { x: cx + d, y: F, z: Z0, facing: 'north', width: 1, height: 2 });
      C.window(bp, { x: cx + d, y: F, z: Z1, facing: 'south', width: 1, height: 2 });
    }
    // lantern posts either side of where the branch walk lands, past the eave
    for (const z of [doorZ - 1, doorZ + walk.width]) C.lantern_post(bp, { x: px, y: F, z, facing: 'west' });
  });

  bp.part('loft', () => {
    if (!loft) return;
    // the floor over the north band, out to the row beside the trunk; a rail on its open edge
    const zEdge = cz - 2;
    for (let x = W0 + 1; x < W1; x++) for (let z = Z0 + 1; z <= zEdge; z++) {
      if (trunkAt(x, LOFT, z)) continue;
      bp.put(x, LOFT, z, p.floor);
    }
    for (let x = W0 + 1; x < W1; x++) {
      if (x === stairX || trunkAt(x, LOFT + 1, zEdge)) continue;
      if (!bp.get(x, LOFT, zEdge)) continue;
      bp.put(x, LOFT + 1, zEdge, p.fence);
    }
    // the stair up, rising north, on plank risers
    for (let i = 0; i < 3; i++) {
      const z = stairZ - i;
      for (let y = F; y < F + i; y++) bp.put(stairX, y, z, p.planks);
      bp.stairs(stairX, F + i, z, 'north');
    }
  });

  bp.part('furnishings', () => {
    // kitchen corner on the south wall, between the windows
    const kz = Z1 - 1;
    bp.set(cx + 1, F, kz, 'minecraft:smoker', { facing: 'north', lit: 'false' });
    bp.set(cx + 2, F, kz, 'minecraft:furnace', { facing: 'north', lit: 'false' });
    bp.set(cx + 3, F, kz, 'minecraft:barrel', { facing: 'up', open: 'false' });
    bp.set(W1 - 1, F, kz, 'minecraft:water_cauldron', { level: '3' });
    bp.set(W1 - 1, F, kz - 1, 'minecraft:barrel', { facing: 'west', open: 'false' });
    bp.lantern(cx + 3, F + 1, kz);
    // the table by the kitchen, two chairs
    bp.set(cx - 2, F, kz - 1, p.fence);
    bp.set(cx - 2, F + 1, kz - 1, p.slab, { type: 'bottom' });
    bp.lantern(cx - 2, F + 2, kz - 1);
    bp.chair(cx - 3, F, kz - 1, 'east');
    bp.chair(cx - 1, F, kz - 1, 'west');
    // the woodcutter's corner: a woodpile, a chopping stump, the grindstone and the bench
    for (let z = cz + 2; z <= cz + 3; z++) for (let y = F; y <= F + 1; y++) bp.set(W0 + 1, y, z, p.log, { axis: 'z' });
    bp.set(W0 + 2, F, Z1 - 1, p.log, { axis: 'y' });
    bp.set(W0 + 1, F, Z0 + 1, 'minecraft:crafting_table');
    bp.set(W0 + 2, F, Z0 + 1, 'minecraft:grindstone', { face: 'floor', facing: 'south' });
    bp.set(W0 + 1, F, Z0 + 2, 'minecraft:chest', { facing: 'east', type: 'single', waterlogged: 'false' });
    bp.set(W1 - 1, F, Z0 + 1, 'minecraft:barrel', { facing: 'up', open: 'false' });
    bp.lantern(W1 - 1, F + 1, Z0 + 1);
    bp.lantern(W0 + 1, F + 1, Z0 + 1);
    // the bed: in the loft, or downstairs in the north band
    if (loft) {
      bp.bed(W0 + 2, LOFT + 1, Z0 + 2, 'west', 'brown');
      bp.set(W0 + 2, LOFT + 1, Z0 + 3, 'minecraft:chest', { facing: 'south', type: 'single', waterlogged: 'false' });
      bp.lantern(W0 + 4, LOFT + 1, Z0 + 2);
      bp.lantern(W1 - 3, LOFT + 1, Z0 + 2);
    } else {
      bp.bed(cx + 2, F, Z0 + 1, 'north', 'brown');
    }
    bp.rug(W0 + 2, cz - 1, W0 + 3, cz + 1, F, { fill: 'minecraft:brown_carpet', border: 'minecraft:brown_carpet' });
  });

  bp.part('lighting', () => {
    // hanging lanterns from the collar in each band, and under the loft
    for (const [x, z] of [[W0 + 2, cz], [W1 - 2, cz + 3], [cx, Z1 - 2], [cx - 4, Z1 - 2]]) bp.lantern(x, TOP - 1, z, true);
    if (!loft) for (const [x, z] of [[cx, Z0 + 2], [cx - 4, Z0 + 2], [cx + 4, Z0 + 2]]) bp.lantern(x, TOP - 1, z, true);
    else for (const x of [cx - 1, cx + 1]) bp.lantern(x, LOFT - 1, Z0 + 2, true);
  });

  bp.part('main', () => {
    // the room's air (the trunk's logs are kept)
    for (let x = W0 + 1; x < W1; x++) for (let z = Z0 + 1; z < Z1; z++) for (let y = F; y < TOP; y++) {
      if (!bp.get(x, y, z) && !trunkAt(x, y, z)) bp.put(x, y, z, AIR);
    }
  });

  bp.port(walk.name, 'architect:walk', px, py, pz, walk.facing);
  bp.spot('entrance', W0 - 1, doorZ, -90, { y: F });
  bp.spot('spawn', px, doorZ + 1, -90, { y: F });
  bp.camera('overview', [cx - 14, TOP + 9, cz + 14], [cx, F + 2, cz]);
  return bp;
}
