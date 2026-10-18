// (6c H-a) The water bodies' shared helpers (docs/CONTRACT.md "Phase 6c slice H" §5, §7, §11, §12): placing a rect from a part's
// locator over the plan survey, the bible's `fluids` roles, the freezing rule, the answers' cost and volume shapes, and the undo of a
// body that was refused after r.fluidBody wrote it. Slice H-a owns this file. It imports neither compile.mjs nor program.mjs (the
// generators are dispatched from compile.mjs through hooks.mjs), so the locator here mirrors compile.mjs's (locatorOf, featureGeom,
// scan) over the same `env`: the same targets, the same lattice, the same score (move first, then the sketch, roughness, water share,
// distance from the aim; ties in scan order).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_WATER } from '../region/pack.mjs';
import { isFluidStopping, isGravity } from '../blocks.mjs';
import { bomOf } from '../connectors/bom.mjs';
import { freezesAt as freezesTable } from './biomes.mjs';

/** The claim margin no H part writes in (compile.mjs's MARGIN). */
export const MARGIN = 2;
/** compile.mjs's size presets (a pond's `size.preset`). */
export const PRESET_SIZES = Object.freeze({ S: 32, M: 48, L: 64, XL: 96 });

const isInt = Number.isInteger;
export const rectOf = (x0, z0, w, d) => ({ minX: x0, minZ: z0, maxX: x0 + w - 1, maxZ: z0 + d - 1 });
export const grow = (a, n) => ({ minX: a.minX - n, minZ: a.minZ - n, maxX: a.maxX + n, maxZ: a.maxZ + n });
export const meets = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
export const inside = (a, b) => a.minX >= b.minX && a.maxX <= b.maxX && a.minZ >= b.minZ && a.maxZ <= b.maxZ;
export const rectArr = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
export const arrRect = (q) => ({ minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] });
export const centre = (a) => [(a.minX + a.maxX) >> 1, (a.minZ + a.maxZ) >> 1];
/** Chebyshev gap between two rects (0 when they meet). */
export function gap(a, b) {
  const dx = Math.max(0, b.minX - a.maxX, a.minX - b.maxX), dz = Math.max(0, b.minZ - a.maxZ, a.minZ - b.maxZ);
  return Math.max(dx, dz);
}

// ------------------------------------------------------------------ the survey over a rect

/** Every survey column of a rect (clipped to the claim): {minG, maxG, water, lava, frozen, n}. */
export function rectSurvey(env, a) {
  const S = env.S, c = env.claim;
  let minG = Infinity, maxG = -Infinity, water = 0, lava = 0, frozen = 0, n = 0;
  for (let x = Math.max(c.minX, a.minX); x <= Math.min(c.maxX, a.maxX); x++) for (let z = Math.max(c.minZ, a.minZ); z <= Math.min(c.maxZ, a.maxZ); z++) {
    const g = S.groundAt(x, z), f = flagsAt(env, x, z);
    n++;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (f & FLAG_WATER) water++;
    if (f & FLAG_LAVA) lava++;
    if (f & FLAG_FROZEN) frozen++;
  }
  return { minG, maxG, water, lava, frozen, n };
}

/** The survey flags of the column nearest (x, z). */
export function flagsAt(env, x, z) {
  const c = env.cols, r = c.resolution;
  let i = Math.floor((x - c.minX + (r >> 1)) / r), j = Math.floor((z - c.minZ + (r >> 1)) / r);
  if (i < 0) i = 0; else if (i >= c.width) i = c.width - 1;
  if (j < 0) j = 0; else if (j >= c.depth) j = c.depth - 1;
  return c.flags[i + j * c.width];
}

/** Whether the claim has any surface water (M24's waterInClaim: frozen water counts as dry, W). */
export function waterInClaim(env) {
  const f = env.cols.flags;
  for (let k = 0; k < f.length; k++) if ((f[k] & FLAG_WATER) && !(f[k] & FLAG_FROZEN)) return true;
  return false;
}

// ------------------------------------------------------------------ the locator (compile.mjs's, over the same env)

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

