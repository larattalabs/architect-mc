// (6c P0) The plan compiler (docs/CONTRACT.md P0 §3, §5, §7): it runs inside the bundled program `plan_v0` (kit/regions/plan_v0.mjs)
// over the request's claim, so a check is today's survey, plan and checker with no realise, and the approved artifact is the
// check's own IR. In order:
//   1. validate (schema.mjs): malformed and unsupported parts are answered there;
//   2. resolve, in topological order (ties by id): zones (a rect from the locator, size, sketch and tolerances; the street layout
//      evaluated inside it), forms (relief, terrace, spikes) and, last, every connector (one T2 route pass per grade limit);
//      a part whose dependency is not fits or adjusted is `blocked`; out of time or nodes, `incomplete`;
//   3. emit what fits into the one region (zones as V's street layouts in their rects, T1's relief, 6a's terrace, F1's forms, T2's
//      routes), each part's emission under a checkpoint so a failure rolls back to nothing;
//   4. record each part's answer, geometry and the IR parts it wrote in `r.meta.planCheck` (finish.mjs adds the cost, the tile shas,
//      the overall result and the artifact after the budget pass).
// Every coordinate is an integer cell; scores are integers; candidate scans run x then z; ties by scan order. No clock but
// performance.now() for maxMs (a check that hits it is never cached and never makes an artifact).
import { validatePlan, zoneLots, entryOf, cmp, ZONE_PORTS } from './schema.mjs';
import { canonicalJson, sha256Hex, FLAG_WATER, FLAG_LAVA, FLAG_FROZEN, encodeColumns } from '../region/pack.mjs';
import { layoutStreet, streetLayout, STREET_RULES, toWorld } from '../region/village.mjs';
import { emitProps, lampFixture, planProps } from '../region/props.mjs';
import { lightCover } from '../region/light.mjs';
import { validateLots } from '../params.mjs';
import { PRESETS as ICE_PRESETS } from '../forms/iceSpike.mjs';
import { PRESETS as ROCK_PRESETS } from '../forms/rockSpire.mjs';
import { KIT_VERSION } from '../region/plan.mjs';
import { CATALOGUE_VERSION } from './schema.mjs';
import { keptBuilds, pickBuild, buildEndpoint, buildKeepOut } from '../region/builds.mjs';
import { besidePorts, emitDistricts, parseDistricts, placeDistricts } from '../region/districtsEmit.mjs';
import { placeFollow } from '../region/followEmit.mjs';
import { zoneDistricts } from './schema.mjs';
// (7a K1) walls and gates (K1a), rope bridges and auto connectors (K1b): the compiler's hooks for the four connector kinds
import { WALL_KINDS, emitWalls, finishGates, planWalls, wallsPassInput, wallsRouted } from '../connectors/wall.mjs';
import { ROPE_KINDS, emitRopes, ropeAnswer, ropeFailAnswer, ropeLeg, ropePassInput, ropeResolve } from '../connectors/rope.mjs';
/** (7a K1) The connector kinds K1 compiles (each a supported block in catalogue 4). */
export const K1_KINDS = Object.freeze([...WALL_KINDS, ...ROPE_KINDS]);

/** §7's caps (each a request may only lower). */
export const BUDGET_DEFAULTS = Object.freeze({ maxNodes: 2_000_000, maxEdges: 128, maxCells: 20_000_000, maxMs: 120_000, maxHeapMb: 2048 });
/** x-defaults. */
export const TOL_DEFAULTS = Object.freeze({
  move: { max: 16, hard: false, ceiling: 64 }, size: { max: 25, hard: false, ceiling: 50 }, rotate: { allowed: true, hard: false },
  count: { max: 0, hard: false, ceiling: Infinity }, grade: { max: 0.25, hard: true, ceiling: 0.25 }, detour: { max: 2.0, hard: false, ceiling: 4.0 },
  sketch: { max: 8, hard: false, ceiling: 32 },
});
export const PRESET_SIZES = Object.freeze({ S: 32, M: 48, L: 64, XL: 96 });
const WIDTH_DEFAULT = { street: 3, road: 3, path: 1 };
/** The claim margin a zone keeps (the street layout's own margin is inside the zone's rect). */
const MARGIN = 2;
/** Zones (and terraces) keep this many cells apart: none beyond not overlapping (a zone's rect holds its street layout's own margin). */
const ZONE_GAP = 0;
/** A provisional building's cells per column of its lot, low and high (the cost band of a lot with no library entry). */
export const PROVISIONAL_BAND = Object.freeze([4, 16]);
/** The top-ranked candidate rects whose street layout is evaluated, per size. */
const EVAL_K = 12;

const isInt = Number.isInteger;
const q64 = (v) => Math.round(v * 64) / 64;

// ------------------------------------------------------------------ small geometry (rects are {minX, minZ, maxX, maxZ}, inclusive)

const rectOf = (x0, z0, w, d) => ({ minX: x0, minZ: z0, maxX: x0 + w - 1, maxZ: z0 + d - 1 });
const grow = (a, n) => ({ minX: a.minX - n, minZ: a.minZ - n, maxX: a.maxX + n, maxZ: a.maxZ + n });
const meets = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
const inside = (a, b) => a.minX >= b.minX && a.maxX <= b.maxX && a.minZ >= b.minZ && a.maxZ <= b.maxZ;
const rectArr = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
const arrRect = (q) => ({ minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] });
/** Chebyshev gap between two rects (0 when they meet). */
function gap(a, b) {
  const dx = Math.max(0, b.minX - a.maxX, a.minX - b.maxX), dz = Math.max(0, b.minZ - a.maxZ, a.minZ - b.maxZ);
  return Math.max(dx, dz);
}
const centre = (a) => [(a.minX + a.maxX) >> 1, (a.minZ + a.maxZ) >> 1];

// ------------------------------------------------------------------ the environment: anchors, water bodies, obstacles, budget

/** Named anchors: the built-in claim ones and the caller's ({name: [x, y, z]}), as [x, z]. */
export function anchorPoints(claim, given = {}) {
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  const m = new Map([['claim_center', [cx, cz]], ['claim_n', [cx, claim.minZ + MARGIN]], ['claim_s', [cx, claim.maxZ - MARGIN]], ['claim_w', [claim.minX + MARGIN, cz]], ['claim_e', [claim.maxX - MARGIN, cz]]]);
  for (const k of Object.keys(given).sort()) { const p = given[k]; if (Array.isArray(p) && p.length >= 2) m.set(k, p.length === 3 ? [p[0], p[2]] : [p[0], p[1]]); }
  return m;
}

/**
 * Water bodies over the survey grid (4-connected water columns), each `{id, cells: Int32Array (indices), area (columns), bbox,
 * kind: river|lake|ocean}`. `kind`: a body touching the claim's edge with 25% or more of the claim is ocean; one touching two
 * opposite edges, or long and narrow (its bbox's long side over 4 times its short side), is a river; else a lake.
 */
export function waterBodies(cols) {
  const W = cols.width, D = cols.depth, n = W * D, r = cols.resolution;
  const lab = new Int32Array(n).fill(-1);
  const out = [];
  for (let s = 0; s < n; s++) {
    if (lab[s] >= 0 || !(cols.flags[s] & FLAG_WATER)) continue;
    const id = out.length, q = [s];
    lab[s] = id;
    let i0 = W, i1 = -1, j0 = D, j1 = -1;
    for (let h = 0; h < q.length; h++) {
      const k = q[h], i = k % W, j = (k - i) / W;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= W || b >= D) continue;
        const t = a + b * W;
        if (lab[t] < 0 && cols.flags[t] & FLAG_WATER) { lab[t] = id; q.push(t); }
      }
    }
    const area = q.length * r * r;
    const edgeX = i0 === 0 || i1 === W - 1, edgeZ = j0 === 0 || j1 === D - 1;
    const bw = i1 - i0 + 1, bd = j1 - j0 + 1;
    const kind = (edgeX || edgeZ) && q.length * 4 >= n ? 'ocean' : ((i0 === 0 && i1 === W - 1) || (j0 === 0 && j1 === D - 1) || Math.max(bw, bd) > 4 * Math.min(bw, bd)) ? 'river' : 'lake';
    out.push({ id, cells: Int32Array.from(q), area, kind, bbox: { minX: cols.minX + i0 * r, minZ: cols.minZ + j0 * r, maxX: cols.minX + i1 * r + r - 1, maxZ: cols.minZ + j1 * r + r - 1 } });
  }
  return { bodies: out, label: lab };
}

/** The 2D prefix sums of a per-column value (Float64 to stay exact for sums of squares). */
function prefix(W, D, f) {
  const P = new Float64Array((W + 1) * (D + 1));
  for (let j = 0; j < D; j++) {
    let row = 0;
    for (let i = 0; i < W; i++) { row += f(i + j * W); P[(i + 1) + (j + 1) * (W + 1)] = P[(i + 1) + j * (W + 1)] + row; }
  }
  return (i0, j0, i1, j1) => P[(i1 + 1) + (j1 + 1) * (W + 1)] - P[i0 + (j1 + 1) * (W + 1)] - P[(i1 + 1) + j0 * (W + 1)] + P[i0 + j0 * (W + 1)];
}

/** Everything the resolver reads, built once per check. */
export function makeEnv(ctx, P, t0 = performance.now()) {
  const claim = ctx.claim, S = ctx.survey, cols = S.columns, r = cols.resolution, W = cols.width, D = cols.depth;
  const budget = { ...BUDGET_DEFAULTS };
  for (const k of Object.keys(BUDGET_DEFAULTS)) { const v = P.budget?.[k]; if (isInt(v) && v > 0 && v < BUDGET_DEFAULTS[k]) budget[k] = v; }
  const keepOut = (ctx.keepOut ?? []).map(arrRect);
  const protectedAreas = (P.protected ?? []).map((a) => ({ id: a.id, rect: arrRect(a.rect) }));
  const regions = (P.regions ?? []).map((a) => ({ id: a.id, rect: arrRect(a.rect) }));
  // (D1) the owner's standing regions beside the claim (endpoint.region): their footprint (lots grown by 1, roads, paths, ways) is hard
  const standing = (P.standing ?? []).filter((a) => a && typeof a.id === 'string').map((a) => ({ ...a, lots: a.lots ?? [], keep: a.keep ?? [], graph: a.graph ?? { nodes: [], edges: [] } }));
  const standingHard = standing.flatMap((a) => [...a.lots.map((q) => [q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]), ...a.keep]);
  // 6c PT: the players' kept builds; each build (grown by 1) and its door aprons are keep-out for zones (S-PT-4; the plan request
  // names no consent, so every kept build), the builds' own rects for routes (a road may run on a door's apron)
  const builds = keptBuilds(P.builds ?? []).filter((b) => Array.isArray(b.bounds) && b.bounds.length === 6);
  const buildRects = builds.map((b) => ({ id: b.id, rect: { minX: b.bounds[0], minZ: b.bounds[2], maxX: b.bounds[3], maxZ: b.bounds[5] } }));
  const buildKeep = buildKeepOut(builds, { claim }).map(arrRect);
  // columns no zone may take: keep-out (the owner's areas), every protected area, other owners' regions (grown by 1), builds
  const hard = [...keepOut, ...protectedAreas.map((a) => a.rect), ...regions.map((a) => a.rect)].map((q) => grow(q, 1)).concat(buildKeep).concat(standingHard.map(arrRect));
  const blocked = new Uint8Array(W * D), water = new Uint8Array(W * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const x = cols.minX + i * r, z = cols.minZ + j * r, k = i + j * W;
    if (cols.flags[k] & (FLAG_WATER | FLAG_LAVA)) water[k] = 1;
    for (const q of hard) if (x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ) { blocked[k] = 1; break; }
  }
  const sumG = prefix(W, D, (k) => cols.ground[k]), sumG2 = prefix(W, D, (k) => cols.ground[k] * cols.ground[k]);
  const sumW = prefix(W, D, (k) => water[k]), sumB = prefix(W, D, (k) => blocked[k]);
  const wb = waterBodies(cols);
  const surveySha = sha256Hex(encodeColumns(cols));
  return {
    ctx, claim, S, cols, r, W, D, budget, keepOut, protectedAreas, regions, standing, standingHard, hard, builds, buildRects, sumG, sumG2, sumW, sumB, water: wb,
    anchors: anchorPoints(claim, P.anchors ?? {}), anchorsGiven: P.anchors ?? {}, surveySha, fingerprint: P.fingerprint ?? null, bible: P.bible ?? null,
    t0, deadline: t0 + budget.maxMs, hitTime: false,
    cacheIn: ctx.planCache ?? null, cacheOut: {},
  };
}

/** Grid index range of a world rect (clipped to the survey). */
function gridOf(env, a) {
  const { cols, r, W, D } = env;
  const i0 = Math.max(0, Math.floor((a.minX - cols.minX) / r)), j0 = Math.max(0, Math.floor((a.minZ - cols.minZ) / r));
  const i1 = Math.min(W - 1, Math.floor((a.maxX - cols.minX) / r)), j1 = Math.min(D - 1, Math.floor((a.maxZ - cols.minZ) / r));
  return [i0, j0, i1, j1];
}
/** Terrain roughness of a rect: the ground's standard deviation (integer, floor). Water share in 1/1000. Blocked columns. */
function rectStats(env, a) {
  const [i0, j0, i1, j1] = gridOf(env, a);
  if (i1 < i0 || j1 < j0) return { rough: 0, water: 1000, blocked: 1 };
  const n = (i1 - i0 + 1) * (j1 - j0 + 1);
  const s = env.sumG(i0, j0, i1, j1), s2 = env.sumG2(i0, j0, i1, j1);
  const v = Math.max(0, Math.floor((n * s2 - s * s) / (n * n)));
  return { rough: Math.floor(Math.sqrt(v)), water: Math.floor((1000 * env.sumW(i0, j0, i1, j1)) / n), blocked: env.sumB(i0, j0, i1, j1), mean: Math.floor(s / n) };
}

// ------------------------------------------------------------------ tolerances

