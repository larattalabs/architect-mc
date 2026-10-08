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
| `regions/<id>.mjs` | bundled programs (`mega_bench.mjs` in 6a) | |
| `tools/region.mjs` | CLI: `plan`, `eval` (`check`, `preview` in 6b) | exit 0 / 1 / 2 |

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

## Sidecar protocol (2, additive; CONTRACT §6 "Sidecar protocol")

Client -> sidecar (each is acked like every message, `{ok, error?, result?}`):
- `region.plan {program, params, seed?, claim, surveyBlobId, bible?, bibleVersion?, roles?}` -> ack `{planId}`; then
  `region.planned {planId, irSha, ir, lots, stages, anchors, budget, tiles, notes}` or `region.failed {planId, message}`.
  `program` is a bundled id (`kit/regions/<id>.mjs`) or a path under `<gameDir>/architect/regions/programs`. The plan dir is
  `<data>/regions/plans/<planId>/` (program copy, `ir.json`, `plan.json`). `ir` travels in `region.planned` so the mod can keep
  a copy in the world (it is at most 4 MB; sent as `irBlobId` instead when over 1 MB: the mod reads the blob).
- `region.tiles.request {planId, irSha, ir?, tiles: [{key, stage, set, heights}]}` (`heights`: base64 `ARSV`): ack
  `{accepted: n}`, or `ok: false, error: "ir_unknown"` when the sidecar has neither the plan dir nor an IR of that sha cached
  and the request carries no `ir`. Then one `region.tile` per tile, in any order:
  `region.tile {planId, key, stage, set, seq, more, data, count, sha}` (`data`: base64 of a slice of the gzip bytes, at most
  1 MB per frame, `seq` from 0; `count` and `sha` on every frame), or `region.tile.error {planId, key, stage, set, message}`.
- `region.release {planId}`: drop cached tiles and the cached IR.

Backpressure: the mod keeps at most W tiles outstanding (config `regionWindow`, default 4); the sidecar evaluates on a
`worker_threads` pool (`regionWorkers`, default `min(4, cores/2)`), at most W evaluated tiles per plan held in memory.
Snapshot features: `region.plan`, `region.tiles`.