/** compile.mjs featureGeom: {rect, aim, avoid, body?} or {error}. */
export function featureOf(env, f, geomOf, from = null) {
  if (f.part !== undefined) {
    const t = geomOf(f.part);
    if (!t) return { error: { code: 'NO_FEATURE', message: `${f.part} has no geometry in v0`, evidence: { feature: { part: f.part } } } };
    return { rect: t.rect, aim: centre(t.rect), avoid: t.rect };
  }
  if (f.protected !== undefined) {
    const a = env.protectedAreas.find((p) => p.id === f.protected);
    if (!a) return { error: { code: 'NO_FEATURE', message: `no protected area "${f.protected}" meets the claim`, evidence: { feature: { protected: f.protected } } } };
    return { rect: a.rect, aim: centre(a.rect), avoid: a.rect };
  }
  if (f.build !== undefined) {
    const b = env.buildRects.find((x) => x.id === f.build) ?? env.buildRects.find((x) => env.builds.find((q) => q.id === x.id && String(q.kind).toLowerCase() === String(f.build).toLowerCase()));
    if (!b) return { error: { code: 'NO_FEATURE', message: `no build ${f.build} in the claim`, evidence: { feature: { build: f.build } } } };
    return { rect: b.rect, aim: centre(b.rect), avoid: grow(b.rect, 1) };
  }
  if (f.water !== undefined) {
    const w = f.water ?? {};
    const body = w.body ?? 'any', minArea = w.minArea ?? 1;
    const to = w.to ? env.anchors.get(w.to) : from ?? centre(env.claim);
    const cands = env.water.bodies.filter((b) => (body === 'any' || b.kind === body) && b.area >= minArea);
    if (!cands.length) return { error: { code: 'NO_FEATURE', message: `no ${body === 'any' ? '' : `${body} `}water of at least ${minArea} columns in the claim`, evidence: { feature: { water: w }, bodies: env.water.bodies.map((b) => ({ kind: b.kind, area: b.area })) } } };
    const near = (b) => nearestCell(env, b, to);
    const cc = centre(env.claim);
    const key = (b) => (w.pick === 'nearest' ? [near(b).d, 0] : [-b.area, nearestCell(env, b, cc).d]);
    cands.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || a.bbox.minX - b.bbox.minX || a.bbox.minZ - b.bbox.minZ; });
    const pick = cands[0];
    const n = near(pick);
    return { rect: pick.bbox, aim: [n.x, n.z], avoid: null, body: pick };
  }
  return { error: { code: 'NO_FEATURE', message: `feature ${Object.keys(f)[0]} is not compiled in v0` } };
}

/**
 * compile.mjs locatorOf: `{valid(rect), move(rect), aim, areaFor(w, d, maxMove), target?, body?}` or `{error}`. `within0`: the
 * default `near.within`.
 */
export function locatorOf(env, where, geomOf, { within0 = 32 } = {}) {
  const anyOk = () => true;
  if (!where) return { valid: anyOk, move: () => 0, aim: centre(env.claim) };
  const lk = Object.keys(where)[0], b = where[lk];
  const targetOf = (t) => (t?.build !== undefined ? (env.buildRects.find((x) => x.id === t.build) ?? null) : geomOf(t?.part));
  if (lk === 'inside') {
    if (b.claim) return { valid: anyOk, move: () => 0, aim: centre(env.claim) };
    const t = targetOf(b);
    if (!t) return { error: { code: b.build !== undefined ? 'NO_FEATURE' : 'DEPENDENCY', message: b.build !== undefined ? `no build ${b.build} in the claim` : `${b.part} has no geometry` } };
    return { valid: (a) => inside(a, t.rect), move: () => 0, aim: centre(t.rect), areaFor: () => t.rect };
  }
  if (lk === 'near') {
    const W = isInt(b.within) ? b.within : within0;
    let target, aim, avoid = null, body = null;
    if (b.anchor) {
      const p = env.anchors.get(b.anchor);
      target = { minX: p[0], minZ: p[1], maxX: p[0], maxZ: p[1] };
      aim = p;
    } else {
      const f = featureOf(env, b.feature, geomOf, null);
      if (f.error) return f;
      target = f.rect; aim = f.aim; avoid = f.avoid; body = f.body ?? null;
    }
    return { valid: (a) => !avoid || !meets(a, avoid), move: (a) => Math.max(0, gap(a, target) - W), aim, areaFor: (w, d, mm) => grow(target, W + Math.min(mm, 1024) + Math.max(w, d)), W, target, body };
  }
  if (lk === 'adjacent') {
    const t = targetOf(b.to);
    if (!t) return { error: { code: b.to.build !== undefined ? 'NO_FEATURE' : 'DEPENDENCY', message: b.to.build !== undefined ? `no build ${b.to.build} in the claim` : `${b.to.part} has no geometry` } };
    const T = t.rect;
    const [g0, g1] = Array.isArray(b.gap) ? b.gap : isInt(b.gap) ? [b.gap, b.gap] : [0, 4];
    const side = b.side ?? 'any';
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
    return { valid: (a) => !meets(a, T) && mv(a) < Infinity, move: mv, aim: centre(T), areaFor: (w, d, mm) => grow(T, g1 + Math.min(mm, 1024) + Math.max(w, d)), target: T };
  }
  return { error: { code: 'NO_FEATURE', message: `locator ${lk} is not compiled for this form in v0` } };
}

