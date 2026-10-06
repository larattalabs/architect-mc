// Component library of the bible `Mosswater Stilts` (lib/components.mjs has the rules): damp, leaning timber on
// mangrove stilts, dark oak trim, moss creeping up from the water, lanterns hung from fence arms.
//
// No imports: every material comes from the palette (bp.p, roles in bp.p.roles), so the same components re-skin under
// any bible; directions come from bp.kit. Each function takes (bp, at, opts) with `at` in design coordinates.
//
//   window         a small pane over the opening, a trim-log sill run long on one side, open trapdoor shutters
//                  (one missing a board), a vine strand under the left shutter
//   door_surround  frame posts, an off-centre trim-log lintel, a trim threshold and a slab step down, a fence-arm lantern
//   lantern_post   a fence post on a pile cap with a fence arm and a hanging lantern
//   roof_trim      an upside-down stair fascia under the eave (ragged gaps), moss carpet patches, a vine or two
//   chimney        a foundation-stone column that kinks one block sideways above the roof on a corbel, a campfire on top
//   stilt_pile     a frame log on a sunk foundation cap, fence cross-bracing to a second pile `span` away
//   boardwalk      a 2-wide floor-wood slab walk on frame posts that dips a slab in the middle, fence rail on one side,
//                  a lantern on a fence arm at the far end
//   net_loft       a fence rail hung under the eave with cobweb nets and a slab shelf holding a barrel
//   drying_rack    a bracketed slab shelf on the wall holding barrels, a fence rail above with a net drying on it

export const meta = {
  stilt_pile: { slot: 'ground', label: 'stilt pile' },
  boardwalk: { slot: 'ground', label: 'boardwalk' },
  net_loft: { slot: 'roof', label: 'net loft' },
  drying_rack: { slot: 'wall', label: 'drying rack' },
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

/** The slab of the floor wood (the boardwalk boards), else the frame wood's slab. */
function deckSlab(bp) {
  const f = bp.p.floor ?? '';
  return /_planks$/.test(f) ? f.replace(/_planks$/, '_slab') : bp.p.slab;
}

/** A creeper (vine, lichen) on the face of the block in direction `toward`, if the bible has a multiface creeper. */
function creep(bp, x, y, z, toward) {
  const c = bp.p.roles?.creeper;
  if (!c || !/vine|lichen/.test(c) || bp.get(x, y, z)) return;
  bp.set(x, y, z, c, { [toward]: 'true' });
}

/** A drape (moss carpet) on top of a cell, if the bible has one and the cell above is free. */
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
  const back = bp.kit.OPPOSITE[at.facing];
  const cell = (i, y, o = 0) => [at.x + ax * i + out.dx * o, y, at.z + az * i + out.dz * o];
  const axis = ax !== 0 ? 'x' : 'z';
  const lo = -Math.floor((w - 1) / 2);
  for (let i = lo; i < lo + w; i++) for (let y = at.y; y < at.y + h; y++) bp.set(...cell(i, y), p.pane);
  // the sill: a trim log in the wall under the opening, running one cell long on the right only
  for (let i = lo; i <= lo + w; i++) bp.set(...cell(i, at.y - 1), p.stoneTrim, axisProps(bp, p.stoneTrim, axis));
  // open trapdoor shutters flat on the wall either side; the right one has lost its top board
  const shutter = { facing: at.facing, open: 'true', half: 'bottom' };
  for (let y = at.y; y < at.y + h; y++) {
    bp.set(...cell(lo - 1, y, 1), p.trapdoor, shutter);
    if (h < 2 || y < at.y + h - 1) bp.set(...cell(lo + w, y, 1), p.trapdoor, shutter);
  }
  // a vine strand creeping up under the left shutter
  creep(bp, ...cell(lo - 1, at.y - 1, 1), back);
}

