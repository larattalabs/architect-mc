// (7c CO) The planning images (docs/CONTRACT.md "Phase 7c" §3 row 12, SETTLEMENTS §16.5 use 1): what the composer sees of the land
// before any plan exists, and what `checkPlan` returns on request (PlanRequest ext `architect_mc:planImages`, S-7c-2):
//
//   top        a hillshade of the claim's columns, each affordance's x/z box framed and labelled with its number
//   section-1  a vertical cut west to east through the claim's middle row (z = the centre)
//   section-2  a vertical cut north to south through the claim's middle column (x = the centre)
//   iso        a low-detail isometric of the land, the affordances' numbers over their boxes
//
// The input is the ARSV columns survey (pack.mjs) and an affordance list (AF's `analyseVolume` objects: {id, kind, box, score}); the
// numbers are the list's order after `rankAffordances` (score, then id), 1-based, the same numbers the composer's prompt lists the
// affordances under (their ids are too long to print legibly). Pure and deterministic: integer pixel maths and the kit's pinned PNG
// encoder (raster.mjs), no trig, no clock, so the same survey and list give the same bytes on every platform; `pixelSha` (the RGBA
// pixels' sha256) is what the goldens compare.
import { Canvas } from './raster.mjs';
import { asColumns, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from './pack.mjs';

/** The images, in the order they are rendered and listed. */
export const PLAN_IMAGE_NAMES = Object.freeze(['top', 'section-1', 'section-2', 'iso']);
/** How many affordances the composer is shown (the top of `rankAffordances`). */
export const PLAN_IMAGE_AFFORDANCES = 60;
/** Each image's largest side in pixels. */
const MAX_PX = 1536;

const INK = [30, 30, 30];
const SKY = [228, 240, 252];
const MISSING = [160, 160, 160];
const WATER = [52, 95, 218];
const LAVA = [220, 90, 20];
const TREE = [52, 110, 48];
const EARTH = [120, 100, 76];
/** An affordance kind's frame colour. */
const KIND = {
  cliff_face: [170, 60, 50], ledge: [215, 120, 30], overhang: [150, 60, 170], cave: [200, 30, 120], trunk: [90, 60, 20],
  canopy: [20, 120, 40], spike: [60, 160, 200], water: [20, 60, 200], gap: [200, 180, 20], pad: [40, 40, 40],
};
const kindColour = (k) => KIND[k] ?? INK;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, num, den) => [a[0] + Math.trunc(((b[0] - a[0]) * num) / den), a[1] + Math.trunc(((b[1] - a[1]) * num) / den), a[2] + Math.trunc(((b[2] - a[2]) * num) / den)];
/** A colour times `f / 100`, clamped. */
const shade = (c, f) => [Math.min(255, Math.trunc((c[0] * f) / 100)), Math.min(255, Math.trunc((c[1] * f) / 100)), Math.min(255, Math.trunc((c[2] * f) / 100))];

/** The land's colour at a height, from the claim's lowest (green) to its highest (pale stone). */
function ramp(y, lo, hi) {
  const span = Math.max(1, hi - lo);
  const t = clamp(y - lo, 0, span);
  return t * 2 <= span ? mix([96, 150, 72], [168, 160, 112], t * 2, span) : mix([168, 160, 112], [214, 210, 200], t * 2 - span, span);
}

/**
 * The affordances in the order the composer is shown them: score descending, then id ascending; the first `n` (default
 * {@link PLAN_IMAGE_AFFORDANCES}). Entries without a string id, a kind and a box are left out. Pure.
 */
export function rankAffordances(list, n = PLAN_IMAGE_AFFORDANCES) {
  const ok = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.id === 'string' && typeof a.kind === 'string' && a.box && Number.isFinite(a.box.minX));
  return [...ok].sort((a, b) => (Number(b.score ?? 0) - Number(a.score ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, Math.max(0, n));
}

/** The survey's land, read once: per grid cell its kind and heights, and the claim's height range. */
function land(c) {
  const n = c.width * c.depth;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    if (c.flags[k] & FLAG_MISSING) continue;
    lo = Math.min(lo, c.ground[k], c.floor[k]);
    hi = Math.max(hi, c.ground[k], c.height[k]);
  }
  if (lo > hi) { lo = 0; hi = 0; }
  return { lo, hi };
}

/** The top colour of grid cell k. */
function topColour(c, k, L) {
  const f = c.flags[k];
  if (f & FLAG_MISSING) return MISSING;
  if (f & FLAG_LAVA) return LAVA;
  if (f & FLAG_WATER) return mix(WATER, [170, 200, 240], clamp(c.ground[k] - c.floor[k], 0, 8) > 2 ? 0 : 1, 2);
  if (f & FLAG_TREE) return mix(ramp(c.ground[k], L.lo, L.hi), TREE, 3, 5);
  return ramp(c.ground[k], L.lo, L.hi);
}

