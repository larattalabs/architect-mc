// (6c HY) connector.channel as channel.course in the plan compiler, and the region primitive r.course (docs/CONTRACT.md "Phase 6c slice
// HY" §7, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by
// the channel's block, channelBlock()).
//   resolve(C, p) -> res          compile step 2, after lots, zones and H's forms (they read lot boxes and X's geometry) and before the
//                                 routes: place the course (the router, the profile, its ends) and register an overflow on each plan
//                                 body it leaves (hooks.mjs registerOverflow(C, ...), before that body emits). res as H's (pond.mjs).
//   emit(K, p, res)               compile step 3: write the reaches (r.fluidBody per reach, ids reachId(part, k), k from the head; lining,
//                                 joins into plan bodies, after); throw 'CODE: message' to refuse it (the part rolls back, and its
//                                 overflow registrations with it)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields over the default, or null
//   acceptsOverflow = true         a course can feed another course (a branch takes an overflow from its nearest reach)
//   course(r, path, opts) -> rec   r.course's implementation (bound into program.mjs below): lay a course along `path` (a hydrology pass's
//                                 data.courses[i], {cells: [[x, z]], accumulation?: [n]}, or a polyline [[x, z], ...]) with opts {id
//                                 (the part id rule; reaches are reachId(id, k)), part, look: 'natural' | 'built', flow: 'level' |
//                                 'pools' | 'riffles', width, depth, drop, riffle, cut, fill, stage, from, to (ends: {kind: 'spring' |
//                                 'pool' | 'weir' | 'join' | 'overflow' | 'rim', ...})}. Returns {id, part, bodies: [body records],
//                                 steps: [{kind: 'fall' | 'spillway' | 'riffle', from, to, drop}], ends: [{end: 'from' | 'to', kind, ref}],
//                                 refused: null | {code, message, until?, evidence?}}: siteplan's `courses` row (r.meta.courses).
//
// The foundation's stub (HY-core): the part answers refused UNREACHABLE (until HYb) at resolve, so nothing is emitted and every plan
// compiles exactly as without the part; r.course lays nothing and answers the same refusal in its record (never a throw).
import { _bindCourse } from '../region/program.mjs';

export const acceptsOverflow = true;

/** The stub's refusal (HY-b builds the course). */
export function stubRefusal(block = 'channel.course') {
  return { code: 'UNREACHABLE', message: `${block} is built by slice HY-b (this build has HY-core only)`, until: 'HYb', evidence: { block } };
}

/** Place the part: the foundation refuses it (slice HY-b builds it). */
export function resolve(C, p) {
  void C;
  void p;
  return { klass: 'refused', reasons: [stubRefusal('channel.course')], notes: [] };
}

/** Write the part: nothing in the foundation (resolve never answers fits). */
export function emit(K, p, res) {
  void K; void p; void res;
}

/** The part's answer fields: none in the foundation. */
export function answer(K, p, res) {
  void K; void p; void res;
  return null;
}

/** r.course's implementation: the foundation lays nothing and answers the stub's refusal in the record. */
export function course(r, path, opts = {}) {
  void r; void path;
  return { id: opts.id ?? null, part: opts.part ?? null, bodies: [], steps: [], ends: [], refused: stubRefusal('channel.course') };
}

_bindCourse(course);
