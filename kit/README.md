# Architect blueprint kit

Buildings as code: a design (`designs/<id>.mjs`) builds a vanilla structure template (`.nbt`) and its sidecar
(`.blueprint.json`), the checker validates both, and the renderer draws previews without the game. Plain ESM; runs
with `node` (>= 22) and no `npm install`. The contract is `docs/CONTRACT.md` ("Library on disk", "Checker profiles",
"Kit CLI"). Ported from AgentCraft's `tools/blueprints` (MIT, see LICENSE).

## CLI

```sh
node kit/build.mjs cabin [--out <dir>] [--max x,y,z] [--type <t>] [--json]   # build + check
node kit/render.mjs kit/out/cabin.nbt [--out <dir>] [--cutaway]                # iso / top / front previews
node kit/tools/examples.mjs                                                    # rebuild kit/examples/<id>/
node --test kit/test/*.test.mjs                                                # tests
```

`build.mjs` writes `<out>/<id>.nbt` and `<out>/<id>.blueprint.json` (default `kit/out/`), prints `warning:` and
`error:` lines and `check: OK` / `check: FAILED`. Exit 0 = OK, 1 = check failed, 2 = the design threw or bad usage.
`--json` prints one line: `{ ok, errors, warnings, nbt, sidecar }`.

## Writing a design

This passes `build.mjs` with no warnings (the template's size must match the blocks' extent exactly):

```js
import { Blueprint, PALETTES } from '../lib/kit.mjs';
export const id = 'cabin';
export default function build({ palette: p = PALETTES.rustic } = {}) {
  const bp = new Blueprint({ id, type: 'cabin', size: [11, 10, 11], origin: [1, 0, 1], palette: p,
    interior: [1, 1, 1, 7, 4, 5] });              // design coordinates; origin shifts them into the template
  bp.room([0, 0, 0, 8, 5, 6]);                   // walls + floor + ceiling + air
  bp.door(4, 1, 6, 'south');                     // wooden; bp.ironDoor() adds the two buttons
  bp.roofGable(-1, -1, 9, 7, 5, { gableInset: 1, gableFrom: 6 });
  bp.ceilingLights(1, 1, 7, 5, 4);
  bp.floor(3, 7, 5, 9, 0, p.path);               // a path out front
  bp.spot('entrance', 4, 7, 180);                // outside the front door
  bp.spot('spawn', 4, 9, 180);
  return bp;
}
```

Coordinates: +x east, +y up, +z south; floor row `groundY - 1`, feet row `groundY` (default 1). Read materials
from the palette (`p.planks`, `p.log`, `p.stone`, `p.roofStairs`, ...) so the design re-runs in other materials:
`palette({ wood, stone, roof, accent, ...overrides })`, presets in `PALETTES`.

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
the tower / barn / gatehouse geometry and the minimum interior volume per type.

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
