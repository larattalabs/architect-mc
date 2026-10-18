// (6c T3a) The bridge move of the route pass (docs/CONTRACT.md "Phase 6c slice T3" §3, §4): row 7 of route.mjs's SPECIAL_MOVES, opt-in
// per edge (`spans` includes 'bridge': bridge edges with `once: 'bridge'`, auto edges and the street fallback without). From a walk
// cell on a cardinal heading, a span of §3's geometry (1..32 deck cells, or the edge's `span` {min, max}; beam or arch, the edge's
// form) landing on a walk cell, level with the ground there or with the near landing (when that is within the far cell's fill); cost
// 320 + 30 per deck cell + 40 per pier. A bridge edge uses exactly one (the A* state's flag bit, which its goal needs; it walks at most
// `approach` at each end, route.mjs's withinM). The row's land is the pass's (the survey's ground plus the program's base, a frozen
// volume's classes where the pass holds one); trees, the pass's hard rects, keep-out, the claim margin and the walls are never under
// a deck. A bridge edge (or a fallback edge, `t3.bridge.diagnose`) with no route answers why (`fail`): NO_GAP, SPAN, TOO_STEEP,
// HEADROOM, ANCHOR, WATER, or UNREACHABLE. Under the realise lint (integer math; Math.floor/abs/min/max only).
// (6c H-b, §8.1) An edge with `t3.bridge.wet` ({waterDepth}: the wet fallback only) may stand piers in natural water sources up to
// waterDepth (the frozen volumes' fluid layer where the pass holds one over the column, else the survey's floor), each wet pier cell
// costing 10 more; its failures name WATER's kind (deep, flowing, lava).
//
// The interface (foundation, docs/HANDOFF-T3a.md): bridgeInit, bridgeActive, bridgeNeedsFlag, bridgeExpand, bridgeCells, bridgeCommit,
// bridgeFail; the edge's options in `edge.t3.bridge` ({form, clearance, width, diagnose}), the pass-level input in `intent.bridge`
// ({volumes}).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../../pack.mjs';
import { BRIDGE, checkBridge, maxRiseOf } from '../../../connectors/bridgeGeom.mjs';
import { deckY } from '../../../connectors/ropeGeom.mjs';
import { VC, VOXEL_CLASSES, classAt as volumeClassAt } from '../../volume.mjs';
import { fluidVolumes } from '../../../fluids/wet.mjs';

const NONE = -32768;
const FP = 16;
/** A tree column's top for the head room (the pass has no trunk heights): never under a deck. */
const TREE_TOP = 64;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;
const onceOf = (edge) => (typeof edge?.once === 'string' ? edge.once : edge?.spanOnce ? 'rope' : null);

/** The pass-level state from the intent and its edges, or null when no edge asks for bridge spans (full resolution only). */
export function bridgeInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('bridge'))) return null;
  const { W, D, minX, minZ, flags } = env, G = env.G, n = W * D;
  const top = new Int16Array(n), water = new Uint8Array(n), frozen = new Uint8Array(n), blocked = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = flags[k];
    top[k] = f & FLAG_TREE ? G[k] + TREE_TOP : G[k];
    water[k] = f & FLAG_WATER ? 1 : 0;
    frozen[k] = f & FLAG_FROZEN ? 1 : 0;
    if (f & (FLAG_LAVA | FLAG_MISSING)) blocked[k] = 1;
  }
  const rect = (b) => {
    for (let z = Math.max(minZ, b[1]); z <= Math.min(minZ + D - 1, b[3]); z++) for (let x = Math.max(minX, b[0]); x <= Math.min(minX + W - 1, b[2]); x++) blocked[(x - minX) + (z - minZ) * W] = 1;
  };
  for (const b of intent.hard ?? []) rect(b);
  if (!intent._unsafe?.noKeepOut) for (const b of intent.keepOut ?? []) rect(b);
  const m = Math.max(0, intent.margin ?? 2);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (i < m || j < m || i >= W - m || j >= D - m) blocked[i + j * W] = 1;
  // (K1 interplay) a deck or rail never crosses or overhangs a wall cell (the gate move ends outside the wall; a bridge may start there)
  for (const w of Array.isArray(intent.walls) ? intent.walls : []) for (const c of w?.cells ?? []) {
    const i = c[0] - minX, j = c[1] - minZ;
    if (i >= 0 && j >= 0 && i < W && j < D) blocked[i + j * W] = 1;
  }
  // the pre-region classes (K1b's reading): a frozen volume's where the pass holds one over the cell, else the 2.5D base
  const vols = Array.isArray(intent.bridge?.volumes) ? intent.bridge.volumes.filter(Boolean) : [];
  const classAt = (x, y, z) => {
    for (const v of vols) { const c = volumeClassAt(v, x, y, z); if (c !== VC.MISSING) return VOXEL_CLASSES[c]; }
    const i = x - minX, j = z - minZ;
    if (i < 0 || j < 0 || i >= W || j >= D) return 'MISSING';
    const k = i + j * W, g = G[k], f = flags[k];
    if (f & FLAG_MISSING) return 'MISSING';
    if (y > g) return 'AIR';
    if (f & FLAG_WATER) return (f & FLAG_FROZEN) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const at = (x, z) => (x - minX) + (z - minZ) * W;
  const inside = (x, z) => x >= minX && z >= minZ && x < minX + W && z < minZ + D;
  const land = {
    groundAt: (x, z) => (inside(x, z) ? G[at(x, z)] : -64), topAt: (x, z) => (inside(x, z) ? top[at(x, z)] : 320), waterAt: (x, z) => inside(x, z) && water[at(x, z)] === 1,
    frozenAt: (x, z) => inside(x, z) && frozen[at(x, z)] === 1, blocked: (x, z) => !inside(x, z) || blocked[at(x, z)] === 1, classAt, written: null,
  };
  // ((H-b) the wet piers' bed: the survey's floor; their columns re-read from the frozen volumes with a fluid layer)
  const F = env.F ?? null;
  const wetLand = { floorAt: (x, z) => (F && inside(x, z) ? F[at(x, z)] : land.groundAt(x, z)), vols: fluidVolumes(vols) };
  return { W, D, minX, minZ, G, top, water, land, wetLand, cur: null, memo: new Map() };
}

