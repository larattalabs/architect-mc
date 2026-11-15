// PA treehouse home (house, rustic, wrap_trunk): a one-storey family home built as a square ring round the host tree's trunk,
// under its crown, its front door on the west where the branch walk (port walk_w) arrives.
//
// Plan (design frame = the lot, 17 x 8 x 17; the trunk's axis at (cx, cz) = (8, 8), its logs x/z 6..10, kept, never written):
//
//   z=1        eave (roof stairs; corbels + accent trim under it)
//   z=2        L = = W = = W = = W = = L      north wall: kitchen windows
//   z=3..5     | table  furnace smoker barrel cauldron | NE corner
//   z=6..10  W | hall      T T T T T     |=D=| bedroom (beds against the east wall)
//   z=11..13   | living   hearth          | |
//   z=14       L = = W = = H = = W = = L      south wall: the hearth, the chimney outside it
//   x=0..1     the porch on the west, round the walk port (z 8..9), bearing on the soil bank west of the lot
//
// Rows: y0 the ring beam under the walls and the collar of braces round the trunk, y1 the deck (floor role, a stone plinth
// under the walls), y2..4 the walls (planks, log corner posts), y5 the wall plate (logs), y5..7 a hipped roof from a 1-cell
// overhang up to a flat collar round the trunk (pitch 1). Everything bears on the trunk (the deck touches it) within 4 cells;
// the overhang cells past that rest on stair corbels (a corbel steps out and up from the wall, the checker's brace rule).
// The interior is one ring room 3 wide round the trunk, a partition with a door closing off the bedroom.
import { Blueprint, palette } from '../lib/kit.mjs';
import { loadBible } from '../lib/bible.mjs';
import * as C from '../../bible/components.mjs';

const BIBLE = loadBible(new URL('../../bible/bible.json', import.meta.url));

export const id = 'gen_pa_treehouse_home';
export const fit = 'wrap_trunk';

export const params = {
  porch: { type: 'bool', default: true, label: 'Porch round the walk' },
  hearth: { type: 'bool', default: true, label: 'Hearth and chimney' },
  beds: { type: 'int', min: 1, max: 3, default: 2, label: 'Beds' },
};

