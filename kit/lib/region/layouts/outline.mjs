// (6c FL-c, CONTRACT FL §4.2) Outlines: `sketch: {shape: polygon | polyline, outline: true}`. A polygon is the zone's mask (the cells
// whose centre lies inside it, in the claim's q64 frame or the anchor's block frame); the zone's layout runs inside it, lots wholly in
// it. A polyline is the street's line: the street laid along it, lots on both sides, the mask the line grown by the deepest lot + the
// setback + 2. Placed as drawn: where the drawing meets an obstacle or the claim's edge the mask is the drawn one less those cells, and
// the deviation is the largest distance from a drawn cell (polygon) or a drawn vertex (polyline) to what is used, in the sketch's unit,
// judged against the part's sketch tolerance (soft 8, ceiling 32). Past it: TOLERANCE with wouldFit the sketch scaled to fit.
import { line8, to4, frontage, groundRoadProblem, FL_RULES } from '../frontage.mjs';
import { boundsOf } from './ring.mjs';

/** A sketch's points in world cells: q64 over the claim, or blocks from its anchor (frame anchor), or from the claim's corner. */
export function sketchCells(claim, s, anchors) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (s.unit === 'q64') return s.points.map(([u, v]) => [claim.minX + Math.floor((u * W) / 64), claim.minZ + Math.floor((v * D) / 64)]);
  const a = s.frame === 'anchor' ? anchors.get(s.anchor) ?? [(claim.minX + claim.maxX) >> 1, (claim.minZ + claim.maxZ) >> 1] : [claim.minX, claim.minZ];
  return s.points.map(([u, v]) => [a[0] + u, a[1] + v]);
}

/** The cells whose centre lies inside a polygon (even-odd; integer arithmetic at doubled coordinates). */
export function polygonCells(pts) {
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const out = [];
  const P = pts.map(([x, z]) => [2 * x, 2 * z]);
  for (let z = Math.min(...zs); z <= Math.max(...zs); z++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
    const px = 2 * x + 1, pz = 2 * z + 1;
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, zi] = P[i], [xj, zj] = P[j];
      if ((zi > pz) !== (zj > pz)) {
        // px < xi + (pz - zi) * (xj - xi) / (zj - zi), compared without division
        const lhs = (px - xi) * (zj - zi), rhs = (pz - zi) * (xj - xi);
        if ((zj - zi > 0 && lhs < rhs) || (zj - zi < 0 && lhs > rhs)) inside = !inside;
      }
    }
    if (inside) out.push([x, z]);
  }
  return out;
}

/** The largest Chebyshev distance from any of `from` to the nearest of `to` (0 when every `from` is in `to`; Infinity with no `to`). */
function farthest(from, to) {
  if (!to.length) return Infinity;
  const T = new Set(to.map(([x, z]) => `${x},${z}`));
  let worst = 0;
  for (const [x, z] of from) {
    if (T.has(`${x},${z}`)) continue;
    let d = Infinity;
    for (const [a, b] of to) { const e = Math.max(Math.abs(a - x), Math.abs(b - z)); if (e < d) d = e; }
    worst = Math.max(worst, d);
  }
  return worst;
}

/** A cell distance in the sketch's unit (q64: 64ths of the claim's larger side, rounded up). */
const toUnit = (claim, s, d) => (s.unit === 'q64' ? Math.ceil((d * 64) / Math.max(claim.maxX - claim.minX + 1, claim.maxZ - claim.minZ + 1)) : d);

/**
 * The outline's mask (polygon) or line (polyline) over the zone's field F: `{mask: Set, centre, deviation, wouldFit?}` |
 * `{line: [[x, z]], deviation, wouldFit?}` | `{error}`. The deviation is in the sketch's unit; `wouldFit` the sketch scaled about its
 * centroid (by tenths) until it is drawn wholly on usable land.
 */
