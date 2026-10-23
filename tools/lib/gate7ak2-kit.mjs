// (7a K2) What slice K2 moves for its byte-identity check (tools/gate7ak2.mjs unit, docs/CONTRACT.md "Phase 7a slice K2" §6, §8), by name,
// over the 7a foundation's own (F7A_MOVED: the merge base is main, before the foundation). Every other committed plan fixture plans
// byte for byte as on the merge base: a wall without where.along and without walk (or params.wall_walk) emits as K1a.
import { F7A_MOVED } from './f7a-norm.mjs';

export const K2_MOVED = Object.freeze({
  ...F7A_MOVED,
  'asks/castle_city.json': 'K2 (§6, §8): curtain_wall\'s params.wall_walk is read as walk: true: its notes, geometry and IR change (the walk round the ring, an access at its gate); still adjusted (its gate_lot join, K3\'s)',
  'extension/e15_every_reserved_a.json': `${F7A_MOVED['extension/e15_every_reserved_a.json']}; K2: c_wall_along left the fixture (wall.along supported)`,
  'k1a/unread_keys.json': 'K2: wall_walk is read now (walk: true), so the fixture\'s third unread key is wall_height (S-K1-3\'s three-key bar kept)',
});
