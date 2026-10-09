# Architect blueprint kit

Buildings as code: a design (`designs/<id>.mjs`) builds a vanilla structure template (`.nbt`) and its sidecar
(`.blueprint.json`), the checker validates both, and the renderer draws previews without the game. Plain ESM; runs
with `node` (>= 22) and no `npm install`. The contract is `docs/CONTRACT.md` ("Library on disk", "Checker profiles",
"Kit CLI"). Ported from AgentCraft's `tools/blueprints` (MIT, see LICENSE).

## CLI

```sh
node kit/build.mjs cabin [--out <dir>] [--max x,y,z] [--type <t>] [--json]   # build + check
node kit/build.mjs cabin --palette cherry --values '{"width":11,"porch":false}'  # a variant
node kit/render.mjs kit/out/cabin.nbt [--out <dir>] [--cutaway]                # iso / top / front previews
node kit/render.mjs kit/out/cabin.nbt --views iso,iso_back,front,top,cutaway    # pick the views (phase 5a)
node kit/tools/slices.mjs kit/out/cabin.nbt [--y N|A-B] [--box x0,z0,x1,z1] [--storeys] [--max-chars N]  # layered ASCII
node kit/build.mjs cabin --restraint <bible.json> --json                       # metrics + restraint warnings (phase 5a)
node kit/tools/describe.mjs cabin                                              # params, palettes (one JSON line)
node kit/check.mjs <file.nbt> <sidecar.json> [--max x,y,z] [--type <t>] [--imported] [--json]  # check a pair, no source
node kit/import.mjs <file.nbt> --id <id> --out <dir> [--name <n>] [--json]     # a structure-block save -> entry
node kit/tools/examples.mjs                                                    # rebuild kit/examples/<id>/
node kit/build.mjs cabin --bible kit/out/my_bible.json                         # build under a style bible (or --bible cherry)
node kit/build.mjs lair --type hellish_lair --profile door,lit,no_floating      # an open type with its profile
node kit/tools/components.mjs <components.mjs> --bible <bible.json|name> --out <dir> [--json]  # component test frame + sheet.png
node kit/tools/bible.mjs validate <bible.json> [--scope settlement] | builtin [<name>] | roles  # style bibles
node kit/tools/preset-builds.mjs                                               # the presets still build byte-identically
node kit/build.mjs tavern --massing kit/massings/tavern_massing/tavern_massing.blueprint.json  # detail vs its massing
node kit/tools/massings.mjs                                                    # build + render the example massings
node kit/tools/region.mjs plan kit/regions/mega_bench.mjs --survey s.bin --claim x0,z0,x1,z1[,y0,y1] --out <dir> [--json]  # region programs (phase 6a)
node kit/tools/region.mjs eval <dir>/ir.json --tile tx,tz --heights h.bin [--stage s] [--set terrain|path] [--json]  # one tile's cells
node kit/tools/region.mjs synth --box x0,z0,x1,z1 --out s.bin                  # a synthetic survey / heights window
node kit/tools/region-bench.mjs                                                # mega_bench plan + every tile, the 6a numbers
node --test kit/test/*.test.mjs                                                # tests (incl. the param x palette sweep)
```

Region programs (`regions/<id>.mjs`: `mega_bench`, `region_small`) describe whole sites; the plan turns one into a Region IR
and `lib/realise.mjs` evaluates it per 64x64 tile. See `REGIONS.md` (formats, ops, shapes, primitives, CLI).

`build.mjs` writes `<out>/<id>.nbt` and `<out>/<id>.blueprint.json` (default `kit/out/`), prints `warning:` and
`error:` lines and `check: OK` / `check: FAILED`. Exit 0 = OK, 1 = check failed, 2 = the design threw or bad usage.
`--json` prints one line: `{ ok, errors, warnings, nbt, sidecar, metrics }` (also for bad usage; `metrics` is null when
the check could not compute them).

`--palette` is a preset name or JSON `{ preset?, wood?, stone?, roof?, accent? }` (inputs only; a preset is applied first,
the other keys over it); `--values` is JSON `{ name: value }` over the params' defaults. An unknown palette or a value
outside its param's domain is bad usage (exit 2). The sidecar JSON then records:

