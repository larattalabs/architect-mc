// Component library (parts) of the built-in Style `crimson`: drafted by U5's "Add parts…" (bible.parts) on bib_crimson_parts (from crimson v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Crimson (parts)`: crimson stems on blackstone under a nether brick roof
// (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes framed by stem jambs, a blackstone lintel with a nether brick hood, a blackstone sill
//   door_surround  stem posts and a blackstone lintel, a nether brick hood with a lantern hung under each end,
//                  a blackstone brick threshold
//   lantern_post   a blackstone brick plinth and wall, a crimson fence post, a blackstone head with two arms, a lantern
//                  hanging from each, a nether brick cap
//   roof_trim      a blackstone brick band of top slabs under the eave, a corbel (upside-down stairs) every rhythm step
//   chimney        a blackstone brick shaft banded with polished blackstone every storey, a nether brick cap

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
  // stem jambs either side of the opening, in the wall plane
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.frame, axisProps(bp, p.frame, 'y'));
  }
  // the lintel across the jambs, and a nether brick hood on it outside
  for (let i = lo - 1; i <= lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    bp.set(x, at.y + h, z, p.stoneTrim);
    bp.set(x + out.dx, at.y + h, z + out.dz, p.roofSlab, { type: 'bottom' });
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  // stem posts either side, a blackstone lintel over the door
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 2; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 2, at.z, p.stoneTrim);
  for (let s = -1; s <= 1; s++) {
    const x = at.x + ax * s + out.dx;
    const z = at.z + az * s + out.dz;
    // a nether brick hood above head height, sloping out from the wall
    bp.stairs(x, at.y + 2, z, inward, { block: p.roofStairs, half: 'bottom' });
    // the threshold, level with the floor
    bp.set(x, at.y - 1, z, p.stone);
  }
  // a lantern hung under each end of the hood, clear of the doorway
  for (const s of [-1, 1]) bp.lantern(at.x + ax * s + out.dx, at.y + 1, at.z + az * s + out.dz, true, p.light);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.set(at.x, at.y + 2, at.z, p.fence);
  bp.set(at.x, at.y + 3, at.z, p.stoneTrim);
  bp.set(at.x, at.y + 4, at.z, p.roofSlab, { type: 'bottom' });
  // two fence arms off the head, a lantern hanging from each
  for (const s of [-1, 1]) {
    bp.set(at.x + ax * s, at.y + 3, at.z + az * s, p.fence);
    bp.lantern(at.x + ax * s, at.y + 2, at.z + az * s, true, p.light);
  }
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const rhythm = 3; // the bible's window rhythm
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const inward = bp.kit.OPPOSITE[at.facing];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's hood, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    // a corbel at each end and every rhythm step, a band of top slabs between
    if (i === 0 || i === n - 1 || i % rhythm === 0) bp.stairs(x, at.y - 1, z, inward, { block: p.stoneStairs, half: 'top' });
    else bp.set(x, at.y - 1, z, p.stoneSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  // the shaft, banded with the trim every storey
  for (let y = at.y; y < top; y++) bp.set(at.x, y, at.z, (y - at.y) % 4 === 3 ? p.stoneTrim : p.stone);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.roofSlab, { type: 'bottom' });
}