/** compile.mjs sketchPoint. */
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
 * Scan w x d rects over the locator's area (compile.mjs's lattice and score) for the ones `ok(rect)` accepts, best first, at most
 * `limit`. `keep`: the cells around the rect the body's shell, rim and buffer take (the rect grown by `keep` must stay inside the claim
 * less its margin and clear of env.hard and of `obstacles`).
 */
export function scanRects(env, w, d, loc, { sketch = null, obstacles = [], limit = 16, maxMove = Infinity, keep = 0, ok = () => true, avoid = [], hard: useHard = true } = {}) {
  const c = grow(env.claim, -MARGIN);
  const area = loc.areaFor ? loc.areaFor(w, d, maxMove) : null;
  const A = area ? { minX: Math.max(c.minX, area.minX), minZ: Math.max(c.minZ, area.minZ), maxX: Math.min(c.maxX, area.maxX), maxZ: Math.min(c.maxZ, area.maxZ) } : c;
  const step = Math.max(1, Math.ceil(Math.max(env.claim.maxX - env.claim.minX + 1, env.claim.maxZ - env.claim.minZ + 1) / 256));
  const up = (v, o) => o + Math.ceil((v - o) / step) * step;
  const aim = sketch ?? loc.aim;
  const hard = env.hard;
  const out = [];
  for (let x0 = up(A.minX, c.minX); x0 + w - 1 <= A.maxX; x0 += step) for (let z0 = up(A.minZ, c.minZ); z0 + d - 1 <= A.maxZ; z0 += step) {
    const a = rectOf(x0, z0, w, d);
    const k = grow(a, keep);
    if (!inside(k, c)) continue;
    if (!loc.valid(a)) continue;
    if (obstacles.some((o) => meets(k, o))) continue;
    if (useHard && hard.some((h) => meets(k, h))) continue;
    if (avoid.some(([px, pz, pr]) => px >= k.minX - pr && px <= k.maxX + pr && pz >= k.minZ - pr && pz <= k.maxZ + pr)) continue;
    const move = loc.move(a);
    if (move > maxMove) continue;
    const why = ok(a);
    if (why !== true) continue;
    const [cx, cz] = centre(a);
    const sk = sketch ? Math.max(Math.abs(cx - sketch[0]), Math.abs(cz - sketch[1])) : 0;
    const ad = aim ? Math.max(Math.abs(cx - aim[0]), Math.abs(cz - aim[1])) : 0;
    const st = rectSurvey(env, a);
    const rough = st.maxG - st.minG;
    const score = 4096 * move + 8 * sk + 4 * rough + Math.floor((1000 * st.water) / Math.max(1, st.n)) + ad;
    out.push({ rect: a, move, sketch: sk, score, rough });
  }
  out.sort((p, q) => p.score - q.score);
  return out.slice(0, limit);
}

/** A locator refusal as a resolve answer. */
export function locatorRefusal(part, loc) {
  return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(part.where ?? {})[0] ?? null, ...(loc.error.evidence ?? {}) } }] };
}

/**
 * The points a body keeps clear of: a plan with no zone stands its entrance and spawn anchors on the claim's centre column
 * (compile.mjs stubAnchors), so a body there would spawn players in it: [[x, z, radius]].
 */
