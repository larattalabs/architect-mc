// (6c D1) The `districts` pass (docs/SETTLEMENTS.md §4.4, docs/CONTRACT.md "Phase 6c slice D" §2): districts to candidate areas,
// nodes to lots, edges by route cost (a minimum spanning tree plus loops). The pure half lives here, under the realise lint's
// rules (integer math; Math.floor/abs/min/max only):
//   - levelBands: the claim's height terciles (the level bands low, mid, high);
//   - districtCandidates: survey candidates `{id, rect, y, tags, band, range}` at a district's size (6c: flat areas from the survey,
//     keep-out, C17 areas, builds and the caller's hard rects excluded); 7a's affordances produce the same interface;
//   - assignDistricts: an exact assignment (Hungarian on integer costs, with overlapping candidates handled by branch and bound)
//     when every district has at most 64 candidates, else greedy by cost (ties by id); districts without a candidate are unplaced;
//   - spanningEdges: Kruskal's minimum spanning tree over the routable pairs, plus the cheapest non-tree edges while the added cost
//     stays within `loopiness` of the tree's.
// The emitting half (street layouts per district, the routes, the beside join) is Region._districts in program.mjs.
import { FLAG_MISSING, FLAG_TREE, FLAG_WATER, FLAG_LAVA } from '../pack.mjs';

/** The level bands, in order. */
export const BANDS = Object.freeze(['low', 'mid', 'high']);
/** A district may name these `prefer` tags (6c: from the survey; HY's `wet` field when present). */
export const PREFER_TAGS = Object.freeze(['flat', 'sloped', 'wet', 'dry', 'near_water', 'wooded', 'open']);
/** At most this many candidates per district for the exact assignment (CONTRACT D §2). */
export const EXACT_MAX = 64;
/** Districts per pass (plan/0's program.districts maxItems). */
export const DISTRICTS_MAX = 16;
/** Columns kept between two districts' rects (room for a route between them). */
export const DISTRICT_GAP = 4;
/** The cost of leaving a district unplaced (larger than any placed cost). */
export const UNPLACED = 1_000_000_000;
/** A lot the district's layout can't place costs this much (so a candidate that places every lot always wins). */
export const LOT_UNPLACED = 1_000_000;
/** Branch-and-bound nodes before the exact assignment gives up for the greedy one (recorded as `exact: false`). */
export const BNB_MAX = 512;
/** Columns of water distance that count as `near_water`. */
export const NEAR_WATER = 8;
const INF = Number.MAX_SAFE_INTEGER;
const isInt = Number.isInteger;

/** Rects as {minX, minZ, maxX, maxZ}. */
export const rectsMeet = (a, b, gap = 0) => a.minX - gap <= b.maxX && a.maxX + gap >= b.minX && a.minZ - gap <= b.maxZ && a.maxZ + gap >= b.minZ;
const arrRect = (q) => ({ minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] });

/**
 * The claim's level bands: the terciles of the surveyed ground over its dry, known columns. `{t1, t2}`: a y at most t1 is `low`, at
 * most t2 `mid`, else `high`. Integer.
 */
export function levelBands(cols, claim) {
  const g = [];
  const r = cols.resolution;
  for (let j = 0; j < cols.depth; j++) for (let i = 0; i < cols.width; i++) {
    const x = cols.minX + i * r, z = cols.minZ + j * r;
    if (x < claim.minX || x > claim.maxX || z < claim.minZ || z > claim.maxZ) continue;
    const k = i + j * cols.width;
    if (cols.flags[k] & (FLAG_WATER | FLAG_MISSING | FLAG_LAVA)) continue;
    g.push(cols.ground[k]);
  }
  if (!g.length) return { t1: 0, t2: 0, n: 0 };
  g.sort((a, b) => a - b);
  return { t1: g[Math.floor(g.length / 3)], t2: g[Math.floor((2 * g.length) / 3)], n: g.length };
}

/** The band of a y. */
export const bandOf = (bands, y) => (y <= bands.t1 ? 'low' : y <= bands.t2 ? 'mid' : 'high');

