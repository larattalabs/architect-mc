// (6c HY) connector.channel as channel.ditch (a level irrigation ditch 1 x 1 along the sides of a lot or zone, where.along) in the plan
// compiler (docs/CONTRACT.md "Phase 6c slice HY" §7.6, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs
// (hooks.mjs dispatches to it by channelBlock()). The signatures are course.mjs's (resolve, emit, answer). A ditch is one H body; it
// stands alone or receives a course or a branch (acceptsOverflow).
//
// The foundation's stub (HY-core): the part answers refused UNREACHABLE (until HYb) at resolve.
import { stubRefusal } from './course.mjs';

export const acceptsOverflow = true;

/** Place the part: the foundation refuses it (slice HY-b builds it). */
export function resolve(C, p) {
  void C; void p;
  return { klass: 'refused', reasons: [stubRefusal('channel.ditch')], notes: [] };
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