/** A part's tolerance for `what`: x-defaults under the part's own (`{max, hard, ceiling}`). */
export function tolOf(part, what) {
  const d = TOL_DEFAULTS[what];
  const t = part?.tolerance?.[what];
  if (what === 'rotate') return { allowed: t?.allowed ?? d.allowed, hard: t?.hard ?? d.hard };
  const max = typeof t?.max === 'number' ? t.max : d.max;
  const hard = typeof t?.hard === 'boolean' ? t.hard : d.hard;
  return { max, hard, ceiling: hard ? max : Math.max(max, d.ceiling) };
}

/** Deviations -> {class: fits|adjusted|refused, deviations, failed: what} (a soft tolerance up to its ceiling; a hard one never). */
function judge(devs) {
  const out = [];
  let refused = null;
  for (const d of devs) {
    if (!(d.value > 0)) continue;
    const exceeds = d.value > d.max;
    out.push({ what: d.what, value: d.value, max: d.max, ...(exceeds ? { exceeds: true } : {}) });
    if ((exceeds && d.hard) || d.value > d.ceiling) refused ??= d;
  }
  return { klass: refused ? 'refused' : out.length ? 'adjusted' : 'fits', deviations: out, failed: refused };
}

// ------------------------------------------------------------------ locators

/**
 * A locator's target for a rect of a part: `{valid(rect) -> bool, move(rect) -> cells, aim: [x, z] | null, need?: reason}`.
 * `geomOf(id)`: a resolved part's (or lot's) rect, or null. Returns {error: {code, message}} when the target can't be found.
 */
export function locatorOf(env, where, geomOf, { within0 = 32 } = {}) {
  const claimIn = grow(env.claim, -MARGIN);
  const anyOk = () => true;
  // no locator (or inside the claim): anywhere, nearest the claim's centre
  if (!where) return { valid: anyOk, move: () => 0, aim: centre(env.claim) };
  const lk = Object.keys(where)[0], b = where[lk];
  // 6c PT: target {build: id}: the build's rect
  const targetOf = (t) => (t?.build !== undefined ? (env.buildRects.find((x) => x.id === t.build) ?? null) : geomOf(t?.part));
  if (lk === 'inside') {
    if (b.claim) return { valid: anyOk, move: () => 0, aim: centre(env.claim) };
    if (b.build !== undefined && !targetOf(b)) return { error: { code: 'NO_FEATURE', message: `no build ${b.build} in the claim` } };
    const t = targetOf(b);
    if (!t) return { error: { code: 'DEPENDENCY', message: `${b.part} has no geometry` } };
    return { valid: (a) => inside(a, t.rect), move: () => 0, aim: centre(t.rect), areaFor: () => t.rect };
  }
  if (lk === 'near') {
    const W = isInt(b.within) ? b.within : within0;
    let target = null, aim = null, avoid = null;
    if (b.anchor) {
      const p = env.anchors.get(b.anchor);
      target = { minX: p[0], minZ: p[1], maxX: p[0], maxZ: p[1] };
      aim = p;
    } else {
      const f = featureGeom(env, b.feature, geomOf, null);
      if (f.error) return f;
      target = f.rect; aim = f.aim; avoid = f.avoid;
    }
    return { valid: (a) => !avoid || !meets(a, avoid), move: (a) => Math.max(0, gap(a, target) - W), aim, areaFor: (w, d, mm) => grow(target, W + Math.min(mm, 1024) + Math.max(w, d)), W, target };
  }
  if (lk === 'adjacent') {
    const t = targetOf(b.to);
    if (!t && b.to.build !== undefined) return { error: { code: 'NO_FEATURE', message: `no build ${b.to.build} in the claim` } };
    if (!t) return { error: { code: 'DEPENDENCY', message: `${b.to.part} has no geometry` } };
    const T = t.rect;
    const [g0, g1] = Array.isArray(b.gap) ? b.gap : isInt(b.gap) ? [b.gap, b.gap] : [0, 4];
    const side = b.side ?? 'any';
    // the gap on a side: the rect wholly beyond that side of T; the misalignment: cells the rect lies past T across that side
    const sideMove = (a, s) => {
      let g, across;
      if (s === 'n') { if (a.maxZ >= T.minZ) return Infinity; g = T.minZ - a.maxZ - 1; across = Math.max(0, T.minX - a.maxX, a.minX - T.maxX); }
      else if (s === 's') { if (a.minZ <= T.maxZ) return Infinity; g = a.minZ - T.maxZ - 1; across = Math.max(0, T.minX - a.maxX, a.minX - T.maxX); }
      else if (s === 'w') { if (a.maxX >= T.minX) return Infinity; g = T.minX - a.maxX - 1; across = Math.max(0, T.minZ - a.maxZ, a.minZ - T.maxZ); }
      else { if (a.minX <= T.maxX) return Infinity; g = a.minX - T.maxX - 1; across = Math.max(0, T.minZ - a.maxZ, a.minZ - T.maxZ); }
      return Math.max(0, g0 - g, g - g1) + across;
    };
    const sides = side === 'any' ? ['n', 'e', 's', 'w'] : [side];
    const mv = (a) => Math.min(...sides.map((s) => sideMove(a, s)));
    return { valid: (a) => !meets(a, T) && mv(a) < Infinity, move: mv, aim: centre(T), areaFor: (w, d, mm) => grow(T, g1 + Math.min(mm, 1024) + Math.max(w, d)), adjacent: { to: b.to.part ?? b.to.build, g0, g1 } };
  }
  // along, around: unsupported (validation answered them)
  return { error: { code: 'NO_FEATURE', message: `locator ${lk} is not compiled in v0` } };
  void claimIn;
}

/**
 * A feature's geometry: `{rect, aim, avoid}` (water: the picked body's bbox, aim its nearest column to `from`; part: its rect; protected:
 * the area). `from`: [x, z] the pick's `nearest` measures from (default the claim's centre or the feature's `to` anchor).
 */
export function featureGeom(env, f, geomOf, from) {
  if (f.part !== undefined) {
    const t = geomOf(f.part);
    if (!t) return { error: { code: 'NO_FEATURE', message: `${f.part} has no geometry in v0`, evidence: { feature: { part: f.part } } } };
    return { rect: t.rect, aim: centre(t.rect), avoid: t.rect, what: `part ${f.part}` };
  }
  if (f.protected !== undefined) {
    const a = env.protectedAreas.find((p) => p.id === f.protected);
    if (!a) return { error: { code: 'NO_FEATURE', message: `no protected area "${f.protected}" meets the claim`, evidence: { feature: { protected: f.protected }, areas: env.protectedAreas.map((x) => x.id) } } };
    return { rect: a.rect, aim: centre(a.rect), avoid: a.rect, what: `protected ${a.id}` };
  }
  if (f.build !== undefined) {
    // 6c PT: a player's build by id or by kind (feature.pick ties); its rect is its bounds, kept out (grown by 1)
    const b = pickBuild(env.builds, f.build, { claim: env.claim, to: from ?? undefined });
    if (b.none) return { error: { code: 'NO_FEATURE', message: b.none, evidence: { feature: { build: f.build }, builds: env.builds.map((x) => x.id) } } };
    const rect = env.buildRects.find((x) => x.id === b.build.id).rect;
    return { rect, aim: centre(rect), avoid: grow(rect, 1), what: `build ${b.build.id} (${String(b.build.kind).toLowerCase()})` };
  }
  if (f.water !== undefined) {
    const w = f.water ?? {};
    const body = w.body ?? 'any', minArea = w.minArea ?? 1;
    const to = w.to ? env.anchors.get(w.to) : from ?? centre(env.claim);
    const cands = env.water.bodies.filter((b) => (body === 'any' || b.kind === body) && b.area >= minArea);
    if (!cands.length) return { error: { code: 'NO_FEATURE', message: `no ${body === 'any' ? '' : `${body} `}water of at least ${minArea} columns in the claim`, evidence: { feature: { water: w }, bodies: env.water.bodies.map((b) => ({ kind: b.kind, area: b.area })) } } };
    const near = (b) => nearestCell(env, b, to);
    // pick: largest (then nearest to the claim's centre), or nearest (to `to`); then the smallest min x, then min z
    const cc = centre(env.claim);
    const key = (b) => (w.pick === 'nearest' ? [near(b).d, 0] : [-b.area, nearestCell(env, b, cc).d]);
    cands.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || a.bbox.minX - b.bbox.minX || a.bbox.minZ - b.bbox.minZ; });
    const pick = cands[0];
    const n = near(pick);
    return { rect: pick.bbox, aim: [n.x, n.z], avoid: null, body: pick, what: `${pick.kind} (${pick.area} columns)` };
  }
  return { error: { code: 'NO_FEATURE', message: `feature ${Object.keys(f)[0]} is not compiled in v0` } };
}

/** A water body's column nearest to [x, z] (Chebyshev; ties by index): {x, z, d}. */
function nearestCell(env, body, p) {
  const { cols, r, W } = env;
  let best = null;
  for (const k of body.cells) {
    const i = k % W, j = (k - i) / W, x = cols.minX + i * r, z = cols.minZ + j * r;
    const d = Math.max(Math.abs(x - p[0]), Math.abs(z - p[1]));
    if (!best || d < best.d) best = { x, z, d };
  }
  return best;
}

/** The sketch's point in world cells (q64 over the claim, or blocks from its anchor): the centroid of its points. */
export function sketchPoint(env, s) {
  if (!s) return null;
  const n = s.points.length;
  const sx = s.points.reduce((a, p) => a + p[0], 0), sz = s.points.reduce((a, p) => a + p[1], 0);
  if (s.frame === 'claim' || s.unit === 'q64') {
    const W = env.claim.maxX - env.claim.minX + 1, D = env.claim.maxZ - env.claim.minZ + 1;
    return [env.claim.minX + Math.floor((sx * W) / (64 * n)), env.claim.minZ + Math.floor((sz * D) / (64 * n))];
  }
  const a = env.anchors.get(s.anchor) ?? centre(env.claim);
  return [a[0] + Math.floor(sx / n), a[1] + Math.floor(sz / n)];
}

/**
 * Scan positions of a w x d rect (x then z; step 1 up to 256 a side, else ceil(side / 256)) over `area` (default the claim less
 * its margin) for the valid ones, each scored (an integer): 4096 x move + 8 x sketch deviation + 4 x roughness + water share + the
 * distance from the aim. Returns them best first (ties: scan order), at most `limit`.
 */
function scan(env, w, d, loc, { sketch = null, obstacles = [], limit = 64, maxMove = Infinity, area = null } = {}) {
  const c = grow(env.claim, -MARGIN);
  area ??= loc.areaFor ? loc.areaFor(w, d, maxMove) : null;
  const A = area ? { minX: Math.max(c.minX, area.minX), minZ: Math.max(c.minZ, area.minZ), maxX: Math.min(c.maxX, area.maxX), maxZ: Math.min(c.maxZ, area.maxZ) } : c;
  const step = Math.max(1, Math.ceil(Math.max(env.claim.maxX - env.claim.minX + 1, env.claim.maxZ - env.claim.minZ + 1) / 256));
  const out = [];
  const aim = sketch ?? loc.aim;
  // one lattice for every scan of a claim (its origin the claim's corner), so a recheck scans the same rects
  const up = (v, o) => o + Math.ceil((v - o) / step) * step;
  for (let x0 = up(A.minX, c.minX); x0 + w - 1 <= A.maxX; x0 += step) for (let z0 = up(A.minZ, c.minZ); z0 + d - 1 <= A.maxZ; z0 += step) {
    const a = rectOf(x0, z0, w, d);
    if (!inside(a, c)) continue;
    if (!loc.valid(a)) continue;
    if (obstacles.some((o) => meets(a, o))) continue;
    const st = rectStats(env, a);
    if (st.blocked) continue;
    const move = loc.move(a);
    if (move > maxMove) continue;
    const [cx, cz] = centre(a);
    const sk = sketch ? Math.max(Math.abs(cx - sketch[0]), Math.abs(cz - sketch[1])) : 0;
    const ad = aim ? Math.max(Math.abs(cx - aim[0]), Math.abs(cz - aim[1])) : 0;
    const score = 4096 * move + 8 * sk + 4 * st.rough + st.water + ad;
    out.push({ rect: a, move, sketch: sk, score, rough: st.rough, water: st.water });
  }
  out.sort((p, q) => p.score - q.score); // stable: scan order on ties
  return out.slice(0, limit);
}

// ------------------------------------------------------------------ zones

/** A lots program's specs for the layout (validateLots' shape; `label` and `entry` are the plan's own). */
function lotSpecs(zone) {
  const lots = zoneLots(zone).map((l) => l.lot);
  return validateLots(lots.map((l) => { const { label, entry, ...rest } = l; void label; void entry; return rest; }), 'lots');
}

/** The program's own minimum rect for a lot list (both sides of one street, the square in the middle): [along, across]. */
export function programMinimum(specs, shared) {
  const R = STREET_RULES;
  const along = specs.reduce((a, s) => a + s.size[0] + R.lotGap, 0);
  const deep = specs.reduce((a, s) => Math.max(a, s.size[1]), 0);
  const sq = shared.kind === 'square' ? shared.size : 7;
  const L = Math.ceil(along / 2) + sq + 2 * R.claimMargin + 8;
  const Dd = 2 * (deep + 2) + R.streetWidth + 2 * R.claimMargin + 2;
  return [Math.max(24, L), Math.max(24, Dd)];
}

/** The zone's shared space (program.lots: shared square|well|none; a template: its params). */
function sharedOf(zone) {
  const p = zone.program;
  const v = p.template !== undefined ? (p.params?.shared ?? 'square') : (p.shared ?? 'square');
  const size = p.template !== undefined ? (p.params?.squareSize ?? 11) : 11;
  return v === 'well' || v === 'none' ? { kind: 'well', size: 7 } : { kind: 'square', size };
}