export function spawnAvoid(C) {
  if (C.order.some((p) => p.family === 'zone')) return [];
  const [cx, cz] = centre(C.env.claim);
  return [[cx, cz, 2]];
}

/** What the scan must keep clear of (the zones and forms placed before the part, grown by `g`). */
export const takenRects = (C, g = 1) => (C.taken ?? []).map((t) => grow(t, g));

/** A rect meeting a protected area, a build (grown by 1), another owner's region or keep-out: the first one met, or null. */
export function protectedMet(env, a) {
  for (const p of env.protectedAreas) if (meets(a, p.rect)) return { kind: 'protected', id: p.id, rect: rectArr(p.rect) };
  for (const b of env.buildRects) if (meets(a, grow(b.rect, 1))) return { kind: 'build', id: b.id, rect: rectArr(b.rect) };
  for (const g of env.regions) if (meets(a, grow(g.rect, 1))) return { kind: 'region', id: g.id, rect: rectArr(g.rect) };
  for (const k of env.keepOut) if (meets(a, k)) return { kind: 'keep-out', rect: rectArr(k) };
  return null;
}

// ------------------------------------------------------------------ lenient params (§5, S-K1-3)

/**
 * Read a part's `params` leniently (never malformed): `accept` maps a key to `(value) => read value | undefined` (undefined: not
 * readable, noted with `why`), applied only where the part has no first-class member `member` of that name (`as` names it). Keys the
 * part answers with a fixed note (`noted`: key -> note) are listed with it. Returns {read: {member: value}, notes}.
 */
export function readParams(part, accept = {}, { noted = {} } = {}) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const a = accept[key];
    if (a && part[a.as ?? key] === undefined) {
      const v = a.read(P[key]);
      if (v !== undefined) { read[a.as ?? key] = v; continue; }
      notes.push(`params.${key} not read (${a.why ?? 'not a valid value'})`);
      continue;
    }
    if (noted[key]) { notes.push(`params.${key}: ${noted[key]}`); continue; }
    notes.push(`params.${key} not read${a ? ` (the part's own ${a.as ?? key} wins)` : ''}`);
  }
  return { read, notes };
}
export const intIn = (lo, hi) => (v) => (isInt(v) && v >= lo && v <= hi ? v : undefined);

// ------------------------------------------------------------------ the bible's `fluids` roles (§11)

/** The members of the bible's `fluids` (role names), H-a's and H-b's. */
export const FLUID_SLOTS = Object.freeze(['bed', 'rim', 'coping', 'spout', 'quay', 'mooring']);
/** §11's default chains (the first role the plan resolves wins; a shell slot skips a gravity or flow-through block). */
export const FLUID_DEFAULTS = Object.freeze({
  bed: ['subsurface', 'foundation'], rim: ['surface'], coping: ['trim', 'structure'], spout: ['structure'], quay: ['path', 'structure'], mooring: ['frame'],
});
/** The slots that line a body: their block must stop fluid and never fall (§2.2). */
const SHELL_SLOTS = new Set(['bed', 'rim', 'coping', 'spout']);

/** A bible's `fluids` member checked: null when fine, else a message (role names that are roles of the bible). */
export function fluidsError(f, roles = null) {
  if (f === undefined) return null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return `fluids must be an object { ${FLUID_SLOTS.join('?, ')}? }`;
  for (const [k, v] of Object.entries(f)) {
    if (!FLUID_SLOTS.includes(k)) return `fluids: unknown slot '${k}' (one of ${FLUID_SLOTS.join(', ')})`;
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(v)) return `fluids.${k} must be a role name`;
    if (roles && !roles[v]) return `fluids.${k}: '${v}' is not a role of this bible`;
  }
  return null;
}

/** Whether a block may line a body (fluid-stopping, never falling). */
export const linesBody = (b) => typeof b === 'string' && isFluidStopping(b) && !isGravity(b);

/**
 * The role name each slot resolves to, then its block: `{bed: {role, block}, ...}`. `roles`: the plan's resolved roles; `given`: the
 * bible's `fluids` (or null). A slot the bible names wins when the plan resolves that role (and, for a shell slot, its block lines a
 * body); else the first role of its default chain that does; a shell slot with none falls back to `minecraft:stone`.
 */
