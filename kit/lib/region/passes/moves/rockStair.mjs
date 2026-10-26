// (7a RK) Route row 11, `rock_stair` (docs/CONTRACT.md "Phase 7a slice RK" §4; the foundation's §3.2): a straight stair flight carved or
// bored into rising ground, opt-in per edge (`spans` includes 'rock_stair'; a rock stair edge `once: 'rock_stair'`, which uses exactly
// one flight and walks at most `approach` at each end). From a walk cell on a cardinal heading, flights of rise 2..48 (or the edge's
// `rise`) up, then down, in ascending rise, landing on a walk cell at y ± rise at the flight's end (its ground within the walk's cut
// or fill of that y). A candidate is tried only inside a frozen volume the plan holds and only when the survey keeps every tread on
// ground (a tread over air is ANCHOR whatever the rock says); the full check is connectors/rockStairGeom.mjs's (memoised per edge).
// Cost 400 + 40 a step + 30 a landing cell. A rock stair edge with no route answers why (`fail`): over the cells its search reached,
// every flight landing within `approach` of the goal; the candidate that got furthest through §4's order (NO_CLIMB, SPAN, ANCHOR,
// WATER, PROTECTED, VOLUME) nearest the goal names it; UNREACHABLE when one passes. Under the realise lint (integer math only).
//
// The interface (the foundation's): rockStairInit, rockStairActive, rockStairNeedsFlag, rockStairBlocks, rockStairExpand, rockStairCells,
// rockStairCommit, rockStairFail; the edge's options in `edge.t7.rock_stair` ({part, width, height, landing, lining, portal, rise: {min,
// max}, _unsafe}), the pass-level input in `intent.rockStair` ({volumes, parts: {id: {status, volume}}, classes, written, kept}).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../../pack.mjs';
import { ROCK, ROCK_ORDER, flightCost, flightLength, flightProfile, rockStairGeom } from '../../../connectors/rockStairGeom.mjs';
import { tunnelLand } from '../../../connectors/tunnelGeom.mjs';
import { latOn, rightOf } from '../../../connectors/ropeGeom.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../../volume.mjs';

const NONE = -32768;
const FP = 16;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;
const onceOf = (edge) => (typeof edge?.once === 'string' ? edge.once : edge?.spanOnce ? 'rope' : null);
/** T2 fills this many cells under a walk surface: a route's lowest written cell is its surface minus this. */
const ROUTE_FILL = 3;
const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };
const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };

