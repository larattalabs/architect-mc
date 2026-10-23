// (7a CW) Route row 10, `catwalk` (docs/CONTRACT.md "Phase 7a slice CW" §3; the foundation's §3.2): a level deck shelf along a face,
// opt-in per edge (`spans` includes 'catwalk'; a catwalk edge `once: 'catwalk'`). From a walk cell on a cardinal heading, when the cell
// ahead is not walkable at grade (its ground differs from y by more than the walk's cut or fill allows), the row tries runs of n = 3..32
// deck cells (or the edge's `length`) in ascending length, the face on the left, then the right, landing on a walk cell at y; a run
// is tried only while its first cell's face holds (connectors/catwalkGeom.mjs checkCatwalk, §2). Cost 200 + 25 a deck cell + 20 a
// bracket. A catwalk edge uses exactly one run (the A* state's flag bit, which its goal needs) and walks at most `approach` at each
// end (route.mjs's withinM). The row's land is the pass's (the survey's ground plus the program's base, a frozen volume's classes
// where the pass holds one; K1b's reading); trees count 64 high. A catwalk edge with no route answers why (`fail`): NO_GAP, ANCHOR,
// HEADROOM, SPAN, WATER, PROTECTED, or UNREACHABLE when one passes (K1b's method). Under the realise lint (integer math only).
//
// The interface (the foundation's): catwalkInit, catwalkActive, catwalkNeedsFlag, catwalkBlocks, catwalkExpand, catwalkCells,
// catwalkCommit, catwalkFail; the edge's options in `edge.t7.catwalk` ({width, length: {min, max}, diagnose}), the pass-level input
// in `intent.catwalk` ({volumes, kept: [[x, y, z, body]]}: the frozen volumes and the plan bodies' hard cells, KC).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../../pack.mjs';
import { CATWALK, CATWALK_ORDER, bracketIndices, catwalkLanes, checkCatwalk, runCost } from '../../../connectors/catwalkGeom.mjs';
import { rightOf, SITE_SOLID } from '../../../connectors/ropeGeom.mjs';
import { VC, VOXEL_CLASSES, classAt as volumeClassAt } from '../../volume.mjs';

const FP = 16;
/** A tree column's top for the head room (the pass has no trunk heights): never under a deck. */
const TREE_TOP = 64;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;
const onceOf = (edge) => (typeof edge?.once === 'string' ? edge.once : edge?.spanOnce ? 'rope' : null);
const SIDES = ['left', 'right'];

/** The pass-level state from the intent and its edges, or null when no edge asks for catwalk runs (full resolution only). */
export function catwalkInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('catwalk'))) return null;
  const { W, D, minX, minZ, flags } = env, G = env.G, n = W * D;
  const top = new Int16Array(n), water = new Uint8Array(n), blocked = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = flags[k];
    top[k] = f & FLAG_TREE ? G[k] + TREE_TOP : G[k];
    water[k] = f & FLAG_WATER ? 1 : 0;
    if (f & (FLAG_LAVA | FLAG_MISSING)) blocked[k] = 1;
  }
  const rect = (b) => {
    for (let z = Math.max(minZ, b[1]); z <= Math.min(minZ + D - 1, b[3]); z++) for (let x = Math.max(minX, b[0]); x <= Math.min(minX + W - 1, b[2]); x++) blocked[(x - minX) + (z - minZ) * W] = 1;
  };
  for (const b of intent.hard ?? []) rect(b);
  if (!intent._unsafe?.noKeepOut) for (const b of intent.keepOut ?? []) rect(b);
  const m = Math.max(0, intent.margin ?? 2);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (i < m || j < m || i >= W - m || j >= D - m) blocked[i + j * W] = 1;
  // (K1 interplay) a deck never crosses a wall cell
  for (const w of Array.isArray(intent.walls) ? intent.walls : []) for (const c of w?.cells ?? []) {
    const i = c[0] - minX, j = c[1] - minZ;
    if (i >= 0 && j >= 0 && i < W && j < D) blocked[i + j * W] = 1;
  }
  // the pre-region classes (K1b's reading): a frozen volume's where the pass holds one over the cell, else the 2.5D base
  const vols = Array.isArray(intent.catwalk?.volumes) ? intent.catwalk.volumes.filter(Boolean) : [];
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
  // (6c KC) the plan bodies' hard cells: a catwalk never writes one (OVERLAP {kind: body})
  const kept = new Map();
  for (const q of Array.isArray(intent.catwalk?.kept) ? intent.catwalk.kept : []) kept.set(`${q[0]},${q[1]},${q[2]}`, { body: q[3] ?? null });
  const at = (x, z) => (x - minX) + (z - minZ) * W;
  const inside = (x, z) => x >= minX && z >= minZ && x < minX + W && z < minZ + D;
  const land = {
    groundAt: (x, z) => (inside(x, z) ? G[at(x, z)] : -64), topAt: (x, z) => (inside(x, z) ? top[at(x, z)] : 320), waterAt: (x, z) => inside(x, z) && water[at(x, z)] === 1,
    blocked: (x, z) => !inside(x, z) || blocked[at(x, z)] === 1, classAt, written: null, ...(kept.size ? { kept: (x, y, z) => kept.get(`${x},${y},${z}`) ?? null } : {}),
  };
  return { W, D, minX, minZ, G, land, cur: null, memo: new Map(), maxCut: isInt(intent.maxCut) ? intent.maxCut : 4, maxFill: isInt(intent.maxFill) ? intent.maxFill : 4 };
}

/** Whether an edge searches with the catwalk move; sets the edge's own options for its search. */
export function catwalkActive(state, edge) {
  if (!state) return false;
  const on = Array.isArray(edge?.spans) && edge.spans.includes('catwalk');
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const o = edge.t7?.catwalk ?? {};
  const len = o.length && typeof o.length === 'object' ? o.length : {};
  const once = onceOf(edge) === 'catwalk';
  state.cur = {
    once, diagnose: once || !!o.diagnose, width: isInt(o.width) ? o.width : isInt(edge.width) ? edge.width : 2,
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= CATWALK.approachMax ? edge.approach : CATWALK.approach,
    nMin: Math.max(CATWALK.runMin, isInt(len.min) ? len.min : CATWALK.runMin), nMax: Math.min(CATWALK.runMax, isInt(len.max) ? len.max : CATWALK.runMax),
    startK: kOf(edge.from), goalK: kOf(edge.to), reached: null,
  };
  state.cur.reached = state.cur.diagnose ? new Int32Array(state.W * state.D) : null;
  state.memo = new Map();
  return true;
}

/** Whether an edge's goal needs the flag bit set (a catwalk edge: exactly one run). */
export function catwalkNeedsFlag(state, edge) {
  return !!state && onceOf(edge) === 'catwalk';
}

/** No cell is a hard obstacle to the other moves (a catwalk blocks nothing before it is built). */
export const catwalkBlocks = () => null;

const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/** One run's check, memoised per edge (the same run is reached from many states). */
function runCheck(state, i, j, y, hf, n, side) {
  const c = state.cur, key = `${i},${j},${y},${hf},${n},${side}`;
  let r = state.memo.get(key);
  if (r) return r;
  r = checkCatwalk(state.land, [state.minX + i, y, state.minZ + j], DIRS[hf], n, side, c.width, { len: { min: c.nMin, max: c.nMax } });
  state.memo.set(key, r);
  return r;
}

/** Whether a run's first cell's face holds (§3: a run is tried only then): site-solid at y .. y + 2 beside deck cell 1. */
function firstFaceHolds(state, i, j, y, hf, side) {
  const dir = DIRS[hf], L = catwalkLanes(state.cur.width, dir, side), [rx, rz] = rightOf(dir);
  const x = state.minX + i + dir[0] + rx * L.face, z = state.minZ + j + dir[1] + rz * L.face;
  for (let yy = y; yy <= y + 2; yy++) if (!SITE_SOLID.includes(state.land.classAt(x, yy, z))) return false;
  return true;
}

/** Expand the catwalk move from a state (route.mjs's special-move table: S). Candidates by heading, then run length, then side. */
export function catwalkExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D } = state;
  const { i, j, k, h, y, f, inS, dOf } = S;
  if (c.once && f === 1) return; // run: walk on to the goal
  if (c.diagnose && y + 32768 + 1 > c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells reached at their highest y, for `fail`)
  if (c.once && cheb(W, k, c.startK) > c.approach) return;
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    const i1 = i + di, j1 = j + dj;
    if (i1 < 0 || j1 < 0 || i1 >= W || j1 >= D) continue;
    // the cell ahead is not walkable at grade (its ground beyond the walk's cut or fill at y)
    if (dOf(y, i1 + j1 * W) >= 0) continue;
    const sides = SIDES.filter((s) => firstFaceHolds(state, i, j, y, hf, s));
    if (!sides.length) continue;
    const dead = { left: false, right: false };
    for (let n = c.nMin; n <= c.nMax; n++) {
      const ci = i + di * (n + 1), cj = j + dj * (n + 1);
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      const k2 = ci + cj * W;
      if (!inS(k2) || dOf(y, k2) < 0) continue;
      if (c.once && cheb(W, k2, c.goalK) > c.approach) continue;
      for (const side of sides) {
        if (dead[side]) continue;
        const r = runCheck(state, i, j, y, hf, n, side);
        // (a face, head room, water or protection failure at some cell fails every longer run too)
        if (!r.ok) { if (r.code !== 'NO_GAP' && r.code !== 'SPAN') dead[side] = true; continue; }
        S.relax(k2, hf, 2, y * FP, runCost(n), n * 2 + (side === 'right' ? 1 : 0), c.once ? 1 : f);
      }
      if (dead.left && dead.right) break;
    }
  }
}

