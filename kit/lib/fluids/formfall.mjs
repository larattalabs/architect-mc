// (8c RV-b, docs/CONTRACT.md "Phase 8c" §6, N-8c-3) form.waterfall `lip: "form"`: a fall off a plan form (`on: {part}`), the header
// pool set in the form's top, the curtain falling clear of the form into a basin on the ground. waterfall.mjs dispatches here for a part
// with lip form; every other waterfall is waterfall.mjs's, byte for byte. It must not import compile.mjs or program.mjs.
//
// The frame is waterfall.mjs's (rows along `f`, out of the face; lanes across): the header pool rows -(POOL-1)..0, lanes 0..w-1, at the
// form's own level L (the lowest top over its columns); its walls and second course (rows -(POOL+1)..0, lanes -2..w+1) the form's own
// top, at most FORM_FALL.rough over L; the outlets row 1 at L, off the form's top; the curtain row 1 from L - 1 down to the basin, clear of
// the form's cells (an island's roots by their boxes); the basin a natural pond on the ground under the curtain (or a join into natural
// water), its landing cells D deep (D = 2, 3 past a drop of 24: hy probe 18 (b), N-8c-3), the pond rect rows (2-D)..(D+2), lanes
// (1-D)..(w-2+D) (a rect pond's ring at the landing is D), under the form's overhang only where the form clears it by 4.
//
// The limits (N-8c-3, decided 2026-11-18 on Noah's delegation), each refused at its limit + 1 with a typed reason (no new code, §8):
//   drop       the form's L over the basin's surface, at most 48 (or the part's drop): LIMIT {limit: 'drop', max, value}
//   falls      at most 4 waterfalls per region (every fall counts; only a lip form fall is refused): LIMIT {limit: 'falls', max, value}
//   width      the curtain at most 5 wide: the schema's (SCHEMA at $.width), and formFallLimits for a caller
//   basin      always a basin, 3 deep past a 24 drop: a join into water shallower than that is NO_FEATURE {limit: 'basinDepth', min, value}
//   lots       never onto lots or routes, none within 2: the site keeps every zone, lot pad and protected area 2 off (KEEP_OUT {limit:
//              'lots', within: 2}); the basin and curtain bodies are KC's (registerBody), so later lots and routes keep off them
// Hosts: form.floating_island (its rim), form.hollow_mountain and form.crater (where a face drops clear; their slopes usually give none:
// NO_ROOM {why}). Survival: the header pool on a staged island waits for it (8a's typed `terrain` wait; the op's `on` names the host part).
import { FLAG_LAVA, FLAG_TREE, FLAG_WATER, FLAG_FROZEN } from '../region/pack.mjs';
import { flagsAt, grow, meets, rectArr, MARGIN, locatorOf, refusal, fluidRolesOf, bodiesMark, bodiesRollback, reachMeetsKeep, leakRefusal, volumeKeep, volumeAnswer, linesBody, protectedMet } from './place.mjs';
import { VC, classAt } from '../region/volume.mjs';
import { bodyAnswer, emitPond, iceFor, shellCheck } from './pond.mjs';
import { localWorld, reachId } from './body.mjs';
import { craterGen, islandGen, mountainGen } from '../forms/bigForms.mjs';
import { reserve } from './keep.mjs';
import { hollowIn } from './waterfall.mjs';
import { RIM } from '../forms/crater.mjs';

/** The lip form's limits and frame constants (N-8c-3). */
export const FORM_FALL = Object.freeze({ drop: 48, perRegion: 4, deepPast: 24, depth: 2, deep: 3, width: 5, near: 2, rough: 2, clear: 4, minDrop: 3, pool: 3, back: 8 });
/** The forms a fall may drop off. */
export const FALL_HOSTS = Object.freeze(['floating_island', 'hollow_mountain', 'crater']);
const DIRS = Object.freeze({ n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] });
const FACINGS = Object.freeze(['n', 'e', 's', 'w']);
const k2 = (x, z) => `${x},${z}`;

