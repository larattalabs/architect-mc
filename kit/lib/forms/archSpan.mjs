// The `archSpan` generator (docs/CONTRACT.md "Phase 7c" §3 row 14, slice PM; SETTLEMENTS §13): an arcade of masonry arches carrying a
// deck across a gap, the first form through the shape-promotion pipeline (kit/lib/forms/CANDIDATES.md, tools/promote.mjs). Plan time
// only; integer maths and Math.sqrt (exact by spec) only: no trig, no `**`, no Date, no Math.random. Deterministic: the same params and
// seed give byte-identical ops on any Node and OS (the promotion's determinism step).
//
// The elevation is drawn in the span's own frame (u along the axis from `at`, y over `at`'s y) and extruded across `width`:
// - one or two **tiers**; each is a row of `bays` arches between piers `pier` thick, its top a solid course (the lower tier's is the
//   string course the upper tier stands on, the upper's the deck). An upper tier has twice the bays, its piers over the lower piers and
//   crowns. Leftover length goes to the end abutments.
// - the **profile** of every arch: `round` (a semicircle), `segmental` (a low circular segment), `pointed` (two-centred), `elliptical`
//   (a flattened half-ellipse). Each soffit is `floor(f(d) + 0.5)` cells over the springing, d the distance from the bay's middle.
// - a **parapet** on the deck's two outer rows: `wall`, `crenel` (every other cell), `rail` (the rail role) or `none`.
// - **piers** reach down to the ground (`groundAt(x, z)`: the ground's top cell; a pier stands on it, at most DROP under `at`), so a span
//   stands across a valley; the bays stay open.
// Roles: `structure` (all masonry), `rail` (a rail parapet). One `columns` op per 16 columns along the span (a bounded cluster).
// Returns `{ops, bounds, generator, version, params, seed, species, stats}`.
import { fnv64, splitmix64 } from '../noise.mjs';

export const GENERATOR = 'archSpan';
/** The module's semver (promotion step 6). */
export const VERSION = '1.0.0';
export const PROFILES = Object.freeze(['round', 'segmental', 'pointed', 'elliptical']);
export const PARAPETS = Object.freeze(['wall', 'crenel', 'rail', 'none']);
/** The deepest a pier reaches under `at` to the ground. */
export const DROP = 32;
/** Columns along the span per op. */
const CHUNK = 16;

/** Species presets: what a seed picks from when a param is not given. */
export const SPECIES = Object.freeze({
  roman: { profile: ['round'], tiers: [1, 2, 2], pier: [2, 3], parapet: ['wall', 'crenel'], spandrel: [1, 2] },
  gothic: { profile: ['pointed'], tiers: [1, 1, 2], pier: [1, 2], parapet: ['crenel', 'wall'], spandrel: [1, 2, 3] },
  bridge: { profile: ['segmental'], tiers: [1], pier: [2, 3, 4], parapet: ['wall', 'rail'], spandrel: [1, 2] },
  viaduct: { profile: ['elliptical', 'round'], tiers: [1, 2], pier: [1, 2, 3], parapet: ['rail', 'none', 'wall'], spandrel: [1, 2, 3] },
});
const isInt = Number.isInteger;

function rng(seed) {
  const h = fnv64(seed, GENERATOR);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  f.pick = (list) => list[Math.floor(g.float() * list.length)];
  return f;
}

