// (7a K3) The committed plan fixtures K3 moves by name (docs/CONTRACT.md "Phase 7a slice K3" §8, §9): byte identity against the merge
// base holds for every other one (tools/gate7ak3.mjs unchanged). Each mover is a recorded wall that names lots of its own zone (its
// lots sited on its line, its zone laid out without them) or K1a's unread-keys fixture (its `towers` read now).
const why = (s) => `K3 §9: ${s}`;
export const K3_MOVED = Object.freeze({
  'asks/castle_city.json': why('corner_lots (4 towers on the corners) and gate_lot (the gatehouse on the gate run) read and sited; the castle laid out without them'),
  'asks/walled_town.json': why('gateLots (4 gatehouses, the 4 gates their passages) read and sited; the town laid out without them'),
  'asks/metropolis.json': why('gates (2 gatehouses: gates.min 2) and towers (3 corners) read and sited; the capital laid out without them'),
  'asks/camp_to_city.json': why('gate (the gatehouse) and towers (2 corners) read and sited; the camp laid out without them'),
  'asks/border_fort.json': why('anchors (2 towers on corners, the gatehouse on the gate run, by type) read and sited on the wall.edge; the fort laid out without them'),
  'asks/desert_jungle_wall.json': why('the wall.line\'s via gatehouse: its onWall and its passage across the line (the town\'s lots unchanged)'),
  'asks-8703dbd/redstone_gate.json': why('joins read by type; every lot back to the zone (the raised band meets the moat\'s body), K1\'s join deviations noted why: the same class as before'),
  'k1a/unread_keys.json': why('towers read: h1 sited on the ring\'s corner (no join deviation; the expect updated)'),
});

/** (7a K3) The recorded ask parts K3 re-answers (adjusted -> fits, provisional: their lots read and sited on the wall): the earlier slices'
 * asks tables (KC item 3, H-a item 10, HY-b item 11) compare their lines by part and kind only, through fl-norm's flAsksFilter (k3AskLine). */
export const K3_ASK_PARTS = Object.freeze(['border_fort/fort_wall', 'camp_to_city/city_wall', 'castle_city/curtain_wall', 'walled_town/town_wall']);
