// (6c H) connector.channel as channel.moat in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §7, §8, §15). Slice H-a owns this file; it must not
// import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): place the part. res = {klass: 'fits' | 'adjusted' | 'refused' |
//                                 'incomplete', rect?, footprints?: [[x0, z0, x1, z1]] (what later zones and forms keep off), reasons?,
//                                 deviations?, notes?, wouldFit?}; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass,
//                                 tolOf, judge, notes, taken: the rects of the zones and forms placed before it}
//   emit(K, p, res)               compile step 3 (before the routes, so the route pass sees its water): write it (r.fluidBody for a
//                                 body, its shell in its own stage); throw 'CODE: message' to refuse it (the part rolls back)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields ({geometry, cost, notes, deviations}) over the default, or null
//   passInput(K) -> object | null  the route pass's input for the plan's own water (the routes keep 1 off it); null: none
// (H-a, additive) planWaterClearance(K, l): the clearance a street fallback's bridge keeps over plan water (N-H-5: 1); emitMoat(r, o)
// (the generator, for bundled programs: water_demo).
//
// The moat (§7.4): a level ring of still water round a feature (a part, a protected area or a build), `width` (default 5) wide and
// `depth` (default 3) deep, its surface 1 under the lowest ground of its banks (sunk), lined in `foundation` with a `fluids.coping` rim.
// Its inner shell runs at Chebyshev distance `ring` (the first offset of [6, 12] whose ring is dry, clear and inside the claim) from the
// feature. Beside a wall on the same feature it starts outside the wall's widest ring plus its thickness plus a berm (a bridge's far
// landing and the gate's approach), adjusted outward past the range when it must be. `closed: false` leaves out the side nearest the
// claim's centre (the ends capped by the shell). Compiled with the forms (step 2) and written before the routes: the route pass sees
// every body's water (passInput), streets, roads and paths crossing it take T3's bridge fallback (clearance 1 over plan water, N-H-5)
// and land at the wall's gate. Plan water stays an obstacle to walls and wet piers (§8): a pier never stands in it.
import { VC, classAt } from '../region/volume.mjs';
import { VOLUME_CAP } from './body.mjs';
import { WALL_DEFAULTS } from '../connectors/wall.mjs';
import { FLAG_WATER } from '../region/pack.mjs';
import { channelForm } from '../plan/schema.mjs';
import { bodiesMark, bodiesRollback, centre, featureOf, fluidRolesOf, grow, inside, intIn, linesBody, meets, protectedMet, reachMeetsKeep, readParams, rectArr,
  rectSurvey, shellBlock, takenRects, volumeAnswer, volumeKeep, MARGIN, flagsAt, refusal, leakRefusal, exitNotches } from './place.mjs';
import { shellCheck, bodyAnswer, bodyId, iceFor, naturalOf, shellStatesOf } from './pond.mjs';

export const MOAT = Object.freeze({ width: 5, depth: 3, ring: [6, 12], berm: 5 });
const cheb = (x, z, T) => Math.max(Math.max(0, T.minX - x, x - T.maxX), Math.max(0, T.minZ - z, z - T.maxZ));

/** The moat's members (first-class, then params leniently: width, depth, closed, fluid for R22). */
export function moatSpec(part) {
  const pr = readParams(part, {
    width: { read: intIn(1, 7), why: 'not 1..7' },
    depth: { read: intIn(1, 4), why: 'not 1..4' },
    fluid: { read: (v) => (v === 'water' || v === 'lava' ? v : undefined), why: 'not water or lava' },
  }, { noted: { material: "not read (the bible's foundation and fluids.coping style the moat)", mechanism: 'not read (no mechanism in H)' } });
  const ar = part.where?.around ?? {};
  const ring = Array.isArray(ar.ring) ? ar.ring : Number.isInteger(ar.ring) ? [ar.ring, ar.ring] : MOAT.ring;
  return { width: part.width ?? pr.read.width ?? MOAT.width, depth: part.depth ?? pr.read.depth ?? MOAT.depth, fluid: pr.read.fluid ?? 'water', closed: ar.closed ?? true, ring, notes: pr.notes };
}

