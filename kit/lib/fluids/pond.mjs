// (6c H) form.pond (water or a lava pit), the farm pond (S-H-1, farmPond: true) and the wet well (well water: true) in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §7, §8, §15). Slice H-a owns this file; it must not
// import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): place the part. res = {klass: 'fits' | 'adjusted' | 'refused' |
//                                 'incomplete', rect?, footprints?: [[x0, z0, x1, z1]] (what later zones and forms keep off), reasons?,
//                                 deviations?, notes?, wouldFit?}; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass,
//                                 tolOf, judge, notes, taken: the rects of the zones and forms placed before it}
//   emit(K, p, res)               compile step 3 (before the routes, so the route pass sees its water): write it (r.fluidBody for a
//                                 body, its shell in its own stage); throw 'CODE: message' to refuse it (the part rolls back)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields ({geometry, cost, notes, deviations}) over the default, or null
//   stageWanted(C) -> bool         whether a part that is no body brings one (a farm lot's farmPond): the fluids stage
// (H-a, additive) emitFarmPonds(K) (compile step 3, after the zones: each farm lot's pond), emitPond(r, o) (the generator, for bundled
// programs: water_demo), wetWell(r, well, o) (V's well with water, flat_village's wellWater).
//
// The pond (§7.1): the integer ellipse of its size (a natural edge) or its rect (built, and every lava pit); its surface 1 under the
// lowest ground of its rim columns, so every pond is sunk (§2.5); `depth` (default 2; lava 1) at the centre, stepping up 1 a ring towards
// the edge; the basin carved IF_NATURAL; a 1-thick shell (r.fluidBody's rule) in the bible's `fluids.bed` (floor and sides) and
// `fluids.rim` (the ring over the surface: the bank) for a natural edge, `structure` with a `fluids.coping` rim for a built one, and
// `foundation` with a non-flammable coping for lava. An ice cap where the biome freezes (R23, §1.3). Lava (N-H-3, R22): a pit 1..2 deep,
// at least 2 from any water (the site keeps 4 off surveyed water), M20's fire reach clear of trees, protected areas and builds (the
// site), its plants cleared in stage `forms` (IF_NATURAL air over the ground within the reach).
import { FIRE_REACH } from '../region/checkFluids.mjs';
import { FLAG_TREE, FLAG_WATER, FLAG_LAVA } from '../region/pack.mjs';
import { VC, blockAt, classAt } from '../region/volume.mjs';
import { isFlammable } from '../blocks.mjs';
import { localWorld } from './body.mjs';
import { inferVillager } from '../params.mjs';
import { overflowsOn } from './hooks.mjs';
import { F_WRITTEN } from '../region/vworld.mjs';
import {
  PRESET_SIZES, arrRect, bodiesMark, bodiesRollback, bodyBom, centre, flagsAt, fluidRolesOf, gap, grow, intIn, inside, linesBody, locatorOf,
  locatorRefusal, meets, protectedMet, reachMeetsKeep, readParams, rectArr, rectOf, rectSurvey, scanRects, shellBlock, sketchPoint, surfaceFreezes,
  takenRects, volumeAnswer, volumeKeep, waterInClaim, MARGIN, freezesAt, spawnAvoid, refusal, leakRefusal, exitNotches,
} from './place.mjs';