/** Sizes to try for a zone: [{w, d, asked: [w, d] | null}] (largest first within a range; the program's minimum, growing). */
function zoneSizes(env, zone, specs, shared) {
  const cw = env.claim.maxX - env.claim.minX + 1 - 2 * MARGIN, cd = env.claim.maxZ - env.claim.minZ + 1 - 2 * MARGIN;
  const sz = zone.size;
  if (!sz) {
    const [a, b] = programMinimum(specs, shared);
    const out = [];
    for (const k of [0, 1, 2, 3, 4, 6, 8]) {
      const w = Math.min(cw, a + Math.floor((a * k) / 4)), d = Math.min(cd, b + Math.floor((b * k) / 4));
      if (!out.some((o) => o.w === w && o.d === d)) out.push({ w, d, asked: null });
    }
    return { sizes: out, asked: null };
  }
  const side = (v, P) => (v === undefined ? [P, P] : Array.isArray(v) ? v : [v, v]);
  let wr, dr;
  if (sz.preset) { const P = PRESET_SIZES[sz.preset]; wr = [P, P]; dr = [P, P]; } else { wr = side(sz.w); dr = side(sz.d); }
  const out = [];
  for (let w = wr[1]; w >= wr[0]; w -= Math.max(1, Math.ceil((wr[1] - wr[0]) / 4))) for (let d = dr[1]; d >= dr[0]; d -= Math.max(1, Math.ceil((dr[1] - dr[0]) / 4))) {
    out.push({ w, d, asked: [w, d], dev: 0 });
    if (dr[0] === dr[1]) break;
  }
  return { sizes: out, asked: { w: wr, d: dr } };
}

/** Size deviation in percent of the asked side (0 inside a range). */
function sizeDev(asked, w, d) {
  if (!asked) return 0;
  const one = (v, [lo, hi]) => (v < lo ? Math.ceil(((lo - v) * 100) / lo) : v > hi ? Math.ceil(((v - hi) * 100) / hi) : 0);
  return Math.max(one(w, asked.w), one(d, asked.d));
}

/**
 * Resolve a zone: its rect, and (village zones) the street layout evaluated in it. Returns an answer draft `{klass, rect, layout,
 * deviations, reasons, wouldFit, unplaced}`. `obstacles`: rects the zone must keep `ZONE_GAP` from (the overlap pass).
 */
export function resolveZone(env, z, geomOf, { obstacles = [] } = {}) {
  const zone = z.part;
  const program = zone.program;
  // N-P0-1: a whole-claim template
  if (program.template !== undefined && program.template !== 'flat_village') return resolveWholeClaim(env, z, obstacles);
  let specs;
  try { specs = lotSpecs(zone); } catch (e) { return { klass: 'malformed', reasons: [{ code: 'SCHEMA', path: `${z.path}.program`, message: e.message }] }; }
  if (!specs.length) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: 'the zone lists no lots: nothing to lay out', evidence: { lots: 0 } }] };
  const shared = sharedOf(zone);
  const loc = locatorOf(env, zone.where, geomOf);
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(zone.where ?? {})[0] ?? null, ...(loc.error.evidence ?? {}) } }] };
  const tMove = tolOf(zone, 'move'), tSize = tolOf(zone, 'size'), tCount = tolOf(zone, 'count'), tSketch = tolOf(zone, 'sketch'), tRot = tolOf(zone, 'rotate');
  const sk = sketchPoint(env, zone.sketch);
  const { sizes, asked } = zoneSizes(env, zone, specs, shared);
  // the asked sizes, then (soft size tolerance) shrunk by up to the ceiling
  const tries = [...sizes];
  if (asked) for (const pct of [10, 20, 25, 35, 50]) {
    if (pct > tSize.ceiling) break;
    const w = Math.max(8, Math.floor((asked.w[0] * (100 - pct)) / 100)), d = Math.max(8, Math.floor((asked.d[0] * (100 - pct)) / 100));
    if (!tries.some((t) => t.w === w && t.d === d)) tries.push({ w, d, asked: null, shrunk: pct });
  }
  const obs = obstacles.map((o) => grow(o, ZONE_GAP));
  const keepOut = (env.ctx.keepOut ?? []);
  const evalAt = (cand) => {
    const L = layoutStreet({ claim: { ...env.claim, ...cand.rect }, survey: env.S, specs, rules: STREET_RULES, shared, keepOut });
    return L.fail ? null : L;
  };
  // the search: every size (and orientation), the top-ranked rects' layouts; most lots placed, then the least size change, then
  // unrotated, then the best score. `maxMove`: the move ceiling (Infinity: the wouldFit search, the same ranking past it)
  const searchAll = (maxMove) => {
    let best = null;
    for (const t of tries) {
      const orient = asked && tRot.allowed && t.w !== t.d ? [[t.w, t.d, false], [t.d, t.w, true]] : [[t.w, t.d, false]];
      for (const [w, d, rot] of orient) {
        if (w > env.claim.maxX - env.claim.minX + 1 - 2 * MARGIN || d > env.claim.maxZ - env.claim.minZ + 1 - 2 * MARGIN) continue;
        const cands = scan(env, w, d, loc, { sketch: sk, obstacles: obs, maxMove, limit: EVAL_K * 4 });
        let evals = 0;
        for (const c of cands) {
          if (evals++ >= EVAL_K) break;
          const L = evalAt(c);
          if (!L) continue;
          const unplaced = L.unplaced.length;
          const cand = { ...c, w, d, rot, L, unplaced, sizeDev: t.shrunk ?? sizeDev(asked, rot ? d : w, rot ? w : d) };
          const better = !best || cand.unplaced < best.unplaced || (cand.unplaced === best.unplaced && (cand.sizeDev < best.sizeDev || (cand.sizeDev === best.sizeDev && (cand.rot < best.rot || (cand.rot === best.rot && cand.score < best.score)))));
          if (better) best = cand;
          if (unplaced === 0) break;
        }
        if (best && best.unplaced === 0 && best.sizeDev === 0 && !best.rot) break;
      }
      if (best && best.unplaced === 0) break;
    }
    return best;
  };
  const best = searchAll(tMove.ceiling);
  if (!best) {
    // nothing within the move ceiling: what would fit past it (the wouldFit fragment), else no room
    const beyond = tMove.ceiling < Infinity ? searchAll(Infinity) : null;
    if (beyond && beyond.move > tMove.ceiling) {
      return { klass: 'refused', reasons: [{ code: 'TOLERANCE', message: `the nearest place for the zone is ${beyond.move} cells past its locator (move at most ${tMove.ceiling})`, evidence: { move: beyond.move, max: tMove.max, ceiling: tMove.ceiling } }],
        wouldFit: wouldFitMove(zone, loc, beyond) };
    }
    return { klass: 'refused', reasons: [{ code: obstacles.length ? 'OVERLAP' : 'NO_ROOM', message: obstacles.length ? 'no room for the zone beside the zones placed before it' : 'no street layout fits a rect for the zone here (water, slope, keep-out or the claim)', evidence: { tried: tries.length } }],
      ...(beyond ? { wouldFit: wouldFitMove(zone, loc, beyond) } : {}) };
  }
  const devs = [
    { what: 'move', value: best.move, ...tMove },
    { what: 'size', value: best.sizeDev, ...tSize },
    ...(best.rot ? [{ what: 'rotate', value: 90, max: tRot.hard && !tRot.allowed ? 0 : 90, hard: tRot.hard, ceiling: tRot.allowed ? 90 : 0 }] : []),
    { what: 'count', value: best.unplaced, ...tCount },
    ...(sk ? [{ what: 'sketch', value: best.sketch, ...tSketch }] : []),
  ];
  const j = judge(devs);
  const rect = best.rect;
  const res = { klass: j.klass, rect, layout: best.L, specs, shared, deviations: j.deviations, unplaced: best.L.unplaced, reasons: [] };
  if (j.klass === 'refused') {
    res.reasons.push({ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} is past its ${j.failed.hard ? 'hard limit' : 'ceiling'} (${j.failed.hard ? j.failed.max : j.failed.ceiling})`, evidence: { what: j.failed.what, value: j.failed.value } });
    res.wouldFit = j.failed.what === 'count' ? [{ part: zone.id, fragment: { program: { ...zone.program, ...(zone.program.lots ? { lots: zone.program.lots.filter((l) => !best.L.unplaced.some((u) => u.id === l.id)) } : { params: { ...zone.program.params, lots: zone.program.params.lots.filter((l) => !best.L.unplaced.some((u) => u.id === l.id)) } }) } }, geometry: { rect: rectArr(rect) }, cost: layoutCost(best.L) }]
      : j.failed.what === 'move' ? wouldFitMove(zone, loc, best) : [];
  }
  return res;
}

/** A layout's cost band: its placed lots' provisional range (PROVISIONAL_BAND cells per column of each lot), the plan's own cells aside. */
function layoutCost(L) {
  const cols = (L?.lots ?? []).reduce((n, l) => n + (l.rect[2] - l.rect[0] + 1) * (l.rect[3] - l.rect[1] + 1), 0);
  return { range: { cells: [cols * PROVISIONAL_BAND[0], cols * PROVISIONAL_BAND[1]] }, lots: (L?.lots ?? []).length, unplaced: (L?.unplaced ?? []).length };
}

/** wouldFit for a zone that would fit further out: the same locator, widened to the place found, with its geometry and cost. */
function wouldFitMove(zone, loc, c) {
  const w = zone.where;
  const g = { rect: rectArr(c.rect) }, cost = layoutCost(c.L);
  if (w?.near) return [{ part: zone.id, fragment: { where: { near: { ...w.near, within: Math.min(512, (loc.W ?? 32) + c.move) } } }, geometry: g, cost }];
  if (w?.adjacent) return [{ part: zone.id, fragment: { where: { adjacent: { ...w.adjacent, gap: [loc.adjacent.g0, Math.min(512, loc.adjacent.g1 + c.move)] } } }, geometry: g, cost }];
  return [{ part: zone.id, fragment: { tolerance: { ...(zone.tolerance ?? {}), move: { max: c.move, hard: false } } }, geometry: g, cost }];
}

/** The whole-claim templates' claim ranges (their catalogue `claim`). */
export const WHOLE_CLAIM = new Map();
function resolveWholeClaim(env, z, obstacles) {
  const t = WHOLE_CLAIM.get(z.part.program.template);
  const W = env.claim.maxX - env.claim.minX + 1, D = env.claim.maxZ - env.claim.minZ + 1;
  if (!t) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `template ${z.part.program.template} is not loaded` }] };
  if (obstacles.length) return { klass: 'refused', reasons: [{ code: 'OVERLAP', message: `${z.part.program.template} takes the whole claim, so it compiles only as the plan's sole zone (N-P0-1)` }] };
  const [w0, d0] = t.claim.min, [w1, d1] = t.claim.max;
  const fit = (w, d) => w >= w0 && w <= w1 && d >= d0 && d <= d1;
  if (!fit(W, D) && !fit(D, W)) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `${z.part.program.template} plans a claim of ${w0}x${d0} to ${w1}x${d1} (this claim is ${W}x${D})`, evidence: { claim: [W, D], min: t.claim.min, max: t.claim.max } }] };
  const rect = { minX: env.claim.minX, minZ: env.claim.minZ, maxX: env.claim.maxX, maxZ: env.claim.maxZ };
  return { klass: 'fits', rect, whole: true, deviations: [], reasons: [] };
}

// ------------------------------------------------------------------ forms

/** Terrace: a rect from its locator and size (default M), beside every zone; steps and rise checked against the land. */
function resolveTerrace(env, f, geomOf, zoneIds, obstacles) {
  const part = f.part;
  const loc = locatorOf(env, part.where, geomOf);
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(part.where ?? {})[0] ?? null, ...(loc.error.evidence ?? {}) } }] };
  const P = part.size?.preset ? PRESET_SIZES[part.size.preset] : null;
  const side = (v) => (Array.isArray(v) ? v[1] : v);
  const w = P ?? side(part.size?.w) ?? PRESET_SIZES.M, d = P ?? side(part.size?.d) ?? PRESET_SIZES.M;
  // a terrace inside a zone would sit under its lots: v0 compiles terraces beside zones (S3's terraced program builds on them)
  if (part.where?.inside?.part && zoneIds.has(part.where.inside.part)) return { klass: 'refused', reasons: [{ code: 'OVERLAP', message: `a terrace under zone ${part.where.inside.part}'s lots is not compiled in v0 (terraces stand beside zones)`, evidence: { zone: part.where.inside.part } }] };
  const tMove = tolOf(part, 'move');
  const sk = sketchPoint(env, part.sketch);
  const obs = obstacles.map((o) => grow(o, ZONE_GAP));
  const cands = scan(env, w, d, loc, { sketch: sk, obstacles: obs, maxMove: tMove.ceiling, limit: 1 });
  if (!cands.length) return { klass: 'refused', reasons: [{ code: obstacles.length ? 'OVERLAP' : 'NO_ROOM', message: `no ${w}x${d} rect for the terrace within its locator, clear of the zones and keep-out`, evidence: { size: [w, d], obstacles: obstacles.length } }] };
  const c = cands[0];
  const j = judge([{ what: 'move', value: c.move, ...tMove }, ...(sk ? [{ what: 'sketch', value: c.sketch, ...tolOf(part, 'sketch') }] : [])]);
  return { klass: j.klass, rect: c.rect, footprints: [rectArr(c.rect)], deviations: j.deviations, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [], notes: part.edge === 'blend' ? ['edge blend: v0 builds the terrace\'s 1:1 batters (edge slope); blending its edges by relief is not compiled'] : [] };
}

