// Component library (parts) of the built-in Style `medieval`: drafted by U5's "Add parts…" (bible.parts) on bib_medieval_parts (from medieval v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Medieval (parts)`: dark oak timber framing with pale daub walls and steep spruce
// roofs (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in a timber frame (posts, a sill beam, a lintel beam), open accent shutters either side,
//                  an accent ledge outside under the sill
//   door_surround  frame posts either side of the door up to a frame lintel, a small accent-roof hood over it,
//                  a foundation doorstep outside
//   lantern_post   a frame post on a foundation block, a fence arm at the top with a lantern hanging from it
//   roof_trim      a frame beam under the eave, carried by upside-down accent brackets against the wall every few cells
//   chimney        a foundation-stone stack banded with trim near the top, capped by a slab

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** The accent wood's stairs (spruce in this bible), falling back to the palette stairs. */
function accentStairs(bp) {
  return bp.p.accentStairs ?? bp.p.stairs;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const axis = ax !== 0 ? 'x' : 'z';
  const lo = -Math.floor((w - 1) / 2);
  const hi = lo + w - 1;
  for (let i = lo; i <= hi; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the ledge outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.accentSlab, { type: 'top' });
  }
  // the timber frame: a sill beam and a lintel beam across the opening, posts either side
  for (let i = lo - 1; i <= hi + 1; i++) {
    bp.set(at.x + ax * i, at.y - 1, at.z + az * i, p.frame, axisProps(bp, p.frame, axis));
    bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.frame, axisProps(bp, p.frame, axis));
  }
  for (const i of [lo - 1, hi + 1]) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) {
      bp.set(x, y, z, p.frame, axisProps(bp, p.frame, 'y'));
      // an open shutter folded back against the post
      bp.set(x + out.dx, y, z + out.dz, p.trapdoor, { facing: at.facing, half: 'bottom', open: 'true' });
    }
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  const axis = ax !== 0 ? 'x' : 'z';
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.frame, axisProps(bp, p.frame, axis));
  // a little hood of accent stairs over the door, sloping out from the lintel
  for (let s = -1; s <= 1; s++) bp.stairs(at.x + ax * s + out.dx, at.y + 3, at.z + az * s + out.dz, back, { block: accentStairs(bp) });
  // brackets under the hood ends
  for (const s of [-1, 1]) bp.stairs(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, back, { block: accentStairs(bp), half: 'top' });
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const out = bp.kit.DIR[at.facing ?? 'south'];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  for (let y = at.y; y <= at.y + 3; y++) bp.set(at.x, y, at.z, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 4, at.z, p.accentSlab, { type: 'bottom' });
  // the arm, with the lantern hanging well above head height
  bp.set(at.x + out.dx, at.y + 3, at.z + out.dz, p.fence);
  bp.lantern(at.x + out.dx, at.y + 2, at.z + out.dz, true, p.light);
}

export function roof_trim(bp, at, opts = {}) {
  const p = bp.p;
  const n = at.length ?? 1;
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  const [ax, az] = out.dx === 0 ? [1, 0] : [0, 1];
  const axis = ax !== 0 ? 'x' : 'z';
  const every = opts.every ?? 3;
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // the beam under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    bp.set(x, at.y - 1, z, p.frame, axisProps(bp, p.frame, axis));
    // a bracket against the wall below the beam, at the ends and every few cells
    const bracket = i === 0 || i === n - 1 || i % every === 0;
    if (bracket && !bp.get(x, at.y - 2, z) && bp.get(x - out.dx, at.y - 2, z - out.dz)) {
      bp.stairs(x, at.y - 2, z, back, { block: accentStairs(bp), half: 'top' });
    }
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.foundation);
  bp.set(at.x, top - 2, at.z, p.stoneTrim);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneSlab, { type: 'bottom' });
}