const k2 = (x, z) => `${x},${z}`;
const k3 = (x, y, z) => `${x},${y},${z}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** (6c HY, §1.5) A pond may feed a course: a course `from: {part: <pond>}` registers an overflow on it (hooks.mjs). */
export const acceptsOverflow = true;
/** The default sizes: a water pond 9 x 7, a lava pit 3 x 3. The area limit (catalogue 7 `form.pond.limits.area`). */
export const POND = Object.freeze({ water: [9, 7], lava: [3, 3], areaMax: 1024, areaMin: 4, depth: 2, lavaDepth: 1 });
/** The farm pond (S-H-1): 3 x 3, 1 deep, its rim 2 from the lot's box (M25:keep keeps one clear cell beside a box). */
export const FARM_POND = Object.freeze({ side: 3, depth: 1, rimGap: 2 });
/** Lava keeps this far (Chebyshev, columns) off surveyed water and trees (its fire reach plus a tree's leaves). */
const LAVA_WATER_GAP = 4, LAVA_TREE_GAP = FIRE_REACH.side + 4;

/** A body id for a plan part (a region part id; the shell is `${id}_shell`). */
export const bodyId = (pid, suffix = '') => `w_${pid}`.slice(0, 40 - suffix.length) + suffix;

// ------------------------------------------------------------------ the outline

/**
 * The columns of a pond's outline over `rect` and each column's ring (1 at the edge, +1 a ring inwards: the 4-connected distance to
 * the outside): `round` the integer ellipse inscribed in the rect, else the whole rect. Sorted (x, z).
 */
export function outline(rect, shape = 'round') {
  const w = rect.maxX - rect.minX + 1, d = rect.maxZ - rect.minZ + 1;
  const inSet = new Set();
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    if (shape === 'round' && w > 2 && d > 2) {
      const a = 2 * i + 1 - w, b = 2 * j + 1 - d;
      if (a * a * d * d + b * b * w * w > w * w * d * d) continue;
    }
    inSet.add(k2(rect.minX + i, rect.minZ + j));
  }
  const ring = new Map();
  let q = [];
  for (const k of inSet) {
    const [x, z] = k.split(',').map(Number);
    if (N4.some(([dx, dz]) => !inSet.has(k2(x + dx, z + dz)))) { ring.set(k, 1); q.push([x, z]); }
  }
  for (let r = 1; q.length; r++) {
    const nq = [];
    for (const [x, z] of q) for (const [dx, dz] of N4) {
      const kk = k2(x + dx, z + dz);
      if (!inSet.has(kk) || ring.has(kk)) continue;
      ring.set(kk, r + 1);
      nq.push([x + dx, z + dz]);
    }
    q = nq;
  }
  return [...inSet].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z, ring: ring.get(k) }; }).sort((a, b) => a.x - b.x || a.z - b.z);
}

/** The rim columns of an outline (4-neighbours outside it), sorted. */
export function rimColumns(cols) {
  const own = new Set(cols.map((c) => k2(c.x, c.z)));
  const out = new Set();
  for (const c of cols) for (const [dx, dz] of N4) { const kk = k2(c.x + dx, c.z + dz); if (!own.has(kk)) out.add(kk); }
  return [...out].map((k) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// ------------------------------------------------------------------ the generator

/**
 * Write one pond body (the basin carve and the shell in `stage`, the sources in `fluids`). `o`: {id, part, kind ('pond' | 'farm_pond'),
 * rect (the water's), shape ('round' | 'rect'), depth, edge ('natural' | 'built'), fluid, stage, level? (default 1 under the lowest rim
 * ground), roles (place.mjs fluidRolesOf), ice (cells | true | null), clearFire (lava: clear the plants within M20's reach)}. Returns
 * the body record with {rect, level, depth, cols}.
 */
export function emitPond(r, o) {
  const S = r.ctx.survey;
  const fluid = o.fluid ?? 'water';
  const shape = o.shape ?? (fluid === 'water' && o.edge !== 'built' ? 'round' : 'rect');
  const cols = outline(o.rect, shape);
  const rim = rimColumns(cols);
  const level = o.level ?? Math.min(...rim.map(([x, z]) => S.groundAt(x, z))) - 1;
  const depth = Math.max(1, o.depth ?? (fluid === 'lava' ? POND.lavaDepth : POND.depth));
  const cells = [];
  const carve = [];
  for (const c of cols) {
    const d = Math.min(depth, c.ring);
    for (let y = level - d + 1; y <= level; y++) cells.push([c.x, y, c.z]);
    const top = Math.max(level, S.topAt(c.x, c.z));
    carve.push(c.x, c.z, level - d + 1, top, 0);
  }
  const roles = o.roles;
  const rolesAll = r.ctx.roles;
  const bed = roles.bed.block, rimB = roles.rim.block;
  const coping = linesBody(roles.coping.block) ? roles.coping.block : shellBlock(rolesAll, 'structure');
  const structure = shellBlock(rolesAll, 'structure');
  const nonFlam = (b, fb) => (linesBody(b) && !isFlammable(b) ? b : fb);
  const lavaShell = nonFlam(shellBlock(rolesAll, 'foundation'), 'minecraft:stone');
  const lavaCoping = nonFlam(coping, nonFlam(structure, 'minecraft:stone_bricks'));
  const subsurface = linesBody(rolesAll.subsurface) ? rolesAll.subsurface : bed;
  // a shell cell is written by the body's own part (§1.1): the realise skips a write that leaves the cell as it was (a dirt bed in
  // natural dirt), which would leave it unowned (M25:shell "not written"), so each cell takes the first block of its chain that
  // differs from what stands there (the plan's own world so far: the frozen volume where the plan read one)
  const natural = naturalOf(r, o.rect, level - depth - 2, level + 3);
  const pick = (x, y, z, chain) => { const n = natural(x, y, z); return chain.find((b) => b && nameOf(b) !== n) ?? chain[chain.length - 1]; };
  const shellRole = (x, y, z, where) => {
    if (fluid === 'lava') return pick(x, y, z, where === 'rim' ? [lavaCoping, 'minecraft:stone_bricks', 'minecraft:cobblestone'] : [lavaShell, 'minecraft:cobblestone', 'minecraft:stone']);
    if (o.edge === 'built') return pick(x, y, z, where === 'rim' ? [coping, structure, 'minecraft:stone_bricks'] : [structure, 'minecraft:stone_bricks', 'minecraft:cobblestone']);
    if (where === 'rim') return pick(x, y, z, y >= S.groundAt(x, z) ? [rimB, 'minecraft:moss_block', 'minecraft:coarse_dirt'] : [subsurface, 'minecraft:clay', 'minecraft:mud']);
    return pick(x, y, z, [bed, 'minecraft:clay', 'minecraft:mud']);
  };
  const basin = r.part(`${o.id}_basin`.slice(0, 48), { stage: o.stage });
  basin.columns({ abs: 0 }, { abs: 0 }, carve, [null], { cond: 0 });
  (r.meta.parts[basin.id] ??= {}).kind = 'carve';
  // lava (M20): the plants over the ground within the fire reach of the pit are cleared (IF_NATURAL air: natural cells only)
  if (fluid === 'lava' && o.clearFire !== false) {
    const own = new Set([...cols.map((c) => k2(c.x, c.z)), ...rim.map(([x, z]) => k2(x, z))]);
    const R = FIRE_REACH.side + 1, clear = [];
    for (let x = o.rect.minX - R; x <= o.rect.maxX + R; x++) for (let z = o.rect.minZ - R; z <= o.rect.maxZ + R; z++) {
      if (own.has(k2(x, z))) continue;
      const g = S.groundAt(x, z);
      const y1 = level + FIRE_REACH.above + 1;
      if (y1 > g) clear.push(x, z, g + 1, y1, 0);
    }
    if (clear.length) {
      const fp = r.part(`${o.id}_clear`.slice(0, 48), { stage: o.stage });
      fp.columns({ abs: 0 }, { abs: 0 }, clear, [null], { cond: 0 });
      (r.meta.parts[fp.id] ??= {}).kind = 'carve';
    }
  }
  // the exits (water only): notches in the rim a swimmer climbs out through, the bank over each cleared
  const exits = fluid === 'water' && o.exits !== false ? exitNotches(cells, level, { every: o.exitEvery ?? 6 }) : [];
  if (exits.length) {
    const ex = r.part(`${o.id}_exits`.slice(0, 48), { stage: o.stage });
    const ec = [];
    for (const [x, y, z] of exits) { const t = S.topAt(x, z); if (t >= y) ec.push(x, z, y, t, 0); }
    if (ec.length) { ex.columns({ abs: 0 }, { abs: 0 }, ec, [null], { cond: 0 }); (r.meta.parts[ex.id] ??= {}).kind = 'carve'; }
  }
  // ((6c HY, §1.5) a course leaving the pond: its overflows open side shell cells at the surface; only when there are any, so an H pond's
  // body is as before)
  const ov = Array.isArray(o.overflow) && o.overflow.length ? { overflow: o.overflow, raised: true } : {};
  const rec = r.fluidBody(cells, { id: o.id, part: o.part ?? null, kind: o.kind ?? 'pond', fluid, stage: o.stage, level, shellRole, ice: o.ice ?? null, outlets: exits, _unsafe: o._unsafe ?? null, ...ov });
  return Object.assign(rec, { rect: o.rect, level, depth, cols: cols.length, rim, shellStates: shellStatesOf(rec, shellRole) });
}

/** The block each shell cell of a body record is written in (r.fluidBody's floor / side / rim reading), for the bill of materials. */
export function shellStatesOf(rec, shellRole) {
  const own = new Set(rec.cells.map((c) => k3(...c)));
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return rec.shell.map(([x, y, z]) => {
    const where = own.has(k3(x, y + 1, z)) ? 'floor' : N6.some(([dx, dy, dz]) => own.has(k3(x + dx, y + dy, z + dz))) ? 'side' : 'rim';
    return typeof shellRole === 'function' ? shellRole(x, y, z, where) : shellRole;
  });
}

/** A block state's name (no properties). */
const nameOf = (b) => String(b).replace(/\[.*$/, '');

/** What stands at a cell in the plan's own world so far (the block's name), over `rect` grown by 2, y in [y0, y1]. */
export function naturalOf(r, rect, y0, y1) {
  const lw = localWorld(r, { minX: rect.minX - 2, maxX: rect.maxX + 2, minZ: rect.minZ - 2, maxZ: rect.maxZ + 2, minY: y0, maxY: y1 });
  const P = lw.vw.pal;
  // (the frozen volumes the plan was given, by block id, first: a body asks its own volume after its shell is chosen, so the draft world
  // here may not hold it yet; a cell the plan already wrote keeps the draft's state)
  const vols = (r.ctx.volumes ?? []).map((v) => v.decoded).filter((d) => d?.blocks);
  return (x, y, z) => {
    if (!(lw.vw.flags(x, y, z) & F_WRITTEN)) for (const v of vols) { const b = blockAt(v, x, y, z); if (b) return nameOf(b); }
    return nameOf(P.states[lw.vw.get(x, y, z)]);
  };
}

/** The surface cells a pond over `rect` would have (for the ice decision before it is written). */
export function surfaceOf(r, rect, shape) {
  const S = r.ctx.survey;
  const cols = outline(rect, shape);
  const level = Math.min(...rimColumns(cols).map(([x, z]) => S.groundAt(x, z))) - 1;
  return cols.map((c) => [c.x, level, c.z]);
}

// ------------------------------------------------------------------ the plan part

/** The pond's own members (first-class, then params read leniently), with its notes. */
export function pondSpec(part) {
  const pr = readParams(part, {
    depth: { read: intIn(1, 6), why: 'not 1..6' },
    fluid: { read: (v) => (v === 'water' || v === 'lava' ? v : undefined), why: 'not water or lava' },
  }, { noted: { lake: 'a note only (the size comes from size)', material: "not read (the bible's fluids roles style the pond)" } });
  const notes = [...pr.notes];
  const fluid = part.fluid ?? pr.read.fluid ?? 'water';
  let depth = part.depth ?? pr.read.depth ?? (fluid === 'lava' ? POND.lavaDepth : POND.depth);
  if (fluid === 'lava' && depth > 2) { notes.push(`depth ${depth}: a lava pit is 1..2 deep (read as 2)`); depth = 2; }
  const edge = fluid === 'lava' ? 'built' : part.edge ?? 'natural';
  if (fluid === 'lava' && part.edge !== undefined) notes.push('edge: a lava pit is always lined (its edge is not read)');
  const def = POND[fluid];
  const side = (v, i) => (Array.isArray(v) ? v[1] : Number.isInteger(v) ? v : def[i]);
  let w, d;
  if (part.size?.preset) { w = PRESET_SIZES[part.size.preset]; d = w; } else { w = side(part.size?.w, 0); d = side(part.size?.d, 1); }
  w = Math.max(2, w); d = Math.max(2, d);
  if (w * d > POND.areaMax) {
    const f = Math.sqrt(POND.areaMax / (w * d));
    const w2 = Math.max(2, Math.floor(w * f)), d2 = Math.max(2, Math.floor(d * f));
    notes.push(`size ${w}x${d}: past the pond's area limit (${POND.areaMax}); built ${w2}x${d2}`);
    w = w2; d = d2;
  }
  if (part.ice !== undefined && fluid === 'lava') notes.push('ice: a lava pit is never capped (not read)');
  return { fluid, depth, edge, w, d, notes };
}

