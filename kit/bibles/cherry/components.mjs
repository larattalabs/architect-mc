// Component library (parts) of the built-in Style `cherry`: drafted by U5's "Add parts…" (bible.parts) on bib_cherry_parts (from cherry v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Cherry (parts)`: cherry wood on polished tuff under a dark oak roof (lib/components.mjs
// has the rules). No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components
// re-skin under any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes framed by cherry log jambs, a dark oak lintel with a little stair hood outside, a tuff slab sill
//   door_surround  cherry log posts, a dark oak lintel, a dark oak stair canopy over the door, a tuff brick doorstep
//   lantern_post   a polished tuff plinth and wall base, a cherry fence post with a bracket arm, a hanging lantern
//   roof_trim      a row of top cherry slabs under the dark eave, a cherry log bracket every third cell (window rhythm)
//   chimney        a polished tuff column on a tuff brick foot, a tuff brick cap and a tuff wall pot

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  const axis = ax !== 0 ? 'x' : 'z';
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // cherry log jambs either side of the opening
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.frame, axisProps(bp, p.frame, 'y'));
  }
  // the lintel: dark oak across the opening and the jambs, with a small stair hood outside over the panes
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.accentPlanks);
  for (let i = lo; i < lo + w; i++) {
    bp.stairs(at.x + ax * i + out.dx, at.y + h, at.z + az * i + out.dz, back, { block: p.accentStairs, half: 'top' });
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  // the lintel: log ends over the posts, dark oak over the door
  for (const s of [-1, 1]) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.frame, axisProps(bp, p.frame, ax !== 0 ? 'x' : 'z'));
  bp.set(at.x, at.y + 2, at.z, p.accentPlanks);
  // a little dark oak canopy outside, above head height, echoing the roof
  for (let s = -1; s <= 1; s++) bp.stairs(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, back, { block: p.accentStairs });
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.stoneTrim);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.set(at.x, at.y + 2, at.z, p.fence);
  bp.set(at.x, at.y + 3, at.z, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 4, at.z, p.accentSlab, { type: 'bottom' });
  // a bracket arm to one side with the lantern hanging under it
  bp.set(at.x + ax, at.y + 3, at.z + az, p.fence);
  bp.lantern(at.x + ax, at.y + 2, at.z + az, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    // a cherry log bracket at the ends and every third cell, cherry top slabs between
    if (i % 3 === 0 || i === n - 1) bp.set(x, at.y - 1, z, p.frame, axisProps(bp, p.frame, 'y'));
    else bp.set(x, at.y - 1, z, p.slab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.set(at.x, at.y, at.z, p.stoneTrim);
  bp.fill([at.x, at.y + 1, at.z, at.x, top - 1, at.z], p.stone);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
