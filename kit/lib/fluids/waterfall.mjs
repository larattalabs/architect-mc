// (6c H) form.waterfall (lip existing or sculpt; the basin a pond or a join) in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §7, §8, §15). Slice H-a owns this file; it must not
// import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): place the part. res = {klass: 'fits' | 'adjusted' | 'refused' |
//                                 'incomplete', rect?, footprints?: [[x0, z0, x1, z1]] (what later zones and forms keep off), reasons?,
//                                 deviations?, notes?, wouldFit?}; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass,
//                                 tolOf, judge, notes, taken: the rects of the zones and forms placed before it}
//   emit(K, p, res)               compile step 3 (before the routes, so the route pass sees its water): write it (r.fluidBody for a
//                                 body, its shell in its own stage); throw 'CODE: message' to refuse it (the part rolls back)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields ({geometry, cost, notes, deviations}) over the default, or null
// (H-a, additive) siteOf / emitWaterfall(r, o): the site search and the generator, for bundled programs (water_demo).
//
// The waterfall (§7.3), in a frame of its own: rows along `f` (the direction the water falls away, out of the face), lanes across it.
//   the header pool  a raised body of sources `width` lanes wide and POOL rows deep, its front row the lip (row 0, the face's top);
//                    walled 2 thick (its shell plus a solid course: the single breach stays in);
//   the lip run      its outlets: row 1 at the pool's level, one cell out from the face, where the flow leaves the pool; then
//   the curtain      the falling column down row 1 (the declared spill, computed by M25's flow) into
//   the basin        a natural pond body under it (rows 1..BASIN_ROWS, lanes -1..width), or a join: natural water at least 2 deep
//                    under row 1 (the fall lands in its sources: `joins`).
// lip `existing` uses a natural drop: the face row's ground at least `drop` over row 1's (its cells certainly air, 2.5D) with a level
// top behind it; `sculpt` raises a rock outcrop in stage `ground` (the face `drop` over the basin, at most WATERFALL.sculpt high) and
// sets the pool in its top; `auto` (the default) is existing where one passes, else sculpt. A waterfall already in the world is never
// adopted (the survey can't tell one from a pond: `params.existing` reads as auto, noted). The hollow behind the curtain is not built
// (7b, form.hidden_room): a hollow written inside the waterfall's own members (its label, notes or params) makes it answer `adjusted`
// with a deviation naming it (S-H-7); a separate form.hidden_room part waits on its own.
import { VC, classAt } from '../region/volume.mjs';
import { FLAG_FROZEN, FLAG_LAVA, FLAG_TREE, FLAG_WATER } from '../region/pack.mjs';
import { bodiesMark, bodiesRollback, flagsAt, fluidRolesOf, grow, inside, intIn, linesBody, locatorOf, locatorRefusal, meets, protectedMet, reachMeetsKeep,
  readParams, rectArr, scanRects, shellBlock, sketchPoint, spawnAvoid, takenRects, volumeAnswer, volumeKeep, MARGIN, refusal, leakRefusal } from './place.mjs';
import { shellCheck, bodyAnswer, bodyId, emitPond, iceFor, naturalOf, shellStatesOf } from './pond.mjs';

export const WATERFALL = Object.freeze({ width: 3, drop: 6, pool: 3, sculpt: 12, basinRows: 4, basinDepth: 2, maxRough: 1, maxRoughExisting: 3 });
const DIRS = Object.freeze({ n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] });
const FACINGS = Object.freeze(['n', 'e', 's', 'w']);
/** A frame's lane vector (right of the facing). */
const laneOf = (f) => [-f[1], f[0]];
const k3 = (x, y, z) => `${x},${y},${z}`;

