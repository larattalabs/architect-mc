// (6c H) The compiler's H hooks (docs/CONTRACT.md "Phase 6c slice H" §15): one dispatcher by kind over the generators' modules, so
// compile.mjs names no generator. H-core owns this file; each generator module is its slice's (pond, fountain, waterfall and moat
// H-a's; quay and wet H-b's), with the signatures documented in each. No module here imports compile.mjs or program.mjs.
//
// (6c HY, "Phase 6c slice HY" §1.5, §7.7, §8.3, §15) HY-core owns the additions; the course generators are HY-b's (course, race, ditch,
// profile) and the water gate HY-c's (gate.mjs, with line.mjs and wall.mjs). A channel dispatches by its block (schema.mjs channelBlock):
// channel.moat to moat.mjs, channel.course to course.mjs, channel.race to race.mjs, channel.ditch to ditch.mjs; a channel whose ext
// 'architect_mc:unsafe' carries `handCourse` to handcourse.mjs (HY-core's gate fixture: a course laid from explicit reaches, so the gate
// sends a course through Regions.checkPlan and realiseApproved before HY-b's router exists).
//   Overflows (§1.5): a course `from: {part: X}` registers an overflow on X in step 2 (registerOverflow(C, rec)), before X emits; X's
//   generator, when it accepts overflow (its module's `acceptsOverflow`: pond, fountain, moat, a course), reads overflowsOn(K, X) in
//   step 3 and passes them to r.fluidBody's `overflow`. compile.mjs emits a part fed by overflows after every course registered on it
//   (emitOrder: receivers before feeders, ties by plan order, so a plan without overflows emits in plan order), and a course that rolls
//   back drops its registrations (dropOverflows) before its feeder emits.
//   Crossings (§8.3): a course registers each still reach a wall line crosses (registerCrossing(K, rec), gate.mjs's record); HY-c's wall
//   reads crossingsOf(K).
import * as pond from './pond.mjs';
import * as fountain from './fountain.mjs';
import * as waterfall from './waterfall.mjs';
import * as moat from './moat.mjs';
import * as quay from './quay.mjs';
import * as course from './course.mjs';
import * as race from './race.mjs';
import * as ditch from './ditch.mjs';
import * as handcourse from './handcourse.mjs';
import * as handgate from './handgate.mjs';
import { isBodyPart, isHPart } from './kinds.mjs';
import { channelBlock, planLotIds } from '../plan/schema.mjs';

export { isBodyPart, isHPart } from './kinds.mjs';
export { wetBridgeFallback, wetWallFallback } from './wet.mjs';

const BY_KIND = Object.freeze({ pond, fountain, waterfall, quay, channel: moat });
/** (6c HY) A channel's generator by its block (channelBlock). */
const BY_CHANNEL = Object.freeze({ 'channel.moat': moat, 'channel.course': course, 'channel.race': race, 'channel.ditch': ditch });
/** (6c HY) The ext key of the gate's broken variants and fixtures (H's, K1's, T3's). */
export const UNSAFE_EXT = 'architect_mc:unsafe';

const lotCache = new WeakMap();
/** (6c HY) The plan's lot ids (a race is a course with a lot in via), cached per plan object. */
function lotIdsOf(plan) {
  if (!plan || typeof plan !== 'object') return new Set();
  let s = lotCache.get(plan);
  if (!s) { s = planLotIds(plan); lotCache.set(plan, s); }
  return s;
}

/** (6c HY) A channel part's block: channel.moat, channel.course, channel.race or channel.ditch (null when its path form is malformed). */
export function channelBlockOf(X, p) {
  return channelBlock(p.part, lotIdsOf(X?.plan));
}

function moduleOf(p, X = null) {
  if (p.kind === 'channel') {
    if (p.part?.ext?.[UNSAFE_EXT]?.handCourse) return handcourse;
    // ((6c HY-c, additive) HY-c's hand-laid water gate: a still reach across a planned wall, its gate fixture)
    if (p.part?.ext?.[UNSAFE_EXT]?.handGate) return handgate;
    const m = BY_CHANNEL[channelBlockOf(X, p)];
    if (m) return m;
  }
  const m = BY_KIND[p.kind];
  if (!m) throw new Error(`no H generator for kind ${p.kind}`);
  return m;
}

/** Compile step 2: place an H part (a form, or a channel compiled with the forms). */
export function fluidResolve(C, p) {
  return moduleOf(p, C).resolve(C, p);
}

/**
 * (6c KC, §2) Compile step 2: the footprint an H part that fits reserves ([[x0, z0, x1, z1]]), or null. A course or race (routed at
 * emit, after the walls: HY-c's water gates) and the unsafe hand fixtures reserve nothing at resolve: they register at emit.
 */
export function fluidFootprint(C, p, res) {
  const m = moduleOf(p, C);
  if (typeof m.footprint !== 'function') return null;
  const fp = m.footprint(res);
  return fp.length ? fp : null;
}

/** Compile step 3: write an H part that fits (throws 'CODE: message' to refuse it). */
export function fluidEmit(K, p, res) {
  return moduleOf(p, K).emit(K, p, res);
}

/** Compile step 6: an H part's answer fields over the default ones, or null. */
export function fluidAnswer(K, p, res) {
  return moduleOf(p, K).answer(K, p, res);
}

/** (6c HY) Whether a part's generator accepts an overflow (pond, fountain, moat, a course, race or ditch: its module's acceptsOverflow). */
export function acceptsOverflow(X, p) {
  if (!isHPart(p)) return false;
  return moduleOf(p, X).acceptsOverflow === true;
}