export default function build({ palette: p = palette({ bible: BIBLE }), site, porch = true, hearth = true, beds = 2 } = {}) {
  const S = site.size;
  const t = site.trunk();
  const { cx, cz } = t;
  const walk = site.port('walk_w');
  const clampX = (v) => Math.max(0, Math.min(S.x - 1, v));
  const clampZ = (v) => Math.max(0, Math.min(S.z - 1, v));
  const FY = walk.at[1] - 1; // the deck row: the walk's feet stand on it
  const feet = FY + 1;
  const plate = FY + 3; // the wall plate and the eave row
  const top = Math.min(S.y - 1, plate + 3); // the flat collar round the trunk
  const W = clampX(cx - 6), E = clampX(cx + 6), N = clampZ(cz - 6), Sth = clampZ(cz + 6); // the wall ring
  const doorZ = walk.at[2];
  const solid = (x, y, z) => site.solid(x, y, z);

  const bp = new Blueprint({
    id,
    name: 'PA treehouse home',
    description: `A rustic one-storey family home wrapped round a great trunk under its crown, a ring of rooms with a kitchen, a bedroom${hearth ? ' and a stone hearth' : ''}, its door on a porch where the branch walk arrives.`,
    type: 'house',
    tags: ['rustic', 'treehouse', 'medium'],
    site,
    fit,
    size: [S.x, S.y, S.z],
    palette: p,
    groundY: feet,
    front: 'west',
    interior: [W + 1, feet, N + 1, E - 1, top - 1, Sth - 1],
  });
  bp.keep(site.cellsOf('LOG')); // the host trunk

  // ------------------------------------------------------------------ the deck, its ring beam and the trunk collar
  bp.part('deck', () => {
    for (let x = W; x <= E; x++) for (let z = N; z <= Sth; z++) {
      if (solid(x, FY, z)) continue;
      const edge = x === W || x === E || z === N || z === Sth;
      bp.put(x, FY, z, edge ? p.foundation : p.floor); // the plinth under the walls
      if (edge) bp.put(x, FY - 1, z, p.frame, { axis: x === W || x === E ? 'z' : 'x' }); // the ring beam
    }
    // the collar: upside-down stairs braced against the trunk under the deck
    for (let x = W; x <= E; x++) for (let z = N; z <= Sth; z++) {
      if (solid(x, FY - 1, z)) continue;
      for (const [dir, dx, dz] of [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]) {
        if (solid(x + dx, FY - 1, z + dz) && !bp.get(x, FY - 1, z)) { bp.put(x, FY - 1, z, p.stairs, { facing: dir, half: 'top', shape: 'straight' }); break; }
      }
    }
  });

  bp.part('porch', () => {
    const z0 = porch ? doorZ - 2 : doorZ, z1 = porch ? doorZ + 2 : doorZ + walk.width - 1;
    for (let x = 0; x < W; x++) for (let z = z0; z <= z1; z++) bp.put(x, FY, z, p.floor);
    if (porch) {
      for (const z of [z0, z0 + 1]) bp.put(0, feet, z, p.fence);
      for (let x = 1; x < W; x++) { bp.put(x, feet, z0, p.fence); bp.put(x, feet, z1, p.fence); }
      C.lantern_post(bp, { x: 0, y: feet, z: z1, facing: 'west' });
    }
  });

  // ------------------------------------------------------------------ walls and the bedroom partition
  const wallCell = (x, z) => (x === W || x === E || z === N || z === Sth);
  bp.part('main', () => {
    for (let x = W; x <= E; x++) for (let z = N; z <= Sth; z++) {
      for (let y = feet; y <= top - 1; y++) {
        if (solid(x, y, z)) continue;
        if (wallCell(x, z)) {
          if (y > plate) continue;
          const corner = (x === W || x === E) && (z === N || z === Sth);
          if (corner) bp.put(x, y, z, p.frame, { axis: 'y' });
          else if (y === plate) bp.put(x, y, z, p.frame, { axis: x === W || x === E ? 'z' : 'x' });
          else bp.put(x, y, z, p.wall);
        } else bp.put(x, y, z, 'minecraft:air');
      }
    }
    // the bedroom: a partition across the east side north of the trunk, and one down to the south wall east of it
    const pz = cz - 2, px = cx + 2;
    for (let x = E - 1; x > cx && !solid(x, feet, pz); x--) for (let y = feet; y < top; y++) bp.put(x, y, pz, x === E - 1 || solid(x - 1, y, pz) ? p.frame : p.wall, x === E - 1 || solid(x - 1, y, pz) ? { axis: 'y' } : undefined);
    for (let z = Sth - 1; z > cz && !solid(px, feet, z); z--) for (let y = feet; y < top; y++) bp.put(px, y, z, p.wall);
  });

  // ------------------------------------------------------------------ doors and windows
  const rhythm = [-3, 0, 3]; // windows every 3 cells, centred on each wall
  bp.part('openings', () => {
    bp.door(W, feet, doorZ, 'west');
    C.door_surround(bp, { x: W, y: feet, z: doorZ, facing: 'west' });
    bp.door(E - 2, feet, cz - 2, 'south'); // the bedroom door
    const win = (x, z, facing) => C.window(bp, { x, y: feet + 1, z, facing, width: 1, height: plate - feet - 1 });
    for (const d of rhythm) {
      if (d !== 0) win(W, cz + d, 'west');
      win(E, cz + d, 'east');
      win(cx + d, N, 'north');
      if (!(hearth && d === 0)) win(cx + d, Sth, 'south');
    }
  });

  // ------------------------------------------------------------------ the roof: a hip from the overhang up to a flat collar round the trunk
  bp.part('roof', () => {
    // corbels under the eave at both ends of each side: they carry the roof's corners (a corbel steps out and up from the wall)
    for (const [x, z, facing] of [[W - 1, N, 'east'], [W - 1, Sth, 'east'], [E + 1, N, 'west'], [E + 1, Sth, 'west'],
      [W, N - 1, 'south'], [E, N - 1, 'south'], [W, Sth + 1, 'north'], [E, Sth + 1, 'north']]) {
      bp.put(x, plate - 1, z, p.stairs, { facing, half: 'top', shape: 'straight' });
    }
    roofHipAround(bp, W - 1, N - 1, E + 1, Sth + 1, plate, top, solid, p);
  }, { roof: 'hip' });

  // ------------------------------------------------------------------ the hearth and its chimney
  if (hearth) {
    bp.part('chimney', () => {
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = feet; y < plate; y++) bp.put(x, y, Sth, p.stone);
      bp.put(cx, feet, Sth, 'minecraft:campfire', { lit: 'true', signal_fire: 'false', facing: 'north', waterlogged: 'false' });
      C.chimney(bp, { x: cx, y: FY, z: Sth + 1, facing: 'south', top: top - 1 });
    });
  }

  // ------------------------------------------------------------------ furnishings
  bp.part('furnishings', () => {
    // kitchen corner along the north wall
    const k = N + 1;
    bp.set(cx - 2, feet, k, 'minecraft:furnace', { facing: 'south', lit: 'false' });
    bp.set(cx - 1, feet, k, 'minecraft:smoker', { facing: 'south', lit: 'false' });
    bp.set(cx, feet, k, 'minecraft:barrel', { facing: 'up', open: 'false' });
    bp.set(cx + 1, feet, k, 'minecraft:cauldron');
    bp.set(cx + 2, feet, k, 'minecraft:crafting_table');
    // the family table in the north-west corner
    bp.table(W + 2, feet, N + 2);
    bp.chair(W + 1, feet, N + 2, 'east');
    bp.chair(W + 3, feet, N + 2, 'west');
    bp.chair(W + 2, feet, N + 1, 'south');
    // the hall: a chest and a plant by the door
    bp.set(W + 1, feet, doorZ - 2, 'minecraft:chest', { facing: 'east', type: 'single', waterlogged: 'false' });
    bp.plant(W + 1, feet, doorZ + 2, 'minecraft:potted_fern');
    // the living room by the hearth
    bp.chair(cx - 1, feet, Sth - 2, 'south');
    bp.chair(cx + 1, feet, Sth - 2, 'south');
    bp.set(W + 1, feet, Sth - 1, 'minecraft:bookshelf');
    bp.set(W + 2, feet, Sth - 1, 'minecraft:bookshelf');
    bp.rug(cx - 1, Sth - 3, cx + 1, Sth - 3, feet, { fill: 'minecraft:red_carpet', border: 'minecraft:brown_carpet' });
    // the bedroom: beds with their heads against the east wall
    const bedZ = [cz, cz + 1, Sth - 2].slice(0, beds);
    for (const z of bedZ) bp.bed(E - 1, feet, z, 'east', z === Sth - 2 ? 'green' : 'red');
    bp.set(E - 1, feet, cz - 1, 'minecraft:chest', { facing: 'west', type: 'single', waterlogged: 'false' });
    if (beds < 3) bp.set(E - 1, feet, Sth - 1, 'minecraft:barrel', { facing: 'up', open: 'false' });
  });

  // ------------------------------------------------------------------ lights: lanterns hanging from the collar
  bp.part('lighting', () => {
    // cells under the flat collar (the hip's courses lie outside it), one per corner square and one per side
    for (const [x, z] of [[W + 2, N + 2], [cx, N + 2], [E - 2, N + 2], [W + 2, cz], [E - 2, cz + 1], [W + 2, Sth - 2], [cx, Sth - 2], [E - 2, Sth - 2]]) {
      if (bp.nameAt(x, top, z) !== 'minecraft:air' && bp.nameAt(x, top - 1, z) === 'minecraft:air') bp.lantern(x, top - 1, z, true);
    }
  });

  bp.port(walk.name, 'architect:walk', ...site.portHint(walk.name), walk.facing);
  bp.spot('entrance', W - 1, doorZ, -90, { y: feet });
  bp.spot('spawn', 0, doorZ + 1, -90, { y: feet });
  bp.camera('overview', [cx - 15, top + 9, cz + 13], [cx, feet + 1, cz]);
  return bp;
}

