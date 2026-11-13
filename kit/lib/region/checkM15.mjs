// (7c RM, docs/CONTRACT.md "Phase 7c" §3 row 8, "Slice RM as built") Region M15, structural sense at region scale (SETTLEMENTS §11 M15):
// cantilever, necks and spans over the mass the region writes on its virtual world, and the joints where a port link lands on a site
// lot's port (the column kit/lib/siteCheck.mjs leaves to 7c). Building-scale M15 (lib/siteCheck.mjs, SC) judges a design on its site; this
// judges what the region's own parts write: connectors, walls, terraces, pads, links. Every finding is a warning (7c: "a warning first").
//
// The mass: the written cells that hold themselves up (lib/blocks.mjs supportOf null: not air, a fluid or fire; a torch, a lantern or a
// ladder hangs on its support and carries nothing). The supports (distance 0): a mass cell touching the pre-region world's solid on any of
// its 6 sides (rock, soil, a log or leaves: what the region bears on), and every cell of a declared floating group or a generated form
// (M3 and M3:overhang judge those; they carry what stands on them). Then SC's measure, unchanged: resting on the cell below, hanging from
// the one above and a stair stepping diagonally up carry a cell's distance; a horizontal step (8 ways, Chebyshev) adds 1. Only the region's
// own parts are judged: a cell with no part (a design's, in a lot, on a realised world) is mass and holds what leans on it, never a finding.
// - `M15:cantilever`: a cell more than `cantilever` from a support, held on one side only. A cell whose row's run of the mass reaches a cell
//   within the limit (or a port's landing) both ways along x or z is a span, not a cantilever (SC's rule). The run follows a deck's profile
//   (one step down or up per cell: a rope deck's sag, a ramp).
// - `M15:joint`: the same, on a port link's end (the column just outside the lot's box, the port's width through its height, the floor row
//   included): the link leans on the design's landing, which SC lets stand one step past its own support, so the landing holds a span's end
//   but never a cantilever.
// - `M15:span`: a held run whose clear length between its supports (distance 0, or a landing) is over its connector type's `maxSpan`,
//   when the plan's Style sets one (format 3 `connectors.<type>.maxSpan`, recorded in the plan meta's `m15`; unbounded otherwise: SC's
//   leftover). The longest span of each part is recorded.
// - `M15:neck`: a mass of more than `neckMass` cells that reaches every support through one cell only.
// Pure and deterministic; reads `vw` only.
import { BLOCKS, supportOf } from '../blocks.mjs';
import { parseState } from './vworld.mjs';
import { lotPortsWorld } from './links.mjs';

/**
 * Region M15's limits (frozen names: AQ and US read them). `cantilever` and `neckMass` are SETTLEMENTS §11's numbers (SC's own,
 * lib/siteCheck.mjs SITE_CHECK_LIMITS); `span` is per connector type, null (unbounded) unless the plan's Style sets the type's `maxSpan`.
 */
export const REGION_M15_LIMITS = Object.freeze({ cantilever: 4, neckMass: 200, span: Object.freeze({}) });
/** The connector types a span is judged by, and the plan meta's record list for each (the cells a type's records own). */
export const M15_SPAN_TYPES = Object.freeze({ rope_bridge: 'ropes' });
/** The sub-rules, in report order. */
export const M15_RULES = Object.freeze(['M15:cantilever', 'M15:joint', 'M15:span', 'M15:neck']);

/** The look parameters region M15 reads from a format 3 Style's (ctx.connectorLook.look): {<type>: {maxSpan}} for the span types, or null. */
export function m15LookOf(look) {
  const out = {};
  for (const t of Object.keys(M15_SPAN_TYPES)) if (Number.isInteger(look?.[t]?.maxSpan)) out[t] = { maxSpan: look[t].maxSpan };
  return Object.keys(out).length ? out : null;
}

/**
 * The limits a plan is judged by: REGION_M15_LIMITS, with `span[type]` from a format 3 Style's look parameters (`look`: the plan meta's
 * `m15.look`, ctx.connectorLook.look: {rope_bridge: {maxSpan}}), then `overrides` (a test's or a caller's).
 */
export function regionM15Limits(look = null, overrides = {}) {
  const span = {};
  for (const t of Object.keys(M15_SPAN_TYPES)) if (Number.isInteger(look?.[t]?.maxSpan)) span[t] = look[t].maxSpan;
  const out = { cantilever: REGION_M15_LIMITS.cantilever, neckMass: REGION_M15_LIMITS.neckMass, span };
  for (const [k, v] of Object.entries(overrides ?? {})) if (v !== undefined) out[k] = k === 'span' ? { ...span, ...v } : v;
  return out;
}