export function fluidRoles(roles, given = null) {
  const out = {};
  for (const s of FLUID_SLOTS) {
    const okRole = (r) => typeof r === 'string' && roles?.[r] && (!SHELL_SLOTS.has(s) || linesBody(roles[r]));
    const g = given?.[s];
    const role = okRole(g) ? g : FLUID_DEFAULTS[s].find(okRole) ?? null;
    out[s] = { role, block: role ? roles[role] : SHELL_SLOTS.has(s) ? 'minecraft:stone' : null };
  }
  return out;
}

/** A plan's (or program's) fluid roles from its ctx: the bible's member when the plan was given one (ctx.fluids), else the defaults. */
export function fluidRolesOf(ctx) {
  return fluidRoles(ctx.roles, ctx.fluidsGiven ?? null);
}

/** A role's block, or a fallback when it lines a body badly: the foundation, then stone (never a gravity or flow-through block). */
export function shellBlock(roles, role, fallback = 'minecraft:stone') {
  const b = roles?.[role];
  if (linesBody(b)) return b;
  if (linesBody(roles?.foundation)) return roles.foundation;
  return fallback;
}

// ------------------------------------------------------------------ freezing (§1.3, R23)

/** Whether water at the surface y freezes in biome `id`: H-core's generated table (lib/fluids/biomes.mjs, 26.3's shouldFreeze rule). */
export function biomeFreezes(id, y) {
  return freezesTable(id, y);
}

/**
 * Whether open water at (x, y, z) freezes: the plan's biome grid (ctx.biomes, one biome per 4x4 columns; reading it records it in the
 * IR, so only a plan with a body reads it). No grid: false (`known: false`).
 */
export function freezesAt(ctx, x, y, z) {
  const b = ctx.biomes;
  if (!b) return { freezes: false, known: false };
  const i = Math.floor((x - b.minX) / b.res), j = Math.floor((z - b.minZ) / b.res);
  if (i < 0 || j < 0 || i >= b.width || j >= b.depth) return { freezes: false, known: false };
  const k = b.ids[i + j * b.width];
  if (k < 0) return { freezes: false, known: false };
  return { freezes: biomeFreezes(b.palette[k], y), known: true, biome: b.palette[k] };
}

/** Whether every surface cell freezes (R23: a cap where the biome freezes); `any` when some do. */
export function surfaceFreezes(ctx, surface) {
  let n = 0, known = true, biome = null;
  for (const [x, y, z] of surface) {
    const f = freezesAt(ctx, x, y, z);
    if (!f.known) known = false;
    if (f.freezes) { n++; biome ??= f.biome; }
  }
  return { all: n > 0 && n === surface.length, any: n > 0, known, biome };
}

// ------------------------------------------------------------------ answers: cost, volume, undo

/**
 * §12's `cost.bom` ({item: n}, C26's rules through connectors/bom.mjs): the shell's blocks (`shellStates` on each body record), water
 * sources free, one lava bucket per lava source (C26 gives a bucket back), the ice cap as `ice`.
 */
export function bodyBom(bodies) {
  const states = [];
  for (const b of bodies) {
    for (const s of b.shellStates ?? []) states.push(s);
    if (b.fluid === 'lava') for (let i = 0; i < b.cells.length; i++) states.push('minecraft:lava_bucket');
    for (let i = 0; i < (b.ice?.length ?? 0); i++) states.push('minecraft:ice');
  }
  return bomOf(states);
}

/** The answer of a body whose volume the plan could not give it (§10): incomplete VOLUME (past the cap, or not read), else null. */
export function volumeAnswer(r, bodies) {
  for (const b of bodies) {
    if (b.volumeState === 'cap') return { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `body ${b.id}'s frozen volume is ${b.volumeCells} cells, past the per-part cap (4,000,000)`, evidence: { body: b.id, cells: b.volumeCells, cap: 'partCells', limit: 4000000 } }] };
    if (b.volumeState === 'asked' && (r.ctx.volumes ?? []).length) return { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `body ${b.id}'s frozen volume was not read (its chunks are not loaded or not generated): prepare (or check with load: "generate"), then check again`, evidence: { body: b.id, missing: true } }] };
  }
  return null;
}

