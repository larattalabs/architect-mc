// (6c H) form.fountain in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §7, §8, §15). Slice H-a owns this file; it must not
// import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): place the part. res = {klass: 'fits' | 'adjusted' | 'refused' |
//                                 'incomplete', rect?, footprints?: [[x0, z0, x1, z1]] (what later zones and forms keep off), reasons?,
//                                 deviations?, notes?, wouldFit?}; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass,
//                                 tolOf, judge, notes, taken: the rects of the zones and forms placed before it}
//   emit(K, p, res)               compile step 3 (before the routes, so the route pass sees its water): write it (r.fluidBody for a
//                                 body, its shell in its own stage); throw 'CODE: message' to refuse it (the part rolls back)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields ({geometry, cost, notes, deviations}) over the default, or null
// (H-a, additive) emitFountain(r, o): the generator, for bundled programs (water_demo).
//
// The fountain (§7.2): a built basin `basin` x `basin` (odd, default 5) of sources 1 deep, raised 1 over the ground (its floor at the
// site's lowest ground, written), its side ring in `structure` and its rim (the course over the water) in `fluids.coping`; a 1x1 pillar
// of `fluids.spout` in its centre rising `spout` (default 2) over the rim with one source on top (a second body) whose four sides fall
// into the basin (the spill: the basin cells under them are sources, so nothing spreads). The single breach (§2.5): the raised basin
// passes when its breach reach meets nothing the plan may not flood; else the generator thickens the coping to 2 (an outer ring, the
// floor under it written) and tries again; failing that, LEAK.
import { VC, classAt } from '../region/volume.mjs';
import { bodiesMark, bodiesRollback, centre, fluidRolesOf, grow, intIn, linesBody, locatorOf, locatorRefusal, protectedMet, reachMeetsKeep, readParams, rectArr,
  rectOf, rectSurvey, scanRects, shellBlock, sketchPoint, spawnAvoid, takenRects, volumeAnswer, volumeKeep, refusal, leakRefusal } from './place.mjs';
import { shellCheck, bodyAnswer, bodyId, iceFor, naturalOf, shellStatesOf } from './pond.mjs';
import { overflowsOn } from './hooks.mjs';

const k3 = (x, y, z) => `${x},${y},${z}`;
/** (6c HY, §1.5) A fountain may feed a course (an overflow from its basin) or receive one (a fall over its coping). */
export const acceptsOverflow = true;
export const FOUNTAIN = Object.freeze({ basin: 5, spout: 2, maxRough: 1 });

/** The fountain's members (first-class, then params leniently: basin, spout, fluid for R22). */
export function fountainSpec(part) {
  const pr = readParams(part, {
    basin: { read: (v) => (Number.isInteger(v) && v >= 3 && v <= 9 && v % 2 === 1 ? v : undefined), why: 'not an odd 3..9' },
    spout: { read: intIn(1, 4), why: 'not 1..4' },
    fluid: { read: (v) => (v === 'water' || v === 'lava' ? v : undefined), why: 'not water or lava' },
  }, { noted: { material: "not read (the bible's fluids roles style the fountain)" } });
  return { basin: part.basin ?? pr.read.basin ?? FOUNTAIN.basin, spout: part.spout ?? pr.read.spout ?? FOUNTAIN.spout, fluid: pr.read.fluid ?? 'water', notes: pr.notes };
}

