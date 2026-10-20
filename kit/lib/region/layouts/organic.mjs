// (6c FL-c, CONTRACT FL §3.4, N-FL-1: moderately irregular) The organic layout: a green with 2 to 4 lanes growing out of it like a
// hamlet that grew, lots of mixed setbacks along lanes that bend. Each lane is a seeded walk in 8 headings that turns by at most 45
// degrees every 6 to 12 cells, preferring the cheaper ground (along the contours on a slope), never closer than 6 to another lane except
// where it joins one; a lane that reaches the land's edge or another lane stops. Lanes are 3 wide (the road; verges where they fit).
// Lots: setback 1 to 5 beyond the road's edge by the seed, gaps 3 to 6, fronts by the nearest lane cell; the green's lots first (central,
// landmark), edge lots at the lanes' ends. Never a grid by accident: an axis-run share of the lanes' cells over 0.6 re-seeds once.
import { line8, to4, polarCell, placeMulti, groundRoadProblem, hubSpace, hubAvoid, spokes, TURN, FL_RULES } from '../frontage.mjs';
import { boundsOf } from './ring.mjs';

/** 32-bit FNV-1a of a string: a lot's own seeded draws (independent of the order the placer tries them in). */
export function fnv32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** A seeded integer in [a, b] from a key. */
const draw = (key, a, b) => a + (fnv32(key) % (b - a + 1));

/** The share of a lane's cells in straight axis-aligned runs of 8 or more (the organic read: over 0.6 is a grid by accident). */
export function axisRunShare(lanes) {
  let inRun = 0, total = 0;
  for (const cells of lanes) {
    total += cells.length;
    let run = 1;
    const flush = () => { if (run >= 8) inRun += run; run = 1; };
    for (let i = 2; i < cells.length; i++) {
      const d1 = [cells[i - 1][0] - cells[i - 2][0], cells[i - 1][1] - cells[i - 2][1]], d2 = [cells[i][0] - cells[i - 1][0], cells[i][1] - cells[i - 1][1]];
      if (d1[0] === d2[0] && d1[1] === d2[1]) run++; else flush();
    }
    flush();
  }
  return total ? Math.round((inRun * 1000) / total) / 1000 : 0;
}

/**
 * The lanes from the green's edge (`r0` from c): `n` seeded walks. Each: heading h (0..7, 45 degrees each), a segment of 6..12 cells, then
 * a turn of -1, 0 or +1 heading (the cheapest next segment's ground change, ties by the seed), until the land ends, another lane comes
 * within 6 (it joins that lane's nearest cell and stops), or `maxLen` cells. Returns `[{cells, join: {x, z, lane} | null}]`.
 */
export function walkLanes(F, c, { n, r0, seed, maxLen = 72 }) {
  const lanes = [];
  const near = (x, z, self) => {
    let best = null;
    for (let j = 0; j < lanes.length; j++) {
      if (j === self) continue;
      for (const [a, b] of lanes[j].cells) { const d = Math.max(Math.abs(a - x), Math.abs(b - z)); if (!best || d < best.d) best = { d, x: a, z: b, lane: j }; }
    }
    return best;
  };
  const okRoad = (x, z) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!F.ok(x + dx, z + dz) || F.occ[F.k(x + dx, z + dz)]) return false; return true; };
  const h0 = draw(`${seed}:h0`, 0, 7);
  for (let j = 0; j < n; j++) {
    let h = (h0 + Math.floor((j * 8) / n)) % 8;
    let p = polarCell(c, h * 32, r0);
    const pts = [p];
    let len = 0, join = null, seg = 0;
    while (len < maxLen) {
      const L = draw(`${seed}:${j}:len:${seg}`, 6, 12);
      // the turn: the heading of -1, 0, +1 whose segment's ground changes least (contours), then the seed's preference
      const pref = draw(`${seed}:${j}:turn:${seg}`, 0, 2) - 1;
      let pick = null;
      for (const dh of [pref, 0, -pref || 1, pref ? -pref : -1].filter((v, i, a) => a.indexOf(v) === i)) {
        const hh = (h + dh + 8) % 8;
        if (seg === 0 && dh !== 0) continue; // the first segment heads straight out of the green
        const q = polarCell(p, hh * 32, L);
        const cells = line8(p, q).slice(1);
        if (!cells.every(([x, z]) => okRoad(x, z))) continue;
        const rise = Math.abs(F.S.heightAt(q[0], q[1]) - F.S.heightAt(p[0], p[1]));
        if (!pick || rise < pick.rise) pick = { hh, q, cells, rise };
      }
      if (!pick) break;
      // another lane within 6: join its nearest cell and stop
      let hit = null;
      for (let t = 0; t < pick.cells.length && !hit; t++) { const nb = near(pick.cells[t][0], pick.cells[t][1], j); if (nb && nb.d < 6 && len + t > 6) hit = { at: t, nb }; }
      if (hit) { pts.push(pick.cells[hit.at]); pts.push([hit.nb.x, hit.nb.z]); join = { x: hit.nb.x, z: hit.nb.z, lane: hit.nb.lane }; break; }
      pts.push(pick.q);
      p = pick.q; h = pick.hh; len += L; seg++;
    }
    const raw = [];
    for (let i = 0; i + 1 < pts.length; i++) { const s = line8(pts[i], pts[i + 1]); raw.push(...(i ? s.slice(1) : s)); }
    let cells = to4(raw.length ? raw : pts, false);
    // the ground road: the longest prefix that is one
    if (groundRoadProblem(F.S, cells)) {
      let lo = 0, hi = cells.length;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (groundRoadProblem(F.S, cells.slice(0, m))) hi = m; else lo = m; }
      cells = cells.slice(0, lo);
      join = null;
    }
    lanes.push({ cells, join });
  }
  return lanes.filter((l) => l.cells.length >= 8);
}

