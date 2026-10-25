// Component library (parts) of the built-in Style `mangrove`: drafted by U5's "Add parts…" (bible.parts) on bib_mangrove_parts (from mangrove v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Mangrove (parts)`: mangrove planks and logs on a mud-brick plinth, packed mud plaster
// as the light trim against the red wood, spruce as the dark accent (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes under a packed mud lintel (a cell either side), a mud-brick sill outside,
//                  accent-wood shutters folded flat against the wall either side
//   door_surround  log posts either side of the door, a packed mud lintel, a roof-slab hood over the step,
//                  a mud-brick doorstep outside
//   lantern_post   a mud-brick wall base, a fence post with a fence arm and a lantern hanging from it
//   roof_trim      accent top slabs under the eave with a log bracket every few cells
//   chimney        a mud-brick column, a packed mud band at the top and a mud-brick wall pot

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** The accent wood's trapdoor if the palette has one (spruce here), else the main wood's. */
function accentTrapdoor(bp) {
  const a = bp.p.accentSlab;
  return typeof a === 'string' && a.endsWith('_slab') ? a.replace(/_slab$/, '_trapdoor') : bp.p.trapdoor;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // the packed mud lintel: across the opening and a cell either side
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.stoneTrim);
  // shutters: open trapdoors folded flat against the jambs, outside
  const td = accentTrapdoor(bp);
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) {
      bp.set(at.x + ax * i + out.dx, y, at.z + az * i + out.dz, td, { facing: at.facing, open: 'true', half: 'bottom' });
    }
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
  // a hood of roof slabs over the step, hung off the lintel (headroom: two cells above the step)
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, p.roofSlab, { type: 'top' });
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const out = bp.kit.DIR[at.facing];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.set(at.x, at.y + 2, at.z, p.fence);
  bp.set(at.x, at.y + 3, at.z, p.fence);
  // the arm, and the lantern hanging from it
  bp.set(at.x + out.dx, at.y + 3, at.z + out.dz, p.fence);
  bp.lantern(at.x + out.dx, at.y + 2, at.z + out.dz, true, p.light);
}

export function roof_trim(bp, at, opts = {}) {
  const p = bp.p;
  const n = at.length ?? 1;
  const every = opts.every ?? 3;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const axis = ax !== 0 ? 'x' : 'z';
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    const bracket = i === 0 || i === n - 1 || i % every === 0;
    if (bracket) bp.set(x, at.y - 1, z, p.frame, axisProps(bp, p.frame, axis));
    else bp.set(x, at.y - 1, z, p.accentSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.stone);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
