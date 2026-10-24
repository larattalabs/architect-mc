// Component library (parts) of the built-in Style `modern`: drafted by U5's "Add parts…" (bible.parts) on bib_modern_parts (from modern v1),
// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.
// Component library of the bible `Modern (parts)`: white concrete and smooth quartz, glass-heavy, under flat roofs
// (lib/components.mjs has the rules). Crisp quartz frames, dark polished deepslate brows and canopies, sea lantern light.
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         panes over the opening in a flush trim (quartz) frame, a thin roof-slab brow outside above it,
//                  a foundation-slab sill outside below it
//   door_surround  trim posts either side of the door, a trim lintel, a roof-slab canopy outside with a light set in
//                  its middle, a foundation doorstep
//   lantern_post   a slim bollard: two stone walls (or the accent fence) on a foundation block, a light cube, a roof-slab cap
//   roof_trim      a foundation-slab soffit line under the eave with a light set in it every fourth cell
//   chimney        a flue of wall_alt with a trim band and a roof-slab cap

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 2;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo - 1; i <= lo + w; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    const side = i < lo || i >= lo + w;
    // the frame: trim jambs either side, a trim head and a trim foot across, flush with the wall
    for (let y = at.y; y < at.y + h; y++) bp.set(x, y, z, side ? p.stoneTrim : p.pane);
    bp.set(x, at.y + h, z, p.stoneTrim);
    bp.set(x, at.y - 1, z, p.stoneTrim);
    // a thin dark brow outside over the head, a white sill outside under the foot
    bp.set(x + out.dx, at.y + h, z + out.dz, p.roofSlab, { type: 'bottom' });
    if (!side) bp.set(x + out.dx, at.y - 1, z + out.dz, p.stoneSlab, { type: 'top' });
  }
}

export function door_surround(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(at.x + ax * s, y, at.z + az * s, p.stoneTrim);
  for (let s = -1; s <= 1; s++) {
    bp.set(at.x + ax * s, at.y + 2, at.z + az * s, p.stoneTrim);
    // the canopy: a dark slab over the step, a light set in its middle as a downlight
    const x = at.x + ax * s + out.dx;
    const z = at.z + az * s + out.dz;
    if (s === 0) bp.set(x, at.y + 2, z, p.light);
    else bp.set(x, at.y + 2, z, p.roofSlab, { type: 'top' });
  }
  // a doorstep, level with the floor, outside the door
  bp.set(at.x + out.dx, at.y - 1, at.z + out.dz, p.foundation);
}

export function lantern_post(bp, at) {
  const p = bp.p;
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  bp.set(at.x, at.y, at.z, p.stoneWall);
  bp.set(at.x, at.y + 1, at.z, p.stoneWall);
  bp.set(at.x, at.y + 2, at.z, p.light);
  bp.set(at.x, at.y + 3, at.z, p.roofSlab, { type: 'bottom' });
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
    if (i % 4 === 2 && i < n - 1) bp.set(x, at.y - 1, z, p.light);
    else bp.set(x, at.y - 1, z, p.stoneSlab, { type: 'top' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.plaster);
  bp.set(at.x, top, at.z, p.stoneTrim);
  bp.set(at.x, top + 1, at.z, p.roofSlab, { type: 'bottom' });
}