/** Sliding-window max (or min) of `a` (W x D) over windows w x d anchored at their min corner: (W-w+1) x (D-d+1). */
function windowExtreme(a, W, D, w, d, max) {
  const W2 = W - w + 1, D2 = D - d + 1;
  const better = max ? (p, q) => p >= q : (p, q) => p <= q;
  const rowOut = new Int32Array(W2 * D);
  const dq = new Int32Array(Math.max(W, D));
  for (let j = 0; j < D; j++) {
    let h = 0, t = 0;
    for (let i = 0; i < W; i++) {
      const v = a[i + j * W];
      while (t > h && better(v, a[dq[t - 1] + j * W])) t--;
      dq[t++] = i;
      if (dq[h] <= i - w) h++;
      if (i >= w - 1) rowOut[i - w + 1 + j * W2] = a[dq[h] + j * W];
    }
  }
  const out = new Int32Array(W2 * D2);
  for (let i = 0; i < W2; i++) {
    let h = 0, t = 0;
    for (let j = 0; j < D; j++) {
      const v = rowOut[i + j * W2];
      while (t > h && better(v, rowOut[i + dq[t - 1] * W2])) t--;
      dq[t++] = j;
      if (dq[h] <= j - d) h++;
      if (j >= d - 1) out[i + (j - d + 1) * W2] = rowOut[i + dq[h] * W2];
    }
  }
  return out;
}

/** A summed-area table of a 0/1 (or count) grid. */
function sat(a, W, D) {
  const s = new Float64Array((W + 1) * (D + 1));
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) s[(i + 1) + (j + 1) * (W + 1)] = a[i + j * W] + s[i + (j + 1) * (W + 1)] + s[(i + 1) + j * (W + 1)] - s[i + j * (W + 1)];
  return (i0, j0, i1, j1) => s[(i1 + 1) + (j1 + 1) * (W + 1)] - s[i0 + (j1 + 1) * (W + 1)] - s[(i1 + 1) + j0 * (W + 1)] + s[i0 + j0 * (W + 1)];
}

/**
 * Survey candidates for districts of size [w, d] (columns; resolution-1 surveys, else the size is in survey cells times r) over the
 * claim: every rect on a lattice of `step` inside the claim's `margin`, with no water, lava or unknown column, clear of `blocked`
 * rects (keep-out, C17 areas, builds, a standing region's cells, the caller's hard rects) by `gap`. Each: `{id, rect, y (the mean
 * ground), range (max - min ground), band, trees, water (columns of water within NEAR_WATER), tags}`; at most `limit`, by (range,
 * trees, z, x) with neighbours suppressed (a candidate whose centre is within half its size of a kept one's is dropped). Pure.
 */