/** The basin's depth at the landing for a drop: 3 past 24, else 2. */
export const basinDepthFor = (drop) => (drop > FORM_FALL.deepPast ? FORM_FALL.deep : FORM_FALL.depth);

/**
 * The lip form's limits as one pure check (the property tests' and a caller's): {drop, width, falls (this one counted), basinDepth (the
 * landing's), lotGap (cells from the nearest lot or zone; Infinity when none)} -> null, or the first typed reason {code, message, evidence:
 * {limit, max | min, value}}.
 */
export function formFallLimits({ drop, width, falls = 1, basinDepth = null, lotGap = Infinity, maxDrop = FORM_FALL.drop }) {
  const lim = (code, limit, bound, value, message) => ({ code, message, evidence: { limit, ...bound, value } });
  if (Number.isInteger(width) && width > FORM_FALL.width) return lim('LIMIT', 'width', { max: FORM_FALL.width }, width, `the curtain is ${width} wide (at most ${FORM_FALL.width})`);
  if (Number.isInteger(drop) && drop > maxDrop) return lim('LIMIT', 'drop', { max: maxDrop }, drop, `the fall drops ${drop} (at most ${maxDrop})`);
  if (Number.isInteger(falls) && falls > FORM_FALL.perRegion) return lim('LIMIT', 'falls', { max: FORM_FALL.perRegion }, falls, `the region would hold ${falls} waterfalls (at most ${FORM_FALL.perRegion})`);
  if (Number.isInteger(drop) && basinDepth !== null && basinDepth < basinDepthFor(drop)) return lim('NO_FEATURE', 'basinDepth', { min: basinDepthFor(drop) }, basinDepth, `a fall of ${drop} lands in water at least ${basinDepthFor(drop)} deep (${basinDepth} here)`);
  if (lotGap <= FORM_FALL.near) return lim('KEEP_OUT', 'lots', { min: FORM_FALL.near + 1 }, lotGap, `the fall would stand ${lotGap} from a lot or zone (at least ${FORM_FALL.near + 1})`);
  return null;
}

/** A frame (waterfall.mjs frameOf's, inlined: that module imports this one). */
function frameOf(O, facing) {
  const f = DIRS[facing], a = [-f[1], f[0]];
  return { O, facing, f, a, col: (row, lane) => [O[0] + f[0] * row + a[0] * lane, O[1] + f[1] * row + a[1] * lane] };
}
function frameRect(F, r0, r1, l0, l1) {
  const ps = [F.col(r0, l0), F.col(r0, l1), F.col(r1, l0), F.col(r1, l1)];
  return { minX: Math.min(...ps.map((p) => p[0])), maxX: Math.max(...ps.map((p) => p[0])), minZ: Math.min(...ps.map((p) => p[1])), maxZ: Math.max(...ps.map((p) => p[1])) };
}
const cellsOf = (F, r0, r1, l0, l1) => { const out = []; for (let rr = r0; rr <= r1; rr++) for (let l = l0; l <= l1; l++) out.push(F.col(rr, l)); return out; };
/** The basin pond's rows and lanes for a landing depth D (the pond rect; its shell one round it). */
const basinExtent = (w, D) => [2 - D, D + 2, 1 - D, w - 2 + D];

/**
 * The host form as a fall reads it: {id, kind, rect, top(x, z) -> its top y | null (not the form's column), solid(x, y, z), roots: boxes,
 * pads: rects}. The generator is the one emitBig writes (bigForms.mjs, pure), so resolve and emit agree. Returns null for another kind.
 */
