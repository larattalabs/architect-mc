# Phase 1 contract

The mod, the sidecar and the kit are built in parallel against this file. Change it here first,
then in code. Source for everything copied: AgentCraft at commit `8101f9b`, snapshot in `_import/`
(gitignored; `_import/COMMIT`). Keep AgentCraft's MIT notice; LICENSE already carries it.

## Names

| What | Value |
|---|---|
| Display name | Architect |
| Fabric mod id | `architect_mc` (the Modrinth slug `architect` is taken by an unrelated mod) |
| Java package | `dev.larattalabs.architect` (client: `dev.larattalabs.architect.client`) |
| Minecraft / loader | 26.3, Fabric (the same versions as AgentCraft's `mod/gradle.properties`) |
| Env/system-property prefix | `ARCHITECT_` / `-Darchitect.` |
| Sidecar port | `7890` (`ARCHITECT_PORT`) |
| DevBridge port | `7891` (`ARCHITECT_DEV_PORT`) |
| Game data | `<gameDir>/architect/` |
| Sidecar data | `<gameDir>/architect/sidecar-data/` (state.json, logs, design scratch dirs) |

## Repo layout

```
mod/       Fabric mod (Gradle, split client/main source sets like AgentCraft)
sidecar/   Node helper (TypeScript, Node >= 22). `npm run build` -> dist/main.mjs (esbuild bundle,
           with @anthropic-ai/claude-agent-sdk left external)
kit/       blueprint kit (plain ESM JS): lib/ (kit, blocks, check, render, nbt, png), designs/, build.mjs, render.mjs
tools/     devcli.mjs, shoot.mjs, lib/devclient.mjs (DevBridge on 7891)
docs/
```

## Library on disk

`<gameDir>/architect/library/<id>/`, where `<id>` matches `[a-z0-9_]+`:

| file | what |
|---|---|
| `<id>.nbt` | vanilla structure template (as in AgentCraft, docs/BUILDINGS.md "Blueprints") |
| `<id>.blueprint.json` | sidecar (below) |
| `<id>.mjs` | the design's parametric source (kept for phase 2: variants, remix) |
| `<id>.preview-iso.png`, `-top.png`, `-front.png` | previews (optional) |

The mod loads every folder in the library at start, on `/architect reload`, and after a design finishes.
Bundled examples ship in the jar under `data/architect_mc/library/<id>/` and the same id in the user
library overrides them.

### Sidecar `<id>.blueprint.json`

```json
{
  "id": "gen_lakeside_cabin",
  "name": "Lakeside Cabin",
  "description": "A one-room log cabin with a porch and a stone chimney.",
  "type": "cabin",
  "tags": ["rustic", "small"],
  "size": { "x": 11, "y": 9, "z": 13 },
  "groundY": 1,
  "front": "south",
  "materials": ["minecraft:spruce_log", "..."],
  "foundationBlock": "minecraft:cobblestone",
  "approach": { "length": 4, "width": 3, "block": "minecraft:dirt_path", "slab": "minecraft:cobblestone_slab" },
  "interior": { "minX": 1, "minY": 1, "minZ": 1, "maxX": 9, "maxY": 6, "maxZ": 11 },
  "anchors": {
    "entrance": { "x": 5.5, "y": 1.0, "z": 12.5, "yaw": 0.0, "pitch": 0.0 },
    "spawn":    { "x": 5.5, "y": 1.0, "z": 14.5, "yaw": 180.0, "pitch": 0.0 },
    "cam_overview": { "x": -6.0, "y": 10.0, "z": 22.0, "yaw": -140.0, "pitch": 25.0 }
  },
  "source": "gen_lakeside_cabin.mjs",
  "createdAt": 1759600000000,
  "request": { "...": "the DesignRequest it was made from (absent for bundled)" }
}
```

Fields carried over from AgentCraft keep their meaning: `size`, `groundY`, `front`, `foundationBlock`
and `approach` (and their placement rules: terrain fit, foundation fill, entrance approach,
occupancy, fluids, snapshot/restore). Dropped: `kind`, `wings`, every office anchor, `walk` (now
`interior`, optional), and bindings/station blocks. **Architect templates contain vanilla blocks only.**
Required anchors: `entrance` and `spawn`. `cam_*` anchors are optional.

## Building types (`type`)

`house`, `cabin`, `cottage`, `tower`, `shop`, `tavern`, `barn`, `smithy`, `chapel`, `gatehouse`, `custom`.
Each type has a checker profile and a style guide line in the brief. The checker rules are below.

## Checker profiles (kit/lib/check.mjs)

The checker reads `type` from the sidecar and applies **common rules** plus the **profile**. It runs
as `node kit/build.mjs <id>` (build + check, prints `check: OK` or errors) and is reused by the sidecar
with `--max x,y,z` (size limit) and `--type <t>` (expected type).

**Phase 1 severity:** rules inherited from AgentCraft are **errors** (palette validity, door + buttons,
light, anchor standability, size). Every rule that is **new** here (floating, reachability, enclosure, the
profile geometry, interior volume) is a **warning** in phase 1. A new rule becomes an error only after it
passes the hand-written examples and a couple of real generations (record the promotion in PLAN.md).

Common:
- vanilla `minecraft:` blocks only, all of them in `kit/lib/blocks.mjs`; every property explicit and valid
- `entrance` and `spawn` anchors present, with a standable cell (solid below, 2 free cells above)
- at least one outside door, closed, on the `front` face reachable from `entrance`; an iron door
  needs a button on both sides (as in AgentCraft), a wooden door doesn't
- nothing floating: every non-air block is connected to the ground row through other blocks (face
  adjacency; attachables count through their support)
- `interior` (required for every type but `custom`, an error: without it the light rule would be skipped): every standable interior cell is lit by vanilla emitters (block light >= 1),
  every floor level is reachable from the entrance by walking (stairs, ladders, slabs; max step 1),
  and the interior is enclosed (no sky access straight down into it except declared skylights/courtyards)
- size within `--max`

Profiles:
- `tower`: height >= 2 x the smaller footprint side; >= 3 floor levels reachable
- `barn`: an entrance opening at least 3 wide and 3 tall (a door or an open arch)
- `gatehouse`: a passage through the building, front to back, at least 3 wide and 3 tall
- `chapel`, `tavern`, `shop`, `house`, `cottage`, `cabin`, `smithy`: the common rules plus, as a warning,
  a minimum interior volume per type
- `custom`: the common rules only

## Kit CLI (what the sidecar and the design agent run)

Layout: `kit/lib/` (kit.mjs, blocks.mjs, colors.mjs, check.mjs, render lib, nbt, png), `kit/designs/<id>.mjs`
(sources; `export const id`, a default export that returns the Blueprint), `kit/build.mjs`, `kit/render.mjs`.

- `node kit/build.mjs <id> [--out <dir>] [--max x,y,z] [--type <t>] [--json]`: imports `kit/designs/<id>.mjs`,
  writes `<out>/<id>.nbt` + `<out>/<id>.blueprint.json` (default `--out kit/out`), then checks. Prints warnings
  and errors one per line and `check: OK` or `check: FAILED`; exit code 0 = OK, 1 = check failed, 2 = the
  design threw / bad usage. `--json` prints one JSON line instead: `{ ok, errors[], warnings[], nbt, sidecar }`.
- `node kit/render.mjs <file.nbt> --out <dir>`: writes `<id>.preview-iso.png`, `-top.png`, `-front.png`.
- A design scratch dir (sidecar) is `<data>/designs/<designId>/` with `kit/` (a fresh copy), `BRIEF.md`,
  `CONTRACT.md` (this file's blueprint/checker sections), `remix/` (optional). The agent works in `kit/designs/<id>.mjs`.
- **Block table:** `kit/lib/blocks.mjs` is **generated** (`kit/tools/gen-blocks.mjs`) from the vanilla 26.3
  data generator report (`java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports`
  -> `blocks.json`: every block, property domain and default; the collision class derived per block family),
  and `kit/lib/colors.mjs` from average texture colours in the 26.3 client jar. Every vanilla block is
  usable. Station/AgentCraft blocks are gone.
- **Kit helpers** for general buildings: walls with openings, floors, wooden and iron doors, gable / hip /
  flat roofs with overhang, stairs and ladders between floors, windows (pane rhythm), chimney, porch,
  lighting helpers, `anchor()`.
- **Examples** (hand-written, pass the checker, no warnings): `cabin.mjs` and `tower.mjs` first (the sim
  designer and the mod's bundled library use them), then one or two more types. AgentCraft's office
  designs are not carried over.

## Protocol (sidecar <-> mod)

Same transport and envelope as AgentCraft (docs/protocol.md in `_import`): `ws://127.0.0.1:7890`, one
JSON object per text frame, `{ "v": 1, "type", "id"?, ...payload }`. Reject an `Origin` header or a
non-loopback Host. The client sends `hello` and gets a `snapshot`, then broadcasts.

**Client token** (as AgentCraft `clienttoken.ts`): the sidecar writes a random token to `<data>/client.token`
(mode 0600) on start; `hello` must carry `{ token }`, and anything else before a valid hello is refused. `auth.set`
changes credentials and `design.request` spends the user's money, so a stray local process must not reach them.

Client -> sidecar:
- `hello` `{ client: "mod" | "cli", version, token }`
- `design.request` `{ request: DesignRequest }` -> ack `{ designId }`
- `design.cancel` `{ designId }`
- `auth.set` `{ apiKey?: string | null, useClaudeLogin?: boolean }`: the in-game settings; the sidecar stores
  the key in `<data>/secrets.json` (mode 0600), never logs it, never echoes it back
- `shutdown` `{}` (the launcher stops a sidecar it started)

Sidecar -> client:
- `snapshot` `{ version, status: Status, designs: Design[] }`
- `status` `{ status: Status }`
- `design.upsert` `{ design: Design }`
- `ack` / `error` keyed by `id`

```ts
Status = {
  auth: 'ok' | 'missing' | 'failed' | 'checking',
  authSource?: string,          // "API key", "claude login (personal use)", "Amazon Bedrock", ...
  useClaudeLogin: boolean,
  sdk: 'ready' | 'missing',      // @anthropic-ai/claude-agent-sdk resolvable
  designing?: string,            // the running design id
  queued: number,
  usageLimitUntil?: number,
}
DesignRequest = {
  type: BuildingType,
  style: string,                 // free-ish: "rustic", "medieval", "modern", ... (UI offers chips, any text allowed, <= 40)
  materials?: string,            // free text, e.g. "spruce and cobblestone"
  features: string[],            // porch, chimney, balcony, garden, skylights, courtyard, big_windows, basement, ... (<= 6)
  maxSize: {x, y, z},            // x/z 7..96, y 6..64
  plot?: { ... },                // as AgentCraft DesignSpec.Plot, informational
  remix?: string,                // library id
  name?: string,                 // <= 40
  notes?: string,                // <= 2000
}
Design = { id: "d<n>", request, status, step, blueprintId?, size?, previews?, error?, createdAt, updatedAt }
```

`DesignStatus` is the same as AgentCraft. The sidecar knows the library path from its launch flags; the
mod does not send `outDir`.

## Sidecar process (launched by the mod)

`node <sidecarDir>/dist/main.mjs --port 7890 --data <gameDir>/architect/sidecar-data --library <gameDir>/architect/library --kit <kitDir> [--use-claude-login] [--parent-pid <pid>]`

- It exits when the parent pid is gone (checked every 5 s), so a crashed game doesn't leave it running.
- It writes `<data>/sidecar.json` `{ pid, port, version, startedAt }` on start, so the mod can reuse one that's
  already running: if the port answers `hello` with the same `version`, reuse it; otherwise stop it if the
  pid file says we started it, then start ours.
- Auth: `ANTHROPIC_API_KEY` from the environment, else `secrets.json`, else a cloud-provider switch;
  `--use-claude-login` (or `useClaudeLogin` in secrets.json) for personal use only, copied from
  AgentCraft `foreman/src/agents/claude/auth.ts`, including the env scrubbing.
- Design jobs: AgentCraft `foreman/src/agents/claude/design.ts` + `designs.ts`, made standalone: queue,
  scratch dir per job (a fresh copy of `kit/`), BRIEF.md, design turn (claude_code preset, a policy that
  refuses network, subagents and anything that would prompt; a `design_status` tool), a pristine-kit
  re-check in a child process with a minimal env, up to 4 rounds, previews, install into the library
  (never overwriting; the source `.mjs` too), usage-limit hold/resume, session resume after a restart.
- PATH: Minecraft spawns the sidecar with a minimal PATH, and the design agent runs `node kit/build.mjs` through
  Bash. Prepend `dirname(process.execPath)` to PATH for design turns and checker child processes.
- A `sim` designer (no Claude: it copies a bundled example under a new id) for tests and offline UI work.

## Launcher (mod, client side)

- Where the sidecar comes from (first match wins): `-Darchitect.sidecarDir` / `ARCHITECT_SIDECAR_DIR` (a dev
  checkout's `sidecar/`); otherwise the bundle in the jar (`architect-sidecar/` resources: dist/main.mjs,
  package.json, package-lock.json, and kit/), extracted to `<gameDir>/architect/sidecar/<modVersion>/`;
  on first run `npm ci --omit=dev` (npm resolved next to the node binary; `npm.cmd` on Windows) installs the Agent SDK (it pulls a ~200 MB platform binary; progress
  shown in-game).
- Finding node (Minecraft launched from a GUI has a minimal PATH): config `nodePath`; PATH; `/opt/homebrew/bin`,
  `/usr/local/bin`, mise/volta/nvm shims; the login shell (`$SHELL -lc 'command -v node'`). Needs Node >= 22.
  Windows: `where node`, `%ProgramFiles%\nodejs`.
- When: on client start (in the background), if `autoStart` is on (default true). It reuses a running
  sidecar (see above). It stops the sidecar on client exit only if it started it.
- Status for the UI: `node-missing` (with an install link), `installing` (npm progress line), `starting`,
  `running`, `crashed` (the last 20 log lines), `disabled`.

## Mod scope for phase 1

Port from AgentCraft, without repos, wings, leads, agents, stations, trophies, roads, beds, journal (unless
the crash-safety snapshot needs a slim part of it) or HQ:
- placement core: Blueprint(s), BlueprintTransform, TemplateGrid, TerrainFit, Approach, Occupancy, GhostModel,
  Reconcile, a `Site` record (was Building) + `Sites` (was Buildings: place, remove, move, undo move,
  snapshot/restore, crash safety, the world-start check), `<world>/architect-sites.json`
- client: BuildPlacement, GhostRenderer, PlacementHud, PlotMarker, PlotHud, TemplateCells, BlueprintPreview,
  the key handling (KeyboardHandlerMixin)
- **one screen** (`B` key, `/architect`): tabs **Design** (the form: type, style chips + text, materials,
  features, size S/M/L/plot/custom, name, notes; "Design it"), **Library** (a list with previews; Place /
  Delete; phase 2 makes it richer), **Designs** (queue and progress, Cancel), **Status** (the sidecar/launcher state,
  auth, API key field, the use-claude-login toggle with its personal-use note)
- the sidecar client (slim ForemanLink/State) and the launcher
- DevBridge (slim: state, camera, screenshot, key/click injection, the build/plot/design dev hooks) for headless verification
- commands: `/architect place <id> [rotation]`, `remove <site>`, `reload`, `list`
- no cheats needed; works in survival and hardcore (phase 3 adds the survival rules: until then placement is free
  in every mode, as in AgentCraft)

## Phase 1 gate (docs/PLAN.md)

In a fresh dev world (DevBridge, never a real world): generate a cabin at preset M and a tower on a marked plot
with the real Claude backend; both pass the checker, show as a ghost, place, and Remove restores the terrain
exactly. Screenshots in `artifacts/gate1/`.

---

# Phase 2 contract: the library

The parallel work for phase 2 builds against this section. Phase 1 above still holds. The gate is in docs/PLAN.md.

## Library entry (additions to `<id>.blueprint.json`)

```json
{
  "palette": { "preset": "rustic", "wood": "spruce", "stone": "cobblestone", "roof": "dark_oak", "accent": "dark_oak" },
  "params": {
    "floors": { "type": "int", "min": 1, "max": 3, "default": 1, "label": "Floors" },
    "width":  { "type": "int", "min": 7, "max": 15, "default": 9, "label": "Width" },
    "porch":  { "type": "bool", "default": true, "label": "Porch" }
  },
  "values": { "floors": 1, "width": 9, "porch": true },
  "variantOf": "gen_lakeside_cabin",
  "favorite": false,
  "userTags": ["mine"],
  "displayName": "Lakeside Cabin (birch)"
}
```

- **The kit's build writes these:**
  - `palette`: the palette the design was built with, as its inputs (preset name if any, plus wood/stone/roof/accent).
  - `params`: the design's declared parameters, exported from the source as `export const params = {...}`. Absent means none.
  - `values`: the parameter values this build used.
- **The sidecar writes:**
  - `variantOf`: the library id this entry was made from, for a variant or a remix.
- **The mod writes, editing the JSON in place:**
  - `favorite`, `userTags`, `displayName`. These three are user metadata.
  - The sidecar never touches them. The kit's build never writes them, and a rebuild keeps them.

## Parametric designs (kit + brief)

- **Signature.** A design's default export takes `{ palette, ...values }` and must build for every value in its `params`
  domain. Each `int` param has min, max and default; each `bool` param has a default; each `enum` param has `options` and a default.
- **Sizes.** Designs keep the size small enough that the defaults fit the request's maxSize. `params` bounds may reach
  past that limit. A variant that doesn't fit the requested maxSize is just a bigger building; the mod shows its size.
- **Examples.** The kit examples (cabin, tower, tavern, gatehouse) each get 2 to 4 params, e.g. floors, width/depth,
  porch on/off, roof style.
- **Brief.** The design brief asks Claude for 2 to 4 meaningful params plus palette-driven materials. Materials must come
  from `palette` fields, never hard-coded wood or stone ids, so palette swaps work. The checker warns when a design uses
  a wood or stone family that isn't from its palette (phase 2: a warning).
- **Palettes.** `kit/lib/kit.mjs` `PALETTES` grows to about 10 presets: rustic, oak, birch, dark, desert, brick, plus
  cherry, mangrove, crimson (nether-safe woods) and a stone-heavy "fortress". `palette()` validates the overrides.
- **CLI.** `node kit/build.mjs <id> --palette <preset>|<json> --values <json>` builds a variant.
  `node kit/tools/describe.mjs <id>` prints `{ params, palettes: [names + inputs] }`.

## Variants without Claude (protocol additions)

Client -> sidecar:
- `variant.request` `{ from: libraryId, palette?: string | {wood?, stone?, roof?, accent?}, values?: {..}, name?: string }`
  -> ack `{ variantId }`.

Sidecar -> client:
- `variant.upsert` `{ variant: { id: "v<n>", from, status: queued|building|done|failed, step, blueprintId?, size?, error?, createdAt, updatedAt } }`
- Also in `snapshot.variants[]` (the last 20 plus any unfinished).

How a variant job works:
- No Claude.
- Copy the library entry's `.mjs` into a scratch kit copy, then build it with the palette and values through the
  pristine-kit check: same child process, minimal env, `--max` = the entry's request maxSize grown to fit (no limit), `--type` = the entry's type.
- Render the previews, then install as a new library entry. Id: `<from>_<palette>`, or `_v2`, ...; never overwriting.
  The entry gets `variantOf`, keeps the original's `request`, and gets `displayName` = `"<name> (<palette>, floors 2)"`.
- One job at a time; seconds, not minutes.
- A source that throws or fails the check marks the variant `failed`, with the checker's error lines.

## Mod: library screen

**Library tab:**
- A grid of cards with the iso preview, name, type, size, a favourite star, and a variant badge.
- Filters: type, user tag, favourites only, and text search over name/tags/description.
- Sort: newest, name, size.

Detail panel for the selected card:
- previews: iso, top, front, cutaway if present
- description, materials, size, and where it came from (generated request, variant of X, imported, bundled)
- actions: Place, Place on the plot, Rename, Tags, Favourite, Delete (to the trash, as now), Export, Remix…, Variants…

**Variants…:**
- A palette picker (preset chips, plus advanced wood/stone/roof/accent dropdowns from the kit's lists).
- Controls generated from `params` (int stepper, bool toggle, enum chips).
- "Make variant" sends `variant.request`.
- Progress and the result show in the Designs tab, which now lists variants too.

**Remix…** opens the Design tab prefilled from the entry's request, with `remix` set and an empty notes field
for "what to change". It's the existing remix path, so it uses Claude.

**Import / export:**
- Export writes `<id>.nbt` and `<id>.blueprint.json` to `<gameDir>/architect/exports/<id>/`. It also copies the `.nbt` into the
  current world's `generated/<namespace>/structures/` as `architect_mc:<id>`, so a vanilla structure block can load it.
- Import:
  - The Library's "Import…" lists `.nbt` files in `<gameDir>/architect/imports/`, in `<gameDir>/architect/exports/` (so an export imports into another world), and in the current world's
    `generated/*/structure/` (structure-block saves; 26.3 uses singular `structure/`, legacy `structures/` too).
  - Picking one creates a library entry: type `custom`, groundY 1, front south, entrance at the front centre, and spawn 2 out.
  - It is checked with the `custom` profile through the sidecar (`import.request {path}` -> reuses the variant pipeline:
    a check, previews, install with `"imported": true`). No source, so no variants: the Variants button is disabled for it.
  - A palette re-skin of imports is out of scope.

## Phase 2 gate (PLAN.md)

All in a fresh dev world, through the UI (DevBridge):
- Generate one design with Claude.
- Make 3 variants of it without a Claude call: 2 palettes and 1 param change (e.g. floors).
- Place a variant and remove it.
- Export one entry, and import it in a second world (a structure-block save round trip).
- Favourite, tag, rename and delete all work and survive a game restart.

Screenshots go in `artifacts/gate2/`, and gate-verifier checks the result.

---

# Phase 3 contract: survival

The parallel work builds against this section. Phases 1-2 above still hold.

## The toggle

- Per world: `<world>/architect-world.json` `{ "survival": bool }`.
- Default at the first load: on for survival and hardcore worlds, off for creative.
- Changing it needs permission level 2 (cheats/op). The Status tab shows it, and so does `/architect survival on|off`.
- **Off**: everything as in phases 1-2 (instant placement, snapshot Remove).
- **On**: Place creates a construction site.
- A player in creative mode in a survival world can finish a site instantly with `/architect site finish <id>`, which needs permission 2.

## Decision: terrain in survival (changes the PLAN.md phase 3 bullet)

Clearing a site's terrain gives **no drops**, and Remove **restores the snapshot exactly**, as in creative. The PLAN
bullet had cleared terrain drop as items and Remove keep the ground flat. That trade loses exact Remove, which is the
mod's core guarantee, and either path risks duplicating items. Here the player never receives the terrain, so restoring
it creates nothing. Free clearing (trees and dirt removed without drops) is the convenience a site gives.

## Lifecycle of a construction site

1. **Place in survival.**
   - It runs the same checks and snapshot as phases 1-2.
   - The snapshot is taken first, then the terrain fit **clear** step runs at once (free, no drops).
   - Nothing else is placed.
   - The `Site` record gets `state: "building"` and a **build queue**: every cell the instant placement would write (the
     template cells, foundation fill, approach path/slabs/fill), in build order.
   - A **construction crate** (`architect_mc:construction_crate`, a block with a block entity) is put at the approach's
     end, or 2 cells out from the entrance when there is no approach. It is outside the snapshot box, and its cell is
     snapshotted separately in the site record.
2. **Build order.**
   - Bottom-up by y.
   - Within a row: full blocks first, then partial blocks (slabs, stairs, panes, fences), then **attachables** (torches,
     lanterns, buttons, doors, beds, ladders, signs, carpets, flowers, anything that needs support). Attachables come only
     after their support cell is built.
   - Two-part blocks (doors, beds, tall plants) are placed as pairs.
   - Air cells in the template are not queued; the clear step handled them.
   - Block entities placed by the template are empty.
3. **Materials.**
   - Each queued cell costs its **item**: `Block.asItem()`, with these special cases:
     - a door, bed or tall plant costs one item per pair;
     - a double slab costs 2 slabs;
     - candles cost their count; sea pickles cost their count;
     - wall torches, wall signs and wall banners cost their standing item;
     - `minecraft:fire` and other blocks with no item cost nothing.
     - **Obtainability map** (`data/architect_mc/survival_items.json`), for blocks whose item can't be obtained in survival
       or that have no item:
       - `dirt_path` and `farmland` cost `dirt`; `grass_block` costs `dirt` (it is placed as grass anyway);
       - a potted plant costs `flower_pot` plus the plant;
       - creative-only blocks (spawner, budding_amethyst, reinforced_deepslate, bedrock, end_portal_frame, command
         blocks, barrier, light, structure blocks...) are **refused at placement** in survival ("this design uses
         <block>, which survival can't build"). The kit checker warns about them, as `survival:` warnings.
       - The kit approach default `dirt_path` therefore costs dirt; the gate cabin must be buildable end to end.
     - Waterlogged cells are built not waterlogged in survival (no water bucket cost); the crate screen notes it.
   - The **bill of materials** (BOM) is the sum over the queue. It is computed from the template on the server, and on the client for the
     Library ("needs: 412 spruce planks, ...").
4. **The crate.**
   - A `WorldlyContainer`. Hoppers and droppers insert from any side.
   - It accepts an item only while the site still needs it (counting equivalents), so a hopper chain never jams on junk.
   - Right-click opens the crate screen:
     - the BOM with needed / delivered / placed per item;
     - an "insert from inventory" button that moves every needed item from the player's inventory;
     - progress, and pause/resume;
     - Deconstruct.
   - Breaking the crate is refused while the site is building (unbreakable for players; it shows a message to use
     Deconstruct) and it is **explosion-immune**. Lava, `/setblock` and the like can still remove it: that's the "crate missing" case.
5. **Equivalents** (`data/architect_mc/equivalents.json`, curated, **one way only, raw to processed, at vanilla crafting
   yields**; nothing converts back and nothing skips smelting):
   - 1 log, wood or stem (stripped too) = 4 planks of that wood
   - 1 planks = 2 slabs of that wood (6 planks -> 12 slabs, the crafting yield per plank)
   - 1 stone = 1 stone bricks (the stonecutter yield); 1 cobblestone = 1 cobblestone slab×2 / stairs×1 / wall×1
     (stonecutter); likewise for other stone families a stonecutter makes
   - and similar small ones; nothing from a cheaper material to a more expensive one
   An inserted item that only an equivalent needs is converted on insert. Leftovers stay as credit in the crate.
6. **Builder.**
   - Each server tick, a building site places up to `blocksPerTick` (default 4, config 1-64) queued cells whose item is
     in the crate. Place sounds play quietly at the cell.
   - **It writes exactly what the instant placement writes:** the same `FLAGS` (no neighbour updates, so stairs, fences,
     panes and chest halves keep the template's shape), and the template's block-entity NBT, with only container
     inventories cleared (signs, banners, pots and lecterns keep their data). The gate compares every cell, BE NBT
     included, with an instant placement.
   - **Only cells in loaded chunks** progress. Never force-load a chunk.
   - A cell whose position now holds something else (a player's block or a mob) is skipped and retried later. After
     200 ticks it's reported in the crate screen as "blocked at x,y,z".
   - When the queue is empty: `state: "built"`, the crate drops its leftover items (credit too, as items) and turns into
     air, and a toast plus chat note fires. The crate cell is restored from its own snapshot.
7. **Ghost.**
   - The server syncs each building site's **remaining** cells to clients in range, through custom payloads:
     `architect_mc:site_ghost {siteId, origin, rotation, blueprintId, built: bitset}` once when a client comes in range
     or joins, then `architect_mc:site_progress {siteId, newlyBuilt: int[]}` deltas (batched per tick). Clients derive the
     remaining cells from the template plus the bitset.
   - GhostRenderer draws the remaining cells translucent; the next cells, whose items are delivered, are tinted green.
   - The ghost is kept across relogs and restarts; the state is in the site record.
8. **Remove / deconstruct in survival** (from the crate screen, the Library's Placed view, or `/architect remove`).
   - For every cell of the box:
     - if the current state equals what the site placed there **and that cell was paid for** (placed by consuming
       an item; cells placed by `/architect site finish` or by an instant placement are tracked as free), the cell's
       item is **refunded**;
     - else if the current state differs from the snapshot and is not air, it is the player's block: it **drops as an item** at the cell;
     - else nothing.
   - Then the snapshot is restored, as now.
   - Refunds plus the crate's stored items and credit drop at the crate's position as item entities, or go into the
     crate's inventory if there's room, until the player empties it. Decide which, and document.
   - **Blocks the player mined from a site are not refunded**: they already have the item. That's the no-dupe rule.
   - A container the player filled still refuses Remove (as now).
   - Move in survival is refused ("deconstruct and place again").
9. **Leaf guard and bed safety** apply as now. A bed that bed safety leaves out is not queued and not charged.

## Site record additions and where state lives

- In the site record (`architect-sites.json`, written on state changes and on world save, **never per tick**):
  - `state: "building"|"built"` (absent means built, as in phases 1-2);
  - `queue` (a compact form: indexes into the template grid plus the foundation/approach cells);
  - `crate {pos, snapshot}`;
  - `free` (a bitset of cells placed without payment).
- **The ledger lives in the crate block entity** (delivered counts and credit, next to its items), saved with its chunk
  like any container. Items and ledger can't drift apart in a crash.
- **`built` is derived from the world.** On load (and after a crash) a queued cell counts as built if the world holds
  exactly the template's state there. In memory it's a bitset; it is not persisted per tick.
- **Reconcile and the world-start check** know `building`: a half-built site is not "doesn't match its blueprint". They
  rebuild `built` from the world. A missing crate is reported ("crate missing": Deconstruct from the Library still works,
  with refunds of placed cells only).
A building site whose design changed under the same id keeps working from its pin's template fingerprint. If the template
is gone, the site can only be removed.

## UI

- **Library detail:** in a survival world, "Needs: N items" plus an expandable BOM. Place says "Place construction site".
- **Crate screen** (above). Also a HUD line while a site you placed is building and you're within 64 blocks:
  "Gate Cabin 62% · needs 40 spruce planks".
- **Status tab:** the survival toggle and its state, with the permission rule.

## DevBridge hooks

`dev.survival.set`, `dev.site.state {id}` (queue length, built count, ledger, blocked cells), `dev.crate.insert {id, items}`,
`dev.crate.open`, `dev.site.finish`, `dev.site.deconstruct`.

## Phase 3 gate

In a fresh **survival** dev world (DevBridge):
- the toggle is on by default;
- place a cabin site: the ghost is visible, and it survives a relog;
- feed it from a **hopper chain** out of chests holding exactly the BOM **as reported by `dev.site.state` after placement**
  (the template plus that spot's foundation and approach), part of it as logs (equivalents);
- watch it finish: the built site equals an instant placement of the same design at the same spot, every cell;
- mine 3 placed blocks (the player keeps the items), then deconstruct: the refund equals BOM − 3 mined, the 3 aren't
  refunded again, and the terrain is restored exactly;
- a creative world with the toggle off still places instantly;
- a hardcore world works without cheats, except the toggle change.

gate-verifier checks the result.

## Phase 3 as built (deviations, recorded 2026-10-05)

- **Identical to instant placement by construction.** Survival Place runs the unchanged instant build, settles the
  block ticks it scheduled on its own cells (dirt_path next to a solid block turns to dirt one tick later), captures
  the snapshot box into a per-site **target file**, then clears the queued cells to air in the same tick. The builder
  writes each target state and its BE NBT with the same FLAGS, stripping only container inventories. The queue indexes
  the snapshot box, not the template grid, so a site keeps working when its design changes under the same id.
- **Built status** is derived from the world by matching the block, not the full state, so a door the player opened
  still counts. World start reads it, as the existing sites check does; the builder's rescans never load chunks.
- **Ghost payloads** carry the queue cells and their state ids as well as the bitset (foundation and approach depend on
  the terrain). Extra payloads: `site_status` (HUD line, green tint), `site_clear` (and the "built" toast), `crate_open`.
- **Refunds** drop as items on the crate's cell, outside the box. A built site keeps its crate record, so later refunds
  land there. "The player's block" ignores natural changes (fluids, fire, snow, grass/dirt).
- **DevBridge hooks** take `{site}`, because `id` is the request id. Also added: `dev.items.near`, `dev.ghosts.state`, and
  `dev.command {asPlayer}`.
- **Other choices:** `blocksPerTick` lives in `architect-world.json`; `/architect site finish` needs permission 2 and creative mode;
  the Status toggle runs the command as the player; the crate sits one cell to the side of the approach's end.
- **Equivalents** are generated (`tools/gen-equivalents.mjs`, 195 rules), whole-number yields only.
- **The creative-only list** exists twice (`survival_items.json` and `kit/lib/check.mjs`), kept in sync by hand.
- **Dev worlds:** `ARCHITECT_AUTOWORLD_MODE=creative|survival|hardcore`, `ARCHITECT_AUTOWORLD_CHEATS`, and
  `ARCHITECT_DEV_HARDCORE=1` (lets the dev tool drive a hardcore world).

---

# Phase 4a contract: public API (A8 + R2, R5, R7, R11)

Reviewed by Steward (`steward-mc/docs/A8-REVIEW.md`); its items 1-6 and 8 are in, 9 is noted as Noah's call, and 7
(a composite preview with per-cell added/removed/changed) is reserved for 4c/5b.

The stable surface other mods (first: Steward, `steward_mc`) build on. **Everything outside `dev.larattalabs.architect.api`
and the documented protocol messages stays internal**, and may change without notice.

## Versioning

- **Java API:** `ArchitectApi.VERSION` (semver string, starts at `1.0.0`). A minor bump adds methods; a major bump breaks.
  A dependent mod declares `"depends": {"architect_mc": ">=0.4.0"}` in fabric.mod.json and checks
  `ArchitectApi.VERSION` at runtime if it needs a newer minor version.
- **Sidecar protocol:** an integer `protocol`, starting at `2`. Phases 1-3 are protocol 1. `hello` carries `protocols: [1, 2]` (what the
  client speaks) and the `snapshot` answers `protocol: <chosen>` and `features: [..]` (e.g. `"job.run"`, `"job.tools"`,
  `"budget"`). A protocol-1 client keeps working unchanged.
- **Build artifact:** `./gradlew publishToMavenLocal` publishes `dev.larattalabs:architect_mc:<version>` (the mod jar plus a
  sources jar). Steward compiles against it with `modImplementation` from mavenLocal. There is no separate API jar; the package boundary is the contract.

## Java API (server side, the integrated server)

Entry: `ArchitectApi.get()`, a singleton available after the mod initialised. All calls are on the server thread unless
noted. Async results use `CompletableFuture` completed on the server thread.

```java
public interface ArchitectApi {
  String VERSION = "1.1.0";   // 1.1.0: Jobs.putBlob, ToolHandler.threadSafe, Job.resultBlob/owner (see "Phase 4a mod jobs as built")
  static ArchitectApi get();

  Library library();                 // read-only view of the library (bundled + user)
  Sites sites(MinecraftServer s);    // the sites of this world
  Survey survey();                   // terrain sampling (R1/A5b section 7.1)
  SiteEvents events();               // Fabric Events (R7)
  Jobs jobs();                       // Claude jobs (R2), see "Jobs": thread-safe, callable from the server thread
  Designs designs();                 // building design requests (review 1), see "Designs"
  Set<String> features();            // review 6. STABLE names (never renamed or removed within major 1): "sites",
                                     // "events", "designs", "library", "survey", "protocol2", "jobs", "jobTools",
                                     // "blobs"; later "siteGroups", "jobGroups", "massing", "deltaApply"... Java-only ones
                                     // plus the sidecar's (prefixed as above when they come from the snapshot)
}

interface Library {
  List<Entry> list();  Optional<Entry> get(String id);  void reload();
  // writes (review 2); thread-safe, futures complete on the server thread
  CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name);
  CompletableFuture<Boolean> delete(String entryId);                 // to the trash, as the UI; bundled entries refuse
  void setExt(String entryId, String key, @Nullable JsonElement value); // namespaced key; null removes
  void setTags(String entryId, List<String> userTags);
  // remix is a design request with `remix` set: Designs.request
  record Entry(String id, String name, String type, BlockSize size, List<String> tags, Optional<String> source,
               Map<String, JsonElement> params, Map<String, JsonElement> values, Optional<JsonObject> palette,
               Map<String, Port> ports, JsonObject ext, boolean bundled, boolean imported, Optional<String> variantOf) {}
  record Port(String name, String kind, BlockPos offset, Direction facing) {}   // R5, template coordinates
}

interface Sites {
  List<SiteView> list();  List<SiteView> list(@Nullable String owner);  Optional<SiteView> get(String siteId);
  CompletableFuture<PlaceResult> place(PlaceRequest r);
  CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o);
  Verdict check(PlaceRequest r);     // dry run: what place() would do (refusals, notes, BOM, boxes), no side effects
}
record PlaceRequest(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation, Mode mode,
                    @Nullable String owner, JsonObject ext, boolean force, @Nullable ServerPlayer actor) {}
enum Mode { AUTO, INSTANT, CONSTRUCTION }  // AUTO = the world's toggle. INSTANT in a survival-toggle world needs an
                                           // `actor` with permission level 2; no actor, or one without it -> refused
                                           // NOT_ALLOWED (no free builds by an entity or a mod on its own).
record SiteView(String id, String blueprintId, String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
                Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued) {}
enum State { BUILT, BUILDING }
record PlaceResult(boolean placed, Optional<String> siteId, List<Refusal> refusals, List<String> notes) {}
record Refusal(Reason reason, String message) {}
enum Reason { PLAYER_IN_BOX, OCCUPIED, OVERLAP, LAVA, BLOCK_ENTITIES, BUILD_HEIGHT, DOOR_CUT, CREATIVE_ONLY_BLOCK,
              NOT_ALLOWED, NOT_LOADED, UNKNOWN_BLUEPRINT, OTHER }
record RemoveOptions(boolean force, String requester) {}  // removing a site owned by someone else needs force
record RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund) {}
```

- **Owner and requester are guardrails, not security.** Any mod in the same JVM can pass any string; they prevent
  accidental removal of another mod's sites, nothing more. The permission rule that matters (INSTANT in survival) is
  checked against a real `actor`.
- **Owner (R5):** a free string, by convention `<modid>:<thing>` (e.g. `steward_mc:settlement/set_ab12`); `null` = the
  player's own site. It's stored in the site record and shown in the Library's Placed view ("owned by steward_mc").
  Architect's UI asks for a second confirmation before removing an owned site. The API refuses `remove` from a
  different requester unless `force`.
- **ext (R5):** a JSON object, keys namespaced (`"steward_mc:lot": "L3"`). Stored on the site; on library entries it lives in the
  blueprint JSON's `ext`. Architect never interprets it, and builds/variants/imports keep it.
- **Ports (R5):** the kit's `bp.port(name, kind, x, y, z, facing)` writes `ports` into the blueprint JSON. Known kinds:
  `item_out`, `item_in`, `water_in`, `water_out`, `redstone_in`, `redstone_out`, `bed`, `door`, plus any `<modid>:<kind>`.
  The checker validates that a port's cell is inside the template and its facing is horizontal.

## Designs (review 1)

```java
interface Designs {
  CompletableFuture<String> request(DesignRequest r);   // -> designId once acked
  void cancel(String designId);
  Optional<Design> get(String designId);  List<Design> list(@Nullable String owner);
}
record DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize,
                     @Nullable String name, @Nullable String notes, @Nullable String remix,
                     @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
                     @Nullable String bible, @Nullable String group) {}   // bible/group reserved for 4b (ignored until then)
record Design(String id, Status status, String step, Optional<String> entryId, Cost cost, Optional<String> error, ...) {}
```
Results arrive as `DESIGN_UPDATED` / `DESIGN_DONE` events (the new library entry included, with the request's `ext`
copied into the entry). Remix = a request with `remix` set.

## Events (R7)

Fabric `Event`s on `ArchitectApi.get().events()`:
`SITE_PLACED(SiteView)`, `SITE_REMOVED(SiteView, RemoveResult)`, `SITE_MOVED(SiteView before, SiteView after)`,
`PLACE_FAILED(PlaceRequest, List<Refusal>)`, `SITE_PROGRESS(SiteView)` (construction sites, at most once per second per
site), `SITE_BUILT(SiteView)`, `DESIGN_UPDATED(Design)`, `DESIGN_DONE(Design)`, `VARIANT_DONE(Library.Entry)`,
`JOB_UPDATED(Job)`, `JOB_DONE(Job)`. All fire on the server thread. UI and commands fire them too, not only API calls.

## Survey (for Steward's site survey; A5b section 7.1; review 3 and 5)

`Survey.sample(ServerLevel, BoundingBox area, int resolution, LoadPolicy load)` returns a `CompletableFuture<Sample>`.
It is **time-sliced on the server thread** (a budget of a few ms per tick), so a big area never stalls a tick.
`LoadPolicy`:
- `LOADED_ONLY` (default): unloaded chunks are reported as missing;
- `LOAD_BOUNDED(maxChunks)`: loads at most that many chunks, then unloads what it loaded.

A `Sample` holds, per column: `height` (motion-blocking without leaves), `floor` (ocean floor), `top` (the top block's id),
`slope` (max height difference to the 4 neighbours), and masks for `water`, `tree` (logs and leaves above ground) and
`natural` (the column's top is natural terrain, nothing built). Also `biome` per 4x4. Resolution is 1 up to 256x256,
else 4.

**A survey never goes to the model whole** (a 256x256 sample is far past any context and the 256 KB tool limit). It
goes to the sidecar as a **blob** (see Jobs), and kit programs read it from the job's scratch dir. The agent gets
`Sample.summary()`: stats, a coarse ASCII height grid (at most 64x64) and the blob handle.

## Client side

`ArchitectClientApi.get()` (client thread):
- `preview(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style)` shows a locked ghost with the HUD verdict
  until `clearPreview()`. It's the placement ghost without the keys.

## Jobs, Java side (common: callable from the server thread)

```java
interface Jobs {
  CompletableFuture<String> run(JobSpec spec);           // -> jobId once acked; completes on the server thread
  void cancel(String jobId);
  Optional<Job> get(String jobId);  List<Job> list(@Nullable String owner);   // includes jobs finished while you were away
  void registerTool(String owner, String name, ToolHandler h);  // global per (owner, tool name), NOT per run
  boolean available();                                   // false: no sidecar link (helper not running / no client)
  // 1.1.0
  CompletableFuture<String> putBlob(String kind, @Nullable String owner, JsonElement data);  // -> blobId
  CompletableFuture<String> putBlob(String kind, @Nullable String owner, byte[] data);       // 1 MB chunks
}
@FunctionalInterface interface ToolHandler {
  CompletableFuture<JsonElement> call(String jobId, JsonObject input);
  default boolean threadSafe() { return false; }         // 1.1.0: a readOnly tool's handler may then run on a worker
  static ToolHandler threadSafe(ToolHandler h);          // 1.1.0: wraps a lambda as thread-safe
}
```
- **Tool handlers are registered globally** by owner and tool name, at mod init. A job that resumes after a restart
  re-sends its pending tool call, and the handler registered in the new JVM answers it. A per-run closure would have
  died with the old process. No handler registered -> the agent gets the error "no handler for <tool> in this game".
- Calls are thread-safe. The mod forwards them to its one sidecar link, which lives on the client side of the same
  singleplayer process. Futures and tool handlers run on the server thread.
- Events: `JOB_UPDATED(Job)` and `JOB_DONE(Job)` on `events()`, so a mod sees results that finished while it wasn't listening
  (and `list(owner)` after a world load).

## Jobs (R2): protocol 2

Client -> sidecar:
- `job.run { job: JobSpec }` -> ack `{ jobId }`
  ```
  JobSpec = { kind: "structured" | "agent",
              prompt: string, system?: string,
              model?: string (default "claude-sonnet-5-5"; designs keep their own default), effort?: low|medium|high|xhigh,
              schema?: JSONSchema            (structured: the final answer must validate; one retry on a schema miss)
              tools?: [{ name, description, inputSchema }]   (mod-provided tools, see below)
              budgetUsd?: number             (hard stop, enforced by the sidecar)
              maxTurns?: number, owner?: string, tag?: string, group?: string, ext?: object }
  ```
  **Both kinds run through the Claude Agent SDK** (`query()`), never the raw Messages API: the opt-in claude-login mode
  authenticates only through the SDK/CLI, so a direct API path would silently fail for login users.
  - `structured` uses the SDK's native `outputFormat: {type: 'json_schema', schema}`. The result is the result message's
    `structured_output`, validated again by the sidecar. The SDK's own retries end in `error_max_structured_output_retries`,
    which means failed. Built-in tools are off (`tools: []`) and `maxTurns` is small.
  - `agent` is multi-turn with ONLY the mod-provided tools (an in-process MCP server built from `tools`, plus
    `job_status` for progress). Built-in tools are off at the source (`tools: []`): no file system, no Bash, no web. The
    refuse-by-default permission policy is the second line of defence, not the first.
- `job.cancel { jobId }`
- `blob.put { blobId?, kind, owner?, data | chunks }` -> ack `{ blobId }`. A blob is JSON or binary (base64 chunks of at
  most 1 MB each), up to 64 MB. It's stored in `<data>/blobs/<id>`, kept 7 days or until `blob.delete`. A JobSpec lists
  `blobs: [blobId]`, and the sidecar copies them into the job's scratch dir as `blobs/<id>.<ext>`, where kit programs and
  scripts read them. The model sees only names and the summaries the client passes in the prompt.
- `job.tool.result { jobId, callId, result?: any, error?: string }`

Sidecar -> client:
- `job.upsert { job: Job }`, and `snapshot.jobs[]` (the last 20 plus any unfinished)
  ```
  Job = { id: "j<n>", spec (without the prompt text past 2000 chars), status: queued|running|waiting_tool|held|done|failed|cancelled,
          step, result?: any (structured: the validated JSON; agent: the final text plus an optional JSON),
          error?, cost: { usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns },
          createdAt, updatedAt }
  ```
- `job.event { jobId, kind: "text" | "step" | "tool", data }`: streamed progress, not persisted.
- `job.tool.call { jobId, callId, name, input }`: the agent called a mod-provided tool. The client answers with
  `job.tool.result`. The answer must be JSON, at most 256 KB; anything bigger goes in a blob and the result names it.
  While waiting, the job's status is `waiting_tool`.
  - **Timeout:** per tool, `timeoutMs` in the tool spec, default 60 s. **The clock pauses while the game is paused**:
    the mod sends `client.paused {paused}` when singleplayer pauses or resumes, and the sidecar doesn't count paused
    time.
  - A tool may declare `readOnly: true`. The mod then runs its handler off the server thread (on a worker) when the
    handler says it's thread-safe. Everything else runs on the server thread, which only advances while the game runs;
    the paused clock covers that.

Other job rules:
- **Budget (hard stop):** the sidecar passes `budgetUsd` as the SDK's `maxBudgetUsd`. The SDK ends the run with
  `error_max_budget_usd`, and the job fails with `error: "budget"`, keeping the cost so far. The sidecar also checks the
  cumulative `total_cost_usd` after each result, because `maxBudgetUsd` counts only since the current `query()` and a
  resumed job must count its earlier spend too. **Cost is the SDK's estimate**, not a billing statement. Under the
  claude-login mode it's notional (plan usage, not dollars), and the budget still applies to that estimate.
- **Resume after restart:** jobs persist in the sidecar's state (prompt, session id, cost). An unfinished job resumes on
  the next start (the SDK session resume). A pending tool call is re-sent when the client reconnects.
- **Usage limits:** a job is `held` with `usageLimitUntil`, as designs are. Groups (4b) hold together.
- **Concurrency:** structured jobs run up to 4 at once (config `jobConcurrency`). Agent jobs share the design queue's limit
  until 4b brings job groups.
- **Design requests gain** optional `owner`, `ext`, `model`, `budgetUsd` (the same meaning as for jobs) and report `cost` with
  cache tokens.

## DevBridge for other mods (R11)

`tools/lib/devclient.mjs` is importable by path. Ports come from `ARCHITECT_DEV_PORT` (and the client's `ARCHITECT_PORT`),
and the token from `<gameDir>/architect/devbridge.token`. `docs/DEVBRIDGE.md` (new) lists the `dev.*` hooks, with their
arguments and results, as a semi-stable test surface: changes are noted in its changelog, but it isn't semver'd.

## Phase 4a gate

- **Publishing:** `publishToMavenLocal` now. A public Maven (GitHub Packages on a release tag, or Modrinth Maven) is wanted
  for Steward's public CI, but publishing is Noah's call; it's not part of this gate.
- An in-repo test mod `apitest/` (a Gradle subproject, dev only, **never in the shipped jar or the sidecar bundle**) depends only on
  `dev.larattalabs.architect.api`. In a dev world it:
  - places a site through the API with an owner and ext, and gets SITE_PLACED;
  - is refused with typed reasons (PLAYER_IN_BOX, OVERLAP);
  - in a survival world, gets SITE_PROGRESS and SITE_BUILT;
  - removes the site (refused without force from another requester; RemoveResult with the refund in survival);
  - samples a survey;
  - shows a client preview.
- **Jobs, without Claude** (the sim backend):
  - run, events, cancel;
  - a tool round trip;
  - **a tool call across a paused game** (pause > 60 s mid-call, unpause, and the job completes);
  - **a blob handle** (a survey uploaded as a blob, read by a kit script in the job's scratch dir);
  - resume after a sidecar restart;
  - a budget stop (the sim reports a cost).
- **Designs and the library through the API:** a design request round trip (sim backend) with owner and ext, landing on the
  new entry; a variant through `Library.makeVariant`; setExt and setTags; delete.
- **Jobs, with Claude, once:** a `structured` job with a schema (a concept-card-like parse) and an `agent` job that
  calls one mod-provided tool. Cheap model, small budget. The cost report includes cache tokens.
- A protocol-1 client (today's mod build, or the stub) still works against the new sidecar.
- gate-verifier checks the result.

## Phase 4a sidecar as built (protocol 2, recorded 2026-10-05)

- **Negotiation:** `hello {client, version, token, protocols}`. No `protocols` means 1; no common protocol means `error` and close
  code 4002. Protocol-1 clients get exactly the phase 1-3 messages (filtered by `toProtocol1`).
- **Snapshot features from the sidecar:** `job.run`, `job.tools`, `blobs`, `budget`, `designs.v2`. The Java `features()` maps them
  to its stable names (`jobs`, `jobTools`, `blobs`, `protocol2`, ...).
- **Budget:** `maxBudgetUsd` passes the REMAINING budget to each `query()`, since the SDK counts per query. A query cut short by a
  restart reports no cost, so the budget can overshoot by that query's spend (documented).
- **Additions:**
  - `job.tool.call` carries `owner` and `timeoutMs`;
  - `Job` carries `resultBlob` (when the result is over 256 KB) and `usageLimitUntil`;
  - `blob.put` takes `ext` and `more` (multi-frame uploads);
  - frames are at most 16 MB (close 1009 above).
- **Tool-call re-send** is matched by the hello `client` name (the mod sends `"mod"`), not by owner. The same `callId` can arrive
  again after a reconnect or restart, so the client re-sends a cached answer. `ok:false` "no pending tool call" means drop it.
- **Job results:** structured gives the validated JSON; agent gives `{text, json?}`. A structured schema miss gets one re-ask in the
  same session. Agent jobs and designs share one slot; structured jobs run up to `jobConcurrency` (4).
- **Verified on real Claude (2026-10-05, Noah's login, Sonnet 5.5 low):**
  - Structured jobs with `tools: []` return `structured_output` against Steward's concept-card schema (nullable types,
    minLength/maxLength/maxItems accepted), 2 turns, $0.011-0.019. The second job read the prompt cache.
  - An agent job calls a client tool and finishes in 2 turns for $0.007.
  - A sidecar SIGKILLed while waiting on a tool call restarts, re-sends the same `callId` to the reconnecting client (matched by
    the client name), resumes the session with the answer and finishes. The reported cost then covers only the post-restart
    query (the documented overshoot).

## Phase 4a mod jobs as built (Java side, API 1.1.0, recorded 2026-10-05)

- **API 1.1.0 (minor):** `Jobs.putBlob(String kind, @Nullable String owner, JsonElement data)` and
  `Jobs.putBlob(String kind, @Nullable String owner, byte[] data)` -> `CompletableFuture<String>` (the blob id, on the server
  thread); `ToolHandler.threadSafe()` (default false) and `static ToolHandler.threadSafe(ToolHandler)`; `Job` gains the
  component `Optional<String> resultBlob` (the 1.0.0 nine-argument constructor is kept) and `Optional<String> owner()`.
  Not purely additive for `Job`: a record pattern with nine components no longer compiles, and equals/hashCode/toString
  include `resultBlob` (no known caller deconstructs `Job`; Steward only reads it).
  `features()` already mapped the sidecar's `blobs`.
- **available()** = the link is synced, the sidecar chose protocol 2 and lists `job.run`. Against a protocol-1 helper `run()`
  fails with "jobs need protocol 2; this helper speaks protocol 1".
- **Jobs and events:** `snapshot.jobs` is merged with what the mod already knows (a snapshot holds only the last 20 plus the
  unfinished ones), and `job.upsert` updates it. `JOB_UPDATED` fires when status, step, cost or `updatedAt` changed since the
  last one; `JOB_DONE` fires once per job (`id@createdAt`), and that set is kept in `<gameDir>/architect/api-jobs.json`, so a
  reconnect's snapshot, a sidecar restart or a game restart never fires it again. A job that finished while no world was
  loaded fires when the next world has started. A job whose result came as `resultBlob` gets it read back from
  `<sidecar data>/blobs/<id>` into `result` before `JOB_DONE` (if that read fails, `result` stays empty and `resultBlob`
  names it).
- **Tool calls:** the handler of (`owner` from the call, else the job's spec owner; `name`). It runs on the server thread, or
  on a worker ("Architect-ToolWorker") when the job's spec marks the tool `readOnly` AND the handler is `threadSafe()`.
  - Answers are cached per `callId` (the newest 512) before they are sent. A re-sent call gets the cached answer, and one
    re-sent while its handler still runs waits for it; the handler never runs twice.
  - An answer whose JSON is over 254 KB (256 KB less some headroom for `JSON.stringify` differences) goes as a `tool.result`
    blob, and the result is `{blob, kind: "tool.result", bytes, note}`. A sidecar `ok:false` that says the result is too
    big triggers the same fallback.
  - `ok:false` with "no pending tool call" (the job was cancelled, or the call timed out) is dropped with an info log line.
  - With no handler, the answer is the error "no handler for <tool> in this game". With no world running, or a server that
    is stopping, it is an error that says so. A handler that throws or fails gives the agent its message (at most 10 000
    chars).
- **The paused clock in practice:** the integrated server still runs queued tasks while the game is paused, so a server-
  thread handler that answers at once is not held up by a pause. Only work that waits for ticks (or anything else that
  stops while paused) is, and the sidecar's paused clock covers that. apitest's `tickwait` tool shows it: a call with a
  10 s timeout survives a 15 s pause.
- **blob.put from Java:** a JSON blob up to 12 MB goes whole (`data`); a bigger one goes as UTF-8 chunks with `ext: "json"`.
  A binary blob goes as base64 chunks of 1 MB, with at most 12 MB of base64 per frame (so under 16 MB). The frames are sent
  one after another with `more: true` and the blob id from the first ack. Above 64 MB, the upload is refused before
  sending.
- **Designs and variants (fixes):**
  - `Library.makeVariant` futures time out after 2 minutes. They fail when the link drops, and they complete even when the
    variant finished before its ack was processed: the outcome is kept for a minute for a late registration.
  - `Designs.request` completes at the ack. Its 10-minute timeout is a backstop, because the link's 20 s ack timeout and a
    dropped link already fail it.
  - Both timeouts are configurable: `-Darchitect.api.variantTimeoutMs` / `ARCHITECT_API_VARIANT_TIMEOUT_MS` and
    `-Darchitect.api.designTimeoutMs` / `ARCHITECT_API_DESIGN_TIMEOUT_MS`.
  - Designs and variants that finished while no world was loaded fire `DESIGN_DONE` / `VARIANT_DONE` once the next world
    has started.
- **Dev/test:** `ARCHITECT_SIDECAR_BACKEND=sim|claude` makes the launcher pass `--backend` to a sidecar it starts
  (`tools/run-apitest-client.sh --sim`). New DevBridge hooks `dev.world.leave` / `dev.world.open` (docs/DEVBRIDGE.md).
- **Verified without Claude** (`tools/apitest.mjs jobs` and `catchup`, the real sidecar's sim backend started by the launcher):
  - a structured job, and an agent job: the survey summary tool on the server thread, a `readOnly` + thread-safe tool on a
    worker, a `readOnly` tool that is not thread-safe on the server thread, a missing handler, a 310 KB answer as a blob;
  - a tool call across a 15 s pause with a 10 s timeout;
  - cancel, with the late answer dropped;
  - a budget stop at $0.02 of $0.015;
  - a 2.5 MB binary blob (3 frames) and a survey JSON blob put from Java and found in a job's scratch dir, the SHA-256
    matching;
  - the sidecar SIGKILLed mid tool call and restarted by the launcher: the handler ran once and the cached answer was
    re-sent;
  - every JOB_ event on the server thread, DONE once per job across reruns;
  - designs and variants finished on the title screen fire DONE when the world loads.

---

# Phase 4b contract: style bibles and design groups (A1 + A2, R3, R4, R9, R10) - DRAFT for Steward review

Goal: **many separately generated buildings read as one place**, and N of them design in about the wall time of one.

## Style bible (A1)

A bible is an artifact, separate from library entries: `<gameDir>/architect/bibles/<id>/`.

| file | what |
|---|---|
| `bible.json` | the structured bible (schema below), versioned (`version` increments on every revision) |
| `bible.md` | prose for designers: mood, silhouette, what each material means, do and don't |
| `components.mjs` | the bible's component library (R3), a kit module |
| `sheet.png` | a rendered sample sheet: each component plus a wall/roof swatch, for review |

`bible.json`:
```json
{ "id": "bib_ashfall", "name": "Ashfall", "version": 3, "prompt": "hellish evil lair, mining facility",
  "roles": { "wall": "minecraft:blackstone", "wall_alt": "minecraft:polished_blackstone_bricks", "trim": "minecraft:basalt",
             "roof": "minecraft:deepslate_tiles", "floor": "minecraft:polished_basalt", "frame": "minecraft:crimson_stem",
             "accent": "minecraft:crimson_planks", "light": "minecraft:shroomlight", "glass": "minecraft:red_stained_glass_pane",
             "foundation": "minecraft:blackstone", "path": "minecraft:coarse_dirt" },
  "proportions": { "storey": 4, "roofPitch": 1.0, "overhang": 1, "windowRhythm": 3, "plinth": 1 },
  "roofLanguage": "steep gable", "silhouette": "tall, narrow, spiky ridges", "motifs": ["chimney vents", "chain lanterns"],
  "tiers": { "humble": ["wall_alt","accent"], "important": ["wall","trim"] },
  "lighting": "low, warm, from below", "avoid": ["white", "bright wood"],
  "components": ["window", "door_surround", "lantern_post", "roof_trim", "chimney"],
  "createdAt": 0, "cost": { "usd": 0, "...": 0 } }
```
- **Roles generalise the kit palette.** `palette({bible})` maps every palette field to a role, and the existing presets
  become built-in bibles without prose. A design that takes materials from `palette` (the phase 2 rule) re-skins under any
  bible with no code change. **A re-skin = a variant with another bible** (free, no Claude).
- **Bible job** (`bible.request {prompt, name?, owner?, ext?, model?, budgetUsd?, references?: [libraryId]}`):
  - a structured pass (the JSON) plus an agent pass that writes `components.mjs` in a scratch kit;
  - a component check: each component builds into a test frame, passes the checker and renders the sheet;
  - Opus by default, about one design's cost;
  - `bible.upsert` progress like designs, `snapshot.bibles`.
- **Revise:** `bible.revise {id, notes}` creates version+1. Entries pin the bible version they were built with, and re-skinning
  to a newer version is a variant.

## Component library and named parts (R3)

- **Components:** `components.mjs` exports functions `(bp, at, opts)` that place a small part using the bible's roles:
  `window`, `door_surround`, `lantern_post`, `roof_trim`, `chimney` (the minimum set) plus any the bible adds. Every design in
  a group imports `bible/components.mjs` from its scratch dir and is asked to use them for those elements.
- **Named parts:** `bp.part(name, () => {...})` records which cells a part writes. The sidecar JSON gets
  `parts: { "<name>": { "box": [..], "cells": <count> } }`. Names must be unique, stable across revisions (`wing_east`,
  `tower`, `porch`), and given for every major mass. This is what A6 delta apply diffs by. The checker warns when a design
  has fewer than 2 parts or more than 20% of its cells outside any part.

## Open building types (R4)

`DesignRequest.type` may be any short string (`hellish_lair`, `mining_hall`), not only the 11 presets. For a non-preset type,
`profile` lists the checker rules from a menu: `door`, `roof_closed`, `floors_reachable`, `lit`, `no_floating`,
`interior` (required for `lit`), `min_interior_volume:<n>`, `passage:<w>x<h>`, `tall:<ratio>`. Preset types keep their
profiles. A non-preset type without a profile gets `door`, `lit` and `no_floating`.

## Design groups (A2, R9)

- **`design.group`**: `{ group: { id?, name, bible, owner?, ext?, concurrency?: 1..6 (default 3), budgetUsd?,
  items: [DesignRequest & { role?: "landmark"|"ordinary", model? }] } }` -> ack `{groupId, designIds}`.
  - The default model per role: landmark `claude-opus-5-5`, ordinary `claude-sonnet-5-5` (config).
  - Every item gets the bible (its JSON, its prose, and `components.mjs` in the scratch dir) and, after the first wave,
    renders of its finished siblings ("neighbours": iso PNGs, at most 4).
- **`group.upsert`**: `{id, status, designs: [{id, status, step}], done, failed, cost (aggregate), usageLimitUntil?}`.
- **Concurrency:** design jobs run up to `concurrency` at once. The sidecar-wide `designConcurrency` caps all groups
  (default 3); a single design still uses one slot.
- **Rate limits (R9):** a usage limit hit by any job holds the whole group, and its queued items wait. All of them resume
  together after the reset.
- **Partial results are usable:** each finished design installs as soon as it's done. A group can be cancelled; finished
  items stay.
- **Budget:** a group budget is a hard cap on the group's total. Items still queued when it's reached are cancelled with
  error "budget".

## Collections (R10)

Entries carry `bible` (id + version) and `group` (id). The Library gets a **Collection** filter (by bible or group) and a
collection header with the bible's sheet, name and a "re-skin the collection" action: N variants with another bible, free.

## API (Java, 1.2.0)

`ArchitectApi.bibles()`:
- `request(BibleRequest)`, `revise(id, notes)`, `get(id)`, `list(owner)`;
- events `BIBLE_UPDATED` / `BIBLE_DONE`.

`Designs`:
- `requestGroup(GroupRequest)` -> `CompletableFuture<String groupId>`;
- `group(id)`, `cancelGroup(id)`;
- events `GROUP_UPDATED` / `GROUP_DONE`.

`Library.makeVariant` takes an optional `bible` (the re-skin). New features: `"bibles"`, `"designGroups"`, `"namedParts"`,
`"openTypes"`.

## Phase 4b gate

- One bible from a prompt (real Claude). Its sheet renders, and its components pass their check.
- A group of 3 designs (house, tavern, tower; one landmark) with that bible, on real Claude:
  - wall time at most the sum over waves of 1.5x that wave's slowest design (anchor-first waves run in sequence, and a wave's items run in parallel; amended 2026-10-05 after the real run: 22.7 min = 12.5 for the anchor + 10.2 for the parallel second wave);
  - all 3 use the bible's components and roles;
  - each has at least 2 named parts;
  - the aggregate cost is reported.
- **"Reads as one set"** is judged by two independent `design-critic` agents on the three renders side by side plus the
  sheet. Both must say "set". A control: 3 designs of the same types WITHOUT a bible, judged the same way, should read as
  less coherent.
- **Re-skin:** the collection re-skinned to a second (built-in) bible is free and passes the checker.
- **A group-wide usage hold** (sim backend): one item hits the limit, all hold, all resume.
- **An open type** with a profile (`hellish_lair` with `door`, `lit`, `no_floating`) designs and passes.
- gate-verifier checks the result.

### 4b review folded in (Steward, `steward-mc/docs/A4B-REVIEW.md`, all accepted 2026-10-05)

1. **Addressable items:** a group item carries `itemKey` (the caller's key, unique in the group) plus `ext`. `group(id)` and
   `GROUP_DONE` return `items: [{itemKey, ext, designId, entryId?, status, cost}]`, persisted across restarts.
   `Designs.listGroups(owner)` and `Bibles.list(owner)`.
2. **Estimates:** `Designs.estimate(GroupRequest)` and `Bibles.estimate(BibleRequest)` return
   `{usdLow, usdHigh, minutesLow, minutesHigh, basis}`. They're computed from the sidecar's measured per-model averages
   (rolling, persisted, seeded with today's measurements: Opus design about $1.0-1.5 and 4-6 min; Sonnet unmeasured,
   seeded at 0.4x Opus cost), the concurrency and the current usage-limit state. Protocol: `design.estimate` / `bible.estimate`.
3. **Soft budget:** `softBudgetFraction` (default 0.8). Reaching it stops dispatching new items, and the group goes
   `paused_budget` with a reason. `Designs.extendGroup(id, budgetUsd)` and `resumeGroup(id)`. The hard budget still cancels
   at 100%.
4. **Anchor-first:** items take `wave: n` (default 1; `anchor: true` = wave 0). A wave starts when the previous wave is
   done (or failed), and later waves get the earlier waves' renders as neighbours.
5. **Open roles:** `roles` may carry extra named roles (vanilla blocks, validated). `BibleRequest.scope: "building" |
   "settlement"`; with settlement, the bible job also fills the macro roles `rock`, `surface`, `subsurface`, `rubble`, `rail`,
   `structure`, for A5b region programs.
6. **Re-skin and the sheet:** `Library.reskinCollection(bibleId, version)` returns one future plus a `RESKIN_DONE` event listing
   the new entries. The Java `Bible` record has `version`, `roles`, `prose` and `sheetPath`, so the client can show the sheet
   for approval.
7. **Seed preset:** `BibleRequest.seedPreset` starts a bible from a built-in one (the 10 palettes, plus style templates as
   they're added).
8. **Group statuses:** `queued | running | held_usage | paused_budget | done | failed | cancelled`.
9. **Limits and sharing:**
   - A group holds up to **24** items.
   - `designConcurrency` (default 3) is one pool shared round-robin across groups (fair, not FIFO by group) and single designs.
   - A bible job takes one slot.
   - Variants and re-skins don't use design slots (they're in the variant queue, seconds each).
10. **Gate additions:**
    - `ext` and `itemKey` survive a sidecar restart mid-group;
    - the estimate is within ±50% of the measured cost for the gate group, and the tolerance gets tightened as data accrues;
    - a soft-budget pause, extend and resume (sim backend).

### Steward ask (2026-10-05): read the world's survival toggle (API 1.2.0, with the 4b Java side)

`Sites.survival()` -> `SurvivalInfo { boolean enabled; int blocksPerTick; boolean mayToggle(@Nullable ServerPlayer actor); }` for the
server's world, plus a `WORLD_MODE_CHANGED(SurvivalInfo)` event (fired by the Status tab, `/architect survival` and the default at the
first load). Feature name: `"survivalInfo"`.

### 4b estimate seeds (measured 2026-10-05)

The seeded estimates were wrong by more than 2x on the first real group ($1.8-2.7 estimated, $6.68 measured). Seeds are now
measured values: an Opus design $2.0-3.2 and 8-13 min, a Sonnet design $0.8-2.5 and 4-10 min, a bible job $1.2-2.0 and 5-8 min.
For the gate group (1 Opus anchor plus 2 Sonnet) that gives $3.6-8.2 and 12-23 min; the measured $6.68 and 22.7 min fall inside.
Real samples replace the seeds per model as they accrue.

### Phase 4b mod as built (API 1.2.0, mod 0.5.0)

- **Java surface:** `ArchitectApi.bibles()` (request/revise/cancel/estimate/get/list/job/jobs), `Designs` groups (requestGroup, group,
  listGroups, cancel/extend/resumeGroup, estimate), `Library.makeVariant(..., bible[, version])`, `reskinCollection(bibleId,
  version, CollectionRef)`, `Sites.survival()`. New records: Bible, BiblePin, BibleRequest, BibleJob, Estimate, GroupRequest (Item,
  Role), Group (Item, Status), Reskin, SurvivalInfo, Library.Part and CollectionRef. Six events; features `bibles`,
  `designGroups`, `namedParts`, `openTypes`, `estimates`, `reskin`, `survivalInfo`.
- **Not purely additive** (as with `Job` in 1.1.0):
  - record patterns and equals change for `DesignRequest` and `Library.Entry` (the old constructors are kept);
  - new abstract methods on `ArchitectApi`, `Designs`, `Library` and `Sites` (a breaking change only for implementers);
  - a single `DesignRequest` with `group` set now fails, because the sidecar refuses it.
- **Completion:** `Bibles.request` / `revise` complete at the ack, with the queued job. `reskinCollection` completes when the
  re-skin is final, after the library reload. Bundled and imported entries are never re-skinned (no `.mjs`).
- **UI:** the Design tab (open type plus profile, bible picker); "Design a set…" (a landmark = anchor at size L, ordinary items at
  size M, the bible's name as style, a live estimate); sets with per-item progress in the Designs tab; a Library collection
  filter and header with re-skin; bibles in the Variants dialog. The 4b controls are hidden for a protocol-1 helper.
- **DONE events** (bible, group, re-skin) fire once each, persisted and caught up after a world load, like JOB_DONE.

---

# Phase 4c contract: massing pass (A3) and composite preview (A8 review item 7) - DRAFT for Steward review

Goal: **approve the shape cheaply before paying for detail.** A massing is a coarse volume design: masses, roof forms
and openings, no detail. Making one costs cents and takes a minute or two. The player approves it as a ghost or
redirects it with notes. The detail design then takes the approved massing as binding input.

## Kit: massing designs

- `kit/lib/massing.mjs`:
  - `m.mass(name, [x0,y0,z0,x1,y1,z1], { roof: 'gable'|'hip'|'flat'|'shed'|'none', ridge: 'x'|'z', storeys })`
  - `m.opening(name, face, at, size)`: door or major opening
  - `m.stilts(name, box, spacing)`: piles, posts
  - The masses use the bible's roles in flat form: wall, roof, foundation, and `glass` for openings, so a massing reads in
    the bible's colours. Every mass is a named part (it uses `bp.part`), and **the part names carry over to the detail
    design**.
- A massing is an ordinary blueprint with `massing: true`, its `parts`, `type` and `size`. Checker profile `massing`: size, parts
  (at least 2), no floating, entrance reachable. No light or interior rules.

## Sidecar

- `design.request { request: DesignRequest & { massing: true } }` runs a **massing job**.
  - Default model `claude-sonnet-5-5`, effort `low`, maxTurns about 20, about $0.10-0.40 and 1-3 min (seed; measured in the gate).
  - It writes `kit/designs/<id>.mjs` with massing.mjs, and the brief asks for mass names that describe function
    (`hall`, `wing_east`, `tower`, `porch`).
  - Massings install into `<gameDir>/architect/massings/<id>/`, the same files as a library entry. They don't appear in the
    library list.
- `design.request { request: DesignRequest & { fromMassing: id } }` runs the detail pass.
  - The scratch dir gets `massing/<id>.mjs` plus its renders.
  - The brief says the massing is binding: the same part names, each part's box within ±1 per face, the total size within ±2,
    and the same roof forms. Detail goes inside and on the masses.
  - The re-check adds the **massing conformance** rule: a warning in 4c (per the phase 1 rule), promoted once real runs
    pass it.
- `massing.redirect { massingId, notes }` makes a new massing (version +1) from the old one plus notes. It's cheap.
- **Groups:** `design.group { group: { ..., massingFirst: true } }`.
  - All items get massings first, in waves like designs.
  - Then the group goes `awaiting_approval`.
  - `group.approve { groupId, approve: [itemKey], redirect: { itemKey: notes } }` approves some items (their detail passes start)
    and redirects others (new massing versions). The group finishes when every item is detailed or cancelled.
- **Estimates:** a `massing` kind joins the rolling averages, and a group with `massingFirst` estimates both passes.

## Java API (1.3.0)

- `DesignRequest.massing(boolean)` / `fromMassing(String)`.
- `Designs.massing(id)`, `redirectMassing(id, notes)`, `approveGroup(groupId, approve, redirect)`.
- Events `MASSING_DONE` and `GROUP_AWAITING_APPROVAL`.
- **Composite preview** (`ArchitectClientApi`), for massing and delta ghosts (5b) and Steward's site plans:
  ```java
  void previewComposite(String key, List<PreviewLayer> layers);   // replaces the layers under `key`
  void clearComposite(String key);
  record PreviewLayer(String blueprintId /* or massing id */, BlockPos origin, Rotation rotation, PreviewStyle style,
                      @Nullable Set<BlockPos> onlyCells /* null = all */) {}
  enum PreviewStyle { GHOST, MASSING, ADDED, REMOVED, CHANGED }    // distinct tints; REMOVED draws red outlines
  ```
  Several layers, and several keys, at once. Steward shows a whole settlement's massings and lot outlines this way.
  Without a HUD verdict per layer, so it's a preview only; placement still goes one site at a time (until 4d batches).
- Features: `"massing"`, `"compositePreview"`.

## UI

- **Design tab:** a "Massing first" toggle (default on for L and plot sizes). When the massing is done, it shows as a ghost at the
  player's look target, with an **Approve** / **Redirect…** (notes) / **Cancel** bar.
- **Set dialog:** "Massing first" (default on). An awaiting-approval set shows all its massings at once as a composite preview
  in a row (or at a plot), with per-item Approve / Redirect.

## Phase 4c gate

- **One real massing** (tavern, preset L): cost at most $0.40, at most 3 min; its parts at least 3; looks right.
- **A redirect** ("make it L-shaped with a tower at the corner") gives a visibly different massing with a new part.
- **Detail from the approved massing** (real): the same part names; every part's box within ±1 per face; size within ±2.
  Report the conformance warning count, which should be 0.
- **A set of 3 with massingFirst** (sim): awaiting_approval; approve 2, redirect 1; the redirected item gets a new massing, then
  approval; all 3 detailed.
- **The composite preview** shows MASSING, ADDED, REMOVED and CHANGED tints at once, in a screenshot that has been looked at.
- **Estimates** include the massing pass.
- gate-verifier checks the result.

### 4c review folded in (Steward, `steward-mc/docs/A4C-REVIEW.md`, all accepted 2026-10-05)

1. **Who approves:** `GroupRequest.approvalUi: "architect" | "owner"` (default `architect`). With `owner`, Architect shows no
   Approve/Redirect bar. It emits `GROUP_AWAITING_APPROVAL` (with the owner) and accepts `approveGroup` from that owner only.
2. **Massing records and lifecycle:** `Massing { id, version, itemKey?, ext, owner?, group?, bible pin, parts, size, request,
   cost, createdAt }`, and `Designs.listMassings(owner)`, `massing(id[, version])`, `deleteMassing(id)`. `ext` round-trips across a
   sidecar restart. **Garbage collection:**
   - a group's massings are deleted 7 days after the group is final;
   - a stand-alone massing is deleted 7 days after its detail design finishes, or 30 days after creation if it's never detailed;
   - `deleteMassing` is immediate.
   Protocol: `massing.list` / `massing.delete`, and `snapshot.massings` (unfinished ones, plus the last 20).
3. **The size cap binds:** the massing job stays inside `request.maxSize`, and the detail pass's size is at most
   `min(massing size + 2, request.maxSize)` per axis. Both are errors, not warnings.
4. **Group context:** `GroupRequest.context` (text up to 4000 chars, or JSON: concept-card summary, site/purpose, neighbour lot
   rectangles and street side) goes into every item's brief, for massing and detail.
5. **Budget:** massings and redirects count toward the group's aggregate cost and its soft/hard budget. Redirect rounds are capped
   per item (`maxRedirects`, default 3); `item.rounds` reports them.
6. **Composite preview at scale:**
   - at most 200,000 cells per key;
   - layers past the cap, or further than 160 blocks, draw as box outlines;
   - composites clear on world leave;
   - **client-only:** a server-side mod sends its layers over its own packet and calls `previewComposite` on the client.
7. **Auto-approve** needs no change (the owner calls `approveGroup` on the event).

### Phase 4c as built (API 1.3.0, mod 0.6.0)

- **Sidecar wire** (full text in `sidecar/README.md` "Phase 4c"):
  - massing acks are `{designId, massingId, version}`; a detail ack is `{designId, massing}`;
  - `massing.upsert` / `massing.removed`;
  - `group.approve` also takes `cancel[]`;
  - `GroupItem.stage` is massing|approval|detail. An item awaiting approval has status `done` with stage `approval`.
  - `massing.delete` acks a count.
  - Only conformance ERRORS (the size cap) fail a detail round; issues stay warnings on `Design.conformance`. Fixed in 487a5f3: the first build failed on issues too.
- **Java:**
  - `Designs.massing(id[, version])` answers from a persisted book: the latest version of every massing is fetched on each connect, and a pinned version is known only if this game saw it.
  - `approveGroup` / `redirectMassing` have owner overloads; the forms without an owner are refused for approvalUi owner groups.
  - MASSING_DONE fires once per installed version. GROUP_AWAITING_APPROVAL fires again only for a newly awaiting massing version (after a redirect).
  - **Not purely additive:** new record components, `Group.Status.AWAITING_APPROVAL` inserted before DONE (ordinals shift), new `PreviewStyle` constants (exhaustive switches break).
- **Composite preview:**
  - `onlyCells` is in template coordinates (unrotated);
  - a library entry wins over a massing with the same id, and `id@version` names a version;
  - a 200k-cell key costs 5-7 ms of CPU per frame (vertex streaming).
- **UI:** a Design-tab review bar (Enter approves, R redirects, Esc dismisses and keeps the massing); a set's massings stand in a row with a numbered legend; the Designs tab shows item stages, rounds and conformance.

---

# Phase 4d contract: batch placement, site groups, stages (A7, R1 minimum, R6, R7 queue) - FROZEN after Steward review

Goal: place a whole set (8-20+ buildings, roads later) **over ticks, near the player, without lag spikes**, surviving relogs,
with **one undo** for the group and **stages** that can be approved, skipped, reordered and undone. This phase stays on the
current box-snapshot backend; 4e swaps the backend for the journal underneath without changing this API.

## Ticked placement (instant mode)

- Today an instant placement writes everything in one tick. In 4d it becomes a **placement job**:
  1. checks plus the snapshot, as now;
  2. the cell list (template cells, foundation fill, clears, approach) is precomputed in the same order the atomic path
     writes;
  3. cells are written over ticks with the same FLAGS, under a **per-tick time budget** (default 4 ms of server time per tick
     across all jobs; config `placementBudgetMs`, 1-20);
  4. leaf hold, bed safety and the block-entity NBT are applied exactly as in the atomic path.
- The result **must equal the atomic placement cell for cell, BE NBT included**. That's the gate's acceptance bar. A small site
  (under one tick's budget) still completes in one tick.
- While placing, the site is `placing`, and its ghost shows progress. A crash or relog mid-job resumes from the persisted cursor
  (`<world>/architect-queue.json`), because the snapshot was written first. Remove during `placing` cancels the job and restores.
- **Construction sites** (survival) already build over ticks. Their builder adopts the same time budget.

## The placement queue (R7)

- `Sites.queue(Batch)` -> `batchId`. `Batch { id?, owner, ext, group?, items: [PlaceRequest & {itemKey, stage?, after?: [itemKey]}],
  waitPolicy }`.
- **Order:** by stage, then by `after` dependencies, then by list order.
- **Waiting instead of refusing:** an item whose site is blocked by something temporary waits and re-checks every 20 ticks. That
  covers a player in or next to the box, mobs that would refuse, and unloaded chunks. Blockers that won't go away refuse the item
  with a typed reason (lava, block entities, overlap, build height, a door cut, creative-only blocks). `waitPolicy` sets the
  maximum wait (default 10 min), and an item that waits that long fails with its reason. The batch goes on with the other items
  unless `stopOnFailure`.
- **Chunks:** an item proceeds only when every chunk its snapshot box touches is loaded. Default `LOADED_ONLY` (it waits for the
  player to come near); `LOAD_BOUNDED(n)` adds short-lived tickets for at most n chunks at a time.
- **Persistence:** the queue survives relogs and restarts (`<world>/architect-queue.json`).
- **Events:** `BATCH_PROGRESS` (at most 1/s), `ITEM_PLACED` / `ITEM_FAILED` (with the reason) / `ITEM_WAITING` (with the reason),
  and `BATCH_DONE`.

## Site groups and undo (R1 minimum)

- A **site group**: `{id, owner, ext, sites[], stages[], state}`, recorded in `<world>/architect-sites.json` next to the sites. A batch
  with `group` adds its sites to it. Group membership is visible in the Library's Placed view and in `SiteView.group`.
- `Sites.removeGroup(groupId, options)` removes all its sites **in reverse placement order**, ticked under the same budget, and
  completes when all are restored. Survival groups deconstruct with refunds.
- **Overlap is still refused in 4d.** 4e's journal makes it legal.

## Stages (Steward A5B-SPEC §6a)

- `stages: [{name, items: [itemKey]}]`, ordered, on the batch or group. Each stage is a unit with its own state: `planned |
  approved | placing | placed | partial | skipped | undone`.
- `Sites.approveStage(group, name)`, `skipStage`, `reorderStages(group, [names])` (planned stages only), and `undoStage(group,
  name)`, which removes that stage's sites in reverse order. **Undoing a stage that later placed stages depend on is refused**
  unless `force`. In 4d the dependency is "a later stage is placed".
- `autoApprove: true` places stages as they come.
- Events `STAGE_STATE(group, stage, state)`.

## Group crate and stockpile (R6)

- In survival, a batch with `group` may set `sharedCrate: true`. One crate (at the first site's approach end, or at
  `crateAt`) feeds every construction site of the group, item by item, in placement order. The ledger is per group.
- `Sites.stock(groupId)` returns delivered, credit and the outstanding BOM per site and in total. Deconstruct refunds go to the
  shared crate's cell.

## Shared cell lists

- Repeated placements of the same blueprint and rotation reuse one cached cell list (TemplateGrid plus the ordered write list).
  The terrain-dependent parts (foundation, approach) stay per site.

## Java API (1.4.0)

- `Sites`: `queue(Batch)`, `batch(id)`, `cancelBatch(id)`, `groups(owner)`, `group(id)`, `removeGroup(id, RemoveOptions)`,
  `approveStage`, `skipStage`, `reorderStages`, `undoStage`, `stock(groupId)`.
- New records: Batch, BatchView, SiteGroup, Stage, Stock.
- `SiteView` gains `group` and `state` (`PLACING`).
- New events, and features `"batchPlacement"`, `"siteGroups"`, `"stages"`, `"groupCrate"`.

## Phase 4d gate

- **Equality:** a batch of 12 lots (the 4 kit examples, 3 each, on varied terrain) placed via the queue gives a world identical
  to placing them atomically one by one, every cell plus BE NBT, compared region by region in two copies of the same world.
- **Ticks:** no server tick over 50 ms during the batch; record the MSPT max and mean and the per-tick budget used.
- **Relog mid-batch** resumes, and the final result is still identical.
- **Waiting:** a lot with the player standing in it waits, then places when the player leaves. A lot in unloaded chunks waits until
  the player walks near.
- **Group undo:** removing the group restores the whole region exactly (box + 7), in reverse order.
- **Stages:** 3 stages: approve 1, skip 2, place 3, undo 3, then undo 1, with each state change observed. Undoing 1 while 3 is
  placed is refused.
- **Survival shared crate:** 3 construction sites fed from one hopper chain, each finishes identical to instant placement, and the
  stock query matches.
- gate-verifier checks the result.

## Changes from Steward's review (steward-mc/docs/A4D-REVIEW.md), all accepted

Where this section and the text above disagree, this section wins.

### Lot fitting (MUST 1)

- `Library.Entry` gains (1.4.0) `front` (the direction the entrance faces in the unrotated template), `anchors` (named template
  cells, at least `entrance` and `spawn` when the design has them), `groundY` (the template y of the entrance's feet row, i.e. the
  ground level the design expects) and `approach` (`{length, width, extendMax}`; `extendMax` = `Approach.EXTEND`, 8).
- `Sites.fitToLot(blueprintId, BoundingBox lot, Direction streetSide, FitOptions)` -> `LotFit {origin, rotation, box,
  predictedRestoreBox, Verdict}`. It does the geometry Steward would otherwise copy:
  - **rotation** so the entrance faces `streetSide`;
  - **across the street**: the box centred on the lot's street-side span (the entrance column centred when `centreOn = ENTRANCE`,
    the default; `BOX` centres the footprint);
  - **depth**: the front face set back from the lot's street edge by `setback` (default: the approach length, so the approach ends
    on the lot edge and stays inside the lot); `approachIntoStreet: true` puts the front face on the lot edge and lets the approach
    run out into the street;
  - **y**: `lot.minY` is the ground height Steward gives; `origin.y = lot.minY - groundY`;
  - the Verdict is the normal `check()` at that origin and rotation. A footprint that doesn't fit the lot (after rotation and
    setback) refuses with the new reason `LOT_TOO_SMALL`. No placement happens; the caller passes `origin` and `rotation` into
    a `PlaceRequest` (or a batch item).

### Overlap rule (MUST 2)

- The overlap check is **restore box against restore box** (`Sites.java` `check`): the new site's snapshot box against every
  standing site's restore box, same dimension, inclusive bounds. It is **not** box+7: box+7 is only the region the gate hashes
  to prove Remove exact.
- A restore box = the template box, plus the approach strip in front of the entrance, plus one row below the lowest written
  cell. Foundation fill stays inside the footprint. So **sides and back add nothing**: two lots side by side with **any gap,
  including 0** (touching, not sharing a cell), never overlap. Only the front grows, by at most `approach.length + extendMax` rows
  (the extension only happens while the path hasn't met the ground).
- `Sites.overlapMargin(blueprintId)` -> `{front, sides: 0, back: 0}` with `front = length + extendMax` (worst case), and
  `LotFit.predictedRestoreBox` gives the box for the actual terrain. Steward's default 3-block gap is fine.
- **Approach into a street (4e):** in 4d roads aren't sites, so an approach running onto a road is ordinary terrain. In 4e, when
  a road is a site, an approach stops at the first road cell it meets (the road counts as ground; the approach writes nothing
  there) and that does not count as overlap. The 4e contract states it in full.

### Actor and mode in a persisted queue (MUST 3)

- An item persists `actor` (UUID, nullable) and its **mode resolved at queue time** (`INSTANT` or `CONSTRUCTION`), from the same
  Verdict `check()` returns. It never stores a `ServerPlayer`.
- Placement does not need the actor: INSTANT writes cells, CONSTRUCTION is fed from its crate. The actor is only attribution
  (`owner` default) and is resolved by UUID when an event wants a name. An actor who logged out or left changes nothing.
- An API caller may queue **without an actor** (`actor = null`). Then INSTANT is allowed only where an actorless INSTANT is
  allowed: a creative world, or a world whose survival toggle is off. Elsewhere `queue` refuses the item with `NOT_ALLOWED`.
  That is Steward's Patron mode.
- If the world's survival toggle is switched on while INSTANT items are still queued, those items are **not converted**: each
  fails with `NOT_ALLOWED` ("survival was switched on after this was queued"); the caller re-queues them. The reverse (toggle off,
  CONSTRUCTION queued) keeps them as construction sites.

### Mapping back to lots (SHOULD 4)

- `SiteView` gains `batchId` and `itemKey` (both nullable), and a site's `ext` is the batch `ext` merged with the item's own
  `ext` (item keys win). Every item event (`ITEM_PLACED/FAILED/WAITING`) carries `batchId`, `itemKey` and that merged `ext`. All
  of it survives restarts.

### Proximity ordering (SHOULD 5)

- `Batch.proximityFirst` (default `true` with `LOADED_ONLY`, `false` with `LOAD_BOUNDED`): within a stage, among items whose
  `after` dependencies are met, the one nearest any player goes first; ties keep list order.

### Cancel and remove semantics (SHOULD 6)

- `cancelBatch(id)`: placed items stay placed and stay in the group; the item being placed is **rolled back** (restored from its
  snapshot, exact, as Remove during `placing`); items not started are dropped, each with `ITEM_FAILED(reason CANCELLED)`; then
  `BATCH_DONE(cancelled)`. The group remains.
- `removeGroup` while a batch of that group is still running: cancels that batch first (as above), then removes every placed site
  in reverse placement order.
- New Reason values: `CANCELLED`, `LOT_TOO_SMALL`, `TIMED_OUT` (the wait limit).

### Throughput numbers (SHOULD 7)

- The gate records cells/s at the 4 ms default (and at 1 and 10 ms), and the wall time of the 12-lot village with the player
  standing in the middle (`LOADED_ONLY`), in `artifacts/gate4d/REPORT.md` and a machine-readable `throughput.json` for Steward's
  estimates and mega_bench.

### Growing a group (SHOULD 8)

- A `queue(Batch)` naming an existing `group` appends its sites to that group, and its stages are appended after the group's
  existing stages, in the order given. Stage names must be unique within the group (a duplicate refuses the batch). The batch
  owner must equal the group owner. `removeGroup` and stage undo cover the appended sites like the original ones.

### Gate additions

- `fitToLot` on 4 lots of each street side gives entrances facing the street, with the approach inside the lot by default and
  out in the street with `approachIntoStreet`.
- Two lots with a 0-block side gap both place; a third whose approach would cross a neighbour's front refuses `OVERLAP`.
- Relog mid-batch with the actor gone, and an actorless Patron batch in a creative world, both finish identically.
- Toggle survival on with INSTANT items queued: they fail `NOT_ALLOWED`, nothing half-placed.
- `cancelBatch` mid-item leaves that item's region exactly as before; a second batch appends a stage to an existing group and
  `removeGroup` takes both batches' sites down exactly.
- Throughput numbers recorded.
