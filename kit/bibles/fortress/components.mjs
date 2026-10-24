// Component library (parts) of the built-in Style `fortress`: drafted by U5's "Add parts…" (bible.parts) on bib_fortress_parts (from fortress v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Fortress (parts)`: stone bricks and spruce under deepslate tiles (lib/components.mjs
// has the rules). Stone-brick jambs and posts, polished-andesite lintels, sills and corbels, deepslate caps.
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes in a stone-brick surround, a trim lintel above, a trim corbel sill outside below it
//   door_surround  stone-brick posts either side of the door, a trim lintel over a stone hood, a doorstep outside
//   lantern_post   a stone-brick plinth, a stone wall shaft and a lantern on top
//   roof_trim      a trim slab cornice under the eave with a full trim corbel every third cell
//   chimney        a stone-brick column with a trim band and a roof-slab cap

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A shape (slab, stairs) of the trim role, e.g. polished_andesite -> polished_andesite_slab. */
function trimShape(bp, shape) {
  const t = String(bp.p.roles?.trim ?? bp.p.stoneTrim);
  const base = t.replace(/(brick|tile|plank)s$/, '$1');
  return `${base}_${shape}`;
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, p.pane);
    // the sill outside, under the opening: an upside-down trim stair against the wall
    bp.set(x + out.dx, at.y - 1, z + out.dz, trimShape(bp, 'stairs'), { facing: inward, half: 'top' });
  }
  // the stone jambs either side of the opening, in the wall plane
  for (const i of [lo - 1, lo + w]) for (let y = at.y; y < at.y + h; y++) bp.set(at.x + ax * i, y, at.z + az * i, p.foundation);
  // the lintel: trim across the opening and the jambs
  for (let i = lo - 1; i <= lo + w; i++) bp.set(at.x + ax * i, at.y + h, at.z + az * i, p.stoneTrim);
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const inward = bp.kit.OPPOSITE[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.foundation);
  for (let s = -1; s <= 1; s++) {
    bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
    // a stone hood over the doorway, outside, above head height
    bp.set(at.x + ax * s + out.dx, at.y + 2, at.z + az * s + out.dz, p.stoneStairs, { facing: inward, half: 'top' });
  }
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.stoneTrim);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.foundation);
  bp.set(at.x, at.y + 1, at.z, p.stoneWall);
  bp.set(at.x, at.y + 2, at.z, p.stoneWall);
  bp.lantern(at.x, at.y + 3, at.z, false, p.light);
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
    const corbel = i % 3 === 0 || i === n - 1;
    if (corbel) bp.set(x, at.y - 1, z, p.stoneTrim);
    else bp.set(x, at.y - 1, z, trimShape(bp, 'slab'), { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 2, at.z], p.foundation);
  bp.set(at.x, top - 1, at.z, p.stoneTrim);
  bp.set(at.x, top, at.z, p.foundation);
  bp.set(at.x, top + 1, at.z, p.roofSlab, { type: 'bottom' });
}
