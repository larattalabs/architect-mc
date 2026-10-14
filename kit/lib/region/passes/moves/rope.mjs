// (7a K1b) The rope move of the route pass (docs/CONTRACT.md "Phase 7a slice K1" §3, §4): opt-in per edge (`spans: ['rope']`, set
// only by rope_bridge and auto connectors). From a walk cell on a cardinal heading, a span of §3's geometry (n deck cells, 8..40, or
// the edge's `span` {min, max}) landing on a walk cell; cost 30 + 3 per deck cell (in cells: 300 + 30 per deck cell in the pass's
// units, so a short walk round wins); a rope_bridge edge uses exactly one (the A* state's flag bit `spanned`, which its goal needs)
// and its span's landings lie within `approach` cells (Chebyshev, default 16) of its ends; an auto edge uses any number.
// The row's land is the pass's (the survey's ground plus the program's base); trees are never under a deck (the survey has no trunk
// heights here), nor the pass's hard rects, keep-out or the claim margin. A rope_bridge edge with no route answers why (`fail`):
// NO_GAP, SPAN, TOO_STEEP, HEADROOM, ANCHOR, or UNREACHABLE. Under the realise lint (integer math; Math.floor/abs/min/max only).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../../pack.mjs';
import { ROPE, checkSpan, deckY, maxRiseOf, profile } from '../../../connectors/ropeGeom.mjs';

const NONE = -32768;
const FP = 16;
/** A tree column's top for the head room (its trunk's height is not in the pass's land): never under a deck. */
const TREE_TOP = 64;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** The cardinal headings within 45 degrees of a heading (even = cardinal). */
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;

/** The pass-level state from the intent and its edges, or null when no edge asks for rope spans (full resolution only). */
export function ropeInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('rope'))) return null;
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
  // the pre-region classes the anchors stand in (the virtual world's 2.5D base): soil to 3 under the ground, rock below, water
  // down a water column (a frozen top ice), unknown columns MISSING
  const classAt = (x, y, z) => {
    const i = x - minX, j = z - minZ;
    if (i < 0 || j < 0 || i >= W || j >= D) return 'MISSING';
    const k = i + j * W, g = G[k], f = flags[k];
    if (f & FLAG_MISSING) return 'MISSING';
    if (y > g) return 'AIR';
    if (f & FLAG_WATER) return (f & FLAG_FROZEN) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const land = {
    groundAt: (x, z) => G[(x - minX) + (z - minZ) * W], topAt: (x, z) => top[(x - minX) + (z - minZ) * W], waterAt: (x, z) => water[(x - minX) + (z - minZ) * W] === 1,
    frozenAt: () => false, blocked: (x, z) => { const i = x - minX, j = z - minZ; return i < 0 || j < 0 || i >= W || j >= D || blocked[i + j * W] === 1; },
    classAt, written: null,
  };
  return { W, D, minX, minZ, G, top, water, land, cur: null };
}

/** Whether an edge searches with the rope move (`edge.spans` includes 'rope'); sets the edge's own options for its search. */
export function ropeActive(state, edge) {
  const on = !!state && Array.isArray(edge?.spans) && edge.spans.includes('rope');
  if (!state) return false;
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const sp = edge.span && typeof edge.span === 'object' ? edge.span : {};
  const once = !!edge.spanOnce;
  state.cur = {
    once, width: isInt(edge.width) ? edge.width : 3,
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= ROPE.approachMax ? edge.approach : ROPE.approach,
    nMin: Math.max(ROPE.spanMin, isInt(sp.min) ? sp.min : ROPE.spanMin), nMax: Math.min(ROPE.spanMax, isInt(sp.max) ? sp.max : ROPE.spanMax),
    startK: kOf(edge.from), goalK: kOf(edge.to), reached: once ? new Int32Array(state.W * state.D) : null,
  };
  return true;
}

/** Whether an edge's goal needs the flag bit set (a rope_bridge edge: exactly one span). */
export function ropeNeedsFlag(state, edge) {
  return !!state && !!edge?.spanOnce;
}

