// (6c FL-a, CONTRACT FL §3.1, §4.1) The ring: a closed street round an open hub, lots on its outer side facing in (N-FL-2), central and
// landmark lots in the hub facing the street (S-FL-3), the hub's square, green or nothing at its centre. `around` a feature is the same
// ring with its radius following the feature's footprint (`base`), the feature itself the hub (nothing written in it), lots outside it
// facing it; closed: false leaves out the arc nearest the claim's centre.
import { Field, polarLoop, frontage, groundRoadProblem, hubSpace, hubAvoid, spokes, alongX, orderOf, stepOf, TURN, FL_RULES } from '../frontage.mjs';

const mod = (k, n) => ((k % n) + n) % n;

/** The side signs at index i of a loop about c: outer first (away from c along the lot's normal axis), or inner. */
export function sidesAbout(st, c, which) {
  return (i) => {
    const [x, z] = st.cells[i];
    const d = alongX(st, i) ? z - c[1] : x - c[0];
    const out = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (!out) return [];
    return which === 'outer' ? [out] : [-out];
  };
}

/** A level spot for a bare hub's bell area (shared none): the centre, else the nearest level 5x5 within `reach` (step 2). */
export function bareHub(F, c, reach) {
  for (let d = 0; d <= reach; d += 2) {
    for (let dz = -d; dz <= d; dz += 2) for (let dx = -d; dx <= d; dx += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
      const h = hubSpace(F, [c[0] + dx, c[1] + dz], { kind: 'none' });
      if (!h.fail) return h;
    }
  }
  return null;
}

/**
 * One ring at radius R (the centre line `base[k] + R` about c): `{L}` or `{fail: {why, message}}`. `F0` the zone's field (not changed).
 * `hub`: lay a hub (shared space, hub lots, spokes); false for `around` (the feature is the hub). `open`: the step whose arc is left out.
 */
export function ringAt(F0, { c, R, specs, shared, base = null, hub = true, open = null }) {
  const F = F0.clone();
  const rad = (k) => (base ? base[k] : 0) + R;
  let cells = polarLoop(c, rad);
  let closed = true;
  if (open !== null) {
    // the arc within 1/12 turn either side of `open` left out: the line runs from just past it round to just before it
    const off = cells.map(([x, z]) => mod(stepOf(x - c[0], z - c[1]) - open, TURN));
    const gapAt = (i) => off[i] <= 21 || off[i] >= TURN - 21;
    let s = cells.findIndex((_, i) => gapAt(i) && !gapAt((i + 1) % cells.length));
    if (s < 0) return { fail: { why: 'open', message: 'no gap could be left in the ring' } };
    s = (s + 1) % cells.length;
    const line = [];
    for (let t = 0; t < cells.length; t++) { const i = (s + t) % cells.length; if (gapAt(i)) break; line.push(cells[i]); }
    cells = line;
    closed = false;
  }
  if (cells.length < 16) return { fail: { why: 'small', message: `a ring of radius ${R} is too small for a street` } };
  const bad = F.streetOk(cells);
  if (bad) return { fail: { why: 'land', message: `the ring street (radius ${R}) leaves the zone's land at ${bad.x},${bad.z}`, at: bad } };
  const grade = groundRoadProblem(F.S, closed ? [...cells, ...cells.slice(0, 8)] : cells);
  if (grade) return { fail: { why: 'grade', message: `the ring street (radius ${R}) is not a ground road: ${grade}` } };
  F.markBand(cells);
  const st = { name: 'ring', cells, closed };
  let h = null, avoid = [];
  if (hub) {
    h = shared.kind === 'none' ? bareHub(F, c, Math.max(0, R - 12)) : hubSpace(F, c, shared);
    if (!h || h.fail) return { fail: { why: 'hub', message: h?.fail ?? `no level spot for the hub's bell area inside the ring (radius ${R})` } };
    avoid = hubAvoid(h);
    for (const a of avoid) F.occupy(a, 2);
  }
  // central and landmark lots in the hub (inner side, facing the street), as many as it holds; the rest outside, facing in
  const hubSpecs = hub ? specs.filter((s) => s.placement === 'central' || s.landmark) : [];
  const inner = hubSpecs.length ? frontage(F, st, hubSpecs, { sides: sidesAbout(st, c, 'inner'), avoid, centre: c }) : { lots: [], unplaced: [] };
  for (const l of inner.lots) l.slot = 'hub';
  const rest = [...specs.filter((s) => !hubSpecs.includes(s)), ...hubSpecs.filter((s) => inner.unplaced.some((u) => u.id === s.id))].sort((a, b) => a._i - b._i);
  const outer = frontage(F, st, rest, { sides: sidesAbout(st, c, 'outer'), avoid, placed: inner.lots, centre: c });
  for (const l of outer.lots) l.slot = 'street';
  const sp = h && h.sh.kind !== 'none' ? spokes(F, h, 4) : [];
  const lots = [...inner.lots, ...outer.lots];
  // (around: no hub) the bell on the street, at its cell nearest the claim's centre
  const cc = [(F.claim.minX + F.claim.maxX) >> 1, (F.claim.minZ + F.claim.maxZ) >> 1];
  const bellAt = h ? null : cells.reduce((b, q) => (Math.max(Math.abs(q[0] - cc[0]), Math.abs(q[1] - cc[1])) < Math.max(Math.abs(b[0] - cc[0]), Math.abs(b[1] - cc[1])) ? q : b), cells[0]);
  return { L: { kind: 'ring', streets: [st], lots, unplaced: outer.unplaced, hub: h, spokes: sp, F, centre: c, R, ...(bellAt ? { bellAt } : {}), rect: boundsOf(F, [st], lots, h) } };
}

/** The bounding rect of a layout: its streets' bands, its lots and its hub's space. */
export function boundsOf(F, streets, lots, h) {
  let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
  const add = (x0, z0, x1, z1) => { a = Math.min(a, x0); b = Math.min(b, z0); cc = Math.max(cc, x1); d = Math.max(d, z1); };
  for (const st of streets) for (const [x, z] of st.cells) add(x - 2, z - 2, x + 2, z + 2);
  for (const l of lots) add(...l.rect);
  if (h) add(...h.sh.rect);
  const cl = F.claim;
  return { minX: Math.max(cl.minX, a), minZ: Math.max(cl.minZ, b), maxX: Math.min(cl.maxX, cc), maxZ: Math.min(cl.maxZ, d) };
}

/**
 * The ring's radius search about c: the smallest radius (by 2 from `r0` to `r1`) whose rings place every lot, else the one placing the
 * most (then the smaller). `{best, tried, fails}`.
 */
export function ringSearch(F, { c, specs, shared, base = null, hub = true, open = null, r0, r1, step = 2 }) {
  let best = null;
  const fails = [];
  let tried = 0;
  // the outer frontage's lower bound: a ring of radius R holds about 5 (R + 3) cells of fronts (2 pi at 80%)
  const need = specs.filter((s) => !(hub && (s.placement === 'central' || s.landmark))).reduce((a, s) => a + s.size[0] + FL_RULES.lotGap, 0);
  for (let R = r0; R <= r1; R += step) {
    if (!base && 5 * (R + 3) < need && R + step <= r1) continue;
    tried++;
    const g = ringAt(F, { c, R, specs, shared, base, hub, open });
    if (g.fail) { fails.push({ R, ...g.fail }); continue; }
    const L = g.L;
    if (!best || L.unplaced.length < best.unplaced.length) best = L;
    if (L.unplaced.length === 0) break;
  }
  return { best, tried, fails };
}

void orderOf; void Field;
