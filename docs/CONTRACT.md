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

### Phase 4d as built (API 1.4.0, mod 0.7.0, recorded 2026-10-05)

- **Ticked placement.** `TemplateWriter` is vanilla `StructureTemplate.placeInWorld` as a resumable cursor (barrier for NBT
  cells, `setBlock` gating "placed", the edge shape update, then `updateFromNeighbourShapes` / neighbour updates per placed
  cell); `PlaceJob` then writes bed safety, foundation, clears, approach (clear, fill, path, slabs) and cut plants in the
  atomic order. Block and fluid ticks scheduled during Architect's own write slices are held back (`LevelTicksMixin`) and
  scheduled with their delays when the placement completes. Cell lists are cached per template and rotation. The site
  record is written as `placing` right after the snapshot (snapshot, record, blocks).
- **Unsliced steps** (coordinator decision): the start of a placement (checks, snapshot capture + compressed write +
  read-back, leaf ring, leaf hold) and a construction site's conversion each run in one tick. Measured on the kit buildings:
  job start max 12.3 ms, conversion max 17.0 ms; the 12-lot village at 4 ms had MSPT max 16.8 ms, the survival scenario
  24.6 ms, no tick over 50 ms anywhere. Designs near the size cap would take longer.
- **Construction items of a batch** are written over ticks like instant ones and converted into construction sites when
  their last cell is written (the atomic convert measured a 45 ms tick). A single Place outside a batch is unchanged.
- **Removal:** group and stage removal restore instant sites over ticks (`RestoreJob`); construction sites deconstruct
  atomically, one per tick. A player in a box is waited for (up to 10 min); the player's things in a box stop the removal
  with the blockers (sites already removed stay removed). Remove of a `placing` site from the UI or API rolls it back at
  once; `cancelBatch` rolls the placing item back over ticks.
- **Resume:** a clean stop writes every job's cursor (`architect-queue.json`, `clean: true`) and resumes there. After an
  unclean stop a placing job is rolled back from its snapshot and its item queued again (chunks on disk may be older than
  the file). Restore jobs start over (rewriting a snapshot is idempotent).
- **Leaf ring (a fix to exact Remove, found by this gate, affects the atomic path too):** worldgen leaves often carry a
  larger distance than their nearest log gives; any shape update next to them relaxes a whole canopy, which made Remove
  inexact over box + 7. Snapshots now carry `architect_leafRing` (leaves within 8 of the box, with their distances);
  Remove puts those distances back (no neighbour updates; cells in other standing sites are left), and restores drop the
  leaf ticks they schedule.
- **Waiting:** temporary blockers are PLAYER_IN_BOX, OCCUPIED (mobs, drops) and NOT_LOADED. An item also waits until the
  chunks of its snapshot box grown by 7 are loaded (the leaf hold and edge updates read there). While a job writes, its
  chunks hold a short-lived `architect_mc:placement` ticket. The wait limit counts game ticks (20 per re-check) across relogs.
- **Batches and stages:** one item places at a time per batch. Items without a stage form a stage named after the batch
  id, first, approved at once; a batch without `group` gets a new group (`g<n>`), so every batch has one undo. Stages place
  only when every earlier stage of the group is finished. `reorderStages` permutes the planned stages' slots only.
  `stopOnFailure` lets the item being placed finish and ends the batch STOPPED. Skipped stages' and cancelled items get
  ITEM_FAILED CANCELLED. Actorless INSTANT is allowed in a creative-default world or with the toggle off.
- **fitToLot:** an entrance-centred box that would stick out of the lot sideways is moved back inside it (the entrance as
  near the centre as the lot allows); `streetSide` NORTH = the lot's minZ edge. The approach may still extend past the lot
  edge on a slope (up to `extendMax`, while it has not met the ground); `predictedRestoreBox` shows it.
- **Shared crate:** the group's crate block entity is owned by `group:<id>`; it accepts what any building site of the group
  still needs, sites draw from it in placement order, deconstruct refunds drop at its cell, and it gives back its stock and
  goes when the group's last site is built. Without `crateAt` it goes beside the first construction item's approach end, in
  the first cell (right, then left, up to 8 out) outside every item's predicted restore box and every standing site's; none
  refuses the batch (OTHER: pass crateAt). Its delivered counts stay on the group record for `stock()`.
- **Budget:** `placementBudgetMs` lives in `architect-world.json` next to `blocksPerTick`; `/architect budget [ms]` sets it.
  The construction builder stops at the budget after its first cell per site.
- **Ghost progress:** a placing site sends the construction ghost payloads (its template cells, filled in as written).
- **MSPT:** Fabric runs END_SERVER_TICK after the server tallies its tick time, so `dev.placement.stats` times the full tick
  itself (start to after the last end-of-tick handler).
- Commands, DevBridge hooks and apitest steps: README "Controls", docs/DEVBRIDGE.md changelog. Gate evidence:
  `artifacts/gate4d/REPORT.md`, `throughput.json` (local).

# Phase 4e contract: journal-backed sites (A5a, R1) - FROZEN after Steward review

Goal: sites may **overlap and layer**. Examples: a road, then a house whose approach meets it; a building, then a later
extension over its side wall; a lot over a terrain pad. **Remove stays exact in any order**, and **roads become sites**.
The 4d API keeps working unchanged. Underneath it, the box-snapshot backend (one `.nbt` per site in `architect-sites/`)
is replaced by a per-cell **world journal**, ported from AgentCraft's `WorldJournal` (contract J1). Phases 1-4d above
still hold except where this section changes them; where they disagree, this section wins.

Sources for this draft:
- `docs/PLAN.md`: the 4e row, and the 4d caveats.
- "Phase 4d as built" and "Changes from Steward's review" (the approach-meets-road promise).
- AgentCraft `~/Developer/agentcraft`: `mod/src/main/java/dev/agentcraft/journal/`, last changed `ab08a02`, and
  docs/BUILDINGS.md "World journal", "Held leaves" and "Roads".
- Steward: `steward-mc/docs/A5B-SPEC.md` §4 N1-N9 and §6a, and `A4D-REVIEW.md`.

## What stays the same

- **The write paths.** Every block an instant placement, a ticked placement (`PlaceJob`, `TemplateWriter`), a
  construction builder or a restore (`restoreQuietly`, `RestoreJob`, `TickDeferral`, the leaf ring) writes is unchanged.
  Only where the "before" comes from and how the undo is chosen change.
- **The bar.** A site that overlaps nothing is placed and removed with **exactly the same block writes as in 4d**. The 4d
  gate re-runs unchanged as a regression (see the gate).
- **The 4d API.** Every 1.4.0 method keeps its meaning, and a caller that passes no overlap policy gets 4d's refusal:
  **overlap stays REFUSE by default**.
- **The site.** It stays the user-facing handle: id, record in `architect-sites.json`, owner, ext, group, stage. A site now
  names its journal entries instead of a snapshot file.

## The journal

### Port map (AgentCraft `dev.agentcraft.journal` -> `dev.larattalabs.architect.journal`)

| AgentCraft | Here | How |
|---|---|---|
| `Journal.java` (rules: `planUndo`, `reactivate`, `transfer`, `absorb`, `stack`, `Value`, `Cell`, `Entry`, `Policy`) | `journal/Journal.java` | **Verbatim** except for three additions: the PLACING status, a `Value` cache key, and per-cell layers stored sparsely (below). Pure, no world. The rules work per position, so they run unchanged on one chunk section at a time (see "Per-section planning"). |
| `JournalTest` (16 tests) | `JournalTest` | **Verbatim** (package rename), plus the property tests in the gate. |
| `JournalStore.java` (index + one gzip NBT file per entry, generations, atomic index commit, tidy at open) | `journal/JournalStore.java` | **Adapted.** The commit protocol, generations, read-back and tidy rules are kept. The files are sharded per entry per 512x512 region, the index gains a section map, and I/O runs on a journal I/O thread. |
| `JournalNbt.java` (entry encoding with a per-file palette; template <-> cells) | `journal/JournalNbt.java` | **Adapted.** Same palette encoding, grouped by section, with a 12-bit position within the section instead of a `long` per cell, and the layer per entry with per-cell overrides. The template conversion is kept for migration and for `TemplateWriter` input. |
| `WorldJournal.java` (open/close, capture, `apply`, `planUndo` against a level, DevBridge JSON) | `journal/WorldJournal.java` | **Partly reused.** Open/close, `unavailable`, `valueAt` and `state()` with its cache, and `dev.journal.state`/`at` are kept. `activeTouching` (which loads whole entries by bounding box) is replaced by the section index. `apply` is **replaced**: undo writes go through Architect's 4d writers (below). |
| `JournalMigration.java` (AgentCraft's buildings, roads and trophies files) | `journal/JournalMigration.java` | **Rewritten** for Architect's formats. AgentCraft's structure is kept: plan, then commit as the only "done" marker, then move to `legacy/`. |
| Roads: `RoadPlan`, `RoadTerrain`, `Road.handover` | `site/roads/` | **Adapted** (see "Roads as sites"). The surface choice, clearing, half steps, lanterns and handover are kept. The route comes from the caller's polyline instead of AgentCraft's agent planner, and there are no building-pair records. |

Not ported: trophies, `absorb`'s trophy use (kept in `Journal.java`, unused), AgentCraft's `LegacyIds`, its road settle (replaced
by Architect's Reconcile with the covered-cell rule below).

### Data model

- **Entry**: `{id: "j<n>", kind, site, group?, dimension, policy: BOX|CELL, layer, status: PLACING|ACTIVE|UNDONE, createdAt,
  cells, undo?, meta?, ring?}`.
  - `kind`:
    - `site`: a building's restore box;
    - `road`;
    - `cells`: a cell site, see below;
    - `crate`: a construction crate's cell;
    - `leaves`: held leaves.
    - Mod-defined kinds are namespaced (`steward_mc:terrain`).
  - `site`: the Architect site id it belongs to. AgentCraft's `owner` is renamed so it can't be confused with the API owner.
  - `group`: the site group (4d), if any.
  - `meta`: the site record when the entry was made (crash repair rebuilds a lost record from it).
  - `ring`: the 4d leaf ring, kept as a side table on `site` entries (see "Leaves").
- **Cell**: `{pos, layer, before: Value, after: Value | null}`.
  - `after` null means unknown; only migrated BOX entries have it (a BOX undo never needs `after`).
  - `layer` defaults to the entry's layer. A cell keeps its old layer only after a `transfer` (road handover), and that
    override is stored per cell.
- **Value**: `{state: {Name, Properties}, nbt?}`, the block state plus the block entity's full NBT, as in AgentCraft.
- **Layers.** One counter per world, and a later change is higher. The active cells at one position form a **stack**,
  ordered by layer. The top cell's `after` is what the world should show there, and the entry holding the top cell
  **owns** that cell.
- **PLACING** (new): an entry committed before its blocks are written, whose `after` is not captured yet.
  - It counts as on top for overlap and ownership.
  - Its undo is a rollback: BOX writes every `before`. CELL writes `before` where the world holds the planned `after`,
    which is known for roads and cell sites.
- **Undo group**: the entries undone together. A site's undo group is its `site` entry plus its `leaves` and `crate` entries.
  A site group's or stage's undo is the union of its sites' entries.

### Layering rules (AgentCraft J1, unchanged)

`Journal.planUndo` takes the undone entries out of the stacks, top-down per position:
- **A cell on top** writes the world.
  - A **BOX** entry always writes its `before`. Remove puts back exactly what was there, including the player's later
    changes inside the box (today's safe remove).
  - A **CELL** entry writes `before` only while the world "still holds" its `after` (see "Still ours"). Otherwise it leaves
    the cell and reports it as **kept**.
- **A cell under a cell that stays** changes nothing in the world. **Ownership passes down**: the newer cell's `before`
  becomes what this entry's undo would have made of it. For BOX that is this cell's `before`. For CELL it is this cell's
  `before` if its `after` matches the newer cell's `before`, else the newer cell's `before` as it is. So overlapping
  entries undo in any order, with no holes and no resurrected blocks.
- **Undone entries** keep their cells, what the undo wrote and each hand-down until the next world start settles them.
  Settling either releases them or reactivates them (the hand-downs reversed, newest first, where the receiving cell still
  holds what was handed).
- **Transfer** moves cells between entries and keeps their layers (road handover).

**Per-section planning.** A stack is per position, so planning an undo over the positions of one chunk section needs only
the entries that have cells in that section. The plan for a whole entry is the union of its per-section plans, with
hand-down `order` numbered per section in section order. This is a unit test (gate 1), and it is what lets a road that spans
a village be removed without loading anything outside its own sections.

### Still ours (CELL policy)

A cell's world state "still holds" `after` when all of these are true:
1. it is the same block;
2. every property is equal except the **volatile** ones below;
3. it has a block entity exactly when `after` does;
4. for a container, its inventory is empty when `after`'s was empty. A container the player filled is not ours.

Proposed volatile list (open question S2):
- `open` (doors, trapdoors, fence gates, barrels)
- `powered`, `power`, `lit`, `triggered`, `enabled`, `extended`
- `occupied` (beds)
- `in_wall` (fence gates)
- `snowy` (grass, podzol, mycelium)
- `waterlogged`
- `distance` (leaves; `persistent` is NOT volatile)
- `moisture` (farmland)
- the connection properties `north`, `east`, `south`, `west`, `up` on fences, walls, panes, iron bars and redstone wire
- `shape` on stairs and rails

Not volatile: `facing`, `half`, `type` (slab), `axis`, `age`. Crop `age` is Steward's question.

Two kinds have their own comparison:
- `leaves` entries compare only the block and `persistent` (AgentCraft `LeafGuard.stillHeld`).
- `crate` entries are BOX.

## On disk

### Files

`<world>/architect-journal/`:
- `journal.json`: the index. Holds `{version: 1, nextId, nextLayer, entries: [meta], legacy: {oldFile: entryId}}`. Each
  entry's meta is:
  - id, kind, site, group, dimension, policy, layer, status, createdAt, cell count, box;
  - `files: {"rx,rz": gen}`;
  - `sections`: the packed section keys it has cells in, as base64 of a `long[]`;
  - when undone: `undoGroup` and `undoneAt`.
- `e/<id>/<rx>.<rz>.<gen>.nbt`: gzip NBT holding the entry's cells in one 512x512 column region. Inside, each section is
  `{key, palette, idx: short[] (12-bit position within the section), b: int[], a: int[] (-1 = unknown), bn/an: {i: nbt},
  layers?: {i: long}}`.
  - The undo record (`written`, `handed`) is stored per region file in the same shape.
  - A kit building is one file. A 1000x1000 cell site is about 9 files.
- `legacy/`: 4d snapshot files after migration (below).

In memory:
- the index;
- a **section map** `sectionKey -> entry ids`, built at open from `sections`;
- an LRU cache of decoded region files (config `journalCacheMb`, default 64).

Nothing loads an entry's cells outside the sections an operation touches.

### Commit protocol (AgentCraft's, per region file)

1. Write each changed `(entry, region)` file as its next generation: to a `.tmp`, then an atomic move, then a read-back
   whose cell count must match.
2. Replace `journal.json` atomically. **This is the commit point.**
3. Delete the superseded generations.

- One commit may carry many entries. An undo plus all its hand-downs, or a migration, is always **one** commit.
- At open:
  - generations the index doesn't name are leftovers and are deleted;
  - `.tmp` files are deleted;
  - files of entries the index doesn't know are **kept** and listed (`dev.journal.state.unreferenced`).
- **I/O thread.** Encoding and file I/O run on one journal I/O thread, in commit order. The server thread captures the cells,
  hands off the commit, and **never writes a block that depends on a commit before that commit's future has completed**.
  The ticked placement waits in a new internal phase `COMMITTING`. A single Place outside the queue may commit
  synchronously when it has at most 100k cells (as 4d's snapshot write did). Above that it uses the ticked job.

### Size limits

| What | Limit | Over the limit |
|---|---|---|
| a `site` entry | the restore box of a template within the existing 96x64x96 cap | as today |
| a `road` entry | 2048 centre cells, width 1-5 | refused `OTHER` ("road too long; split it") |
| a `cells` entry | 1,000,000 cells per request | refused `TOO_LARGE` |
| stack depth | **8 active non-guard entries** per cell (guard kinds `leaves`, and `ring` data, don't count) | refused `LAYER_DEPTH` |
| index | none. Logged at over 16 MB. | |
| journal on disk | none. A warning toast and a Status-tab line at over 1 GB; `/architect journal` shows the size. | |

### Compaction

The journal holds only what is needed to undo the entries that stand. It is not a history.
- **Undone** entries are released at the world start that settles them, and their files go in that commit.
- **Forgotten** entries are released at once.
- Superseded generations are deleted after each commit, and leftovers at open.
- Each file has its own palette, so a palette never grows past its file's states.
- A `leaves` entry whose cells were all released (the leaves no longer held) is released.
- An entry entirely covered by newer cells **stays**, because hand-down needs it. Folding covered entries (`absorb`) is
  deferred.

### Crash safety: state sequences and kill points

Order for every change: **the journal first, then the site record (`architect-sites.json`), then the blocks.**

**Place** (instant, atomic or ticked; construction sites too):

| Step | What |
|---|---|
| P1 | Checks, then capture the `before` of every cell (see "Capture in one tick"); the cells are reserved, and overlapping items wait |
| P2 | Write the entry files (I/O thread) |
| P3 | **Index commit: entry PLACING** |
| P4 | Site record `placing` |
| P5 | Block writes (4d `PlaceJob`, unchanged) |
| P6 | Capture `after` (sliced) |
| P7 | Commit: entry ACTIVE with `after` |
| P8 | Site record placed; SITE_PLACED |

What happens on a kill (named for the gate's `dev.journal.killAt`):
- **K1, before P3:** the world and record are unchanged. Orphan files are deleted (generations) or listed (unknown entry).
- **K2, P3 to P4:** at the next start, a PLACING entry with no record is **released, and nothing is written**. No block was
  written before the record existed, and a rollback would only write a possibly stale capture.
- **K3, during P5 or P6:** as 4d. After a clean stop the job resumes from its cursor. After an unclean stop it rolls back,
  and the rollback is the undo of the PLACING entry, writing exactly 4d's snapshot restore.
- **K4, P7 to P8:** the journal wins. The record becomes placed.

**Remove** (one site, a stage or a group):

| Step | What |
|---|---|
| R1 | Plan the undo per section (pure) |
| R2 | **One commit**: the entries UNDONE with `written` and every hand-down to the entries that stay |
| R3 | Site records go to `pending`, naming their entries |
| R4 | Block writes (atomic, or a ticked `RestoreJob`) |
| R5 | At the next world start: settle (below) |

What happens on a kill:
- **K5, before R2:** nothing changed.
- **K6, R2 to R3:** at the next start the record follows the journal (it becomes pending). The evidence then finds the site
  standing, so the entries are reactivated and the record comes back.
- **K7, during R4:** after a clean stop the `RestoreJob` re-runs from the start (re-writing `written` is idempotent). After an
  unclean stop it also re-runs, before any settling. **An undo group with an interrupted restore job is not settled at that
  start**; it is settled at the next.

**A hand-down** is part of the R2 commit, so it can't be half applied (K8 in the gate kills inside that commit).

**Journal unavailable.** If the index can't be read, place, move, remove, forget, roads and cell sites refuse with
`JOURNAL_UNAVAILABLE`, and the ghost verdict says so. Nothing on disk is touched (AgentCraft).
**Full disk.** The draft write in P2 fails and the placement is refused before the world changes.

## Placement and removal on the journal

### Capture in one tick

A `before` gathered over many ticks could record a state that never existed: leaves decaying, fluids flowing, random ticks
in between. So:
- **Up to 50k cells** (every kit building, about 30 ms at most), the `before` capture (P1) and the `after` capture (P6) each
  happen **in one tick**, as 4d's snapshot capture does. Only encoding and file I/O move off the server thread. That is the
  part of 4d's unsliced job start that grows with size (compressed write plus read-back).
- **Larger captures** (designs near the size cap, cell sites, big roads) are sliced under `placementBudgetMs`, with **change
  tracking**. From the first slice until P3, a hook on chunk block changes records every changed position inside the
  reserved sections. In the tick before P3, those positions are captured again. The capture then equals a one-tick capture
  taken at that tick. The same applies to a sliced P6.
- Gate 8 places the size-cap fixture with `randomTickSpeed` raised and checks that its Remove is exact.

### Place

- **Instant (atomic and ticked):** P1-P8. The writes are 4d's.
  - The 4d caveat "job start unsliced" is closed. The compressed write and read-back move off the server thread, and
    captures over 50k cells are sliced with change tracking (above). Gate 8 measures the size-cap fixture.
- **Construction sites** (survival): the instant build runs as in phase 3/4d. Then:
  1. the `after` capture is the **target**: the target file goes away, and the entry's `after` cells are the target;
  2. the queue indexes the entry's cells;
  3. the queued cells are cleared.

  The target capture is one tick (as P6). The clear step after it runs over ticks under the budget. Together with the
  off-thread I/O, this addresses the other 4d caveat (the 17-45 ms conversion).
  - The crate cell is its own `crate` BOX entry in the site's undo group. A 4d shared crate is owned by the group and
    undone when the crate goes, or with the group.
  - "Built" is derived from the world as in phase 3, but **only for cells this entry owns** (top of stack). A cell another
    site covers is neither built nor queued; it counts as `covered` in `dev.site.state`.

### Remove

1. `refusePlayerIn` over the cells the undo will write.
2. `removalBlockers` (the player's things in the box, filled containers) over **the cells the site owns**. A covered cell
   belongs to the site on top.
3. Survival refunds (see "Survival layering").
4. Commit R2, record R3.
5. Writes:
   - **BOX writes** go through 4d's restore path. The snapshot template given to `TemplateWriter` / `restoreTemplate` is
     built from the plan's `written` values over the entry's box, so a site with no overlaps gets the full box exactly as
     in 4d.
   - Cells the plan does not write (**holes**: covered by a site that stays) are absent from the template.
   - **CELL writes** use `setBlock` lowest first, with the kind's flags. Roads and cell sites use `UPDATE_CLIENTS |
     UPDATE_SKIP_ALL_SIDEEFFECTS`, as AgentCraft's roads do.
6. Leaves (below), drops, reholdNear, SITE_REMOVED.

**Updates at holes.** After a BOX restore, the 4d writer runs edge shape updates, `updateFromNeighbourShapes` and neighbour
updates for the cells it wrote. These would change the site above: its fences, panes and stairs would reshape, and a torch,
ladder or door hung on a restored wall could pop off.
- **Rule:** in a restore with holes, **no update of any kind is delivered into a covered position**: no shape update, no
  neighbour update. The writer gets a mask of covered positions and skips them as update targets.
- Block and fluid ticks scheduled **at** covered positions during the restore are dropped, the same way leaf ticks are
  (`TickDeferral`).
- Written cells still get their updates as in 4d. A restore without holes has an empty mask, so it is unchanged from 4d.
- Cells of the site on top that are now unsupported are reported in `RemoveResult.notes`. Examples: an attachable whose
  support cell was restored to air, or a gravity block over a restored cave. They stay as they are until something else
  updates them.
- The gate checks that the site on top is identical, cell for cell, after the site under it is removed.

### Move, undo move, forget

- **Move / undo move:** allowed only for a site that has **no layers above or below it**, meaning no cell it owns or covers
  is shared with another standing entry. Otherwise it is refused: "remove it and place it again". Moving layered sites is
  deferred.
- **Forget** (drop the record, keep the blocks) releases the site's entries.
  - Allowed when nothing is **below** the site.
  - A site with entries below is refused: forgetting it would make the lower site's undo wipe the forgotten blocks.
    "Forget or remove the sites under it first."
  - Forgetting a site with entries **above** is fine: their `before`s already hold its blocks.

### World-start settle (Reconcile)

Pending sites are settled on evidence, as in 4d (`Reconcile.restored`, `stands`), with one change: **cells another standing
entry owns are excluded** from both counts, as AgentCraft's road settle does.
- **Restored** releases the entries.
- **Standing** reactivates them and brings the record back.
- **Doubtful** keeps them.

`Reconcile.standing` for standing sites also counts only the cells each site owns. A building half covered by an extension
still "stands".

Evidence for the kinds 4d didn't have:
- **Road and cell entries:** over the uncovered cells the undo wrote, count the cells where `before` and `after` differ
  (AgentCraft's road settle).
  - Most hold `before`, or none can tell: release.
  - Most hold `after`: reactivate, and the record comes back.
- **Migrated BOX entries with `after` unknown:** the site's pin (its template and own block entities), as in 4d.
- **A site whose comparable cells are all covered:** release. A standing site's own entry holds the same terrain (AgentCraft's
  COVERED rule).
- **`leaves` and `crate` entries** settle with their site's group.

**Records come from the journal.** Each site's list of entries is derived from `entry.site` and is not stored in the record.
At every start, an ACTIVE or PLACING entry whose `site` has no record gets its record rebuilt from the entry's `meta`
(the journal wins). This is also what repairs a downgrade round trip (see Migration).

### Leaves

- **Held leaves** (`LeafGuard.hold`) become a `leaves` CELL entry in the site's undo group, as in AgentCraft:
  - each cell's `before` is the natural leaf with its distance, and its `after` is the same leaf persistent;
  - the undo writes quietly (`UPDATE_KNOWN_SHAPE`) and compares block plus `persistent`.
- **Decision:** the stack semantics replace 4d's `releaseHeldInside`. A later site whose box takes in a held leaf records
  the **persistent** leaf as its `before`.
  - If the holder is removed first, hand-down gives the later site the natural leaf.
  - If the later site is removed first, its restore writes the persistent leaf, which the holder still holds.
  - The end states equal 4d's in both orders (gate 9).
  - `reholdNear` stays: after a removal, nearby standing sites get new `leaves` entries.
- **Guard cells never claim another site's cells.** Held leaves and the leaf ring skip cells that another standing entry
  owns when they are captured (4d's "not cells inside a standing site's box").
- **The leaf ring** (4d, `architect_leafRing`) stays a **side table** on the `site` entry, not stack cells. After the
  site's undo, `LeafGuard.restoreRing` runs as in 4d. The 4d test "in another standing site's restore box" becomes "owned
  by a standing entry". Leaf ticks are dropped as in 4d.

### Block entities

- `Value.nbt` holds the full BE NBT in `before` and `after`. Undo loads it as 4d does.
- Construction targets clear only container inventories (phase 3).
- **"Foreign" block entities** in a new site's box are the cells whose BE isn't an Architect `after`:
  - the cell is not owned by an entry; or
  - its NBT differs from the owner's `after` in container contents.

  These still refuse with `BLOCK_ENTITIES` unless `force`. An empty template chest of a lower site does not refuse a LAYER
  over it; a chest the player filled does (Steward N2, N5).
- **Migrated entries** have no `after`. For them, "an Architect BE" falls back to the site's pin (its template's own BE
  positions), as 4d's `removalBlockers` does.

## Overlap

### The test is per cell

- A new site overlaps when any cell of its **predicted restore box** (4d: template box, approach strip, one row below) is
  in a standing or placing entry's cells, in the same dimension. The lookup goes through the section map.
- For BOX against BOX this is 4d's box test, because a `site` entry's cells fill its box. Against a road or a cell site it
  is exact; a bounding box would refuse anything near a long road.
- Guard data (held leaves, the ring) never counts as overlap.

### `OverlapPolicy` (per call; `PlaceRequest.overlap`, `Batch.overlap`)

| Policy | Means |
|---|---|
| `REFUSE` (default: null, or a 1.4.0 caller) | **4d behaviour.** Any overlap refuses with `OVERLAP`. The one exception is the 4d promise: an approach stopped by a road is not an overlap, because it writes nothing there (see "Roads as sites"). |
| `LAYER` | The new site goes on top: its `before` at shared cells is what the world shows (the lower site's blocks), and undo works in any order through hand-down. All other checks still apply. |

**LAYER still refuses** when:
- the overlapped entry is `placing`, a construction site still `BUILDING`, or being removed: `OVERLAP_BUSY` (temporary, so a
  queued item **waits**, as for `PLAYER_IN_BOX`);
- the overlapped site has another owner than the request: `OVERLAP_OWNED` unless `force` (the guardrail, as for remove);
- the stack would exceed 8: `LAYER_DEPTH`;
- foreign block entities, lava, build height, a door cut, creative-only blocks, or occupancy, as in 4d.

**TerrainFit and Approach under LAYER** read cells another entry owns by their block, like natural terrain. Solid is ground,
non-solid can be cleared. They are never "the player's block" (Steward N2).

`REPLACE` (remove what you overlap, then place) is **deferred**: no Steward ask needs it (see Deferred).

### Removing a covered site: `CoveredPolicy` (`RemoveOptions.covered`)

| Policy | Means |
|---|---|
| `KEEP` (default) | Hand-down. Cells another site covers stay as they are (that site's blocks). Every other cell is restored. The site on top later restores the original ground. RemoveResult lists `handedDown` per covering site. |
| `CASCADE` | First remove every site that covers this one, top-down, recursively, as one undo group. Then remove this one. Each covering site is subject to its own blockers, owner rule and refunds. Any refusal stops the whole cascade before anything is written. |
| `REFUSE` | Refuse `COVERED` when another site covers any cell. |

The UI asks when a site is covered: "3 cells of this site are under 'East Wing'; they stay until it is removed. [Remove]
[Remove both] [Cancel]". `KEEP` never silently deletes anything (Steward N1).

## Roads as sites

### Request

```java
record RoadRequest(ServerLevel level, List<BlockPos> points, int width, @Nullable String surface, @Nullable String slab,
                   boolean lanterns, boolean shallowDecks, Mode mode, @Nullable String owner, JsonObject ext,
                   @Nullable ServerPlayer actor, boolean force) {}
```

- `points`: 2-256 waypoints. Each `y` is a ground hint: the ground is searched from `y + 8` down to `y - 8`.
- `width`: 1-5, default 3, centred on the line. An even width puts the extra cell on the right of the direction of travel.
- `surface` / `slab`: null means automatic. Otherwise a vanilla block id, validated.

The ghost previews it through a new composite layer style `ROAD` (client), and `Sites.checkRoad(r)` returns a Verdict with
the cells.

### Cells

- **Line.** Between waypoints, a 4-connected supercover line in x/z. A diagonal step goes through its corner cell, so the
  walkway stays connected (AgentCraft).
- **Profile.** Each centre cell's ground is the top solid block that is not leaves or a plant (Approach's ground rule).
  - The heights are smoothed so neighbouring centre cells differ by at most 1, and no column is cut or filled by more than 4.
  - A column that needs more refuses with `TOO_STEEP`, naming it.
  - Fill uses `foundation` (default `minecraft:cobblestone`). A cut removes natural blocks only.
- **Side cells** take their centre cell's height.
  - Each needs at most 2 of fill or cut. A side cell needing more, or holding something that can't be cleared, is left
    out (noted).
  - A centre cell holding something that can't be cleared keeps it (AgentCraft `KEPT`, noted).
- **Surface** (`surface == null`), AgentCraft `RoadPlan.surfaceFor`:
  - `dirt_path` on the dirt family;
  - `gravel` on sand or stone when the block below holds it up, else `packed_mud`;
  - `packed_mud` on mud.

  **Half steps** follow the same rule: a bottom slab in the feet cell where a neighbour is one block higher and none is
  lower. Exposed ores are never paved.
- **Clearing.** 2 cells of headroom (3 over a half step): plants, saplings, grass, snow layers, leaves, and natural terrain
  in a cut. It never clears block entities, logs, the player's blocks, fluids or anything waterlogged.
- **Water.** 1-deep water gets an `oak_slab` deck in the air above it only with `shallowDecks`; otherwise those cells are
  skipped and noted. Deeper water refuses with `DEEP_WATER` ("bridges are phase 6").
- **Lanterns** (optional): AgentCraft's rule, a fence post plus a lantern beside the walkway, the first 6 blocks out and
  then every 12.
- **Other sites.** **A road never layers.** It skips every cell another standing entry owns (a building's restore box
  including its approach, another road) and notes "N cells of `<site>` left as they are". A road placed after the lots
  therefore runs up to the approach ends.
- **Entry.** Kind `road`, policy **CELL**, `after` = the planned cells. Writes use `UPDATE_CLIENTS |
  UPDATE_SKIP_ALL_SIDEEFFECTS`. New drops near changed cells are cleared (AgentCraft `CellDrops`). Writes are ticked under
  the placement budget.

### Approaches meet roads (the 4d promise, in full)

- `Approach`'s `TerrainFit.World` gets a new flag `ROAD` on cells whose owner is a standing road entry's surface or slab
  cell. Road cells also count as ground (`NATURAL | FILLABLE`).
- The approach **stops before the first row r >= 1 in which any of its columns' path cell (one below the feet) or feet cell
  is a ROAD cell.** Rows r and later are not written, and the extension (`EXTEND`) stops: the path has met the ground.
- The restore box (`approach.union(box)`) therefore ends before row r. The approach writes nothing on the road, and that is
  **not an overlap**, under any policy.
- If the last written row's path is more than 1 block off the road surface, a note says "approach meets road `<id>` with a
  step of N". It is not a refusal.
- A road cell inside the template box or row 0 is an ordinary overlap: REFUSE refuses, LAYER layers.
- **Client ghost.** The client has no journal, so the server syncs road cells near each player. The payload is
  `architect_mc:road_cells {dimension, sections: [{key, cells: short[], top: byte (surface|slab)}]}`.
  - It covers roads with sections within 160 blocks.
  - It is sent on join and dimension change, and as deltas on road place and remove.
  - The client's Approach adapter reads it, so the ghost draws the shortened approach. The placement verdict stays the
    server's.
- **`fitToLot`** computes `predictedRestoreBox` with the road rule, so a lot facing a road gets the shorter box.
- **`overlapMargin`** stays the worst case (no road). A lot facing a road needs at most that much and usually less.

### Removing a road

- CELL rule: a cell is restored where the world still holds the road's block. Cells the player changed are kept and
  reported (`RemoveResult.kept`).
- A cell a later site covers (a LAYER placement over the road) is handed down.
- **Crossings and shared stretches** (AgentCraft `Road.handover`): changed cells that another standing road runs on are
  **transferred** to that road with `Journal.transfer`, keeping their layers, and noted ("… 24 cells kept for road
  `<id>`"). This covers cells in or beside a column of that road's walkway, from 2 below its feet to 3 above. If there are
  several such roads, the nearest takes the cell, then the newest.
- **Houses whose approach met the road** are unchanged. Their approaches end where the road was.

### Survival roads

In a survival-toggle world a road is a **construction site**:
- its crate goes beside the first waypoint;
- its BOM comes from the surface, slab, fill, fence and lantern cells (with the obtainability map, so `dirt_path` costs
  dirt);
- the builder writes the entry's `after` cells.

INSTANT follows the same actor and permission rules as buildings. (A candidate for deferral; open question S7.)

## Cell sites

`Sites.placeCells(CellsRequest)` places a caller's own cell list as a site. Steward needs it for pad flattening (N3) and as
the write path phase 6 will stream region programs into (N9). It is also the gate's synthetic scale fixture.

```java
record CellsRequest(ServerLevel level, String kind /* namespaced */, Policy policy /* BOX | CELL */, List<CellWrite> cells,
                    boolean naturalOnly, OverlapPolicy overlap, Mode mode, @Nullable String owner, JsonObject ext,
                    @Nullable ServerPlayer actor, boolean force) {}
record CellWrite(BlockPos pos, BlockState state, @Nullable CompoundTag nbt) {}
```

- At most 1,000,000 cells; more than that means several requests in one group. INSTANT only in 4e: CONSTRUCTION is refused
  `NOT_ALLOWED`. Writes are ticked and use the road flags.
- `naturalOnly` (default true): a cell whose current block is not natural terrain, air or water, or holds a block entity,
  is skipped and noted (Steward's engine invariant).
- Overlap is checked per cell as above. LAYER over BOX sites is allowed.

## Survival layering

The invariant is **items in = items out**, for every removal order: no item is duplicated and none is lost. The rules:
1. **Waiting.** A LAYER placement over a construction site that is still BUILDING waits (`OVERLAP_BUSY`).
2. **Free clearing.** The clear step of a site on top gives no drops, whether the cleared cell is terrain or a lower site's
   block. Either the block comes back when the upper site is removed (its BOX `before`), or rule 4 refunds it.
3. **Refunds when a site S is deconstructed:**
   - (a) a cell S owns, where the world holds S's `after` block and the cell was paid, is refunded (phase 3);
   - (b) a paid cell of S that a site U covers, where U's `before` there equals S's `after` (U's clear step displaced S's
     intact block), is refunded. After the hand-down, U's `before` there is S's `before`, so that block never comes back;
   - otherwise nothing is refunded.
   - The player's own blocks drop only from cells S owns (phase 3 rule).
4. **The other order.** If U is removed first, its BOX undo writes S's block back, and S refunds it later under (a).
5. **Covered cells and S's own state.** S's builder, "built" scan and Reconcile skip cells S doesn't own.
6. **Crates.** Refunds drop at the deconstructed site's crate cell, or its group's shared crate (4d).
7. **Group undo.** In a group or stage undo, refunds are computed against the stacks **before** the undo is planned. The
   hand-downs within the group would otherwise hide rule 3(b).

## Groups, stages and the queue

The API is unchanged from 4d.
- **`removeGroup`** is **one undo** over every entry of the group's sites, planned per section and written by a ticked
  `RestoreJob`. Hand-downs between members of the group cancel out, so the result doesn't depend on order. The writes still
  go in reverse placement order, so progress reads as 4d did.
- **Construction members** deconstruct with the refund rules above.
- **`undoStage`** is one undo over that stage's entries. The 4d dependency rule stays (a later placed stage refuses without
  `force`). With `force`, hand-down applies.
- **The queue:**
  - An item's policy comes from `PlaceRequest.overlap`, else `Batch.overlap`, else REFUSE.
  - Items of one batch may layer on earlier items of the same batch when the policy is LAYER (terrain pad, then lots).
  - The overlap test runs at queue time (in the Verdict) and again at the item's start.
  - `OVERLAP_BUSY` waits under `waitPolicy`.
  - Road and cell items queue like buildings.
- **Groups are journal undo groups.** Stages are undo groups too. `SiteGroup` and `Stage` records don't change.

## Migration from 4d worlds (`JournalMigration`)

**When:** the first 0.8.0 start of a world that has `architect-sites.json` and no `architect-journal/journal.json`. It runs at
SERVER_STARTED, before the sites load, the same way AgentCraft's migration does.

| 4d artifact | Becomes |
|---|---|
| a standing instant site's snapshot (`architect-sites/<file>.nbt`) | an ACTIVE `site` BOX entry over its restore box: the `before`s are the snapshot's blocks and BE NBT exactly, and `after` is unknown |
| the snapshot's `architect_leafRing` | that entry's `ring` side table, unchanged |
| `Pin.heldLeaves` (x, y, z, distance) | a `leaves` CELL entry. Each listed cell is read from the world (its chunk loaded for the read). A cell that is no longer a persistent leaf is dropped (it isn't held). `before` = the natural leaf with the recorded distance, `after` = the leaf as read. |
| a construction site's target file | the `site` entry's `after` values (the target); the queue indexes are remapped to entry cells |
| a crate's `{pos, snapshot}` (and a group's shared crate) | a `crate` BOX entry (one cell) in the site's (or group's) undo group |
| a `pending` site (removed or moved away, not settled) | UNDONE entries whose undo wrote the whole box, settled at this start by the existing evidence rules |
| a `placing` site (`architect-queue.json` cursor) | a PLACING entry with the snapshot as `before`. Its job resumes (clean stop) or rolls back (unclean), as in 4d. The queue file is unchanged: its cursors index the cell lists, not the snapshot. |
| site groups, stages, batches | unchanged in `architect-sites.json`; site records name no entries (they are derived from `entry.site`) |
| unreferenced snapshot files | not imported, moved with the rest, still listed |

- **Layers** follow `placedAt`, and each site's entries are consecutive (`site`, then `leaves`, then `crate`).
- **Unreadable files:**
  - An unreadable snapshot of one site imports that site without an entry, flagged. Remove refuses it with the 4d "forget"
    way out.
  - An unreadable `architect-sites.json` means no import (4d's `loadFailed`; nothing is written).
- **Done marker:** the single index commit. After it, `architect-sites/` moves to `architect-journal/legacy/`. A crash
  in between only finishes the move at the next start. Old file names map to entries in `legacy`.
- **Late import:** at every start, a site record that names a snapshot file in `architect-sites/` and has no entry is imported
  the same way, as the top layer. Such a record was made by 0.7.0 after a downgrade.
- **Downgrade** (0.8.0 world opened in 0.7.0). Checked in the code:
  - 0.7.0 ignores the file `version`.
  - `Site.fileFromJson` reads only `sites`, `pending`, `groups`, `next` and `nextGroup`.
  - `Site.fileJson` writes only those, so **any 0.7.0 save drops every field and array it doesn't know**.

  Hence:
  - **Roads and cell sites** go in a top-level array `infra: []`. 0.7.0 doesn't see them, so it can't remove them, and its
    next save drops the array. 0.8.0 then rebuilds those records from their entries' `meta` (the journal wins, see "Records
    come from the journal").
  - **Migrated building sites** keep records that 0.7.0 can read. Their Remove refuses, because the snapshot moved; 0.7.0
    offers forget, and writes no wrong terrain. A 0.7.0 **forget** drops the record but not the journal entry, so 0.8.0
    brings the record back. Forgetting must be done again in 0.8.0.
  - **Sites 0.7.0 places** get snapshot files and no entries. 0.8.0 late-imports them on top, which is LAYER semantics if
    they overlap a road 0.7.0 couldn't see.
  - **New ids** (`s<n>`, `g<n>`): 0.7.0 recomputes `next` from the records it sees. Road and cell-site ids therefore use
    their own prefixes (`r<n>`, `c<n>`), with counters stored in the journal index, so 0.7.0 can't reuse one.
  - So a downgrade is **unsupported but recoverable**: no wrong blocks are written, and the round trip 0.8 -> 0.7 (place
    something, which saves) -> 0.8 restores every record. Gate 4 checks it (open question N1).

## Java API (1.5.0)

`ArchitectApi.VERSION = "1.5.0"`. The rules follow the 1.1-1.4 precedent: old constructors kept; new `Sites` methods are
default methods that throw `UnsupportedOperationException("... needs Architect API 1.5.0")`; enum constants are appended
at the end.

**New types:**
- `enum OverlapPolicy { REFUSE, LAYER }`
- `enum CoveredPolicy { KEEP, CASCADE, REFUSE }`
- `enum Policy { BOX, CELL }`
- `RoadRequest`, `CellsRequest`, `CellWrite`
- `Layer(String siteId, String kind, Policy policy, long layer, boolean top)`
- `Overlap(String siteId, @Nullable String owner, int cells, boolean blocking)`

**Records gain components** (the old constructors are kept):
- `PlaceRequest`: `@Nullable OverlapPolicy overlap` (null = REFUSE, or the batch default).
- `RemoveOptions`: `CoveredPolicy covered` (null = KEEP).
- `RemoveResult`: `int restored`, `int kept` (CELL cells the player changed), `Map<String,Integer> handedDown`, `List<String>
  cascaded`.
- `Verdict`: `List<Overlap> overlaps`, plus road and cell cells for `checkRoad` / `checkCells` (as a count and a box, not the
  list).
- `SiteView`: `String kind` (`building`, `road`, `cells:<kind>`), `Policy policy`, `List<String> covers`, `List<String> coveredBy`
  (site ids).
- `Batch`: `@Nullable OverlapPolicy overlap`.
- `Batch.Item`: `@Nullable RoadRequest road` and `@Nullable CellsRequest cells`. **Exactly one of `request`, `road` and
  `cells` is non-null. For a road or cell item, `request()` returns null.**

**`Sites` gains:**
- `placeRoad(RoadRequest)` -> `CompletableFuture<PlaceResult>`
- `checkRoad(RoadRequest)` -> `Verdict`
- `placeCells(CellsRequest)` -> `CompletableFuture<PlaceResult>`
- `checkCells(CellsRequest)` -> `Verdict`
- `stack(ResourceKey<Level>, BlockPos)` -> `List<Layer>` (bottom first)
- `place`, `check` and `queue` honour `PlaceRequest.overlap` / `Batch.overlap`
- `remove`, `removeGroup` and `undoStage` honour `RemoveOptions.covered`

**`Reason` gains** (appended): `OVERLAP_BUSY`, `OVERLAP_OWNED`, `LAYER_DEPTH`, `COVERED`, `TOO_STEEP`, `DEEP_WATER`, `TOO_LARGE`,
`JOURNAL_UNAVAILABLE`.

**Events:** none new. SITE_PLACED and SITE_REMOVED fire for roads and cell sites (their `SiteView.kind` tells them apart).
SITE_REMOVED's RemoveResult carries the hand-downs.

**Features:** `"journal"`, `"overlapLayer"`, `"roads"`, `"cellSites"`, `"stackQuery"`.

**Not purely additive** (as in 1.1-1.4):
- Record patterns, `equals` and `toString` change for `PlaceRequest`, `RemoveOptions`, `RemoveResult`, `Verdict`, `SiteView`,
  `Batch` and `Batch.Item`.
- New `Reason` constants break exhaustive switches.
- `Batch.Item.request()` may now be null, for road and cell items only. A 1.4.0 caller reading only its own items is
  unaffected.

**Binary compatibility check:** Steward's current jar, and `apitest` compiled against 1.4.0, run against 0.8.0 unchanged (gate
11).

## DevBridge (docs/DEVBRIDGE.md changelog)

- From AgentCraft: `dev.journal.state` and `dev.journal.at {x, y, z, dimension?}`.
- New:
  - `dev.journal.killAt {point: K1..K8 | migrate-before-commit | migrate-after-commit}`: the next matching step halts the
    JVM (`Runtime.halt`);
  - `dev.journal.failNextCommit`;
  - `dev.road.place` / `dev.road.check`;
  - `dev.cells.place`;
  - `dev.region.hash {box, exclude?}`: cells plus BE NBT, for the order tests.
- `dev.site.state` gains `covered`, `entries` and `layers`.

## Performance budgets

| What | Budget |
|---|---|
| capture (`before` / `after`) on the server thread | <= 0.6 µs per cell without a BE: one tick up to 50k cells (kit buildings under 30 ms), sliced with change tracking above that |
| encode + gzip + write + read-back (I/O thread) | >= 2M cells/s; never on the server thread above 100k cells |
| journal size | <= 10 bytes per cell compressed, averaged over the village |
| placement throughput at 4 ms | >= 15k cells/s, journal included (75% of 4d's 20.5k) |
| undo planning | <= 1 µs per cell at stack depth <= 2, sliced per section |
| overlap check (`check()` of a kit building) | <= 2 ms |
| MSPT | no tick over 50 ms in any gate scenario. Village plus roads at 4 ms: max <= 25 ms. A 96x64x96 fixture placed and removed: no tick over 50 ms (closes the 4d caveat). |
| memory | peak heap <= 4d + 64 MB on the village |

## Phase 4e gate

1. **Unit tests:**
   - AgentCraft's `JournalTest`, `JournalStoreTest` and `JournalMigrationTest` cases, ported. The migration cases are
     rewritten for Architect's formats.
   - **Property tests (invariants)** over random fixtures (2-6 entries, BOX and CELL, random overlaps, random player edits),
     each removal order and each group split:
     - (i) with no player edits, undoing everything in any order gives back the original world;
     - (ii) undoing a subset never writes a cell owned by an entry outside the subset;
     - (iii) the final world after undoing everything is the same for every order, with edits included;
     - (iv) a player edit on a cell that a CELL entry owns survives that entry's undo.
   - **Per-section planning** equals whole-entry planning.
   - **Store crash tests:** a fault at every I/O step.
2. **Any-order exactness** (dev world). The fixture is 4 overlapping sites:
   - T: a cell site, CELL, a flattened pad;
   - R: a road across T;
   - H: a house LAYERed on T, whose approach meets R;
   - X: an extension LAYERed over H's side wall.

   **All 24 removal orders**, each from a copy of the same world, plus one group removal of all 4. After each removal:
   - every site still standing is identical, cell for cell, on the cells it owns (no shape leak through holes);
   - at the end, the union box + 8 equals the pre-placement hash, every cell plus BE NBT.

   A fifth site L (a lot that LAYERs over R's edge) runs in 6 random orders.
3. **Player edits:**
   - a block placed on R and a lever flipped in H. R's removal keeps the block and reports it.
   - H's removal restores its box (safe remove), and the flipped lever counts as ours.
   - A filled chest in T refuses H's LAYER without force.
4. **Migration:** a world made **with the 0.7.0 jar** through its DevBridge, with the pre-placement hashes recorded. It holds:
   - 3 instant sites;
   - a construction site half built;
   - a removed site not yet settled;
   - a group with 2 stages;
   - a site placing at a clean stop;
   - a site beside a worldgen tree (held leaves and the ring).

   Opened with 0.8.0:
   - the index is made and `legacy/` is filled;
   - every Remove matches its pre-hash;
   - the construction site finishes identical to an instant placement;
   - the placing site resumes, and the pending site settles.

   - A LAYER placement over a migrated site works (the foreign-BE check falls back to the pin), and removing both in either
     order is exact.

   Repeated with a kill before and after the migration commit.

   **Downgrade round trip:** 0.8.0 (with a road) -> 0.7.0, where you place a site, which saves the file, and try to Remove
   a migrated site, which refuses and writes nothing -> 0.8.0. Afterwards the road's record is back, the 0.7.0 site is
   late-imported, and every Remove is exact.
5. **Crash mid-write:** K1-K8 each, by `dev.journal.killAt` and a restart. Each time:
   - the journal opens, and no file the index names is lost;
   - the site ends in the state the sequence promises;
   - a final full removal matches the pre-hash.
6. **Road plus village:** the 4d 12-lot village with roads joining the entrances, in both orders:
   - **(A)** roads first, then lots through the queue with REFUSE. Every approach stops at a road, there are 0 OVERLAP
     refusals, and no approach cell is a road cell.
   - **(B)** lots first, then roads. The roads skip lot cells.

   Both orders end with an exact group undo.
   - Removing one road while the lots stand restores its uncovered cells, transfers its crossing cells to the other road,
     and leaves the lot approaches unchanged.
   - The client ghost of a lot facing a road draws the shortened approach (a screenshot that has been looked at).
   - `fitToLot` facing a road predicts the shorter box.
7. **Survival layering:** S (a cabin construction site) and U (an extension LAYERed over S's wall, construction), both fed by
   hoppers. U queued while S builds waits with `OVERLAP_BUSY`, then proceeds. Both finish identical to instant LAYER
   placements. Deconstructing in both orders (two world copies): items out equals items in, per item id, and the terrain is
   exact.
8. **MSPT and throughput:**
   - the village plus roads at 1, 4 and 10 ms;
   - a 96x64x96 fixture placed and removed;
   - numbers in `artifacts/gate4e/REPORT.md` and `throughput.json`, against the budgets.
   - The size-cap fixture is also placed with `randomTickSpeed` 300 near a worldgen tree, and its Remove is exact. The same
     holds for a sliced 300k-cell cell site with change tracking.
9. **4d regression:**
   - the whole 4d gate and its additions re-run, including that a third lot whose approach crosses a neighbour's front
     refuses `OVERLAP` under the default;
   - the phase 3 gate and phase 1 exact Remove;
   - **the strengthened 4d caveat:** the toggle step on **adjacent (0-gap) lots**, where the only allowed diffs are
     persistent-leaf diffs, and the held-leaf cases from "Leaves" in both orders.
10. **mega-lite** (synthetic, no region programs, since realise is phase 6):
    - a 256x256 CELL terrain pad as a cell site, 40 stub lots LAYERed on it, and 8 roads, through the queue with
      `LOAD_BOUNDED`;
    - the group undo is exact, and one lot's undo leaves the pad exact.

    Recorded (not gated):
    - cells/s at 1, 4 and 10 ms, undo time (group and one lot), journal size, peak heap, and resume across a relog;
    - the same generator at 1000x1000, for Steward's `mega_bench` numbers.
11. **API:**
    - new apitest steps for every 1.5.0 method and each new Reason;
    - **the 1.4.0 apitest jar, unchanged, passes against 0.8.0.**
12. gate-verifier checks the result.

## Open questions for Steward

- **S1.** `RemoveOptions.covered` defaults to `KEEP` (hand-down, the lots stay). Is that right for API callers, or do you
  want `REFUSE` by default with an explicit KEEP or CASCADE?
- **S2.** The volatile list (see "Still ours"). Should crop `age` and farmland `moisture` be on it? Do you need any more?
- **S3.** Should items in the same group get LAYER implicitly, or is an explicit `Batch.overlap = LAYER` fine? The draft
  wants it explicit.
- **S4.** Roads take a polyline with Architect's ground-following profile (cut or fill of at most 4, width at most 5).
  Enough for region programs, or do you need per-point absolute y (sky roads) or larger cut/fill limits?
- **S5.** Is `placeCells` (Java-side lists, at most 1M cells, INSTANT only, `naturalOnly`) useful to you before phase 6, for
  example for N3 pad flattening? Should construction mode for it come in 4e?
- **S6.** N3 says a child may move within its pad. 4e refuses Move for any layered site. Is that acceptable until later?
- **S7.** Do you need survival (construction) roads in 4e, or only Patron/creative?
- **S8.** Is `SiteView.covers/coveredBy` plus `Sites.stack()` enough for N8, or do you want per-entry views (change-sets)
  in the API?
- **S9.** mega-lite gated in 4e, with your full `mega_bench` measured in phase 6 once region realise exists: agreed?

## Open questions for Noah

- **N1.** Downgrade: "unsupported but recoverable". 0.7.0 refuses to remove migrated sites, roads are invisible to it, and
  its saves drop the road records, which 0.8.0 rebuilds from the journal. Is that acceptable? Nothing 0.7.0 already honours
  could make it refuse such a world: it ignores `version`.
- **N2.** Player UI:
  - Should the ghost offer "Place on top" (LAYER) when it overlaps, in creative and in survival?
  - Should Remove of a covered site ask with "Remove both"?
  - The draft says yes to both.
- **N3.** REPLACE is deferred. Do you want it in 4e anyway? The tight version: remove the overlapped sites of the same
  owner, then place, refused if any of them is covered by a third site.
- **N4.** The survival refund rule (b) for a lower site's paid block that an upper site displaced. OK as the no-dupe,
  no-loss rule?
- **N5.** The journal port copies AgentCraft at `ab08a02` and diverges (sharded store). Treat it as independent from now on,
  like the placement code (PLAN "Open questions")?
- **N6.** A road tool in the UI (click waypoints, ghost, confirm) in 4e? The draft has a command (`/architect road <x z>...
  [width]`) plus the API only.
- **N7.** The disk warning threshold of 1 GB, and the cache of 64 MB.

## Deferred (recommended)

- **REPLACE** overlap policy (N3).
- **Moving layered sites**, and forgetting a site with layers below it.
- **Bridges** beyond 1-deep decks: spans, supports, arches. That is phase 6 (A5b `bridge`), placed as cell sites.
- **Routed roads** (pathfinding between entrances, AgentCraft's planner). 4e takes the caller's polyline.
- **Region realise streaming** (N9: per-section evaluation in the sidecar, cell lists over the WebSocket). Phase 6 writes them
  through `placeCells`.
- **Construction mode for cell sites.**
- **Delta apply** (A6, phase 5b). It becomes "a new layer whose `before` includes the earlier layers", which the journal
  already supports.
- **Compaction of covered stacks** (`absorb` beyond release and GC), and a stack inspector UI (DevBridge only in 4e).
- **The full 1000x1000 `mega_bench` as a gate** (phase 6).

## Coordinator decisions on N1-N7 (provisional, Noah may override)

- **N1** Yes: unsupported but recoverable, with the round trip in the gate. The changelog says so.
- **N2** Yes to both: "Place on top" in creative and survival, and "Remove both" on a covered site.
- **N3** REPLACE stays deferred.
- **N4** Yes: rule (b) is the no-dupe, no-loss rule.
- **N5** Yes: the journal is independent from now on. CONTRACT and the source header record its origin (AgentCraft `ab08a02`).
- **N6** Command plus API in 4e; the click-waypoint road tool waits until roads are used in play.
- **N7** Yes: 1 GB warning, 64 MB cache, both in the config.

## Changes from Steward's review (steward-mc/docs/A4E-REVIEW.md), all accepted

Where this section and the 4e text above disagree, this section wins.

- **Roads over cell sites (MUST 1).** A road skips every cell owned by a `site` entry (a building's restore box, its approach
  included) or another `road` entry, and **layers over `cells` entries** (CELL policy). A `cells` entry of another owner refuses
  with `OVERLAP_OWNED` unless forced. Gate 2's "R across T" tests exactly this.
- **Cell sites in a survival-toggle world (SHOULD 2).** In 4e, `placeCells` is INSTANT only. In a world where INSTANT is not
  allowed (survival toggle on, not creative) it refuses `NOT_ALLOWED`, terrain-kind included. Free natural-only cut/fill for
  survival terrain operators is a game-design call for Noah, taken up with Steward's difficulty modes (not 4e).
- **mega_bench numbers (SHOULD 3).** The gate records compressed journal bytes per cell for a 256x256 pad and for the mega-lite
  generator, and `Sites.stack()` query time (p50/p99) at stack depth 4, in `artifacts/gate4e/bench.json`.
- **S1** KEEP stays the default for removing a covered site.
- **S2** The "volatile" properties ignored when deciding a cell is still ours: add `age` (crops, sugar cane, cactus, kelp,
  fire, nether wart), `stage` (saplings), `honey_level`, `level` (composter, cauldron) and `bites`. `moisture` is already on the
  list. `facing/half/axis/type` are not added.
- **S3** LAYER is explicit: `Batch.overlap = LAYER`. **S4** Polyline roads only, no per-point absolute y. **S5** placeCells
  ships in 4e, with no construction mode. **S6** Move refused for layered sites. **S7** No survival roads in 4e.
  **S8** `covers/coveredBy` plus `stack()` is enough. **S9** mega-lite gates 4e; the full mega_bench is measured in phase 6.

## Phase 4e as built (API 1.5.0, mod 0.8.0, recorded 2026-10-06)

Deviations, interpretations and measured numbers. The gate evidence is local: `artifacts/gate4e/` (REPORT.md, per-step
JSON, `throughput.json`, `bench.json`), driven by `tools/gate4e.mjs`. Every gate step passed on the final build; gate 9's 4d
re-run has one pre-existing failure class (below).

**Journal and store**
- The journal is AgentCraft `ab08a02`'s rules (`Journal.java` and its tests, verbatim plus `PLACING` and interned state tags),
  stored per entry per 512x512 region with generations, the index as the commit point, a section map and an LRU cache
  (`journalCacheMb`, 64; `journalWarnMb`, 1024, in `architect-world.json`).
- Block states are kept as `NbtUtils.writeBlockState` writes them; in 26.x that is `{id, properties}` (the port's
  `Name/Properties` helpers were wrong; `Journal.AIR` never equalled a world value until the gate found it).
- Undo records and section sets use hash collections: `Map.copyOf` on packed block positions went quadratic (a 600k-cell
  undo planned for minutes).
- **The invariants (iii) and (iv) contradict each other** when a player edits a cell where a CELL entry lies over a BOX entry:
  with BOX undone first, the CELL entry keeps the player's block (iv); with CELL first, the BOX entry restores its before.
  The end state depends on the order. Resolution (closest to Steward's needs, which rely on iv: a player's block on a road or
  pad survives): (iv) holds as specified; (iii) is tested with player edits on cells whose entries are all CELL or all BOX,
  and the contradicting case has its own test (`JournalPropertyTest.theContradictionBetweenIiiAndIvIsReal`).

**Placement and removal**
- A single Place commits P3 and P7 synchronously (as 4d's synchronous snapshot write). Queue items commit off the server
  thread and wait for the commit inside the budget plus at most 6 ms (`PlaceJob.COMMIT_GRACE_NANOS`), so an item does not
  lose a tick per commit. The next batch item starts while the previous item's P7 commit is still on the I/O thread
  (its writes are done; it is PLACED at P8 as before), and a finished job's batch starts its next item in the same tick.
- A building's `after` (P6) is captured before the placement's deferred block ticks run: a few cells differ from it later
  (dirt_path under a solid block becomes dirt). BOX removal is unaffected; `dev.site.verify` reports such cells.
- Large sites (restore box over 100k cells, the size cap) are removed over ticks (`Sites.removeLarge`, a `RestoreJob`): the
  undo is planned per section across ticks after its region files are read off the server thread, its commit is built
  off-thread, the restore template is prepared off-thread, and the edge shape update runs face by face.
- A large batch item (design box over 100k cells) has its template grid warmed off-thread, its checks in one tick and its
  start (reusing that plan) in the next. Terrain checks read through the column's chunk; leaf scans skip sections without
  leaves.
- Large cell sites in a batch (over 50k cells): decoded, de-duplicated and sorted off-thread, the natural filter over ticks,
  the overlap test on occupied sections only, started a tick later without a second sort; their PLACING sections are built
  off-thread. Single `placeCells` calls are synchronous (one tick) as specified for INSTANT.
- Batch items read the journal regions under them off the server thread before their checks.
- The placement queue file is written off the server thread (it holds queued cell sites' cells); a clean stop writes it
  at once. Placement waits the first 40 ticks after a world start (the server's own first ticks reached 45 ms).
- A group removal is one undo; blockers are checked up front; the records go pending in one change of state.
- Removal blockers count a block entity in the site's journal `after` as the site's own (a LAYERed BOX site keeps what it
  stood on).
- The outside halves of tall plants a box cuts are guard cells of the site's `leaves` entry and are written back before the
  box; restores put back two-block plants and doors a box write lost (0.7.0 lost such plants).
- `undoStage(group, stage, RemoveOptions)` is an added overload (the covered policy for stages). `Sites.Removed.site` is null
  for road and cell-site results.

**Crash safety and settle**
- K4 (ACTIVE in the journal, the record still placing): the record is placed. K6 (undo committed, record not pending): the
  record follows the journal to pending, then the evidence decides. Pending roads and cell sites are settled at world start
  like sites (they were not before the gate). Group-undo evidence compares against the value the group wrote at a cell.
- Orphan generation files are deleted at open; an unknown entry's files are kept and listed.

**Roads, cell sites, layering**
- A road's handover to the road it crosses is its own commit, before the road's undo.
- Cell sites in a world where INSTANT is not allowed refuse `NOT_ALLOWED` regardless of the actor (SHOULD 2).
- Survival rule 3(b) refunds a covered cell only when the covering site displaced the block (the world no longer holds it);
  a block the covering site kept drops once, with that site's removal.
- `/architect remove <road> force` is CASCADE.
- LOAD_BOUNDED fairness: the first item that could not get its chunk tickets has the next ones.
- CASCADE on a road or cell site also removes the roads and cell sites on top (over ticks, before it).

**Gate setup**
- The fixtures stand on a flat meadow (`preset: flat`); normal worldgen near spawn was too steep for roads with at most 4 of
  cut/fill. Trees for the size-cap and leaf cases are placed with the worldgen tree features (`/place feature`), and the
  held-leaf cases use a normal world (seed `4e`).
- The kit has no lever: the "lever flipped in H" edit flips H's door (`open`, the same volatile-property rule).
- The 4d gate's lot L3 fails group-undo equality on the 0.7.0 jar too (worldgen gravel floating over a cave at the lot edge
  falls after the restore): a pre-existing limit, not a 4e regression.
- The 4d gate's group-undo equality also fails on other lots of other base worlds (a fresh world each run) for the same
  reason class: a worldgen block that cannot stand on its own after the restore (gravel over a cave, a brown mushroom in light
  after the house is gone) is written back and then breaks. The atomic path and the 0.7.0 jar lose the same cell
  (`artifacts/gate4e/regress4d-final/undodebug-atomic.json`, `v070/`): a known limit of exact Remove, not a 4e regression.

**MSPT: what broke 50 ms and why (the gate's mega-lite and size-cap runs)**
- A 655k-cell pad's start in a batch took 237-263 ms in one tick: decoding the queued cells, a boxed per-cell check and a
  boxed sort. Now staged (see above).
- The placement queue file was written on the server thread after every change and held the queued pad's cells (megabytes of
  JSON): 20-40 ms per save. Now written off-thread.
- A group removal marked 48 records pending one by one, saving the record file each time: 96 ms. Now one change, one save.
- A road or cell site's restore gathered its 655k undo cells on the server thread (25-35 ms). Now off-thread.
- After a relog the first ticks are the server's own warm-up (up to 45 ms) plus cold journal regions (a check decoding a
  pad's region): placement now waits 40 ticks after a world start and reads the regions under a batch item off-thread first.
- The size-cap keep: a cold template grid (118 ms), two checkSite passes, the undo plan (417 ms), its commit (199 ms) and the
  restore writes (776 ms) in single ticks; all spread or moved off-thread as listed above.

**Measured (final run, 82ec7b5; `artifacts/gate4e/REPORT.md`)**

| What | Budget | Measured |
|---|---|---|
| placement throughput at 4 ms (village + roads) | >= 15k cells/s | 16.6k cells/s (8.2k at 1 ms, 57.2k at 10 ms); probes 19.5-24.3k |
| MSPT, village + roads at 4 ms | max <= 25 ms | 12.7 ms |
| size-cap keep placed / removed | no tick over 50 ms | max 23 / 33 ms; with randomTickSpeed 300 by trees 25 ms |
| 304k-cell cell site placed / removed | no tick over 50 ms | 20 / 15 ms |
| mega-lite at 1 / 4 / 10 ms, group undo | no tick over 50 ms | 23 / 46 / 29 ms, group undo 14 ms |
| journal size | <= 10 bytes/cell | 256x256 pad 0.044, mega-lite 0.39, 1000x1000 0.40 bytes/cell |
| `Sites.stack()` at depth 4 | recorded | p50 1.08 µs, p99 1.46 µs |
| 1000x1000 generator (recorded) | | 11.57M cells in 33.6 min at 4 ms with LOAD_BOUNDED 64; 11 of 610 lots timed out NOT_LOADED; MSPT max 237 ms while the server generated unexplored terrain |


# Phase 5a contract: critique loop and eval harness (A4 + R8) - FROZEN after Steward review

Goal: **designs get better without a person reviewing each one, and we can measure it.** After a design renders, a
cheaper critic looks at fixed renders plus the blueprint summary, the brief and the style bible, and returns a structured
verdict. The designer revises on that verdict until the critic ships it, a round cap or a budget stops it, and the best
version installs. An eval harness scores a fixed brief set with the checker, the critic and a blind pairwise judge, stores
the results, and compares versions. It also gives Steward the Opus vs Sonnet numbers it asked for (R8).

5a also closes two carried items: the 4b quality note ("the bible set is cluttered and less legible") and the 4e caveat
(no migration unit tests).

Versions: API **1.6.0**, mod **0.9.0**, sidecar protocol stays **2** (additive messages, new feature names, as in 4b-4c).

## What Steward asked for (summary of steward-mc/docs, read only)

- **A4** (ARCHITECT-ASKS): render, Claude reviews its own iso/top/front images and its neighbours', revises, bounded
  rounds. "Quality without a human per building"; the same pattern as AgentCraft's design-critic.
- **R8**: an eval harness. A prompt set scored by the checker plus the critique, re-run when the prompts, the bible format or
  the model change. Steward needs it for the Opus vs Sonnet tier decision.
- **A5B-SPEC §5**: for region programs (phase 6) the reviewer also looks at top-down and section previews plus the checker
  output. Not in 5a (no region programs yet), but the critic's inputs are a list of views so phase 6 can add them.
- **BUILDER-TOOLING.md** (unverified research): textured renders (block-model-renderer), layered ASCII slices in the critique
  prompt, deterministic facing and attachment checks, the GDMC rubric (adaptability, functionality, narrative,
  aesthetics), MineCEraft-style verifiable instruction categories for the eval set, a HeadlessMC nightly.
- **skills/minecraft-structure-design**: a playbook (SKILL.md) written for Architect's design agent, plus `slices.mjs`
  (layered ASCII) and `attach-lint.mjs` (support, halves, open doors, hanging lanterns). Steward's notes: copy SKILL.md
  into each scratch dir and name it in BRIEF.md, never load it through `settingSources`; drop §7 (regions) until A5b;
  the scripts may become kit tools and the rules kit checker warnings.
- **Steward PLAN**: critique is part of every building job in its pipeline ("checker, render, critique, revise");
  style coherence is to be measured; cost is a product constraint (an 8-20 building settlement is $12-50 and 30-90 min
  today).

## Measured costs this contract builds on

| What | Measured | Source |
|---|---|---|
| Opus design | $2.0-3.2, 8-13 min | 4b seeds; 4c detail pass $3.40 / 13.8 min |
| Sonnet design | $0.8-2.5, 4-10 min | 4b gate (4 designs) |
| Bible job | $1.2-2.0, 5-8 min | 4b ($1.40 / 6.4 min) |
| Massing | $0.1-0.4, 1-3 min | 4c ($0.21 / 0.9 min, redirect $0.17) |
| Structured job, text only, Sonnet low | $0.011-0.019, 2 turns | 4a |

Price list used for the new seeds (Claude API rates; under the claude login they are notional): Sonnet 5.5 $2 / $10 per
MTok in/out, Opus 5.5 $4 / $20, cache reads $0.20. A 1000x800 PNG is about 1,100 input tokens.

---

## The critique loop

### Where it runs

A design job today: designing -> checking (pristine kit) -> rendering -> install. With critique on:

```
designing -> checking -> rendering -> critiquing --ship--------------------------------> install the best round
                                          |
                                          +--iterate--> designing ("revising after critique") -> checking -> rendering -> critiquing ...
```

- **Round 0** is the design as it is today (it passed the check and rendered). Each **revision** is one more designer turn
  in the same SDK session (warm cache), followed by the usual check and render, then a critic call.
- `DesignStatus` gains `critiquing`. Protocol-1 clients see it as `rendering` (`toProtocol1`), with the step text.
- Every round that passes the check is kept in the scratch dir: `rounds/<n>/` holds the `.nbt`, the sidecar JSON, the
  previews and the verdict.
- **Install the best round:** the passing round with the highest sidecar-computed `overall` (ties: the later round). The
  library never sees intermediate rounds.

### The critic

| | |
|---|---|
| Model | `claude-sonnet-5-5` (config `critique.model`), effort `medium` |
| Call | a `structured` job inside the sidecar (`outputFormat: json_schema`, `tools: []`), a **fresh query per round** (no session), so it doesn't defend its earlier verdict |
| Images | sent as image content blocks in the SDK user message (see "Images in jobs"). Fallback if a probe shows that path fails under the claude login: an agent turn whose only tool is Read, restricted to `critique/<round>/` |
| Max turns | 3 (one schema re-ask) |
| Seed | $0.04-0.15 and 0.5-2 min per call (about 8-14k input tokens, 2-5k output with thinking); measured in the smoke tier |

**Inputs, all fixed per design:**
- **Renders**, from fixed cameras: `iso` (front-left, today's), `iso_back` (back-right, new), `front`, `top`, `cutaway`
  (lowered near walls, today's `--cutaway`). Flat-colour renderer, 1000 px wide. `critique.views` can drop views; phase 6
  adds `section`.
- **Neighbour renders** for a group item: at most 4 `iso` PNGs of finished siblings, as 4b already passes to the designer.
- **Blueprint summary** (JSON, at most 4k chars): type and profile, size and `maxSize`, `front`, named parts (name, box,
  cells), the 12 most used blocks with counts, checker warnings, the new attach and facing warnings, massing conformance,
  and the metrics `accentShare`, `detailNoise` and `windowsPerFacade` (see "Bible-set clutter").
- **Layered ASCII slices** (`kit/tools/slices.mjs`): the floor row and the eye-height row of each storey, at most 6 layers
  and 8k chars. They make doors, stairwells and holes exact where the flat renders are vague.
- **The brief:** the request text, type, size, notes, group context (4c item 4).
- **The style bible:** `bible.json` and `bible.md`, not `components.mjs`.
- **Round 2 and later:** the previous round's issue list, so the critic can mark issues resolved. It never sees the
  designer's transcript or the `.mjs` source; it judges what was built.

**Verdict (the JSON schema; the sidecar validates it again):**
```
{ "scores": { "silhouette": 1-10, "legibility": 1-10, "craft": 1-10, "materials": 1-10, "brief": 1-10,
              "bible"?: 1-10, "set"?: 1-10, "interior"?: 1-10 },
  "issues": [ { "priority": "P0"|"P1"|"P2", "part": "<a named part>" | null, "view": "<a view name>",
                "what": "<=200 chars", "fix": "<=200 chars" } ],      // at most 6, worst first
  "resolved": [<index into the previous round's issues>],
  "verdict": "ship" | "iterate",
  "summary": "<=300 chars" }
```
- **Dimensions:** `silhouette` (massing and roof read as the type), `legibility` (doors, windows, entrance readable; no
  noise), `craft` (no floating or stray blocks, finished corners, facing right), `materials` (three-tone hierarchy, palette
  and roles), `brief` (does what was asked). `bible` only with a bible, `set` only with neighbours, `interior` only for a
  type with the `interior` rule. The GDMC rubric maps onto these (functionality is mostly the checker's job).
- **Parts (R3):** `part` must be one of the blueprint's part names, or null for the whole building. An unknown name becomes
  null with a note, and counts against the critic's part-grounding rate (an eval metric).
- **P0** = a player would call it broken (unreadable entrance, a floating mass, a hole in the roof the checker missed). P1 =
  clearly worse than it should be. P2 = polish.
- **The sidecar decides ship, not the model:** `overall` = the mean of the present scores. Ship when `overall >= shipScore`
  (default 7.0), no score is below `shipScore - 2`, and there is no P0. The model's own `verdict` is recorded and its
  disagreement rate reported in the eval.

### The revision turn

- The designer's session resumes with a prompt built from the verdict: the issues in priority order, with part and view;
  the scores; and the rules: fix every P0 and P1; keep the part names, the front and the size; **when the issue is clutter,
  remove before adding**; no new motifs; read `critique/<round>/` (the same PNGs the critic saw).
- It has its own check-fix allowance: up to 2 more turns if the pristine check fails. If it still fails, the loop ends
  with `check_failed` and the best earlier round installs. A failed revision never fails the design.
- `MAX_DESIGN_ROUNDS` (4) still bounds round 0's own check-fix turns; revisions don't spend it.

### Stopping

The loop ends at the first of:

| End reason | When |
|---|---|
| `ship` | the sidecar's ship rule holds |
| `max_revisions` | `maxRevisions` revisions done (default 2, at most 3), then one last critic call scores the final round |
| `budget` | the next revision plus critic would not fit: their seeded **high** estimate exceeds what is left of any cap (below). Not a failure: the best round installs |
| `time` | the loop has run `maxMinutes` (default 15) at a round boundary |
| `regressed` | a revision scored at least 1.0 below the best round so far; the best round installs |
| `check_failed` | see above |
| `critic_failed` | the critic call failed twice (schema, error); the best round so far installs, with a note |

### Budgets and cost

- **Caps on the loop's spend** (critic calls plus revision turns), the smallest wins:
  1. `critique.budgetUsd`, if set;
  2. otherwise **1.0x round 0's own cost**: by default the loop at most doubles a design's cost;
  3. what's left of the design's `budgetUsd` (hard) and of the group's budget (4b, `designBudget`).
- The SDK's `maxBudgetUsd` still gets the remaining hard budget on every query, as today. Hitting the hard budget
  mid-revision installs the best round with end reason `budget`; it doesn't fail the design, unlike a hard stop in round 0.
- **Group soft budget** (4b item 3): once reached, items mid-loop finish the round they're in and then end with `budget`. No
  new revision starts in a `paused_budget` group.
- **Usage limits** hold critic calls and revision turns like design turns (`held_usage`, group-wide). The loop state is in
  `DesignWork.critique` (rounds, the best round, the pending step) and resumes after a sidecar restart: a critic call with
  no stored result runs again; a revision resumes its session (`RESTART_PROMPT`).
- **Concurrency:** an item keeps its design slot for its whole loop (the critic is a short call inside it). Simple and fair
  across groups; wall time grows by the loop's time, and the estimate says so.
- **Cost reporting:** `Design.cost` stays the total. New `Design.critique.cost` splits it as `{critic, revise}`. Group cost
  aggregates as today.

**Seeds** (per call or turn, until measured; `Estimates` gains the kinds `critic` and `revise`):

| | Cost | Time |
|---|---|---|
| critic call (Sonnet 5.5, medium) | $0.04-0.15 | 0.5-2 min |
| revision turn, Sonnet design | $0.25-0.9 | 2-5 min |
| revision turn, Opus design | $0.5-1.5 | 3-7 min |

- **Estimate with critique:** low = round 0 plus 1 critic call (ships first time); high = round 0 plus
  `maxRevisions x (revise + critic) + 1 critic`, clipped by the caps. Default loop, Sonnet: +$0.04 to +$2.25 (capped at 1.0x
  round 0); Opus: +$0.04 to +$3.45 (capped likewise). The basis line names the critique and its cap.

### Opt-in vs default

- `critique.mode`: `off` | `report` (one critic call, no revision: scores and issues for about $0.1) | `loop`.
- **API default `off`.** A caller opts in per design request, per group or per group item (the item's spec wins). Steward
  turns it on where it wants it.
- **UI default:** `off` until the gate passes; then the Design tab's "Critique and revise" toggle defaults on for single
  designs and sets (open question N1). The toggle shows the estimate with and without it.
- **Massings:** `critique` on a massing request is allowed with its own rubric (`silhouette`, `brief`, `site fit` from the
  group context), `maxRevisions` default 1, default off. It's useful with `approvalUi: "owner"` groups that auto-approve.
- **Bible jobs:** with critique on, the bible job ends with one `report` call on `sheet.png` (component legibility and
  restraint), stored in `bible.json.critique`. About $0.05.

### Blind and non-blind

- **The in-loop critic is not blind:** it knows the brief, the bible, and (from round 2) the previous issues. It is the
  designer's reviewer, not a judge of the loop.
- **The eval judge is blind** (see the eval harness): it sees two render sets labelled A and B with neutral file names,
  in random order, judged twice with the order swapped. It isn't told that either is a revision, sees no critique text and
  no round numbers, and is a different model (Opus 5.5) from the critic (Sonnet 5.5), to limit self-preference and the
  loop learning to please one reviewer.

### Report-only critique of a library entry

`design.critique { entryId, spec: { mode: "report", ... } }` -> ack `{designId}`. It runs one critic call on the entry's
installed files (re-rendering the views it lacks) and writes `<entry>/critique.json`. No new entry, no Claude design turn.
This is for players ("how good is this?") and for scoring old designs, e.g. the 4b sets, in the eval. A "polish" action
that revises an existing entry is deferred.

### Images in jobs (`job.run`, also used inside the sidecar)

`JobSpec.images?: [{ blob: blobId, label: string }]`: at most 8, PNG or JPEG, each at most 5 MB. The sidecar sends them
as image content blocks before the prompt text. Feature `job.images`. The first build step is a probe: one structured
job with 2 images under Noah's claude login (about $0.02). If the SDK path refuses images there, critic and judge take the
Read fallback, and `job.images` ships only once it works.

### Kit additions (renderer and checker)

- `render.mjs --views iso,iso_back,front,top,cutaway` (default unchanged: iso, top, front). `iso_back` is the iso camera
  turned 180 degrees.
- From Steward's skill, owned by Architect from now on (header notes the origin): `kit/tools/slices.mjs` and
  `kit/PLAYBOOK.md` (SKILL.md without §7, paths changed to `kit/tools/`). The playbook is copied into every scratch dir with
  the kit and named in BRIEF.md, never loaded via `settingSources`.
- **New checker rules, as warnings** (the phase 1 rule): `attach` (ladders, wall torches, wall signs and wall banners have
  a solid block behind them; door and bed halves are complete; doors written closed; hanging lanterns hang from something),
  ported from `attach-lint.mjs`, and `facing` (a door leaf doesn't open into a wall; a bed's head against a wall; roof
  stairs on a slope face up-slope). They're promoted to errors only after a full eval shows zero false positives on the
  brief set and the kit examples.
- **New metrics** in the check's JSON output, recorded and passed to the critic: `accentShare`, `detailNoise`,
  `windowsPerFacade`, `paletteAdherence` (the share of cells whose wood and stone families come from the palette or the
  bible's roles). They give warnings only against a bible's `restraint` (below).

### Protocol (2, additive)

- `DesignRequest.critique?: CritiqueSpec`, `GroupRequest.critique?` (the default for items), `GroupItemInput.critique?`.
  ```
  CritiqueSpec = { mode: "off"|"report"|"loop", maxRevisions?: 0..3 (2), model?: string, effort?: low|medium|high (medium),
                   budgetUsd?: number, maxMinutes?: number (15), shipScore?: number (7.0),
                   views?: [view], neighbours?: boolean (true in groups), extraCriteria?: [string <= 200 chars] (<= 3) }
  ```
- `Design.critique?: { mode, rounds: [{ n, verdict, overall, scores, issues, resolved, cost, ms, kept: boolean }],
  best: n, end: EndReason, cost: { critic, revise } }`. `GroupItem.critique?` gives the same summary (rounds, best, end,
  overall).
- `Design.status` gains `critiquing`. Steps: `critic: round 1`, `revising after critique (1 of 2): 3 issues`,
  `critique: shipped at round 1 (7.6)`.
- `design.critique { entryId, spec }` (report only, above).
- `design.estimate` / group estimates take the critique spec.
- `JobSpec.images` (above).
- Bible additions: `bible.delete`, `bible.archive`, and `BibleInfo.restraint`, `BibleInfo.archived` (see "Bible-set
  clutter").
- Snapshot features: `critique`, `critique.report`, `job.images`, `bible.admin`, `bible.restraint`.

### Java API (1.6.0)

- `CritiqueSpec` (record plus builder) and `enum CritiqueMode { OFF, REPORT, LOOP }`; `DesignRequest.critique(CritiqueSpec)`,
  `GroupRequest.critique(...)`, `GroupRequest.Item.critique(...)`.
- `record Critique(List<Round> rounds, int best, EndReason end, double overall, Map<String,Integer> scores,
  List<Issue> openIssues, Cost critic, Cost revise)`, with `Round`, `Issue(Priority, @Nullable String part, String view,
  String what, String fix)` and `enum EndReason { SHIP, MAX_REVISIONS, BUDGET, TIME, REGRESSED, CHECK_FAILED, CRITIC_FAILED,
  OFF }`.
- `Design.critique()` / `Group.Item.critique()` / `Library.Entry.critique()` -> `Optional<Critique>`.
- `Designs.critique(String entryId, CritiqueSpec)` -> `CompletableFuture<Critique>` (report mode).
- Event `DESIGN_CRITIQUED(designId, Round)` once per round; `DESIGN_DONE` carries the final critique.
- `Jobs`: `JobSpec.images(List<ImageRef>)`.
- `Bibles.delete(id, @Nullable owner)` and `Bibles.archive(id, boolean)`; `Bible` gains `restraint()` and `archived()`.
- Features `critique`, `critiqueReport`, `jobImages`, `bibleAdmin`, `bibleRestraint`.
- **Not purely additive** (the 1.1-1.5 precedent): `Design.Status.CRITIQUING` is inserted before `DONE` (ordinals shift,
  exhaustive switches break), and records gain components (old constructors kept).

### UI

- Design tab and the set dialog: a "Critique and revise" toggle, a max-revisions choice (1 or 2) and the estimate
  including it.
- Designs tab: per design, the rounds with `overall` and the end reason; the best round is marked.
- Library entry details: the final scores and the open issues (unresolved P1/P2); a "Critique" entry action (report mode,
  shows its ~$0.1 estimate).

---

## Bible-set clutter

**What the carried item means.** PLAN's "the bible set is cluttered and less legible" is the 4b quality note about the
**designs built with the bible** (gate4b-real REPORT and blind CRITICS.md: scattered red trim and dark bundle blocks, moss
floating on roofs, few readable windows, heavy roofs hiding walls), not about too many bible files. The Mosswater bible
had 7 motifs, 9 components and "avoid large window walls", and the designer prompt says "follow it over your own taste".
5a fixes it in three places, and also adds the library hygiene the request asked about.

1. **The critique loop:** `legibility` and `craft` are scored dimensions, and the revision rule for clutter is "remove
   before adding".
2. **Restraint in the bible** (bible format 2):
   - `bible.json` gains
     `restraint: { heroMotifs: [<= 3 of motifs], accentShareMax: 0.04-0.20 (0.12), detailDensity: "sparse"|"moderate"|"rich" ("moderate"), windowsPerFacadeMin: int (2) }`.
   - `motifs` drops from at most 8 to at most 6, and the components to the 5 required plus at most 3.
   - The bible author's prompt: a bible is a restraint as much as a palette; pick at most 3 hero motifs; each motif must
     read at one block's scale.
   - The design brief: hero motifs on every building, other motifs at most once per building, never an unsupported motif
     block, windows readable from `front`.
   - Kit warnings when a design breaks its bible's `accentShareMax` or `windowsPerFacadeMin`, or when `detailNoise` is over
     the level its `detailDensity` allows (thresholds set from the 4b sets plus the eval's round-0 designs before the
     gate, then frozen).
   - Format 1 bibles read with defaults (hero motifs = the first 3 motifs). `bible.revise {id, notes}` writes a format 2
     version; re-skins keep working, since roles don't change.
3. **The sheet critique** at bible creation (above).

**Library hygiene:**
- `bible.archive { id, archived }`: hides the bible from the pickers. Its entries and re-skins are unaffected.
- `bible.delete { id }`: refused while any library entry, unfinished group or massing pins any of its versions (the error
  lists them), or for another owner's bible without that owner. Otherwise it removes `<bibles>/<id>/`. No force flag.
- **Version GC:** a version that is neither the latest nor pinned by anything, and is older than 30 days, loses its
  `versions/<v>/` folder at sidecar start. Pins always win.
- Consolidating near-duplicate bibles = archive one, and `bible.revise` the other with notes. No automatic merge.

---

## The eval harness (R8)

### Layout

```
eval/briefs/v1/<briefId>.json       the brief set, versioned; a change makes v2 (the set's hash is in every result)
eval/fixtures/bibles/mosswater/     the 4b bible (format 1) and a format 2 revision made in the gate: no bible cost per run
eval/results/<label>/summary.json   committed: metrics per brief, the aggregates, versions and hashes (small, no PNGs)
artifacts/eval/<runId>/             local (gitignored): per brief every round's nbt, previews, verdicts, the judge's verdicts, logs
tools/eval.mjs                      the runner
```

### The brief set v1 (18 briefs)

| # | Brief | Type | Size | Biome / setting | Model |
|---|---|---|---|---|---|
| 1 | woodcutter's cabin | cabin | S | taiga | Sonnet |
| 2 | farmhouse with a porch | house | M | plains | Sonnet |
| 3 | watchtower on an 11x11 plot | tower | plot | mountains | Sonnet |
| 4 | spice shop with an awning | shop | M | desert | Sonnet |
| 5 | coaching inn | tavern | L | plains | Sonnet |
| 6 | cattle barn | barn | L | savanna | Sonnet |
| 7 | smithy with a forge yard | smithy | M | badlands | Sonnet |
| 8 | mountain chapel | chapel | M | snowy slopes | Sonnet |
| 9 | gatehouse on a 15x9 plot | gatehouse | plot | forest | Sonnet |
| 10 | hellish lair | open: `hellish_lair` (door, lit, no_floating) | L | nether | Sonnet |
| 11 | lighthouse | open: `lighthouse` (door, floors_reachable, tall:3) | M | beach | Sonnet |
| 12 | windmill | open: `windmill` (door, roof_closed, lit) | M | meadow | Sonnet |
| 13 | stilt house | house | S | jungle | Sonnet |
| 14 | mining hall | open: `mining_hall` (door, lit, passage:3x3) | L | badlands | Sonnet |
| 15 | tea house | house | M | cherry grove | Sonnet |
| 16-18 | Mosswater set: tavern (anchor), house, tower | group with the bible | L, M, M | swamp | Opus anchor, Sonnet items (product defaults) |

- Each brief file pins the request (prompt, type, size, profile, notes), the model and effort, and for 16-18 the group
  spec (waves, neighbours).
- **Smoke tier subset:** 1, 3, 10, 13 (two presets, a plot, an open type; small sizes).
- **Model-tier subset (R8, recorded):** 5, 8, 10, 14 also run on Opus.
- Settlement-flavoured briefs from Steward's concept cards can join as v2 (S6).

### How one brief runs (paired, so it's frugal)

The runner submits the brief with `critique.mode = "loop"`. **Round 0 is the no-critique design** (identical to what
critique off would produce), so one run gives the pair **round 0 vs final** with no second design. Briefs that ship at
round 0 have no revision; they're counted, and they leave the pairwise test (identical designs).

### Metrics (per brief, per round where it applies)

| Metric | From |
|---|---|
| conformance errors and issues (massing pass only; v1 has none) | checker |
| checker errors, and warnings by rule (attach and facing included) | pristine check |
| `paletteAdherence`, `accentShare`, `detailNoise`, `windowsPerFacade`, parts count, cells outside parts | kit metrics |
| critic scores per dimension, `overall`, P0/P1/P2 counts, part-grounding rate, model vs sidecar verdict disagreement | in-loop critic (not blind) |
| blind pairwise preference final vs round 0: win, loss or tie, margin, reasons per dimension | judge (blind) |
| cost (round 0, critic, revise; cache tokens) and wall time per step | sidecar |
| end reason, revisions, the best round | sidecar |
| estimate vs measured (cost, time) | `design.estimate` before submit |

### The blind pairwise judge

- A `structured` job with images, `claude-opus-5-5`, effort `medium`.
- Input: two sets of the same 5 views, named `A_iso.png`... and `B_iso.png`..., plus the brief text only (no bible prose,
  no critique, no scores).
- Output: `{ preferred: "A"|"B"|"tie", margin: "slight"|"clear"|"strong", dimensions: { silhouette, legibility, craft,
  materials, brief: "A"|"B"|"tie" }, reasons: "<= 400 chars" }`.
- **Each pair is judged twice, with the order swapped.** A brief is a **win** when both calls prefer the final, a **loss**
  when both prefer round 0, otherwise a **tie**.
- About $0.08-0.12 per call, so about $0.20 per brief.

### The runner (`tools/eval.mjs`)

- `run --tier sim|smoke|full [--label <name>] [--briefs 1,3] [--max-usd N] [--models opus-subset]`
  - It starts its own sidecar (no game) on a free port with `--backend claude --use-claude-login`, or `--backend sim` for
    `--tier sim`, and drives it over WebSocket protocol 2, as the 4b and 4c real runs did.
  - **Auth guard:** a real tier refuses to start if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set in its environment
    or the sidecar's config holds a key. Gate and eval runs use Noah's claude login only, never an API key.
  - **Spend guard:** it stops submitting when the cumulative SDK cost estimate plus the next brief's seeded high would
    pass `--max-usd` (default: the tier's cap). Running items get the remaining cap as their budget.
  - Usage limits: the runner waits through `held_usage` and resumes. It is restartable (`--resume <runId>`); finished
    briefs are never re-run.
- `rescore <runId>`: recomputes every deterministic metric from the stored artifacts. $0.
- `rejudge <runId> [--briefs]`: runs the pairwise judge again on stored renders, judge cost only (measures judge
  stability).
- `compare <runA> <runB>`: matched by brief id. Deterministic deltas per brief and in aggregate; optionally (`--judge`) a
  cross-version blind pairwise of the two runs' finals (judge cost only, about $0.20 per brief). The verdict:
  - **regressed** if A's finals beat B's by the sign test (one-sided, alpha 0.05), or a hard metric got worse (any
    checker error; mean warnings +25%; mean cost or time +30%; mean `paletteAdherence` -5 points);
  - otherwise **no regression**, with the deltas.
- **Reproducibility:** every result records the sidecar and kit versions; hashes of the brief set, the kit, the design
  system prompt, the brief template, the critic and judge prompts and schemas; model ids, efforts and the config. The
  renders are deterministic from the `.nbt`; model outputs aren't, so reproducible here means the same inputs are pinned
  and the stored outputs can be re-scored and re-judged.
- **When to run (R8):** smoke after any change to the design, bible, critic or judge prompts, the bible format or a
  default model, compared against the last stored smoke; full when the smoke flags a regression or before a minor release
  that changes them. CI can't call Claude; the sim tier runs in CI.

### Tiers and their cost

| Tier | What | Expected | Cap |
|---|---|---|---|
| sim | the 18 briefs on the sim backend with scripted critic and judge verdicts; tests the harness | $0 | $0 |
| smoke | briefs 1, 3, 10, 13 on Sonnet, `maxRevisions` 1, judged | ~$5-9 (round 0 ~$0.8-1.5 each, loop <= 1.0x, judge $0.20) | $12 |
| full | the 18 briefs, `maxRevisions` 2, judged | ~$45-60 (round 0 ~$27 at a $1.5 Sonnet mean plus the Opus anchor; loop ~$14; judge ~$4) | $85 |
| model subset | briefs 5, 8, 10, 14 on Opus with the loop, judged vs their Sonnet finals | ~$18 | $26 |

---

## Migration unit tests (the 4e caveat)

4e shipped `JournalMigration` checked only by the in-game gate step. 5a adds pure-JVM tests to `./gradlew test`.

- **Seam:** `JournalMigration.run(MigrationWorld world, JournalStore store, Path worldDir, boolean late)`, with
  `interface MigrationWorld { @Nullable BlockState read(String dimension, BlockPos pos); boolean hasDimension(String dimension); }`.
  The production adapter wraps `MinecraftServer` (loads the chunk for the read, as today). No behaviour change; the 4e
  gate's in-game migration step re-runs as the regression.
- **Fixtures:**
  - `mod/src/test/resources/migration/v070/` holds files from the 4e-verify 0.7.0 world, trimmed
    (`architect-sites.json`, `architect-sites/*.nbt`, `architect-queue.json`).
  - A test helper writes synthetic 0.7.0-format files.
  - A vendored copy of 0.7.0's `Site.fileFromJson` / `fileJson` (`V070SiteFile`, test only) for the downgrade cases.
- **Cases** (one test each, from the migration table and its notes):
  1. an instant site -> an ACTIVE `site` BOX entry whose `before`s equal the snapshot's blocks and BE NBT;
  2. `architect_leafRing` -> the entry's `ring` table, unchanged;
  3. `heldLeaves` -> a `leaves` CELL entry, and a cell that is no longer a persistent leaf is dropped;
  4. a construction target -> the entry's `after` values, with the queue indexes remapped;
  5. a crate and a group's shared crate -> `crate` BOX entries in the right undo group;
  6. a `pending` site -> UNDONE entries, settled by the evidence rules;
  7. a `placing` site -> a PLACING entry, and the queue file unchanged;
  8. groups, stages and batches unchanged;
  9. unreferenced snapshot files not imported, but moved and listed;
  10. layers ordered by `placedAt`, each site's entries consecutive;
  11. an unreadable snapshot -> that site flagged, with no entry;
  12. an unreadable `architect-sites.json` -> nothing written;
  13. a fault at every I/O step of the migration commit and of the legacy move (`JournalStore.faultHook`) -> reopening
      gives either the pre-migration state (migration runs again) or the finished one, never a mix;
  14. late import of a 0.7.0-made record as the top layer;
  15. the `r<n>` / `c<n>` counters survive a 0.7.0 save that drops `infra`, and never collide;
  16. downgrade: `V070SiteFile` reads a 0.8.0 file and keeps the migrated records, its save drops `infra`, and 0.8.0
      rebuilds the infra records from the entries' `meta`;
  17. migrating twice equals migrating once.
- **Property test:** random 0.7.0 worlds (2-6 sites with random held leaves, crates, stages and pending states) -> migrate
  -> undo everything through journal planning in a random order -> the cells equal the original snapshots.
- At least 18 tests, all in CI.

---

## Phase 5a gate

Budget cap for the whole gate: **$120** (the SDK's cost estimate under Noah's claude login; notional plan usage, not
billing). The runner enforces it across tiers. Planned spend: probe ~$0.1, smoke ~$9, full ~$60, bible clutter ~$12,
other real checks ~$3, about $85; the model subset (~$18) runs last and only if it fits under the cap.

1. **Unit and sim (no Claude):**
   - sidecar tests for the loop on the sim backend, each a scripted verdict sequence:
     - ship at round 0;
     - iterate then ship;
     - a regression keeps the best round;
     - `max_revisions`, `budget` (the 1.0x default cap and an explicit `budgetUsd`), `time`, `check_failed` and
       `critic_failed`;
     - an unknown part name;
     - a restart mid-critic and mid-revision;
     - a usage hold mid-critic, group-wide;
     - a group soft budget stops new revisions;
     - a protocol-1 client sees `rendering`;
     - the estimate with critique;
   - kit tests for `--views`, slices, the attach and facing rules (the kit examples plus deliberately broken fixtures, as
     Steward's lint was checked) and the four metrics;
   - bible format 2 validation and defaults for format 1; delete refused while pinned; archive; version GC keeps pins;
   - the migration tests above;
   - `eval.mjs run --tier sim`, then `rescore` (byte-identical) and `compare` on two sim runs.
2. **Probe** (real, ~$0.1): one structured job with 2 images under the claude login. It decides image blocks vs the Read
   fallback.
3. **Smoke tier** (real, cap $12): its measured critic and revise costs replace the seeds before the full run. `rejudge` on
   the smoke run agrees with the first judging on at least 3 of 4 briefs (judge stability).
4. **Full tier** (real, cap $85, Sonnet briefs). **The bar:**
   - **G1, improvement (primary, blind):** among briefs with at least one revision (n of them, at least 12), final beats
     round 0 by a one-sided sign test at alpha 0.05 over the non-tie briefs (n=18 -> at least 13 wins; 16 -> 12;
     14 -> 11; 12 -> 10), with at most 3 losses.
     **Confidence statement:** a pass means the judge prefers the loop's output more often than chance (p < 0.05). With
     18 pairs the test has about 72% power for a true 75% win rate, so a modest real effect can fail; a fail is recorded
     as "not shown", not as "no effect". Fewer than 12 briefs with a revision means `shipScore` is too lax, and the gate
     fails.
   - **G2, the critic's own view (supporting):** the mean in-loop `overall` rises by at least 1.0 from round 0 to the
     installed round, and P0 issues at install are 0 in at least 16 of 18.
   - **G3, no deterministic regression:** 0 checker errors in every final; per brief, final warnings <= round 0's in at
     least 16 of 18, and the total doesn't rise; mean `paletteAdherence` doesn't drop by more than 2 points; every final
     has at least 2 named parts.
   - **G4, cost and time bounds:**
     - the loop's spend is within its cap for **18 of 18** (an invariant);
     - mean loop spend is at most 60% of mean round-0 cost;
     - mean added wall time is at most 8 min;
     - the estimate with critique is within ±50% of the measured cost for at least 15 of 18 designs and for the total.
5. **Bible clutter** (real, ~$12):
   - Mosswater revised to format 2 (`bible.revise` with consolidate notes, ~$1.5).
   - The 3-item set (briefs 16-18) run with the v2 bible and the loop.
   - A blind pairwise judge on each item, against the 4b set's renders (stored, $0 design): the new item wins at least 2
     of 3 on `legibility`.
   - Two `design-critic` agents, as in 4b, still say "set" at 7/10 or above.
   - `detailNoise` and `accentShare` are lower than the 4b set's, on average over the 3 items.
6. **Other real checks** (~$3):
   - one `report` critique of a 4b entry;
   - one massing critique (`maxRevisions` 1);
   - the bible sheet critique from step 5;
   - one design with `loop` requested through the Java API from `apitest` (the first real Java-path check of a design;
     4a-4c covered the Java side by sim only).
7. **Regression:**
   - every sidecar, kit and mod test;
   - the 4a jobs sim checks, the 4b 38 sim checks and the 4c 35 sim checks re-run;
   - **the 1.5.0 apitest jar, unchanged, passes against 0.9.0**;
   - the 4e in-game migration step (gate 4e item 4, without the downgrade) re-run on the new seam;
   - a dev-client screenshot of the Designs tab showing a design's critique rounds, which has been looked at.
8. **Recorded, not gated:**
   - the model subset: Opus vs Sonnet on briefs 5, 8, 10 and 14, with cost, time, the loop's effect and the cross-model
     pairwise;
   - whether the second revision adds value (wins of round 2 over round 1 where it happened); this decides the default
     `maxRevisions`;
   - the critic's part-grounding rate and its verdict disagreement.
9. gate-verifier checks the result, including that no real tier ran with an API key in its environment.

---

## Build order inside 5a

1. The image probe; `job.images`.
2. The kit: `--views`, slices, the attach and facing rules, the metrics, the playbook copy.
3. Migration tests (independent; can run in parallel with the rest).
4. The critic and the loop on the sim backend; estimates; the protocol.
5. Bible format 2, restraint, admin.
6. Java 1.6.0 and the UI.
7. The eval runner (sim), then smoke, calibrate the seeds and the clutter thresholds, freeze them, then the full gate.

## Open questions for Steward

- **S1.** Critique defaults to `off` for API callers; you opt in per group or item. OK, or do you want `loop` by default
  for groups?
- **S2.** You get the verdicts as data (`Critique` on designs, items and entries, `DESIGN_CRITIQUED` per round). Is that
  enough for your inbox or HUD?
- **S3.** `extraCriteria` (at most 3 short strings per item, e.g. "faces the street on the south side", "reads as a
  mine") join the rubric as an extra score. Useful, or should the critic read `GroupRequest.context` instead?
- **S4.** Neighbour renders are at most 4 iso PNGs. Do you need a site-plan view (a top-down composite of the lots) in 5a,
  or is that phase 6, with the A5B section previews?
- **S5.** Massing critique for `approvalUi: "owner"` groups that auto-approve: do you want it in 5a?
- **S6.** Will you send 4-6 settlement-flavoured briefs (concept-card outputs) for eval set v2?
- **S7.** Architect takes owned copies of SKILL.md (as `kit/PLAYBOOK.md`, without §7), `slices.mjs` and the attach rules
  (as checker rules). Changes flow back to you by message. Agreed?
- **S8.** Is `job.images` (images in `job.run`) useful to you beyond the critic, e.g. a concept card from a screenshot?
- **S9.** The model subset runs 4 briefs on both models, which is directional only. Enough for your tier decision, or do
  you want a dedicated run (about $30, outside this gate)?

## Open questions for Noah

- **N1.** After the gate, should the UI default "Critique and revise" to on (with `maxRevisions` from the round-2 data), or
  keep it off?
- **N2.** Is a $120 gate cap on your claude login OK? About $85 of mostly Sonnet use will likely hit plan usage limits;
  the runner waits through holds, so the gate may take a day or more of wall time.
- **N3.** The defaults `shipScore` 7.0 and "the loop at most doubles a design's cost" (1.0x round 0): OK?
- **N4.** `eval/results/<label>/summary.json` is committed to the public repo (brief texts, scores, costs; no PNGs, no
  personal data). OK?
- **N5.** Critic Sonnet 5.5 medium, judge Opus 5.5 medium: OK? A Sonnet judge would halve the judge cost, but it's the
  critic's model.
- **N6.** Textured renders (block-model-renderer, MPL-2.0, 26.x unverified) are deferred. Agree?
- **N7.** `bible.delete` has no force flag and refuses while anything pins the bible. OK?
- **N8.** The HeadlessMC nightly stays deferred. Agree?

## Deferred (recommended)

- **Textured renders** (verify 26.x and the asset licence first). The critic's view list is ready for them.
- **Polish of existing entries** (critique plus revision as a remix). 5a has report mode only.
- **Region and settlement critique** (top-down plan, section views, set-level revisions): phase 6 with A5b.
- **A HeadlessMC or GameTest nightly** as a slow in-game gate.
- **MineCEraft-style categories** in the eval (verify the reference first) and **hill-climbing prompts against the eval**.
- **In-loop critic panels** (several lenses per round): 2-3x critic cost for an unmeasured gain. Revisit with eval data.
- **Promoting the attach and facing warnings to errors** (after a clean full eval).
- **A dedicated Opus vs Sonnet run** (S9) and a **v0.8.0 vs v0.9.0 round-0 comparison** (the playbook's own effect, about
  $30): recorded later, not gated.
- **Not 5a:** the other 4e caveats (the thin 4 ms throughput margin, invariant iii narrowed, the 1000x1000 NOT_LOADED
  timeouts and terrain-generation ticks) stay with phase 6 as PLAN says.

## Coordinator decisions on Noah's questions (provisional; N2 waits for Noah)

- **N1** The UI default stays off after the gate; a settings toggle turns it on, and the default is revisited once real use shows its cost.
- **N2** Noah: run the gate on his claude login (subscription). The dollar figures are API-equivalent usage, not a bill. The $120
  cap stays as a guard on usage; holds that stretch the gate over more than a day are accepted.
- **N3** Yes: ship at a mean of 7 with no score below 5 and no P0 issue; the loop at most doubles a design's cost.
- **N4** Yes: commit small eval summaries (scores, costs, verdicts), no renders or transcripts. They hold no personal data.
- **N5** Yes: the critic is Sonnet 5.5 and the blind judge Opus 5.5.
- **N6, N7, N8** Yes: textured renders and the HeadlessMC nightly are deferred, and bibles have no force-delete.

## Changes from Steward's review of 5a (steward-mc/docs/A5A-REVIEW.md), all accepted

Where this section and the 5a text above disagree, this section wins.

- **Estimates (SHOULD 1).** Estimates return critique as separate fields (`critiqueUsdLow/High`, `critiqueMinutesLow/High`, per
  item and in total), next to the design figures, so a caller can show "with polish / without". When the soft budget is reached,
  critique rounds are the first thing dropped: no new critic call or revision starts, and the design installs as it is.
- **Group wall time (SHOULD 2).** The group estimate states its time with and without critique. An item **releases its design slot
  during the critic call** and re-enters the queue for its revision turn **ahead of items not yet started** (same session, kept
  alive). The gate records group wall time with critique for the Mosswater set.
- **Polish-ready report verdicts (SHOULD 3).** Report mode writes `<entry>/critique.json` (verdict, renders' hashes, the bible
  version, the entry revision). Its shape is the input a later "polish" job (critique plus a revision of an installed entry,
  deferred to 5b with delta apply) starts from. A stale verdict (entry revision changed) is marked stale, not reused.
- **S1** Off for API callers; per-item opt-in. Architect never loops a whole group by default.
- **S2** Verdicts as data, as drafted.
- **S3** `extraCriteria`: up to 3 per item, scored as their own rubric lines and shown to the critic and the judge.
- **S4** No site-plan view in 5a (phase 6, with section previews and Steward's lot rectangles).
- **S5** Massing critique with autoApprove: available, off by default.
- **S6** Eval set v2 adds Steward's 6 briefs (steward-mc/docs/eval-briefs-v2-candidates.json) as a separate tier, not in the
  5a gate's 18.
- **S7** Architect owns PLAYBOOK.md, slices.mjs and the attach/facing rules, with an origin note; changes are reported to Steward.
- **S8** `job.images` is a general input of structured jobs, not critic-only.
- **S9** The 4-brief Opus subset is directional. If it is ambiguous, a dedicated run follows the gate as a separate decision.

## Phase 5a as built (API 1.6.0, mod 0.9.0, recorded 2026-10-08)

Built on branch `phase/5a` (with `phase/5a-kit`, `phase/5a-mig` and `phase/5a-java` merged into it). The gate's numbers are in
"Phase 5a gate results" below and in `eval/results/{smoke,full,opus-subset}/summary.json`.

**Images and the critic**
- The probe passed (a structured job with 2 PNG image blocks under the claude login, $0.0098, `apiKeySource none`), so the critic
  and the judge send image content blocks; there is no Read fallback. `JobSpec.images` is checked at `job.run` (PNG or JPEG by
  magic bytes, at most 5 MB, at most 8) and the files are copied into the job's scratch `images/`.
- The critic is an internal structured job (`owner: "architect:critic"`, tag `design <id> round <n>`), so it shows in the jobs
  list and gets the job runner's hold, resume and budget for free; the sheet critique is `owner: "architect:sheet-critic"`. Internal
  jobs may carry more than 8 images (5 views plus up to 4 neighbours).
- `extraCriteria` are the score keys `x1`..`x3`. The massing rubric is `silhouette, brief, site`; the sheet rubric `legibility,
  restraint, craft`.

**The loop**
- One loop for both designers (`sidecar/src/critique.ts`, state in `DesignWork.critique`). A designer hands each passing round to
  `roundReady` and returns the new run outcome `critique`, which gives the pool slot back; the critic job runs off the pool; a
  revision re-enters its lane at the front.
- The loop cap (critique.budgetUsd, else 1.0x round 0) covers every critic call, round 0's included (the contract's "loop's spend"),
  and a revision turn's SDK budget is what is left of the caps minus a critic call's high seed, so the loop stays within its cap
  (18 of 18 in the full tier). The sim backend with no notional cost (simDesignUsd 0) has no loop cap.
- **Report mode ends with a new end reason `report`** (sidecar and API `EndReason.REPORT`, inserted before OFF): a report is one
  critic call, not a loop that stopped at `max_revisions`.
- `openIssues` (entry, API) are the best round's issues: a round's list holds only what is still open (`resolved` points into the
  previous round's list), so the contract's "unresolved P1/P2" is the best round's list. P0s, if any, are included.
- Groups: a massingFirst item's massings never carry the critique; its detail pass does (Design tab and set dialog alike). A
  revision waiting in a paused (soft budget) group starts and ends its loop with `budget` at once.
- Installed entries carry a `critique` summary in their blueprint JSON and `<entry>/critique.json` (format 1: entryRevision =
  sha256 of the .nbt, renders' hashes, the bible pin, the verdict, open issues). The API marks a critique.json whose entryRevision
  differs from the current .nbt as stale.
- Estimates: the design sample is round 0 only; critic and revision samples are their own kinds. Seeds calibrated on the smoke
  tier: critic $0.02-0.08 / 0.1-0.4 min, Sonnet revision $0.25-1.0 / 1-4 min, Opus revision $0.4-1.6 / 1.5-6 min (scaled, unmeasured).

**Bibles and the kit**
- Every new bible version is format 2 (the kit validates it); the drafted component list is the library (5 required plus at most 3).
  `archived` lives in `<bibles>/<id>/admin.json`. Pins for delete and GC: library entries, unfinished groups, unfinished single
  designs, open massings, unfinished bible jobs. GC runs at sidecar start only. `bible.delete` / `bible.archive` carry the bible id
  in `id`, which is also the envelope's correlation id (as `bible.revise` already did).
- Kit: `--views` (iso_back), `kit/tools/slices.mjs`, `kit/PLAYBOOK.md`, the `attach:` / `facing:` warnings (zero on every kit example,
  corner and preset; one real hit in the 4c design), the metrics, `--restraint`. `DETAIL_NOISE_MAX` frozen at sparse 0.32 / moderate
  0.42 / rich 0.5 after the smoke tier. **`accentShare` as specified does not measure the 4b clutter** (the clutter sat in the main
  roles: the 4b set scored 0.08-0.11 while the clean kit tavern scored 0.22); `detailNoise` is the metric that separates it.
- Migration seam: `JournalMigration.MigrationWorld` is a nested public interface; `MigrationWorld.of(server)` is the production
  adapter; 19 pure-JVM tests on synthetic 0.7.0 worlds (the 4e-verify world was gone) plus one real-file test from a phase-3 world.
  Fixed on the way: a pending site's layer is ordered by placedAt; the legacy move has fault points; unreferenced snapshots are
  listed in the plan notes.

**Java 1.6.0** (not purely additive, as in 1.1-1.5): `Design.Status.CRITIQUING` before DONE and `Critique.EndReason.REPORT` before
OFF shift ordinals; records gained components with the old constructors kept. `tools/api-compat.mjs` checks that every member the
unchanged 1.5.0 apitest jar references (466) and the whole 1.5.0 api surface (1088 members) still exist with the same descriptor;
the 1.5.0 jar passes its survival suite against 0.9.0 (`APITEST_API_VERSION=1.5.0`). UI: the critique toggle defaults off (N1), and
the Status tab's "Critique and revise new designs by default" turns it on (`config/architect_mc_ui.json`).

**The eval harness** (`tools/eval.mjs`): `run` / `rescore` / `rejudge` / `compare [--judge]`, plus `revise-bible` (the gate's format-2
Mosswater, kept in `eval/fixtures/bibles/mosswater/versions/2/`) and `clutter` (the judge against an older set's renders). The
summary is a pure function of the stored files (`rescore` is byte-identical). **The judge sees 4 views per set** (iso, iso_back,
front, top: 8 images, the job.images limit), not 5. A pair whose final is round 0 (the loop kept round 0) is `identical`: no judge
call, counted as a tie. The sim tier runs in CI (`sidecar/test/eval.e2e.test.ts`, on its own copy of the bundle).

### Phase 5a gate results (builder's run, 2026-10-08; $93.23 API-equivalent, claude login, cap raised to $150 by Noah)

| Item | Result |
|---|---|
| Probe | image blocks work under the claude login ($0.0098) |
| Smoke (4) | 2 wins, 1 tie, 1 identical; rejudge agreed 4/4; seeds calibrated, DETAIL_NOISE_MAX frozen |
| G1 | **not shown**: 18 revised, 7 wins / 6 losses / 5 ties (3 identical), p 0.50 |
| G2 | **fail**: critic mean 5.48 -> 5.76; P0 at install 0 in 16/18 |
| G3 | pass |
| G4 | pass: loop within cap 18/18, 52% of round 0, +3.2 min, estimate +-50% 16/18 and total +10.5% |
| Clutter | legibility 2/3, detailNoise and accentShare lower; design-critic "set" 8 and **6** (bar 7) |
| Other | report critique, massing critique (ended `budget` before a revision), a loop design through the Java API: ok |
| Opus subset | directional: Opus preferred 2, Sonnet 1, tie 1; Opus +33% cost |
| Regressions | all suites green; 4a-4c sim suites; the 1.5.0 jar against 0.9.0; the 4e migration step; UI walk-through |

## Phase 5a re-scope (Noah, 2026-10-08)

- The gate's spend cap was raised from $120 to **$150** API-equivalent on 2026-10-07; the gate spent $93.23.
- G1 was not shown (7/6/5, p 0.50) and G2 failed (+0.28). The critique **loop ships experimental**: off by default, labelled
  "(experimental)" in the Design tab, the set dialog and the Status-tab default, and in the README. Report critiques, the eval
  harness, bible format 2, `job.images`, API 1.6.0 and the migration unit tests ship as built (G3, G4 and all regressions passed).
- A later loop change is re-gated on the same 18-brief eval with the same G1/G2 bars; prompts are not tuned against the eval set.

# Phase 5b contract: delta apply and polish (A6, plus polish) - FROZEN after Steward review

Goal: **change a building without rebuilding it.** A library entry gets versions. A new version is compared with the old one
part by part and cell by cell. A placed site moves to the new version by writing only the cells that differ, as a new journal
layer that can be undone exactly. **Polish** is the first producer of versions: a critique, then a revision **confined to the
parts the critique named** ("edit, don't rebuild"). Polish is also the proposed fix for the 5a loop, so it is measured on
5a's 18-brief eval against the same bars.

5b also carries two small fixes from Steward's live check: the release build fails when the sidecar bundle is missing, and the
claude login is found when USER/LOGNAME are missing.

Versions: API **1.7.0**, mod **0.10.0**. The sidecar protocol stays **2**, with additive messages and new feature names, as in
4b-5a. Phases 1-5a still hold, except where this section changes them; where they disagree, this section wins.

Sources for this draft:
- `docs/PLAN.md`: the A6/5b row, the 5a status and re-scope, and the carried-forward items.
- `docs/CONTRACT.md`:
  - 4b: named parts (R3) and bibles;
  - 4c: massing conformance and the composite preview;
  - 4d: queue, groups, stages;
  - 4e: journal, layers, LAYER/covered, survival layering, K points;
  - all of 5a, including "Changes from Steward's review of 5a" (critique.json for polish) and the re-scope.
- Code at `main` (v0.9.0):
  - `kit/lib/kit.mjs` `part()` / `partBoxes()`: the per-cell part map exists only in memory; the blueprint JSON keeps `box`
    and `cells`, and the `.nbt` has no part ids;
  - `kit/lib/check.mjs` `parts`;
  - `sidecar/src/critique.ts` `writeEntryCritique` (format 1), `critic.ts` `revisionPrompt`, `designs.ts` `installDesign`
    (exclusive create, never overwrites), `claude/designer.ts` (the auth check that says "not logged in");
  - `mod/build.gradle` (the bundle is copied "when it exists");
  - `site/Site.java` (`Pin` = template fingerprint), `site/SiteJournal.java` (entries found by `entry.site`; kind is a
    free string), `journal/Journal.java` (`transfer` keeps layers; `absorb` is unused).
- The 5a full run's stored artifacts: `artifacts/eval/full-2026-10-07T2324/` (local).
- Steward, read only:
  - `ARCHITECT-ASKS.md` A6 and R3;
  - `A5B-SPEC.md` §2 `part(id)` ("renames are breaking") and §4 N7 ("a new change-set layer whose before includes the
    earlier layers");
  - `A5A-REVIEW.md` SHOULD 3 (polish = "make it less cluttered" = delta apply);
  - `PLAN.md` (Evolve, phase 3 "delta preview and apply", the risk note: REPORT critiques only, "polish later");
  - `mod/DEV.md` "Live card run" (the USER/LOGNAME observation).

## What Steward asked for (summary, read only)

- **A6:** diff the new build of a source against what is placed. The ghost shows added, removed and changed cells, and only
  the delta is applied. It builds on `Reconcile`.
- **R3:** named parts with stable ids, so patches stay local. A5B §2: "A6 diffs and patches by part; renames are breaking."
- **A5B N7:** a patch writes the new cells as a new change-set layer whose `before` includes the earlier layers, and Remove
  stays exact.
- **A5A-REVIEW SHOULD 3:** polish (critique plus a revision of an installed entry) soon, because "delta apply and 'make it
  less cluttered' are the same operation". critique.json is the polish input.
- **Steward PLAN, after 5a:** REPORT critiques on every item; "polish later" is a decision Steward wants to be able to
  make; free-text change requests ("add a library wing") and an approve-then-apply delta preview for its phase 3.

## Key decisions (each specified below)

| # | Decision |
|---|---|
| D1 | **Entry versions live in the entry**, and the id stays stable: `<id>/versions/<n>/`, as bibles do. The top-level files are the head version. A site pins `(entry, version)`. |
| D2 | **A blueprint delta is template against template in design coordinates.** The kit records a `frame` (the design origin) and a per-cell part map (`<id>.parts.nbt`) from 5b on. A change of `front`, or of the entrance's feet row, is refused. |
| D3 | **A site's delta is plan against plan.** The pinned version's instant-placement plan and the new version's plan are both computed on the pre-site terrain (the journal `before`s). Only cells where they differ are written. |
| D4 | **The delta layer is a BOX journal entry**, kind `delta`, in the site's undo group. That keeps it out of 4e's CELL-over-BOX conflict between invariants (iii) and (iv). |
| D5 | **Undo is last-in, first-out per site.** Revert to a version in the chain undoes the top deltas down to it; any other target is a forward delta. A middle delta is never undone alone. |
| D6 | **Player edits:** each delta cell is compared with the site's own top `after` (StillOurs). The default `KEEP` leaves the player's block and reports it. Unchanged cells are never written. |
| D7 | **Covered cells: REFUSE** (`COVERED`, listing the covering sites). Writing under a covering site is deferred to phase 6. |
| D8 | **Survival:** a delta is a construction delta. Its BOM is the delta only, and refunds cover the paid cells it replaces. **A survival revert is a paid forward delta, never a journal undo** (a free undo after refunds would duplicate items). |
| D9 | **Bounded history:** at most 6 deltas per site. The 7th folds the oldest into the base (journal `transfer`, layers kept), so stack depth stays within 4e's limit of 8. |
| D10 | **Polish = one targeted issue per step.** The issue must name a part. Changes are confined to that part (plus at most 2 new parts) by a deterministic scope check. A step is accepted only if a fresh critic marks the issue resolved. One polish installs at most one new version. |
| D11 | **The polish eval starts from 5a's stored round 0** (all 18 present, verified). It uses the same critic, judge, views and G1/G2 computation as built, and no round-0 spend. **The outcome decides polish's label, not the phase:** delta apply ships if its gate passes. |
| D12 | **Spend: expected about $58, cap $80, stated ceiling $100**, on the claude login only (the runner's auth guard). |

---

## 1. Entry versions and blueprint deltas

### Frame and part map (kit, from 5b on)

- **Frame.** The kit's `Blueprint` already takes `origin` (it shifts every design coordinate). The sidecar JSON now always
  records `frame: { origin: [ox, oy, oz] }`. A missing `frame` (every entry before 5b) means `[0, 0, 0]`.
  - Design coordinates: `d = t - origin`, where `t` is the template coordinate.
  - Two versions of one entry are compared in design coordinates.
  - The design brief and the polish brief say: "to grow toward -x, -y or -z, raise `origin`; never move existing
    coordinates."
- **Per-cell part map.** `node kit/build.mjs` also writes `<id>.parts.nbt`, a gzip NBT `{ names: [string], idx: int[] }`,
  with one `idx` per entry of the template's `blocks` list in order (-1 = in no part). It is a separate file, because
  vanilla structure loaders must keep reading the `.nbt` unchanged.
  - Installs, variants, re-skins and versions copy it.
  - Entries without one (before 5b, imports) get part labels **by box**, marked `approximate` in every delta made from
    them.
  - Polish never relies on box labels: it rebuilds the base from source (below), which writes the exact map.

### Entry versions on disk

```
<library>/<id>/
  <id>.nbt  <id>.blueprint.json  <id>.mjs  <id>.parts.nbt  <id>.preview-*.png  critique.json   the head version (layout as today)
  versions/<n>/   the same files for version n; immutable once complete; one folder per version n >= 1
```

- The blueprint JSON gains:
  - `version` (absent = 1);
  - `versions: [{ n, createdAt, by: "design"|"polish"|"revert"|"migrated", parent: n|null, designId?, summary (<= 200 chars),
    nbtSha256, criticHash? }]`, the lineage.
- **Pre-5b entries** are version 1, and their `versions/1/` is made at their first version bump, by copying the top level.
- **What reads where:**
  - The mod reads a site's pinned version from `versions/<v>/`, and the head from the top level (or from
    `versions/<head>/` when the top level is mid-repair, below).
  - Exports, vanilla tools and older mods (0.9.0) read the top level, which is always a complete head.

### Installing a version (sidecar; crash-safe order)

1. If `versions/<n>/` is missing (the first bump), copy the top level into `versions/.tmp-<n>-<rand>/`, then rename it to
   `versions/<n>/`.
2. Write version n+1 into `versions/.tmp-<n+1>-<rand>/` (exclusive create, as `installDesign` does), then rename it to
   `versions/<n+1>/`. **This rename is the commit point.**
3. Replace the top-level files, each by writing a `.tmp` and renaming it. The blueprint JSON goes last, with `version: n+1`
   and the lineage.
   - It carries the user metadata (`favorite`, `userTags`, `displayName`) and `ext`, read from the current top-level JSON
     immediately before the rename.
   - The mod owns those keys. On `entry.versioned` it re-applies its in-memory values if they differ, which closes the
     window in which an edit could be lost.
4. **Repair**, at sidecar start and at the mod's library load:
   - if the top-level `version` is less than the highest complete `versions/<m>/`, step 3 is redone from `versions/<m>/`;
   - `.tmp-*` folders are deleted.

**Refused:**
- polishing or revising a **bundled** entry (`bundled`: "make a variant first");
- an **imported** entry (`no_source`: it has no `.mjs`);
- a **massing** (massings keep their own 4c versions).

**Revert of an entry** (`entry.revert {entryId, toVersion}`) installs version n+1 as a byte copy of version k, with
`by: "revert"` and `parent: k`. History stays linear, and placed sites are untouched.

### Lineage and staleness

- **critique.json format 2** (the polish input, Steward SHOULD 3) adds `entryVersion` and `criticHash` (the hash of the critic
  system prompt, template and schema).
  - Each version keeps its own `versions/<n>/critique.json`; the top-level file is the head's.
  - A format-1 file reads as `entryVersion: 1`.
- **Stale** = `entryVersion` differs from the head version, **or** `entryRevision` (the `.nbt` sha256) differs, **or**
  `criticHash` differs from the current critic. A stale verdict is shown as "for v2; this is v3" and is never reused.
- **Variants and re-skins** are other entries with their own lineage. `variantOf` gains `variantOfVersion`. A new version
  of the base doesn't change its variants ("rebase variants" is deferred).

### Retention

- At most **32 versions** per entry. Garbage collection runs at sidecar start.
- A version folder is deleted when it is not the head, no site pins it (the mod reports pins at connect), no unfinished
  design or polish uses it, and it is older than 30 days.
- **Pins always win.** A site's pinned version is never collected, whatever its age or the count.

### The blueprint delta

`delta(A, B)` for two versions of one entry, both built with their recorded palette, values and bible pin. They are compared
in design coordinates.

- **Cells:** over the union of written cells (unwritten = "terrain stays", as in phase 1):
  - `added`: written only in B;
  - `removed`: written only in A;
  - `changed`: written in both, with a different state or block-entity NBT;
  - `unchanged`: written in both and equal.
- **Parts:** each cell carries `part(A)` and `part(B)`. Per part name:
  - `ADDED`: only in B;
  - `REMOVED`: only in A;
  - `CHANGED`: some cell of the part is added, removed or changed;
  - `UNCHANGED`.
  
  It also gets counts and its box in each version. A cell whose part changed name is counted under both names.
- **Frame checks:**
  - `front` must be equal, and the entrance's feet row (`groundY - origin.y`) must be equal; otherwise the delta is
    `frameKept: false` and every site apply refuses `FRAME_CHANGED`.
  - **The frame hint:** when more than half of the cells of `UNCHANGED`-looking parts fail to match, but some translation
    `v` (|v| <= 8 per axis) makes at least 90% of them match, the delta notes "frame moved by v: set origin, keep design
    coordinates".
- **Output** (`delta.json` in `versions/<n+1>/`, at most 64 KB; counts and boxes, no cell lists):
  `{ entryId, from, to, frameKept, parts: {name: {status, added, removed, changed, boxFrom, boxTo}}, added, removed, changed,
  unchanged, approximate, notes }`.
- **Two implementations, pinned equal:**
  - the kit's `kit/tools/diff.mjs`, used by the sidecar for polish scope checks, the delta summary and `entry.delta`;
  - the mod's `TemplateDelta` (Java), off-thread, which is authoritative for world writes.
  
  A fixture set (the gate's hand-written versions, plus every kit example against its param and palette variants) must
  give the same cell sets in both. It's a CI test.
- **Limits:** both templates within the 96x64x96 cap. `delta.json` at most 64 KB (cell lists are never stored; they're
  recomputed).

---

## 2. Delta apply to a placed site

### What a site stands at

- `Site.Pin` gains `version`. For a pre-5b pin it is derived once, as the stored version whose template fingerprint equals
  the pin's.
  - No match means `VERSION_GONE`: the site can be removed or placed again, but not updated.
- The site record gains `version` and `history: [{version, appliedAt, kind: placed|delta|revert|forward, deltaEntry?}]`.
  - The entries themselves are still derived from `entry.site`, as in 4e.
  - A record that a 0.9.0 save stripped of these fields is rebuilt from the `delta` entries' `meta`. The journal wins,
    as in 4e.

### The delta set (plan against plan)

For a site S at version a, applying version b:

1. **The pre-site view.** A read-only world view in which S's own entries are undone: the base `site` entry, its `delta`s,
   and their `leaves` and `crate` entries.
   - It is the world outside S's cells.
   - Inside them, it is the `before` of the lowest of S's cells at that position.
   - Other sites' cells read as they are now, so they count like terrain, as TerrainFit does under LAYER.
2. **Plans.** `plan_a` and `plan_b` are the **written cells** of an instant placement of each version at S's origin and
   rotation, computed against the pre-site view:
   - template cells, foundation fill, clears and approach, as `PlaceJob` orders them;
   - bed safety.
   
   Guard data (the leaf ring, held leaves) is **not** part of the plans. It depends on the living world (trees grow and are
   cut), so recomputing it would make spurious deltas. It is added only for growth (step 3).

   Version b's template is placed so that every design coordinate lands on the same world cell as in version a (frame
   aligned). Approaches follow the 4e road rule.
3. **The delta set** `Δ = { c : plan_b(c) ≠ plan_a(c) }`, where a cell a plan doesn't write takes the pre-site value.
   - "Removed" cells therefore go back to the ground under them, and growth gets its own foundation and approach from the
     original terrain.
   - **Guard cells** for growth are added as the 4e place path adds them: the row under new footprint columns, new held
     leaves, and the leaf-ring extension.
4. `plan_a` comes from the pinned version's files, not from the journal `after`. P6's `after` can differ in a few cells
   from the plan (4e as built: dirt_path turning to dirt one tick later), and using it would make spurious deltas. The
   journal `after` is used for the player-edit test only.
5. An empty Δ is not a refusal: the site's version becomes b, with a note "nothing to write".

### Refusals and waits (Verdict, before any write)

| Reason | When | In a queue |
|---|---|---|
| `FRAME_CHANGED` (new) | front, or the entrance feet row, differs | refuses |
| `VERSION_GONE` (new) | the pinned version can't be found | refuses |
| `SITE_BUSY` (new) | S is `placing`, `BUILDING` (a construction site or a construction delta not finished), or being removed | **waits** |
| `COVERED` (4e) | any cell of Δ is owned by another site's entry (S's cell is not on top). Lists the covering sites and cell counts | refuses |
| `OVERLAP` / `OVERLAP_BUSY` / `OVERLAP_OWNED` / `LAYER_DEPTH` (4e) | growth cells outside S's cells meet other entries; `DeltaRequest.overlap` (default REFUSE, LAYER allowed) applies as for placement | as 4e |
| `PLAYER_EDITS` (new) | `playerEdits: REFUSE` and any Δ cell fails "still ours" | refuses |
| `BLOCK_ENTITIES` (phase 1) | a container the player filled in a Δ cell (any mode) | refuses |
| `PLAYER_IN_BOX`, `OCCUPIED`, `NOT_LOADED` | over Δ plus guard cells only | waits |
| `CREATIVE_ONLY_BLOCK`, `NOT_ALLOWED` | survival rules, below | refuses |
| `JOURNAL_UNAVAILABLE` | as 4e | refuses |

### The journal entry

- **Entry:** `{kind: "delta", site: S, policy: BOX, layer: next, cells: Δ' ∪ shape guards ∪ growth guards, meta: {from: a,
  to: b, entryId, version b's fingerprint}}`.
  - Δ' is Δ minus the kept cells (below).
  - **Shape guards** are the face neighbours of Δ' that S owns, outside Δ'. Vanilla shape updates (see "Writing") may change
    them, so their `before` is captured with Δ', and a revert writes it back exactly.
  - `before` = the world at capture (P1, one tick up to 50k cells; sliced with change tracking above that, as 4e).
  - `after` = captured at P6.
- **Why BOX:** reverting a delta restores exactly the previous version, including cells the player touched after the apply.
  This is the same rule as Remove, and it keeps the delta out of 4e's CELL-over-BOX case, where invariant (iii) is
  narrowed.
- **Undo group:** S's undo group is now its `site` entry, its `leaves` and `crate` entries, **every `delta` entry**, and their
  own `leaves` and `crate` entries.
  - Remove of S undoes the whole group, which gives the pre-site terrain.
  - A revert undoes a suffix of the deltas (below).
- **Kind compatibility:** `kind` is a free string in the store, and 0.9.0 finds a site's entries by `entry.site`. So a 0.9.0
  Remove of an updated site undoes the deltas too. The gate checks this as a recorded step.

### Writing

- **Writes** go through the 4d/4e writers with the same FLAGS and per-cell post-processing as a placement of the cell.
  Deferred block ticks are held and released as in `PlaceJob`. Only Δ' and the guard cells are written.
- **Updates.** Template states are not final states. `TemplateWriter` (vanilla `placeInWorld`) runs
  `updateFromNeighbourShapes` and a neighbour update after each placed cell. So a fresh placement of b would reshape an
  unchanged fence, pane, wall or stair next to an added or removed cell, and the delta must do the same.
  - The post-pass (shape update at the edge, then `updateFromNeighbourShapes` and neighbour updates) runs for Δ' as
    `TemplateWriter` runs it for placed cells. Its updates reach the shape-guard cells (S's own neighbours) and terrain.
  - **Only cells owned by other sites are masked**, exactly as 4e's holes rule.
  - Shape-guard cells whose state changed are reported as `reshaped` (expected, not an error). E1 is the arbiter: the result
    must equal a fresh placement of b.
- **Block entities in unchanged cells are never touched**: a chest the player filled in an unchanged part keeps its items.

### Player edits

For each cell c of Δ that S owns (S's own top cell at c is the top of the stack), compare the world with the `after` of S's
top cell at c. The comparison is 4e's StillOurs, with the volatile list as amended by Steward S2.

| `playerEdits` | A cell that is no longer ours |
|---|---|
| `KEEP` (default) | Not written and not in the entry. Reported as `kept {pos, found, planned}`. The site counts it in `deviations`. |
| `OVERWRITE` | Written. The entry's `before` records the player's block, so a creative revert gives it back. In survival the player's block drops as an item (phase 3 rule), and survival never journal-undoes a delta. |
| `REFUSE` | The whole delta is refused with `PLAYER_EDITS` and the list. |

- Later deltas are always computed plan against plan and tested against S's top `after`. A kept cell therefore stays kept
  until the player puts the block back, or a delta with `OVERWRITE` runs.
- Cells outside Δ are never written, so the player's edits there survive any apply and any revert.
- **Remove is unchanged:** BOX writes the pre-site terrain over all of S's cells, under the same blockers as today.

### Covered cells and cells below

- **Above S** (another site X owns a Δ cell): refused `COVERED`. The fix is to remove X first, or to apply a version that
  doesn't touch those cells. A journal entry can't be slid under X: its layer would be above X's.
  - Writing under a cover means rewriting X's `before` and undoing that rewrite later, through every removal order. That
    is deferred to phase 6, where region deltas under lots need it (Steward S2).
- **Below S** (S stands LAYERed on a pad T): Δ's `before` at those cells is what the world shows, so the 4e rule
  ("before includes the earlier layers") holds unchanged. Growth onto T's cells needs `overlap: LAYER`, as placement does.
  Removing T and S works in any order through hand-down.

### Undo: revert, remove, history

- **Revert** (`Sites.revert(siteId, k)`):
  - **Creative, or wherever INSTANT is allowed for the actor (4a rules):**
    - if version k is in S's chain, the deltas above it are undone as **one** undo (R1-R5 of 4e, one commit). Their mutual
      hand-downs cancel, so the order inside doesn't matter;
    - otherwise it is a forward delta to k (as `applyDelta`).
  - **Survival (INSTANT not allowed):** always a forward **construction** delta to k (see Survival). It's paid for.
- **Last-in, first-out.** Only suffixes are undone. There is no API to undo a middle delta: hand-down would accept it, but the
  result would match no version.
  - Other sites' placements and removals may interleave freely; the 4e rules cover them.
- **Remove** S at any point: one undo of the whole group, then the pre-site terrain (BOX), as 4e.
- **History bound:** at most 6 `delta` entries per site (config `maxSiteDeltas`, 2-6). Applying one more first **folds the
  oldest delta into the base entry**, in the same commit as the new delta's PLACING entry.
  - Cells where the base has a cell: `before` stays the base's, and `after` becomes the delta's.
  - Growth cells move to the base with `Journal.transfer`, keeping the delta's layer as a per-cell override (4e).
  - No other active entry can lie between the base and its delta at a shared cell, because a delta never writes a covered
    cell. So the fold doesn't change any undo result except "revert to the folded version", which then becomes a forward
    delta. `SITE_UPDATED` notes "history folded (v2)".
- **Depth:** S's own entries at a cell are its base plus at most 6 deltas. Because of the fold, 4e's `LAYER_DEPTH` limit of 8
  per cell is never exceeded by S alone. Another site LAYERed above counts as usual.

### Crash safety (4e's sequences, applied to a delta)

| Step | What |
|---|---|
| D1 | Checks; plan Δ (off-thread for the template diff, one tick for the pre-site view); capture `before`; reserve the cells |
| D2 | Write the entry files (I/O thread) |
| D3 | **Index commit: `delta` entry PLACING** (with a fold, if any, in the same commit) |
| D4 | Site record `updating {to: b}` |
| D5 | Block writes (ticked under `placementBudgetMs`; persisted cursor) |
| D6 | Capture `after` |
| D7 | Commit: ACTIVE |
| D8 | Record `version: b`, history appended; `SITE_UPDATED` |

On a kill:
- **K1/K2** (before D3, or D3 to D4): nothing written; the PLACING entry is released at start, and the record stays at a.
- **K3** (during D5 or D6): a clean stop resumes from the cursor. An unclean stop rolls back: the undo of the PLACING delta
  entry writes its `before`s, the site is exactly at a, and the record goes back to a.
- **K4** (D7 to D8): the journal wins, and the record becomes b.

A revert is 4e's Remove sequence (R1-R5, K5-K7) over the suffix, with the record going to `reverting {to: k}`.

**World-start settle** (Reconcile, as 4e) for a pending revert: the evidence is counted over that delta's own uncovered cells
where `before ≠ after`.
- Most cells hold `before`: released, and the record goes to k.
- Most hold `after`: reactivated, and the record stays.
- Otherwise doubtful: kept for the next start.

### Survival

The invariant is **items in = items out** over any chain of applies, reverts and Remove (4e's rule, extended).

- **A built site only.** A site that is still `BUILDING`, or a construction delta that hasn't finished, is `SITE_BUSY`
  (queued items wait).
- **A construction delta** (D5 replaced). In one tick:
  - **Removed** cells (where `plan_b` is the pre-site value) are written at once and for free, as phase 3's clearing.
  - **Added** cells are cleared to air (free, no drops) and queued.
  - **Changed** cells **keep version a's block** and are queued as swaps, so a re-roof never leaves a hole while it
    waits for materials.
  - The entry's `after` (the target) is `plan_b`. It is computed, not captured, because nothing was written; the 4e
    note on deferred ticks applies.
- **BOM** = the sum over queued (added plus changed) cells of the item of `plan_b(c)`, with the obtainability map. Creative-only
  blocks refuse `CREATIVE_ONLY_BLOCK`.
- **Refunds:**
  - **removed** cells: at the start, the item of S's block, if the cell is paid and still ours;
  - **changed** cells: at the swap, the item of the replaced block, if paid and still ours;
  - kept (player-edited) cells are neither charged nor refunded.
  
  Refunds go to the crate as in phase 3 and 4d.
- **Crate:** a built site has no crate left, so the delta places a new one beside the approach end (phase 3 placement rule)
  as its own `crate` BOX entry in the delta's undo group. A group with `sharedCrate` uses the group's crate.
- **Paid/free per delta cell:** a bitset on the delta, as phase 3's `free`.
- **The builder** works in phase 3 order over the queue (bottom-up, supports before attachables, pairs together) under the
  4d time budget. A swap happens only when the new item is in the crate. When the queue is empty, the delta is `BUILT`, the
  crate gives back its leftovers and goes, and `SITE_BUILT` fires.
- **Remove during a construction delta:** a cell is refunded when the world holds the `after` of the **topmost of S's cells
  there that is built and paid**. An unbuilt delta cell doesn't count, so an un-swapped changed cell refunds version a's
  block, which was paid in the base. Then the pre-site terrain is restored (free). Rule 3(b) of 4e is unchanged.
- **Revert in survival = a forward construction delta.** A journal undo would put back blocks that were already refunded
  (a dupe), so it is never used in survival.
  - A delta built as construction is **never** journal-undone later, even if the toggle is switched off or the actor gains
    INSTANT. Its `revertible` is false for good, and only a forward delta goes back.
- **OVERWRITE in survival:** the player's block drops as an item.
- **Mined cells** are player edits: kept, not refunded (phase 3's no-dupe rule).

### The queue, groups and stages

- **`Batch.Item.delta`** (`DeltaRequest`): exactly one of `request`, `road`, `cells` and `delta` is non-null.
  - The mode is resolved at queue time (4d MUST 3).
  - `SITE_BUSY`, `OVERLAP_BUSY` and occupancy wait under `waitPolicy`.
  - `ITEM_PLACED` means "applied" for a delta item.
  - `cancelBatch` rolls back an in-flight delta (the undo of its PLACING entry), exactly.
- **Groups:** a delta's entries join S's undo group, so `removeGroup` is unchanged (one undo, exact).
- **Stages:** a stage may hold delta items, for example Steward's "upgrade" stage. `undoStage` on such a stage reverts each
  of its deltas.
  - Each must be its site's top delta. A later delta on the same site refuses without `force`, as 4d's dependency rule
    does.
  - `force` reverts the later deltas too.
  - In survival, `undoStage` of a delta stage queues forward construction deltas.
- **One site, one update at a time:** a second delta for the same site in a batch runs after the first, in list order.

### Performance budgets

| What | Budget |
|---|---|
| template diff (worker thread) | <= 50 ms for a 96x64x96 pair; never on the server thread |
| pre-site view, plan and growth terrain fit (server thread) | <= 5 ms for kit buildings, in one tick; sliced above 50k cells |
| capture, commit, I/O | 4e's budgets (<= 0.6 µs per cell to capture; I/O off-thread above 100k cells) |
| delta start for a kit building (checks, capture, commit hand-off) | <= 15 ms |
| throughput at 4 ms | >= 15k cells/s, journal included (4e's bar) |
| revert planning for a kit building | <= 10 ms |
| MSPT | no tick over 50 ms in any gate scenario. The 12-lot village delta batch at 4 ms: max <= 25 ms. A size-cap fixture with every cell changed, applied and reverted: no tick over 50 ms. |

### Preview and UI

- **Delta ghost.** The server computes the world-space Δ (and the kept cells) and sends it as
  `architect_mc:delta_preview {siteId, to, sections: [{key, cells: short[], kind: byte (added|removed|changed|kept)}]}`. Tags
  are section-packed like 4e's `road_cells`, up to 200k cells.
  - The client draws it with 4c's `ADDED`, `REMOVED` and `CHANGED` styles, plus a new `KEPT` style (yellow outline).
  - `previewComposite` accepts `<entry>@<version>` for library entries too (4c had it for massings only), so a caller can
    compose versions itself. `onlyCells` stays in each layer's own template coordinates.
- **Library, Placed view:** "v1 · v3 available · Update…". Update… shows:
  - the delta ghost;
  - the per-part list (added, removed and changed, with counts);
  - the kept cells;
  - in survival, the BOM of the delta and the refunds.
  
  Apply / Cancel. A "History" panel lists the versions, with "Revert to v1" in creative and "Rebuild as v1" (a paid forward
  delta) in survival.
- **Library detail:**
  - the version list (n, date, by, summary, critique overall);
  - "Compare…" (the part summary and a two-layer composite at the look target);
  - "Revert entry to vk";
  - "Polish…" (below).
- Commands: `/architect site update <id> [version] [keep|overwrite]`, `/architect site revert <id> <version>` and
  `/architect site history <id>`.

---

## 3. Polish

### What polish is

`design.polish {entryId, spec}` runs a **polish design** (`Design.kind: "polish"`) on an installed entry:

1. a critique;
2. up to `maxSteps` targeted revision steps, each confined to named parts;
3. at most one new **version** of the same entry;
4. optionally, a delta of that version to the entry's placed sites.

The same steps also run inside a new design as `CritiqueSpec.mode: "polish"` (round 0, a report, then the polish steps):
that's how polish replaces the loop if it earns it.

```
PolishSpec = { fromVersion?: int (head),
               critique?: "reuse" | "fresh"   (reuse when the head's critique.json isn't stale, else a report runs first),
               target?: { issues?: [int], parts?: [name], notes?: string <= 500 chars },
               maxSteps?: 1..3 (2), maxNewParts?: 0..2 (2), maxChangedShare?: 0.05..1 (0.5),
               model?: string (the entry's designer model), effort?: low|medium|high (medium),
               budgetUsd?: number, maxMinutes?: number (15),
               apply?: { sites: [siteId] | "all", preview: boolean (true) } }
```

### Targets (one issue per step)

- **Default:** the highest-priority open issue of the current verdict **that names a part**: P0, then P1, then P2, and verdict
  order within a priority. An issue that a previous step failed on is skipped.
  - Issues with `part: null` are not targeted by default; they are reported as `untargetable`.
  - No targetable issue ends the polish with `no_target`.
- **Explicit issues** (`target.issues`): taken in the order given, one per step.
- **Notes** (`target.notes`, for example "make the porch less cluttered" or "add a library wing") without `parts`: a
  **scoping call** runs first.
  - It's a structured job (Sonnet, low effort) with the iso and front renders and the part list. It returns `{parts: <= 3
    existing names, newParts: <= maxNewParts new names, restated: string}`.
  - Seed: $0.01-0.03.
  - Notes with `parts` skip it.
- **Allowed set** for a step: S = the target's part(s), plus the scoping or caller parts, plus up to `maxNewParts` new part
  names (new names only, following the name rule).

### The scope check ("edit, don't rebuild")

It's deterministic, run by the sidecar with `kit/tools/diff.mjs --scope`. The designer runs the same command before it ends.

1. **The base is rebuilt from source** (`versions/<from>/<id>.mjs`, with its recorded palette, values and bible pin) in the
   polish scratch kit. Its cells must equal the installed base. Otherwise the polish ends `base_drift`, with the differing
   cells, before any model call. The rebuild also writes the exact part map for pre-5b entries.
2. `delta(base, new)`. **A violation** is any of these:
   - a non-unchanged cell whose `part(base)` or `part(new)` is outside S (a cell in no part on either side counts as
     outside, so unnamed cells can't dodge the rule);
   - a base part missing from the new version, unless it is in S;
   - `front`, frame, entrance feet row, `params`, palette or `values` changed;
   - the size is over the request's `maxSize`;
   - more than `maxChangedShare` of the base's written cells are changed (an edit, not a rebuild).
3. **The pristine check:** 0 errors, warnings per rule not higher than the base's, and at least 2 parts.

On a violation or a failed check, the designer gets the list and up to **2 fix turns** (5a's revision allowance). If it still
fails, the step ends `scope_failed` or `check_failed`. Nothing from that step is kept, and the next step starts from the same
base.

### The polish turn

- A **fresh Agent SDK session** (the original design session is gone for an installed entry) in a polish scratch dir:
  - the kit copy, with `kit/designs/<id>.mjs` = the base source;
  - `BRIEF.md` (the original request), `kit/PLAYBOOK.md`;
  - `POLISH.md`: the issue (priority, part, view, what, fix), the allowed parts, and the rules ("change only these parts;
    keep every other cell; remove before adding when the issue is clutter; no new motifs; keep the frame; run the diff
    command and end only when it reports no violation and the check is OK");
  - the base renders and slices in `polish/base/`.
- The same permission policy as designs: no network, the scratch dir only.
- The model is the entry's designer model (Opus for anchors), config `polish.model`.
- The prompts are new, written and **frozen before the eval** (see "Prompt development"); their hashes go into every result.

### Acceptance (the sidecar decides, as in 5a)

After the scope check passes, the new version is rendered with 5a's views. A critic call follows: 5a's critic, a fresh query,
given the base's issue list so it can fill `resolved`. **A step is accepted** when all three hold:
- the target issue's index is in `resolved`;
- no P0 appears that the base didn't have;
- `overall >= base overall - 0.5`.

- An accepted step becomes the base of the next step. It stays in scratch until the end.
- A rejected step is discarded, and its issue is not targeted again in this polish.

### End and install

| End | When |
|---|---|
| `polished` | at least one step accepted and `maxSteps` steps done (or no target left) |
| `no_target` | no targetable issue at the start |
| `not_resolved` | no step accepted |
| `scope_failed`, `check_failed` | the last step failed so, and none was accepted |
| `base_drift` | the rebuilt base differs from the installed one |
| `budget`, `time`, `critic_failed` | as 5a. The accepted chain so far still installs. |

- With at least one accepted step, the last accepted result installs as **one** new version (`by: "polish"`). Its
  `summary` lists the issues resolved, `versions/<n+1>/delta.json` is written, and critique.json format 2 comes from the
  last accepted critic verdict.
- With none, nothing installs. A fresh report, if one ran, is written as the head's critique.json.
- **Apply:** with `apply`, each listed site (or every site standing at an older version of this entry) gets a delta.
  - With `preview: true` (the default; the UI always previews), the polish ends and the sites show "Update available"
    with the delta ghost. Nothing is written until the player or the caller applies.
  - With `preview: false` (API only), the deltas are queued as one batch with the caller as actor.

### Budgets and cost seeds

- **Caps** (the smallest wins):
  - `budgetUsd` if set;
  - else 1.0x the entry's recorded round-0 design cost, or $2.0 for Sonnet and $4.0 for Opus when unknown;
  - what's left of a group or design budget (5a's rules; the soft budget drops polish first, Steward SHOULD 1).
- A step whose seeded high doesn't fit ends the polish with `budget`.

**Seeds** (estimates gain the kinds `polish`, `scope`; measured samples replace them):

| | Cost | Time |
|---|---|---|
| scoping call (Sonnet, low) | $0.01-0.03 | < 0.3 min |
| polish step, Sonnet (fresh session, cold cache; 5a's warm revision turns were $0.47-0.49) | $0.4-1.2 | 2-6 min |
| polish step, Opus | $0.8-2.4 | 3-8 min |
| scope or check fix turn | $0.1-0.4 | 1-2 min |
| critic call (5a calibrated) | $0.02-0.08 | 0.1-0.4 min |

- **Estimate:** low = 1 step + 1 critic; high = `maxSteps x (step + fix turn + critic)` + a report if stale, then clipped by
  the caps.
- `Designs.estimate` returns polish as its own fields, as critique (Steward SHOULD 1).

### The polish eval (re-gating the 5a fix)

**Starting points: 5a's round 0, no new round-0 spend.** `artifacts/eval/full-2026-10-07T2324/sidecar/data/designs/d1..d18/`
holds, for every brief:
- `rounds/0/` with `.mjs`, `.nbt`, the blueprint JSON and `check.json`;
- the round-0 verdict `critique/0/verdict.json`;
- for briefs 16-18, the Mosswater v2 bible pin.

Checked for this draft:
- all 18 are complete;
- every round-0 verdict has at least one P0 or P1 issue grounded on a named part;
- the top issue's part is `roof` in 9 of 18.

**`tools/eval.mjs` additions:**
- `import-round0 <runId>`: installs each round 0 as a library entry in the eval sidecar, with its round-0 verdict as
  critique.json format 2. Cost $0.
  - The verdict is reused only when `criticHash` equals the 5a run's (recorded in its provenance); otherwise a fresh report
    runs, at about $0.03 per brief.
  - **Pre-check, before any spend:** it rebuilds all 18 round-0 sources with the frozen 5b kit and **refuses to start** if
    any differs from its stored `.nbt`. A base drift would otherwise end that brief `base_drift` and quietly count it as a
    tie in G1.
- `run --tier full --arm polish --from <runId>`: polish with `maxSteps 2` (5a's `maxRevisions` 2), each brief's own model
  (Opus for brief 16, as in 5a), effort as 5a's revisions.
- The auth and spend guards are unchanged: claude login only, refused with `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and
  `--max-usd`.

**Judging and bars, exactly as 5a built them:**
- The same blind Opus judge, prompt and schema (pinned by hash), the same 4 views (iso, iso_back, front, top), each pair
  judged twice with the order swapped.
- A brief whose polish accepted nothing has final = round 0. It is `identical`: no judge call, counted as a tie, and it
  **stays in `withRevision`** when a step ran (as 5a counted its 3 identical briefs).
- **G1:** final vs round 0, one-sided sign test at alpha 0.05, using 5a's thresholds (`n` 12/14/16/18 -> 10/11/12/13 wins), at
  most 3 losses, and at least 12 briefs with a step.
- **G2:** the critic's mean `overall` rises by at least 1.0 from round 0 to installed, and P0 at install is 0 in at least
  16 of 18. Same critic, same scale. A recalibrated critic would change the scale, so it is not part of this arm.
- **G3** as 5a.
- **G4**, with one change from 5a:
  - **Blocking:** polish spend within its cap for 18 of 18 (the invariant); mean added time at most 8 min; the estimate within
    ±50% for 15 of 18 and for the total.
  - **Recorded, not blocking:** 5a's "mean at most 60% of mean round-0 cost" line ($2.02 measured, so $1.21). It is
    **predicted to fail**: the seeds give about $1.4-1.7 per brief, because a fresh polish session has a cold cache, unlike 5a's
    warm revisions at $0.47-0.49.
  - Making the line blocking would hide polish behind a dev flag on cost alone, before its quality is known. Instead it
    is reported next to the loop's measured $1.06 and feeds N4.
- **G5 (new, an invariant):** every accepted step passes the scope check, and the mod's `TemplateDelta` of every installed
  version touches no cell outside its steps' allowed sets (re-verified by `rescore`).

**Recorded, not gated:**
- **Head to head:** polish final vs 5a loop final, with the same blind judge, both orders. `identical` when both finals are
  round 0. Judge cost only.
- **Targeted-issue judge:** a blind pairwise asking only "which shows the problem '<issue.what>' less?". It's blind to
  which is revised. It measures whether the fix worked visibly, even when the overall preference is a tie.
- step acceptance rate, scope-violation rate, base drift count, changed-cell share, cost per accepted step, and polish vs
  loop cost and time.

**Prompt development (not tuned on the eval set):** `POLISH.md`, the polish system prompt and the scoping prompt are developed
only on real designs outside the 18:
- gate 1's cabin and tower, gate 2's town house, 4b's Mosswater set (format 1, 3 items) and 4c's tavern;
- if more are needed, round 0 of Steward's v2 briefs (`steward-mc/docs/eval-briefs-v2-candidates.json`).

Development cap $20. Then:
- the prompt hashes are frozen;
- **the measured polish, fix-turn and scoping costs replace the seeds**, and the expected spend of the rest is recomputed;
- if what has been spent plus the new expectation is over the $80 cap, the run **stops and asks Noah** before the full tier.
  The smoke stop rule is not relied on for this.

**Smoke stop rule (no extra spend):** the full run does briefs 1, 3, 10 and 13 first, then stops and reports, without running
the other 14, if any of these holds:
- 3 or more of the 4 end with no accepted step;
- any G5 violation;
- the smoke spend is over 1.5x the seeded high.

**Predicted outcome (stated before the run):**
- One or two single-part edits per brief make small visual changes, so the judge's tie rate will rise. **G1 (13 wins of 18)
  is unlikely to pass.**
- 5a's full revisions moved the critic only +0.28, so **G2's +1.0 is unlikely too.**
- G4's recorded cost line ($1.21 mean) will likely be exceeded (see G4).
- The run is still worth about $40, because the targeted-issue judge and the head-to-head answer the questions Steward needs
  for "polish later":
  - does a targeted edit visibly fix what was named?
  - is it at least as good as the loop, at a lower cost?

**What the outcome decides (agreed now, learning from 5a):**
- **G1-G5 pass:** polish becomes the mechanism behind "Critique and revise" (`mode: "polish"`), and the loop stays
  experimental. Whether the toggle defaults on is Noah's call (N4).
- **G1 or G2 fails, G3-G5 pass:** polish ships **experimental** (as the loop did), the result is recorded as "not shown", and
  the rest of 5b ships.
- **G3, G4 or G5 fails:** polish stays behind a dev flag until fixed. The rest of 5b still ships.

### Spend (claude login only; API-equivalent estimate)

| Part | Expected | Notes |
|---|---|---|
| Prompt development | ~$15 | 6 non-eval entries x (report $0.05 + 2 steps ~$1.5), about 1.7 passes |
| Full polish arm, 18 briefs | ~$30 | 2 steps x ~$0.8 (step, fix turns, critic) per brief; brief 16 on Opus ~$3; steps that end `no_target` cost nothing |
| Judges | ~$6.5 | vs round 0 $2.1; vs the loop $2.1; targeted-issue $2.1; rejudge of 4 briefs for stability $0.5 |
| Other real checks | ~$6 | polish plus apply through the Java API ~$2; one live `critique.mode: "polish"` design ~$3; one notes-scoped polish ~$1 |
| Delta apply gate | $0 | hand-written versions, sim backend |
| **Total** | **~$58** (range $40-75) | |

- **Proposed cap: $80**, enforced by the runner across all real steps.
- **Stated ceiling: $100.** Noah may raise the cap up to $100 without re-planning; past $100 the gate is re-scoped instead.
- 5a, for scale: planned about $85 with a $120 cap (raised to $150); it spent $93.23.

---

## 4. Two fixes from Steward's live check

### F1: release builds need the sidecar bundle

Today `mod/build.gradle` copies `../sidecar/dist` "when it exists", so a jar built without `npm run build` silently ships no
sidecar, and the launcher reports "no sidecar bundled" at run time.

- **Task `checkSidecarBundle`:** requires the **file** `sidecar/dist/main.mjs` (non-empty) and `sidecar/package-lock.json`. It
  writes `architect-sidecar/BUNDLE.json {sidecarVersion, modVersion, builtAt, mainSha256}` into the jar.
- **It fails the build** for:
  - every `publish*` task, including `publishToMavenLocal` (see N5);
  - any build with `-Prelease` (`publish.yml` passes it).
  
  The message: "release builds need the sidecar bundle: cd sidecar && npm ci && npm run build".
- **A plain local `./gradlew build` / `jar` without the bundle still succeeds**, as a **dev jar marked three ways**:
  - the version suffix `+nosidecar` (`architect_mc-0.10.0+nosidecar.jar`);
  - the manifest attribute `Architect-Sidecar-Bundle: missing` (and `custom.architect_mc:bundle = "missing"` in
    fabric.mod.json);
  - a launcher log line and a red Status-tab line: "Development build without the sidecar bundle: set
    ARCHITECT_SIDECAR_DIR, or build sidecar/ and rebuild the mod" (instead of "no sidecar bundled").
  
  Gradle also prints a warning.
- `-PallowNoSidecar` lets `publishToMavenLocal` publish the `+nosidecar` version (never under the plain version), for API-only
  compiling.
- **CI:** `ci.yml` already builds the bundle first. A new CI step builds once without it and asserts the three marks, then
  asserts that `publishToMavenLocal -Prelease` fails.

### F2: the claude login without USER/LOGNAME

- **Observed** (Steward `mod/DEV.md`, 2026-10-07): a client started from `env -i` without USER and LOGNAME didn't find the
  claude login; with them it did. The cause is not root-caused here; it is likely the CLI's macOS keychain lookup. The fix
  doesn't depend on the mechanism.
- **Sidecar** (login mode, before the auth check and every CLI spawn):
  - if `USER` or `LOGNAME` is unset or empty, both are set from `os.userInfo().username`, falling back to the basename of
    `HOME`;
  - if `HOME` is unset, it is set from `os.userInfo().homedir`;
  - this is logged once: "USER/LOGNAME were unset; using <name> from the OS".
  
  `tools/eval.mjs` starts its sidecar through the same code.
- **Launcher (Java):** passes `USER`/`LOGNAME`/`HOME` to the sidecar when missing, from `user.name` and `user.home`.
- **A clear error.** Under login mode, the `designer.ts` auth check's "not logged in" becomes: "The claude CLI found no login
  (user <USER>, HOME <HOME>). Log in by running `claude` and `/login` in a terminal as this user. If Minecraft starts from a
  scrubbed environment, keep HOME, USER and LOGNAME."
  - When the sidecar filled in a variable, the message says so.
  - The Status tab shows it, and it stays an `auth` failure (`failures.ts`).
- **Docs:** the README section "Use my Claude login", and DEV notes on repeating Steward's `env -i` run.

---

## 5. Java API 1.7.0, protocol, events

### Rules (the 1.1-1.6 precedent, tightened)

- `ArchitectApi.VERSION = "1.7.0"`.
- The old record constructors are kept.
- New interface methods are **defaults** that throw `UnsupportedOperationException("... needs Architect API 1.7.0")`.
- **Every new enum constant is appended at the end.** No insertion before DONE or OFF, as 5a did, so ordinals stay stable.
  Exhaustive switches still break, as before.
- `tools/api-compat.mjs` checks the unchanged **1.6.0 and 1.5.0** apitest jars' references and the 1.6.0 API surface. Both jars
  pass their suites against 0.10.0.

### New types

```java
record EntryVersion(int version, long createdAt, String by, @Nullable Integer parent, @Nullable String designId, String summary,
                    String nbtSha256, boolean pinned) {}
enum PartStatus { ADDED, REMOVED, CHANGED, UNCHANGED }
record PartDelta(String name, PartStatus status, int added, int removed, int changed, @Nullable BoundingBox boxFrom,
                 @Nullable BoundingBox boxTo) {}
record BlueprintDelta(String entryId, int from, int to, boolean frameKept, boolean approximate, Map<String, PartDelta> parts,
                      int added, int removed, int changed, int unchanged, List<String> notes) {}
enum PlayerEdits { KEEP, OVERWRITE, REFUSE }
record DeltaRequest(String siteId, int toVersion /* 0 = head */, @Nullable PlayerEdits playerEdits /* null = KEEP */,
                    @Nullable OverlapPolicy overlap /* null = REFUSE */, @Nullable ServerPlayer actor, boolean force, JsonObject ext) {}
record KeptCell(BlockPos pos, BlockState found, BlockState planned) {}
record DeltaVerdict(boolean ok, List<Refusal> refusals, int added, int removed, int changed, Map<String, PartDelta> parts,
                    List<KeptCell> kept, List<Overlap> overlaps, Map<Item, Integer> bom, Map<Item, Integer> refund,
                    BoundingBox box, Mode mode, List<String> notes) {}
record DeltaResult(boolean applied, String siteId, int fromVersion, int toVersion, int written, List<KeptCell> kept,
                   Map<Item, Integer> refund, int reshaped, List<Refusal> refusals, List<String> notes) {}
record SiteVersion(int version, long appliedAt, Kind kind, boolean revertible) { enum Kind { PLACED, DELTA, REVERT, FORWARD } }
// revertible: this version's delta (and every delta above it) can be journal-undone. It is false for every delta built as a
// construction delta, permanently: a later toggle change to INSTANT never makes it undoable (that would put back refunded
// blocks). Such a version is reached again only by a forward delta. It is also false for a version folded into the base.
record PolishRequest(String entryId, @Nullable Integer fromVersion, @Nullable List<Integer> issues, @Nullable List<String> parts,
                     @Nullable String notes, int maxSteps, @Nullable String model, @Nullable Double budgetUsd,
                     @Nullable String owner, JsonObject ext, @Nullable PolishApply apply) {}
record PolishApply(List<String> siteIds /* empty = every site at an older version */, boolean preview) {}
record Polish(int fromVersion, @Nullable Integer installedVersion, List<Step> steps, End end, Cost cost) {
  record Step(int n, @Nullable Critique.Issue target, List<String> allowedParts, boolean accepted, @Nullable Double overall,
              int changedCells, Cost cost, long ms, @Nullable String failure) {}
  enum End { POLISHED, NO_TARGET, NOT_RESOLVED, SCOPE_FAILED, CHECK_FAILED, BASE_DRIFT, BUDGET, TIME, CRITIC_FAILED }
}
```

### Additions to existing types

- **`Library`:**
  - `versions(entryId)` -> `List<EntryVersion>`;
  - `entry(entryId, version)` -> `Optional<Entry>`;
  - `delta(entryId, from, to)` -> `CompletableFuture<BlueprintDelta>` (computed by the mod, off-thread);
  - `revertEntry(entryId, toVersion)` -> `CompletableFuture<Entry>`.
- **`Library.Entry`:** gains `int version` and `List<EntryVersion> versions`. The old constructors give version 1.
- **`Designs`:**
  - `polish(PolishRequest)` -> `CompletableFuture<String>` (the design id, at the ack);
  - `estimatePolish(PolishRequest)` -> `Estimate`, with polish as separate fields.
  
  `Design` gains `kind()` (`DESIGN`, `MASSING`, `REPORT`, `POLISH`, appended) and `polish()` -> `Optional<Polish>`.
- **`CritiqueMode`:** `POLISH` (appended).
- **`Sites`:**
  - `checkDelta(DeltaRequest)` -> `DeltaVerdict`;
  - `applyDelta(DeltaRequest)` -> `CompletableFuture<DeltaResult>`;
  - `revert(siteId, toVersion, @Nullable ServerPlayer actor)` -> `CompletableFuture<DeltaResult>`;
  - `history(siteId)` -> `List<SiteVersion>`.
- **`SiteView`:** gains `int version`, `int headVersion`, `int deviations` and `boolean updating`.
- **`Batch.Item`:** gains `@Nullable DeltaRequest delta`. Exactly one of `request`, `road`, `cells` and `delta` is non-null,
  and `request()` is null for delta items.
- **`Reason`** (appended): `SITE_BUSY`, `FRAME_CHANGED`, `VERSION_GONE`, `PLAYER_EDITS`.
- **Client side:**
  - `PreviewStyle.KEPT` (appended);
  - `ArchitectClientApi.previewDelta(String key, String siteId, int toVersion)`;
  - `previewComposite` accepts `<entry>@<version>`.

### Events and features

**Events:**
- `ENTRY_VERSIONED(Library.Entry entry, int fromVersion)`: once per installed version, persisted and caught up after a world
  load, like `JOB_DONE`.
- `SITE_UPDATED(SiteView before, SiteView after, DeltaResult result)`: for an apply or a revert. It fires when the delta's
  writes are done; for a construction delta it fires at its start, and `SITE_PROGRESS` / `SITE_BUILT` follow as in phase 3.
- `DESIGN_DONE` carries `polish()`.

**Features:** `entryVersions`, `blueprintDelta`, **`deltaApply`** (the name 4a and Steward's A8 review reserved), `siteRevert`,
`polish`, `deltaPreview`.

**Not purely additive:**
- record patterns and `equals` change for `Library.Entry`, `SiteView`, `Batch.Item` and `Design`;
- `Batch.Item.request()` may now be null for a delta item;
- new constants, appended.

### Sidecar protocol (2, additive)

Client -> sidecar:
- `entry.versions {entryId}` -> ack `{versions}`
- `entry.delta {entryId, from, to}` -> ack `{delta}` (the kit's summary)
- `entry.revert {entryId, toVersion}` -> ack `{version}`
- `design.polish {entryId, spec: PolishSpec}` -> ack `{designId}`
- `design.estimate` takes `{polish: PolishSpec}`
- `CritiqueSpec.mode` takes `"polish"`, with `maxRevisions` meaning `maxSteps`

Sidecar -> client:
- `entry.versioned {entryId, version, from, by, designId?}` (the mod reloads that entry)
- `design.upsert` with `kind: "polish"` and `polish: {fromVersion, steps, end, installedVersion}`

Other:
- Snapshot features: `entry.versions`, `entry.delta`, `design.polish`, `critique.polish`.
- **Protocol-1 clients** see none of it; polish designs are filtered out by `toProtocol1`.

**Kit CLI:** `node kit/tools/diff.mjs <a.nbt> <b.nbt> [--parts-a f] [--parts-b f] [--frame-a x,y,z] [--frame-b x,y,z]
[--scope p,q] [--new-parts n] [--max-share 0.5] [--json]` prints `{ok, frameKept, parts, added, removed, changed, unchanged,
violations[], frameHint?}`. The exit code is 0 for no violation, 1 for violations, 2 for bad usage.

### DevBridge (docs/DEVBRIDGE.md changelog)

- `dev.entry.versions`, `dev.entry.installVersion {entryId, dir}` (installs a hand-written version, no Claude), and
  `dev.entry.delta`.
- `dev.site.delta.check` / `dev.site.delta.apply`, `dev.site.revert`, `dev.site.history`.
- `dev.writes.count {box}` (block writes counted since the last call, for minimality).
- `dev.journal.killAt` gains D1-D8.
- `dev.site.state` gains `version`, `deviations` and `deltas`.

---

## 6. Phase 5b gate

Blocking items: 1-5 and 7-10. Item 6 must run to the end within the cap. Its G3, G4 and G5 block **shipping polish**, and its
G1 and G2 decide polish's label (above), not the phase.

1. **Unit and property tests (no Claude):**
   - **Kit:**
     - `diff.mjs` on fixtures: part statuses, approximate labels, the frame hint, every scope violation (including
       no-part cells and a removed out-of-scope part), and base drift;
     - `frame` and `parts.nbt` round trips.
   - **Kit diff equals the mod's `TemplateDelta`** on every fixture pair and on every kit example against its param and
     palette variants.
   - **Mod, pure JVM** (a world seam like 5a's `MigrationWorld`): property tests over random version chains (3-6 versions
     from random edits inside parts, including growth and shrink with a frame shift) and random op sequences: apply any
     version, revert, Remove, another site LAYERed below or placed beside, other removals, and random player edits.
     - **E1 (path independence):** with no player edits, after any sequence the union box + 8 equals a fresh instant
       placement of the site's current version on the original world (or the original world, after Remove).
     - **E2:** a revert of the top delta restores exactly the world before that apply.
     - **E3:** Remove at any point restores the original world, edits included (BOX).
     - **E4:** an apply writes only Δ' and its guard cells: shape guards (by vanilla shape updates only) and growth
       guards.
     - **E5:** under KEEP, player-edited Δ cells are untouched and reported, and cells outside Δ are untouched by both
       apply and revert.
     - **E6:** a fold changes no undo result except the folded version.
     - **E7:** no API path undoes a non-top delta.
     - **Per-section planning** equals whole-entry planning, with delta entries included.
   - **Sidecar:**
     - the version install with a fault at every step, then repair;
     - user metadata and `ext` kept through a bump;
     - GC keeps pins;
     - the stale rule (version, sha, critic hash);
     - polish on the sim backend: every end reason scripted, target selection (including `untargetable`), a scope
       failure then a fix, the acceptance rule, the caps, a restart mid-step, a usage hold, the estimate, and protocol-1
       filtering.
2. **In-game exactness (dev world, $0).** Hand-written versions of the kit tavern, installed with `dev.entry.installVersion`:
   - v2 adds `wing_east`, removes `porch` and re-materials `roof`;
   - v3 grows west (origin raised, design coordinates kept) and changes `main`'s windows;
   - v4 changes `front` (must refuse `FRAME_CHANGED`);
   - v5 shrinks (removes a part; smaller footprint).
   
   The checks:
   - **Chains:** a fixed 12-operation script plus 20 seeded random scripts of apply and revert over v1, v2, v3 and v5, each
     from a copy of one world.
     - After every operation, the region hash equals a fresh placement of that version at the same spot in another
       copy (E1).
     - Every revert equals the pre-apply hash (E2).
     - A final Remove equals the pre-site hash over the union box + 8, every cell plus BE NBT (E3).
   - **Layered and leaves:** the same on a site LAYERed over a cell-site pad T, next to a worldgen tree (held leaves, the
     ring, growth into leaves). T and the site are removed in both orders.
   - **Covered:** X is LAYERed over the tavern's wall.
     - A delta touching X's cells refuses `COVERED`, naming X.
     - One that doesn't touch them applies.
     - All 6 removal orders of {T, tavern with its delta, X} are exact.
   - **Minimality:** `dev.writes.count` equals |Δ'| plus the shape-guard and growth-guard writes. A chest with items in an
     unchanged part keeps them. A door opened in an unchanged part stays open.
   - **Shape updates:** a fence and a glass pane in an unchanged part stand against a wall that v2 adds and against a wall
     that v5 removes. After each apply and revert, they match a fresh placement (E1, E2).
   - **Player edits:**
     - a block placed in a removed part's cell: KEEP keeps it and reports it, OVERWRITE replaces it, REFUSE refuses;
     - a filled chest in a changed cell refuses `BLOCK_ENTITIES`;
     - an opened door in a changed cell counts as ours.
   - **Crash:** D1-D8 and K5-K7 by `dev.journal.killAt`, then a restart. The states are as the table says, and the final
     Remove is exact.
   - **History:** 8 deltas in a row on the same cells. The depth stays at most 8, the 7th folds, reverts to the retained
     versions are exact, and Remove is exact.
   - **Ghost:** a delta preview with ADDED, REMOVED, CHANGED and KEPT tints, in a screenshot that has been looked at.
3. **Survival:**
   - A cabin construction site is built from hoppers. Then a construction delta v1 -> v2:
     - the BOM from `dev.site.state` equals the sum over the delta's queued cells;
     - it is fed exactly that;
     - it finishes identical to an instant apply at the same spot in a creative copy;
     - the refunds equal the paid removed and changed cells that are still ours;
     - changed cells kept the old block until their swap.
   - "Rebuild as v1" (a forward delta) is fed and finishes identical to an instant v1. Then deconstruct. Over the whole
     run, items delivered = items returned, per item id.
   - A second run mines 3 blocks: returned = delivered - 3.
   - A delta on a site that is still `BUILDING` refuses `SITE_BUSY`, and a queued one waits.
4. **Queue, groups and stages:**
   - The 4d 12-lot village gets a batch of 12 delta items (hand-written v2s of the 4 kit examples) as stage `upgrade`. It
     is identical to atomic applies, and a relog mid-batch resumes identically.
   - `cancelBatch` rolls back the in-flight delta exactly.
   - `undoStage("upgrade")` reverts all 12 exactly, and `removeGroup` afterwards is exact.
5. **MSPT and throughput:** the budgets table; the village delta batch at 1, 4 and 10 ms; the size-cap fixture with every
   cell changed, applied and reverted. Results in `artifacts/gate5b/REPORT.md` and `throughput.json`.
6. **The polish eval** (real, claude login only, with the guards):
   - prompt development frozen (hashes recorded);
   - `import-round0`;
   - smoke with the stop rule, then the full 18;
   - G1-G5 as above, plus the recorded comparisons;
   - `rescore` byte-identical;
   - `rejudge` agrees on at least 3 of 4.
7. **Other real checks:**
   - through the Java API (apitest): polish an entry placed in a dev world, preview, then apply;
   - a notes-scoped polish ("make the porch less cluttered") with its scoping call;
   - one new design with `critique.mode: "polish"`.
8. **The fixes:**
   - `publishToMavenLocal -Prelease` and `publish` fail without `sidecar/dist/main.mjs`;
   - a local build without the bundle carries all three marks (and a Status-tab screenshot that has been looked at);
   - a sidecar started with `env -i HOME=... PATH=...` (no USER or LOGNAME) in login mode reports auth ok (account info
     only, $0);
   - the new message is unit-tested with an injected account-info result (no login found, with a variable filled and with
     none filled). This is not a live negative run: it would depend on how the CLI finds credentials, and it could write
     first-run files.
9. **Regressions:**
   - every sidecar, kit and mod test;
   - the 4a jobs, 4b and 4c sim suites;
   - the 4d gate;
   - 4e gate items 2 (any order), 5 (crash), 7 (survival layering) and 9 (the 4d regression);
   - the 5a sim tier with `rescore`, and the migration tests;
   - **the 1.6.0 and 1.5.0 apitest jars, unchanged, pass against 0.10.0**, and `api-compat` is clean;
   - recorded, not gated: a world with an updated site opened in 0.9.0 removes it exactly (the deltas are found by
     `entry.site`).
10. gate-verifier checks the result, including that no real step ran with an API key in its environment and that the
    spend is within the cap.

## Build order inside 5b

1. F1 and F2 (small, independent).
2. Kit: `frame`, `parts.nbt`, `diff.mjs` (with the scope mode); the fixture versions.
3. Sidecar: entry versions (install, repair, GC, lineage, critique.json format 2), the `entry.*` messages.
4. Mod: `TemplateDelta`, the pre-site view and plans, the `delta` entry, apply, revert, fold, crash points, settle. Then
   survival, the queue and stages, preview, UI. The equality test with the kit comes early.
5. Polish on the sim backend: targets, scope check, acceptance, steps, estimates, apply.
6. Java 1.7.0 and api-compat.
7. Gate items 1-5, 8 and 9 (all $0). Then polish prompt development (cap $20), freeze, smoke, full, other real checks.

## Open questions for Steward

- **S1. Player edits default.** `KEEP` (the player's block stays, reported) for API callers, as your N5 asked for removal. Or do
  you want `REFUSE` by default, so the steward can ask the player first?
- **S2. Covered cells.** 5b refuses a delta that touches cells another site covers (`COVERED`), and defers writing under a
  cover to phase 6. Your lots sit on top of pads, so a lot's own delta is fine. A **pad's** delta under standing lots needs the
  deferred mode. Is phase 6 soon enough?
- **S3. Version identity.** The entry id stays stable across versions. Group items, collections and your lot-to-entry maps are
  unchanged, and `SiteView.version` / `headVersion` plus `ENTRY_VERSIONED` drive "update available". Enough for your inbox,
  or do you want per-site update proposals as events?
- **S4. Survival revert costs materials** (a paid forward delta; a free undo would duplicate refunded items). Acceptable for
  Supplied and Hardcore?
- **S5. Polish targets.** One part-grounded issue per step. Notes ("add a library wing") go through a scoping call that picks
  at most 3 parts and 2 new ones. Will your free-text change requests (your phase 3) fit that, or do they need multi-part
  edits across more of the building (which would be a remix, not a polish)?
- **S6. Scope of delta apply in 5b.** Building sites only. Roads, cell sites and massings re-place, and region deltas are
  phase 6 with A5b. OK?
- **S7. Frame rule.** A new version must keep `front` and the entrance feet row; rotating a building is a re-place. OK?
- **S8. History.** At most 6 deltas per site before the oldest folds into the base (revert to a folded version becomes a
  forward delta). Enough?
- **S9. Polish model.** The entry's own designer model (Opus for anchors), or always Sonnet for polish?

## Open questions for Noah

- **N1. Spend:** about $58 expected, a cap of **$80**, and a stated ceiling of **$100** (raise without re-planning up to it).
  Claude login only. OK?
- **N2. Versions in place** (stable id, `versions/<n>/`), rather than a new library entry per revision. OK?
- **N3. The outcome rule, decided before the run:** polish's G1 and G2 decide only its label (default-capable vs
  experimental). Delta apply ships on its own gate. OK?
- **N4.** If polish passes G1-G5: should "Critique and revise" switch to polish, and should it default on?
- **N5. `publishToMavenLocal` without the bundle fails**, with `-PallowNoSidecar` as the escape. Or should mavenLocal stay
  lenient?
  - Steward compiles against mavenLocal.
  - Its DEV.md records that a jar built from a tag clone needs `npm ci && npm run build` in `sidecar/` first, or it has no
    sidecar.
  - Failing makes that impossible to miss.
- **N6. Survival revert = pay again** (S4), a game-design call.
- **N7. Retention:** 32 versions per entry, 30-day GC, pins always kept. OK?
- **N8. Prompt development** on gate 1/2/4b/4c designs (outside the eval), never on the 18. OK?

## Deferred (recommended)

- **Writing a delta under a covering site** (rewriting the cover's `before`, with its undo): phase 6, for pad deltas under
  lots.
- **Deltas for roads, cell sites, massings and region programs:** phase 6 with A5b.
- **Moving or rotating through a delta**, and changing `front`: re-place.
- **Rebasing variants and re-skins** onto a new base version.
- **Polish of bundled and imported entries.** Imports have no source; bundled entries need a variant first.
- **In-world renders** for critiquing a placed site with the player's edits. 5b critiques the entry's template.
- **A recalibrated critic** ("7 reachable"). It changes the G2 scale, so it is a separate experiment with its own eval run.
- **Collection-wide polish** ("polish the whole set") and set-level critique: phase 6.
- **Exports with versions and source** (the PLAN carry-over "exports carry no source").
- Still with phase 6, unchanged: the thin 4 ms throughput margin (5b re-measures it), invariant (iii) narrowed (delta entries
  are BOX, so it is not widened), and the 1000x1000 NOT_LOADED timeouts.

## Coordinator decisions on Noah's questions

- **N1** Noah: the polish eval runs as drafted on his claude login, with an $80 cap and a $100 ceiling.
- **N6** Noah: a survival revert is a paid forward delta.

- **N2** Yes: versions live inside the entry, and the id stays stable.
- **N3** Yes: polish's G1/G2 decide only its label; delta apply ships on its own gate.
- **N4** Only if polish passes G1 and G2: "Critique and revise" then switches to polish, still off by default. Turning it on by default is a later decision.
- **N5** Yes: `publishToMavenLocal` fails without the bundle too, with `-PallowNoSidecar` as the escape.
- **N7** Yes: 32 versions, a 30-day GC, pinned versions always kept.
- **N8** Yes: prompt development only on designs outside the 18.

## Changes from Steward's review of 5b (steward-mc/docs/A5B-DELTA-REVIEW.md), all accepted

Where this section and the 5b text above disagree, this section wins. (The Java API is section 5 above; Steward's copy was cut.)

- **Delta preview as data (SHOULD 1).** `Sites.checkDelta(DeltaRequest)` returns a `DeltaVerdict` that carries, as Java data,
  the per-part summary (`PartDelta`), the kept cells (`pos, found, planned`), the BOM, the refunds, and the reasons. The client
  ghost and Architect's UI render from that same object.
- **Routing free text (SHOULD 2).** The scoping call returns `fits: boolean`, `suggest: "polish" | "reskin" | "remix"` and a
  reason. A whole-look request (bible revise plus re-skin) or a structural rebuild is declined before any polish step, for the
  scoping call's cost only ($0.01-0.03).
- **`Sites.outdated(owner)` (SHOULD 3).** Returns each standing site whose pinned version is older than its entry's head, with
  the entry id, the site's version and the head version. Callers use it at world load, because `ENTRY_VERSIONED` events are
  missed while the world is closed.
- **Owner rule (SHOULD 4).** A delta on a site owned by someone other than the caller refuses with `OVERLAP_OWNED` unless forced.
- **Answers:** S1 KEEP default. S2 covered cells wait for phase 6. S3 version/headVersion, `ENTRY_VERSIONED` and `outdated`.
  S4 paid survival revert. S5 local edits within 3 existing plus 2 new parts; whole-look changes route away (above). S6 buildings
  only. S7 frame rule. S8 6 deltas. S9 polish uses the entry's own designer model by default, with a caller override.

## Phase 5b as built (API 1.7.0, mod 0.10.0, recorded 2026-10-08)

Built on branch `phase/5b`. Gate record: `artifacts/gate5b/REPORT.md` (local). Where this section and the 5b text disagree,
this section says what shipped.

**Deviations and decisions made while building:**
- **Unframed versions borrow the frame.** A pre-5b version (no `frame` in its blueprint JSON) takes the framed side's
  `origin` when compared with a framed version, in the kit's `diff.mjs` and in the mod's `TemplateDelta` alike ("missing =
  [0,0,0]" put most pre-5b entries one block off). Two unframed versions compare at [0,0,0].
- **`DeltaRequest` gains `owner`** (the owner rule needs the caller's identity); the 7-argument constructor stays.
  `Designs.estimatePolish` returns `CompletableFuture<Estimate>`. `Sites.outdated` returns `OutdatedSite` records.
- **The API revert** passes the site's own owner with `force` (a revert is the site owner's undo).
- **Shape guards** are limited to S-owned neighbours whose world value is still S's `after` (kept or edited cells are never
  guards, so a player's edit is never re-written as "ours").
- **The leaf ring of a growth** is recorded as the delta entry's own ring (head data), not a change to the base's ring.
- **Delta jobs (over 50k cells) are not resumed after a clean stop:** settle rolls them back (D4-D6) like an unclean stop.
- **Instant deltas are atomic.** A batch delta item checks on one tick and writes on the next (the check is used only when
  the site record did not change in between). A `cancelBatch` therefore never finds a half-applied instant delta; the
  in-flight rollback path applies to delta jobs only.
- **`BLOCK_ENTITIES`** refuses in every `playerEdits` mode, a kept (player-edited) cell included.
- **Lost writes (crash safety, added).** An unclean stop loses block writes made since the world's last save, while the
  journal and the site record are on disk. At a world start after an unclean stop (a marker written at world start and
  deleted by a clean stop), a site's top delta whose own loaded cells (before != after, uncovered) mostly hold their
  `before` is undone (one undo, exact) and the record follows the world. So a D7/D8 kill ends at a consistent version a,
  not "record b, world a"; when the world was saved before the halt, the journal wins (b). Construction deltas are left
  alone. After a clean stop nothing is undone (a player who mined a delta's added cells keeps the site at its version).
- **Write order.** A delta writes its clears (cells becoming air) before its other cells, instant and ticked, so a block
  under one the delta removes doesn't react to it first. A dirt path under a solid block is planned as dirt (vanilla turns it
  at its next tick), so the captured `after`, a construction target and a fresh placement agree.
- **Template deltas are cached** by the two versions' content; batch items wait for the diff on a worker thread.
- **Deconstruct after construction deltas:** growth cells' pre-site value comes from the delta's `before`; restore-box cells
  no entry of the site recorded are not the site's.
- **Fixtures:** the tavern versions gained a `yard` part (fence, glass pane, a free-standing gate door) for the shape-update,
  opened-door and minimality checks.
- **Prompt development** used the 4b Mosswater items and the 4c tavern (gate 1's cabin and tower entries no longer exist on
  disk; gate 2's town house has no part map, so no part-named target), through `tools/eval.mjs polish-dev` (entries rebuilt
  from source, a fresh report, the eval's spend guard). It ended at 0 of 7 steps accepted ($2.65 of the $20 cap): the
  step critic sees the step's renders and the base's indexed issues, the targeted fix was visibly there (dormers and a
  kinked ridge on the 4c tavern's roof), and `resolved` stayed empty every time. The limit is 5a's critic, which the
  contract keeps fixed, so the prompts were frozen at the second revision (hashes: system f4916959, brief 8d0b4f4c, step
  99d5bcdb, scoping e9821a71).
- **The polish eval stopped at the smoke tier** (`full-polish-2026-10-08T1901`): 4 of 4 smoke briefs accepted no step
  (3 `not_resolved`, brief 3 `budget`: the seeded step high didn't fit 1.0x its round-0 cost), so the other 14 were not
  run. G1 not shown (3 identical), G2 +0.00, G4: in cap 4/4, mean $0.49 and 2.2 min, estimate within 50% 2/4 (fail);
  G5: nothing installed to check. `rescore` byte-identical. Polish's label is decided outside the build (contract: G4 fail
  -> dev flag; G1/G2 fail -> experimental).
- **Gate item 7** ran through the Java API on the claude login: a placed entry polished with a preview (0/2 accepted, so
  the real apply path was exercised on the sim: polish, ENTRY_VERSIONED, outdated, checkDelta, applyDelta, history,
  revert, Remove exact); a notes-scoped polish with its scoping call (0/1); one new design with `critique.mode: "polish"`
  (round 0 + report, then a polish design, 0/1).
- **`tools/apitest.mjs`** gains `polish`, `polish-real` and `critique-polish-real`; `tools/gate5b.mjs` steps smoke, e1,
  chains, edits, layers, crash, history, ghost, survival, survqueue, village, sizecap, apijars.
- **Spend:** $9.17 API-equivalent (claude login, every paid run with a scrubbed environment: no ANTHROPIC_*/CLAUDE_*
  variable, logged in artifacts/gate5b/env-paid.log).

## Phase 5b outcome (coordinator, 2026-10-08)

- Delta apply, entry versions, checkDelta, outdated, the owner rule, F1 and F2 ship (gate items 1-5 and 8-9 passed; the
  gate-verifier confirmed them).
- Polish: G1 not shown, and G2 and G4 failed (the smoke stop rule ended the eval at 4 briefs: 0 steps accepted). By the outcome
  rule above, polish stays **behind a dev flag**: the Library "Polish…" button shows only with `-Darchitect.dev.polish=true`.
  The API and protocol keep `mode: "polish"` for callers who opt in knowingly. The next attempt changes the critic, which is
  what refused visible fixes, and is re-gated on the same eval.

# Phase 6 contract: macro kit, region realise and mega_bench (A5b) - FROZEN after Steward review

Goal: **build whole sites as programs.** A region program describes terrain operations, lots, roads, bridges, stairs and
anchors for an area far larger than one template, such as a crater works, a sky isle, a walled hill or a 1000x1000 district.
It is checked without the game and shown as previews and a ghost. Realising it streams cell lists from the sidecar's JS kit
to the mod, which writes them through the 4e journal. The whole region undoes exactly. The lots are ordinary building
sites, LAYERed on the region's pads.

Phase 6 is Steward's A5b (`steward-mc/docs/A5B-SPEC.md`, the binding input) plus Steward's full `mega_bench` (A5B §6a).
It also carries the scale problems 4e recorded at 1000x1000 and deferred to this phase.

Versions: API **1.8.0**, mod **0.11.0** (see "Split" for the per-sub-phase numbers). The sidecar protocol stays **2**,
with additive messages and new feature names, as in 4b-5b. Phases 1-5b still hold, except where this section changes them;
where they disagree, this section wins.

Sources for this draft:
- Steward, read only:
  - `docs/A5B-SPEC.md`, all of it: the Region API, primitives, M1-M14, N1-N9, §6a mega_bench and staged builds, §7 resolved
    points, §8 open points;
  - `ARCHITECT-ASKS.md` A5 and R1;
  - `A4B-REVIEW.md` item 5 (open roles, macro superset);
  - `A4E-REVIEW.md` S4 (sky roads, bridges and ramps are region cell lists in phase 6) and S9 (full mega_bench in phase 6);
  - `A5A-REVIEW.md` S4 (site-plan view and set critic in phase 6);
  - `A5B-DELTA-REVIEW.md` S2 and S6 (pad deltas under lots, and region deltas, in phase 6);
  - `PLAN.md` (Phase 2 "Macro sites" gate, the risks after 5a/5b).
- `docs/PLAN.md`: the phase 6 row, the 4e status and caveats, and the 5a/5b outcomes.
- `docs/CONTRACT.md`:
  - 4a: Survey, `LoadPolicy`, blobs;
  - 4d: the queue, groups, stages, waiting, tickets, and "as built";
  - 4e: the journal, CELL/BOX, layering, K1-K8, roads, cell sites, the budgets, and "as built", including the 1000x1000
    recorded run;
  - 5b: D7 (covered cells deferred to phase 6), the "Deferred" list, and the outcome.
- Measured, local: `artifacts/gate4e/megabig.json`, `artifacts/gate4e/REPORT.md`, `artifacts/gate5b/throughput.json`.
- Code at `main` (v0.10.0):
  - `site/Batches.java`: placement tickets are `FLAG_LOADING` at radius 0, so a ticket can trigger worldgen; LOAD_BOUNDED
    fairness;
  - `site/CellsCheck.java`, `InfraPlace.MAX_CELLS` (1M per request);
  - `sidecar/src/server.ts` `MAX_FRAME_BYTES` 16 MB; `protocol.ts` `MAX_CHUNK_BYTES` 1 MB and `MAX_BLOB_BYTES` 64 MB;
  - `kit/lib/kit.mjs` `MACRO_ROLES` = rock, surface, subsurface, rubble, rail, structure; `CORE_ROLES` includes `accent`
    and `foundation`; `kit/lib/bible.mjs` scope `settlement`.

## What the 4e and 5b record says phase 6 must fix or carry

| Item | Record | What this contract does |
|---|---|---|
| 1000x1000 run (`megabig`, recorded, not gated) | 657 items, 11.57M cells in 2018 s wall. The step's `cellsPerSecond` is 6.6k; cells over wall time is 5.7k. 11 of 610 lots TIMED_OUT while waiting NOT_LOADED under LOAD_BOUNDED(64), "not investigated further". MSPT max 237 ms, **58 ticks over 50 ms**, while the server generated unexplored terrain for the tickets. Peak heap (sum of pool peaks) **6.27 GB**. Journal 4.6 MB (0.40 bytes/cell). | A root-cause step first. Then a separate, governed **prepare** (pre-generation) step; **realise never generates a chunk**; a queue-time refusal for items that can never get their chunks; 0 timeouts as a gate bar; a memory bar under `-Xmx4G`. |
| The 4 ms throughput margin | 4e: 16.6k cells/s (builder), **15.1k (verifier)**, against a budget of 15k. 5b re-measured MSPT, not a fresh cells/s median (its village delta batch is item-bound at 5.8k cells/s). | The bar stays 15k. The number is now the **median of 3 runs**, with a stated rule for a miss (gate item 9). |
| Invariant (iii) narrowed | It holds except where a player edits a cell where a CELL entry lies over a BOX entry. | **A region never puts CELL over BOX**: terrain, paths and roads are always below the lots. Region terrain skips cells that a `site` or `delta` entry owns. So (iii) holds in full for regions. A region delta that would write terrain under standing lots refuses (6d). |
| Deferred to phase 6 | Bridges beyond 1-deep decks; region realise streaming; site-plan and section previews; a set-level critic over lots; deltas for cell sites, roads and regions; writing a delta under a covering site; the full mega_bench as a gate. | Bridges, streaming, previews and mega_bench are in 6a/6b. Deltas are 6d. The set-level critic is **deferred** (below). |
| 5a and 5b outcomes | The critic doesn't accept fixes: loop G1/G2 failed, and polish accepted 0 steps. | **Nothing in phase 6 depends on critique.** Quality comes from deterministic programs, the macro checker and previews. Claude's authoring rounds are driven by checker findings only. |

## Key decisions (each specified below)

| # | Decision |
|---|---|
| D1 | **Programs run once, at plan time. Realise evaluates data.** A region program (`kit/regions/<id>.mjs`, agent-written or bundled) runs in the pristine-kit child process and returns a **Region IR**: JSON with shape trees from a closed kit shape library, and no closures. Realise evaluates the IR with the kit's own code only, so agent-written code never runs at realise time. |
| D2 | **The evaluation unit is a tile: 64x64 columns (4x4 chunks), over the region's y range.** Ops are pointwise over a frozen heightfield, so tiles evaluate independently and in any order, in a sidecar worker pool. |
| D3 | **The pre-region heightfield is frozen, not re-surveyed per section.** A column's surface is surveyed once, the first time any tile of the region (any stage) touches it, including an 8-column margin. It is persisted in the world before that tile's first journal commit. Surface-relative ops always resolve against it. A resume, a later stage or the next section down therefore never evaluates against the region's own carve. (This deviates from A5B §1, "a fresh survey of those sections"; see S2.) |
| D4 | **One journal entry per (change-set, tile), each its own 4e P1-P8 cycle.** A region's change-set is the set of its tile entries. K1-K8, per-section planning and settle apply unchanged. A tile entry over 1M cells is split by section rows (the 4e `placeCells` cap). |
| D5 | **The mod pulls, the sidecar never pushes.** The mod requests a window of tiles ahead of the writer (default 4). Cell lists arrive packed, in frames of at most 1 MB. Received lists are never written to the queue file; the queue persists only tile keys and the IR hash. If the sidecar is gone, the region **waits** (`SIDECAR_UNAVAILABLE`, temporary). Undo never needs the sidecar. |
| D6 | **Prepare, then realise.** `Regions.prepare` generates the missing chunks of claim + margin under an MSPT governor, persistently, with its own record. Realise uses a new `LoadPolicy.GENERATED_ONLY(n)`, which loads chunks from disk and **never generates**. Generated chunks during realise are counted, and the gate bar is 0. |
| D7 | **Lots are BOX building sites LAYERed on the region's CELL pads**, placed with `fitToLot`. The order is always terrain, then paths and roads, then lots, by stage. Region terrain skips `site`/`delta`-owned cells. |
| D8 | **Ground roads are 4e roads; everything off the ground is kit cell lists.** A region `road` that fits 4e's limits (width at most 5, cut/fill at most 4) compiles to `RoadRequest` items, so approaches stop at it and crossings hand over. Graded roads, ramps, stairs and bridge decks are cell lists in `architect:path` entries whose walk-surface cells are marked like road surface cells, so 4e's approach rule sees them too. |
| D9 | **Determinism:** IR = f(program sha, params, plan survey, roles, seed), byte-identical per Node major. Cell lists = f(IR, frozen heightfield), byte-identical across worker counts, tile order, restarts, macOS and Linux. Realise-time kit math uses no `Math.sin/cos/tan/exp/log/pow/random` and no `Date` (lint-enforced). |
| D10 | **Claude authors programs only (6c).** It is template-first: a cheap structured call picks a bundled program and params when one fits. Otherwise a program-writing session is repaired in rounds against the **deterministic checker**. There is no critic, no loop and no set-level critic. The feature uses whatever auth the sidecar is configured with, like every job. **The gate's spend runs on the claude login only**: expected about **$12**, cap **$25**, stated ceiling **$35**, all in 6c. 6a, 6b and 6d spend $0. |
| D11 | **Split into 6a (engine and scale, gated by full mega_bench), 6b (macro kit, checker and previews), 6c (Claude authoring and Steward's crater gate), and 6d (region evolution and deltas; recommended to wait for Steward's phase 3).** Each has its own gate. |
| D12 | **Overworld only, and INSTANT only** (creative, or survival toggle off; Steward's Patron), as 4e cell sites. Regions in survival-toggle worlds refuse `NOT_ALLOWED` until Noah decides the terrain rule (N4). |

### Deviations from A5B-SPEC (for Steward's review)

| A5B says | This contract | Why |
|---|---|---|
| §1: realise takes "a fresh survey of those sections" | D3: a frozen pre-region heightfield per column, taken at first touch, plus a drift check at region and stage start | Re-surveying would evaluate surface-relative ops against the region's own earlier writes (resume, a later stage, the next section down) |
| §2: programs compose shapes freely in JS | D1: a closed, serialisable shape library; `heightfield` and `mask` blobs as the escape hatch | Realise runs data, not agent code; determinism and streaming |
| §2: `road(path, opts)` placed as a site | D8: ground roads become 4e roads; graded roads, ramps, stairs and decks become `architect:path` cell lists | 4e's approach-meets-road and handover rules work only on road entries; S4 of 4e put sky roads in phase 6 cell lists |
| §3: M14 starts as a warning | Part-id **uniqueness** is an error from the start (the rest of M14 starts as a warning) | Duplicate part ids make per-part counts and 6d's diff ambiguous |
| §4 N4: a group places terrain, then roads, then lots | Kept, applied **per stage**, plus "a region never writes CELL over BOX" | Keeps invariant (iii) whole |
| §6: the gate's player block "placed in a lot beforehand" | Split into before-realise and after-realise cases (6c gate) | The two cases go through different rules (lot refusal, CELL keep) |

---

## Split

| Sub-phase | Scope | Gate | API / mod | Spend |
|---|---|---|---|---|
| **6a: engine and scale** | Kit: IR, shape core, noise, tile evaluator, packing; and the primitives mega_bench needs (`carve`, `add`, `platform`, `pillar`, `ring`, `terrace`, `lot`, `road`, `stair`, `bridge`, `part`, `anchor`, `noise`). Sidecar: `region.plan` and the evaluation pool with streaming. Mod: prepare, the frozen heightfield, tile items, the governor, region groups and stages, crash points, region undo. API (6a part of 1.8.0). Commands and DevBridge, no player UI. | Full mega_bench at 1000x1000 with explicit bars; determinism; exact undo; the crash points; the 4d/4e/5b regressions. | 1.8.0 / 0.11.0 | $0 |
| **6b: macro kit, checker, previews** | The rest of the primitives (`cavern`, `utility`, `floating`, `underside`, `stages` checks). The virtual world and macro checker M1-M14 (every rule starts as a warning except M1/M13/M14's always-on parts). Previews: top-down, section, iso and site plan. The region ghost. The four family fixtures plus broken variants. A minimal Architect player UI (a "Terrain" tab with bundled programs). | Fixture reports match expectations; broken variants caught; prefix-of-stages check; preview goldens; checker time on mega_bench. | 1.9.0 / 0.12.0 | $0 |
| **6c: authoring with Claude** | `Regions.design` (template-first, then program authoring with checker rounds); lot children from library entries or variants; Steward's A5B §6 gate. | Claude "crater mining facility" passes M1-M4 with no findings, realises, lots placed, one undo exact; the player-block cases; spend within cap. | 1.10.0 / 0.13.0 | about $12, cap $25 |
| **6d: region evolution** (recommended to wait) | Region deltas by part (A5B N7); deltas for cell sites and roads; pad deltas under standing lots (writing under a cover, the 5b D7 deferral). | Specified when Steward's phase 3 needs it; outline below. | later | $0 |

6a goes first because it carries the unknowns: the 237 ms ticks, the timeouts and memory. Its measured numbers set M12's
budget estimates and the kit's limits in 6b. 6a and 6b are not merged: the checker's coarse/full-resolution design should
build on the measured evaluator.

If Noah prefers one 1.8.0 for the whole phase, the 6b/6c members become 1.8.0 methods that throw
`UnsupportedOperationException("... needs Architect 0.12.0")` until they land, and `features()` tells callers which ones
exist (N1).

---

## 1. The program model

### Where programs run

```
plan     (sidecar, no game)  program.mjs + params + plan survey + roles + seed  --child process-->  Region IR (JSON)
check    (sidecar, no game)  IR + plan survey  -->  virtual world  -->  checker report, previews        (6b)
prepare  (mod)               claim + margin  -->  generated chunks on disk (governed)
realise  (mod <-> sidecar)   mod freezes heights per tile -> requests tiles -> sidecar evaluates IR per tile
                             -> packed cell lists -> mod writes them as tile entries through the queue and the journal
```

- **Plan** runs the program in the **pristine-kit child process**, the one the checker uses today, with the sidecar's
  permission policy (no network; file access limited to the job's scratch dir and the read-only kit). Limits: 30 s CPU,
  `--max-old-space-size=1024`, IR output at most 4 MB. A program that throws, exceeds a limit, or returns something that is not
  a `Region` fails the plan with the kit's message.
- The program sees `ctx = {claim, survey, bible, seed, params, kitVersion}`.
  - `ctx.survey` is the plan survey: 4a's `Sample`, read from its blob. Its resolution is 1 up to 256x256, else 4.
  - It has helpers: `heightAt`, `pickCenter`, `slopeAt`, `waterAt`, `biomeAt`, and a coarse `flatAreas()`.
  - `Math.random` throws ("use ctx.rng"), `Date.now` returns 0, and `ctx.rng(label)` is the seeded PRNG.
- **The IR** (`format: 1`) is the plan's identity. It holds:
  - id, `programSha`, params, seed, claim, and the `kitVersion`;
  - the **resolved roles** (role -> vanilla block state, from the bible; a re-skin changes these and nothing else);
  - `parts: [{id, stage, ops: [op]}]` in program order;
  - `lots`, `roads`, `paths` (stairs, ramps, bridge decks and graded roads), `utility`, `anchors`, `floating`, `rules`,
    `stages: [name]`;
  - `budget: {cells, removed, added}`, an estimate from the coarse pass.

  An op is `{kind, shape, material?, opts}`. A shape is a JSON tree over the closed shape library (below).
- **Realise** never runs the program. It evaluates the IR with `kit/lib/realise.mjs`, a pure function `(IR, tile key,
  heightfield window) -> packed cells`. It runs on a sidecar worker pool: `worker_threads`, default `min(4, cores/2)`,
  config `regionWorkers`. The pool runs only Architect's kit code.
- **Plans live in two places.** The sidecar keeps `<gameDir>/architect/regions/plans/<planId>/` (program copy, `ir.json`,
  report, previews). The world keeps `<world>/architect-regions/<regionId>/` with `region.json` (the record), a copy of
  `ir.json`, and `heights/` (the frozen heightfield, one shard per tile). Because the world holds the IR, a realise can resume after the
  sidecar lost its plan dir: the mod re-sends the IR with each tile request (cached by IR sha in the sidecar).

### The shape library (closed set, signed distance)

Primitives:
- `sphere(c, r)`, `box(min, max)`, `cylinder(c, r, h)`, `cone(c, r0, r1, h)`;
- `bowl(c, r, depth, {profile: 'parabolic'|'spherical'|'flat'})`, `ring(c, r0, r1, {h, rise})`, `torus`;
- `capsulePath(points, r)`, `extrude(polygon, y0, y1)`;
- `heightfield(blobRef, {scale, y0})`: a caller-supplied 16-bit field;
- `mask(blobRef)`: a 2D bitmap.

Combinators: `union`, `subtract`, `intersect`, `smooth(k, a, b)`, `offset(d)`, `displace(noise, amp)`, `clipY(y0, y1)`.

Y is surface-relative by default (`y: {surface: dy}`), or absolute (`y: {abs: n}`).

**Rule:** every op is **pointwise**. A cell's result depends only on the IR, its position, and the frozen heights of
columns within 8 of it. Smoothing radius, terrace blending and support search are capped at 8 columns. That cap is what
makes a tile independent: a tile reads the heightfield over itself plus an 8-column margin.

`heightfield` and `mask` are the escape hatch for shapes the library can't express. Their blobs are at most 16 MB each
and part of the IR's identity (by sha).

### Ground and trees

- The survey's `height` is motion-blocking without leaves, so on forested ground it is the top of a trunk. **The region's
  ground** (what `surface` means, in the plan survey and in the frozen heightfield) is the first block found by walking down
  from `height` that is natural and is not a log, leaves or a plant. The freeze stores that y (`ground`), and also `height`
  for the checker.
- **Worldgen trees inside an op's write volume or a pad are removed as natural:**
  - logs, leaves and their attached plants (vines, cocoa) count as `IF_NATURAL` cells of the op that reaches them;
  - **a tree trunk any of whose log cells an op removes is removed whole**, within the claim, as cells of the same tile
    entry. No trunk is left floating over a crater;
  - leaves outside the write volume that hung on those logs get the 4e treatment: `leaves` guard entries per tile, held
    persistent while the tile stands, and given back on undo.
  - Trees that touch no op are untouched.
- The 6a gate places a tile of mega_bench's carve rim through a forest (gate item 6).

### Evaluation and conflicts within a program

- Ops apply in IR order (part order, then op order within the part). **The last op that touches a cell wins.**
- Each result cell carries a **condition**. The mod resolves the conditions **at P1, together with the `before` capture**,
  against the live world, using 4e's change tracking up to P3 for sliced captures. **The PLACING entry contains only the
  cells that passed**, so its planned `after` is exact for 4e's CELL rollback and for P7. This is where 4e's large cell
  sites already run the natural filter.

| Condition | Writes when the world cell is | Used by |
|---|---|---|
| `IF_NATURAL` (default) | natural terrain, air or water, with no block entity (4e `naturalOnly`) | carve, terrace, platform, pads |
| `IF_SOLID_NATURAL` | solid natural terrain | carve `lining` |
| `IF_AIR_OR_FLUID` | air, water or lava (not waterlogged blocks) | `add`, decks and supports over water |
| `ALWAYS_OURS` | a cell this region's earlier entries own, or anything `IF_NATURAL` allows | later stages over earlier ones |

  A cell whose condition fails at P1 is **skipped and noted** per tile (counts per reason). It is never forced. Engine
  invariants (A5B §3) are enforced here and by the claim check, whatever the checker said.
- **Claim:** every cell outside the claim box is dropped by the evaluator *and* refused by the mod (`REGION_LIMIT`). The
  mod never trusts the evaluator for M1.

### Seeds and determinism

- `seed` is a 64-bit integer from the request. It is carried **as a decimal string** in JSON (the IR, the protocol and the
  region record), because a JSON number loses precision above 2^53 between Java and JS. The default is
  `fnv64(programId, canonical(params), claim)`, so it never depends on the world seed implicitly.
- `noise(field)` is kit-implemented value and simplex noise over integer hashing (splitmix64 on BigInt-free 32-bit halves),
  using only `+ - * / Math.floor Math.sqrt Math.abs Math.min Math.max`. Those are exactly specified in IEEE/ECMAScript, so
  results are bit-identical across platforms.
- **The realise lint:** a kit test scans `lib/sdf.mjs`, `lib/noise.mjs` and `lib/realise.mjs` and fails on any other
  `Math.*` member, `Date` or `Math.random`.
- **Plan determinism** is per Node major. A program may use trig, which affects IR numbers only. The IR is recorded, so
  realise is unaffected, and the plan records `node` and `kitVersion`. A replan on another Node major may give another IR
  sha; that is reported, not an error.
- **Guarantees** (each a test):
  1. The same plan inputs give a byte-identical IR (canonical JSON, keys sorted).
  2. The same (IR, heightfield window) gives a byte-identical packed tile, for 1 and 4 workers, in forward and shuffled
     tile order, after a sidecar restart, and on macOS and Linux CI.
  3. Two realises of one plan in two copies of the same world give identical region hashes.

### Limits

| What | Limit | Over the limit |
|---|---|---|
| claim | 1024x1024 columns (2048x2048 behind `-Darchitect.dev.bigRegions=true`) | plan refused `REGION_LIMIT` |
| y range | within the world's build limits; M11 warns within 8 of either limit | refused at plan |
| IR | 4 MB, 20,000 ops, 1,024 lots, 256 paths, 64 stages | plan fails with the count |
| cells | `budget.cells` declared by the program; default 20M; hard 64M | plan refused; the checker's M12 shows the estimate |
| one tile | 1M cells per entry (4e cap); split into section-row sub-tiles above that | automatic |
| plan run | 30 s CPU, 1 GB heap | plan fails |
| tile evaluation | 2 s per tile, 256 MB per worker | the tile fails `OTHER` with the kit's message; the region pauses (not fails) so a fix can resume it |
| region stages | 64 | plan fails |
| dimension | Overworld (the survey's height is motion-blocking; the Nether ground issue is still open) | `NOT_ALLOWED` |

---

## 2. Primitives

Every primitive belongs to a `part` (M14), and every part to a stage (default `main`). The guarantees hold for the cells
written. A skipped cell (a failed condition, outside the claim, owned by another site) is noted, never forced.

| Primitive | Parameters (defaults) | Guarantees | Sub-phase |
|---|---|---|---|
| `part(id, {stage})` | id `^[a-z][a-z0-9_]{0,47}$`, unique; stage name | Stable id: the unit of diffing (6d) and of the per-part counts on the ghost and in reports. Renames are breaking (A5B §2). | 6a |
| `carve(shape, {to: 'air'\|role, lining: role?, liningDepth: 1, naturalOnly: true})` | the shape and fill | Removes only `IF_NATURAL` cells inside the shape. The lining is written only where a surviving solid natural cell faces the void (`IF_SOLID_NATURAL`). Never removes block entities, player blocks or cells owned by others. Removed and lined counts are reported per part. | 6a |
| `add(shape, material, {underside: 'flat'\|'taper'\|'pillars'\|'rock', supportEvery: 8})` | the shape and a role | Writes only `IF_AIR_OR_FLUID`. `pillars` adds `pillar` ops at most `supportEvery` apart under the mass's rim and grid. `taper` and `rock` shape the underside with a seeded noise cone. | 6a; `rock`/`taper` in 6b |
| `platform(polygon, y, {thickness: 1, edge: 'none'\|'rail'\|'wall', underside})` | a polygon in x/z, a y | A flat slab at exactly `y` over the polygon, with the edge style on its boundary cells. With `underside: 'fill'` it fills down to the frozen surface (`IF_NATURAL`). | 6a |
| `pillar(at, {to: 'ground'\|'bedrock'\|y, size: 1\|2\|3, material})` | position and footprint | A column from its top down to the first solid natural cell under the frozen surface, or to the floor under water (it reads `floor`). Stops at the claim's bottom margin (M11). | 6a |
| `ring(c, r0, r1, {height: 8, rise: 0, towers: {every: 48, radius: 4, extra: 4}, gates: [{angle, width: 3, height: 4}], crenels: true})` | centre and radii | A closed wall following the frozen surface, plus `rise`. Every gate opening has at least its width and height clear, and its threshold cells are walk-surface cells. Towers sit on the wall line. | 6a; towers and crenels in 6b |
| `terrace(region, levels, {riser: 2, retain: role, edge: 'slope'\|'wall', stairs: true})` | a polygon or (centre, fractions) and levels | Each level is flat (every column at its level's y). Risers are at most `riser` per step, or a retaining wall when `edge: 'wall'`. With `stairs`, one stair of width 3 joins each pair of levels. | 6a |
| `stair(path, {width: 3, rise: 1, landingEvery: 8, carve: true, railing: role?, spiral: false})` | a polyline (x, y, z) | Rise at most 1 per step; 2 headroom along the whole width (carved `IF_NATURAL`; a blocked headroom cell is reported as an M6 error, never forced); a landing (2 flat cells) at least every `landingEvery` steps. Walk cells are marked as walk-surface. | 6a |
| `bridge(path, {width: 3, deck: role, rail: true, supports: {every: 12, style: 'pillar'\|'arch'}, maxSpan: 24, towers: false})` | a polyline of at least 2 points (abs y or surface) | The deck is continuous at the given width, with rise at most 1 per block along the path. There are 2 headroom cells over the deck. No unsupported span is longer than `maxSpan`: supports go in at most `every` apart, as pillars to the ground or the floor under water. `arch` is a pointwise arch between supports. Rails on both sides. Deck cells are walk-surface (approaches stop at them). An `architect:path` entry. | 6a; arches and towers in 6b |
| `road(path, {width: 3, surface: auto, lanterns: true, mode: 'ground'\|'graded'})` | a polyline | `ground` (default): compiled into 4e `RoadRequest` items; a road over 2048 centre cells is split. All 4e road guarantees hold (profile, clearing, handover, approaches stop). `graded`: width 1-9, a profile from the frozen heights smoothed to grade at most 1 in 4, cut/fill at most 12, written as an `architect:path` entry with retaining edges where a cut or fill exceeds 2. | 6a |
| `lot(id, {at, size: [w, d], floor: 'auto'\|y, front: dir\|'toward:<part\|anchor>', max: [x, y, z], brief, pad: {maxCut: 6, maxFill: 6, edge: 'slope'\|'wall'}, foundation: role})` | as A5B | A pad: every column of `size` (+1 apron) ends at `floor`. Cut above (`IF_NATURAL`); fill below with `foundation` down to the frozen surface. Batter slopes or a wall within `maxCut`/`maxFill`. A pad needing more fails at plan with M9's numbers. The lot's box `[size + max height]` is recorded in the IR (N3) and in `RegionView.lots`. The child design cap is the 96x64x96 template cap. | 6a |
| `anchor(name, at)` | `entrance` and `spawn` required; `cam_*` free | Validated inside the claim. Exposed in the plan and `RegionView`. | 6a |
| `noise(field, {kind: 'value'\|'simplex', octaves, scale, seedLabel})` | | A seeded field used by other ops (`displace`, masks, `cavern`). Same seed and label, same values (D9). | 6a |
| `cavern(shape, {noise, amp: 3, floor: 'flat'\|'natural', light: {every: 8, block: role}})` | | A hollow with a noise edge and a flat floor. **Light is mandatory**: a light block at most `every` apart on the floor grid, so no floor cell is more than `every/2` from one (M5 confirms). | 6b |
| `utility(path, {width: 3, height: 3, kind})` | | No blocks. A reserved corridor: the checker keeps it clear of later ops, and 6d deltas keep it. | 6b |
| `floating([part ids], {anchor})` | | Declares sky parts for M3 (connected to each other and to an anchor, not to ground). | 6b |

**Materials** are roles only (A5B §2). The roles are `MACRO_ROLES` and `CORE_ROLES` from the bible, plus extra named roles
(the 4b open-roles rule: validated vanilla blocks). Steward's `scorched` and `lining` are **not** in `MACRO_ROLES` today:
- programs use them as extra roles, with a fallback chain declared in the program (`roles.scorched ?? roles.rock`);
- M13 errors on a role that resolves to nothing.

Adding `scorched` to `MACRO_ROLES` is a bible-format change: question S5.

**Lot children.** Realise takes a map `lot id -> (blueprint id[, version])`. Each mapped lot becomes a queue item:
`fitToLot(lot box, front)`, then a `PlaceRequest` with `overlap = LAYER`, in the lot's stage after its terrain and paths.
An unmapped lot stays a pad. Generating children is the caller's (Steward's group, A2) or `Regions.design` with
`designLots` (6c).

---

## 3. Region realise

### Records and states

- `RegionView {id, planId, irSha, owner, ext, groupId, claim, state, stages: [{name, state, tilesDone, tilesTotal, cells}],
  lots: [{id, pad, siteId?, state}], cellsWritten, cellsSkipped: {reason: n}, waiting?: {reason, since}, prepare?: PrepareView}`.
- States: `planned` -> `preparing` -> `prepared` -> `placing` -> `placed` | `partial` | `failed`; then `removing`. These
  are A5B N8's states plus `preparing`/`prepared`.
- A region **is** a 4d/4e site group. The group's stages are the IR's stages, so 4d `approveStage`, `skipStage`,
  `reorderStages` and `undoStage` apply unchanged. Within each stage, items go in this order:
  1. terrain tiles;
  2. `architect:path` tiles and 4e roads;
  3. lots.

  4d's dependency rule stays: undoing a stage that later placed stages depend on refuses without `force`.

### The unit of writing: tile entries

- A tile is `(change-set, tx, tz)`, 64x64 columns. The change-set is `terrain` or `path` per stage.
  - Kind `architect:terrain` or `architect:path`, policy **CELL**.
  - `site` = the tile's own cell-site record id (`c<n>`); `group` = the region's group.
  - `meta.region` = region id; `meta.tile` = `tx,tz`.
- Each tile goes through 4e's P1-P8, with 4e's large-cell-site path: decode, de-duplicate and sort off-thread; the
  condition filter over ticks; the overlap test on occupied sections only; capture with change tracking.
- **Overlap within the region:** a later stage's tile is LAYERed over this region's earlier `cells` entries (CELL over
  CELL). A tile **skips** cells owned by any `site`, `delta` or `road` entry, the region's own lots included, and notes them.
  So a region never writes CELL over BOX (invariant iii stays whole).
- **Overlap with others:** cells owned by another owner's entry are skipped and noted, never `OVERLAP_OWNED`-refused. A
  tile can't wait for a whole settlement. A region whose claim overlaps another owner's standing region is refused at
  realise with `OVERLAP_OWNED` unless `force`.
- **Entry count and the index.** mega_bench at about 3 stages gives about 256 x (terrain + path) tiles per stage that
  touches a tile, plus about 200 lots, so about 1-2k entries. The 4e index holds every entry's section list, base64. The
  build measures the index size and its commit time. **Bar: index at most 8 MB, commit p99 at most 100 ms on the I/O
  thread.** If the bar fails, 6a moves `sections` into per-entry side files: index `version: 2`, with the downgrade rule
  of 4e, so 0.10.0 keeps refusing safely. That is a store-format change and needs its own migration test.

### Streaming (mod <-> sidecar)

1. **Freeze.** When a tile is next-but-W in the queue, the mod surveys the tile's columns plus the 8-column margin that
   have no frozen height yet. It uses 4a's sliced `Survey.sample` on loaded chunks; prepared chunks load from disk under
   `GENERATED_ONLY`. It writes them to a per-tile shard `heights/<tx>.<tz>.bin` (int16 `ground`, `height` and `floor`, and
   a water bit, per column; margin columns go to the shard of the tile that owns them, written once) with write, fsync,
   atomic rename and read-back. **This happens before the tile's P3.** Shards are never rewritten once complete.
2. **Request.** `region.tiles.request {planId, irSha, ir?, tiles: [{key, heights: base64}]}`, with at most W tiles
   outstanding (default 4, config `regionWindow` 1-16). The IR travels only when the sidecar answers `ir_unknown`.
3. **Answer.** `region.tile {planId, key, seq, more, data: base64, count, sha}`.
   - `data` is the packed list: per section, a palette, 12-bit positions and a 2-bit condition, gzip.
   - A tile larger than 1 MB packed is split into frames with `more: true`.
   - `sha` covers the whole tile and is checked by the mod.
   - An evaluation error answers `region.tile.error {key, message}`.
4. **Write.** The tile becomes a ready queue item. The writer takes it under `placementBudgetMs` like any cell-site item.
   Its cells are held in memory only until its P7 commit.
5. **Backpressure.** The mod requests a new tile only when one leaves the window. The sidecar holds at most W evaluated
   tiles per region in memory.

- **Bytes:** the packing targets at most 4 bytes per cell over the wire, and the gate records the number. 4e's 0.40
  bytes/cell on disk suggests 1-2.
- **Sidecar gone:** in-flight requests are dropped; the region waits `SIDECAR_UNAVAILABLE`, which is temporary and has no
  wait limit. On reconnect the mod re-requests its window. A tile already at P3 or later doesn't need the sidecar (its
  cells are in the PLACING entry).
- **Queue file:** a region item persists `{regionId, stage, kind, tile}` only. 4e's lesson: queued cell lists made the
  queue file megabytes.

### Chunks: prepare, loading and the NOT_LOADED fix

**First build step (6a, before any fix is claimed): the root cause.** Re-run 4e's `megabig` generator with the 0.10.0 jar
and a diagnostic log per waiting item: chunks needed, chunks ticketed, their status per tick, ticket churn, and the wait
reason over time. Write the classification to `artifacts/gate6a/timeouts.md`. Candidate causes, to confirm or rule out:
- (a) an item whose snapshot box + 7 needs more chunks than the 64-chunk bound (a 96-wide lot needs up to 8x8 = 64 on its
  own, so a lot that straddles needs more), which can then never start;
- (b) fairness: one waiter holds the next tickets while others' tickets lapse;
- (c) generation slower than the 600 s wait limit under the spikes;
- (d) radius-0 tickets reaching a chunk status the placement check doesn't accept.

The fixes below don't depend on which cause it was. The diagnosis decides whether more is needed.

- **`Regions.prepare(PrepareRequest)`** generates every not-yet-generated chunk of `claim + 2 chunks` (the box + 7 margin
  of edge items, rounded up) and records progress in `<world>/architect-regions/<id>/prepare.json`. It resumes after a
  relog. The governor:
  - at most `prepareInFlight` generation tickets at once (default 2, config 1-8);
  - a new ticket only when the last 20 ticks had max MSPT under 35 ms and mean under 20 ms;
  - after a tick over 50 ms, no new ticket for 40 ticks;
  - each finished chunk's ticket released at once, so loaded chunks don't accumulate;
  - nearest to any player first, then rows.

  `PREPARE_PROGRESS` fires at most 1/s. Prepare writes no blocks, and nothing in the journal.
- **Knowing a chunk is generated without loading it** is a named 6a verification item. The candidate is the region file's
  location table plus the stored chunk status (vanilla's chunk storage read path) on 26.3. If 26.3 has no cheap way, the
  fallback is to load with a ticket under the governor and read the status (slower, still governed). The contract does not
  assume an API.
- **`LoadPolicy` gains `GENERATED_ONLY(n)`**: like `LOAD_BOUNDED(n)`, but a chunk that isn't fully generated is never
  ticketed. The item waits with the new temporary reason `NOT_GENERATED`, and the region's state shows "needs prepare".
  **Realise defaults to `GENERATED_ONLY(64)`**, and a counter of chunks generated while a region item holds tickets must
  stay 0.
- **Queue-time chunk check:** at queue time every item computes the chunks its box + 7 touches. **Under a policy that holds
  tickets** (`LOAD_BOUNDED`, `GENERATED_ONLY`), an item needing more than the batch's bound is refused at once with the new
  reason `CHUNK_BOUND` ("needs N chunks, the bound is M"). It never waits to `TIMED_OUT`. `LOADED_ONLY` (bound 0, the 4d
  default and Steward's staged mode) holds no tickets and is not checked. Tiles need at most 36 (6x6); lots up to 81.
  - **One ticket budget per region.** The writing item and the heights freeze of the W tiles ahead draw from the same
    bound. The freeze takes tickets only for columns not yet frozen, and releases each tile's tickets once its heights are
    on disk. **Realise sets the bound to max(64, the largest item's need + 36)**, so the writer and at least one freeze
    always fit. The freeze is otherwise sequential, so a window of 4 never needs 4 x 36 at once.
  - The check also applies to ordinary ticket-holding batches (a behaviour fix to 4d/4e, listed under the API rules).
- **Waiting without a time limit:** for region items, `NOT_LOADED`, `NOT_GENERATED` and `SIDECAR_UNAVAILABLE` waits don't
  count toward `waitPolicy`. A staged region near the player can wait for days (A5B §6a). `PLAYER_IN_BOX`, `OCCUPIED` and
  `OVERLAP_BUSY` still count.
- **Staged near the player (`LOADED_ONLY`):** prepare is optional. Items proceed when their chunks are loaded by players
  and never ticket. If a chunk is ungenerated, it is generated by the player's own exploration, not by Architect.

### MSPT budget

| Phase | Budget |
|---|---|
| realise writes | `placementBudgetMs` (default 4 ms) across all jobs, as 4d/4e. Region writes use the road and cell-site flags (`UPDATE_CLIENTS \| UPDATE_SKIP_ALL_SIDEEFFECTS`), so fluids and gravity blocks get no updates during the write; M3/M4 cover the consequences statically. |
| server-thread work per tile outside the budget | heights freeze (sliced), the item start (one tick, at most 15 ms), and the P3 and P7 handoff (at most 6 ms grace, as 4e) |
| lighting and client sync | not budgeted by Architect (vanilla's light engine and chunk sending); **measured** in the gate as the MSPT of ticks with no Architect write slice during a realise |
| prepare | the governor above |

### Crash safety

Order per tile: **heights first, then the journal, then the record, then the blocks.** So the 4e K1-K8 sequence follows
a new step H0 (heights persisted). New kill points for `dev.journal.killAt`:

| Point | Where | After restart |
|---|---|---|
| RG1 | during prepare | resumes prepare; no blocks or journal touched |
| RG2 | plan accepted, region record written, no tile started | region `prepared`/`planned`, queue resumes |
| RG3 | after H0, before the tile's P3 | the frozen heights are reused (no write happened, so they are pre-region); the tile restarts |
| RG4 | tile in P5 (writes), unclean | 4e K3: the PLACING tile entry rolls back exactly; the tile is re-queued and re-evaluated, giving the same cells (D9) |
| RG5 | sidecar killed mid-stream | the region waits `SIDECAR_UNAVAILABLE`, then resumes; no tile duplicated |
| RG6 | during a region group undo | 4e K7 |

The 5b "lost writes" rule (an unclean stop loses block writes since the last world save) applies to tiles as to cell
sites: settle by evidence (most cells hold `before`: release, the tile is re-queued).

### Undo

- `Regions.remove(regionId, options)` = 4e `removeGroup` over every entry of the region (tiles, roads, paths, lots, their
  leaves and crates), as one undo planned per section, written by a ticked `RestoreJob`, in reverse stage order.
- **CELL tiles keep the player's later blocks** (reported in `kept`). BOX lots restore exactly as 4e.
- `undoStage` removes one stage. A lot's own Remove leaves the pad exact (4e's mega-lite bar, kept).
- `CoveredPolicy` applies to removing a **tile** that a foreign site covers. KEEP is the default: hand-down, as 4e.

### Region limits on the world, summarised

Claim containment (M1), `IF_*` conditions, no block entities removed, nothing outside the claim, the block budget, and the
journal path for every write. The mod enforces all of these at write time, whatever the checker reported.

---

## 4. Previews and the checker (6b)

### The virtual world

The plan survey plus the IR, evaluated by the same `realise.mjs` at **coarse resolution**: every 4th column for claims over
256x256, full resolution below. A **full-resolution pass** covers lots + 8, paths and bridges + 4, stairs, carve edges
(cells within 2 of a carve boundary) and gates. Lot interiors are their declared boxes (A5B §3).

### The checker (M1-M14)

- Rules and severities as A5B §3, which this contract adopts as written.
- Start severities: M1 and M13 are errors, M14's uniqueness is an error (a deviation, see the table above), and every
  other rule is a warning.
- Promotion follows the usual process, recorded in PLAN.md, after the 6b fixtures and the 6c real runs.
- A program may declare `rules` (R4). M1, M13 and M14 always apply.
- **Prefix checking:** M2 (reachability) and M3 (support) run after each stage prefix.
  - The walk graph and the support union-find are kept per stage and extended, not rebuilt.
  - This is A5B §8's question, answered by measuring it on mega_bench: bar at most 2x a single full check.
- **Output:** `report.json` with `{rule, severity, part, stage, count, sample: [positions <= 20], message}`, plus a summary
  the agent and Steward can read.
- **Checker time on mega_bench** (gate 6b): coarse at most 60 s, full-resolution passes at most 120 s, single-threaded on
  this machine; recorded per rule.

### The four views (sidecar renders, no game)

| View | What | Format |
|---|---|---|
| `top` | Shaded relief of the post-op heightfield (hillshade from the NW), parts tinted by kind (carve, add, path), lots as outlined rectangles with ids, roads, bridges, anchors, the claim. | PNG, at most 2048 px on the long side; 1 px = 1 column up to 2048, else scaled |
| `section` | A vertical cut along an axis: the default is `entrance` -> region centre -> the opposite claim edge; or a caller's polyline. Pre-region surface as a line, post-op solid filled by role colour, lots as boxes, water shaded, y grid every 8. One image per axis, at most 4 axes. | PNG |
| `iso` | A low-detail isometric of the post-op heightfield mesh (one quad per sampled column), with lots as boxes and paths drawn on top. | PNG |
| `siteplan` | The **site plan**: lots with ids, labels (from `brief`), front arrows and entrances; roads and paths with widths; bridges; stairs; utility corridors; stages as colour bands; districts (parts); anchors; scale bar and north arrow. | SVG + PNG + `siteplan.json` (all geometry as data: lot rects, entrances, paths as polylines, stages) |

- The previews are written to the plan dir. They are deterministic: the same IR and survey give byte-identical PNGs (the
  kit's pinned encoder).
- `region.preview {planId, views, axes?}` re-renders on demand.
- **How Steward gets them:**
  - `Regions.previews(planId)` -> `RegionPreviews {paths: {view -> absolute path}, sitePlan: JsonObject, report}`;
  - `RegionPlan.previews` carries the same at plan time.
  - The client can show the PNGs (Steward's inbox, Architect's Terrain tab). The paths are valid `job.images` inputs if
    Steward wants its own report-only review.
- **Region ghost** (client): `ArchitectClientApi.previewRegion(planId, @Nullable String stage)`.
  - It shows the cells of tiles within 64 blocks of the player. They come from the same tile evaluation, run in preview
    mode over the plan survey.
  - Beyond 64 blocks: the claim outline and the lot boxes.
  - Tints: added, removed, path and lot. The verdict line shows the checker summary and the cell budget.

### Not in phase 6: a set-level critic

A5A-REVIEW S4 asked for a set-level critic (a composite of the lots along the street). 5a's critic did not reach its bar,
and 5b's critic accepted 0 visible fixes. A set critic built on it would inherit both failures, and a region gate must not
depend on it. **Deferred** until a recalibrated critic passes 5a's eval. The `siteplan` and `top` views are its future
inputs, and Steward can already run a report-only review on them through `job.images`.

---

## 5. Claude (6c): authoring programs

- **Template first.** `Regions.design(RegionDesignRequest)` first runs one cheap structured job (Sonnet). Its inputs are
  the brief, the survey summary (4a's `summary()`: stats plus a 64x64 ASCII grid), the claim, and the catalogue of bundled
  programs with their params. It returns `{fits, program, params, reason}`. Cost seed $0.01-0.05. When `fits`, the plan
  runs with no further model call.
- **Authoring.** Otherwise a design-agent session (the entry model, Opus by default as for landmarks; caller override)
  writes `regions/<id>.mjs` in a scratch dir. It has the kit docs (`kit/REGIONS.md`, new), the bundled programs as
  examples, the survey blob and the bible's roles. Its tools are `region plan`, `region check` and `region preview`.
  - **Rounds are driven by checker findings only:** a round ends when the plan has no errors and none of the request's
    `mustPass` rules (default M1, M2, M3, M4) has a finding.
  - Caps: 4 rounds, the request's `budgetUsd`, and the 4a hard budget stop.
  - No critic call and no critique loop.
  - The agent may look at its own previews (image blocks under the claude login, as 5a's probe showed).
- **Lots.** `designLots: false` (default): lots come back as specs, and the caller fills them. The 6c gate fills them from
  existing library entries and variants (no model call).
- **Auth and spend.** `Regions.design` uses the sidecar's configured auth, like every job: an API key is the supported
  player path, and the claude login is the opt-in. **The gate's paid runs use the claude login only.** The gate runner
  refuses an `ANTHROPIC_*` / `CLAUDE_*` key in its environment, as in 5b, and the gate-verifier checks the log.
  - The 6c gate's runs: 2 template picks, 2 authoring sessions (the crater, and a custom "terraced hillside village"), and
    at most 2 retries.
  - **Expected about $12, cap $25, stated ceiling $35** (raise without re-planning up to it).
  - 6a, 6b and 6d: $0. Their fixtures and mega_bench are deterministic programs, and the sim backend covers the job paths.

---

## 6. Java API 1.8.0, protocol, events

### Rules (the 1.7.0 rules, unchanged)

- `ArchitectApi.VERSION = "1.8.0"` (6a; 1.9.0 and 1.10.0 for 6b and 6c if the split is accepted, same rules).
- Old record constructors kept. New interface methods are defaults that throw `UnsupportedOperationException("... needs
  Architect API 1.8.0")`. **Every new enum constant is appended at the end.**
- `tools/api-compat.mjs` checks the unchanged **1.7.0, 1.6.0 and 1.5.0** apitest jars' references and the 1.7.0 surface.
  All three jars pass their suites against 0.11.0.
- **Behaviour change, listed:** the queue-time `CHUNK_BOUND` refusal applies to every batch whose policy holds tickets
  (`LOAD_BOUNDED`, `GENERATED_ONLY`); `LOADED_ONLY` batches are unchanged. A 1.7.0 `LOAD_BOUNDED` caller whose item could
  never get its chunks now gets `ITEM_FAILED(CHUNK_BOUND)` at once, instead of `TIMED_OUT` after 10 minutes.

### New types

```java
interface Regions {                                                     // ArchitectApi.regions(), a default method
  CompletableFuture<RegionPlan> plan(RegionPlanRequest r);              // survey (sliced), sidecar plan, (6b) check + previews
  CompletableFuture<PrepareView> prepare(PrepareRequest r);             // completes when every chunk is generated or it was cancelled
  void cancelPrepare(String regionOrPlanId);
  CompletableFuture<String> realise(RealiseRequest r);                  // -> regionId once queued (its group id in view().groupId)
  CompletableFuture<RemoveResult> remove(String regionId, RemoveOptions o);
  Optional<RegionView> get(String regionId);  List<RegionView> list(@Nullable String owner);
  CompletableFuture<RegionPreviews> previews(String planId, Set<PreviewView> views, List<List<BlockPos>> axes);   // 6b
  CompletableFuture<String> design(RegionDesignRequest r);              // 6c, -> designId (Design.kind REGION)
}
record RegionPlanRequest(String program /* bundled id or a path under <gameDir>/architect/regions/programs */, JsonObject params,
                         ServerLevel level, BoundingBox claim, @Nullable Long seed, @Nullable String bible, @Nullable Integer bibleVersion,
                         LoadPolicy surveyLoad, @Nullable String owner, JsonObject ext) {}
record RegionPlan(String planId, String programId, String programSha, String irSha, String surveySha, long seed,
                  List<LotSpec> lots, List<String> stages, Map<String, BlockPos> anchors, RegionBudget budget,
                  @Nullable CheckReport report /* 6b */, @Nullable RegionPreviews previews /* 6b */, List<String> notes) {}
record LotSpec(String id, String stage, BoundingBox lot, int floorY, Direction front, @Nullable String brief, BlockSize max, JsonObject ext) {}
record RegionBudget(long cells, long removed, long added, int tiles, int chunks, int chunksToGenerate) {}
record PrepareRequest(String planId, @Nullable Integer inFlight) {}
record PrepareView(String planId, int chunksTotal, int chunksGenerated, int chunksMissing, State state) { enum State { RUNNING, DONE, CANCELLED, FAILED } }
record RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries /* lot id -> blueprint id[@version] */,
                      @Nullable LoadPolicy load /* null = GENERATED_ONLY(bound) */, boolean autoApprove, @Nullable List<String> stages,
                      boolean force, JsonObject ext) {}
record RegionView(String id, String planId, String irSha, String owner, JsonObject ext, String groupId, BoundingBox claim, RegionState state,
                  List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped,
                  @Nullable Refusal waiting, @Nullable PrepareView prepare) {}
enum RegionState { PLANNED, PREPARING, PREPARED, PLACING, PLACED, PARTIAL, FAILED, REMOVING }
record StageProgress(String name, Stage.State state, int tilesDone, int tilesTotal, long cells) {}
record LotState(String id, @Nullable String siteId, String state /* pad | queued | placed | failed:<reason> */) {}
record CheckReport(boolean ok, int errors, int warnings, List<Finding> findings) {                                    // 6b
  record Finding(String rule, String severity, @Nullable String part, @Nullable String stage, int count, List<BlockPos> sample, String message) {} }
enum PreviewView { TOP, SECTION, ISO, SITEPLAN }                                                                         // 6b
record RegionPreviews(Map<PreviewView, List<Path>> images, JsonObject sitePlan) {}                                       // 6b
record RegionDesignRequest(String brief, ServerLevel level, BoundingBox claim, @Nullable String bible, List<String> mustPass,
                           boolean templateFirst, boolean designLots, @Nullable String model, @Nullable Double budgetUsd,
                           @Nullable String owner, JsonObject ext) {}                                                    // 6c
```

### Additions to existing types

- `ArchitectApi.regions()` (default: throws).
- `LoadPolicy` gains the component `boolean generate`. The old constructor means `generate = true`. Also
  `GENERATED_ONLY(int)` and `generates()`.
- `CellWrite` gains `@Nullable Cond cond`, with `enum Cond { IF_NATURAL, IF_SOLID_NATURAL, IF_AIR_OR_FLUID, ALWAYS_OURS }`
  (null = the request's `naturalOnly` meaning, as before). That makes the condition available to Java `placeCells` callers
  too.
- `SiteView` gains `@Nullable String region`. `Sites.list()` keeps returning every site, tiles included. Architect's
  Placed view groups a region's tiles into one row.
- `Design.Kind` gains `REGION` (appended, 6c).
- `Reason` (appended): `NOT_GENERATED`, `CHUNK_BOUND`, `DRIFTED`, `SIDECAR_UNAVAILABLE`, `PLAN_STALE`, `REGION_LIMIT`
  (and `PLAYER_BLOCKS` in 6c only if needed, see the 6c gate).
  - `DRIFTED`: realise refuses when the region-start heightfield sample differs from the plan survey beyond the tolerance:
    per sampled column |dh| at most 2 on at least 95%, and no column over 8 inside a lot pad or path corridor. Steward can
    replan.
  - `PLAN_STALE`: the IR's kit version is newer than the running kit.
- Client: `ArchitectClientApi.previewRegion(String planId, @Nullable String stage)` and `PreviewStyle.REGION` (appended,
  6b).

### Events and features

- **Events:**
  - `REGION_STATE(RegionView)` on every state change;
  - `REGION_PROGRESS(RegionView)` at most 1/s;
  - `PREPARE_PROGRESS(PrepareView)` at most 1/s.
  - The existing `ITEM_*`, `STAGE_STATE` and `SITE_PLACED/REMOVED` events fire for tiles and lots as for any batch item;
    tile items carry `ext["architect_mc:tile"]`.
- **Features:**
  - 6a: `regions`, `regionPrepare`, `generatedOnly`, `cellConditions`, `chunkBound`;
  - 6b: `regionCheck`, `regionPreview`, `regionGhost`;
  - 6c: `regionDesign`.

### Sidecar protocol (2, additive)

Client -> sidecar:
- `region.plan {program, params, seed, claim, surveyBlobId, bible?, bibleVersion?}` -> ack `{planId}`, then
  `region.planned {planId, irSha, lots, stages, anchors, budget, notes, report?, previews?}` or
  `region.failed {planId, message}`;
- `region.tiles.request {planId, irSha, ir?, tiles: [{key, heights}]}`; the answers are `region.tile` /
  `region.tile.error`;
- `region.preview {planId, views, axes?}` -> ack `{paths, sitePlan}` (6b);
- `region.check {planId}` -> ack `{report}` (6b);
- `region.design {spec}` -> ack `{designId}`, then `design.upsert` with `kind: "region"` (6c);
- `region.release {planId}` (drop cached tiles and IR).

Sidecar -> client: `region.planned`, `region.failed`, `region.tile`, `region.tile.error`, plus `ir_unknown` as an error
code on `region.tiles.request`.

Snapshot features: `region.plan`, `region.tiles`, `region.preview`, `region.check`, `region.design`. Protocol-1 clients see
none of it.

**Kit CLI:** `node kit/tools/region.mjs plan <program> --params p.json --survey s.bin --seed n --claim x0,z0,x1,z1 [--bible b.json] [--out dir]`,
`eval <ir.json> --tile tx,tz --heights h.bin [--json]`, `check <ir.json> --survey s.bin` (6b), and
`preview <ir.json> --survey s.bin --views top,section,iso,siteplan` (6b). Exit codes are 0, 1 (findings or failure) and 2
(usage), as `diff.mjs`.

### DevBridge (docs/DEVBRIDGE.md changelog)

- `dev.region.plan`, `dev.region.prepare`, `dev.region.realise`, `dev.region.state`, `dev.region.remove`.
- `dev.region.hash {regionId | box, ySpan?, exclude?}`: sliced over ticks; tiles of 64x64 columns, hashed per tile and
  combined.
- `dev.chunks.generated {since}`: the number of chunks that reached a generated status since a mark (the "0 generated
  during realise" counter).
- `dev.mspt.trace {start|stop}`: per-tick times split into Architect slices, the journal handoff and the rest.
- `dev.journal.killAt` gains RG1-RG6.
- `dev.heap {gc: true}`: used heap after a forced GC.

---

## 7. Performance budgets

Measured on this machine (M5 Max), dev client, singleplayer, render distance 12, unless a gate item says otherwise.

| What | Budget |
|---|---|
| tile evaluation (sidecar, 4 workers) | at least 3x the write rate: at least 45k cells/s on mega_bench; the writer is starved (no ready tile) in at most 5% of its ticks |
| wire size | at most 4 bytes per cell (packed, before base64) |
| realise write rate at 4 ms, prepared chunks | **at least 15k cells/s** = cells written / wall seconds from the first tile write to the last, prepare excluded. The 4e step's `cellsPerSecond` is recorded beside it. |
| MSPT during realise | **0 ticks over 50 ms**; p99 at most 25 ms |
| MSPT during prepare | **0 ticks over 100 ms**; at most 1% of ticks over 50 ms; chunks/s recorded |
| chunks generated during realise | **0** |
| failed items | **0** `TIMED_OUT`, 0 `NOT_LOADED`/`NOT_GENERATED` failures, 0 `CHUNK_BOUND` in the fixture |
| liveness (because region waits have no time limit, "0 failures" alone could pass by hanging) | config A finishes every item within **45 minutes** of the first tile write. Under `GENERATED_ONLY`, no item waits more than **30 s** while its chunks are all generated and it holds its tickets (`dev.region.state` logs every wait over 10 s with its chunk statuses). Config B: progress resumes within **60 s** of the player arriving at a waiting item's chunks, and within **30 s** of the sidecar coming back. |
| memory | The dev client's heap holds client and integrated server together, so the **baseline** is the used heap after a forced GC in the same world, standing at the claim centre, with no region running. Used heap after a forced GC at 5 checkpoints is at most baseline + 1 GB, and mega_bench completes under **`-Xmx` = baseline + 2 GB** (rounded up to a whole GB; expected 4-5 GB). The 4e run's 6.27 GB was a sum of pool peaks, unconstrained: it is recorded the same way for comparison. Sidecar RSS at most 1.5 GB. |
| journal | at most 1 byte per cell over mega_bench (4e: 0.40); index at most 8 MB; index commit p99 at most 100 ms |
| region group undo | exact (gate); at most 10 minutes for mega_bench; 0 ticks over 50 ms |
| one lot's undo | at most 5 s; the pad under it exact |
| checker (6b) | coarse at most 60 s, full-resolution at most 120 s on mega_bench; prefix checks at most 2x one full check |
| plan (sidecar) | the mega_bench plan at most 30 s including the coarse budget pass |

---

## 8. mega_bench (Steward's fixture, A5B §6a)

`kit/regions/mega_bench.mjs`, bundled and deterministic (seed fixed), with no Claude call:
- claim 1000x1000;
- **one big carve**: a bowl of radius 160, depth 28, with a `rubble` lining;
- **a ring wall**: radius 470, height 10, thickness 4, towers every 48, 4 gates;
- **terraces**: 3 terraced hills of 5 levels;
- **bridges**: 4, spans 40-120, pillar supports, one with arches (6b; a pillar version in 6a);
- **stairs**: a spiral stair into the bowl;
- **roads**: ground roads joining the gates and the districts, plus graded roads to the terraces;
- **lots**: 200 lots on pads, children from 4 stub blueprints (boxes 9-24 wide, 6-14 tall) and the 4 kit examples, so 4d's
  shared cell lists apply;
- **stages**: `ground` (carve, terraces, pads), `ways` (roads, stairs, bridges), and `lots-1` to `lots-4` (50 lots each).

The plan records the exact cell count. **About 10M cells (±30%)** is expected, comparable to 4e's 11.6M.

Two configurations, each in a fresh world of fixed seed `mega6` (normal worldgen: terrain generation is the point):
- **A: prepared.** `prepare`, then `realise` with `GENERATED_ONLY`, the player standing at the claim centre. Every bar in
  §7 applies.
- **B: staged near the player.** `LOADED_ONLY`, with a scripted player walk through the claim (DevBridge teleports every
  30 s along a route), a relog in the middle of `lots-2`, and a sidecar kill in the middle of `ways`.
  - Bars: 0 failed items, resume after the relog and after the sidecar comes back, and stage progress reported.
  - Throughput and MSPT are recorded (here the player's own exploration generates chunks, which Architect doesn't govern).

**Exactness, stated up front** (the 4d L3 / 4e class: worldgen blocks that can't stand on their own break after a restore):
- **E-flat.** mega_bench on a flat-preset world, same seed, with `randomTickSpeed 0`, `doMobSpawning false`,
  `doFireTick false` and `doWeatherCycle false`. After the group undo the claim + 8 over the written y span ± 8 equals the
  pre-region hash, every cell plus BE NBT: **0 mismatches**.
- **E-normal.** Configuration A's world, same gamerules. Mismatches are allowed only where a deterministic classifier
  (`dev.region.classify`) labels the **pre-region** cell as unable to stand on its own: a gravity block over air or fluid,
  or a plant or mushroom without valid support or light.
  - Each one is listed with its position.
  - The count is at most 0.01% of written cells.
  - The same classifier run over the atomic-restore baseline of one tile in a world copy must show the same class (4e's
    method).

---

## 9. Phase 6a gate

1. **Unit and property tests (no game, no Claude):**
   - Kit:
     - shape SDFs against analytic fixtures;
     - every 6a primitive's guarantee, as a property over random params: stair rise and headroom, bridge span and deck
       continuity, terrace flatness, pad flatness and cut/fill limits, ring gates clear, pillar reaching ground;
     - conditions, last-op-wins, claim clipping;
     - the realise lint;
     - packing round trips.
   - **Determinism (D9):** IR byte-identical over 3 plan runs; every mega_bench tile's sha identical for 1 and 4 workers,
     forward and shuffled order, and on Linux and macOS CI (the tile shas are a committed golden file).
   - Mod, pure JVM (world seam): a tile's P1-P8 with conditions; region undo planning equals per-tile planning; the
     queue-time `CHUNK_BOUND`; `GENERATED_ONLY` never tickets an ungenerated chunk (fake chunk source).
   - Sidecar: the `region.*` messages; the window and backpressure; `ir_unknown`; worker crash; plan limits; the sim
     backend for `region.plan` with a throwing program.
2. **The timeout diagnosis** (`artifacts/gate6a/timeouts.md`): the 11 megabig timeouts reproduced and classified, with the
   fix that addresses each class.
3. **Chunk-status verification:** how 26.3 knows a chunk is generated without loading it (or the governed fallback),
   written down with its measured cost.
4. **mega_bench A (prepared):** every §7 bar, recorded in `artifacts/gate6a/REPORT.md` and `megabench.json`:
   - plan time; prepare time, chunks and MSPT;
   - realise cells, wall, cells/s both ways, MSPT max/p99/ticks over 50 ms, starvation share;
   - the lighting/sync tick share;
   - the heap baseline, the checkpoints, and the run under the capped `-Xmx`;
   - journal bytes, index size and commit p99;
   - wire bytes per cell, evaluation p50/p99 per tile;
   - group undo time and MSPT; one lot's undo time.
5. **mega_bench B (staged):** 0 failed items, the relog and sidecar-kill resumes, per-stage progress events.
6. **Exactness:** E-flat (0 mismatches) and E-normal (the classified rule), after the group undo. One stage's undo
   (`lots-3`) and one lot's undo are exact on the cells they own. A player block placed on a pad cell after realise survives
   the group undo and is reported in `kept`.
   **Forest rim:** a tile where the bowl's rim crosses worldgen forest. No log is left without a log or ground under it
   (checked by a scan), held leaves are on the tile's `leaves` entry, and the tile's undo is exact, with
   `randomTickSpeed 3` (default) over a 2-minute stand before the undo.
7. **Crash:** RG1-RG6 and K3/K7 inside a region, each by `dev.journal.killAt` and a restart. Each ends in the stated state,
   a resumed realise gives the same region hash as an uninterrupted one in a world copy, and the final group undo is exact
   (E-flat world).
8. **Invariant iii for regions:** a lot LAYERed on a pad with a player edit on a lot cell. Remove the pad and the lot in
   both orders: the same end state (no CELL over BOX occurs; the test proves it).
9. **Regressions:**
   - every sidecar, kit and mod test;
   - the 4d gate; 4e gate items 2 (any order), 5 (crash), 6 (roads plus village), 8 (MSPT and throughput), 9 (4d
     regression) and 10 (mega-lite);
   - 5b gate items 2 (chains: the fixed script plus 5 seeded), 4 (village deltas) and 5 (MSPT);
   - the 4a jobs, 4b and 4c sim suites;
   - **the 1.7.0, 1.6.0 and 1.5.0 apitest jars, unchanged, pass against 0.11.0**, and `api-compat` is clean.
   - **The throughput margin:** the 4e village plus roads at 4 ms is run **3 times**; the bar is the **median at least
     15k cells/s**, with all three numbers and their spread recorded.
     - If the median is within 5% of the bar (under 15.75k), the verifier runs 3 more and the median of 6 decides.
     - A miss fails the gate. It is not waived: the fix is either a throughput change or an explicit budget change by Noah.
     - A target of at least 17k is stated, not gated: 6a may profile the per-cell path, since it now matters at 10M
       cells.
10. gate-verifier checks the result, including that no step spent money.

## Phase 6b gate (outline, frozen with 6b's own review)

- **Fixtures and expected reports:** `crater_works`, `sky_isle`, `rift_city` and `walled_hill` each match their expected
  checker report (which rules fire, and why).
- **Broken variants caught:** a lot with no path (M2), a carve that opens a lake (M4), a floating spur (M3), a dark cavern
  (M5), a bridge span over its limit (M10), a stair with rise 2 (M7).
- **Prefix checks:** they hold on every stage prefix of `walled_hill`; the per-prefix check time is within budget.
- **Preview goldens:** byte-identical; the section and site-plan views have been looked at (screenshots); `siteplan.json`
  validates against its schema.
- **The region ghost:** a screenshot that has been looked at, inside and beyond 64 blocks.
- **Checker time on mega_bench** within budget.
- **The Terrain tab:** a bundled program planned, previewed, realised and undone in a dev world, exact (`crater_works`
  at 200x200 under **default** gamerules, with the classified-mismatch rule).
- **Regressions:** the 6a gate items 4 (shortened: one mega_bench A run), 6 and 9.

## Phase 6c gate (outline; Steward's A5B §6 gate, refined)

- From a fresh dev world, `Regions.design("a crater mining facility")`: a template pick or authored program. The plan has
  **no M1, M2, M3 or M4 findings**. It is prepared, then realised through the queue. Its lots are filled from library
  entries and variants, then placed. One `Regions.remove` returns the area cell for cell (the 6a exactness rules).
- **The player block, split into its two cases:**
  - **(a) before realise:** a block the player placed inside a lot's pad area is skipped by the pad (noted). The lot's
    child must then refuse, because A5B N2 says the player's own blocks inside a lot still refuse placement. The region
    ends `partial`, and after the group undo the block is still there.
    - Not verified from the code for this draft: whether 0.10.0's check refuses a non-natural block without a block entity
      inside a LAYERed box, and with which `Reason`. The occupancy path gives `PLAYER_IN_BOX` or `OCCUPIED` for entities
      only, and `BLOCK_ENTITIES` covers block entities only.
    - The 6c build pins the reason. If the check only clears such a block, 6c adds the refusal as a new appended `Reason`,
      `PLAYER_BLOCKS`, returned by `check()` and the queue. It is a behaviour change to 4e's LAYER, listed.
  - **(b) after realise:** a block placed on a pad or path cell survives the group undo and is reported in `kept`.
- A second brief ("a terraced hillside village") through authoring, with its checker rounds recorded.
- **Spend:** within the $25 cap; the claude login only (environment log); the estimate within ±50% for each run.
- **Regressions:** 6a items 6 and 9, and 6b's fixtures.

## Phase 6d (outline, recommended to wait)

- **Region delta (A5B N7):** re-plan, then diff the IRs by part id. Changed parts' tiles are re-evaluated **against the
  same frozen heightfield**, and the new cells are written as a new CELL layer per tile.
  - LIFO undo, as 5b D5.
  - Cells under a standing lot refuse `COVERED`, or the caller cascades the lots: no CELL over BOX.
- **Deltas for cell sites and 4e roads.**
- **Pad delta under standing lots** (5b D7's deferral): rewriting the cover's `before` with its own undo. It needs its own
  invariant work, because it is the only place a terrain change would sit under a BOX entry.

## Build order inside 6a

1. The timeout diagnosis and the chunk-status verification (gate items 2 and 3), with the 0.10.0 jar. Also an index-commit
   measurement at 2k synthetic entries.
2. Kit: IR, shapes, noise, the realise evaluator, packing, the lint, the 6a primitives, the determinism goldens,
   `mega_bench.mjs`.
3. Sidecar: `region.plan` in the child process, the worker pool, `region.tiles` with the window.
4. Mod: prepare and the governor; `GENERATED_ONLY`; `CHUNK_BOUND`; heights freeze (H0); tile items on the 4e large-cell
   path; region records and states; RG kill points; undo.
5. Java 1.8.0, apitest steps, api-compat.
6. Gate items 1 and 4-9.

## Open questions for Steward

- **S1. The write unit.** A region change-set is a set of 64x64 tile entries (D4), one undo group with the region's stages.
  Is that enough for N8, given `RegionView` aggregates the tiles and `Sites.list` shows them individually? Or do you want
  tiles hidden from `Sites.list(owner)`?
- **S2. The frozen heightfield (D3) instead of "a fresh survey per section".** Surface-relative ops resolve against the
  pre-region surface captured at first touch. The drift check runs at region start (and per stage) against the plan
  survey. OK? The tolerance is |dh| at most 2 on 95% of sampled columns and none over 8 in pads and paths. Are those numbers
  right for your replan prompt?
- **S3. Roads (D8).** Ground roads compile to 4e roads; graded roads, ramps, stairs and decks are cell lists whose walk
  cells count as road for approaches. Does that cover sky roads and crater ramps?
- **S4. Closed shape library (D1).** No per-cell JS callbacks at realise time. `heightfield` and `mask` blobs are the escape
  hatch. Enough for rift, sky city, crater and castle, or is a shape missing?
- **S5. Roles.** `scorched` and `lining` aren't macro roles today. Use extra roles with a fallback, or add them to
  `MACRO_ROLES` (a bible-format bump that settlement bibles would then need)?
- **S6. Prepare as a step.** Region realise waits for `prepare` by default (`GENERATED_ONLY`), and the state shows
  "preparing ground". Is that acceptable in your inbox flow, or should realise auto-prepare?
- **S7. Lot children.** Realise takes `lot id -> blueprint` from you, and unmapped lots stay pads. Is `designLots` in 6c
  needed, or do you always run your own design group?
- **S8. Waits without a limit** for region items (`NOT_LOADED`, `NOT_GENERATED`, `SIDECAR_UNAVAILABLE`). Good for staged
  builds over days?
- **S9. The mega_bench composition** in §8 (stages, 200 lots, about 10M cells): does it match what you want measured? Is
  configuration B's scripted walk a fair stand-in for "build near the player"?
- **S10. The site plan as SVG + PNG + `siteplan.json`**, and the set-level critic deferred: OK?
- **S11. Survival.** Regions refuse in survival-toggle worlds until Noah's terrain rule (N4). Does anything in your Supplied
  or Hardcore plans need regions before that?

## Open questions for Noah

- **N1. The split.** 6a, 6b, 6c and 6d, each gated, with API 1.8.0, 1.9.0 and 1.10.0 (or one 1.8.0 with members that throw
  until they land). And 6d waits for Steward's phase 3?
- **N2. Spend.** 6c only: about $12 expected, a $25 cap, a $35 ceiling, on the claude login. 6a and 6b are $0.
- **N3. Pre-generation.** `prepare` generates terrain the player hasn't explored: about 4.2k chunks for mega_bench, tens of
  MB of region files. OK as an explicit step, shown in the UI?
- **N4. Survival terrain.** Free natural-only cut and fill (no BOM, no drops) for terrain ops in survival-toggle worlds, or
  regions stay creative/Patron only? (Open since 4e SHOULD 2.)
- **N5. Gate conditions.** The scale exactness runs use `randomTickSpeed 0` and no mob spawning, fire or weather. The 6b
  Terrain-tab run uses default rules. Acceptable?
- **N6. Claim limits.** 1024x1024 by default and 2048x2048 behind a dev flag, matching Steward's "plausible after measuring"
  and "experimental" classes.
- **N7. Player UI.** A Terrain tab with bundled programs in 6b, or commands only until Steward needs it?
- **N8. The throughput bar.** Keep 15k at 4 ms (median of 3, a miss fails), or lower the bar explicitly if 6a measures that
  10M-cell terrain makes it unrealistic?

## Deferred (recommended)

- **The set-level critic and any critique of regions** (5a/5b outcomes; future inputs: `siteplan`, `top`).
- **Region evolution (6d):** region deltas, deltas for cell sites and roads, pad deltas under standing lots.
- **Survival regions** and construction mode for cell sites (N4).
- **Routed roads** (pathfinding between entrances). Programs give polylines.
- **Utility modules** that use `utility` corridors (Steward phase 5).
- **Nether and End regions** (the survey's ground definition).
- **Moving or rotating a region.** Re-plan and re-realise.
- **A Java copy of the shape math.** Never (A5B §7.2).
- **Textured region renders**, and HeadlessMC for scale gates.
- **Absorbing covered entries** (4e's `absorb`). Revisit only if mega_bench's index bar fails.
- Still open from earlier phases, unchanged: the Nether ground search; exports without source; REPLACE overlap.

## Coordinator decisions on Noah's questions (provisional; Noah may override)

- **N1** Yes: split into 6a (engine and scale, API 1.8.0 / mod 0.11.0), 6b (checker and previews), 6c (Claude authoring) and
  6d (region deltas, waiting for Steward's phase 3), each with its own gate and minor version.
- **N2** 6c: about $12 expected, a $25 cap and a $35 ceiling, on the claude login. This is in line with the spend Noah has
  approved before; he is told before 6c starts.
- **N3** Yes: pre-generating unexplored chunks with `prepare` is an explicit, throttled step that the caller (or the player)
  starts. It is never implicit.
- **N4** Regions refuse in survival-toggle worlds until Steward's difficulty modes settle the terrain rules (the 4e
  `placeCells` precedent).
- **N5** Yes: scale exactness runs use the gamerules the draft proposes (random ticks 0, fire spread off, mob griefing off) and
  state them in the report.
- **N6** Yes: 1024 by default, and 2048 behind a dev flag.
- **N7** Commands and the API in 6b. A player-facing Terrain tab waits until regions see real use.
- **N8** Keep the 15k bar, measured as the median of 3 runs.

## Changes from Steward's review of phase 6 (steward-mc/docs/A6-REVIEW.md), all accepted

Where this section and the phase 6 text above disagree, this section wins.

- **S1** `Sites.list(owner)` returns one `RegionView` per region. Its tiles are hidden unless `includeTiles` is set (debugging).
- **S2** Frozen heights and the drift tolerances as drafted. Drift is reported as "land changed since planning", and the caller
  chooses to replan or continue.
- **S4** The closed shape library is enough for 6a. **6b adds** `wedge`/`prism` and `array(shape, step, n)` (repetition without
  inflating the IR), not blocking.
- **S5** `scorched` and `lining` are extra roles with a `??` rock fallback. `MACRO_ROLES` does not change.
- **S6** `prepare` stays explicit. It first returns a size and time estimate, shows a visible "preparing ground" state, and never
  starts silently or automatically.
- **S7** No `designLots`; `Regions.design` is kept for bundled programs.
- **S8** Waits have no time limit for staged builds. The wait reason is shown with a nudge action (move closer, prepare), and
  `maxWait` is opt-in.
- **S9** The mega_bench composition is accepted. The gate also records **seconds per stage and chunks loaded per stage** (B's
  scripted walk goes in stage order and stops per stage).
- **S10** SVG, PNG and `siteplan.json`; Steward reads `siteplan.json`. The set critic stays deferred.
- **S11** No survival regions before Noah decides N4. Steward recommends free natural-only cut/fill (terrain is not a material),
  recorded for Noah.
- **N8** The 15k bar stays at the median of 3, and a miss is recorded with its measured number (it still fails the gate).

## Phase 6a as built (API 1.8.0, mod 0.11.0, recorded 2026-10-08)

Built on branch `phase/6a`. Gate record: `artifacts/gate6a/REPORT.md` (local). Where this section and the phase 6 text
disagree, this section says what shipped.

**The 4e timeouts and spikes (gate item 2, `artifacts/gate6a/timeouts.md`).**
- The timeouts were lost shared chunk tickets. Vanilla keeps one ticket per (type, level) and chunk, so the first of two
  Architect holders to release one dropped it for both; the other waited `NOT_LOADED` holding its share of the bound until
  `TIMED_OUT`. Architect's tickets are now reference counted (`ChunkTickets`). Waits a region item does not cause
  (`NOT_LOADED`, `NOT_GENERATED`, `SIDECAR_UNAVAILABLE`, ticket turns) no longer count toward its limit.
- The spikes were not terrain generation (vanilla's part of every slow tick was under 1 ms). They were journal region reads
  on the server thread during road checks, and single-tick cabin placements over a 256x256 pad entry. Roads and cell sites
  now warm the journal off-thread before their checks; regions use 64x64 tile entries.

**Chunks generated during a realise (diagnosis).** One failed megaA run generated 161 chunks during a stall, cause unknown;
later runs generated none. Each one is now logged whatever `ARCHITECT_TRACE_JOBS` says: the first 1000 per region with their
position, the Architect ticket holding them (if any), whether a prepare runs, the nearest player's distance in chunks against the
view distance, and whether they lie in the claim + 2 chunks. The count is always kept (`stats.generatedDuringRealise` in the
region record); the logged list goes to `<region>/generated.json` when the batch ends and to `dev.region.state`.

**Chunk status without loading (gate item 3).** `ChunkGen`: the chunk map's latest status when the chunk is in memory, else
`IOWorker.scanChunk` reading only the `Status` field of the stored NBT (pending stores included), cached per chunk.

**Deviations and decisions made while building:**
- `CHUNK_BOUND` refuses building items only; oversized road and cell items keep 4e's "run alone" (mega-lite's 256x256 pad).
- The default realise bound is `GENERATED_ONLY(max(64, largest need + 72))`, which fits two freezes ahead. A ticket janitor
  returns tickets an item holds for nothing.
- Heights freeze per tile window, and **no region item writes a column before it is frozen** (H0 for every writer). A lot
  freezes the not-yet-frozen columns of its snapshot box (the approach included), and a 4e road those of its ticketed box,
  after their chunks are loaded and before their check and capture. So a later-stage tile over an earlier stage's lot or road
  reads the pre-region land in any stage order, a `reorderStages` included, and no plan is refused for its stage order. This is
  the narrow form of SETTLEMENTS.md's 7a "freeze before lots" (the item's own columns rather than the whole tile window). It is a
  no-op on mega_bench and region_small's lots, whose columns the ground stage's tiles froze; region_small's road freezes the
  columns of its box outside them. (SETTLEMENTS.md's 7a note, on main, still describes this as a later change.)
- The plan flow is plan (`LOADED_ONLY`, the prepare estimate), prepare, plan again (`GENERATED_ONLY`, the complete survey),
  realise. In a survey, `GENERATED_ONLY(n)` means n chunks at once and any number in all; `LOAD_BOUNDED` keeps 4a's total cap.
- **Drift (S2) is checked at region start and before each later stage**, on stored heightmaps (loaded chunks live; no chunk
  loads). At region start the plan survey is the baseline, and `force` passes a drifted start (it covers the start check only).
  Before any stage but the one that runs first (in the group's order, so after a `reorderStages` too) starts, up to 4096 columns of its tiles and lot boxes are compared with the region's own
  baseline there: the height the region's placed items left (`after/<tx>.<tz>.bin`, snapshotted when each tile, road or lot
  places), else the frozen pre-region height, else the plan survey. The tolerance is the start check's. Land changed beyond it
  **holds the stage**: it goes back to PLANNED (`StageRules.hold`), the `RegionView` waits `DRIFTED` with "land changed since
  planning: ...; stage <s> holds: approve it again to continue, or replan", and `REGION_STATE` fires. Continue is
  `Sites.approveStage` on the region's group (no new API); replan is skipping the stage or removing the region. The outcome
  (`ok`, `held`, `continued`) is kept per stage in the region record, so a relog neither checks again nor drops a hold. While
  the check runs (asynchronous reads) the stage's items don't start and no tile ahead is frozen. After-heights are flushed at a
  world stop; a shard lost to a crash makes that stage compare those columns with the frozen heights, which can report drift the caller continues past.
- `RegionPlan` carries no checker report or previews (6b). Region futures fail with `RegionRefused(reason)` (new API type).
- Lots fit flush (setback 0, the approach into the street). Unmapped lots stay pads.
- **Exactness guards (E-normal).** A tile skips an air write that would let water or lava in. What stands on any changed
  cell (snow, plants, leaf litter, sand, gravel, kelp and so on) goes with it as cells of the tile's entry. Water or lava
  that flowed into air a CELL entry cleared counts as still the entry's. The E-normal classifier labels gravity (including
  the landing cell), unsupported blocks and world-made block-entity changes as `live`. `live` is strict, because it could
  otherwise mask a real block-entity error: a mismatch that keeps its block and changes its block entity is `live` only on a
  block the world itself changes (bee nests and hives, furnaces, smokers, blast furnaces, hoppers, brewing stands, campfires,
  spawners and trial spawners, vaults, sculk sensors, catalysts and shriekers, conduits, beacons, creaking hearts:
  `LiveBlocks.LIVE_BE`). On any other block (a chest whose loot table resolved, a sign) it is `none`, unexplained, and fails the
  bar. Every `live` mismatch on record so far (megaA, the verifier's megaA, forest) is a bee nest.
- **Ticks.** A tile's check runs in stages under the tick budget (cells, fluid guard, trees, dependents, leaves) and is
  assembled off the server thread; tile jobs capture over ticks and build their sections off-thread from 8192 cells. The
  group undo prepares its journal commit and its covering-sites scan off the server thread and checks members over ticks.
- **Journal format 2.** Sections with more than 256 cells store positions as a 4096-bit mask (0.20 bytes per cell on
  mega_bench, was 1.59). Format 1 is still read. The index is written as version 2, so 0.10.x refuses a world 0.11.0 has
  written (a safe downgrade refusal).
- **Waits (S8).** A region's items wait without a time limit by default; the wait reason is shown in the region's
  `RegionView.waiting`. **`maxWait` is opt-in**: `RealiseRequest.maxWaitSeconds` (a region option; 0 = no limit; DevBridge
  `dev.region.realise {maxWait}`). With it set, every wait of an item counts toward the limit, the staged ones (`NOT_LOADED`,
  `NOT_GENERATED`, `SIDECAR_UNAVAILABLE`) and its turn for the chunk budget included, and an item over it fails `TIMED_OUT` with
  "waited N s for: <the wait reason>". The limit is per item and stages run in order, so a region whose every stage waits gives
  up after up to (stages x maxWait). A stage held for drift is not an item wait and does not count. The **nudge action API**
  (an action attached to the wait reason: move closer, prepare) is deferred to 6b; 6a shows the reason text only. Inside a region's items, a dropped item nobody threw (loot of an animal the region's own carve killed) is cleared
  like a natural drop; named items and items a player threw still refuse. Regions are creative-only (N4).
- **Still ours, more volatile changes.** Grass, mycelium and podzol turning to dirt (or back) by random ticks counts as still
  the entry's; so does water or lava in air a CELL entry cleared. The E-normal classifier adds `growth` (kelp, cane, vines,
  crops, saplings, grass spread) beside gravity, unsupported and live.
- **Delta apply (5b, found by the regression).** The cells other sites hold on top of a delta's write box are computed off the
  server thread (a 590k-cell site read every section in the first write tick: 50-84 ms on main and 6a alike).
- **Gate procedure clarifications (after the gate-verifier's run).**
  - *Throughput warm-up.* The JIT is cold after a client start: the verifier's first run after each start measured 12.3k and
    13.4k, the rest 19.5-26.8k. Item 9's throughput margin is measured as **one unmeasured warm-up run of the 4e village plus
    roads at 4 ms per client start, then the median of 3 measured runs** (`node tools/gate4e.mjs throughput`; 6 runs when the
    median is within 5% of the bar). The warm-up's number is recorded beside them, not judged.
  - *megaB seconds per stage* (S9) are wall time of the harness's walk, dominated by its 30 s dwell per waypoint, not an engine
    speed. Each stage now also records its engine time (ticks in which one of its items was writing), its first start and last
    item (`RegionRec.Stage`); chunks loaded per stage stay as measured. The megaB on record predates this; its next run reports
    engine time per stage.
  - *RG5* asserts that the region waited `SIDECAR_UNAVAILABLE` while the sidecar was gone (the check was always true before).
- The group undo saves the group and its stages once at the end (each stage save wrote the 0.5 MB sites file).
- Group undo: a player standing in a tile's box holds it (4e's rule); the gate uses a spectator player and clears mobs first.
- `RemoveResult.kept` for group and stage undos counts kept cells (it was 0).
- `Sites.list(owner)` hides tiles (S1); the client's Placed view still lists tiles (no player UI in 6a).
- Sidecar plan directories live under `<data>/regions/plans`; the 30 s plan limit is wall clock.

# Phase 6b contract: checker, previews, volumes, IR format 2, the scenario harness and the crater gate - FROZEN after Steward review

Status: **draft**, 2026-10-09. Nothing here is built. After Steward's review this becomes the "Phase 6b contract" section of
`docs/CONTRACT.md` (frozen), following the usual process.

Goal: **check and show a region before it is built, and turn the first golden scenario green.** 6b adds the macro checker
(M1-M14, plus the `player` mover for M2), the four previews and `siteplan.json`, the region ghost, the 3D volume survey,
IR format 2 (side blobs, new shapes, material rules), the `floatingIsland` generator, the scenario harness, and Noah's
gallery. Template-first `Regions.design` ships with two bundled programs, `crater_works` and `rift_city`, so Steward's
phase 2 prompts can run as template picks. Golden scenario S1 (floating islands) goes green.

Versions: API **1.9.0**, mod **0.12.0**, kit `KIT_VERSION` **0.12.0**. The sidecar protocol stays **2**: messages are
additive and come with new feature names. Phases 1-6a still hold except where this section changes them. Where they
disagree, this section wins.

Sources, read for this draft:
- `docs/SETTLEMENTS.md`, all of it. It is the binding direction, including "Noah's decisions (2026-10-08)", "Changes
  from Steward's review" and "Note after 6a".
  - §3.2 (IR format 2), §3.3 (material rules), §5 (the 3D volume), §9.1-9.2 (`floatingIsland`), §11 (rule numbering),
    §15.1 (`siteplan.json`), §16 (the scenario ladder, bars, gallery), §17.2 (6b scope).
- `docs/CONTRACT.md`:
  - the phase 6 contract: §1 (program model, shape library, limits), §2 (primitives marked 6b), §4 (virtual world,
    checker, views, ghost), §6 (API 1.8.0 rules and the planned 6b/6c members), §7 (budgets);
  - the 6b and 6c gate outlines;
  - "Changes from Steward's review of phase 6" (S4 `wedge`/`prism`/`array`, S7 no `designLots`, S8 nudge, S10 siteplan);
  - "Phase 6a as built". The nudge action API was deferred to 6b. `RegionPlan` shipped without report or previews.
- `docs/PLAN.md`: the 6a status (passed 2026-10-09, the open items).
- Steward, read only:
  - `steward-mc/docs/A5B-SPEC.md` §3 (M1-M14), §6 (fixtures, broken variants, gate);
  - `A6-REVIEW.md` (S4, S7, S8, S10);
  - `A7-SETTLEMENTS-REVIEW.md` (S1: ship `crater_works` and a rift; villagers don't climb);
  - `PLAN.md` phase 2 gate ("the rift and a custom 'meteor crater mining facility' prompt").
- Code at `main` (`dd622d6`, v0.11.0):
  - `kit/lib/realise.mjs`: `compileIR` throws `IR: format must be 1`, and an unknown op kind throws;
  - `kit/lib/region/plan.mjs`: `KIT_VERSION = '0.11.0'`; the IR's `blobs` are inline base64 (`kit/REGIONS.md`);
  - `api/Regions.java`: 1.8.0 shipped `plan`, `prepare`, `cancelPrepare`, `prepareState`, `realise`, `remove`, `get` and
    `list`. **It did not ship** `previews`, `design`, `RegionDesignRequest`, `CheckReport`, `PreviewView` or
    `RegionPreviews`, which the phase 6 text listed;
  - `api/Reason.java`: `PLAN_STALE` exists, but no code returns it;
  - `api/Design.java`: `Kind { DESIGN, MASSING, REPORT, POLISH }`, so `REGION` was never added;
  - `region/TileStream.java`: `region.tile.error` fails the tile with the sidecar's message;
  - `kit/regions/`: only `mega_bench` and `region_small`. The four family fixtures don't exist yet;
  - `kit/test/fixtures/regions/mega_bench.golden.json`: 6a's committed tile-sha golden.
- `docs/GATES.md` **does not exist yet**. The `tools/gate-runner` worktree is at `dd622d6`, with no commits beyond main.
  This draft uses the gate-runner policy as the coordinator described it:
  - two tiers;
  - the **full engine chain** only when realise, the journal or streaming change;
  - otherwise the **`regress`** chain.

  Where this draft names the `regress` chain, it lists the steps it means (gate item 12). When GATES.md lands, its names
  win, provided the steps are the same.

---

## What 6b inherits and what it must fix

| Item | Record | What this contract does |
|---|---|---|
| The planned 1.8.0 members that didn't ship | `previews`, `design`, `CheckReport`, `PreviewView`, `RegionPreviews`, `RegionDesignRequest`, `Design.Kind.REGION`, `RegionPlan.report/previews` | All land in **1.9.0** as additive members (§6). |
| Nudge actions (S8), deferred from 6a | `RegionView.waiting` shows the reason text only | `WaitAction` and `Regions.nudge` (§6.3). |
| `PLAN_STALE` is declared but unused | A newer IR fails each tile with `IR: format must be 1` | 0.12.0 refuses `PLAN_STALE` up front, at the defined points (§2.4). The behaviour of 0.11.x is stated and tested. |
| Blobs inline in the IR | A 1024x1024 u16 field is about 2.7 MB base64 against the 4 MB IR cap (K4) | Side blobs by sha (§2.2). |
| The old 6b gate item "Terrain tab" | N7: commands and API only | Replaced by the command and DevBridge path (gate item 9). |
| Program authoring (old 6c) | Moved to 7c | 6b ships **template-first only**: a brief that no bundled program fits returns "no fit", not an authoring session. |
| 6a open items | The 161 generated chunks in one early run (now logged); the structure-template memory leak on repeated 5b sizecap runs | Not fixed by 6b. Both are re-checked by the full chain: `generatedDuringRealise` must be 0 in every 6b megaA, and the leak is recorded if seen. |

## Key decisions

| # | Decision |
|---|---|
| B1 | **IR format 2 is additive and opt-in by use.** A plan emits `format: 2` only if it uses a format-2 member. Format-1 IRs evaluate byte-identically, so 6a's `mega_bench.golden.json` tile shas don't change. |
| B2 | **Blobs leave the IR.** Format 2 names blobs by sha. They are side files in the plan dir, copied into the world dir with the IR. Realise and undo never need the plan dir. |
| B3 | **Refuse early, never mid-write.** The supported IR formats and op/shape/rule kinds are checked at plan accept, realise start and region resume. A newer IR refuses `PLAN_STALE` before any tile is requested. |
| B4 | **Checker on a virtual world** = plan survey + frozen volumes (where taken) + IR, evaluated by the same `realise.mjs`. The phase 6 §4 rules, unchanged except that M2 runs as the `player` mover (SETTLEMENTS §11). |
| B5 | **Generators run at plan time and emit closed-library shapes.** `floatingIsland` is kit code, deterministic and lint-clean, and emits one bounded op per cluster. Its output is ordinary ops. |
| B6 | **Template-first only.** `Regions.design` makes one cheap structured pick among bundled programs. With no fit, it ends `NO_TEMPLATE` (a design outcome, not an authoring session). |
| B7 | **Evaluation is deterministic metrics plus Noah's gallery.** No model judges anything in 6b. A gallery approval is bound to a sha of the evidence it approved. |
| B8 | **The full engine chain gates 6b**, because 6b changes the evaluator and the wire (§9.1). |
| B9 | **Spend: template picks only.** Expected about $0.30, cap $3, on the claude login only (§10). |

### Deviations from SETTLEMENTS.md and the phase 6 text (for Steward's review)

| SETTLEMENTS / phase 6 says | This contract | Why |
|---|---|---|
| §16.3 axis-run share: "forms at most 0.25 (est.; calibrated on S1 in 6b)" | Recorded only in 6b. It is calibrated on 10 held-out island seeds by Noah's marks, and gated from 6c | Calibrating and gating on the same run is the metric gaming §18 forbids |
| §16.3 theme fit, motifs | Not applicable to S1 in 6b (recorded only) | No connector types or district motifs exist before 7a |
| §16.2 S1 brief "linked by rope and stone" | S1 v1 has stone links (bridges with `'ends'` supports and stairs). 7a re-runs S1 with rope bridges | Rope bridges are a 7a connector (§8.2) |
| §16.3 Fit row, villager reachability | Not applicable in 6b | Site lots are 7a/7b, and the villager mover is 7a |
| §3.2 IR format 2 members | Adds `requires` (the format-2 kinds used). Defers `graph`, `siteLots`, `lotEntries`, `fits`, `relief`, `scatter`, `voxels` and `stamp` | `requires` makes `PLAN_STALE` precise. The rest belong to 6c/7a |
| §17.2: `Survey.volume` in 6b | Ships, and is gated by a measurement only (no scenario uses it) | It is the prerequisite for 7a, and the 16M-cell limit must be measured before it is set |
| Phase 6 §8: mega_bench "one [bridge] with arches (6b)" | mega_bench is unchanged. Arches are tested on `sky_isle` and `rift_city` | Keeps 6a's `mega_bench.golden.json` as the byte-identity proof for format 1 |
| Phase 6 §6: `previews`, `design`, `CheckReport` and related types in 1.8.0 | Land in 1.9.0 | They didn't ship in 1.8.0 |
| §17.2 spend est. $1-3 | Expected about $0.30, cap $3 | Authoring moved to 7c; S1 is deterministic |
| Old 6b outline: the Terrain tab gate item | Commands and DevBridge (gate item 9) | N7 |

---

## 1. Scope

### 1.1 In scope

**Kit (no game):**
1. **The rest of the primitives** (phase 6 §2, marked 6b):
   - `cavern` (lighting is mandatory);
   - `utility` corridors;
   - `floating([parts], {anchor})`;
   - `add` with `underside: 'taper' | 'rock'`;
   - `ring` towers and crenels;
   - `bridge` arches and towers.
   - New for floating sites: a `bridge` support style `'ends'` (no pillars). It is legal only when the deck's whole length
     is at most `maxSpan` and both ends bear on cells of declared parts. M10 checks it.
   - New: a lot pad option `pad: {fill: 'none'}` for lots on a generated mass (§4.2).
2. **Shapes** (format 2), all pointwise and lint-safe:
   - `ellipsoid`, `capsuleChain`;
   - `wedge` and `prism` (Steward S4);
   - `array(shape, step, n)` (S4);
   - `warp` (`amp` at most 8);
   - `strata`, `instances`.
3. **Material rules** (SETTLEMENTS §3.3) on `shape` and `columns` ops.
4. **IR format 2:** side blobs, `fields`, `volumes` refs, `forms` provenance, and `requires` (§2).
5. **`floatingIsland` generator** (§4).
6. **Virtual world and the macro checker M1-M14**, with M2 as the `player` mover and prefix checks (§3).
7. **The four previews** `top`, `section`, `iso`, `siteplan`, and `siteplan.json` with the `graph` block (topology only,
   from 6a paths and roads; §3.4).
8. **Bundled programs and fixtures:**
   - `crater_works`, `sky_isle`, `rift_city`, `walled_hill`, each with an expected checker report;
   - the broken variants;
   - `floating_islands` (S1's program).

**Sidecar:**
1. `region.check` and `region.preview`.
2. Plans carry a report and previews.
3. Blob side files and `blob_unknown`.
4. The template pick for `region.design`.
5. `hello` reports `irFormats` and `kitVersion`.

**Mod:**
1. `Survey.volume` and the ARVX freeze (§5).
2. Blob copy into the world dir, and the blob re-send path.
3. `PLAN_STALE` gating.
4. The region ghost (client).
5. `Regions.previews`, `Regions.design`, `Regions.nudge`.
6. DevBridge additions.
7. Commands (no Terrain tab, N7).

**Tools:**
1. `tools/scenarios.mjs` (run, metrics, gallery bundle).
2. `tools/find-site.mjs`.
3. `tools/gate6b.mjs`.
4. The gallery page (§8).

### 1.2 Not in scope (SETTLEMENTS phases)

These come later:
- **6c:** the passes (relief, hydrology, routing, districts); the op kinds `relief`, `scatter`, `voxels` and `stamp`;
  every generator except `floatingIsland`; M17-M20.
- **7a:** site analysis and affordances; the graph as IR data with typed edges; connectors (`rope_bridge` and the rest);
  `nav.json`; the `villager` and `steward` movers; M8 promoted; M15 and M16.
- **7b:** site-aware design.
- **7c:** program authoring, planning and bible format 3.

In format 2, these op kinds are **reserved names that throw** until their phase.

---

## 2. IR format 2

### 2.1 Shape of the IR

Format 2 is format 1 plus the members below (SETTLEMENTS §3.2, the 6b subset). An IR is `format: 2` only if it uses at least
one of them. Canonical JSON (keys sorted) stays the identity (`irSha`).

```
{ format: 2, ...every format-1 member except inline blob data...,
  requires: ["shape:ellipsoid", "shape:warp", "material:rule", ...],   // sorted; every format-2 kind the IR uses
  blobs:   { name: { sha, bytes, kind: 'heightfield'|'mask'|'field'|'volume' } },   // no 'data': side files
  fields:  { name: { blob, type: 'u8'|'i16', minX, minZ, width, depth, res: 1|4 } },
  volumes: { name: { blob, box: {minX..maxZ}, sha } },                 // frozen ARVX volumes the plan read (§5)
  forms:   [{ id, generator, version, params, seed, bounds, ops: [opIndex...] }],   // provenance only
  parts[].ops[]: { op: 'shape'|'columns', ..., material: <blockState> | { rule: <materialRule> } }
}
```

- `requires` is computed by the planner from the IR's actual contents, never by hand. A test asserts it equals the set of
  kinds found by walking the IR.
- Format-1 `blobs: {name: {minX, minZ, width, depth, data}}` (inline) stays legal **in format 1 only**. A format-2 IR with
  inline `data` fails at plan ("format 2 blobs are side files").
- The `graph` and `siteLots` members, and `lotEntries`/`fits`, are **7a**. The 6b evaluator rejects them as unknown
  members of format 2.

### 2.2 Side blobs

- **Plan dir:** `<data>/regions/plans/<planId>/blobs/<sha>.bin`. sha is the SHA-256 of the bytes. Each blob is at most
  16 MB, and a plan's blobs are at most 64 MB in all.
- **World dir:** when the region record is created (before any tile is requested), the mod copies the IR and every blob
  it names into `<world>/architect-regions/<id>/blobs/<sha>.bin`. Each copy is written, fsynced, renamed and read back,
  with the sha checked. A missing or bad blob refuses realise with `OTHER` ("blob <sha> missing") before any write.
- **Wire:** 4a's chunked blob path (`MAX_BLOB_BYTES` 64 MB). `region.tiles.request` may now be answered with the error
  code `blob_unknown {shas: [...]}`.
  - The mod then re-sends those blobs from the world copy and re-requests the tile.
  - It follows the 6a `ir_unknown` order: IR first, then blobs.
  - A tile is re-requested at most 3 times for the same reason. After that the region waits `SIDECAR_UNAVAILABLE` with the
    message.
- **Undo** reads only the journal, as before. Blobs are deleted with the region record, after the region is removed.

### 2.3 Shapes and material rules (normative)

| Kind | Fields | Inside / value | Bounds |
|---|---|---|---|
| `ellipsoid` | `c, r: [rx, ry, rz]` | `(len(p/r) - 1) * min(r) <= 0` (bound-safe) | `c ± r` |
| `capsuleChain` | `points: [[x,y,z]...], radii: [r...]` (same length, at least 2) | distance to the nearest round-cone segment, with the radius interpolated along it | segment boxes ± max r |
| `wedge` | `min, max, rise: 'n'\|'s'\|'e'\|'w'` | a box whose top slopes linearly from `max.y` on the `rise` side to `min.y` on the opposite side | the box |
| `prism` | `polygon: [[x,z]...], y0, y1, apex: {line: [[x,z],[x,z]], y}` | a polygon extruded up to `y0`, then a ridge rising to `apex.y` along `line` (roofs, keeps) | polygon box, `y0..apex.y` |
| `array` | `of, step: [dx,dy,dz], n` (1..256) | union of `of` translated by `k*step`, `k = 0..n-1`; evaluates only the copies whose bounds hold the cell | union of the copies |
| `instances` | `of, transforms: [{t: [dx,dy,dz], rot: 0\|90\|180\|270, mirror: 'x'\|'z'\|null}]` (at most 1024) | union of `of` under each integer transform | union |
| `warp` | `noise, amp` (integer, 1..8), `of` | `of` evaluated at `p + amp * noise3(p)` (three seeded lookups) | `of` ± amp |
| `strata` | `of, bands: {noise?, every, offset}` | the same geometry as `of`; it also tags each cell with `band = floor((y + offset + n) / every)` for material rules | as `of` |

- **Material rules** follow SETTLEMENTS §3.3 exactly:
  - the conditions are `depth`, `slopeLt`/`slopeGte`, `field`, `band`, `noise` (+ `age`), `yAbs`, `facing`;
  - the first matching clause wins, otherwise `default`;
  - `dither: 'ordered4' | 'none'`;
  - role names resolve through `ir.roles` at plan, so the IR holds block states only;
  - `depth` and `facing` read the op's own SDF;
  - `slope` reads frozen ground within 1 column (inside the 8 margin).

  Every quantity is integer or exactly specified float, so the realise lint holds.
- **Evaluation cost:**
  - a `facing` condition costs 6 SDF lookups, and only cells that reach that clause pay for it;
  - **an op whose rule uses `facing` is limited to 32 primitives** (plan error past that);
  - `floatingIsland` emits at most 32 primitives per op (SETTLEMENTS §9.1).
- **The realise lint** (`region-lint.test.mjs`) adds every new file on the realise path to its scan list (e.g.
  `lib/material.mjs`, and `lib/sdf.mjs` grows).

### 2.4 Versioning and unknown kinds

| Who sees what | Behaviour (each a test) |
|---|---|
| 0.12.0 evaluator, format-1 IR | Byte-identical to 0.11.0. 6a's `mega_bench.golden.json` and `region_small`'s tiles are unchanged. |
| 0.12.0 evaluator, format-2 IR with an unknown op, shape or rule kind, or an unknown format-2 member | `compileIR` throws `IR: unknown <op\|shape\|rule> '<kind>' (supported: ...)`. Unknown kinds still throw (K6), now with the list. Format 2 has no "ignore unknown". |
| 0.12.0, an IR with `format > 2`, or `requires` naming a kind this kit lacks, or `kitVersion` newer than the running kit (semver compare) | Refused **`PLAN_STALE`** with "plan needs kit X / format N / kinds [...]; this is kit Y". Checked at: (a) `region.planned` accept (a dev sidecar newer than the mod); (b) `Regions.realise` start; (c) resume of a region record at world load. No tile is requested, so nothing is written. |
| The sidecar's own check | The sidecar's `hello` snapshot gains `kitVersion` and `irFormats: [1, 2]`. The mod compares them with the IR before (a)-(c). The mod also compares its own bundled kit version with the sidecar's, and a mismatch is a log warning (dev only). |
| **0.11.x mod with a world that holds a format-2 region** (a downgrade) | 0.11.x has no format gate. Its sidecar answers every tile request with `region.tile.error "IR: format must be 1"`. `TileStream` marks the tile `FAILED` with that message. **No cell of that region can be written by 0.11.x**, because no cell list ever arrives. **What the region's state then shows** (paused, waiting or failed items: phase 6 §1 says "the region pauses") **is not confirmed from 0.11.0's code for this draft.** Gate item 10(c) pins it and records it. `Regions.remove` still works, because undo reads the journal only. This is accepted rather than bumping a store format, because nothing can be written wrongly. |
| A format-1 IR in a 0.12.0 world | Unchanged. No migration. |

---

## 3. The virtual world, the checker and the previews

### 3.1 The virtual world

- **Contents:** the plan survey (2.5D) + frozen volumes where the plan took one (§5) + the IR, evaluated by `realise.mjs`.
- **Resolution:**
  - full resolution up to 256x256;
  - otherwise coarse (every 4th column);
  - plus full-resolution passes around lots + 8, paths and bridges + 4, stairs, carve edges within 2, gates, and
    **declared floating parts + 4**.
- **Lot interiors** are their declared boxes (A5B §3).
- Where a volume exists, the cells come from the volume. Elsewhere, columns are solid from `floor` down and air above
  `height` (SETTLEMENTS §5.2).

### 3.2 Rules

M1-M14 as A5B §3, with the phase 6 severities:
- **Errors:** M1; M13; M14's uniqueness, plus "every op in a part".
- **Warnings:** everything else.

Details per rule:
- **M2** runs the **`player` mover** (SETTLEMENTS §11): step 1, fall at most 3, 2 headroom, stairs, bridges, doors, and
  ladders where a program declares them. The `villager` and `steward` movers are 7a.

  Reached from `entrance` are every lot entrance, every named district (part), and every `floating` group's anchor.
  The output is a per-node reachable flag, so S1's "100% of nodes" bar is computable.
- **M3:** non-floating solids connect to ground. A `floating` group connects internally, and to its anchor if one is
  declared.
  - Cells of a floating group that are unconnected to the group are reported separately as `M3:floating_spur`.
  - Gravity blocks need support.
- **M5** reports dark spawnable area in cells and as a share of walk area:
  - block light 0;
  - solid below and 2 headroom;
  - "spawnable" from a per-block flag generated from the 26.3 data generator into `blocks.mjs`, not hand-listed (SETTLEMENTS
    §11).

  `cavern` light placement must give 0 such cells inside the cavern.
- **M8:** walk cells beside a drop over 3 without a barrier at least 1.5 tall. It stays a warning (promotion is 7a). The
  share guarded is reported.
- **M10:** the span between supports is at most `maxSpan`. An `'ends'` bridge must have both ends on declared parts' cells,
  over at least 2x2 each.
- **Prefix checks:** M2 and M3 after each stage prefix, extended incrementally (phase 6 §4).
- **Report:** `report.json` with `{rule, severity, part, stage, count, sample <= 20, message}`, plus `summary.txt`.

  Steward and `RegionPlan.report` see the same data.
- **Promotion** of any rule follows the usual process, recorded in PLAN.md. **6b promotes nothing** (no real generations
  yet). It records which rules fired on the fixtures and the crater/rift runs, as promotion evidence.

### 3.3 Previews

As in phase 6 §4 "The four views":
- `top`, `section` (up to 4 axes), `iso`, `siteplan` (SVG, PNG and `siteplan.json`);
- deterministic: the same IR and survey give byte-identical PNGs (the kit's pinned encoder);
- written to the plan dir;
- re-rendered on demand by `region.preview`.

Changes:
- Floating parts get their own tint, and `section` draws them with their undersides.
- Material rules render in the role or block colour of the cell's resolved block (the flat-colour palette, as today).

### 3.4 `siteplan.json` (schema `siteplan/1`, a JSON Schema in `kit/schemas/siteplan-1.json`)

```
{ "format": 1, "planId", "irSha", "claim", "stages": [name],
  "lots": [{ id, stage, rect: [x0, z0, x1, z1], floorY, front, entrance: [x, y, z], brief? }],
  "paths": [{ id, kind: "stair"|"bridge"|"graded"|"road", stage, width, points: [[x, y, z]] }],
  "utility": [{ id, kind, width, height, points }],
  "anchors": { name: [x, y, z] },
  "parts": [{ id, stage, kind: "carve"|"add"|"path"|"pad"|"form", floating: bool }],
  "graph": { "nodes": [{ id, kind: "lot"|"anchor"|"junction", ref, at: [x, y, z], level }],
             "edges": [{ id, from, to, type: "road"|"stair"|"bridge"|"graded", path, stage, mover: ["player"] }] } }
```

- The `graph` block is **topology only**. It is derived from 6a's paths and roads:
  - a node per lot entrance, per anchor, and per path endpoint or junction;
  - an edge per path segment between nodes.

  7a replaces the derivation with the planned graph and adds `seconds`, `risk` and more movers (A7 review). The format
  stays 1 if only members are added.
- Steward reads this file (A6 S10). Any change to existing members is a format bump.

### 3.5 The region ghost (client)

As phase 6 §4:
- `ArchitectClientApi.previewRegion(planId, @Nullable stage)` and `PreviewStyle.REGION` (appended);
- the cells of tiles within 64 blocks of the player, from the same tile evaluation in preview mode over the plan
  survey;
- beyond 64 blocks: the claim outline and the lot boxes;
- tints: added, removed, path, lot, floating;
- a verdict line with the checker summary and the cell budget.

Format-2 IRs preview the same way. Their blobs come from the plan dir.

---

## 4. The `floatingIsland` generator and S1's program

### 4.1 Generator

`kit/lib/forms/floatingIsland.mjs`, version 1. Plan time only, integer or fixed-point, lint-clean, with no `Math.random` or
`Date`.

```js
floatingIsland({ at: [x, y, z], r: [rx, rz], thickness, seed, top: { relief: 0..4, pads: [{ at: [x, z], size: [w, d] }] },
                 underside: { taper: 0.3..0.9, roots: 0..12 }, materials: 'island' | <materialRule> })
  -> { ops: [...], parts: [...], bounds, anchor: [x, y, z], pads: [{ at, size, y }] }
```

- **Shape:**
  - top: a flattened `ellipsoid` with noise relief, intersected `clipY`;
  - underside: an inverted `cone`, `warp`ed (amp at most 6);
  - hanging roots: `capsuleChain`s.
- **Op grouping:**
  - the island body is one op;
  - each root cluster is one op;
  - at most 32 primitives per op.
- **Top pads:** declared pads are exactly flat at the returned `y`, carved into the relief.
- **Default material rule `island`:**
  - grass skin at depth 0, facing up;
  - dirt at depths 1-3;
  - stone core;
  - stone strata bands of `andesite`/`tuff` at depth 4 and over;
  - ore noise at depth 6 and over;
  - `dither: ordered4`.

  Roles resolve through the bible (`surface`, `subsurface`, `rock`).
- **Output:** a `floating` declaration for the island's parts and an anchor cell (the top centre).

**Property tests** (kit, no game) over 50 seeded param sets:
1. Bounds contain every cell.
2. Per-tile evaluation equals whole evaluation (tiles cut through the island).
3. The island's cells are one face-connected component (M3 floating holds).
4. Every pad is flat at its `y`, and solid under it to depth 3.
5. Material rules resolve to valid blocks (M13).
6. Determinism: byte-identical ops for 3 runs on Node 22 and 24, on macOS and Linux CI; a golden of shas over 20 param
   sets.
7. Evaluation cost per cell at most 2x `sphere`'s.

### 4.2 `floating_islands` (S1's bundled program)

`kit/regions/floating_islands.mjs`, params `{ islands: 5..9, spread, altitude }`.

**Layout:**
- islands at y 150-200 over plains or ocean;
- one larger hub island with the `entrance` and `spawn` anchors reachable;
- **stone links**: `bridge` decks with `supports: 'ends'`, where the island gaps allow spans of at most 24. Otherwise
  `stair` links between islands at different heights, ends bearing on pads;
- a spiral `stair` from the ground to the hub, so `entrance` is on the ground;
- **guarded edges:** every walkable island rim, pad edge, bridge and stair beside a drop over 3 gets a rail or wall (the
  `platform`/`bridge`/`stair` edge options, and an `edge: 'rail'|'wall'` option on `floatingIsland` pads). S1's bar is M8 at
  100% (§8.3). On islands 150+ above ground, this is where the scenario is hardest, so the bible does **not** opt out
  (`edges: 'open'` is not used);
- lots on island pads with `pad: {fill: 'none'}`. The pad's own top must be solid in the virtual world (M9 checks it), with
  no fill down to the frozen ground.

**Lot children** are library entries and variants, mapped by the scenario file ($0): the kit examples plus the 6a stub
blueprints, as mega_bench uses.

**The brief's "rope" is not in 6b.** SETTLEMENTS' S1 brief says "linked by rope and stone". Rope bridges are a 7a
connector. **S1 in 6b is "S1 v1: stone links"**, and 7a re-runs S1 with rope bridges (a changed scenario, so it returns to
the gallery). This is question N-6b-2 for Noah.

---

## 5. The 3D volume survey (`Survey.volume`, ARVX)

- **API** (1.9.0, additive, as SETTLEMENTS §5.1):

```java
// Survey (a default method that throws "needs Architect API 1.9.0" on older implementations)
default CompletableFuture<Volume> volume(ServerLevel level, BoundingBox box, LoadPolicy load) { throw ...; }
record Volume(String sha, BoundingBox box, String blobId, Map<VoxelClass, Long> counts, int missingColumns) {}
enum VoxelClass { AIR, ROCK, SOIL, LOOSE, ICE, SNOW, WATER, LAVA, LOG, LEAVES, PLANT, OWNED, PLAYER, BLOCK_ENTITY, MISSING }
```

- **Classes:** from the kit's block table (family and collision class), exported to the mod as a generated
  `voxel_classes.json`, so both sides classify identically. A test asserts that the Java and JS tables are equal.
  - `OWNED` cells record the owner entry id in a side table in the blob.
  - `PLAYER` = non-natural with no journal owner.
- **Encoding ARVX:**
  - a header (`ARVX`, version 1, box, column order x-major);
  - per column, bottom-up runs `(class u8, length varint)` from `box.minY`;
  - the owner side table;
  - gzip.

  The format is documented in `kit/REGIONS.md`, with a JS decoder in `kit/lib/region/volume.mjs`.
- **Sampling:**
  - sliced on the server thread under 4a's Survey budget;
  - reads section palettes (single-valued sections cost one lookup);
  - `LoadPolicy` as `sample` (`GENERATED_ONLY(n)` allowed).
- **Freeze:**
  - the volume goes to `<world>/architect-regions/<id>/volumes/<sha>.bin` (write, fsync, rename, read-back sha);
  - it is never rewritten;
  - plan dirs reference it by sha (IR format 2 `volumes`).

  Standalone calls (no region) write to `<world>/architect/volumes/<sha>.bin` and return the `blobId`.
- **Program access:** `r.needVolume(box)` in a program asks the planner for a volume.
  - The two-plan flow (plan, prepare, plan again) takes requested volumes after prepare, before the second plan.
  - The virtual world uses them (§3.1).

  No 6b program **needs** a volume to plan. The fixtures use one only in the volume gate item.
- **Limit:** 16M cells per region (est.). 6b measures it and then sets it (gate item 7). Over the limit, the plan fails
  with the count.
- **Not in 6b:** drift by class inside a volume (`SITE_DRIFTED`), and site lots. Those are 7a/7b.

---

## 6. Java API 1.9.0, protocol, events

### 6.1 Rules (K7; the 1.8.0 rules, unchanged)

- `ArchitectApi.VERSION = "1.9.0"`.
- Old record constructors are kept: each widened record keeps its 1.8.0 canonical constructor as a secondary constructor.
- New interface methods are defaults that throw `UnsupportedOperationException("... needs Architect API 1.9.0")`.
- **Every new enum constant is appended.**
- `tools/api-compat.mjs` checks the **unchanged 1.8.0, 1.7.0 and 1.6.0 apitest jars** (`architect_apitest-0.11.0.jar`,
  `-0.10.0.jar`, `-0.9.0.jar`) by reference, and the 0.11.0 mod jar's 1.8.0 surface (`--surface`). All three jars pass
  their suites against 0.12.0.
  - **The 0.11.0 apitest jar is not archived yet.** The first 6b build step builds it from `main` at v0.11.0 into
    `artifacts/gate6b/v0110/` before any 6b change.
- **Behaviour changes, listed:**
  1. A format-2 or newer-kit IR refuses `PLAN_STALE` at the three points of §2.4. This is a new refusal for 1.8.0 callers
     only when they feed 0.12.0 a newer plan.
  2. `RegionPlan` now carries a report and previews.

     Planning time grows by the checker and the renders. Bars: coarse at most 60 s and full at most 120 s on mega_bench
     (phase 6 §7).

     `RegionPlanRequest.ext["architect_mc:check"] = false` skips both (for mega_bench gate runs).

### 6.2 New and widened types

```java
interface Regions {   // additions, all default-throwing
  CompletableFuture<RegionPreviews> previews(String planId, Set<PreviewView> views, List<List<BlockPos>> axes);
  CompletableFuture<CheckReport> check(String planId);
  CompletableFuture<String> design(RegionDesignRequest r);                 // -> designId (Design.Kind.REGION)
  CompletableFuture<NudgeResult> nudge(String regionId, WaitAction.Kind action);
}
record CheckReport(boolean ok, int errors, int warnings, List<Finding> findings) {
  record Finding(String rule, String severity, @Nullable String part, @Nullable String stage, int count, List<BlockPos> sample, String message) {} }
enum PreviewView { TOP, SECTION, ISO, SITEPLAN }
record RegionPreviews(Map<PreviewView, List<Path>> images, JsonObject sitePlan) {}
// RegionPlan gains trailing @Nullable CheckReport report, @Nullable RegionPreviews previews, int irFormat (old constructor: null, null, 1)
record RegionDesignRequest(String brief, ServerLevel level, BoundingBox claim, @Nullable String bible, List<String> mustPass,
                           @Nullable String model, @Nullable Double budgetUsd, @Nullable String owner, JsonObject ext) {}
//   no designLots (Steward S7); template-first only in 6b (an authoring fallback is 7c)
// Design.Kind gains REGION (appended). A REGION design's result: { program, params, planId?, reason, outcome: PICKED|NO_TEMPLATE }
record WaitAction(Kind kind, String label, @Nullable BlockPos target, @Nullable String detail) {
  enum Kind { MOVE_CLOSER, PREPARE, START_SIDECAR, APPROVE_STAGE, REPLAN } }
// RegionView gains trailing List<WaitAction> actions (old constructor: List.of())
record NudgeResult(boolean done, String message) {}
// Survey: volume(...), Volume, VoxelClass (§5)
// Reason (appended): NO_TEMPLATE; PLAYER_BLOCKS only if the crater gate's case (a) needs it (§7.3)
```

**Nudge semantics (S8):**

| Wait | Actions offered | What `nudge` does |
|---|---|---|
| `NOT_LOADED` (`LOADED_ONLY`) | `MOVE_CLOSER` (target = the waiting item's nearest chunk centre) | Nothing in the world. It answers the target (`done: false`, "walk to x, z"). |
| `NOT_GENERATED` | `PREPARE` | Starts `prepare` for the region's plan. This is explicit: the caller chose it, so S6's "never silently" holds. |
| `SIDECAR_UNAVAILABLE` | `START_SIDECAR` | Asks the sidecar supervisor to (re)start it. If it is already starting, it answers so. |
| `DRIFTED` (stage held) | `APPROVE_STAGE`, `REPLAN` | `APPROVE_STAGE` = `Sites.approveStage` on the held stage (the 6a continue). `REPLAN` answers `done: false` with "replan with Regions.plan". 6b doesn't replan for the caller. |

An action not offered for the current wait answers `done: false` with "not applicable".

### 6.3 Events and features

- Events: `REGION_STATE` also fires when `actions` change. `REGION_CHECKED(planId, CheckReport)` is a new event (appended).
- **Features:** `regionCheck`, `regionPreview`, `regionGhost`, `regionDesign`, `regionNudge`, `surveyVolume`,
  `irFormat2`.

### 6.4 Sidecar protocol (2, additive)

- `region.planned` gains `report`, `previews: {view: [path]}`, `sitePlan`, `irFormat`, `requires`.
- `region.check {planId}` -> ack `{report}`; `region.preview {planId, views, axes?}` -> ack `{paths, sitePlan}`.
- `region.tiles.request` may fail with `blob_unknown {shas}`. Blobs are sent with 4a's `blob.put` message (chunked).
- `region.design {brief, claim, surveyBlobId, bible?, mustPass, model?, budgetUsd?}` -> ack `{designId}`, then
  `design.upsert {kind: "region", outcome, program, params, reason, cost}`.
- The `hello` snapshot gains `kitVersion` and `irFormats`.
- New snapshot features: `region.check`, `region.preview`, `region.design`, `region.blobs`, `ir.format2`.

**Kit CLI:**
- `region.mjs check <ir> --survey s.bin [--volumes dir]`;
- `region.mjs preview <ir> --survey s.bin --views ...`;
- `region.mjs plan ... --blobs-out dir`;
- `volume.mjs decode <arvx> [--slice y]`.

Exit codes are 0/1/2 as before.

### 6.5 DevBridge (DEVBRIDGE.md changelog)

- `dev.region.check`, `dev.region.preview`, `dev.region.design`, `dev.region.nudge`.
- `dev.survey.volume {box, load}`, which returns sha, counts, ms, ticks and the max tick.
- `dev.region.ghost {planId, stage?}`, with `dev.screenshot` for screenshots.
- `dev.scenario.cams {scenario}`: sets fixed time (6000) and clear weather, and teleports a spectator to each `cam_*`
  anchor for `dev.screenshot`.
- `dev.region.drop {planId, after: <tiles written>}` deletes the sidecar's plan dir and cache mid-realise, after N tiles are written (the resume test, gate item 10(a)).

### 6.6 Commands (N7: no Terrain tab)

`/architect region plan <program> <claim> [params]`, `check`, `preview`, `prepare`, `realise`, `remove`, `design "<brief>"`,
`nudge <action>`. The verdicts are printed in chat, and the previews are written to the plan dir with a clickable path.

---

## 7. Template-first `Regions.design` and Steward's crater gate

### 7.1 The pick

- One structured job (Sonnet, `job.run` with a JSON schema). Its inputs:
  - the brief;
  - 4a's survey `summary()` (stats plus the 64x64 ASCII grid);
  - the claim;
  - the bible's role names;
  - the **catalogue**: each bundled program's id, one-paragraph description, params with ranges, the terrain it needs
    (`needs: {minFlat, water, relief}`) and its claim size range.
- It returns `{fits: bool, program, params, reason}`. The answer is validated against the catalogue (unknown program,
  out-of-range params) and gets **one** retry with the validation error. Then the outcome is `NO_TEMPLATE`.
- With `fits`, the plan runs with no further model call, and the design's result names the `planId`.
- **Catalogue in 6b:** `crater_works`, `rift_city`, `walled_hill`, `sky_isle`, `floating_islands`. `mega_bench` and
  `region_small` are excluded (`catalogue: false`).
- **Auth:** the sidecar's configured auth, as every job. The gate's runs use the claude login only (§10).

### 7.2 The bundled programs Steward asked for

- **`crater_works`** (A5B §2's sketch, made real):
  - a carved bowl with a `scorched ?? rock` lining;
  - a rubble rim ring;
  - a spiral stair from the rim to the floor;
  - 3 terraced work levels;
  - 6-12 lots on terrace pads (offices, halls, sheds);
  - ground roads on the rim, graded roads down the terraces;
  - `entrance`/`spawn` outside the rim.

  Params: radius 40-160, depth 12-48, lots 4-12.
- **`rift_city`:**
  - a carved linear rift (a `capsulePath` carve with `warp` walls, depth 20-60) with a `lining ?? rock` lining;
  - a `cavern` side hall (lit);
  - ledge terraces on both walls with lots;
  - `bridge`s across the rift (pillar or arch supports from the rift floor);
  - `stair`s from each rim to the floor;
  - a `utility` corridor along the floor.

  Params: length 96-320, width 16-48, depth 20-60, bridges 2-6.

Both are also family fixtures (§9, gate item 2), with expected reports.

### 7.3 Steward's crater gate (moved from the old 6c outline; A5B §6, refined)

From a fresh dev world (normal worldgen, a pinned seed, a site chosen by `find-site` for "flat ground, 300x300"):
1. `Regions.design("a repurposed meteor crater mining facility")` returns `PICKED` `crater_works`.
2. The plan has **no M1, M2, M3 or M4 findings**, and no errors.
3. `prepare` runs, then `realise` through the queue. The lots are filled from library entries and variants (no model call).
4. Every lot is placed, and the region is `PLACED`.
5. One `Regions.remove` returns the area cell for cell under the 6a exactness rules (E-normal classified, with **default**
   gamerules as the old 6b outline said for a dev world).
6. **The player block, case (a), before realise:** a non-natural block placed by the player inside a lot's pad area.
   - The pad skips it (noted).
   - The lot's child must refuse (A5B N2), the region ends `PARTIAL`, and after the group undo the block is still there.
   - The build first pins which `Reason` 0.11.0's check gives for a non-natural, non-BE block inside a LAYERed box. If it
     only clears it, 6b adds the appended `Reason.PLAYER_BLOCKS`, returned by `check()` and the queue. That is a
     behaviour change to LAYER, listed in §6.1.
7. **Case (b), after realise:** a block placed on a pad or path cell survives the group undo and is reported in `kept`.

The **rift prompt** ("a rift settlement", Steward PLAN phase 2) runs the same path. It must pick `rift_city` and pass
steps 2-5. Cases (a) and (b) run on the crater only.

### 7.4 Pick accuracy

Six briefs, each with its expected outcome, run on the claude login against their pinned sites:

| Brief | Expected |
|---|---|
| "a walled town on a hill, with gates and towers" | `walled_hill` |
| "a stone citadel floating on a single great sky rock, held up by pillars" | `sky_isle` |
| "a scattered hamlet on several small floating islands" | `floating_islands` |
| "a mining camp in a blasted crater" | `crater_works` |
| "a town built down the walls of a deep canyon" | `rift_city` |
| "a cozy two-room cottage" | `NO_TEMPLATE` |

**Bar: at least 5 of 6 as expected, and the `NO_TEMPLATE` brief must be one of the 5.** `sky_isle` and `floating_islands`
have distinct catalogue descriptions and `needs`:
- `sky_isle` is one large mass on pillars or a taper;
- `floating_islands` is 5-9 small unsupported islands.

That way the two sky briefs can be told apart.

---

## 8. The scenario harness and the gallery

### 8.1 Scenario files

`scenarios/<id>.json`, committed, one per golden scenario (S1-S6). Only S1 must be green in 6b. S2-S6 get files with their
fixtures found and pinned, but no bars run.

```json
{ "id": "s1_floating_islands", "phase": "6b", "version": 1,
  "world": { "seed": "<u64 decimal>", "preset": "normal", "gamerules": "gallery" },
  "fixture": { "claim": [x0, z0, x1, z1], "yRange": [y0, y1], "foundBy": "find-site s1 @ <sha>", "surveySha": "<sha>" },
  "flat": { "preset": "flat", "claimOffset": [0, 0], "gamerules": "exact" },
  "program": "floating_islands", "params": {}, "seed": "<u64 decimal>", "bible": "kit/bibles/<id>.json",
  "lotEntries": { "lotId": "entryId@version" },
  "cams": { "cam_hub": [x, y, z, yaw, pitch], "...": "6 fixed cameras" },
  "bars": { "...": "§8.3" } }
```

- **Gamerule sets:**
  - `exact`: `randomTickSpeed 0`, `doMobSpawning false`, `doFireTick false`, `doWeatherCycle false` (the 6a E-flat
    set);
  - `gallery`: default rules, time 6000, clear weather.

  **Gallery screenshots are taken after a 2-minute stand at default random ticks** (SETTLEMENTS §18: leaf decay, melt).
  E-flat runs at 0.
- **`tools/find-site.mjs <scenario>`:**
  1. surveys a grid of candidate claims in a scratch world of the pinned seed;
  2. scores them by the scenario's needs (S1: low relief, at least 70% plains or ocean, no village within the claim + 64);
  3. records the winner and its survey sha in the scenario file.

  It runs once per scenario. The pinned file, not the tool, is the source of truth after that.
- **Seeds are pinned three times:** the world seed, the program seed and the IR sha (recorded at the first green run). A
  later run that gives another IR sha is a finding, unless the change log names why (a kit change).

### 8.2 The harness

`tools/scenarios.mjs run <scenario> --phase 6b [--flat] [--out artifacts/scenarios/6b/<id>/<runId>/]` drives the dev client
through DevBridge:
1. a fresh world from the pinned seed (or the flat variant);
2. plan (a report and previews are kept);
3. prepare;
4. realise with `lotEntries`;
5. a re-survey and metrics;
6. the 2-minute stand;
7. the 6 cameras;
8. `Regions.remove`;
9. the exactness check.

It writes:
- `metrics.json`: every bar, with its value, threshold and pass;
- `report.json`, the four previews;
- `shots/<cam>.png`;
- `before/` (§8.4);
- `exact.json`;
- `run.json`: world seed, IR sha, kit/mod/sidecar versions, Node major, wall times, spend;
- `evidence.sha`: the SHA-256 over the sorted list of (path, sha) of everything above.

`tools/scenarios.mjs gallery --phase 6b` assembles the gallery bundle (§8.4). `tools/scenarios.mjs check --phase 6b` checks
that every new or changed scenario's `metrics.json` passes and that `approvals.json` holds a matching approval.

### 8.3 Bars for S1 in 6b (SETTLEMENTS §16.3, the rows that apply)

| Check | Metric (on the **realised** world, re-surveyed, not the virtual one) | Bar in 6b |
|---|---|---|
| Checker | the plan's report | 0 errors; **no M1, M2, M3, M4 findings** |
| Reachability (M2 `player`) | a walk graph over the realised world from `entrance` | 100% of nodes (lot entrances, island anchors); 0 unreachable lot entrances |
| Structure (M3) | the support scan on the realised world | 0 floating cells outside declared `floating` groups; 0 `M3:floating_spur`; every floating group one component |
| Spans (M10) | per bridge | every unsupported span at most its `maxSpan`; `'ends'` bridges bear on at least 2x2 cells at both ends |
| Safety | M4; M5 dark spawnable share; M8 guarded share | M4 0; M5 under 1% of walk area; **M8: 100% of walk cells beside a drop over 3 guarded** (SETTLEMENTS §16.3's scenario bar; the rule itself stays a warning in the checker until 7a promotes it) |
| Theme fit: palette | role adherence over non-terrain written cells (roles, shape variants, form materials) | at least 0.9 |
| Theme fit: organic read | axis-run share of form boundary cells | **recorded, not gated** in 6b (below) |
| Buildings | the kit checker over the placed lot entries; `detailNoise` and `accentShare` | 0 errors; `detailNoise` and `accentShare` within the bible's restraint (as 5a). The entries are library entries, so this is a regression guard |
| MSPT and throughput | 6a's realise bars | 0 ticks over 50 ms, p99 at most 25 ms; the light-engine tick share recorded |
| Exactness | E-flat on the flat variant; E-normal on the natural fixture; after one `Regions.remove` | E-flat 0 mismatches; E-normal all classified, at most 0.01% of written cells |
| Determinism | IR sha over 3 plans; tile shas for 1 and 4 workers, forward and shuffled; macOS and Linux CI | identical; a committed golden `scenarios/goldens/s1.json` |
| Gallery | Noah's approval (§8.4) | approved for this run's `evidence.sha` |

Not applicable to S1 in 6b, stated so they aren't silently skipped:
- `villager` reachability (7a);
- Fit share and disturbance (site lots, 7a/7b);
- theme-fit motifs (no connector types or district motifs before 7a; lantern posts per 24 path cells recorded only);
- spend ±50% (S1 is a $0 run; its spend must be **$0.00**, which is checked).

**Axis-run calibration.** SETTLEMENTS says the axis-run bar is "calibrated on S1 in 6b". Calibrating and gating on the same
run is the gaming SETTLEMENTS §18 forbids. So in 6b:
- axis-run share is **recorded only**;
- the calibration uses **10 held-out island seeds**, not S1's seed;
- `floatingIsland` alone is rendered and Noah marks each "reads natural / reads geometric" on the gallery's calibration
  card;
- the threshold that separates his marks best is proposed for 6c's gate and written into SETTLEMENTS' bar table (gated
  from 6c on).

### 8.4 The gallery: a private claude.ai page (Noah's decision)

**One page per phase**, "Architect 6b gallery":
- published with the Artifact tool as a **private** page (the default; organization-internal because it declares
  `assets`);
- capabilities `db`, `user`, `assets`;
- republished to the same URL on each changed run, so Noah keeps one link.

**What it shows**, per scenario that is new or changed in this phase (in 6b: S1, plus a calibration card):
1. **A header:** scenario id and version; run id; `evidence.sha` (first 12 hex); IR sha; date; versions.
2. **Metrics first:** the §8.3 table with pass or fail per row, and any not-gated rows labelled "recorded".
3. **Before and after, side by side, per camera (6 cameras):**
   - "before" is **the pristine fixture** (the same cameras in the same world before the plan; S1 has no earlier phase
     run);
   - from 6c on, "before" is the previous phase's green run of the same scenario, with the pristine fixture one tab away.
4. **The previews:** top, section (each axis), iso, and the site plan (SVG). The checker summary is under them.
5. **Exactness:** the E-flat and E-normal counts, with the classified list collapsed.
6. **Decision controls:** Approve or Reject, a notes field, and a Submit button. Only the page's owner (Noah) can write
   decisions. Everyone else sees them read-only.
7. **The calibration card** (6b only): 10 island renders, each with "natural" or "geometric" toggles, stored with the same
   mechanism.

Images are uploaded as the artifact's assets (the PNGs), referenced by asset URL. The page stays under the 16 MB limit,
since the images aren't embedded as data URIs.

**How approval is recorded:**
- **On the page:** one `db` document per decision, `approvals/<phase>__<scenario>`:
  `{phase, scenario, runId, evidenceSha, decision: "approved"|"rejected", notes, by: <user id>, at: <ISO time>}`.
  - Rules: `approvals` is readable at `view` and writable at `owner` only.
  - A new Submit replaces the document. The page keeps the earlier decision under `history` in the same document.
- **Binding:** a decision counts only for the `evidenceSha` it names. Republishing the page for a new run shows the
  earlier decision struck through, with "evidence changed, decide again".
- **Into the repo:** the builder reads the documents with `ArtifactData` (`list approvals`) and writes them, verbatim with
  the page URL, to `artifacts/scenarios/6b/approvals.json`. The builder then:
  - adds a line per scenario to PLAN.md ("S1 approved by Noah <date>, run <id>, evidence <sha12>: <notes>");
  - commits both.
- **Verification:** the gate-verifier cannot read claude.ai. It checks that `approvals.json`'s `evidenceSha` equals the
  sha it recomputes from `artifacts/scenarios/6b/s1/<runId>/`, and that the decision is `approved`. A rejection with
  notes sends the scenario back to the builder. A rejected scenario is not green.
- **Fallback:** if the page can't be published or Noah prefers, `tools/scenarios.mjs gallery --local` writes the same page
  as a local HTML file whose buttons write `approvals.json` directly (SETTLEMENTS §16.4's original design). The binding
  rule is the same.

---

## 9. Fixtures and the broken variants

- **Family fixtures** (A5B §6): `crater_works`, `sky_isle`, `rift_city`, `walled_hill`. Each has
  `kit/test/fixtures/regions/<id>.expected.json` listing which rules fire, at what severity, on which parts, and why (a
  one-line reason per finding). Each runs at default params on a synthetic survey (`synth.mjs`), and `crater_works` and
  `rift_city` also on their gate sites' recorded surveys.
- **Broken variants**, each caught by its rule (finding present, on the named part):

| Variant | Rule |
|---|---|
| a lot with no path | M2 |
| a carve that opens a lake (a bowl next to a surveyed water body) | M4 |
| a floating spur (a mass of an island's part with no face contact) | M3 (`floating_spur`) |
| a dark cavern (light disabled) | M5 |
| a bridge span over its limit | M10 |
| a stair with rise 2 | M7 |
| an `'ends'` bridge with one end in air | M10 |
| two parts with the same id | M14 (error) |
| a role that resolves to nothing | M13 (error) |
| a write outside the claim | M1 (error) |

---

## 10. Spend (claude login only)

| Run | Calls | Est. |
|---|---|---|
| Crater gate pick ("a repurposed meteor crater mining facility") | 1 pick (+ at most 1 validation retry) | $0.01-0.05 (measured seed, phase 6 §5) |
| Rift pick ("a rift settlement") | 1 (+1) | $0.01-0.05 |
| Pick accuracy (gate item 8b): 6 briefs, each with its expected outcome | 6 (+ at most 6) | $0.06-0.30 |
| Retries of the whole gate (at most 2 re-runs of the above) | up to 16 | up to $0.80 |
| S1, the fixtures, the full chain, the gallery | none | **$0** |

- **Expected about $0.30. Cap $3.** Past $3 the gate stops and asks the coordinator.
- **Auth:** **the claude login only. Never an API key.** `tools/gate6b.mjs` refuses to start if any `ANTHROPIC_*` or
  `CLAUDE_*` key is in its environment (as in 5b and 6c's outline). It logs the sidecar's auth mode at each paid step, and
  the gate-verifier checks the log.
- **Per-run cost** is recorded in each `design.upsert` and summed in `artifacts/gate6b/spend.json`. The ±50% estimate check
  applies to the sum of picks (an expected $0.02 seed per pick).
- **Publishing the gallery costs nothing.**
- SETTLEMENTS estimated 6b at $1-3. This contract's count is lower because authoring is 7c and S1 is deterministic. The
  $3 cap keeps SETTLEMENTS' upper figure.

## 11. Reference images

**6b needs none.** Nothing in 6b feeds images to a model:
- the pick is text only;
- S1 is a deterministic program;
- the image A/B (SETTLEMENTS §16.5) starts in 7b.

Noah's gallery judgment and the axis-run calibration are made against the renders themselves. The first ask for GPT Image
2.5 references comes with the 7b contract (per scenario, for the images A/B). **Nothing to ask Noah for in 6b.**

---

## 12. Phase 6b gate

Bars are explicit. Each item writes `artifacts/gate6b/<step>.json`, and `REPORT.md` summarises them.

1. **Unit and property tests (no game, no Claude):**
   - **Kit:**
     - the new shapes' SDFs against analytic fixtures;
     - `array`/`instances` equal to the explicit union;
     - `warp` bounds (no cell outside `of` ± amp);
     - material rules: each condition, first-match, dither, determinism;
     - every 6b primitive's guarantee as a property (cavern light coverage, `'ends'` bridge span, ring gates with towers,
       underside taper connectivity);
     - the realise lint over the extended file list;
     - `requires` computed equals walked;
     - the format-2 compile errors (unknown op, shape, rule or member) and the inline-blob refusal;
     - the ARVX round trip;
     - the `floatingIsland` property tests (§4.1).
   - **Format-1 byte identity:** `kit/test/fixtures/regions/mega_bench.golden.json` and `region_small`'s tiles are
     **unchanged** (the same file, not regenerated).
   - **Format-2 determinism:** IR byte-identical over 3 plan runs. S1's and the four fixtures' tile shas are identical
     for 1 and 4 workers, forward and shuffled, on macOS and Linux CI. They are committed goldens.
   - **Sidecar:**
     - `region.check`, `region.preview`;
     - `blob_unknown` and the re-send;
     - the `hello` versions;
     - `region.design` against the sim backend (pick, invalid pick and retry, `NO_TEMPLATE`, budget stop);
     - the plan with report and previews within limits.
   - **Mod, pure JVM:**
     - the `PLAN_STALE` gates (a)-(c) with fake IRs;
     - the blob copy with read-back, and a bad sha refusing;
     - ARVX encoding equal to the JS decoder on fixture columns;
     - the Java and JS `VoxelClass` tables equal;
     - `WaitAction` per wait reason;
     - `RegionView` and `RegionPlan` old constructors.
2. **Fixtures and broken variants** (bridge arches and towers are tested here, on `sky_isle` and `rift_city`; mega_bench is
   unchanged, §Deviations): each family fixture's report equals its `expected.json`. Every broken variant in §9 is
   caught by its rule on the named part.
3. **Prefix checks:** M2 and M3 hold on every stage prefix of `walled_hill`. The per-prefix total time is at most 2x one
   full check.
4. **Checker and plan time on mega_bench:** coarse at most 60 s, full-resolution at most 120 s, single-threaded, recorded
   per rule. mega_bench's plan with the check, at most 30 s + the check.
5. **Previews:**
   - the goldens are byte-identical;
   - the section and site-plan views of every fixture and of S1 have been looked at (screenshots in the report, with a
     sentence each on what they show);
   - `siteplan.json` validates against `siteplan-1.json` for every fixture and S1;
   - the `graph` has a node for every lot entrance and anchor.
6. **The region ghost:** screenshots inside and beyond 64 blocks, for `crater_works` and S1 (floating tint), looked at.
7. **Volume survey:**
   - `dev.survey.volume` over a natural cliff-and-cave fixture of 256x256x128 (found by `find-site`, pinned), in a dev
     world;
   - **0 ticks over 50 ms** while sampling; max sampling slice recorded;
   - bytes per cell and total bytes recorded;
   - write/fsync/read-back sha checked;
   - the counts per class are plausible (a scan reports ROCK, AIR, WATER, LOG and LEAVES each above 0);
   - a second sample of the unchanged area gives the same sha.

   **The per-region cell limit is set from the measured cells per second and bytes** (rule: at most 60 s of sampling and
   64 MB on disk at the measured rates, rounded down to a whole million). It is written into CONTRACT and REGIONS.md.
8. **Steward's crater gate (§7.3), steps 1-7, plus the rift prompt (steps 1-5).** Each runs from a fresh world, on the
   claude login.

   **8b. Pick accuracy (§7.4):** at least 5 of 6 as expected, including `NO_TEMPLATE`.
9. **The command path (replaces the Terrain tab item):**
   - `/architect region plan|check|preview|prepare|realise|remove` on `crater_works` at 200x200 in a dev world under
     **default** gamerules;
   - exact under the classified-mismatch rule;
   - `nudge` exercised once for each of `PREPARE` (a not-prepared region), `MOVE_CLOSER` (`LOADED_ONLY`, player far),
     `START_SIDECAR` (sidecar killed) and `APPROVE_STAGE` (drift induced by a scripted dig).
10. **Versioning:**
    - (a) A format-2 IR planned by 0.12.0 is realised by 0.12.0 after the sidecar's plan dir is deleted mid-realise. The
      region resumes through `ir_unknown` and then `blob_unknown`, with the same region hash as an uninterrupted run in
      a world copy.
    - (b) A newer IR (`format: 3`, or `kitVersion` 0.99.0) refuses `PLAN_STALE` at accept, at realise start and at
      resume, with nothing written.
    - (c) **The downgrade:** a world with a format-2 region mid-realise (one stage placed), opened with the 0.11.0 jar.
      - Every tile request fails with the format message.
      - No cell is written (`dev.region.hash` unchanged).
      - `Regions.remove` with the 0.11.0 jar is exact on what 0.12.0 wrote.
11. **S1 green:**
    - every §8.3 bar passes on the natural fixture run;
    - E-flat passes on the flat variant;
    - the determinism golden is committed;
    - **Noah's approval** in `approvals.json` matches the run's `evidence.sha`.

    The axis-run calibration card is **not** required for S1 green. If Noah fills it in, the proposed threshold is
    recorded for 6c. If not, 6c's contract carries the calibration.
12. **Regressions, the full engine chain** (§12.1 says why). Steps of `tools/gate6a.mjs` unless marked:
    - **every sidecar, kit and mod test** (including 6a's);
    - **`megaA`** (one run, prepared, every phase 6 §7 bar, with `ext["architect_mc:check"] = false` so the plan stays
      6a's);
    - **`megaB`** (staged: relog and sidecar-kill resumes, per-stage engine time and chunks loaded);
    - **`eflat`** (0 mismatches);
    - **`forest`**;
    - **`crash`** (RG1-RG6, K3/K7 inside a region);
    - **`inv3`**;
    - **`staged`**;
    - **`heap`** (used heap after a forced GC at the 5 checkpoints, at most baseline + 1 GB; megaA under `-Xmx` = baseline +
      2 GB; sidecar RSS at most 1.5 GB). The evaluator, the blob copy and the volume path can each move these;
    - **`apijars`** with the unchanged 1.8.0, 1.7.0 and 1.6.0 apitest jars, and `api-compat` clean (references and the
      1.8.0 surface);
    - **the `regress` chain:**
      - the 4d gate;
      - 4e gate items 2, 5, 6, 8, 9, 10;
      - 5b gate items 2, 4, 5;
      - the 4a jobs, 4b and 4c sim suites;
      - the **throughput margin**: one unmeasured warm-up, then the 4e village plus roads at 4 ms, median of 3 at least
        15k cells/s (6 runs if within 5%).
    - In every megaA and megaB run, `generatedDuringRealise` is **0** (the 6a open item, re-checked).
    - **Excluded `gate6a.mjs` steps, with why:**
      - `chunkstatus`: 6a's one-time verification of how 26.3 reads chunk status; 6b doesn't touch `ChunkGen`;
      - `prepare` as a separate step: megaA runs prepare itself;
      - `smoke`/`base`/`eval`: harness steps, not bars.
13. **gate-verifier** checks the result. It reproduces items 1, 2, 5, 10(b) and 11's sha check independently, and it checks
    that spend is within the $3 cap, on the claude login (the environment log).

### 12.1 Which regression tier, and why

Per the gate-runner policy (two tiers; the full chain when realise, the journal or streaming change), 6b needs **the full
engine chain**, not only `regress`:
- **Realise changes.** `kit/lib/realise.mjs` and `lib/sdf.mjs` gain the format-2 compile path, new shapes and per-cell
  material-rule dispatch. That is the evaluator's hot path, so the 45k cells/s evaluation bar and the per-tile 2 s limit
  can regress even for format-1 IRs.
  - The format-1 golden proves the *output* is unchanged. It cannot prove the *speed*.
  - So megaA re-measures evaluation p50/p99, starvation share and cells/s.
- **Streaming changes.** The `blob_unknown` path, the blob re-send from the world copy, and the region record's blob copy
  change the mod-sidecar resume logic that megaB (sidecar kill, relog) and the crash step (RG3-RG5) exercise.
- **The journal does not change.** No store format, no journal code. That alone would allow `regress`, but either of the
  two above requires the full chain.

The full chain is **one** run of megaA and megaB, not three. The throughput median-of-3 is the only repeated item.

## 13. Build order inside 6b

1. Build and archive the 0.11.0 apitest jar (`artifacts/gate6b/v0110/`). Pin the player-block `Reason` question (§7.3
   case (a)) with the 0.11.0 jar.
2. Kit:
   - IR format 2, `requires`, side blobs;
   - the new shapes; material rules; the lint list;
   - the format-1 golden check, wired first so every later kit change runs against it;
   - the 6b primitives; `floatingIsland`; ARVX decode.
3. Kit: the virtual world, M1-M14, prefix checks, the previews, `siteplan.json`.
4. Bundled programs and fixtures (`crater_works`, `rift_city`, `sky_isle`, `walled_hill`, `floating_islands`), the
   expected reports, and the broken variants.
5. Sidecar: check, preview, blobs, `hello` versions, `region.design` (the template pick).
6. Mod: blob copy and re-send, the `PLAN_STALE` gates, `Survey.volume`, previews/check/design/nudge, the ghost,
   commands, DevBridge; Java 1.9.0, apitest steps, api-compat.
7. Tools: `find-site.mjs`, `scenarios.mjs`, the scenario files (S1-S6 fixtures pinned), `gate6b.mjs`.
8. Gate items 1-10 and 12, then S1's run and the gallery (item 11), then the gate-verifier (13).

---

## Open questions for Steward

- **S-6b-1. `siteplan.json` format 1** (§3.4): the `graph` block is derived topology (lot entrances, anchors, path
  endpoints, path edges with `mover: ["player"]`) until 7a replaces it with the planned graph and adds `seconds`, `risk`
  and the other movers as new members (format stays 1). Is reading that early derived graph useful to you in 6b, or would
  you rather it stay absent until 7a?
- **S-6b-2. The two prompts.** The gate runs "a repurposed meteor crater mining facility" (your PLAN wording; A5B used "a
  crater mining facility") and "a rift settlement". Are those your exact test strings? Is `rift_city`'s shape (a linear
  carved rift, ledge terraces on both walls, bridges across, a lit side hall, a floor utility corridor) what your rift
  means?
- **S-6b-3. `NO_TEMPLATE`.** With authoring in 7c, a brief no bundled program fits ends the design with `NO_TEMPLATE` and
  the pick's reason. Do you want the closest program offered anyway (with `fits: false` and the reason), so your inbox can
  propose it, or a clean refusal?
- **S-6b-4. The nudge actions** (§6.2): `MOVE_CLOSER`, `PREPARE`, `START_SIDECAR`, `APPROVE_STAGE`, `REPLAN`. Does your
  inbox need any other? `PREPARE` from a nudge counts as the explicit start S6 asked for; agreed?
- **S-6b-5. `RegionPlan.report` and previews by default.** Planning now runs the checker and renders (mega_bench: up to
  about 3 extra minutes). Is that acceptable as the default, with `ext["architect_mc:check"] = false` to skip, or do you
  want check and previews only on request?
- **S-6b-6. `Survey.volume` early.** It ships in 6b with no 6b consumer beyond the measurement. Do you want to call it
  yourself before 7a (e.g. to judge "sculpt vs find site"), and is the class set enough?

## Open questions for Noah

- **N-6b-1. Gallery mechanics.** One private claude.ai page per phase, republished to the same link. Approve or Reject per
  scenario with notes, writable only by you, bound to the run's evidence sha, and mirrored by the builder into
  `approvals.json` and PLAN.md. Is that how you want to approve, and is a 10-render "natural / geometric" calibration card
  for the islands acceptable extra work in 6b?
- **N-6b-2. S1 without rope.** S1's brief says "rope and stone". Rope bridges are a 7a connector, so 6b's S1 is "stone
  links" (stone bridges and stairs), and 7a re-runs it with rope bridges and sends it back to your gallery. OK to call S1
  green in 6b on that basis?
- **N-6b-3. Spend.** Expected about $0.30, cap $3 (claude login only), all template picks. SETTLEMENTS said $1-3. OK?
- **N-6b-4. Downgrade behaviour.** A world with a format-2 region opened by 0.11.x fails that region's tiles with an error (the exact region state is pinned by gate item 10(c)) and
  writes nothing (it can still remove it exactly), rather than refusing the whole world as journal format 2 did. Accept,
  or do you want a hard refusal (a store-format bump)?
- **N-6b-5. Survival rule timing.** Your decision (natural cut/fill and grown forms free; connectors and buildings as
  construction sites) isn't built in 6b, so regions still refuse in survival-toggle worlds. Proposal: implement the
  terrain half in 6c (when forms and relief arrive) and the connector half in 7a. Or do you want it sooner?

## Deferred (from 6b)

- Program authoring sessions, and an authoring fallback for `NO_TEMPLATE` (7c).
- The op kinds `relief`, `scatter`, `voxels` and `stamp`; fields produced by passes; the other generators; M17-M20 (6c).
- `graph`/`siteLots`/`lotEntries`/`fits` in the IR; connectors (rope bridges in S1 v2); `nav.json`; the `villager` and
  `steward` movers; the behavioural villager test; M8 promotion; M15 and M16; site analysis; volume drift by class (7a).
- The axis-run bar as a gate (6c, from the 6b calibration).
- Rule promotions (after real generations; recorded in PLAN.md).
- The survival rule for regions (N-6b-5).
- Textured region renders; a set-level critic (unchanged deferrals).
- The 6a open items not fixed here: the cause of the 161 generated chunks (monitored), and the structure-template memory
  leak on repeated 5b sizecap runs.

## Coordinator decisions on Noah's questions (provisional; Noah may override)

- **N-6b-1** The gallery as drafted: a private claude.ai page with the metrics first, then before/after renders, approve or
  reject with notes, bound to the run's evidence sha. The 10-render calibration card is optional for Noah; skipping it doesn't
  block S1.
- **N-6b-2** Yes: S1 goes green in 6b with stone links only. Rope bridges arrive in 7a.
- **N-6b-3** Yes: about $0.30 expected, with a $3 cap.
- **N-6b-4** The soft downgrade is accepted: 0.11.x writes nothing to a format-2 region, and the gate pins that behaviour.
- **N-6b-5** Yes: the terrain half of the survival rule lands in 6c, and the connector half in 7a.

## Changes from Steward's review of 6b (steward-mc/docs/A6B-REVIEW.md), all accepted

Where this section and the 6b text above disagree, this section wins.

- **S-6b-1** The topology graph ships in 6b in `siteplan.json` (format 1), marked `derived: true` so it can be told apart from 7a's planned graph.
- **S-6b-2** The crater gate's `RegionDesignRequest` receives Steward's **card fields**, not the raw string:
  - crater: site "giant meteor crater", purpose "mining facility", style "hellish evil lair" (player text "repurposed giant
    meteor crater mining facility, hellish evil lair");
  - rift: site "rift", purpose "settlement" (player text "a rift settlement").
  
  `rift_city` is a linear carved rift with ledge terraces, bridges, a lit side hall and a floor utility corridor. Cave city and
  ravine town are separate templates.
- **S-6b-3** No `NO_TEMPLATE` refusal on its own: the result offers the **closest program** with `fits: false` and the reason,
  so a caller can propose it. `Reason.NO_TEMPLATE` stays for callers that require a fit.
- **S-6b-4** The nudge set is enough. A nudge `PREPARE` counts as the explicit start only after it has shown the prepare size and
  time estimate.
- **S-6b-5** Check and previews run on every plan by default. The `ext` skip is kept, and progress is reported ("checking",
  "rendering previews") so a caller's inbox isn't silent.
- **S-6b-6** `Survey.volume` returns summary stats alongside the grid: class counts, slope and overhang fractions, and tree and
  cave presence.
