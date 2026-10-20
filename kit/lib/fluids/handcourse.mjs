// (6c HY) HY-core's hand-built course (docs/CONTRACT.md "Phase 6c slice HY" §14, §15 step 1): the gate fixture `hy_core_demo` lays it
// through the plan compiler, so HY-core's foundation (the reach chain, plan-body joins, the overflow hook, the lining, the weir, the
// dependency order, the upstream drain, per-body guards) goes through Regions.checkPlan and realiseApproved in game before HY-b's router
// and profile exist. HY-core owns this file. A connector.channel whose ext 'architect_mc:unsafe' carries {handCourse: {role, origin,
// variant}} dispatches here (hooks.mjs); nothing else does, so no plan Claude writes reaches it. It must not import compile.mjs or
// program.mjs.
//
// The layout, along +x from `origin` [x, z] on level ground g (the survey's ground there), in a stone mound the course is cut into (a flat
// world has 3 cells of soil, so the falls stand on the plan's own ground):
//   mound   stone: A dx 1..12 (dz -4..8) to g + 7, B dx 13..22 to g + 4, C dx 23..33 to g + 3 (dz -4..4)
//   r1      the head reach (role stream, body <part>_r1): dx 2..11, dz -1..1, g + 5..g + 6, surface g + 6; its -x shell (dx 1) and a weir
//           course (dx 0, the lake's own wall rewritten) face a natural lake at its level (hyCoreLake: dx -6..-1, g + 5..g + 6)
//   fall    r1's outlet at dx 12 (lined), a falling column at dx 13 from g + 6 into r2: drop 3
//   r2      dx 13..21, g + 2..g + 3, surface g + 3
//   spill   r2's outlet at dx 22 (lined), a film over r3's first row: a spillway, drop 1
//   r3      the tail reach: dx 23..31, g + 1..g + 2, surface g + 2 (a terminal reach)
//   feed    (role feed, its own part: the body `w_<part>`) a 3x3 basin 1 deep on mound A (dx 8..10, dz 4..6, surface g + 8) that overflows
//           into r1 when a stream names it in `from` (the overflow hook): its outlet at dz 3, a lined spillway, a fall into r1 at dz 1
// Write order (§3.1): r3, r2, r1, feed. Variants (the gate's broken ones, §14): predict_short (r2's spill declared one cell short: the
// escape guard drains r2 and its upstream closure, r1 and feed), no_lining_cell (the floor lining under the feed's outlet left unwritten
// and carved open: the outlet's water falls into it), sand_lining (that lining cell in sand: M25:shell), thin_weir (r1 one cell nearer the lake, no weir course: its shell alone faces
// the lake: M25:shell, its breach M25:keep), wrong_order (`after` reversed: the head written first: M25:order; in game the head's fall
// pours into r2's empty basin and the escape guard drains it), flowing_state (r2 written as a flowing state: lint FLUID_STATE).
import { reachId, SOURCE_STATE } from './body.mjs';
import { bodyAnswer, bodyId } from './pond.mjs';
import { volumeAnswer, bodiesMark, bodiesRollback } from './place.mjs';
import { overflowsOn, registerOverflow, UNSAFE_EXT } from './hooks.mjs';

export const acceptsOverflow = true;
export const VARIANTS = Object.freeze(['none', 'predict_short', 'no_lining_cell', 'sand_lining', 'thin_weir', 'wrong_order', 'flowing_state']);
const MOUND = 'minecraft:stone', SHELL = 'minecraft:stone_bricks', BED = 'minecraft:clay', WEIR = 'minecraft:mossy_stone_bricks', LINING = 'minecraft:polished_andesite';

/** The hand course's spec on a part (its ext), or null. */
export function handSpec(part) {
  const h = part?.ext?.[UNSAFE_EXT]?.handCourse;
  if (!h || typeof h !== 'object') return null;
  const role = h.role === 'feed' ? 'feed' : 'stream';
  const origin = Array.isArray(h.origin) && h.origin.length === 2 && h.origin.every(Number.isInteger) ? h.origin : null;
  const variant = VARIANTS.includes(h.variant) ? h.variant : 'none';
  return { role, origin, variant };
}

const box = (x0, y0, z0, x1, y1, z1) => { const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]); return out; };

/** The natural lake beside the head (the gate /fills it; kit tests synthesize it): {wall: [x0, y0, z0, x1, y1, z1] (stone), water: [...]}. */
export function hyCoreLake([ox, oz], g) {
  return { wall: [ox - 7, g + 1, oz - 4, ox, g + 6, oz + 4], water: [ox - 6, g + 5, oz - 3, ox - 1, g + 6, oz + 3], level: g + 6 };
}

/** The footprint of the layout (the lake included): [x0, z0, x1, z1]. */
export function hyCoreFootprint([ox, oz]) {
  return [ox - 8, oz - 5, ox + 34, oz + 9];
}