/** Spikes: `count` sites (dry, off zones, forms and keep-out, 8 apart) within the locator's area, best first. */
function resolveSpikes(env, f, geomOf, taken = []) {
  const part = f.part, p = f;
  const loc = locatorOf(env, part.where, geomOf, { within0: 24 });
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(part.where ?? {})[0] ?? null, ...(loc.error.evidence ?? {}) } }] };
  const want = part.count ?? 1;
  const tMove = tolOf(part, 'move'), tCount = tolOf(part, 'count');
  // a site's footprint: the preset's reach (a spire's radius plus its ledges; a cluster's spread plus a spike's radius), both sides
  const pr = p.kind === 'ice_spike' ? ICE_PRESETS[part.preset ?? 'classic'] : ROCK_PRESETS[part.preset ?? 'pinnacle'];
  const hMax = Array.isArray(part.height) ? part.height[1] : part.height ?? pr.height[1];
  const reach = p.kind === 'ice_spike' ? pr.spread + pr.radius[1] + Math.ceil(pr.lean * hMax) + 2 : pr.radius[1] + pr.ledge[1] + pr.warp + 4;
  const foot = 2 * reach + 1;
  const obs = taken.map((t) => grow(t, 2));
  const cands = scan(env, foot, foot, loc, { obstacles: obs, maxMove: tMove.ceiling, limit: 4096, sketch: sketchPoint(env, part.sketch) });
  const sites = [];
  for (const c of cands) {
    if (sites.length >= want) break;
    if (c.water > 0 || c.rough > 3) continue;
    if (sites.some((s) => gap(s.rect, c.rect) < 8)) continue;
    const [x, zz] = centre(c.rect);
    if (env.S.frozenAt(x, zz)) continue;
    sites.push(c);
  }
  if (!sites.length) return { klass: 'refused', reasons: [{ code: taken.length ? 'OVERLAP' : 'NO_ROOM', message: 'no dry, level site for the form within its locator', evidence: { footprint: foot, obstacles: taken.length } }] };
  const move = Math.max(...sites.map((s) => s.move));
  const j = judge([{ what: 'move', value: move, ...tMove }, { what: 'count', value: want - sites.length, ...tCount }]);
  const notes = part.keepNatural ? ['keepNatural: v0 keeps the spikes off water and frozen columns of the survey (no frozen volume is read)'] : [];
  return { klass: j.klass, sites: sites.map((s) => centre(s.rect)), footprints: sites.map((s) => rectArr(s.rect)), rect: sites.reduce((a, s) => ({ minX: Math.min(a.minX, s.rect.minX), minZ: Math.min(a.minZ, s.rect.minZ), maxX: Math.max(a.maxX, s.rect.maxX), maxZ: Math.max(a.maxZ, s.rect.maxZ) }), sites[0].rect), deviations: j.deviations, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [], notes };
}

// ------------------------------------------------------------------ (D1) districts zones

/** A plan size ({w, d} with ints or ranges, or a preset) as one [w, d]: a range's largest, a preset's side. */
function sideOf(size) {
  if (!size) return null;
  if (size.preset) return [PRESET_SIZES[size.preset], PRESET_SIZES[size.preset]];
  const one = (v) => (Array.isArray(v) ? v[1] : v);
  return [one(size.w), one(size.d)];
}

/** A districts program's districts in the pass's shape (lots without the plan's label and entry). */
export function planDistricts(part) {
  return (part.program.districts ?? []).map((d) => ({
    id: d.id, size: sideOf(d.size), lots: d.lots.map((l) => { const { label, entry, ...rest } = l; void label; void entry; return rest; }),
    ...(d.levelBand ? { levelBand: d.levelBand } : {}), ...(d.prefer ? { prefer: d.prefer } : {}), ...(d.near ? { near: d.near } : {}), ...(d.shared ? { shared: d.shared } : {}),
  }));
}

/**
 * Resolve a districts zone (D1): the districts placed on survey candidates (kit/lib/region/districtsEmit.mjs placeDistricts) clear of
 * the claim's protected areas, other owners' regions, builds and standing regions (env.hard) and of `taken` (the zones and forms
 * resolved before it). fits when every district and lot is placed; adjusted (count) when some are not; refused NO_ROOM when none is.
 */
export function resolveDistrictsZone(env, p, taken) {
  let dsRaw, ds;
  try { dsRaw = planDistricts(p.part); ds = parseDistricts(dsRaw, 'program.districts'); } catch (e) { return { klass: 'malformed', reasons: [{ code: 'SCHEMA', path: `${p.path}.program.districts`, message: e.message }] }; }
  const notes = [];
  if (p.part.where || p.part.size) notes.push('a districts zone is placed over the claim: its where and size are not read in v0');
  const blocked = [...env.hard.map(rectArr), ...taken.map((q) => rectArr(grow(q, 1)))];
  const placement = placeDistricts({ S: env.S, claim: env.claim, keepOut: env.keepOut.map(rectArr), blocked, ds });
  const placed = ds.filter((d) => placement.pick.has(d.id));
  if (!placed.length) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `no district has a candidate area (${placement.unplaced.map((u) => `${u.id}: ${u.reason}`).join(', ')})`, evidence: { unplaced: placement.unplaced } }] };
  const unplacedLots = ds.filter((d) => !placement.pick.has(d.id)).reduce((a, d) => a + d.specs.length, 0) + placed.reduce((a, d) => a + placement.pick.get(d.id).L.unplaced.length, 0);
  const t = tolOf(p.part, 'count');
  const j = judge([{ what: 'count', value: unplacedLots, max: t.max, hard: t.hard, ceiling: t.ceiling }]);
  const rects = placed.map((d) => placement.pick.get(d.id).rect);
  const rect = rects.reduce((a, q) => ({ minX: Math.min(a.minX, q.minX), minZ: Math.min(a.minZ, q.minZ), maxX: Math.max(a.maxX, q.maxX), maxZ: Math.max(a.maxZ, q.maxZ) }));
  if (placement.unplaced.length) notes.push(`unplaced: ${placement.unplaced.map((u) => `${u.id} (${u.reason})`).join(', ')}`);
  return {
    klass: j.klass, deviations: j.deviations, notes,
    reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${unplacedLots} lot(s) unplaced, past the count tolerance`, evidence: { unplaced: unplacedLots } }] : [],
    rect, rects, ds, dsRaw, placement, unplacedLots, districts: true,
  };
}

/** A district id for a plan zone (the pass's ids are at most 24 characters). */
const districtIdOf = (zoneId) => (/^[a-z][a-z0-9_]{0,23}$/.test(zoneId) ? zoneId : `z_${sha256Hex(zoneId).slice(0, 12)}`);

/**
 * (D2, C27) A zone along a boundary (`where: {along: {feature, side?, anchor?}}`): one district following it (a shore for a water
 * feature, a biome edge, a ridge), its size [length, depth] from the zone's size (default 96 x 24), its lots the zone's. Placed now
 * (kit/lib/region/followEmit.mjs placeFollow), so later parts keep out of its band; refused NO_FEATURE (no such edge), PROTECTED or
 * OVERLAP, named.
 */
export function resolveFollowZone(env, p, taken) {
  const al = p.part.where.along, f = al.feature ?? {};
  const fk = Object.keys(f)[0];
  const follow = fk === 'water' ? { shore: { minArea: f.water?.minArea ?? 64 } } : fk === 'biome_edge' ? { biome_edge: { between: f.biome_edge.between } } : fk === 'ridge' ? { ridge: { minRise: f.ridge?.minRise ?? 8 } } : null;
  if (!follow) return { klass: 'refused', reasons: [{ code: 'NO_FEATURE', message: `along ${fk}: v0 follows a water body's shore, a biome edge or a ridge`, evidence: { feature: f } }] };
  const sz = sideOf(p.part.size) ?? [96, 24];
  const size = [Math.max(24, Math.min(256, sz[0])), Math.max(12, Math.min(64, sz[1]))];
  const id = districtIdOf(p.id);
  const lots = zoneLots(p.part).map((l) => { const { label, entry, ...rest } = l.lot; void label; void entry; return rest; });
  const side = al.side === 'right' ? 'b' : 'a';
  let ds;
  try { ds = parseDistricts([{ id, size, lots, follow, side }], 'zone'); } catch (e) { return { klass: 'malformed', reasons: [{ code: 'SCHEMA', path: `${p.path}.program`, message: e.message }] }; }
  const notes = [];
  if (fk === 'water' && (f.water?.body || f.water?.pick)) notes.push('along water: the shore of any water body of at least minArea is followed (body and pick are not read in v0)');
  if (al.distance !== undefined) notes.push('along: distance is not read in v0 (the band starts at the boundary)');
  if (al.side && !['either', 'left', 'right'].includes(al.side)) notes.push(`along: side ${al.side} is read as the first family's side`);
  const near = al.anchor ? env.anchors.get(al.anchor) : null;
  const blocked = [...env.regions.map((a) => rectArr(grow(a.rect, 1))), ...env.buildRects.map((a) => rectArr(grow(a.rect, 1))), ...env.standingHard, ...taken.map((q) => rectArr(grow(q, 1)))];
  const keepOut = [...env.keepOut.map(rectArr), ...env.protectedAreas.map((a) => rectArr(a.rect))];
  const pf = placeFollow({ cols: env.cols, claim: env.claim, d: ds[0], biomes: env.ctx.biomes ?? null, blocked, keepOut, near });
  if (pf.none) {
    const code = /^PROTECTED/.test(pf.none) ? 'PROTECTED' : /^OVERLAP/.test(pf.none) ? 'OVERLAP' : 'NO_FEATURE';
    return { klass: 'refused', reasons: [{ code, message: pf.none, evidence: { feature: f } }] };
  }
  return { klass: 'fits', notes, rect: pf.rect, rects: [pf.rect], ds, dsRaw: [{ id, size, lots, follow, side }], follow: { [id]: pf }, ...(near ? { near: { [id]: near } } : {}), unplacedLots: 0, districts: true };
}

/**
 * (D2) An outpost zone (`kind: outpost`): one district on a survey candidate at least `gap` (default 24) from every zone and form
 * resolved before it, joined at emission by a road to the nearest other zone's street end (its corridor reported, its region's).
 */
