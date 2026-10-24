// Component library (parts) of the built-in Style `fantasy`: drafted by U5's "Add parts…" (bible.parts) on bib_fantasy_parts (from fantasy v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Fantasy (parts)`: warped wood and purpur under crimson roofs, lit by shroomlights;
// tall, curving roofs and odd turrets (lib/components.mjs has the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in calcite jambs under a purpur arch (chamfered stair corners, a pillar keystone), a crimson sill
//   door_surround  warped stem posts, a purpur arch with a shroomlight keystone under a pillar point, a purpur step
//   lantern_post   a warped fence post on a purpur block carrying a shroomlight under a crimson mushroom cap
//   roof_trim      a purpur band under the eave with the eave's ends curling up in crimson stairs
//   chimney        a purpur turret column with a calcite band, a corbelled purpur crown and a crimson witch-hat cap

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** Set a cell only if nothing is there yet (caps and trims never overwrite the building). */
function put(bp, x, y, z, block, props) {
  if (!bp.get(x, y, z)) bp.set(x, y, z, block, props);
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
    // the head: a purpur pillar course over the opening (the keystone)
    bp.set(x, at.y + h, z, p.stoneTrim, axisProps(bp, p.stoneTrim, axis));
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.accentSlab, { type: 'top' });
  }
  // calcite jambs either side, and the arch's corners: upside-down purpur stairs chamfering the head
  for (const [i, side] of [[lo - 1, bp.kit.CCW[at.facing]], [hi + 1, bp.kit.CW[at.facing]]]) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.plaster);
    bp.set(x, at.y + h, z, p.stoneStairs, { facing: side, half: 'top', shape: 'straight' });
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  // warped stem posts either side of the door
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  // the arch: chamfered purpur corners, a shroomlight keystone glowing over the door
  bp.set(at.x - ax, at.y + 2, at.z - az, p.stoneStairs, { facing: bp.kit.CCW[at.facing], half: 'top', shape: 'straight' });
  bp.set(at.x + ax, at.y + 2, at.z + az, p.stoneStairs, { facing: bp.kit.CW[at.facing], half: 'top', shape: 'straight' });
  bp.lantern(at.x, at.y + 2, at.z, false, p.light);
  // the arch's point: a purpur pillar over the keystone
  bp.set(at.x, at.y + 3, at.z, p.stoneTrim, axisProps(bp, p.stoneTrim, 'y'));
  // a purpur doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.fence);
  bp.set(at.x, at.y + 1, at.z, p.fence);
  bp.lantern(at.x, at.y + 2, at.z, false, p.light);
  // the mushroom cap: a crimson crown over the light with a brim of slabs round it
  const y = at.y + 3;
  bp.set(at.x, y, at.z, p.roofBlock);
  for (const f of ['north', 'south', 'east', 'west']) {
    const d = bp.kit.DIR[f];
    put(bp, at.x + d.dx, y, at.z + d.dz, p.roofSlab, { type: 'bottom' });
  }
  bp.set(at.x, y + 1, at.z, p.roofSlab, { type: 'bottom' });
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  // a purpur band under the eave, unless something (a door's hood, a post) is already there
  for (let i = 0; i < n; i++) put(bp, at.x + ax * i, at.y - 1, at.z + az * i, p.stoneSlab, { type: 'top' });
  // the curl: the eave's two ends kick up in crimson stairs, their backs to the outside
  if (n < 3) return;
  const fwd = ax !== 0 ? 'east' : 'south';
  const back = bp.kit.OPPOSITE[fwd];
  put(bp, at.x, at.y + 1, at.z, p.roofStairs, { facing: back, half: 'bottom', shape: 'straight' });
  put(bp, at.x + ax * (n - 1), at.y + 1, at.z + az * (n - 1), p.roofStairs, { facing: fwd, half: 'bottom', shape: 'straight' });
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  // the turret column, purpur with a calcite band under the crown
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.stone);
  if (top - 2 > at.y) bp.set(at.x, top - 2, at.z, p.plaster);
  // the crown: a purpur pillar corbelled out with upside-down stairs
  bp.set(at.x, top, at.z, p.stoneTrim, axisProps(bp, p.stoneTrim, 'y'));
  for (const f of ['north', 'south', 'east', 'west']) {
    const d = bp.kit.DIR[f];
    put(bp, at.x + d.dx, top, at.z + d.dz, p.stoneStairs, { facing: bp.kit.OPPOSITE[f], half: 'top', shape: 'straight' });
  }
  // the witch-hat cap: crimson stairs round a crimson core, a slab tip
  bp.set(at.x, top + 1, at.z, p.roofBlock);
  for (const f of ['north', 'south', 'east', 'west']) {
    const d = bp.kit.DIR[f];
    put(bp, at.x + d.dx, top + 1, at.z + d.dz, p.roofStairs, { facing: bp.kit.OPPOSITE[f], half: 'bottom', shape: 'straight' });
  }
  bp.set(at.x, top + 2, at.z, p.roofSlab, { type: 'bottom' });
}
