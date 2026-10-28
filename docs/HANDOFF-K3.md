# HANDOFF K3: towers and gatehouses as lots on a wall's line

Branch `slice/K3` (worktree `../architect-mc-K3`, run dir `../architect-mc-K3-run`, gate ports 8970-8979). The frozen contract is
docs/CONTRACT.md "Phase 7a slice K3"; the as-built goes there when the gate passes, and this file is deleted then. Versions are `NEXT`
placeholders throughout (the coordinator stamps them at merge).

**State: the contract text and the API are ready; the DEV MODE gate passed (CONTRACT "Phase 7a slice K3 as built", Gate). Stop before merging: Steward's RC first (S-K3-3).** Gallery: https://claude.ai/artifact/X1tdDP5xUzEGyXefe58Ywo.

## RC note for Steward

K3 changes what Steward designs and binds, and adds a `realiseApproved` refusal. Please run the RC (S-K3-3) on the branch head:

1. **castle_city** (its recorded plan, unchanged): `checkPlan` answers READY. The curtain wall `fits` and is `provisional`, with
   - its four `corner_lots` on the ring's corners, and its `gate_lot` straddling the gate run that faces the street's end;
   - no `join` deviation.
2. **Design and bind**:
   - For each lot whose artifact entry has `onWall`, design with type `tower` or `gatehouse`.
   - For a gatehouse, pass `onWall.passage.lotCells` as `DesignRequest.reserved` (IRR's member, unchanged).
   - Add a brief line: "keep the faces outside the wall closed at ground level (doors face in)". The outer faces are
     `onWall.outerFaces.lotCells`; a typed member for them is still S-K3-2's "later".
   - The design must fill its lot's box across the line. A design narrower than its box leaves the wall open at the box's faces and is
     refused.
   - **Send the exact box:** maxSize = the lot's fitBox in its frame (front to the south), no approach margin and no 7 minimum.
     `DesignRequest.maxSize` x/z now accepts 3..96 (was 7..96; y stays 6..64) in protocol 1, protocol 2 and group items. K3's siting
     emits boxes of at least 5 a side. An older sidecar still refuses x/z under 7: send a box under 7 only when the helper advertises
     `wallLots`.
3. **A bind refusal and its repair.** The refusal comes as `ARTIFACT_STALE`, the reason a changed site gets. Branch on the message prefix
   "lot <id> on wall <wall>:" and send that case to the design repair loop, not to a stale re-check, which would retry forever.
   Bind a tower whose door is on an outer face. `realiseApproved` refuses `ARTIFACT_STALE` with
   "lot tower_N on wall curtain_wall: the design leaves the wall open at x,y,z ... (n cells)" and writes nothing. Repair the design
   (door on an inner face) and bind again.
4. **Villagers through the gatehouse**: realised, every lot inside reaches the gatehouse's front port through its passage and back.
5. **Removal**: `Regions.remove` restores the claim. The lots and their designs are removed with the region, as lots.

**The sim stand-in (an RC against `ARCHITECT_SIDECAR_BACKEND=sim`).** The sim builds a real wall-lot design, not the kit example, for a
request with:
- type `tower` or `gatehouse` and a maxSize (the lot's exact box in its frame, front to the south);
- one of these signs: the brief line above (in notes or context), a gatehouse's `reserved`, `ext["architect:wallLot"].outerFaces`,
  or the `sim:outerdoor` token.

What it builds (`kit/lib/wallLotDesigns.mjs` `standInDesign`, the gate's stub designs) in the request's palette or bible roles:
- The footprint is exactly the box (reserved.size when it fits maxSize). The height is the stub's: a tower is 2 x its smaller side + 3,
  so about 23 for a 9 x 9 under the 40 cap.
- **A gatehouse:** the passage open on the reserved columns over a standable floor, and its side-room doors on the back face. That is
  safe for any outer-face set. Its side rooms need **9 across** (wall, room, wall, the 3-wide passage, wall, room, wall); a narrower
  gatehouse box builds (a 5-wide one's passage is u 1..3, its side walls the box's faces) but the kit's gatehouse rules (an outside
  door, a lit interior) refuse it, so the sim reports the design failed.
- **A tower:** builds and checks in any box down to 3 x 3. One door on the front face, at the middlemost cell off the outer faces. **Pass a tower's
  `onWall.outerFaces.lotCells` unchanged as `ext["architect:wallLot"].outerFaces`.** Without it the door is the front's middle. That is
  right for a run or via tower, but castle_city's corner towers have that cell outer, and their inner front cells mirror each other
  (u 1..3 or 5..7), so no blind door is safe and the bind refuses them. The ext ends up in the entry's blueprint JSON `ext`.

**The token `sim:outerdoor`** goes in the DesignRequest notes (Steward's brief). It is matched anywhere in the notes as a whole token
(`sim:outerdoors` does not count), or as `"outerdoor"` in `ext["architect:sim"]`. In round 1 the door goes in an outer face (a tower's
back face, a gatehouse's front face beside the passage), so the bind refuses it `ARTIFACT_STALE`. A **versionOf** of that entry (the
repair: the refusal text as the change) always comes back with the door fixed, at the same size. It ignores the token even when its
notes still carry it, so the repair request can pass the notes through unchanged.

**What Steward might need to change:**
- **Lots outside the zone's rect (S-K3-4).** A zone's lots in its answer and in the artifact can now stand outside its rect. `onWall`
  says why.
- **A wall answer's `gates`** can include `{id: "<lot>_passage", kind: "passage"}`.
- **Graph readers:**
  - nodes of kind `passage`, with ports `front` and `back`;
  - edges of type `passage`;
  - route edges with a `passage` segment;
  - the inner lanes, edges `route_wl_<lot>`.
- **Zone geometry** (street, lot positions) moves for every zone whose wall names lots, because the zone is laid out without them.

## RC note for Steward: request identity, confirmed cancel, DONE ordering (feature `design.opKeys`)

All additive and binary compatible; check `ArchitectApi.features().contains("design.opKeys")` before using any of it (an older helper
refuses a keyed request rather than dropping the key).

1. **`DesignRequest.opKey`** (`withOpKey(key)`, `[A-Za-z0-9_.:-]{1,128}`), scoped by (owner, "design", key) like `GroupRequest.opKey`.
   Sending the same key and body again completes with the first design's id, in any state (also a finished one), and starts no job;
   a keyed `versionOf` retry is adopted, never `VERSION_REFUSED busy`. Another body fails `ArchitectRefused OP_KEY_CONFLICT`. The body
   ignores the versionOf site blobs (the mod re-uploads them on every send; the first design's site files win). A keyed design is
   kept at least 30 days after it is final.
2. **`Designs.designByKey(owner, key)`** -> `CompletableFuture<Optional<Design>>`: the design in any state from the helper's persisted
   record; empty = never received; fails `SIDECAR_UNAVAILABLE` while not connected.
3. **`Designs.cancelDesign(id)`** -> `CompletableFuture<CancelOutcome>` (`kind` CANCELLED / ALREADY_FINAL / UNKNOWN, `design`).
   CANCELLED only once the running turn's process is gone and the design's internal calls ended; its `design().cost()` is final. A
   repeat answers CANCELLED again. ALREADY_FINAL carries the DONE or FAILED design and its cost. It fails exceptionally while the
   helper is unreachable, or if the turn has not stopped within 15 s (the design stays cancelled; ask again). DESIGN_DONE with status
   CANCELLED still fires. `cancel(id)` is unchanged.
4. **Ordering:** `get`, `designByKey` and the cancel outcome report DONE only once the entry's new version is installed and loaded on
   the server, the moment DESIGN_DONE fires (a DESIGN_DONE listener already sees DONE). Before that a finished design reads as its last
   non-final status (RENDERING if the game saw none). FAILED and CANCELLED are reported when final.

## The exact API delta (all additive; no existing record, method, constructor or enum value removed or changed; api-compat clean)

| Surface | Delta |
|---|---|
| Feature | `wallLots` from the helper's `region.walls.lots` (sidecar `FEATURES`, `ApiRules`, `ArchitectApi` javadoc "Since NEXT (7a K3)"). |
| Feature `design.opKeys` (added for the RC) | `DesignRequest.opKey` (a new last component; the 1.41.0 canonical constructor kept) and `withOpKey`; `Designs.designByKey`, `Designs.cancelDesign` (defaults that throw); the new record `CancelOutcome` with enum `Kind`; wire `design.request.opKey`, `design.byKey`, `design.cancelConfirm`. |
| plan/0 `connector.wall` | New strict member `lots: [{lot: id, at?: corner \| gate \| run, near?: endpoint}]`, at most 16, `lot` required. It is the only addition to the schema, terse because the compact plan/0 has a 96,000 bound: 95,975 now, 228 more than main's 95,747. |
| Lenient params (R17) | Read when `lots` is absent: `corner_lots` and `towers` (corners first, then runs); `gate_lot`, `gateLots`, `gate` (a lot id) and `gates` (a list of lot ids, which also sets `gates.min` to its length); `joins` and `anchors` by the lot's type, else its id stem. Each mapped key leaves the "params.X not read" notes. |
| Plan behaviour | A ring wall (`wall.around` or `wall.edge` on a zone) withholds its named lots from the zone's street or free layout and sites them on its line. The band raises `ring.min` to ceil(depth / 2) + 2: noted, with a `move` deviation only past `ring.max`. A lot that fits nowhere goes back to its zone: the plan compiles once more and keeps K1's `join` deviation, noting why. A `wall.line` keeps its `via` lots (K1's joined lots) and adds their `onWall`. A `wall.along` sites none. A wall naming no lot is K1's, byte for byte. |
| Wall answer | `provisional: true` with lots on its line. `geometry.wallLots [{lot, at, box, front, passage?: {width, height, front, back}}]`. `geometry.gates` lists each passage as `{id: <lot>_passage, kind: passage, at: front port, width}`. Notes name each lot's place. |
| Zone answer | `geometry.lots` includes its lots on its walls' lines, with their boxes, entrances and fronts. A gatehouse's entrance is its passage's front port. |
| Artifact `lots[]` | `onWall: {wall, at: corner\|gate\|run\|via, floorY, frame: [W, D], outerFaces: {cells, lotCells}, passage?: {width, height (3), cells, lotCells, floor, front, back, lintelY, facing}}` and, for a gatehouse, `ports: [{name: front\|back, at, facing}]`. `cells` are flat world column runs `[x, z, y0, y1, ...]`. `lotCells` are the same cells in the lot's frame (front to the south: `[u, v, y0, y1]`, y from the floor, as IRR's). `floor` is flat `[x, z, y]` triples (the row under the passage). |
| `realiseApproved` | A new refusal through the existing lot refusal, `ARTIFACT_STALE`, when a wall lot's bound entry (the artifact's own or the request's) leaves an outer face open, rows floorY..+2 not impassable ("the design leaves the wall open at ... (n cells)"), or the passage's floor unstandable ("the passage floor is not standable at ... (n cells)"). Nothing is written. Impassable means a full-height collision that is not a door, fence gate or trapdoor. |
| Realise | A gatehouse's entry blocks on its passage cells are dropped; its site never writes, owns, journals or bills them (site ext `architect_mc:passage`, count `architect_mc:passageDropped`). `LotMask` unions it with IRR's irrigation mask; only irrigation drains at removal. |
| IR | `lots[].onWall`, `lots[].ports`, `lots[].ext["architect_mc:wall"] {wall, at}` (Architect's namespace). |
| siteplan/1 | `walls[].lots [{lot, at, box, passage?}]` (the key the foundation reserved). Node kind `passage`, edge type `passage` in the enums. |
| Graph | Node `passage:<lot>` (kind `passage`, ref the lot, ports `front`, `back`) and edge `pg_<lot>` (type `passage`, movers player and villager, `crossing {type: passage, wall, lot}`). Route edges through a gatehouse carry a `passage` segment (`{kind: passage, lot, wall}`); the route writes nothing in the box. |

## GM seam (gate mechanisms come after K3)

GM needs no API change to sit in a K3 gatehouse:
- **`onWall.passage`** carries the passage's geometry: its cells, the front and back ports, `facing`, `lintelY` (floorY + 3) and its
  floor row. A portcullis goes in the front face's row of passage cells under `lintelY`. A drawbridge goes outside the front port.
- **The passage cells are the region's**, under the `architect_mc:passage` mask: no design writes or owns them. GM's mechanism blocks can
  be region-owned there, journaled and undone with the region.
- **The passage is its own segment kind and graph edge type**, so GM can mark a closed gate impassable without touching routing:
  - a `passage` edge gains a state;
  - M2's closure already treats the passage as a gate (blocked in the closed test, open across).
- **The stub gatehouse** keeps a solid lintel course at `lintelY` across the passage (the trim role), and the hall floor above it is the
  winch room. A portcullis slot is cut there.
- **New member:** `onWall.passage` can gain `mechanism?` additively, and the bind check can learn a mechanism's closed state.

## Deferred (queued in PLAN)

- **Routes joining gate landings** (K2's along walls): not in K3. Along walls site no lots, and a fix would move K2's fixtures.
- **T2's self-crossing retry** keeps its ends open only for K3's own inner lanes (`keepEnds: true`, like CL's climbs); every other edge
  is unchanged. The general fix is its own slice.
- **A lot bound or re-versioned after the realise** (a delta, `versionOf`) is not bind-checked again: the contract scopes the check to
  `realiseApproved`.
- **IRR's `RegionsImpl.dropped()`** counts the template's air cells (found by K3's Java work). K3's passage count uses non-air blocks;
  IRR's own count is unchanged here.
