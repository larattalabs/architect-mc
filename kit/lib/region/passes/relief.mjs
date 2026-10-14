// (6c T1) The `relief` pass (docs/SETTLEMENTS.md §4.1, docs/CONTRACT.md 6c T1 §5, kit/REGIONS.md "Passes"): a smooth target
// surface around pads and path corridors, by integer Jacobi relaxation over the plan survey with the pins fixed, then an optional
// erosion touch-up. Plan time only (never at realise); under the realise lint all the same (integer math, Math.floor/abs/min/max
// only, no clock), so a replan gives the same field on every Node major. Pure: (survey, volumes, intent) -> {fields, ops, data}.
import { FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../pack.mjs';

/** A field sample that is not part of the op (the evaluator's RELIEF_NONE). */
export const NONE = -32768;
/** Fixed-point scale of the relaxation (1/16 block). */
const FP = 16;
/** Columns this close to water (Chebyshev, in survey cells) keep their ground: a cut beside water would let it in. */
const WATER_GUARD = 2;
/** Erosion's extra |dh| over the blend, per column (CONTRACT T1 §5). */
export const ERODE_MAX = 4;
/** Thermal erosion moves material while a drop to the lowest neighbour is over this. */
const TALUS = 2;

const isInt = Number.isInteger;

/**
 * The pins of `around` on the survey grid: lot results (`{at, size, floorY}`: the footprint and its 1-column apron at the pad's
 * top y, floorY - 1), corridors (`{path: [[x, y, z], ...], width}`: the centre line at its own profile y, integer-interpolated,
 * widened to `width`) and rects (`{rect: [x0, z0, x1, z1], y}`). Returns `{pin: Int16Array (NONE = free), kind: Uint8Array
 * (1 a pad's footprint or a rect, 2 corridor, 3 a lot's apron)}`. The first pin of a cell wins.
 */
export function pinsOf(c, around) {
  const n = c.width * c.depth, r = c.resolution;
  const pin = new Int16Array(n).fill(NONE), kind = new Uint8Array(n);
  const put = (x, z, y, k) => {
    const i = Math.floor((x - c.minX) / r), j = Math.floor((z - c.minZ) / r);
    if (i < 0 || j < 0 || i >= c.width || j >= c.depth) return;
    const q = i + j * c.width;
    if (pin[q] === NONE) { pin[q] = y; kind[q] = k; }
  };
  const rect = (x0, z0, x1, z1, y, k) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, z, y, k); };
  for (const a of around ?? []) {
    if (a && Array.isArray(a.at) && Array.isArray(a.size) && isInt(a.floorY)) {
      // the footprint (kind 1: the lot's own) first, then its apron ring (kind 3: the pass writes it at the pad's top, so a plant or
      // a dip on the apron never leaves a step at the entrance)
      rect(a.at[0], a.at[1], a.at[0] + a.size[0] - 1, a.at[1] + a.size[1] - 1, a.floorY - 1, 1);
      rect(a.at[0] - 1, a.at[1] - 1, a.at[0] + a.size[0], a.at[1] + a.size[1], a.floorY - 1, 3);
    } else if (a && Array.isArray(a.rect) && isInt(a.y)) {
      rect(a.rect[0], a.rect[1], a.rect[2], a.rect[3], a.y, 1);
    } else if (a && Array.isArray(a.path)) {
      const half = Math.floor(((a.width ?? 3) - 1) / 2), half2 = (a.width ?? 3) - 1 - half;
      for (const p of a.path) if (!Array.isArray(p) || p.length !== 3 || !p.every(isInt)) throw new Error('relief: a corridor path is [[x, y, z], ...] integers');
      for (let s = 0; s + 1 < a.path.length; s++) {
        const [x0, y0, z0] = a.path[s], [x1, y1, z1] = a.path[s + 1];
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), 1);
        for (let k = 0; k <= steps; k++) {
          // integer interpolation, rounded half up (no floats in the cell positions)
          const x = x0 + Math.floor((2 * (x1 - x0) * k + steps) / (2 * steps));
          const z = z0 + Math.floor((2 * (z1 - z0) * k + steps) / (2 * steps));
          const y = y0 + Math.floor((2 * (y1 - y0) * k + steps) / (2 * steps));
          rect(x - half, z - half, x + half2, z + half2, y, 2);
        }
      }
    } else throw new Error('relief: each `around` item is a lot (from r.lot), {path, width} or {rect, y}');
  }
  return { pin, kind };
}