/** A lava pit's site rules (M20, M25:mix at plan time): no tree, protected area or build within its fire reach; no water within 4. */
function lavaSiteOk(env, a) {
  const fire = grow(a, LAVA_TREE_GAP);
  const S = rectSurvey(env, grow(a, LAVA_WATER_GAP));
  if (S.water || S.lava) return 'water';
  for (let x = fire.minX; x <= fire.maxX; x++) for (let z = fire.minZ; z <= fire.maxZ; z++) {
    if (x < env.claim.minX || x > env.claim.maxX || z < env.claim.minZ || z > env.claim.maxZ) continue;
    if (flagsAt(env, x, z) & FLAG_TREE) return 'tree';
  }
  if (protectedMet(env, grow(a, 1 + FIRE_REACH.side + 1))) return 'protected';
  return true;
}

/** Place the part: a rect from its locator, clear of what it may not meet; refusals say what held it. */
export function resolve(C, p) {
  const env = C.env, part = p.part;
  const sp = pondSpec(part);
  const loc = locatorOf(env, part.where, C.geomOf);
  if (loc.error) return locatorRefusal(part, loc);
  const tMove = C.tolOf(part, 'move');
  const sk = sketchPoint(env, part.sketch);
  const lava = sp.fluid === 'lava';
  // the shell (1) and one clear cell around it; a lava pit keeps its fire reach (it clears the plants there) inside the claim
  const keep = lava ? 1 + FIRE_REACH.side + 1 : 2;
  const obstacles = takenRects(C, 1);
  const waterOk = (a) => (rectSurvey(env, grow(a, 2)).water || rectSurvey(env, grow(a, 2)).lava ? 'water' : true);
  const ok = (a) => { const w = waterOk(a); if (w !== true) return w; return lava ? lavaSiteOk(env, a) : true; };
  const avoid = spawnAvoid(C);
  const scanWith = (o) => scanRects(env, sp.w, sp.d, loc, { sketch: sk, obstacles, maxMove: tMove.ceiling, keep, limit: 1, avoid, ...o });
  let c = scanWith({ ok })[0];
  if (!c) {
    // why: the water (a body meeting natural water at another level), a protected area or build, the fire reach, else no room
    const anyRect = scanWith({ ok: () => true, keep: 0, obstacles: [] })[0] ?? null;
    if (anyRect && waterOk(anyRect.rect) !== true && scanWith({ ok: (a) => (lava ? lavaSiteOk(env, a) : true), keep: 2 })[0]) {
      const st = rectSurvey(env, grow(anyRect.rect, 2));
      return { klass: 'refused', notes: sp.notes, reasons: [{ code: 'WATER', message: `every place for the ${lava ? 'pit' : 'pond'} within its locator meets natural water at another level (a body is never joined to natural water)`, evidence: { kind: 'level', at: rectArr(anyRect.rect), water: st.water } }] };
    }
    if (lava) {
      const noFire = scanWith({ ok: waterOk, keep: 2 })[0];
      if (noFire) {
        const why = lavaSiteOk(env, noFire.rect);
        const water = resolve(C, { ...p, part: { ...part, fluid: 'water', depth: Math.min(part.depth ?? 2, 2) } });
        const wf = water.klass === 'fits' || water.klass === 'adjusted' ? [{ part: p.id, fragment: { ...part, fluid: 'water' }, geometry: { rect: rectArr(water.water) }, cost: { cells: water.water ? (water.water.maxX - water.water.minX + 1) * (water.water.maxZ - water.water.minZ + 1) : 0 } }] : undefined;
        return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'FIRE', message: `every place for the lava pit within its locator has ${why === 'tree' ? 'a tree' : 'a protected area or build'} within its fire reach (M20: ${FIRE_REACH.side} sideways, ${FIRE_REACH.below} below to ${FIRE_REACH.above} above, plus a tree's leaves)`, evidence: { kind: why, at: rectArr(noFire.rect), reach: FIRE_REACH } }] };
      }
    }
    const raw = scanRects(env, sp.w, sp.d, loc, { sketch: sk, maxMove: tMove.ceiling, keep: 0, limit: 1, ok: () => true, hard: false });
    const met = raw[0] ? protectedMet(env, grow(raw[0].rect, keep)) : null;
    if (met) return { klass: 'refused', notes: sp.notes, reasons: [{ code: 'PROTECTED', message: `the ${lava ? 'pit' : 'pond'}'s shell and its clear cell would meet ${met.kind}${met.id ? ` ${met.id}` : ''} (nothing is written or flooded there)`, evidence: { ...met, at: rectArr(raw[0].rect) } }] };
    return { klass: 'refused', notes: sp.notes, reasons: [{ code: obstacles.length ? 'OVERLAP' : 'NO_ROOM', message: `no ${sp.w}x${sp.d} place for the ${lava ? 'pit' : 'pond'} within its locator, clear of the zones, forms, keep-out and natural water`, evidence: { size: [sp.w, sp.d], obstacles: obstacles.length } }] };
  }
  const j = C.judge([{ what: 'move', value: c.move, ...tMove }, ...(sk ? [{ what: 'sketch', value: c.sketch, ...C.tolOf(part, 'sketch') }] : [])]);
  const a = c.rect;
  return {
    klass: j.klass, rect: grow(a, 1), footprints: [rectArr(grow(a, lava ? keep : 2))], deviations: j.deviations, notes: sp.notes,
    reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [],
    water: a, spec: sp,
  };
}