const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/** Expand the rope move from a state (route.mjs's special-move table: S). Candidates by heading, then span length ascending. */
export function ropeExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D, minX, minZ, G, top, water, land } = state;
  const { i, j, k, h, y, f, inS, builtY } = S;
  if (c.once) {
    if (f === 1) return; // spanned: walk on to the goal
    if (!c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells the search reached, for `fail`)
    if (cheb(W, k, c.startK) > c.approach) return;
  }
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    const i1 = i + di, j1 = j + dj;
    if (i1 < 0 || j1 < 0 || i1 >= W || j1 >= D) continue;
    // the first deck cell must clear the land (the deck sags at most a half block there): the cell ahead drops 2, or is water
    const k1 = i1 + j1 * W;
    if (!(water[k1] || top[k1] <= y - 2)) continue;
    for (let n = c.nMin; n <= c.nMax; n++) {
      const ci = i + di * (n + 1), cj = j + dj * (n + 1);
      if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
      const k2 = ci + cj * W;
      if (!inS(k2) || water[k2]) continue;
      if (c.once && cheb(W, k2, c.goalK) > c.approach) continue;
      const yf = builtY[k2] !== NONE ? builtY[k2] : G[k2];
      const rise = yf - y;
      if (Math.abs(rise) > maxRiseOf(n)) continue;
      if (!checkSpan(land, [minX + i, y, minZ + j], [di, dj], n, rise, c.width).ok) continue;
      S.relax(k2, hf, 2, yf * FP, ROPE.cost + ROPE.costPer * n, n, c.once ? 1 : f);
    }
  }
}

/** The path cells of a rope move (after its start cell: the deck cells 1..n at their deck block's y, then the far landing) and the segment's data. */
export function ropeCells(state, m) {
  const n = m.arg, sx = Math.sign(m.dx), sz = Math.sign(m.dz), ys = profile(n, m.y0, m.y1 - m.y0);
  const cells = [];
  for (let t = 1; t <= n; t++) cells.push([m.x0 + sx * t, deckY(ys[t]), m.z0 + sz * t]);
  cells.push([m.x1, m.y1, m.z1]);
  return { cells, data: { n, rise: m.y1 - m.y0, dir: [sx, sz] } };
}

/** After an edge routes: its spans, for the links stage and the answer (`edgeOut.ropes`). */
export function ropeCommit(state, env, edgeOut, moves) {
  if (!state?.cur) return;
  const spans = (edgeOut.segments ?? []).filter((g) => g.kind === 'rope').map((g) => ({ from: [...edgeOut.path[g.from]], to: [...edgeOut.path[g.to]], n: g.n, rise: g.rise, dir: [...g.dir] }));
  if (spans.length) edgeOut.ropes = spans;
  void env; void moves;
}

/**
 * Why a rope_bridge edge found no route (route.mjs calls a row's `fail` before T2's water check): over the near cells its search
 * reached and the far cells within `approach` of its goal, every cardinal span of 2..diagMax deck cells. NO_GAP when none has a gap
 * under it; else the first failing check (SPAN, TOO_STEEP, HEADROOM, ANCHOR) of the candidate nearest the goal (then the shortest,
 * then x, z, heading); UNREACHABLE when one passes every check. Sets `edgeOut.failed = 'ROPE'`, `edgeOut.rope = {code, evidence}`;
 * returns true when it answered (a rope_bridge edge), false otherwise.
 */
export function ropeFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.once) return false;
  const { W, D, minX, minZ, G, water, land } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, gaps = 0, tried = 0;
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, y = c.reached[k] - 32768 - 1;
    for (let hf = 0; hf < 8; hf += 2) {
      const di = DIRS[hf][0], dj = DIRS[hf][1];
      for (let n = 1; n <= ROPE.diagMax; n++) {
        const ci = i + di * (n + 1), cj = j + dj * (n + 1);
        if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
        const k2 = ci + cj * W;
        if (!inS(k2) || water[k2] || cheb(W, k2, c.goalK) > c.approach) continue;
        tried++;
        const rise = G[k2] - y, ys = profile(n, y, rise);
        let gap = false;
        for (let t = 1; t <= n && !gap; t++) { const kk = (i + di * t) + (j + dj * t) * W; if (water[kk] || G[kk] < deckY(ys[t]) - ROPE.gapDepth) gap = true; }
        if (!gap) continue;
        gaps++;
        const res = n >= c.nMin && n <= c.nMax ? checkSpan(land, [minX + i, y, minZ + j], [di, dj], n, rise, c.width) : { ok: false, code: 'SPAN', evidence: { span: n, min: c.nMin, max: c.nMax } };
        const code = res.ok ? 'UNREACHABLE' : res.code;
        const key = [Math.max(Math.abs(ci - gi), Math.abs(cj - gj)), n, minX + i, minZ + j, hf];
        if (!best || cmpKey(key, best.key) < 0) best = { key, code, evidence: { ...(res.evidence ?? {}), span: n, from: [minX + i, y, minZ + j], to: [minX + ci, G[k2], minZ + cj] } };
      }
    }
  }
  const why = !gaps
    ? { code: 'NO_GAP', evidence: { tried, approach: c.approach, message: `no span within ${c.approach} of both ends crosses a gap (ground more than ${ROPE.gapDepth} below the deck, or water)` } }
    : { code: best.code, evidence: best.evidence };
  edgeOut.failed = 'ROPE';
  edgeOut.rope = why;
  edgeOut.note = `no rope bridge: ${why.code}`;
  return true;
}

const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };
