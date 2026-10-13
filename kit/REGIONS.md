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
  1 MB per frame, `seq` from 0; `count` and `sha` on every frame), or `region.tile.error {planId, key, stage, set, message,
  code?, attempts?}`. (6c 0a) A tile over its time limit (`regionTileMs`, 2 s) is evaluated again on a fresh worker, up to 4
  evaluations, the limit doubling (2, 4, 8, 16 s) with 1, 2 and 4 s pauses; then it answers `code: "timeout"` (the mod waits
  TILE_SLOW and asks again later). Any other error answers `code: "error"` at once. `attempts`: the evaluations made. An older
  sidecar sends neither field (an error). Test hook: env `ARCHITECT_TEST_SLOW_TILES=<n>` makes the first n evaluations of
  each tile overrun.
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
  `IR: unknown <op|shape|rule> '<kind>' (supported: ...)`. `relief`, `scatter` and `stamp` are reserved op names
  that throw the same way until their phase (`voxels` is built in kit 0.19.0, below). A format-2 blob with inline `data` throws `format 2 blobs are side files`.
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
  - `voxels` (kit 0.19.0): an ARVB file, the `voxels` op's baked cells (below, "Kit 0.19.0").
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
- **`region.release`** gains `evict?: boolean` (6b): the cached IR goes even when other plans share its sha (DevBridge
  `dev.region.drop` sends it so the next tile request meets `ir_unknown`, gate item 10(a)).

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

# Phase 6c slice V additions (flat village, C10; CONTRACT "Phase 6c slice V")

## Kit 0.16.0