/** The ice decision for a water body's surface (R23, §1.3): {ice: cells | null, notes, refuse?}. */
export function iceFor(ctx, surface, asked) {
  const notes = [];
  const fr = surfaceFreezes(ctx, surface);
  if (asked === false) {
    if (fr.any) return { ice: null, notes, refuse: { code: 'WATER', message: `ice: false, but the biome freezes the surface (${fr.biome}): open water there freezes on its own (a lit or roofed surface is not compiled in H)`, evidence: { kind: 'freezes', biome: fr.biome } } };
    return { ice: null, notes };
  }
  if (!fr.any) {
    if (asked === true) notes.push(`ice: true is read only where the biome freezes (R23): ${fr.known ? 'this surface does not' : 'the plan has no biome grid'}; noted, not read`);
    return { ice: null, notes };
  }
  const ice = surface.filter(([x, y, z]) => freezesAt(ctx, x, y, z).freezes);
  notes.push(`capped with ice (${ice.length} cell(s)): the biome (${fr.biome}) freezes open water there (R23)`);
  return { ice, notes };
}

/** Write the part: the pond's body; refuse it when its reach meets what it may not (LEAK) or its frozen surface may not be capped. */
export function emit(K, p, res) {
  const r = K.r, env = K.env, sp = res.spec;
  const m = bodiesMark(r);
  try {
    const shape = sp.fluid === 'water' && sp.edge !== 'built' ? 'round' : 'rect';
    let ice = null;
    const notes = [];
    // (the gate's uncapped twin, item 4: ext 'architect_mc:unsafe' {noCap: true} leaves a freezing surface open, the probe of §0's
    // freezing assumption; dev only, never a plan's)
    const noCap = p.part.ext?.['architect_mc:unsafe']?.noCap === true;
    if (noCap) notes.push('architect_mc:unsafe noCap: the surface is left open (the gate\'s uncapped twin)');
    if (sp.fluid === 'water' && !noCap) {
      const dec = iceFor(K.ctx, surfaceOf(r, res.water, shape), p.part.ice);
      if (dec.refuse) throw refusal(dec.refuse.code, dec.refuse.message, dec.refuse.evidence);
      ice = dec.ice; notes.push(...dec.notes);
    }
    const rec = emitPond(r, { id: bodyId(p.id), part: p.id, kind: 'pond', rect: res.water, shape, depth: sp.depth, edge: sp.edge, fluid: sp.fluid, stage: K.stageOf('forms'), roles: fluidRolesOf(K.ctx), ice, overflow: overflowsOn(K, p.id) });
    leakCheck(r, env, rec);
    if (sp.fluid === 'lava') mixCheck(r, rec);
    res.emitted = { bodies: [rec], notes };
  } catch (e) {
    bodiesRollback(r, m);
    throw e;
  }
}

