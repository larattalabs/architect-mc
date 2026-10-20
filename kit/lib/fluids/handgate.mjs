// (6c HY-c) The hand-laid water gate (docs/CONTRACT.md "Phase 6c slice HY" §8.3, §14 items 9 and 14): HY-c's gate fixture, a still reach
// laid straight across a planned K1 wall through the plan compiler, so the water gate (the crossing, the grate, the lintel, closure and
// gates.max) goes through Regions.checkPlan and realiseApproved in game before HY-b's router exists. HY-c owns this file. A
// connector.channel whose ext 'architect_mc:unsafe' carries {handGate: {wall, at: [x, z], width?, depth?, beyond?, variant?}} dispatches
// here (hooks.mjs); nothing else does, so no plan Claude writes reaches it. It must not import compile.mjs or program.mjs.
//
// Emit (step 3, after planWalls): gate.mjs reachAcross lays the reach across `wall` at its free straight run nearest `at` (`width` 1..3
// positions, `beyond` 2..6 cells past each face, `depth` 1..3 under a surface 1 under the lowest ground: sunk 1 under the lower bank), the
// cells and the open top carved in the ground stage; gate.mjs waterGate checks and registers the crossing (UNREACHABLE {kind: wall} for
// a sealed wall, one at its gates.max, ...); r.fluidBody writes the reach (kind course, its grate). Variants: `no_grate` (the crossing
// registered and the lintel laid, the water under it left open: the in-game negative control of item 14).
import { reachId } from './body.mjs';
import { bodyAnswer, shellStatesOf } from './pond.mjs';
import { volumeAnswer, bodiesMark, bodiesRollback } from './place.mjs';
import { reachAcross, waterGate, grateState } from './gate.mjs';
import { bomOf } from '../connectors/bom.mjs';

export const acceptsOverflow = false;
export const VARIANTS = Object.freeze(['none', 'no_grate']);
const UNSAFE = 'architect_mc:unsafe';

/** The hand gate's spec on a part (its ext), or null. */
export function handGateSpec(part) {
  const h = part?.ext?.[UNSAFE]?.handGate;
  if (!h || typeof h !== 'object' || typeof h.wall !== 'string') return null;
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const at = Array.isArray(h.at) && h.at.length === 2 && h.at.every(Number.isInteger) ? h.at : null;
  return { wall: h.wall, at, width: int(h.width, 1, 3, 3), depth: int(h.depth, 1, 3, 2), beyond: int(h.beyond, 2, 6, 3), variant: VARIANTS.includes(h.variant) ? h.variant : 'none' };
}

/** Place the part: it is laid at emit, once the walls are planned (step 3). */
export function resolve(C, p) {
  void C;
  const sp = handGateSpec(p.part);
  if (!sp?.at) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: 'a hand gate needs ext architect_mc:unsafe.handGate {wall, at: [x, z]}', evidence: {} }] };
  return { klass: 'fits', spec: sp, notes: [`architect_mc:unsafe handGate (${sp.variant}): HY-c's hand-laid water gate across wall ${sp.wall}`] };
}

/** Write the part: the reach across the wall (its carve, its grate) and the crossing. Throws 'CODE: message' to refuse it. */
export function emit(K, p, res) {
  const r = K.r, sp = res.spec;
  const L = reachAcross(K, sp.wall, sp.at, { width: sp.width, beyond: sp.beyond, depth: sp.depth });
  if (L.error) { const e = new Error(`${L.error.code}: ${L.error.message}`); e.evidence = L.error.evidence; throw e; }
  const id = reachId(p.id, 1);
  const gate = waterGate(K, { course: p.id, body: id, cells: L.cells, level: L.level });
  const m = bodiesMark(r);
  try {
    const stage = K.stageOf('ground');
    const carve = r.part(`${p.id}_carve`.slice(0, 48), { stage });
    const cols = [];
    for (const [x, z] of L.columns) cols.push(x, z, L.level - sp.depth + 1, L.level + 1, 0);
    carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 3 });
    const roles = K.ctx.roles ?? {};
    const wallBlock = roles.structure ?? 'minecraft:stone_bricks', bed = roles.foundation ?? wallBlock;
    const shellRole = (x, y, z, where) => (where === 'floor' ? bed : wallBlock);
    const rec = r.fluidBody(L.cells, { id, part: p.id, kind: 'course', stage, level: L.level, grate: sp.variant === 'no_grate' ? [] : gate.grate, shellRole });
    rec.shellStates = shellStatesOf(rec, shellRole);
    const grateN = sp.variant === 'no_grate' ? 0 : gate.grate.length;
    (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind: 'course', look: 'built', flow: 'level', bodies: [id], steps: [], ends: [{ end: 'from', kind: 'pool', ref: id }, { end: 'to', kind: 'pool', ref: id }], waterGates: gate.crossings.map((q) => q.wall) });
    res.emitted = { bodies: [rec], gate, grateN, L };
  } catch (e) {
    bodiesRollback(r, m);
    if (r.meta.courses) { r.meta.courses = r.meta.courses.filter((c) => c.part !== p.id); if (!r.meta.courses.length) delete r.meta.courses; }
    throw e;
  }
}

/** The answer's fields: the reach, its water gates (wall, cells, lintel), the bill with the grate's bars. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  const xs = e.L.columns.map((c) => c[0]), zs = e.L.columns.map((c) => c[1]);
  const rect = { minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs) };
  const a = bodyAnswer(K, p, e.bodies, { rect, notes: res.notes ?? [], extra: { block: 'channel.course', hand: res.spec.variant, waterGates: e.gate.crossings.map((q) => ({ wall: q.wall, cells: q.cells.length, lintel: q.lintel, grate: e.grateN })) } });
  if (e.grateN) {
    const states = [];
    for (const b of e.bodies) for (const s of b.shellStates ?? []) states.push(s);
    for (let i = 0; i < e.grateN; i++) states.push(grateState());
    K.record.bom[p.id] = bomOf(states);
  }
  return a;
}