/**
 * The layout's geometry from an origin [x, z] and its ground g: {mound: [{box, block}], carve: [box], reaches: [{k, cells, level, outlets,
 * lining, weir, joins, after, shellRole}], feed: {cells, level, overflow}}. Absolute cells.
 */
export function hyCoreLayout([ox, oz], g, variant = 'none', part = 'stream') {
  const X = (dx) => ox + dx, Y = (dy) => g + dy, Z = (dz) => oz + dz;
  const thin = variant === 'thin_weir';
  const ids = [1, 2, 3].map((k) => reachId(part, k));
  const mound = [
    { box: [X(1), Y(1), Z(-4), X(12), Y(7), Z(8)], block: MOUND },
    { box: [X(13), Y(1), Z(-4), X(22), Y(4), Z(4)], block: MOUND },
    { box: [X(23), Y(1), Z(-4), X(33), Y(3), Z(4)], block: MOUND },
  ];
  const r1x0 = thin ? 1 : 2;
  // the basins with their open tops, the lip and the fall's slot (r2's open top at dx 13 is in r2's carve)
  const carve = [
    [X(r1x0), Y(5), Z(-1), X(11), Y(7), Z(1)],
    [X(12), Y(6), Z(-1), X(12), Y(7), Z(1)],
    [X(13), Y(2), Z(-1), X(21), Y(4), Z(1)],
    [X(22), Y(3), Z(-1), X(22), Y(4), Z(1)],
    [X(23), Y(1), Z(-1), X(31), Y(3), Z(1)],
  ];
  const lanes = [-1, 0, 1].map(Z);
  const r1 = { k: 1, id: ids[0], cells: box(X(r1x0), Y(5), Z(-1), X(11), Y(6), Z(1)), level: Y(6),
    outlets: lanes.map((z) => [X(12), Y(6), z]),
    lining: [[X(12), Y(6), Z(2)], [X(12), Y(6), Z(-2)]],
    weir: thin ? [] : lanes.flatMap((z) => [[X(0), Y(5), z], [X(0), Y(6), z]]),
    joins: [{ body: ids[1], cells: lanes.map((z) => [X(13), Y(3), z]) }] };
  const r2 = { k: 2, id: ids[1], cells: box(X(13), Y(2), Z(-1), X(21), Y(3), Z(1)), level: Y(3),
    outlets: lanes.map((z) => [X(22), Y(3), z]),
    lining: [[X(22), Y(3), Z(2)], [X(22), Y(3), Z(-2)]],
    weir: [], joins: [{ body: ids[2], cells: lanes.map((z) => [X(23), Y(2), z]) }] };
  // (the spillway's lip at dx 22 is r3's inlet: no rim of r3's over it)
  const r3 = { k: 3, id: ids[2], cells: box(X(23), Y(1), Z(-1), X(31), Y(2), Z(1)), level: Y(2), outlets: lanes.map((z) => [X(22), Y(3), z]), lining: [], weir: [], joins: [] };
  const reaches = [r1, r2, r3];
  for (const r of reaches) r.after = r.joins.map((j) => j.body);
  if (variant === 'wrong_order') { r1.after = []; r2.after = [ids[0]]; r3.after = [ids[1]]; }
  // the feed: a 3x3 basin 1 deep on mound A, its overflow (outlet dz 3, lined) falling into r1 at dz 1
  // (dx 8..10: its single breach spreads at most 7 over the mound's top, never off its west edge onto the lake)
  const feed = { cells: box(X(8), Y(8), Z(4), X(10), Y(8), Z(6)), level: Y(8),
    overflow: { cells: [[X(9), Y(8), Z(3)]], lining: [[X(9), Y(7), Z(3)], [X(8), Y(8), Z(3)], [X(10), Y(8), Z(3)], [X(8), Y(8), Z(2)], [X(10), Y(8), Z(2)]], into: { body: ids[0], cells: [[X(9), Y(6), Z(1)]] } } };
  return { mound, carve, reaches, feed, ids };
}

const shellRoleOf = (variant, lip) => (x, y, z, where) => {
  if (where === 'weir') return WEIR;
  if (where === 'lining') return variant === 'sand_lining' && lip && x === lip[0] && y === lip[1] && z === lip[2] ? 'minecraft:sand' : LINING;
  return where === 'rim' ? SHELL : BED;
};

