// (7a LF) The lift's geometry (docs/CONTRACT.md "Phase 7a slice LF" §2): a bubble column against a face, contained by two layers on
// every open side, entered through a two-door airlock at its foot and left over a railed rim at the face's top. Pure: integer math, no
// random number; the land is the caller's (the route row's over the pass's survey and volumes, or a demo's surveyLand).
//
// Coordinates: the approach walk cell `a` = [x, y0, z] (the surface block; feet one over) and the heading `dir` toward the face (cardinal).
// A cell of the tower is (t, v): t rows along the heading from a (1 the outer layer, 2 the inner layer, 3 the shaft row, 4 the face's first
// row, 5 its second), v lanes across it (rightOf(dir) positive). The up shaft stands at v = 0; with `down`, the down shaft at v = 2s (s = +1
// on the right, -1 on the left), the layer between them (v = s) shared:
//
//      t=5  .  .  F  .  .               F  face (natural where site-solid, else written as shell); the top walk cell (4, v) at yT
//      t=4  .  F  F  F  .               S  the shaft: the base (soul sand, a down shaft's magma) at y0, bubble_column y0+1..yT (level with the face's top), open over it
//      t=3  o  i  S  i  o               i  the inner layer (the shaft's shell); o the outer layer
//      t=2  o  o  D  o  o               D  the airlock's doors: the inner (t=2) and the outer (t=1) door, y0+1 (lower) and y0+2 (upper)
//      t=1  o  o  D  o  o
//      t=0        a                     a  the approach walk cell (the route's)
//          -2 -1  0 +1 +2
//
// (The column's top is level with the face's top: a rider the column lifts clears the top walk cell's block and steps onto it; the ride
// probe measured a lift of under a block over a column's top.)
// Every tower cell from y0 to yT + 1 is written: the plinth course at y0 (the base role), the layers y0+1..yT (the shell role), the cap
// course at yT + 1 (the cap role: the rim) round the open shaft top; under a column standing lower than y0 the base role fills down to its ground
// (at most LIFT.fillMax). Two layers on every open side mean a single breach reaches nothing outside (H §2.5 by construction). The face
// side's two cells behind each shaft, (4, v) and (5, v), and the cells beside the first, (4, v +- 1), are written as shell at every y the
// water stands wherever the plan may write; a site-solid cell it may not write stays natural; anything else is ANCHOR. The rim at yT + 1 is railed (the rail role at yT + 2) on the shaft's three open
// sides and round the roof's open edges; the face side is the exit. Lights: the light role's niche block in the inner layer every
// LIFT.lightEvery up (so no shaft cell is at block light 0: drowned), two by the outer door at y0 + 2, one on a rail post at the top.
import { rightOf, SITE_SOLID } from './ropeGeom.mjs';
import { joinedState, splitState } from './climbGeom.mjs';
import { doorOf, shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor, lightLevel } from '../region/fixtures.mjs';
import { BLOCKS } from '../blocks.mjs';

