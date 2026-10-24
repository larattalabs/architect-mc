// Component library (parts) of the built-in Style `brick`: drafted by U5's "Add parts…" (bible.parts) on bib_brick_parts (from brick v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Brick (parts)`: brick and oak with deepslate trim and a tiled roof (rules in
// kit/lib/components.mjs).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in a brick surround (jambs where the wall is plain), a deepslate trim lintel, a brick sill
//   door_surround  brick jambs either side of the door, a trim lintel, a tiled hood over it, a trim doorstep
//   lantern_post   a brick plinth, an oak post with an arm and a hanging lantern, a dark oak cap
//   roof_trim      dark oak top slabs under the eave with an upside-down dark oak corbel every third cell
//   chimney        a brick stack with a corbelled brick collar and a deepslate trim cap

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** Brick over a plain wall cell only: corner posts, frames and openings stay as they are. */
function brickIfWall(bp, x, y, z) {
  if (bp.nameAt(x, y, z) === bp.p.wall) bp.set(x, y, z, bp.p.foundation);
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
    // the brick sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // brick jambs either side of the opening and under it
  for (const i of [lo - 1, lo + w]) for (let y = at.y; y < at.y + h; y++) brickIfWall(bp, at.x + ax * i, y, at.z + az * i);
  for (let i = lo; i < lo + w; i++) brickIfWall(bp, at.x + ax * i, at.y - 1, at.z + az * i);
  // the lintel: deepslate trim across the opening and a cell either side
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.stoneTrim);
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.foundation);
  for (let s = -1; s <= 1; s++) {
    bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
    // a tiled hood over the door, on the lintel's face, above head height
    const hx = at.x + ax * s + out.dx;
    const hz = at.z + az * s + out.dz;
    if (!bp.get(hx, at.y + 2, hz)) bp.set(hx, at.y + 2, hz, p.roofSlab, { type: 'top' });
  }
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.stoneTrim);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.foundation);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.set(at.x, at.y + 2, at.z, p.fence);
  bp.set(at.x, at.y + 3, at.z, p.fence);
  bp.set(at.x, at.y + 4, at.z, p.accentSlab, { type: 'bottom' });
  // the arm: a fence rail off the post, the lantern hanging under it
  bp.set(at.x + ax, at.y + 3, at.z + az, p.fence);
  bp.lantern(at.x + ax, at.y + 2, at.z + az, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const back = bp.kit.OPPOSITE[at.facing];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    if (i % 3 === 1) bp.set(x, at.y - 1, z, p.accentStairs, { facing: back, half: 'top', shape: 'straight' });
    else bp.set(x, at.y - 1, z, p.accentSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top, at.z], p.stone);
  // a corbelled collar under the cap on the three free sides (not into the wall behind)
  const back = bp.kit.OPPOSITE[at.facing];
  for (const d of ['north', 'south', 'east', 'west']) {
    if (d === back) continue;
    const o = bp.kit.DIR[d];
    if (!bp.get(at.x + o.dx, top, at.z + o.dz)) bp.set(at.x + o.dx, top, at.z + o.dz, p.stoneStairs, { facing: bp.kit.OPPOSITE[d], half: 'top', shape: 'straight' });
  }
  bp.set(at.x, top + 1, at.z, p.stoneTrim);
}