export function resolveOutpostZone(env, p, taken) {
  const sz = sideOf(p.part.size) ?? [40, 40];
  const size = [Math.max(24, Math.min(256, sz[0])), Math.max(24, Math.min(256, sz[1]))];
  const id = districtIdOf(p.id);
  const lots = zoneLots(p.part).map((l) => { const { label, entry, ...rest } = l.lot; void label; void entry; return rest; });
  const gap = Number.isInteger(p.part.gap) ? p.part.gap : 24;
  let ds;
  try { ds = parseDistricts([{ id, size, lots, outpost: { gap } }], 'zone'); } catch (e) { return { klass: 'malformed', reasons: [{ code: 'SCHEMA', path: `${p.path}.program`, message: e.message }] }; }
  const blocked = [...env.hard.map(rectArr), ...taken.map((q) => rectArr(grow(q, 1)))];
  const placement = placeDistricts({ S: env.S, claim: env.claim, keepOut: env.keepOut.map(rectArr), blocked, ds, farFrom: taken.map(rectArr) });
  if (!placement.pick.has(id)) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `no candidate area at least ${gap} from the zones placed before it`, evidence: { unplaced: placement.unplaced } }] };
  const c = placement.pick.get(id);
  const unplacedLots = c.L.unplaced.length;
  const t = tolOf(p.part, 'count');
  const j = judge([{ what: 'count', value: unplacedLots, max: t.max, hard: t.hard, ceiling: t.ceiling }]);
  return { klass: j.klass, deviations: j.deviations, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${unplacedLots} lot(s) unplaced` }] : [], rect: c.rect, rects: [c.rect], ds, dsRaw: [{ id, size, lots, outpost: { gap } }], placement, unplacedLots, districts: true, outpost: true };
}

// ------------------------------------------------------------------ the region: checkpoints

/** A snapshot of the region's growable state; rollback() restores it (a part whose emission throws writes nothing). */
function checkpoint(r) {
  return {
    parts: r.parts.length, partIds: new Set(r.partIds), lots: r.lots.length, lotIds: new Set(r.lotIds), roads: r.roads.length, roadIds: new Set(r.roadIds),
    paths: r.paths.length, nodes: r.graph.nodes.length, edges: r.graph.edges.length, graphIds: new Set(r.graphIds), forms: r.forms.length, opCount: r.opCount,
    notes: r.notes.length, passRuns: r.passRuns.length, blend: r.blendLots.length, relief: new Set(r.reliefLots), fields: { ...r.fields }, sideBlobs: { ...r.sideBlobs },
    pathIds: Object.keys(r.meta.paths), nodeIds: r.graph.nodes.length, edgeIds: r.graph.edges.length,
    meta: JSON.stringify({ paths: r.meta.paths, lots: r.meta.lots, parts: r.meta.parts, route: r.meta.route ?? null, gravity: r.meta.gravity ?? null, forms: r.meta.forms ?? null, village: r.meta.village ?? null, villageZones: r.meta.villageZones ?? null }),
    anchors: { ...r.anchors },
  };
}
function rollback(r, c) {
  r.parts.length = c.parts; r.partIds = c.partIds; r.lots.length = c.lots; r.lotIds = c.lotIds; r.roads.length = c.roads; r.roadIds = c.roadIds;
  r.paths.length = c.paths; r.graph.nodes.length = c.nodes; r.graph.edges.length = c.edges; r.graphIds = c.graphIds; r.forms.length = c.forms; r.opCount = c.opCount;
  r.notes.length = c.notes; r.passRuns.length = c.passRuns; r.blendLots.length = c.blend; r.reliefLots = c.relief; r.fields = c.fields; r.sideBlobs = c.sideBlobs;
  const m = JSON.parse(c.meta);
  r.meta.paths = m.paths; r.meta.lots = m.lots; r.meta.parts = m.parts;
  for (const k of ['route', 'gravity', 'forms', 'village', 'villageZones']) { if (m[k] === null) delete r.meta[k]; else r.meta[k] = m[k]; }
  r.anchors = c.anchors;
}
/** The region parts (and lots) added since a checkpoint. */
const addedSince = (r, c) => ({ parts: r.parts.slice(c.parts).map((p) => p.id), lots: r.lots.slice(c.lots).map((l) => l.id), roads: r.roads.slice(c.roads).map((x) => x.id),
  paths: Object.keys(r.meta.paths).filter((k) => !(c.pathIds ?? []).includes(k)), nodes: r.graph.nodes.slice(c.nodes ?? 0).map((n) => n.id), edges: r.graph.edges.slice(c.edges ?? 0).map((e) => e.id) });

// ------------------------------------------------------------------ the check

/**
 * Run the check inside plan_v0. Returns `{region, record}`: the region (made by `makeRegion`, or by a whole-claim template) and the
 * planCheck record for its `meta.planCheck`. `templates`: name -> {module} for N-P0-1 (the caller runs a whole-claim template first and passes
 * `whole: {zone, region}`).
 */
export function runCheck(ctx, P, { makeRegion, templates = new Map() }) {
  const env = makeEnv(ctx, P, performance.now());
  for (const [name, t] of templates) WHOLE_CLAIM.set(name, { claim: t.catalogue?.claim ?? { min: [64, 64], max: [1024, 1024] }, module: t });
  const V = validatePlan(P.plan, { anchors: Object.keys(env.anchorsGiven) });
  const answers = new Map();
  const res = new Map(); // id -> resolution
  const geom = new Map(); // id -> {rect}
  const notes = [];
  const record = { schemaVersion: 'plan/0', catalogueVersion: CATALOGUE_VERSION, kitVersion: KIT_VERSION, budget: env.budget, surveySha: env.surveySha };
  if (V.malformed) {
    const r = makeRegion(null);
    r.stages(['main']);
    stubAnchors(r, env);
    return { region: r, record: { ...record, malformed: V.malformed, answers: [], partOf: {}, notes, hit: null, order: [] } };
  }
  const lotZone = V.lotZone;
  const geomOf = (id) => {
    if (geom.has(id)) return geom.get(id);
    if (lotZone.has(id)) { const z = res.get(lotZone.get(id)); const l = z?.layout?.lots?.find((x) => x.spec.id === id); return l ? { rect: arrRect(l.rect) } : null; }
    return null;
  };
  // every reason carries evidence (§3): its own, else what the reason names (the path, the block and its slice, the parts)
  const withEvidence = (r) => (r.evidence ? r : { ...r, evidence: Object.fromEntries(Object.entries({ path: r.path, block: r.block, until: r.until, blockedBy: r.blockedBy }).filter(([, v]) => v !== undefined && v !== null)) });
  const ans = (p, o) => {
    if (Array.isArray(o.reasons)) o = { ...o, reasons: o.reasons.map(withEvidence) };
    const a = { part: p.id, block: p.block, class: o.class, required: p.required };
    for (const k of ['geometry', 'cost', 'provisional', 'deviations', 'reasons', 'wouldFit', 'blockedBy', 'cached', 'notes']) if (o[k] !== undefined && !(Array.isArray(o[k]) && !o[k].length)) a[k] = o[k];
    if (p.ext) a.ext = p.ext;
    answers.set(p.id, a);
    return a;
  };
  const budgetHit = (cap) => ({ class: 'incomplete', reasons: [{ code: 'BUDGET', message: `the check ran out of ${cap} before this part had an answer`, evidence: { cap } }] });
  const okClass = (id) => ['fits', 'adjusted'].includes(answers.get(id)?.class);
  const depState = (p) => {
    const bad = p.deps.filter((d) => !okClass(d));
    if (!bad.length) return null;
    const inc = bad.filter((d) => answers.get(d)?.class === 'incomplete');
    if (inc.length) return { class: 'incomplete', reasons: [{ code: 'BUDGET', message: `depends on ${inc.join(', ')}, which ran out of budget`, evidence: { cap: answers.get(inc[0]).reasons?.[0]?.evidence?.cap ?? null } }] };
    return { class: 'blocked', blockedBy: bad, reasons: [{ code: 'DEPENDENCY', message: `depends on ${bad.join(', ')}, which ${bad.length === 1 ? 'is' : 'are'} not fits or adjusted`, evidence: { blockedBy: bad, classes: Object.fromEntries(bad.map((d) => [d, answers.get(d)?.class ?? null])) } }] };
  };
  const timeUp = () => { if (performance.now() > env.deadline) env.hitTime = true; return env.hitTime; };

  // ---- 1. validation verdicts
  for (const p of V.parts) {
    if (p.verdict === 'malformed') ans(p, { class: 'malformed', reasons: [p.reason] });
    else if (p.verdict === 'unsupported') ans(p, { class: 'unsupported', reasons: [{ code: 'UNSUPPORTED', message: p.reason.message, block: p.block, until: p.reason.until ?? undefined, path: p.reason.path }].map(clean) });
  }
  const byId = V.byId;
  const order = V.order.map((id) => byId.get(id));
  const zonesAccepted = []; // {id, rect}
  const formsAccepted = []; // footprint rects of the forms placed so far
  // ---- 2. resolve zones and forms in order; connectors after
  const reliefOf = new Map(); // zone id -> relief form ids naming it
  for (const p of order) {
    if (answers.has(p.id)) continue;
    if (p.family === 'connector') continue;
    const dep = depState(p);
    if (dep) { ans(p, dep); continue; }
    if (timeUp()) { ans(p, budgetHit('maxMs')); continue; }
    if (p.family === 'zone' && (p.part.where?.along || p.kind === 'outpost') && !Array.isArray(p.part.program?.districts)) {
      // (D2) a zone along a boundary (locator.along: a shore, a biome edge, a ridge), or an outpost: one district, never cached
      const taken = [...zonesAccepted.map((o) => o.rect), ...formsAccepted];
      const z = p.kind === 'outpost' ? resolveOutpostZone(env, p, taken) : resolveFollowZone(env, p, taken);
      res.set(p.id, z);
      if (z.klass === 'fits' || z.klass === 'adjusted') { geom.set(p.id, { rect: z.rect }); for (const q of z.rects) zonesAccepted.push({ id: p.id, rect: q }); }
      ans(p, { class: z.klass, reasons: z.reasons, deviations: z.deviations, notes: z.notes });
      continue;
    }
    if (p.family === 'zone' && Array.isArray(p.part.program?.districts)) {
      // (D1) a districts zone: its districts placed on survey candidates around the zones and forms before it (never cached)
      const z = resolveDistrictsZone(env, p, [...zonesAccepted.map((o) => o.rect), ...formsAccepted]);
      res.set(p.id, z);
      if (z.klass === 'fits' || z.klass === 'adjusted') { geom.set(p.id, { rect: z.rect }); for (const q of z.rects) zonesAccepted.push({ id: p.id, rect: q }); }
      ans(p, { class: z.klass, reasons: z.reasons, deviations: z.deviations, notes: z.notes });
      continue;
    }
    if (p.family === 'zone') {
      const key = cacheKey(env, p, geom);
      const hit = env.cacheIn?.(key);
      let z;
      if (hit && hit.rect && !zonesAccepted.some((o) => meets(grow(arrRect(hit.rect), ZONE_GAP), o.rect))) {
        z = rehydrateZone(env, p, hit);
        if (z) z.cached = true;
      }
      if (!z) z = resolveZone(env, p, geomOf);
      // the overlap pass: a zone meeting one placed before it is placed again around them (never cached)
      if ((z.klass === 'fits' || z.klass === 'adjusted') && zonesAccepted.some((o) => meets(grow(z.rect, ZONE_GAP), o.rect))) {
        const again = resolveZone(env, p, geomOf, { obstacles: zonesAccepted.map((o) => o.rect) });
        z = again;
        if (z.klass === 'fits' || z.klass === 'adjusted') {
          z.deviations = [...(z.deviations ?? [])];
          z.notes = [...(z.notes ?? []), 'placed again around the zones resolved before it (zones never overlap)'];
          if (z.klass === 'fits') z.klass = 'adjusted';
        } else if (z.reasons?.[0]?.code === 'NO_ROOM' || z.reasons?.[0]?.code === 'TOLERANCE') {
          // the zones placed before it hold its place: OVERLAP, naming them (what would fit stays)
          z.reasons[0] = { ...z.reasons[0], code: 'OVERLAP', evidence: { ...(z.reasons[0].evidence ?? {}), zones: zonesAccepted.map((o) => o.id) } };
        }
      } else if ((z.klass === 'fits' || z.klass === 'adjusted') && !z.cached) env.cacheOut[key] = cacheEntry(z);
      res.set(p.id, z);
      if (z.klass === 'fits' || z.klass === 'adjusted') { geom.set(p.id, { rect: z.rect }); zonesAccepted.push({ id: p.id, rect: z.rect }); }
      ans(p, { class: z.klass, reasons: z.reasons, deviations: z.deviations, wouldFit: z.wouldFit, notes: z.notes, cached: z.cached || undefined, provisional: undefined });
      continue;
    }
    if (p.family === 'form') {
      if (p.kind === 'relief') {
        const around = p.part.around;
        const zonesIn = around.filter((id) => byId.get(id)?.family === 'zone');
        const others = around.filter((id) => byId.get(id)?.family !== 'zone');
        const n = others.length ? [`around ${others.join(', ')}: v0 blends around zones' pads only (routes cut and fill their own ground, T2)`] : [];
        if (!zonesIn.length) { ans(p, { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: 'relief names no zone (v0 blends around zones\' pads)' }], notes: n }); continue; }
        for (const z of zonesIn) { if (!reliefOf.has(z)) reliefOf.set(z, []); reliefOf.get(z).push(p.id); }
        res.set(p.id, { klass: 'fits', zones: zonesIn });
        ans(p, { class: 'fits', notes: n });
        continue;
      }
      // placed from its own locator (cacheable), then, meeting a zone or a form placed before it, placed again around them (never
      // cached), as zones are
      const taken = [...zonesAccepted.map((o) => o.rect), ...formsAccepted];
      const zoneIds = new Set(V.parts.filter((q) => q.family === 'zone').map((q) => q.id));
      const resolveForm = (obs) => (p.kind === 'terrace' ? resolveTerrace(env, p, geomOf, zoneIds, obs) : resolveSpikes(env, p, geomOf, obs));
      const ok = (x) => x.klass === 'fits' || x.klass === 'adjusted';
      const gapOf = p.kind === 'terrace' ? ZONE_GAP : 2;
      const clashes = (x) => (x.footprints ?? []).some((fp) => taken.some((o) => meets(grow(arrRect(fp), gapOf), o)));
      const key = cacheKey(env, p, geom);
      const hit = env.cacheIn?.(key);
      let f = hit && hit.footprints ? { klass: hit.klass, rect: arrRect(hit.rect), footprints: hit.footprints, sites: hit.sites ?? undefined, deviations: hit.deviations, reasons: hit.reasons, notes: hit.notes, cached: true } : resolveForm([]);
      if (ok(f) && clashes(f)) {
        f = resolveForm(taken);
        if (ok(f)) { f.notes = [...(f.notes ?? []), 'placed again around the zones and forms resolved before it']; if (f.klass === 'fits') f.klass = 'adjusted'; }
      } else if (ok(f) && !f.cached) env.cacheOut[key] = { rect: rectArr(f.rect), footprints: f.footprints, ...(f.sites ? { sites: f.sites } : {}), klass: f.klass, deviations: f.deviations ?? [], reasons: f.reasons ?? [], notes: f.notes ?? [] };
      if (ok(f)) formsAccepted.push(...f.footprints.map(arrRect));
      res.set(p.id, f);
      if (f.klass === 'fits' || f.klass === 'adjusted') geom.set(p.id, { rect: f.rect });
      ans(p, { class: f.klass, reasons: f.reasons, deviations: f.deviations, notes: f.notes, cached: f.cached || undefined });
      continue;
    }
  }

  // ---- 3. emit zones (pads blend where a relief names them), relief, forms
  // (7a K1) a plan with a wall, gate, rope bridge or auto connector to compile gets the `links` stage after `routes` (none
  // otherwise: every plan without K1 parts keeps its stages, so its IR)
  const k1Parts = order.filter((p) => p.family === 'connector' && K1_KINDS.includes(p.kind) && !answers.has(p.id));
  const stagesWanted = k1Parts.length ? ['ground', 'street', 'forms', 'routes', 'links', 'lots', 'props'] : ['ground', 'street', 'forms', 'routes', 'lots', 'props'];
  const whole = order.find((p) => p.family === 'zone' && res.get(p.id)?.whole && okClass(p.id));
  let r;
  const partOf = {}; // region part / lot / road id -> plan part id
  const mark = (pid, added) => { for (const id of [...added.parts, ...added.lots.map((l) => `lot:${l}`), ...added.roads.map((x) => `road:${x}`), ...(added.paths ?? []).map((x) => `path:${x}`), ...(added.nodes ?? []).map((x) => `node:${x}`), ...(added.edges ?? []).map((x) => `edge:${x}`)]) partOf[id] = pid; };
  if (whole) {
    // N-P0-1: the template runs first over the whole claim with its own params; the region is its
    const t = WHOLE_CLAIM.get(whole.part.program.template);
    const sub = Object.create(ctx, { params: { value: Object.freeze(templateParams(t.module, whole.part.program.params ?? {})), enumerable: true } });
    try {
      r = t.module.default(sub);
      if (!r || typeof r.part !== 'function') throw new Error('the template returned no region');
    } catch (e) {
      r = null;
      res.set(whole.id, { klass: 'refused' });
      ans(whole, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `${whole.part.program.template}: ${e.message}` }] });
    }
    if (r) {
      const c0 = { parts: 0, lots: 0, roads: 0, pathIds: [], nodes: 0, edges: 0 };
      mark(whole.id, addedSince(r, c0));
      const ent = r.anchors.entrance;
      geom.set(whole.id, { rect: res.get(whole.id).rect, entrance: ent });
    }
  }
  if (!r) { r = makeRegion(null); r.stages(stagesWanted); }
  const stageOf = (s) => (r.stageList.includes(s) ? s : s === 'routes' || s === 'props' || s === 'lots' || s === 'links' ? r.stageList[r.stageList.length - 1] : r.stageList[0]);
  const zoneEmit = new Map(); // zone id -> {L, lots, prefix}
  let villages = 0, laneCells = [], reserved = new Set();
  const outposts = [];
  // (D1) a districts zone (D2: a following zone, an outpost zone): its layouts, then its own routes (a spanning tree plus loops, a
  // following street, an outpost's road), lamps once at the end
  const emitDZone = (p, z, extra) => {
    const cp = checkpoint(r);
    try {
      const others = [...geom.entries()].filter(([id, g]) => id !== p.id && g?.rect && byId.get(id)?.family === 'zone').map(([, g]) => rectArr(g.rect));
      const out = emitDistricts(r, {
        districts: z.dsRaw, _placed: z.placement, ...(z.follow ? { _follow: z.follow } : {}), ...(z.near ? { near: z.near } : {}), loopiness: p.part.program?.loopiness ?? 0.15, lamps: false, anchors: false, meta: false,
        stage: { ground: stageOf('ground'), street: stageOf('street'), routes: stageOf('routes'), lots: stageOf('lots'), props: stageOf('props') },
        routePart: `routes_${p.id}`.slice(0, 48), hard: [...env.hard.map(rectArr), ...others], ...extra,
      });
      for (const k of out.reserved) reserved.add(k);
      laneCells.push(...out.laneCells);
      const layouts = Object.values(out.layouts);
      const bell0 = Object.values(out.data.bells)[0];
      zoneEmit.set(p.id, { L: { lots: layouts.flatMap((L) => L.lots), res: { bell: bell0 } }, districts: out, prefix: '' });
      geom.set(p.id, { rect: z.rect, bell: bell0 });
      villages++;
      mark(p.id, addedSince(r, cp));
      // a district no route reached went unplaced at emission: its lots count against count; (D2) so do a following district's lots
      // its street had no room for
      const late = out.data.unplaced.filter((u) => u.reason === 'unreachable');
      const lateLots = Object.values(out.data.follow ?? {}).length ? Object.entries(out.data.unplacedLots).filter(([id]) => out.data.follow?.[id]).reduce((a, [, v]) => a + v.length, 0) : 0;
      if (lateLots && !late.length) {
        const t = tolOf(p.part, 'count');
        const j = judge([{ what: 'count', value: z.unplacedLots + lateLots, max: t.max, hard: t.hard, ceiling: t.ceiling }]);
        ans(p, { class: j.klass, deviations: j.deviations, notes: [...(z.notes ?? []), `${lateLots} lot(s) without room along the street`], reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${z.unplacedLots + lateLots} lot(s) unplaced, past the count tolerance`, evidence: { unplaced: z.unplacedLots + lateLots } }] : [] });
      }
      if (late.length) {
        const lost = late.reduce((a, u) => a + (z.ds.find((d) => d.id === u.id)?.specs.length ?? 0), 0);
        const t = tolOf(p.part, 'count');
        const j = judge([{ what: 'count', value: z.unplacedLots + lost, max: t.max, hard: t.hard, ceiling: t.ceiling }]);
        ans(p, { class: j.klass, deviations: j.deviations, notes: [...(z.notes ?? []), `unreachable: ${late.map((u) => u.id).join(', ')} (no route reaches ${late.length === 1 ? 'it' : 'them'})`],
          reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${z.unplacedLots + lost} lot(s) unplaced, past the count tolerance`, evidence: { unplaced: z.unplacedLots + lost } }] : [] });
      }
    } catch (e) {
      rollback(r, cp);
      const code = /NO_ROOM/.test(e.message) ? 'NO_ROOM' : /NO_EDGE/.test(e.message) ? 'NO_FEATURE' : /PROTECTED/.test(e.message) ? 'PROTECTED' : /OVERLAP/.test(e.message) ? 'OVERLAP' : 'UNREACHABLE';
      ans(p, { class: 'refused', reasons: [{ code, message: `the districts' layout failed: ${e.message}` }] });
      geom.delete(p.id);
    }
  };
  for (const p of order) {
    if (p.family !== 'zone' || !okClass(p.id) || res.get(p.id).whole) continue;
    const z = res.get(p.id);
    if (z.districts) {
      // (D2) an outpost is emitted after the other zones (its road joins the nearest one's street end)
      if (z.outpost) { outposts.push(p); continue; }
      emitDZone(p, z, {});
      continue;
    }
    const prefix = villages === 0 ? '' : `z${villages + 1}_`;
    const cp = checkpoint(r);
    try {
      const shared = z.shared;
      let props = null;
      const L = streetLayout(r, z.specs, {
        rules: STREET_RULES, shared, laneWidth: (p.part.program.params?.laneWidth ?? 2), maxHeight: 32, rect: z.rect, prefix, layout: z.layout,
        padEdge: reliefOf.has(p.id) && reliefOf.get(p.id).some((f) => okClass(f)) ? 'blend' : 'slope',
        stages: { ground: stageOf('ground'), street: stageOf('street'), lots: stageOf('lots') },
        planProps: ({ o, sh, res: rs, lots }) => (props = planProps(r, { o, sh, res: rs, lots, laneWidth: 2, lamps: p.part.program.params?.lamps ?? 'street', bell: !!p.part.program.params?.bell, keepOut: ctx.keepOut ?? [], rng: ctx.rng(`props:${p.id}`) })),
      });
      emitProps(r, props, { stage: stageOf('props'), prefix });
      for (const k of props?.noWalk ?? []) reserved.add(k);
      for (const [x, zz] of [...L.res.area, ...L.res.golem]) reserved.add(`${x},${zz}`);
      laneCells.push(...Object.values(L.laneCells).flat());
      zoneEmit.set(p.id, { L, prefix });
      geom.set(p.id, { rect: z.rect, bell: L.res.bell });
      villages++;
      mark(p.id, addedSince(r, cp));
    } catch (e) {
      rollback(r, cp);
      ans(p, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `the zone's layout failed: ${e.message}` }] });
      geom.delete(p.id);
    }
  }
  // (D2) the outposts: each joined by a road to the nearest other zone's street end (the cell past it) or a district's
  for (const p of outposts) {
    const z = res.get(p.id);
    const c = centre(z.rect);
    let best = null;
    for (const [zid, e] of zoneEmit) {
      if (zid === p.id) continue;
      const ends = e.districts ? Object.values(e.districts.ends).flat().map((x) => ({ x: x.x, z: x.z, facing: x.facing })) : (() => {
        const o = e.L.orientation, sv = e.L.road.sv;
        return [[e.L.u0 - 1, -1], [e.L.u1 + 1, 1]].map(([u, sg]) => { const [x, zz] = toWorld(o, u, sv); return { x, z: zz, facing: o === 'ew' ? [sg, 0] : [0, sg] }; });
      })();
      for (const q of ends) { const d = Math.max(Math.abs(q.x - c[0]), Math.abs(q.z - c[1])); if (!best || d < best.d) best = { d, q, zid }; }
    }
    if (!best) { ans(p, { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: 'an outpost needs another zone of the plan to join (its road ends at that zone\'s street end)' }] }); continue; }
    const q = best.q;
    emitDZone(p, z, { joinTo: { name: `o_${p.id}`.slice(0, 40), at: [q.x, env.S.groundAt(q.x, q.z) + 1, q.z], facing: q.facing } });
  }
  // relief: one pass per relief form, around its zones' lots
  for (const p of order) {
    if (p.family !== 'form' || p.kind !== 'relief' || !okClass(p.id)) continue;
    const dep = depState(p);
    if (dep) { ans(p, dep); continue; }
    const lots = res.get(p.id).zones.flatMap((zid) => (zoneEmit.get(zid)?.L?.lots ?? []).map((l) => l.lot));
    if (!lots.length) continue;
    const cp = checkpoint(r);
    const name = `relief_${p.id}`.slice(0, 40);
    try {
      r.pass('relief', { around: lots, radius: p.part.radius ?? 12, maxCut: p.part.maxCut ?? 6, maxFill: p.part.maxFill ?? 6, erode: p.part.erode ?? null, name, part: name });
      mark(p.id, addedSince(r, cp));
    } catch (e) {
      rollback(r, cp);
      ans(p, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `relief: ${e.message}` }] });
    }
  }
  // a pad on a blend edge that no relief ran around (its relief failed): blend it anyway, inside the zone's own answer (never left broken)
  const unblended = r.blendLots.filter((id) => !r.reliefLots.has(id));
  if (unblended.length) {
    const lots = r.lots.filter((l) => unblended.includes(l.id));
    r.pass('relief', { around: lots, name: 'relief_pads', part: 'relief_pads' });
    notes.push(`relief_pads: ${unblended.length} pad(s) blended by the default relief (their relief form did not run)`);
  }
  // terrace and spikes
  for (const p of order) {
    if (p.family !== 'form' || p.kind === 'relief' || !okClass(p.id)) continue;
    const f = res.get(p.id);
    const cp = checkpoint(r);
    const id = `f_${p.id}`.slice(0, 44);
    try {
      if (p.kind === 'terrace') {
        const a = f.rect;
        const part = r.part(id, { stage: stageOf('forms') });
        part.terrace({ polygon: [[a.minX, a.minZ], [a.maxX + 1, a.minZ], [a.maxX + 1, a.maxZ + 1], [a.minX, a.maxZ + 1]] }, p.part.steps ?? 3, { riser: p.part.rise ?? 2, step: p.part.rise ?? 2, edge: 'slope', stairs: true });
        (r.meta.parts[part.id] ??= {}).kind = 'terrace';
      } else {
        const presets = p.kind === 'ice_spike' ? ICE_PRESETS : ROCK_PRESETS;
        const preset = p.part.preset ?? (p.kind === 'ice_spike' ? 'classic' : 'pinnacle');
        const h = p.part.height === undefined ? undefined : Array.isArray(p.part.height) ? p.part.height : [p.part.height, p.part.height];
        f.sites.forEach(([x, z], k) => {
          const at = [x, env.S.groundAt(x, z), z];
          const params = { preset, at, ...(h ? { height: h } : {}) };
          if (p.kind === 'ice_spike') r.iceSpike(`${id}_${k + 1}`, params, { stage: stageOf('forms') });
          else r.rockSpire(`${id}_${k + 1}`, params, { stage: stageOf('forms') });
        });
      }
      const added = addedSince(r, cp);
      // a form must stay inside the claim
      for (const fm of r.forms.slice(cp.forms)) if (fm.bounds && (fm.bounds.minX < env.claim.minX || fm.bounds.maxX > env.claim.maxX || fm.bounds.minZ < env.claim.minZ || fm.bounds.maxZ > env.claim.maxZ)) throw new Error(`OUT_OF_CLAIM: form ${fm.id} reaches past the claim`);
      mark(p.id, added);
      const b = r.forms.slice(cp.forms).reduce((a, fm) => (fm.bounds ? { minX: Math.min(a.minX, fm.bounds.minX), minZ: Math.min(a.minZ, fm.bounds.minZ), maxX: Math.max(a.maxX, fm.bounds.maxX), maxZ: Math.max(a.maxZ, fm.bounds.maxZ) } : a), f.rect);
      geom.set(p.id, { rect: b });
    } catch (e) {
      rollback(r, cp);
      const oc = /OUT_OF_CLAIM/.test(e.message);
      ans(p, { class: 'refused', reasons: [{ code: oc ? 'OUT_OF_CLAIM' : 'NO_ROOM', message: e.message }] });
      geom.delete(p.id);
    }
  }

  // ---- (7a K1) the K1 context (docs/CONTRACT.md "Phase 7a slice K1" §4's compile order), then step 2: wall lines and gates placed
  // `at` an endpoint, open before routing
  const K = k1Parts.length ? {
    env, ctx, r, plan: P.plan, V, order, byId, k1Parts, geom, res, zoneEmit, lotZone, answers, ans, depState, okClass, timeUp, stageOf, notes, partOf,
    checkpoint: () => checkpoint(r), rollback: (c) => rollback(r, c), addedSince: (c) => addedSince(r, c), mark, endpointNode: (e, other, conn, where) => endpointNode(env, e, other, geom, zoneEmit, lotZone, r, conn, where),
    record: {}, routed: [],
  } : null;
  if (K) planWalls(K);

  // ---- 4. connectors: legs, one route pass per grade limit (a dry run, then only the connectors whose every leg routed)
  // ((7a K1) a wall or gate is answered by its own steps; a rope_bridge or auto connector routes here with its leg options)
  const conns = order.filter((p) => p.family === 'connector' && !answers.has(p.id) && !WALL_KINDS.includes(p.kind));
  const legs = []; // {conn, k, from, to, width, movers, grade}
  const connNotes = new Map(); // conn id -> notes
  for (const p of conns) {
    const dep = depState(p);
    if (dep) { ans(p, dep); continue; }
    if (timeUp()) { ans(p, budgetHit('maxMs')); continue; }
    if (ROPE_KINDS.includes(p.kind)) { const stop = ropeResolve(K, p); if (stop) { ans(p, stop); continue; } }
    const ends = [p.part.from, ...(p.part.via ?? []), p.part.to];
    const pts = [];
    let err = null;
    for (let k = 0; k < ends.length && !err; k++) {
      const other = ends[k === ends.length - 1 ? k - 1 : k + 1];
      const e = endpointNode(env, ends[k], other, geom, zoneEmit, lotZone, r, p, `${k === 0 ? 'from' : k === ends.length - 1 ? 'to' : `via[${k - 1}]`}`);
      if (e.error) err = e.error; else pts.push(e);
    }
    const snapNotes = pts.filter((q) => q.snapped).map((q) => `anchor ${q.snapped.anchor} lies inside zone ${q.snapped.zone}: the route ends at the zone's street end`);
    if (err) { ans(p, { class: 'refused', reasons: [err] }); continue; }
    const tGrade = tolOf(p.part, 'grade');
    const grade = Math.max(1 / 64, Math.min(1, q64(tGrade.max)));
    if (snapNotes.length) connNotes.set(p.id, snapNotes);
    const k1 = ROPE_KINDS.includes(p.kind) ? ropeLeg(K, p) : null;
    for (let k = 0; k + 1 < pts.length; k++) legs.push({ conn: p, k, from: pts[k], to: pts[k + 1], width: p.part.width ?? WIDTH_DEFAULT[p.kind] ?? 3, movers: p.part.movers, grade, ...(k1 ? { k1 } : {}) });
  }
  // maxEdges: legs past the cap (in order) are incomplete
  const capped = new Set();
  legs.forEach((l, i) => { if (i >= env.budget.maxEdges) capped.add(l.conn.id); });
  const connOk = new Map(); // conn id -> leg results
  const live = legs.filter((l) => !capped.has(l.conn.id));
  for (const id of capped) ans(byId.get(id), budgetHit('maxEdges'));
  const grades = [...new Set(live.map((l) => l.grade))].sort((a, b) => a - b);
  for (const g of grades) {
    let group = live.filter((l) => l.grade === g && !answers.has(l.conn.id));
    for (let round = 0; round < 3 && group.length; round++) {
      if (timeUp()) { for (const l of group) if (!answers.has(l.conn.id)) ans(l.conn, budgetHit('maxMs')); group = []; break; }
      const cp = checkpoint(r);
      const part = `routes_${grades.indexOf(g)}`;
      const edges = group.map((l, i) => ({ id: `c${conns.indexOf(l.conn)}l${l.k}`, from: l.from.name, to: l.to.name, width: l.width, ...(l.movers ? { movers: l.movers } : {}), ...(l.k1 ?? {}), _i: i }));
      const nodes = {};
      for (const l of group) for (const e of [l.from, l.to]) if (e.node) nodes[e.name] = e.node;
      let out;
      try {
        // every protected area and other owner's region meeting the claim is keep-out for the routes (nothing is written there), plus avoid[]
        const ko = [...env.protectedAreas.map((a) => rectArr(a.rect)), ...env.regions.map((a) => rectArr(a.rect)), ...env.buildRects.map((a) => rectArr(a.rect)), ...avoidRects(env, group, geom)];
        // (7a K1) the walls (the gate move) and the rope move's inputs, only when the plan has them (else T2's pass, byte for byte)
        const walls = K ? wallsPassInput(K) : null, rope = K ? ropePassInput(K) : null;
        out = r.pass('route', { nodes, edges: edges.map(({ _i, ...e }) => e), maxGrade: g, stage: stageOf('routes'), part, maxExpanded: env.budget.maxNodes, lanterns: true, ...(ko.length ? { keepOut: ko } : {}), ...(env.buildRects.length ? { clearTrees: env.buildRects.map((a) => rectArr(a.rect)) } : {}), ...(env.standingHard.length || rope?.hard?.length ? { hard: [...env.standingHard, ...(rope?.hard ?? [])] } : {}), ...(rope?.base ? { base: rope.base } : {}), ...(walls ? { walls } : {}), ...(rope ? { rope } : {}) });
      } catch (e) {
        rollback(r, cp);
        for (const l of group) if (!answers.has(l.conn.id)) ans(l.conn, { class: 'refused', reasons: [{ code: /KEEP_OUT/.test(e.message) ? 'KEEP_OUT' : 'UNREACHABLE', message: e.message }] });
        group = [];
        break;
      }
      const byEdge = new Map(out.edges.map((e) => [e.id, e]));
      const metaEdges = new Map((r.meta.route?.edges ?? []).map((e) => [e.id, e]));
      const bad = new Set();
      for (let i = 0; i < group.length; i++) { const e = byEdge.get(edges[i].id); if (!e?.ok) bad.add(group[i].conn.id); }
      if (!bad.size) {
        // (7a K1) the routed edges (their gates opened, their rope spans) for the gate steps and the links stage
        if (K) { for (let i = 0; i < group.length; i++) K.routed.push({ conn: group[i].conn, leg: group[i], edge: byEdge.get(edges[i].id), meta: metaEdges.get(edges[i].id), part }); wallsRouted(K, out.data.edges); }
        for (let i = 0; i < group.length; i++) {
          const l = group[i], m = metaEdges.get(edges[i].id);
          if (!connOk.has(l.conn.id)) connOk.set(l.conn.id, []);
          connOk.get(l.conn.id).push({ leg: l, meta: m, edge: edges[i].id });
        }
        // (D1) a leg ending on a standing region: the external graph edge to its port (7a types it, S-D-2)
        for (const l of group) for (const en of [l.from, l.to]) {
          if (!en.external) continue;
          const n = r.graph.nodes.find((x) => x.id === en.name);
          const id = `x_${en.name}`.slice(0, 64);
          if (n && !r.graphIds.has(id)) r.graphEdge({ id, from: `${n.id}.${n.ports[0].name}`, to: `${en.external.region}:${en.external.node}.${en.external.port}`, type: 'road', width: l.width, path: part, stage: stageOf('routes'), external: true });
        }
        // a route pass's part is shared by its connectors (their legs' cells are told apart in finish.mjs by the edge's roads and paths)
        for (const x of r.parts.slice(cp.parts)) partOf[x.id] = `routes:${group.map((l) => l.conn.id).filter((v, i, a) => a.indexOf(v) === i).join(',')}`;
        // each leg's roads, paths and graph edge are its connector's (route_<edge>, route_<edge>_<n>)
        const ad = addedSince(r, cp);
        for (let i = 0; i < group.length; i++) {
          const pre = `route_${edges[i].id}`;
          for (const id of [...ad.roads.map((x) => `road:${x}`), ...ad.paths.map((x) => `path:${x}`), ...ad.edges.map((x) => `edge:${x}`)]) if (id.slice(id.indexOf(':') + 1) === pre || id.slice(id.indexOf(':') + 1).startsWith(`${pre}_`)) partOf[id] = group[i].conn.id;
        }
        group = [];
        break;
      }
      // a connector with a failed leg is answered and its other legs dropped; route the rest again
      rollback(r, cp);
      for (let i = 0; i < group.length; i++) {
        const l = group[i];
        if (!bad.has(l.conn.id) || answers.has(l.conn.id)) continue;
        const e = byEdge.get(edges[i].id);
        if (e && e.ok) continue;
        const m = metaEdges.get(edges[i].id);
        const why = m?.failed ?? e?.failed ?? 'NO_ROUTE';
        // ((7a K1b) a rope_bridge leg the route pass could not span answers its typed reason: NO_GAP, SPAN, ...)
        ans(l.conn, why === 'ROPE' && K ? ropeFailAnswer(K, l, m) : why === 'BUDGET' ? budgetHit('maxNodes') : why === 'ROUTE_WATER'
          ? { class: 'refused', reasons: [{ code: 'WATER', message: `leg ${l.k + 1}: every route crosses water`, until: 'T3', evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at } }] }
          : { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `leg ${l.k + 1}: no route within the grade (${g}), the cut and fill limits and the obstacles`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, grade: g } }] });
      }
      group = group.filter((l) => !bad.has(l.conn.id));
    }
  }
  for (const p of conns) {
    if (answers.has(p.id)) continue;
    const ls = connOk.get(p.id) ?? [];
    if (!ls.length) { ans(p, { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: 'no leg routed' }] }); continue; }
    const tDet = tolOf(p.part, 'detour');
    let worst = 0;
    const legsOut = ls.map(({ leg, meta, edge }) => {
      const a = leg.from.at, b = leg.to.at;
      const straight = Math.max(1, Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]));
      const det = q64((meta.length - 1) / straight);
      worst = Math.max(worst, det);
      return { edge, from: a, to: b, length: meta.length, rise: meta.rise, detour: det, segments: meta.segments.length, path: corners(meta.path) };
    });
    // detour is a ratio (1 = straight): a deviation only past the asked max
    const dv = worst > tDet.max ? [{ what: 'detour', value: worst, max: tDet.max, exceeds: true }] : [];
    const klass = worst > tDet.ceiling ? 'refused' : dv.length ? 'adjusted' : 'fits';
    geom.set(p.id, { legs: legsOut });
    const base = { class: klass, deviations: dv, geometry: { legs: legsOut }, notes: connNotes.get(p.id), reasons: klass === 'refused' ? [{ code: 'TOLERANCE', message: `detour ${worst} is past its ceiling ${tDet.ceiling}`, evidence: { detour: worst } }] : [], ...(p.kind === 'street' && p.part.lamps === undefined ? {} : {}) };
    // (7a K1) a rope_bridge or auto connector's own answer fields (its spans, notes, refusals) over the route's
    const extra = ROPE_KINDS.includes(p.kind) ? ropeAnswer(K, p, ls) : null;
    ans(p, extra ? { ...base, ...extra } : base);
  }

  // ---- (7a K1) step 4: gates by crossing, auto gates and gates.min; step 5: the links stage (walls and gates, rope spans), each
  // part under a checkpoint
  if (K) {
    finishGates(K);
    emitWalls(K);
    emitRopes(K);
  }

  // ---- 5. apron lamps over every village lot; anchors
  if (villages && !whole) {
    const anyBell = [...zoneEmit.values()][0].L.res.bell;
    r.anchor('entrance', anyBell); r.anchor('spawn', anyBell);
    const cp = checkpoint(r);
    try {
      const cover = lightCover(r, { fixture: lampFixture(r), stage: stageOf('props'), keepOut: ctx.keepOut ?? [], reserved, laneCells });
      if (r.meta.village) r.meta.village.apronLamps = { fixture: cover.fixture, perLot: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped };
      for (const x of r.parts.slice(cp.parts)) partOf[x.id] = '__lamps__';
    } catch (e) { rollback(r, cp); notes.push(`apron lamps: ${e.message}`); }
  }
  if (!r.anchors.entrance) stubAnchors(r, env);

  // ---- 6. geometry into the answers (zones: rect, lots, street ends; forms: bounds)
  for (const p of V.parts) {
    const a = answers.get(p.id);
    if (!a || !['fits', 'adjusted'].includes(a.class)) continue;
    if (p.family === 'zone') {
      const z = res.get(p.id), e = zoneEmit.get(p.id);
      if (e?.districts) {
        const d = e.districts.data;
        const lots = e.L.lots.map((l) => ({ id: l.spec.id, box: [l.lot.box.minX, l.lot.box.minY, l.lot.box.minZ, l.lot.box.maxX, l.lot.box.maxY, l.lot.box.maxZ], entrance: l.lot.entrance, front: l.lot.front, size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1] }));
        a.geometry = { rect: rectArr(z.rect), districts: Object.fromEntries(Object.entries(d.rects).map(([id, q]) => [id, { rect: q, band: d.bandOf[id].got, bell: d.bells[id], lots: d.lots[id], unplaced: d.unplacedLots[id] }])), unplaced: d.unplaced.map((u) => u.id), edges: d.edges.map((x) => ({ id: x.id, a: x.a, b: x.b, kind: x.kind, ok: x.ok })), treeCost: d.treeCost, loopCost: d.loopCost, lots,
          ...(d.follow ? { follow: Object.fromEntries(Object.entries(d.follow).map(([id, f]) => [id, { kind: f.kind, side: f.side, rect: f.rect, mask: f.mask, boundary: f.boundary, street: corners(f.street) }])) } : {}),
          ...(d.corridor ? { corridor: Object.fromEntries(Object.entries(d.corridor).map(([id, c]) => [id, { runs: c.runs, cells: c.cells }])) } : {}), ...(d.join && !d.join.region ? { join: d.join } : {}) };
        const entries = new Map(zoneLots(p.part).map((l) => [l.id, l.lot?.entry ?? null]));
        a.provisional = styleOf(P.plan, p.part)?.pending !== undefined || lots.some((l) => !entries.get(l.id));
        continue;
      }
      const lots = e ? e.L.lots.map((l) => ({ id: l.spec.id, box: [l.lot.box.minX, l.lot.box.minY, l.lot.box.minZ, l.lot.box.maxX, l.lot.box.maxY, l.lot.box.maxZ], entrance: l.lot.entrance, front: l.lot.front, size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1] }))
        : r.lots.map((l) => ({ id: l.id, box: [l.box.minX, l.box.minY, l.box.minZ, l.box.maxX, l.box.maxY, l.box.maxZ], entrance: r.meta.lots[l.id]?.entrance, front: l.front }));
      a.geometry = { rect: rectArr(z.rect), ...(e ? { bell: e.L.res.bell, shared: e.L.shared?.kind, orientation: e.L.orientation, unplaced: e.L.unplaced.map((u) => u.id) } : { whole: true }), lots };
      const entries = new Map(zoneLots(p.part).map((l) => [l.id, l.lot?.entry ?? null]));
      const pend = styleOf(P.plan, p.part)?.pending !== undefined;
      a.provisional = pend || lots.some((l) => !entries.get(l.id));
    } else if (p.family === 'form' && geom.get(p.id)?.rect) a.geometry = { rect: rectArr(geom.get(p.id).rect), ...(res.get(p.id)?.sites ? { sites: res.get(p.id).sites } : {}) };
    else if (p.family === 'form' && p.kind === 'relief') a.geometry = { around: res.get(p.id).zones };
  }
  const hit = env.hitTime ? 'maxMs' : null;
  return { region: r, record: {
    ...record, malformed: null, answers: V.parts.map((p) => answers.get(p.id)).filter(Boolean), order: V.order, partOf, notes, hit,
    zones: Object.fromEntries([...zoneEmit.entries()].map(([id, e]) => [id, { prefix: e.prefix }])),
    lotZone: Object.fromEntries(lotZone), lotMeta: Object.fromEntries(V.parts.filter((p) => p.family === 'zone').flatMap((p) => zoneLots(p.part).map((l) => [l.id, { role: l.lot?.role ?? null, label: l.lot?.label ?? null, ext: l.lot?.ext ?? null }]))), lotEntries: Object.fromEntries(V.parts.filter((p) => p.family === 'zone').flatMap((p) => zoneLots(p.part).map((l) => [l.id, l.lot?.entry ?? null]))),
    styles: Object.fromEntries(V.parts.filter((p) => p.family === 'zone' || p.family === 'connector').map((p) => [p.id, styleOf(P.plan, p.part) ?? null])),
    cacheOut: hit ? {} : env.cacheOut, protectedRects: env.protectedAreas.map((a) => rectArr(a.rect)),
    ...(K ? { links: K.record } : {}),
    anchors: Object.fromEntries([...env.anchors.entries()].map(([k, v]) => [k, [v[0], env.S.groundAt(v[0], v[1]) + 1, v[1]]])),
  } };
}