export function fallHost(C, id) {
  const q = C.byId.get(id), res = C.res.get(id);
  if (!q || q.family !== 'form' || !FALL_HOSTS.includes(q.kind) || !res?.rect) return null;
  const env = C.env, rect = res.rect;
  if (q.kind === 'floating_island') {
    const { isl } = islandGen(env, C.ctx, q, rect);
    const pads = isl.pads.map((pd) => ({ minX: pd.at[0], minZ: pd.at[1], maxX: pd.at[0] + pd.size[0] - 1, maxZ: pd.at[1] + pd.size[1] - 1 }));
    return { id, kind: q.kind, rect, top: (x, z) => isl.top.get(k2(x, z)) ?? null, solid: isl.solid, roots: isl.rootBoxes, pads };
  }
  if (q.kind === 'hollow_mountain') {
    const gen = mountainGen(env, C.ctx, q, rect);
    return { id, kind: q.kind, rect, top: (x, z) => { const t = gen.topAt(x, z); return t === null ? null : Math.max(t, env.S.groundAt(x, z)); }, solid: gen.solid, roots: [], pads: [] };
  }
  const gen = craterGen(env, C.ctx, q, rect);
  const [cx, cz] = gen.centre, R = gen.R, rim = gen.params.rim;
  // (crater.mjs's ring: R < r <= R + RIM, crest `rim` over the base at its middle; the bowl's columns their lining)
  const top = (x, z) => {
    const b = gen.bottomAt(x, z), g = env.S.groundAt(x, z);
    if (b !== null) return Math.min(b, g);
    const r = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
    if (r > R + RIM) return null;
    const u = (2 * (r - R)) / RIM - 1;
    const h = Math.floor(rim * (1 - u * u) + 0.5);
    return h > 0 && gen.base + h > g ? gen.base + h : g;
  };
  return { id, kind: q.kind, rect, top, solid: (x, y, z) => { const t = top(x, z); return t !== null ? y <= t : y <= env.S.groundAt(x, z); }, roots: [], pads: [] };
}