export function districtCandidates(cols, claim, size, { bands = null, blocked = [], step = 4, margin = 2, gap = 1, limit = EXACT_MAX, band = null } = {}) {
  const r = cols.resolution, W = cols.width, D = cols.depth;
  const [sw, sd] = size;
  if (!isInt(sw) || !isInt(sd) || sw < 8 || sd < 8) throw new Error(`districts: size must be [w, d], integers of at least 8 (got ${JSON.stringify(size)})`);
  const w = Math.max(1, Math.floor((sw + r - 1) / r)), d = Math.max(1, Math.floor((sd + r - 1) / r));
  if (w > W || d > D) return [];
  const bs = bands ?? levelBands(cols, claim);
  const n = W * D;
  const bad = new Uint8Array(n), tree = new Uint8Array(n), near = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = cols.flags[k];
    if (f & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) bad[k] = 1;
    if (f & FLAG_TREE) tree[k] = 1;
  }
  // the blocked rects (grown by gap), in survey cells
  const blk = new Uint8Array(n);
  for (const b of blocked) {
    const q = Array.isArray(b) ? arrRect(b) : b;
    const i0 = Math.max(0, Math.floor((q.minX - gap - cols.minX) / r)), i1 = Math.min(W - 1, Math.floor((q.maxX + gap - cols.minX) / r));
    const j0 = Math.max(0, Math.floor((q.minZ - gap - cols.minZ) / r)), j1 = Math.min(D - 1, Math.floor((q.maxZ + gap - cols.minZ) / r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blk[i + j * W] = 1;
  }
  // water within NEAR_WATER (Chebyshev), for the near_water tag
  const R = Math.floor((NEAR_WATER + r - 1) / r);
  const water = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (cols.flags[k] & FLAG_WATER) water[k] = 1;
  const wSat = sat(water, W, D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) near[i + j * W] = wSat(Math.max(0, i - R), Math.max(0, j - R), Math.min(W - 1, i + R), Math.min(D - 1, j + R)) > 0 ? 1 : 0;
  const g = Int32Array.from(cols.ground);
  const gMax = windowExtreme(g, W, D, w, d, true), gMin = windowExtreme(g, W, D, w, d, false);
  const badS = sat(bad, W, D), blkS = sat(blk, W, D), treeS = sat(tree, W, D), nearS = sat(near, W, D), gS = sat(g, W, D);
  const W2 = W - w + 1;
  const out = [];
  const st = Math.max(1, Math.floor(step / r));
  const m = Math.floor((margin + r - 1) / r);
  for (let j = m; j + d - 1 <= D - 1 - m; j += st) {
    for (let i = m; i + w - 1 <= W - 1 - m; i += st) {
      const x0 = cols.minX + i * r, z0 = cols.minZ + j * r, x1 = x0 + sw - 1, z1 = z0 + sd - 1;
      if (x0 < claim.minX + margin || z0 < claim.minZ + margin || x1 > claim.maxX - margin || z1 > claim.maxZ - margin) continue;
      if (badS(i, j, i + w - 1, j + d - 1) > 0 || blkS(i, j, i + w - 1, j + d - 1) > 0) continue;
      const lo = gMin[i + j * W2], hi = gMax[i + j * W2];
      const y = Math.floor(gS(i, j, i + w - 1, j + d - 1) / (w * d));
      const b = bandOf(bs, y);
      if (band && band !== 'any' && b !== band) continue;
      const trees = treeS(i, j, i + w - 1, j + d - 1), nw = nearS(i, j, i + w - 1, j + d - 1);
      const tags = [hi - lo <= 2 ? 'flat' : 'sloped', nw > 0 ? 'near_water' : 'dry', ...(nw > 0 ? ['wet'] : []), trees * 8 >= w * d ? 'wooded' : 'open'];
      out.push({ rect: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 }, y, range: hi - lo, band: b, trees, water: nw, tags });
    }
  }
  out.sort((p, q) => p.range - q.range || p.trees - q.trees || p.rect.minZ - q.rect.minZ || p.rect.minX - q.rect.minX);
  const kept = [];
  const hx = Math.floor(sw / 2), hz = Math.floor(sd / 2);
  for (const c of out) {
    if (kept.length >= limit) break;
    const cx = (c.rect.minX + c.rect.maxX) >> 1, cz = (c.rect.minZ + c.rect.maxZ) >> 1;
    if (kept.some((k) => Math.abs(((k.rect.minX + k.rect.maxX) >> 1) - cx) < hx && Math.abs(((k.rect.minZ + k.rect.maxZ) >> 1) - cz) < hz)) continue;
    kept.push(c);
  }
  kept.sort((p, q) => p.rect.minZ - q.rect.minZ || p.rect.minX - q.rect.minX);
  return kept.map((c) => ({ id: `c${sw}x${sd}_${c.rect.minX}_${c.rect.minZ}`.replace(/-/g, 'm'), ...c }));
}

// ------------------------------------------------------------------ assignment

/**
 * The Hungarian algorithm (potentials, O(n^2 m)) on an n x m integer cost matrix (n <= m; `cost(i, j)`, INF for forbidden). Returns
 * `{cols: [j per row], total}` or null when some row has only forbidden columns.
 */
export function hungarian(n, m, cost) {
  if (n === 0) return { cols: [], total: 0 };
  if (n > m) throw new Error('hungarian: more rows than columns');
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const c = cost(i0 - 1, j - 1);
        const cur = c >= INF ? INF : c - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (j1 < 0 || delta >= INF) return null;
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else if (minv[j] < INF) minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const cols = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) cols[p[j] - 1] = j - 1;
  let total = 0;
  for (let i = 0; i < n; i++) total += cost(i, cols[i]);
  return { cols, total };
}