/** The waterfall's members (first-class, then params leniently). */
export function waterfallSpec(part) {
  const pr = readParams(part, {
    drop: { read: intIn(3, 24), why: 'not 3..24' },
    width: { read: intIn(1, 5), why: 'not 1..5' },
    fluid: { read: (v) => (v === 'water' || v === 'lava' ? v : undefined), why: 'not water or lava' },
  }, { noted: { existing: 'read as lip auto (an existing waterfall is never adopted: the survey cannot tell a falling column from a pond)', material: "not read (the bible's roles style the outcrop and the pools)" } });
  const notes = [...pr.notes];
  if (/existing waterfall/i.test(`${part.notes ?? ''} ${part.label ?? ''}`)) notes.push('"use an existing waterfall" is read as lip auto: a waterfall already in the world is never adopted (the survey cannot tell a falling column from a pond)');
  return { drop: part.drop ?? pr.read.drop ?? WATERFALL.drop, width: part.width ?? pr.read.width ?? WATERFALL.width, lip: part.lip ?? 'auto', basin: part.basin ?? 'auto', fluid: pr.read.fluid ?? 'water', notes };
}

/** A frame: the face's first lip column O, the facing f; col(row, lane) -> [x, z]. */
export function frameOf(O, facing) {
  const f = DIRS[facing], a = laneOf(f);
  return { O, facing, f, a, col: (row, lane) => [O[0] + f[0] * row + a[0] * lane, O[1] + f[1] * row + a[1] * lane] };
}

/** The axis-aligned rect of a frame's rows r0..r1 and lanes l0..l1. */
function frameRect(F, r0, r1, l0, l1) {
  const ps = [F.col(r0, l0), F.col(r0, l1), F.col(r1, l0), F.col(r1, l1)];
  return { minX: Math.min(...ps.map((p) => p[0])), maxX: Math.max(...ps.map((p) => p[0])), minZ: Math.min(...ps.map((p) => p[1])), maxZ: Math.max(...ps.map((p) => p[1])) };
}

/** The footprint rows and lanes of a waterfall: the works (outcrop or the pool's walls) and the basin. */
function extents(w, basin) {
  return { works: [-(WATERFALL.pool + 1), 0, -2, w + 1], basin: basin === 'join' ? null : [1, WATERFALL.basinRows + 1, -2, w + 1] };
}

/**
 * Judge one site: frame F, width w, drop, lip ('existing' | 'sculpt'), basin ('pond' | 'join' | 'auto'). Returns {ok: true, lip, basin,
 * top (the works' ground), L (the pool's surface), H (the outcrop's height over the ground; 0 existing), Wl (the join's water top) | null,
 * rect, rects} or {ok: false, why}.
 */
