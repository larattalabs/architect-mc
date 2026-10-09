# Settlements in any terrain and theme: architecture and roadmap

Status: **draft for Noah and Steward review**, 2026-10-08. Nothing here is built, and nothing here reopens a frozen contract.
Phase 6a is still running its gate chain on `phase/6a` (megaA passed its bars on 2026-10-08; the final megaA, megaB, E-flat,
forest, crash and regression steps are in progress per `docs/HANDOFF-6a.md`). This document builds on 6a as built and
**replaces the 6b and 6c rows** of the phase 6 contract with a new 6b, a new 6c and a phase 7. 6d (region evolution) stays
deferred and keeps its name. When a phase here is taken up, it becomes a CONTRACT section the usual way: a draft, Steward's
review, then frozen.

Sources, read for this draft:
- architect-mc `docs/PLAN.md`; `docs/CONTRACT.md` 4a (Survey, ports R5), 4d (lots, `fitToLot`, batches, stages), 4e (journal,
  layering, CELL/BOX, roads, cell sites, survival layering), 5a and 5b (critique loop and polish outcomes), the phase 6
  contract (program model, closed shape library, primitives, realise, mega_bench, split, Steward's review changes);
  `origin/phase/6a` `docs/HANDOFF-6a.md`, `kit/REGIONS.md`, `kit/lib/realise.mjs`, `kit/lib/region/program.mjs`, and CONTRACT
  "Phase 6a as built".
- Code at `main` (v0.10.1): `placement/TerrainFit.java`, `placement/Approach.java`, `survival/BuildOrder.java`,
  `kit/lib/kit.mjs` (`bp.port`, `bp.part`), `kit/lib/check.mjs` (`makeGrid`, `walker`, `supportOf`, metrics),
  `kit/lib/bible.mjs` (scope `settlement`), `kit/README.md`, `kit/PLAYBOOK.md`.
- steward-mc (read only): `docs/PLAN.md`, `docs/A5B-SPEC.md`, `docs/A6-REVIEW.md`, `docs/A5A-REVIEW.md`,
  `layout/VillageLayout.java`.

Cost figures marked **measured** come from the gate records. Everything else marked **est.** is an estimate to be measured.

---

## 0. Summary

The model phase 6 was heading for is: shape the terrain with a closed library of signed-distance primitives, flatten
rectangular pads, place box buildings that were designed in a vacuum, and join them with roads, stairs and straight
bridges. That model can do a crater, a walled hill or a terraced village. It cannot do a ravine town, a mountainside
monastery, an ice-spike outpost, a treehouse village, floating islands with life on them, or a cave city, because in those
places **the building has to fit into the terrain**, the **connection is the character** (a rope bridge, a ladder, a lift, a
tunnel), and **natural forms must read as natural**.

The direction Noah agreed, made concrete:

1. **Global plan, local realise.** Whole-claim passes (hydrology, relief blending and erosion touch-ups, slope-aware routing,
   district layout) run once at plan time and are baked into **fields and shapes** (side blobs referenced by sha). Realise
   stays pointwise per 64x64 tile, so 6a's guarantees hold: determinism, tile independence, exact journal undo, no agent
   code at realise, the MSPT budget.
2. **A frozen 3D site volume** (new) for candidate areas and lot volumes, because 6a's survey and frozen heightfield are
   2.5D (columns only) and can't see overhangs, caves, ledges or trunks.
3. **Site analysis** finds affordances (cliff faces, ledges, overhangs, caves, trunks, canopies, spikes, water, gaps) and
   turns them into **non-box lot types**.
4. **Site-aware design.** The designer receives the real site volume in its own frame and a **fit mode** (`on_pad`,
   `carve_into`, `attach_to_cliff`, `span`, `wrap_trunk`, `suspend`). Placement merges with terrain instead of flattening.
   Exact undo comes from the journal's existing BOX-over-CELL layering. It also works without a region, on a plot a
   player marks on a natural cliff or gap (section 7.8).
5. **A settlement graph** of nodes and typed edges, realised as **designed connectors** (rope bridges, catwalks, tunnels,
   rock-cut stairs, ladders, lifts, switchbacks, branch walkways) generated for the actual span and anchors and styled from
   the bible.
6. **Natural-form generators** (trees, spires, ice spikes, mushrooms, coral, islands, roots) that grow globally at plan time
   and emit closed-library shapes, plus scatter, harvested vanilla feature stamps, domain warping and **material rules**
   (depth, height, slope, wetness, age).
7. **Claude plans the settlement** (concept, districts, circulation, verticality) as structured data; code realises it.
   A settlement-scale bible (format 3) styles connectors, forms and scatter.
8. **Gameplay validity** as checker rules: reachability per mover class (player, villager, Steward NPC), lighting and
   spawn-proofing, fall hazards, fluids and flooding, melt and decay; survival builds hanging and spanning structures in
   support order.
9. **Composites** past 96x64x96 joined at ports; a **shape-promotion** pipeline; **incremental replanning** with 6d;
   **Steward** gets an exported nav graph with typed links.

Evaluation does not use a model judge. A **scenario ladder** of six golden scenarios with deterministic metrics, plus a
**gallery** Noah approves, is the gate. Each phase must turn at least one more scenario green end to end.

Phase plan (details in section 17):

| Phase | Scope | New scenario(s) green | Claude spend (gate) |
|---|---|---|---|
| 6a | as frozen (engine and scale) | none (mega_bench) | $0 |
| **6b** | checker, previews, nav export, 3D volume survey, IR format 2 scaffolding, material rules and the first forms, scenario harness and gallery, template-first `Regions.design` and Steward's crater gate | floating islands | est. $1-3 |
| **6c** | plan-time passes (fields, relief blending, hydrology, routing with switchbacks, bridges and tunnels), the generator library, scatter, feature stamps | ice-spike outpost; mountainside monastery v1 | $0 |
| **7a** | site analysis, affordance lots, settlement graph and connectors, gameplay-validity rules | ravine town v1 | $0 |
| **7b** | site-aware design (fit modes, the designer's site volume, kit, checker, TerrainFit/Approach, survival support order) | treehouse village; cave city (monastery and ravine reach v2) | est. $60, cap $90 |
| **7c** | Claude settlement planning, bible format 3, program authoring (old 6c), shape promotion, composites past the cap | all six from a one-line brief | est. $120, cap $180 |
| 6d | region evolution, deltas, incremental replanning (designed in section 14) | (deferred to Steward phase 3) | $0 |

---

## 1. Why the current model fails, in the code

| Where | What it does today | Why that fails in these places |
|---|---|---|
| `TerrainFit.plan` | Fills foundation down to 12 under every floor-row cell; **clears natural terrain and trees** at or above the ground row inside the box wherever the template doesn't write; clears leaves anywhere in the box | A cave room, a cliff-face house, a trunk house all *want* the rock or trunk to stay. Today the box is emptied and the building stands in a hole cut to its rectangle. |
| `Approach` | A strip out of the front face, up to 6+8 rows, cutting up to 8 above the path and filling to 12 | A door that opens onto a rope bridge, a ledge or a 40-block drop has no ground to walk to. The strip would cut a trench into the cliff. |
| `fitToLot` / 4d lots / region `lot()` | Box lot, rotation so the entrance faces the street, `origin.y = lot.minY - groundY`; the region `lot()` makes a flat pad with cut/fill and batter or wall | Every lot is a rectangle on a flat pad. A ravine has no flat pad of 20x20; making one destroys the ravine. |
| Blueprint (kit) | A box template designed with no knowledge of where it goes; `front` south, `groundY` feet row | A design that doesn't know the site can't wrap a trunk, follow a cliff, or leave the rock as its back wall. |
| Closed shape library (6a) | sphere, box, cylinder, cone, bowl, ring, torus, capsulePath, extrude, heightfield, mask, plus combinators; one material per op | Every form is built from smooth analytic solids with one block each. Rock, ice, trees and roots read as geometry: no strata, no weathering, no taper along a branch. |
| Primitives (6a) | `stair`, `bridge` (straight polyline, pillar supports), `road` (4e ground or graded) | Connections are the same three shapes everywhere. Nothing hangs, sags, climbs a wall or runs along a branch. |
| Survey and frozen heightfield (6a) | Columns only: `ground`, `height`, `floor`, flags (water, missing, tree, lava) | Can't see overhangs, caves, ledges under an overhang, a trunk's radius, or an ice spike's real shape. |
| Size cap | 96x64x96 per template | A monastery complex or a cliff city's main hall can exceed it. |
| 5a/5b | The critic didn't accept fixes (loop G1/G2 failed, polish 0 steps) | Visual quality can't be gated by a model critic. |

---

## 2. Constraints carried from 6a (every design below states how it meets them)

- **K1. No agent code at realise.** Agent-written programs run only at plan time in the pristine-kit child process. Realise
  evaluates IR data with Architect's kit code only.
- **K2. Pointwise and tile-independent.** A cell's result depends only on the IR, its position and the frozen columns within
  8 of it. Anything wider (a 60-block tree, an island, a long bridge, a building whose y comes from a column in another tile)
  must be **resolved to absolute y at plan time**. Drift is absorbed locally with skirts (roots, footings, pillars down to
  frozen ground) inside the 8-column margin.
- **K3. The realise lint.** At realise, only `Math.floor/sqrt/abs/min/max/imul`, no `**`, no trig, no `Date`, no
  `Math.random`. So a rope bridge sags as an integer parabola, not a cosh. Bundled programs and plan passes avoid trig too, so
  IR goldens match across Node majors.
- **K4. Size.** IR at most 4 MB and 20,000 ops; blobs at most 16 MB each. REGIONS.md puts blobs **inline as base64** today. A
  1024x1024 u16 field is 2 MB raw and about 2.7 MB in base64, so fields and grown voxel structures must become **side blobs
  referenced by sha**, outside the IR text (IR format 2, section 3.2).
- **K5. Write order and "no CELL over BOX".** Within a stage: terrain tiles, then path tiles and 4e roads, then lots. A region
  never writes CELL over BOX; region tiles skip cells that `site`/`delta`/`road` entries own. As built, lots and 4e roads
  don't freeze heights, and a later-stage tile over earlier lot columns would freeze the post-lot surface.
- **K6. Unknown op kinds throw** (`compileIR`: "unknown op ... (shape, columns)"). New op kinds need IR `format: 2`. An older
  kit refuses a format-2 IR with `PLAN_STALE`. Format-1 IRs keep evaluating byte-identically.
- **K7. Additive API.** API rules as in 1.7.0/1.8.0: old record constructors kept, new interface methods are defaults that
  throw, every new enum constant appended, the 1.8.0/1.7.0/1.6.0 apitest jars unchanged and passing.
- **K8. Budgets.** Writes under `placementBudgetMs` (4 ms), 0 ticks over 50 ms, at least 15k cells/s (median of 3), 0
  chunks generated during realise, exactness E-flat 0 mismatches and E-normal classified.
- **K9. Survival.** Regions refuse in survival-toggle worlds until Noah decides N4 (terrain rule). Everything here that
  writes region CELL entries inherits that. BOX lots (buildings, including site-aware ones) are templates and can be
  construction sites as today.

---

## 3. Architecture

### 3.1 The pipeline

```
 1. card / brief                      (Steward's concept card, or a player's prompt)
 2. survey (2.5D, coarse)             Survey.sample, as 4a/6a
 3. coarse plan                       picks candidate areas: where cliffs, gaps, trees, water, caves may be (from 2.5D cues)
 4. prepare                           as 6a (governed pre-generation)
 5. volume freeze (3D, NEW)           Survey.volume over candidate areas only -> frozen, sha'd, persisted
 6. site analysis (NEW, plan time)    affordances from 2.5D + 3D
 7. settlement plan                   bundled program (6b-7b) or Claude's SettlementPlan (7c): districts, nodes, edges, forms
 8. global passes (NEW, plan time)    relief blending, hydrology/wetness, routing, district fitting, form growth
 9. IR v1                             terrain, forms, scatter, lots (pad lots and site lots), graph topology
10. check + previews (6b)             virtual world = 2.5D survey + 3D volumes + IR; M1-M21; top/section/iso/siteplan
11. lot designs                       library entries / variants ($0), or Claude designs (site-aware in 7b), against the
                                      virtual world's site volume per lot
12. link pass (NEW, plan time)        connectors generated between the installed designs' actual ports -> IR v2 (adds the
                                      `links` stage); IR identity includes the lot -> entry@version map and the fits
13. check again (6b rules) + gallery
14. realise                           6a: tiles, roads, lots, links per stage; a tile is frozen before any lot touching it
15. nav export                        siteplan.json graph + nav.json for Steward
```

Steps 3, 5, 6, 8, 11-12 and 15 are new. Everything after step 9 that writes the world goes through 6a's queue and journal
unchanged.

### 3.2 IR format 2 (additive over format 1)

Format 2 is format 1 plus the members below. The evaluator accepts both; a format-1 IR evaluates byte-identically
(golden test). An IR is format 2 only if it uses one of these.

```
{ format: 2, ...every format-1 member...,
  blobs: { name: { sha, bytes, kind } },              // SIDE files <planDir>/blobs/<sha>.bin, never inline; the IR names
                                                      // them by sha; the mod copies them into <world>/architect-regions/
                                                      // <id>/blobs/ with the IR (realise must never need the plan dir)
  fields: { name: { blob, type: 'u8'|'i16', minX, minZ, width, depth, res } },   // 2D fields, res 1 or 4
  volumes: { name: { blob, box, sha } },              // frozen 3D site volumes the plan read (section 5)
  forms: [{ id, generator, version, params, seed, bounds }],    // provenance only; their output is ordinary ops
  graph: { nodes: [...], edges: [...] },              // section 8; data for checker, siteplan and nav
  siteLots: [{ id, stage, part, fit, frame, volume, max, ports, affordance, brief?, ext }],   // section 7
  lotEntries: { lotId: "entryId@version" },           // only in IR v2 after the link pass; part of identity
  fits: { lotId: { origin, rotation, box, restoreBox } },        // likewise
  parts[].ops gain these op kinds:
    { op: 'relief', field, mode: 'delta'|'target', cut: cond, fill: materialRule, maxCut, maxFill }
    { op: 'scatter', grid, jitter, density: number|{field}, items: [{ w, shape|stamp, material?, anchor: 'ground'|'ceiling'|'wall' }], seedLabel }
    { op: 'voxels', blob, origin, rotation }           // baked cells, palette + positions (a grown or captured structure)
    { op: 'stamp', id, at, rotation }                  // a kit feature stamp (section 9.4)
  'shape' and 'columns' ops accept material: <blockState> | { rule: materialRule } }
```

**Side blobs on the wire.** 6a re-sends the IR when the sidecar answers `ir_unknown` (it lost its plan dir). With format 2
the sidecar may also answer `blob_unknown {shas}`; the mod then re-sends those blobs from the world copy through 4a's blob
path (`MAX_BLOB_BYTES` 64 MB, chunked) before re-requesting the tile. Realise still never needs the sidecar's plan dir, and
undo never needs the sidecar.

Shapes added to the closed library (all pointwise, lint-safe):

| Shape | Definition | Why |
|---|---|---|
| `ellipsoid(c, r)` | per-axis radii, the bound-safe approximation (`(|p/r| - 1) * min(r)`) | islands, canopies, boulders |
| `capsuleChain(points, radii)` | a polyline of round cones: radius interpolated along each segment | trunks, branches, roots, stalactites, coral, rope sag tubes |
| `wedge` / `prism`, `array(shape, step, n)` | accepted from Steward's review (S4) | keeps, ramps, colonnades, battlements |
| `warp(noise, amp, of)` | **domain warp**: evaluate `of` at `p + amp * noise3(p)` (three seeded noise lookups); bounds grow by `amp` | breaks the analytic read of every form. `displace` moves the surface along the distance; `warp` bends space. |
| `strata(of, field)` | no geometry; tags cells with a y-band index for material rules | rock layering |
| `instances(ref, transforms)` | the same sub-shape at N integer transforms (translate, rotate 90s, mirror) | repeated forms without inflating the IR |

The 8-column rule binds `warp` too: `amp` at most 8, and a warped shape's tile bounds grow by `amp`.

### 3.3 Material rules (pointwise)

A `materialRule` replaces a single block on any `shape`, `columns` or `relief` op. It picks a block per cell from
quantities that are all pointwise:

```
{ rule: [
    { when: { depth: [0, 0] },                 mat: 'surface' },          // depth = cells inside the op's surface (from the SDF value; 0 = skin)
    { when: { depth: [1, 3], slopeLt: 2 },     mat: 'subsurface' },
    { when: { field: 'wet', gte: 170 },        mat: 'minecraft:mud' },
    { when: { band: [3, 4] },                  mat: 'minecraft:tuff' },    // strata band
    { when: { noise: 'age', gte: 0.62 },       mat: 'minecraft:mossy_cobblestone' },
    { when: { yAbs: [-64, 0] },                mat: 'minecraft:deepslate' },
    { when: { facing: 'up', depth: [0, 0] },   mat: 'minecraft:snow_block' } ],
  default: 'rock', dither: 'ordered4' }
```

- `depth` is `floor(-sd)` of the op's own shape, so skins, cores and shells come free.
- `slope` is the max |dh| over the 4 neighbours of the frozen ground (inside the margin).
- `field` samples a 2D field blob (nearest at res 1, bilinear-free at res 4: integer interpolation).
- `noise` names an IR noise field. `age` is a plan parameter bias added to the noise threshold.
- `facing: up|down|side` comes from the op's own SDF at the cell's neighbours (6 lookups).
- `dither` is an integer Bayer matrix, so transitions don't make hard lines.

Roles resolve through the bible exactly like today's materials. A re-skin still changes only `roles`.

### 3.4 How each 6a guarantee survives

| Guarantee | How |
|---|---|
| Determinism (D9) | Passes and growers run at plan time and their output is IR data plus side blobs, sha'd and recorded. Realise evaluates only kit code under the lint. Goldens extend to format-2 ops. |
| Tile independence | All new ops are pointwise: fields are sampled, warps bounded by 8, scatter uses a hashed jittered grid (below), connectors are absolute-y data. |
| Exact undo | Every write is still a tile CELL entry, a 4e road or a BOX lot. Site-aware lots are BOX entries LAYERed on whatever the region wrote (section 7.6). |
| No agent code at realise | Claude-written generators and passes run only at plan time; their output is data. Only promoted generators (section 13) are evaluated lazily at realise, and those are kit code. |
| MSPT | Unchanged writer. New cost is in plan time and the sidecar's evaluation; forms add cells, which the 15k bar already covers. Light-engine cost under big canopies and caves is measured per scenario (section 16). |

**Scatter without a global pass.** The scatter op divides the plane into cells of `grid` size. Each grid cell's hash (seed,
cell) gives 0 or 1 jittered point and an item choice; `density` is the probability. A tile evaluates all grid cells within
its window plus the largest item radius (at most 8). Same seed, same placements, in any tile order. Items larger than 8
columns are not scatter: the plan places them as explicit ops.

**Freeze before lots (a 7a change to 6a's realise).** Connectors realise after lots (section 8.5), and any later-stage tile
must resolve surface-relative y against the pre-region surface. The rule: **a tile's columns (with their 8-column margin)
are frozen before any lot whose restore box touches that tile's window is written.** A lot item already waits for its
chunks to be loaded, so the freeze needs no extra chunk loading in either of 6a's configurations: under `GENERATED_ONLY` the
chunks are prepared, and under `LOADED_ONLY` (mega_bench config B, staged near the player) the lot can't start until its
chunks are loaded anyway, and the freeze runs then. Freezing every tile of the claim at region start was rejected because it
would need the whole claim loaded, which config B can't do. This closes 6a's "a later-stage tile over earlier lot columns
would freeze post-lot" deviation. Connectors use absolute y only; their footings go "down to the first solid natural cell"
at P1, as `pillar` does. **7a's gate must re-run mega_bench configs A and B** to show this change keeps 6a's bars.

---

## 4. Global plan, local realise: the plan-time passes

A **pass** is a deterministic function that runs at plan time, in the pristine-kit child process, over the whole claim. It
reads the plan survey (2.5D), the frozen volumes (3D) and the program's intent, and writes **fields** (2D blobs), **ops**
and **data** (routes, assignments). It never runs at realise.

```js
// kit/lib/region/passes/*.mjs; called from a program or from the SettlementPlan realiser
const wet  = r.pass('hydrology', { rain: 1, channelAt: 400 });           // -> fields.flow, fields.wet, ops for channels
const blend = r.pass('relief', { around: [...pads, ...paths], radius: 12, maxCut: 6, maxFill: 6 });  // -> fields.relief, one 'relief' op
const net  = r.pass('route', { graph: g, maxGrade: 0.25, switchback: true, bridgeMax: 32, tunnelMax: 48 });   // -> edges as primitives
const d    = r.pass('districts', { plan: settlementPlan.districts, affordances: A });    // -> node -> affordance assignment
```

Rules for passes:
- **Integer or fixed-point math**, no trig, the same lint as realise. Not needed for D9 (the IR is recorded), but it keeps
  replans stable across Node majors, which 6d's diff-by-part needs.
- **Plan budget.** 6a's 30 s plan limit stays for programs without passes. With passes: 120 s wall and 2 GB, measured in 6c
  on a 1024x1024 claim. A pass reports its time in the plan notes.
- **Resolution.** The first plan's survey is resolution 4 past 256x256. Passes that need detail (relief blending, routing)
  run on the **second plan's survey**, which 6c raises to resolution 1 up to 1024x1024 (about 7 MB as ARSV, a blob within
  the 64 MB cap). The two-plan flow is 6a's as built (plan, prepare, plan again); this only changes the second survey's
  resolution.

### 4.1 Relief blending and erosion touch-ups (`relief`)

Instead of a pad with a batter slope, the pass computes a smooth target surface around pads, path corridors and site lots:
a distance-weighted relaxation (integer Jacobi iterations) over the whole claim with the pads and corridors pinned. The
output is `fields.relief` (i16 dh per column, relative to the frozen ground) and one `relief` op per stage.

At realise, a column with frozen ground `g` and field value `dh` becomes ground `g + dh`: cut above (`IF_NATURAL`), fill
below with a material rule (`surface` skin, `subsurface` to depth 3, `rock` core). `maxCut`/`maxFill` clamp per column. A
column that drifted (its frozen ground differs from the plan survey) still gets `g + dh`, so the blend follows the real
surface. A pad's own columns get an exact target y (`mode: 'target'`), so the pad stays flat.

Erosion is a **touch-up, not a regeneration**: an optional thermal plus stream-power pass over the relief field, |dh| at
most 4, that roughens fills and cuts into gullies and scree so they stop reading as smoothed clay. Vanilla terrain is not
re-simulated.

### 4.2 Hydrology (`hydrology`)

- Priority-flood depression filling on the integer heights, D8 flow directions, flow accumulation. All integer, ties broken
  by index, so it is deterministic.
- `fields.flow` (u8, log accumulation) and `fields.wet` (u8: a function of accumulation and distance to surveyed water).
  Material rules and scatter density read `wet` (moss, mud, clay, ferns, dripleaf near water).
- **Designed water, contained.** Channels are opt-in (`channelAt`). A channel is a carve plus **still water source blocks**
  laid level per reach. A drop between reaches is a declared waterfall cell with a basin. The checker's M4 proves
  containment on the virtual world. Writes keep 6a's flags (no fluid updates during the write) and its E-normal guards:
  a tile still skips air writes that would let water in, and the channel's own sources are cells of the tile's entry, so
  undo removes them. `waterlogged` is volatile under "still ours", so a player waterlogging a channel stair is kept, not a
  mismatch.
- Rivers that flow (non-source water) are **deferred**: they change after the write and make E-normal unprovable.

### 4.3 Slope-aware routing (`route`)

A* over the second plan's survey (resolution 1), extended with the frozen volumes where they exist:
- State `(x, z, heading)`, so turns cost and **switchbacks emerge** from a grade limit: a straight climb steeper than
  `maxGrade` is not a legal move, a hairpin with a landing is.
- Moves: walk (cost: length, grade, cut/fill, water), **bridge** (a straight jump across a gap up to `bridgeMax`, cost by span
  and depth), **tunnel** (through rock in a frozen volume up to `tunnelMax`), **stair** (rise 1 per cell, with landings),
  **ladder** (vertical, only where the graph edge allows it).
- Lots, site lots and forms are obstacles; existing paths and 4e roads get a discount (hysteresis, which 6d replanning needs).
- Deterministic: integer costs, ties by (f, g, x, z, heading).
- Output: each edge becomes ordinary primitives (`road` ground or graded, `stair`, `bridge`) or the new connectors (section 8).
  This replaces "routed roads (pathfinding) deferred" from the phase 6 contract.

### 4.4 District layout (`districts`)

Inputs: the settlement plan's districts (each with a size, a level band, preferred affordance kinds, adjacency wishes) and
the affordance catalogue (section 6). The pass assigns nodes to affordances: greedy by score with constraints for small N,
an exact assignment (Hungarian, integer costs) when a district has at most 64 candidates. Then it builds the graph's edges:
a minimum spanning tree over the assigned nodes by route cost, plus loops where the plan asks for circulation
(`loopiness`). Output: `siteLots`, `lots` (pads), graph nodes and edges.

---

## 5. The 3D site volume (prerequisite, 6b)

### 5.1 Survey

```java
// API 1.9.0 (6b), additive
interface Survey {
  CompletableFuture<Volume> volume(ServerLevel level, BoundingBox box, LoadPolicy load);   // sliced, server thread
}
record Volume(String sha, BoundingBox box, String blobId, Map<VoxelClass, Long> counts, int missingColumns) {}
enum VoxelClass { AIR, ROCK, SOIL, LOOSE, ICE, SNOW, WATER, LAVA, LOG, LEAVES, PLANT, OWNED, PLAYER, BLOCK_ENTITY, MISSING }
```

- **Classes, not block states.** `ROCK` = stone-family natural blocks, `SOIL` = dirt family, `LOOSE` = sand and gravel
  (gravity), `ICE` = ice, packed and blue ice, `OWNED` = a cell some journal entry owns (with the entry id in a side table),
  `PLAYER` = non-natural with no journal owner, `BLOCK_ENTITY` = any block entity. The kit's block table already classifies
  natural blocks (`blocks.mjs` family and collision class).
- **Encoding `ARVX`:** per column, bottom-up runs of (class u8, length varint) from `box.minY`, gzip. Natural terrain is a
  handful of runs per column, so a 256x256x128 box is about 1-3 MB (est.).
- **Only candidate areas and lot volumes**, never the whole claim: 1000x1000x100 is about 100M cells. Candidates come from
  the coarse plan's 2.5D cues (`slopeAt` over a threshold, `height - ground` over a threshold, a ground far below its
  neighbours, the tree flag, water) and from the program (`r.needVolume(box)`). Limit: 16M cells per region in 6b (est.;
  measured, then set).
