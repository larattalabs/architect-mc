// (7a K3, §10) Wall-lot designs: a tower and a gatehouse for a lot on a wall's line, built in the lot's own frame (front to the south, x
// across, z from the back; y 0 the floor row, 1 the feet) from a bible's roles (resolveRoles: the rustic defaults under the bible's).
// Moved here from tools/lib/gate7ak3-designs.mjs (which re-exports it) so the sidecar's sim can build them as its stand-in for a wall lot
// (standInDesign; sidecar/src/sim.ts). K3's gate writes them straight into the library, so the look gallery shows a castle in each bible's
// materials. Each design fills its lot's box exactly (the realise fits a
// design to its box; a smaller one leaves the wall open at the box's faces), keeps the box's outer faces closed at rows 1..3 (the
// onWall record's outerFaces: walls, panes; its door on an inner face) and, for a gatehouse, its passage open (the reserved cells,
// onWall.passage.lotCells: air, a standable floor under them). Broken variants for item 7: `outerDoor: true` (a door in an outer face:
// refused at bind), `badFloor: true` (the passage's floor a fence row: refused at bind), `openPassage: false` (the passage walled: not
// refused, the realise drops those blocks and reports the count; survival never bills them).
//
//   towerDesign(K, id, lot, roles, opts)      a tower of the lot's size: crenellated, lit on every floor, a ladder up through 3+ floors;
//                                             a hipped roof (roof role) over the crenels where the bible's roof role has stairs and
//                                             `roof: true`, else an open top. `doorAt: [u, v]` puts the door there; `maxH` caps the
//                                             height (fewer storeys)
//   gatehouseDesign(K, id, lot, roles, opts)  a gatehouse: the passage through it (under a lintel course of the trim role, lit from niches
//                                             in its side walls), a hall over it, crenellated, a ladder up from a room on one side;
//                                             the GM seam: the row over the front arch (passage.lintelY) is a solid lintel course the
//                                             later gate mechanism slice may cut a portcullis slot through
//   frameOf(lot)                              the lot's frame size [W, D] and its outer-face and passage cells in the frame ({u, v, y})
//   standInDesign(id, spec, palette)          (the sim's stand-in) the design for a wall lot the sim knows only by its request: spec
//                                             {type: tower | gatehouse, size: [W, H, D], passage: [[u, y, v], ...] | null, outerDoor,
//                                             outerFaces?: the onWall record's outerFaces.lotCells when the request carries them}.
//                                             Every face cell closed at rows 1..3 but the doors and the passage: a gatehouse's doors on
//                                             its back face (its front faces out), safe for any outer-face set; a tower's one door on its
//                                             front face (a tower's front faces in), at the middlemost cell off `outerFaces`. Without
//                                             them that is the front's middle: right for a run or via tower, but a corner tower's front
//                                             is half outer, its middle always (no door cell is inner for every corner tower), so a
//                                             corner tower needs `outerFaces`. `outerDoor` (sim:outerdoor) puts the door in an outer
//                                             face: a tower's back face, a gatehouse's front face beside the passage.
// Pure: returns a kit Blueprint (the caller writes it to the library with writeBlueprint). `K`: {Blueprint, palette, variant, shapeOf,
// doorOf}; KIT (this kit's own) when omitted by standInDesign.
import { Blueprint, palette as makePalette, variant, PALETTES, rolesOfPalette } from './kit.mjs';
import { shapeOf, doorOf } from './connectors/style.mjs';
import { resolveRoles } from './region/plan.mjs';

/** This kit's design toolbox (the K the designs take). */
export const KIT = Object.freeze({ Blueprint, palette: makePalette, variant, shapeOf, doorOf });

const runsToCells = (runs) => {
  const out = [];
  if (!Array.isArray(runs)) return out;
  for (let i = 0; i + 3 < runs.length; i += 4) for (let y = runs[i + 2]; y <= runs[i + 3]; y++) out.push([runs[i], y, runs[i + 1]]);
  return out;
};