/** Multi-source 8-neighbour BFS from the pinned cells: the distance (in survey cells, Chebyshev) and the source's pin y. */
function nearestPin(c, pin) {
  const n = c.width * c.depth, W = c.width, D = c.depth;
  const dist = new Int32Array(n).fill(-1), src = new Int16Array(n);
  let q = new Int32Array(n), qn = 0;
  for (let i = 0; i < n; i++) if (pin[i] !== NONE) { dist[i] = 0; src[i] = pin[i]; q[qn++] = i; }
  let next = new Int32Array(n);
  let d = 0;
  while (qn) {
    d++;
    let nn = 0;
    for (let t = 0; t < qn; t++) {
      const i = q[t], x = i % W, z = (i - x) / W;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
        const j = X + Z * W;
        if (dist[j] >= 0) continue;
        dist[j] = d; src[j] = src[i]; next[nn++] = j;
      }
    }
    const t = q; q = next; next = t; qn = nn;
  }
  return { dist, src };
}

/**
 * The relaxation and the touch-up on a grid, exported for the unit tests (a hand case): `ground` (Int16Array, the land the pass
 * blends into), `base` (Int16Array or null: the clamps' reference, default `ground`), `pin` (NONE = free), `fixed` (Uint8Array:
 * columns that keep their ground), `W`, `D`, `R` (the band radius in cells), `iterations`, `maxCut`, `maxFill`, `erode`
 * ({thermal, stream, streamAt}), `minY` (no new ground below it: the world's bottom rows). Returns `{h (Int16Array, the new ground), band (Uint8Array), clamped, eroded, maxExtra}`.
 */
export function relax({ ground, base = null, pin, fixed, wall = null, W, D, R, iterations, maxCut, maxFill, erode = null, minY = -32768 }) {
  const n = W * D;
  const ref = base ?? ground;
  const { dist, src } = nearestPin({ width: W, depth: D }, pin);
  const band = new Uint8Array(n);
  let h = new Int32Array(n), h2 = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (pin[i] !== NONE) { h[i] = pin[i] * FP; continue; }
    const g = ground[i] * FP;
    if (fixed[i] || dist[i] < 0 || dist[i] > R) { h[i] = g; continue; }
    band[i] = 1;
    // distance-weighted start: the pin's y at the pin, the land at R + 1
    h[i] = g + Math.floor(((src[i] * FP - g) * (R + 1 - dist[i])) / (R + 1));
  }
  const lo = (i) => Math.max(ref[i] - maxCut, minY) * FP, hi = (i) => (ref[i] + maxFill) * FP;
  let clamped = 0;
  for (let it = 0; it < iterations; it++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const i = x + z * W;
        if (!band[i]) { h2[i] = h[i]; continue; }
        // (6c S2) a wall column (a kept natural cell's column: its ground is the kept form's top, not the land) is no neighbour:
        // the band meets it as it meets the claim's edge
        const open = (j) => !wall || !wall[j];
        const e = x + 1 < W && open(i + 1) ? h[i + 1] : h[i], w = x > 0 && open(i - 1) ? h[i - 1] : h[i], s = z + 1 < D && open(i + W) ? h[i + W] : h[i], nn = z > 0 && open(i - W) ? h[i - W] : h[i];
        let v = Math.floor((e + w + s + nn + 2) / 4);
        const a = lo(i), b = hi(i);
        if (v < a) v = a; else if (v > b) v = b;
        h2[i] = v;
      }
    }
    const t = h; h = h2; h2 = t;
  }
  // round to blocks; count the band columns the clamp holds
  const H = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    H[i] = Math.floor((h[i] + FP / 2) / FP);
    if (band[i]) {
      const a = Math.max(ref[i] - maxCut, minY), b = ref[i] + maxFill;
      if (H[i] <= a || H[i] >= b) { if (H[i] < a) H[i] = a; if (H[i] > b) H[i] = b; clamped++; }
    }
  }
  // erosion touch-up: thermal (a drop over TALUS slides one block to the lowest neighbour) and stream (D8 accumulation cuts one
  // block where it is over streamAt), at most ERODE_MAX extra |dh| a column, never on a pin or outside the band
  const blend = Int16Array.from(H);
  let eroded = 0, maxExtra = 0;
  const can = (i, d) => band[i] && Math.abs(H[i] + d - blend[i]) <= ERODE_MAX && H[i] + d >= Math.max(ref[i] - maxCut, minY) && H[i] + d <= ref[i] + maxFill;
  if (erode && erode.thermal > 0) {
    for (let it = 0; it < erode.thermal; it++) {
      for (let z = 0; z < D; z++) {
        for (let x = 0; x < W; x++) {
          const i = x + z * W;
          if (!band[i]) continue;
          let low = -1, lv = H[i];
          if (x + 1 < W && H[i + 1] < lv) { low = i + 1; lv = H[i + 1]; }
          if (x > 0 && H[i - 1] < lv) { low = i - 1; lv = H[i - 1]; }
          if (z + 1 < D && H[i + W] < lv) { low = i + W; lv = H[i + W]; }
          if (z > 0 && H[i - W] < lv) { low = i - W; lv = H[i - W]; }
          if (low < 0 || H[i] - lv <= TALUS) continue;
          if (!can(i, -1) || !can(low, 1)) continue;
          H[i]--; H[low]++;
        }
      }
    }
  }
  if (erode && erode.stream > 0) {
    const at = erode.streamAt ?? 24;
    for (let it = 0; it < erode.stream; it++) {
      // band cells, highest first (ties by index): each passes its accumulation to its lowest lower 8-neighbour in the band
      const cells = [];
      for (let i = 0; i < n; i++) if (band[i]) cells.push(i);
      cells.sort((a, b) => H[b] - H[a] || a - b);
      const acc = new Int32Array(n);
      for (const i of cells) {
        acc[i] += 1;
        const x = i % W, z = (i - x) / W;
        let low = -1, lv = H[i];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
          const j = X + Z * W;
          if (band[j] && H[j] < lv) { low = j; lv = H[j]; }
        }
        if (low >= 0) acc[low] += acc[i];
      }
      for (const i of cells) if (acc[i] >= at && can(i, -1)) H[i]--;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!band[i]) continue;
    const e = Math.abs(H[i] - blend[i]);
    if (e) { eroded++; if (e > maxExtra) maxExtra = e; }
  }
  return { h: H, band, clamped, eroded, maxExtra };
}

