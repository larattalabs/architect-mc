// (6c HY) connector.channel as channel.race (a course with a lot in via: a wheel fall beside the lot) in the plan compiler (docs/CONTRACT.md
// "Phase 6c slice HY" §7.5, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs (hooks.mjs dispatches to it
// by channelBlock()). The signatures are course.mjs's (resolve, emit, answer); the answer gains `serves: {lot, side, fall: {at, drop}}`.
//
// The foundation's stub (HY-core): the part answers refused UNREACHABLE (until HYb) at resolve.
import { stubRefusal } from './course.mjs';

export const acceptsOverflow = true;

/** Place the part: the foundation refuses it (slice HY-b builds it). */
export function resolve(C, p) {
  void C; void p;
  return { klass: 'refused', reasons: [stubRefusal('channel.race')], notes: [] };
}

/** Write the part: nothing in the foundation. */
export function emit(K, p, res) {
  void K; void p; void res;
}

/** The part's answer fields: none in the foundation. */
export function answer(K, p, res) {
  void K; void p; void res;
  return null;
}