/** Validate the params; returns them with the seed's picks filled (every pick drawn in a fixed order, whether or not it is given). */
export function archSpanParams(p) {
  const seed = String(p.seed ?? '1');
  const r = rng(seed);
  const species = p.species ?? r.pick(Object.keys(SPECIES));
  const sp = SPECIES[species];
  if (!sp) throw new Error(`archSpan: species must be one of ${Object.keys(SPECIES).join(', ')}`);
  const picks = {
    profile: r.pick(sp.profile), tiers: r.pick(sp.tiers), pier: r.pick(sp.pier), parapet: r.pick(sp.parapet), spandrel: r.pick(sp.spandrel),
    height: r.int(10, 28), prop: r.int(70, 160), flat: 35 + r.int(0, 25), point: 120 + r.int(0, 80),
  };
  const o = {
    at: p.at, axis: p.axis ?? 'x', length: p.length ?? 48, width: p.width ?? 5,
    height: p.height ?? picks.height, tiers: p.tiers ?? ((p.height ?? picks.height) < 12 ? 1 : picks.tiers), bays: p.bays ?? null, prop: p.prop ?? picks.prop, pier: p.pier ?? picks.pier,
    profile: p.profile ?? picks.profile, parapet: p.parapet ?? picks.parapet, spandrel: p.spandrel ?? picks.spandrel,
    // segmental and elliptical rise, in percent of the half span; pointed radius, in percent of the half span
    flat: p.flat ?? picks.flat, point: p.point ?? picks.point,
  };
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('archSpan: at must be [x, y, z] integers');
  if (o.axis !== 'x' && o.axis !== 'z') throw new Error("archSpan: axis must be 'x' or 'z'");
  if (!(isInt(o.length) && o.length >= 12 && o.length <= 128)) throw new Error('archSpan: length must be 12..128');
  if (!(isInt(o.width) && o.width >= 3 && o.width <= 9)) throw new Error('archSpan: width must be 3..9');
  if (!(isInt(o.height) && o.height >= 6 && o.height <= 48)) throw new Error('archSpan: height must be 6..48');
  if (o.tiers !== 1 && o.tiers !== 2) throw new Error('archSpan: tiers must be 1 or 2');
  if (o.tiers === 2 && o.height < 12) throw new Error('archSpan: two tiers need height 12 or more');
  if (o.bays !== null && !(isInt(o.bays) && o.bays >= 1 && o.bays <= 16)) throw new Error('archSpan: bays must be 1..16 (or absent: from prop)');
  if (!(isInt(o.prop) && o.prop >= 40 && o.prop <= 200)) throw new Error('archSpan: prop must be 40..200 (percent)');
  if (!(isInt(o.pier) && o.pier >= 1 && o.pier <= 4)) throw new Error('archSpan: pier must be 1..4');
  if (!PROFILES.includes(o.profile)) throw new Error(`archSpan: profile must be one of ${PROFILES.join(', ')}`);
  if (!PARAPETS.includes(o.parapet)) throw new Error(`archSpan: parapet must be one of ${PARAPETS.join(', ')}`);
  if (!(isInt(o.spandrel) && o.spandrel >= 1 && o.spandrel <= 4)) throw new Error('archSpan: spandrel must be 1..4');
  if (!(isInt(o.flat) && o.flat >= 20 && o.flat <= 90)) throw new Error('archSpan: flat must be 20..90 (percent)');
  if (!(isInt(o.point) && o.point >= 110 && o.point <= 200)) throw new Error('archSpan: point must be 110..200 (percent)');
  if (p.groundAt !== undefined && typeof p.groundAt !== 'function') throw new Error('archSpan: groundAt must be a function (x, z) -> y');
  return { ...o, seed, species, groundAt: p.groundAt ?? null };
}

/** The soffit's height over the springing (cells, before rounding) at distance d from the middle of a clear span of S cells. */
export function soffit(profile, S, d, flat, point) {
  const R = S / 2;
  if (d >= R) return 0;
  if (profile === 'round') return Math.sqrt(R * R - d * d);
  if (profile === 'segmental') {
    const h = Math.max(1, (R * flat) / 100);
    const Rc = (R * R + h * h) / (2 * h);
    return Math.max(0, Math.sqrt(Math.max(0, Rc * Rc - d * d)) - (Rc - h));
  }
  if (profile === 'pointed') {
    const Rp = (R * point) / 100;
    const e = d + Rp - R;
    return Math.sqrt(Math.max(0, Rp * Rp - e * e));
  }
  // elliptical
  const h = (R * flat) / 100;
  return h * Math.sqrt(Math.max(0, 1 - (d * d) / (R * R)));
}

/**
 * A bay's widest unsupported soffit: the most cells across from a soffit cell to the nearest solid cell one layer down (a lower soffit
 * cell, or a pier at either end). M3's ledge rule (kit/lib/region/check.mjs OVERHANG_LIMIT 4) allows at most OVERHANG.
 */
export function overhangOf(profile, S, flat, point) {
  const o = [];
  for (let t = 0; t < S; t++) o.push(Math.floor(soffit(profile, S, Math.abs(t + 0.5 - S / 2), flat, point) + 0.5));
  let worst = 0;
  for (let t = 0; t < S; t++) {
    let d = Math.min(t + 1, S - t); // the piers
    for (let q = 0; q < S; q++) if (o[q] < o[t] && Math.abs(q - t) < d) d = Math.abs(q - t);
    if (d > worst) worst = d;
  }
  return worst;
}
/** The widest overhang M3's ledge rule allows under a soffit. */
export const OVERHANG = 4;

/** A profile's crown (its highest soffit, rounded) over a clear span S. */
function crownOf(profile, S, flat, point) {
  let m = 0;
  for (let t = 0; t < S; t++) m = Math.max(m, Math.floor(soffit(profile, S, Math.abs(t + 0.5 - S / 2), flat, point) + 0.5));
  return m;
}

/**
 * One tier's layout over [0, L): {open: Int16Array(L)} the open cells over the tier's base per column (0: solid from the base), from
 * bays b between piers P thick, the arches' crowns `spandrel` under the tier's top course. Raises the bay count (narrower bays) until every
 * crown fits under the course with a leg of 0 or more and no soffit cell overhangs more than OVERHANG (M3); past 3-wide bays the rise is clipped.
 */