/**
 * A hip roof over (x0,z0)-(x1,z1) with eaves on row y, rising one row per cell to a flat collar on row `top` round the trunk
 * (the site's solid cells are left). Corners get outer-corner stairs.
 */
function roofHipAround(bp, x0, z0, x1, z1, y, top, solid, p) {
  const R = top - y;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const dN = z - z0, dS = z1 - z, dW = x - x0, dE = x1 - x;
    const m = Math.min(dN, dS, dW, dE);
    if (m >= R) { if (!solid(x, top, z)) bp.put(x, top, z, p.roofBlock); continue; }
    if (solid(x, y + m, z)) continue;
    const sides = [dN === m && 'north', dS === m && 'south', dW === m && 'west', dE === m && 'east'].filter(Boolean);
    const opp = { north: 'south', south: 'north', west: 'east', east: 'west' };
    let facing = opp[sides[0]];
    let shape = 'straight';
    if (sides.length > 1) {
      const ns = sides.find((q) => q === 'north' || q === 'south');
      const we = sides.find((q) => q === 'west' || q === 'east');
      facing = ns === 'north' ? 'south' : 'north';
      shape = { 'north,west': 'outer_left', 'north,east': 'outer_right', 'south,east': 'outer_left', 'south,west': 'outer_right' }[`${ns},${we}`];
    }
    bp.put(x, y + m, z, p.roofStairs, { facing, half: 'bottom', shape });
    // a lining under each course above the eaves ties it to the one below (inside: the sloped ceiling's step)
    const under = bp.nameAt(x, y + m - 1, z);
    if (m > 0 && (under === null || under === 'minecraft:air')) bp.put(x, y + m - 1, z, p.roofBlock);
  }
}