/** How far apart two rects stand (Chebyshev: 1 side by side, 0 when they meet): `lotGap` of formFallLimits. */
export const rectGap = (a, b) => Math.max(0, b.minX - a.maxX, a.minX - b.maxX, b.minZ - a.maxZ, a.minZ - b.maxZ);
const inBox = (b, x, y, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y >= b.minY && y <= b.maxY;

/**
 * Judge one site off host `H`: frame F, width w, the most it may drop. Returns {ok: true, lip: 'form', basin, L, Lb, Wl, depth, drop,
 * rect, rects} or {ok: false, why, drop?, joinDepth?}.
 */
export function judgeFormSite(env, H, F, w, { maxDrop = FORM_FALL.drop, basin = 'auto' } = {}) {
  const S = env.S, P = FORM_FALL.pool;
  const c = env.claim;
  const inClaim = (q) => q[0] >= c.minX + MARGIN && q[0] <= c.maxX - MARGIN && q[1] >= c.minZ + MARGIN && q[1] <= c.maxZ - MARGIN;
  const works = cellsOf(F, -(P + 1), 0, -2, w + 1);
  if (!works.every(inClaim)) return { ok: false, why: 'claim' };
  // the pool and its back wall on the form's own top (its floor the form's cells); its side walls the form's but at the face, where a
  // rim curves away (the body writes its whole shell); the second course where the form has it
  const pool = cellsOf(F, -(P - 1), 0, 0, w - 1);
  const need = [...pool, ...cellsOf(F, -P, -P, -1, w), ...cellsOf(F, -(P - 1), -1, -1, -1), ...cellsOf(F, -(P - 1), -1, w, w)];
  if (need.some((q) => H.top(q[0], q[1]) === null)) return { ok: false, why: 'edge' };
  const L = Math.min(...pool.map((q) => H.top(q[0], q[1])));
  const tops = works.map((q) => H.top(q[0], q[1])).filter((t) => t !== null);
  if (tops.some((t) => t < L - FORM_FALL.rough || t > L + FORM_FALL.rough)) return { ok: false, why: 'rough' };
  for (const q of pool) if (!H.solid(q[0], L - 1, q[1])) return { ok: false, why: 'rough' };
  const row1 = cellsOf(F, 1, 1, 0, w - 1);
  if (row1.some((q) => H.top(q[0], q[1]) !== null)) return { ok: false, why: 'face' };
  const worksRect = frameRect(F, -(P + 1), 0, -2, w + 1);
  if (H.pads.some((pd) => meets(grow(worksRect, FORM_FALL.near), pd))) return { ok: false, why: 'lot' };
  // the basin: judged over the deeper basin's extent (its shell round it), a join where natural water stands under the curtain
  const [r0, r1, l0, l1] = basinExtent(w, FORM_FALL.deep);
  const bc = cellsOf(F, r0 - 1, r1 + 1, l0 - 1, l1 + 1);
  if (!bc.every(inClaim) || !row1.every(inClaim)) return { ok: false, why: 'claim' };
  const r1f = row1.map((q) => flagsAt(env, q[0], q[1]));
  const wet = r1f.every((f) => (f & FLAG_WATER) && !(f & FLAG_FROZEN) && !(f & FLAG_LAVA));
  const useJoin = basin === 'join' || (basin === 'auto' && wet);
  if (useJoin && !wet) return { ok: false, why: 'join' };
  let Lb, Wl = null, joinDepth = null;
  if (useJoin) {
    const r1g = row1.map((q) => S.groundAt(q[0], q[1]));
    Wl = Math.min(...r1g);
    if (Math.max(...r1g) !== Wl) return { ok: false, why: 'join' };
    joinDepth = Math.min(...row1.map((q) => S.groundAt(q[0], q[1]) - S.floorAt(q[0], q[1])));
    Lb = Wl;
  } else {
    const fl = bc.map((q) => flagsAt(env, q[0], q[1]));
    if (fl.some((f) => f & (FLAG_WATER | FLAG_LAVA))) return { ok: false, why: 'water' };
    if (fl.some((f) => f & FLAG_TREE)) return { ok: false, why: 'tree' };
    const bg = bc.map((q) => S.groundAt(q[0], q[1]));
    const foot = Math.min(...bg);
    if (Math.max(...bg) - foot > 1) return { ok: false, why: 'rough' };
    // (sunk: no column within 2 round it lower than its banks)
    for (const q of cellsOf(F, r0 - 3, r1 + 3, l0 - 3, l1 + 3)) if (S.groundAt(q[0], q[1]) < foot) return { ok: false, why: 'slope' };
    Lb = foot - 1;
  }
  const drop = L - Lb;
  if (drop < FORM_FALL.minDrop) return { ok: false, why: 'drop' };
  if (drop > maxDrop) return { ok: false, why: 'tall', drop };
  const D = basinDepthFor(drop);
  if (useJoin && joinDepth < D) return { ok: false, why: 'joinDepth', drop, joinDepth };
  // the curtain clear of the form (and its roots) from L down to the basin; the basin's columns clear of it by FORM_FALL.clear
  for (const [x, z] of row1) for (let y = Lb + 1; y <= L; y++) if (H.solid(x, y, z) || H.roots.some((b) => inBox(b, x, y, z))) return { ok: false, why: 'curtain' };
  for (const [x, z] of bc) for (let y = Lb - FORM_FALL.clear; y <= Lb + FORM_FALL.clear; y++) if (H.solid(x, y, z) && y > S.groundAt(x, z)) return { ok: false, why: 'under' };
  for (const [x, z] of bc) for (const b of H.roots) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.minY <= Lb + FORM_FALL.clear) return { ok: false, why: 'under' };
  const basinRect = frameRect(F, r0 - 1, r1 + 1, l0 - 1, l1 + 1);
  const rects = [worksRect, useJoin ? frameRect(F, 1, 1, 0, w - 1) : basinRect];
  const rect = rects.reduce((a, q) => ({ minX: Math.min(a.minX, q.minX), minZ: Math.min(a.minZ, q.minZ), maxX: Math.max(a.maxX, q.maxX), maxZ: Math.max(a.maxZ, q.maxZ) }));
  return { ok: true, lip: 'form', basin: useJoin ? 'join' : 'pond', L, Lb, Wl, depth: D, drop, rect, rects, joinDepth };
}

