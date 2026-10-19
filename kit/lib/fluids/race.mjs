// (6c HY) connector.channel as channel.race (a course with a lot in via: a wheel fall beside the lot) in the plan compiler (docs/CONTRACT.md
// "Phase 6c slice HY" §7.5, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs (hooks.mjs dispatches to it
// by channelBlock()). The signatures are course.mjs's (resolve, emit, answer); the answer gains `serves: {lot, side, fall: {at, drop}}`.
//
// The router passes the lot's side (the via's port when it names a side, n, e, s or w; else the side facing `to`) along a band 4 outside
// the lot's box (the race's banks 3 from it: its shell clear of the box grown by 1, K5, M25:keep), and the profile takes one fall of at
// least RACE.drop there: the wheel fall, its lip within 4 of the box. The wheel itself is the lot design's (inside its box), or a later
// prop: a region never writes in a lot box, and nothing turns. No fall fits by the lot: refused NO_ROOM with the plain course (the part
// without the lot in via) as the wouldFit.
import { planCourse, emit as courseEmit, answer as courseAnswer, laneOffsets, courseSpec } from './course.mjs';
import { planLotIds } from '../plan/schema.mjs';
import { centre, rectArr } from './place.mjs';

export const acceptsOverflow = true;
export const RACE = Object.freeze({ drop: 3, band: 4 });
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const cheb = (x, z, R) => Math.max(Math.max(0, R.minX - x, x - R.maxX), Math.max(0, R.minZ - z, z - R.maxZ));

/** The side of `rect` facing point `t`. */
function sideFacing(rect, t) {
  const [cx, cz] = centre(rect);
  const dx = t[0] - cx, dz = t[1] - cz;
  return Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'e' : 'w') : (dz >= 0 ? 's' : 'n');
}

/** The via goal along a lot's side: the band RACE.band outside the box on that side, the flow along it. */
function sideGoal(rect, side, offs) {
  // (the band's centre line: the lane nearest the box RACE.band from it)
  const b = side === 'n' || side === 'w' ? RACE.band + offs[offs.length - 1] : RACE.band - offs[0];
  const along = side === 'n' || side === 's' ? [0, 2] : [1, 3];
  const inBand = (x, z) => (side === 'n' ? z === rect.minZ - b && x >= rect.minX && x <= rect.maxX
    : side === 's' ? z === rect.maxZ + b && x >= rect.minX && x <= rect.maxX
      : side === 'w' ? x === rect.minX - b && z >= rect.minZ && z <= rect.maxZ : x === rect.maxX + b && z >= rect.minZ && z <= rect.maxZ);
  const box = side === 'n' ? { minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ - b, maxZ: rect.minZ - b } : side === 's' ? { minX: rect.minX, maxX: rect.maxX, minZ: rect.maxZ + b, maxZ: rect.maxZ + b }
    : side === 'w' ? { minX: rect.minX - b, maxX: rect.minX - b, minZ: rect.minZ, maxZ: rect.maxZ } : { minX: rect.maxX + b, maxX: rect.maxX + b, minZ: rect.minZ, maxZ: rect.maxZ };
  // (two cells into the band, so the lip has a straight run before and after it)
  return { box, col: inBand, test: (x, z, d) => inBand(x, z) && along.includes(d) && inBand(x - DIRS[d][0], z - DIRS[d][1]) && inBand(x - 2 * DIRS[d][0], z - 2 * DIRS[d][1]) };
}