/** The lift's numbers (§1, §2, §3). */
export const LIFT = Object.freeze({
  riseMin: 4, riseMax: 64, approach: 16, approachMax: 32, fillMax: 6, lightEvery: 6, headroom: 3,
  /** route row 9's cost (§3): base + per a cell of rise (+ down). */
  cost: 300, costPer: 10, costDown: 100,
  /** `fail`'s candidate rises (beyond the limits, so SPAN can be named). */
  diagMax: 96,
});
/** §3's refusal order. */
export const LIFT_ORDER = Object.freeze(['NO_CLIMB', 'SPAN', 'ANCHOR', 'HEADROOM', 'WATER', 'PROTECTED']);
/** The bubble column states (26.3: drag=false carries up over soul sand, drag=true down over magma). */
export const BUBBLE = Object.freeze({ up: 'minecraft:bubble_column[drag=false]', down: 'minecraft:bubble_column[drag=true]' });
/** The column's bases (functional: the shared UNTHEMED_OK allowlist names them). */
export const BASE = Object.freeze({ up: 'minecraft:soul_sand', down: 'minecraft:magma_block' });
const OPEN = new Set(['AIR', 'PLANT']);
const UNWRITABLE = new Set(['WATER', 'LAVA', 'MISSING', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'OUTSIDE']);
const isInt = Number.isInteger;
const FACING = (dx, dz) => (dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north');

/** The tower's lanes (v) for `down` and its side: {shafts: [{v, kind}], lo, hi, mid}. */
export function liftLanes(down = false, side = 'right') {
  const s = side === 'left' ? -1 : 1;
  if (!down) return { shafts: [{ v: 0, kind: 'up' }], lo: -2, hi: 2, mid: null, s };
  return { shafts: [{ v: 0, kind: 'up' }, { v: 2 * s, kind: 'down' }], lo: s > 0 ? -2 : -4, hi: s > 0 ? 4 : 2, mid: s, s };
}

/**
 * The lights (theme): the light role's block for a niche in a wall (standing on the course under it): a lantern role's lantern standing,
 * a full emitter (sea lantern, glowstone, shroomlight, a froglight) flush, a torch standing; `shaft` the same block when it is
 * fluid-stopping (a shell cell must be: a torch is washed away, so a torch bible's shaft is unlit and noted); `post` the light W's
 * fixture sets on a rail post (fixtureFor). `level` the niche block's own light.
 */
export function liftLights(lightBlock, railBlock = 'minecraft:oak_fence') {
  const name = String(lightBlock ?? 'minecraft:lantern').replace(/\[.*$/, '');
  const fam = BLOCKS[name]?.family;
  let niche;
  if (fam === 'lantern') niche = `${name}[hanging=false,waterlogged=false]`;
  else if (fam === 'torch' || fam === 'wall_torch') niche = name.replace('_wall_torch', '_torch').replace('minecraft:wall_torch', 'minecraft:torch');
  else niche = fixtureFor(name, railBlock).light;
  const nb = splitState(niche).name;
  const fs = !!BLOCKS[nb]?.fs && lightLevel(niche) > 0;
  const post = fixtureFor(name, railBlock).light;
  return { niche, shaft: fs ? niche : null, post, level: lightLevel(niche) || 0 };
}

/**
 * The roles a lift writes (§2; connectors.lift {shell, base, door, cap}): `shell` the layers and written face cells (structure, then
 * foundation, then wall), `base` the plinth course and the fill under it (foundation, then structure), `cap` the roof course (trim, then
 * the shell's), `door` the frame's wood family's door (K1's door rule: the gate's frame, else trim), `rail` the rail role's fence (else the
 * frame's), `light` the light role. Each is a block state from r.material; the caller's connectorRoles names the slots.
 */
export function liftRoles(r) {
  const roles = r.roles ?? {}, cr = r.ctx?.connectors?.lift ?? {};
  const has = (n) => !!n && Object.prototype.hasOwnProperty.call(roles, n);
  const slot = (name) => (has(cr[name]) ? cr[name] : null);
  const pick = (s, chain, fallback) => slot(s) ?? chain.find(has) ?? fallback;
  const shellRole = pick('shell', ['structure', 'foundation', 'wall'], 'structure');
  const baseRole = pick('base', ['foundation', 'structure'], shellRole);
  const capRole = pick('cap', ['trim'], shellRole);
  const frameRole = ['frame', 'trim', 'structure'].find(has) ?? shellRole;
  const railRole = ['rail', 'frame'].find(has) ?? null;
  return { shell: shellRole, base: baseRole, cap: capRole, frame: frameRole, rail: railRole, door: slot('door'), light: has('light') ? 'light' : null };
}

/** The blocks of a region's lift (liftRoles through r.material). */
export function liftMats(r) {
  const R = liftRoles(r);
  return liftBlocks((n) => r.material(n, `lift ${n}`), R);
}

/**
 * The lift's blocks from its roles (`mat(role)` -> state): {shell, plinth, cap, door (name), rail (a fence name), lights}. A shell, plinth
 * or cap role that is not a full fluid-stopping, non-gravity block falls back to the shell's (then stone bricks, the plan default's
 * structure: never reached with the built-in roles).
 */
export function liftBlocks(mat, R) {
  const plain = (s) => String(s).replace(/\[.*$/, '');
  const sturdy = (s) => { const b = BLOCKS[plain(s)]; return !!b && b.collision === 'full' && !!b.fs && !b.g; };
  const shell = sturdy(mat(R.shell)) ? mat(R.shell) : 'minecraft:stone_bricks';
  const plinth = sturdy(mat(R.base)) ? mat(R.base) : shell;
  const cap = sturdy(mat(R.cap)) ? mat(R.cap) : shell;
  const frame = mat(R.frame);
  const door = R.door ? (shapeOf(mat(R.door), 'door') ?? doorOf(frame)) : doorOf(frame);
  const railBase = R.rail ? mat(R.rail) : frame;
  const rail = shapeOf(plain(railBase), 'fence') ?? (BLOCKS[plain(railBase)]?.family === 'fence' ? plain(railBase) : 'minecraft:oak_fence');
  const lights = liftLights(R.light ? mat(R.light) : 'minecraft:lantern', rail);
  return { shell, plinth, cap, door: plain(door), rail, lights };
}

/**
 * The check of one lift (§2, §3) over `land` ({groundAt, topAt, waterAt, blocked(x, z) -> bool, classAt(x, y, z), kept?(x, y, z) -> body
 * | null, built?(x, z) -> bool (an earlier edge's column), inClaim?(x, z)}) from the approach walk cell `a` = [x, y0, z] toward `dir`.
 * `opts`: {down, side ('right' | 'left'), move ('up' | 'down': the route's lane past the top; default up), rise: {min, max}, _unsafe: {oneLayer, oneDoor, noLight}}. Returns `{ok: false, code, evidence}`
 * (§3's order: NO_CLIMB, SPAN, ANCHOR, HEADROOM, WATER, PROTECTED) or the geometry `{ok: true, y0, yT, rise, dir, side, down, lanes,
 * shafts: [{v, kind, col, base, cells (the bubble cells), top (the top walk cell, [x, yT, z]), approach ([x, y0, z]), doors}], cells:
 * [[x, y, z, kind, ...]] (the written cells, kinds: fill plinth base inner outer cap door face light lamp rail post clear), inner (the
 * shafts' shell: every face neighbour of a bubble cell, the rims at yT and the bases), outer (the second layer), faceNatural, footprint
 * ([[x, z]]: the tower's and the written face's columns), cost}`.
 */
export function checkLift(land, a, dir, opts = {}) {
  const [ax, y0, az] = a, [dx, dz] = dir;
  if (Math.abs(dx) + Math.abs(dz) !== 1) throw new Error('checkLift: dir must be cardinal');
  const [rx, rz] = rightOf(dir);
  const at = (t, v) => [ax + dx * t + rx * v, az + dz * t + rz * v];
  const unsafe = opts._unsafe ?? {};
  const down = !!opts.down;
  const side = opts.side === 'left' ? 'left' : 'right';
  const L = liftLanes(down, side);
  const rmin = Math.max(LIFT.riseMin, isInt(opts.rise?.min) ? opts.rise.min : LIFT.riseMin);
  const rmax = Math.min(LIFT.riseMax, isInt(opts.rise?.max) ? opts.rise.max : LIFT.riseMax);
  const [fx, fz] = at(4, 0);
  const yT = land.groundAt(fx, fz);
  const rise = yT - y0;
  const base = { y0, yT, rise, dir: [dx, dz], side, down };
  const fail = (code, evidence) => ({ ok: false, code, evidence: { rise, ...evidence }, ...base });
  // NO_CLIMB: the face rises less than 4 within one cell of the shaft (over the approach, and over the shaft's own column)
  const [sx0, sz0] = at(3, 0);
  if (rise < LIFT.riseMin || yT - land.groundAt(sx0, sz0) < LIFT.riseMin) return fail('NO_CLIMB', { need: LIFT.riseMin, at: [fx, yT, fz], face: yT - land.groundAt(sx0, sz0) });
  if (rise < rmin || rise > rmax) return fail('SPAN', { min: rmin, max: rmax });
  const solid = (x, y, z) => SITE_SOLID.includes(land.classAt(x, y, z));
  const writable = (x, y, z) => !land.blocked(x, z) && !(land.inClaim && !land.inClaim(x, z)) && !UNWRITABLE.has(land.classAt(x, y, z)) && !land.kept?.(x, y, z) && !land.built?.(x, z);
  // ---- ANCHOR: the face side of every shaft (the two cells behind it, the cells beside the first) site-solid or writable
  const routeV = opts.move === 'down' && down ? 2 * L.s : 0; // the lane whose (5, v) at yT is the route's walk cell
  const faceTops = new Map(); // "t,v" -> the top y the face cell must stand to
  for (const sh of L.shafts) {
    faceTops.set(`4,${sh.v}`, yT);
    // (the route's walk cell past the top, (5, v) at yT, on the lane it moves on: up lands past the up shaft's top, down starts past the
    // down shaft's; the ground or its surface holds a breach of (4, v) there. The other lane's is the face's, written to yT)
    faceTops.set(`5,${sh.v}`, sh.v === routeV ? yT - 1 : yT);
    for (const w of [sh.v - 1, sh.v + 1]) if (!faceTops.has(`4,${w}`)) faceTops.set(`4,${w}`, yT);
  }
  const faceNatural = [], faceWritten = [], weak = [];
  for (const [key, top] of [...faceTops].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))) {
    const [t, v] = key.split(',').map(Number);
    const [x, z] = at(t, v);
    const g = land.groundAt(x, z);
    const from = Math.min(y0 + 1, g + 1);
    if (y0 - g > LIFT.fillMax) { weak.push({ at: [x, g, z], why: 'deep', depth: y0 - g }); continue; }
    for (let y = from; y <= top; y++) {
      // (written as shell wherever the plan may write: the natural face's 2.5D reading can't see a cave or an overhang behind it, and the
      // fluids stage's gate refuses a body whose shell does not hold (lf-natural's first run: 18 cells); a site-solid cell the plan may
      // not write stays natural, judged by the gate at realise; anything else is ANCHOR)
      if (writable(x, y, z)) { faceWritten.push([x, y, z]); continue; }
      if (solid(x, y, z)) { if (y > y0) faceNatural.push([x, y, z]); continue; }
      weak.push({ at: [x, y, z], class: land.classAt(x, y, z) });
    }
  }
  if (weak.length) return fail('ANCHOR', { why: 'face', cells: weak.slice(0, 12), count: weak.length });
  // the tower's columns: their ground (a column under y0 is filled to it, at most fillMax)
  const tower = [];
  for (let t = 1; t <= 3; t++) for (let v = L.lo; v <= L.hi; v++) tower.push([t, v]);
  const deep = [];
  for (const [t, v] of tower) { const [x, z] = at(t, v); const g = land.groundAt(x, z); if (y0 - g > LIFT.fillMax) deep.push({ at: [x, g, z], depth: y0 - g }); }
  if (deep.length) return fail('ANCHOR', { why: 'foot', columns: deep.slice(0, 12), count: deep.length, fillMax: LIFT.fillMax });
  // ---- HEADROOM: 3 clear over every shaft's top (yT + 1 .. yT + 3), 2 over the top walk cells (no overhang, no trunk)
  const meets = [];
  for (const sh of L.shafts) {
    const [sx, sz] = at(3, sh.v), [tx, tz] = at(4, sh.v);
    for (const [x, z, y1, y2, what] of [[sx, sz, yT + 1, yT + LIFT.headroom, 'shaft'], [tx, tz, yT + 1, yT + 2, 'top']]) {
      if (land.topAt(x, z) > land.groundAt(x, z) && land.topAt(x, z) >= y1) { meets.push({ at: [x, y1, z], why: 'tree', what }); continue; }
      for (let y = y1; y <= y2; y++) {
        if (what === 'shaft' && y <= land.groundAt(x, z)) continue; // (the shaft's own column is cleared to yT: the land's ground there is the tower's)
        const c = land.classAt(x, y, z);
        if (!OPEN.has(c)) { meets.push({ at: [x, y, z], class: c, what, clear: y - y1 }); break; }
      }
    }
    // the down shaft's top walk cell: no higher than the up shaft's (its rim is yT)
    if (sh.kind === 'down' && land.groundAt(tx, tz) > yT) meets.push({ at: [tx, land.groundAt(tx, tz), tz], what: 'top', why: 'higher' });
  }
  // (the roof: no land over the tower's top course)
  for (const [t, v] of tower) { const [x, z] = at(t, v); if (land.groundAt(x, z) > yT) meets.push({ at: [x, land.groundAt(x, z), z], what: 'roof', why: 'land' }); }
  if (meets.length) return fail('HEADROOM', { cells: meets.slice(0, 12), count: meets.length, need: LIFT.headroom });
  // ---- WATER: no tower or written face column over water, nor the approaches
  const cols = new Map();
  const addCol = (x, z) => cols.set(`${x},${z}`, [x, z]);
  for (const [t, v] of tower) addCol(...at(t, v));
  for (const [x, , z] of faceWritten) addCol(x, z);
  const footprint = [...cols.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const approaches = L.shafts.map((sh) => at(0, sh.v));
  const wet = [...footprint, ...approaches].filter(([x, z]) => land.waterAt(x, z));
  if (wet.length) return fail('WATER', { columns: wet.slice(0, 12), count: wet.length });
  // ---- PROTECTED: keep-out, builds, other regions, lot boxes and aprons, walls, the claim margin, an earlier route's columns, a body's cells
  const prot = footprint.filter(([x, z]) => land.blocked(x, z) || (land.inClaim && !land.inClaim(x, z)) || land.built?.(x, z));
  const body = [];
  if (land.kept) for (const [x, z] of footprint) for (let y = Math.min(y0, land.groundAt(x, z)) - 1; y <= yT + 3; y++) { const k = land.kept(x, y, z); if (k) { body.push({ at: [x, y, z], body: k.body ?? k }); break; } }
  if (prot.length || body.length) return fail('PROTECTED', { columns: prot.slice(0, 12), count: prot.length, ...(body.length ? { kind: 'body', bodies: body.slice(0, 12) } : {}) });
  // ---- the down column's foot: the approach row from beside the up approach to the down shaft's own (0, s) .. (0, 2s), walkable at y0
  // (its ground filled up to y0, at most fillMax; 2 clear over it): a down rider leaves the airlock onto it (lf-natural: the natural
  // down approach a step over the foot, the rider stuck in the outer door). On land already level, nothing is written.
  const apron = [];
  if (down) {
    for (const v of [L.s, 2 * L.s]) {
      const [x, z] = at(0, v);
      const g = land.groundAt(x, z);
      if (y0 - g > LIFT.fillMax) return fail('ANCHOR', { why: 'foot', columns: [{ at: [x, g, z], depth: y0 - g }], count: 1, fillMax: LIFT.fillMax });
      if (land.waterAt(x, z)) return fail('WATER', { columns: [[x, z]], count: 1 });
      const fill = [], clear = [];
      for (let y = g + 1; y <= y0; y++) fill.push(y);
      for (let y = y0 + 1; y <= y0 + 2; y++) if (!OPEN.has(land.classAt(x, y, z))) clear.push(y);
      if ((fill.length || clear.length) && ([...fill, ...clear].some((y) => !writable(x, y, z)))) return fail('PROTECTED', { columns: [[x, z]], count: 1, why: 'foot' });
      apron.push({ x, z, fill, clear });
    }
  }
  // ---- the cells
  const out = [];
  const put = (x, y, z, kind, ...extra) => out.push([x, y, z, kind, ...extra]);
  const shaftCol = new Map(L.shafts.map((sh) => [`3,${sh.v}`, sh]));
  const doorAt = new Map();
  for (const sh of L.shafts) for (const t of [1, 2]) if (!(unsafe.oneDoor && t === 1)) doorAt.set(`${t},${sh.v}`, sh);
  const outerLayer = (t, v) => t === 1 || v === L.lo || v === L.hi;
  const shaftV = (v) => L.shafts.some((q) => q.v === v);
  const oneLayer = !!unsafe.oneLayer;
  // the inner layer: every tower cell face-adjacent to a shaft cell (rows 2 and 3 beside it), the mid layer both shafts'
  const innerTV = new Set();
  for (const sh of L.shafts) for (const [t, v] of [[2, sh.v], [3, sh.v - 1], [3, sh.v + 1]]) innerTV.add(`${t},${v}`);
  const shafts = [];
  for (const sh of L.shafts) {
    const [sx, sz] = at(3, sh.v), [tx, tz] = at(4, sh.v), [ox, oz] = at(0, sh.v);
    shafts.push({ v: sh.v, kind: sh.kind, col: [sx, sz], base: [sx, y0, sz], cells: Array.from({ length: rise }, (_, k) => [sx, y0 + 1 + k, sz]), top: [tx, yT, tz], approach: [ox, y0, oz],
      doors: [1, 2].map((t) => at(t, sh.v)) });
  }
  const lightSide = (sh) => (L.mid === null ? null : -L.s * (sh.kind === 'up' ? 1 : -1)); // (the outer side of each shaft: never the shared layer)
  const lightCells = new Map();
  if (!unsafe.noLight) {
    for (const sh of L.shafts) {
      let k = 0;
      for (let y = y0 + 3; y <= yT; y += LIFT.lightEvery, k++) {
        const w = lightSide(sh) ?? (k % 2 === 0 ? -1 : 1);
        lightCells.set(`3,${sh.v + w},${y}`, true);
      }
    }
  }
  const footLights = new Set();
  if (!unsafe.noLight) for (const sh of L.shafts) for (const w of [-1, 1]) { const v = sh.v + w; if (!L.shafts.some((q) => q.v === v)) footLights.add(`1,${v}`); }
  const inner = [], outer = [];
  for (const [t, v] of tower) {
    const [x, z] = at(t, v);
    const g = land.groundAt(x, z);
    for (let y = g + 1; y < y0; y++) put(x, y, z, 'fill');
    const sh = shaftCol.get(`${t},${v}`);
    if (sh) {
      put(x, y0, z, 'base', sh.kind);
      inner.push([x, y0, z]);
      // the shaft's own column cleared (the land in it) from y0 + 1 to the top's head room; the fluids stage writes its bubble cells
      for (let y = y0 + 1; y <= yT + LIFT.headroom; y++) if (land.classAt(x, y, z) !== 'AIR') put(x, y, z, 'clear');
      continue;
    }
    const isOuter = outerLayer(t, v) && !innerTV.has(`${t},${v}`);
    if (oneLayer && isOuter) {
      // (the broken variant: one layer; the outer cells left as the land was: the single breach reaches outside)
      put(x, y0, z, 'plinth');
      continue;
    }
    put(x, y0, z, 'plinth');
    const dsh = doorAt.get(`${t},${v}`);
    for (let y = y0 + 1; y <= yT; y++) {
      if (dsh && (y === y0 + 1 || y === y0 + 2)) { put(x, y, z, 'door', y === y0 + 1 ? 'lower' : 'upper', FACING(dx, dz)); (innerTV.has(`${t},${v}`) ? inner : outer).push([x, y, z]); continue; }
      // (the broken variant oneDoor: the outer door's cells an open doorway)
      if (unsafe.oneDoor && t === 1 && shaftV(v) && (y === y0 + 1 || y === y0 + 2)) { put(x, y, z, 'clear'); continue; }
      if (lightCells.has(`${t},${v},${y}`)) { put(x, y, z, 'light'); inner.push([x, y, z]); continue; }
      if (t === 1 && y === y0 + 2 && footLights.has(`${t},${v}`)) { put(x, y, z, 'lamp'); outer.push([x, y, z]); continue; }
      put(x, y, z, innerTV.has(`${t},${v}`) ? 'inner' : 'outer');
      (innerTV.has(`${t},${v}`) ? inner : outer).push([x, y, z]);
    }
    put(x, yT + 1, z, 'cap');
    (innerTV.has(`${t},${v}`) ? inner : outer).push([x, yT + 1, z]);
    // (a column of the land standing over yT: left as it is; the roof's rail skips it)
  }
  // the down column's foot (above): filled to y0 (its top the plinth's), cleared 2 over
  for (const { x, z, fill, clear } of apron) {
    for (const y of fill) put(x, y, z, y === y0 ? 'plinth' : 'fill');
    for (const y of clear) put(x, y, z, 'clear');
  }
  // the written face cells (shell), the rest of the face natural
  for (const [x, y, z] of faceWritten) put(x, y, z, 'face');
  // the rails at yT + 2 (on the rim, the cap course): round the shafts' open tops (but the face side) and along the roof's open edges
  const roofSet = new Set(tower.filter(([t, v]) => !shaftCol.has(`${t},${v}`)).map(([t, v]) => at(t, v).join(',')));
  const holeSet = new Set(L.shafts.map((sh) => at(3, sh.v).join(',')));
  const faceTopAt = (x, z) => {
    const w = faceWritten.some((c) => c[0] === x && c[2] === z && c[1] >= yT) ? yT : -Infinity;
    return Math.max(land.groundAt(x, z), w);
  };
  const rails = [];
  if (!unsafe.noRails) {
    for (const [t, v] of tower) {
      if (shaftCol.has(`${t},${v}`)) continue;
      const [x, z] = at(t, v);
      if (land.groundAt(x, z) > yT || !OPEN.has(land.classAt(x, yT + 2, z))) continue;
      let edge = false;
      for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ex, nz = z + ez, nk = `${nx},${nz}`;
        if (holeSet.has(nk)) { edge = true; break; }
        if (roofSet.has(nk)) continue;
        // (a drop of 2 or more from the roof's surface at yT + 2: the face's top beside it is a step of 1)
        if (faceTopAt(nx, nz) < yT) { edge = true; break; }
      }
      if (edge) rails.push([x, yT + 2, z]);
    }
  }
  for (const [x, y, z] of rails) put(x, y, z, 'rail');
  // the top lamp: on the rail post at the outer row's corner (the first one railed), at yT + 3
  if (!unsafe.noLight) {
    const corners = [at(1, L.lo), at(1, L.hi)];
    const post = corners.find(([x, z]) => rails.some((q) => q[0] === x && q[2] === z)) ?? null;
    if (post) put(post[0], yT + 3, post[1], 'lamp');
  }
  const cost = LIFT.cost + LIFT.costPer * rise + (down ? LIFT.costDown : 0);
  return { ok: true, ...base, lanes: L, shafts, cells: out, inner, outer, faceNatural, faceWritten, footprint, rails, cost };
}

/**
 * A lift's land over a survey (route row 9's reading, for a region program that routes and writes its own lifts): the ground plus a
 * program's `base` (a grid {minX, minZ, width, depth, values}: a cliff raised in stage `ground` is land to the lift as to the route pass),
 * soil to 3 under it, rock below, water down to the ground, air above; `blocked(x, z)` the caller's; trees 64 high.
 */
export function surveyLiftLand(S, { base = null, blocked = () => false, claim = null } = {}) {
  const b = (x, z) => {
    if (!base) return 0;
    const i = x - base.minX, j = z - base.minZ;
    return i >= 0 && j >= 0 && i < base.width && j < base.depth ? base.values[i + j * base.width] : 0;
  };
  const groundAt = (x, z) => S.groundAt(x, z) + b(x, z);
  const classAt = (x, y, z) => {
    if (S.missingAt?.(x, z)) return 'MISSING';
    const g = groundAt(x, z);
    if (y > g) return 'AIR';
    if (S.waterAt(x, z) && !b(x, z)) return S.frozenAt?.(x, z) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const topAt = (x, z) => (S.topAt(x, z) > S.groundAt(x, z) ? groundAt(x, z) + 64 : groundAt(x, z));
  const inClaim = claim ? (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ : null;
  return { groundAt, topAt, waterAt: (x, z) => S.waterAt(x, z) && !b(x, z), blocked, classAt, ...(inClaim ? { inClaim } : {}) };
}

/**
 * Write a lift (§2) into `r`: the tower (its links part, every cell ALWAYS_OURS) and its body (r.fluidBody: the bubble cells, the shell
 * declared, the outer layer and the natural face as the flow's solids, no frozen volume). `g`: checkLift's geometry. `opts`: {part
 * ('links_l<i>'), stage, bodyId, planPart, mats (liftBlocks), id, edge, movers, _unsafe}. Returns the record (also r.meta.lifts) with
 * the body's record and the cost.bom of the written cells (the bubble cells are water: free).
 */
export function writeLift(r, g, opts = {}) {
  const M = opts.mats;
  const part = opts.part ?? 'links';
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage: opts.stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const own = new Map();
  const stateAt = (c) => {
    const [, , , kind, a1, a2] = c;
    if (kind === 'fill' || kind === 'plinth') return M.plinth;
    if (kind === 'base') return BASE[a1];
    if (kind === 'inner' || kind === 'outer' || kind === 'face') return M.shell;
    if (kind === 'cap') return M.cap;
    if (kind === 'door') return `${M.door}[facing=${a2},half=${a1},hinge=left,open=false,powered=false]`;
    if (kind === 'light') return M.lights.shaft;
    if (kind === 'lamp') return c[1] > g.yT ? M.lights.post : M.lights.niche;
    if (kind === 'rail') return M.rail;
    if (kind === 'clear') return null;
    throw new Error(`writeLift: unknown cell kind ${kind}`);
  };
  const cells = [];
  for (const c of g.cells) {
    let s = stateAt(c);
    // (a torch bible: no fluid-stopping niche light; the inner cell stays shell, noted in the record)
    if (c[3] === 'light' && !s) s = M.shell;
    own.set(`${c[0]},${c[1]},${c[2]}`, s);
    cells.push([c[0], c[1], c[2], s, c[3]]);
  }
  // fences joined to their neighbours (kit.mjs finalize's rule): the lift's own cells, the land's cubes
  const CUBE = { name: 'minecraft:stone', props: {} };
  const sturdy = opts.sturdy ?? (() => false);
  const nameAt = (x, y, z) => { const k = `${x},${y},${z}`; if (own.has(k)) { const s = own.get(k); return s === null ? null : splitState(s); } return sturdy(x, y, z) ? CUBE : null; };
  for (const c of cells) if (c[4] === 'rail') c[3] = joinedState(c[3], c[0], c[1], c[2], nameAt);
  const mats = [], idx = new Map();
  const mi = (s) => { const k = s ?? 'air'; if (!idx.has(k)) { idx.set(k, mats.length); mats.push(s); } return idx.get(k); };
  const cols = [];
  for (const c of cells) cols.push(c[0], c[2], c[1], c[1], mi(c[3]));
  if (cols.length) p.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: 3 });
  const bom = bomOf(cells.filter((c) => c[3] !== null).map((c) => c[3]));
  // the body: the bubble cells (sources), its shell (declared; the generator wrote it), the outer layer and the natural face as solids
  const bubble = g.shafts.map((sh) => ({ drag: sh.kind === 'down', cells: sh.cells }));
  const allCells = g.shafts.flatMap((sh) => sh.cells);
  const solids = [...g.outer, ...g.faceNatural, ...g.faceWritten];
  const body = r.fluidBody(allCells, { id: opts.bodyId, part: opts.planPart ?? null, kind: 'lift', fluid: 'water', level: g.yT, shellRole: null, stage: opts.stage, solid: solids, volume: false, bubble,
    // (the exit: the cell over the top walk cell, beside the column's open top, is where a rider leaves; no flow rises there)
    outlets: g.shafts.map((sh) => [sh.top[0], g.yT + 1, sh.top[2]]),
    ...(opts._unsafe?.predictShort ? { _unsafe: { predictShort: true } } : {}) });
  const id = opts.id ?? `lift_${(r.meta.lifts?.length ?? 0) + 1}`;
  const up = g.shafts.find((sh) => sh.kind === 'up'), dn = g.shafts.find((sh) => sh.kind === 'down') ?? null;
  const rec = {
    id, kind: 'lift', part: p.id, stage: p.stage, body: body.id, planPart: opts.planPart ?? null, edge: opts.edge ?? null,
    foot: [...up.approach], top: [...up.top], rise: g.rise, down: g.down, side: g.side, dir: [...g.dir], y0: g.y0, yT: g.yT,
    shafts: g.shafts.map((sh) => ({ kind: sh.kind, col: [...sh.col], base: [...sh.base], top: [...sh.top], approach: [...sh.approach], doors: sh.doors.map((d) => [...d]), bubble: sh.cells.length })),
    lights: g.cells.filter((c) => c[3] === 'light').map((c) => [c[0], c[1], c[2]]), lamps: g.cells.filter((c) => c[3] === 'lamp').map((c) => [c[0], c[1], c[2]]),
    rails: g.rails.map((c) => [...c]), footprint: g.footprint.map((c) => [...c]), faceWritten: g.faceWritten.length, faceNatural: g.faceNatural.length,
    inner: g.inner.length, outer: g.outer.length, shaftLit: !!M.lights.shaft, shell: M.shell, cap: M.cap, door: M.door, rail: M.rail, light: M.lights.niche, bom,
    ...(dn ? { downTop: [...dn.top], downFoot: [...dn.approach] } : {}),
    ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(opts._unsafe && Object.keys(opts._unsafe).length ? { _unsafe: { ...opts._unsafe } } : {}),
  };
  (r.meta.lifts ??= []).push(rec);
  return { rec, body, bom, cells };
}