/** One organic layout about c with seed `seed`: `{L}` or `{fail}`. */
export function organicAt(F0, { c, specs, shared, seed }) {
  const F = F0.clone();
  const h = hubSpace(F, c, shared);
  if (h.fail) return { fail: { why: 'hub', message: h.fail } };
  const avoid = hubAvoid(h);
  for (const a of avoid) F.occupy(a, 2);
  const n = Math.max(2, Math.min(4, Math.round(specs.length / 4)));
  const r0 = Math.ceil(((h.sh.u1 - h.sh.u0 + 1) * 3) / 4) + 3;
  const lanes = walkLanes(F, c, { n, r0, seed });
  if (lanes.length < 2) return { fail: { why: 'land', message: 'fewer than 2 lanes grow from the green (the land round it)' } };
  const streets = lanes.map((l, j) => ({ name: `l${j + 1}`, cells: l.cells, closed: false }));
  for (const st of streets) F.markBand(st.cells);
  const crossings = lanes.map((l, j) => (l.join ? { x: l.join.x, z: l.join.z, streets: [`l${j + 1}`, `l${l.join.lane + 1}`] } : null)).filter(Boolean);
  // the slots: the green's lots nearest it, edge lots at the lanes' far ends, the rest outward from the green lane by lane in turn
  const slots = [];
  streets.forEach((st) => st.cells.forEach(([x, z], i) => slots.push({ st, i, sides: draw(`${seed}:side:${st.name}:${i >> 3}`, 0, 1) ? [1, -1] : [-1, 1], d: Math.max(Math.abs(x - c[0]), Math.abs(z - c[1])), x, z })));
  const byD = [...slots].sort((p, q) => p.d - q.d || p.i - q.i || p.st.name.localeCompare(q.st.name));
  const far = [...byD].reverse();
  const out = (s) => (s.placement === 'edge' ? far : byD);
  const placed = placeMulti(F, specs, out, { avoid, setbackOf: (s) => 1 + draw(`${seed}:set:${s.id}`, 1, 5), gapOf: (s) => draw(`${seed}:gap:${s.id}`, 3, 6) });
  for (const l of placed.lots) l.slot = 'street';
  // each lane ends a little past its last lot (a joined lane keeps its join; a lane with no lot keeps its first 12 cells)
  const kept = streets.map((st, j) => {
    if (lanes[j].join) return st;
    const last = Math.max(-1, ...placed.lots.filter((l) => l.street === st.name).map((l) => l.at));
    return { ...st, cells: st.cells.slice(0, Math.min(st.cells.length, Math.max(12, last + 10))) };
  });
  const G = F0.clone();
  for (const st of kept) G.markBand(st.cells);
  for (const a of avoid) G.occupy(a, 2);
  for (const l of placed.lots) { G.occupy(l.rect, 1); for (const [x, z] of l.lane) G.occ[G.k(x, z)] = 3; }
  // the spokes: from the green's edge to each lane's first cell (straight, clear of the lots), so every lane meets the green
  const sp = [];
  for (const st of kept) {
    const to = st.cells[0];
    const run = line8([(h.sh.u0 + h.sh.u1) >> 1, (h.sh.v0 + h.sh.v1) >> 1], to);
    const cells = run.filter(([x, z]) => !(x >= h.sh.u0 && x <= h.sh.u1 && z >= h.sh.v0 && z <= h.sh.v1) && !G.band[G.k(x, z)]);
    const dx = to[0] - (h.sh.u0 + h.sh.u1) / 2, dz = to[1] - (h.sh.v0 + h.sh.v1) / 2;
    const dir = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
    const side = dir[0] ? [0, 1] : [1, 0];
    if (cells.some(([x, z]) => !G.ok(x, z) || G.occ[G.k(x, z)] === 1 || !G.ok(x + side[0], z + side[1]) || G.occ[G.k(x + side[0], z + side[1])] === 1)) continue;
    sp.push({ cells, to, dir, side });
    for (const [x, z] of cells) { G.occ[G.k(x, z)] = 3; G.occ[G.k(x + side[0], z + side[1])] = 3; }
  }
  const L = { kind: 'organic', streets: kept, lots: placed.lots, unplaced: placed.unplaced, hub: h, spokes: sp, F: G, centre: c, crossings, rect: null, axisRun: axisRunShare(kept.map((s) => s.cells)) };
  L.rect = boundsOf(G, kept, placed.lots, h);
  return { L };
}

/**
 * The organic search about c: the zone's seed; an axis-run share over 0.6 re-seeds once (recorded). `{best, fails}`.
 * (The setback is FL_RULES.setback at least: a lot's front edge stands off the verge, 1..5 beyond the road's edge by the seed.)
 */
export function organicSearch(F, { c, specs, shared, rng = null, zoneId = 'z' }) {
  const seed0 = `${zoneId}:${rng ? rng.int(0, 1 << 30) : 0}`;
  const fails = [];
  let g = organicAt(F, { c, specs, shared, seed: seed0 });
  const notes = [];
  if (!g.fail && g.L.axisRun > 0.6) {
    const g2 = organicAt(F, { c, specs, shared, seed: `${seed0}:re` });
    notes.push(`organic: axis-run share ${g.L.axisRun} over 0.6, re-seeded once (now ${g2.fail ? 'failed' : g2.L.axisRun})`);
    if (!g2.fail) g = g2;
  }
  if (g.fail) { fails.push(g.fail); return { best: null, fails }; }
  g.L.notes = [...notes, `organic: ${g.L.streets.length} lanes, axis-run share ${g.L.axisRun}`];
  return { best: g.L, fails };
}

void TURN; void FL_RULES;