/** The lot's frame: [W, D] and the outer faces' and passage's cells in it ([u, y (from the floor), v]). */
export function frameOf(lot) {
  const ow = lot.onWall ?? {};
  return { W: ow.frame?.[0], D: ow.frame?.[1], outer: runsToCells(ow.outerFaces?.lotCells), passage: runsToCells(ow.passage?.lotCells) };
}

/** The first of `roles` (role names) whose block has variant `shape` (shapeOf), else null. */
function shaped(K, roles, names, shape) {
  for (const n of names) { const b = roles[n]; if (!b) continue; const v = K.shapeOf(b, shape); if (v) return v; }
  return null;
}

const base = (s) => String(s).replace(/\[.*$/, '');

/** The blocks a design takes from a bible's roles. */
function blocksOf(K, roles) {
  const body = base(roles.structure ?? roles.wall);
  const trim = base(roles.trim ?? roles.structure);
  const floor = base(roles.floor ?? roles.structure);
  const light = base(roles.light ?? 'minecraft:lantern');
  const glass = base(roles.glass ?? 'minecraft:glass');
  const pane = K.variant(glass, 'pane') ?? (glass.endsWith('_glass') ? `${glass}_pane` : 'minecraft:glass_pane');
  return {
    body, trim, floor, light, pane,
    frame: base(roles.frame ?? roles.trim),
    roofStairs: shaped(K, roles, ['roof'], 'stairs'), roofBlock: base(roles.roof ?? roles.trim),
    trimStairs: shaped(K, roles, ['trim', 'structure'], 'stairs') ?? 'minecraft:stone_brick_stairs',
    trimSlab: shaped(K, roles, ['trim', 'structure'], 'slab') ?? 'minecraft:stone_brick_slab',
    merlon: shaped(K, roles, ['trim', 'structure'], 'wall'),
    fence: K.shapeOf(roles.rail ?? 'minecraft:oak_fence', 'fence') ?? 'minecraft:oak_fence',
    door: K.doorOf(roles.frame ?? roles.trim ?? 'minecraft:oak_planks'),
    lantern: /:(soul_)?lantern$/.test(light),
  };
}

/** A lit lamp at (x, y, z) standing on the block under it (a lantern; a full light block set as itself). */
function lamp(bp, B, x, y, z) {
  if (B.lantern) bp.set(x, y, z, B.light, { hanging: 'false' });
  else bp.set(x, y, z, B.light);
}

/**
 * The crenellated top: a deck on row y over the box, a parapet ring at y + 1 (full trim blocks) with merlons at y + 2 every other cell
 * (the trim's wall block where it has one, joined by finalize), lamps on the deck inside two corners.
 */
function crenelTop(bp, B, W, D, y) {
  bp.fill([0, y, 0, W - 1, y, D - 1], B.floor);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    if (!(x === 0 || x === W - 1 || z === 0 || z === D - 1)) continue;
    bp.set(x, y + 1, z, B.trim);
    if ((x + z) % 2 === 0) bp.set(x, y + 2, z, B.merlon ?? B.trim);
  }
  lamp(bp, B, 1, y + 1, 1);
  lamp(bp, B, W - 2, y + 1, D - 2);
}

/** The design's common start: a Blueprint of the frame's size (approach none, front south), the floor row in the floor role. */
function start(K, id, kind, W, H, D, roles, interior, palette = null) {
  const p = palette ?? K.palette({});
  const bp = new K.Blueprint({ id, name: id, description: `K3 stub ${kind} (${W}x${D})`, type: kind, size: [W, H, D], origin: [0, 0, 0], groundY: 1, front: 'south', palette: p, approach: false, interior });
  return { bp, B: blocksOf(K, roles) };
}

/**
 * The tower: walls of the body role (trim bands every 5 rows), a floor every 5 rows with a ladder up the back wall through them all,
 * slit windows (panes) above the outer faces' rows, a lamp on every floor, the door on the front row at its middlemost cell off the outer
 * faces (an inner face; else the back), and the crenellated top (a hipped roof over it with `roof`).
 */