/** The side of rect T nearest the claim's centre (an open ring leaves it out). */
function openSide(env, T) {
  const [cx, cz] = centre(env.claim);
  const d = { n: Math.abs(cz - T.minZ), e: Math.abs(T.maxX - cx), s: Math.abs(T.maxZ - cz), w: Math.abs(cx - T.minX) };
  return ['n', 'e', 's', 'w'].reduce((a, b) => (d[b] < d[a] ? b : a), 'n');
}
const onSide = (x, z, T, s) => (s === 'n' ? z < T.minZ : s === 's' ? z > T.maxZ : s === 'w' ? x < T.minX : x > T.maxX);

/** The ring's columns at offset o: {water: [[x, z]], all: [[x, z, d]]} (all: inner shell to outer shell, the open side left out). */
export function ringColumns(T, o, w, omit = null) {
  const water = [], all = [];
  const R = o + w + 1;
  for (let x = T.minX - R; x <= T.maxX + R; x++) for (let z = T.minZ - R; z <= T.maxZ + R; z++) {
    const d = cheb(x, z, T);
    if (d < o || d > R) continue;
    // (the open side: the columns past the feature's side there, corners included, are left out; the shell caps the ends)
    if (omit && onSide(x, z, T, omit)) continue;
    all.push([x, z, d]);
    if (d > o && d < R) water.push([x, z]);
  }
  return { water, all };
}

/** The walls of the plan that ring the same feature: [{id, hi (their widest ring), thickness}]. */
function wallsOn(C, f) {
  const key = JSON.stringify(f);
  const out = [];
  for (const q of C.order) {
    if (q.family !== 'connector' || q.kind !== 'wall' || !q.part.where?.around) continue;
    if (JSON.stringify(q.part.where.around.feature) !== key) continue;
    const r = q.part.where.around.ring;
    const hi = Array.isArray(r) ? r[1] : Number.isInteger(r) ? r : WALL_DEFAULTS.ring[1];
    out.push({ id: q.id, hi, thickness: q.part.thickness ?? WALL_DEFAULTS.thickness });
  }
  return out;
}