export function judgeSite(env, F, w, drop, lip, basin) {
  const S = env.S;
  const cells = (r0, r1, l0, l1) => { const out = []; for (let rr = r0; rr <= r1; rr++) for (let l = l0; l <= l1; l++) out.push(F.col(rr, l)); return out; };
  const inClaim = (q) => q[0] >= env.claim.minX + MARGIN && q[0] <= env.claim.maxX - MARGIN && q[1] >= env.claim.minZ + MARGIN && q[1] <= env.claim.maxZ - MARGIN;
  const works = cells(-(WATERFALL.pool + 1), 0, -2, w + 1);
  if (!works.every(inClaim)) return { ok: false, why: 'claim' };
  const wf = works.map((q) => flagsAt(env, q[0], q[1]));
  if (wf.some((f) => f & (FLAG_WATER | FLAG_LAVA))) return { ok: false, why: 'water' };
  if (wf.some((f) => f & FLAG_TREE)) return { ok: false, why: 'tree' };
  const gw = works.map((q) => S.groundAt(q[0], q[1]));
  let top = Math.min(...gw);
  const topMax = Math.max(...gw);
  if (lip === 'existing') {
    // (a natural cliff's top is rarely level: the pool's surface is the lip's own lowest ground, every pool column at least that high
    // (the rest carved), every wall column at most 1 under it (the walls stand on it), and no column over 8 above it)
    const lipG = Math.min(...cells(0, 0, 0, w - 1).map((q) => S.groundAt(q[0], q[1])));
    if (cells(-(WATERFALL.pool - 1), 0, 0, w - 1).some((q) => S.groundAt(q[0], q[1]) < lipG)) return { ok: false, why: 'rough' };
    if (gw.some((g) => g < lipG - 1 || g > lipG + 8)) return { ok: false, why: 'rough' };
    top = lipG;
  } else if (topMax - top > WATERFALL.maxRough) return { ok: false, why: 'rough' };
  // row 1 (the curtain's column) and the basin
  const row1 = cells(1, 1, 0, w - 1);
  if (!row1.every(inClaim)) return { ok: false, why: 'claim' };
  const r1f = row1.map((q) => flagsAt(env, q[0], q[1]));
  const wet = r1f.every((f) => (f & FLAG_WATER) && !(f & FLAG_FROZEN) && !(f & FLAG_LAVA));
  const deep = wet && row1.every((q) => S.groundAt(q[0], q[1]) - S.floorAt(q[0], q[1]) >= 2);
  const r1g = row1.map((q) => S.groundAt(q[0], q[1]));
  let useBasin = basin;
  if (basin === 'auto') useBasin = deep ? 'join' : 'pond';
  if (useBasin === 'join' && !deep) return { ok: false, why: 'join' };
  let Wl = null, foot = null;
  if (useBasin === 'join') {
    Wl = Math.min(...r1g);
    if (Math.max(...r1g) !== Wl) return { ok: false, why: 'join' };
  } else {
    const bc = cells(1, WATERFALL.basinRows + 1, -2, w + 1);
    if (!bc.every(inClaim)) return { ok: false, why: 'claim' };
    const bf = bc.map((q) => flagsAt(env, q[0], q[1]));
    if (bf.some((f) => f & (FLAG_WATER | FLAG_LAVA))) return { ok: false, why: 'water' };
    const bg = bc.map((q) => S.groundAt(q[0], q[1]));
    foot = Math.min(...bg);
    if (Math.max(...bg) - foot > (lip === 'existing' ? WATERFALL.maxRoughExisting : WATERFALL.maxRough)) return { ok: false, why: 'rough' };
    // the basin sunk (§2.5): no column within 2 round it lower than its banks (a breach would run downhill off a slope)
    for (const q of cells(1, WATERFALL.basinRows + 3, -4, w + 3)) if (S.groundAt(q[0], q[1]) < foot) return { ok: false, why: 'slope' };
  }
  // the basin's surface: the join's water top, or the pond's (1 under its banks' lowest ground)
  const Lb = useBasin === 'join' ? Wl : foot - 1;
  let L, H;
  if (lip === 'existing') {
    // a natural drop: the face's top `drop` over the basin, the curtain's cells over row 1's ground (certainly air)
    L = top;
    H = 0;
    if (L - Lb < drop) return { ok: false, why: 'drop' };
    if (r1g.some((g) => g >= L - 1)) return { ok: false, why: 'drop' };
    // (no ground between the face and row 1 standing over the lip)
  } else {
    L = Lb + drop;
    H = L - top;
    if (H < 2) return { ok: false, why: 'drop' };
    if (H > WATERFALL.sculpt) return { ok: false, why: 'sculpt' };
  }
  const ex = extents(w, useBasin);
  const rects = [frameRect(F, ex.works[0], ex.works[1], ex.works[2], ex.works[3]), ...(ex.basin ? [frameRect(F, ex.basin[0], ex.basin[1], ex.basin[2], ex.basin[3])] : [frameRect(F, 1, 1, 0, w - 1)])];
  const rect = rects.reduce((a, q) => ({ minX: Math.min(a.minX, q.minX), minZ: Math.min(a.minZ, q.minZ), maxX: Math.max(a.maxX, q.maxX), maxZ: Math.max(a.maxZ, q.maxZ) }));
  return { ok: true, lip, basin: useBasin, top, L, H, Lb, Wl, rect, rects };
}

/** The S-H-7 reading: a hollow written inside the waterfall's own members (its label, notes or params). */
export function hollowIn(part) {
  const text = `${part.label ?? ''} ${part.notes ?? ''} ${JSON.stringify(part.params ?? {})}`;
  return /\bhollow\b|\bcave behind\b|behind the (falls|curtain|water)/i.test(text);
}

/**
 * The site search: every facing and every frame origin whose site rect lies within the locator's area, judged (lip existing first when
 * auto, then sculpt), scored as compile.mjs scores a rect. Returns the best {site, F, move, sketch} or null, and why it found none.
 */