const H8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const ZERO = [[0, 1, 0], [0, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NOT_MASS = new Set(['air', 'liquid', 'fire']);
/** The dense index grid's largest box (cells; 64 MB of Int32): a bigger mass box falls back to a map. */
const GRID_MAX = 1 << 24;

/**
 * Region M15 over a virtual (or realised) world. `ir`, `vw`, `meta`, `limits` (regionM15Limits), `finding` (check.mjs's). Returns
 * {findings, metrics}; metrics: {mass, supports, cantileverMax, cantileverLimit, heldMax, spans: [{part, type, length, limit}], necks,
 * joints: [{link, lot, port, end, cells, written, dist, held}]}.
 */
export function regionM15({ ir, vw, meta, limits = regionM15Limits(meta?.m15?.look ?? null), finding }) {
  const P = vw.pal;
  const c = ir.claim;
  // packed keys: claim-relative x and z with a 64 margin, y from -512
  const DX = c.maxX - c.minX + 129, DZ = c.maxZ - c.minZ + 129;
  const key = (x, y, z) => ((x - c.minX + 64) * DZ + (z - c.minZ + 64)) * 1024 + (y + 512);
  const inFrame = (x, z) => x - c.minX + 64 >= 0 && x - c.minX + 64 < DX && z - c.minZ + 64 >= 0 && z - c.minZ + 64 < DZ;
  // per palette index: 1 mass, 0 not
  const massIdx = [];
  const isMass = (idx) => {
    let v = massIdx[idx];
    if (v === undefined) {
      const st = parseState(P.states[idx]);
      const f = BLOCKS[st.name]?.family;
      v = massIdx[idx] = !P.air[idx] && !P.fluid[idx] && !NOT_MASS.has(f) && supportOf(st) === null ? 1 : 0;
    }
    return v === 1;
  };
  // the parts that are supports, never judged: declared floating groups and generated forms (M3, M3:overhang)
  const fixedParts = new Set();
  for (const f of ir.floating ?? []) for (const id of f.parts) fixedParts.add(id);
  for (const f of ir.forms ?? []) fixedParts.add(f.part ?? f.id);
  const fixedIdx = new Set(ir.parts.map((p, i) => (fixedParts.has(p.id) ? i : -1)).filter((i) => i >= 0));

  // ---- the mass, densely indexed
  const X = [], Y = [], Z = [], PI = [], ST = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (!isMass(idx) || !inFrame(x, z)) return;
    X.push(x); Y.push(y); Z.push(z); PI.push(pi); ST.push(P.stairs[idx] ? 1 : 0);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  });
  const n = X.length;
  // the index of the mass cell at a position (-1 none): a dense grid over the mass's box (index + 1), or a map past GRID_MAX cells
  let idxAt;
  const GW = x1 - x0 + 1, GH = y1 - y0 + 1, GD = z1 - z0 + 1;
  if (n && GW * GH * GD <= GRID_MAX) {
    const grid = new Int32Array(GW * GH * GD);
    for (let i = 0; i < n; i++) grid[((X[i] - x0) * GD + (Z[i] - z0)) * GH + (Y[i] - y0)] = i + 1;
    idxAt = (x, y, z) => (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1 ? -1 : grid[((x - x0) * GD + (z - z0)) * GH + (y - y0)] - 1);
  } else {
    const at = new Map();
    for (let i = 0; i < n; i++) at.set(key(X[i], Y[i], Z[i]), i);
    idxAt = (x, y, z) => at.get(key(x, y, z)) ?? -1;
  }
  // the 6 face neighbours (-1 none), and the supports: a cell touching the pre-region world's solid (unwritten), or a fixed part's
  const nb6 = new Int32Array(n * 6).fill(-1);
  const seed = new Uint8Array(n);
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const fixed = fixedIdx.has(PI[i]);
    let s = fixed;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = N6[d];
      const x = X[i] + dx, y = Y[i] + dy, z = Z[i] + dz;
      const j = idxAt(x, y, z);
      nb6[i * 6 + d] = j;
      if (!s && j < 0 && !(vw.flags(x, y, z) & 1)) { const b = vw.get(x, y, z); if (P.solid[b] && !P.fluid[b]) s = true; }
    }
    if (s) { seed[i] = 1; seeds.push(i); }
  }

  // ---- cantilever: SC's 0-1 flood from the supports
  const dist = new Int32Array(n).fill(-1);
  let now = seeds.slice();
  for (const i of seeds) dist[i] = 0;
  let level = 0, max = 0;
  while (now.length) {
    const next = [];
    for (let q = 0; q < now.length; q++) {
      const i = now[q];
      if (dist[i] !== level) continue;
      const x = X[i], y = Y[i], z = Z[i];
      for (const [dx, dy, dz] of ZERO) {
        const j = idxAt(x + dx, y + dy, z + dz);
        if (j < 0 || (dist[j] >= 0 && dist[j] <= level)) continue;
        if (dy === 1 && (dx || dz) && !ST[j]) continue;
        dist[j] = level;
        now.push(j);
      }
      for (const [dx, dz] of H8) {
        const j = idxAt(x + dx, y, z + dz);
        if (j < 0 || (dist[j] >= 0 && dist[j] <= level + 1)) continue;
        dist[j] = level + 1;
        next.push(j);
      }
      if (level > max) max = level;
    }
    now = next;
    level++;
  }

  // ---- the port links' joints: each end's landing (the port's column inside the lot's box: a hold) and its end column (outside it)
  const landing = new Set(); // keys
  const joints = [];
  const jointOf = new Map(); // mass index of an end column cell -> joint row
  const lotById = new Map((ir.lots ?? []).map((l) => [l.id, l]));
  for (const link of ir.portLinks ?? []) {
    for (const end of [link.from, link.to]) {
      const lot = lotById.get(end?.lot);
      if (!lot?.site) continue;
      const ports = ir.linked?.lots?.[end.lot]?.ports ?? null;
      const p = lotPortsWorld(lot, ports).find((q) => q.name === end.port);
      const v = p && { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[p.facing];
      if (!v) continue;
      const along = v[0] ? [0, 1] : [1, 0];
      const row = { link: link.id, lot: end.lot, port: end.port, end: p.out, cells: 0, written: 0, dist: null, held: true };
      for (let w = 0; w < p.width; w++) for (let dy = -1; dy < p.height; dy++) {
        landing.add(key(p.cell[0] + along[0] * w, p.cell[1] + dy, p.cell[2] + along[1] * w));
        const j = idxAt(p.out[0] + along[0] * w, p.out[1] + dy, p.out[2] + along[1] * w);
        row.cells++;
        if (j >= 0) { row.written++; jointOf.set(j, row); if (row.dist === null || dist[j] > row.dist) row.dist = dist[j] < 0 ? row.dist : dist[j]; }
      }
      joints.push(row);
    }
  }

  // ---- held and spans. A run along x or z follows the deck's profile: each step to the cell at the same y, else one down or up (a rope
  // deck's sag, a ramp). A cell is held when its run reaches a cell within the limit (or a landing) both ways; its span is the clear run
  // between the supports (distance 0, or a landing) it reaches each way.
  const limit = limits.cantilever;
  const run = (i, dx, dz, stop) => {
    let yy = Y[i];
    for (let s = 1; ; s++) {
      const px = X[i] + s * dx, pz = Z[i] + s * dz;
      let nextY = null;
      for (const dy of [0, -1, 1]) {
        if (landing.size && landing.has(key(px, yy + dy, pz))) return s;
        const j = idxAt(px, yy + dy, pz);
        if (j < 0) continue;
        if (stop(j)) return s;
        if (nextY === null) nextY = yy + dy;
      }
      if (nextY === null) return null;
      yy = nextY;
    }
  };
  const nearJ = (j) => dist[j] >= 0 && dist[j] <= limit;
  const supJ = (j) => dist[j] === 0;
  const both = (i, stop) => {
    let best = null;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const a = run(i, dx, dz, stop);
      if (a === null) continue;
      const b = run(i, -dx, -dz, stop);
      if (b === null) continue;
      if (best === null || a + b - 1 < best) best = a + b - 1;
    }
    return best;
  };
  const partId = (pi) => ir.parts[pi]?.id ?? null;
  const partStage = (pi) => ir.parts[pi]?.stage ?? null;
  // a span's connector type: the part of a meta record of that type
  const typeOfPart = new Map();
  for (const [t, list] of Object.entries(M15_SPAN_TYPES)) for (const rec of meta?.[list] ?? []) if (rec?.part) typeOfPart.set(rec.part, t);
  const over = { 'M15:cantilever': new Map(), 'M15:joint': new Map() }; // rule -> part index -> mass indexes
  const spanByPart = new Map();
  let heldMax = 0;
  if (limit !== null) for (let i = 0; i < n; i++) {
    const d = dist[i];
    // (judged: the region's own parts; a cell with no part, a design's in a lot on a realised world, holds but is never judged)
    if (d <= limit || PI[i] < 0 || fixedIdx.has(PI[i])) continue;
    if (both(i, nearJ) !== null) {
      if (d > heldMax) heldMax = d;
      const s = both(i, supJ);
      const e = spanByPart.get(PI[i]);
      if (s !== null && (!e || s > e.length)) spanByPart.set(PI[i], { length: s, at: i });
      continue;
    }
    const j = jointOf.get(i);
    if (j) j.held = false;
    const m = over[j ? 'M15:joint' : 'M15:cantilever'];
    let l = m.get(PI[i]);
    if (!l) m.set(PI[i], (l = []));
    l.push(i);
  }

  // ---- necks: an articulation point of the mass (a virtual ground joined to every support) holding more than neckMass cells
  const neck = necks(n, nb6, seed, limits.neckMass);

  // ---- the findings (samples in cell order: y, then x, then z)
  const cellOf = (i) => [X[i], Y[i], Z[i]];
  const ord = (a, b) => Y[a] - Y[b] || X[a] - X[b] || Z[a] - Z[b];
  const findings = [];
  for (const rule of ['M15:cantilever', 'M15:joint']) for (const [pi, is] of [...over[rule]].sort((a, b) => a[0] - b[0])) {
    const far = Math.max(...is.map((i) => dist[i]));
    const what = rule === 'M15:joint' ? `cell(s) of a port link's end more than ${limit} from a support of its own, held on one side only (the lot's landing holds a span's end, not a cantilever)` : `cell(s) more than ${limit} horizontally from a support column or a bracket, held on one side only`;
    findings.push(finding(rule, partId(pi), partStage(pi), is.length, is.slice().sort(ord).map(cellOf), `${is.length} ${what} (farthest ${far})`));
  }
  const spans = [];
  for (const [pi, e] of [...spanByPart].sort((a, b) => a[0] - b[0])) {
    const type = typeOfPart.get(partId(pi)) ?? null;
    const lim = type ? limits.span?.[type] ?? null : null;
    spans.push({ part: partId(pi), type, length: e.length, limit: lim });
    if (lim !== null && e.length > lim) findings.push(finding('M15:span', partId(pi), partStage(pi), 1, [cellOf(e.at)], `an unsupported span of ${e.length} in part ${partId(pi)}, more than the Style's ${type}.maxSpan ${lim}`));
  }
  for (const k of neck) findings.push(finding('M15:neck', partId(PI[k.at]), partStage(PI[k.at]), 1, [cellOf(k.at)], `a mass of ${k.mass} cells hangs on the one cell ${cellOf(k.at).join(',')} (a mass of more than ${limits.neckMass} cells needs at least 2 cells of contact)`));
  return {
    findings,
    metrics: { mass: n, supports: seeds.length, cantileverMax: max, cantileverLimit: limit, heldMax, spans, necks: neck.length, joints },
  };
}