/** Place the part: a level square of basin + 4 (the coping's room for 2 thick), from its locator. */
export function resolve(C, p) {
  const env = C.env, part = p.part;
  const sp = fountainSpec(part);
  // R22: lava only on form.pond (a fountain is water): refused FIRE, the water shape as the wouldFit
  if (sp.fluid === 'lava') {
    const water = resolve(C, { ...p, part: { ...part, params: Object.fromEntries(Object.entries(part.params ?? {}).filter(([k]) => k !== 'fluid')) } });
    const wf = water.klass === 'fits' || water.klass === 'adjusted' ? [{ part: p.id, fragment: { ...part, params: Object.fromEntries(Object.entries(part.params ?? {}).filter(([k]) => k !== 'fluid')) }, geometry: { rect: rectArr(water.rect) }, cost: { cells: (water.rect.maxX - water.rect.minX + 1) * (water.rect.maxZ - water.rect.minZ + 1) } }] : undefined;
    return { klass: 'refused', notes: sp.notes, wouldFit: wf, reasons: [{ code: 'FIRE', message: 'lava is allowed only in a lined pit (form.pond, R22): a fountain holds water', evidence: { kind: 'lava' } }] };
  }
  const loc = locatorOf(env, part.where, C.geomOf);
  if (loc.error) return locatorRefusal(part, loc);
  const tMove = C.tolOf(part, 'move');
  const sk = sketchPoint(env, part.sketch);
  const S = sp.basin + 4;
  const ok = (a) => { const st = rectSurvey(env, grow(a, 1)); return st.water || st.lava ? 'water' : st.maxG - st.minG > FOUNTAIN.maxRough ? 'rough' : true; };
  const scan = (o) => scanRects(env, S, S, loc, { sketch: sk, obstacles: takenRects(C, 1), maxMove: tMove.ceiling, keep: 1, limit: 1, avoid: spawnAvoid(C), ok, ...o })[0];
  const c = scan({});
  if (!c) {
    const raw = scan({ keep: 0, obstacles: [], ok: () => true, hard: false });
    const met = raw ? protectedMet(env, grow(raw.rect, 1)) : null;
    if (met) return { klass: 'refused', notes: sp.notes, reasons: [{ code: 'PROTECTED', message: `the fountain would meet ${met.kind}${met.id ? ` ${met.id}` : ''}`, evidence: { ...met, at: rectArr(raw.rect) } }] };
    return { klass: 'refused', notes: sp.notes, reasons: [{ code: 'NO_ROOM', message: `no level, dry ${S}x${S} place for the fountain (its basin ${sp.basin} and a coping up to 2 thick) within its locator`, evidence: { size: [S, S] } }] };
  }
  const j = C.judge([{ what: 'move', value: c.move, ...tMove }, ...(sk ? [{ what: 'sketch', value: c.sketch, ...C.tolOf(part, 'sketch') }] : [])]);
  return {
    klass: j.klass, rect: c.rect, footprints: [rectArr(grow(c.rect, 1))], deviations: j.deviations, notes: sp.notes,
    reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [],
    spec: sp,
  };
}

/**
 * Write a fountain over `rect` (basin + 4 square: the outer ring is the coping's second course, written only when `thick` is 2).
 * `o`: {id, part, rect, basin, spout, thick (1 | 2), stage, roles, ice}. Returns {basin: record, spout: record, floor, top, thick}.
 */
export function emitFountain(r, o) {
  const S = r.ctx.survey;
  const [cx, cz] = centre(o.rect);
  const h = o.basin >> 1;
  let f = Infinity;
  for (let x = cx - h - 2; x <= cx + h + 2; x++) for (let z = cz - h - 2; z <= cz + h + 2; z++) f = Math.min(f, S.groundAt(x, z));
  const wy = f + 1, top = f + 2 + o.spout;
  const roles = o.roles, all = r.ctx.roles;
  const structure = shellBlock(all, 'structure');
  const coping = linesBody(roles.coping.block) ? roles.coping.block : structure;
  const spoutB = linesBody(roles.spout.block) ? roles.spout.block : structure;
  const basinCells = [];
  for (let x = cx - h; x <= cx + h; x++) for (let z = cz - h; z <= cz + h; z++) if (x !== cx || z !== cz) basinCells.push([x, wy, z]);
  // the basin's room: everything over the floor in its square (the water cells and up to the column's top), IF_NATURAL
  const carve = [];
  for (let x = cx - h - (o.thick === 2 ? 2 : 1); x <= cx + h + (o.thick === 2 ? 2 : 1); x++) for (let z = cz - h - (o.thick === 2 ? 2 : 1); z <= cz + h + (o.thick === 2 ? 2 : 1); z++) {
    const t = S.topAt(x, z);
    if (t >= wy) carve.push(x, z, wy, t, 0);
  }
  const cut = r.part(`${o.id}_room`.slice(0, 48), { stage: o.stage });
  if (carve.length) cut.columns({ abs: 0 }, { abs: 0 }, carve, [null], { cond: 0 });
  (r.meta.parts[cut.id] ??= {}).kind = 'carve';
  // the pillar: the floor's centre up to the cell under the spout's source; the second coping course (thick 2): the outer ring, from
  // the floor up to the rim
  const solid = r.part(`${o.id}_works`.slice(0, 48), { stage: o.stage });
  const cols = [];
  const mats = [spoutB, structure, coping];
  cols.push(cx, cz, f, top - 1, 0);
  if (o.thick === 2) {
    for (let x = cx - h - 2; x <= cx + h + 2; x++) for (let z = cz - h - 2; z <= cz + h + 2; z++) {
      if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) !== h + 2) continue;
      cols.push(x, z, f, f + 1, 1);
      if (!(x === cx && Math.abs(z - cz) === h + 2)) cols.push(x, z, f + 2, f + 2, 2);
    }
  }
  solid.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: 3 });
  (r.meta.parts[solid.id] ??= {}).kind = 'add';
  const pillar = [];
  for (let y = f; y <= top - 1; y++) pillar.push([cx, y, cz]);
  const natural = naturalOf(r, o.rect, f - 2, top + 1);
  const pick = (x, y, z, chain) => chain.find((b) => b && String(b).replace(/\[.*$/, '') !== natural(x, y, z)) ?? chain[chain.length - 1];
  const shellRole = (x, y, z, where) => (x === cx && z === cz ? spoutB : where === 'rim' ? pick(x, y, z, [coping, structure, 'minecraft:stone_bricks']) : pick(x, y, z, [structure, 'minecraft:stone_bricks', 'minecraft:cobblestone']));
  // the exits: a notch in the coping on two opposite sides (both courses when it is 2 thick): a swimmer steps onto the side ring and
  // down to the ground
  const exits = [[cx, wy + 1, cz - h - 1], [cx, wy + 1, cz + h + 1]];
  // ((6c HY, §1.5) a course leaving the fountain: its overflows, only when there are any)
  const ov = Array.isArray(o.overflow) && o.overflow.length ? { overflow: o.overflow, raised: true } : {};
  const basin = r.fluidBody(basinCells, { id: o.id, part: o.part ?? null, kind: 'fountain', stage: o.stage, level: wy, shellRole, solid: pillar, ice: o.ice ?? null, outlets: exits, ...ov });
  const basinSet = new Set(basinCells.map((c) => k3(...c)));
  const outlets = [[cx + 1, top, cz], [cx - 1, top, cz], [cx, top, cz + 1], [cx, top, cz - 1]];
  const spout = r.fluidBody([[cx, top, cz]], { id: `${o.id}_spout`.slice(0, 48), part: o.part ?? null, kind: 'fountain', stage: o.stage, level: top, outlets, shellRole: spoutB, solid: pillar,
    world: (x, y, z) => (basinSet.has(k3(x, y, z)) ? 'water' : null) });
  basin.shellStates = shellStatesOf(basin, shellRole);
  spout.shellStates = [];
  if (o.thick === 2) for (let i = 0; i < 4 * (o.basin + 3); i++) basin.shellStates.push(structure, structure, ...(i < 2 ? [] : [coping]));
  return { basin, spout, floor: f, top, thick: o.thick };
}