/** Place the part: the first offset of its ring range whose ring is dry, clear and inside the claim. */
export function resolve(C, p) {
  const env = C.env, part = p.part;
  if (channelForm(part) !== 'moat') return { klass: 'unsupported', reasons: [{ code: 'UNSUPPORTED', message: 'a channel along a line is channel.course, reserved until HY', block: 'channel.course', until: 'HY' }] };
  const sp = moatSpec(part);
  if (sp.fluid === 'lava') {
    const frag = { ...part, params: Object.fromEntries(Object.entries(part.params ?? {}).filter(([k]) => k !== 'fluid')) };
    const water = resolve(C, { ...p, part: frag });
    const wf = water.klass === 'fits' || water.klass === 'adjusted' ? [{ part: p.id, fragment: frag, geometry: { rect: rectArr(water.rect), ring: water.ring }, cost: { cells: water.cells } }] : undefined;
    return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'FIRE', message: 'lava is allowed only in a lined pit (form.pond, R22): a moat holds water', evidence: { kind: 'lava' } }] };
  }
  const f = featureOf(env, part.where.around.feature, C.geomOf);
  if (f.error) return { klass: f.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', notes: sp.notes, reasons: [{ code: f.error.code, message: f.error.message, evidence: f.error.evidence ?? {} }] };
  if (f.body) return { klass: 'refused', notes: sp.notes, reasons: [{ code: 'NO_FEATURE', message: 'a moat rings a part, a protected area or a build, not water', evidence: { feature: part.where.around.feature } }] };
  const T = f.rect;
  const notes = [...sp.notes];
  const walls = wallsOn(C, part.where.around.feature);
  let lo = sp.ring[0];
  const hi = sp.ring[1];
  let need = lo;
  for (const w of walls) need = Math.max(need, w.hi + w.thickness + MOAT.berm);
  if (walls.length) notes.push(`beside wall ${walls.map((w) => w.id).join(', ')}: the ring starts at ${need} (the wall's widest ring, its thickness and a ${MOAT.berm}-cell berm for a bridge's landing and the gate)`);
  const omit = sp.closed ? null : openSide(env, T);
  if (omit) notes.push(`closed: false: its ${{ n: 'north', e: 'east', s: 'south', w: 'west' }[omit]} side (nearest the claim's centre) is left out, the ends capped`);
  const claimIn = grow(env.claim, -MARGIN);
  const taken = takenRects(C, 1);
  let why = { water: 0, hard: 0, claim: 0, taken: 0 }, met = null, wet = null;
  const tryAt = (o) => {
    const outer = grow(T, o + sp.width + 1);
    if (!inside(grow(outer, 1), claimIn)) { why.claim++; return false; }
    const { all } = ringColumns(T, o, sp.width, omit);
    // natural water within 2 of the ring (a body never meets natural water at another level)
    for (const [x, z] of ringColumns(T, Math.max(0, o - 2), sp.width + 4, omit).all) if (flagsAt(env, x, z) & FLAG_WATER) { why.water++; wet ??= [x, z]; return false; }
    // the ring's columns (and one around) clear of keep-out, protected areas, builds and other owners, and of the zones and forms placed
    // before it (the feature's own rect lies inside the ring, never under it)
    const bands = ringBands(T, o - 1, o + sp.width + 2, omit);
    for (const b of bands) {
      const h = env.hard.find((q) => meets(b, q));
      if (h) { why.hard++; met ??= protectedMet(env, b) ?? { kind: 'keep-out', rect: rectArr(h) }; return false; }
      if (taken.some((t) => meets(b, t) && !(t.minX >= T.minX - 1 && t.maxX <= T.maxX + 1 && t.minZ >= T.minZ - 1 && t.maxZ <= T.maxZ + 1))) { why.taken++; return false; }
    }
    void all;
    return true;
  };
  let o = null;
  for (let k = Math.max(lo, Math.min(need, hi)); k <= hi; k++) if (k >= need && tryAt(k)) { o = k; break; }
  let devs = [];
  if (o === null && need > hi) {
    // past the range: the first offset from `need` outward (adjusted, a move deviation of the cells past the range's end)
    for (let k = need; k <= need + 8; k++) if (tryAt(k)) { o = k; break; }
    if (o !== null) devs = [{ what: 'move', value: o - hi, ...C.tolOf(part, 'move') }];
  }
  if (o === null) {
    if (why.water) return { klass: 'refused', notes, reasons: [{ code: 'WATER', message: `every ring of the moat in ${lo}..${Math.max(hi, need)} meets natural water at another level (a moat is never joined to natural water)`, evidence: { kind: 'level', at: wet, ring: [lo, hi] } }] };
    if (why.hard && met) return { klass: 'refused', notes, reasons: [{ code: 'PROTECTED', message: `every ring of the moat meets ${met.kind}${met.id ? ` ${met.id}` : ''}`, evidence: { ...met, ring: [lo, hi] } }] };
    return { klass: 'refused', notes, reasons: [{ code: 'NO_ROOM', message: `no ring of the moat in ${lo}..${Math.max(hi, need)} fits inside the claim, clear of the zones, forms${walls.length ? ' and the wall' : ''}`, evidence: { ring: [lo, hi], need, outside: why.claim, overlap: why.taken } }] };
  }
  const j = C.judge(devs);
  const outer = grow(T, o + sp.width + 1);
  const cells = ringColumns(T, o, sp.width, omit).water.length * sp.depth;
  return {
    klass: j.klass, rect: outer, footprints: ringBands(T, o, o + sp.width + 1, omit).map(rectArr), deviations: j.deviations, notes,
    reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `the ring ${o} is ${o - hi} past its range`, evidence: { what: 'move', value: o - hi } }] : [],
    spec: sp, T, ring: o, omit, cells, walls: walls.map((w) => w.id),
  };
}

/** The four side bands of a ring between Chebyshev offsets a..b round T (the open side left out): rects. */
export function ringBands(T, a, b, omit = null) {
  const out = [];
  if (omit !== 'n') out.push({ minX: T.minX - b, maxX: T.maxX + b, minZ: T.minZ - b, maxZ: T.minZ - a });
  if (omit !== 's') out.push({ minX: T.minX - b, maxX: T.maxX + b, minZ: T.maxZ + a, maxZ: T.maxZ + b });
  if (omit !== 'w') out.push({ minX: T.minX - b, maxX: T.minX - a, minZ: T.minZ - b, maxZ: T.maxZ + b });
  if (omit !== 'e') out.push({ minX: T.maxX + a, maxX: T.maxX + b, minZ: T.minZ - b, maxZ: T.maxZ + b });
  return out;
}

/**
 * Write a moat round T at offset `ring`: the trench carved, the shell in `foundation` with a `fluids.coping` rim (each cell the first block
 * of its chain unlike what stands there), the sources. `o`: {id, part, T, ring, width, depth, omit, stage, roles, ice}. Returns the
 * body record with {level, ring}.
 */