/**
 * The pass. `survey`: the plan's columns (resolution 1 or 4; missing columns filled). `intent`: `{around, radius = 12, maxCut = 6,
 * maxFill = 6, erode: {thermal, stream, streamAt}, base: {minX, minZ, width, depth, values} (added to the land the blend meets,
 * e.g. a hill the program raises with the same op), fill, corridorFill, cut = 0, name = 'relief', keep: [[x, z]] (6c S2: the
 * plan's kept columns; `r.pass` passes them)}`. Returns `{fields: {<name>,
 * <name>_target?, <name>_apron?}, ops, data}`: one `delta` op over the blended band, when there are corridors one `target` op over
 * their pinned columns, and one `target` op over the lots' aprons at their pad's top (the footprints are their lots' own).
 */
export function reliefPass(survey, volumes, intent) {
  const c = survey;
  const { around, radius = 12, maxCut = 6, maxFill = 6, erode = null, base = null, fill, corridorFill = fill, cut = 0, name = 'relief', minY = -32768, keep = null } = intent ?? {};
  if (!Array.isArray(around) || !around.length) throw new Error('relief: `around` must list the pads and corridors to blend around');
  if (!(isInt(radius) && radius >= 1 && radius <= 64)) throw new Error('relief: radius must be 1..64');
  for (const [k, v] of [['maxCut', maxCut], ['maxFill', maxFill]]) if (!(isInt(v) && v >= 0 && v <= 64)) throw new Error(`relief: ${k} must be 0..64`);
  if (erode !== null) {
    if (typeof erode !== 'object') throw new Error('relief: erode is {thermal, stream, streamAt}');
    for (const k of ['thermal', 'stream']) if (erode[k] !== undefined && !(isInt(erode[k]) && erode[k] >= 0 && erode[k] <= 16)) throw new Error(`relief: erode.${k} must be 0..16`);
  }
  if (fill === undefined) throw new Error('relief: fill (a block state or a material rule) is required');
  const W = c.width, D = c.depth, n = W * D, r = c.resolution;
  const R = Math.max(1, Math.floor((radius + r - 1) / r));
  const { pin, kind } = pinsOf(c, around);
  // the land the blend meets: the survey's ground, plus the program's base (a hill the program raises: its own cells)
  const ref = Int16Array.from(c.ground);
  const ground = Int16Array.from(c.ground);
  if (base) {
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      const bi = Math.floor((c.minX + i * r - base.minX)), bj = Math.floor((c.minZ + j * r - base.minZ));
      if (bi >= 0 && bj >= 0 && bi < base.width && bj < base.depth) ground[i + j * W] += base.values[bi + bj * base.width];
    }
  }
  // fixed columns: water and lava (and WATER_GUARD around water), trees (a cut would float the canopy), missing
  const fixed = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = c.flags[k];
    if (f & (FLAG_TREE | FLAG_LAVA | FLAG_MISSING)) fixed[k] = 1;
    if (f & FLAG_WATER) {
      const x = k % W, z = (k - x) / W;
      for (let dz = -WATER_GUARD; dz <= WATER_GUARD; dz++) for (let dx = -WATER_GUARD; dx <= WATER_GUARD; dx++) {
        const X = x + dx, Z = z + dz;
        if (X >= 0 && Z >= 0 && X < W && Z < D) fixed[X + Z * W] = 1;
      }
    }
  }
  for (let k = 0; k < n; k++) if (pin[k] !== NONE) fixed[k] = 0;
  // (6c S2) the plan's kept natural cells (`keep`: their [x, z] columns, from r.keepNatural): such a column keeps its ground (fixed:
  // the pass never writes a kept cell) and is a wall to the relaxation (its ground is the kept form's top, an ice spike's tip, not
  // land the blend should meet). A pin on a kept column stays a pin (the program's own error, which the checker's M1 reports).
  let wall = null;
  if (keep && keep.length) {
    wall = new Uint8Array(n);
    for (const [x, z] of keep) {
      const i = Math.floor((x - c.minX) / r), j = Math.floor((z - c.minZ) / r);
      if (i < 0 || j < 0 || i >= W || j >= D) continue;
      const k = i + j * W;
      if (pin[k] !== NONE) continue;
      wall[k] = 1; fixed[k] = 1;
    }
  }
  const iterations = radius * 4;
  const res = relax({ ground, base: base ? ref : null, pin, fixed, wall, W, D, R, iterations, maxCut, maxFill, erode, minY });
  // the program's base outside the band (a raised hill): written as it is, within the clamps (`raised` cells)
  const raised = new Uint8Array(n);
  if (base) for (let k = 0; k < n; k++) {
    if (res.band[k] || pin[k] !== NONE || fixed[k] || ground[k] === ref[k]) continue;
    raised[k] = 1;
    res.h[k] = Math.max(Math.max(ref[k] - maxCut, minY), Math.min(ref[k] + maxFill, ground[k]));
  }
  // the fields over the bounding box of the band and the corridor pins (dh against the survey's own ground; NONE elsewhere)
  let i0 = W, i1 = -1, j0 = D, j1 = -1;
  for (let k = 0; k < n; k++) {
    if (!res.band[k] && !raised[k] && kind[k] !== 2 && kind[k] !== 3) continue;
    const x = k % W, z = (k - x) / W;
    if (x < i0) i0 = x; if (x > i1) i1 = x; if (z < j0) j0 = z; if (z > j1) j1 = z;
  }
  const fields = {}, ops = [];
  const data = { pinned: 0, pads: 0, corridors: 0, band: 0, raised: 0, changed: 0, iterations, radius, resolution: r, clamped: res.clamped, eroded: res.eroded, maxErodeExtra: res.maxExtra, cut: 0, fill: 0, maxCutUsed: 0, maxFillUsed: 0 };
  for (let k = 0; k < n; k++) { if (pin[k] !== NONE) { data.pinned++; if (kind[k] === 2) data.corridors++; else data.pads++; } if (res.band[k]) data.band++; if (raised[k]) data.raised++; }
  if (i1 < 0) return { fields, ops, data };
  const fw = i1 - i0 + 1, fd = j1 - j0 + 1;
  const dv = new Int16Array(fw * fd).fill(NONE), tv = new Int16Array(fw * fd).fill(NONE), av = new Int16Array(fw * fd).fill(NONE);
  let corr = 0, aprons = 0;
  for (let j = 0; j < fd; j++) for (let i = 0; i < fw; i++) {
    const k = (i0 + i) + (j0 + j) * W, o = i + j * fw;
    if (res.band[k] || raised[k]) {
      const dh = res.h[k] - ref[k];
      dv[o] = dh;
      if (dh) { data.changed++; if (dh < 0) { data.cut++; if (-dh > data.maxCutUsed) data.maxCutUsed = -dh; } else { data.fill++; if (dh > data.maxFillUsed) data.maxFillUsed = dh; } }
    }
    if (kind[k] === 2) { tv[o] = pin[k]; corr++; }
    if (kind[k] === 3) { av[o] = pin[k]; aprons++; }
  }
  const geo = { type: 'i16', minX: c.minX + i0 * r, minZ: c.minZ + j0 * r, width: fw, depth: fd, res: r };
  fields[name] = { ...geo, values: dv };
  ops.push({ op: 'relief', field: name, mode: 'delta', cut, fill, maxCut, maxFill });
  if (corr) {
    fields[`${name}_target`] = { ...geo, values: tv };
    ops.push({ op: 'relief', field: `${name}_target`, mode: 'target', cut, fill: corridorFill, maxCut, maxFill });
  }
  if (aprons) {
    // the lots' aprons at their pad's top, within the lots' own pad limits (the plan already refused a pad past them)
    const lots = around.filter((a) => a && Array.isArray(a.at) && Array.isArray(a.size) && isInt(a.floorY));
    const aCut = Math.max(0, ...lots.map((l) => l.pad?.maxCut ?? maxCut)), aFill = Math.max(0, ...lots.map((l) => l.pad?.maxFill ?? maxFill));
    fields[`${name}_apron`] = { ...geo, values: av };
    ops.push({ op: 'relief', field: `${name}_apron`, mode: 'target', cut, fill, maxCut: Math.min(64, aCut), maxFill: Math.min(64, aFill) });
  }
  return { fields, ops, data };
}
