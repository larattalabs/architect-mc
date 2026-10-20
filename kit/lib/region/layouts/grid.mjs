// (6c FL-b, CONTRACT FL §3.3) The grid: blocks of V streets. Avenues along one axis (the zone's C37 orientation: `ew` avenues run
// east-west; auto: the longer side of the land), cross streets along the other, lots back to back in each block facing its two avenues.
// Block depth = 2 x the deepest lot + the gap (plus the setbacks); block length fits k lots (k 2..6, the best fill). The central block is
// the plaza (square: V's square filling the block; well: the green; none: an ordinary block); central and landmark lots take the slots
// nearest it (facing it across its avenues), edge lots the outer blocks. Avenues are numbered from the start side (street_a1, a2, ...;
// cross streets street_c1, ...). This is the only free layout that reads orientation.
import { placeMulti, groundRoadProblem, hubSpace, FL_RULES } from '../frontage.mjs';
import { levelStats, reservations } from '../village.mjs';
import { boundsOf } from './ring.mjs';

/** Block grids tried (blocks along the avenue x across), smallest first; odd counts have a central block. */
const GRIDS = Object.freeze([[1, 1], [3, 1], [1, 3], [3, 3], [5, 3], [3, 5], [5, 5], [7, 5], [5, 7]]);

/**
 * One grid about c: `{L}` or `{fail}`. `axis` 'ew' | 'ns' (the avenues' run), `k` lots per block row, `[bu, bv]` blocks.
 */
export function gridAt(F0, { c, specs, shared, axis, k, bu, bv }) {
  const F = F0.clone();
  const W = (u, v) => (axis === 'ew' ? [u, v] : [v, u]);
  const rest = specs.filter((s) => true);
  const D = Math.max(...rest.map((s) => s.size[1]));
  const ws = rest.map((s) => s.size[0]).sort((a, b) => a - b);
  const wMed = ws[ws.length >> 1], wMax = ws[ws.length - 1];
  const gap = FL_RULES.lotGap;
  const blockLen = Math.max(wMax, k * wMed + (k - 1) * gap);
  const Sc = blockLen + 2 * FL_RULES.setback - 1; // cross streets' spacing: the block's lots 3 from each cross street's centre
  const Sa = 2 * D + 2 * FL_RULES.setback + gap + 1; // avenues' spacing: two rows back to back, 3 from each avenue's centre
  const U = bu * Sc, V = bv * Sa;
  const [cu, cv] = axis === 'ew' ? c : [c[1], c[0]];
  const u0 = cu - (U >> 1), v0 = cv - (V >> 1);
  const avenues = [], cross = [];
  for (let a = 0; a <= bv; a++) {
    const v = v0 + a * Sa;
    const cells = [];
    for (let u = u0; u <= u0 + U; u++) cells.push(W(u, v));
    avenues.push({ name: `a${a + 1}`, cells, closed: false, v });
  }
  for (let b = 0; b <= bu; b++) {
    const u = u0 + b * Sc;
    const cells = [];
    for (let v = v0; v <= v0 + V; v++) cells.push(W(u, v));
    cross.push({ name: `c${b + 1}`, cells, closed: false, u });
  }
  const streets = [...avenues, ...cross];
  for (const st of streets) {
    const bad = F.streetOk(st.cells);
    if (bad) return { fail: { why: 'land', message: `street ${st.name} leaves the zone's land at ${bad.x},${bad.z}` } };
    const g = groundRoadProblem(F.S, st.cells);
    if (g) return { fail: { why: 'grade', message: `street ${st.name} is not a ground road: ${g}` } };
  }
  for (const st of streets) F.markBand(st.cells);
  // the plaza: the central block (odd counts), its interior 3 from every street's centre
  let hub = null, avoid = [];
  const pb = bu % 2 === 1 && bv % 2 === 1 ? [bu >> 1, bv >> 1] : null;
  if (pb && shared.kind !== 'none') {
    const pu0 = u0 + pb[0] * Sc + FL_RULES.setback, pu1 = u0 + (pb[0] + 1) * Sc - FL_RULES.setback;
    const pv0 = v0 + pb[1] * Sa + FL_RULES.setback, pv1 = v0 + (pb[1] + 1) * Sa - FL_RULES.setback;
    const [x0, z0] = W(pu0, pv0), [x1, z1] = W(pu1, pv1);
    const rect = [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];
    if (shared.kind === 'square') {
      const st = levelStats(F.S, rect);
      for (let z = rect[1]; z <= rect[3]; z++) for (let x = rect[0]; x <= rect[2]; x++) if (!F.ok(x, z)) return { fail: { why: 'hub', message: `the plaza leaves the zone's land at ${x},${z}` } };
      if (st.water || st.cut > 2 || st.fill > 2) return { fail: { why: 'hub', message: `the plaza needs a cut of ${st.cut} and a fill of ${st.fill} (at most 2)` } };
      const sh = { kind: 'square', u0: rect[0], u1: rect[2], v0: rect[1], v1: rect[3], side: 0, cu: (rect[0] + rect[2]) >> 1, y: st.top, rect };
      // the bell area and golem space as V's 11 x 11 square would hold them, at the plaza's centre (the golem within 8 of the bell)
      const mx = (rect[0] + rect[2]) >> 1, mz = (rect[1] + rect[3]) >> 1;
      hub = { sh, res: reservations('ew', { ...sh, u0: mx - 5, u1: mx + 5, v0: mz - 5, v1: mz + 5, cu: mx }) };
    } else {
      const h = hubSpace(F, [(rect[0] + rect[2]) >> 1, (rect[1] + rect[3]) >> 1], shared);
      if (h.fail) return { fail: { why: 'hub', message: h.fail } };
      hub = h;
    }
    avoid = [rect];
    F.occupy(rect, 2);
  }
  const pc = hub ? [(hub.sh.u0 + hub.sh.u1) >> 1, (hub.sh.v0 + hub.sh.v1) >> 1] : c;
  // the slots: every avenue cell (both sides), by distance to the plaza; edge lots the farthest first
  const slots = [];
  // (the outer avenues hold lots on their inner side only: every lot stands in a block)
  avenues.forEach((st, a) => { const sides = a === 0 ? [1] : a === bv ? [-1] : [1, -1]; st.cells.forEach(([x, z], i) => slots.push({ st, i, sides, d: Math.max(Math.abs(x - pc[0]), Math.abs(z - pc[1])), x, z })); });
  const near = [...slots].sort((p, q) => p.d - q.d || p.z - q.z || p.x - q.x);
  const far = [...near].reverse();
  const slotsFor = (s) => (s.placement === 'edge' ? far : near);
  const placed = placeMulti(F, specs, slotsFor, { avoid });
  for (const l of placed.lots) l.slot = 'street';
  // the street junctions where avenues and cross streets meet
  const crossings = [];
  for (const a of avenues) for (const b of cross) { const at = W(b.u, a.v); crossings.push({ x: at[0], z: at[1], streets: [a.name, b.name] }); }
  const L = { kind: 'grid', orientation: axis, streets, lots: placed.lots, unplaced: placed.unplaced, hub, spokes: [], F, centre: c, crossings, blocks: [bu, bv], k, blockLen, rect: null };
  L.rect = boundsOf(F, streets, placed.lots, hub);
  return { L };
}

