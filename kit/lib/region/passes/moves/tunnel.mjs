// (6c T3b) The tunnel move of the route pass (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §6): row 8 of route.mjs's SPECIAL_MOVES,
// opt-in per edge (`spans` includes 'tunnel': a tunnel edge with `once: 'tunnel'`, which uses exactly one bore and walks at most
// `approach` at each end; an auto edge without `once`, any number). From a walk cell on a cardinal heading, a straight bore of L
// floor cells (4..64, or the edge's `length`) landing on a walk cell, checked by lib/connectors/tunnelGeom.mjs over the pass's land
// (the survey's ground plus the program's base) and the frozen volumes the plan holds (`intent.tunnel.volumes`, decoded): cover,
// span, rise, the 2-cell fluid buffer, the protected columns and classes, the routes over the roof and K1's walls (a postern), the
// volume. Cost 400 + 30 per floor cell, plus a gate's 60 cells per postern. A tunnel edge with no route answers why (`fail`): every
// candidate without surface cover is `tunnel.under` (reserved until 7b); else the first failing check of the candidate nearest the
// goal (NO_COVER, SPAN, TOO_STEEP, WATER, PROTECTED, VOLUME), UNREACHABLE when one passes. Under the realise lint (integer math;
// Math.floor/abs/min/max only).
//   tunnelInit(env, intent) -> state | null       intent.tunnel: {volumes}; null without a tunnel edge (resolution 1 only)
//   tunnelActive(state, edge) -> bool              edge.spans includes 'tunnel'; edge.t3?.tunnel: {part, width, height, lining, portal,
//                                                  length, _unsafe}
//   tunnelNeedsFlag(state, edge) -> bool           edge.once === 'tunnel'
//   tunnelBlocks(state) -> null
//   tunnelExpand(state, S)                         the bore candidates (S: route.mjs's expanded state)
//   tunnelCells(state, m) -> {cells, data}         the floor cells 1..L at their floor block's y, then the landing
//   tunnelCommit(state, env, edgeOut, moves, lat)  edgeOut.tunnels for the links stage
//   tunnelFail(state, edgeOut, inS) -> bool        edgeOut.failed = 'TUNNEL', edgeOut.tunnel = {code, evidence, under?}
//   tunnelPrune(state, from, to) -> note | null    (the gate row already prunes a sealed wall between the ends: none here)
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_WATER } from '../../pack.mjs';
import { TUNNEL, maxRiseOf, surfaceCover, tunnelGeom, tunnelLand } from '../../../connectors/tunnelGeom.mjs';
import { deckY } from '../../../connectors/ropeGeom.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../../volume.mjs';

const NONE = -32768;
const FP = 16;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** The cardinal headings within 45 degrees of a heading (even = cardinal). */
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;
/** A postern costs what opening a gate costs (K1's gateCost 60 cells; a straight cell is 10). */
export const COST_POSTERN = 600;
/** T2 fills this many cells under a walk surface: a route's lowest written cell is its surface minus this. */
const ROUTE_FILL = 3;

const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/** The pass-level state from the intent and its edges, or null when no edge asks for tunnels (full resolution only). */
export function tunnelInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('tunnel'))) return null;
  const { W, D, minX, minZ, flags } = env, G = env.G, n = W * D;
  // the land's obstacles (columns at every depth): the claim margin, the caller's hard rects (lots, aprons, forms, kept sets,
  // standing regions), keep-out (protected areas, other owners' regions, builds)
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
  // K1's walls: a bore may pass under one only as a postern (2 site-solid between its roof and the wall's footing, 2 under the ground)
  const walls = Array.isArray(intent.walls) ? intent.walls.filter((w) => w && Array.isArray(w.cells)) : [];
  const wallOf = new Map();
  walls.forEach((w) => { for (const c of w.cells) wallOf.set(`${c[0]},${c[1]}`, w); });
  // the survey's own ground (the pass's land minus the program's base) for the written cells of a raised ridge
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
  };
  const volumes = Array.isArray(intent.tunnel?.volumes) ? intent.tunnel.volumes.filter(Boolean) : [];
  return {
    W, D, minX, minZ, G, flags, blocked, CLASS, walls, wallOf, S, base, volumes, kOf, cur: null,
    posterns: new Map(walls.map((w) => [w.id, 0])),
  };
}