export function siteOf(C, part, sp, { lips = null, ignore = {} } = {}) {
  const env = C.env;
  const loc = locatorOf(env, part.where, C.geomOf, { within0: 16 });
  if (loc.error) return { error: loc };
  const tMove = C.tolOf(part, 'move');
  const sk = sketchPoint(env, part.sketch);
  const obstacles = ignore.taken ? [] : takenRects(C, 1);
  const avoid = spawnAvoid(C);
  const whys = new Map();
  const tryLips = lips ?? (sp.lip === 'auto' ? ['existing', 'sculpt'] : [sp.lip]);
  // (basin auto: a join wherever one passes, else a pond: the fall lands in natural water when the locator offers it)
  const tryBasins = sp.basin === 'auto' ? ['join', 'pond'] : [sp.basin];
  for (const [lip, basin] of tryLips.flatMap((l) => tryBasins.map((b) => [l, b]))) {
    let best = null;
    // candidate origins: scan the whole footprint's bounding square (side = the largest extent) and try each facing inside it
    const side = WATERFALL.pool + 2 + WATERFALL.basinRows + 2 + sp.width + 4;
    const cands = scanRects(env, side, side, loc, { sketch: sk, obstacles: [], maxMove: tMove.ceiling, keep: 0, limit: 100000, avoid: [], ok: () => true });
    for (const c of cands) {
      for (const facing of FACINGS) {
        // the frame's origin: the square's centre, the site centred on it
        const cx = (c.rect.minX + c.rect.maxX) >> 1, cz = (c.rect.minZ + c.rect.maxZ) >> 1;
        const F0 = frameOf([0, 0], facing);
        const back = F0.col(-1, (sp.width - 1) >> 1);
        const F = frameOf([cx - back[0], cz - back[1]], facing);
        const s = judgeSite(env, F, sp.width, sp.drop, lip, basin);
        if (!s.ok) { whys.set(s.why, (whys.get(s.why) ?? 0) + 1); continue; }
        const g = grow(s.rect, 1);
        if (!ignore.hard && env.hard.some((h) => meets(g, h))) { whys.set('protected', (whys.get('protected') ?? 0) + 1); continue; }
        if (obstacles.some((o) => meets(g, o))) { whys.set('overlap', (whys.get('overlap') ?? 0) + 1); continue; }
        if (avoid.some(([px, pz, pr]) => px >= g.minX - pr && px <= g.maxX + pr && pz >= g.minZ - pr && pz <= g.maxZ + pr)) continue;
        if (!loc.valid(s.rect)) continue;
        const move = loc.move(s.rect);
        if (move > tMove.ceiling) continue;
        const score = c.score + (lip === 'existing' ? 0 : 0) + FACINGS.indexOf(facing);
        if (!best || score < best.score) best = { site: s, F, move, sketch: c.sketch, score };
      }
      if (best && c.score > best.score + 64) break;
    }
    if (best) return { best, whys };
  }
  return { best: null, whys };
}

