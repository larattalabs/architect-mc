# Region programs (phase 6a engine)

Whole sites as programs (docs/CONTRACT.md "# Phase 6 contract", the binding spec). A **program** runs once, at plan time,
and returns a **Region IR** (JSON, data only). **Realise** evaluates the IR per 64x64-column **tile** against a **frozen
heightfield** and returns a **packed cell list** that the mod writes through the 4e journal. This file pins the interfaces
between the kit, the sidecar and the mod. Everything byte-compared is little-endian and platform-independent.

## Modules

| File | What | Rules |
|---|---|---|
| `lib/region/program.mjs` | the program API (`region(ctx)` builder, primitives, `toIR()`) | plan time; may use any JS |
| `lib/region/plan.mjs` | `planRegion({programFile, params, survey, seed, claim, roles, kitVersion})` -> `{ir, irJson, irSha, notes}` | runs in the pristine-kit child process |
| `lib/sdf.mjs` | the closed shape library (signed distance), shape JSON evaluation | realise lint |
| `lib/noise.mjs` | seeded value / simplex noise, `fnv64`, splitmix | realise lint |
| `lib/realise.mjs` | `evalTile(ir, key, heights)` -> `{payload, count, sha, notes}` | realise lint; pure |
| `lib/region/pack.mjs` | `pack(cells)`, `unpack(payload)`, `gzipPinned(buf)`, the columns codec | pure |
| `lib/region/survey.mjs` | `ctx.survey` (nearest-sample helpers), `windowFromSurvey` (the budget pass's tile windows) | plan time |
| `lib/region/geom.mjs` | trig-free directions (`compassDir`), 4-connected lines, centre cells and cross-sections | plan time |
| `lib/region/synth.mjs` | a deterministic synthetic heightfield (tests, benches, the golden file) | |
| `regions/<id>.mjs` | bundled programs: `mega_bench.mjs` (§8) and `region_small.mjs` (smoke, crash and forest-rim runs) | |
| `tools/region.mjs` | CLI: `plan`, `eval`, `synth` (`check`, `preview` in 6b) | exit 0 / 1 / 2 |
| `tools/region-bench.mjs` | the 6a report numbers (plan time, cells, tiles, eval p50/p99, cells/s, bytes per cell) | |

**The realise lint** (`test/region-lint.test.mjs`): `lib/sdf.mjs`, `lib/noise.mjs` and `lib/realise.mjs` (and anything they
import from `lib/region/`) may use only `Math.floor`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`, `Math.imul` (exact by
spec; allow-listed), and no `Date`, no `Math.random`, no `**` operator (implementation-approximated). Plan-time code
(`program.mjs`, `plan.mjs`, programs) may use anything, but bundled programs and the kit's primitives avoid trig too, so the
mega_bench IR is the same on every Node major.

## Coordinates and keys

- World block coordinates. A **tile** is 64x64 columns aligned to world multiples of 64 (4x4 chunks):
  `tx = floor(x / 64)`, `tz = floor(z / 64)`. Its **key** is the string `"<tx>,<tz>"` (e.g. `"-2,5"`).
- A tile's **window** is its columns plus an 8-column margin: x from `64*tx - 8` to `64*tx + 71`, likewise z (80x80).
- Sections are 16x16x16, `sx = x >> 4`, `sy = y >> 4`, `sz = z >> 4` (arithmetic shift; y may be negative).
- The **claim** is `{minX, minZ, maxX, maxZ, minY, maxY}` (inclusive). The evaluator drops every cell outside it; the mod
  refuses them again (`REGION_LIMIT`).

## Columns codec (plan survey blob and tile heights)

One binary layout for both, `ARSV`:

```
offset 0  "ARSV" (4 bytes)   u8 version = 1   u8 0 0 0 (pad)
offset 8  i32 minX, i32 minZ, i32 width, i32 depth, i32 resolution
offset 28 i16 ground[n], i16 height[n], i16 floor[n], u8 flags[n]       n = width * depth
```

Column `(i, j)` is world `(minX + i*resolution, minZ + j*resolution)`, index `i + j*width`.
- `height`: the y of the highest motion-blocking block, leaves ignored (4a `Sample.height`: on forested ground the top of a trunk).
- `ground`: **the region's surface**: walking down from `height`, the first block that is not air, not a log, not leaves and
  not a plant (vines, flowers, grass, mushrooms, saplings...). Water counts as ground (its top block).
- `floor`: walking down from `ground`, the first block that is not a fluid (= `ground` on dry land).
- `flags`: bit 0 water (the ground block is water), bit 1 missing (no data: values are 0), bit 2 tree (a log or leaves stand
  above `ground`), bit 3 lava.

The plan survey (`region.plan`'s `surveyBlobId`) has resolution 1 up to 256x256 columns, else 4. A tile's heights are its
80x80 window at resolution 1 (`minX = 64*tx - 8`), from the mod's frozen heightfield.

## Packed tiles (`ARTL`)

The evaluator's output for one tile, before compression:

```
"ARTL" (4 bytes)  u8 version = 1  u8 0 0 0
varint sectionCount
per section, sorted by (sx, sz, sy) ascending:
  zigzag-varint sx, sy, sz
  varint paletteSize, then per entry: varint byteLength + UTF-8 block state string
  varint cellCount
  cellCount x u16 LE: bits 0-11 pos = (y&15)<<8 | (z&15)<<4 | (x&15) (ascending, unique), bits 12-13 cond, bit 14 walk, bit 15 0
  palette indexes: none if paletteSize == 1; u8 each if <= 256; else u16 LE each
```

- **Block state strings** are canonical: `minecraft:stone`, or `minecraft:oak_stairs[facing=north,half=bottom]` with the
  properties sorted by name. `minecraft:air` writes air. The mod parses them with vanilla's block state parser.
- **cond** (2 bits): 0 `IF_NATURAL`, 1 `IF_SOLID_NATURAL`, 2 `IF_AIR_OR_FLUID`, 3 `ALWAYS_OURS` (CONTRACT "Evaluation and
  conflicts within a program"). The mod resolves them at P1 against the live world.
- **walk** (1 bit): a walk-surface cell (stair treads, bridge decks, graded road surface, gate thresholds); the mod treats them
  as 4e road-surface cells (approaches stop at them).
- `sha` = SHA-256 (hex) of these **uncompressed** bytes. The wire carries `gzipPinned(payload)` (gzip, level 6, mtime 0, OS
  byte 255), split into frames of at most 1 MB of gzip bytes.
- An empty tile is a payload with sectionCount 0.
- **varint** is unsigned LEB128 (7 bits per byte, least significant group first, high bit set on every byte but the last);
  **zigzag-varint** encodes a signed 32-bit n as the varint of `(n << 1) ^ (n >> 31)`.
- A section's **palette order** is the order of first appearance in ascending pos order (the evaluator scans the section in
  pos order); `pack()` uses the same rule, so repacking an unpacked payload gives the same bytes.

## The Region IR (`format: 1`)

Canonical JSON (keys sorted, no whitespace) is the IR's identity: `irSha` = SHA-256 of it. Numbers are integers or finite
doubles; seeds are decimal strings.

```
{ format: 1, id, programSha, kitVersion, node, params, seed: "<u64 decimal>",
  claim: {minX, minZ, maxX, maxZ, minY, maxY},
  roles: {role: blockState},                       // resolved; a re-skin changes only these
  stages: [name],                                  // in order, <= 64
  parts: [{id, stage, set: "terrain"|"path", ops: [op]}],   // program order
  lots: [{id, stage, part, at: [x, z], size: [w, d], floorY, front: "north"|"south"|"east"|"west", brief?, max: [x, y, z],
          box: {minX, minY, minZ, maxX, maxY, maxZ}}],      // the lot's box (N3): size x (floorY .. floorY + max[1] - 1)
  roads: [{id, stage, part, points: [[x, y, z]], width, surface?, lanterns}],   // ground roads -> 4e RoadRequest items
  paths: [{id, stage, part, kind: "stair"|"bridge"|"graded", box}],           // their cells are ops of a "path" part
  anchors: {name: [x, y, z]},                      // entrance and spawn required
  rules: {}, budget: {cells, removed, added},      // budget: the plan's estimate
  tiles: {"<stage>": {terrain: [key], path: [key]}} // the tiles each change-set touches (sorted keys), from op bounds
}
```

As built (kit 6a):
- `node` is the Node **major** (`"24"`); `kitVersion` is `KIT_VERSION` in `lib/region/plan.mjs`. The golden test pins
  `node` so one golden file serves Node 22 and 24 (their IRs are otherwise identical: no trig on the plan path).
- `claim.minY/maxY` is the request's range **tightened** after the budget pass to the surveyed land and every cell the
  pass emitted (lowest - 64 .. highest + 64, lot boxes and anchors included), never wider than the request's. When the
  survey has any missing column the request's range stays (with a note): an unexplored column could hold anything.
- `tiles` keys are sorted numerically by (tx, tz). A stage with no ops in a set has an empty list (mega_bench's `lots-N`).
- `budget` is **exact for the plan survey**: every tile of every change-set evaluated (count only) over the survey,
  nearest-neighbour upsampled to resolution 1 (sample `floor((x - minX + res/2) / res)`), missing columns filled from their
  nearest known neighbours. `removed` = air writes, `added` = block writes. The mod skips no-op cells at P1, so written
  cells can be fewer.
- `lots[]`: `at` is the footprint's north-west (min x, min z) corner; `size` its width (x) and depth (z); `box` is the
  footprint (apron not included) from `floorY` to `floorY + max[1] - 1`; `front` is always a cardinal (a `toward:` front is
  resolved at plan); `part` is the lot's pad part (in the pads' stage, e.g. `ground`), `stage` the lot's own stage (e.g.
  `lots-1`). Extra: `pad: {cut, fill, maxCut, maxFill, edge}` (what the pad needed on the plan survey).
- **Lot pads (binding, coordinator):** a lot's `floorY` is the y of the first cell ABOVE the pad's top block: the pad's top
  solid block is at `floorY - 1` over the footprint plus a 1-column apron, and the cells from `floorY` up to `box.maxY` over
  the footprint are clear (air, written by the pad op even over open air so trees and plants go), and to the column's top
  over the apron and batter. The mod places the lot's building with `fitToLot(box, front)` LAYERed on the pad.
- `paths[].box` is a plan-time box (supports' bottoms from the plan survey); `roads[]` are split at 2048 centre cells and
  256 points (ids `<id>_1`, `<id>_2`, ... when split); `points[].y` is the plan survey's ground (4e's search hint).
- Optional `blobs: {name: {minX, minZ, width, depth, data}}` (base64) for `heightfield` / `mask` shapes.
- Ops carry their **effective** cond (the "path part or later stage" rule is applied at plan); the evaluator never
  rewrites conds.

**Ops** are the low-level, pointwise operations the evaluator knows. The primitives in `program.mjs` (carve, add, platform,
pillar, ring, terrace, lot pads, stair, bridge, graded road) compile into them at plan time:

```
{ op: <kind>, shape: <shape>, material: <blockState | null for air>, cond: 0..3, walk: bool, bounds: {minX..maxZ, minY, maxY} | null, ...op fields }
```

- `bounds` is a conservative world box (y may be surface-relative, see below) used to skip tiles and cells; the
  evaluator must give the same result with or without it.
- A **shape** is a JSON tree over the closed library: primitives `sphere`, `box`, `cylinder`, `cone`, `bowl`, `ring`, `torus`,
  `capsulePath`, `extrude`, `heightfield`, `mask`; combinators `union`, `subtract`, `intersect`, `smooth`, `offset`,
  `displace`, `clipY`. A shape's y values are either absolute (`{abs: n}`) or surface-relative (`{surface: dy}`, relative
  to the frozen `ground` of the column being evaluated). A cell is inside when the signed distance is <= 0.
- **Pointwise rule:** a cell's result depends only on the IR, its position, and the frozen columns within 8 of it.
- Ops apply in IR order (part order, then op order); **the last op that touches a cell wins** (its state, cond and walk).
- Cond defaults: carve/terrace/platform/pad cut and fill `IF_NATURAL`, carve lining `IF_SOLID_NATURAL`, `add` and decks
  `IF_AIR_OR_FLUID`. In a `path` part or any stage after the first, `IF_NATURAL` becomes `ALWAYS_OURS`.

## evalTile

`evalTile(ir, key, heights)`:
- `heights` is an `ARSV` buffer for the tile's 80x80 window (or a decoded columns object).
- Evaluates every op of every part whose `set` and `stage` match the request (`{stage, set}` option; default all) over the
  tile's 64x64 columns and the claim's y range, last op wins, and returns `{payload: Uint8Array, count, sha, notes}`.
- Deterministic: the same `(ir, key, heights, stage, set)` gives a byte-identical payload in any worker, in any order, on any
  OS (D9).
- Limits: 2 s and 256 MB per tile (the pool enforces them); over 1M cells the mod splits the entry by section rows.

As built (kit 6a): `evalTile(ir, key, heights, {stage, set, countOnly} = {})` returns `{payload, count, sha, removed, added,
notes: {parts: {partId: {removed, placed}}, clipped, missing}}` (`countOnly`: no payload and no sha, the same counts: the
plan's budget pass). `heights` must have resolution 1. A column outside `heights` or flagged missing gets no cells
(`notes.missing` counts such columns under an op). `clipped` counts op cells beyond the claim (x/z outside it, or within 64
of its y range) in the tiles evaluated; tiles wholly outside the claim are never in `tiles`. The IR is compiled once per IR
object (a WeakMap); an IR passed as a string is parsed on each call. Speed (M5 Max, Node 24, mega_bench): about 15M
cells/s single-threaded, p50 0.9 ms and p99 18 ms per tile; about 0.24 gzip bytes per cell (2.6 raw).

## Ops (as built, kit 6a)

Two low-level op kinds; both carry `cond` (0..3), `walk` (bool) and `bounds`:

```
{ op: "shape",   shape, material: blockState | null }
{ op: "columns", from: yref, to: yref, cols: [x, z, a, b, m, ...], materials: [blockState | null] }
```

- `shape`: every cell (x, y, z) with `sd(x, y, z) <= 0` gets `material` (null: air). Cells are sampled at integer
  coordinates (the block's own x, y, z).
- `columns`: for each 5-tuple, the cells of column (x, z) from `resolve(from) + a` to `resolve(to) + b` (inclusive) get
  `materials[m]`. A column may have several entries; they apply in order. Used for stair treads (with per-cell stairs
  facings), headroom, bridge decks, rails and supports, graded road surface / cut / fill / retaining edges, pillar grids.
- **y-refs** (shape y values, `from` / `to`): a number or `{abs: n}`; `{surface: dy}` = the column's frozen `ground` + dy;
  `{floor: dy}` = `floor` + dy; `{height: dy}` = `max(height, ground)` + dy (the column's top, trunks included);
  `{min: [y, ...]}` / `{max: [y, ...]}`.
- **No air into air:** primitives clip air writes to `{height: 0}` (a carve, a terrace or pad cut), except a lot's footprint,
  which is cleared to `box.maxY` (the lot rule above).
- The evaluator computes, per column and op, an exact `[lo, hi]` y span (shapes analytically, with a value band per
  shape node so skipping never changes a result; see `lib/sdf.mjs`), tests `sd <= 0` only inside it, and writes into a dense
  per-chunk buffer scanned in ARTL order. `bounds` is informative (tile lists); the evaluator recomputes x/z bounds from the
  shape itself, so a wrong `bounds` can never change a cell.

### Shapes (JSON, `kind`)

| kind | fields | inside |
|---|---|---|
| `sphere` | `c: [x, y, z], r` | distance to c <= r |
| `box` | `min: [x, y, z], max: [x, y, z]` | x0..x1, y0..y1, z0..z1 inclusive (exact box SDF) |
| `cylinder` | `c` (base centre), `r, h` | horizontal distance <= r, y from c.y to c.y + h - 1 |
| `cone` | `c, r0, r1, h` | radius r0 at c.y to r1 at c.y + h - 1 (linear) |
| `bowl` | `c` (rim centre), `r, depth, profile: parabolic\|spherical\|flat, h = 32` | the void: above the profile (rim - depth at the centre), within r, up to the rim + h |
| `ring` | `c, r0, r1, h` | r0 <= horizontal distance <= r1, y from c.y to c.y + h - 1 |
| `torus` | `c, R, r` | horizontal torus |
| `capsulePath` | `points: [[x, y, z]], r` | distance to the polyline <= r |
| `extrude` | `polygon: [[x, z]], y0, y1` | inside the polygon (boundary inclusive), y0..y1 |
| `heightfield` | `blob, scale, y0` | over the blob's area, y <= y0 + scale * value (u16) |
| `mask` | `blob` | over the blob's set bits, every y (sd = -0.5 / +0.5) |
| `union` / `intersect` | `of: [shape...]` | min / max |
| `subtract` | `of: [a, b...]` | a minus the union of the rest |
| `smooth` | `k, of: [a, b]` | polynomial smooth union |
| `offset` | `d, of` | sd - d |
| `displace` | `noise: {kind: value\|simplex, dims: 2\|3, scale, octaves, seed: 16 hex}, amp, of` | sd + amp * noise (noise in [-1, 1]) |
| `clipY` | `y0?, y1?, of` | max(sd, y0 - y, y - y1) |

`c[1]`, `min[1]`, `max[1]`, `y0`, `y1` are y-refs; x/z values are plain numbers. Noise: `lib/noise.mjs` (FNV-1a 64 and
splitmix64 on 32-bit halves, value and simplex noise over a 32-bit lattice hash keyed by the field's mixed seed, octaves
halve the amplitude and double the frequency).

## Writing a program

```js
// kit/regions/my_site.mjs
import { region } from '../lib/region/program.mjs';
export const id = 'my_site';
export const params = { depth: { type: 'int', min: 4, max: 20, default: 8 } };   // as designs (lib/params.mjs)
export default function (ctx) {          // ctx = {claim, survey, roles, seed, params, kitVersion, rng(label), region()}
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots-1']);
  const [x, y, z] = ctx.survey.pickCenter();
  r.part('pit', { stage: 'ground' }).carve({ kind: 'bowl', c: [x, { abs: y }, z], r: 30, depth: ctx.params.depth }, { lining: ctx.roles.scorched ?? 'rubble' });
  r.part('steps', { stage: 'ways', set: 'path' }).stair([[x + 32, y, z], [x + 10, y - 6, z]]);
  r.anchor('spawn', [x + 40, z]); r.anchor('entrance', [x + 40, z + 4]);
  return r;
}
```

- Plan time only: the program runs once in the plan child process; `Math.random` throws ("use ctx.rng"), `Date.now`
  returns 0. `ctx.rng(label)` is a seeded PRNG `() => [0, 1)` with `.int(a, b)`, `.pick(arr)`, `.shuffle(arr)`.
- `ctx.survey`: `heightAt` / `groundAt`, `floorAt`, `topAt`, `waterAt`, `missingAt`, `slopeAt`, `biomeAt` (null in 6a),
  `pickCenter()`, `stats(x0, z0, x1, z1)`, `padStats(x, z, w, d, {floorY?})`, `flatAreas({size, maxRange, limit})`,
  `resolution`, `columns`. Missing columns read as their nearest known neighbours (`missingAt` tells).
- `ctx.roles`: role -> block state (the bible's roles over the rustic core roles and the macro defaults: rock stone,
  surface grass_block, subsurface dirt, rubble cobblestone, rail oak_fence, structure stone_bricks). A material argument
  is a role name, a block state (`minecraft:x[k=v]`, validated) or null / 'air'. Extra roles use a fallback chain
  (`ctx.roles.scorched ?? ctx.roles.rock`).
- Avoid trig (use `compassDir(degrees)` from `lib/region/geom.mjs`) so the IR is the same on every Node major.
- Builder: `r.stages([...])` (once, in order), `r.part(id, {stage, set: 'terrain'|'path'})` (ids unique), `r.anchor(name,
  [x, z] | [x, y, z])`, `r.noise(field, {kind, octaves, scale, seedLabel, dims})`, `r.budget(cells)` (default 20M, at most
  64M), `r.note(text)`, `r.blob(name, {...})`. A part's low-level `fill(shape, material, {cond, walk})` is the escape hatch.

### Primitives (6a) and their guarantees

| primitive | as built | guarantees (tests: `test/region-primitives.test.mjs`) |
|---|---|---|
| `carve(shape, {to: 'air', lining, liningDepth: 1, naturalOnly: true})` | lining: `clipY(_, {floor: 0}, offset(d, S) - S)` IF_SOLID_NATURAL; then S clipped to the column top (air) IF_NATURAL | removes natural cells only; never air into air |
| `add(shape, material, {underside: flat\|pillars, supportEvery: 8})` | IF_AIR_OR_FLUID; pillars from the frozen floor under the mass's grid and rim (plan survey) | `taper`/`rock`: 6b |
| `platform(polygon, y, {thickness, edge: none\|rail\|wall, underside: none\|fill, clear})` | slab top exactly y; edge cells by the evaluator's own polygon rule | |
| `pillar([x, y, z], {to: ground\|bedrock\|y, size: 1-3, bottom})` | a box from the frozen floor + 1 (or min(floor + 1, bottom)) to y | reaches the first solid cell under the surface (the floor under water) |
| `ring([x, z], r0, r1, {height, rise, gates: [{angle\|dir, width: 3, height: 4}]})` | wall from the ground block up height + rise (surface-following); per gate: foundation under, a walk threshold at the plan ground, air above | each gate: width x height clear over walk cells |
| `terrace(area, levels, {riser: 2, step, edge: slope\|wall, retain, stairs, soil: 3})` | per level: cut above, fill below (floor + 1), the top block `surface`; walls on each rim (`wall`); one stair per pair of levels | levels flat; risers <= riser (`slope`) |
| `stair(path \| spiral, {width: 3, landingEvery: 8, carve, railing, spiral, material})` | treads (stairs blocks facing up the rise where the material has them), 2 headroom, rails; a spiral winds around a 3x3 core; a column keeps one tread per 3 blocks of height | rise <= 1, a 2-cell landing every <= landingEvery steps, 2 headroom, walk treads |
| `bridge(path, {width: 3, deck, rail, supports: {every: 12, bottom}, maxSpan: 24})` | deck y interpolated (fails over 1 per block), rails both sides, 2 headroom, piers at both ends and every <= `every` | continuous deck, spans <= every <= maxSpan, supports to the floor |
| `road(path, {width, mode: ground\|graded, optional, surface, lanterns})` | ground: `roads[]` (4e); converted to graded when width > 5, a cut/fill over 3 on the plan survey, or water; graded: grade <= 1 in 4 (vertex y pins), cut/fill <= 12, retaining edges over 2 | `optional`: dropped with a note instead of failing |
| `lot(id, {at, size, floor: auto\|y, front, max, pad: {maxCut: 6, maxFill: 6, edge: slope\|wall}, stage})` | pad fill (foundation; 1:1 batter steps of subsurface), cut (footprint to box.maxY, apron and batter to the top), the top block at floorY - 1 | the lot pad rule above; over the limits: the plan fails with the numbers |

Path primitives (`stair`, `bridge`, `road`) need a `path` part. Paths walk 4-connected centre lines (a diagonal step goes
through its corner cell) with axis-aligned cross-sections (`crossOffsets`: an even width's extra cell on the right).

## CLI (`tools/region.mjs`)

```
node kit/tools/region.mjs plan <program.mjs> --params p.json --survey s.bin [--seed u64] --claim minX,minZ,maxX,maxZ[,minY,maxY]
     [--bible b.json] [--roles r.json] [--out dir] [--json]
node kit/tools/region.mjs eval <ir.json> --tile tx,tz --heights h.bin [--stage s] [--set terrain|path] [--json] [--out file]
node kit/tools/region.mjs synth --box minX,minZ,maxX,maxZ [--res 1|4] [--seed s] --out file
node kit/tools/region-bench.mjs [--seed s] [--scale full|light] [--json]
```

- `plan` writes `<out>/ir.json` (canonical) and `<out>/plan.json` (`{ok, irSha, id, seed, claim, stages, lots, roads, paths,
  anchors, budget, notes, stats}`, stats with per-stage tile counts and cells and the ms split), nothing else. `--json`'s
  last line: `{ok: true, irSha, stages, lots, anchors, budget, tiles (counts), notes, ms}` or `{ok: false, error}`.
- `eval` writes the raw ARTL payload to `--out`; `--json` prints `{ok, key, count, sha, bytes, gzipBytes, removed, added,
  notes, ms}`.
- `synth` writes a synthetic ARSV survey or window (`lib/region/synth.mjs`), for tests and benches.

## Plan CLI (how the sidecar runs a plan)

The sidecar runs, with cwd the plan dir `<data>/regions/plans/<planId>/`:

```
node --permission --allow-fs-read=<kit> --allow-fs-read=<planDir> [--allow-fs-read=<programs dir>] --allow-fs-write=<planDir>
     --max-old-space-size=1024 --import=<no-network preload>
     <kit>/tools/region.mjs plan <program.mjs> --params <planDir>/params.json --survey <planDir>/survey.bin --seed <u64>
     --claim minX,minZ,maxX,maxZ,minY,maxY [--bible <planDir>/bible.json] --out <planDir> --json
```

- `<program.mjs>` is an absolute path: `<kit>/regions/<id>.mjs` for a bundled program (so its relative kit imports resolve),
  else the player's file under `<gameDir>/architect/regions/programs`.
- `--claim` carries the y range as its 5th and 6th numbers (CONTRACT §6 lists `x0,z0,x1,z1`; the IR's claim needs y).
- `--bible` is `{id?, version?, roles: {role: blockState}}`: the bible's roles already merged with the request's `roles`
  (the request's win). It is absent when there are no roles.
- The CLI writes `<out>/ir.json`: the canonical IR JSON, whose SHA-256 is `irSha`. It may write `<out>/plan.json`; the sidecar
  keeps its fields and adds its own.
- Its stdout's last JSON line is `{ok: true, irSha?, notes?: [string]}` or `{ok: false, error}`; exit 0 on success, 1 when
  the program throws or the IR is invalid (the `error` text is what `region.failed` carries), 2 on bad usage. The sidecar
  takes `lots`, `stages`, `anchors`, `budget` and `tiles` from `ir.json` itself, not from stdout.
- Limits the sidecar enforces around it: 30 s (wall clock), 1 GB heap, `ir.json` at most 4 MB.

## Sidecar protocol (2, additive; CONTRACT §6 "Sidecar protocol")

Client -> sidecar (each is acked like every message, `{ok, error?, result?}`):
- `region.plan {program, params, seed?, claim, surveyBlobId, bible?, bibleVersion?, roles?}` -> ack `{planId, seed}` (the
  seed used: the request's, or one the sidecar picked; a u64 decimal string); then
  `region.planned {planId, irSha, ir, lots, stages, anchors, budget, tiles, notes, ms?}` or `region.failed {planId, message}`.
  `program` is a bundled id (`kit/regions/<id>.mjs`) or a path under `<gameDir>/architect/regions/programs`. The plan dir is
  `<data>/regions/plans/<planId>/` (program copy, `ir.json`, `plan.json`). `ir` travels in `region.planned` so the mod can keep
  a copy in the world (it is at most 4 MB; sent as `irBlobId` instead when over 1 MB: the mod reads the blob).
  `ir` is a **string**: the exact `ir.json` text, so the mod can store the bytes whose SHA-256 is `irSha` without
  re-serialising; the blob `<data>/blobs/<irBlobId>` holds the same bytes. Both messages are broadcast to protocol-2 clients.
- `region.tiles.request {planId, irSha, ir?, tiles: [{key, stage, set, heights}]}` (`heights`: base64 `ARSV`): ack
  `{accepted: n}`, or `ok: false, error: "ir_unknown"` when the sidecar has neither the plan dir nor an IR of that sha cached
  and the request carries no `ir`. `ir` is the `ir.json` text (preferred) or its JSON object (hashed as canonical JSON); it
  must hash to `irSha`. The IR cache is by sha, so a known IR is found under any `planId`. At most 64 tiles per request.
  Then one `region.tile` per tile, in any order:
  `region.tile {planId, key, stage, set, seq, more, data, count, sha}` (`data`: base64 of a slice of the gzip bytes, at most
  1 MB per frame, `seq` from 0; `count` and `sha` on every frame), or `region.tile.error {planId, key, stage, set, message}`.
- `region.release {planId}` -> ack `{planId, dropped}`: drop this connection's queued tiles and the cached IR. The plan dir
  stays (a later request without `ir` still finds the IR there).

Backpressure: the mod keeps at most W tiles outstanding (config `regionWindow`, default 4); the sidecar evaluates on a
`worker_threads` pool (`regionWorkers`, default `min(4, cores/2)`), at most W evaluated tiles per plan held in memory.
In the sidecar a tile holds one of its plan's W slots (per connection) from evaluation until its last frame is flushed to the
socket; requests beyond W queue (at most 256 per plan and connection). A connection that goes away loses its queued and
in-flight tiles; the plan dirs and the IR cache stay.
Snapshot features: `region.plan`, `region.tiles`.

# Phase 6b additions (pinned interfaces; CONTRACT "# Phase 6b contract" is the spec)

This part pins every interface the kit, the sidecar and the mod share in 6b. Where the contract leaves a byte layout or a
message field open, this section decides it. Everything byte-compared is little-endian and platform-independent.

## IR format 2

An IR is `format: 2` only when it uses a format-2 member; a format-1 IR evaluates byte-identically to 6a (the
`mega_bench.golden.json` tile shas are the proof). `kitVersion` is `'0.12.0'` (`KIT_VERSION`).

```
{ format: 2, ...every format-1 member except inline blob data...,
  requires: [kind...],          // sorted, unique; computed by walking the IR (never by hand)
  blobs:    { name: { sha, bytes, kind: 'heightfield'|'mask'|'field'|'volume' } },   // side files, by sha
  fields:   { name: { blob, type: 'u8'|'i16', minX, minZ, width, depth, res: 1|4 } },
  volumes:  { name: { blob, box: {minX, minY, minZ, maxX, maxY, maxZ}, sha } },
  forms:    [{ id, generator, version, params, seed, bounds, ops: [opIndex...] }],     // provenance only
  parts[].ops[]: { op: 'shape'|'columns', ..., material: <blockState> | null | { rule: <materialRule> } } }
```

- **Kinds in `requires`** (the closed list; `KINDS_FORMAT2` in `lib/realise.mjs`): `shape:ellipsoid`, `shape:capsuleChain`,
  `shape:wedge`, `shape:prism`, `shape:array`, `shape:instances`, `shape:warp`, `shape:strata`, `material:rule`,
  `blobs:side`, `fields`, `volumes`, `forms`. Any of them present makes the IR format 2; none, format 1.
- **Members a format-1 IR may also carry** (6a's phase-6 IR list, additive, not format-2 kinds): `floating:
  [{parts: [partId], anchor: name|null}]`, `utility: [{id, stage, part, kind, width, height, points}]`, `lots[].pad.fill`
  (`'foundation'` default, `'none'`), `paths[].supports` (`'pillar'|'arch'|'ends'`), `paths[].maxSpan`,
  `paths[].ends` and `paths[].cells` (the deck's centre cells, for M10 and the site plan), `paths[].width`,
  `lots[].entrance`, `parts[].kind` (`carve|add|path|pad|form`, for previews and the site plan), `parts[].floating`.
  The evaluator ignores them; the checker and previews read them. They are emitted only when a program uses them, so
  mega_bench's IR is unchanged.
- **Unknown members** of a format-2 IR throw `IR: unknown member '<m>' (supported: ...)`; `graph`, `siteLots`,
  `lotEntries` and `fits` are 7a and unknown in 6b. Unknown op, shape or rule kinds throw
  `IR: unknown <op|shape|rule> '<kind>' (supported: ...)`. `relief`, `scatter`, `voxels` and `stamp` are reserved op names
  that throw the same way until their phase. A format-2 blob with inline `data` throws `format 2 blobs are side files`.
- **Stale:** `format > 2`, a `requires` kind outside `KINDS_FORMAT2`, or `kitVersion` newer than the running kit (semver
  compare) is `PLAN_STALE`: "plan needs kit X / format N / kinds [...]; this is kit Y" (`staleReason(ir, kit)` in
  `lib/realise.mjs`; `compileIR` throws it with the prefix `PLAN_STALE: `).

## Side blobs

- Plan dir: `<data>/regions/plans/<planId>/blobs/<sha>.bin`, sha = SHA-256 (hex) of the file's bytes. At most 16 MB each,
  64 MB per plan. The kit CLI writes them with `plan ... --blobs-out <dir>` (the sidecar passes `<planDir>/blobs`).
- World dir: `<world>/architect-regions/<regionId>/blobs/<sha>.bin`, copied by the mod when the region record is created,
  before any tile is requested (write, fsync, rename, read back, sha checked). A missing or bad blob refuses realise with
  `OTHER` ("blob <sha> missing") before any write.
- **File layouts by `kind`:**
  - `heightfield` / `mask`: `ARBL` (4 bytes), u8 version 1, u8 kind (1 heightfield, 2 mask), u16 0, i32 minX, i32 minZ,
    i32 width, i32 depth, then the data: u16 LE per column (heightfield) or a bitset, bit i at byte i>>3 bit i&7
    (mask); i = x + z*width.
  - `field`: raw values, `u8` one byte or `i16` two bytes LE per sample, row-major (i + j*width); dims in `fields`.
  - `volume`: an ARVX file (below), stored as the mod froze it (gzip); `volumes[name].sha` is its ARVX sha.
- The evaluator gets blob bytes through `evalTile(ir, key, heights, {blobs})`, `blobs` a function `sha -> Uint8Array` or a
  map; a missing sha throws `blob_unknown <sha>`.

## Material rules

`material: { rule: { rule: [{when, mat}], default, dither: 'ordered4'|'none' } }` as SETTLEMENTS §3.3; `mat` and `default`
are block states (roles resolved at plan). Conditions (all must hold; a clause with no conditions always matches):
- `depth: [a, b]`: `d = floor(-sd)` of the op's own shape (0 = skin), `a <= d <= b`;
- `slopeLt: n` / `slopeGte: n`: `s = max |ground(x±1, z) - ground|, |ground(x, z±1) - ground|` over the frozen ground;
- `field: name, gte?: n, lt?: n`: the field's sample at (x, z) (res 4: the sample `floor((x - minX) / 4)`; outside: 0);
- `band: [a, b]`: the strata band of the nearest enclosing `strata` node (no strata: band 0);
- `noise: {kind, dims, scale, octaves, seed}, gte?: v, lt?: v, age?: a`: the noise value at (x, y, z) plus `age`;
- `yAbs: [a, b]`;
- `facing: 'up'|'down'|'side'`: up = the cell above is outside the op's shape (sd > 0), down = the cell below is outside,
  side = any of the 4 horizontal neighbours is outside (6 SDF lookups, only for cells that reach the clause).

`dither: 'ordered4'`: a clause's numeric thresholds (`gte`, `lt`, `depth` bounds) are shifted by the 4x4 Bayer value
`B[(x & 3) + 4 * (z & 3)] / 16 - 0.5` (in the condition's own units: depth in cells, noise in [-1, 1] scaled by 0.25,
fields by 16), so transitions don't make straight lines. An op whose rule uses `facing` has at most 32 primitive shapes
(plan error past that).

## Protocol (2, additive)

- **`hello` / snapshot** (protocol 2): `kitVersion` (the sidecar kit's `KIT_VERSION`), `irFormats: [1, 2]`, `irKinds`
  (`KINDS_FORMAT2`). New features: `region.check`, `region.preview`, `region.design`, `region.blobs`, `ir.format2`.
- **`region.plan`** gains `check?: boolean` (default true; false = `ext["architect_mc:check"] = false`: no check, no
  previews) and `volumes?: [{name?, sha, blobId, box}]` (frozen volumes the program may read: the second plan of the
  two-plan flow). It broadcasts **`region.progress {planId, phase: 'planning'|'checking'|'rendering'}`** when each phase
  starts (S-6b-5).
- **`region.planned`** gains: `irFormat` (1|2), `requires` ([]), `kitVersion` (the IR's), `blobs: [{name, sha, bytes,
  kind, blobId}]` (each side blob is also registered in the sidecar's blob store as kind `region.blob`, so the mod reads it
  with the existing blob read), `needVolumes: [{minX, minY, minZ, maxX, maxY, maxZ}]` (boxes the program asked for with
  `r.needVolume`), `report` (report.json, absent with `check: false`), `previews: {top: [path], section: [path...], iso:
  [path], siteplan: [svgPath, pngPath]}` (absolute paths in the plan dir), `sitePlan` (siteplan.json), `checkMs`,
  `renderMs`, and `checkError` when the check or the previews failed while the plan itself is good (the plan is accepted
  without a report; `region.check` re-runs it).
- **`region.check {planId}`** -> ack `{report}` (re-runs the check from the plan dir's IR and survey).
- **`region.preview {planId, views?: ['top'|'section'|'iso'|'siteplan'], axes?: [[[x, y, z]...]...]}`** -> ack `{paths:
  {view: [path]}, sitePlan}`.
- **`region.tiles.request`** gains `blobs?: {sha: blobId}`. The sidecar resolves the IR first (`ir_unknown`, as 6a), then
  every blob sha the IR names from the plan dir, its blob cache (`<data>/regions/blobs/<sha>.bin`) or the request's
  `blobs` (blob-store ids, checked by sha and then cached); any missing: ack `ok: false, error: "blob_unknown
  <sha>,<sha>..."`. The mod then uploads those from the world copy with `blob.put` (kind `region.blob`, chunked) and asks
  again with `blobs`. At most 3 re-requests per tile and reason; then the region waits `SIDECAR_UNAVAILABLE`.
- **`region.design {brief, card?: {site?, purpose?, style?, text?}, claim, surveyBlobId, bible?, mustPass?, model?,
  budgetUsd?, requireFit?: false, plan?: true}`** -> ack `{designId}`; then `design.upsert` with a design of `kind:
  "region"` whose `result` is `{outcome: 'PICKED'|'NO_TEMPLATE', fits, program, params, reason, cost, planId?, tries}`.
  With `fits` (and `plan`), the sidecar starts `region.plan` itself and names its `planId`; without a fit the result
  still offers the closest `program` and `params` with `fits: false` (S-6b-3), and the outcome is `NO_TEMPLATE`. The pick
  reads the survey through `surveySummary(ARSV)` (sidecar `regiondesign.ts`): 4a's `summary()` text (heights, water,
  trees, natural share, biomes when the survey carries them, the 64x64 grid) rebuilt from the plan survey.