/** The candidate frames off a host: every facing whose lane-0 column is a top column with the next one out off the form (sorted). */
function framesOff(H, w) {
  const out = [];
  const R = H.rect;
  for (let z = R.minZ; z <= R.maxZ; z++) for (let x = R.minX; x <= R.maxX; x++) {
    if (H.top(x, z) === null) continue;
    for (const facing of FACINGS) {
      const [fx, fz] = DIRS[facing];
      if (H.top(x + fx, z + fz) !== null) continue;
      out.push(frameOf([x, z], facing));
    }
  }
  void w;
  return out;
}

/** The form's rock under the pool's floor, FORM_FALL.back rows behind the face at the middle lane (at most FORM_FALL.back cells deep). */
function rockBehind(H, F, w, L) {
  const [x, z] = F.col(-FORM_FALL.back, (w - 1) >> 1);
  let n = 0;
  while (n < FORM_FALL.back && H.solid(x, L - 1 - n, z)) n++;
  return n;
}

/**
 * The region's falls that count before `p` (FORM_FALL.perRegion), once every part has resolved: every other waterfall off the land that
 * fits (H's: never refused by the limit, wherever it stands in the plan) and every fall off a form that fits ahead of `p` in plan order.
 * So the first four falls stand and a fifth off a form is refused, whatever the order the compiler resolves them in.
 */
export function fallsBefore(K, p) {
  const idx = new Map(K.V.parts.map((q, i) => [q.id, i]));
  return K.order.filter((q) => q.id !== p.id && q.family === 'form' && q.kind === 'waterfall' && K.okClass(q.id) && (q.part?.lip !== 'form' || idx.get(q.id) < idx.get(p.id))).length;
}

/**
 * Place a lip form fall (compile step 2, its host resolved). sp: waterfall.mjs's spec. Returns waterfall.mjs's resolution shape with
 * `site.lip` 'form' and `host` {id, kind}.
 */