/** Place the part: the course through the lot's side, a wheel fall of at least 3 beside it. */
export function resolve(C, p) {
  const part = p.part;
  const lots = planLotIds(C.plan);
  const vi = (part.via ?? []).findIndex((v) => v && typeof v.part === 'string' && lots.has(v.part));
  const v = part.via?.[vi];
  const plain = { ...part, via: (part.via ?? []).filter((_, i) => i !== vi) };
  if (!plain.via.length) delete plain.via;
  const g = v ? C.geomOf(v.part) : null;
  if (!g?.rect) return { klass: 'refused', notes: [], reasons: [{ code: 'NO_FEATURE', message: `a race's via names a lot of the plan, placed (${v?.part ?? 'none'})`, evidence: { via: v ?? null } }] };
  const rect = g.rect;
  const toPt = part.to?.anchor !== undefined ? C.env.anchors.get(part.to.anchor) : null;
  const side = ['n', 'e', 's', 'w'].includes(v.port) ? v.port : sideFacing(rect, toPt ?? centre(C.env.claim));
  const goal = sideGoal(rect, side, laneOffsets(courseSpec(part, 'channel.race').width));
  let serves = null;
  const adjust = (full) => {
    // the wheel fall's lip: the path's first index in the band past two straight cells (the via goal's index)
    const j = full.path.findIndex(([x, z], i) => i >= 2 && goal.col(x, z) && goal.col(...full.path[i - 1]) && goal.col(...full.path[i - 2]));
    if (j < 0) return { refused: { code: 'NO_ROOM', message: `the race does not pass ${v.part}'s ${side} side`, evidence: { lot: v.part, side } } };
    for (let i = j + 1; i < full.levels.length; i++) full.levels[i] = Math.min(full.levels[i], full.levels[j] - RACE.drop);
    serves = { lot: v.part, side, j };
    return null;
  };
  const res = planCourse(C, { ...p, part: { ...part, via: undefined } }, { block: 'channel.race', via: [goal], race: true, adjust });
  if (!(res.klass === 'fits' || res.klass === 'adjusted')) return res;
  // the wheel fall: a fall of at least 3 whose lip is within 4 of the box, outside it grown by 1
  const fall = res.geo.steps.find((s) => s.kind === 'fall' && s.drop >= RACE.drop && s.cells.every(([x, , z]) => cheb(x, z, rect) >= 2) && s.cells.some(([x, , z]) => cheb(x, z, rect) <= RACE.band));
  if (!fall) {
    const alone = planCourse(C, { ...p, part: plain });
    const wf = alone.klass === 'fits' || alone.klass === 'adjusted' ? [{ part: p.id, fragment: plain, geometry: { rect: rectArr(alone.rect), reaches: alone.geo.reaches.length }, cost: { cells: alone.geo.reaches.reduce((a, R) => a + R.cells.length, 0) } }] : undefined;
    return { klass: 'refused', notes: res.notes, reasons: [{ code: 'NO_ROOM', message: `no fall of at least ${RACE.drop} fits within ${RACE.band} of ${v.part}'s ${side} side, outside its box grown by 1 (the plain course is the wouldFit)`, evidence: { lot: v.part, side } }], ...(wf ? { wouldFit: wf } : {}) };
  }
  const mid = fall.cells[fall.cells.length >> 1];
  res.race = { serves: { lot: v.part, side, fall: { at: mid, drop: fall.drop } }, note: `serves ${v.part}: a wheel fall of ${fall.drop} on its ${side} side at ${mid.join(' ')} (the wheel is the lot design's, inside its box; nothing turns)` };
  void serves;
  return res;
}

/** Write the part: the course's. */
export function emit(K, p, res) {
  return courseEmit(K, p, res);
}

/** The part's answer fields: the course's, with `serves`; the lot's zone answer gets a note naming the side and the fall. */
export function answer(K, p, res) {
  const out = courseAnswer(K, p, res);
  if (out && res.race && !out.class) {
    const zid = K.lotZone?.get?.(res.race.serves.lot);
    const za = zid ? K.answers?.get?.(zid) : null;
    const note = `${res.race.serves.lot}: a mill race (${p.id}) has a wheel fall of ${res.race.serves.fall.drop} on its ${res.race.serves.side} side at ${res.race.serves.fall.at.join(' ')}; its design may face a wheel there (inside its box)`;
    if (za && !(za.notes ?? []).includes(note)) za.notes = [...(za.notes ?? []), note];
  }
  return out;
}
