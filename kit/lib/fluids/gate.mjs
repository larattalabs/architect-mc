// (6c HY) Water gates (wall.water_gate, docs/CONTRACT.md "Phase 6c slice HY" §8.3, §15): where a course crosses a K1 wall's line or ring,
// the wall stands on a lintel over a still reach and a waterlogged iron grate fills the reach's cells in the wall's thickness. Slice HY-c
// owns this file (and the crossing's use in line.mjs and wall.mjs); it must not import compile.mjs or program.mjs.
//   The crossing record a course registers (hooks.mjs registerCrossing(K, rec)) and a wall reads (crossingsOf(K)):
//     {course: <part id>, body: <reach body id>, wall: <wall part id> | null, cells: [[x, z]] (the still reach's columns the wall's line
//      crosses, at least 2 cells of still reach each side, at most 3 wide), level (the reach's surface), lintel: y (the wall's footing
//      over the open top), grate: [[x, y, z]] (the reach's cells in the wall's thickness: body cells written iron_bars[waterlogged=true]
//      by the course's fluid op `grate`)}
//   waterGates(K, wall) -> [{course, cells, lintel, grate}]   the crossings a wall stands over (counted against gates.max)
//   grateState()                                              the grate block state ('minecraft:iron_bars[waterlogged=true]')
//
// The foundation's stub (HY-core): no wall has a water gate; a course meeting a wall answers UNREACHABLE {kind: wall} (HY-b's router)
// until HY-c.
import { GRATE_STATE } from './body.mjs';

/** The crossings a wall stands over: none in the foundation. */
export function waterGates(K, wall) {
  void K; void wall;
  return [];
}

/** The grate's block state (a fixed block, not a role: it must be waterloggable and refuse mobs). */
export function grateState() {
  return GRATE_STATE;
}