export function resolveFormFall(C, p, sp) {
  const env = C.env, part = p.part;
  const notes = [...sp.notes];
  const refused = (code, message, evidence) => ({ klass: 'refused', notes, reasons: [{ code, message, evidence }] });
  const hostId = part.on?.part;
  if (typeof hostId !== 'string') return refused('NO_FEATURE', 'a fall off a form names its host: on {part} (lip form)', { lip: 'form' });
  if (hostId.includes('#')) return refused('NO_FEATURE', 'a fall off a form outside this plan waits: its host is written by this plan', { host: hostId });
  const q = C.byId.get(hostId);
  if (!q || q.family !== 'form' || !FALL_HOSTS.includes(q.kind)) return refused('NO_FEATURE', `a fall's host is a form.${FALL_HOSTS.join(', a form.')} of this plan (${hostId} is ${q ? q.block ?? `${q.family}.${q.kind}` : 'not a part'})`, { host: hostId, kind: q?.kind ?? null, hosts: FALL_HOSTS.map((k) => `form.${k}`) });
  // ((the schema's width is 1..5; a caller's own check reads formFallLimits)
  const wl = formFallLimits({ width: sp.width });
  if (wl) return refused(wl.code, wl.message, wl.evidence);
  const H = fallHost(C, hostId);
  if (!H) return { klass: 'blocked', notes, reasons: [{ code: 'DEPENDENCY', message: `${hostId} has no geometry`, evidence: { host: hostId } }] };
  const maxDrop = Math.min(FORM_FALL.drop, part.drop ?? FORM_FALL.drop);
  const loc = part.where ? locatorOf(env, part.where, C.geomOf, { within0: 16 }) : null;
  if (loc?.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', notes, reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(part.where)[0] } }] };
  // what the site keeps 2 off: the zones and forms placed before it (the host's own footprints aside), protected areas
  const own = new Set((C.res.get(hostId)?.footprints ?? []).map((fp) => fp.join(',')));
  const obstacles = (C.taken ?? []).filter((t) => !own.has(rectArr(t).join(',')) && !own.has(rectArr(grow(t, -1)).join(',')));
  const whys = new Map();
  const why = (k) => whys.set(k, (whys.get(k) ?? 0) + 1);
  let best = null, tall = null, shallow = null, nearest = null;
  for (const F of framesOff(H, sp.width)) {
    const s = judgeFormSite(env, H, F, sp.width, { maxDrop, basin: sp.basin });
    if (!s.ok) {
      why(s.why);
      if (s.why === 'tall' && (tall === null || s.drop < tall)) tall = s.drop;
      if (s.why === 'joinDepth' && !shallow) shallow = s;
      continue;
    }
    const g = grow(s.rect, FORM_FALL.near);
    const hit = obstacles.find((o) => meets(g, o));
    if (hit) { why('lot'); const d = rectGap(s.rect, hit); if (nearest === null || d < nearest) nearest = d; continue; }
    if (protectedMet(env, g)) { why('protected'); continue; }
    if (loc && !loc.valid(s.rect)) continue;
    const move = loc ? loc.move(s.rect) : 0;
    // (the thickest rock behind the face first, 8 rows back: a hidden room behind the curtain needs it, and a lobe the warp made has none)
    const score = 4096 * move + 8 * s.drop + 16 * (FORM_FALL.back - rockBehind(H, F, sp.width, s.L)) + FACINGS.indexOf(F.facing);
    if (!best || score < best.score) best = { site: s, F, move, score };
  }
  if (!best) {
    const ev = { host: hostId, whys: Object.fromEntries([...whys].sort()) };
    if (tall !== null && !whys.get('curtain') && [...whys.keys()].every((k) => ['tall', 'edge', 'face', 'rough'].includes(k))) {
      const l = formFallLimits({ drop: tall, maxDrop });
      return refused(l.code, `${l.message}: every site off ${hostId} drops more`, { ...l.evidence, host: hostId });
    }
    if (shallow) { const l = formFallLimits({ drop: shallow.drop, basinDepth: shallow.joinDepth }); return refused(l.code, l.message, { ...l.evidence, host: hostId }); }
    if (whys.get('lot') || whys.get('protected')) { const l = formFallLimits({ lotGap: nearest ?? 0 }); return refused(l.code, `every site off ${hostId}: ${l.message}`, { ...l.evidence, ...ev }); }
    return refused('NO_ROOM', `no ${sp.width}-wide fall off ${hostId}: no edge of its top drops clear into a basin on the ground (${[...whys.keys()].sort().join(', ') || 'no edge'})`, ev);
  }
  const s = best.site;
  const j0 = C.judge([{ what: 'move', value: best.move, ...C.tolOf(part, 'move') }]);
  // (S-H-7, as H's: a hollow asked only in the fall's own words is never dropped silently; a form.hidden_room hosted by it builds it)
  const hollowPart = C.order.find((x) => x.family === 'form' && x.kind === 'hidden_room' && x.part?.host === p.id);
  const hollow = hollowIn(part) && !hollowPart ? { what: 'count', kind: 'hollow', value: 1, max: 0, block: 'form.hidden_room', exceeds: true, note: 'the hollow behind the curtain is not built from the fall\'s own words: a form.hidden_room part hosted by this fall (entrance waterfall) builds it' } : null;
  const j = { ...j0, klass: j0.klass === 'fits' && hollow ? 'adjusted' : j0.klass, deviations: [...j0.deviations, ...(hollow ? [hollow] : [])] };
  if (part.drop !== undefined && part.drop !== s.drop) notes.push(`drop ${s.drop} (the form's over the basin; at most ${maxDrop})`);
  notes.push(`lip form off ${hostId}, basin ${s.basin}${sp.basin === 'auto' ? ' (auto)' : ''}: a ${sp.width}-wide fall of ${s.drop} into water ${s.depth} deep`);
  if (hollowPart) notes.push(`the hollow behind the curtain is its own part (form.hidden_room ${hollowPart.id})`);
  return {
    klass: j.klass, rect: s.rect, footprints: s.rects.map((r) => rectArr(grow(r, FORM_FALL.near))), deviations: j.deviations, notes,
    reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [],
    spec: sp, site: s, frame: { O: best.F.O, facing: best.F.facing }, host: { id: hostId, kind: q.kind },
  };
}

/**
 * Write a lip form fall: the room (the form's cells over the pool, ALWAYS_OURS; the natural cells over the basin under the curtain), the
 * basin pond (kind basin, flow level) or the join, the header pool (kind header, lip form, on the host). Returns {pool, basin, bodies}.
 * `o`: {part, F, width, site, stage, roles, hostTop, on, basinIce}.
 */
export function emitFormFall(r, o) {
  const S = r.ctx.survey, F = o.F, w = o.width, s = o.site, P = FORM_FALL.pool, L = s.L, D = s.depth;
  const ids = [reachId(o.part, 1), reachId(o.part, 2)];
  const all = r.ctx.roles;
  const rock = linesBody(all.rock) ? all.rock : 'minecraft:stone';
  const room = r.part(`${o.part}_room`.slice(0, 48), { stage: o.stage });
  const rc = [];
  for (let rr = -(P - 1); rr <= 0; rr++) for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(rr, l); const t = o.hostTop(x, z); rc.push(x, z, L, Math.max(L, t ?? L) + 1, 0); }
  room.columns({ abs: 0 }, { abs: 0 }, rc, [null], { cond: 3 });
  const cc = [];
  for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(1, l); const t = S.topAt(x, z); if (t >= s.Lb + 1) cc.push(x, z, s.Lb + 1, t, 0); }
  if (cc.length) room.columns({ abs: 0 }, { abs: 0 }, cc, [null], { cond: 0 });
  (r.meta.parts[room.id] ??= {}).kind = 'carve';
  const out = [];
  let basin = null;
  const lanes = [];
  for (let l = 0; l <= w - 1; l++) lanes.push(F.col(1, l));
  if (s.basin === 'pond') {
    const [r0, r1, l0, l1] = basinExtent(w, D);
    const ps = [F.col(r0, l0), F.col(r1, l1)];
    const rect = { minX: Math.min(ps[0][0], ps[1][0]), maxX: Math.max(ps[0][0], ps[1][0]), minZ: Math.min(ps[0][1], ps[1][1]), maxZ: Math.max(ps[0][1], ps[1][1]) };
    basin = emitPond(r, { id: ids[1], part: o.part, kind: 'basin', flow: 'level', rect, shape: 'rect', depth: D, edge: 'natural', fluid: 'water', stage: o.stage, level: s.Lb, roles: o.roles, ice: o.basinIce ?? null });
    out.push(basin);
  }
  const cells = [];
  for (let rr = -(P - 1); rr <= 0; rr++) for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(rr, l); cells.push([x, L, z]); }
  const outlets = lanes.map(([x, z]) => [x, L, z]);
  const joins = s.basin === 'join' ? lanes.map(([x, z]) => [x, s.Wl, z]) : [{ body: ids[1], cells: lanes.map(([x, z]) => [x, s.Lb, z]) }];
  // (the exit: a notch in the back rim's middle, a swimmer climbs out onto the form's top, as waterfall.mjs's)
  const backMid = F.col(-P, (w - 1) >> 1);
  const pool = r.fluidBody(cells, { id: ids[0], part: o.part, kind: 'header', stage: o.stage, level: L, outlets: [...outlets, [backMid[0], L + 1, backMid[1]]], joins, shellRole: rock, ice: null, lip: 'form', on: o.on });
  return { pool, basin, bodies: [pool, ...out] };
}