- **`region.release {planId}`** (mod -> sidecar, no ack payload): the helper drops the plan's in-memory IR and blobs (the
  region is done or removed, or DevBridge `dev.region.drop` forces the `ir_unknown` / `blob_unknown` resume path).

## ARVX (3D volumes, `Survey.volume`)

**The cell limit is 268M cells per volume and per region's volumes together** (`VolumeSurvey.MAX_CELLS`; over it
`REGION_LIMIT`). Set by 6b gate item 7 on a natural 256x256x128 cliff-and-cave fixture: 9.6M cells/s wall time (sliced over
ticks, 0 ticks over 50 ms, slices at most 5 ms), 0.039 bytes per cell frozen. The contract's rule (60 s of sampling and
64 MB on disk) gives 578M and 1.7G; the sampler holds 1 byte per cell, so a 256 MB heap bound decides it.

The file is `gzip(ARVX bytes)`; the volume's **sha is SHA-256 of the uncompressed ARVX bytes** (the gzip bytes differ
between Java and Node).

```
"ARVX" (4)  u8 version = 1  u8 0 0 0
i32 minX, minY, minZ, maxX, maxY, maxZ                      (the box, inclusive)
columns, x-major: for x in minX..maxX, for z in minZ..maxZ:
  runs bottom-up from minY: (u8 class, varint length)...   (lengths sum to maxY - minY + 1)
varint ownerCount, then ownerCount x (varint byteLength + UTF-8 entry id)
varint ownedRuns, then per OWNED run in file order: varint ownerIndex
```