export function emitMoat(r, o) {
  const S = r.ctx.survey;
  const { water, all } = ringColumns(o.T, o.ring, o.width, o.omit);
  const level = Math.min(...all.map(([x, z]) => S.groundAt(x, z))) - 1;
  const cells = [], carve = [];
  for (const [x, z] of water) {
    for (let y = level - o.depth + 1; y <= level; y++) cells.push([x, y, z]);
    carve.push(x, z, level - o.depth + 1, Math.max(level, S.topAt(x, z)), 0);
  }
  const cut = r.part(`${o.id}_trench`.slice(0, 48), { stage: o.stage });
  cut.columns({ abs: 0 }, { abs: 0 }, carve, [null], { cond: 0 });
  (r.meta.parts[cut.id] ??= {}).kind = 'carve';
  const all3 = r.ctx.roles;
  const lining = shellBlock(all3, 'foundation');
  const coping = linesBody(o.roles.coping.block) ? o.roles.coping.block : shellBlock(all3, 'structure');
  const box = { minX: o.T.minX - o.ring - o.width - 1, maxX: o.T.maxX + o.ring + o.width + 1, minZ: o.T.minZ - o.ring - o.width - 1, maxZ: o.T.maxZ + o.ring + o.width + 1 };
  const natural = naturalOf(r, box, level - o.depth - 1, level + 2);
  const pick = (x, y, z, chain) => chain.find((b) => b && String(b).replace(/\[.*$/, '') !== natural(x, y, z)) ?? chain[chain.length - 1];
  const shellRole = (x, y, z, where) => (where === 'rim' ? pick(x, y, z, [coping, lining, 'minecraft:stone_bricks']) : pick(x, y, z, [lining, 'minecraft:stone_bricks', 'minecraft:cobblestone']));
  // the exits: notches in both rims every 12 (a swimmer climbs out on either side), the bank over each cleared
  const exits = exitNotches(cells, level, { every: 12, max: 256 });
  const ec = [];
  for (const [x, y, z] of exits) { const t = S.topAt(x, z); if (t >= y) ec.push(x, z, y, t, 0); }
  if (ec.length) { const ex = r.part(`${o.id}_exits`.slice(0, 48), { stage: o.stage }); ex.columns({ abs: 0 }, { abs: 0 }, ec, [null], { cond: 0 }); (r.meta.parts[ex.id] ??= {}).kind = 'carve'; }
  const rec = r.fluidBody(cells, { id: o.id, part: o.part ?? null, kind: 'moat', stage: o.stage, level, shellRole, ice: o.ice ?? null, outlets: exits });
  rec.shellStates = shellStatesOf(rec, shellRole);
  return Object.assign(rec, { ring: o.ring, columns: water.length });
}

/** Write the part (after the walls: the ring kept clear of their cells). */
export function emit(K, p, res) {
  const r = K.r, env = K.env, sp = res.spec;
  // the walls already planned (K1's step 2 ran first): the ring keeps 2 clear of every wall cell
  for (const W of K.walls ?? []) for (const c of W.cells) {
    const d = cheb(c.x, c.z, res.T);
    if (d >= res.ring - 2 && d <= res.ring + sp.width + 3) throw new Error(`NO_ROOM: wall ${W.id} stands at ${c.x} ${c.z}, inside the moat's ring ${res.ring} (or within 2 of it)`);
  }
  const m = bodiesMark(r);
  try {
    const S = r.ctx.survey;
    const { water, all } = ringColumns(res.T, res.ring, sp.width, res.omit);
    const level = Math.min(...all.map(([x, z]) => S.groundAt(x, z))) - 1;
    // (§10) past the per-part volume cap the moat answers incomplete VOLUME before anything is written (its box: the cells and the
    // shell, grown by 2: r.fluidBody's for a sunk body)
    const R = res.ring + sp.width + 1 + 2;
    const vcells = (res.T.maxX - res.T.minX + 1 + 2 * R) * (res.T.maxZ - res.T.minZ + 1 + 2 * R) * (sp.depth + 2 + 4);
    if (vcells > VOLUME_CAP) { res.capped = { cells: vcells }; return; }
    const dec = iceFor(K.ctx, water.map(([x, z]) => [x, level, z]), p.part.ice);
    if (dec.refuse) throw refusal(dec.refuse.code, dec.refuse.message, dec.refuse.evidence);
    const rec = emitMoat(r, { id: bodyId(p.id), part: p.id, T: res.T, ring: res.ring, width: sp.width, depth: sp.depth, omit: res.omit, stage: K.stageOf('forms'), roles: fluidRolesOf(K.ctx), ice: dec.ice });
    const hit = reachMeetsKeep(r, env, rec, { volClass: volumeKeep(r, VC, classAt) });
    if (hit) throw leakRefusal(rec, hit);
    shellCheck(r, rec);
    res.emitted = { bodies: [rec], notes: dec.notes };
  } catch (e) {
    bodiesRollback(r, m);
    throw e;
  }
}

/** The answer's fields. */
export function answer(K, p, res) {
  if (res.capped) return { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `the moat's frozen volume is ${res.capped.cells} cells, past the per-part cap (${VOLUME_CAP})`, evidence: { cells: res.capped.cells, cap: 'partCells', limit: VOLUME_CAP } }] };
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { block: 'channel.moat', around: rectArr(res.T), ring: res.ring, width: res.spec.width, depth: res.spec.depth, closed: !res.omit, ...(res.omit ? { open: res.omit } : {}) } });
}