/** Place the part. */
export function resolve(C, p) {
  const env = C.env, part = p.part;
  const sp = waterfallSpec(part);
  if (sp.fluid === 'lava') {
    const frag = { ...part, params: Object.fromEntries(Object.entries(part.params ?? {}).filter(([k]) => k !== 'fluid')) };
    const water = resolve(C, { ...p, part: frag });
    const wf = water.klass === 'fits' || water.klass === 'adjusted' ? [{ part: p.id, fragment: frag, geometry: { rect: rectArr(water.rect) }, cost: { cells: 0 } }] : undefined;
    return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'FIRE', message: 'lava is allowed only in a lined pit (form.pond, R22): a waterfall holds water (lava falls wait, N-H-3)', evidence: { kind: 'lava' } }] };
  }
  if (sp.lip === 'sculpt' && sp.drop - 1 > WATERFALL.sculpt + 1) sp.notes.push(`drop ${sp.drop}: a sculpted outcrop rises at most ${WATERFALL.sculpt}`);
  const found = siteOf(C, part, sp);
  if (found.error) return locatorRefusal(part, found.error);
  let { best, whys } = found;
  let devs = [];
  // a sculpt asked past the outcrop's limit: the highest it raises, a size deviation
  if (!best && (whys.get('sculpt') ?? 0) > 0) {
    for (let d = sp.drop - 1; d >= 3 && !best; d--) {
      const f2 = siteOf(C, part, { ...sp, drop: d }, { lips: sp.lip === 'existing' ? ['existing'] : ['sculpt'] });
      if (f2.best) { best = f2.best; devs = [{ what: 'size', value: Math.ceil(((sp.drop - d) * 100) / sp.drop), ...C.tolOf(part, 'size') }]; sp.notes.push(`drop ${d} (asked ${sp.drop}): the highest a sculpted outcrop raises there`); }
    }
  }
  if (!best) {
    // why: the water (a join asked where none is deep enough), a protected area, the zones and forms, no drop, else no room
    const wf = smallerDrop(C, p, sp);
    const any = siteOf(C, part, sp, { ignore: { taken: true, hard: true } }).best;
    const met = any ? protectedMet(env, grow(any.site.rect, 1)) : null;
    if (sp.basin === 'join' && (whys.get('join') ?? 0) > 0 && !any) return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'NO_FEATURE', message: 'no natural water at least 2 deep under a fall within the locator (basin join)', evidence: { feature: { water: { minDepth: 2 } } } }] };
    if (met) return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'PROTECTED', message: `every site for the waterfall within its locator meets ${met.kind}${met.id ? ` ${met.id}` : ''}`, evidence: { ...met } }] };
    if (any) return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'NO_ROOM', message: 'every site for the waterfall within its locator meets a zone or form placed before it', evidence: { whys: Object.fromEntries(whys) } }] };
    return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'NO_ROOM', message: `no site for a ${sp.width}-wide waterfall dropping ${sp.drop} within its locator (${sp.lip === 'existing' ? 'no natural drop' : 'no level, dry ground'})`, evidence: { whys: Object.fromEntries(whys) } }] };
  }
  // S-H-7: the hollow behind the curtain is never dropped silently
  const notes = [...sp.notes];
  const hollowPart = C.order.some((q) => q.family === 'form' && q.kind === 'hidden_room');
  if (hollowIn(part) && !hollowPart) devs.push({ what: 'count', kind: 'hollow', value: 1, max: 0, block: 'form.hidden_room', until: '7b', note: 'the hollow behind the curtain is not built (form.hidden_room waits for 7b): the fall is built in front of the face' });
  else if (hollowPart) notes.push('the hollow behind the curtain is its own part (form.hidden_room, until 7b)');
  else notes.push('the cliff behind the curtain is not hollowed (a hollow is form.hidden_room, 7b)');
  const j = C.judge([{ what: 'move', value: best.move, ...C.tolOf(part, 'move') }, ...(best.sketch ? [{ what: 'sketch', value: best.sketch, ...C.tolOf(part, 'sketch') }] : []), ...devs.filter((d) => d.what !== 'count')]);
  const hollow = devs.find((d) => d.kind === 'hollow');
  const klass = j.klass === 'fits' && hollow ? 'adjusted' : j.klass;
  const s = best.site;
  notes.push(`lip ${s.lip}${sp.lip === 'auto' ? ' (auto)' : ''}, basin ${s.basin}${sp.basin === 'auto' ? ' (auto)' : ''}: a ${sp.width}-wide fall of ${s.L - s.Lb}${s.lip === 'sculpt' ? ` from an outcrop ${s.H} high` : ''}`);
  return {
    klass, rect: s.rect, footprints: s.rects.map((q) => rectArr(grow(q, 1))), deviations: [...j.deviations, ...(hollow ? [{ ...hollow, exceeds: true }] : [])], notes,
    reasons: klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [],
    spec: sp, site: s, frame: { O: best.F.O, facing: best.F.facing },
  };
}

/** A smaller drop's wouldFit (the refusals' repair): the same part with drop 3, when that finds a site. */
function smallerDrop(C, p, sp) {
  if (sp.drop <= 3) return undefined;
  const f = siteOf(C, p.part, { ...sp, drop: 3 });
  if (!f.best) return undefined;
  return [{ part: p.id, fragment: { ...p.part, drop: 3 }, geometry: { rect: rectArr(f.best.site.rect) }, cost: { cells: 0 } }];
}

/**
 * Write a waterfall at a judged site. `o`: {id, part, F (frame), width, site (judgeSite's), stage, roles, ice, sculptStage}. The outcrop
 * (sculpt) in `sculptStage` (default `ground`), the pool's walls, the basin pond, the header pool. Returns {pool, basin, works: rect}.
 */