/** Whether an edge searches with the bridge move; sets the edge's own options for its search. */
export function bridgeActive(state, edge) {
  if (!state) return false;
  const on = Array.isArray(edge?.spans) && edge.spans.includes('bridge');
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const o = edge.t3?.bridge ?? {};
  const sp = o.span && typeof o.span === 'object' ? o.span : {};
  const once = onceOf(edge) === 'bridge';
  const diagnose = once || !!o.diagnose;
  state.cur = {
    once, diagnose, width: isInt(o.width) ? o.width : isInt(edge.width) ? edge.width : 2, form: ['beam', 'arch'].includes(o.form) ? o.form : 'auto',
    clearance: isInt(o.clearance) ? o.clearance : BRIDGE.clearance, maxFill: isInt(o.maxFill) ? o.maxFill : 4,
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= BRIDGE.approachMax ? edge.approach : BRIDGE.approach,
    nMin: Math.max(BRIDGE.spanMin, isInt(sp.min) ? sp.min : BRIDGE.spanMin), nMax: Math.min(BRIDGE.spanMax, isInt(sp.max) ? sp.max : BRIDGE.spanMax),
    startK: kOf(edge.from), goalK: kOf(edge.to), reached: diagnose ? new Int32Array(state.W * state.D) : null, _unsafe: o._unsafe ?? null,
    wet: o.wet && isInt(o.wet.waterDepth) ? { waterDepth: o.wet.waterDepth } : null,
  };
  state.memo = new Map();
  return true;
}

/** Whether an edge's goal needs the flag bit set (a bridge edge: exactly one span). */
export function bridgeNeedsFlag(state, edge) {
  return !!state && onceOf(edge) === 'bridge';
}

const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/** One span's check, memoised per edge (the same landing pair is reached from many states). */
function spanCheck(state, i, j, y, hf, n, yf) {
  const c = state.cur, key = `${i},${j},${y},${hf},${n},${yf}${c.wet ? `,w${c.wet.waterDepth}` : ''}`;
  let r = state.memo.get(key);
  if (r) return r;
  const di = DIRS[hf][0], dj = DIRS[hf][1];
  r = checkBridge(state.land, [state.minX + i, y, state.minZ + j], [di, dj], n, yf - y, c.width, { form: c.form, clearance: c.clearance, span: { min: c.nMin, max: c.nMax }, ...(c.wet ? { wet: { ...c.wet, ...state.wetLand, ...(c._unsafe?.flowingPier ? { unsafeFlowing: true } : {}) } } : {}) });
  state.memo.set(key, r);
  return r;
}

