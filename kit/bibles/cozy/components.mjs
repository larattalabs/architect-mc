// Component library (parts) of the built-in Style `cozy`: drafted by U5's "Add parts…" (bible.parts) on bib_cozy_parts (from cozy v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Cozy (parts)`: an oak cottage on mossy cobblestone, small windows and warm light,
// low deep gables (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         a small pane opening in an oak log frame, accent (spruce) shutters either side, an accent sill
//   door_surround  log posts and a log lintel, a little roof-wood hood over the door, a hanging lantern, a stone step
//   lantern_post   a log on a mossy foundation block, a fence post with a fence arm and a lantern hanging from it
//   roof_trim      accent soffit slabs under the eave and an accent fascia board (open trapdoors) on the eave's face
//   chimney        a cobblestone column on a mossy foot, a trim band and a stone-wall pot at the top

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** Fence connection props towards the given directions. */
function fenceProps(dirs) {
  const props = {};
  for (const d of ['north', 'south', 'east', 'west']) props[d] = dirs.includes(d) ? 'true' : 'false';
  return props;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const axis = ax !== 0 ? 'x' : 'z';
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening: an upside-down accent stair against the wall
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.accentStairs, { facing: bp.kit.OPPOSITE[at.facing], half: 'top', shape: 'straight' });
  }
  // the frame: log jambs either side, a log lintel across the top
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.frame, axisProps(bp, p.frame, 'y'));
  }
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.frame, axisProps(bp, p.frame, axis));
  // shutters: open accent trapdoors on the jambs' outer faces
  const shutter = accentTrapdoor(p);
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) {
      bp.set(at.x + ax * i + out.dx, y, at.z + az * i + out.dz, shutter, { facing: at.facing, open: 'true', half: 'bottom' });
    }
  }
}

/** The accent wood's trapdoor (the accent role's shape), else the main wood's. */
function accentTrapdoor(p) {
  const m = /^(.*)_planks$/.exec(p.accentPlanks ?? '');
  return m ? `${m[1]}_trapdoor` : p.trapdoor;
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const axis = ax !== 0 ? 'x' : 'z';
  // log posts either side, a log lintel over the door
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.frame, axisProps(bp, p.frame, axis));
  // a small hood in the roof wood: stairs sloping out from the lintel, its ends turned down
  for (let s = -1; s <= 1; s++) {
    bp.set(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, p.roofStairs, { facing: bp.kit.OPPOSITE[at.facing], half: 'bottom', shape: 'straight' });
  }
  // a lantern hanging under one end of the hood, beside the way in
  bp.lantern(at.x + ax + out.dx, at.y + 1, at.z + az + out.dz, true, p.light);
  // a step, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const side = bp.kit.CW[at.facing];
  const back = bp.kit.OPPOSITE[side];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 1, at.z, p.fence, fenceProps([]));
  bp.set(at.x, at.y + 2, at.z, p.fence, fenceProps([]));
  // the arm: a fence reaching one cell sideways, a lantern hanging from it, an accent slab capping the post
  bp.set(at.x, at.y + 3, at.z, p.fence, fenceProps([side]));
  bp.set(at.x + ax, at.y + 3, at.z + az, p.fence, fenceProps([back]));
  bp.set(at.x, at.y + 4, at.z, p.accentSlab, { type: 'bottom' });
  bp.lantern(at.x + ax, at.y + 2, at.z + az, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const out = bp.kit.DIR[at.facing];
  const [ax, az] = out.dx === 0 ? [1, 0] : [0, 1];
  const board = accentTrapdoor(p);
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // the soffit under the eave, unless something (a door's headroom, a post) is already there
    if (!bp.get(x, at.y - 1, z)) bp.set(x, at.y - 1, z, p.accentSlab, { type: 'top' });
    // the fascia: an accent board on the eave's outer face
    if (bp.get(x, at.y, z) && !bp.get(x + out.dx, at.y, z + out.dz)) {
      bp.set(x + out.dx, at.y, z + out.dz, board, { facing: at.facing, open: 'true', half: 'bottom' });
    }
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  // a mossy foot, a cobblestone shaft, a band of trim and a stone-wall pot on top
  bp.fill([at.x, at.y, at.z, at.x, Math.min(at.y + 1, top - 1), at.z], p.foundation);
  if (at.y + 2 <= top - 1) bp.fill([at.x, at.y + 2, at.z, at.x, top - 1, at.z], p.stone);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