Classes (u8 = the enum ordinal): `AIR 0, ROCK 1, SOIL 2, LOOSE 3, ICE 4, SNOW 5, WATER 6, LAVA 7, LOG 8, LEAVES 9, PLANT 10,
OWNED 11, PLAYER 12, BLOCK_ENTITY 13, MISSING 14`. Precedence per cell: unloaded/ungenerated column `MISSING`; a cell a
journal entry owns `OWNED`; a block entity `BLOCK_ENTITY`; else the block's class from `kit/voxel_classes.json` (a block
not listed is `PLAYER`; air is `AIR`). Adjacent cells of one class (and, for OWNED, one owner) form one run.

`kit/voxel_classes.json` is generated by `kit/tools/gen-blocks.mjs` from 26.3 (BlockDump, with the same block tags as the
mod's `TerrainFit.natural` and its tree rules): `{format: 1, classes: [names in ordinal order], blocks: {"minecraft:x":
"ROCK", ...}}`, natural blocks only. The mod bundles the same file; a JVM test asserts its enum order and file equal the
kit's. `kit/lib/region/volume.mjs` decodes (`decodeArvx(bytes)`) and `region.mjs volume decode <arvx> [--slice y]`
prints it.

## Realised-world dumps (`ARWD`, the scenario metrics)

S1's bars run on the realised world, re-surveyed. `dev.region.dump {box, light?: true, file}` writes `gzip(ARWD bytes)`:

```
"ARWD" (4)  u8 version = 1  u8 flags (bit 0: light present)  u8 0 0
i32 minX, minY, minZ, maxX, maxY, maxZ
varint paletteSize, then per entry: varint byteLength + UTF-8 canonical block state (as ARTL)
columns, x-major: runs bottom-up (varint paletteIndex, varint length)
if light: columns, x-major: runs bottom-up (u8 blockLight, varint length)
```

`kit/lib/region/vworld.mjs` decodes it (`decodeArwd`; `encodeArwd` writes one, for tests) and `dumpWorld(before, after, claim,
{virtual, lots})` makes the checker's cell source: the cells that differ are the written cells; with `virtual` (the plan's
virtual world) each takes the part and walk flag the plan gave it, and the IR's lots are obstacles, so the realised report
reads the same parts and floating groups as the plan's (`checkRegion({ir, meta, world})`, `mode: 'realised'`).

## The checker report (`report.json`) and `summary.txt`

```
{ format: 1, planId?, irSha, mode: 'virtual'|'realised', resolution: {coarse: 1|4, fullPasses: n},
  ok: bool, errors: n, warnings: n,
  findings: [{ rule: 'M1'..'M14' | 'M3:floating_spur', severity: 'error'|'warning', part: id|null, stage: name|null,
               count: n, sample: [[x, y, z]...] (<= 20), message }],
  metrics: { M2: {nodes, reached, unreachable: [id...], perNode: {id: bool}}, M5: {darkSpawnable, walkArea, share},
             M8: {edgeCells, guarded, share}, M10: [{path, maxSpan, longest, ends}], ...per rule },
  prefix: [{ stage, M2: {...}, M3: {...} }], ms: { total, perRule: {M1: ms, ...}, prefix } }