export function towerDesign(K, id, lot, roles, { roof = false, outerDoor = false, doorAt = null, maxH = Infinity, palette = null } = {}) {
  const { W, D, outer } = frameOf(lot);
  const extra = 3 + (roof ? (Math.min(W, D) >> 1) : 0);
  const storeys = Math.max(1, Math.min(Math.max(3, Math.ceil((2 * Math.min(W, D)) / 5)), Math.floor((maxH - extra) / 5)));
  const topY = 5 * storeys; // the deck row
  const H = topY + extra;
  const { bp, B } = start(K, id, 'tower', W, H, D, roles, [1, 1, 1, W - 2, topY - 1, D - 2], palette);
  const isOuter = new Set(outer.map(([u, , v]) => `${u},${v}`));
  bp.part('main', () => {
    bp.fill([0, 0, 0, W - 1, 0, D - 1], B.floor);
    for (let y = 1; y < topY; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      if (!(x === 0 || x === W - 1 || z === 0 || z === D - 1)) { bp.air(x, y, z); continue; }
      bp.set(x, y, z, y % 5 === 0 ? B.trim : B.body);
    }
    for (let s = 1; s < storeys; s++) bp.fill([1, 5 * s, 1, W - 2, 5 * s, D - 2], B.floor);
  }, { roof: roof ? 'hip' : 'flat', storeys });
  bp.part('openings', () => {
    // slit windows on every face above row 3, two per face per storey
    for (let s = 0; s < storeys; s++) {
      const y = 5 * s + 3;
      if (y < 4) continue;
      for (const x of [2, W - 3]) { bp.set(x, y, 0, B.pane); bp.set(x, y, D - 1, B.pane); }
      for (const z of [2, D - 3]) { bp.set(0, y, z, B.pane); bp.set(W - 1, y, z, B.pane); }
    }
    // the door: on the front row, the middlemost cell off the outer faces (rows 1 and 2), else on the back row
    const mid = (W - 1) >> 1;
    const cand = [...Array(W).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    const free = (u, v) => !isOuter.has(`${u},${v}`) && u > 0 && u < W - 1;
    let door = null;
    for (const v of [D - 1, 0]) { const u = cand.find((q) => free(q, v)); if (u !== undefined) { door = [u, v]; break; } }
    if (outerDoor) { const o = outer.find(([u, , v]) => u > 0 && u < W - 1 && (v === 0 || v === D - 1)); if (o) door = [o[0], o[2]]; }
    if (doorAt) door = [doorAt[0], doorAt[1]];
    if (door) bp.door(door[0], 1, door[1], door[1] === 0 ? 'north' : 'south');
    bp.spot('entrance', door ? door[0] : (W - 1) >> 1, door ? (door[1] === 0 ? 1 : D - 2) : D - 2, door && door[1] === 0 ? 0 : 180, { y: 1 });
  });
  bp.part('stair', () => {
    // a ladder up the back wall's inside (column 1 or 2), through every floor to the deck
    bp.ladder(1, 1, 1, topY, 'south');
    for (let s = 1; s <= storeys; s++) lamp(bp, B, W - 2, 5 * (s - 1) + 1, D - 2 > 1 ? D - 2 : 1);
  });
  bp.part('top', () => {
    if (roof && B.roofStairs) {
      // a roofed top: the walls carried up a course with lamps under the eaves, the hipped roof on them
      bp.fill([0, topY, 0, W - 1, topY, D - 1], B.floor);
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) if (x === 0 || x === W - 1 || z === 0 || z === D - 1) bp.set(x, topY + 1, z, B.trim);
      lamp(bp, B, W - 2, topY + 1, D - 2);
      bp.roofHip(0, 0, W - 1, D - 1, topY + 2, { stairs: B.roofStairs, top: B.roofBlock, lining: B.roofBlock });
    } else crenelTop(bp, B, W, D, topY);
    bp.air(1, topY, 1); // the ladder's hatch through the deck
    bp.ladder(1, 1, topY, topY, 'south');
  }, { roof: roof ? 'hip' : 'flat' });
  bp.spot('spawn', W - 2, 2, 180, { y: 1 });
  return bp;
}