- **Frozen like heights.** A volume is taken once, written with write, fsync, rename and read-back to
  `<world>/architect-regions/<id>/volumes/<sha>.bin`, and never rewritten. Sliced over ticks with the 4a Survey budget; it
  reads chunk section palettes, so single-valued sections (all air, all stone) cost almost nothing.
- **Drift inside a volume.** Before a site lot's item starts, the mod re-samples the lot's volume (sliced) and compares it
  by class against the **expected** state, which is not the frozen volume alone: a site lot is designed against the virtual
  world, so the expected state is **the frozen volume with the region's own writes overlaid** (the cells of the region's
  tile entries that touch the lot volume, which are written before the lot by stage order). A generated host tree, island or
  spike is therefore expected, not drift. The live sample **looks through region-owned cells** to their block's class (an
  `OWNED` cell whose owner is this region classifies as the block it holds, so a generated log is `LOG`). Any cell the
  design marked **keep-critical** (a trunk, the rock a cantilever bears on, a cave ceiling a suspended house hangs from)
  that differs refuses with `SITE_DRIFTED`, naming the cells. Other differences over a tolerance (2% of cells, est.) also
  refuse; under it they are notes. The caller re-fits (section 7.5) or replans. Outside a region (section 7.8) the expected
  state is the volume itself.

