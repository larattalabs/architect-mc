// (SP2) The committed plan fixtures slice SP2 moves, by name, for the earlier slices' byte-identity checks (their unchanged() over the
// fixtures against the base), each with its reason (docs/CONTRACT.md "Slice SP2 as built").
export const SP2_MOVED = Object.freeze({
  // a crater's recorded params read leniently (kit/lib/forms/bigForms.mjs craterParamsOf): its class unchanged (fits), its bowl and notes move
  'asks/crater_mine.json': "SP2: the crater's params depth 16, diameter 56 and rim_height 4 are read (a bowl 16 deep, radius 28, rim 4; was M's 9, 19, 2); still fits",
  // S1's program (kit/regions/floating_islands.mjs): its link landings one cell nearer each island's rim (RM's walkway end)
  'valid/v14_floating_islands.json': "SP2: floating_islands' link landings one cell nearer each rim (RM's M15 walkway end); the answers' IR moves, still READY",
  // (CF, composer feedback) carried in this list so every byte-identity helper that reads SP2's movers reads them too: kit/lib/plan/
  // compile.mjs's sealedWallMessage rewords an UNREACHABLE leg blocked by a sealed ring; only the answers' text moves (overall, IR and
  // first plan byte-identical)
  'k1a/sealed.json': "CF: UNREACHABLE through a sealed ring names the wall and the fix (sealedWallMessage); answers' text only, overall/IR/first plan identical",
  'tunnel/tn15_postern_sealed.json': "CF: UNREACHABLE through a sealed ring names the wall and the fix (sealedWallMessage); answers' text only, overall/IR/first plan identical",
  // (CF2, batch 5 / v0.73.0) a required zone answered fits/adjusted with more than its allowance of lots unplaced gets a LOTS_SHORT
  // reason and NEEDS_REPAIR (docs/CONTRACT.md "Slice CF2 as built"); each one diffed against origin/main d7d000ca: only parts[i].reasons
  // gains the LOTS_SHORT entry (no CF3 terraces clause: no survey), the overall where stated; IR and first plan byte-identical
  'asks/cat_sanctuary.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: sanctuary 5 of 9 lots unplaced (allowed 3): READY -> NEEDS_REPAIR",
  'asks/end_city_ruins.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 6 of 10 unplaced (allowed 3): READY -> NEEDS_REPAIR",
  'asks/hidden_village.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: hollow 6 of 10 unplaced (allowed 3); overall NEEDS_REPAIR as before",
  'asks/ice_village.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: village 4 of 10 unplaced (allowed 3): READY -> NEEDS_REPAIR",
  'asks/metropolis.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: capital 21 of 35 unplaced (allowed 11): READY -> NEEDS_REPAIR",
  'asks/one_block.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 4 of 10 unplaced (allowed 3); overall REQUIRED_BLOCKED as before",
  'asks/redstone_gate.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 6 of 10 unplaced (allowed 3); overall REQUIRED_BLOCKED as before",
  'asks/rival_families.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: two zones 5 of 5 and 2 of 2 unplaced (allowed 1, 0): READY -> NEEDS_REPAIR",
  'asks/spiral_town.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 10 of 13 unplaced (allowed 4): READY -> NEEDS_REPAIR",
  'asks/terraced_hill.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 5 of 11 unplaced (allowed 3); overall REQUIRED_BLOCKED as before",
  'asks/two_districts.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: 5 of 5 unplaced (allowed 1); overall REQUIRED_BLOCKED as before",
  'asks-8703dbd/redstone_gate.json': "CF2: a required zone short of its lots answers LOTS_SHORT (kit/lib/plan/finish.mjs markLotsShort); answers' reasons only, IR and first plan identical: fortress 6 of 10 unplaced (allowed 3); overall REQUIRED_BLOCKED as before",
  // (WR) carried here for the same reason: kit/lib/connectors/wall.mjs ringOf keeps a closed: false ring closed when its box holds the
  // claim's centre (no town-facing side), with a note; war_camp's palisade surrounds the asks claim's centre
  'asks/war_camp.json': "WR: camp_palisade's ring encloses the claim's centre, so closed: false is ignored (noted) and the ring stays closed (all four sides); still fits",
});

/** (CF2) The recorded ask parts (ask/part) whose asks-table row CF2 moves only by its LOTS_SHORT code (adjusted -> adjusted LOTS_SHORT). */
export const CF2_ASK_PARTS = Object.freeze(['cat_sanctuary/sanctuary', 'hidden_village/hollow', 'ice_village/village', 'metropolis/capital', 'redstone_gate/fortress']);
/** An asks-table line with CF2's LOTS_SHORT code normalised for those parts only (f7a-norm's f7aAskLine applies it, so every table reads it). */
export const cf2AskLine = (l) => (CF2_ASK_PARTS.some((p) => l.startsWith(`${p} `)) ? l.replace(/ LOTS_SHORT$/, '') : l);
