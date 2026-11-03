// (7a GM) The gate mechanisms' cell layouts and timing, as `gm-probe` proved them on the running 26.3 server (docs/CONTRACT.md "Slice GM"
// §2, §2a, §7, §12; tools/gate7agm.mjs). Pure data and pure functions: no world, no compile context.
//
// Local frame (one gate): u across the passage (east, +x, in the probe), d along it from the front face (south, +z), r up from floorY.
// The gate plane is d = 1; the passage lanes are u = -1 and u = 1, the mullion u = 0; the recess (jambs) u in [-4, -2] and [2, 4];
// lintelY = r 3; the rows above it, r 4..7, hold the bus. A cell is [u, d, r, state]; a state's facing is written in the local frame
// (u+ = east, d+ = south) and turned by the caller.
//
//   layout(kind, mats) -> {cells: [[u,d,r,state]...], envelope: [[u,d,r]...], writeOrder}   the settled rest state (open by day, nothing
//                                                                                           moving); see settle()
//   settle(kind, rest, mats) -> the cells of the rest state: a fixed point (gm-unit)
//   TIMING   the ticks the probe recorded per kind (open, close)

const W = 'minecraft:';

/** The materials a gate takes: the structure block (leaf, mullion, lining, sleepers), the bar (portcullis leaves), the stone it sits in. */
export function gmMats(m = {}) {
  return {
    structure: m.structure ?? `${W}stone_bricks`,
    bar: m.bar ?? `${W}iron_bars`,
    slab: m.slab ?? `${W}stone_brick_slab`,
    button: m.button ?? `${W}stone_button`,
    plate: m.plate ?? `${W}stone_pressure_plate`,
  };
}

const k = (u, d, r) => `${u},${d},${r}`;
/** Map u-sign s to the facing that points toward the passage's centre (a piston on side s faces -s). */
const toCentre = (s) => (s < 0 ? 'east' : 'west');

/**
 * The sliding gate (portcullis = bars, slide = solid leaves): per side s = -1, +1, three sticky pistons at u = 3s (rows 0-2) push the leaf
 * column from the recess (u = 2s, open) to the lane (u = s, closed). Power G closes. The feed of G to the six pistons (§12; a 3-high piston
 * stack cannot be powered from its own plane alone, so the lining of the plane d = 2 carries the lower two):
 *   top    S = (3s,1,3), a structure block under the bus dust (3s,1,4): powers the top piston, and the middle one by quasi-connectivity
 *   right  (4s,1,2) under the dust (4s,1,3): the top piston again
 *   bottom (3s,2,0) under the dust (3s,2,1), reached down the lining: (4s,1,3) -> (4s,2,2) -> (3s,2,1)
 * The cut cells (air) let the dust step down: (4s,1,4), (3s,1,5), (4s,2,3), (3s,2,2).
 * G enters each side at (3s,2,5) on (3s,2,4).
 */
export function slideCells(kind, mats) {
  const M = gmMats(mats);
  const leaf = kind === 'slide' ? M.structure : M.bar;
  const c = new Map();
  const put = (u, d, r, s) => c.set(k(u, d, r), [u, d, r, s]);
  for (let r = 0; r <= 2; r++) put(0, 1, r, M.structure); // the mullion
  for (const s of [-1, 1]) {
    for (let r = 0; r <= 2; r++) {
      put(s, 1, r, `${W}air`); // the lane at rest (open)
      put(2 * s, 1, r, leaf); // the leaf in its recess
      put(3 * s, 1, r, `${W}sticky_piston[extended=false,facing=${toCentre(s)}]`);
    }
    put(3 * s, 1, 3, M.structure); // S
    put(3 * s, 1, 4, `${W}redstone_wire`);
    put(3 * s, 1, 5, `${W}air`);
    put(4 * s, 1, 0, M.structure);
    put(4 * s, 1, 1, M.structure);
    put(4 * s, 1, 2, M.structure);
    put(4 * s, 1, 3, `${W}redstone_wire`);
    put(4 * s, 1, 4, `${W}air`);
    put(2 * s, 1, 3, M.structure); // the sleeper over the recess
    // the lining, plane d = 2
    put(3 * s, 2, 0, M.structure);
    put(3 * s, 2, 1, `${W}redstone_wire`);
    put(3 * s, 2, 2, `${W}air`);
    put(4 * s, 2, 1, M.structure);
    put(4 * s, 2, 2, `${W}redstone_wire`);
    put(4 * s, 2, 3, `${W}air`);
    put(3 * s, 2, 4, M.structure);
    put(3 * s, 2, 5, `${W}redstone_wire`);
  }
  return c;
}

