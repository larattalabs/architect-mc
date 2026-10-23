// (7a K2) Wall walks (docs/CONTRACT.md "Phase 7a slice K2" §1, §3, §5, §7 and the coordinator's readings of 2026-10-23): a railed,
// lit walk along a wall's top, player only, with flights (or ladders) up from the inside. wall.mjs emitWall calls it with the wall's
// own cells, its top per position and its `put`, so the walk is cells of the wall's own part (`w_<id>`: RS's targets take it with the
// wall, bottom up).
//
//   the level       the walk surface in half blocks per position: S2 = max over j of (2 T[j] + 2 - |i - j|) (K1a's top raised so that
//                   neighbouring walk cells differ by at most one half block: over a gate's raised lintel it ramps), an even S2 a full
//                   block of the walk role at S2 / 2 - 1, an odd one a bottom slab at (S2 - 1) / 2 over a full block
//   the courses     the inner `width` courses (and any between them and the outer) are the walk; the outer course is the parapet: a
//                   continuous wall-block course at the feet (1.5 over the walk: M8's barrier on every walk cell), K1a's merlons a
//                   course above it every other position when crenels are on (a role with no wall variant: two full blocks)
//   the inner rail  where the inside ground is more than 3 below the walk, a rail (the rail role's wall block, else its fence) one
//                   cell inward at the feet, on a corbel at walk level (face-joined to the walk: M3); open where an access lands
//   accesses        at each gate a flight up the inner face on each side (rise 1 a cell, 1 wide, along the wall, railed on its open
//                   side from its second step, filled under), its band (its cells plus 1) clear of obstacles, walk networks and the
//                   gate lamps; else a ladder on the inner face (player only; access: stair refuses NO_ROOM {why: access}); `every`
//                   adds one along a run longer than it; a wall with no gate gets one (a ring: by the zone's street end; else its middle)
//   towers          corners: tower: a 1-wide, 2-high passage through each stub at walk level
//   lamps           the bible's light on the parapet's top (in a crenel gap) at least every floor(12 * level / 15) positions
//   dead ends       a free end of an open wall: a rail across the walk (noted)
// Integer cells, ties by position; pure and deterministic.
import { CONNECTOR_DEFAULTS, shapeOf } from './style.mjs';

/** (§1) The walk's defaults. */
export const WALK_DEFAULTS = Object.freeze({ width: 1, access: 'auto', every: 64, lamps: 'every' });
/** How far along the wall (positions) a gate's flight may start past its jamb's neighbour. */
const FLIGHT_SHIFT = 8;

const key = (x, z) => `${x},${z}`;
const FACE = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };

/** A wall part's walk settings: the `walk` member (true or an object), else params.wall_walk read as true; null for none. */
export function walkOf(part, read = {}) {
  const w = part.walk !== undefined ? part.walk : read.walk ? true : undefined;
  if (w === undefined || w === false) return null;
  const o = w === true ? {} : w;
  return { width: o.width ?? WALK_DEFAULTS.width, access: o.access ?? WALK_DEFAULTS.access, every: o.every ?? WALK_DEFAULTS.every, lamps: o.lamps ?? WALK_DEFAULTS.lamps };
}

/**
 * The walk's surface per position (half blocks) over K1a's top T: S2[i] = max over j of (2 T[j] + 2 - d(i, j)), d the distance along
 * the wall (around a closed ring). Returns {S2, top}: top[i] the walk's top block (a slab when S2 is odd).
 */
export function walkLevels(T, closed) {
  const n = T.length, S2 = T.map((t) => 2 * t + 2);
  // two sweeps each way (a ring: twice round)
  const rounds = closed ? 2 : 1;
  for (let r = 0; r < rounds; r++) {
    for (let i = 1; i < (closed ? n + 1 : n); i++) { const a = i % n, b = (i - 1) % n; if (S2[b] - 1 > S2[a]) S2[a] = S2[b] - 1; }
    for (let i = (closed ? n : n - 1) - 1; i >= 0; i--) { const a = i % n, b = (i + 1) % n; if (S2[b] - 1 > S2[a]) S2[a] = S2[b] - 1; }
  }
  const top = S2.map((s) => Math.floor((s - 1) / 2));
  return { S2, top };
}

/** The first role of a chain whose block has a wall variant (the bible's own slot first), its wall block; else null. */
function wallRoleOf(roles, given, chain) {
  for (const r of [given, ...chain]) { if (!r || !roles[r]) continue; const w = shapeOf(roles[r], 'wall'); if (w) return { role: r, block: w }; }
  return null;
}