/**
 * The gatehouse: the passage through the middle (its reserved cells air, its floor the floor role, an arch of the trim role's stairs
 * front and back over it, lamps in niches in its side walls), side rooms either side (doors on the back face, an inner face), a floor
 * over the passage at row 5 with a hall over it (windows), the crenellated top at row 10, a ladder up from the east room. Its front
 * face is closed but for the passage (rows 1..3), and its sides' outer halves too.
 */
export function gatehouseDesign(K, id, lot, roles, { openPassage = true, outerDoor = false, badFloor = false, palette = null } = {}) {
  const { W, D, outer, passage } = frameOf(lot);
  const topY = 10;
  const H = topY + 3;
  const { bp, B } = start(K, id, 'gatehouse', W, H, D, roles, [1, 1, 1, W - 2, topY - 1, D - 2], palette);
  const pass = new Set(passage.map(([u, , v]) => `${u},${v}`));
  const pu = [...new Set(passage.map(([u]) => u))].sort((a, b) => a - b);
  const p0 = pu[0] ?? ((W - 3) >> 1), p1 = pu[pu.length - 1] ?? p0 + 2;
  const isOuter = new Set(outer.map(([u, , v]) => `${u},${v}`));
  bp.part('main', () => {
    bp.fill([0, 0, 0, W - 1, 0, D - 1], B.floor);
    for (let y = 1; y < topY; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1;
      // the passage's side walls (the rooms' inner walls) from the floor to the hall's floor
      const side = y < 5 && (x === p0 - 1 || x === p1 + 1);
      if (edge || side) bp.set(x, y, z, y === 5 ? B.trim : B.body);
      else bp.air(x, y, z);
    }
    bp.fill([1, 5, 1, W - 2, 5, D - 2], B.floor); // the hall's floor, over the passage
  }, { roof: 'flat', storeys: 2 });
  bp.part('passage', () => {
    // the passage: air rows 1..3 through the box, its floor the floor role; the lintel course over it (row 4) the trim, its arch the trim's
    // stairs upside down at the ends of each face's opening
    for (let x = p0; x <= p1; x++) for (let z = 0; z < D; z++) {
      for (let y = 1; y <= 3; y++) { if (openPassage) bp.air(x, y, z); else bp.set(x, y, z, B.body); }
      bp.set(x, 4, z, B.trim);
      // (the broken variant badFloor: the passage's floor row a fence (1.5 tall: nothing stands on it), refused at bind)
      if (badFloor) bp.set(x, 0, z, B.fence);
    }
    // (the opening is the passage's reserved cells, rows 1..3: the realise drops anything there, so its arch is the lintel course)
    // lamps in niches in the passage's side walls, midway through
    const zm = (D - 1) >> 1;
    for (const x of [p0 - 1, p1 + 1]) { bp.air(x, 2, zm); lamp(bp, B, x, 2, zm); bp.set(x, 1, zm, B.body); }
  });
  bp.part('rooms', () => {
    // the side rooms: a door each on the back face (an inner face), a lamp inside; the ladder up from the east room to the hall and the top
    const rooms = [[1, p0 - 2], [p1 + 2, W - 2]].filter(([a, b]) => b >= a);
    for (const [a, b] of rooms) {
      const u = (a + b) >> 1;
      if (!isOuter.has(`${u},0`)) bp.door(u, 1, 0, 'north');
      // (the broken variant: a second door on the front face, an outer face)
      if (outerDoor) bp.door(u, 1, D - 1, 'south');
      lamp(bp, B, b, 1, D - 2);
    }
    const r = rooms[rooms.length - 1];
    if (r) {
      const lx = r[1];
      bp.ladder(lx, 1, 1, topY, 'south');
      bp.air(lx, 5, 1);
      bp.ladder(lx, 1, 5, 5, 'south');
    }
    // the hall's windows over the outer face and the back, lamps along it
    for (let x = 2; x < W - 2; x += 3) { bp.set(x, 7, 0, B.pane); bp.set(x, 7, D - 1, B.pane); }
    lamp(bp, B, 2, 6, (D - 1) >> 1);
    lamp(bp, B, W - 3, 6, (D - 1) >> 1);
  });
  bp.part('top', () => {
    crenelTop(bp, B, W, D, topY);
    const r = [[1, p0 - 2], [p1 + 2, W - 2]].filter(([a, b]) => b >= a).pop();
    if (r) { bp.air(r[1], topY, 1); bp.ladder(r[1], 1, topY, topY, 'south'); }
  }, { roof: 'flat' });
  bp.spot('entrance', (W - 1) >> 1, D - 1, 180, { y: 1 });
  bp.spot('spawn', (W - 1) >> 1, D - 2, 180, { y: 1 });
  return bp;
}