/** Expand the bridge move from a state (route.mjs's special-move table: S). Candidates by heading, then span length, then the far y. */
export function bridgeExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D, G, top, water } = state;
  const { i, j, k, h, y, f, inS, builtY } = S;
  if (c.once && f === 1) return; // spanned: walk on to the goal
  if (c.diagnose && y + 32768 + 1 > c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells the search reached at their highest y, for `fail`)
  if (c.once && cheb(W, k, c.startK) > c.approach) return;
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    const i1 = i + di, j1 = j + dj;
    if (i1 < 0 || j1 < 0 || i1 >= W || j1 >= D) continue;
    // the first deck cell clears the land (the landing stands at a drop, or on the walk's fill: a walk keeps clear of water by its
    // half width plus one, so a bridge over water starts on the bank), and a gap (water, or a drop of 2) lies ahead within the span
    const k1 = i1 + j1 * W;
    if (!(water[k1] || top[k1] < y)) continue;
    if (!gapAhead(state, i, j, di, dj, Math.min(y, G[k]), c.nMax)) continue;
    for (let n = c.nMin; n <= c.nMax; n++) {
      const ci = i + di * (n + 1), cj = j + dj * (n + 1);
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      const k2 = ci + cj * W;
      if (!inS(k2) || water[k2]) continue;
      if (c.once && cheb(W, k2, c.goalK) > c.approach) continue;
      // the far landing: an earlier edge's built cell at its y; else the ground there, or level with the near landing within its fill
      const ys = builtY[k2] !== NONE ? [builtY[k2]] : y !== G[k2] && y > G[k2] && y - G[k2] <= c.maxFill ? [G[k2], y] : [G[k2]];
      for (const yf of ys) {
        if (Math.abs(yf - y) > maxRiseOf(n)) continue;
        const r = spanCheck(state, i, j, y, hf, n, yf);
        if (!r.ok) continue;
        S.relax(k2, hf, 2, yf * FP, BRIDGE.cost + BRIDGE.costPer * n + BRIDGE.costPier * r.piers.length + (c.wet ? BRIDGE.costWet * wetCells(r) : 0), n, c.once ? 1 : f);
      }
    }
  }
}

/** (H-b) A span's wet pier cells (0 for a dry span). */
const wetCells = (r) => { let t = 0; for (const p of r.piers ?? []) t += p.wet ?? 0; return t; };

/** Whether a gap (water, or ground 2 or more under the bank `g`) lies within `nMax` cells ahead, the land never rising over the bank first. */
function gapAhead(state, i, j, di, dj, g, nMax) {
  const { W, D, top, water } = state;
  for (let t = 1; t <= nMax; t++) {
    const ci = i + di * t, cj = j + dj * t;
    if (ci < 0 || cj < 0 || ci >= W || cj >= D) return false;
    const k = ci + cj * W;
    if (water[k] || top[k] <= g - BRIDGE.narrowDrop) return true;
    if (top[k] > g) return false;
  }
  return false;
}

/** The path cells of a bridge move (after its start cell: the deck cells 1..n at their deck block's y, then the far landing) and the segment's data. */
export function bridgeCells(state, m) {
  const n = m.arg, sx = Math.sign(m.dx), sz = Math.sign(m.dz);
  const i0 = m.x0 - state.minX, j0 = m.z0 - state.minZ, hf = sx > 0 ? 0 : sx < 0 ? 4 : sz > 0 ? 2 : 6;
  const r = spanCheck(state, i0, j0, m.y0, hf, n, m.y1);
  const cells = [];
  for (let t = 1; t <= n; t++) cells.push([m.x0 + sx * t, deckY(r.ys[t]), m.z0 + sz * t]);
  cells.push([m.x1, m.y1, m.z1]);
  const c = state.cur;
  const check = { ok: true, form: r.form, ys: r.ys, lowest: r.lowest, piers: r.piers, springing: r.springing, intrados: r.intrados, wetTop: r.wetTop, ground: r.ground, over: r.over, depth: r.depth, under: r.under };
  const wet = wetCells(r);
  return { cells, data: { n, rise: m.y1 - m.y0, dir: [sx, sz], form: r.form, width: c.width, clearance: c.clearance, piers: r.piers.length, over: r.over, depth: r.depth, check, ...(wet ? { wet: { cells: wet, waterDepth: c.wet.waterDepth } } : {}) } };
}

/** After an edge routes: its spans, for the links stage and the answer (`edgeOut.bridges`). */
export function bridgeCommit(state, env, edgeOut) {
  if (!state?.cur) return;
  const spans = (edgeOut.segments ?? []).filter((g) => g.kind === 'bridge').map((g) => ({ from: [...edgeOut.path[g.from]], to: [...edgeOut.path[g.to]], n: g.n, rise: g.rise, dir: [...g.dir], form: g.form, piers: g.piers, over: g.over, depth: g.depth }));
  if (spans.length) edgeOut.bridges = spans;
  void env;
}