export function emitWaterfall(r, o) {
  const S = r.ctx.survey, F = o.F, w = o.width, s = o.site, P = WATERFALL.pool;
  const all = r.ctx.roles;
  const rock = linesBody(all.rock) ? all.rock : 'minecraft:stone';
  const coping = linesBody(o.roles.coping.block) ? o.roles.coping.block : shellBlock(all, 'structure');
  const L = s.L;
  // the works: the outcrop (sculpt: rock from the ground up to the pool's level over rows -(P+1)..0, lanes -2..w+1) or the pool's
  // second wall course (existing: lanes -2 and w+1 and the back row, at the pool's level and the rim's), and the room over the pool
  const works = r.part(`${o.id}_works`.slice(0, 48), { stage: o.sculptStage ?? 'ground' });
  const cols = [];
  for (let rr = -(P + 1); rr <= 0; rr++) for (let l = -2; l <= w + 1; l++) {
    const [x, z] = F.col(rr, l);
    const g = S.groundAt(x, z);
    const pool = rr >= -(P - 1) && l >= 0 && l <= w - 1;
    if (s.lip === 'sculpt') {
      if (L - 1 >= g + 1) cols.push(x, z, g + 1, L - 1, 0);
      if (!pool) cols.push(x, z, L, L, 0);
      // the outer course of the rim (the shell's own rim is the inner one), and the inner course's two back corners (no shell cell: the
      // rim would show two gaps there)
      if (l === -2 || l === w + 1 || rr === -(P + 1) || (rr === -P && (l === -1 || l === w))) cols.push(x, z, L + 1, L + 1, 1);
    } else if (!pool && (l === -2 || l === w + 1 || rr === -(P + 1))) {
      cols.push(x, z, L, L + 1, 1);
    } else if (rr === -P && (l === -1 || l === w)) {
      cols.push(x, z, L, L, 0, x, z, L + 1, L + 1, 1);
    }
  }
  works.columns({ abs: 0 }, { abs: 0 }, cols, [rock, coping], { cond: 3 });
  (r.meta.parts[works.id] ??= {}).kind = 'add';
  // the room: over the pool, its rim and the curtain (row 1, from the pool's level up), everything natural cleared
  const room = r.part(`${o.id}_room`.slice(0, 48), { stage: o.stage });
  const rc = [];
  for (let rr = -(P - 1); rr <= 0; rr++) for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(rr, l); const t = S.topAt(x, z); rc.push(x, z, L, Math.max(L, t), 0); }
  for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(1, l); const t = S.topAt(x, z); if (t >= s.Lb + 1) rc.push(x, z, s.Lb + 1, t, 0); }
  room.columns({ abs: 0 }, { abs: 0 }, rc, [null], { cond: 0 });
  (r.meta.parts[room.id] ??= {}).kind = 'carve';
  // the basin: a natural pond under the curtain (rows 1..BASIN_ROWS, lanes -1..w), or the join
  let basin = null;
  const out = [];
  if (s.basin === 'pond') {
    const ps = [F.col(1, -1), F.col(WATERFALL.basinRows, w)];
    const rect = { minX: Math.min(ps[0][0], ps[1][0]), maxX: Math.max(ps[0][0], ps[1][0]), minZ: Math.min(ps[0][1], ps[1][1]), maxZ: Math.max(ps[0][1], ps[1][1]) };
    basin = emitPond(r, { id: `${o.id}_basin`.slice(0, 40), part: o.part ?? null, kind: 'waterfall', rect, shape: 'round', depth: WATERFALL.basinDepth, edge: 'natural', fluid: 'water', stage: o.stage, level: s.Lb, roles: o.roles, ice: o.basinIce ?? null });
    out.push(basin);
  }
  // the header pool: sources at the lip, its outlets over row 1
  const cells = [];
  for (let rr = -(P - 1); rr <= 0; rr++) for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(rr, l); cells.push([x, L, z]); }
  const outlets = [];
  for (let l = 0; l <= w - 1; l++) { const [x, z] = F.col(1, l); outlets.push([x, L, z]); }
  const joins = s.basin === 'join' ? outlets.map(([x, , z]) => [x, s.Wl, z]) : [];
  const natural = naturalOf(r, frameRect(F, -(P + 1), 1, -2, w + 1), L - 3, L + 2);
  const pick = (x, y, z, chain) => chain.find((b) => b && String(b).replace(/\[.*$/, '') !== natural(x, y, z)) ?? chain[chain.length - 1];
  const shellRole = (x, y, z, where) => (s.lip === 'sculpt' ? (where === 'rim' ? coping : rock) : where === 'rim' ? pick(x, y, z, [coping, rock, 'minecraft:stone_bricks']) : pick(x, y, z, [rock, 'minecraft:cobblestone', 'minecraft:stone_bricks']));
  const basinSet = new Set((basin?.cells ?? []).map((c) => k3(...c)));
  // the exit: a notch in the back rim's middle (a swimmer climbs out onto the outcrop's top, away from the lip); the outer course
  // behind it is the step up
  const backMid = F.col(-P, (w - 1) >> 1);
  const notch = [backMid[0], L + 1, backMid[1]];
  const pool = r.fluidBody(cells, { id: o.id, part: o.part ?? null, kind: 'waterfall', stage: o.stage, level: L, outlets: [...outlets, notch], joins, shellRole, ice: null,
    world: (x, y, z) => (basinSet.has(k3(x, y, z)) ? 'water' : null) });
  pool.shellStates = shellStatesOf(pool, shellRole);
  pool.works = frameRect(F, -(P + 1), 0, -2, w + 1);
  for (let i = 0; i < cols.length; i += 5) for (let y = cols[i + 2]; y <= cols[i + 3]; y++) pool.shellStates.push(cols[i + 4] ? coping : rock);
  return { pool, basin, bodies: [pool, ...out] };
}