/** A body's reach (its cells, shell, spill and single breach) meeting a lot, a build, a protected area, keep-out or another owner: LEAK. */
export function leakCheck(r, env, rec) {
  const hit = reachMeetsKeep(r, env, rec, { volClass: volumeKeep(r, VC, classAt) });
  if (hit) throw leakRefusal(rec, hit);
  shellCheck(r, rec);
}

/**
 * A body's shell cells the realise would not write (§1.1, M25:shell "not written"): a cell whose block the plan's own world says is no
 * natural block (ice, packed ice, snow block, a player's block: the realise's ALWAYS_OURS passes natural terrain and its own cells only),
 * read from the frozen volume the plan was given (without one the world is the survey's, all natural). Returns [[x, y, z, block]].
 */
export function unwrittenShell(r, rec) {
  if (rec.volumeState !== 'given') return [];
  const xs = rec.shell.map((c) => c[0]), ys = rec.shell.map((c) => c[1]), zs = rec.shell.map((c) => c[2]);
  const lw = localWorld(r, { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY: Math.min(...ys), maxY: Math.max(...ys) });
  const out = [];
  // (the mod's natural terrain, TerrainFit.natural, holds no ice: the kit's ICE class counts as natural in the virtual world, so an ice
  // block under a shell cell is named here from the world before the plan)
  const P = lw.vw.pal;
  const iceOf = (i) => /^minecraft:(ice|packed_ice|blue_ice|frosted_ice)$/.test(String(P.states[i]).replace(/\[.*$/, ''));
  for (const [x, y, z] of rec.shell) {
    const unwritten = !(lw.vw.flags(x, y, z) & F_WRITTEN) || iceOf(lw.vw.base(x, y, z));
    if (unwritten) { out.push([x, y, z, P.states[iceOf(lw.vw.base(x, y, z)) ? lw.vw.base(x, y, z) : lw.vw.get(x, y, z)]]); if (out.length >= 16) break; }
  }
  return out;
}

/** A body whose shell can't be written: refused LEAK (the body could not be closed), naming the cells and what stands there. */
export function shellCheck(r, rec) {
  const bad = unwrittenShell(r, rec);
  if (bad.length) throw refusal('LEAK', `body ${rec.id}: ${bad.length}+ shell cell(s) stand on blocks the realise never replaces (${[...new Set(bad.map((q) => q[3]))].slice(0, 4).join(', ')}): the body could not be closed`, { kind: 'unwritable', body: rec.id, cells: bad.map((q) => q.slice(0, 3)), blocks: [...new Set(bad.map((q) => q[3]))] });
}

/** Lava within 2 of any water (M25:mix): the plan's earlier bodies. */
function mixCheck(r, rec) {
  const lava = rec.cells;
  for (const b of r._fluidBodies ?? []) {
    if (b === rec || b.fluid !== 'water') continue;
    for (const w of [...b.cells, ...b.spill]) for (const q of lava) if (Math.max(Math.abs(w[0] - q[0]), Math.abs(w[1] - q[1]), Math.abs(w[2] - q[2])) <= 2) throw refusal('LEAK', `lava pit ${rec.id} within 2 of ${b.id}'s water at ${w.join(' ')} (M25:mix)`, { kind: 'mix', body: rec.id, water: b.id, at: w });
  }
}

/** The answer's fields: the geometry, the cost, the notes (an incomplete VOLUME when the frozen volume was not read). */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { water: rectArr(res.water), fluid: res.spec.fluid, edge: res.spec.edge, depth: res.spec.depth } });
}