/** Write the part: a 1-thick coping when the single breach passes, else 2 thick; LEAK when neither does. */
export function emit(K, p, res) {
  const r = K.r, env = K.env, sp = res.spec;
  const vk = volumeKeep(r, VC, classAt);
  const notes = [];
  // a fountain in a freezing biome: its basin capped (R23), its spout left open (a falling source re-fills it; noted)
  const S = r.ctx.survey;
  const [cx, cz] = centre(res.rect);
  const h = sp.basin >> 1;
  let f = Infinity;
  for (let x = cx - h - 2; x <= cx + h + 2; x++) for (let z = cz - h - 2; z <= cz + h + 2; z++) f = Math.min(f, S.groundAt(x, z));
  const surface = [];
  for (let x = cx - h; x <= cx + h; x++) for (let z = cz - h; z <= cz + h; z++) if (x !== cx || z !== cz) surface.push([x, f + 1, z]);
  const dec = iceFor(K.ctx, surface, p.part.ice);
  if (dec.refuse) throw refusal(dec.refuse.code, dec.refuse.message, dec.refuse.evidence);
  // (the spout's spill lands on the basin: under an ice cap the falling water would meet ice, so a capped fountain keeps the four
  // cells under the spout open)
  const ice = dec.ice ? dec.ice.filter(([x, , z]) => Math.abs(x - cx) + Math.abs(z - cz) !== 1) : null;
  notes.push(...dec.notes);
  let last = null;
  for (const thick of [1, 2]) {
    const m = bodiesMark(r);
    const cp = K.checkpoint();
    try {
      const out = emitFountain(r, { id: bodyId(p.id), part: p.id, rect: res.rect, basin: sp.basin, spout: sp.spout, thick, stage: K.stageOf('forms'), roles: fluidRolesOf(K.ctx), ice, overflow: overflowsOn(K, p.id) });
      for (const rec of [out.basin, out.spout]) {
        const hit = reachMeetsKeep(r, env, rec, { volClass: vk });
        if (hit) throw leakRefusal(rec, hit);
      shellCheck(r, rec);
      }
      if (thick === 2) notes.push('the coping is 2 thick: a 1-thick coping\'s single breach would reach what the plan may not flood');
      res.emitted = { bodies: [out.basin, out.spout], notes, thick, floor: out.floor, top: out.top };
      return;
    } catch (e) {
      K.rollback(cp);
      bodiesRollback(r, m);
      last = e;
      if (!/^LEAK: /.test(e.message)) throw e;
    }
  }
  throw last;
}

/** The answer's fields. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { basin: res.spec.basin, spout: res.spec.spout, coping: e.thick, floor: e.floor, top: e.top } });
}

void rectOf;
