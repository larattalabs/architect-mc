// (7a K2) What slice K2 moves for its byte-identity check (tools/gate7ak2.mjs unit, docs/CONTRACT.md "Phase 7a slice K2" §6, §8), by name,
// over the 7a foundation's own (F7A_MOVED: the merge base is main, before the foundation). Every other committed plan fixture plans
// byte for byte as on the merge base: a wall without where.along and without walk (or params.wall_walk) emits as K1a.
import { F7A_MOVED } from './f7a-norm.mjs';

export const K2_MOVED = Object.freeze({
  ...F7A_MOVED,
});
