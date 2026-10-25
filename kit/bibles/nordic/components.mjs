// Component library (parts) of the built-in Style `nordic`: drafted by U5's "Add parts…" (bible.parts) on bib_nordic_parts (from nordic v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Nordic (parts)`: spruce halls on cobbled deepslate under steep spruce roofs
// (kit/lib/components.mjs has the rules). Shaped on the reference library kit/bibles/rustic/components.mjs.
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes framed by a log lintel, accent-wood shutters open either side, an accent bracket sill
//   door_surround  log posts, an accent lintel, a small steep gable hood of roof stairs over the door, a trim doorstep
//   lantern_post   a log post on a foundation block, an accent fence arm with a hanging lantern, a roof slab cap
//   roof_trim      accent corbels and slabs alternating under the eave, an accent fascia board along the roof edge
//   chimney        a foundation-stone stack banded with trim, a stone wall post and a stone slab hood on top

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** The accent wood's trapdoor (a shape of the accent role), else the palette's trapdoor. */
function accentTrapdoor(bp) {
  const a = bp.p.accentPlanks;
  return typeof a === 'string' && /_planks$/.test(a) ? a.replace(/_planks$/, '_trapdoor') : bp.p.trapdoor;
}

/** Set a cell only if it is still empty (never overwrite a door, a post or the roof). */
function put(bp, x, y, z, block, props) {
  if (!bp.get(x, y, z)) bp.set(x, y, z, block, props);
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside: an upside-down accent stair, its back against the wall, like a carved bracket
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.accentStairs, { facing: inward, half: 'top' });
  }
  // the lintel: one log across the opening and a cell either side
  const axis = ax !== 0 ? 'x' : 'z';
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.log, axisProps(bp, p.log, axis));
  // shutters: accent trapdoors open flat against the wall either side of the opening
  const td = accentTrapdoor(bp);
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) {
      put(bp, at.x + ax * i + out.dx, y, at.z + az * i + out.dz, td, { facing: at.facing, open: 'true', half: 'bottom' });
    }
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const right = bp.kit.CW[at.facing];
  const left = bp.kit.CCW[at.facing];
  // log posts either side of the door, up through the lintel row
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 2; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  // an accent lintel over the door
  bp.set(at.x, at.y + 2, at.z, p.accentPlanks);
  // the hood: a steep little gable of roof stairs outside, over the lintel, with a slab at its peak
  const hx = at.x + out.dx;
  const hz = at.z + out.dz;
  put(bp, hx - ax, at.y + 2, hz - az, p.roofStairs, { facing: right });
  put(bp, hx + ax, at.y + 2, hz + az, p.roofStairs, { facing: left });
  put(bp, hx, at.y + 2, hz, p.roofBlock);
  put(bp, hx, at.y + 3, hz, p.roofSlab, { type: 'bottom' });
  // a doorstep, level with the floor, outside the door
  bp.set(hx, at.y - 1, hz, p.stoneTrim);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const arm = bp.kit.DIR[at.facing];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  for (let y = at.y; y <= at.y + 2; y++) bp.set(at.x, y, at.z, p.log, axisProps(bp, p.log, 'y'));
  bp.set(at.x, at.y + 3, at.z, p.roofSlab, { type: 'bottom' });
  // an accent fence arm off the top of the post, the lantern hanging under it
  bp.set(at.x + arm.dx, at.y + 2, at.z + arm.dz, p.accentFence);
  bp.lantern(at.x + arm.dx, at.y + 1, at.z + arm.dz, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  const [ax, az] = out.dx === 0 ? [1, 0] : [0, 1];
  const td = accentTrapdoor(bp);
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave: an accent corbel every other cell, top slabs between (unless something is already there)
    if (i % 2 === 0) put(bp, x, at.y - 1, z, p.accentStairs, { facing: inward, half: 'top' });
    else put(bp, x, at.y - 1, z, p.accentSlab, { type: 'top' });
    // the fascia: an accent board open against the eave's outer face, where the eave has a block
    if (bp.get(x, at.y, z)) put(bp, x + out.dx, at.y, z + out.dz, td, { facing: at.facing, open: 'true', half: 'bottom' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.foundation);
  // trim bands: at the foot and every storey up the stack
  for (let y = at.y; y < top; y += 4) bp.set(at.x, y, at.z, p.stoneTrim);
  bp.set(at.x, top, at.z, p.stoneTrim);
  // the vent: a stone wall post under a stone slab hood
  bp.set(at.x, top + 1, at.z, p.stoneWall);
  bp.set(at.x, top + 2, at.z, p.stoneSlab, { type: 'bottom' });
}