/** Write the part (waterfall.mjs emit's lip form half): the bodies, each against KC's keep and the curtain clear in the draft world. */
export function emitForm(K, p, res) {
  const r = K.r, env = K.env, sp = res.spec, s = res.site;
  const F = frameOf(res.frame.O, res.frame.facing);
  const m = bodiesMark(r);
  try {
    const notes = [];
    const fl = formFallLimits({ falls: fallsBefore(K, p) + 1 });
    if (fl) throw refusal(fl.code, `${fl.message}: a fall off ${res.host.id} is one more`, fl.evidence);
    let basinIce = null;
    if (s.basin === 'pond') {
      const [r0, r1, l0, l1] = basinExtent(sp.width, s.depth);
      const surf = cellsOf(F, r0, r1, l0, l1).map(([x, z]) => [x, s.Lb, z]);
      const dec = iceFor(K.ctx, surf, p.part.ice);
      if (dec.refuse) throw refusal(dec.refuse.code, dec.refuse.message, dec.refuse.evidence);
      const under = new Set(cellsOf(F, 1, 1, 0, sp.width - 1).map(([x, z]) => k2(x, z)));
      basinIce = dec.ice ? dec.ice.filter(([x, , z]) => !under.has(k2(x, z))) : null;
      notes.push(...dec.notes);
    }
    // the lots now laid (the zones emit before the H parts): none within FORM_FALL.near of the curtain or the basin
    const g = grow(s.rect, FORM_FALL.near);
    const lot = r.lots.find((l) => meets(g, l.box));
    if (lot) { const l = formFallLimits({ lotGap: rectGap(s.rect, lot.box) }); throw refusal(l.code, `${l.message}: lot ${lot.id}`, { ...l.evidence, lot: lot.id }); }
    const H = fallHostAt(K, res.host.id);
    const out = emitFormFall(r, { part: p.id, F, width: sp.width, site: s, stage: K.stageOf('forms'), roles: fluidRolesOf(K.ctx), hostTop: H.top, on: res.host.id, basinIce });
    // the curtain in the plan's own world so far (the form's real cells, its roots): air from the lip down to the basin
    const row1 = cellsOf(F, 1, 1, 0, sp.width - 1);
    const lw = localWorld(r, { minX: Math.min(...row1.map((q) => q[0])), maxX: Math.max(...row1.map((q) => q[0])), minZ: Math.min(...row1.map((q) => q[1])), maxZ: Math.max(...row1.map((q) => q[1])), minY: s.Lb, maxY: s.L });
    const blocked = [];
    for (const [x, z] of row1) for (let y = s.Lb + 1; y <= s.L - 1; y++) if (lw.solid(x, y, z)) blocked.push([x, y, z]);
    if (blocked.length) throw refusal('NO_ROOM', `the curtain meets the form at ${blocked.slice(0, 4).map((q) => q.join(' ')).join('; ')}`, { why: 'curtain', cells: blocked.slice(0, 16) });
    const vk = volumeKeep(r, VC, classAt);
    for (const b of out.bodies) {
      const hit = reachMeetsKeep(r, env, b, { volClass: vk });
      if (hit) throw leakRefusal(b, hit);
      shellCheck(r, b);
    }
    // ((N-8c-3) none within 2: KC's reservation of the footprint is replaced by the bodies' exact sets (compile.mjs registerBody), so the
    // 2 round the curtain, the basin and the header stay kept under a record of their own (`<part>#near`), which the routes, walls and
    // later writers read (keptColumns); it rides the emit's checkpoint, so a rollback drops it)
    if (Array.isArray(K.keep)) reserve(K.keep, { part: `${p.id}#near`, body: out.pool.id, rects: s.rects.map((q) => rectArr(grow(q, FORM_FALL.near))), y0: s.Lb - 6, y1: s.L + 2 });
    res.emitted = { bodies: out.bodies, notes };
  } catch (e) {
    bodiesRollback(r, m);
    throw e;
  }
}

/** The host at emit (K has C's maps: compile.mjs's ensureK). */
function fallHostAt(K, id) {
  const H = fallHost({ byId: K.byId, res: K.res, env: K.env, ctx: K.ctx }, id);
  if (!H) throw refusal('DEPENDENCY', `${id} has no geometry`, { host: id });
  return H;
}

/** The answer's fields (waterfall.mjs answer's lip form half). */
export function answerForm(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  const s = res.site;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { lip: 'form', on: res.host.id, basin: s.basin, drop: s.drop, width: res.spec.width, facing: res.frame.facing, basinDepth: s.depth, ...(s.basin === 'join' ? { joins: e.bodies[0].joins.length } : {}) } });
}