### 5.2 The virtual world

6b's virtual world becomes `2.5D survey + volumes + IR`: where a volume exists, the checker and the designer see it cell for
cell; elsewhere columns are filled solid from `floor` down and air above `height`. Lot interiors are their declared boxes for
pad lots (as A5B §3) and their **actual designs composited with the volume** for site lots once designs exist (step 13).

---

## 6. Site analysis and affordance lots (7a)

A deterministic analysis at plan time over the plan survey and the frozen volumes:

| Kind | Detector (on volume runs and 2.5D) | Gives |
|---|---|---|
| `cliff_face` | a vertical boundary of solid (ROCK/SOIL) against AIR at least `h` tall and `w` long; normal from the air side; planarity by row offsets | `attach_to_cliff` and `carve_into` lots along the face |
| `ledge` | standable solid shelf on a cliff, depth at least `d`, headroom at least 3 | small pad lots; switchback landings |
| `overhang` | solid above AIR at least 4 tall, extending at least 3 from the face | `suspend` lots; sheltered pads |
| `cave` | connected AIR components fully enclosed by the volume except openings; size, floor area, ceiling height, openings | `carve_into`/cave-floor lots; tunnel endpoints |
| `trunk` | LOG columns at least 12 tall, radius per y (from the frozen volume, or a generator's skeleton directly) | `wrap_trunk` lots |
| `canopy` | LEAVES layers with area at least `a` and a trunk under them | canopy platforms; `suspend` from branches |
| `spike` | ICE (or ROCK) runs narrow and tall: width at most 5, height at least 12 | `wrap_trunk` (on a spike), lookout lots |
| `water` | WATER areas and depth from 2.5D | stilt lots (`on_pad` with pillar foundations), docks |
| `gap` | pairs of opposing `cliff_face`s with span at most 48 and overlapping height bands | `span` lots; bridge edges |
| `pad` | today's `flatAreas()` | `on_pad` lots |

- **Stable ids.** An affordance id is a hash of its kind and its quantized geometry (box rounded to 4, normal), so a
  re-analysis of unchanged land gives the same ids. 6d replanning depends on this.
- **Scores** combine size, accessibility (route cost from the entrance), exposure and the plan's preferences.
- Output, in `plan.json` and `RegionPlan`: `affordances: [{id, kind, box, anchors, normal, metrics, score}]`.

```java
record Affordance(String id, Kind kind, BoundingBox box, List<BlockPos> anchors, @Nullable Direction normal,
                  JsonObject metrics, double score) {
  enum Kind { CLIFF_FACE, LEDGE, OVERHANG, CAVE, TRUNK, CANOPY, SPIKE, WATER, GAP, PAD }
}
```

**Lot types.** A pad lot stays 6a's `lot()`. A **site lot** (`r.siteLot(id, {affordance, fit, max, ports, brief})`) records:
the fit mode, the **frame** (an origin and rotation that map the design's own coordinates, front south, to world), the lot
**volume** (the design's allowed box plus a margin, inside a frozen volume), the child cap (96x64x96 or a composite,
section 12), and **port requirements**: where the settlement graph will arrive (section 8). A site lot writes no pad; the
region only reserves its volume (no region op writes inside it except the forms the lot is about, such as its host tree).

---

## 7. Site-aware design (7b)

### 7.1 Fit modes

| Fit | Means | TerrainFit (what placement does to unwritten cells) | Approach | Support rule (checker) |
|---|---|---|---|---|
| `on_pad` | today | clear natural above the ground row, clear leaves, fill foundation down to 12 | `ground` (today's strip) | today's `no_floating` |
| `carve_into` | rooms cut into rock; the rock stays as walls, floor and ceiling | **keep** every unwritten cell; the design writes air where it carves | `port`: the facade's door port meets a graph edge | every cell connects to site-solid; rock counts as enclosure |
| `attach_to_cliff` | the building hangs on or stands against a face, bearing on it | keep unwritten cells; no foundation fill; the design writes its own brackets and beams | `port` | every cell connects to site-solid within the cantilever limit; brackets bear on at least 2 rock cells each |
| `span` | bridges a gap between two faces or two trunks | keep | `port` at both ends | both ends bear on site-solid over at least 2x2 cells each; unsupported span within the bible's limit |
| `wrap_trunk` | rings a trunk (natural, generated or a spike) | keep logs and leaves the design doesn't write; never clear the host's leaves; no foundation fill | `port` (branch walkway, ladder, stair around the trunk) | every cell connects to the trunk or to site-solid; the trunk cells are keep-critical |
| `suspend` | hangs from a ceiling, overhang or branch | keep | `port` | every cell connects upward to site-solid through chains or posts, chain runs within the limit; hang points are keep-critical |

A design declares its fit; the request gives it. **Keep cells are absent cells, not a block.** `structure_void` is not an
option: it is on the kit's creative-only list (`SURVIVAL_CREATIVE_ONLY` in `kit/lib/check.mjs`) and in the mod's
`survival_items.json`, so placement would refuse `CREATIVE_ONLY_BLOCK` and the BOM would choke on it. Instead `bp.keep(...)`
leaves those cells out of the template's block list (vanilla templates are sparse; a structure block save omits
structure-void cells the same way), and the sidecar records `keep: {critical: [...], mask?: blobRef}`. TerrainFit already
distinguishes a cell the template doesn't write (`writes[] = 0`) from written air (`1`), so what changes is only the
policy for the "doesn't write" cells (section 7.5). The template writer, BuildOrder and the BOM never see keep cells,
because they are not in the template. The `.nbt` stays a plain vanilla template.

**The host-tree exemption.** 6a removes a worldgen tree whole when an op takes any of its logs. A site lot's host
(`siteLot.affordance` of kind `trunk` or `canopy`) is recorded in the IR, and region ops skip its logs and the leaves that
hang on them (noted, `host`). Forms the region grows as hosts are ops of the region and stay, as any CELL tile cell.

### 7.2 Kit changes

```js
import { Blueprint } from '../lib/kit.mjs';
import { Site } from '../lib/site.mjs';                     // NEW
export const id = 'trunk_house';
export const fit = 'wrap_trunk';
export const params = { storeys: { type: 'int', min: 1, max: 3, default: 2, label: 'Storeys' } };

export default function build({ palette: p, site, storeys = 2 } = {}) {
  // site: a Site in the design's own frame (front = south, +y up), covering the lot volume plus 8 cells of margin
  const t = site.trunk();                                   // { cx, cz, radiusAt(y), y0, y1 }  (or throws: wrong affordance)
  const bp = new Blueprint({ id, type: 'house', fit, site, size: site.size, palette: p });
  bp.keep(site.cellsOf('log'));                             // never write the trunk; keep-critical by default
  for (let s = 0; s < storeys; s++) {
    const y = t.y0 + 6 + s * 5;
    bp.part(`deck_${s}`, () => bp.ringDeck(t.cx, t.cz, t.radiusAt(y) + 1, t.radiusAt(y) + 6, y, { brackets: 'trunk' }));
  }
  bp.port('door_w', 'architect:walk', ...site.portHint('w'), 'west');   // where the graph arrives
  return bp;
}
```

- **`Site`** (`kit/lib/site.mjs`) is built from an ARVX volume window and the lot spec: `at(x, y, z)` gives the class;
  `surface(x, z)`, `ceiling(x, z)`, `faces()`, `trunk()`, `ledges()`, `cellsOf(cls)`, `solid(x, y, z)`, `portHint(side)`,
  and `size`. It is the same object in the designer's scratch dir, the checker and the renderer.
- **Helpers for terrain-merged forms** (all ordinary kit code): `ringDeck` (annular deck around an axis), `bracket`
  (diagonal stairs or fences from a face), `hangChain`, `beamInto` (a beam that ends 1 cell inside rock), `carveRoom`
  (writes air in a box but only where the site is solid, lines exposed soil with the foundation role), `facadeOnFace`
  (a wall that follows a face's offsets), `stilts`.
- **The template box** is the lot volume's box (at most 96x64x96 or a composite). `groundY` is meaningless for non-pad fits;
  the sidecar records `fit` and `frame` instead.
- **Variants.** Palette and bible variants work as today (no geometry changes). Size and param variants **re-run the program
  against the same site** ($0), and the checker re-checks them. A variant at **another site** is a **site variant**: the
  same program with another lot's `Site` ($0 when it checks clean). This is what makes archetype reuse work across a
  settlement: 3 designed trunk houses become 12 by site variants on 12 trunks.

### 7.3 The designer: prompt, inputs and tools

The scratch dir gains `site/`: `site.arvx`, `site.json` (the lot spec, fit, frame, ports wanted, keep-critical hints,
affordance metrics), and four renders of the **empty site** from the kit renderer (iso from the open side, section through
the lot's axis, top, and the composite camera the gallery uses). BRIEF.md gains a "Site" section written by the sidecar:

- what the site is in words generated from the analysis ("a west-facing granite face, 31 tall; a ledge 4 deep at y+9;
  overhang above y+22; the gap to the east face is 19");
- the fit mode and what it requires (from the table above);
- where connections arrive (port requirements), and that the approach is a port, not a ground strip.

Tools (kit CLI, as today, plus the site):
```sh
node kit/build.mjs <id> --site site/site.arvx --lot site/site.json --max X,Y,Z --json   # build + check, composited with the site
node kit/render.mjs kit/out/<id>.nbt --site site/site.arvx --views iso,section,composite # the design IN its site
node kit/tools/slices.mjs kit/out/<id>.nbt --site site/site.arvx --y 8-12               # slices with terrain shown (# rock, ~ water, T log)
```

The PLAYBOOK gains a "Building into a site" section: plan in the site's frame, keep what you don't need to change, bear on
rock, put the door where the port is, look at the composite render, not the floating template.

**Expectation, stated honestly.** Claude's 3D spatial reasoning from voxels is the weakest link here. The design leans on
code: the `Site` helpers answer "where is the face, what radius is the trunk at y", and the fit rules catch what the agent
gets wrong. Rounds are driven by checker findings only, as 6c and 5b decided. No critic.

### 7.4 The checker with a site

`checkStructure` takes an optional `site`. The grid becomes **template composited with the site**: site solids are terrain
for support, light occlusion, walking and enclosure. New rules, all starting as warnings except the first:

- `site_keep` (**error**): no write into a keep cell, a `PLAYER` cell, a `BLOCK_ENTITY` cell, or an `OWNED` cell of another
  owner.
- `fit:<mode>`: the support rule of the mode (table above), with counts and sample cells.
- `site_breach`: a carve that opens into WATER or LAVA within 1 (the building-scale M4), or into an unlit cave component
  bigger than the room (spawn exposure).
- `ports_met`: every required port exists on the design's boundary, facing out, standable, at the hinted cell within 2.
- `cut_volume`: removed rock cells against the fit's allowance (a `carve_into` house may remove at most its interior
  volume plus walls; a `wrap_trunk` house removes no logs).
- Existing rules apply on the composite: `door`, `lit`, `floors_reachable` (from the port, not from a ground entrance),
  `attach:`, `facing:`.

### 7.5 Placement: TerrainFit, Approach, `fitToSite`

- **TerrainFit** gets a policy from the fit: `CLEAR` (today) or `KEEP`. Under `KEEP` the plan does no clearing, no
  foundation fill and no leaf clearing; keep cells (absent from the template) are not touched. The snapshot (the BOX entry's restore box) is
  still the whole template box, so undo is exact.
- **Approach** gets a mode: `GROUND` (today), `PORT` (no strip: the verdict notes "door port faces a graph edge" and, under
  a region, the link pass guarantees the edge), `NONE`.
- **`Sites.fitToSite`** (7b, API 1.12.0):

```java
record SiteLotSpec(String lotId, FitMode fit, Frame frame, BoundingBox volume, String volumeSha,
                   List<BlockPos> keepCritical, List<PortReq> ports) {}
enum FitMode { ON_PAD, CARVE_INTO, ATTACH_TO_CLIFF, SPAN, WRAP_TRUNK, SUSPEND }
record Frame(BlockPos origin, Rotation rotation) {}          // design coords (front = south) -> world
record PortReq(String name, String kind, BlockPos atDesign, Direction facing, int width, int height, @Nullable String edge) {}
interface Sites {   // additions
  default LotFit fitToSite(String blueprintId, SiteLotSpec lot, FitOptions o) { throw new UnsupportedOperationException("... needs Architect API 1.12.0"); }
}
// Reason (appended): SITE_DRIFTED, KEEP_LOST, UNSUPPORTED, SITE_MISMATCH
```

  There is no rotation search: a site-bound design is placed only in its own frame. `SITE_MISMATCH` refuses an entry bound
  to another volume sha. `KEEP_LOST` refuses when a keep-critical cell is gone. `UNSUPPORTED` comes from a live support scan
  of the composite (the same rule as the checker's, on the real world).
- **Library binding.** `Library.Entry` gains `Optional<SiteBinding> site()`, with
  `record SiteBinding(String volumeSha, FitMode fit, String lotId, BoundingBox volume, String regionPlanId)`. A site-bound entry
  shows a pin badge in the Library. Placing it elsewhere offers "site variant here" (a re-run on a new volume, $0) instead
  of a plain placement.

### 7.6 Exact undo with merged terrain

Nothing new is needed in the journal. A site lot is a BOX `site` entry LAYERed over whatever the region wrote (forms, relief,
host tree) and over natural terrain. Its `before` is the whole box, keep cells included. Remove in any order works
through 4e hand-down: if the region is removed while the house stands, the trunk cells the house's box covers are handed
down, and the house's later Remove restores the pre-region state there. Two things are new and get tests:
- **keep cells under BOX:** a BOX entry whose template didn't write a cell still owns it; the tests prove a host-trunk cell
  survives region-first and house-first removal orders exactly (E-flat) and that the stack never exceeds 8;
- **the player edits a keep cell** (cuts the trunk inside the box): BOX restore puts the trunk back on Remove, as today's
  safe remove does for any cell in the box. That is the existing rule, stated for the new case.

### 7.7 Survival: support order and scaffolding

- **Support order.** `BuildOrder` sorts bottom-up by y. A suspended house built bottom-up starts with floating floor cells,
  and a span starts mid-air. 7b generalises it: order by **support distance**, a BFS over the template's cells from the
  cells adjacent to site-solid (or the keep-critical anchors), ties by y, then today's full/partial/attachable and pair
  rules. Every built prefix is then connected to the site. `on_pad` designs keep today's order byte for byte (the BFS from
  the ground row reduces to it; a golden test proves equality on the kit examples).
- **Gravity blocks** (sand, gravel, concrete powder, anvils, scaffolding itself) are placed only once the cell under them is
  built or is site-solid.
- **Scaffolding is cosmetic** (the construction site places blocks itself, so nobody needs to stand on it). Optional per
  bible: vanilla scaffolding columns under unsupported prefixes, written as a separate `architect:scaffold` CELL entry in
  the site's undo group, removed when the site completes. It costs no items and refunds nothing, so "items in = items out"
  holds unchanged. It is also what makes a half-built rope house read as being built.
- **The crate** goes at the lot's first port's landing (reachable on foot), not in front of a door that opens onto air.
- **Only BOX lots.** Site-aware buildings are templates, so they work in survival worlds today. The region parts around them
  (forms, relief, connectors) are CELL and wait for N4 (K9). Section 20 asks Noah to split N4: terrain vs built connectors.

### 7.8 The standalone path: site-aware design without a region

PLAN's rule for every Steward ask is that it must also be useful to Architect players on its own. Site-aware design is,
without any region: a player marks a plot on a natural cliff, across a ravine, under an overhang or around a big jungle
trunk, picks a fit, and gets a building that fits into it. This is also the path the 7b survival gate uses, since regions
refuse in survival-toggle worlds (K9) and plain building sites don't.

- **Plot marking** gains a fit picker (`on_pad` default) and a "sample site" step: `Survey.volume` over the marked box plus
  8, and a single-lot site analysis that proposes the frame (the face normal, the trunk axis, the gap's two faces) for the
  player to confirm on the ghost.
- **Requests** carry the site:

```java
// API 1.12.0 (7b), additive
record SiteSpec(String volumeBlobId, String volumeSha, BoundingBox volume, FitMode fit, Frame frame,
                List<BlockPos> keepCritical, List<PortReq> ports) {}
// DesignRequest gains a trailing @Nullable SiteSpec site (old constructor = null: today's behaviour)
// PlaceRequest gains a trailing @Nullable SiteSpec site: the verdict runs the site checks (SITE_DRIFTED against the volume
//   itself, KEEP_LOST, UNSUPPORTED) and TerrainFit KEEP / Approach PORT or GROUND per fit
```

- **Approach** outside a region: a `PORT` door must face a standable cell or the verdict warns "the entrance opens onto a
  drop"; the player builds the connection, or a single connector can be requested with the same generators as section 8
  (`Sites.placeConnector(ConnectorRequest)`, a CELL path site like a 4e road; INSTANT only, as 4e cell sites).
- **Survival:** the building is an ordinary construction site with the support order of section 7.7; the terrain it keeps
  is never touched, so no terrain rule is involved.

---

## 8. The settlement graph and connectors (7a)

### 8.1 Data

```
graph: {
  nodes: [{ id, kind: 'lot'|'site_lot'|'landmark'|'plaza'|'gate'|'junction', ref, level, ports: [{ name, at, facing, width }] }],
  edges: [{ id, from: 'node.port', to: 'node.port', type, width, style?, stage, params }]
}
```

Edge `type` is one of the connectors below, or `auto` (the router picks by grade and gap). Ports on a building are its
blueprint ports (R5) of kind `architect:walk` (new standard kind; `door` keeps meaning a door). The checker's port rule
gains `up`/`down` facings for vertical walk ports (ladders, lifts, composite levels).

### 8.2 Connector catalogue

Each connector is a **kit generator** (plan time, deterministic) that takes the two endpoints (world position, facing,
width), the virtual world between them and the bible's connector style, and emits ops (`columns` or `voxels` in a
`links`-stage `path` part, walk cells marked), nav links (section 15), and its support list for M3.

| Type | Geometry and guarantees | Anchoring | Limits (defaults; bible may tighten) |
|---|---|---|---|
| `rope_bridge` | deck of slabs or planks; sag is an integer parabola `y(i) = y_lin(i) - floor(4 * d * i * (n - i) / n^2)`, `d = floor(n / 12)`; rails of fence posts every 2 with chains or walls between; 2 headroom; lit every 12 | posts 2 deep into site-solid at both ends | span 8-40 |
| `catwalk` | deck along a face or between structures on brackets every 4; rails on the open side | brackets bear on site-solid or a building | any length; 1-3 wide |
| `tunnel` | capsule carve (`IF_NATURAL`), floor walk cells, lining with the `lining ?? rock` role where soil is exposed, light every 8 (mandatory), portal frames at both ends | the rock itself | length up to 64; refuses through WATER/LAVA within 2 |
| `rock_stair` | 6a `stair` with `carve: true` and a lining; landings every 8 | rock | rise 1 per step |
| `switchback` | a graded path with hairpins at landings, retaining walls where cut or fill exceeds 2 (6a graded road plus routed turns) | ground | grade at most 1 in 4 |
| `ladder` | a ladder column on a wall or in a shaft; a landing at least every 24 (est.; checked against fatigue-free climbing, not a game rule); a trapdoor or gate at the top edge | a sturdy face behind every ladder cell (the existing `attach:` rule) | height up to 48 |
| `lift` | a **bubble column**: soul sand base, water source column enclosed on 4 sides, entry door at the bottom, an exit opening at the top; down column with magma optional | a full enclosure (M4 proves containment) | height up to 64 |
| `branch_walk` | a deck that follows a tree generator's branch skeleton (section 9) or runs between two branches on rope hangers | the branch capsules | span between hangers at most 8 |
| `span_bridge` | 6a `bridge` (pillars or arches) for gaps with a floor within 24 | ground | as 6a |
| `stairs_around` | a spiral stair around a trunk or spike (6a `stair` with `spiral`) | trunk or spike | rise 1 |

The checker verifies each connector's guarantees on the virtual world (headroom, rails, light, support, containment),
whatever the generator claimed, as 6a's mod does for engine invariants.

### 8.3 Styling from the bible

Bible format 3 (section 10.3) has a `connectors` block: per type, the roles and components to use (`deck`, `rail`, `rope`,
`post`, `hanger`, `lining`, `portal`, `light` component), the preferred types for this settlement (a monastery prefers
`rock_stair` and `switchback`; a treehouse village `branch_walk`, `rope_bridge` and `ladder`), and limits. A connector
generator reads only roles and component ids, so a re-skin restyles every connector without replanning.

### 8.4 Ports and the lot boundary

A connector never writes inside a lot's restore box (K5). It ends on the cell just outside the box in the port's facing, at
the port's feet y. The lot's design owns its landing (the port cell is a standable boundary cell of the template). The 4e
approach rule already stops approaches at walk-surface cells, so an `on_pad` building facing a connector gets the shorter
approach.

### 8.5 The link pass and its timing

Connectors attach to buildings, so they are generated **after** the lots are designed and fitted:
1. IR v1 plans terrain, forms, pads, site lots and the graph topology (edges with endpoints as `node.port` names, routes
   between node anchors as a provisional corridor that later terrain ops keep clear, like a 6b `utility` corridor).
2. Lot entries are chosen or designed and fitted (`fitToLot`/`fitToSite`, no placement).
3. `region.link {planId, lotEntries, fits}` re-runs only the link pass on the virtual world plus the composited designs, and
   produces IR v2: the same parts plus a `links` stage after all lot stages. `lotEntries` and `fits` are part of IR v2's
   identity. Changing a lot's entry later means a new link pass (cheap, $0) and, once placed, a 6d delta.
4. Realise writes stages in order; `links` tiles come last, and the freeze-before-lots rule (section 3.4) has frozen their
   columns before any lot touching them was written.

---

## 9. Natural forms, scatter and features (6b, 6c)

### 9.1 Grow globally, evaluate pointwise

A generator runs at plan time. It grows a **skeleton** with any deterministic algorithm (space colonisation, L-systems,
random walks, all integer or fixed-point) and emits **closed-library shapes**: `capsuleChain`s for trunks, branches and roots,
`ellipsoid`s with `warp` for canopy lobes and rock masses, `cone`s for spikes, `intersect`/`clipY` for caps. The shapes
carry material rules (bark skin, wood core; leaf clusters with holes from a noise mask). Realise evaluates the shapes
pointwise, so a 60-wide tree spans tiles without breaking K2. The skeleton is resolved to absolute y at plan time; roots
reach down past the plan ground by 6 and are `IF_NATURAL`/`IF_AIR_OR_FLUID`, so a few blocks of drift are absorbed (K2).

**Evaluation cost.** The evaluator culls ops by their bounds per column, but inside one op it evaluates the whole shape
tree. A tree emitted as one `union` of hundreds of `capsuleChain` segments would be evaluated against all of them for every
cell in its bounds, which threatens 6a's 2 s per-tile limit and the 45k cells/s evaluation bar. Rule: **a generator emits one
bounded op per cluster** (a branch with its twigs, a canopy lobe, a root), at most about 32 primitives per op (est.), so the
per-op bounds cull. 6c measures evaluation p50/p99 per tile on S2, S3 and a forest-heavy mega_bench variant.

When a form is too detailed for shapes (more than about 400 ops for one form, est.), the generator bakes it as a `voxels`
side blob instead (palette + positions, ARTL-like), which realise copies per tile. Side blobs keep the IR under 4 MB (K4).

### 9.2 The generator library

| Generator | Skeleton | Materials | Gotchas it must handle |
|---|---|---|---|
| `giantTree` | trunk capsuleChain tapering by height, branches by space colonisation toward canopy attractors, roots as capsuleChains bending into ground | bark skin (`log` with `axis` from the segment direction), `wood` core, leaves | **Leaves more than 6 from a log decay.** Generated leaves are written `persistent=true`. They are region-owned CELL cells, so later ops treat them as ours, and `persistent` is not volatile. |
| `rockSpire` | stacked warped cones with ledges | strata bands, weathered skin by `age` noise, moss by `wet` | overhang support (M3) |
| `iceSpike` | clusters of thin cones, a few leaning | `packed_ice` core, `blue_ice` accents, `snow_block` caps | **Ice and snow layers melt at block light above 11; packed and blue ice don't.** The material rule never uses `ice` or snow layers within 3 of a light component (M17). |
| `mushroom` | stem capsuleChain, cap = ellipsoid intersect clipY, gills underside | stem, cap and spot blocks | mushroom blocks' face properties set from neighbours |
| `coral` | branching capsuleChains, fans | coral blocks only **in water** | **Coral dies out of water.** Dry coral cells use the dead variants, or the generator refuses outside a water volume (M19). |
| `floatingIsland` | an inverted warped teardrop (ellipsoid top, cone underside), top relief from noise, hanging roots | material rule by depth: grass skin, dirt to 3, stone core, ores by noise | M3 `floating` declaration and anchor |
| `roots` | capsuleChains from a trunk base down a cliff or into a cave | `rooted_dirt`, `mangrove_roots`, hanging roots | none |
| `stalactites` | cones from a ceiling and floor, merged as columns | dripstone blocks; `pointed_dripstone` thickness states | pointed dripstone's `thickness` from the cone radius |

Each generator ships with bundled params per **species** (oak, spruce, jungle, mangrove, cherry, crimson ...), a bible may
name others, and property tests (section 13).

### 9.3 Scatter and decoration

The `scatter` op (section 3.4) places small things on ground, walls and ceilings: plants, boulders (warped ellipsoids up to
radius 3), stumps, lanterns along paths (a bible component placed per N cells of walk surface), moss carpets, snow layers,
glow lichen on cave walls. Density reads fields (`wet`, distance to paths, district masks), so decoration follows the plan
without a global pass at realise.

### 9.4 Vanilla worldgen features

Vanilla features (huge mushrooms, geodes, fossils, trees, dripstone clusters) are Java code that can't run in the sidecar,
so they would break "checked without the game". Two routes:
- **Stamps (6c, recommended).** A DevBridge tool (`dev.feature.stamp {feature, seeds: [..], ground}`) places the feature in a
  scratch world, captures the cells it wrote into a **stamp** (palette + positions + root cell), and the kit ships a stamp
  library (`kit/stamps/<feature>/<seed>.bin`, harvested once per Minecraft version). A `stamp` op places one at plan-chosen
  positions; the checker and previews see it. Stamps don't adapt to slopes, so the op adds a root skirt to the frozen ground.
- **Live capture (deferred).** A recording `WorldGenLevel` proxy runs the feature at realise P1 and turns its writes into the
  tile entry's cells. Exact undo would hold (they're CELL cells), but previews and the checker would only see the result after
  capture, and the proxy surface is large. Deferred until stamps prove too rigid.

---

## 10. Settlement-scale planning by Claude (7c)

### 10.1 What Claude decides and what code decides

Claude decides **concept, districts, circulation and verticality**: structured data, not code. Code assigns, routes,
generates and checks. That keeps the expensive and unreliable part (spatial reasoning over voxels) in deterministic passes.

```json
{ "concept": "a monastery that grows down the cliff it was cut from",
  "levels": [ { "name": "summit", "band": "top" }, { "name": "cloister", "band": "upper-third" }, { "name": "gate", "band": "foot" } ],
  "districts": [
    { "id": "chapel", "level": "summit", "nodes": [ { "id": "chapel", "role": "landmark", "fit": ["attach_to_cliff", "on_pad"], "size": "L" } ],
      "prefers": ["cliff_face", "ledge"] },
    { "id": "cells", "level": "cloister", "nodes": [ { "id": "cell_*", "count": 6, "role": "dwelling", "fit": ["carve_into"], "archetypes": 2 } ],
      "prefers": ["cliff_face"] } ],
  "circulation": { "spine": ["gate", "cloister", "summit"], "spineType": ["switchback", "rock_stair"], "loopiness": 0.2,
                   "secondary": ["ladder", "catwalk"], "avoid": ["lift"] },
  "forms": [ { "generator": "rockSpire", "where": "near:summit", "count": 2 } ],
  "decor": { "scatter": ["moss", "prayer_flags"], "density": "sparse" },
  "mustPass": ["M1", "M2", "M3", "M4", "M2:villager:cells"] }
```

- **The job:** a structured `job.run` (Sonnet by default, Opus for a landmark-heavy brief), with the concept card, the
  affordance catalogue (top 60 by score, as JSON), the survey summary, and **images**: the site's top hillshade with
  affordance ids overlaid, two sections, an iso. Cost est. $0.3-1.5.
- **The realiser** (kit, deterministic): districts → `districts` pass → `route` → forms → scatter → IR v1. If the plan can't
  be satisfied (no affordance for a required node), the realiser returns typed findings and Claude gets **one** repair
  round with them (est. $0.2-0.8).
- **Program authoring** (old 6c, kept): when the brief needs ops the plan schema can't express, a program-writing session
  as the phase 6 contract specified (checker-driven rounds, 4 rounds cap, no critic). It now has the passes, generators and
  connectors as library calls, so programs are shorter.

### 10.2 Template-first stays first

`Regions.design` keeps the cheap pick (measured $0.01-0.05) among bundled programs. In 7c the catalogue includes the six
scenario programs, parametrised, so a "ravine town" brief over a ravine usually costs a pick, not an authoring session.

### 10.3 The settlement-scale style bible (format 3)

Format 3 = format 2 plus, for `scope: settlement`:

```json
{ "format": 3, "scope": "settlement",
  "connectors": { "prefer": ["rope_bridge", "ladder", "branch_walk"],
                  "rope_bridge": { "deck": "accent", "post": "frame", "rope": "minecraft:chain", "sagRatio": 12, "maxSpan": 32, "light": "lantern_post" },
                  "ladder": { "landingEvery": 16 }, "tunnel": { "lining": "lining", "portal": "door_surround" } },
  "forms": { "giantTree": { "species": "jungle", "heightBand": [40, 70] }, "rockSpire": { "strata": ["tuff", "calcite"] } },
  "materials": { "age": 0.6, "rules": { "rock": "<materialRule>", "path": "<materialRule>" } },
  "scatter": { "ground": ["fern", "moss_carpet"], "wall": ["vine", "glow_lichen"], "density": "moderate" },
  "settlement": { "verticality": "high", "density": "low", "lightEvery": 10, "edges": "railed",
                  "roleShares": { "wall": [0.25, 0.45], "frame": [0.10, 0.25], "accent": [0.02, 0.10] } },
  "references": [ { "blob": "...", "label": "silhouette" } ] }
```

`roleShares` gives the theme-fit metric its target bands (section 16). `references` are images (section 16.4). A format-2 bible
keeps working: defaults fill the new blocks.

---

## 11. Gameplay validity (6b-7b; the phase of each rule is in section 17)

New macro rules continue A5B's numbering. Every new rule starts as a warning and is promoted by the usual process.

| # | Rule | Check |
|---|---|---|
| M2 (extended) | **Reachability per mover** | Three walk graphs on the virtual world: `player` (step 1, ladders, scaffolding, bubble columns, doors, trapdoors, fall at most 3), `villager` (step 1, doors, no ladders, no lifts, no water columns, no 1-wide gaps), `steward` (player moves plus Steward's typed links). Each node and district declares which movers must reach it; dwellings and job sites default to `villager`. **The villager rules are to be verified against 26.3's walk node evaluator and path types** before M2's villager graph is promoted; nothing here assumes vanilla behaviour for ladders or scaffolding. |
| M5 (extended) | **Spawn-proofing** | Spawnable surfaces (a per-block flag from the 26.3 data generator, to be generated into `blocks.mjs`, not hand-listed) with block light 0 inside the settlement's bounds: walk surfaces, roofs, canopies, cave floors, under overhangs. Reports area and samples. |
| M8 (promoted plan) | **Fall protection** | Every walk cell beside a drop over 3 has a barrier at least 1.5 tall (fence, wall, pane) or water at least 2 deep below, unless the bible says `edges: open` for that edge type. Connectors are generated to pass it. |
| M15 | **Structural sense** | Beyond M3's connectivity: unsupported span per connector and per building part within limits; cantilever (a solid cell more than 4 horizontally from a support column or a bracket); **necks** (a mass over 200 cells hanging on fewer than 2 cells of contact). |
| M16 | **Flood behaviour** | Static: for each water body the plan touches, the cells that would flood if any one barrier cell were removed. A walk cell or lot below a water surface in the same basin with a barrier thinner than 2 is a finding. |
| M17 | **Melt** | No `ice` or snow layer within reach of block light above 11 (from the kit's light model). |
| M18 | **Decay** | No non-persistent leaves more than 6 from a log. |
| M19 | **Dead coral** | No live coral without adjacent water. |
| M20 | **Fire** | No flammable block within 2 of lava or an open fire source. |
| M21 | **Site fit** | For site lots: the `fit:<mode>` rules of section 7.4 on the composite. |

---

## 12. Composite structures past 96x64x96 (7c)

A **composite** is a set of modules, each an ordinary template within the cap, joined at **joint ports**:

```js
export default function composite({ palette, site }) {
  const c = new Composite({ id: 'great_hall', site });
  const nave = c.module('nave', buildNave, { at: [0, 0, 0] });                 // each module: a Blueprint <= 96x64x96
  const tower = c.module('tower', buildTower, { at: [70, 0, 10] });
  c.join(nave.port('east_arch'), tower.port('west_arch'));                    // ports of kind architect:joint, same width/height
  return c;
}
```

- **Joint rule.** A joint is a pair of `architect:joint` ports at the same world cell boundary, opposite facings (`up`/`down`
  allowed), same width and height. The checker runs on the **union grid** (the kit has no size cap offline) and checks every
  rule across seams; it errors on an unmatched or mismatched joint.
- **Placement.** One site group, modules as BOX sites in dependency order (support first: a tower on a nave roof follows
  the nave). Modules may touch (4d: a 0-block gap is legal). Where a seam must overlap (a shared wall), the later module
  LAYERs over the earlier one, so the stack-of-8 limit and `OVERLAP_BUSY` waits apply as 4e.
- **Undo** per module or the whole group, exact as 4e.
- **Library.** One entry with `modules: [...]` and one preview set; the modules are hidden entries.

---

## 13. Shape promotion (7c)

Claude may write new generators or shapes inside a program. At plan time that is already safe (K1): their output is data.
**Promotion** makes such a generator a kit module that other programs call and that realise can evaluate lazily from a
small spec (no blob), which matters for IR size and for 6d diffs.

A candidate goes through, in order, with each step recorded in `kit/forms/CANDIDATES.md`:
1. **Lint.** Plan-path code under the realise lint (no trig, no `**`, no `Date`, no `Math.random`).
2. **Determinism.** Byte-identical output for 3 runs, 2 Node majors, macOS and Linux; a golden file of shas over 20 seeded
   params.
3. **Properties** (property tests over random params): bounds contain every cell; pointwise evaluation per tile equals whole
   evaluation; support connectivity (M3) of the output; material rules resolve; no cell outside the declared bounds; eval
   cost per cell within 2x of the existing generators.
4. **Variety.** 20 seeds rendered on a contact sheet; pairwise silhouette IoU below 0.8 for at least 80% of pairs (they
   aren't all the same tree).
5. **Noah's gallery approval** of the contact sheet.
6. A semver'd kit module with params, species and docs. Kit version bump; older IRs that embedded the baked form still
   evaluate.

---

## 14. Incremental replanning on land change (with 6d)

Land changes (the player digs, builds or cuts trees; Steward adds a district; a tree grows) must not reshape the whole
settlement. Design, to be built with 6d:

- **What re-runs.** Fields from the original plan are part of its IR and are **not recomputed** for unchanged areas. A
  replan computes passes only over **dirty tiles plus a 16-column margin**, with the old field values as boundary conditions.
- **Stable ids everywhere.** Affordance ids (quantized geometry hash), graph node and edge ids, part ids and form ids are
  stable. A replan diffs IR by part id (6d's model) and by graph edge.
- **Routing hysteresis.** Existing edges are pinned unless an endpoint moved or the route is blocked; blocked edges re-route
  with a discount on cells of the old route.
- **Site-bound lots.** A change inside a standing lot's volume does nothing until someone asks; a change to a keep-critical
  cell of a standing building is reported (the site is "damaged"), and a re-fit is a 5b-style delta of the same program
  against the new volume.
- **Drift at realise** (stages not yet placed): `DRIFTED` and `SITE_DRIFTED` offer "replan affected stages", which re-runs
  only parts whose tiles or volumes changed.
- **Writing under standing lots** stays 6d's open problem (the pad delta under a BOX cover). Nothing here works around it.

---

## 15. Steward-side needs

### 15.1 What Architect exports

- **`siteplan.json`** (6b, which Steward already reads per A6-REVIEW S10) gains the settlement graph: nodes, typed edges,
  ports, levels and districts.
- **`nav.json`** (7a), per region, in the plan dir and in the world dir:

```
{ "format": 1, "regionId": "...",
  "nodes": [{ "id": "n12", "at": [x, y, z], "area": 18, "mover": ["player", "villager", "steward"] }],
  "links": [{ "from": "n12", "to": "n40", "kind": "walk|stair|ladder|lift_up|lift_down|rope_bridge|catwalk|tunnel|door|trapdoor",
              "cells": [[x, y, z], ...], "cost": 14, "width": 2, "mover": ["player", "steward"] }],
  "pois": [{ "node": "n12", "lot": "smithy", "port": "door_s" }] }
```

  Nodes are walk-surface regions (flood-filled patches up to 32 cells) on the virtual world after realise; links come from
  the connector generators (which know what they built) and from the walk graph. `RegionView` gains `navPath()`.
- **API:** `Regions.nav(regionId) -> Optional<Path>` and a `NAV_UPDATED` event when a stage completes (the nav graph covers
  placed stages only).

### 15.2 What Steward needs to build (for Steward's planning, not Architect's)

- **NPC navigation with typed links.** The steward entity needs a navigator that follows `nav.json` links as off-mesh links
  (climb a ladder, ride a bubble column, cross a rope bridge), with vanilla pathing inside a node's patch. Verify against
  26.3's `PathNavigation` and node evaluators what a custom entity can do natively before writing link traversal.
- **Villagers stay on villager-reachable components.** Housing, beds, job-site blocks, the bell and the meeting point go on
  nodes whose mover set includes `villager`. The settlement plan's `mustPass` names them (`M2:villager:cells` above), and
  Steward's housing and trading-hall placement should consume the mover sets rather than assume villagers can climb.
- **Vertical routines.** Route costs favour stairs over ladders, avoid lifts for routine errands, and treat a rope bridge in
  rain or at night as costlier (Steward's choice). Jobs for vertical settlements (a lamplighter that walks lit connectors,
  a lift keeper, a bridge warden) are Steward content built on the same graph.
- **Difficulty modes.** Patron works with everything here. Supplied and Hardcore get BOX lots as construction sites (site-
  aware ones included, with support order); connectors, forms and relief wait for Noah's N4 split (section 20).

---

## 16. Evaluation: the scenario ladder

### 16.1 Why not a judge

5a's critic never reached its ship line (mean 5.48 to 5.76 against 7), the blind Opus pairwise judge split 7/6/5 (p 0.50),
and 5b's critic accepted 0 visible fixes. No phase here depends on a model judging renders. Gates are **deterministic
metrics** plus **Noah's approval in a gallery**. Report-only critiques may still run (Steward uses them for its inbox), never
as a gate.

### 16.2 The six golden scenarios

Each scenario is a bundled program (written by the builder sessions, not at runtime) over a pinned terrain fixture, plus a
one-line brief for 7c. Natural fixtures are found once by a site-search tool over a pinned world seed (`tools/find-site.mjs`:
survey a grid of candidate claims, score by the scenario's affordance needs, record the winner's coordinates) and frozen in
the scenario file. Every scenario that sculpts its own terrain also has a **flat-world variant** for E-flat exactness.

| # | Scenario | Fixture | Claim (est.) | Brief (7c) | First green |
|---|---|---|---|---|---|
| S1 | Floating islands | plains/ocean, pinned seed; islands generated | 256x256, y to 200 | "a hamlet on floating islands, linked by rope and stone" | 6b |
| S2 | Ice-spike outpost | an ice spikes biome location, pinned; spikes kept, plus generated ones | 192x192 | "a frontier outpost among the ice spikes" | 6c |
| S3 | Mountainside monastery | a stony or jagged peaks location, pinned | 192x192, 120 tall | "a monastery that grows down its cliff" | 6c (v1 terraced), 7b (v2 cliff-built) |
| S4 | Ravine town | a canyon location, pinned; plus the sculpted `rift_city` fixture for E-flat | 256x160 | "a town hanging in a ravine, bridges everywhere" | 7a (v1 ledges and pads), 7b (v2 spans and cliff houses) |
| S5 | Treehouse village | a forest location, pinned; giant trees generated | 192x192 | "a village in the crowns of giant trees" | 7b |
| S6 | Cave city | a mountain location, pinned; a sculpted cavern plus any natural cave the volume finds | 192x192, 80 tall | "a city carved inside the mountain" | 7b |

### 16.3 Measurable checks (every scenario, every phase that touches it)

| Check | Metric | Bar (start; tightened as data comes in) |
|---|---|---|
| Reachability | M2 per mover on the realised world (re-surveyed volume, not the virtual one) | `player` 100% of nodes; `villager` 100% of dwellings and job sites that declare it; 0 unreachable ports |
| Structural sense | M3 + M15 | 0 floating (outside declared `floating` parts), 0 necks, every span and cantilever within limits |
| Safety | M4, M5, M8, M16-M20 | 0 errors; M5 dark spawnable area under 1% of walk area; M8 100% of drops over 3 guarded (unless the bible opts out) |
| Theme fit: palette | **role adherence**: share of non-terrain written cells whose block is a bible role, a role's shape variant, or a form material; **role shares** within the bible's `roleShares` bands | adherence at least 0.9; every banded role inside its band |
| Theme fit: motifs | counts from named parts and components: e.g. lantern posts per 24 path cells, connector types used vs the bible's `prefer` list, bible motifs present per district | at least 80% of connectors of preferred types; each hero motif present in every district |
| Theme fit: organic read | **axis-run share**: of the exterior boundary cells of forms and terrain edits, the share lying on straight axis-aligned runs of 6 or more | forms at most 0.25 (est.; calibrated on S1 in 6b); recorded for buildings, not gated |
| Fit | share of the scenario's lots with the fit it calls for; **disturbance**: (cut + fill cells) / lot volume for site lots; pad area as a share of the claim | S5 at least 75% of dwellings `wrap_trunk`/`suspend`; S6 at least 75% `carve_into`; disturbance at most 0.3 |
| Buildings | the kit checker 0 errors; `detailNoise` and `accentShare` within bible restraint | as 5a |
| MSPT and throughput | 6a's bars | 0 ticks over 50 ms, p99 at most 25 ms; the light-engine tick share recorded (canopies and caves stress it) |
| Exactness | 6a's E-flat (flat variant) and E-normal (classified) after one `Regions.remove` | 0 / classified |
| Spend | the run's spend against its estimate | within ±50% |
| Gallery | Noah's approval | approved, with notes recorded in PLAN.md |

A scenario is **green** in a phase when every bar passes and Noah approves its gallery page. A phase's gate requires its new
scenarios green and every earlier green scenario still green (regression runs are $0: designs are cached library entries
keyed by volume sha, brief and bible, and the link pass and realise are deterministic).

### 16.4 The gallery

`tools/scenarios.mjs run <scenario> --phase <p>` writes `artifacts/scenarios/<phase>/<scenario>/`: the metrics JSON, the
four sidecar previews, and in-game screenshots from 6 fixed cameras (the scenario's `cam_*` anchors, DevBridge, fixed time
of day and weather), plus the same cameras from the previous phase's run. `tools/scenarios.mjs gallery` assembles one local
HTML page: per scenario, before/after side by side, the metrics table, and approve/reject with a notes field that writes
`approvals.json`. If Noah wants it on his phone, it can be published as a private page; that's his call.

### 16.5 Reference images (`job.images`) as a quality lever

`job.images` shipped in 5a (image blocks work under the claude login, measured probe $0.0098). Images already reach designers
(neighbour renders since 4b) and the critic, but they have **never been A/B'd as a quality lever** for generation. Three uses, each A/B'd, none gating:
1. **Site renders into planning** (7c): the top view with affordance ids, sections and an iso. Expected to help the most,
   because it grounds "where" in a picture of the actual land.
2. **Site renders into site-aware design** (7b): the empty-site renders and, after round 1, the composite render.
3. **Style references** into the bible job and the generator-param pick: a few reference images (Noah's, or concept art) for
   silhouette and mood.

Protocol: in 7b and 7c, one scenario per phase runs twice from the same seed, with and without images. Noah picks blind in
the gallery (left/right randomised, the pick recorded before the labels show). Image tokens cost about 1-2k per 1000-px image
(est.), so 8 images add about $0.03 on Sonnet and $0.15 on Opus per call (est.). Report the picks; adopt by default only if
Noah prefers the image runs in a clear majority over the phases' runs.

---

## 17. Phase plan

### 17.1 Scenario x capability matrix

| Capability | Phase | S1 islands | S2 ice | S3 monastery | S4 ravine | S5 trees | S6 cave |
|---|---|---|---|---|---|---|---|
| Harness, gallery, metrics | 6b | x | x | x | x | x | x |
| Checker M1-M14 (+ M2 player), previews, siteplan, ghost | 6b | x | x | x | x | x | x |
| 3D volume survey, virtual world with volumes | 6b | | | v1 | x | x | x |
| IR 2: side blobs, new shapes, material rules | 6b | x | x | x | x | x | x |
| Forms: `floatingIsland` | 6b | x | | | | | |
| Forms: the rest of the library | 6c | | x | x | | x | x |
| Passes: relief, hydrology, routing (switchbacks, bridges, tunnels), districts | 6c | | x | x | x | x | x |
| Scatter, stamps | 6c | | x | x | x | x | x |
| M17-M20 (melt, decay, coral, fire) | 6c | | x | | | x | x |
| Affordances, site lots (pad-compatible) | 7a | | | v2 | x | x | x |
| Graph, connectors, link pass, nav export, M2 villager, M8, M15, M16 | 7a | | | v2 | x | x | x |
| Site-aware design, `fitToSite`, survival support order | 7b | | | v2 | v2 | x | x |
| Claude planning, bible 3, authoring, promotion, composites | 7c | brief | brief | brief | brief | brief | brief |

Each phase adds the fewest capabilities that turn at least one more scenario green.

### 17.2 The phases

Sizes are relative to 6a (6a = 1.0). Versions follow the phase 6 rules: one minor API version per phase.

**6b: checker, previews, volumes and the harness** (API 1.9.0, mod 0.12.0; size ~1.0; spend est. $1-3)
- Kept from the old 6b: the virtual world and M1-M14 (M1, M13 and M14's uniqueness are errors, the rest warnings); prefix
  checks; the four previews and `siteplan.json`; the region ghost; `cavern`, `utility`, `floating`, `underside` taper and rock;
  `wedge`/`prism`/`array`; the four family fixtures and the broken variants; commands, no Terrain tab (N7).
- New: `Survey.volume` and ARVX; IR format 2 (side blobs, `PLAN_STALE` gating); `ellipsoid`, `capsuleChain`, `warp`,
  `strata`, `instances`; material rules; the `floatingIsland` generator; M2 with the `player` mover; the scenario harness,
  gallery and metrics; the graph block in `siteplan.json` (topology only, from 6a's paths and roads).
- Moved from the old 6c, because Steward depends on it: **template-first `Regions.design`** (bundled programs only) and
  **Steward's crater gate** run through it (a template pick, measured seed $0.01-0.05 per pick).
- Gate: the old 6b gate, plus S1 green, plus Steward's crater gate by template pick, plus 6a regressions.
- Depends on: 6a merged.

**6c: forms, fields and routing** (API 1.10.0, mod 0.13.0; size ~1.0; spend $0)
- Passes: relief blending and erosion touch-ups, hydrology and contained channels, routing (switchbacks, bridge and tunnel
  moves), districts; the second plan's survey at resolution 1 up to 1024x1024; plan limits for passes (120 s, 2 GB).
- The generator library (section 9.2), scatter, the stamp library and `dev.feature.stamp`; M17-M20.
- Gate: S2 and S3 v1 green; pass determinism goldens; plan time on a 1024x1024 claim recorded; 6b's gate items as
  regressions; mega_bench A rerun (one) to show the writer bars hold with forms in the mix.
- Depends on: 6b.

**7a: affordances, the settlement graph and connectors** (API 1.11.0, mod 0.14.0; size ~1.0; spend $0)
- Site analysis and affordances; site lots for pad-compatible fits (ledges, cave floors, canopy platforms: a pad inside a
  site); the graph, the connector catalogue and the link pass (IR v2 with `lotEntries`/`fits`); freeze before lots; `nav.json`
  and `Regions.nav`; M2 `villager` and `steward` movers; M8, M15, M16.
- Lots are filled from library entries and variants ($0), as the old 6c gate did.
- Gate: S4 v1 green; S1-S3 still green; connector property tests (every generator's guarantees over random endpoints);
  nav round trip (every link walked by a scripted player in the dev client for S4).
- Depends on: 6c (routing).

**7b: site-aware design** (API 1.12.0, mod 0.15.0; size ~1.3; spend est. $60, cap $90, claude login only)
- `kit/lib/site.mjs`, the fit modes, `bp.keep`, the terrain-merge helpers, the checker with a site, the designer's site
  inputs, prompt section and playbook section, `fitToSite`, TerrainFit `KEEP`, Approach `PORT`, site bindings and site
  variants, support-order construction and cosmetic scaffolding; the standalone path for players (section 7.8: plot
  marking with a fit, `SiteSpec` on design and place requests, single connectors).
- Gate: S5 and S6 green; S3 v2 and S4 v2 green; S1, S2 still green; survival: one site-aware house in each of
  `attach_to_cliff`, `span` and `suspend` built from a hopper chain in a survival dev world, every built prefix connected
  (a scan per 100 cells), items in = items out, identical to its instant placement; the images A/B on one scenario.
- Depends on: 7a. N4 is not needed for the gate: the survival items use the **standalone path** (section 7.8), a
  site-aware house on a player-marked natural cliff, gap or overhang in a survival-toggle world, with no region involved.

**7c: Claude plans settlements** (API 1.13.0, mod 0.16.0; size ~0.9; spend est. $120, cap $180, claude login only)
- The SettlementPlan schema, the planning job with images, the realiser and the repair round; bible format 3; program
  authoring sessions (the old 6c's); shape promotion with its first candidate; composites past the cap.
- Gate: all six scenarios green **from their one-line briefs** over the same fixtures (template pick or plan, never the
  bundled scenario program directly); at least one promoted form; one composite over 96 in some axis placed and removed
  exactly; spend within cap; the images A/B on one more scenario.
- Depends on: 7b.

**6d: region evolution** stays as specified in the phase 6 contract, deferred to Steward's phase 3, and gains section 14.

### 17.3 Spend per scenario run (what a player or Steward pays)

| Run | What Claude does | Est. per run |
|---|---|---|
| Deterministic (6b-7a, bundled program, lots from the library) | nothing | **$0** |
| Bundled program by template pick | one pick (measured $0.01-0.05) | **< $0.10** |
| 7b-style with designs | bible (measured $1.2-2.0); 2-4 site-aware archetypes (Sonnet measured $0.8-2.5 per normal design; site-aware est. 1.3-2x: $1.5-4 each); 1 site-aware landmark (Opus measured $2-3.2 normal; est. $3-5); site variants for the rest ($0) | **$8-25** |
| 7c from a brief | the above, plus the plan job (est. $0.3-1.5) and a repair round (est. $0.2-0.8); an authoring session when no bundled program fits (est. $3-8) | **$10-30**, up to ~$40 with authoring |

Site-aware design costs more per building than a box design (more context: the site summary, renders and slices; more
rounds: fit findings). The plan keeps the settlement total in Steward's existing budgets (S $20, M $35, L $55, XL $95) by
**designing archetypes and placing site variants**, and by letting deterministic generators and connectors carry most of
the cells: in a treehouse village the trees, walkways, ladders and scatter are typically most of the written cells, and they
cost nothing.

---

## 18. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Claude's 3D spatial reasoning on voxels** | Site-aware designs may fail fit rules round after round, or fit but look wrong | `Site` helpers do the geometry; designs are in the site's frame; the composite render; checker-driven rounds with a cap; archetypes plus site variants, so few designs need to succeed; deterministic fallbacks (a `ringDeck` house template per fit mode, bundled) |
| **The gallery is Noah's time** | Six scenarios per phase, each with 6 cameras, is a lot to look at | Show only changed scenarios with before/after; metrics first; approval per scenario, not per image |
| **Proxy metrics get gamed** | Programs can satisfy role shares and axis-run share and still look poor | Metrics are guards, the gallery is the gate; metrics are never tuned against the gallery verdicts of the same run |
| **3D survey cost** | Sampling volumes is server-thread work; 16M cells is a lot | Candidate areas only; section-palette shortcuts; sliced; measured in 6b with a bar before the limit is set |
| **IR and blob size** | Forms, fields and voxels can explode the plan | Side blobs; skeletons over voxels; `instances`; a plan-time size report per form; limits set from S1-S6 numbers |
| **Form evaluation cost per tile** | Big unions of capsules make each cell expensive; 6a's 2 s per tile and 45k cells/s bars | One bounded op per cluster (section 9.1); measured per tile in 6c; bake to `voxels` past a cost threshold |
| **Plan-time passes are slow** | Routing and hydrology over 1M columns in JS | 120 s plan budget, measured in 6c; districts and routing on coarse grids first, refined per corridor |
| **Light engine under canopies and caves** | 6a measured lighting outside Architect's budget; big overhangs and caverns change sky light over large areas | Measured per scenario (the light tick share); if it spikes, stage the large forms and write caverns' roofs last |
| **Fluids** | Channels, lifts and coral put water next to carved voids; undo exactness | Still water only; M4 and M16 on the virtual world; E-normal guards as built in 6a; flowing rivers deferred |
| **Leaf decay, melt, coral death** | Generated forms that look right in the preview change after random ticks | `persistent=true` leaves, M17-M19, and every scenario's gallery screenshots taken after a 2-minute stand at default random ticks |
| **Site-bound designs vs the library** | A design that only fits one place breaks the "library of reusable buildings" model | Site variants ($0 re-fit); the pin badge; on-pad designs stay the default for anything that doesn't need a site |
| **Drift between design and placement** | A player cuts the host tree between plan and realise | Keep-critical cells, `SITE_DRIFTED`/`KEEP_LOST`, re-fit offered |
| **Scope** | Five phases at about 1.0 each is a lot before Steward sees a ravine town | Each phase ships a working scenario; Steward can use 6b (crater gate) immediately and 7a's connectors without 7b |
| **Survival** | Without N4, none of the terrain-merging settlements exist in survival | Ask Noah to split N4 (section 20); BOX lots work in survival now |
| **Villager behaviour** | Assuming what villagers path over would break dwellings | M2's villager graph verified against 26.3's evaluators before promotion; Steward places villager things on villager-reachable nodes |

---

## 19. Open questions for Steward

- **S1. Delay of authoring.** Program authoring (old 6c) moves to 7c; template-first `Regions.design` and the crater gate
  stay in 6b. Does Steward's phase 2 (rift, crater) work with template picks over bundled programs until 7c?
- **S2. `siteplan.json` graph and `nav.json`.** Are nodes as walk patches up to 32 cells, typed links and mover sets enough
  for your navigator? Do you want link timing (seconds to climb a ladder) in the export?
- **S3. Movers.** `player`, `villager`, `steward`. Do you need more (a mounted steward, an iron golem, animals moved into a
  wing)?
- **S4. SettlementPlan ownership.** Should Steward's concept card produce the SettlementPlan (Steward owns the schema and
  the prompt, as for the card), with Architect owning the realiser and passes? Or should Architect own both?
- **S5. Archetypes and site variants.** Steward's per-lot briefs become per-archetype briefs plus site variants. Does your
  design group model (A2) fit "3 designs, 12 placements", and does the inbox show site variants as one item?
- **S6. Fit modes in the concept card.** Should the card carry the fit preference ("dwellings carved into rock"), or is
  that entirely the planner's?
- **S7. Survival.** In Supplied and Hardcore, are connectors materials the player pays for (a rope bridge costs its planks
  and chains) while terrain and natural forms are free? That's the N4 split asked of Noah below.
- **S8. Vertical routines.** Any constraint from your villager plans (bell placement, golem spawning space, trading hall)
  that should be a planner rule rather than Steward-side logic?

## 20. Open questions for Noah

- **N1. The replacement.** Replace the old 6b/6c with the new 6b, 6c and 7a-7c as above, 6d still deferred?
- **N2. Spend.** 6b est. $1-3; 6c and 7a $0; 7b est. $60 (cap $90); 7c est. $120 (cap $180); all on the claude login. These
  are estimates from measured unit costs; each phase's contract states its own before it starts.
- **N3. Split N4.** Today regions refuse in survival worlds until you decide the terrain rule. Proposal: **terrain and
  natural forms are free** (natural-only cut and fill, no BOM, no drops; Steward's recommendation), **connectors and built
  structures are construction sites** with a BOM. Or keep all regions Patron-only for now?
- **N4. The gallery as the gate.** You approve each new or changed scenario per phase. Is that the role you want, and
  should the gallery be a local HTML file or a private page you can open on your phone?
- **N5. Reference images.** Can you supply reference images per scenario (or allow generating concept art locally, with the
  Krea 2 Turbo setup on this machine, $0 Claude) for the images A/B?
- **N6. Site-bound designs in the Library.** OK that some library entries carry a pin badge and only place as site variants?
- **N7. Vanilla feature stamps.** Harvesting stamps from vanilla features into the kit (generated data per Minecraft
  version) is fine licensing-wise to ship in a public repo? (The kit already ships tables generated from the 26.3 data
  generator; stamps would be block lists produced by running vanilla code.)
- **N8. Scenario fixtures.** Natural fixtures on pinned seeds (real vanilla ravines, ice spikes, peaks) plus flat variants
  for exactness. Any scenario you'd swap for a better test of "any terrain and theme" (a desert mesa town, a mangrove stilt
  village, a Nether fortress town once the Nether ground search exists)?

## 21. Deferred

- Flowing rivers and waterfalls beyond declared single cells (E-normal can't classify them yet).
- Live capture of vanilla features at realise (stamps first).
- A model judge or set-level critic as a gate (until a recalibrated critic passes 5a's eval).
- Nether and End settlements (the Nether ground search is still open; regions are Overworld only).
- Moving or rotating a placed settlement (replan and re-realise).
- Redstone lifts (piston elevators) as connectors: fragile across versions; bubble columns only.
- Region-scale survival (N4 above), and construction mode for forms and relief.
- Writing under standing lots (6d's pad delta under a BOX cover).
- A Terrain tab or settlement UI in Architect for players (commands, API and the gallery until regions see real use).

## Noah's decisions (2026-10-08)

- **Phase plan adopted:** the old 6b/6c are replaced by 6b, 6c, 7a, 7b and 7c, each with its own contract and Steward review.
  Spend caps: 7b about $60 (cap $90) and 7c about $120 (cap $180), on the claude login. Noah is told before each paid phase starts.
- **Survival rule:** natural cut/fill and grown natural forms are free. Connectors and buildings are construction sites with
  a bill of materials.
- **Gallery:** a private claude.ai page per phase, with renders and approve/reject per scenario.
- **Reference images:** made with GPT Image 2.5. Noah generates them through his own chat interface or sets up API access
  himself. Architect asks him when a phase is ready for them; no local image generation is used for this.