/** The pass-level state from the intent and its edges, or null when no edge asks for rock stairs (full resolution only). */
export function rockStairInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('rock_stair'))) return null;
  const { W, D, minX, minZ, flags } = env, G = env.G, n = W * D;
  const blocked = new Uint8Array(n);
  const rect = (b, v) => {
    for (let z = Math.max(minZ, b[1]); z <= Math.min(minZ + D - 1, b[3]); z++) for (let x = Math.max(minX, b[0]); x <= Math.min(minX + W - 1, b[2]); x++) {
      const k = (x - minX) + (z - minZ) * W;
      if (!blocked[k]) blocked[k] = v;
    }
  };
  if (!intent._unsafe?.noKeepOut) for (const b of intent.keepOut ?? []) rect(b, 1);
  for (const b of intent.hard ?? []) rect(b, 2);
  const m = Math.max(0, intent.margin ?? 2);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if ((i < m || j < m || i >= W - m || j >= D - m) && !blocked[i + j * W]) blocked[i + j * W] = 3;
  for (let k = 0; k < n; k++) if (!blocked[k] && (flags[k] & FLAG_LAVA)) blocked[k] = 4;
  const CLASS = [null, 'KEEP_OUT', 'HARD', 'MARGIN', 'LAVA'];
  const rs = intent.rockStair ?? {};
  for (const q of Array.isArray(rs.classes) ? rs.classes : []) {
    if (!Array.isArray(q.rect)) continue;
    let ci = CLASS.indexOf(q.class);
    if (ci < 0) { CLASS.push(q.class); ci = CLASS.length - 1; }
    for (let z = Math.max(minZ, q.rect[1]); z <= Math.min(minZ + D - 1, q.rect[3]); z++) for (let x = Math.max(minX, q.rect[0]); x <= Math.min(minX + W - 1, q.rect[2]); x++) {
      const k = (x - minX) + (z - minZ) * W;
      if (blocked[k] === 1 || !blocked[k]) blocked[k] = ci;
    }
  }
  const walls = Array.isArray(intent.walls) ? intent.walls.filter((w) => w && Array.isArray(w.cells)) : [];
  const wallOf = new Map();
  walls.forEach((w) => { for (const c of w.cells) wallOf.set(`${c[0]},${c[1]}`, w); });
  const base = intent.base ?? null;
  const baseAt = (x, z) => {
    if (!base) return 0;
    const i = x - base.minX, j = z - base.minZ;
    return i >= 0 && j >= 0 && i < base.width && j < base.depth ? base.values[i + j * base.width] : 0;
  };
  const kOf = (x, z) => { const i = x - minX, j = z - minZ; return i < 0 || j < 0 || i >= W || j >= D ? -1 : i + j * W; };
  const S = {
    groundAt: (x, z) => { const k = kOf(x, z); return k < 0 ? 0 : G[k] - baseAt(x, z); },
    missingAt: (x, z) => { const k = kOf(x, z); return k < 0 || (flags[k] & FLAG_MISSING) !== 0; },
    waterAt: (x, z) => { const k = kOf(x, z); return k >= 0 && (flags[k] & FLAG_WATER) !== 0; },
    frozenAt: (x, z) => { const k = kOf(x, z); return k >= 0 && (flags[k] & FLAG_FROZEN) !== 0; },
    treeAt: (x, z) => { const k = kOf(x, z); return k >= 0 && (flags[k] & FLAG_TREE) !== 0; },
  };
  return {
    W, D, minX, minZ, G, flags, blocked, CLASS, wallOf, S, base, kOf, cur: null, grids: new Map(),
    volumes: Array.isArray(rs.volumes) ? rs.volumes.filter(Boolean) : [],
    parts: rs.parts && typeof rs.parts === 'object' ? rs.parts : {},
    written: Array.isArray(rs.written) ? rs.written : [],
    kept: Array.isArray(rs.kept) ? rs.kept : null,
  };
}

/** Whether an edge searches with the rock stair move; sets the edge's own options for its search. */
export function rockStairActive(state, edge) {
  if (!state) return false;
  const on = Array.isArray(edge?.spans) && edge.spans.includes('rock_stair');
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const t = edge.t7?.rock_stair ?? {};
  const once = onceOf(edge) === 'rock_stair';
  const rise = t.rise && typeof t.rise === 'object' ? t.rise : {};
  state.cur = {
    once, width: isInt(t.width) ? t.width : isInt(edge.width) && edge.width <= ROCK.widthMax ? edge.width : ROCK.width,
    height: isInt(t.height) ? t.height : ROCK.height, landing: isInt(t.landing) ? t.landing : ROCK.landing,
    lining: t.lining ?? 'exposed', portal: t.portal ?? 'arch', unsafe: t._unsafe ?? null, part: t.part ?? null,
    rMin: Math.max(ROCK.riseMin, isInt(rise.min) ? rise.min : ROCK.riseMin), rMax: Math.min(ROCK.riseMax, isInt(rise.max) ? rise.max : ROCK.riseMax),
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= ROCK.approachMax ? edge.approach : ROCK.approach,
    // no flight to search: an explicit part whose corridor holds no volume (the check's first plan, chunks not read, past a cap)
    idle: !!t.part && !!state.parts[t.part] && !state.parts[t.part].volume,
    startK: kOf(edge.from), goalK: kOf(edge.to), reached: once ? new Int32Array(state.W * state.D) : null,
    memo: new Map(), fast: new Map(), builtY: null, land: null,
  };
  return true;
}

/** Whether an edge's goal needs the flag bit set (a rock stair edge: exactly one flight). */
export function rockStairNeedsFlag(state, edge) {
  return !!state && onceOf(edge) === 'rock_stair';
}

/** No cell is a hard obstacle to the other moves (a flight is carved, not standing, until it is built). */
export const rockStairBlocks = () => null;

