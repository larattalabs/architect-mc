// Small-building components (docs/CONTRACT.md "Phase 6c slice 0b" §4, C8): parametric builders a SMALL design composes
// from, so an S item (a market stall, a well, a shed, a rack) is a few lines and a short design pass.
//
// Every builder is `(bp, box, opts)`:
//   - `box` = [x0, y0, z0, x1, y1, z1] in design coordinates: the footprint and the height it may use. y0 is the base row
//     (the row under the feet, groundY - 1 for a building on the ground); the builder writes the base under what stands.
//   - the materials come from the palette roles only (bp.p and bp.p.roles), so a builder re-skins under any bible.
//   - `opts.facing` (default bp.front) is the side that faces the street: a stall's counter, a shed's door.
//   - each returns what a caller needs to compose it: { standAt: [x, y, z] (a feet cell to stand on in front of it),
//     door?: [x, y, z], interior?: [x0, y0, z0, x1, y1, z1] (a shed's room, feet rows) }.
//
// APPEND-ONLY after release: a builder that must change gets a new name (rack2, ...), so a polish rebuild or a copy
// rebuilt from its recipe never drifts. kit/test/smalls.test.mjs checks each standalone under every built-in bible.

const norm = (b) => [Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]), Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])];

function checkBox(name, box, min) {
  if (!Array.isArray(box) || box.length !== 6 || !box.every(Number.isInteger)) throw new Error(`smalls.${name}: box must be [x0,y0,z0,x1,y1,z1] (whole numbers)`);
  const [x0, y0, z0, x1, y1, z1] = norm(box);
  const dims = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
  if (dims[0] < min[0] || dims[1] < min[1] || dims[2] < min[2]) throw new Error(`smalls.${name}: box ${dims.join('x')} is under the ${min.join('x')} it needs (x by height by z)`);
  return [x0, y0, z0, x1, y1, z1];
}

/** The block a role names (bp.p.roles), else the palette field `fallback`. */
function role(bp, name, fallback) {
  return bp.p.roles?.[name] ?? bp.p[fallback ?? name];
}

/** A cell in front of the box on the `facing` side, at the feet row, and the run direction along that side. */
function frontOf([x0, y0, z0, x1, , z1], facing) {
  const mx = Math.floor((x0 + x1) / 2);
  const mz = Math.floor((z0 + z1) / 2);
  const y = y0 + 1;
  switch (facing) {
    case 'north': return { stand: [mx, y, z0 - 1], edge: [mx, y, z0] };
    case 'east': return { stand: [x1 + 1, y, mz], edge: [x1, y, mz] };
    case 'west': return { stand: [x0 - 1, y, mz], edge: [x0, y, mz] };
    default: return { stand: [mx, y, z1 + 1], edge: [mx, y, z1] };
  }
}

const alongX = (facing) => facing === 'north' || facing === 'south';

/**
 * A rack (a drying or market rack): posts at both ends (and every 3 cells), shelves at `levels` rows. `length` cells along
 * the facing side (default the box's), `levels` 1-3 (default 2). Box at least 3 x 3 high x 1.
 */
export function rack(bp, box, { length, levels = 2, facing = bp.front } = {}) {
  const [x0, y0, z0, x1, y1, z1] = checkBox('rack', box, [1, 3, 1]);
  if (!Number.isInteger(levels) || levels < 1 || levels > 3) throw new Error('smalls.rack: levels must be 1, 2 or 3');
  const ax = alongX(facing);
  const full = ax ? x1 - x0 + 1 : z1 - z0 + 1;
  const len = Math.max(2, Math.min(length ?? full, full));
  const top = Math.min(y1, y0 + levels + 1);
  const post = role(bp, 'frame', 'frame');
  // the run sits on the box's middle row across the facing side
  const across = ax ? Math.floor((z0 + z1) / 2) : Math.floor((x0 + x1) / 2);
  const at = (i, y) => (ax ? [x0 + i, y, across] : [across, y, z0 + i]);
  for (let i = 0; i < len; i++) {
    bp.set(...at(i, y0), role(bp, 'foundation', 'foundation'));
    const isPost = i === 0 || i === len - 1 || i % 3 === 0;
    if (isPost) for (let y = y0 + 1; y <= top; y++) bp.set(...at(i, y), post, bp.p.frame === post && /_log$|_stem$/.test(post) ? { axis: 'y' } : {});
    else for (let l = 1; l <= levels; l++) if (y0 + l < top) bp.slab(...at(i, y0 + l), 'top', bp.p.slab);
  }
  // a cap along the top
  for (let i = 1; i < len - 1; i++) bp.slab(...at(i, top), 'bottom', bp.p.slab);
  const f = frontOf([x0, y0, z0, x1, y1, z1], facing);
  return { standAt: f.stand };
}

/**
 * A market stall: four posts, a counter along the `counter` side (default the facing side), an awning of the `awning`
 * role's block (default `accent`; a role with a slab variant is laid as slabs), a hanging light. Box at least 3 x 5 x 3.
 */
