// (7a K1b) The rope move of T2's route pass (docs/CONTRACT.md "Phase 7a slice K1" §4): from a walk cell, on a cardinal heading,
// a span of §3's geometry landing on a walk cell. Opt-in per edge (`spans: ['rope']`): a `rope_bridge` connector must use exactly
// one (the search's `spanned` bit) and walks at most `approach` cells at each end; an `auto` connector uses any number. Cost 30 +
// 3 per deck cell, in cells (a walk cell is 10), so a short walk round wins. Plan time, integer math.
import { ROPE, checkSpan, maxRiseOf, profile, deckY } from './rope.mjs';

const NONE = -32768;
/** The cardinal headings within 45 degrees of a heading (T2's 8 headings, even = cardinal). */
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/**
 * The rope row for one edge's search. `env`: {W, D, minX, minZ, G (the land: ground plus the program's base), top (the column's
 * top), water (0/1), blocked (0/1: what a deck can't pass over: hard rects, keep-out, the claim margin, lava and unknown columns),
 * classAt(x, y, z), DIRS}. `opt`: {once, approach, width, startK, goalK}. Returns {moves(k, y, h, inS, builtY), diag}.
 */
export function ropeRow(env, opt) {
  const { W, D, minX, minZ, G, top, water, blocked, DIRS } = env;
  const { once = false, approach = ROPE.approach, width = 1, startK, goalK } = opt;
  const land = {
    groundAt: (x, z) => G[(x - minX) + (z - minZ) * W], topAt: (x, z) => top[(x - minX) + (z - minZ) * W], waterAt: (x, z) => water[(x - minX) + (z - minZ) * W] === 1,
    frozenAt: () => false, blocked: (x, z) => { const i = x - minX, j = z - minZ; return i < 0 || j < 0 || i >= W || j >= D || blocked[i + j * W] === 1; },
    classAt: env.classAt, written: null,
  };
  const inGrid = (i, j) => i >= 0 && j >= 0 && i < W && j < D;
  /** The spans from cell k at surface y, heading h: [{k, h, y, n, cost}]. */
  const moves = (k, y, h, inS, builtY) => {
    const out = [];
    const i = k % W, j = (k - i) / W;
    if (once && cheb(W, k, startK) > approach) return out;
    for (const hf of cardinalNear(h)) {
      const di = DIRS[hf][0], dj = DIRS[hf][1];
      // the first deck cell must clear the land (the deck sags at most a half block there): the cell ahead drops 2 or is water
      if (!inGrid(i + di, j + dj)) continue;
      const k1 = (i + di) + (j + dj) * W;
      if (!(water[k1] || top[k1] <= y - 2)) continue;
      for (let n = ROPE.spanMin; n <= ROPE.spanMax; n++) {
        const ci = i + di * n, cj = j + dj * n;
        if (!inGrid(ci, cj)) break;
        const k2 = ci + cj * W;
        if (!inS(k2) || water[k2]) continue;
        if (once && cheb(W, k2, goalK) > approach) continue;
        const yf = builtY[k2] !== NONE ? builtY[k2] : G[k2];
        const rise = yf - y;
        if (Math.abs(rise) > maxRiseOf(n)) continue;
        // the landing before it must not be land at the deck's height (else a shorter span lands there)
        const res = checkSpan(land, [minX + i, y, minZ + j], [di, dj], n, rise, width);
        if (!res.ok) continue;
        out.push({ k: k2, h: hf, y: yf, n, cost: ROPE.cost + ROPE.costPer * (n - 1), gap: res.gap });
      }
    }
    return out;
  };
  /**
   * Why no span served (a rope_bridge edge that found no route): over the near cells the search reached (`near`: 0/1 per cell)
   * and the far cells within `approach` of the goal, every cardinal span of 2..diagMax. NO_GAP when none has a gap under it;
   * else the first failing check (SPAN, TOO_STEEP, HEADROOM, ANCHOR) of the candidate landing nearest the goal; UNREACHABLE when
   * a span passes every check (its far side can't reach the goal). `{code, evidence}`.
   */
  const diag = (near, inS) => {
    let best = null, gaps = 0, tried = 0;
    const gi = goalK % W, gj = (goalK - gi) / W;
    for (let k = 0; k < W * D; k++) {
      if (!near[k]) continue;
      const i = k % W, j = (k - i) / W;
      const y = near[k] - 1 + NEAR_BASE;
      for (let hf = 0; hf < 8; hf += 2) {
        const di = DIRS[hf][0], dj = DIRS[hf][1];
        for (let n = 2; n <= ROPE.diagMax; n++) {
          const ci = i + di * n, cj = j + dj * n;
          if (!inGrid(ci, cj)) break;
          const k2 = ci + cj * W;
          if (!inS(k2) || water[k2]) continue;
          if (cheb(W, k2, goalK) > approach) continue;
          tried++;
          const rise = G[k2] - y;
          const ys = profile(n, y, rise);
          let gap = false;
          for (let t = 1; t < n && !gap; t++) { const kk = (i + di * t) + (j + dj * t) * W; if (water[kk] || G[kk] < deckY(ys[t]) - ROPE.gapDepth) gap = true; }
          if (!gap) continue;
          gaps++;
          const res = checkSpan(land, [minX + i, y, minZ + j], [di, dj], n, rise, width);
          const code = res.ok ? 'UNREACHABLE' : res.code;
          const d = Math.max(Math.abs(ci - gi), Math.abs(cj - gj));
          const key = [d, n, minX + i, minZ + j, hf];
          if (!best || cmpKey(key, best.key) < 0) best = { key, code, evidence: { ...(res.evidence ?? {}), span: n, from: [minX + i, y, minZ + j], to: [minX + ci, G[k2], minZ + cj], ...(res.gap ? { over: res.gap.over, depth: res.gap.depth } : {}) } };
        }
      }
    }
    if (!gaps) return { code: 'NO_GAP', evidence: { tried, approach, message: 'no span within the approach of both ends crosses a gap (ground more than 4 below the deck, or water)' } };
    return { code: best.code, evidence: best.evidence };
  };
  return { moves, diag, land };
}

/** `near[k]` holds y - NEAR_BASE + 1 for a reached near cell (0: not reached), so a Int16 array keeps the walk's y. */
export const NEAR_BASE = -4096;
const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