/** The land for one edge's checks (rockStairGeom's), over the pass's survey, volumes and obstacles, with the earlier edges' routes. */
function landOf(state) {
  const c = state.cur;
  if (c.land) return c.land;
  const { blocked, CLASS, kOf, wallOf, G } = state;
  c.land = tunnelLand(state.S, {
    volumes: state.volumes, base: state.base, classOfVolume: (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)], written: state.written, kept: state.kept,
    blocked: (x, z) => { const k = kOf(x, z); return k < 0 ? { class: 'OUTSIDE' } : blocked[k] ? { class: CLASS[blocked[k]] } : null; },
    routeLow: (x, z) => { const k = kOf(x, z); return k < 0 || !c.builtY || c.builtY[k] === NONE ? null : c.builtY[k] - ROUTE_FILL; },
    wallAt: (x, z) => { const w = wallOf.get(`${x},${z}`); if (!w) return null; const k = kOf(x, z); return { id: w.id, footing: (k < 0 ? 0 : G[k]) - 2 }; },
  });
  return c.land;
}

/** One candidate's full check (memoised per edge). */
function geomOf(state, x, y, z, hf, rise) {
  const c = state.cur, k = `${x},${y},${z},${hf},${rise}`;
  let g = c.memo.get(k);
  if (g === undefined) {
    const r = rockStairGeom(landOf(state), [x, y, z], DIRS[hf], rise, { width: c.width, height: c.height, landing: c.landing, lining: c.lining, portal: c.portal, rise: { min: c.rMin, max: c.rMax }, _unsafe: c.unsafe ?? undefined });
    g = r.ok ? { ok: true, cover: r.cover, bore: r.bore } : { ok: false, code: r.code, evidence: r.evidence };
    c.memo.set(k, g);
  }
  return g;
}

/**
 * The volume grids of one frozen volume over the pass's land (built once per pass, T3b's method): per cell its class (land.classAt, so a
 * plan's raised ridge reads ROCK), `near2` (a WATER, LAVA or ICE cell, or a plan body's cell, within 2, Chebyshev: the fluid buffer),
 * `prot1` (an OWNED, PLAYER or BLOCK_ENTITY cell at it or a face neighbour), `unk2` (an unknown cell within 2), `tree`, `solid` (site-solid,
 * or the plan's own written rock) and per column the prefix counts of solid cells (cover).
 */
function gridOf(state, v) {
  let g = state.grids.get(v);
  if (g) return g;
  const land = landOf(state);
  const b = v.box, H = b.maxY - b.minY + 1, D = b.maxZ - b.minZ + 1, n = (b.maxX - b.minX + 1) * H * D;
  const at = (x, y, z) => ((x - b.minX) * D + (z - b.minZ)) * H + (y - b.minY);
  const fluid = new Uint8Array(n), prot = new Uint8Array(n), unk = new Uint8Array(n), tree = new Uint8Array(n), solidC = new Uint8Array(n), solid = new Uint16Array((b.maxX - b.minX + 1) * D * (H + 1));
  const SOLID = new Set(['ROCK', 'SOIL']), FL = new Set(['WATER', 'LAVA', 'ICE']), PR = new Set(['OWNED', 'PLAYER', 'BLOCK_ENTITY']);
  for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
    const col = ((x - b.minX) * D + (z - b.minZ)) * (H + 1);
    for (let y = b.minY; y <= b.maxY; y++) {
      const i = at(x, y, z), c = land.classAt(x, y, z);
      if (c === 'MISSING' || !land.known(x, y, z)) unk[i] = 1;
      if (FL.has(c) || land.kept?.(x, y, z)) fluid[i] = 1;
      if (PR.has(c)) prot[i] = 1;
      if (c === 'LOG' || c === 'LEAVES') tree[i] = 1;
      const so = SOLID.has(c) || land.written(x, y, z) ? 1 : 0;
      solidC[i] = so;
      solid[col + (y - b.minY) + 1] = solid[col + (y - b.minY)] + so;
    }
  }
  const dilate = (src, r) => {
    let a = src;
    for (const [sx, sy, sz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const o = new Uint8Array(n);
      for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) {
        if (!a[at(x, y, z)]) continue;
        for (let t = -r; t <= r; t++) {
          const xx = x + sx * t, yy = y + sy * t, zz = z + sz * t;
          if (xx < b.minX || xx > b.maxX || yy < b.minY || yy > b.maxY || zz < b.minZ || zz > b.maxZ) continue;
          o[at(xx, yy, zz)] = 1;
        }
      }
      a = o;
    }
    return a;
  };
  const prot1 = Uint8Array.from(prot);
  for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) {
    if (!prot[at(x, y, z)]) continue;
    for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const xx = x + ax, yy = y + ay, zz = z + az;
      if (xx >= b.minX && xx <= b.maxX && yy >= b.minY && yy <= b.maxY && zz >= b.minZ && zz <= b.maxZ) prot1[at(xx, yy, zz)] = 1;
    }
  }
  g = { b, H, D, at, near2: dilate(fluid, 2), prot1, unk2: dilate(unk, 2), tree, solidC, solid };
  state.grids.set(v, g);
  return g;
}

/**
 * A flight's quick check (the same rules as rockStairGeom, over the survey and the precomputed grids; §4 "T3b's grid fast check"): its
 * code in §4's order (SPAN, ANCHOR, WATER, PROTECTED, VOLUME) or null when it passes. The survey first: a tread's lanes more than the
 * fill (1) over the land's ground are ANCHOR whatever the rock says; a lane in a blocked column PROTECTED; no frozen volume holding the
 * flight's envelope (its lanes and 3 either side, from the lowest tread - 3) VOLUME. Then over the volume's grids: the tread rule, the
 * cover per tread, fluids (or a plan body) within 2, unknown cells within 2, protected cells, a tree over a cut, a route or wall too
 * close over the roof. The chosen flight is re-checked by rockStairGeom at emission (memoised per edge).
 */
function fastCheck(state, x0, y0, z0, hf, rise) {
  const c = state.cur, k = `${x0},${y0},${z0},${hf},${rise}`;
  const had = c.fast.get(k);
  if (had !== undefined) return had;
  const res = fast0(state, x0, y0, z0, hf, rise);
  c.fast.set(k, res);
  return res;
}

function fast0(state, x0, y0, z0, hf, rise) {
  const c = state.cur, land = landOf(state);
  const n = Math.abs(rise);
  if (n < c.rMin || n > c.rMax) return 'SPAN';
  const [dx, dz] = DIRS[hf], [rx, rz] = rightOf([dx, dz]), { lo, hi } = latOn(c.width, [dx, dz]);
  const P = flightProfile(y0, rise, c.landing), L = P.L, h = c.height;
  const coverNeed = isInt(c.unsafe?.cover) ? c.unsafe.cover : ROCK.cover;
  const buf = isInt(c.unsafe?.fluidBuffer) ? c.unsafe.fluidBuffer : ROCK.fluidBuffer;
  let prot = false;
  for (let i = 1; i <= L; i++) for (let v = lo - 1; v <= hi + 1; v++) {
    const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
    if (land.blocked(x, z)) prot = true;
    if (v >= lo && v <= hi && land.groundAt(x, z) < P.ys[i] - 1 - ROCK.fill) return 'ANCHOR';
  }
  const xs = [x0 + dx * -2 + rx * (lo - 3), x0 + dx * (L + 3) + rx * (hi + 3)], zs = [z0 + dz * -2 + rz * (lo - 3), z0 + dz * (L + 3) + rz * (hi + 3)];
  const yLo = Math.min(y0, y0 + rise) - 3;
  const ex0 = Math.min(...xs), ex1 = Math.max(...xs), ez0 = Math.min(...zs), ez1 = Math.max(...zs);
  const vol = state.volumes.find((q) => q.box.minX <= ex0 && q.box.maxX >= ex1 && q.box.minZ <= ez0 && q.box.maxZ >= ez1 && q.box.minY <= yLo);
  if (!vol) return prot ? 'PROTECTED' : 'VOLUME';
  const g = gridOf(state, vol);
  const { b, H, D, at } = g;
  const inBox = (y) => y >= b.minY && y <= b.maxY;
  const colS = (x, z) => ((x - b.minX) * D + (z - b.minZ)) * (H + 1);
  let wet = false, unk = false;
  for (let i = 1; i <= L; i++) {
    const fy = P.ys[i], top = fy + h;
    // cover: the least over the lanes of the solid cells over the void, up to the ground
    let mn = Infinity;
    for (let v = lo; v <= hi; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v, gr = Math.min(land.groundAt(x, z), b.maxY);
      const cs = colS(x, z);
      mn = Math.min(mn, gr > top ? g.solid[cs + (gr - b.minY) + 1] - g.solid[cs + (Math.max(top, b.minY - 1) - b.minY) + 1] : 0);
    }
    const bore = mn >= coverNeed;
    for (let v = lo; v <= hi; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v, gr = land.groundAt(x, z);
      // the tread rule over the classes
      if (!inBox(fy - 1) || !inBox(fy - 2)) return 'VOLUME';
      let yb = fy;
      if (!g.solidC[at(x, fy - 1, z)]) { if (c.unsafe?.noFill || !g.solidC[at(x, fy - 2, z)]) return 'ANCHOR'; yb = fy - 1; }
      const y1 = bore ? top : Math.max(top, gr);
      for (let y = yb; y <= y1; y++) {
        if (y > b.maxY) { if (gr >= b.maxY) unk = true; continue; }
        if (y < b.minY) { unk = true; continue; }
        const ii = at(x, y, z);
        if (buf > 0 && g.near2[ii]) wet = true;
        if (g.unk2[ii]) unk = true;
        if (g.prot1[ii]) prot = true;
      }
      if (!bore) for (let y = gr + 1; y <= Math.min(gr + 12, b.maxY); y++) if (y >= b.minY && g.tree[at(x, y, z)]) prot = true;
      const rl = land.routeLow(x, z);
      if (rl !== null && rl - y1 - 1 < ROCK.cover) prot = true;
      const w = land.wallAt(x, z);
      if (w && w.footing - y1 - 1 < ROCK.cover) prot = true;
    }
  }
  return wet ? 'WATER' : prot ? 'PROTECTED' : unk ? 'VOLUME' : null;
}