/** Whether an edge searches with the tunnel move (`edge.spans` includes 'tunnel'); sets the edge's own options for its search. */
export function tunnelActive(state, edge) {
  if (!state) return false;
  const on = Array.isArray(edge?.spans) && edge.spans.includes('tunnel');
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const t = edge.t3?.tunnel ?? {};
  const once = edge.once === 'tunnel';
  const villager = Array.isArray(edge.movers) ? edge.movers.includes('villager') : true;
  const width = isInt(t.width) ? t.width : isInt(edge.width) && edge.width <= TUNNEL.widthMax ? edge.width : villager ? TUNNEL.widthVillager : TUNNEL.widthPlayer;
  state.cur = {
    once, width, height: isInt(t.height) ? t.height : TUNNEL.height, lining: t.lining ?? 'exposed', portal: t.portal ?? 'arch',
    length: { min: Math.max(TUNNEL.lengthMin, isInt(t.length?.min) ? t.length.min : TUNNEL.lengthMin), max: Math.min(TUNNEL.lengthMax, isInt(t.length?.max) ? t.length.max : TUNNEL.lengthMax) },
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= TUNNEL.approachMax ? edge.approach : TUNNEL.approach,
    unsafe: t._unsafe ?? null, part: t.part ?? null,
    startK: kOf(edge.from), goalK: kOf(edge.to), reached: once ? new Int32Array(state.W * state.D) : null,
    memo: new Map(), builtY: null,
  };
  return true;
}

/** Whether an edge's goal needs the flag bit set (a tunnel edge: exactly one bore). */
export function tunnelNeedsFlag(state, edge) {
  return !!state && edge?.once === 'tunnel';
}

/** Cells every edge treats as hard obstacles: none (a bore crosses under the land). */
export function tunnelBlocks() {
  return null;
}

/** The land for one edge's checks (tunnelGeom's), over the pass's survey, volumes and obstacles, with the earlier edges' routes. */
function landOf(state) {
  const c = state.cur;
  if (c.land) return c.land;
  const { blocked, CLASS, kOf, wallOf, G } = state;
  c.land = tunnelLand(state.S, {
    volumes: state.volumes, base: state.base, classOfVolume: (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)],
    blocked: (x, z) => { const k = kOf(x, z); return k < 0 ? { class: 'OUTSIDE' } : blocked[k] ? { class: CLASS[blocked[k]] } : null; },
    routeLow: (x, z) => { const k = kOf(x, z); return k < 0 || !c.builtY || c.builtY[k] === NONE ? null : c.builtY[k] - ROUTE_FILL; },
    wallAt: (x, z) => { const w = wallOf.get(`${x},${z}`); if (!w) return null; const k = kOf(x, z); return { id: w.id, footing: (k < 0 ? 0 : G[k]) - 2, sealed: w.max === 0 }; },
  });
  return c.land;
}

/** One candidate's full check (memoized per edge): tunnelGeom over the edge's land. */
function geomOf(state, x, y, z, hf, L, rise) {
  const c = state.cur, key = `${x},${y},${z},${hf},${L},${rise}`;
  let g = c.memo.get(key);
  if (g === undefined) {
    g = tunnelGeom(landOf(state), [x, y, z], DIRS[hf], L, rise, { width: c.width, height: c.height, lining: c.lining, portal: c.portal, length: c.length, _unsafe: c.unsafe ?? undefined });
    c.memo.set(key, g.ok ? { ok: true, posterns: g.posterns } : { ok: false, code: g.code, evidence: g.evidence });
    g = c.memo.get(key);
  }
  return g;
}