/**
 * A body part's answer fields: geometry {rect, level, bodies, ...extra}, notes; its exact bill of materials (§12: the shell's blocks, a
 * lava bucket per lava source, the ice cap) goes to the plan record's `links.bom` (finish.mjs sets `cost.bom` from it, as K1's).
 */
export function bodyAnswer(K, p, bodies, { rect, notes = [], extra = {}, deviations = null } = {}) {
  (K.record.bom ??= {})[p.id] = bodyBom(bodies);
  return {
    geometry: { rect: rectArr(rect), level: bodies[0].level, ...extra, bodies: bodies.map((b) => ({ id: b.id, kind: b.kind, fluid: b.fluid, level: b.level, cells: b.cells.length, shell: b.shell.length, spill: b.spill.length, ice: b.ice.length, settleTicks: b.settleTicks, raised: b.raised })) },
    ...(notes.length ? { notes } : {}),
    ...(deviations ? { deviations } : {}),
  };
}

// ------------------------------------------------------------------ the farm pond (S-H-1, S-H-2: farmPond: true, off by default)

/** The zone parts whose farm lots get a pond: [{zone (validated part), lots: [lot ids]}]. */
export function farmPondZones(order, okClass) {
  const out = [];
  for (const p of order) {
    if (p.family !== 'zone' || !okClass(p.id)) continue;
    const z = p.part;
    // a lot's villager use as flat_village resolves it: the caller's own value, else the one its type implies (params.mjs)
    const all = z.program?.lots ?? z.program?.params?.lots ?? [];
    const asked = (l) => l && (l.farmPond === true || (z.farmPond === true && l.farmPond !== false));
    const lots = all.filter((l) => asked(l) && (l.villager ?? inferVillager(l.type)) === 'farm');
    if (lots.length) out.push({ zone: p, lots: lots.map((l) => l.id) });
    else if (z.farmPond === true || all.some((l) => l?.farmPond === true)) out.push({ zone: p, lots: [], noFarm: true });
  }
  return out;
}