function tierLayout(L, h, bays, P, profile, spandrel, flat, point) {
  const room = h - spandrel; // open cells available under the solid band (the band: spandrel cells, the course included)
  let nb = Math.max(1, Math.min(bays, Math.floor((L - P) / (P + 3))));
  let S = Math.floor((L - (nb + 1) * P) / nb);
  while (S > 3 && (crownOf(profile, S, flat, point) > room || overhangOf(profile, S, flat, point) > OVERHANG)) { nb++; S = Math.floor((L - (nb + 1) * P) / nb); }
  if (S < 1) { nb = 1; S = Math.max(1, L - 2 * P); }
  const extra = L - nb * S - (nb + 1) * P;
  const left = P + (extra >> 1);
  const open = new Int16Array(L);
  const crown = Math.min(room, crownOf(profile, S, flat, point));
  const leg = Math.max(0, room - crown);
  const bayAt = [];
  for (let b = 0; b < nb; b++) {
    const u0 = left + b * (S + P);
    bayAt.push(u0);
    for (let t = 0; t < S; t++) {
      const s = Math.min(crown, Math.floor(soffit(profile, S, Math.abs(t + 0.5 - S / 2), flat, point) + 0.5));
      open[u0 + t] = leg + s;
    }
  }
  return { open, bays: nb, span: S, crown, leg, bayAt };
}

/** Grow an arch span. */
export function archSpan(params) {
  const p = archSpanParams(params);
  const [ax, ay, az] = p.at;
  const L = p.length, W = p.width, H = p.height;
  const half = W >> 1;
  // the tiers: [base, top] over ay (top: the solid course's cell)
  const tiers = p.tiers === 2 ? [[0, Math.floor((H * 3) / 5)], [Math.floor((H * 3) / 5) + 1, H]] : [[0, H]];
  let lower0 = 1;
  const layouts = tiers.map(([b, t], i) => {
    const P = i === 0 ? p.pier : Math.max(1, p.pier - 1);
    const spandrel = i === 0 ? p.spandrel : Math.max(1, p.spandrel - 1);
    // the bay count: given, or the clear span `prop` percent of the tier's open height (an upper tier: twice the lower's when it fits)
    const want = Math.max(3, Math.floor(((t - b - spandrel) * p.prop) / 100));
    const lower = p.bays ?? Math.max(1, Math.floor((L - P + ((want + P) >> 1)) / (want + P)));
    const bays = i === 0 ? lower : Math.max(lower0 * 2 <= Math.floor((L - P) / (P + 3)) ? lower0 * 2 : lower0, 1);
    if (i === 0) lower0 = lower;
    return { base: b, top: t, ...tierLayout(L, t - b, bays, P, p.profile, spandrel, p.flat, p.point) };
  });
  const xz = (u, w) => (p.axis === 'x' ? [ax + u, az - half + w] : [ax - half + w, az + u]);
  const ground = (x, z) => (p.groundAt ? Math.max(ay - DROP, Math.min(ay, p.groundAt(x, z) + 1)) : ay); // the cell over the ground's top
  const ops = [];
  let cells = 0, minY = ay, maxY = ay + H;
  for (let u0 = 0; u0 < L; u0 += CHUNK) {
    const cols = [];
    for (let u = u0; u < Math.min(L, u0 + CHUNK); u++) for (let w = 0; w < W; w++) {
      const [x, z] = xz(u, w);
      // the solid runs of this column, bottom up (each tier: solid from its base + open to its top)
      const runs = [];
      for (const T of layouts) {
        const lo = ay + T.base + T.open[u], hi = ay + T.top;
        if (lo <= hi) runs.push([lo, hi]);
      }
      // a pier (no opening in the lowest tier) reaches down to the ground
      if (layouts[0].open[u] === 0) { const g = ground(x, z); if (g < ay) runs[0][0] = g; }
      // merge touching runs
      const merged = [];
      for (const r of runs) { const m = merged[merged.length - 1]; if (m && r[0] <= m[1] + 1) m[1] = Math.max(m[1], r[1]); else merged.push([...r]); }
      for (const [lo, hi] of merged) { cols.push(x, z, lo, hi, 0); cells += hi - lo + 1; if (lo < minY) minY = lo; }
      const edge = w === 0 || w === W - 1;
      if (edge && (p.parapet === 'wall' || p.parapet === 'rail' || (p.parapet === 'crenel' && u % 2 === 0))) {
        cols.push(x, z, ay + H + 1, ay + H + 1, p.parapet === 'rail' ? 1 : 0); cells++; maxY = ay + H + 1;
      }
    }
    if (cols.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: ['structure', 'rail'], cond: 2, walk: false });
  }
  const [x0, z0] = xz(0, 0), [x1, z1] = xz(L - 1, W - 1);
  const bounds = { minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), minY, maxY };
  const { groundAt, seed, species, ...rest } = p;
  return {
    generator: GENERATOR, version: VERSION, seed, species,
    params: { ...rest, seed, species },
    ops, bounds,
    stats: { cells, tiers: layouts.map((T) => ({ bays: T.bays, span: T.span, crown: T.crown, leg: T.leg })) },
  };
}