/** Expand the tunnel move from a state (route.mjs's special-move table: S). Candidates by heading, then length ascending. */
export function tunnelExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D, minX, minZ, G, flags } = state;
  const { i, j, k, h, y, f, inS, builtY } = S;
  c.builtY = builtY;
  if (c.once) {
    if (f === 1) return; // bored: walk on to the goal
    if (!c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells the search reached, for `fail`)
    if (cheb(W, k, c.startK) > c.approach) return;
  }
  const x0 = minX + i, z0 = minZ + j;
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    // the survey first: the ground ahead must stand height + cover over a level floor somewhere within the longest bore (a quick
    // test before any candidate; the candidates' own surface cover follows)
    let rises = false;
    for (let t = 1; t <= c.length.max && !rises; t++) {
      const ci = i + di * t, cj = j + dj * t;
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      if (G[ci + cj * W] - y - c.height >= TUNNEL.cover - maxRiseOf(c.length.max)) rises = true;
    }
    if (!rises) continue;
    for (let L = c.length.min; L <= c.length.max; L++) {
      const ci = i + di * (L + 1), cj = j + dj * (L + 1);
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      const k2 = ci + cj * W;
      if (!inS(k2) || (flags[k2] & FLAG_WATER)) continue;
      if (c.once && cheb(W, k2, c.goalK) > c.approach) continue;
      const yf = builtY[k2] !== NONE ? builtY[k2] : G[k2];
      const rise = yf - y;
      if (Math.abs(rise) > maxRiseOf(L)) continue;
      if (surfaceCover(landOf(state).groundAt, [x0, y, z0], [di, dj], L, rise, c.width, c.height, c.unsafe?.cover ?? TUNNEL.cover).run < TUNNEL.boreMin) continue;
      const g = geomOf(state, x0, y, z0, hf, L, rise);
      if (!g.ok) continue;
      // a postern (a bore under a K1 wall) counts against its wall's gates.max, as a gate; a sealed wall never takes one
      let extra = 0, okWall = true;
      for (const p of g.posterns ?? []) {
        const w = state.walls.find((q) => q.id === p.wall);
        const max = w && isInt(w.max) ? w.max : 16, opened = (w && isInt(w.opened) ? w.opened : 0) + (state.posterns.get(p.wall) ?? 0);
        if (p.sealed || max === 0 || opened >= max) { okWall = false; break; }
        extra += COST_POSTERN;
      }
      if (!okWall) continue;
      S.relax(k2, hf, 2, yf * FP, TUNNEL.cost + TUNNEL.costPer * L + extra, L, c.once ? 1 : f);
    }
  }
}

/** The path cells of a tunnel move (after its start cell: the floor cells 1..L at their floor block's y, then the landing) and its data. */
export function tunnelCells(state, m) {
  const L = m.arg, sx = Math.sign(m.dx), sz = Math.sign(m.dz);
  const nn = L * L;
  const cells = [];
  for (let t = 1; t <= L; t++) cells.push([m.x0 + sx * t, deckY(Math.floor((2 * m.y0 * nn + 2 * (m.y1 - m.y0) * t * L) / nn)), m.z0 + sz * t]);
  cells.push([m.x1, m.y1, m.z1]);
  void state;
  return { cells, data: { n: L, rise: m.y1 - m.y0, dir: [sx, sz] } };
}

