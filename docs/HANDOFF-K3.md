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
3. **A bind refusal and its repair**: bind a tower whose door is on an outer face. `realiseApproved` refuses `ARTIFACT_STALE` with
   "lot tower_N on wall curtain_wall: the design leaves the wall open at x,y,z ... (n cells)" and writes nothing. Repair the design
   (door on an inner face) and bind again.
4. **Villagers through the gatehouse**: realised, every lot inside reaches the gatehouse's front port through its passage and back.
5. **Removal**: `Regions.remove` restores the claim. The lots and their designs are removed with the region, as lots.

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

## The exact API delta (all additive; no record, method, constructor or enum value changed; api-compat clean)

| Surface | Delta |
|---|---|
| Feature | `wallLots` from the helper's `region.walls.lots` (sidecar `FEATURES`, `ApiRules`, `ArchitectApi` javadoc "Since NEXT (7a K3)"). |
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