export function outlineMask(env, F, s, { anchors }) {
  const claim = env.claim;
  const ok3 = (x, z) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!F.ok(x + dx, z + dz)) return false; return true; };
  const measure = (sk) => {
    const pts = sketchCells(claim, sk, anchors);
    if (sk.shape === 'polygon') {
      const drawn = polygonCells(pts);
      const used = drawn.filter(([x, z]) => F.ok(x, z));
      return { drawn, used, dev: toUnit(claim, sk, farthest(drawn, used)) };
    }
    const raw = [];
    for (let i = 0; i + 1 < pts.length; i++) { const seg = line8(pts[i], pts[i + 1]); raw.push(...(i ? seg.slice(1) : seg)); }
    const cells = to4(raw.length ? raw : pts, false);
    // the longest run of cells a road may take
    let best = [], cur = [];
    for (const c of cells) { if (ok3(c[0], c[1])) cur.push(c); else { if (cur.length > best.length) best = cur; cur = []; } }
    if (cur.length > best.length) best = cur;
    return { drawn: cells, used: best, dev: toUnit(claim, sk, farthest(pts, best)) };
  };
  const m = measure(s);
  if (s.shape === 'point') return { error: { code: 'SCHEMA', message: 'an outline is a polygon or a polyline (a point has no outline)', evidence: { shape: 'point' } } };
  // the wouldFit: the sketch scaled about its centroid until the drawing is whole (deviation 0), checked here
  let wouldFit = null;
  if (m.dev > 0) {
    // about the centroid of what is used (in the sketch's unit): the drawing shrinks onto the land it already holds
    const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
    const nu = Math.max(1, m.used.length);
    const ux = Math.floor(m.used.reduce((a, c) => a + c[0], 0) / nu), uz = Math.floor(m.used.reduce((a, c) => a + c[1], 0) / nu);
    const org = s.unit === 'q64' ? null : s.frame === 'anchor' ? anchors.get(s.anchor) ?? [(claim.minX + claim.maxX) >> 1, (claim.minZ + claim.maxZ) >> 1] : [claim.minX, claim.minZ];
    const cx = m.used.length ? (org ? ux - org[0] : Math.floor(((ux - claim.minX) * 64) / W)) : Math.floor(s.points.reduce((a, p) => a + p[0], 0) / s.points.length);
    const cz = m.used.length ? (org ? uz - org[1] : Math.floor(((uz - claim.minZ) * 64) / D)) : Math.floor(s.points.reduce((a, p) => a + p[1], 0) / s.points.length);
    for (let pct = 90; pct >= 10 && !wouldFit; pct -= 10) {
      const sk = { ...s, points: s.points.map(([u, v]) => [cx + Math.trunc(((u - cx) * pct) / 100), cz + Math.trunc(((v - cz) * pct) / 100)]) };
      const q = measure(sk);
      if (q.dev === 0 && q.used.length >= (s.shape === 'polygon' ? 64 : 24)) wouldFit = sk;
    }
  }
  if (!m.used.length) return { error: { code: 'TOLERANCE', message: 'the outline lies wholly off the zone\'s land (the claim, water, keep-out or the parts before it)', evidence: { what: 'outline', drawn: m.drawn.length } }, ...(wouldFit ? { wouldFit } : {}) };
  if (s.shape === 'polygon') {
    const mask = new Set(m.used.map(([x, z]) => `${x},${z}`));
    const n = m.used.length;
    const centre = [Math.floor(m.used.reduce((a, c) => a + c[0], 0) / n), Math.floor(m.used.reduce((a, c) => a + c[1], 0) / n)];
    return { mask, centre, deviation: m.dev, drawnCells: m.drawn.length, usedCells: n, ...(wouldFit ? { wouldFit } : {}) };
  }
  const n = m.used.length;
  return { line: m.used, centre: m.used[n >> 1], deviation: m.dev, ...(wouldFit ? { wouldFit } : {}) };
}

/**
 * A street along a line (a polyline outline), or one straight street through c (`straight`: along `orientation`, auto the longer run of
 * the land through c), lots on both sides: `L` (kind 'street') or null. A drawn line keeps the land within the deepest lot + the setback
 * + 2 of it as the mask.
 */