function renderTop(c, L, ranked) {
  const W = c.width, D = c.depth, r = c.resolution;
  const s = clamp(Math.floor(MAX_PX / Math.max(W, D)), 1, 4);
  const cv = new Canvas(W * s, D * s);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W;
    let col = topColour(c, k, L);
    if (!(c.flags[k] & FLAG_MISSING)) {
      // the slope shade: lit from the north-west, linear in the height step (preview.mjs's rule, in integer percent)
      const kn = i > 0 && j > 0 ? k - 1 - W : k;
      const step = c.flags[kn] & FLAG_MISSING ? 0 : c.ground[k] - c.ground[kn];
      col = shade(col, clamp(100 + Math.trunc((8 * step) / r), 60, 135));
    }
    cv.rect(i * s, j * s, i * s + s - 1, j * s + s - 1, col);
  }
  const X = (x) => Math.trunc(((x - c.minX) * s) / r), Z = (z) => Math.trunc(((z - c.minZ) * s) / r);
  ranked.forEach((a, i) => {
    const b = a.box, col = kindColour(a.kind);
    const x0 = X(b.minX), z0 = Z(b.minZ), x1 = Math.max(x0, X(b.maxX + 1) - 1), z1 = Math.max(z0, Z(b.maxZ + 1) - 1);
    cv.frame(x0, z0, x1, z1, col);
    cv.label(x0 + 1, z0 + 1, String(i + 1), col);
  });
  cv.frame(0, 0, cv.w - 1, cv.h - 1, INK);
  // north arrow
  cv.line(8, 22, 8, 8, INK, 2);
  cv.label(6, 24, 'N', INK);
  return cv;
}

/** A section along a row (axis "x": z fixed at `at`) or a column (axis "z": x fixed at `at`) of the grid. */
function renderSection(c, L, ranked, axis, at) {
  const r = c.resolution;
  const n = axis === 'x' ? c.width : c.depth;
  const fixed = axis === 'x' ? clamp(Math.trunc((at - c.minZ) / r), 0, c.depth - 1) : clamp(Math.trunc((at - c.minX) / r), 0, c.width - 1);
  const kOf = (t) => (axis === 'x' ? t + fixed * c.width : fixed + t * c.width);
  const worldOf = (t) => (axis === 'x' ? c.minX : c.minZ) + t * r;
  const crossW = axis === 'x' ? c.minZ + fixed * r : c.minX + fixed * r;
  const crossed = ranked.map((a, i) => ({ a, i })).filter(({ a }) => (axis === 'x' ? a.box.minZ <= crossW + r - 1 && a.box.maxZ >= crossW : a.box.minX <= crossW + r - 1 && a.box.maxX >= crossW));
  let ylo = L.lo, yhi = L.hi;
  for (const { a } of crossed) { ylo = Math.min(ylo, a.box.minY); yhi = Math.max(yhi, a.box.maxY); }
  ylo -= 8; yhi += 8;
  const hh = yhi - ylo + 1;
  const s = clamp(Math.floor(MAX_PX / Math.max(n, hh)), 1, 4);
  const cv = new Canvas(n * s, hh * s, SKY);
  const py = (y) => (yhi - y) * s;
  for (let y = ylo; y <= yhi; y++) if (y % 8 === 0) for (let x = 0; x < cv.w; x += 2) cv.set(x, py(y), [190, 205, 220]);
  for (let t = 0; t < n; t++) {
    const k = kOf(t), f = c.flags[k];
    const x0 = t * s, x1 = t * s + s - 1;
    if (f & FLAG_MISSING) { cv.rect(x0, py(yhi), x1, py(ylo) + s - 1, MISSING); continue; }
    const g = c.ground[k], fl = c.floor[k], h = c.height[k];
    const solidTop = f & FLAG_WATER ? Math.min(fl, g) : g;
    cv.rect(x0, py(solidTop), x1, py(ylo) + s - 1, shade(ramp(solidTop, L.lo, L.hi), 80));
    cv.rect(x0, py(Math.max(ylo, solidTop - 3)), x1, py(ylo) + s - 1, EARTH);
    if (f & FLAG_WATER && g > solidTop) cv.rect(x0, py(g), x1, py(solidTop + 1) + s - 1, WATER);
    if (f & FLAG_LAVA) cv.rect(x0, py(g), x1, py(g) + s - 1, LAVA);
    if (h > g) cv.rect(x0, py(h), x1, py(g + 1) + s - 1, f & FLAG_TREE ? TREE : [130, 130, 130]);
    cv.rect(x0, py(g), x1, py(g), INK);
  }
  for (const { a, i } of crossed) {
    const b = a.box, col = kindColour(a.kind);
    const lo = axis === 'x' ? b.minX : b.minZ, hi2 = axis === 'x' ? b.maxX : b.maxZ;
    const t0 = clamp(Math.trunc((lo - worldOf(0)) / r), 0, n - 1), t1 = clamp(Math.trunc((hi2 - worldOf(0)) / r), 0, n - 1);
    cv.frame(t0 * s, py(b.maxY), t1 * s + s - 1, py(b.minY) + s - 1, col);
    cv.label(t0 * s + 2, py(b.maxY) + 2, String(i + 1), col);
  }
  for (let y = ylo; y <= yhi; y++) if (y % 32 === 0) cv.label(2, py(y) - 8, `y${y}`, INK);
  cv.label(2, 2, axis === 'x' ? `W-E z${crossW}` : `N-S x${crossW}`, INK);
  cv.frame(0, 0, cv.w - 1, cv.h - 1, INK);
  return cv;
}