/** After an edge routes: its bores (`edgeOut.tunnels`), for the links stage and the answer; its posterns count against their walls. */
export function tunnelCommit(state, env, edgeOut, moves) {
  if (!state?.cur) return;
  const c = state.cur;
  const out = [];
  for (const g of edgeOut.segments ?? []) {
    if (g.kind !== 'tunnel') continue;
    const from = [...edgeOut.path[g.from]], to = [...edgeOut.path[g.to]];
    const hf = DIRS.findIndex((d) => d[0] === g.dir[0] && d[1] === g.dir[1]);
    const geo = geomOf(state, from[0], from[1], from[2], hf, g.n, g.rise);
    for (const p of geo.posterns ?? []) state.posterns.set(p.wall, (state.posterns.get(p.wall) ?? 0) + 1);
    out.push({ from, to, n: g.n, rise: g.rise, dir: [...g.dir], width: c.width, height: c.height, posterns: (geo.posterns ?? []).map((p) => ({ wall: p.wall, cells: p.cells })) });
  }
  if (out.length) edgeOut.tunnels = out;
  void env; void moves;
}

/**
 * Why a tunnel edge found no route (route.mjs calls a row's `fail` before T2's water check): over the near cells its search reached
 * and the far cells within `approach` of its goal, every cardinal bore of 1..diagMax floor cells. `tunnel.under` (with `under: true`)
 * when no candidate has surface cover (flat ground between the ends: the passage waits for 7b); else the first failing check of the
 * candidate with surface cover nearest the goal (then the shortest, then x, z, heading), UNREACHABLE when it passes every check.
 * Sets `edgeOut.failed = 'TUNNEL'`, `edgeOut.tunnel = {code, evidence, under?}`; true when it answered (a tunnel edge).
 */
export function tunnelFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.once) return false;
  const { W, D, minX, minZ, G, flags } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, tried = 0, covered = 0;
  const land = landOf(state);
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, y = c.reached[k] - 32768 - 1;
    for (let hf = 0; hf < 8; hf += 2) {
      const di = DIRS[hf][0], dj = DIRS[hf][1];
      for (let L = 1; L <= TUNNEL.diagMax; L++) {
        const ci = i + di * (L + 1), cj = j + dj * (L + 1);
        if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
        const k2 = ci + cj * W;
        if (!inS(k2) || (flags[k2] & FLAG_WATER) || cheb(W, k2, c.goalK) > c.approach) continue;
        tried++;
        const rise = G[k2] - y;
        if (surfaceCover(land.groundAt, [minX + i, y, minZ + j], [di, dj], L, rise, c.width, c.height, c.unsafe?.cover ?? TUNNEL.cover).run < TUNNEL.boreMin) continue;
        covered++;
        const key = [Math.max(Math.abs(ci - gi), Math.abs(cj - gj)), L, minX + i, minZ + j, hf];
        if (!best || cmpKey(key, best.key) < 0) best = { key, x: minX + i, y, z: minZ + j, hf, L, rise };
      }
    }
  }
  let why;
  if (!covered) {
    why = { code: 'NO_COVER', under: true, evidence: { tried, approach: c.approach, block: 'tunnel.under', until: '7b', message: `the ground between the ends never stands ${c.height + TUNNEL.cover} over a line between them: a passage under flat ground (tunnel.under) waits for 7b` } };
  } else {
    const g = geomOf(state, best.x, best.y, best.z, best.hf, best.L, best.rise);
    const code = g.ok ? 'UNREACHABLE' : g.code;
    why = { code, evidence: { ...(g.ok ? {} : g.evidence ?? {}), length: best.L, from: [best.x, best.y, best.z], to: [best.x + DIRS[best.hf][0] * (best.L + 1), best.y + best.rise, best.z + DIRS[best.hf][1] * (best.L + 1)], heading: [DIRS[best.hf][0], DIRS[best.hf][1]] } };
  }
  edgeOut.failed = 'TUNNEL';
  edgeOut.tunnel = why;
  edgeOut.note = why.under ? 'no tunnel: tunnel.under (flat ground between the ends)' : `no tunnel: ${why.code}`;
  return true;
}

/** A reason no route can exist before the search: none (route.mjs's gate row prunes a sealed wall between the ends). */
export function tunnelPrune() {
  return null;
}

const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };
