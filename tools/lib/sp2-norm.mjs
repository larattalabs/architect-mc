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
  // (WR) carried here for the same reason: kit/lib/connectors/wall.mjs ringOf keeps a closed: false ring closed when its box holds the
  // claim's centre (no town-facing side), with a note; war_camp's palisade surrounds the asks claim's centre
  'asks/war_camp.json': "WR: camp_palisade's ring encloses the claim's centre, so closed: false is ignored (noted) and the ring stays closed (all four sides); still fits",
});
