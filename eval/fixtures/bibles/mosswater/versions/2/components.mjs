// Component library of the bible `Mosswater Stilts` (lib/components.mjs has the rules): calm spruce plank boxes on
// mangrove stilts, single shuttered panes, lanterns hung from fence arms, thin dark oak eaves. Moss and vines stay at
// the waterline; the crookedness belongs to the roof, so every part here is straight and symmetric.
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         a single pane, a wall-wood trapdoor shutter open on each side, a wall-wood slab sill
//   door_surround  a trim-log lintel over the door, a top-slab threshold and a slab step down, a fence-arm lantern
//   lantern_post   a fence post on a foundation cap with a fence arm and a hanging lantern
//   roof_trim      an upside-down roof-stair fascia under the eave, unbroken
//   chimney        a foundation-stone column one block wide, straight up past the ridge, a campfire on top
//   stilt_pile     a frame log on a foundation cap, moss carpet on the cap's footing, a vine on the lowest log
//   boardwalk      a 2-wide floor-wood slab walk on frame posts over foundation caps, a fence rail on one side,
//                  a lantern on a fence arm at the far end
//   net_loft       a framed shelf under the eave: a fence rail, a net hung from it, a slab shelf with a barrel

export const meta = {
  stilt_pile: { slot: 'ground', label: 'stilt pile' },
  boardwalk: { slot: 'ground', label: 'boardwalk' },
  net_loft: { slot: 'roof', label: 'net loft' },
};

/** The horizontal step along a wall that faces `facing` (to the right, seen from outside). */
function along(bp, facing) {
  const r = bp.kit.DIR[bp.kit.CW[facing]];
  return [r.dx, r.dz];
}

/** A log-like block standing along an axis, if the block has one. */
function axisProps(bp, block, axis) {
  return /_(log|stem|wood|hyphae)$|basalt|_pillar$|bamboo_block|hay_block|bone_block/.test(block) ? { axis } : {};
}

/** A part (slab, trapdoor) of the plank wood of the floor or walls, else the frame wood's. */
function plankPart(bp, kind) {
  const f = [bp.p.floor, bp.p.wall].find((b) => /_planks$/.test(b ?? ''));
  return f ? f.replace(/_planks$/, `_${kind}`) : bp.p[kind];
}

/** A creeper (vine, lichen) on the face of the block in direction `toward`, if the bible has a multiface creeper. */
function creep(bp, x, y, z, toward) {
  const c = bp.p.roles?.creeper;
  if (!c || !/vine|lichen/.test(c) || bp.get(x, y, z)) return;
  bp.set(x, y, z, c, { [toward]: 'true' });
}

/** A drape (moss carpet) on top of a cell, if the bible has one and the cell is free. */
function drape(bp, x, y, z) {
  const d = bp.p.roles?.drape;
  if (!d || bp.get(x, y, z)) return;
  bp.set(x, y, z, d);
}

/** A lantern hanging from a fence arm: the arm at (x, y, z), the lantern under it. */
function armLantern(bp, x, y, z) {
  bp.set(x, y, z, bp.p.fence);
  bp.lantern(x, y - 1, z, true, bp.p.light);
}

export function window(bp, at, opts = {}) {
  const p = bp.p;
  const w = at.width ?? opts.width ?? 1;
  const h = at.height ?? opts.height ?? 1;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const cell = (i, y, o = 0) => [at.x + ax * i + out.dx * o, y, at.z + az * i + out.dz * o];
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) for (let y = at.y; y < at.y + h; y++) bp.set(...cell(i, y), p.pane);
  // a thin sill outside, under the opening
  const slab = plankPart(bp, 'slab');
  for (let i = lo; i < lo + w; i++) bp.set(...cell(i, at.y - 1, 1), slab, { type: 'top' });
  // wall-wood trapdoor shutters, open flat against the wall either side
  const shutter = plankPart(bp, 'trapdoor');
  const props = { facing: at.facing, open: 'true', half: 'bottom' };
  for (let y = at.y; y < at.y + h; y++) for (const i of [lo - 1, lo + w]) bp.set(...cell(i, y, 1), shutter, props);
}

/** `lanterns`: 1 (default, a fence-arm lantern on the right of the door), 2 (one each side), 0 (none). */
export function door_surround(bp, at, opts = {}) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const cell = (i, y, o = 0) => [at.x + ax * i + out.dx * o, y, at.z + az * i + out.dz * o];
  const axis = ax !== 0 ? 'x' : 'z';
  // the lintel: a trim log over the door and a cell either side
  for (let s = -1; s <= 1; s++) bp.set(...cell(s, at.y + 2), p.stoneTrim, axisProps(bp, p.stoneTrim, axis));
  // a threshold level with the floor, then a slab step down to the boardwalk
  const slab = plankPart(bp, 'slab');
  bp.set(...cell(0, at.y - 1, 1), slab, { type: 'top' });
  if (!bp.get(...cell(0, at.y - 1, 2))) bp.set(...cell(0, at.y - 1, 2), slab, { type: 'bottom' });
  // lanterns hung from fence arms at lintel height, beside the doorway
  const n = opts.lanterns ?? (opts.lantern === false ? 0 : 1);
  if (n >= 1) armLantern(bp, ...cell(2, at.y + 2, 1));
  if (n >= 2) armLantern(bp, ...cell(-2, at.y + 2, 1));
}