/** Expand the rock stair move from a state (route.mjs's special-move table: S). Candidates by heading, then rise ascending, up then down. */
export function rockStairExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D, minX, minZ } = state;
  const { i, j, k, h, y, f, inS, dOf, builtY } = S;
  c.builtY = builtY;
  if (c.once) {
    if (f === 1) return; // climbed: walk on to the goal
    if (y + 32768 + 1 > c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells reached at their highest y, for `fail`)
    if (cheb(W, k, c.startK) > c.approach) return;
  }
  if (c.idle) return;
  const x0 = minX + i, z0 = minZ + j;
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    for (const sg of [1, -1]) for (let n = c.rMin; n <= c.rMax; n++) {
      const rise = sg * n, L = flightLength(rise, c.landing);
      const ci = i + di * (L + 1), cj = j + dj * (L + 1);
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      const k2 = ci + cj * W;
      if (!inS(k2) || dOf(y + rise, k2) < 0) continue;
      if (c.once && cheb(W, k2, c.goalK) > c.approach) continue;
      if (fastCheck(state, x0, y, z0, hf, rise) !== null) continue;
      S.relax(k2, hf, 2, (y + rise) * FP, flightCost(rise, c.landing), n * 2 + (sg > 0 ? 1 : 0), c.once ? 1 : f);
    }
  }
}

/** The path cells of a flight (after its start cell: the treads 1..L at their surface y, then the landing) and the segment's data. */
export function rockStairCells(state, m) {
  const n = m.arg >> 1, rise = m.arg & 1 ? n : -n, sx = Math.sign(m.dx), sz = Math.sign(m.dz);
  const P = flightProfile(m.y0, rise, state.cur?.landing ?? ROCK.landing);
  const cells = [];
  for (let t = 1; t <= P.L; t++) cells.push([m.x0 + sx * t, P.ys[t], m.z0 + sz * t]);
  cells.push([m.x1, m.y1, m.z1]);
  return { cells, data: { n: P.L, rise, steps: P.steps, landings: P.landings, dir: [sx, sz], width: state.cur?.width ?? ROCK.width } };
}