/**
 * The grid's search about c: k (lots a block row) 2..6 and the block grids, smallest land first; the first that places every lot, else
 * the one placing the most (then the smaller). `{best, fails, axis}`.
 */
export function gridSearch(F, { c, specs, shared, orientation = 'auto' }) {
  // the avenues' axis: forced, or the land's longer side about c (ties: east-west)
  let axis = orientation;
  if (axis !== 'ew' && axis !== 'ns') {
    const run = (dx, dz) => { let n = 0; for (let t = 1; t < 512; t++) { if (!F.ok(c[0] + dx * t, c[1] + dz * t)) break; n++; } return n; };
    const lx = run(1, 0) + run(-1, 0), lz = run(0, 1) + run(0, -1);
    axis = lz > lx ? 'ns' : 'ew';
  }
  const D = Math.max(...specs.map((s) => s.size[1]));
  const ws = specs.map((s) => s.size[0]).sort((a, b) => a - b);
  const wMed = ws[ws.length >> 1], wMax = ws[ws.length - 1];
  const tries = [];
  // (a grid has a plaza block with blocks round it: 3 x 3 or more once the lots fill more than a block's two rows)
  const small = specs.length <= 4;
  for (const [bu, bv] of GRIDS) for (let k = 2; k <= 6; k++) {
    if (!small && (bu < 3 || bv < 3)) continue;
    const blockLen = Math.max(wMax, k * wMed + (k - 1) * FL_RULES.lotGap);
    const Sc = blockLen + 2 * FL_RULES.setback - 1, Sa = 2 * D + 2 * FL_RULES.setback + FL_RULES.lotGap + 1;
    // capacity: two rows a block, each about k lots; the plaza block holds none
    const blocks = bu * bv - (bu % 2 && bv % 2 && shared.kind !== 'none' ? 1 : 0);
    if (blocks * 2 * Math.max(1, Math.floor((blockLen + FL_RULES.lotGap) / (wMed + FL_RULES.lotGap))) < specs.length) continue;
    void wMed;
    tries.push({ bu, bv, k, area: (bu * Sc) * (bv * Sa) });
  }
  tries.sort((p, q) => p.area - q.area || p.k - q.k || p.bu - q.bu || p.bv - q.bv);
  let best = null;
  const fails = [];
  for (const t of tries.slice(0, 24)) {
    const g = gridAt(F, { c, specs, shared, axis, k: t.k, bu: t.bu, bv: t.bv });
    if (g.fail) { fails.push({ ...t, ...g.fail }); continue; }
    if (!best || g.L.unplaced.length < best.unplaced.length) best = g.L;
    if (!g.L.unplaced.length) break;
  }
  if (best) best.notes = [`grid: ${best.blocks[0]} x ${best.blocks[1]} blocks, ${best.k} lots a block row, avenues ${axis === 'ew' ? 'east-west' : 'north-south'}`];
  return { best, fails, axis };
}