/**
 * The passage columns of a gatehouse stand-in from a request's reserved cells (in the lot's frame, [u, y, v]; they may be merged with an
 * irrigation set): the columns u reserved at the feet row (y 0) on every row v front to back, else every u reserved, else the middle 3.
 * Returns the passage's cells [[u, y, v]] (rows 0..2, every v) of a frame W x D.
 */
export function standInPassage(W, D, reserved = []) {
  const at = new Set(reserved.map(([u, y, v]) => `${u},${y},${v}`));
  const us = [...new Set(reserved.map(([u]) => u))].filter((u) => u > 1 && u < W - 2).sort((a, b) => a - b);
  let cols = us.filter((u) => [...Array(D).keys()].every((v) => at.has(`${u},0,${v}`)));
  if (!cols.length) cols = us;
  if (!cols.length) { const c = (W - 3) >> 1; cols = [c, c + 1, c + 2]; }
  const out = [];
  for (const u of cols) for (let v = 0; v < D; v++) for (let y = 0; y < 3; y++) out.push([u, y, v]);
  return out;
}

const toRuns = (cells) => cells.flatMap(([u, y, v]) => [u, v, y, y]);

/**
 * (the sim's stand-in for a wall lot) A tower or a gatehouse of exactly `spec.size` [W, H (the cap), D] in `palette`'s roles (a bible
 * palette's roles, else the preset's), safe for any outer-face set (see the header). `spec.passage`: the gatehouse's passage cells (the
 * request's reserved cells; standInPassage). `spec.outerDoor`: the sim:outerdoor fault (a door in an outer face).
 */
export function standInDesign(id, spec, palette = PALETTES.rustic, K = KIT) {
  const [W, H, D] = spec.size;
  const p = palette ?? PALETTES.rustic;
  // (S-THEME) the body is the palette's stone set (derived from the style's own stone-like roles) unless the style names a structure
  // role; the rail its wood's fence
  const roles = resolveRoles({ structure: p.stone, ...(p.fence ? { rail: p.fence } : {}), ...(p.roles ?? rolesOfPalette(p)) });
  const lot = { onWall: { frame: [W, D], outerFaces: { lotCells: Array.isArray(spec.outerFaces) ? spec.outerFaces : [] }, ...(spec.type === 'gatehouse' ? { passage: { lotCells: toRuns(spec.passage ?? standInPassage(W, D)) } } : {}) } };
  if (spec.type === 'gatehouse') return gatehouseDesign(K, id, lot, roles, { outerDoor: !!spec.outerDoor, palette: p });
  // a tower: its door on the front face (the frame's front row, which faces in), or (sim:outerdoor) the back face
  const bp = towerDesign(K, id, lot, roles, { maxH: H, palette: p, ...(spec.outerDoor ? { doorAt: [(W - 1) >> 1, 0] } : {}) });
  return bp;
}
