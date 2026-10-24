// Component library (parts) of the built-in Style `birch`: drafted by U5's "Add parts…" (bible.parts) on bib_birch_parts (from birch v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Birch (parts)`: pale birch on polished andesite under a dark oak roof (rules in
// kit/lib/components.mjs). The pale walls take their contrast from dark oak details (shutters, door hood, lamp posts)
// and grey andesite stonework (sills, doorstep, chimney).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in a birch log frame (lintel across the top), dark oak shutters folded open against the wall
//                  either side, a polished andesite sill under opening and shutters
//   door_surround  birch log posts either side of the door, a dark oak lintel, a dark oak slab hood outside above it,
//                  a polished andesite doorstep
//   lantern_post   an andesite wall foot on a polished andesite block, a dark oak fence post, the lantern on top
//   roof_trim      a pale birch soffit (top slabs) under the dark oak eave: the light line under the dark roof
//   chimney        a polished andesite base, an andesite stack, a polished andesite band and an andesite wall flue

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** The accent wood's trapdoor (a shape of the accent role), else the main wood's. */
function accentTrapdoor(p) {
  return /_planks$/.test(p.accentPlanks ?? '') ? p.accentPlanks.replace(/_planks$/, '_trapdoor') : p.trapdoor;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  const shutter = accentTrapdoor(p);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
  }
  // the lintel: one log across the opening and a cell either side
  const axis = ax !== 0 ? 'x' : 'z';
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.frame, axisProps(bp, p.frame, axis));
  // shutters folded open flat against the wall either side, and the sill under opening and shutters
  for (let i = lo - 1; i <= lo + w; i++) {
    const x = at.x + ax * i + out.dx;
    const z = at.z + az * i + out.dz;
    bp.set(x, at.y - 1, z, p.stoneSlab, { type: 'top' });
    if (i === lo - 1 || i === lo + w) {
      for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, shutter, { facing: at.facing, half: 'bottom', open: 'true' });
    }
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  // log posts either side, a dark lintel over the door
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 2; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 2, at.z, p.accentPlanks);
  // a slab hood outside, above the head height, against the lintel
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, p.accentSlab, { type: 'top' });
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.accentFence);
  bp.set(at.x, at.y + 2, at.z, p.accentFence);
  bp.lantern(at.x, at.y + 3, at.z, false, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // the pale soffit under the eave, unless something (a door's hood, a post) is already there
    if (!bp.get(x, at.y - 1, z)) bp.set(x, at.y - 1, z, p.slab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  const base = Math.min(at.y + 1, top - 1);
  bp.fill([at.x, at.y, at.z, at.x, base, at.z], p.foundation);
  if (base + 1 <= top - 1) bp.fill([at.x, base + 1, at.z, at.x, top - 1, at.z], p.stoneTrim);
  bp.set(at.x, top, at.z, p.stone);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