/** A part's style: its own, else its zone's, else the plan's. */
function styleOf(plan, part) {
  return part.style ?? plan.style ?? undefined;
}

/** The legs' avoid rects (`avoid[]` features: parts and protected areas as keep-out for the route). */
function avoidRects(env, group, geom) {
  const out = [];
  for (const l of group) for (const f of l.conn.part.avoid ?? []) {
    if (f.part && geom.get(f.part)?.rect) out.push(rectArr(geom.get(f.part).rect));
    if (f.protected) { const a = env.protectedAreas.find((p) => p.id === f.protected); if (a) out.push(rectArr(a.rect)); }
  }
  const seen = new Set();
  return out.filter((q) => { const k = q.join(); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

/** A polyline's corners (the first and last cell, and every cell where the step changes). */
function corners(path) {
  if (path.length <= 2) return path.map((p) => [...p]);
  const out = [path[0]];
  for (let i = 1; i + 1 < path.length; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[2] - a[2] !== c[2] - b[2] || b[1] - a[1] !== c[1] - b[1]) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out.map((p) => [...p]);
}

/** The template's param values (its declared params resolved; the zone's lots param dropped when the template has none). */
function templateParams(mod, given) {
  const out = {};
  for (const [k, d] of Object.entries(mod.params ?? {})) out[k] = given[k] !== undefined ? given[k] : d.default;
  return out;
}

/** The entrance and spawn anchors at the claim's centre (a plan with no zone emitted). */
function stubAnchors(r, env) {
  const [cx, cz] = centre(env.claim);
  r.anchor('entrance', [cx, env.S.groundAt(cx, cz) + 1, cz]);
  r.anchor('spawn', [cx, env.S.groundAt(cx, cz) + 1, cz]);
}

/**
 * A route end for an endpoint: `{name, at, node?}` (a node in the pass's `nodes`, or a lot / graph id), or `{error}`.
 * `other`: the leg's other endpoint (a zone's default port is its street end nearer to it).
 */
function endpointNode(env, e, other, geom, zoneEmit, lotZone, r, conn, where) {
  const S = env.S;
  const feet = (x, z, name, facing = null) => ({ name, at: [x, S.groundAt(x, z) + 1, z], node: { at: [x, S.groundAt(x, z) + 1, z], kind: 'junction', ...(facing ? { facing } : {}) } });
  const posOf = (q) => {
    if (!q) return centre(env.claim);
    if (q.anchor) return env.anchors.get(q.anchor);
    if (q.build !== undefined) { const b = env.buildRects.find((x) => x.id === q.build); if (b) return centre(b.rect); }
    if (q.part && geom.get(q.part)?.rect) return centre(geom.get(q.part).rect);
    if (q.part && lotZone.has(q.part)) { const z = zoneEmit.get(lotZone.get(q.part)); const l = z?.L.lots.find((x) => x.spec.id === q.part); if (l) return [l.lot.entrance[0], l.lot.entrance[2]]; }
    return centre(env.claim);
  };
  const tag = `${conn.id}:${where}`.replace(/[^a-z0-9_]/g, '_');
  if (e.anchor) {
    const p = env.anchors.get(e.anchor);
    // an anchor inside a zone laid out over it (Steward's stone under the town): the route ends at that zone's street end
    // (not when the leg's other end is that zone or one of its lots: the route then runs inside the zone, from the anchor itself)
    const sameZone = (zid) => other?.part !== undefined && (other.part === zid || lotZone.get(other.part) === zid);
    for (const [zid] of zoneEmit) {
      const g = geom.get(zid)?.rect;
      if (g && !sameZone(zid) && p[0] >= g.minX && p[0] <= g.maxX && p[1] >= g.minZ && p[1] <= g.maxZ) return { ...endpointNode(env, { part: zid }, other, geom, zoneEmit, lotZone, r, conn, where), snapped: { anchor: e.anchor, zone: zid } };
    }
    return feet(p[0], p[1], `a_${tag}`);
  }
  const lotNode = (id) => (r.lots.some((l) => l.id === id) ? { name: id } : null);
  if (e.part !== undefined) {
    if (lotZone.has(e.part)) {
      const n = lotNode(e.part);
      return n ? { ...n, at: r.meta.lots[e.part].entrance } : { error: { code: 'NO_ROOM', message: `lot ${e.part} was not placed (unplaced in its zone)`, path: where } };
    }
    const g = geom.get(e.part);
    const z = zoneEmit.get(e.part);
    if (z?.districts) {
      // (D1) a districts zone: the named district (port), else the district nearest the other end; its street end nearest that end
      const out = z.districts, op = posOf(other);
      const port = e.port ?? null;
      const ids = Object.keys(out.ends);
      if (port && !ZONE_PORTS.includes(port) && !ids.includes(port)) { const n = lotNode(port); return n ? { ...n, at: r.meta.lots[port].entrance } : { error: { code: 'NO_ROOM', message: `port ${port}: not placed (unplaced in its zone)`, path: where } }; }
      const d0 = Object.keys(out.data.bells)[0];
      if (port === 'bell') { const b = out.data.bells[d0]; return feet(b[0], b[2], `b_${tag}`); }
      const dist = (q) => Math.max(Math.abs(q[0] - op[0]), Math.abs(q[1] - op[1]));
      const did = ids.includes(port ?? '') ? port : port === 'start' || port === 'end' ? d0 : [...ids].sort((p1, p2) => dist([out.data.bells[p1][0], out.data.bells[p1][2]]) - dist([out.data.bells[p2][0], out.data.bells[p2][2]]) || cmp(p1, p2))[0];
      if (!out.ends[did]) return { error: { code: 'NO_ROOM', message: `district ${port} was not placed`, path: where } };
      const en = out.ends[did];
      const pick = port === 'start' ? en[0] : port === 'end' ? en[1] : dist([en[1].x, en[1].z]) < dist([en[0].x, en[0].z]) ? en[1] : en[0];
      return feet(pick.x, pick.z, `s_${tag}`, pick.facing);
    }
    if (z) {
      const port = e.port ?? null;
      if (port && !ZONE_PORTS.includes(port)) { const n = lotNode(port); return n ? { ...n, at: r.meta.lots[port].entrance } : { error: { code: 'NO_ROOM', message: `port ${port}: the lot was not placed`, path: where } }; }
      if (port === 'bell') return feet(z.L.res.bell[0], z.L.res.bell[2], `b_${tag}`);
      // the street's ends: the cell past each end along the street axis
      const o = z.L.orientation, sv = z.L.road.sv;
      const ends = [[z.L.u0 - 1, -1], [z.L.u1 + 1, 1]].map(([u, s]) => { const [x, zz] = toWorld(o, u, sv); return { x, z: zz, facing: o === 'ew' ? [s, 0] : [0, s] }; });
      let pick;
      if (port === 'start') pick = ends[0]; else if (port === 'end') pick = ends[1];
      else { const op = posOf(other); const d = (q) => Math.max(Math.abs(q.x - op[0]), Math.abs(q.z - op[1])); pick = d(ends[1]) < d(ends[0]) ? ends[1] : ends[0]; }
      return feet(pick.x, pick.z, `s_${tag}`, pick.facing);
    }
    if (g?.entrance) return feet(g.entrance[0], g.entrance[2], `w_${tag}`);
    if (g?.rect) {
      // a form: the dry column just outside its rect nearest the other end
      const op = posOf(other), a = grow(g.rect, 2);
      const x = Math.max(a.minX, Math.min(a.maxX, op[0])), z = Math.max(a.minZ, Math.min(a.maxZ, op[1]));
      const px = x === a.minX || x === a.maxX ? x : op[0] < a.minX ? a.minX : op[0] > a.maxX ? a.maxX : (op[1] < a.minZ || op[1] > a.maxZ ? x : a.minX);
      const pz = z === a.minZ || z === a.maxZ ? z : op[1] < a.minZ ? a.minZ : op[1] > a.maxZ ? a.maxZ : z;
      return feet(px, pz, `f_${tag}`);
    }
    return { error: { code: 'NO_FEATURE', message: `${e.part} is not a place a route can end at in v0 (a connector's end)`, path: where } };
  }
  if (e.region !== undefined) {
    // (D1) endpoint.region: the cell past a standing region's street end inside the claim (its port: the street end's node id)
    const st = env.standing.find((a) => a.id === e.region);
    if (!st) return { error: { code: 'NO_FEATURE', message: `region ${e.region} is not a standing region of this owner beside the claim`, path: where } };
    const c = env.claim;
    const ports = besidePorts(st).filter((q) => q.end[0] >= c.minX && q.end[0] <= c.maxX && q.end[1] >= c.minZ && q.end[1] <= c.maxZ && (!e.port || q.node === e.port));
    if (!ports.length) return { error: { code: 'NO_FEATURE', message: `region ${e.region} has no street end${e.port ? ` ${e.port}` : ''} inside the claim (the seam must hold the cell past it)`, path: where } };
    const op = posOf(other);
    const q = [...ports].sort((a, b) => Math.max(Math.abs(a.end[0] - op[0]), Math.abs(a.end[1] - op[1])) - Math.max(Math.abs(b.end[0] - op[0]), Math.abs(b.end[1] - op[1])) || cmp(a.node, b.node))[0];
    return { ...feet(q.end[0], q.end[1], `r_${tag}`, q.dir), external: { region: st.id, node: q.node, port: q.port } };
  }
  if (e.build !== undefined) {
    // 6c PT endpoint.build: the road ends on the door's apron (its outer cell, outside the footprint)
    const q = buildEndpoint(env.builds, e.build, e.port ?? 'door');
    if (q.none) return { error: { code: 'NO_FEATURE', message: q.none, path: where } };
    return feet(q.end[0], q.end[2], `d_${tag}`);
  }
  if (e.feature) {
    const f = featureGeom(env, e.feature, (id) => geom.get(id) ?? null, posOf(other));
    if (f.error) return { error: { ...f.error, path: where } };
    if (f.body) {
      // a dry column 3 from the water (the route keeps one column off water, plus its half width), nearest the other end
      const op = posOf(other);
      const { cols, r: rr, W } = env, Dd = env.D;
      const dist = new Map();
      let front = [...f.body.cells];
      for (const k of front) dist.set(k, 0);
      for (let d = 1; d <= 3; d++) {
        const next = [];
        for (const k of front) {
          const i = k % W, j = (k - i) / W;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= W || b >= Dd) continue;
            const t = a + b * W;
            if (dist.has(t)) continue;
            dist.set(t, d); next.push(t);
          }
        }
        front = next;
      }
      let best = null;
      for (const t of front) {
        if (cols.flags[t] & (FLAG_WATER | FLAG_LAVA | FLAG_FROZEN)) continue;
        const i = t % W, j = (t - i) / W, x = cols.minX + i * rr, z = cols.minZ + j * rr;
        if (x < env.claim.minX + 4 || x > env.claim.maxX - 4 || z < env.claim.minZ + 4 || z > env.claim.maxZ - 4) continue;
        const d = Math.max(Math.abs(x - op[0]), Math.abs(z - op[1]));
        if (!best || d < best.d || (d === best.d && (x < best.x || (x === best.x && z < best.z)))) best = { x, z, d };
      }
      if (!best) return { error: { code: 'NO_FEATURE', message: 'no dry column beside the water', path: where } };
      return feet(best.x, best.z, `w_${tag}`);
    }
    const a = grow(f.rect, 2), op = posOf(other);
    const x = Math.max(a.minX, Math.min(a.maxX, op[0])), z = Math.max(a.minZ, Math.min(a.maxZ, op[1]));
    return feet(x, z, `p_${tag}`);
  }
  return { error: { code: 'NO_FEATURE', message: `endpoint ${Object.keys(e)[0]} is not compiled in v0`, path: where } };
}

// ------------------------------------------------------------------ the cache (§7)

/** A part's cache key: kit and catalogue versions, its canonical JSON, its dependencies' geometry, the survey, protection, anchors, bible. */
export function cacheKey(env, p, geom) {
  const deps = p.deps.map((d) => [d, geom.get(d)?.rect ? rectArr(geom.get(d).rect) : null]);
  return sha256Hex(canonicalJson({ kit: KIT_VERSION, cat: CATALOGUE_VERSION, part: p.part, deps, survey: env.surveySha, prot: env.fingerprint, anchors: env.anchorsGiven, bible: env.bible, claim: rectArr(env.claim),
    // (6c PT) the builds a part sees (absent when none, so pre-PT keys are unchanged)
    ...(env.builds.length ? { builds: env.builds.map((b) => [b.id, b.revision ?? 0, b.state, ...b.bounds]) } : {}) }));
}
function cacheEntry(z) {
  return { rect: rectArr(z.rect), klass: z.klass, deviations: z.deviations ?? [], reasons: z.reasons ?? [], wouldFit: z.wouldFit ?? null, notes: z.notes ?? [] };
}
/** A cached zone: its rect and answer, its layout evaluated again in the rect (deterministic: equal to a cold check's). */
function rehydrateZone(env, p, hit) {
  const zone = p.part;
  if (zone.program.template !== undefined && zone.program.template !== 'flat_village') return null;
  const specs = lotSpecs(zone), shared = sharedOf(zone), rect = arrRect(hit.rect);
  const L = layoutStreet({ claim: { ...env.claim, ...rect }, survey: env.S, specs, rules: STREET_RULES, shared, keepOut: env.ctx.keepOut ?? [] });
  if (L.fail) return null;
  return { klass: hit.klass, rect, layout: L, specs, shared, deviations: hit.deviations, reasons: hit.reasons, wouldFit: hit.wouldFit ?? undefined, notes: hit.notes, unplaced: L.unplaced };
}

/** Drop undefined members. */
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}
void cmp; void entryOf;