export function polylineLayout(F0, { line = null, c = null, specs, straight = false, orientation = 'auto' }) {
  if (straight) {
    // one straight street through the land: each axis allowed (orientation, else both) and each offset from c (by 2, within 24), the
    // run of land through it; the line placing the most lots (then the longer, then the nearer c) wins
    let best = null;
    for (const axis of orientation === 'ew' || orientation === 'ns' ? [orientation] : ['ew', 'ns']) for (let off = 0; off <= 24; off = off > 0 ? -off : -off + 2) {
      const o = axis === 'ew' ? [c[0], c[1] + off] : [c[0] + off, c[1]];
      const run = (dx, dz) => { const out = []; for (let t = 1; t < 512; t++) { const x = o[0] + dx * t, z = o[1] + dz * t; let ok = true; for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1; b++) if (!F0.ok(x + a, z + b)) { ok = false; break; } if (!ok) break; out.push([x, z]); } return out; };
      let okO = true;
      for (let a = -1; a <= 1 && okO; a++) for (let b = -1; b <= 1; b++) if (!F0.ok(o[0] + a, o[1] + b)) { okO = false; break; }
      if (!okO) { if (off === -24) break; continue; }
      const [a, b] = axis === 'ew' ? [run(-1, 0), run(1, 0)] : [run(0, -1), run(0, 1)];
      const L = polylineLayout(F0, { line: [...[...a].reverse(), o, ...b], specs, keepMask: false });
      if (L && (!best || L.unplaced.length < best.unplaced.length || (L.unplaced.length === best.unplaced.length && L.streets[0].cells.length > best.streets[0].cells.length))) best = { ...L, streets: L.streets.map((s) => ({ ...s, name: 'main' })) };
      if (off === -24) break;
    }
    return best;
  }
  return lineLayout(F0, { line, specs, keepMask: line !== null });
}

/** Lots on both sides of one street line (a drawn polyline keeps only the land near it as the mask). */
function lineLayout(F0, { line, specs, keepMask = true }) {
  const F = F0.clone();
  let cells = line;
  if (!cells || cells.length < 16) return null;
  if (groundRoadProblem(F.S, cells)) {
    let lo = 0, hi = cells.length;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (groundRoadProblem(F.S, cells.slice(0, m))) hi = m; else lo = m; }
    cells = cells.slice(0, lo);
    if (cells.length < 16) return null;
  }
  if (keepMask) {
    const deep = Math.max(...specs.map((s) => s.size[1]));
    const R = deep + FL_RULES.setback + 2 + 4; // (4: the setback a curving line pushes a lot out by)
    const near = new Set();
    for (const [x, z] of cells) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) near.add(`${x + dx},${z + dz}`);
    F.keepOnly((x, z) => near.has(`${x},${z}`));
  }
  F.markBand(cells);
  const st = { name: 'line', cells, closed: false };
  const r = frontage(F, st, specs, { sides: (i) => ((i >> 4) % 2 ? [1, -1] : [-1, 1]), spread: false, start: 0 });
  for (const l of r.lots) l.slot = 'street';
  // the street ends a little past its outer lots
  const ats = r.lots.map((l) => l.at);
  const a0 = Math.max(0, Math.min(...ats, cells.length) - 10), a1 = Math.min(cells.length, Math.max(...ats, 0) + 11);
  const used = r.lots.length ? cells.slice(a0, a1) : cells;
  const lots = r.lots.map((l) => ({ ...l, at: l.at - a0 }));
  const G = F0.clone();
  if (keepMask) G.mask.set(F.mask);
  G.markBand(used);
  for (const l of lots) { G.occupy(l.rect, 1); for (const [x, z] of l.lane) G.occ[G.k(x, z)] = 3; }
  const st2 = { name: st.name, cells: used, closed: false };
  const mid = used[used.length >> 1];
  return { kind: 'street', streets: [st2], lots, unplaced: r.unplaced, hub: null, spokes: [], F: G, centre: mid, bellAt: mid, rect: boundsOf(G, [st2], lots, null) };
}