/** Whether a part that is no body brings one: a farm lot's farmPond on a claim with no surface water (S-H-1). */
export function stageWanted(C) {
  if (!C.order.some((p) => p.family === 'zone' && /"farmPond":true/.test(JSON.stringify(p.part)))) return false;
  if (waterInClaim(C.env)) return false;
  return farmPondZones(C.order, C.okClass).some((z) => !z.noFarm);
}

/**
 * Compile step 3 (after the zones, before the routes): each farm lot's pond (§7.5): a 3 x 3, 1-deep natural pond whose rim stands 2
 * from the lot's box on its back or sides (never its front, where the lane is), on columns the plan has not written, never in a
 * freezing biome (the note says so). Notes go to the zone's answer. Returns {ponds: [{lot, zone, body}], notes: Map(zone -> [note])}.
 */
export function emitFarmPonds(K) {
  const out = { ponds: [], notes: new Map() };
  const asked = farmPondZones(K.order, K.okClass);
  if (!asked.length) return out;
  const note = (z, s) => { const l = out.notes.get(z) ?? []; l.push(s); out.notes.set(z, l); };
  // never silent: a zone that asked for a farm pond but has no farm lot says so
  for (const z of asked) if (z.noFarm) note(z.zone.id, "farmPond: no farm lot in this zone (a lot whose villager use is 'farm', given or implied by its type), so no farm pond is added");
  const zones = asked.filter((z) => !z.noFarm);
  if (!zones.length) return out;
  if (waterInClaim(K.env)) {
    for (const z of zones) note(z.zone.id, 'farmPond: the claim has surface water, so no farm pond is added (S-H-1: dry claims only)');
    return out;
  }
  const r = K.r, env = K.env, S = env.S;
  const roles = fluidRolesOf(K.ctx);
  for (const z of zones) {
    for (const lid of z.lots) {
      const lot = r.lots.find((l) => l.id === lid || l.id.endsWith(`_${lid}`));
      if (!lot) { note(z.zone.id, `farmPond: ${lid} was not placed (no pond)`); continue; }
      // the water's first column past the box: the rim stands rimGap clear of it (M25:keep: a box grown by 1, and the rim's face
      // neighbours, stay clear)
      const b = lot.box, s = FARM_POND.side, gap0 = FARM_POND.rimGap + 2;
      const cx = (b.minX + b.maxX) >> 1, cz = (b.minZ + b.maxZ) >> 1;
      const front = lot.front;
      // candidates: behind the lot first, then its sides (west/east or north/south), centred on the box's side
      const sides = { north: [cx - 1, b.minZ - gap0 - s + 1], south: [cx - 1, b.maxZ + gap0], west: [b.minX - gap0 - s + 1, cz - 1], east: [b.maxX + gap0, cz - 1] };
      const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[front] ?? 'north';
      const order = [back, ...['north', 'east', 'south', 'west'].filter((d) => d !== back && d !== front)];
      let done = null, why = [];
      for (const side of order) {
        const [x0, z0] = sides[side];
        const a = rectOf(x0, z0, s, s);
        const site = farmSite(K, a, lot);
        if (site !== true) { why.push(`${side}: ${site}`); continue; }
        const fr = freezesAt(K.ctx, x0 + 1, S.groundAt(x0 + 1, z0 + 1) - 1, z0 + 1);
        if (fr.freezes) { why.push(`${side}: the biome freezes (${fr.biome}): a farm pond is never capped`); done = 'frozen'; break; }
        const m = bodiesMark(r);
        const cp = K.checkpoint();
        try {
          const rec = emitPond(r, { id: bodyId(lid, '_pond'), part: z.zone.id, kind: 'farm_pond', rect: a, shape: 'rect', depth: FARM_POND.depth, edge: 'natural', fluid: 'water', stage: K.stageOf('lots'), roles, ice: null });
          leakCheck(r, env, rec);
          K.mark(z.zone.id, K.addedSince(cp));
          out.ponds.push({ lot: lid, zone: z.zone.id, body: rec, side });
          done = rec;
          break;
        } catch (e) {
          K.rollback(cp);
          bodiesRollback(r, m);
          why.push(`${side}: ${e.message}`);
        }
      }
      if (done === 'frozen') note(z.zone.id, `farmPond: ${lid}'s pond is not added: ${why[why.length - 1].replace(/^[a-z]+: /, '')}`);
      else if (done) note(z.zone.id, `farmPond: ${lid} gets a 3x3 pond on its ${out.ponds[out.ponds.length - 1].side} side (its rim 2 from the lot's box, outside it)`);
      else note(z.zone.id, `farmPond: no room for ${lid}'s pond (${why.join('; ')})`);
    }
  }
  return out;
}