`KIT_VERSION` (and `EVAL_KIT_VERSION`, the mod's `IrStale.KIT_VERSION`) is `0.16.0`. Every IR records it, so every IR sha changed; the
tiles did not (the golden tests pin `kitVersion: '0.12.0'` as they pin `node`). An older mod or helper refuses a 0.16.0 plan
`PLAN_STALE` ("plan needs kit 0.16.0").

## New IR members (format 1 and 2; the evaluator ignores them)

- `graph: {nodes, edges}`: SETTLEMENTS §8.1's shape, restricted. Nodes `{id, kind: lot|plaza|junction, ref, level: 0, at: [x, y, z],
  ports: [{name, at, facing, width}]}`; edges `{id, from: 'node.port', to: 'node.port', type: road|path, width, stage: 'ground',
  path}`. Built with `r.graphNode` / `r.graphEdge`; 7a keeps the ids and adds `auto`, connectors, `seconds` and `risk`.
- `keepOut: [[x0, z0, x1, z1]]`: the request owner's protected rects the program honoured. Present only when the program read
  `ctx.keepOut` or `ctx.survey.keptOutAt` (an empty list when it read none given), so other programs' IRs carry nothing new. The
  mod refuses PROTECTED, at accept and at realise, any area meeting the claim whose exact rect is not in this list.
- `lots[].ext`: a program's lot data, copied into `LotSpec.ext` (flat_village: `"architect_mc:village"`).

## `region.plan.keepOut` and the CLI

`region.plan {..., keepOut?: [[x0, z0, x1, z1]]}` (at most 1024; snapshot feature `region.keepOut`). The sidecar writes it to
`<planDir>/keepout.json` and passes `plan ... --keep-out <file>` (the CLI also takes inline JSON). Programs read `ctx.keepOut` (sorted,
unique rects) and `ctx.survey.keptOutAt(x, z)`.

## The `lots` param type

Region programs only (`validateParams(params, {region: true})`; a design's params refuse it), never a variant axis
(`cornerValues` skips it). At most 40 lots, each `{id (LOT_ID, unique), type, role?, size: [alongStreet, deep] (5-96), landmark?,
placement?: central|edge|near_water|high_ground, villager?: dwelling|job|trading_hall|farm|none, brief?, ext?}`: Steward's
`VillageLayout.LotSpec` plus `villager` (inferred from `type` only when absent) and, since 6c X (C19), `ext`: the caller's own data
for the lot, an object of `namespace:name` keys, at most 4096 characters as JSON (the mod refuses a larger one FIELD_LIMIT with the
path, e.g. `params.lots[2].ext`). It is copied onto the IR lot's `ext` (so onto `LotSpec.ext`) and the realise copies it onto the
lot's site. Keys under `architect_mc:` are Architect's: a caller's value for them is dropped (flat_village adds its own
`architect_mc:village` to the lot; it stays on the LotSpec and does not go to the site, where Architect's own key is
`architect_mc:lot`). A lot with no `ext` gives an IR identical to 0.16.0's.

## `flat_village` (kit/regions/flat_village.mjs) and its components

- `lib/region/village.mjs`: `layoutStreet` (pure: VillageLayout's geometry and scoring ported, both orientations, the shared space
  at the street's middle, the square's frontage to the trading hall, the landmark and central lots first, farms moved within 2 of
  water where a slot allows), `streetLayout(r, specs, o)` (emits pads, lots, the square or green, verges, lanes, the two road items
  ending at the square's edges, the graph), `square`, `lane`, `surfaceOps` (columns ops: levelled fill / top / 2 clear, or a
  ground-following swap). No carve, add, terrace, ring, form or cavern op.
- `lib/region/props.mjs`: the dry well (a cauldron, no fluid), lamp posts, benches, planters and the opt-in bell, planned in the
  shared space into air only, beside walk cells and never on them, never in a lot box, the bell area, the golem space or keep-out.
- Roles (a bible's win): `path` gravel, `foundation` stone bricks, `light` lantern. `catalogue = false`.
- `meta.village`: the bell, bell area and golem space, lanes, props, per-lot villager data, unplaced; the checker's village rules
  and S7's bars read it.

## The checker (`lib/region/check.mjs`)

`walkGraph(vw, starts, {mover: 'villager'})`: the player graph without climbing (ladders, vines, scaffolding), bubble columns or
swimming, falls of at most 1, only wooden doors passable (fence gates, trapdoors, iron and copper doors closed), and no standing
on a 1.5-tall barrier. With `meta.village`: `M2:villager` (villager lots reach the bell), M2 on the graph (every lot node joins
the plaza), M22 (bell area, golem space), M23 (trading hall within 12), M24 (farm within 2 of water; no water: a note), and an M1
error for a village part writing inside a lot box. All warnings but M1.

## `siteplan.json` (format 1, widened)

With an IR graph: `graph.derived: false`, its nodes (with `ports`) and edges (with `width`, `path`, and `mover` `['player']` plus
`'villager'` where the villager mover from the bell reaches both ends). Lanes are `paths[]` of kind `path`; `unplaced: [{id,
reason}]`. Without an IR graph: 6b's derived graph, unchanged.

## C12: a standing VillageLayout village as a flat_village shape

VillageLayout's `Plan` maps one to one: its `Lot`s are flat_village lots (`id`, `type`, `role`, `sizeX`/`sizeZ` = `size`
[alongStreet, deep], `front` SOUTH/NORTH = the `ew` orientation's -z/+z sides, `x`/`z` = `at`), `streetZ` is the street's centre line
(`streetV`, street 5 wide), `streetX0..streetX1` its extent. Steward's street has no square: an adopted village gets the plaza node
at the street's middle and no square cells. `Regions.adopt` (the joint 7a/6d gate) records the standing sites without writing a cell.

# Phase 6c slice W additions (village safety; CONTRACT "Phase 6c slice W")

## Kit 0.18.0

`KIT_VERSION` (`EVAL_KIT_VERSION`, the mod's `IrStale.KIT_VERSION`) is `0.18.0`: every IR sha moves. Format-1 tiles, S1's tile golden
and `mega_bench.golden.json` don't (no program but `flat_village` calls the new helpers).

## ARSV `FROZEN` (flag 16)

A column whose top block is ice, packed ice, blue ice or frosted ice with water within 3 below it (only ice or water between)
carries `FROZEN | WATER`, and its `floor` is the bed under the ice and the water. Land ice (an ice spike on snow, packed ice on
stone) is ground. The kit treats it as water everywhere (`survey.waterAt`; `survey.frozenAt` names it), except a farm: M24 and
the farm placement count unfrozen water only. A plan refused over it says `frozen water at x,z`. The mod's 4e road code reads ice
over water as water too (`RoadTerrain`), so a road over a frozen river is `DEEP_WATER`. `Sample.frozen` (API 1.15.0) is the
public side.

## Gravity (`blocks.mjs` `g`, `isGravity`)

Generated from the 26.3 classes (`FallingBlock`: sand, red sand, gravel, the 16 concrete powders, the anvils, the dragon egg).
`surfaceOps` (the square, verges, lanes): where the written top falls and the cell under it is a gap in the plan survey's ground
(water to the bed), a 1-deep gap gets the `foundation` role under it and a deeper one takes the `subsurface` role as its top.
`r.lot`'s apron stands on the pad's foundation fill already. The checker's M3 reports an unsupported gravity block in a written
cell as `M3:gravity` (a warning).

## Lamp fixtures (`lib/region/fixtures.mjs`)

The bible's `light` role picks the fixture, on a post of its `rail` role (a fence in its wood; oak by default):
`lantern_post` (the default, also with no `light` role), `soul_lantern_post`, `torch_post` (a torch or soul torch), `end_rod`,
`bollard` (a full-block light: sea lantern, glowstone, shroomlight, froglights), `hanging_lantern` (a lantern written
`[hanging=true]`: a post-and-arm gibbet). The level is the light block's own emission (lantern 15, torch 14, end rod 14, soul
lantern and soul torch 10). The square's lamps and the apron lamps use it; a weaker light adds square lamps (at most 8).

## The road's `lamp` (format 2, kind `road:lamp`)

`roads[].lamp: {cells: [[along, dy, state]...], light, first, every}`: the street's lanterns in the bible's fixture, written for a
road travelling east (the mod turns the offsets and states to the road's travel), spaced `every` = floor(12 * level / 15) from
`first` = every / 2. Present only when the fixture is not 4e's own oak fence and lantern, so other roads are unchanged. A mod
before 0.18.0 refuses such a plan `PLAN_STALE`. 4e's lantern posts may also stand on a built cell the road's own owner placed
(a region's verge in packed mud, stone bricks or planks).

## `r.lightCover` (`lib/region/light.mjs`; flat_village's `apronLamps`, on by default)

At plan time, over the plan's own virtual world (`plan.mjs draftIR`): the target set is every reached floor the region wrote that a
mob spawns on (the checker's M5 area: aprons and batter steps too); the light is the world's emitters plus a model of the 4e street
lanterns, with lot boxes opaque (the cover is conservative). Candidates beside each lot (the corners outside the apron's diagonal,
then the batter feet) are added greedily, most dark targets lit first, until the dark share is under 0.5% or a lot has 4 lamps. A
lamp that would cut a walk node off the entrance is dropped. It emits part `props_apron` (stage `props`), each lot's lamp positions
on `ext["architect_mc:village"].lamps`, `meta.village.apronLamps` (fixture, per-lot counts, the dark share before and after,
`capped`), the lamps as props of kind `apron_lamp`, and a note `apron lamps (<fixture>, light n): <lot> n, ...`.

## `siteplan.json` (format 1, widened)

A village with apron lamps adds `props: [{kind, id, lot?, at}]` (the shared space's props and the apron lamps) and `lots[].lamps`.

## Kit 0.19.0 (6c slice F1: forms I)

- **The `voxels` op** (format 2, `requires: ['voxels']`; an older kit or mod refuses it `PLAN_STALE`): `{op: 'voxels', blob,
  origin: [x, y, z], rotation: 0|90|180|270, cond, walk}`. `blob` names an ARVB side blob of kind `voxels`
  (`lib/region/voxels.mjs`): `'ARVB'`, u8 version 1, 3 zero bytes, i32 LE sizeX, sizeY, sizeZ, varint palette count and per entry
  varint length + UTF-8 block state, varint cell count, the cells' local indexes `((y * sizeZ + z) * sizeX + x)` as ascending
  varint deltas (the first from -1), then one palette index per cell (u8 with at most 256 entries, else u16 LE). No gzip: the bytes
  are the identity on every OS. A quarter turn is clockwise seen from above, local (x, z) -> (sizeZ - 1 - z, x), and turns the
  states (facing, the four connection flags, axis, sign rotation). Realise copies the cells that fall in the tile, pointwise by
  position, last op wins as for every op; the op's bounds are the turned box. `cond` defaults to IF_NATURAL for a baked form.
- **Generators** (`lib/forms/`): `iceSpike` (a cluster of thin cone chains, one op, packed ice with blue ice accents and snow-block
  caps; never ice or snow layers) and `rockSpire` (stacked warped cone segments, one op each, with clipY'd ellipsoid ledges and a
  capsuleChain buttress under any ledge that would overhang more than 4; strata bands, a weathered skin by noise, moss by the `wet`
  field or noise). Presets: `iceSpike` classic / needles / stubby, `rockSpire` pinnacle / tower / hoodoo. Both settle at plan time
  (`rules.settleForm`): fragments the evaluator splits off are cancelled by an air op (IF_AIR_OR_FLUID) and any remaining overhang
  over 4 gets a support.
- **Generator rules** (`lib/forms/rules.mjs`, every generator): one op per cluster with at most 32 primitives; a form past 400 ops
  (`BAKE_OPS`) is baked by `r.form` into one voxels op (`bake: 'auto'` default, `true` forces it); bases reach 6 below the plan ground.
  `ir.forms[i].baked = {blob, cells, ops}` records a bake. A bake keeps no air writes and no per-op conds.
- **Program API:** `r.iceSpike(id, params, {stage, bake})`, `r.rockSpire(id, params, {stage, bake})`, and
  `r.keepNatural(cls, box, {part, stage})`: the frozen volume's cells of a natural class (e.g. `'ICE'`) in the box become a `keep`
  entry `{volume, class, box}` on a part (default `keep_<class>`; an IR part member the evaluator ignores). It returns
  `{volume, cells, columns, has(x, y, z), near(x, z, r)}` for the program to place around them, or null on the first plan of the
  two-plan flow. `needVolume` is idempotent per box.
- **Checker:** `M17` (warning) no `ice` cell at block light over 10 and no snow layer over 11 (26.3's IceBlock and SnowLayerBlock
  random ticks: ice melts above 11 minus its light dampening, 1), written or natural (the volume's ICE and SNOW cells, when a
  planned light reaches them); a realised world is checked against its dump's light. `M3:overhang` (warning, under M3): a solid
  cell of a form part (not a floating group) with nothing under it, more than 4 (Chebyshev) from every solid cell one layer down.
  `M1` (error): a written cell in any part's `keep` set. Metrics `M3.overhangCells` / `maxOverhang`, `M17`, `keep`.
- **`forms_demo`** (`kit/regions/forms_demo.mjs`, `catalogue = false`): up to 6 ice-spike clusters and 3 spires on S2's claim
  among its natural ice (kept), each form grown at plan time and placed only where none of its cells meets a kept cell; soul-lantern
  posts (block light 10, melt-safe); the first spire baked.

# Phase 6c slice T1 additions (passes, fields and relief; CONTRACT "Phase 6c slice T1")

## Kit 0.20.0

`KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.20.0 (a placeholder: the coordinator renumbers at merge). Every IR sha
moves by its `kitVersion`; a program without passes plans the same parts, ops and tiles as before (format-1 tiles, S1's and S7's tile
goldens and `mega_bench` don't move). `KINDS_FORMAT2` (kit and mod) gains `relief`, appended after MP's `mask, pattern`; `OP_KINDS` is `shape, columns, voxels,
relief`; `OPS_RESERVED` keeps `scatter, stamp`. A relief op takes no mask (refused) and its fill is a block state or a material rule.

## Passes (`lib/region/passes/`, `r.pass`)

A pass is a bundled, deterministic function `(survey, volumes, intent) -> {fields, ops, data}` (`PASSES` in `passes/index.mjs`) run
at plan time in the plan's sandbox, never at realise. Its code is under the realise lint (integer math, `Math.floor/sqrt/abs/min/max/
imul`, no clock, no `Date`, no `**`; `kit/test/relief-t1.test.mjs` scans `passes/**`).

- A program declares the passes it calls: `export const passes = ['relief']` (a **literal** array: the helper reads it from the
  source to pick the plan budget, `regionPassPlanMs` 120 s and `regionPassPlanHeapMb` 2 GB, else 6a's 30 s and 1 GB). The kit
  checks it: a declared name that is not a kit pass, or a name twice, fails the plan; `r.pass(name)` of an undeclared pass fails
  `PASS_UNDECLARED`.
- `r.pass(name, intent)` resolves the intent's materials (roles), runs the pass with `minY` = the claim's bottom + 2, registers its
  fields as side blobs (`r.field`), and pushes its ops into a part (`intent.part`, default the pass's name) in the stage of the first
  lot it names (that lot's pad part: the pass reads the same frozen ground as the pad). It returns `{fields, ops, data: {..., ms}}`
  and adds a note `pass <name>: <s> s, <MB> MB` (wall time; the process's peak RSS after the pass).
- The plan's `stats.passes`, `meta.passes` (then `siteplan.json` `passes: [{name, ms, heapMb}]`), and the CLI's `plan.json` and
  summary (`passes`: the declared list; `passRuns`: the timings). `region.planned` carries `passes` (the kit's word): the game then
  samples the second plan's survey at resolution 1 up to 1024x1024 columns (past 1024 a side the pass runs coarse, on the
  resolution-4 survey, noted).

## The `relief` op (format 2, kind `relief`)

```
{ op: 'relief', field, mode: 'delta'|'target', cut: cond, fill: blockState | {rule}, maxCut, maxFill }
```

`field` names an i16 IR field; a sample of `-32768` (`RELIEF_NONE`), or a column outside the field, writes nothing. For a column with
frozen ground `g` and sample `v`: `dh = v` (`delta`) or `v - g` (`target`), clamped to `[-maxCut, maxFill]` (0..64); the new ground is
`top = g + dh`. A `delta` column with `dh` 0 writes nothing. Cells `min(g, top) .. max(top, g + 2)`: those at or below `top` take the
fill (a material rule's `depth` is `top - y`, so the skin is the surface role), those above are air (a cut, and the plants on a
shallow fill). Every cell's condition is `cut` (default `IF_NATURAL`; like `cond`, `ALWAYS_OURS` in a later stage or the path set).
Pointwise: one sample per column; its tile bounds are the field's extent. Drift: a column whose frozen ground moved still gets `g +
dh` (`delta`) or exactly `v` (`target`).

## The `relief` pass (`passes/relief.mjs`)

`r.pass('relief', {around, radius = 12, maxCut = 6, maxFill = 6, erode: {thermal, stream, streamAt}, fill, corridorFill, base})`:

- **Pins**: each lot from `r.lot` (its footprint and 1-column apron at its top y, `floorY - 1`), corridors `{path: [[x, y, z], ...],
  width}` (the centre line at its integer-interpolated profile y, widened), rects `{rect, y}`. The first pin of a column wins.
- **Fixed columns** keep their ground: water and lava (and 2 columns around water), trees, missing columns.
- **The band**: the free, unfixed columns within `radius` (Chebyshev, survey cells) of a pin. Start: the nearest pin's y fading
  linearly to the land at `radius + 1`; then `radius * 4` Jacobi iterations in 1/16 fixed point (the 4-neighbour mean, rounded),
  each clamped to the land's `-maxCut .. +maxFill` and never under `minY`.
- **Erosion touch-up** (`erode`): `thermal` sweeps move a block from a column to its lowest 4-neighbour while the drop is over 2;
  `stream` sweeps cut a block where the D8 accumulation (highest first, ties by index) reaches `streamAt` (24). Never on a pin or
  outside the band; at most 4 extra |dh| a column; the clamps hold.
- `base` (`{minX, minZ, width, depth, values}`, i16): heights added to the land the blend meets (relief_demo's flat-world hill); its
  columns outside the band are written as raised, within the clamps.
- **Output**: field `<name>` (dh over the band and the raised columns, `RELIEF_NONE` elsewhere: the pads are their lots' own) and, with
  corridors, `<name>_target` (their absolute y); one `delta` op and one `target` op (`corridorFill`, default: the path role on top).
  Both fields cover the bounding box of what they write, at the survey's resolution.

## `pad.edge: 'blend'` (N-T1-1)

`r.lot`'s `pad.edge` takes `blend`: no batter; the relief pass must name the lot in `around` (else the plan fails). `blend` is the
default edge of a program that declares passes; programs without passes keep `slope`.

## `relief_demo` (`kit/regions/relief_demo.mjs`, `catalogue = false`)

Three pads (lots `lot_1..3`) and two corridors on S3's pinned claim (scenario `relief_demo`, phase `6c-t1`), blended with erosion;
on a flat world a hill raised through `base`, two pads on it and one sunk 2 below the ground. `edge: 'slope'` is the same program
with 6a's batters and no pass (the organic-read comparison); `pads` up to 64 (the 1024x1024 plan-time bench).

# Phase 6c slice F2 additions (scatter and stamps; CONTRACT "Phase 6c slice F2")

## Kit 0.22.0

`KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.22.0 (a placeholder: the coordinator renumbers at merge). `KINDS_FORMAT2`
(kit and mod) gains `scatter` and `stamp`, appended after T1's `relief`; `OP_KINDS` is `shape, columns, voxels, relief, scatter, stamp`;
`OPS_RESERVED` is empty. A program without them plans the same parts, ops and tiles as before.

## The `scatter` op (format 2, kind `scatter`; `lib/region/scatter.mjs`, under the realise lint)

```
{ op: 'scatter', area: [x0, z0, x1, z1], grid, jitter, seedLabel, cond, walk: false,
  density: p | {field, scale: [lo, hi]} | {mask, p},  mask?, avoid?: field, lit?: field, y?: [lo, hi],
  items: [{ w, anchor: 'ground'|'ceiling'|'wall', on?: [class...], melts?, rotate?, light?: [dx, dy, dz, level],
            block: state | {down|up|north|east|south|west: state}  |  patch: [[dx, dz, state, upper?]...]  |  cells: blob, root, skirt? }] }
```

- **The grid.** Grid cell `(gx, gz)` covers `x = gx*grid .. gx*grid + grid - 1` (world-aligned). Its 32-bit hashes (`hash3` under the key
  `mix64(fnv64(seed, 'scatter', seedLabel))`; lattice y 0..4) give the jittered point (the cell's middle +- `jitter`), the fire value
  (fires when `hash >>> 16` < density * 65536), the item (multiply-shift over the weights) and the quarter turn. The point is then kept
  so the item's own cells stay inside its grid cell (an item of reach r needs `grid >= 2r + 1`): placements of one op never overlap.
- **Density:** a number; `{field, scale: [lo, hi]}` (the field's sample at the point mapped linearly to 0..1); `{mask, p}` (p where an MP
  mask holds at the anchor cell). The op's own `mask` (MP) is tested at the anchor cell too.
- **Exclusions (hard, in the evaluator):** the item's reach must stay in the claim, off the IR's lots (box and apron) and `keepOut`
  rects; its cells' columns must have 0 in the `avoid` field and, for an item that `melts`, in the `lit` field. A body never writes
  a cell of a part's `keep` (F1's keepNatural: the frozen volume's class in the kept box).
- **Anchors.** `ground`: the point column's frozen ground (or the top a `relief` op of an earlier or the same stage gives it), the
  anchor cell is the one above; the column must be dry ARSV ground (no water, frozen water, lava, tree or missing flag). With a frozen
  volume (`classAt`), the ground cell's class must be in `on` (default `ROCK, SOIL, LOOSE, ICE, SNOW`) and the anchor cell air, a
  plant or a snow layer; an item whose `on` is `SOIL` alone is a plant (its vanilla soils, `#minecraft:supports_vegetation`, are
  that class but for clay and dirt paths) and fires only where the volume reads it (never on a relief-moved column). `ceiling` and
  `wall` read the volume only: the lowest air cell in `y` with a solid cell above (ceiling: face `up`) or beside it (wall: the first
  of N, E, S, W from the turn's start; face toward it). Without a volume they never fire.
- **Items.** `block` (one cell; per face for ceiling and wall); `patch` (each entry at its own column's ground + 1, turned; a column
  that fails its own support is skipped); `cells` (an ARVB body, kind `voxels`, root at the anchor cell, turned, plus a `skirt` of
  each base column's block down to the frozen ground, at most 6). Reach (Chebyshev, columns) at most `SCATTER_MAX_RADIUS` = 4: a
  placement's decision reads its footprint's columns (within 4 of the point), so every cell it writes depends only on columns within
  8 of it (K2).
- **Lights** (`light: [dx, dy, dz, level]`): no ice within `level - 11` (Manhattan) and no snow other than the columns' own snow
  layers within `level - 12` (the volume), no tree or frozen column within `level - 12`; the natural snow layers there (the cell over
  each column's frozen ground, class SNOW) are written as air first, under every placement's cells.
- **Order.** Grid cells by z then x; within a column the clearing first, then the bodies; the last op wins as for every op.

## The `stamp` op (format 2, kind `stamp`)

`{op: 'stamp', id: '<feature>/<seed>', blob, root: [x, y, z], at: [x, y, z], rotation: 0|90|180|270, skirt: 0..6 (6), cond, walk}`:
the ARVB blob's cells (kind `voxels`), turned as voxels turn, with the root cell at `at`; each base column (its lowest cell on the
body's bottom layer) gets a skirt of that cell's block down to the frozen ground (at most `skirt`). Bounds: the turned body at `at`.

## Stamps (`lib/region/stamps.mjs`; local-only, Noah's N-F2-1)

A stamp file is `gzip(ARSP)` (pinned header): `'ARSP'`, u8 1, 3 zero bytes; the feature id, the seed, the game version and the ground
template (varint length + UTF-8 each); the root cell in the ARVB's local cells (3 zigzag varints); the block-entity cells left out
(varint); then the ARVB bytes. The harvester (`dev.feature.stamp`, `tools/harvest-stamps.mjs`) writes `<game>/architect/stamps/
<feature>/<seed>.bin`; the helper passes that dir to the plan CLI (`plan ... --stamps <dir>`, read in the plan sandbox; config
`regions.stampsDir`, `ARCHITECT_STAMPS_DIR`). The library is never in the repo (`kit/stamps/` is gitignored) or the jar (the mod's
kit copy excludes `stamps/**`). A plan embeds each stamp it uses as a side blob `stamp_<feature>_<seed>` (its fluids dropped and
waterlogged states dry: F2 places no fluid). `syntheticStamp(kind, seed)` builds test stamps (no vanilla data).

## Program side (`lib/region/scatterPlan.mjs`, `lib/region/scatterItems.mjs`)

- `stamp(r, id, at, {rotation, skirt, stage, part, cond})` places one library stamp (part `stamp_<id>`); a missing one is a plan note
  and returns null.
- `scatter(r, id, spec, {stage, part})` emits one scatter op in part `id`: `spec.items` take bundled items (`{item: 'boulder'|'stump'|
  'shrub'|'fern_patch'|'moss_carpet'|'snow_layer'|'glow_lichen'|'path_lantern', w, ...params}`), library stamps (`{stamp: id | [ids],
  w, skirt}`; missing ones fall back to `fallback`, a boulder by default, noted) or raw IR items. From the plan's draft virtual world
  so far it builds `<id>_avoid` (walk cells, the columns other parts wrote, blocks or cuts, a relief's band excepted, the lots' boxes
  and aprons), `<id>_lit` (columns within a planned light's snow reach plus 1, when an item melts) and, for `density: {path: [a, b],
  p}`, `<id>_pathd` (Chebyshev distance to the nearest walk column). It reads `ctx.keepOut`, so the IR records the honoured rects.
- `meta.scatter` (per op: items, fields, notes) and `meta.stamps` go to the plan's meta.

## `scatter_demo` (`kit/regions/scatter_demo.mjs`, `catalogue = false`)

Surface (S2's claim and its flat variant): a boardwalk path, one lot, a stamp of each surface library feature (oak, birch, spruce,
acacia, dark oak, the two huge mushrooms) and a buried fossil, each fitted so every part of it touches solid natural ground; path
lanterns (light 15) by distance to the path; ground decoration (boulders, stumps, shrubs, fern patches, moss carpets, snow layers,
small library trees). `stamps: false` is the committed golden's variant (N-F2-1). Cave (`cave: true`, the 6b volume fixture): glow
lichen on cave walls and ceilings at least 2 under the ground, and the dripstone clusters fitted into the cave.

# Phase 6c slice B additions (terrain brushes; CONTRACT "Phase 6c slice B")

## Kit 0.23.0

`KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.23.0 (a placeholder: the coordinator renumbers at merge). Every IR
sha moves by its `kitVersion`; no program but `brush` changes its parts, ops or tiles (S1, S7, `mega_bench` and the 6b goldens hold).
`KINDS_FORMAT2` (kit and mod) gains `volume:blocks`, appended after F2's `scatter` and `stamp`.

## ARVX version 2 (block ids)

Version 2 is version 1 plus, after the owner table:

```
varint blockCount, then blockCount x (varint byteLength + UTF-8 block id, no properties; entry 0 is minecraft:air)
columns, x-major: runs bottom-up of (varint blockIndex, varint length)        (lengths sum to the height)
```

The classes are version 1's, so every v1 reader of classes reads a v2 file's classes the same (the kit's `decodeArvx` and the mod's
`Arvx.decode` read both; a kit before 0.23.0 refuses version 2). A MISSING column's block run is air (a reader asks the class
first: `blockAt` answers null there). The mod writes v2 only when asked: `r.needVolume(box, {blocks: true})` (the `needVolumes`
entry carries `blocks: true`; at most 32M cells, `VolumeSurvey.MAX_BLOCK_CELLS`) and a brush stroke's volume. Fixture:
`mod/src/test/resources/arvx/blocks.{bin,json}` (written by `ArvxBlocksTest`, read by `kit/test/brush-b.test.mjs`).

## The `block` mask term (MP's ruling made real)

An IR volume with block ids carries `volumes[name].blocks: true`, and the IR then requires `volume:blocks`. A mask's `block` term
reads the cell's block id from those volumes (outside them: no block, the term is false). Tags are expanded at plan time into the
IR member `blockTags: {"#minecraft:tag": [ids]}` (the evaluator can't read the 26.3 tables); `blockTags` is a format-2 member. A
`block` term over a version-1 volume or no volume still refuses `MASK_NEEDS_VOLUME`.

## The `json` param type

Region programs only: `{type: 'json', default: null}`, a JSON object (at most 8,192 characters) or null; the program validates it
(the brush's `mask` and `pattern`). Never a variant axis.

## `Part.columns(from, to, cols, materials, {cond, walk, mask})`

The low-level `columns` op for programs (as `fill` is for `shape`): `cols` is a flat `[x, z, a, b, m]...` list, `materials` anything
`fill` takes (roles, block states, null for air, patterns).

## `brush` (`kit/regions/brush.mjs`, `catalogue = false`) and `lib/region/brush.mjs`

Params: `kind` (smooth, erode, melt, blend, raise, lower, overlay, cave_carve), `shape` (sphere, cylinder), `cx`, `cy`, `cz`, `radius`
(1-32), `strength` (1-16), `mask`, `pattern` (json), `destruction` (natural_only, player_blocks). One stage `stroke`, one part
`stroke` (the mask on every op), every op `ALWAYS_OURS` (natural cells and the owner's earlier strokes; the mod decides the rest).

- **The box:** x/z within `radius` of the centre, y within `radius` (a cylinder is `2r + 1` high), clamped to the world. The
  claim is the box plus 8 (the survey margin); the frozen volume the box plus 2 (`VOLUME_PAD`), with block ids, for MELT,
  CAVE_CARVE and a mask with a `block` or `class` term. The mod's `Brushes` computes the same boxes (a test holds them equal).
- **Surface kinds** (smooth, erode, blend, raise, lower) move the columns whose ground lies inside the shape (not water or lava) to
  a new ground `h`; one `columns` op from/to `{surface: 0}`: a fill writes the old top and the new cells (the subsurface role under
  the surface role, or the pattern), a cut writes air from `h + 1` to the old top.
  - SMOOTH: Jacobi toward the 4-neighbour mean (1/16 fixed point, `2 * strength` sweeps, a sweep kept only when neither the
    largest step between inside columns nor the step energy rises), then a step descent (pairs at the largest step move one block
    closer when no step touching the column grows to it). The columns outside pin the edge.
  - RAISE / LOWER: `+/-strength` at the centre; a cylinder falls off by `(1 - d^2/r^2)^2`, a sphere by `sqrt(1 - d^2/r^2)`, rounded.
  - ERODE: thermal (a drop over 2 slides a block) and stream (D8 accumulation at 24) sweeps, at most `strength` per column.
  - BLEND: the inside columns within a third of the radius keep their ground; the ring relaxes (Jacobi, `4 * radius` sweeps) to
    the land outside, each column within `strength` of its ground.
- **OVERLAY:** the top `strength` cells of each inside column (`{surface: 1 - strength}` to `{surface: 0}`): the pattern, else
  the subsurface role under the surface role.
- **MELT:** `strength` rounds over the frozen volume; a round removes every removable cell inside the shape with at least 4 air
  (or plant) neighbours of 6, against the world the earlier rounds left. Removable: ROCK, SOIL, LOOSE, ICE, SNOW; with
  `player_blocks` also PLAYER and BLOCK_ENTITY. Air writes only (absolute `columns` runs).
- **CAVE_CARVE:** a seeded worm from the centre (`ctx.rng('cave')`, compass headings, a gentle pitch), `radius / 2` steps of 2,
  tube radius `1.5 + strength / 4` (at most 4.5), its floor levelled (no cell below the centre line's y minus half the tube). The
  worm stops before a segment any of whose cells is within one cell (26-neighbourhood) of water, lava or a MISSING cell (M4), and
  the solid cells the carve cuts off from the volume's faces are carved too (M3). Only removable cells; air writes only.
## The `route` pass (`passes/route.mjs`, 6c T2)

```js
export const passes = ['route'];
const net = r.pass('route', { nodes: { gate: { lot: 'gate', kind: 'gate' }, look: { at: [x, y, z], kind: 'lookout' } },
  edges: [{ id: 'up', from: 'gate', to: 'look', width: 3, movers }], maxGrade: 0.25, hairpinLanding: 3, stairs: true, ladders: true,
  maxCut: 4, maxFill: 4, prefer: [[x, z]], stage: 'routes', base });
// -> {edges: [{id, ok, failed?, length, rise, segments}], data: {...}}; meta.route has every edge's path, segments, landings, ladders
```

- **Ends:** a `nodes` entry (`{at: [x, y, z]}` feet, or `{lot: id}`), a lot id (its entrance; the route leaves straight out of its
  front) or a graph node. **Movers** (S-T2-1): an edge's own `movers` win; otherwise an end of a player-only kind (`lookout`,
  `watchtower`, `tower`, `overlook`; the node's `kind`, else the lot's `architect_mc:village` villager/type/role) makes it `['player']`,
  else `['player', 'villager']`. **Ladders** (S-T2-2) only on an edge without `villager` (`ladders: true` by default).
- **Search:** A* over (cell, heading of 8, straight cells since the last turn, surface offset from the land); a walk turns 45 degrees
  after 3 straight cells; the profile (1/16 block) moves at most `maxGrade` a cell, so every 8-cell window of a walk run is within the
  grade, and switchbacks emerge where the land is steeper. Moves: walk (length, turn, grade, cut and fill by width), stair flights
  (cardinal, 2..8 rising or falling 1 a cell, then 2 flat cells; `stairs`), hairpins (a flat landing `max(hairpinLanding, width)`
  deep and two lanes wide, then back one lane over), ladders (a cliff of 2..24 climbed against its face), and an earlier edge's built
  cells (walked at their y, a step of at most 1: `shared` segments, built by that edge). Ties by (f, g, x, z, heading, k, offset).
  Coarse to fine: a corridor search at 4 cells, the cell search within 16 of it, then 48, then the whole claim (when it fits the state
  cap). A route that crosses itself is searched again with the crossing blocked (at most 8 times).
- **Obstacles:** the claim margin (2), lava, unknown columns, the lots and their aprons, forms, keep sets, and trees under the
  footprint; water and keep-out (`ctx.keepOut`, so the IR records it, plus the intent's `keepOut`) also one column beside it (a
  retaining column, a 4e lantern). No stair or ladder within 1 of an edge's end. An edge that can only cross water fails
  `ROUTE_WATER` (bridges are T3), else `NO_ROUTE`, with a note; the plan goes on.
- **Hysteresis:** the caller's `prefer` cells (a 4e road, a region path, an earlier plan's route: 6d) and the plan's own 4e roads,
  graded paths and earlier edges cost a third.
- **Output** (part `routes`, set `path`, in `stage`): each column written once (`edgeColumns`: the nearest centre cell's y, owned by
  one segment). A walk on the surveyed ground is a 4e ground road (4e follows the realised ground); elsewhere graded columns
  (`_routeRun`: fill from the floor, `retain` on a tall edge, cut to the column's top and 3 clear, the `path` surface, a retaining
  column where the land beside stands over 2 higher); flights are `stair` with their ground; landings flat; ladders `minecraft:ladder`
  columns (`_ladder`). Graph edges `route_<id>` carry `movers` and `segments` (V's shape plus those two). A route writing into
  keep-out refuses the plan `KEEP_OUT`. Lamps: the program's `lightCover` with `extra` spots beside the routes (`lampSpots`).
- **Checker** (`routeRules`, when `meta.route`): `M2` (an edge's ends don't reach each other by the player mover), `M2:villager` (a
  villager edge's ends by the villager mover, or a ladder on one), `M2:grade` (a walk run's 8-cell window over the grade, the surface
  read from the world); `metrics.route`, `metrics.M5route` (M5 over the routes' walk cells).

## `route_demo` (`kit/regions/route_demo.mjs`, `catalogue = false`)

A gate, a hall, a chapel and a lookout (9x9 lots) from a valley floor to a shoulder about 60 above; edges gate - hall and hall -
chapel (villager), chapel - lookout (player-only). Sites from params `gateX` .. `lookoutZ` (the scenario pins them on S3's claim)
or found; on a flat world a hill raised in stage `ground` (a ridge rising 1 in 2 to 40), routed through the pass's `base`. `edges`
adds grid edges for the plan-time bench.