/** The path cells of a catwalk move (after its start cell: the deck cells 1..n at y, then the landing) and the segment's data. */
export function catwalkCells(state, m) {
  const n = m.arg >> 1, side = m.arg & 1 ? 'right' : 'left', sx = Math.sign(m.dx), sz = Math.sign(m.dz);
  const i0 = m.x0 - state.minX, j0 = m.z0 - state.minZ, hf = sx > 0 ? 0 : sx < 0 ? 4 : sz > 0 ? 2 : 6;
  const r = runCheck(state, i0, j0, m.y0, hf, n, side);
  const cells = [];
  for (let t = 1; t <= n; t++) cells.push([m.x0 + sx * t, m.y0, m.z0 + sz * t]);
  cells.push([m.x1, m.y1, m.z1]);
  const check = { ok: true, n, side, width: state.cur.width, y: m.y0, gap: r.gap, brackets: r.brackets, struts: r.struts, ends: r.ends };
  return { cells, data: { n, side, dir: [sx, sz], width: state.cur.width, brackets: bracketIndices(n).length, check } };
}

/** After an edge routes: its runs, for the links stage and the answer (`edgeOut.catwalks`). */
export function catwalkCommit(state, env, edgeOut) {
  if (!state?.cur) return;
  const runs = (edgeOut.segments ?? []).filter((g) => g.kind === 'catwalk').map((g) => ({ from: [...edgeOut.path[g.from]], to: [...edgeOut.path[g.to]], n: g.n, side: g.side, dir: [...g.dir], width: g.width, brackets: g.brackets }));
  if (runs.length) edgeOut.catwalks = runs;
  void env;
}

const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };
const rankOf = (r) => (r.ok ? CATWALK_ORDER.length : CATWALK_ORDER.indexOf(r.code));

/**
 * Why a catwalk edge found no route (K1b's method): over the near cells its search reached (each from its ground and from the highest
 * y the search reached there), every cardinal run of 1..diagMax deck cells on either face landing on a walk cell (within `approach` of
 * the goal: its ground within the walk's cut or fill of y). NO_GAP when none has a drop under it; else the candidate nearest the goal
 * names its first failing check (runs within the limits before longer ones: SPAN then means only longer runs fit), the run that got
 * furthest through §3's order first; UNREACHABLE when one passes. Sets `edgeOut.failed = 'CATWALK'`, `edgeOut.t7 = {catwalk: {code,
 * evidence}}`.
 */
export function catwalkFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.diagnose) return false;
  const { W, D, minX, minZ, G } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, gaps = 0, tried = 0;
  const near = (y, k) => { const d = y - G[k]; return d <= state.maxFill && -d <= state.maxCut; };
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, yTop = c.reached[k] - 32768 - 1;
    for (const y of yTop === G[k] ? [G[k]] : [G[k], yTop]) {
      for (let hf = 0; hf < 8; hf += 2) {
        const di = DIRS[hf][0], dj = DIRS[hf][1];
        if (i + di < 0 || j + dj < 0 || i + di >= W || j + dj >= D) continue;
        if (near(y, (i + di) + (j + dj) * W)) continue; // the cell ahead is walkable at grade: no catwalk starts here
        for (let n = 1; n <= CATWALK.diagMax; n++) {
          const ci = i + di * (n + 1), cj = j + dj * (n + 1);
          if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
          const k2 = ci + cj * W;
          if (!inS(k2) || !near(y, k2) || (c.once && cheb(W, k2, c.goalK) > c.approach)) continue;
          for (const side of SIDES) {
            tried++;
            const r = checkCatwalk(state.land, [minX + i, y, minZ + j], DIRS[hf], n, side, c.width, { len: { min: c.nMin, max: c.nMax } });
            if (r.code === 'NO_GAP') continue;
            gaps++;
            const code = r.ok ? 'UNREACHABLE' : r.code;
            const out = n > c.nMax || n < c.nMin ? 1 : 0;
            const key = [out, Math.max(Math.abs(ci - gi), Math.abs(cj - gj)), -rankOf(r), n, minX + i, minZ + j, hf, side === 'left' ? 0 : 1];
            if (!best || cmpKey(key, best.key) < 0) best = { key, code, evidence: { ...(r.evidence ?? {}), span: n, side, from: [minX + i, y, minZ + j], to: [minX + ci, y, minZ + cj] } };
          }
        }
      }
    }
  }
  const why = !gaps
    ? { code: 'NO_GAP', evidence: { tried, approach: c.once ? c.approach : null, message: `no run${c.once ? ` within ${c.approach} of both ends` : ''} along a face has a drop of ${CATWALK.drop} under it` } }
    : { code: best.code, evidence: best.evidence };
  edgeOut.failed = 'CATWALK';
  edgeOut.t7 = { ...(edgeOut.t7 ?? {}), catwalk: why };
  edgeOut.note = `no catwalk: ${why.code}`;
  return true;
}
