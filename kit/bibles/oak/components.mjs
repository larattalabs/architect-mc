// Component library (parts) of the built-in Style `oak`: drafted by U5's "Add parts…" (bible.parts) on bib_oak_parts (from oak v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Oak (parts)`: oak walls on stone bricks under a spruce roof (lib/components.mjs has
// the rules).
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in an oak log frame (lintel above), open spruce shutters either side, a smooth stone sill
//   door_surround  oak log posts and lintel round the door, a small spruce stair hood above, a stone brick doorstep
//   lantern_post   an oak log post on a stone brick base, a spruce cap, a fence arm with a hanging lantern
//   roof_trim      upside-down spruce stairs under the eave (a stepped cornice), oak log brackets at the ends
//   chimney        a stone brick column with a smooth stone band and cap, a stone brick wall pot on top

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** The accent wood's trapdoor (spruce shutters under this bible), else the main wood's. */
function accentTrapdoor(bp) {
  const a = bp.p.roles?.accent ?? '';
  return /_planks$/.test(a) ? a.replace(/_planks$/, '_trapdoor') : bp.p.trapdoor;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  const axis = ax !== 0 ? 'x' : 'z';
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening
    bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
  // the oak frame: log jambs either side in the wall, a log lintel across the top
  for (const i of [lo - 1, lo + w]) {
    for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.frame, axisProps(bp, p.frame, 'y'));
  }
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.frame, axisProps(bp, p.frame, axis));
  // open spruce shutters flat against the jambs, outside
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
  const axis = ax !== 0 ? 'x' : 'z';
  // oak log posts either side and a log lintel across
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.frame, axisProps(bp, p.frame, 'y'));
  for (let s = -1; s <= 1; s++) bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.frame, axisProps(bp, p.frame, axis));
  // a small spruce hood over the door: stairs stepping down away from the wall, above the lintel
  for (let s = -1; s <= 1; s++) {
    const x = at.x + ax * s + out.dx;
    const z = at.z + az * s + out.dz;
    if (!bp.get(x, at.y + 2, z)) bp.stairs(x, at.y + 2, z, bp.kit.OPPOSITE[at.facing], { block: p.accentStairs });
  }
  // a doorstep of the plinth stone, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  for (let y = at.y + 1; y <= at.y + 2; y++) bp.set(at.x, y, at.z, p.frame, axisProps(bp, p.frame, 'y'));
  bp.set(at.x, at.y + 3, at.z, p.accentSlab, { type: 'bottom' });
  // a fence arm to one side, the lantern hanging from it above head height
  bp.set(at.x + ax, at.y + 2, at.z + az, p.accentFence);
  bp.lantern(at.x + ax, at.y + 1, at.z + az, true, p.light);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const axis = ax !== 0 ? 'x' : 'z';
  const inward = bp.kit.OPPOSITE[at.facing];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // under the eave, unless something (a door's headroom, a post) is already there
    if (bp.get(x, at.y - 1, z)) continue;
    if (i === 0 || i === n - 1) bp.set(x, at.y - 1, z, p.frame, axisProps(bp, p.frame, axis));
    else bp.stairs(x, at.y - 1, z, inward, { block: p.accentStairs, half: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.foundation);
  // a smooth stone band a third of the way up and a cap at the top
  const band = at.y + Math.max(2, Math.floor((top - at.y) / 3));
  if (band < top - 1) bp.set(at.x, band, at.z, p.stoneTrim);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.stoneWall);
}