/** A wall block's state for its neighbours (K1a's wallState). */
function wallState(block, c) {
  const v = (b) => (b ? 'low' : 'none');
  const straight = (c.n && c.s && !c.e && !c.w) || (c.e && c.w && !c.n && !c.s);
  return `${block}[east=${v(c.e)},north=${v(c.n)},south=${v(c.s)},up=${straight ? 'false' : 'true'},waterlogged=false,west=${v(c.w)}]`;
}
/** A fence's state for its neighbours. */
const fenceState = (block, c) => `${block}[east=${!!c.e},north=${!!c.n},south=${!!c.s},waterlogged=false,west=${!!c.w}]`;

/**
 * Emit a wall's walk. `E`: emitWall's context: {K, W, T (the wall's top per position: the walk's top), S2, put, has (a cell written?),
 * roles, cr (the bible's connector roles), body, opening (x,z -> gate), walkSet (the networks' walk cells), stubs (Set of x,z),
 * lampFoot (Set of x,z: the gates' lamps' columns), fixture, crenels}. Writes through `put` (state strings; `#walk` marks a walk
 * surface the movers may route over); returns {meta, record, geometry, notes, lamps: [[x, y, z, state]], refuse?: reason}.
 */
export function emitWalk(E) {
  const { K, W, top, S2, put, roles, cr, body, opening, walkSet, stubs, lampFoot, fixture } = E;
  const st = W.st, wk = st.walk, t = st.thickness, n = W.positions.length;
  const notes = [];
  const stand = (x, z) => K.stand(x, z);
  // ---- the blocks
  const walkRole = roles[cr.wall?.walk] ?? roles[cr.wall?.cap] ?? roles.trim ?? body;
  const walkFull = walkRole;
  const walkSlab = shapeOf(walkRole, 'slab') ?? shapeOf(body, 'slab') ?? 'minecraft:stone_brick_slab';
  const slabState = `${walkSlab}[type=bottom,waterlogged=false]`;
  const par = wallRoleOf(roles, cr.wall?.parapet, CONNECTOR_DEFAULTS.wall.parapet);
  const parFull = par ? null : (roles[cr.wall?.parapet] ?? roles[cr.wall?.cap] ?? body);
  const railRole = roles.rail ?? 'minecraft:oak_fence';
  const railWall = shapeOf(railRole, 'wall');
  const railFence = railWall ? null : (shapeOf(railRole, 'fence') ?? (/_fence$/.test(railRole.replace(/\[.*$/, '')) ? railRole.replace(/\[.*$/, '') : 'minecraft:oak_fence'));
  const stairBlock = shapeOf(walkRole, 'stairs') ?? shapeOf(body, 'stairs') ?? 'minecraft:stone_brick_stairs';
  // ---- per position: its inner cell, its outward normal
  const cellsOf = Array.from({ length: n }, () => []);
  for (const c of W.cells) cellsOf[c.pos].push(c);
  const inner = cellsOf.map((cs) => cs.find((c) => c.depth === 0) ?? null);
  const outer = cellsOf.map((cs) => cs.find((c) => c.depth === t - 1) ?? null);
  const nrm = inner.map((c, i) => { if (!c) return null; const o = outer[i] ?? c; let dx = Math.sign(o.x - c.x), dz = Math.sign(o.z - c.z); if (!dx && !dz) { if (W.positions[i].axis === 1) dz = 1; else dx = 1; } return dx && dz ? null : [dx, dz]; });
  const ends = new Set(W.ends);
  const feet = (i) => top[i] + 1;
  const odd = (i) => (S2[i] & 1) === 1;
  // the cells the walk takes (in the wall's band, the stubs aside: their passage below)
  const walkCells = [], parCells = [], railCells = [], corbels = [];
  const parapetAt = new Map(); // x,z -> y of the parapet's wall block
  // ---- the courses
  for (const c of W.cells) {
    const k = key(c.x, c.z);
    if (!E.has(c)) continue;
    const i = c.pos, Y = top[i];
    if (stubs.has(k)) {
      // (towers) the passage: the inner course's cell through the stub, at walk level, 2 high
      if (c.depth !== 0) continue;
      put(c.x, Y, c.z, odd(i) ? slabState : walkFull); if (odd(i)) put(c.x, Y - 1, c.z, walkFull);
      put(c.x, Y + 1, c.z, null); put(c.x, Y + 2, c.z, null);
      walkCells.push([c.x, feet(i), c.z, i]);
      continue;
    }
    if (c.depth < t - 1) {
      put(c.x, Y, c.z, odd(i) ? slabState : walkFull);
      if (odd(i)) put(c.x, Y - 1, c.z, walkFull);
      // (a dead end: a rail across the walk)
      if (ends.has(i)) { put(c.x, Y + 1, c.z, '#rail'); railCells.push([c.x, Y + 1, c.z]); continue; }
      walkCells.push([c.x, Y + 1, c.z, i]);
    } else {
      put(c.x, Y, c.z, body);
      if (par) { put(c.x, Y + 1, c.z, '#parapet'); parapetAt.set(k, Y + 1); parCells.push([c.x, Y + 1, c.z]); if (st.crenels && (i & 1) === 0) put(c.x, Y + 2, c.z, '#merlon'); } else { put(c.x, Y + 1, c.z, parFull); put(c.x, Y + 2, c.z, parFull); parCells.push([c.x, Y + 1, c.z]); }
    }
  }
  // ---- accesses
  const blockedCol = (x, z) => {
    const g = W.G.at(x, z);
    return g < 0 || W.G.ob[g] !== 0 || W.cellAt.has(key(x, z)) || walkSet.has(key(x, z)) || opening.has(key(x, z)) || lampFoot.has(key(x, z)) || (K.props ?? []).some((q) => (q.cells ?? []).some((cc) => cc[0] === x && cc[2] === z));
  };
  const taken = new Set(); // columns accesses use (with their band's cells: no second access in them)
  const straightRun = (ps) => {
    for (let q = 0; q < ps.length; q++) {
      const i = ps[q];
      if (i < 0 || i >= n || !inner[i] || !nrm[i] || W.positions[i].axis === 3 || ends.has(i) || stubs.has(key(inner[i].x, inner[i].z))) return false;
      if (W.gates.some((g) => i >= g.a - 1 && i <= g.b + 1)) return false;
      if (q && (nrm[i][0] !== nrm[ps[0]][0] || nrm[i][1] !== nrm[ps[0]][1] || Math.abs(inner[i].x - inner[ps[q - 1]].x) + Math.abs(inner[i].z - inner[ps[q - 1]].z) !== 1)) return false;
    }
    return true;
  };
  const yLast = (i) => (odd(i) ? top[i] - 1 : top[i]);
  // a flight from position p0 stepping `dir` along the wall (rising away from p0): its steps, or null
  const flightAt = (p0, dir) => {
    const [nx, nz] = nrm[p0] ?? [0, 0];
    if (!inner[p0]) return null;
    const cellAt = (i, d) => [inner[i].x - nx * d, inner[i].z - nz * d];
    const [fx, fz] = cellAt(p0, 1);
    const g0 = stand(fx, fz);
    const steps = [];
    for (let k = 0; k < 40; k++) {
      const i = p0 + dir * k;
      if (!straightRun([i]) || (k && !straightRun([i - dir, i]))) return null;
      const y = g0 + 1 + k;
      const [sx, sz] = cellAt(i, 1), [rx, rz] = cellAt(i, 2);
      if (stand(sx, sz) > y || stand(rx, rz) > y) return null;
      steps.push({ i, x: sx, z: sz, y, rail: [rx, rz] });
      if (y === yLast(i)) break;
      if (y > yLast(i)) return null;
      if (k === 39) return null;
    }
    // its band: the steps and their rail column plus 1 (the wall's own cells aside)
    const cols = steps.flatMap((s) => [[s.x, s.z], s.rail]);
    for (const [x, z] of cols) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const bx = x + dx, bz = z + dz;
      if (W.cellAt.has(key(bx, bz))) continue;
      if (blockedCol(bx, bz) || taken.has(key(bx, bz))) return null;
    }
    const facing = FACE[`${Math.sign(steps[steps.length - 1].x - steps[0].x) || 0},${Math.sign(steps[steps.length - 1].z - steps[0].z) || 0}`] ?? null;
    if (steps.length > 1 && !facing) return null;
    return { kind: 'stair', steps, facing: facing ?? FACE[`${-nx},${-nz}`], top: steps[steps.length - 1].i, foot: [steps[0].x, g0 + 1, steps[0].z] };
  };
  // a ladder on the inner face at position p
  const ladderAt = (p) => {
    if (!straightRun([p])) return null;
    const [nx, nz] = nrm[p];
    const x = inner[p].x - nx, z = inner[p].z - nz;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const bx = x + dx, bz = z + dz; if (W.cellAt.has(key(bx, bz))) continue; if (blockedCol(bx, bz) || taken.has(key(bx, bz))) return null; }
    const g0 = stand(x, z);
    return { kind: 'ladder', x, z, y0: g0 + 1, y1: yLast(p), facing: FACE[`${-nx},${-nz}`], top: p, foot: [x, g0 + 1, z] };
  };
  const accesses = [];
  const take = (a) => {
    const cols = a.kind === 'stair' ? a.steps.flatMap((s) => [[s.x, s.z], s.rail]) : [[a.x, a.z]];
    for (const [x, z] of cols) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) taken.add(key(x + dx, z + dz));
    accesses.push(a);
  };
  const access = (cands, why) => {
    // a flight first (access stair or auto), each candidate start in order; then a ladder (auto or ladder)
    if (wk.access !== 'ladder') for (const [p0, dir] of cands) { const f = flightAt(p0, dir); if (f) { take({ ...f, why }); return f; } }
    if (wk.access !== 'stair') for (const [p0] of cands) { const l = ladderAt(p0); if (l) { take({ ...l, why }); return l; } }
    return null;
  };
  const wrap = (i) => (W.closed ? ((i % n) + n) % n : i);
  const missing = [];
  for (const g of [...W.gates].sort((a, b) => a.a - b.a)) {
    for (const side of [-1, 1]) {
      const cands = [];
      for (let s = 0; s <= FLIGHT_SHIFT; s++) { const p0 = wrap(side < 0 ? g.a - 2 - s : g.b + 2 + s); if (p0 >= 0 && p0 < n) cands.push([p0, side]); }
      if (!access(cands, `gate ${g.id}`)) missing.push(`${g.id} ${side < 0 ? 'left' : 'right'}`);
    }
  }
  if (!W.gates.length) {
    // no gate: one access, a ring's by its zone's street end, else the wall's middle
    let p = n >> 1;
    const z = W.target?.zone ? K.zoneEmit?.get(W.target.zone) : null;
    if (z?.L?.orientation && z.L.road) {
      const o = z.L.orientation, sv = z.L.road.sv, pt = o === 'ew' ? [z.L.u1 + 1, sv] : [sv, z.L.u1 + 1];
      let bd = Infinity;
      W.positions.forEach((q, i) => { const d = (q.x - pt[0]) * (q.x - pt[0]) + (q.z - pt[1]) * (q.z - pt[1]); if (d < bd) { bd = d; p = i; } });
    }
    const cands = [];
    for (let s = 0; s <= 2 * FLIGHT_SHIFT; s++) for (const dir of [1, -1]) cands.push([wrap(p + (s >> 1) * (s & 1 ? -1 : 1)), dir]);
    if (!access(cands.filter(([q]) => q >= 0 && q < n), 'no gate')) missing.push('the wall\'s one access');
  }
  if (missing.length && wk.access === 'stair') return { refuse: { code: 'NO_ROOM', message: `no room for a flight up the inner face (access: stair) at ${missing.join(', ')}: its band (the flight's cells plus 1) meets a lot, a street, a lamp or a prop, or the ground`, evidence: { why: 'access', at: missing } } };
  if (missing.length) notes.push(`walk: no access at ${missing.join(', ')} (no room for a flight or a ladder)`);
  // `every`: an access along a run longer than it (the runs between accesses, and an open wall's ends)
  for (let round = 0; round < 8; round++) {
    const ps = [...new Set(accesses.map((a) => a.top))].sort((a, b) => a - b);
    const runs = [];
    if (!ps.length) break;
    if (W.closed) ps.forEach((p, q) => { const nx = q + 1 < ps.length ? ps[q + 1] : ps[0] + n; runs.push([p, nx]); });
    else { runs.push([0, ps[0]]); ps.forEach((p, q) => { if (q + 1 < ps.length) runs.push([p, ps[q + 1]]); }); runs.push([ps[ps.length - 1], n - 1]); }
    let added = false;
    for (const [a, b] of runs) {
      if (b - a <= wk.every) continue;
      const m = (a + b) >> 1;
      const cands = [];
      for (let s = 0; s <= 2 * FLIGHT_SHIFT; s++) for (const dir of [1, -1]) cands.push([wrap(m + (s >> 1) * (s & 1 ? -1 : 1)), dir]);
      if (access(cands.filter(([q]) => q >= 0 && q < n), `every ${wk.every}`)) added = true;
    }
    if (!added) break;
  }
  // ---- write the accesses
  const accessCols = new Map(); // x,z -> the highest y an access needs clear above (its steps' head room)
  const flightLamps = [];
  for (const a of accesses) {
    if (a.kind === 'stair') {
      a.steps.forEach((s, k) => {
        for (let y = Math.min(s.y - 1, K.env.S.groundAt(s.x, s.z) - 2); y < s.y; y++) put(s.x, y, s.z, body);
        put(s.x, s.y, s.z, `${stairBlock}[facing=${a.facing},half=bottom,shape=straight,waterlogged=false]#walk`);
        put(s.x, s.y + 1, s.z, null); put(s.x, s.y + 2, s.z, null);
        accessCols.set(key(s.x, s.z), s.y);
        // the open side's rail from the second step: the column filled to the step, the rail on it
        if (k >= 1) { const [rx, rz] = s.rail; for (let y = Math.min(s.y - 1, K.env.S.groundAt(rx, rz) - 2); y <= s.y; y++) put(rx, y, rz, body); put(rx, s.y + 1, rz, '#rail'); railCells.push([rx, s.y + 1, rz]); accessCols.set(key(rx, rz), s.y + 2); }
      });
      // its light: the fixture's light on the rail, at the flight's middle (and every `every` steps more)
      if (wk.lamps !== 'none' && st.lamps !== 'none' && a.steps.length > 1) {
        const ev = Math.max(4, Math.floor((12 * fixture.level) / 15));
        for (let k = Math.max(1, a.steps.length >> 1); k < a.steps.length; k += ev) {
          const q = a.steps[k];
          flightLamps.push([q.rail[0], q.y + 2, q.rail[1]]);
        }
      }
    } else {
      for (let y = a.y0; y <= a.y1; y++) put(a.x, y, a.z, `minecraft:ladder[facing=${a.facing},waterlogged=false]`);
      accessCols.set(key(a.x, a.z), a.y1);
    }
  }
  // ---- the inner rail on its corbels: where the inside ground is more than 3 below the walk (open over an access where its own steps
  // need the head room)
  for (let i = 0; i < n; i++) {
    const c = inner[i];
    if (!c || !E.has(c) || ends.has(i) || stubs.has(key(c.x, c.z))) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = c.x + dx, z = c.z + dz, k = key(x, z);
      if (W.cellAt.has(k)) continue;
      // an inner neighbour: not beside the outer course
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ex, ez]) => { const o = W.cellAt.get(key(x + ex, z + ez)); return o && o.depth > 0; })) continue;
      const g = W.G.at(x, z);
      if (g < 0 || W.G.ob[g] !== 0) continue;
      if (S2[i] - 2 * (stand(x, z) + 1) <= 6) continue; // the drop is 3 or less: open
      const Y = top[i];
      const ac = accessCols.get(k);
      if (ac !== undefined && Y < ac + 4) continue; // over an access's step: its head room (3 clear, the kit mover's step down)
      if (corbels.some((q) => q[0] === x && q[2] === z)) continue;
      put(x, Y, z, odd(i) ? slabState : walkFull);
      put(x, Y + 1, z, '#rail');
      corbels.push([x, Y, z]); railCells.push([x, Y + 1, z]);
    }
  }
  // ---- the lamps: on the parapet's top in a crenel gap, every floor(12 * level / 15) positions
  const lamps = [];
  if (wk.lamps !== 'none' && st.lamps !== 'none') {
    const light = fixture.kind === 'hanging_lantern' ? fixture.light.replace('hanging=true', 'hanging=false') : fixture.light;
    const every = Math.max(4, Math.floor((12 * fixture.level) / 15));
    const want = [];
    for (let i = W.closed ? 0 : Math.min(2, n - 1); i < n; i += every) want.push(i);
    if (!W.closed && want[want.length - 1] < n - 3) want.push(n - 3);
    const used = new Set();
    for (const i0 of want) {
      for (const d of [0, 1, -1, 2, -2]) {
        const i = wrap(i0 + d);
        if (i < 0 || i >= n || used.has(i) || ends.has(i)) continue;
        const o = outer[i];
        if (!o || stubs.has(key(o.x, o.z)) || !parapetAt.has(key(o.x, o.z)) && par) continue;
        if (par && st.crenels && (i & 1) === 0) continue; // a merlon: the gap beside it
        const y = par ? top[i] + 2 : top[i] + 3;
        lamps.push([o.x, y, o.z, light]);
        used.add(i);
        break;
      }
    }
  }
  {
    const light = fixture.kind === 'hanging_lantern' ? fixture.light.replace('hanging=true', 'hanging=false') : fixture.light;
    for (const [x, y, z] of flightLamps) lamps.push([x, y, z, light]);
  }
  // ---- resolve the parapet's, merlons' and rails' connections
  const rails = new Set(railCells.map(([x, y, z]) => `${x},${y},${z}`));
  const pars = new Set(parCells.map(([x, y, z]) => `${x},${y},${z}`));
  const merlons = new Set(parCells.filter(([x, y, z]) => E.get(x, y + 1, z) === '#merlon').map(([x, y, z]) => `${x},${y + 1},${z}`));
  const merlonAt = (x, y, z) => merlons.has(`${x},${y},${z}`);
  for (const [x, y, z] of parCells) {
    if (!par) continue;
    const j = (dx, dz) => pars.has(`${x + dx},${y},${z + dz}`) || rails.has(`${x + dx},${y},${z + dz}`);
    put(x, y, z, wallState(par.block, { n: j(0, -1), s: j(0, 1), e: j(1, 0), w: j(-1, 0) }));
    if (merlonAt(x, y + 1, z)) { const m = (dx, dz) => merlonAt(x + dx, y + 1, z + dz); put(x, y + 1, z, wallState(par.block, { n: m(0, -1), s: m(0, 1), e: m(1, 0), w: m(-1, 0) })); }
  }
  for (const [x, y, z] of railCells) {
    const j = (dx, dz) => rails.has(`${x + dx},${y},${z + dz}`) || pars.has(`${x + dx},${y},${z + dz}`);
    const c = { n: j(0, -1), s: j(0, 1), e: j(1, 0), w: j(-1, 0) };
    put(x, y, z, railWall ? wallState(railWall, c) : fenceState(railFence, c));
  }
  // ---- the graph: a node per access, an edge per run between neighbouring accesses (player only)
  const order = [...accesses].sort((a, b) => a.top - b.top);
  const nodes = order.map((a, q) => ({ id: `access:${W.id}_${q + 1}`.slice(0, 64), at: [inner[a.top].x, feet(a.top), inner[a.top].z], kind: a.kind, foot: a.foot, top: a.top }));
  const edges = [];
  for (let q = 0; q + 1 < nodes.length || (W.closed && nodes.length > 1 && q < nodes.length); q++) {
    const a = nodes[q], b = nodes[(q + 1) % nodes.length];
    if (a === b) break;
    edges.push({ id: `walk:${W.id}_${q + 1}`.slice(0, 64), from: a.id, to: b.id, length: W.closed ? ((b.top - a.top + n) % n || n) : b.top - a.top });
    if (!W.closed && q + 2 >= nodes.length) break;
  }
  if (!W.closed && W.ends.length) notes.push(`walk: its free end${W.ends.length > 1 ? 's' : ''} closed by a rail across the walk`);
  const walkMeta = {
    width: wk.width, access: wk.access, every: wk.every,
    cells: walkCells.map(([x, y, z, i]) => [x, y, z, i]), parapet: parCells, rails: railCells, corbels,
    accesses: accesses.map((a) => ({ kind: a.kind, why: a.why, top: a.top, foot: a.foot, ...(a.kind === 'stair' ? { steps: a.steps.map((s) => [s.x, s.y, s.z]), rail: a.steps.slice(1).map((s) => [s.rail[0], s.y + 1, s.rail[1]]) } : { cells: [a.x, a.y0, a.z, a.y1] }), at: [inner[a.top].x, feet(a.top), inner[a.top].z] })),
    lamps: lamps.map(([x, y, z]) => [x, y, z]), parapetWall: !!par,
  };
  return {
    meta: walkMeta, nodes, edges, notes, lamps,
    geometry: { width: wk.width, runs: edges.length, accesses: accesses.map((a) => ({ kind: a.kind, at: [inner[a.top].x, feet(a.top), inner[a.top].z] })), cells: walkCells.length, rail: railCells.length },
  };
}