/** World placement of local cells for the probe: (u, d, r) -> (X + u, F + r, Z + d); facings unchanged (u+ = east, d+ = south). */
export function toWorld([u, d, r, s], X, F, Z) {
  return [X + u, F + r, Z + d, s];
}

/**
 * The swing gate (§2, rest closed, power opens): two iron doors (rows 0-1) at u = -1 and 1 in the plane d = 1, a transom of bars above
 * them, the mullion between. Every trigger powers the mullion's middle block (0,1,1), which both doors' upper halves touch: the button on
 * its front face (d = 0, outside, a player), the lever on its back face (d = 2, inside, holds it open); the plate on the floor of the left
 * lane behind the door (-1,2,0) powers the left door's lower half (anyone inside).
 */
export function swingCells(mats) {
  const M = gmMats(mats);
  const c = new Map();
  const put = (u, d, r, s) => c.set(k(u, d, r), [u, d, r, s]);
  for (let r = 0; r <= 2; r++) put(0, 1, r, M.structure);
  for (const [u, hinge] of [[-1, 'left'], [1, 'right']]) {
    put(u, 1, 0, `${W}iron_door[facing=south,half=lower,hinge=${hinge},open=false,powered=false]`);
    put(u, 1, 1, `${W}iron_door[facing=south,half=upper,hinge=${hinge},open=false,powered=false]`);
    put(u, 1, 2, M.bar);
  }
  const btn = M.button.replace(/\[.*$/, '');
  put(0, 0, 1, `${btn}[face=wall,facing=north,powered=false]`);
  put(0, 2, 1, `${W}lever[face=wall,facing=south,powered=false]`);
  put(-1, 2, 0, `${M.plate.replace(/\[.*$/, '')}[powered=false]`);
  return c;
}

/**
 * The drawbridge deck (GM-c, §2: lowered at rest, power raises, a ripple of one redstone tick a cell). Local frame: x along the crossing
 * (cell i = 0..n-1 over the water), z across, y up from the deck row (the deck's trapdoors, half top, flush with the banks). The deck is
 * `width` 2 (z 0 and 1); a middle row of a wider deck has nothing beside it to power it (its neighbours are trapdoors, the walk above and the
 * water below), so the deck is at most 2 wide. Each deck trapdoor is powered by a repeater beside it (z -1 or 2, delay a_i) fed by a second
 * one (z -2 or 3, delay b_i) from a bus (z -3 or 4) that both levers drive at once: cell i flips a_i + b_i = i + 2 redstone ticks after the
 * lever. Repeaters and the bus sit on sleepers one row down (in the water).
 */
export function drawbridgeCells(n, mats) {
  const M = gmMats(mats);
  if (n > 7) throw new Error('drawbridge: the ripple covers 7 cells (repeater delays 1..4 twice)');
  const c = [];
  for (let i = 0; i < n; i++) {
    const tot = i + 2, b = Math.min(4, tot - 1), a = tot - b;
    for (const [z, zf, zb, zbus, fac] of [[0, -1, -2, -3, 'north'], [1, 2, 3, 4, 'south']]) {
      c.push([i, 0, z, `${W}iron_trapdoor[facing=${fac === 'north' ? 'south' : 'north'},half=top,open=false,powered=false,waterlogged=false]`]);
      c.push([i, -1, zf, M.structure], [i, -1, zb, M.structure], [i, -1, zbus, M.structure]);
      c.push([i, 0, zf, `${W}repeater[facing=${fac},delay=${a}]`], [i, 0, zb, `${W}repeater[facing=${fac},delay=${b}]`], [i, 0, zbus, `${W}redstone_wire`]);
    }
  }
  return c;
}
/** The ripple's designed ticks: cell i flips 2 * (i + 2) game ticks after the lever (repeater ticks only; the lever and dust add none). */
export const drawbridgeTicks = (i) => 2 * (i + 2);