export function door_surround(bp, at, opts = {}) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const cell = (i, y, o = 0) => [at.x + ax * i + out.dx * o, y, at.z + az * i + out.dz * o];
  const axis = ax !== 0 ? 'x' : 'z';
  for (const s of [-1, 1]) for (let y = at.y; y <= at.y + 1; y++) bp.set(...cell(s, y), p.frame, axisProps(bp, p.frame, 'y'));
  // the lintel: a trim log, off centre (one cell longer on the right)
  for (let s = -1; s <= 2; s++) bp.set(...cell(s, at.y + 2), p.stoneTrim, axisProps(bp, p.stoneTrim, axis));
  // a trim threshold level with the floor, then a slab step down to the boardwalk
  bp.set(...cell(0, at.y - 1, 1), p.stoneTrim, axisProps(bp, p.stoneTrim, axis));
  bp.set(...cell(0, at.y - 1, 2), deckSlab(bp), { type: 'bottom' });
  // a lantern hung from a fence arm off the long end of the lintel
  if (opts.lantern !== false) armLantern(bp, ...cell(2, at.y + 2, 1));
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
  const inn = bp.kit.DIR[back];
  for (let i = 0; i < n; i++) {
    const x = at.x + ax * i;
    const z = at.z + az * i;
    // the fascia: upside-down stairs under the eave, with a ragged gap now and then
    const gap = (i * 7 + 3) % 9 === 0;
    if (!gap && !bp.get(x, at.y - 1, z)) bp.set(x, at.y - 1, z, p.roofStairs, { facing: back, half: 'top', shape: 'straight' });
    // moss carpet patches on the eave course
    if (bp.get(x, at.y, z) && (i * 5 + 2) % 7 < 3) drape(bp, x, at.y + 1, z);
    // a vine strand down the wall under the fascia
    if (!gap && (i * 5 + 2) % 7 === 0 && bp.get(x + inn.dx, at.y - 2, z + inn.dz)) creep(bp, x, at.y - 2, z, back);
  }
}

export function chimney(bp, at) {
  const p = bp.p;
  const top = at.top ?? at.y + 8;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  // straight up to just under the top, then the stack kinks one block to the side on a corbel
  bp.fill([at.x, at.y, at.z, at.x, top - 1, at.z], p.foundation);
  const lx = at.x + ax;
  const lz = at.z + az;
  bp.set(lx, top - 1, lz, p.stoneStairs, { facing: bp.kit.CCW[at.facing], half: 'top', shape: 'straight' });
  bp.fill([lx, top, lz, lx, top + 1, lz], p.foundation);
  bp.set(lx, top + 2, lz, 'minecraft:campfire', { lit: 'true', signal_fire: 'false', facing: at.facing });
  // moss at the foot, vines creeping up the outer face
  drape(bp, at.x + out.dx, at.y + 1, at.z + out.dz);
  for (let y = at.y + 2; y <= at.y + 3; y++) creep(bp, at.x + out.dx, y, at.z + out.dz, back);
}

/**
 * A stilt: a frame log on a foundation cap sunk into the mud (`height` cells above the ground, or up to `at.top`),
 * fence cross-bracing `span` cells to the right; `pair` (default) also stands the next pile at the end of the bracing.
 */
export function stilt_pile(bp, at, opts = {}) {
  const p = bp.p;
  const h = opts.height ?? (at.top != null ? at.top - at.y + 1 : 5);
  const span = opts.span ?? 3;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  const pile = (x, z) => {
    bp.set(x, at.y - 1, z, p.foundation);
    bp.set(x, at.y, z, p.foundation);
    bp.fill([x, at.y + 1, z, x, at.y + h - 1, z], p.frame, axisProps(bp, p.frame, 'y'));
  };
  pile(at.x, at.z);
  if (span > 0 && opts.pair !== false) pile(at.x + ax * span, at.z + az * span);
  // two braces at different heights (never level with each other: the lower one sags to the far side)
  for (let s = 1; s < span; s++) {
    bp.set(at.x + ax * s, at.y + h - 2, at.z + az * s, p.fence);
    if (s < span - 1 || opts.pair !== false) bp.set(at.x + ax * s, at.y + 1 + (s === span - 1 ? 0 : 1), at.z + az * s, p.fence);
  }
  // vines creeping up from the waterline
  for (let y = at.y + 1; y <= at.y + 2; y++) creep(bp, at.x + out.dx, y, at.z + out.dz, back);
}

/**
 * A boardwalk running `length` cells (default 6) from `at` to the right (seen from the `facing` side), 2 wide toward
 * `facing`, its deck `height` cells above the ground on frame posts; it dips a slab past the middle, a fence rail on
 * one side only (`rail`: 'out' (default, the `facing` side) | 'in'), a lantern on a fence arm off the far end
 * (`lantern: false` to leave it dark).
 */
export function boardwalk(bp, at, opts = {}) {
  const p = bp.p;
  const n = Math.max(2, opts.length ?? at.length ?? 6);
  const h = opts.height ?? 2;
  const f = bp.kit.DIR[at.facing];
  const [ax, az] = along(bp, at.facing);
  const railS = opts.rail === 'in' ? -1 : 2;
  const cell = (i, s, y) => [at.x + ax * i + f.dx * s, y, at.z + az * i + f.dz * s];
  const deck = at.y + h;
  const slab = deckSlab(bp);
  // the dip sits one cell past the middle (nothing here is centred)
  const mid = Math.floor(n / 2);
  const dips = (i) => n >= 4 && i >= mid && i <= mid + 1 && i < n - 1;
  for (let i = 0; i < n; i++) for (const s of [0, 1]) bp.set(...cell(i, s, deck), slab, { type: dips(i) ? 'bottom' : 'top' });
  const post = (i, s, y1) => {
    bp.set(...cell(i, s, at.y - 1), p.foundation);
    bp.fill([...cell(i, s, at.y), ...cell(i, s, y1)], p.frame, axisProps(bp, p.frame, 'y'));
  };
  for (const i of [0, n - 1]) post(i, 0, deck - 1);
  // rail posts on the rail side carry a fence rail along the whole walk
  for (const i of new Set([0, mid, n - 1])) post(i, railS, deck);
  for (let i = 0; i < n; i++) bp.set(...cell(i, railS, deck + 1), p.fence);
  // the pier-end lantern on a fence arm out past the end, over the water
  if (opts.lantern !== false) {
    bp.set(...cell(n - 1, railS, deck + 2), p.fence);
    armLantern(bp, ...cell(n, railS, deck + 2));
  }
  // vines creeping up the middle rail post from the water, under the deck
  for (let y = at.y; y < deck; y++) creep(bp, ...cell(mid, railS < 0 ? 0 : 1, y), railS < 0 ? bp.kit.OPPOSITE[at.facing] : at.facing);
}

/**
 * A net loft under an eave (roof slot): `width` cells (default 3) starting `offset` cells (default 1) along the edge:
 * a fence rail hung from the eave, cobweb nets, a slab shelf holding a barrel.
 */
export function net_loft(bp, at, opts = {}) {
  const p = bp.p;
  const n = at.length ?? 4;
  const w = Math.min(opts.width ?? 3, n);
  const off = Math.min(opts.offset ?? 1, n - w);
  const [ax, az] = bp.kit.DIR[at.facing].dx === 0 ? [1, 0] : [0, 1];
  const cell = (i, y) => [at.x + ax * (off + i), y, at.z + az * (off + i)];
  for (let i = 0; i < w; i++) if (!bp.get(...cell(i, at.y - 1))) bp.set(...cell(i, at.y - 1), p.fence);
  // nets hung from the rail, one sagging a block lower; the last cell is a shelf with a barrel
  for (let i = 0; i < w - 1; i++) bp.set(...cell(i, at.y - 2), 'minecraft:cobweb');
  bp.set(...cell(0, at.y - 3), 'minecraft:cobweb');
  bp.set(...cell(w - 1, at.y - 3), deckSlab(bp), { type: 'top' });
  bp.set(...cell(w - 1, at.y - 2), 'minecraft:barrel', { facing: 'up' });
}

/**
 * A drying rack on a wall (wall slot): at the wall cell, a 3-wide slab shelf outside on stair brackets holding
 * barrels, a fence rail two rows up with a net drying between the barrels.
 */
export function drying_rack(bp, at) {
  const p = bp.p;
  const [ax, az] = along(bp, at.facing);
  const out = bp.kit.DIR[at.facing];
  const back = bp.kit.OPPOSITE[at.facing];
  const cell = (s, y) => [at.x + ax * s + out.dx, y, at.z + az * s + out.dz];
  for (let s = -1; s <= 1; s++) {
    bp.set(...cell(s, at.y), deckSlab(bp), { type: 'top' });
    bp.set(...cell(s, at.y + 2), p.fence);
  }
  for (const s of [-1, 1]) bp.set(...cell(s, at.y - 1), p.stairs, { facing: back, half: 'top', shape: 'straight' });
  bp.set(...cell(-1, at.y + 1), 'minecraft:barrel', { facing: 'up' });
  bp.set(...cell(1, at.y + 1), 'minecraft:barrel', { facing: at.facing });
  bp.set(...cell(0, at.y + 1), 'minecraft:cobweb');
}