/** Place the part: fits on its footprint; a stream whose `from` names another hand course registers an overflow on it (§1.5). */
export function resolve(C, p) {
  const sp = handSpec(p.part);
  if (!sp?.origin) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: 'a hand course needs ext architect_mc:unsafe.handCourse.origin [x, z]', evidence: {} }] };
  // (the ground beside the mound, clear of the lake the gate builds at the origin)
  const g = C.env.S.groundAt(sp.origin[0] + 16, sp.origin[1] + 7);
  const fp = hyCoreFootprint(sp.origin);
  const rect = { minX: fp[0], minZ: fp[1], maxX: fp[2], maxZ: fp[3] };
  const notes = [`architect_mc:unsafe handCourse (${sp.role}, ${sp.variant}): HY-core's hand-built gate course`];
  if (sp.role === 'stream' && typeof p.part.from?.part === 'string') {
    const L = hyCoreLayout(sp.origin, g, sp.variant, p.id);
    const ok = registerOverflow(C, { from: p.part.from.part, course: p.id, cells: L.feed.overflow.cells, lining: L.feed.overflow.lining, into: L.feed.overflow.into });
    notes.push(ok ? `overflow registered on ${p.part.from.part}` : `${p.part.from.part} takes no overflow: the head is a dry end`);
  }
  return { klass: 'fits', rect, footprints: [fp], spec: sp, g, notes };
}

/** Write the part: the mound, the carve and the reaches (a stream), or the feed basin with its overflows (a feed). */
export function emit(K, p, res) {
  const r = K.r, sp = res.spec;
  const m = bodiesMark(r);
  try {
    const stage = K.stageOf('ground');
    const L = hyCoreLayout(sp.origin, res.g, sp.variant, p.id);
    const bodies = [];
    if (sp.role === 'stream') {
      const mound = r.part(`${p.id}_mound`.slice(0, 48), { stage });
      for (const q of L.mound) {
        const [x0, y0, z0, x1, y1, z1] = q.box;
        const cols = [];
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.push(x, z, y0, y1, 0);
        mound.columns({ abs: 0 }, { abs: 0 }, cols, [q.block], { cond: 3 });
      }
      const carve = r.part(`${p.id}_carve`.slice(0, 48), { stage });
      const cols = [];
      for (const [x0, y0, z0, x1, y1, z1] of L.carve) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.push(x, z, y0, y1, 0);
      carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 3 });
      // downstream first (each reach's flow sees the reach below it as water: its plan join)
      for (const q of [...L.reaches].reverse()) {
        const unsafe = {};
        if (sp.variant === 'predict_short' && q.k === 2) unsafe.predictShort = true;
        if (sp.variant === 'flowing_state' && q.k === 2) unsafe.flowingState = true;
        if (sp.variant === 'wrong_order') unsafe.after = q.after;
        const rec = r.fluidBody(q.cells, { id: q.id, part: p.id, kind: 'course', stage, level: q.level, outlets: q.outlets, lining: q.lining, weir: q.weir, joins: q.joins, shellRole: shellRoleOf(sp.variant, q.k === 1 ? q.lining[0] : null), _unsafe: Object.keys(unsafe).length ? unsafe : null });
        bodies.unshift(rec);
      }
      const steps = [{ kind: 'fall', from: L.ids[0], to: L.ids[1], drop: 3 }, { kind: 'spillway', from: L.ids[1], to: L.ids[2], drop: 1 }];
      (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind: 'course', look: 'built', flow: 'pools', bodies: L.ids, steps, ends: [{ end: 'from', kind: typeof p.part.from?.part === 'string' ? 'overflow' : 'weir', ref: p.part.from?.part ?? 'lake' }, { end: 'to', kind: 'pool', ref: L.ids[2] }] });
    } else {
      const ov = overflowsOn(K, p.id);
      // (no_lining_cell: the spillway's floor under the outlet carved open and left unwritten, still declared: the outlet's water falls
      // into it, outside the feed's cells and spill)
      const hole = sp.variant === 'no_lining_cell' && ov.length ? L.feed.overflow.lining[0] : null;
      if (hole) r.part(`${p.id}_hole`.slice(0, 48), { stage }).columns({ abs: 0 }, { abs: 0 }, [hole[0], hole[2], hole[1], hole[1], 0], [null], { cond: 3 });
      const rec = r.fluidBody(L.feed.cells, { id: bodyId(p.id), part: p.id, kind: 'pond', stage, level: L.feed.level, overflow: ov, raised: ov.length > 0, shellRole: shellRoleOf('none', null), _unsafe: hole ? { noLiningCell: hole } : null });
      bodies.push(rec);
    }
    res.emitted = { bodies, notes: [] };
  } catch (e) {
    bodiesRollback(r, m);
    if (r.meta.courses) { r.meta.courses = r.meta.courses.filter((c) => c.part !== p.id); if (!r.meta.courses.length) delete r.meta.courses; }
    throw e;
  }
}

/** The answer's fields: the bodies (one per reach), the volume answer first. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { block: res.spec.role === 'stream' ? 'channel.course' : 'form.pond', hand: res.spec.variant } });
}

void SOURCE_STATE;
