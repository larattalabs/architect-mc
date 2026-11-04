// (7a foundation) What the 7a foundation moves for the earlier slices' byte-identity checks (their unchanged() over the committed plan
// fixtures), by name (docs/CONTRACT.md "Phase 7a foundation" §4, §7 item 1): the catalogue's three changes (connector.rail until CR,
// connector.branch_walk until 7b, connector.span_bridge a supported alias of connector.bridge) re-answer exactly these fixtures. The
// other fixtures the foundation touches are new or renamed on its branch (extension/e02_tube_draft.json, valid/v7a_foundation_*).
/**
 * (GC) What the gatehouse coverage hints move: a wall that rings a zone with a gatehouse lot no wall names answers adjusted with the note
 * "<lot> is not on the wall: name it in lots (at: gate)" (notes and class only: the IR and the plan are unchanged). Recorded plans: only
 * Steward's redstone_gate (its curtain_wall rings the fortress, whose gatehouse_1 the wall does not name).
 */
export const GC_MOVED = Object.freeze({
  'asks/redstone_gate.json': 'GC: curtain_wall answers adjusted with the note "gatehouse_1 is not on the wall: name it in lots (at: gate)" (notes and class only; the IR is identical)',
});

export const F7A_MOVED = Object.freeze({
  ...GC_MOVED,
  'asks/mining_town.json': '7a foundation: rail_1 answers unsupported {connector.rail, until CR} (was until 7a; S-7a-5)',
  'extension/e15_every_reserved_a.json': '7a foundation: c_rail until CR, c_branch_walk until 7b (S-7a-4, S-7a-5); c_span_bridge left the fixture (a supported alias, R25); (7a K2) c_wall_along left it (wall.along supported)',
  // ((7a K2) the slices' own movers, each slice its line: K2 reads castle_city's params.wall_walk (its walk round the ring))
  'asks/castle_city.json': '7a K2: curtain_wall\'s params.wall_walk read as walk: true (its notes, geometry and IR; still adjusted)',
  // ((7a GM-a2, CONTRACT GM §16 items 1 and 3) the GM fixtures' mechanism carries its provisional bill (cost), the gatehouse lot's range holds it,
  // the IR write data names the roof fill's block)
  'gm/gm_castle_13x7.json': '7a GM-a2: mechanism.cost, the lot costRange widened by it, mechanismWrite.fill',
  'gm/gm_castle_17x15.json': '7a GM-a2: mechanism.cost, the lot costRange widened by it, mechanismWrite.fill',
  'gm/gm_castle_slide.json': '7a GM-a2: mechanism.cost, the lot costRange widened by it, mechanismWrite.fill',
  'gm/gm_castle_swing.json': '7a GM-a2: mechanism.cost, the lot costRange widened by it',
});

/** The recorded parts (ask/part) whose answer the foundation moves only by its `until` (connector.rail: 7a -> CR). */
export const F7A_ASK_PARTS = Object.freeze(['mining_town/rail_1']);
/** An asks-table line with the foundation's `until` move normalised (the earlier drivers' tables compare through fl-norm's flAsksFilter). */
export const f7aAskLine = (l) => (F7A_ASK_PARTS.some((p) => l.startsWith(`${p} `)) ? l.replace(/ until \S+$/, '') : l);