/** Undo what r.fluidBody recorded since `mark` (a part refused after its bodies were written: compile.mjs rolls the ops back). */
export function bodiesMark(r) {
  return { bodies: (r._fluidBodies ?? []).length, waters: (r.meta.waters ?? []).length };
}
export function bodiesRollback(r, m) {
  if (r._fluidBodies) r._fluidBodies.length = m.bodies;
  if (r.meta.waters) { r.meta.waters.length = m.waters; if (!m.waters) delete r.meta.waters; }
}

/** Keep cells for a body's reach (M25:keep's, at plan time): what a spill or a breach must never reach. Returns a reason or null. */
export function keepReason(r, env, x, y, z) {
  const c = env.claim;
  if (x <= c.minX || x >= c.maxX || z <= c.minZ || z >= c.maxZ) return 'claim ring';
  for (const p of env.protectedAreas) if (x >= p.rect.minX && x <= p.rect.maxX && z >= p.rect.minZ && z <= p.rect.maxZ) return `protected ${p.id}`;
  for (const k of env.keepOut) if (x >= k.minX && x <= k.maxX && z >= k.minZ && z <= k.maxZ) return 'keep-out';
  for (const b of env.buildRects) if (x >= b.rect.minX - 1 && x <= b.rect.maxX + 1 && z >= b.rect.minZ - 1 && z <= b.rect.maxZ + 1) return `build ${b.id}`;
  for (const g of env.regions) if (x >= g.rect.minX - 1 && x <= g.rect.maxX + 1 && z >= g.rect.minZ - 1 && z <= g.rect.maxZ + 1) return `region ${g.id}`;
  for (const l of r.lots) { const b = l.box; if (x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1 && y >= b.minY - 1 && y <= b.maxY + 1) return `lot ${l.id}`; }
  return null;
}

/**
 * A body's reach at plan time against the keep cells: its cells, shell, spill and single-breach reach (the body record's `watch`).
 * Returns {cells: [[x, y, z]] (at most 16), reasons} when something forbidden is met, else null.
 */
export function reachMeetsKeep(r, env, rec, { volClass = null } = {}) {
  const hit = [], reasons = new Set(), seen = new Set();
  const N7 = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // (M25:keep's reading: each cell and its face neighbours; the frozen volume's other owners, players' blocks and block entities)
  for (const q of [...rec.cells, ...rec.shell, ...rec.spill, ...rec.watch]) for (const [dx, dy, dz] of N7) {
    const x = q[0] + dx, y = q[1] + dy, z = q[2] + dz, k = `${x},${y},${z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let why = keepReason(r, env, x, y, z);
    if (!why && volClass) { const c = volClass(x, y, z); if (c) why = c; }
    if (why) { if (hit.length < 16) hit.push([x, y, z]); reasons.add(why); }
  }
  return hit.length ? { cells: hit, reasons: [...reasons].sort() } : null;
}

/** The frozen volumes' keep classes at a cell (OWNED, PLAYER, BLOCK_ENTITY), for reachMeetsKeep; null without volumes. */
export function volumeKeep(r, VC, classAt) {
  const vols = Object.values(r.volumesUsed ?? {}).map((u) => r._volumeDecoded?.get(u.blob)).filter(Boolean);
  if (!vols.length) return null;
  return (x, y, z) => {
    for (const v of vols) {
      const c = classAt(v, x, y, z);
      if (c === VC.MISSING) continue;
      return c === VC.OWNED ? 'owned' : c === VC.PLAYER ? 'player' : c === VC.BLOCK_ENTITY ? 'block entity' : null;
    }
    return null;
  };
}

/** A generator's refusal: an Error 'CODE: message' carrying its evidence (and a wouldFit) for compile.mjs's answer. */
export function refusal(code, message, evidence = {}, wouldFit = null) {
  return Object.assign(new Error(`${code}: ${message}`), { evidence, ...(wouldFit ? { wouldFit } : {}) });
}

/** The LEAK refusal of a body whose reach meets what M25:keep forbids (reachMeetsKeep's hit). */
export function leakRefusal(rec, hit, what = 'shell, spill or single-breach reach') {
  return refusal('LEAK', `body ${rec.id}'s ${what} meets ${hit.reasons.join(', ')} at ${hit.cells.slice(0, 4).map((q) => q.join(' ')).join('; ')}`, { body: rec.id, meets: hit.reasons, cells: hit.cells });
}