/** A farm pond's site: inside the claim's margin, level within 1, dry, clear of hard rects, and on columns the plan has not written. */
function farmSite(K, a, own) {
  const env = K.env, S = env.S;
  const g = grow(a, 2);
  if (!inside(g, grow(env.claim, -MARGIN))) return 'the claim\'s margin';
  if (env.hard.some((h) => meets(g, h))) return 'keep-out, a protected area, a build or another region';
  const st = rectSurvey(env, grow(a, 1));
  if (st.water || st.lava) return 'water';
  if (st.maxG - st.minG > 1) return 'not level';
  for (let x = g.minX; x <= g.maxX; x++) for (let z = g.minZ; z <= g.maxZ; z++) if (flagsAt(env, x, z) & (FLAG_TREE | FLAG_WATER | FLAG_LAVA)) return 'a tree';
  // nothing of the plan's own there yet (a lane, a lamp, a pad's batter, another lot's apron)
  const box = { minX: g.minX, maxX: g.maxX, minZ: g.minZ, maxZ: g.maxZ, minY: st.minG - 3, maxY: st.maxG + 4 };
  const lw = localWorld(K.r, box);
  for (let x = g.minX; x <= g.maxX; x++) for (let z = g.minZ; z <= g.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) if (lw.vw.flags(x, y, z) & F_WRITTEN) return `the plan already writes ${x} ${y} ${z}`;
  for (const l of K.r.lots) if (l !== own && meets(grow(a, 3), { minX: l.box.minX, minZ: l.box.minZ, maxX: l.box.maxX, maxZ: l.box.maxZ })) return `lot ${l.id}'s box`;
  return true;
}

// ------------------------------------------------------------------ the wet well (V's deferred; well water: true, off by default)

/**
 * A well with water (§7.6): the source 1 under the well's ring, in the shaft (the paving's centre cell), its floor and sides the shell
 * (written in the well's stage in `structure`), the 3x3 ring over it the rim. `well`: the props.mjs well ({id, cells}); `o`: {stage}.
 * The shaft's cauldron is left out by the caller (propCells(..., {water: true})).
 */
export function wetWell(r, well, { stage = 'props', id = null } = {}) {
  const ring = well.cells.filter((c) => c[3] && /water_cauldron/.test(c[3]) === false);
  const xs = well.cells.map((c) => c[0]), zs = well.cells.map((c) => c[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) >> 1, cz = (Math.min(...zs) + Math.max(...zs)) >> 1;
  const ringY = Math.min(...ring.filter((c) => c[0] !== cx || c[2] !== cz).map((c) => c[1]));
  const y = ringY - 1;
  const block = shellBlock(r.ctx.roles, 'structure');
  // ((6c KC, §5) the water cell is the square's plaza surface: cleared first (its own part), or the source's write (into air or a fluid
  // only) would leave the square's block in the body's cell, which M25:clear catches)
  const bid = id ?? `${well.id}_water`.slice(0, 40);
  const room = r.part(`${bid}_room`.slice(0, 48), { stage });
  room.columns({ abs: 0 }, { abs: 0 }, [cx, cz, y, y, 0], [null], { cond: 3 });
  (r.meta.parts[room.id] ??= {}).kind = 'carve';
  const rec = r.fluidBody([[cx, y, cz]], { id: bid, kind: 'well', stage, level: y, shellRole: (x, yy, z, where) => (where === 'rim' ? block : block) });
  return rec;
}

void centre; void gap; void arrRect;

/** (6c KC, §2) The footprint this part reserves at resolve (keep.mjs): its rect grown by its shell and a keep of 2 (lava: its fire keep). Pure: [[x0, z0, x1, z1]]. */
export function footprint(res) {
  return Array.isArray(res?.footprints) ? res.footprints.map((q) => [...q]) : [];
}