/** Write the part. */
export function emit(K, p, res) {
  const r = K.r, env = K.env, sp = res.spec;
  const F = frameOf(res.frame.O, res.frame.facing);
  const m = bodiesMark(r);
  try {
    const notes = [];
    // a basin pond in a freezing biome: capped, its cells under the curtain kept open (the fall lands in water, never on ice)
    let basinIce = null;
    if (res.site.basin === 'pond') {
      const surf = [];
      for (let rr = 1; rr <= WATERFALL.basinRows; rr++) for (let l = -1; l <= sp.width; l++) { const [x, z] = F.col(rr, l); surf.push([x, res.site.Lb, z]); }
      const dec = iceFor(K.ctx, surf, p.part.ice);
      if (dec.refuse) throw refusal(dec.refuse.code, dec.refuse.message, dec.refuse.evidence);
      const under = new Set(); for (let l = 0; l < sp.width; l++) { const [x, z] = F.col(1, l); under.add(`${x},${z}`); }
      basinIce = dec.ice ? dec.ice.filter(([x, , z]) => !under.has(`${x},${z}`)) : null;
      notes.push(...dec.notes);
    }
    const out = emitWaterfall(r, { id: bodyId(p.id), part: p.id, F, width: sp.width, site: res.site, stage: K.stageOf('forms'), sculptStage: K.stageOf('ground'), roles: fluidRolesOf(K.ctx), basinIce });
    const vk = volumeKeep(r, VC, classAt);
    for (const b of out.bodies) {
      const hit = reachMeetsKeep(r, env, b, { volClass: vk });
      if (hit) throw leakRefusal(b, hit);
      shellCheck(r, b);
    }
    res.emitted = { bodies: out.bodies, notes };
  } catch (e) {
    bodiesRollback(r, m);
    if (/^LEAK: /.test(e.message)) { const wf = smallerDropAtEmit(K, p, res); if (wf) e.wouldFit = wf; }
    throw e;
  }
}
const smallerDropAtEmit = () => null;

/** The answer's fields. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  const s = res.site;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { lip: s.lip, basin: s.basin, drop: s.L - s.Lb, width: res.spec.width, facing: res.frame.facing, ...(s.lip === 'sculpt' ? { outcrop: s.H } : {}), ...(s.basin === 'join' ? { joins: e.bodies[0].joins.length } : {}) } });
}

void inside; void FLAG_FROZEN;