export function lantern_post(bp, at) {
  const p = bp.p;
  const out = bp.kit.DIR[at.facing];
  bp.set(at.x, at.y - 1, at.z, p.foundation);
  for (let y = at.y; y <= at.y + 3; y++) bp.set(at.x, y, at.z, p.fence);
  armLantern(bp, at.x + out.dx, at.y + 3, at.z + out.dz);
}

export function roof_trim(bp, at) {
  const p = bp.p;
  const n = at.length ?? 1;
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const back = bp.kit.OPPOSITE[at.facing];
  // the fascia: upside-down roof stairs tucked under the eave, unless something (a door's headroom, a post) is there
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    if (!bp.get(x, at.y - 1, z)) bp.set(x, at.y - 1, z, p.roofStairs, { facing: back, half: 'top', shape: 'straight' });
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  // one block wide, straight up to `top`, a lit campfire as the cap
  bp.fill([at.x, at.y, at.z, at.x, top, at.z], p.foundation);
  bp.set(at.x, top + 1, at.z, 'minecraft:campfire', { lit: 'true', signal_fire: 'false', facing: at.facing });
}

/**
 * A stilt: a foundation cap on the mud at `at`, a frame log `height` cells (default 3) above it (or up to `at.top`).
 * The cap has a footing cell on the `facing` side carrying moss carpet; a vine climbs the lowest log.
 */
export function stilt_pile(bp, at, opts = {}) {
  const p = bp.p;
  const h = opts.height ?? (at.top != null ? at.top - at.y : 3);
  const out = bp.kit.DIR[at.facing];
  const [ax, az] = along(bp, at.facing);
  bp.set(at.x, at.y, at.z, p.foundation);
  bp.set(at.x + out.dx, at.y, at.z + out.dz, p.foundation);
  bp.fill([at.x, at.y + 1, at.z, at.x, at.y + h, at.z], p.frame, axisProps(bp, p.frame, 'y'));
  drape(bp, at.x + out.dx, at.y + 1, at.z + out.dz);
  // a vine on the lowest log, on its right side
  creep(bp, at.x + ax, at.y + 1, at.z + az, bp.kit.CCW[at.facing]);
}

/**
 * A boardwalk running `length` cells (default 6) from `at` to the right (seen from the `facing` side), 2 wide toward
 * `facing`, its top-slab deck `height` cells (default 2) above the ground on frame posts over foundation caps; a fence
 * rail on one side only (`rail`: 'out' (default, the `facing` side) | 'in'), a lantern on a fence arm off the far end
 * (`lantern: false` to leave it dark).
 */
export function boardwalk(bp, at, opts = {}) {
  const p = bp.p;
  const n = Math.max(2, opts.length ?? at.length ?? 6);
  const h = Math.max(2, opts.height ?? 2);
  const f = bp.kit.DIR[at.facing];
  const [ax, az] = along(bp, at.facing);
  const railS = opts.rail === 'in' ? -1 : 2;
  const cell = (i, s, y) => [at.x + ax * i + f.dx * s, y, at.z + az * i + f.dz * s];
  const deck = at.y + h;
  const slab = plankPart(bp, 'slab');
  for (let i = 0; i < n; i++) for (const s of [0, 1]) bp.set(...cell(i, s, deck), slab, { type: 'top' });
  const post = (i, s, y1) => {
    bp.set(...cell(i, s, at.y), p.foundation);
    if (y1 > at.y) bp.fill([...cell(i, s, at.y + 1), ...cell(i, s, y1)], p.frame, axisProps(bp, p.frame, 'y'));
  };
  const mid = Math.floor((n - 1) / 2);
  for (const i of [0, n - 1]) post(i, railS < 0 ? 1 : 0, deck - 1);
  // rail posts beside the deck carry a fence rail along the whole walk
  const railPosts = n > 4 ? [0, mid, n - 1] : [0, n - 1];
  for (const i of new Set(railPosts)) post(i, railS, deck);
  for (let i = 0; i < n; i++) bp.set(...cell(i, railS, deck + 1), p.fence);
  // the pier-end lantern on a fence arm out past the end
  if (opts.lantern !== false) {
    bp.set(...cell(n - 1, railS, deck + 2), p.fence);
    armLantern(bp, ...cell(n, railS, deck + 2));
  }
}

/**
 * A net loft under an eave (roof slot, at most one per building): `width` cells (default 3) starting `offset` cells
 * (default 1) along the edge: a fence rail under the eave, a net hung from it, a slab shelf below with a barrel at one
 * end and a fence upright at the other.
 */
export function net_loft(bp, at, opts = {}) {
  const n = at.length ?? 4;
  const w = Math.max(3, Math.min(opts.width ?? 3, n));
  const off = Math.max(0, Math.min(opts.offset ?? 1, n - w));
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const cell = (i, y) => [at.x + ax * (off + i), y, at.z + az * (off + i)];
  const fence = bp.p.fence;
  for (let i = 0; i < w; i++) {
    if (!bp.get(...cell(i, at.y - 1))) bp.set(...cell(i, at.y - 1), fence);
    bp.set(...cell(i, at.y - 3), plankPart(bp, 'slab'), { type: 'top' });
  }
  bp.set(...cell(0, at.y - 2), fence);
  for (let i = 1; i < w - 1; i++) bp.set(...cell(i, at.y - 2), 'minecraft:cobweb');
  bp.set(...cell(w - 1, at.y - 2), 'minecraft:barrel', { facing: 'up' });
}