const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };

/** The checks in §4's diagnosis order: a failure later in it got further. */
const ORDER = ['NO_GAP', 'SPAN', 'TOO_STEEP', 'HEADROOM', 'ANCHOR', 'WATER'];
const rankOf = (r) => (r.ok ? ORDER.length : ORDER.indexOf(r.code));

/**
 * Why a bridge edge (or a fallback edge with `diagnose`) found no route: over the near cells its search reached, every cardinal span of
 * 1..diagMax deck cells landing on a walk cell (a bridge edge: within `approach` of its goal), each tried from the near cell's ground
 * and from the highest y the search reached there, to the far cell's ground or level with the near landing (within the fill). NO_GAP
 * when none has a gap under it; else the candidate nearest the goal names its check (the landing heights that got furthest through
 * §4's order: SPAN, TOO_STEEP, HEADROOM, ANCHOR, WATER), spans within 1..32 before longer ones (SPAN then means only longer spans
 * cross); UNREACHABLE when one passes. Sets `edgeOut.failed = 'BRIDGE'`, `edgeOut.bridge = {code, evidence, until?}`.
 */
export function bridgeFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.diagnose) return false;
  const { W, D, minX, minZ, G, water } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, gaps = 0, tried = 0;
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, yTop = c.reached[k] - 32768 - 1;
    const nearYs = yTop === G[k] ? [G[k]] : [G[k], yTop];
    for (let hf = 0; hf < 8; hf += 2) {
      const di = DIRS[hf][0], dj = DIRS[hf][1];
      const k1 = (i + di) + (j + dj) * W;
      if (i + di < 0 || j + dj < 0 || i + di >= W || j + dj >= D) continue;
      if (!gapAhead(state, i, j, di, dj, G[k], BRIDGE.diagMax)) continue;
      for (let n = 1; n <= BRIDGE.diagMax; n++) {
        const ci = i + di * (n + 1), cj = j + dj * (n + 1);
        if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
        const k2 = ci + cj * W;
        if (!inS(k2) || water[k2] || (c.once && cheb(W, k2, c.goalK) > c.approach)) continue;
        tried++;
        let res = null;
        if (n > BRIDGE.spanMax) {
          // past the longest span: a gap under it is still a gap (SPAN)
          let gap = false;
          for (let t = 1; t <= n && !gap; t++) { const kk = (i + di * t) + (j + dj * t) * W; if (water[kk] || G[kk] < Math.min(G[k], G[k2]) - BRIDGE.gapDepth) gap = true; }
          if (!gap) continue;
          res = { ok: false, code: 'SPAN', evidence: { span: n, min: c.nMin, max: c.nMax }, y: G[k], yf: G[k2] };
        } else {
          for (const y of nearYs) {
            if (!(water[k1] || state.top[k1] < y)) continue;
            for (const yf of y > G[k2] && y - G[k2] <= c.maxFill ? [G[k2], y] : [G[k2]]) {
              const r = spanCheck(state, i, j, y, hf, n, yf);
              if (!res || rankOf(r) > rankOf(res)) res = { ...r, y, yf };
            }
          }
          if (!res || res.code === 'NO_GAP') continue;
        }
        gaps++;
        const code = res.ok ? 'UNREACHABLE' : res.code;
        // ((H-b) a span over water the plan read names the leg's WATER before one over water it did not: a dry search never has one)
        const key = [res.evidence?.kind === 'unread' ? 1 : 0, n > BRIDGE.spanMax ? 1 : 0, Math.max(Math.abs(ci - gi), Math.abs(cj - gj)), n, minX + i, minZ + j, hf];
        if (!best || cmpKey(key, best.key) < 0) best = { key, code, until: res.until, evidence: { ...(res.evidence ?? {}), span: n, rise: res.yf - res.y, from: [minX + i, res.y, minZ + j], to: [minX + ci, res.yf, minZ + cj] } };
      }
    }
  }
  const why = !gaps
    ? { code: 'NO_GAP', evidence: { tried, approach: c.once ? c.approach : null, message: `no span${c.once ? ` within ${c.approach} of both ends` : ''} crosses a gap (ground more than ${BRIDGE.gapDepth} below the banks, a narrow drop of ${BRIDGE.narrowDrop}, or water)` } }
    : { code: best.code, evidence: best.evidence, ...(best.until ? { until: best.until } : {}) };
  edgeOut.failed = 'BRIDGE';
  edgeOut.bridge = why;
  edgeOut.note = `no bridge: ${why.code}`;
  return true;
}