export function stall(bp, box, { awning = 'accent', counter, facing = bp.front } = {}) {
  const [x0, y0, z0, x1, y1, z1] = checkBox('stall', box, [3, 5, 3]);
  const side = counter ?? facing;
  const top = Math.min(y1, y0 + 4);
  const post = bp.p.fence;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) bp.set(x, y0, z, role(bp, 'floor', 'floor'));
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) for (let y = y0 + 1; y < top; y++) bp.set(x, y, z, post);
  // the counter: planks with a slab on top, between the posts on the counter side
  const run = side === 'north' ? [[x0 + 1, z0], [x1 - 1, z0]] : side === 'east' ? [[x1, z0 + 1], [x1, z1 - 1]] : side === 'west' ? [[x0, z0 + 1], [x0, z1 - 1]] : [[x0 + 1, z1], [x1 - 1, z1]];
  const [[ax, az], [bx, bz]] = run;
  for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
    for (let z = Math.min(az, bz); z <= Math.max(az, bz); z++) {
      bp.set(x, y0 + 1, z, bp.p.planks);
      bp.slab(x, y0 + 2, z, 'bottom', bp.p.slab);
    }
  // the awning: one row wider is not allowed (the box binds), so it covers the footprint
  const cover = role(bp, awning, awning === 'roof' ? 'roofBlock' : awning === 'accent' ? 'accentPlanks' : 'wall');
  const slab = awning === 'roof' ? bp.p.roofSlab : awning === 'accent' ? bp.p.accentSlab : null;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    if (slab) bp.slab(x, top, z, 'bottom', slab);
    else bp.set(x, top, z, cover);
  }
  bp.lantern(Math.floor((x0 + x1) / 2), top - 1, Math.floor((z0 + z1) / 2), true);
  const f = frontOf([x0, y0, z0, x1, y1, z1], side);
  return { standAt: f.stand };
}

/**
 * A well: a ring of the foundation's wall (or stone) around water, `round` (corners cut) or `square`, optionally `roofed`
 * (two posts and a ridge of roof slabs, with a hanging light). Box at least 3 x 2 x 3 (roofed: 3 x 5 x 3).
 */
export function well(bp, box, { shape = 'round', roofed = true, facing = bp.front } = {}) {
  if (shape !== 'round' && shape !== 'square') throw new Error("smalls.well: shape must be 'round' or 'square'");
  const [x0, y0, z0, x1, y1, z1] = checkBox('well', box, [3, roofed ? 5 : 2, 3]);
  const corner = (x, z) => (x === x0 || x === x1) && (z === z0 || z === z1);
  const ring = bp.p.stoneWall ?? bp.p.stone;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      const edge = x === x0 || x === x1 || z === z0 || z === z1;
      if (shape === 'round' && corner(x, z)) {
        bp.set(x, y0, z, role(bp, 'path', 'path'));
        continue;
      }
      if (edge) {
        bp.set(x, y0, z, role(bp, 'foundation', 'foundation'));
        bp.set(x, y0 + 1, z, ring);
      } else bp.set(x, y0, z, 'minecraft:water');
    }
  if (roofed) {
    const top = Math.min(y1, y0 + 4);
    const ax = alongX(facing);
    // the posts stand on the ring's middle of the two sides that don't face the street
    const posts = ax ? [[x0, Math.floor((z0 + z1) / 2)], [x1, Math.floor((z0 + z1) / 2)]] : [[Math.floor((x0 + x1) / 2), z0], [Math.floor((x0 + x1) / 2), z1]];
    for (const [x, z] of posts) for (let y = y0 + 1; y < top; y++) bp.set(x, y, z, bp.p.fence);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (ax ? z === posts[0][1] : x === posts[0][0]) bp.slab(x, top, z, 'bottom', bp.p.roofSlab);
    bp.lantern(Math.floor((x0 + x1) / 2), top - 1, Math.floor((z0 + z1) / 2), true);
  } else bp.lantern(x0 + (shape === 'round' ? 1 : 0), y0 + 2, z0, false);
  const f = frontOf([x0, y0, z0, x1, y1, z1], facing);
  return { standAt: f.stand };
}

/**
 * A shed: a one-room hut with walls of the `wall` role and a frame at the corners, a door on the `door` side (default the
 * facing side), a `lean_to` or `gable` roof, a window, a light inside. Box at least 4 x 6 x 4 (gable: 5 wide across the
 * ridge). Returns the door cell and the interior box (feet rows) for the caller's interior and anchors.
 */
export function shed(bp, box, { roof = 'gable', door, facing = bp.front } = {}) {
  if (roof !== 'gable' && roof !== 'lean_to') throw new Error("smalls.shed: roof must be 'gable' or 'lean_to'");
  const [x0, y0, z0, x1, y1, z1] = checkBox('shed', box, [4, 6, 4]);
  const side = door ?? facing;
  const wallTop = y0 + 3;
  // the floor and the walls
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) bp.set(x, y0, z, role(bp, 'foundation', 'foundation'));
  for (let y = y0 + 1; y <= wallTop; y++)
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const edgeX = x === x0 || x === x1;
        const edgeZ = z === z0 || z === z1;
        if (!edgeX && !edgeZ) {
          bp.air(x, y, z);
          continue;
        }
        bp.set(x, y, z, edgeX && edgeZ ? bp.p.frame : role(bp, 'wall', 'wall'), edgeX && edgeZ && /_log$|_stem$/.test(bp.p.frame) ? { axis: 'y' } : {});
      }
  for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) bp.set(x, y0, z, role(bp, 'floor', 'floor'));
  // the door, in the middle of its side
  const mx = Math.floor((x0 + x1) / 2);
  const mz = Math.floor((z0 + z1) / 2);
  const d = side === 'north' ? [mx, y0 + 1, z0] : side === 'east' ? [x1, y0 + 1, mz] : side === 'west' ? [x0, y0 + 1, mz] : [mx, y0 + 1, z1];
  bp.door(d[0], d[1], d[2], side);
  // a window on the side opposite the door
  const opp = { north: 'south', south: 'north', east: 'west', west: 'east' }[side];
  const w = opp === 'north' ? [mx, y0 + 2, z0] : opp === 'east' ? [x1, y0 + 2, mz] : opp === 'west' ? [x0, y0 + 2, mz] : [mx, y0 + 2, z1];
  bp.set(w[0], w[1], w[2], bp.p.pane);
  // the roof: the ridge runs along the door side (gable), or the roof falls toward the door (lean-to)
  const ax = alongX(side);
  const span = ax ? z1 - z0 + 1 : x1 - x0 + 1;
  const runLo = ax ? x0 : z0;
  const runHi = ax ? x1 : z1;
  const acrossLo = ax ? z0 : x0;
  const cell = (run, across) => (ax ? [run, across] : [across, run]);
  const toward = (across, lowSide) => (ax ? (lowSide ? 'south' : 'north') : lowSide ? 'east' : 'west');
  let peak = wallTop;
  if (roof === 'gable') {
    const half = Math.floor(span / 2);
    for (let k = 0; k < half; k++) {
      const y = wallTop + 1 + k;
      for (let r = runLo; r <= runHi; r++) {
        const [ax0, az0] = cell(r, acrossLo + k);
        const [ax1, az1] = cell(r, acrossLo + span - 1 - k);
        bp.stairs(ax0, y, az0, ax ? 'south' : 'east', { block: bp.p.roofStairs });
        bp.stairs(ax1, y, az1, ax ? 'north' : 'west', { block: bp.p.roofStairs });
      }
      peak = y;
    }
    if (span % 2 === 1) for (let r = runLo; r <= runHi; r++) {
      const [cx, cz] = cell(r, acrossLo + half);
      bp.slab(cx, wallTop + 1 + half, cz, 'bottom', bp.p.roofSlab);
      peak = wallTop + 1 + half;
    }
    // close the gable ends with the wall role up to the roof
    for (let k = 0; k < half; k++)
      for (let a = acrossLo + k + 1; a < acrossLo + span - 1 - k; a++)
        for (const r of [runLo, runHi]) {
          const [gx, gz] = cell(r, a);
          bp.set(gx, wallTop + 1 + k, gz, role(bp, 'wall', 'wall'));
        }
  } else {
    // lean-to: one slope down toward the door side, a stair row per step
    const low = side === 'south' || side === 'east';
    const steps = Math.min(span, Math.max(1, y1 - wallTop));
    for (let i = 0; i < span; i++) {
      const a = low ? acrossLo + span - 1 - i : acrossLo + i;
      const y = wallTop + 1 + Math.min(Math.floor((i * steps) / span), steps - 1);
      for (let r = runLo; r <= runHi; r++) {
        const [sx, sz] = cell(r, a);
        bp.stairs(sx, y, sz, toward(a, !low), { block: bp.p.roofStairs });
        // fill under a raised step so the roof is closed
        for (let yy = wallTop + 1; yy < y; yy++) bp.set(sx, yy, sz, r === runLo || r === runHi || a === acrossLo || a === acrossLo + span - 1 ? role(bp, 'wall', 'wall') : bp.p.roofBlock);
      }
      peak = Math.max(peak, y);
    }
  }
  if (peak > y1) throw new Error(`smalls.shed: the roof reaches row ${peak}, over the box's top ${y1} (make the box taller or narrower across the ridge)`);
  bp.lantern(mx, wallTop, mz, true);
  const f = frontOf([x0, y0, z0, x1, y1, z1], side);
  return { standAt: f.stand, door: d, interior: [x0 + 1, y0 + 1, z0 + 1, x1 - 1, wallTop, z1 - 1] };
}

/** The builders, by name (the SMALL brief lists them). */
export const SMALLS = Object.freeze({ rack, stall, well, shed });
