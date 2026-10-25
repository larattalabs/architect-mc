// Component library (parts) of the built-in Style `japanese`: drafted by U5's "Add parts…" (bible.parts) on bib_japanese_parts (from japanese v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Japanese (parts)`: birch framing, paper-white walls, dark oak accents and deepslate
// tile roofs on mossy stone (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         shoji panes between frame posts, an accent beam above, a small tile hood over it, an accent sill
//   door_surround  frame posts either side of the door, an accent beam above, a tile hood outside, a foundation step
//   lantern_post   a stone toro: foundation base, stone wall shaft, trim platform, the lantern on top
//   roof_trim      accent slabs under the eave and a roof slab flaring the eave edge out
//   chimney        a slim trim column on a foundation foot, a stone wall vent and a roof tile cap

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
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.accentSlab, { type: 'top' });
  }
  // frame posts either side of the opening
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.frame, axisProps(bp, p.frame, 'y'));
  }
  // the beam over the opening and its posts, and a small tile hood outside it leaning on the wall
  for (let i = lo - 1; i <= lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    bp.set(x, at.y + h, z, p.accentPlanks);
    bp.stairs(x + out.dx, at.y + h, z + out.dz, bp.kit.OPPOSITE[at.facing], { block: p.roofStairs });
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) {
    const x = at.x + ax * s;
    const z = at.z + az * s;
    bp.set(x, at.y + 2, z, p.accentPlanks);
    // a tile hood over the doorway, above head height
    bp.stairs(x + out.dx, at.y + 2, z + out.dz, bp.kit.OPPOSITE[at.facing], { block: p.roofStairs });
  }
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.stoneSlab, { type: 'top' });
  bp.lantern(at.x, at.y + 2, at.z, false, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const out = bp.kit.DIR[at.facing];
  const [ax, az] = out.dx === 0 ? [1, 0] : [0, 1];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (!bp.get(x, at.y - 1, z)) bp.set(x, at.y - 1, z, p.accentSlab, { type: 'top' });
    // the eave edge flared one cell further out
    if (bp.get(x, at.y, z) && !bp.get(x + out.dx, at.y, z + out.dz)) bp.set(x + out.dx, at.y, z + out.dz, p.roofSlab, { type: 'bottom' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.set(at.x, at.y, at.z, p.foundation);
  if (top - 1 > at.y) bp.fill([at.x, at.y + 1, at.z, at.x, top, at.z], p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
  bp.set(at.x, top + 2, at.z, p.roofSlab, { type: 'bottom' });
}
