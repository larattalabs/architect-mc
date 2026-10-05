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
node kit/tools/describe.mjs cabin                                              # params, palettes (one JSON line)
node kit/check.mjs <file.nbt> <sidecar.json> [--max x,y,z] [--type <t>] [--imported] [--json]  # check a pair, no source
node kit/import.mjs <file.nbt> --id <id> --out <dir> [--name <n>] [--json]     # a structure-block save -> entry
node kit/tools/examples.mjs                                                    # rebuild kit/examples/<id>/
node --test kit/test/*.test.mjs                                                # tests (incl. the param x palette sweep)
```

`build.mjs` writes `<out>/<id>.nbt` and `<out>/<id>.blueprint.json` (default `kit/out/`), prints `warning:` and
`error:` lines and `check: OK` / `check: FAILED`. Exit 0 = OK, 1 = check failed, 2 = the design threw or bad usage.
`--json` prints one line: `{ ok, errors, warnings, nbt, sidecar }` (also for bad usage).

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

## Checker (`lib/check.mjs`)

Errors: vanilla blocks with every property explicit and valid, sidecar fields, `entrance` + `spawn` standable,
doors closed, an outside door, iron doors with a button on both sides on a conductive block, every standable
interior cell lit by vanilla emitters, `--max`, `--type`. Warnings (phase 1): floating blocks, a reachable front
door, interior floor levels reachable from the entrance, enclosure (roof, wall gaps), unwritten interior cells,
the tower / barn / gatehouse geometry and the minimum interior volume per type. Phase 2 warning: a wood or stone
family that isn't from the sidecar's `palette`.

**Imports** (`--imported`, `import.mjs`): a structure the player built is theirs, so the rules about how a building
works (anchors standable, doors closed / with buttons, an outside door, light) and a size that doesn't match the block
extents become warnings prefixed `imported:`. These stay errors: the structure format, palette validity (vanilla
26.3 blocks with valid property values; every unknown or non-vanilla id is listed in one error with its block count),
the sidecar fields and `--max`. Older saves are read as the game reads them: `Name`/`Properties` palette keys, and
missing properties take their defaults.

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