function renderIso(c, L, ranked) {
  const W = c.width, D = c.depth, r = c.resolution;
  const t = clamp(Math.floor(900 / (W + D)), 1, 4);
  const ylo = L.lo - 4, yhi = L.hi;
  // vertical pixels per block: t per grid cell of r blocks, rounded down to at least 1 per 4 blocks
  const vnum = t, vden = r;
  const vy = (y) => Math.trunc(((y - ylo) * vnum) / vden);
  const w = (W + D) * t + 4, h = Math.trunc(((W + D) * t) / 2) + vy(yhi + 8) + 8;
  const cv = new Canvas(w, h, [240, 244, 248]);
  const ox = D * t + 2, oy = vy(yhi + 4) + 2;
  const P = (i, j, y) => [ox + (i - j) * t, oy + Math.trunc(((i + j) * t) / 2) - vy(y)];
  for (let sum = 0; sum < W + D - 1; sum++) for (let i = Math.max(0, sum - D + 1); i <= Math.min(W - 1, sum); i++) {
    const j = sum - i, k = i + j * W;
    const f = c.flags[k];
    const top = f & FLAG_MISSING ? ylo : c.ground[k];
    const col = topColour(c, k, L);
    const [px, pyy] = P(i, j, top);
    const [, pyb] = P(i, j, ylo);
    cv.rect(px - t, pyy, px + t - 1, pyb + Math.trunc(t / 2), shade(col, 75));
    cv.rect(px - t, pyy - Math.trunc(t / 2), px + t - 1, pyy + Math.trunc(t / 2), col);
  }
  ranked.forEach((a, n) => {
    const b = a.box;
    const i = clamp(Math.trunc((((b.minX + b.maxX) >> 1) - c.minX) / r), 0, W - 1), j = clamp(Math.trunc((((b.minZ + b.maxZ) >> 1) - c.minZ) / r), 0, D - 1);
    const [px, pyy] = P(i, j, b.maxY);
    cv.label(px - 3, pyy - 10, String(n + 1), kindColour(a.kind));
  });
  return cv;
}

/**
 * The four planning images over `survey` (ARSV bytes or decoded columns) with `affordances` (any order; ranked here, the first
 * {@link PLAN_IMAGE_AFFORDANCES} drawn). Returns `{images: [{name, png, pixelSha, width, height}], labels: [{n, id, kind, box}]}`,
 * `labels` the drawn affordances by number. Pure.
 */
export function renderPlanImages({ survey, affordances = [] }) {
  const c = asColumns(survey);
  const L = land(c);
  const ranked = rankAffordances(affordances);
  const cx = c.minX + Math.trunc(((c.width - 1) * c.resolution) / 2), cz = c.minZ + Math.trunc(((c.depth - 1) * c.resolution) / 2);
  const out = [
    ['top', renderTop(c, L, ranked)],
    ['section-1', renderSection(c, L, ranked, 'x', cz)],
    ['section-2', renderSection(c, L, ranked, 'z', cx)],
    ['iso', renderIso(c, L, ranked)],
  ];
  return {
    images: out.map(([name, cv]) => ({ name, png: cv.png(), pixelSha: cv.pixelSha(), width: cv.w, height: cv.h })),
    labels: ranked.map((a, i) => ({ n: i + 1, id: a.id, kind: a.kind, box: a.box })),
  };
}