/**
 * Assign districts to candidates. `districts`: [{id}] (in id order); `cands`: [[{key, rect, cost}] per district] (each district's own
 * candidates; `key` identifies one place across districts: two candidates conflict when their rects meet within `gap`). Every
 * district may stay unplaced at UNPLACED. Exact when every district has at most EXACT_MAX candidates: the Hungarian solution, with
 * a conflict between two districts' rects branched on (best first, at most BNB_MAX nodes); otherwise, or past the node cap, greedy:
 * districts in id order, each its cheapest candidate clear of those taken. Returns `{pick: [index | -1 per district], cost, exact,
 * nodes, method}`.
 */
export function assignDistricts(districts, cands, { gap = DISTRICT_GAP, exact = true } = {}) {
  const n = districts.length;
  const greedy = () => {
    const pick = new Array(n).fill(-1);
    let cost = 0;
    const order = districts.map((d, i) => i).sort((a, b) => (districts[a].id < districts[b].id ? -1 : districts[a].id > districts[b].id ? 1 : 0));
    for (const i of order) {
      let best = -1;
      cands[i].forEach((c, k) => {
        if (c.cost >= INF) return;
        if (pick.some((pj, i2) => pj >= 0 && rectsMeet(cands[i2][pj].rect, c.rect, gap))) return;
        if (best < 0 || c.cost < cands[i][best].cost) best = k;
      });
      pick[i] = best;
      cost += best < 0 ? UNPLACED : cands[i][best].cost;
    }
    return { pick, cost };
  };
  if (!exact || cands.some((c) => c.length > EXACT_MAX)) { const g = greedy(); return { ...g, exact: false, nodes: 0, method: 'greedy' }; }
  // columns: every district's candidates, then one unplaced column per district
  const colOf = [];
  cands.forEach((cs, i) => cs.forEach((c, k) => colOf.push({ i, k })));
  const m = colOf.length + n;
  const solve = (forbid) => hungarian(n, m, (i, j) => {
    if (j >= colOf.length) return j - colOf.length === i ? UNPLACED : INF;
    const q = colOf[j];
    if (q.i !== i) return INF;
    if (forbid.has(j)) return INF;
    return cands[i][q.k].cost;
  });
  const decode = (sol) => sol.cols.map((j) => (j >= colOf.length ? -1 : colOf[j].k));
  const conflict = (pick) => {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (pick[a] < 0 || pick[b] < 0) continue;
      if (rectsMeet(cands[a][pick[a]].rect, cands[b][pick[b]].rect, gap)) return [a, b];
    }
    return null;
  };
  // best-first over forbidden sets (the Hungarian total is a lower bound of every refinement)
  const open = [];
  const push = (forbid) => { const s = solve(forbid); if (s) open.push({ forbid, sol: s }); };
  push(new Set());
  let nodes = 0;
  while (open.length) {
    open.sort((p, q) => p.sol.total - q.sol.total || p.forbid.size - q.forbid.size);
    const cur = open.shift();
    nodes++;
    const pick = decode(cur.sol);
    const c = conflict(pick);
    if (!c) return { pick, cost: cur.sol.total, exact: true, nodes, method: 'hungarian' };
    if (nodes >= BNB_MAX) break;
    const colIdx = (i) => colOf.findIndex((q) => q.i === i && q.k === pick[i]);
    for (const i of c) push(new Set([...cur.forbid, colIdx(i)]));
  }
  const g = greedy();
  return { ...g, exact: false, nodes, method: 'greedy (branch and bound over its node cap)' };
}

// ------------------------------------------------------------------ edges

/**
 * Kruskal's minimum spanning tree over `pairs` ([{a, b, cost}] with integer costs; INF or missing: not routable) on nodes `ids`,
 * ties by (cost, a, b); then the cheapest non-tree pairs while the added cost stays within `loopiness` (a ratio, 1/64 steps) of the
 * tree's. Returns `{tree: [pair], loops: [pair], treeCost, loopCost, components: [[id]] (largest first, then by first id)}`.
 */