- `palette`: the inputs the build used, every default filled in (`{ preset?, wood, stone, roof, accent }`); passing it
  back as `--palette '<that json>'` rebuilds the same template;
- `params`: the design's `params` export (absent when it has none); `values`: the full values of this build.

A build never writes `favorite`, `userTags` or `displayName` (the mod's user metadata); rebuilding into a folder that
has a sidecar keeps them.

`tools/describe.mjs <id>` prints `{ id, params, values, palette, palettes, choices }`: the params and their defaults,
the design's default palette inputs, the presets as `[{ name, preset, wood, stone, roof, accent }]` and
`choices: { woods, stones, roofs }` (what a custom palette accepts). `describe.mjs --palettes` prints only the last two.

`import.mjs` makes a library entry from a vanilla structure file: `<out>/<id>.nbt` (the first palette, entities
dropped, otherwise as saved) and a sidecar with type `custom`, groundY 1, front south, the entrance at the front centre
just outside the box, spawn 2 further out, `imported: true` and no source. It is checked with the custom profile in
import mode (see "Checker"); `--max` defaults to 96,64,96.

## Writing a design

This passes `build.mjs` with no warnings (the template's size must match the blocks' extent exactly):

```js
import { Blueprint, PALETTES } from '../lib/kit.mjs';
export const id = 'hut';
export const params = {
  width: { type: 'int', min: 7, max: 11, default: 9, label: 'Width' },
  chimney: { type: 'bool', default: true, label: 'Chimney' },
};
export default function build({ palette: p = PALETTES.rustic, width = 9, chimney = true } = {}) {
  const X = width - 1;                           // east wall
  const bp = new Blueprint({ id, type: 'cabin', size: [X + 3, chimney ? 12 : 10, 11], origin: [1, 0, 1], palette: p,
    interior: [1, 1, 1, X - 1, 4, 5] });          // design coordinates; origin shifts them into the template
  bp.room([0, 0, 0, X, 5, 6]);                   // walls + floor + ceiling + air
  const D = Math.floor(X / 2);
  bp.door(D, 1, 6, 'south');                     // wooden; bp.ironDoor() adds the two buttons
  bp.roofGable(-1, -1, X + 1, 7, 5, { gableInset: 1, gableFrom: 6 });
  if (chimney) bp.chimney(X + 1, 3, 0, 10);      // the stone column through the overhang, smoke on top
  bp.ceilingLights(1, 1, X - 1, 5, 4);
  bp.floor(D - 1, 7, D + 1, 9, 0, p.path);       // a path out front
  bp.spot('entrance', D, 7, 180);                // outside the front door
  bp.spot('spawn', D, 9, 180);
  return bp;
}
```

Coordinates: +x east, +y up, +z south; floor row `groundY - 1`, feet row `groundY` (default 1).

**Parametric designs.** `export const params` declares 2 to 4 things a player may vary: `int` (`min`, `max`,
`default`), `bool` (`default`) or `enum` (`options`, `default`), each with a `label`. The default export takes
`{ palette, ...values }` and must build (and pass the checker) for every value in the domain; the tests sweep every
corner (int min/max, both bools, every option) in every palette preset. Keep the defaults small enough for the request.

**Palettes.** Read every wood and stone from the palette (`p.planks`, `p.log`, `p.strippedLog`, `p.stairs`, `p.door`,
`p.accentLog`, `p.stone`, `p.stoneStairs`, `p.stoneTrim`, `p.roofStairs`, `p.plaster`, ...), never literal ids, so a
palette swap re-skins the whole building: the checker warns about a wood or stone family that isn't from the palette.
Decor (chests, barrels, beds, lanterns, glass, carpets) is free. `palette({ preset, wood, stone, roof, accent })`; the
presets (`PALETTES`, inputs in `PALETTE_PRESETS`): rustic, oak, birch, dark, desert, brick, cherry, mangrove, crimson,
fortress. A stone must have stairs and slab variants; `stoneWall` falls back to the stone's family, `stoneTrim` is a
second block of the same family (bands, roads).

Helpers (`lib/kit.mjs`): `set/fill/hollow/carve`, `walls` (with `openings`), `room`, `floor`, `post`, `beam`,
`window`, `windows` (a row with rhythm, sills), `door`, `ironDoor`, `doubleDoor`, `stairs`, `slab`, `stairRun`
(between floors, carves the stairwell), `ladder`, `roofGable` / `roofHip` (overhang = a larger rectangle; a lining
under each course so nothing floats) / `roofFlat` (parapet, crenels), `chimney`, `porch`, `lantern`, `torch`,
`candle`, `ceilingLights`, `plant`, `rug`, `table`, `chair`, `bed`, `anchor`, `spot`, `camera`.

## Style bibles, components, named parts, open types (phase 4b)

**Roles.** A style bible (`lib/bible.mjs`, docs/CONTRACT.md "Style bible") names a vanilla block per role: `wall`, `wall_alt`,
`trim`, `roof`, `floor`, `frame`, `accent`, `light`, `glass`, `foundation`, `path` (plus any extra named roles; a
settlement-scope bible adds `rock`, `surface`, `subsurface`, `rubble`, `rail`, `structure`). `palette({ bible })` derives
every palette field from a role (`ROLE_FIELDS` in `lib/kit.mjs`: wall -> `wall`, wall_alt -> `plaster`, trim -> `stoneTrim`,
roof -> `roofBlock/roofStairs/roofSlab`, frame -> `frame` and the wood set of its wood, accent -> the accent wood set, glass ->
`pane`/`glass`, foundation -> `foundation` and the stone set, ...), so a palette-driven design re-skins under any bible. Every
palette has `p.roles` (presets too). The 10 presets are the built-in bibles (`builtinBible(name)`, no prose):
`palette({ bible: 'cherry' })` is field for field `PALETTES.cherry`, and the examples build byte-identically under both
(`test/bible.test.mjs`, `tools/preset-builds.mjs`). A bible build records `palette: { bible: { id, version, roles } }` (it
round-trips through `resolvePalette`) and `bible: { id, version }`. A design in a group loads its bible with
`loadBible(new URL('../../bible/bible.json', import.meta.url))` and defaults to `palette({ bible: BIBLE })`.

**Components.** A bible's `components.mjs` exports `(bp, at, opts)` functions that place a small part with the roles:
`window`, `door_surround`, `lantern_post`, `roof_trim`, `chimney` at least (`lib/components.mjs` has the rules and the `at`
of each). It imports nothing (it is copied between folders): materials come from `bp.p` / `bp.p.roles`, directions from
`bp.kit`. `tools/components.mjs` builds each component into a test frame (a small lit house in the roles), checks it (an
error fails the component; warnings are reported) and renders `sheet.png` (a swatch of the roles, then one tile per
component). `bibles/rustic/components.mjs` is the reference library.

**Named parts.** `bp.part('wing_east', () => { ... })` records the cells a part writes (the innermost part; a later write
takes a cell over). The sidecar gets `parts: { name: { box: [x0,y0,z0,x1,y1,z1], cells } }`. Warnings: fewer than 2 parts,
or more than 20% of the template's cells outside every part. The examples declare theirs.

**Open types.** `type` may be any short string (`/^[a-z][a-z0-9_]{0,39}$/`). A non-preset type is checked with its `profile`
(`new Blueprint({ type: 'hellish_lair', profile: ['door', 'lit', 'no_floating'] })`), rules from the menu `door`,
`roof_closed`, `floors_reachable`, `lit`, `no_floating`, `interior`, `min_interior_volume:<n>`, `passage:<w>x<h>`,
`tall:<ratio>`; without one it gets `door`, `lit`, `no_floating`. `lit` (and the other interior rules) require `interior`.
Preset types keep their profiles. `build.mjs --profile` passes the request's profile; the design must declare the same one.

## Massing designs (phase 4c)

A massing is the cheap first pass: the building's volumes, roof forms and major openings, no detail. It is an ordinary
design (`designs/<id>.mjs`) that builds with `lib/massing.mjs`; its sidecar says `massing: true`, and the detail design
that follows keeps its **part names** and **boxes**.

```js
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';
export const id = 'inn_massing';
export default function build({ palette: p = PALETTES.rustic } = {}) {
  const bp = new Blueprint({ id, type: 'tavern', size: [16, 17, 12], origin: [1, 0, 1], palette: p });
  const m = massing(bp);                                   // marks it massing: true
  m.mass('hall', [0, 0, 0, 13, 5, 8], { wall: 'foundation' });                    // stone ground storey
  m.opening('hall', 'south', [6, 1], [2, 2]);              // the double door (a door: it starts on the feet row)
  m.mass('lodging', [0, 6, 0, 13, 10, 8], { wall: 'wall_alt', roof: 'gable', ridge: 'x', roofPart: 'roof' });
  bp.part('roof', () => bp.fill([14, 0, 4, 14, 16, 4], p.foundation));  // the chimney goes with the roof
  bp.floor(5, 9, 8, 10, 0, p.path);
  bp.spot('entrance', 6, 9, 180);
  bp.spot('spawn', 7, 10, 180);
  return bp;
}
```

- `m.mass(name, [x0,y0,z0,x1,y1,z1], { roof, ridge, storeys, overhang, wall, roofPart, high, parapet, crenels })`: a closed
  shell over the box (design coordinates; y0 the floor row, y1 the top row, where a sloped roof's eaves sit). `roof`:
  `gable` | `hip` | `shed` (stairs and slabs of the roof role, overhang 1 by default) | `flat` (a roof-role deck on row
  y1+1 inside a wall parapet, `crenels` for merlons) | `none` (default). `ridge` `x`/`z` (default the longer side; for a
  shed the axis of the high edge, `high` its side, default the back). `storeys` puts floors inside and is recorded.
  `wall` is the shell's role (`wall` by default; `foundation` reads as stone, `wall_alt` as plaster). The roof goes in
  part `roofPart` (default the mass itself). Every mass is a named part; its roof form is recorded as `parts.<name>.roof`
  (and on `roofPart`).
- `m.opening(mass, face, [u, y], [w, h], { kind })`: a door (doors on the bottom two rows, glass above; the default when
  it starts on the mass's first feet row and is 2+ tall), `window` (glass) or `arch` (open) in the `face` wall of that
  mass. `u` is the first column along the face (x on north/south, z on east/west). It stays in the mass's part.
- `m.stilts(name, box, spacing)`: frame-role posts every `spacing` cells (corners always) from y0 to y1; put a mass on
  top at y1 + 1.
- The materials are the roles in flat form (shell, foundation on the ground row, floor, roof, glass, frame), so a
  massing reads in the bible's colours and re-skins with the palette. Plain `bp.part(name, () => bp.floor(...))` adds
  ground, paths or a chimney column to a part.

**Names.** Name masses by what they are for: `hall`, `lodging`, `wing_east`, `tower`, `porch`, `roof`, not `box1`. The
names carry over: the detail design wraps the same volumes in `bp.part('<same name>', fn, { roof: '<same form>' })`,
inside the same boxes (each face within 1), and may add parts of its own (`openings`, `furnishings`):

```js
bp.part('hall', () => { /* stone walls, the taproom floor, ... */ });
bp.part('lodging', () => { /* timber frame, plaster infill, ... */ });
bp.part('roof', () => { bp.roofGable(-1, -1, X + 1, Z + 1, 10, { ridge: 'x' }); bp.chimney(X + 1, 4, 0, ridge + 1); }, { roof: 'gable' });
bp.part('openings', () => { /* doors and windows: an extra part is fine */ });
```

**Checker profile `massing`** (any sidecar with `massing: true`; `--profile massing` says the request was one): the
structure, palette, sidecar and anchor rules and `--max` as errors; warnings for floating blocks, the named parts (at
least 2) and the walk from the entrance to spawn and into the building (a door or an arch). No door, light, interior or
type-geometry rules.

**Conformance** (`build.mjs <id> --massing <massing.blueprint.json>`, `check.mjs ... --massing <file>`, lib:
`checkConformance(detailSidecar, massingSidecar)`): the detail's size is at most the massing's + 2 on every axis (an
**error**, the cap binds; with `--max` the request's limit applies too). Warnings, prefixed `massing:`: a massing part
missing from the detail, a part box more than 1 off on any face, the size more than 2 under, a roof form that differs
where both record one. `--json` adds `conformance: { ok, errors[], issues[] }`.

**Examples.** `massings/<id>_massing.mjs` are massings of the four examples (same part names, boxes within 1, the
examples record their roofs); `node kit/tools/massings.mjs` builds and renders them into `massings/<id>_massing/` (not
`examples/`, which is the mod's bundled library) and checks each example against its massing (0 issues).
`test/fixtures/massing/` holds a deliberately non-conforming pair.

## Checker (`lib/check.mjs`)

Errors: vanilla blocks with every property explicit and valid, sidecar fields, `entrance` + `spawn` standable,
doors closed, an outside door, iron doors with a button on both sides on a conductive block, every standable
interior cell lit by vanilla emitters, `--max`, `--type`. Warnings (phase 1): floating blocks, a reachable front
door, interior floor levels reachable from the entrance, enclosure (roof, wall gaps), unwritten interior cells,
the tower / barn / gatehouse geometry and the minimum interior volume per type. Phase 2 warning: a wood or stone
family that isn't from the sidecar's `palette`. Phase 4b warnings: named parts (fewer than 2, more than 20% of the cells
outside); an open type's profile geometry. Phase 5a warnings: `attach:` and `facing:` (below), and `restraint:` with
`--restraint`.

**Imports** (`--imported`, `import.mjs`): a structure the player built is theirs, so the rules about how a building
works (anchors standable, doors closed / with buttons, an outside door, light) and a size that doesn't match the block
extents become warnings prefixed `imported:`. These stay errors: the structure format, palette validity (vanilla
26.3 blocks with valid property values; every unknown or non-vanilla id is listed in one error with its block count),
the sidecar fields and `--max`. Older saves are read as the game reads them: `Name`/`Properties` palette keys, and
missing properties take their defaults.

## Phase 5a: views, slices, attach and facing, metrics, restraint, the playbook

**Renders.** `render.mjs --views <list>` writes `<id>.preview-<view>.png` for each listed view: `iso` (front-left),
`iso_back` (the iso camera turned 180 degrees: back-right), `front`, `top`, `cutaway`. Without `--views` the default
stays iso, top, front, and `--cutaway` adds cutaway. An unknown view is bad usage (exit 2).
`renderStructure(nbt, { views })` takes the same list.

**Slices** (`tools/slices.mjs`, from Steward's minecraft-structure-design skill, owned by Architect): the template as
layered ASCII, one character per block, north up, west left, a legend and a listing of directional blocks with their
facing. `--y` and `--box` pick layers and a sub-rectangle; `--storeys` prints only the floor row and the eye-height row
(feet row + 1) of each storey (the interior's floor levels, `floorLevels`; at most 6 layers, needs the sidecar, by
default `<id>.blueprint.json` next to the `.nbt`); `--max-chars N` truncates the output to N characters with a final
`... (truncated)` line. `slices(structure, sidecar, opts)` is the same as a function.

**Attach and facing** (warnings, ported from Steward's attach-lint; promoted to errors only after a full eval shows
zero false positives). One line per kind with a count and up to 5 examples:
- `attach:` ladders, wall torches (every kind), wall signs and wall banners have a sturdy block behind them (terrain, a
  full block that is not a door, trapdoor or gate, or a stair / slab whose face on that side is full); a door's upper half
  stands on its lower half; both halves of each bed; a hanging lantern hangs from a sturdy block, a chain, a fence, a wall,
  bars or a pane. A lower half without its upper half and a door written open are already errors, not repeated.
- `facing:` a door doesn't open into a wall: the cells in front of and behind it (both rows) are not solid (a door
  turned 90 degrees in its wall, or one opening onto a block); a bed's head is against a wall (the cell beyond the head
  is a full or thin block); a stair on a slope doesn't face down-slope (a bottom, straight stair in a run of at least 3
  stairs rising one row per step in one direction, with free space above, must not face against the rise; a stair
  facing across a run is a hip or a crooked eave and is not flagged).

**Metrics** (`checkStructure(...).metrics`, and `metrics` in the `--json` line of `build.mjs` and `check.mjs`):
`{ accentShare, detailNoise, windowsPerFacade: { north, south, east, west }, windowsMin, paletteAdherence, parts,
cellsOutsideParts, blocks, topBlocks }`; fractions 0..1 rounded to 3 decimals.
- *Shell cells*: non-air, non-liquid cells next to (6 directions) a cell of the outside flood: what a player sees
  from outside. A shell cell is visible from a side when its neighbour on that side is outside.
- `accentShare`: among shell cells without glass, panes, doors, trapdoors and light sources, the share that are
  accents: blocks of the palette's accent fields (`accentPlanks`, `accentLog`, `accentStairs`, `accentSlab`,
  `accentFence`, the bible role `accent`) and blocks in no palette field (decor: moss, wool, vines, a bible's extra
  roles). A block in a main field, or the stairs / slab / wall of one, is main (so the roof stairs stay main when the
  accent wood is the roof wood). Without a recorded palette the 4 most-used material families (a wood, a stone family,
  else the block without its shape suffix) are main.
- `detailNoise`: per side, over pairs of shell cells visible from that side that are neighbours in the facade plane
  (along the facade, or one above the other), the share whose block ids differ; the mean over the 4 sides weighted by
  pair count.
- `windowsPerFacade`: per side, the connected groups of glass / glass-pane cells visible from that side;
  `windowsMin` the smallest.
- `paletteAdherence`: among all cells with a wood or stone family, the share whose family is the palette's (as the
  `palette:` warning computes them); 1 without a recorded palette.
- `parts`: named parts; `cellsOutsideParts`: written cells (air included, as the `parts:` warning counts) outside every
  part; `blocks`: non-air cells; `topBlocks`: the 12 most used non-air ids (no `minecraft:`) with counts.

**Restraint** (bible format 2, `lib/bible.mjs`): `bible.json` may say `format: 2` and
`restraint: { heroMotifs (<= 3 of the motifs), accentShareMax (0.04-0.20, default 0.12), detailDensity (sparse |
moderate | rich, default moderate), windowsPerFacadeMin (int, default 2) }`; format 2 allows at most 6 motifs and the 5
required components plus at most 3. `validateBible` fills the defaults in; a format 1 bible keeps its limits and
`restraintOf(bible)` gives it the defaults with its first 3 motifs as hero motifs. `--restraint <bible.json|name>` on
`build.mjs` and `check.mjs` adds `restraint:` warnings when `accentShare > accentShareMax`, `windowsMin <
windowsPerFacadeMin`, or `detailNoise` is over `DETAIL_NOISE_MAX[detailDensity]` (`lib/check.mjs`; provisional
`{ sparse: 0.32, moderate: 0.42, rich: 0.5 }`: the kit examples measure 0.18-0.38 at every corner and preset, the 4b
bible set 0.45-0.50; frozen after the 5a smoke run).

**Playbook** (`PLAYBOOK.md`): Steward's design playbook (SKILL.md without §7), owned by Architect from 5a. The sidecar
copies it into each design scratch dir and names it in BRIEF.md; it is never loaded through `settingSources`.

## Generated tables

`lib/blocks.mjs` (every vanilla 26.3 block: properties, defaults, collision class, family, light, optics,
conductivity, support, item) and `lib/colors.mjs` (texture colours) are generated; don't edit them.

```sh
node kit/tools/gen-blocks.mjs   # server jar -> data generator reports + tools/BlockDump.java (needs Java 25)
node kit/tools/gen-colors.mjs   # client jar textures
```

The jars come from the Fabric Loom cache (`~/.gradle/caches/fabric-loom/26.3/`) or Mojang's piston-meta; pass
`--server-jar` / `--client-jar` / `--java` to override. The API part of `blocks.mjs` lives in
`tools/blocks.template.mjs`, the per-family rules in `tools/classify.mjs`.
