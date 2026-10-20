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

/**
 * The via goals along a lot's side: the band RACE.band outside the box on that side (its lane nearest the box at RACE.band), entered at
 * the end nearer `from` and left at the other, the flow along it: [enter, leave] goals and the band's cells.
 */
function sideGoals(rect, side, offs, from) {
  const b = side === 'n' || side === 'w' ? RACE.band + offs[offs.length - 1] : RACE.band - offs[0];
  const ns = side === 'n' || side === 's';
  const line = ns ? (side === 'n' ? rect.minZ - b : rect.maxZ + b) : (side === 'w' ? rect.minX - b : rect.maxX + b);
  const lo = (ns ? rect.minX : rect.minZ) - 1, hi = (ns ? rect.maxX : rect.maxZ) + 1;
  const cell = (t) => (ns ? [t, line] : [line, t]);
  const fromT = from ? (ns ? from[0] : from[1]) : lo;
  const [t0, t1] = Math.abs(fromT - lo) <= Math.abs(fromT - hi) ? [lo, hi] : [hi, lo];
  const dAlong = ns ? (t1 > t0 ? 0 : 2) : (t1 > t0 ? 1 : 3);
  const at = (t, dir) => { const [x0, z0] = cell(t); return { box: { minX: x0, maxX: x0, minZ: z0, maxZ: z0 }, col: (x, z) => x === x0 && z === z0, test: (x, z, d) => x === x0 && z === z0 && (dir < 0 || d === dir) }; };
  const inBand = (x, z) => (ns ? z === line && x >= Math.min(t0, t1) && x <= Math.max(t0, t1) : x === line && z >= Math.min(t0, t1) && z <= Math.max(t0, t1));
  // (the second leg keeps to the band: the course runs straight along the lot's side)
  return { goals: [at(t0, -1), { ...at(t1, dAlong), corridor: (x, z) => inBand(x, z) }], inBand };
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
  const fromPt = part.from?.anchor !== undefined ? C.env.anchors.get(part.from.anchor) : null;
  const sg = sideGoals(rect, side, laneOffsets(courseSpec(part, 'channel.race').width), fromPt);
  // the wheel fall's lip: an index of the course's run along the band, the middle first, then outwards (the first whose profile fits)
  let res = null;
  for (let t = 0; t < 7; t++) {
    const adjust = (full) => {
      const idx = full.path.map((c, i) => (sg.inBand(c[0], c[1]) ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 4) return { refused: { code: 'NO_ROOM', message: `the race does not pass ${v.part}'s ${side} side`, evidence: { lot: v.part, side } } };
      const m = idx.length >> 1, off = t === 0 ? 0 : (t % 2 ? 1 : -1) * ((t + 1) >> 1);
      const j = idx[Math.max(1, Math.min(idx.length - 2, m + off))];
      for (let i = j + 1; i < full.levels.length; i++) full.levels[i] = Math.min(full.levels[i], full.levels[j] - RACE.drop);
      return null;
    };
    res = planCourse(C, { ...p, part: { ...part, via: undefined } }, { block: 'channel.race', via: sg.goals, race: { lot: v.part }, adjust });
    if (res.klass === 'fits' || res.klass === 'adjusted' || res.reasons?.[0]?.evidence?.kind !== 'cut') break;
  }
  const plainWf = () => {
    const alone = planCourse(C, { ...p, part: plain });
    return alone.klass === 'fits' || alone.klass === 'adjusted' ? [{ part: p.id, fragment: plain, geometry: { rect: rectArr(alone.rect), reaches: alone.geo.reaches.length }, cost: { cells: alone.geo.reaches.reduce((a, R) => a + R.cells.length, 0) } }] : undefined;
  };
  if (!(res.klass === 'fits' || res.klass === 'adjusted')) {
    // (the race's own failures by the lot, and a route that can't pass its side: no wheel fall fits there)
    const kind = res.reasons?.[0]?.evidence?.kind;
    if (res.reasons?.[0]?.code === 'UNREACHABLE' && ['blocked', 'cut', 'length'].includes(kind) || res.reasons?.[0]?.code === 'NO_ROOM') {
      const wf = plainWf();
      return { klass: 'refused', notes: res.notes, reasons: [{ code: 'NO_ROOM', message: `no wheel fall of at least ${RACE.drop} fits by ${v.part}'s ${side} side (${res.reasons[0].message})`, evidence: { lot: v.part, side, why: kind ?? res.reasons[0].code } }], ...(wf ? { wouldFit: wf } : {}) };
    }
    return res;
  }
  // the wheel fall: a fall of at least 3 whose lip is within 4 of the box, outside it grown by 1
  const fall = res.geo.steps.find((s) => s.kind === 'fall' && s.drop >= RACE.drop && s.cells.every(([x, , z]) => cheb(x, z, rect) >= 2) && s.cells.some(([x, , z]) => cheb(x, z, rect) <= RACE.band));
  if (!fall) {
    const alone = planCourse(C, { ...p, part: plain });
    const wf = alone.klass === 'fits' || alone.klass === 'adjusted' ? [{ part: p.id, fragment: plain, geometry: { rect: rectArr(alone.rect), reaches: alone.geo.reaches.length }, cost: { cells: alone.geo.reaches.reduce((a, R) => a + R.cells.length, 0) } }] : undefined;
    return { klass: 'refused', notes: res.notes, reasons: [{ code: 'NO_ROOM', message: `no fall of at least ${RACE.drop} fits within ${RACE.band} of ${v.part}'s ${side} side, outside its box grown by 1 (the plain course is the wouldFit)`, evidence: { lot: v.part, side } }], ...(wf ? { wouldFit: wf } : {}) };
  }
  const mid = fall.cells[fall.cells.length >> 1];
  res.race = { serves: { lot: v.part, side, fall: { at: mid, drop: fall.drop } }, note: `serves ${v.part}: a wheel fall of ${fall.drop} on its ${side} side at ${mid.join(' ')} (the wheel is the lot design's, inside its box; nothing turns)` };
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