/**
 * SC's necks (lib/siteCheck.mjs) over the dense mass: [{at, mass}], the biggest first. An iterative Tarjan with a virtual ground (index n)
 * joined to every support; a cell is a neck when a subtree of more than `limit` cells reaches the ground only through it.
 */
function necks(n, nb6, seed, limit) {
  const G = n;
  const disc = new Int32Array(n + 1).fill(-1), low = new Int32Array(n + 1), size = new Int32Array(n + 1), parent = new Int32Array(n + 1);
  const cursor = new Int32Array(n + 1); // the next neighbour slot: 0..5 the faces, 6 the ground (a support's), past it done
  const found = new Map();
  let t = 0;
  // the ground's neighbours are the supports, walked by a scan
  let gScan = 0;
  const stack = [G];
  disc[G] = t; low[G] = t; size[G] = 1; parent[G] = -1; t++;
  const visit = (u, v) => { disc[u] = t; low[u] = t; size[u] = 1; parent[u] = v; cursor[u] = 0; t++; stack.push(u); };
  while (stack.length) {
    const v = stack[stack.length - 1];
    let u = -1;
    if (v === G) {
      while (gScan < n && !seed[gScan]) gScan++;
      if (gScan < n) u = gScan++;
    } else {
      while (cursor[v] < 7 && u < 0) {
        const c = cursor[v]++;
        const w = c < 6 ? nb6[v * 6 + c] : (seed[v] ? G : -1);
        if (w >= 0 && w !== parent[v]) u = w;
      }
    }
    if (u >= 0) {
      if (disc[u] >= 0) { if (disc[u] < low[v]) low[v] = disc[u]; }
      else visit(u, v);
      continue;
    }
    stack.pop();
    const p = parent[v];
    if (p < 0) continue;
    if (low[v] < low[p]) low[p] = low[v];
    size[p] += size[v];
    if (p !== G && low[v] >= disc[p] && size[v] > limit) found.set(p, Math.max(found.get(p) ?? 0, size[v]));
  }
  return [...found].map(([at, mass]) => ({ at, mass })).sort((a, b) => b.mass - a.mass || a.at - b.at);
}
