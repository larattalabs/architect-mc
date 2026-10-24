// Component library (parts) of the built-in Style `desert`: drafted by U5's "Add parts…" (bible.parts) on bib_desert_parts (from desert v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Desert (parts)`: sandstone and jungle wood with smooth sandstone plaster
// (lib/components.mjs has the rules). Every material comes from the palette (bp.p, roles in bp.p.roles), so the same
// components re-skin under any bible; directions come from bp.kit. Each function takes (bp, at, opts), `at` in design
// coordinates. No imports.
//
//   window         panes in a smooth sandstone reveal, a cut sandstone lintel, jungle shutters folded open against the wall
//                  and a sandstone sill outside
//   door_surround  cut sandstone jambs and lintel, a smooth sandstone hood on corbels above, a sandstone doorstep
//   lantern_post   a cut sandstone pedestal on a sandstone footing, a sandstone wall shaft, a lantern on top
//   roof_trim      jungle log beam ends (vigas) poking out under the eave, cut sandstone slabs between them
//   chimney        a sandstone stack with cut sandstone bands, a vent post and a smooth sandstone cap

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block lying along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  const hi = lo + w - 1;
  for (let i = lo; i <= hi; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // the reveal: smooth sandstone either side of the opening, in the wall plane; jungle shutters folded open outside it
  for (const i of [lo - 1, hi + 1]) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) {
      bp.set(x, y, z, p.plaster);
      bp.set(x + out.dx, y, z + out.dz, p.trapdoor, { facing: at.facing, half: 'bottom', open: 'true' });
    }
  }
  // the lintel: cut sandstone across the opening and the reveal
  for (let i = lo - 1; i <= hi + 1; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.stoneTrim);
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const right = bp.kit.CW[at.facing];
  const left = bp.kit.CCW[at.facing];
  // cut sandstone jambs and lintel in the wall plane
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.stoneTrim);
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
  // a smooth sandstone hood over the door, above head height: a top slab on two upside-down stair corbels
  const hx = at.x + out.dx;
  const hz = at.z + out.dz;
  bp.set(hx, at.y + 2, hz, p.roofSlab, { type: 'top' });
  bp.stairs(hx - ax, at.y + 2, hz - az, right, { block: p.roofStairs, half: 'top' });
  bp.stairs(hx + ax, at.y + 2, hz + az, left, { block: p.roofStairs, half: 'top' });
  // a doorstep, level with the floor, outside the door
  bp.set(hx, at.y - 1, hz, p.stone);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneTrim);
  bp.set(at.x, at.y + 1, at.z, p.stoneWall);
  bp.set(at.x, at.y + 2, at.z, p.stoneWall);
  bp.lantern(at.x, at.y + 3, at.z, false, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const out = bp.kit.DIR[at.facing];
  const [ax, az] = out.dx === 0 ? [1, 0] : [0, 1];
  const axis = out.dx === 0 ? 'z' : 'x';
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's hood, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    // a beam end every third cell, from the second, so both corners get one
    if (i % 3 === 1 || i === n - 2) bp.set(x, at.y - 1, z, p.frame, axisProps(bp, p.frame, axis));
    else bp.set(x, at.y - 1, z, p.stoneSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  for (let y = at.y; y < top; y++) bp.set(at.x, y, at.z, (y - at.y) % 4 === 0 ? p.stoneTrim : p.stone);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
  bp.set(at.x, top + 2, at.z, p.roofSlab, { type: 'bottom' });
}
