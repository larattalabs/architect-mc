// Component library (parts) of the built-in Style `dark`: drafted by U5's "Add parts…" (bible.parts) on bib_dark_parts (from dark v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Dark (parts)`: dark oak on deepslate bricks under deepslate tiles, calcite as the
// pale contrast, polished deepslate for the trim, spruce for the warm accent line (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in a calcite reveal, a polished deepslate lintel above, a deepslate brick sill outside
//   door_surround  dark oak log posts, a polished deepslate lintel, a calcite tympanum and a deepslate brick step
//   lantern_post   a deepslate brick wall base, a dark oak fence shaft, a deepslate cap and a lantern hung from an arm
//   roof_trim      spruce top slabs under the eave with an upside-down spruce corbel every third cell
//   chimney        a deepslate brick stack banded and capped with polished deepslate, a brick-wall flue on top

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
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // the calcite reveal either side of the opening
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.plaster);
  }
  // the lintel: polished deepslate across the opening and its reveal
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.stoneTrim);
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
  // a calcite tympanum over the lintel, flanked by the frame
  bp.set(at.x, at.y + 3, at.z, p.plaster);
  // a deepslate brick step outside, climbing towards the door
  bp.stairs(at.x + out.dx, at.y - 1, at.z + out.dz, inward, { block: p.stoneStairs });
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const out = bp.kit.DIR[at.facing];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.set(at.x, at.y + 2, at.z, p.fence);
  bp.set(at.x, at.y + 3, at.z, p.stoneTrim);
  bp.set(at.x, at.y + 4, at.z, p.roofSlab, { type: 'bottom' });
  // an arm out from the cap with the lantern hung under it
  bp.set(at.x + out.dx, at.y + 3, at.z + out.dz, p.fence);
  bp.lantern(at.x + out.dx, at.y + 2, at.z + out.dz, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const inward = bp.kit.OPPOSITE[at.facing];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    if (i % 3 === 0) bp.stairs(x, at.y - 1, z, inward, { block: p.accentStairs, half: 'top' });
    else bp.set(x, at.y - 1, z, p.accentSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.stone);
  // a polished deepslate band every storey
  for (let y = at.y + 4; y < top - 1; y += 4) bp.set(at.x, y, at.z, p.stoneTrim);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