```

Findings are sorted by (rule, part, stage); `summary.txt` is one line per finding plus the totals.
`CheckReport` in Java carries `ok, errors, warnings, findings` (the rest stays in the JSON).

## `siteplan.json`

As CONTRACT §3.4 with the graph marked `derived: true` (S-6b-1); JSON Schema `kit/schemas/siteplan-1.json`.

## Kit CLI and modules (6b)

```
node kit/tools/region.mjs plan <program.mjs> ... [--blobs-out <dir>] [--volumes <dir>]      (6a args unchanged)
node kit/tools/region.mjs check <ir.json> --survey s.bin [--blobs <dir>] [--volumes <dir>] [--out <dir>] [--json]
node kit/tools/region.mjs preview <ir.json> --survey s.bin [--blobs <dir>] [--views top,section,iso,siteplan]
     [--axes <axes.json>] [--out <dir>] [--json]
node kit/tools/region.mjs catalogue [--json]
node kit/tools/volume.mjs decode <arvx> [--slice y] [--json]
```

- `plan --blobs-out` writes the side blobs as `<dir>/<sha>.bin`; `--volumes <dir>` holds frozen volumes as
  `<dir>/<sha>.bin` (ARVX, gzip) that `r.needVolume(box)` may read. `plan.json` gains `needVolumes`, `irFormat`, `requires`.
- `check` writes `<out>/report.json` and `<out>/summary.txt`; its last JSON line is `{ok: true, report: {ok, errors,
  warnings}, ms}` (exit 0 even with findings; 1 only when the check itself failed).
- `preview` writes `<out>/previews/top.png`, `section-<n>.png`, `iso.png`, `siteplan.svg`, `siteplan.png` and
  `<out>/siteplan.json`; its last JSON line is `{ok: true, paths: {view: [absolute path]}, sitePlan: <path>, ms}`.
- `catalogue` prints `{programs: [{id, description, params: {name: {type, min, max, default}}, needs: {minFlat, water,
  relief}, claim: {min: [w, d], max: [w, d]}}]}` for every bundled program whose module exports `catalogue` (an object;
  `catalogue = false` or none leaves it out: `mega_bench`, `region_small`).
- Modules: `lib/region/check.mjs` (`checkRegion({ir, survey, blobs, volumes, source?}) -> report`),
  `lib/region/vworld.mjs` (the virtual world and the dump-backed cell source), `lib/region/preview.mjs`
  (`renderPreviews({ir, survey, blobs, views, axes, outDir}) -> {paths, sitePlan}`), `lib/region/siteplan.mjs`,
  `lib/region/volume.mjs` (ARVX), `lib/forms/floatingIsland.mjs`, `lib/material.mjs`.

## Ghost tiles (the region ghost, client)

`region.tiles.request {planId, irSha, preview: true, tiles: [{key, stage?, set?}]}` (no `heights`): the sidecar evaluates
the tile over windows built from the plan dir's `survey.bin` (`windowFromSurvey`, as the budget pass), all stages up to and
including `stage` when given (else every stage), both sets, and answers with ordinary `region.tile` frames carrying
`preview: true`, whose `stage` and `set` are `'*'` when the request named none (every stage, both sets). Nothing is written by the mod; the client draws the cells (tints: added, removed, path (walk), lot,
floating).