// ------------------------------------------------------------------ (6c HY) overflows (§1.5)

/**
 * The plan's overflow store (compile.mjs makes one per check: C.overflows and K.overflows are the same array). An overflow:
 * {from: <part id of the body that overflows (X)>, course: <part id of the course it feeds>, cells: [[x, y, z]] (X's side shell cells
 * at X's surface opened as outlets), lining: [[x, y, z]] (the spillway's lining, X's own), into: {body: <the course's head reach id>,
 * cells: [[x, y, z]] (where X's spill lands: the head's sources)}}.
 */
export function overflowStore(X) {
  if (!X) return [];
  if (!Array.isArray(X.overflows)) X.overflows = [];
  return X.overflows;
}

/**
 * Register an overflow on part `rec.from` (compile step 2, while the course resolves: before X emits). Refused (returns false) when X's
 * generator does not accept overflow (a dry end: the course starts at a spring instead, §1.5) or X is no H part of the plan.
 */
export function registerOverflow(C, rec) {
  const X = C.byId?.get?.(rec.from);
  if (!X || !acceptsOverflow(C, X)) return false;
  if (typeof rec.course !== 'string' || !rec.into || typeof rec.into.body !== 'string') throw new Error('registerOverflow: {from, course, cells, lining, into: {body, cells}}');
  overflowStore(C).push({ from: rec.from, course: rec.course, cells: rec.cells ?? [], lining: rec.lining ?? [], into: { body: rec.into.body, cells: rec.into.cells ?? [] } });
  return true;
}

/** The overflows registered on part `partId` (for its generator's r.fluidBody `overflow`), in registration order. */
export function overflowsOn(K, partId) {
  return overflowStore(K).filter((o) => o.from === partId).map((o) => ({ cells: o.cells, lining: o.lining, into: o.into, course: o.course }));
}

/** Drop every overflow course `courseId` registered (its emit rolled back, or it was refused). Returns how many. */
export function dropOverflows(store, courseId) {
  if (!Array.isArray(store)) return 0;
  const before = store.length;
  for (let i = store.length - 1; i >= 0; i--) if (store[i].course === courseId) store.splice(i, 1);
  return before - store.length;
}

/**
 * Step 3's emit order over `parts` (H parts, plan order): a part with overflows registered on it after every course that registered one
 * (so the course's head reach is planned first and a refused course has dropped its overflow), ties by plan order. With no overflows the
 * order is `parts` unchanged.
 */
export function emitOrder(parts, store) {
  if (!Array.isArray(store) || !store.length) return parts;
  const idx = new Map(parts.map((p, i) => [p.id, i]));
  const deps = new Map(parts.map((p) => [p.id, new Set()]));
  for (const o of store) if (idx.has(o.from) && idx.has(o.course) && o.from !== o.course) deps.get(o.from).add(o.course);
  const out = [], done = new Set();
  while (out.length < parts.length) {
    let pick = null;
    for (const p of parts) if (!done.has(p.id) && [...deps.get(p.id)].every((d) => done.has(d))) { pick = p; break; }
    // (a cycle of overflows: the rest in plan order; M25:order names it at the check)
    if (!pick) pick = parts.find((p) => !done.has(p.id));
    done.add(pick.id);
    out.push(pick);
  }
  return out;
}

// ------------------------------------------------------------------ (6c HY) water-gate crossings (§8.3)

/** Register a course's crossing of a wall (gate.mjs's record shape); HY-c's wall reads them. */
export function registerCrossing(K, rec) {
  (K.courseCrossings ??= []).push(rec);
  return rec;
}

/** Every crossing registered so far (HY-c: line.mjs and wall.mjs take their cells as given). */
export function crossingsOf(K) {
  return K?.courseCrossings ?? [];
}


/**
 * Whether the plan gets the `fluids` stage (§3.1): a body part that fits, or a part that is no body but brings one (a farm lot's
 * farmPond: pond.stageWanted). Plans without one keep their stage list, so their IR.
 */
export function fluidStageWanted(C) {
  if (C.order.some((p) => isBodyPart(p) && C.okClass(p.id))) return true;
  return !!pond.stageWanted(C);
}

/** The route pass's input for the plan's own water (the moat's): null when there is none, so the pass is byte for byte as before. */
export function fluidPassInput(K) {
  return moat.passInput(K);
}

/**
 * (H-a, additive) Compile step 3, after the zones: each farm lot's pond (S-H-1/S-H-2: farmPond: true on a lot or zone, a dry claim).
 * Returns {ponds, notes: Map(zone id -> [note])}. Only called when a zone of the plan writes farmPond (else the plan is as before).
 */
export function fluidFarmPonds(K) {
  return pond.emitFarmPonds(K);
}

/** (H-a, additive) Whether a plan's zones ask for farm ponds (a cheap test: compile.mjs makes the K context only then). */
export function asksFarmPond(order) {
  return order.some((p) => p.family === 'zone' && /"farmPond":true/.test(JSON.stringify(p.part)));
}

/** (H-a, additive) N-H-5: the clearance a street fallback's bridge keeps over the plan's own water (1), or null (T3's default). */
export function fluidFallbackClearance(K, l) {
  return moat.planWaterClearance(K, l);
}

/** Whether any part of the plan is H's (its compile runs the H steps). */
export function hasHParts(order) {
  return order.some(isHPart);
}