export function spanningEdges(ids, pairs, loopiness = 0.15) {
  const parent = new Map(ids.map((x) => [x, x]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const ok = pairs.filter((p) => isInt(p.cost) && p.cost < INF).sort((p, q) => p.cost - q.cost || (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0));
  const tree = [], rest = [];
  for (const p of ok) {
    const ra = find(p.a), rb = find(p.b);
    if (ra === rb) { rest.push(p); continue; }
    parent.set(ra, rb);
    tree.push(p);
  }
  const treeCost = tree.reduce((s, p) => s + p.cost, 0);
  const q64 = Math.floor(loopiness * 64 + 1e-9);
  const cap = Math.floor((treeCost * q64) / 64);
  const loops = [];
  let loopCost = 0;
  for (const p of rest) {
    if (loopCost + p.cost > cap) break;
    loops.push(p); loopCost += p.cost;
  }
  const comp = new Map();
  for (const x of ids) { const r = find(x); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(x); }
  const components = [...comp.values()].map((c) => [...c].sort()).sort((p, q) => q.length - p.length || (p[0] < q[0] ? -1 : 1));
  return { tree, loops, treeCost, loopCost, components };
}

/**
 * The pure pass (`PASSES.districts`): candidates per district and the assignment, no emission. `intent`: `{districts: [{id, size,
 * levelBand, prefer, near}], blocked, step, limit, exact, costs: {(district index, candidate) -> extra cost}}`. Returns
 * `{fields: {}, ops: [], data: {bands, candidates: {id: [...]}, assign: {districtId: candidateId}, unplaced, exact, cost}}`.
 * (Region._districts runs the same steps with the street layouts in the cost.)
 */
export function districtsPass(survey, volumes, intent) {
  const it = intent ?? {};
  const claim = it.claim ?? { minX: survey.minX, minZ: survey.minZ, maxX: survey.minX + survey.width * survey.resolution - 1, maxZ: survey.minZ + survey.depth * survey.resolution - 1 };
  const bands = levelBands(survey, claim);
  const ds = it.districts ?? [];
  const cands = ds.map((d) => districtCandidates(survey, claim, d.size, { bands, blocked: it.blocked ?? [], step: it.step ?? 4, limit: it.limit ?? EXACT_MAX, band: d.levelBand ?? null }));
  const costs = cands.map((cs, i) => cs.map((c) => ({ ...c, cost: candidateCost(ds[i], c) })));
  const a = assignDistricts(ds, costs, { exact: it.exact !== false });
  const assign = {}, unplaced = [];
  ds.forEach((d, i) => { if (a.pick[i] >= 0) assign[d.id] = costs[i][a.pick[i]].id; else unplaced.push({ id: d.id, reason: cands[i].length ? 'no_room' : 'no_candidate' }); });
  return { fields: {}, ops: [], data: { bands, candidates: Object.fromEntries(ds.map((d, i) => [d.id, cands[i].length])), assign, unplaced, exact: a.exact, cost: a.cost } };
}

/**
 * A candidate's integer cost for a district (lower is better): its range (64 a block), a missing `prefer` tag (4096 each), trees
 * (2 each); `unplacedLots` (the street layout's) LOT_UNPLACED each; `near` the Chebyshev distance of the centres to each placed
 * target's. INF when its band is not the district's `levelBand`.
 */
export function candidateCost(d, c, { unplacedLots = 0, near = [] } = {}) {
  if (d.levelBand && d.levelBand !== 'any' && c.band !== d.levelBand) return INF;
  let cost = unplacedLots * LOT_UNPLACED + c.range * 64 + c.trees * 2;
  for (const t of d.prefer ?? []) if (!c.tags.includes(t)) cost += 4096;
  const cx = (c.rect.minX + c.rect.maxX) >> 1, cz = (c.rect.minZ + c.rect.maxZ) >> 1;
  for (const q of near) cost += Math.max(Math.abs(cx - q[0]), Math.abs(cz - q[1]));
  return cost;
}

export { INF as DISTRICT_INF };