/**
 * The route pass's input for the plan's own water (every body's, not only the moats'): `{water: [[x, z, level]] (the body's columns),
 * shell: [[x, z, top, level]] (its shell's columns outside them, top the highest shell cell or the ground, level the body's surface), hard: [[x0, z0, x1, z1]] (a raised
 * body's footprint: a fountain, a waterfall's works), lava: [[x, z]]}`, or null when the plan has no body (the pass is T2's, byte for
 * byte). The routes keep 1 off plan water (its columns are the pass's water); a bridge spans it with its piers on dry land outside
 * the shell.
 */
export function passInput(K) {
  const bodies = K.r._fluidBodies ?? [];
  if (!bodies.length) return null;
  const S = K.env.S;
  const water = new Map(), shell = new Map(), lava = new Set(), hard = [];
  const k2 = (x, z) => `${x},${z}`;
  for (const b of bodies) {
    for (const [x, , z] of b.cells) {
      if (b.fluid === 'lava') lava.add(k2(x, z));
      else water.set(k2(x, z), Math.max(water.get(k2(x, z)) ?? -Infinity, b.level));
    }
  }
  for (const b of bodies) {
    for (const [x, y, z] of b.shell) {
      const k = k2(x, z);
      if (water.has(k) || lava.has(k)) continue;
      const q = shell.get(k) ?? { top: S.groundAt(x, z), level: b.level };
      q.top = Math.max(q.top, y); q.level = Math.min(q.level, b.level);
      shell.set(k, q);
    }
    if (b.raised) {
      const xs = [...b.cells, ...b.shell].map((c) => c[0]), zs = [...b.cells, ...b.shell].map((c) => c[2]);
      hard.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]);
    }
  }
  const un = (k) => k.split(',').map(Number);
  const sortXZ = (a, b) => a[0] - b[0] || a[1] - b[1];
  return {
    water: [...water].map(([k, l]) => [...un(k), l]).sort(sortXZ),
    shell: [...shell].map(([k, q]) => [...un(k), q.top, q.level]).sort(sortXZ),
    lava: [...lava].map(un).sort(sortXZ),
    hard: hard.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]),
  };
}

/**
 * N-H-5: a street fallback's bridge keeps clearance 1 over the plan's own water (no boat passes under it) and T3's 2 over natural
 * water: 1 when the leg's ends, grown by the bridge's approach (16), hold plan water and no surveyed water; else null (T3's default).
 */
export function planWaterClearance(K, l) {
  const inp = passInput(K);
  if (!inp || !inp.water.length) return null;
  const a = l.from.at ?? l.from.node?.at, b = l.to.at ?? l.to.node?.at;
  if (!a || !b) return null;
  const box = { minX: Math.min(a[0], b[0]) - 16, maxX: Math.max(a[0], b[0]) + 16, minZ: Math.min(a[2], b[2]) - 16, maxZ: Math.max(a[2], b[2]) + 16 };
  if (rectSurvey(K.env, box).water) return null;
  return inp.water.some(([x, z]) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) ? 1 : null;
}