/** After an edge routes: its flights (`edgeOut.rockStairs`), for the links stage and the answer. */
export function rockStairCommit(state, env, edgeOut) {
  if (!state?.cur) return;
  const out = (edgeOut.segments ?? []).filter((g) => g.kind === 'rock_stair').map((g) => ({ from: [...edgeOut.path[g.from]], to: [...edgeOut.path[g.to]], rise: g.rise, steps: g.steps, landings: g.landings, dir: [...g.dir], width: g.width }));
  if (out.length) edgeOut.rockStairs = out;
  void env;
}

/**
 * Why a rock stair edge found no route (K1b's method): over the near cells its search reached (at their highest y) and every cardinal
 * flight of rise 2..diagMax up or down landing on a walk cell within `approach` of the goal, the candidate whose rise is within the
 * part's range first, then the one that got furthest through §4's order, then nearest the goal, then the smaller rise. With no such
 * flight at all: SPAN when the ends rise past the range, else UNREACHABLE. Sets `edgeOut.failed = 'ROCK_STAIR'`, `edgeOut.t7 =
 * {rock_stair: {code, evidence}}`.
 */
export function rockStairFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.once) return false;
  const { W, D, minX, minZ, G } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, tried = 0;
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, y = c.reached[k] - 32768 - 1;
    for (let hf = 0; hf < 8; hf += 2) {
      const di = DIRS[hf][0], dj = DIRS[hf][1];
      for (const sg of [1, -1]) for (let n = ROCK.riseMin; n <= ROCK.diagMax; n++) {
        const rise = sg * n, L = flightLength(rise, c.landing);
        const ci = i + di * (L + 1), cj = j + dj * (L + 1);
        if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
        const k2 = ci + cj * W;
        if (!inS(k2) || cheb(W, k2, c.goalK) > c.approach) continue;
        const d = y + rise - G[k2];
        if (d > 4 || d < -4) continue; // (the landing walk cell at grade within the walk's cut or fill)
        tried++;
        const out = n < c.rMin || n > c.rMax ? 1 : 0;
        const code = fastCheck(state, minX + i, y, minZ + j, hf, rise);
        const rank = code === null ? ROCK_ORDER.length : ROCK_ORDER.indexOf(code);
        const key = [out, -rank, Math.max(Math.abs(ci - gi), Math.abs(cj - gj)), n, minX + i, minZ + j, hf, sg > 0 ? 0 : 1];
        if (!best || cmpKey(key, best.key) < 0) best = { key, x: minX + i, y, z: minZ + j, hf, rise, out, to: [minX + ci, y + rise, minZ + cj], heading: [di, dj] };
      }
    }
  }
  let why;
  if (best) {
    // the best candidate's full check names the code and its evidence (rockStairGeom's own: a SPAN past the part's range included)
    const g = best.out ? { ok: false, code: 'SPAN', evidence: { rise: best.rise, min: c.rMin, max: c.rMax } } : geomOf(state, best.x, best.y, best.z, best.hf, best.rise);
    why = { code: g.ok ? 'UNREACHABLE' : g.code, evidence: { ...(g.ok ? {} : g.evidence ?? {}), rise: best.rise, from: [best.x, best.y, best.z], to: best.to, heading: best.heading } };
  }
  else {
    const s = c.startK, sy = G[s] ?? 0, gy = G[c.goalK] ?? 0, rise = gy - sy;
    why = { code: Math.abs(rise) > c.rMax ? 'SPAN' : 'UNREACHABLE', evidence: { tried, rise, min: c.rMin, max: c.rMax, approach: c.approach, message: `no straight flight within ${c.approach} of both ends lands on a walk cell` } };
  }
  edgeOut.failed = 'ROCK_STAIR';
  edgeOut.t7 = { ...(edgeOut.t7 ?? {}), rock_stair: why };
  edgeOut.note = `no rock stair: ${why.code}`;
  return true;
}
