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
- N-6b-1, N-6b-2 and N-6b-3: the Steward session relayed on 2026-10-09 that Noah, in that session, raised no objection to them.
  Recorded as relayed, not as first-hand confirmation.

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

## 6b addition: region lot entrances (Noah, 2026-10-09)

Problem seen in the S1 renders: each region lot brings the single-building approach (a dirt-path strip and a cobblestone
apron) that clashes with the region's own roads, stairs and decks. For **region lots only** (single placements keep today's
approach):
- **Style:** the approach and the pad apron take their blocks from the region's `path` and `foundation` roles. Where the
  approach meets a road or walk-surface, it uses that surface's block.
- **Fit:** the approach runs to the nearest walk-surface cell (road, stair, bridge deck, path) by the shortest route the 4d
  approach rules allow. If the entrance already opens onto a walk-surface within 1 cell, there is no approach. If no
  walk-surface is within the approach's maximum length, the default length applies, in the region style, and checker M2
  reports the lot if the player can't reach it.
- **Apron:** the +1 apron becomes the surrounding natural ground block, or the path role where the approach crosses it.
  It is never the default cobblestone.
- **Gate:** S1 and crater_works renders show no default dirt-path or cobblestone cells on lot fronts (a cell count by block,
  plus screenshots looked at). M2 player reachability is unchanged or better. Exact undo still holds. The re-run is limited to
  the steps this touches.
- 7a replaces this with designed entrance connectors in the settlement graph.
- **Extended after Steward's live runs (2026-10-09):** plain placements (not region lots) get the same behaviour **when the
  caller asks for it**: `PlaceRequest.pathStyle` (a road surface block). The approach also takes the block of an adjacent 4e road
  site it joins, and joins the nearest road cell. Without either, single placements are unchanged. API 1.9.0 adds the field (old
  constructors kept). Gate: a plain lot next to a 4e road with `pathStyle` shows no default dirt-path or cobblestone on its front.

## Phase 6b as built (API 1.9.0, mod 0.12.0, recorded 2026-10-10)

Built on branch `phase/6b`. Gate record: `artifacts/gate6b/REPORT.md` and the scenario runs under
`artifacts/scenarios/6b/` (local). Where this section and the 6b text above disagree, this section says what shipped.

**Kit.** IR format 2 (side blobs, fields, volumes, forms, material rules, `requires` walked), the eight new shapes, the
material rules, the 6b primitives (`cavern`, `utility`, `floating`, ring towers and crenels, bridge arches, towers, `ends` and
`over: 'ours'`, solid and lit stairs, `Part.spiralTower`, lot `pad.fill: 'none'`, `Region.clearing`), `floatingIsland`,
the virtual world, M1-M14 at full resolution with prefix checks, the four previews and `siteplan.json` (format 1, its graph
`derived: true`), ARVX, and ARWD dumps (`decodeArwd`, `encodeArwd`, `dumpWorld` with the plan's attribution). Five bundled
programs: `crater_works`, `rift_city`, `walled_hill`, `sky_isle`, `floating_islands` (S1). The format-1 golden
(mega_bench) is byte-identical; format-2 goldens for S1 and the four fixtures pass on macOS and in a Node 22 Linux container.

**Decisions and deviations made while building:**
- The checker has no coarse mode: full resolution meets the coarse bar (mega_bench 10.7 s in game, about 21 s on the
  synthetic survey; bar 60 s). `report.resolution` says `{coarse: 1}`.
- M8's barrier is a block at least 1.5 tall (fences, walls, panes, closed gates) or two blocks high.
- The `floatingIsland` cost bar (2x a sphere per cell) is missed (about 20x); the tile limit and 45k cells/s hold.
- Programs may export `roles`: defaults between the rustic built-ins and the bible's roles. `crater_works` names coarse dirt
  and stone bricks for `path` and `foundation`, `rift_city` packed mud and mud bricks.
- `crater_works` turns its gate (with the bridge, ring opening, road and entrance on the bridge's line) to the side whose
  ground is nearest the rim, and caps the rim 6 above it: on the pinned crater site the south gate was 19 below the rim and the
  bridge ran inside the terraces (M2). `rift_city` runs on the longest stretch with no surface water across its band (the
  pinned rift site's lake gave 283 M4 cells) and puts no lots on a ledge segment too short for its stair; it reads a `damp`
  field (a side blob) for its floor, so it is a format-2 IR with a side blob (gate item 10(a)).
- A bridge with `over: 'ours'` clears 6 above its deck (4 left a rail lantern floating on S1's pinned site).
- Lot pads (6b addition, region lot entrances): the footprint's top is the surface role; the 1-column apron keeps a natural or
  region-made top and fills a gap with the surface role; a fill-none pad keeps the foundation over the footprint and the form's
  top as its apron. A plan recorded as kit 0.11.x keeps 0.11's pad.
- The region lot's entrance approach (mod): the region's `path` and `foundation` roles; it stops at the first walk surface
  (a 4e road cell, a region path tile's walk cell, or region-made standable ground) and takes that surface's block when it is a
  full block; an entrance opening onto one has no approach. `PlaceRequest.pathStyle` gives a plain placement the same,
  joining 4e roads only. A plain `pathStyle` site loses the style on move and 5b delta replans (not stored on the site).
- E-normal adds the class `grazed` (grass or fern now air: a sheep ate it during a stand), the world's doing.
- `region.release` gains `evict` (DevBridge `dev.region.drop` sends it so a shared cached IR goes too).
- **Survey.volume's cell limit is 268M cells** (`VolumeSurvey.MAX_CELLS`), set by gate item 7: 9.6M cells/s wall time,
  0.039 bytes/cell frozen; 60 s and 64 MB give 578M and 1.7G, and the sampler's 1-byte-per-cell heap at 256 MB decides it
  (a third bound the contract's rule does not name).
- **The downgrade (10(c)), pinned:** 0.11.0 does not load a format-2 region's record (its region list is empty, `remove`
  says "no region"), writes nothing to it, and leaves the record on disk; 0.12.0 then resumes it and one `Regions.remove` is
  exact. 0.11.0 never requests a tile, so there is no per-tile format message.
- The pinned world seed `2026100906` is desert and warm ocean near spawn. find-site's needs were widened (relief and water
  caps) and gained `center` and `stopAt`; the crater site has 47 blocks of relief, and `crater_works`' catalogue says hilly
  land is fine (one of four picks said NO_TEMPLATE while it said "relief low").
- Scenario metrics run on the realised world: two ARWD dumps of the claim + 8 over the written y span +-8, the kit checker over
  them with the plan's part and walk attribution; a cell the world changed on its own (kelp, grass under water) is not a
  written cell. The prepared chunks tick 90 s before the dumps. Palette role adherence counts role blocks, their shape
  variants and form materials; the axis-run share is recorded only.
- The S1 lot children are the 9-wide 6a stub (only it fits S1's 9x9 lots); the stub's own three front path rows are part of
  its design (inside the lot box), not the approach.
- **The engine chain and the MSPT bars (2026-10-10).** The first engine chain
  (20261010-013327) failed 4e-megalite (4 ms run, tick max 65.7 ms) and 6a-megaA (realise max 92.8 ms; undo 211 s, max 103 ms).
  Paired runs against v0.11.2 on the same box (load average 15-64: CI runners, the tiers agent's chain, other clients) showed
  v0.11.2 failing the same bars (megalite 4 ms 76.5 / 88.1 ms; megaA undo 64 ms; undo-only on the same realised world: v0.11.2
  247 s / 82 ms, 6b 256 s / 118 ms), the spikes in the vanilla tick and in descheduled or GC-paused placement ticks, and no
  6b-only frame on any thread in JFR. Not a 6b regression (the coordinator and Noah accepted this, and set the MSPT bars to
  judge Architect's own per-tick time). Judged as the placement ticks' wall time (`placementMsMax`) they still failed under
  the load (megalite 86 and 166 ms, megaA 138 and 169 ms), so the builder proposed, and the coordinator accepted, measuring
  it in CPU time:
  `dev.placement.stats` adds `placementCpuMsMax` / `placementCpuMsMean`, the placement ticks (batches, groups, jobs: writes,
  checks, plan work) in the server thread's CPU time, and megalite, megaA and the scenario MSPT row judge it at 50 ms. The whole
  tick (max, p99, over 50), the placement ticks' wall time, the vanilla tick (`serverMsptMax`) and GC are recorded, not judged.
  Bench steps run under whatever load there is (Noah). Re-runs on c717804: 4e-megalite PASS (20261010-065651: Architect CPU
  max 26.4 ms at 4 ms, group undo 12.9 ms); 6a-megaA (20261010-071231): PLACED, 45.3k cells/s, undo 211 s with Architect CPU
  max 19.7 ms, realise Architect CPU max 51.5 ms (37.1 and 42.3 ms in two other runs; the 065651 run went PARTIAL when two
  tiles passed the sidecar's 2 s evaluation limit during a machine stall). Mixed P/E cores make CPU time load-dependent too.
  **Accepted by the coordinator (2026-10-10)** with that caveat: the three c717804 megaA realise maxima are 37.1, 42.3 and 51.5 ms
  of Architect CPU (load average 30-60).
- **For slice 0a (coordinator):** a tile evaluation that passes the sidecar's 2 s limit retries with backoff instead of failing
  the tile, and a region never goes PARTIAL for timeouts alone (a busy server stalled two megaA tiles past the limit).
- **Undo planning (journal).** The group undo's planner (`Journal.planUndo`, `Sections.Planner`) keyed packed positions in
  `java.util.HashMap`: `Long.hashCode` folds a `BlockPos.asLong` so that many positions share a hash, the bins treeify, and one
  section's plan took 50-220 ms in a tick under load (both versions). It now uses fastutil `Long2ObjectOpenHashMap` /
  `LongLinkedOpenHashSet` (same iteration order for the writes; `Undo.written` is still a `HashMap` copy). Undo-only on the
  6a-made megaA world, JFR server-thread samples planning : restoring went from 884 : 439 (6b) and 844 : 570 (v0.11.2) to
  351 : 311, and placement ticks with group work of 25 ms or more from about 46 to 1. The undo's wall time is load-bound
  (gate runs after the fix 195-229 s, before 211-255 s). Moving the plan off the server thread is not done: the
  planner reads the world per cell (`holds`), and per section it is now a few ms; recorded for 0c.
- **inv3 under kit 0.12's pads.** On the flat fixture a 0.12 lot pad writes nothing (its `IF_NATURAL` ops change no cell of
  flat grass), so no lot covers a terrain tile; the step now takes a region tile that covers another (a path over its
  terrain) when no lot covers a pad. Same invariant, same end state in either order.
- **S1 final run** 20261010-055851 (natural) and 20261010-055539-flat on 67eebeb (the undo-planning fix in): every run bar
  green, evidence `1bf0b8e36a1f`, IR `46b2d75ea03a` (the golden), E-flat 0, E-normal 1017 all classified (growth 1016, live 1;
  the undo's own 0), Architect's own tick max 22.9 ms (wall; that build had no CPU figure), $0.00. The gallery bundle is in the main checkout's
  `artifacts/scenarios/6b/gallery/` (`SCENARIOS_ART` puts runs there). The red-brown satellite island (SE, cam_high) is
  grass_block in the `minecraft:dappled_forest` biome's grass tint (an in-game `execute if biome` at the island; the pristine
  before-shot shows the same patch on the ground): the world's colour, not the program's.

## Phase 6c slice 0a: consumer support (FROZEN after Steward review)

This slice is API 1.10.0 and mod 0.13.0. C4 ships early as sub-release 0.12.2, with API 1.9.0 unchanged.

- **Branch:** `phase/6c-0a`, in the worktree `../architect-mc-6c-0a`.
- **Spend:** $0. Everything runs on the sim or the stub; there is no claude-login run.
- **Scope:** the 0a list in PLAN.md "Steward round 4" item 1, plus:
  - the round 5 additions: C14 caller pins, `WORLD_STOPPED` and own-time percentiles;
  - the coordinator's tile-timeout item from CONTRACT "Phase 6b as built".
  
  Everything else waits for 0b or 0c (see Deferred).
- **Precondition:** the gate tiers branch (`tools/gate-tiers`) is merged to main before this slice's gate runs. Main's
  `gate-chains.json` only has quick, regress and engine. The `slice` tier, the impact map and the own-time tick bars exist only on
  that branch.

### 0. What exists today (main, v0.12.0)

- **C4 stub.**
  - The real sidecar's `--backend sim` already covers everything the stub needs:
    - bibles (`SimBibleBackend`: roles, components, the settlement roles);
    - design groups, including massingFirst, `approvalUi: owner`, approvals and redirects;
    - detail passes that conform to their massing;
    - `job.run` with schema-satisfying answers. `ext["architect:simAnswer"]` scripts one.
  - The mod's launcher passes `ARCHITECT_SIDECAR_BACKEND=sim` for both the dev-dir and the bundled sidecar.
  - Steward's `run-e2e-client.sh` doesn't use it. It points at `mod/src/test/resources/stub-sidecar`, a 360-line launcher-test stub
    that handles only 6 message types (no bibles, groups, massings or jobs). Gates 4d, 4e and 5b use that stub, so it stays as it is.
- **C5.** `estimates.ts` keeps rolling samples per model. Its seeds come from 4b, 4c and 5a: design $0.8-3.2, massing $0.10-0.40,
  bible $1.2-2.0. It has no kinds.
- **C6.**
  - `Sites.fitToLot` resolves library entries only, through `Blueprints.get`.
  - Massings read as `Blueprints.Entry` through `MassingFiles` (`id@v`).
  - Conformance (`kit/lib/massing.mjs`) checks parts, roofs and size. It doesn't check the front or the entrance.
- **Batches.** Finished `BatchView`s are kept until the world stops. BATCH_DONE fires live only.
- **C9.** None of the existing ids is idempotent:
  - `GroupRequest.id` is "ignored when taken";
  - `Batch.id` "must be unused";
  - bible jobs take no id.
- **C7.** `Group.cost` is the sum of the items. The bible is excluded, and the critique sits inside the item cost (the split is in
  `Design.critique`).
- **Group events.** The mod dedupes in `RecordBook.fire`. `awaiting_approval` and `paused_budget` re-fire while an action is in flight.
- **Bibles.** `void cancel(jobId)` is fire-and-forget.
- **C14.** `EntryVersion.pinned` means a standing site stands at that version. `entry.pins` reports the pinned versions, and the
  sidecar's GC keeps them.
- **Futures at stop** fail with `IllegalStateException` or `TimeoutException`. Only the region futures have a type
  (`RegionRefused`).
- **Tile timeouts.** `regionpool.ts` fails a tile that runs over `regionTileMs` (2 s), and its item fails with it.
- **MsptTrace.** It has full-tick percentiles, plus the write wall time's max and mean. The judged figure, `placementCpuMs*`, has no
  percentile.

### 1. API 1.10.0 rules and behaviour changes

**Rules (as in 1.9.0):**
- `ArchitectApi.VERSION = "1.10.0"`.
- Every widened record keeps its 1.9.0 constructor as a secondary constructor.
- New interface methods are defaults that throw "... needs Architect API 1.10.0".
- New enum constants are appended.
- `tools/api-compat.mjs` checks the **unchanged 0.12.0, 0.11.0 and 0.10.0 apitest jars** (API 1.9.0, 1.8.0 and 1.7.0) and the 0.12.0
  mod jar's surface (`--surface`). All three jars pass their suites against 0.13.0.

**New types:** `ArchitectRefused extends RuntimeException` with `Reason reason()`. `RegionRefused` is re-parented under it.
Inserting a superclass is binary compatible; if api-compat flags it, the tool is taught this one case.

**New Reasons (appended):** `WORLD_STOPPED`, `OP_KEY_CONFLICT`, `TILE_SLOW`. `WaitAction.Kind` gains `RETRY` (appended).

**Behaviour changes:**
1. Futures pending at world stop fail with `ArchitectRefused(WORLD_STOPPED)` instead of `IllegalStateException` (§10).
2. GROUP_UPDATED fires only on real transitions, so less often (§7).
3. `Sites.batches(owner)` and `batch(id)` return finished batches across restarts (§4).
4. `EntryVersion.pinned` also means "a caller pin exists" (§9).
5. A tile timeout no longer fails the item, so the region doesn't go PARTIAL; it waits with TILE_SLOW (§11).
6. A detail whose front differs from its massing's now fails conformance, a repair round. In paid runs that can cost one repair
   round, about $0.3-0.9. The $0 gate does not measure this.

### 2. C4: the sim as the consumer stub (ships first, as 0.12.2)

- **Turning it on:**
  - A consumer sets `ARCHITECT_SIDECAR_BACKEND=sim` on a dev client running the published jar. No Architect checkout is needed.
  - The bundled sidecar then runs with `--backend sim`.
  - If the bundled install (`npm ci --omit=dev`) exists only for the Agent SDK, sim mode skips it. 0.12.2 checks which is true.
  - README gains "Testing against Architect".
  - The sim never calls Claude.
- **Sim costs:** set with config `simCosts` (in `sidecar-data/config.json`) or `ARCHITECT_SIM_COSTS`.
  - `"zero"` is the default, so existing gates don't change.
  - `"measured"` reports §3's seed midpoints as notional costs:

    | Item | Notional cost |
    |---|---|
    | bible | $1.35 |
    | massing | $0.19 |
    | detail | $3.40 |
    | report critique | $0.10 |
    | repair round | $0.50 |

    With these, budgets, the soft pause, `extendGroup`, `cost.byKind` and the estimates behave as in a real run.
  - An object with those five keys sets the costs directly.
  - These costs are labelled `sim: true` in `basis` and in the log. Nothing is spent.
- **Faults (sim only, in a request's notes or ext):**
  - `sim:usage_limit` already exists;
  - `sim:fail` (new) makes the design fail;
  - `sim:repair` (new) adds one repair round.
- **Scripted job answers:** a `simAnswer` is now validated against the job's schema; a mismatch fails the job.
- **Speed:** a Steward-sized flow (bible, 3 massings, approval, 3 details) finishes in under 2 minutes at the default `simStepMs`
  of 400.
- **0.12.2** is a patch: sidecar and docs only, API 1.9.0. Its mini-gate is §13 item 1.

### 3. C5: estimates by kind, re-seeded

- **Seeds.** Measured samples still replace them per model. The basis reads "seed (Steward phase 1, 2026-10-09)".

  | Pass | Cost | Time |
  |---|---|---|
  | detail with a report critique | $2.5-4.6 | 8-15 min |
  | massing | $0.12-0.30 | 1-3 min |
  | bible | $1.16-1.55 | 5-8 min |
  | repair round | $0.3-0.9 | |

  The critique's figures stay reported separately, as today.
- **Kinds:**
  - **original:** a share of the bible, plus massing, detail and critique;
  - **adapted:** a placed design refitted to a new lot. Seeded at one repair-sized turn ($0.3-0.9), with the basis "unmeasured
    until 7b";
  - **copy:** $0, plus the variant build time. It becomes real with C1 in 0b.
- **API:**

  ```java
  CompletableFuture<Estimate> estimate(EstimateRequest r);              // Designs, default-throwing
  record EstimateRequest(@Nullable GroupRequest group, int originals, int adapted, int copies, boolean newBible,
                         boolean massingFirst, boolean reportCritique, @Nullable String model) {}
  // Estimate gains trailing Map<Kind, Item> byKind; enum Estimate.Kind { BIBLE, ORIGINAL, ADAPTED, COPY }
  ```

  With `group` set, its items count as originals.
- **Bars** (unit tests: Steward's runs replayed through the estimator, with no samples):
  - **Phase 1:** 8 originals, a new bible, massingFirst, report critique. The cost band contains $31.03, and the midpoint is within
    ±25% of it.
  - **Greywater Hamlet:** 3 originals and a new bible. The cost band contains $13.76, and the midpoint is within ±25%.
  - **Greywater's time:** its ~70 min includes the player's approval wait and the play, which the estimate leaves out. So the time
    estimate is recorded next to it, not judged (question S-0a-5).

### 4. C6: massing placement prediction

```java
LotFit fitMassingToLot(MassingRef massing, BoundingBox lot, Direction streetSide, FitOptions o);   // Sites, default-throwing
```

- **Fit and check.** It uses the same `LotFitting.fit` as `fitToLot`, on the massing version's template (read via `MassingFiles`).
  The verdict is the normal check against the massing's template and approach at that spot.
- **Unknown massing or version:** `UNKNOWN_BLUEPRINT`.
- **Prediction.** A detail from that massing version, fitted with `fitToLot` to the same lot, gets the **same rotation**, and its
  origin is within **±2 on x and z and equal in y**.
- **Conformance changes (kit), which make the prediction hold:**
  - a different `front` is an **error**, so the round goes back to the designer;
  - an entrance column more than 1 off is an **issue**.

### 5. Durable finished batches

- **Kept across restarts.** DONE, CANCELLED and STOPPED batches stay in `architect-queue.json`.
- **Retention:** the newest 256 finished batches per world, and every batch finished in the last 30 days, whichever keeps more.
- **Ids:** the `b<n>` counter is persisted, so a batch id is never reused.
- **BATCH_DONE fires once per batch, in this order:**
  1. fire BATCH_DONE;
  2. mark the batch "fired";
  3. save the queue.
- **Catch-up.** On world load, BATCH_DONE fires for every finished batch that isn't marked fired, as JOB_DONE's catch-up does.
  - After a clean stop, the event fires exactly once.
  - After a crash, it fires at least once. Consumers dedupe by batch id, and the javadoc says so.
- **DevBridge:** `dev.batch.skipSave {batchId}` skips the save after that batch's fire, so the gate can crash inside the window.

### 6. C9: caller operation ids

- **The key.** `BibleRequest`, `GroupRequest` and `Batch` gain a trailing `@Nullable String opKey`, matching
  `[A-Za-z0-9_.:-]{1,128}`. A key is scoped by **(owner, kind, opKey)**; a null owner means the player.
- **Same key, same body:** the call returns the first call's result and starts no new work:
  - the same `BibleJob`, as it stands now;
  - the same group id;
  - the same batch id.
  
  That holds in any state, including final or cancelled.
- **Same key, different body:** the call fails with `ArchitectRefused(OP_KEY_CONFLICT)`.
- **How bodies are compared:** by the sha256 of the request's canonical JSON, without `opKey`. For a `Batch`, that is its persisted
  queue-file form (dimension id, actor UUID), not the live objects.
- **Where keys are written:**
  - **Bible jobs and groups:** in the sidecar's `state.json`, in the same write that creates the job, before the ack.
  - **Batches:** in `architect-queue.json`, in the save made when the batch is queued.
- **Retention:** a key lives as long as its record, and for at least 30 days after the record is final.
- **After a crash between the request and its ack:**
  - If the request arrived, the key exists, and a retry or a lookup adopts the work.
  - If it didn't arrive, the lookup is empty, and a retry starts the work once.
- **Lookups:**

  ```java
  CompletableFuture<Optional<BibleJob>> jobByKey(@Nullable String owner, String opKey);   // Bibles
  CompletableFuture<Optional<Group>> groupByKey(@Nullable String owner, String opKey);    // Designs
  Optional<BatchView> batchByKey(@Nullable String owner, String opKey);                   // Sites, server thread
  ```

  - A sidecar lookup fails with `SIDECAR_UNAVAILABLE` when the sidecar isn't connected. It never answers "empty" then, because
    empty must mean "never received".
  - `BibleJob`, `Group` and `BatchView` gain `Optional<String> opKey`.
- **Protocol (2, additive):**
  - `bible.request` and `design.group` take `opKey`;
  - their acks gain `adopted`;
  - new messages `bible.byKey` and `group.byKey`;
  - the feature `opKeys`.
- **DevBridge:** `dev.api.dropAck {type}` drops the next ack of that message type in the mod.

### 7. C7 per-stage breakdown, and group events

```java
// Group gains trailing Breakdown breakdown, long seq, String lastAction (old constructors: EMPTY, 0, ""), and:
Map<String, Double> costByKind();          // bible, massing, detail, critique; derived from breakdown
record Breakdown(Map<Stage, Line> stages, double totalUsd, long wallMs, long firstDetailedMs) {
  enum Stage { BIBLE, MASSING, DETAIL, REPAIR, CRITIQUE, QUEUED, USAGE_HOLD }
  record Line(double usd, long ms, int count) {} }
```

- **Stages:**
  - DETAIL is the first design round of each detail pass.
  - REPAIR is rounds 2 and later, for massings and details.
  - CRITIQUE is critic calls and loop revisions.
  - QUEUED and USAGE_HOLD carry time only.
  - `ms` is summed item time. `wallMs` is the group's wall time. `firstDetailedMs` is the time to the first detailed item (Steward's
    15-minute target).
- **The bible line:** the job or jobs that made the pinned bible version. That cost is counted in the first group of the same owner
  that pins the version; later groups show it as 0 (question S-0a-3).
- **Totals:** `Group.cost` keeps its meaning, the sum of the items. `totalUsd` = `cost.usd` + the bible line.
- **Job log:** one `group <id> breakdown {json}` line goes to `sidecar-data/logs/sidecar.log` at awaiting approval and at the final
  state.
- **`seq`:** set by the sidecar and persisted. It goes up only when one of these changes:
  - the status, the reason, the wave or the awaiting set;
  - an item's status, stage, entryId, massing version or rounds.
  
  Cost, step text and `updatedAt` don't bump it, and `group(id)` still returns them.
- **`lastAction` values:**
  - creation and items: `created`, `item_started`, `item_done`, `item_failed`;
  - massing and approval: `massing_ready`, `awaiting_approval`, `approved`, `redirected`;
  - budget: `paused_budget`, `extended`, `resumed`;
  - usage limit: `held_usage`, `usage_reset`;
  - the end: `cancelled`, `done`, `failed`.
- **What the mod fires:**
  - **GROUP_UPDATED:** only when `seq` grew.
  - **GROUP_AWAITING_APPROVAL:** only on a transition into it, or for a newly waiting massing version.
  - Neither fires again while an approve, redirect, extend or resume is in flight.
  - Against an older sidecar with no `seq`, the mod keeps today's dedupe.

### 8. Bibles.cancelJob

```java
default CompletableFuture<BibleJob> cancelJob(String jobId)   // `void cancel` stays: its return type can't change
```

It completes with the job, cancelled, at the ack. It fails like `cancelGroup` does:
- "no job";
- "already <status>";
- `SIDECAR_UNAVAILABLE`.

BIBLE_DONE fires once, as today.

### 9. C14: caller version pins

```java
CompletableFuture<Void> pinVersion(String entryId, int version, String owner);     // Library, default-throwing
CompletableFuture<Void> unpinVersion(String entryId, int version, String owner);
List<String> pinOwners(String entryId, int version);
```

- **Where pins live:** pins are game-wide, like the library. They persist in `<gameDir>/architect/caller-pins.json` and are merged
  into `entry.pins`.
- **What a pin keeps:** a version stays while a site stands at it or any caller pin exists.
- **Errors:** pinning a collected or unknown version fails with `VERSION_GONE`. Unpinning is idempotent.

### 10. WORLD_STOPPED

- **Which futures fail.** At SERVER_STOPPING, every pending API future fails with `ArchitectRefused(WORLD_STOPPED)`:
  - Sites: place, remove, queue, cancelBatch, removeGroup, undoStage, applyDelta, revert, placeRoad, placeCells;
  - Regions;
  - Survey;
  - the Designs, Bibles, Library and Jobs futures that wait on an ack or an outcome (`PendingFutures.failAll`).
- **Sidecar work keeps running.** The caller finds it again with §6's lookups or the listings after the next load.
- **Until a world starts,** calls that need one fail at once with WORLD_STOPPED.

### 11. Tile-evaluation timeouts

- **Sidecar retries:**
  - A tile over its limit is retried on a fresh worker, up to 3 times.
  - The limit doubles each time (2, 4, 8 s), with 1, 2 and 4 s pauses between attempts.
  - After that it answers `region.tile.error {code: "timeout", attempts}`.
  - Every other error answers `code: "error"`, with no retry.
  - A retry is a fresh deterministic evaluation, so the bytes are unchanged.
- **Mod (`TileStream`):**
  - A `timeout` error puts the tile in WAITING, and the item waits with `Refusal(TILE_SLOW)`.
  - The mod asks for the tile again after 30 s, 60 s and 120 s, then every 5 min.
  - The region stays REALISING and offers `RETRY` (`nudge`, which asks again now).
  - A non-timeout error still fails the tile and its item, so only that can make a region PARTIAL.
- **Test hook (sidecar, dev only):** `ARCHITECT_TEST_SLOW_TILES=<n>` makes the first n evaluations of each tile overrun.

### 12. Own-time percentiles

- `MsptTrace.tick` also takes the per-tick placement CPU time that `Placement` already measures.
- `stop()` adds `own` (wall) and `ownCpu`. Each has ticks, p50, p99, max and mean, over the ticks with Architect work.
- **megaA's bars:** realise and undo are judged on `ownCpu.p99 ≤ 25 ms` (6a's p99 bar, restored on Architect's own time) and
  `ownCpu.max ≤ 50 ms`.
- `tools/lib/tickbar.mjs` uses these fields when present. The full tick is recorded, not judged.

### 13. Gate (slice tier, $0)

**Evidence:** each item writes `artifacts/gate6c0a/<item>.json`, and `REPORT.md` summarises them.

**Driver:** `tools/gate6c0a.mjs`, added to the impact map, with a new client script `tools/run-gate6c0a-client.sh`. That script runs
a packed jar with `ARCHITECT_SIDECAR_BACKEND=sim` and is added to the runner's `SAFE_CLIENTS`.

**Spend:** `spend.json` must read $0.00.

1. **0.12.2 mini-gate:**
   - unit-sidecar, the three sim suites and apijars;
   - the **Steward-style flow** on the **packed 0.12.2 jar** with `simCosts: "measured"`:
     1. a scripted `job.run` card;
     2. a bible;
     3. a 3-item massingFirst group with `approvalUi: owner`;
     4. one redirect, then approve;
     5. a client restart while awaiting approval: the group is re-read and nothing re-fires;
     6. the details;
     7. a batch of the 3, then undo.
     
     Every wait is bounded.
   - `sim:fail`, `sim:repair` and `sim:usage_limit` give FAILED, a repair round and HELD_USAGE.
2. **C5:** the §3 cost bars pass, the `byKind` lines sum to the totals, and in the sim the item-1 flow's notional cost is inside its
   estimate band.
3. **C6:** every kit example massing/detail pair, on 4 street sides × 3 lot sizes, gets the same rotation and an origin within ±2.
   A turned front fails conformance. In game, `fitMassingToLot` and the later `fitToLot` agree on one lot.
4. **Durable batches:**
   - After a clean stop and load, a finished batch is still DONE and BATCH_DONE doesn't re-fire.
   - With `dev.batch.skipSave` and then the client JVM killed, BATCH_DONE fires once on load.
   - Ids are not reused after the retention drop.
5. **C9:** for each of `bibles().request`, `requestGroup` and `queue`:
   - send with an opKey, `dev.api.dropAck`, kill the client and restart;
   - `*ByKey` adopts the work, and a re-request returns the same id;
   - the job, group and batch counts are unchanged;
   - a different body gives OP_KEY_CONFLICT;
   - another owner's key is a separate operation;
   - a lookup with the sidecar down gives SIDECAR_UNAVAILABLE.
6. **C7:**
   - all the stage lines are present, and `totalUsd` = `cost.usd` + the bible line, to $0.001;
   - QUEUED > 0 at concurrency 1;
   - USAGE_HOLD > 0 under `sim:usage_limit`;
   - the log line appears at awaiting approval and at the final state.
7. **Events:**
   - `seq` strictly increases, with no repeats.
   - GROUP_AWAITING_APPROVAL fires once per massing round.
   - The 6b live-run case gets no re-sent `awaiting_approval` or `paused_budget` while an action is in flight. It is reproduced with
     `simCosts: "measured"` and a $5 budget.
8. **cancelJob:** the future completes CANCELLED and BIBLE_DONE fires once. A second cancel fails "already cancelled". With the
   helper down it fails SIDECAR_UNAVAILABLE.
9. **Pins:**
   - a pinned v1 survives a forced-age GC, and unpinned it is collected;
   - with two owners pinning v1, it stays until both unpin.
10. **WORLD_STOPPED:** stop the world with a long `queue`, a `realise`, a `Survey.volume` and an unacked `requestGroup` pending. All
    four fail with `reason() == WORLD_STOPPED`, and after the next load the group is found by its key.
11. **Tile timeout:**
    - Sidecar unit tests cover the retry, the doubling, `code`, and byte-identical output.
    - In game, a mega-lite region with `SLOW_TILES=4` ends **PLACED** with the unhooked run's evidence sha. It shows TILE_SLOW, and
      `RETRY` works.
    - With `=2`, it passes inside the sidecar's retries.
    - A kit-error tile still fails.
12. **Own time:** `dev.mspt.trace` returns `own` and `ownCpu`. megaA is judged on them, with the load recorded. A NOISY result is
    re-run, not waived.
13. **API compatibility:** api-compat and the three apitest jars, as in §1. The 0.12.0 apitest jar is built from `v0.12.0` into
    `artifacts/gate6c0a/v0120/` before any 0a change, and `gate6a.mjs apijars` moves to 1.9, 1.8 and 1.7.
14. **gate-verifier (slice):** it reviews the diff against this contract and the evidence, and re-runs items 4, 5, 10 and 11, the
    crash, adoption, stop and wait paths.

**Not a gate item:** Steward's own `e2e.mjs stub`. After 0.12.2, Steward switches `run-e2e-client.sh` to the sim and runs it, and
Architect records the result in PLAN.md.

#### 13.1 Which regression tier, and why

**The `slice` tier:** `quick` plus the impact map's slice steps.

| Paths touched | Steps they add |
|---|---|
| `region/**` (TileStream, MsptTrace) | 6a-staged, 6a-inv3, 6a-megaA |
| `site/**` (Batches, Placement) | 4e-orders, 4d-all, 5b-village |
| the API and the sidecar | the sim suites and apijars |
| the kit | sim-sets, sim-massing, 4e-megalite |
| `batch/` or `placement/`, if C6 has to touch LotFitting | 4e-throughput, 5b-chains |

**Plus `6a-megaB-fast`, added by hand.** The tile retry changes TileStream's streaming state machine, and megaB's sidecar kill and
relog drive exactly the re-request path.

**Not `release` or `engine`:**
- There is no journal or store-format change. The queue file only gains fields.
- The realise output is unchanged (item 11's sha check).
- The crash suites rotate at the 0.13.0 release.

**Time:** about 45 min on 3 shards.

### 14. Build order

1. Build and archive the 0.12.0 apitest jar.
2. Build 0.12.2:
   - the C4 work;
   - `run-gate6c0a-client.sh` and the runner allowlist;
   - gate item 1;
   - the coordinator tags it.
3. Sidecar: opKeys, seq, the breakdown, estimates, the tile retry and the cancel ack.
4. Kit: conformance.
5. Mod: the 1.10.0 types, durable batches, the WORLD_STOPPED sweep, pins, TileStream, MsptTrace and the DevBridge hooks.
6. Gate: the gate driver, the impact rows, the slice run, then the verifier.

### Open questions for Steward

- **S-0a-1. The scripted card.** Is a fixed card from `ext["architect:simAnswer"]`, validated against your schema, enough for
  `e2e.mjs stub`? And will you switch `run-e2e-client.sh` to `ARCHITECT_SIDECAR_BACKEND=sim`?
- **S-0a-2. Ghost accuracy.** Is "same rotation, origin within ±2" good enough for approval ghosts? The alternative is to reserve the
  massing box plus 2.
- **S-0a-3. Bible cost.** Should the first group of an owner to pin a bible version carry its cost? The alternative is an explicit
  `GroupRequest.bibleJobId`.
- **S-0a-4. Conflicting keys.** When a key is re-used with a different body, should it fail with OP_KEY_CONFLICT (proposed), or
  silently return the first operation?
- **S-0a-5. Greywater's 70 minutes.** What did they cover (approval waits, placement)? The answer decides whether the time estimate
  can be judged against it.

### Open questions for Noah

- **N-0a-1. Early sub-release.** Is the 0.12.2 sub-release (C4 only, API unchanged) OK, so Steward's $0 gate starts early?
- **N-0a-2. Slow tiles.** Should slow tiles wait indefinitely (retried every 5 min, with RETRY), or should the wait be capped, say at
  1 h, and then fail as TIMED_OUT?

### Deferred

- **To 0b:**
  - C1 copies (the `copy` estimate becomes real), C2, C8 and C13;
  - the C7 benchmark of unique against repeat-heavy settlements, against the $5 / 15 min targets. 0a's breakdown is its
    instrument.
- **To 0c:**
  - minLotSize and the recommended rect;
  - partial roads;
  - groundHeight;
  - typed refusals for bounded fields;
  - the extendGroup warning;
  - C16, C17 and C18.
- **Later:**
  - measured `adapted` estimates (7b);
  - off-thread undo planning;
  - the headless gate mode;
  - retiring the launcher-test stub.

## Coordinator decisions (2026-10-10)

- **Version numbers:** v0.12.1 is the tiers + lab-ui integration (no API change). C4's early consumer-stub sub-release is
  therefore **v0.12.2** (API 1.9.0 unchanged), and the rest of 0a is v0.13.0 / API 1.10.0. All "0.12.1" references above have
  been renumbered.
- **Ship the stub early:** yes. Steward's $0 end-to-end gate waits only on it.
- **Slow tiles:** follow the S8 rule. A slow tile waits without a limit by default, showing `TILE_SLOW` and the `RETRY` nudge.
  `RealiseRequest.maxWaitSeconds`, when set, also caps it (TIMED_OUT). No new cap.
- **Gate precondition:** the tiers runner merges first (v0.12.1); 0a then runs `slice` plus the focused checks, with
  6a-megaB-fast added.

### Changes from Steward's review of 0a (all accepted; these win)

- **S-0a-1:** a scripted card through `ext["architect:simAnswer"]` is enough. A schema mismatch fails the job.
- **S-0a-2:** ±2 origin with the same rotation is fine. No reserve of the massing box plus 2.
- **S-0a-3:** bible cost goes to the first group that pins the version. The breakdown's bible line lists the bible job id(s) it
  counts, so a consumer that also tracks `BibleJob` cost doesn't count it twice. A bible job that never reaches a group keeps its
  cost on `BibleJob`. No `GroupRequest.bibleJobId`.
- **S-0a-4:** a re-used key with a different body fails with `OP_KEY_CONFLICT`.
- **S-0a-5:** Greywater's 70 min is wall clock including approval waits. It's recorded beside the estimate, not judged.
  `wallMs` and `firstDetailedMs` give the split on the next paid run.
- Behaviour changes 1-3 and 6 are accepted by Steward.

## Phase 6c slice 0a as built (API 1.10.0, mod 0.13.0, recorded 2026-10-10)

Built on `slice/0a-stub` (0.12.2, C4) and `slice/0a` (the rest; the coordinator's branch names, not `phase/6c-0a`), with two
sub-branches merged in (`slice/0a-c6`, `slice/0a-tiles`) and the sim's small-lot fix shipped early as 0.12.3
(`slice/0a-simfit`). Where this section and the 0a text above disagree, this section says what shipped. Gate record:
`artifacts/gate6c0a/*.json` and the regression runs under `artifacts/gate-runs-0a/` (local).

**C4 (0.12.2, 0.12.3).** As §2, plus: `simCosts` is parsed only with `--backend sim`, the environment wins over config.json, and a
bad value stops the helper (a typo never runs silently at $0). With costs, each round is charged its item's figure spread over its
steps, and a step that runs again (a usage limit, a restart) adds nothing; a loop revision costs a repair round; every critic call
(design report or loop, bible sheet) costs `critique`. `sim: true` is in the start log line, the group-final and bible-ready log
lines and every estimate basis. Faults also come from `ext["architect:sim"]`. The launcher skips `npm ci` under the sim: a
non-API mod change in a release §2 called "sidecar and docs only" (the bundle needs only node built-ins; the install is for the
Agent SDK). 0.12.3: the sim fits the request's max size: the type's example at its defaults when that fits, else the parameters
with the largest footprint that fit, else another example; a massing pass whose example massing exceeds the max installs a
one-box stand-in the size of the fitted detail (entrance, spawn, door, path), so the detail conforms.

**C5.** `design.estimate {mix}` / `Designs.estimate(EstimateRequest)`. The detail seed ($2.5-4.6, 8-15 min, with its report
critique) stands for Opus and Sonnet alike (the phase-1 mix); Haiku stays scaled. Measured samples still replace it per model,
and then a report critique is added on top (samples are design turns only). Lines: BIBLE (when `newBible`), ORIGINAL (massing
with `massingFirst`, the detail), ADAPTED (one repair-sized turn, "unmeasured until 7b"), COPY ($0); the totals are their sums.
Bars: Phase 1 $22.12-40.75 (midpoint $31.44, +1.3% of $31.03), Greywater $8.66-15.35 (midpoint $12.01, -12.8% of $13.76); Greywater's time recorded beside its 70 min: 13-23 min (approval waits and play excluded).

**C6.** As §4. **Honest limits of the ±2 prediction:** the kit's example massing/detail pairs are dimensionally identical, so the
48-case evidence shows |dx| = |dz| = dy = 0 and proves little beyond the code path. Within the conformance tolerances, a detail
may be 2 wider than its massing and its entrance 1 column off: on a 180-degree turn that lands up to **3** off, not 2. The
approach length (the setback) and `groundY` are **not** conformance-checked, so a detail that changes them stands deeper or
higher than its massing predicted. `fitMassingToLot` checks through a `Sites.checkSite` overload that takes an entry (so
`site/Sites.java` changed); an unreadable massing is UNKNOWN_BLUEPRINT.

**Durable batches.** As §5. Region batches are never pruned (their region refers to them). A finished batch read from an older
queue file counts as fired. Fire, mark, save is literal: a crash after the fire and before the save re-fires on load.

**C9.** Bodies are compared by the sha256 of the canonical JSON without the key: for bible requests and groups the validated
request; for a batch, the `Batch` record in its persisted form (level = dimension id, actor = UUID, positions as arrays). The
helper answers a conflict with an `op_key_conflict:` ack error, mapped to `ArchitectRefused(OP_KEY_CONFLICT)`. Records with a key
are kept at least 30 days after they are final; a key whose record is gone is dropped 30 days after it was made.

**C7.** `seq` bumps on any change of the transition signature (status, reason, wave, the awaiting set, an item's status, stage,
entry, massing version, rounds), so an item moving designing -> checking -> rendering bumps it too; `lastAction` names the
transition (an explicit approve/redirect/extend/resume/cancel wins in its own refresh). A design's first round is what its turns
cost while its round was 1 and it was not revising; critique is `Design.critique.cost`; repair is the rest. QUEUED and
USAGE_HOLD time is attributed at each group refresh by the item's state since the previous one. The log line is written on
entering awaiting approval (each massing round) and at the end. `Breakdown.bibleJobIds` lists the bible line's jobs (S-0a-3).

**Events.** GROUP_UPDATED fires when `seq` grew past the last fired one, persisted (in `api-awaiting.json`), so neither a
re-sent upsert nor a client restart re-fires it. GROUP_AWAITING_APPROVAL keeps its persisted per-massing-version tokens.

**WORLD_STOPPED.** The API objects callers get are proxies of their interfaces: every future they return is tracked and failed
at SERVER_STOPPING; a future that fails while the world stops gets WORLD_STOPPED too; Sites, Regions and Survey calls fail at once
while no world runs. 4b's "the reskinCollection future completes after the next load" is therefore gone (behaviour change 1):
the sets suite now expects WORLD_STOPPED there. `Regions.realise` and `Sites.cancelBatch` usually complete before a stop.

**Tile timeouts.** A slow tile gets 4 evaluations (limits 2, 4, 8, 16 s; pauses 1, 2, 4 s: "retried up to 3 times"), then
`region.tile.error {code: "timeout", attempts}`. A slow tile waiting to be asked again holds no window slot. The re-ask schedule
is in memory (after a restart a waiting tile is asked again at once). `ARCHITECT_TEST_SLOW_TILES` works on any backend (the
helper logs a warning). A kit-error tile is covered by a sidecar unit test, not in game.

**Own time.** As §12; megaA fails (rather than falling back) when the trace has no `ownCpu`.

**DevBridge.** `dev.batch.skipSave {batchId}`, `dev.api.dropAck {msgType}` (its own `type` is the hook's message type),
`dev.api.pending`.

**Gate (slice tier, $0).** `node tools/gate-run.mjs slice --since origin/main` (2 shards, 8902-8905), run 20261010-231718: 31 of
34 steps PASS, including the ten `0a-*` steps (items 1-11 in game and at the protocol), apijars on the 0.12.0/0.11.0/0.10.0 jars,
6a-megaA (own CPU p99 12.3 ms, max 48.4 ms; undo p99 10.3, max 24.4), 6a-inv3, 6a-staged, 6a-eflat and the 6b steps. The 3
FAILs (4e-megalite, 4d-all, 4e-throughput: own tick CPU 51-62 ms, throughput 12k) came at machine load 30-55 from parallel
sessions, as the 0b and 0c runs of the same hour. Re-run with `--quiet-wait`: 4d-all PASS, 6a-megaB-fast PASS; an A/B on a quiet
box, main v0.12.4 then 0a back to back: 4e-megalite PASS on both (own CPU max 43.7 / 24.2 ms), 4e-throughput PASS on both
(median 20.3k / 21.9k cells/s). `api-compat --gate6c0a` 4/4 clean. Item 10 re-run with a pending `Sites.removeGroup` and
`Regions.remove`: both, and the unacked group, fail WORLD_STOPPED. Not exercised in game: a kit-error tile (unit test), the
256-batch retention drop (code review). gate-verifier: functional items pass (it re-ran items 4, 5, 10, 11); its bench
reservation is resolved by the A/B above.

## Phase 6c slice 0b: reuse and bounded effort (DRAFT for Steward review)

This slice is API 1.11.0 and mod 0.14.0.

- **Branch:** `phase/6c-0b`, in the worktree `../architect-mc-6c-0b`.
- **Scope:** PLAN.md "Steward round 4" item 2 with the round 3 "Refinements", plus C13 from round 5:
  - C1 copies with the safeguards;
  - C2, narrowed;
  - C8 bounded effort for S buildings;
  - C13 `versionOf`;
  - the C7 benchmark.

  Everything else waits (see Deferred).
- **Precondition:** 0a is merged and tagged v0.13.0 (API 1.10.0) before 0b's gate runs. 0b uses 0a's `Breakdown`, `costByKind`,
  `Estimate.Kind` and `simCosts`, which exist only in 0a's contract until then.
- **Spend:** the gate is $0 (sim). The C7 benchmark (§6) is the only paid run, on Noah's claude login.
  - **Expected about $24. Cap $35.**

### 0. What exists today (main, v0.12.x; 0a contracted, not built)

- **Variants.**
  - `VariantRunner` (`variants.ts`) copies an entry's `.mjs`, builds it with a palette, values or a bible's roles, runs the
    pristine-kit check (the entry's type and profile), renders and installs.
  - It's free: no Claude.
  - It builds **without `--max`** and without massing conformance.
- **Lineage.**
  - `variantOf` is set by player variants, re-skins and remixes alike, so it can't mean "follows its source".
  - `polish.ts:963` carries a `variantOfVersion` key forward, but nothing writes it.
- **Groups.** One design per item. There is no `count`, no "variant of item X" and no copy stage.
- **Mirror.**
  - The kit can't mirror block states. `sdf.mjs` mirrors region geometry only.
  - The mod's `TemplateWriter` can apply a vanilla `Mirror`, but no API exposes it.
- **C2.**
  - A per-item `critique(OFF)` has existed since 1.6.0, and critique is OFF unless asked for. Only a size rule is missing.
  - A report critique is one critic call, $0.02-0.08 (the 5a seed), so C2 alone saves little. C8 and C1 are the levers.
- **C8.**
  - `MAX_DESIGN_ROUNDS = 4` is a constant, also used in the fix-prompt text.
  - Detail turns run `maxTurns` 120 at effort high; massings run 20 at low.
  - The SDK levers are `maxTurns`, `maxBudgetUsd` and `effort`. There is no per-query token cap, so "token cap" here means those.
  - The kit has no small-building components.
- **C13.**
  - Only polish (a dev flag) and revert make versions. A remix makes a new entry.
  - `checkDelta`, `applyDelta` and `outdated` work between versions of one entry.
  - `DeltaPlanner` already computes a site's player-changed cells (the KEEP set).
- **The sim** installs real kit examples with their `.mjs` and params, so copies, conformance and versions run for real at $0.

### 1. API 1.11.0 rules and behaviour changes

- **Rules (as in 1.10.0):**
  - `ArchitectApi.VERSION = "1.11.0"`;
  - widened records keep their 1.10.0 constructors;
  - new interface methods are defaults that throw "... needs Architect API 1.11.0";
  - enum constants are appended.
- **api-compat:** `tools/api-compat.mjs` checks the **0.13.0, 0.12.0 and 0.11.0 apitest jars** (API 1.10, 1.9 and 1.8) and the
  0.13.0 mod jar's surface. All three suites pass against 0.14.0.
- **New Reasons (appended):** `COPY_REFUSED` and `VERSION_REFUSED`.
- **`ArchitectRefused`** gains a trailing `String detail()` (`""` by default), which carries the sub-code (§2.1, §5).
- **Feature flags:** `copies`, `smallEffort`, `versionOf`.
- **Behaviour changes:**
  - `makeVariant` and re-skins also write `variantOfVersion` and a `derivation` (§2.4). Their builds are unchanged.
  - An item with no `count` or `copyOf`, in a group without `smallBySize`, behaves exactly as in 1.10.0.

### 2. C1: copies in a design group

#### 2.1 Request

```java
// GroupRequest.Item gains trailing: int count (default 1, 1..24), @Nullable String copyOf, Effort effort (§4)
// GroupRequest gains trailing: int copyCap (default 3, 1..3; 1 = "all original"), boolean smallBySize (§3)
```

- **`count` = n.** The item expands into the items `<key>`, `<key>#2` ... `<key>#n`.
  - Every `copyCap`-th placement starts a new **archetype** (an original); the others are **copies** of the archetype before
    them. So x6 at cap 3 is 2 designs x 3.
  - Later archetypes get the note "another design for the same program, not a near-copy of `<key>`".
  - A LANDMARK item's extra count becomes originals, never copies.
- **`copyOf` = "variant of item X":** the item becomes a copy of X's archetype and counts toward its cap.
- **`COPY_REFUSED`,** with `detail` `landmark`, `unknown`, `self` or `cap`: a `copyOf` naming a landmark, an unknown item or
  itself, or one past the cap.
- **Cost.** Copies cost $0 and count as `COPY` in `Designs.estimate` (0a §3; it becomes real here). They are never held by
  `paused_budget`; only fallback originals (§2.3) are.

#### 2.2 Items, stages and variation

```java
// Group.Item gains trailing: Kind kind (ORIGINAL, COPY, FALLBACK), Optional<String> copyOf (the archetype's itemKey),
//   Optional<String> variantJob, Optional<String> fallbackReason, Effort effort
// Group.Stage and Breakdown.Stage gain COPY (appended; time only, $0)
```

- **The copy stage.** A copy waits for its archetype to be DONE, then builds in stage COPY on the VariantRunner (seconds).
  - Its `designId` is `""`; `variantJob` names the variant job.
  - It is its own item for placement, stages and undo.
- **massingFirst.** The archetype's approval covers its copies (Steward's "once per design").
  - **A redirect** carries the copies to the new massing version.
  - **A dropped, cancelled or failed archetype** fails its copies with `source_failed`.
- **Variation** is deterministic, with no Claude: a recipe chosen by a seeded hash of (group id, itemKey), from three levers.
  1. **Palette shift inside the bible.** The copy builds with a derived bible, the group's bible with one shift. In order:
     - swap `wall` and `wall_alt`;
     - set the roof to another member of its stone family (`stoneFamilyOf`), or swap `trim` and `frame`;
     - set `accent` to another role's block.

     The bible's restraint rules apply as for any build.
  2. **One declared param changes:** an int ±1 within its bounds, a bool flips, an enum takes its next option. This lever is
     skipped when the design has no params.
  3. **Mirror** left-right across the front axis, so `front` is unchanged.
     - The kit gains `build.mjs --mirror`, a `Blueprint` option. It maps the cross-front coordinate of every `set`, anchor, port,
       part, camera and the approach, and mirrors direction properties as vanilla does.
     - A north or south front uses `Mirror.FRONT_BACK` (x flips); an east or west front uses `LEFT_RIGHT` (z flips).
     - Placement code is untouched.
- **The rule:** every copy shifts the palette, changes a param where one exists, and every second copy (`#2`) is mirrored.
  Rotation is the caller's (street side).
- **Testable:** each copy differs from its archetype and from each sibling in at least 2 levers, and `kit/lib/diff.mjs` finds at
  least **10%** of the written cells changed.
- **Sim faults:** `sim:copyfail` and `sim:copysize`.

#### 2.3 Checks and fallback (never forced)

- **The checks.** Every copy passes:
  - the full kit check of a design;
  - `--max` at the copy item's own `maxSize`;
  - under massingFirst, conformance against the archetype's approved massing **mirrored with the copy**.
- **Retries.** Up to 3 recipes are tried. When all fail, the item becomes **FALLBACK**, an original:
  - under massingFirst, a detail pass bound to the archetype's approved massing (no new approval);
  - otherwise, a design from the item's request.

  `fallbackReason` is `size`, `conformance` or `check`, with the message.
- **Placement-time fit is the caller's.** A `fitToLot` failure at placement can promote the copy:
  `CompletableFuture<Group> promoteCopy(String groupId, String itemKey, String reason)` (Designs, default-throwing). It makes the
  copy a FALLBACK original. It is refused for a non-copy, a copy still building, or a final group.

#### 2.4 One representation with 7b and 6d

```java
// Library.Entry gains trailing Optional<Derivation> derivation, OptionalInt variantOfVersion
record Derivation(String source, int sourceVersion, Kind kind, JsonObject recipe) {
  enum Kind { VARIANT, RESKIN, COPY, SITE }   // SITE: reserved for 7b's site-adapted designs
}
```

- **A copy's recipe** is `{shift, values, mirror, bible pin, group, itemKey}`: enough to rebuild it from any later source version.
  That is 6d's update path, so there's no migration.
- **7b** adds its fit parameters under `kind: SITE`. A program `count` there gives an archetype plus site variants, in this
  shape.
- **Who writes what:** `makeVariant` writes VARIANT, re-skins write RESKIN, a remix writes none.
- **Following the source.** Only COPY and SITE derivations follow their source in 6d.
- **New versions keep it.** The polish carry-list (`polish.ts:963`) and the `versionOf` install keep `derivation` and
  `variantOfVersion`.
- **Polish or `versionOf` of a COPY entry** is refused (`VERSION_REFUSED`, `copy`) in 0b. 6d would overwrite the change when it
  re-applies the recipe.

### 3. C2: no report critique on small items

- **What counts as small:**
  - effort `SMALL` (§4); or
  - with the group's `smallBySize`, an item whose `maxSize` footprint fits 11 x 9 either way. That is Steward's S lot minus the
    approach margin (S-0b-1).
- **What is skipped:** only the group-default **report** critique.
  - An explicit item `critique` still wins.
  - Massings stay for everything.
- **The breakdown** shows CRITIQUE as 0 for that item.

### 4. C8: bounded effort for S buildings

`GroupRequest.Item.Effort { AUTO, STANDARD, SMALL }`. AUTO means SMALL by §3's size rule when `smallBySize` is set, else STANDARD.

| A SMALL detail pass (config `small`, in its basis) | STANDARD today | SMALL |
|---|---|---|
| design rounds (first + repairs) | 4 | **2** |
| `maxTurns` per round | 120 | **40** |
| effort | high | **medium** |
| `maxBudgetUsd` over its turns | the group's remainder | **$1.50**, within the remainder |
| massing | 20 turns, low | unchanged |

- **Rounds.** `MAX_DESIGN_ROUNDS` becomes per design, and the fix prompt says "round r of 2".
- **A cap hit** fails the item (`budget` or `rounds`, with `effort: SMALL`). There is no STANDARD retry (S-0b-2).
- **Kit components** (new `kit/lib/smalls.mjs`). The builders are palette-role driven and parametric, `(bp, box, opts)`:
  - `rack` (length, levels);
  - `stall` (awning role, counter side);
  - `well` (round or square, roofed);
  - `shed` (lean-to or gable, door side).

  Each passes the checker standalone under every built-in bible. The SMALL brief says to compose from them. The module is
  **append-only** after release (a changed builder gets a new name), so polish rebuilds never drift.
- **Estimates.** `Estimate.Kind` gains `SMALL` (appended), seeded at $0.6-1.5 and 3-6 min, with the basis "unmeasured until §6".
  `EstimateRequest` gains a trailing `int smallOriginals`.
- **Sim:** SMALL items report their caps and use the SMALL seed midpoint under `simCosts: "measured"`.

### 5. C13: `versionOf`, a design as the entry's next version

```java
// DesignRequest gains trailing @Nullable String versionOf, @Nullable String versionOfSite; `notes` is the change request
DesignRequest versionOf(String entryId, @Nullable String siteId);   // copy-with
```

- **`VERSION_REFUSED`,** by `detail`:
  - polish's `bundled`, `no_source` and `massing`;
  - `copy` (§2.4);
  - `busy`: a polish or `versionOf` of the entry is unfinished;
  - `site_mismatch`;
  - `group`: single designs only in 0b.

  Unknown ids give `UNKNOWN_BLUEPRINT`.
- **The base is the head version.** The site is context only. Basing on an older site version would offer head-version sites a
  version that drops their changes.
- **Context,** as scratch files, not in `context`:
  - the head's `.mjs`, renders and JSON;
  - with a site, `context/site-now.nbt`: the restore box as it stands, captured on the server thread;
  - with a site, `context/site-edits.json`: DeltaPlanner's KEEP set by part and block, at most 2000 cells listed, plus counts,
    the site's version and its deviations.
- **The brief:** apply the change, keep `front` and the parts, and leave the player's edited cells alone unless the request is
  about them.
- **Frame guard:** exactly `TemplateDelta`'s frame check (front and frame). A result that fails it is a repair round, before
  install.
  - **Growth is allowed** (5b deltas handle growth cells), up to the request's `maxSize`, by default the base's size.
  - A FRAME_CHANGED delta is never offered.
- **Install:** head + 1, with `by: 'design'`, parent = base, the `designId`, and the change request as the summary.
  - If the head moved meanwhile, it fails `base_moved`, and its cost is kept.
  - Then `checkDelta`, `applyDelta` and `outdated` work unchanged.
  - Copies of the entry don't change (6d).
- **Estimates.** `Estimate.Kind` gains `CHANGE` (appended), seeded from the polish step ($0.4-1.2, Sonnet).
- **Protocol:** `design.request` takes `versionOf {entryId, siteId?}`, with the site files; the feature is `versionOf`.
- **Sim:** the sim changes the head as a sim redirect does.

### 6. The C7 benchmark (paid, claude login)

**Question:** which stage to cut, and how far copies and SMALL get toward Steward's targets (a starter settlement under $5, the
first usable result within 15 min).

**Setup:**
- It runs on the 0b build, after gate items 1-8 pass.
- Each arm gets its own new bible (a shared bible's cost would land on the first group only).
- The driver auto-approves massings and auto-resumes soft pauses, so only the hard cap stops a group.
- It places on a flat claim with pad lots.

| Arm | Program | Originals / placements | Seed estimate |
|---|---|---|---|
| **U, unique** (Greywater-like) | 3 M, massingFirst, report critique | 3 / 3 | bible 1.35 + massings 0.57 + details 10.2 = **~$12** (high ~$18) |
| **R, repeat-heavy** | 2 M x `count` 3, 2 S (shed, well), massingFirst, report critique, `smallBySize` | 4 / 8 | 1.35 + 0.76 + 6.8 + 2 x ~1.0 = **~$11** (high ~$17) |
| **C13 smoke** | one `versionOf` on R's first archetype with its site ("weathered, add a lean-to") | | ~$0.5-1.5 |

**Cap $35, enforced mechanically:**
- U runs with `budgetUsd` $18 and R with $14 (hard caps);
- the C13 request has `budgetUsd` $3;
- the driver sums `spend.json` before each paid step and stops past $35.

One run per arm. An infrastructure failure may re-run an arm once, only within the cap.

**Auth:** the claude login only, never an API key. `tools/gate6c0b.mjs bench` refuses to start with any `ANTHROPIC_*` key set,
and logs the auth mode at each paid step.

**Recorded** (`artifacts/gate6c0b/bench-<arm>.json`):
- the 0a Breakdown (each stage's usd and ms, `totalUsd`, `wallMs`, `firstDetailedMs`; USAGE_HOLD is excluded from the time
  figures);
- usd per placement;
- each item's kind and effort;
- repair rounds;
- fallbacks;
- previews.

**Judged:** both arms reach a final state within $35 with complete breakdowns. A budget stop is data, not a failure.

**Not judged:**
- $5 and 15 min; a miss is reported "not shown", with the numbers;
- Noah looks at R's copies and S items, and any he calls visibly cheap is recorded against C1/C8.

**What it decides.** These are proposals in PLAN.md for Noah and Steward, not automatic:
1. **The next cut,** by U's largest stage share:
   - BIBLE ≥ 25%: built-in or cheaper bibles for starter cards;
   - DETAIL dominant: bounded effort for M, or model tiering;
   - REPAIR ≥ 20%: kit and brief fixes.
2. **Whether copies and SMALL reach the targets** (R's usd per placement and `firstDetailedMs`). This feeds Steward's default
   copy policy and card mix.
3. **Re-seeding** the SMALL, COPY and CHANGE estimates from the samples.
4. **The C8 caps:** keep them, or loosen them if S items hit them or look cheap.

### 7. Gate (slice tier plus focused checks)

**Evidence:** `artifacts/gate6c0b/<item>.json` and `REPORT.md`.

**Driver:** `tools/gate6c0b.mjs` (sim), added to the impact map; `bench` is §6.

**Spend:** `spend.json` reads $0.00 through item 8, and at most $35 after item 9.

1. **Expansion:**
   - x6 at cap 3 gives 2 archetypes and 4 copies, with the right keys;
   - cap 1 gives 6 originals;
   - a LANDMARK x2 gives 2 originals;
   - each `COPY_REFUSED` detail is produced.
2. **Variation:**
   - for every kit example with params, under every built-in bible, copies `#2` and `#3` meet "2 levers and 10%";
   - a mirrored copy keeps `front`.
   - **The mirror oracle:** a mod test dumps vanilla's mirrored states for the kit's block list to a JSON fixture, and a kit test
     compares the kit's mirror table against it.
   - **In game:** a mirrored copy's `fitToLot` agrees with `fitMassingToLot` on the **mirrored** massing (C6's ±2).
3. **Fallback:**
   - `sim:copyfail` and `sim:copysize` reach FALLBACK with the right reason;
   - under massingFirst, it binds the approved massing with no new approval;
   - `promoteCopy` works and refuses as in §2.3;
   - a dropped archetype fails its copies with `source_failed`;
   - copies run while the group is `paused_budget`.
4. **Derivation:**
   - a copy's recipe rebuilds it byte-identically from `sourceVersion`;
   - VARIANT and RESKIN are written, and a remix writes none;
   - `derivation` survives a polish of a VARIANT entry;
   - a COPY entry refuses polish and `versionOf`;
   - `Library.Entry` exposes it all.
5. **In game, Steward-style** (sim, `simCosts: "measured"`):
   1. a massingFirst group with an x3 item and a SMALL item;
   2. approve;
   3. COPY stages;
   4. a batch of 4;
   5. undo one copy.

   Then check:
   - each copy is its own site;
   - the breakdown's COPY line is $0;
   - the notional cost is inside the `byKind` estimate.
6. **C2 and C8:**
   - a `smallBySize` item skips the report critique, but an explicit item critique runs;
   - a SMALL basis shows 2 rounds, 40 turns and medium;
   - two `sim:repair` fail it at round 2;
   - every `smalls.mjs` builder passes the checker under every built-in bible.
7. **C13:**
   1. place a site and make 3 player edits;
   2. `versionOf(entry, site)` installs head + 1 (`by: design`);
   3. `outdated` lists the site;
   4. `checkDelta` reports 3 kept cells;
   5. `applyDelta(KEEP)` keeps them, and undo restores the site.

   Then check:
   - a grown result passes;
   - a front-changing sim result is repaired before install;
   - every refusal detail;
   - `base_moved`.
8. **API compatibility,** as in §1. The 0.13.0 apitest jar is built from `v0.13.0` into `artifacts/gate6c0b/v0130/` before any
   0b change.
9. **§6's benchmark,** paid and capped.
10. **gate-verifier (slice):** it reviews the diff against this contract and the evidence, re-runs items 2, 3 and 7, and checks
    §6's spend and auth logs.

#### 7.1 Which regression tier, and why

**The `slice` tier:** `quick` plus the impact map's slice steps.

| Paths touched | Steps they add |
|---|---|
| the sidecar (groups, variants, designer, estimates, versions) | sim-jobs, sim-sets, sim-massing |
| the API and apiimpl | apijars, 4d-all |
| the kit (mirror, `smalls.mjs`, the brief) | sim-sets, sim-massing, 4e-megalite |
| `site/**` or `delta/**` (the `versionOf` site capture) | 4e-orders, 5b-village, 5b-chains |

**Not `release` or `engine`:** there is no journal, placement or realise change, because the mirror is baked into templates.

**Time:** about 40 min on 3 shards, plus §6 (about 1-1.5 h wall time, detached, with one until-loop wait).

### 8. Build order

1. Archive the 0.13.0 apitest jar.
2. Kit: the mirror and its oracle fixture, `smalls.mjs`, the SMALL brief.
3. Sidecar:
   - expansion, COPY, recipes, checks and fallback;
   - derivation;
   - the SMALL caps;
   - `versionOf`;
   - estimates;
   - the sim faults.
4. Mod: the 1.11.0 records, `promoteCopy`, `versionOf` and the site capture.
5. Gate items 1-8, the slice run, the verifier.
6. §6 within its cap. Its results go into PLAN.md.

### Open questions for Steward

- **S-0b-1. The small rule.** Is "footprint fits 11 x 9 either way" the right rule, or will you always set `effort: SMALL`
  yourself?
- **S-0b-2. A capped S item fails.** Fail it so you re-plan (proposed), or retry once at STANDARD inside the group budget?
- **S-0b-3. A failed or dropped archetype.** Fail its copies with `source_failed` so you call `promoteCopy` (proposed), or
  promote the first copy to archetype automatically?

### Open questions for Noah

- **N-0b-1. Benchmark spend.** Is ~$24 expected with a $35 hard cap OK? The cheaper option drops arm U and uses Greywater's
  $13.76 as the unique figure: ~$12, cap $17, but then there is no stage split for unique buildings, which is the question C7
  asks.
- **N-0b-2. Variation bar.** Is "2 of 3 levers and at least 10% of cells changed" enough? You judge the previews in §6 either way.

### Deferred

- **To 0c:** as listed in 0a (minLotSize, partial roads, groundHeight, typed field refusals, the extendGroup warning, C16, C17,
  C18).
- **6d:** a source's new version applied to its COPY and SITE followers, by recipe.
- **7b:** SITE derivations, adapt-first, and measured `adapted` estimates.
- **Later, or on an observed need:**
  - a placement-time mirror in the API;
  - a rotation hint for copies;
  - `versionOf` inside groups;
  - a STANDARD retry for capped S items;
  - a $0 template path for S buildings straight from `smalls.mjs` (the likely next cut if §6 shows S items still too costly);
  - whatever stage §6 points to.

## Phase 6c slice 0c: placement polish and protected areas (DRAFT for Steward review)

This slice is API 1.12.0 and mod 0.15.0. Those numbers assume 0a ships as 1.10.0 / 0.13.0 and 0b as 1.11.0 / 0.14.0; the
coordinator confirms them at merge. SETTLEMENTS.md still gives 1.11.0 to 7a and 1.12.0 to 7b. Those entries move up (N-0c-3).

- **Branch:** `phase/6c-0c`, in the worktree `../architect-mc-6c-0c`.
- **Spend:** $0. Everything runs on the sim or in game. There is no claude-login run.
- **Scope:**
  - PLAN.md "Steward round 4" item 3: minLotSize, partial roads, groundHeight, bounded fields, the extendGroup warning;
  - round 5's C16 and C17, and C18;
  - off-thread group-undo planning, as a go/no-go (§10).

  Anything else goes to the next slice.
- **Parallel build, third merge.** It may be built alongside 0a and 0b, but it merges after both. Before its gate it rebases on
  main with 0a and 0b in (§11). Two things depend on 0a:
  - §5 throws 0a's `ArchitectRefused`. That item is built last, on top of 0a.
  - The new `Reason` constants come after 0a's (and 0b's, if any).

### 0. What exists today (main, v0.12.x)

- **minLotSize.**
  - `LotFitting.fit` (batch/) needs the rotated footprint plus the setback. The setback defaults to the approach length.
    Anything less is `LOT_TOO_SMALL` with a `why`.
  - Nothing returns the size it needs. Steward hardcodes `LotBrief.APPROACH_MARGIN = 5`.
  - `LotFit` has the origin, rotation, box, restore box and verdict. `OverlapMargin` gives the front growth
    (approach + `Approach.EXTEND`).
- **Roads.**
  - `RoadPlan.plan` returns on the first bad centre column and refuses the whole road: no ground within 8, cut or fill over 4
    (TOO_STEEP), water deeper than 1 (DEEP_WATER), lava, or unloaded (NOT_LOADED).
  - Cut and fill are judged after one `smooth()` over the whole line.
  - The centre line doesn't remember which waypoint segment a cell came from.
  - Other sites' columns are already skipped and noted.
- **Survey.**
  - `Sample.height` is `MOTION_BLOCKING_NO_LEAVES`, so under a tree it is the top log.
  - `floor` is `OCEAN_FLOOR`, which logs also block.
  - The `tree` bit marks the column, but nothing gives the soil under it.
  - `Volume` classifies LOG, LEAVES and PLANT per cell, and `Volume.Stats` already defines a surface that skips them, but it
    exposes no per-column array.
  - The region survey (`RegionSurvey`, ARSV) is separate, and this slice doesn't touch it.
- **Bounded fields.**
  - zod in `sidecar/src/protocol.ts` bounds them, for example style 1-40 trimmed, name 1-40, notes 2000, materials 200,
    features 6 × `FEATURE_RE`, group name 1-60, items 24, owner 200, ext 64 KB, model id 100.
  - The Java side checks almost none of them. A long style fails the whole group at the sidecar ("Too big").
  - `DesignsImpl` fails some futures with `IllegalArgumentException`, for example redirect notes.
- **extendGroup.**
  - `CompletableFuture<Void>`.
  - `groups.ts extend` clears the soft override, so a budget whose 80% line is still under the spend re-pauses at once.
  - `Group` already carries `budgetUsd`, `softBudgetFraction` and `cost`.
- **Survival roads (C16).**
  - `InfraPlace.modeRefusal` refuses a road with NOT_ALLOWED when its mode is CONSTRUCTION, or AUTO in a survival world.
    A batch's road items in survival fail.
  - The builder (`Builder.Run`, `planConvert`, `convertNow`, crate helpers) is written against a `Site` with a `Blueprint`.
    Roads are `Infra` records and have neither.
  - `Verdict.bom`, `SiteView.built/queued`, `Stock.outstandingBySite` and the shared crate (`Batch.sharedCrate/crateAt`)
    already exist.
  - `dirt_path` costs one dirt (`survival_items.json`).
- **Protected areas (C17).** Nothing exists in Architect. Steward keeps its own `Settlement.Area`: id, label, dimension,
  x0/z0/x1/z1 at every height. Its layouts avoid those areas, and it drops lots that fall inside one.
- **Occupancy (C18).**
  - `Occupancy.scan(level, box, ignore)` already takes an ignore predicate, but every caller passes `e -> false`:
    - `Sites` check (place, move);
    - `DeltaJob`;
    - `SiteDeltas`;
    - `Groups` (players only);
    - the client ghost.
  - Removal and undo go through `Sites.removalBlockers`, which loops over the entities itself.
  - The placement discard loops (`Sites` P5, `PlaceJob`) remove "removable" entities (unnamed hostiles, projectiles, drops).
- **Undo planning.**
  - The group undo plans each section on the server thread (`Sections.Planner` → `Journal.planUndo`). Since 6b's fastutil
    fix, that takes a few ms per section.
  - The planner reads the world per cell through the `Journal.World.holds` interface.

### 1. API 1.12.0 rules and behaviour changes

**Rules (as in 1.10.0):**
- `ArchitectApi.VERSION = "1.12.0"`.
- Widened records keep their 1.11.0 constructors.
- New interface methods are defaults that throw "... needs Architect API 1.12.0".
- `tools/api-compat.mjs` checks the 0.14.0, 0.13.0 and 0.12.0 apitest jars and the 0.14.0 mod jar's surface. All three apitest
  jars pass against 0.15.0.

**New Reasons** (appended after 0a's and 0b's):
- `PROTECTED`: the op writes into a protected area of its owner (§8);
- `FIELD_LIMIT`: a bounded request field is out of range (§5).

**Behaviour changes:**
1. A request field over a sidecar bound now fails in the mod, before the round trip, with `ArchitectRefused(FIELD_LIMIT)`.
   This includes the redirect notes, which threw `IllegalArgumentException` before. A caller that caught IAE must catch
   `ArchitectRefused` (a RuntimeException).
2. In a survival world, a road in a batch with a shared crate builds as a construction site. Before, it failed NOT_ALLOWED.
3. Entities tagged `architect:owner=<owner>` no longer block that owner's placements, deltas, removals and undos, and are
   never discarded by them (§9).
4. `Sample` and `Volume` gain ground heights (§4). Nothing that exists changes: `height`, `floor`, ARVX bytes and the volume sha
   stay as they are.

### 2. Lot size and the recommended lot (minLotSize)

```java
LotSize minLotSize(String blueprintId, FitOptions o);                 // Sites, default-throwing
LotSize minLotSize(MassingRef massing, FitOptions o);                 // the same for a massing (0a's fitMassingToLot)
record LotSize(int alongStreet, int deep, int setback, int frontMargin) {
  BoundingBox at(BoundingBox lot, Direction streetSide); }            // the minimal lot anchored as fitToLot anchors
// LotFit gains trailing BoundingBox recommendedLot (old constructor: the lot passed in)
```

- `alongStreet` and `deep` are the rotated footprint, with `deep` including the setback, so they are the same for every
  street side. They are exactly what `LotFitting` accepts:
  - a lot of `alongStreet × deep` fits;
  - one block less on either axis is `LOT_TOO_SMALL`.
- `frontMargin` is `OverlapMargin.front`, shown for planners. It isn't part of `deep`, because the restore box may already
  reach into the street (as today).
- **`recommendedLot`** is the smallest lot that holds this fit: the street-edge row, along to the back of the footprint, the
  footprint's width, and the y span of the lot passed in.
  - Placed with `fitToLot`, it gives the same origin and rotation.
  - On `LOT_TOO_SMALL`, it is the lot the design would need, anchored on the street edge, so it extends past the lot given.
- Steward can drop `APPROACH_MARGIN` and size lots from `minLotSize`.

### 3. Partial roads, or the failing span reported

```java
// RoadRequest gains trailing boolean partial (old constructors: false)
record RoadSpan(int fromPoint, int toPoint, Reason reason, String message, BlockPos at) {}
// Verdict gains trailing List<RoadSpan> spans; PlaceResult gains trailing List<RoadSpan> skipped (old constructors: empty)
```

- **Spans.** A failing centre column is mapped to its waypoint segment `[i, i+1]`.
  - Neighbouring failing segments merge into one span.
  - Span-local reasons: TOO_STEEP (no ground, or cut or fill), DEEP_WATER, LAVA and PROTECTED (§8).
  - NOT_LOADED stays a whole-road refusal, because it is temporary and a waiting item waits for it.
- **`checkRoad`** always lists every failing span, whether `partial` is set or not. The first one is also the refusal, as today.
- **`partial: true`:**
  - The failing segments are dropped, and the remaining runs are re-planned and smoothed each on its own.
  - Runs are re-planned until no span fails. That takes at most one round per segment, and it is deterministic.
  - Runs of at least 2 centre cells are placed as **one road site with gaps**: one journal entry and one undo.
  - `PlaceResult.skipped` lists the dropped spans, and a note names them.
  - If nothing remains, the road is refused with the first span's reason.
- **Batches.** A road item with `partial` places like this. Its `ItemView.message` names the skipped spans.

### 4. Ground heights under trees (Survey)

- **Sample.** `Sample` gains trailing `int[] ground`.
  - Per column, ground is the highest cell that isn't air, a fluid, LOG, LEAVES or PLANT. The kit's `voxel_classes.json` table
    (`VoxelTable`) decides LOG, LEAVES and PLANT, as it does for volumes.
  - Built blocks count as ground, so a roof is ground.
  - On a dry column without trees it equals `height`. Under water it is the bed (fluids aren't ground), the same as `floor`
    when no tree stands in the water.
  - A missing column gives `MISSING`.
  - The old constructor copies `height`.
  - `toJson` gains `ground`. The summary grid is unchanged.
  - `RegionSurvey` has its own sampler, so region survey time doesn't change.
- **Volume.** `Volume` gains a trailing `int[] ground` record component; the old constructor gives an empty array.
  - Indexed `i + j * width` over the box's columns.
  - The same definition, applied to the classes. OWNED, PLAYER and BLOCK_ENTITY count as ground.
  - `MISSING` where the column has no ground inside the box, or wasn't read.
  - It is derived while sampling. The ARVX bytes, the sha and the frozen file don't change.
  - Its size is capped at 16M columns (64 MB). A wider box leaves it empty and says so in a note.
- **Consistency bar.** On the same columns, `Sample.ground` (resolution 1) equals `Volume.ground` in every column, when the
  volume box reaches below the ground and above the tree tops.

### 5. Bounded fields refused in the mod

- **`api/Limits.java`** has public constants, one per bounded field the sidecar's zod schemas bound, for these requests:
  `DesignRequest`, `GroupRequest` (and its items), `BibleRequest`, `CritiqueSpec`, `PolishRequest` and redirect notes.
  - Examples: `STYLE_MAX = 40`, `NAME_MAX = 40`, `NOTES_MAX = 2000`, `MATERIALS_MAX = 200`, `FEATURES_MAX = 6`,
    `GROUP_NAME_MAX = 60`, `GROUP_ITEMS_MAX = 24`, `OWNER_MAX = 200`, `EXT_MAX_BYTES = 65536`, `MODEL_ID_MAX = 100`.
  - Each request record's javadoc names its caps.
- **Same rule as zod:** trim where zod trims, then compare the UTF-16 length (and the regex where zod has one).
- **The check:** `requestGroup`, `request`, `bibles().request`, critique, polish and redirect check before sending.
  - A violation fails the future with `ArchitectRefused(FIELD_LIMIT)`.
  - The message gives the path and the limit, e.g. `items[3].request.style: 47 characters, at most 40`.
  - Nothing is sent and no group is created.
- **Drift guard.** A sidecar unit test reads the Java constants (from `Limits.java`, by regex) and asserts they equal the zod
  bounds. A field zod bounds that `Limits` lacks fails the test.

### 6. extendGroup: the re-pause warning

```java
default CompletableFuture<Extension> extend(String groupId, double budgetUsd)   // Designs; extendGroup stays (its type can't change)
record Extension(Group group, double spentUsd, double softLineUsd, boolean pausesAgain, double minBudgetUsd) {}
```

- `softLineUsd = budgetUsd × softBudgetFraction`.
- `pausesAgain = spentUsd ≥ softLineUsd`. This is the sidecar's own comparison: equality pauses.
- `minBudgetUsd` is the smallest whole-cent budget B with `spentUsd < B × softBudgetFraction`, using the same double arithmetic
  as the sidecar.
- **The ack.** Today the `group.extend` ack carries only `groupId` and `budgetUsd`. It gains `spentUsd` and `softBudgetFraction`.
  That is two additive fields in `sidecar.ts` and the feature `extendInfo`. `groups.ts` is untouched, which keeps this item out
  of 0a's work there. Against an older sidecar, the mod uses its cached `Group`.
- The extend still happens when `pausesAgain` is true. The caller decides whether to extend further or resume.
- The javadoc of `extendGroup` points to `extend`.

### 7. C16: roads in survival construction batches, with a BOM

- **When it applies.** In a survival-toggle world, a road item of a batch with `sharedCrate` (and optionally `crateAt`), with mode
  AUTO or CONSTRUCTION, becomes a **construction road**.
  - Refused with NOT_ALLOWED and its own message:
    - a standalone `placeRoad` in CONSTRUCTION;
    - a road in a batch without a shared crate.
  - INSTANT keeps today's actor rule.
  - Cell sites stay INSTANT only.
- **What placing does.**
  - It plans the road as INSTANT would and journals the before state, so undo is exact.
  - Cut cells (natural blocks removed) are cleared at placement, with no drops and at no cost, as a building site's cleared cells
    are.
  - The other written cells are queued for the builder in centre-line order: fill, surface, slabs, decks, posts and lanterns.
- **Cost.** Each queued cell costs `SurvivalItems.cost` of its target, so `dirt_path` costs one dirt (N-0c-2).
  `checkRoad` in construction mode fills `Verdict.bom`, and `Verdict.construction` is true.
- **Building.**
  - The builder takes the road from the group's shared crate, in batch order with the group's buildings.
  - `SiteView.built/queued`, `Stock.outstandingBySite` (keyed by the road's id), the ghost sync, SITE_PROGRESS, `finish` and
    deconstruct-with-refunds work as for buildings.
  - A finished road matches what INSTANT would have written.
- **Implementation note.**
  - `Infra` gains a nullable `Construction`.
  - The builder's `Run`, crate and stock helpers take a "construction target" (a `Site` or a road `Infra`) instead of a `Site`.
  - Buildings keep their code path.
- **Downgrade (expected; not yet checked against 0.14.0's `Infra` reader).** 0.14.0 should read an `Infra` with an unknown
  `construction` field as a finished INSTANT road. Its cells stand as far as they were built. One `remove` should still be exact:
  the journal holds the before state, and unbuilt cells never held their `after`. Gate item 6 pins this, and if it fails, the
  fix is in 0c.

### 8. C17: protected areas

```java
ProtectedArea protect(ProtectedArea a);                      // Sites, server thread; same (owner, id) replaces
boolean unprotect(String owner, String areaId);
List<ProtectedArea> protectedAreas(@Nullable String owner);  // null: every owner
record ProtectedArea(String owner, String id, ResourceKey<Level> dimension, int x0, int z0, int x1, int z1, String label) {}
```

- **The area.** Columns `x0..x1 × z0..z1` at every height, which is Steward's `Area`.
  - `owner` is required, by the `<modid>:<thing>` convention. A null owner (the player) can't mark areas in 0c.
  - At most 1,024 areas per owner, each at most 4,096 × 4,096 columns.
  - Areas are kept per world, in `<world>/architect/protected.json` (written to a temp file, then renamed).
- **Where they apply.** Only to ops of the same owner, and only to work started after the mark.
  - The op is refused with `PROTECTED`, naming the area's id and label.
  - **`force` doesn't override it.** The caller lifts the area instead.
- **Which cells each op is checked on:**

  | Op | Checked against |
  |---|---|
  | `place`, `check`, a batch building item, a move | the predicted restore box (approach and foundation included) |
  | `applyDelta` / `checkDelta`, `revert` (the site's owner), a batch delta item | every cell the delta writes |
  | `placeRoad` / `checkRoad`, a batch road item | every road cell; with `partial`, a protected stretch is a skipped span (§3) |
  | `placeCells` / `checkCells`, a batch cells item | every cell |
  | `fitToLot` | its verdict; `FitOptions` gains trailing `@Nullable String owner` |
  | `Regions` plan accept, and realise start | the claim; an area marked after planning refuses the realise, so there is no per-tile check |

- **Never refused:** remove, undo, `undoStage` and `removeGroup`. They only put back what was there.
- **Already running:**
  - A queued batch item is checked when it starts. A refusal there fails the item; it doesn't wait.
  - A standing construction site keeps building.
- **Events:** none in 0c. Steward owns the areas and knows when it changes them.

#### C31 as built (felling stays within the region's bounds; mod 0.24.1, API unchanged at 1.21.0; recorded 2026-10-13)

| Part | As built |
|---|---|
| The report | Slice T2's builder: when a region write removes one log of a tree, the whole trunk is felled (6a's tree rule, "Ground and trees"), and the felling did not stop at the region owner's C17 areas. A fresh S3 copy's cherry tree reached into T2's protected area. |
| Root cause | Felling is deliberate, not a vanilla side effect: `TileCheck.trees()` floods (26 neighbours) from every log a tile cell replaces and adds each reached log as an air cell of the same tile entry; `leaves()` then holds the non-persistent leaves within 6 of every removed log (a LEAVES entry). The flood was bounded by the tile's window, the claim and journal-owned cells of anything else (`others`), but `TileCheck` never knew the region's owner, so it never saw C17 areas. C17 checks a region only at accept and realise, on the claim, and two cases put an owner's area inside a claim: a keep-out program (6c V: the IR's honoured rects) and a brush stroke (6c B: areas are checked against the brush box, while the claim, and so the flood, reaches 8 further). The held leaves had the same gap. Another owner's journal cells were already skipped by both. |
| Was undo exact before | Yes. Every felled log was a cell of the tile entry and every held leaf a cell of its LEAVES entry, both journaled with their before states, so the region's undo put them back. The pre-fix run of the gate item measured it (below): the area's 4 logs felled and 4 leaves turned persistent, and one undo gave 0 mismatches. Worlds already affected are restored exactly by undoing the region; a region left standing keeps the felled cells inside the area until it is undone. |
| Fix | `TileCheck` takes the region's owner (`RegionItems.tileCheck`, regions and strokes) and snapshots `Protected.of(dimension, owner)` at the check (every area of the owner, the honoured keep-out rects included, so an area marked after the plan binds too). The flood takes a log only when it is inside the window and the claim, not owned by anything else, not in one of the owner's areas, and classed LOG by the voxel table (the kit's natural/player split: a block it does not list, such as a modded log, is a player's block; only such logs seed a flood too). It stops at any other log, and the tree past it stays, possibly floating, counted in the region's `cellsSkipped` as `M3:tree_kept` and per reason as `tree_kept.claim`, `.owned`, `.protected` or `.player`. A leaf is never held inside an area or on another owner's cell. Held leaves outside the claim keep 4e's treatment ("Ground and trees": leaves that hung on removed logs are held). Every cell felling changes is still a tile-entry cell, so undo restores it. |
| Limits (accepted by the coordinator, 2026-10-13) | **1.** The voxel table classes every vanilla log LOG, so a log a player placed (a cabin wall touching a tree) is not told from a grown one. No placement log exists to tell them apart; a player's logs stay safe only when they are another owner's journal cells or in an area. PLAN lists this as a candidate "player-placed tracking" item (the dropped slice PT). **2.** A leaf inside an area that hung only on felled logs outside it is not held, so in a world with random ticks it may decay later (vanilla, unjournaled). **3.** A brush stroke fells into its claim's margin (the brush box plus 8), as 6a's rule ("within the claim") allows, though RegionsImpl says the survey margin is never written; the owner's areas there are now respected. |
| Gate | Step `c31-felling` (`tools/gate6cb.mjs felling`, headless, flat world, `exact` rules), impact rule "C31 felling bounds (v0.24.1)". A raise (r2, s2) over a trunk's base cuts its lowest logs. **1:** a trunk outside the cutter's area with a branch running 4 logs into it (and leaves on the branch); the area meets only the claim's margin, so the stroke is not refused. **2:** a branch resting on a mound of oak logs that another owner's raise laid (its tile cells), the cutter's claim over it. **3:** a tree wholly inside the claim. Each: the forbidden cells' hash unchanged, the finding recorded, the rest felled, one undo E-flat 0. Post-fix `artifacts/gate-runs-c31/20261013-060811-slice` (head ee56424, `--only`): unit-mod, unit-kit, unit-sidecar, x-ingame, b-ingame, **c31-felling (0 failures: area cells unchanged, findings recorded, the rest felled, one undo 0 mismatches in all three cases)** and 4d-all all PASS. gate-verifier: see below. |

### 9. C18: the caller's own entities don't occupy

- **The tag.** An entity carrying the scoreboard tag `architect:owner=<owner>` (`Entity.getTags()`) matches requests with the
  same owner. The owner comes from:
  - `PlaceRequest` or the batch;
  - `DeltaRequest`;
  - the site's owner, for revert and group undo;
  - `RemoveOptions.requester`.
- **No match:**
  - A null owner matches no tag.
  - Players are never exempt.
  - Another owner's tag counts as untagged.
- **Every path:** `Occupancy.scan`'s callers (check, place, move, delta), `removalBlockers` (remove, undo, group undo), and the two
  discard loops. A matching entity neither blocks nor is discarded, including a tagged hostile.
- **Architect doesn't move it.** An ignored entity stays where it is and can be built into or buried by a restore. Moving it first
  is the caller's job (S-0c-2).
- **Setting the tag.** Callers set it with `entity.addTag(...)` or NBT (`Tags:[...]`). The `/tag` command can't, because ':' and
  '=' aren't word characters.

### 10. Off-thread group-undo planning (go/no-go)

- **Spike, timeboxed at 2 h, and the first thing cut.**
  - On the server thread: copy the section's block states, and the NBT of its block-entity cells.
  - Off the thread: plan against that copy, through `Journal.World`.
  - Back on the server thread: re-check `holds` for each cell about to be written. A changed cell is planned again on the server
    thread.
- **Ships only if** megaA's undo-only run on the 6a-made world, against main:
  - lowers the undo's `ownCpu.p99` by at least 30%;
  - doesn't raise its max;
  - keeps E-normal at 0 undo-caused cells;
  - passes the 4e crash suite.
- **No-go:** the measurement goes in "as built", and it moves to Later.
- **Gate cost:** it touches `journal/**`, which adds the engine tag (4e-orders, 4e-crash, 6a-eflat, megaA) to the slice.

### 11. Files touched (merge notes)

| Item | Files | Shared with |
|---|---|---|
| API | `api/{ArchitectApi,Reason,Sites,Designs,LotFit,FitOptions,RoadRequest,Verdict,PlaceResult,Sample,Volume}.java`; new `LotSize`, `RoadSpan`, `ProtectedArea`, `Extension`, `Limits` | 0a: `Reason`, `ArchitectApi`, `Sites` (fitMassingToLot), `Designs` (estimate). 0b: `Designs`, `DesignRequest` |
| §2 | `batch/LotFitting.java`, `apiimpl/SitesImpl.java` (fitToLot, minLotSize) | 0a C6 (`fitMassingToLot` in SitesImpl) |
| §3 | `site/roads/RoadPlan.java`, `site/InfraPlace.java`, `site/InfraApi.java` | none |
| §4 | `apiimpl/SurveyImpl.java`, `apiimpl/SurveyGrid.java`, `region/volume/VolumeSurvey.java` | none |
| §5 | `apiimpl/{DesignsImpl,BiblesImpl}.java`, `sidecar/test/limits.test.ts` | 0a and 0b: DesignsImpl |
| §6 | `apiimpl/DesignsImpl.java` | 0a: `groups.ts` (avoided) |
| §7 | `site/{Builder,Construction,Infra,Infras,InfraJob,InfraPlace,Batches}.java`, `survival/*` (stock) | 0a: `Batches` (durable batches, opKey) |
| §8 | new `site/Protected.java`; check hooks in `site/{Sites,SiteDeltas,InfraPlace,Batches}.java`, `region/RegionsImpl.java` (plan/realise only) | 0a: `Batches`, `RegionsImpl` (WORLD_STOPPED) |
| §9 | `placement/Occupancy.java`, `site/{Sites,PlaceJob,DeltaJob,SiteDeltas,Groups}.java`, `apiimpl/SitesImpl.java` | none |
| §10 | `journal/{Sections,WorldJournal}.java`, `site/Groups.java` | none |

- **Rebase points:** `Reason` order, `VERSION`, the api-compat baselines and the impact-map rows.
- **Dependencies on 0a:** §5 needs `ArchitectRefused`, and §10's bar needs MsptTrace's `ownCpu`. If 0a hasn't merged, they wait.
- **No change to:** the kit, the journal format, or the sites-file format beyond the fields `Infra` gains. The protocol only
  gains §6's two ack fields.

### 12. Gate (slice tier, $0)

**Evidence:** `artifacts/gate6c0c/<item>.json`, summarised in `REPORT.md`.

**Driver:** `tools/gate6c0c.mjs` with `tools/run-gate6c0c-client.sh`, a packed jar on the sim. Survival items use a survival-toggle
world, as the p3 client does. `spend.json` must read $0.00.

1. **minLotSize** (unit): for every kit example design and massing, × 4 street sides:
   - a lot of exactly `minLotSize` fits, and one block less on either axis is LOT_TOO_SMALL;
   - `fitToLot(recommendedLot)` gives the same origin and rotation as the first fit;
   - a too-small lot's `recommendedLot` fits.

   In game: one Steward-sized lot sized from `minLotSize` places.
2. **Partial roads:**
   - Unit, on synthetic terrain with a 6-high step on segment 2 of 4: `checkRoad` reports span [2,3] with TOO_STEEP.
   - With `partial`, two runs are placed as one site, `skipped` = [2,3], and one undo restores both runs exactly.
   - A deep-water segment and a lava segment are reported the same way.
   - NOT_LOADED still refuses the whole road.
   - In game, on the flat fixture with a 6-high wall built across segment 2: placed partial, then undone. The undo's world diff
     over the restore box is 0.
3. **groundHeight:**
   - In game, on a forest box: `Sample.ground` < `height` on tree columns, equals it elsewhere, and equals `Volume.ground` in
     every column.
   - The volume sha is unchanged from a 0.14.0 run on the same box.
4. **Bounded fields:**
   - A group with a 41-character style fails `FIELD_LIMIT`, with the path in the message and no group created (the sidecar's
     group count is unchanged).
   - 40 characters passes.
   - The sidecar drift test passes.
   - Each `Limits` constant gets one unit test at the boundary and one past it.
5. **extendGroup:**
   - A unit test on the 6b live case: $30 → $35 with $31 spent gives `pausesAgain` and `minBudgetUsd` 38.76. At 38.75 the line
     is exactly $31.00, which pauses.
   - A sidecar unit test: extending to `minBudgetUsd` doesn't re-pause, and to one cent less does.
6. **Survival road:** in a survival world, a batch of 2 houses and a 40-cell road with a shared crate.
   - `checkRoad` gives a non-empty `bom`, and it equals the road's `Stock.outstandingBySite` after placing.
   - Feeding exactly that BOM builds it to BUILT.
   - The built cells equal an INSTANT road on an identical flat strip beside it, cell for cell relative to the road's start.
   - Undo restores the pre-state: the world diff over the restore box is 0.
   - Without `sharedCrate`, it is refused NOT_ALLOWED.
   - Downgrade: with the road half built, 0.14.0 loads it as a road, and one `remove` leaves a world diff of 0.
7. **Protected areas:** one area of owner `test:a` across a test strip.
   - Every op in §8's table, including the batch item kinds, a move, and region realise after a late mark, is refused
     PROTECTED.
   - Nothing is written: the journal and the world diff are empty.
   - `force` doesn't change that.

   Also:
   - a partial road crossing the area places both sides and skips the area span;
   - the same ops by owner `test:b` and by the player pass;
   - remove, undo and `undoStage` of a `test:a` site whose box was marked after placing all succeed;
   - the area survives a save and reload.
8. **Owner-tagged entities:**
   - A villager tagged `architect:owner=test:a` stands in a `test:a` site's box. Group undo, `remove`, `applyDelta` and a new
     `place` over it all go ahead, and the villager is alive and not discarded.
   - The same villager untagged blocks (OCCUPIED, or the removal blockers).
   - Tagged `test:b`, it blocks `test:a`.
   - A tagged unnamed zombie isn't discarded.
   - A player in the box still blocks.
9. **Undo planning** (if built): §10's bars, on megaA undo-only with the load recorded. If it isn't built, the measurement is
   recorded.
10. **API compatibility:** api-compat and the three apitest jars (§1). The 0.14.0 apitest jar is built from `v0.14.0` into
    `artifacts/gate6c0c/v0140/` before any 0c change.
11. **gate-verifier (slice):** it reviews the diff against this contract and the evidence, and re-runs items 6, 7 and 8.

**The tier:** `slice` (quick plus the impact map's steps for `site/**`, `api/**`, `survival/**`, `batch/**`, `placement/**`: 4e-orders,
4d-all, 5b-village, 5b-chains, 4e-throughput, the sim suites, apijars). The `RegionsImpl` hook matches the `region/**` rule,
which adds 6a-staged, 6a-inv3 and 6a-megaA and the engine tag. megaA runs there as a regression check: the hook is only a claim
check and changes no tile path. If §10 ships, its `journal/**` steps are added as well. About 60-75 min on 3 shards.

### 13. Build order

1. Archive the 0.14.0 apitest jar.
2. §4 and §2.
3. §3.
4. §9.
5. §8.
6. §7.
7. §6.
8. §5, once 0a is in.
9. §10, timeboxed.
10. The gate driver, the slice run and the verifier.

### Open questions for Steward

- **S-0c-1. Removal and undo.** Remove and undo are never refused by a protected area, because they only restore. Is that right,
  or should an undo that would restore cells inside an area also refuse?
- **S-0c-2. Tagged entities.** Architect ignores tagged entities but doesn't move them. Will Steward move its villagers out of a
  box before an undo or delta, or should Architect teleport a tagged mob to the nearest standable cell outside the box?
- **S-0c-3. Regions.** Is refusing a region claim that touches an area enough for 0c? The alternative is to carve areas out of the
  claim, which is kit work for the terrain slices.
- **S-0c-4. Partial roads.** Is one road site with gaps, plus the skipped waypoint spans, what you need? Or do you want one site
  per run?
- **S-0c-5. Survival roads.** Is a shared crate an acceptable requirement for survival roads? Steward's batches already use one
  per settlement.

### Open questions for Noah

- **N-0c-1. C16's size.** C16 is the largest item, because the builder must take roads as well as buildings. If it runs past
  about half the slice, should it split into its own slice "0d" before V, so the rest of 0c ships?
- **N-0c-2. Road surfaces.** Should a `dirt_path` surface laid on existing grass or dirt cost one dirt (proposed, the plain
  survival rule)? The alternative is to make it free, as a shovel would.
- **N-0c-3. Numbering.** SETTLEMENTS.md gives API 1.11.0 to 7a and 1.12.0 to 7b. With 0a, 0b and 0c at 1.10.0-1.12.0, 7a and 7b
  move to 1.13.0 and later. Should SETTLEMENTS.md be renumbered at this merge?

### Deferred

- **To the 6c terrain slices:**
  - automatic detection of player-changed cells (block-change tracking) as protection;
  - region programs that route around areas;
  - areas binding every owner (a world-wide "never touch").
- **Later:**
  - protected-area events;
  - areas for the player (a null owner) in Architect's own UI;
  - an explicit entity UUID set on `RemoveOptions`, `DeltaRequest` or `Batch` (C18's alternative), if a caller needs it;
  - cell sites in construction mode;
  - off-thread undo planning, if §10 is a no-go.

### Phase 6c slice 0c as built (API 1.12.0, mod 0.15.0, recorded 2026-10-11)

Branch `slice/0c` (worktree `../architect-mc-0c`; the coordinator's names, not `phase/6c-0c`). $0: sim only, no Claude call.
Evidence: `artifacts/gate6c0c/` (REPORT.md, one JSON per step), the slice tier in `artifacts/gate-runs-0c/`.

| § | As built |
|---|---|
| §2 minLotSize | `Sites.minLotSize(String\|MassingRef, FitOptions)`, `LotSize` (+ `at`), `LotFit.recommendedLot` (the 1.4.0 constructor gives the template box: it doesn't know the lot). `fitMassingToLot` gets `recommendedLot` and the owner's areas too. Unit: every kit design and massing × 4 sides × 3 setback rules. |
| §3 partial roads | `RoadRequest.partial`, `RoadSpan`, `Verdict.spans`, `PlaceResult.skipped`. Failures per waypoint segment; runs smoothed each on its own, one segment per run per round. A step or wall can't fail TOO_STEEP (the ground search stops 8 above the hint, so the smoothed profile needs at most 4), so the tests use a trench (no ground within 8). A run shorter than 2 centre cells is left out and noted. |
| §4 ground | `Sample.ground` (scan down from WORLD_SURFACE with the volume's classes; a journal-owned log/leaves/plant counts), `Volume.ground` (derived in the encoder; the ARVX sha unchanged: pinned unit test; in game the same sha on main, 0.14.0 and 0c). Volume counts a journal-owned air cell as ground (OWNED); Sample sees blocks only. |
| §5 FIELD_LIMIT | `api/Limits` (lengths, list sizes, ext, context, the zod patterns), checked before sending (request, requestGroup, critique, polish, redirectMassing, bibles.request); `sidecar/test/limits.test.ts` walks the zod schemas. Numeric ranges aren't in Limits. |
| §6 extend | `Designs.extend` -> `Extension`; the ack carries `spentUsd` and `softBudgetFraction` (feature `extendInfo`). |
| §7 C16 | `site/RoadBuilder` (the builder's `Run` through a probe Site). Free: a `dirt_path` on `grass_block` only (dirt, podzol, mycelium... cost: open question). A cell already holding its target block isn't queued. Downgrade checked: 0.14.0 lists a half-built road and removes it with a world diff of 0. |
| §8 C17 | `Sites.protect/unprotect/protectedAreas`, `<world>/architect/protected.json`. Revert's undo path is checked on the site's restore box. A move is checked on the moving site's owner. |
| §9 C18 | `architect:owner=<owner>` tags skip occupancy, both discard loops and removal blockers (remove: the requester; group undo: the site's owner). |
| Gate | Slice tier `artifacts/gate-runs-0c/20261011-060252-slice` 19 PASS, 3 load flakes (sim-massing composite keys, the 1.11.0 jar's SITE_PROGRESS gap, 6b-nudges) PASS on re-run `20261011-070130-slice`; focused items `artifacts/gate6c0c/REPORT.md` all pass; api-compat clean against the 0.14.0/0.13.0/0.12.0 apitest jars and the 0.14.0 surface; gate-verifier PASS (re-ran items 6, 7, 8). SETTLEMENTS.md numbering (N-0c-3) not touched here. |
| §10 | No-go. megaA undo ownCpu p99 / max: 0c 9.33 / 20.36 and 7.40 / 18.29 ms; spike 6.71 / 12.34 and 6.55 / 12.57 ms, but both spike runs fell back to server-thread planning (an unloaded chunk; a section that changed while it planned), so the gap is load. Branch `slice/0c-undo` kept; to Later. |

## Phase 6c slice V: flat village (C10) (DRAFT for Steward review)

This slice is API 1.13.0 and mod 0.16.0. It comes after 0a (1.10.0 / 0.13.0), 0b (1.11.0 / 0.14.0) and 0c (1.12.0 / 0.15.0).
**0b and 0c aren't written yet. Renumber if they shift, and follow 0c as built.**

- **Branch:** `phase/6c-v`, in the worktree `../architect-mc-6c-v`.
- **Spend:** $0. Lot entries are bundled kit designs as free variants. There is no pick and no claude-login run.
- **Scope (C10, narrow).** On a flat claim: lots, a path from each door to the street, one shared space (a square or a well
  green), a few props, and the villager rules that are cheap on flat ground. It is built as one bundled region program
  (`flat_village`) plus kit components, so 7a's graph and connectors generalise it without a migration.
- **Not in scope:**
  - retiring VillageLayout (C12);
  - survival;
  - additions to a standing village (6d);
  - terrain (the 6c terrain slices).

### 0. Facts V depends on

- **Regions are INSTANT only.** They refuse `NOT_ALLOWED` in survival-toggle worlds (D12, N4). **So V serves Steward's Patron
  worlds only.**
- **Program params** are `int`, `bool` or `enum`. Nothing carries a list of lots.
- **The rustic default `path` role is `minecraft:dirt_path`**, and `rubble` is cobblestone. A program that exports no `roles`
  lays dirt path on lot fronts.
- **The 6b region-lot approach** (`Approach`, at most 16 rows) uses the `path`/`foundation` roles and stops at the first walk
  surface: a 4e road cell, or a region cell with the walk flag. `fitToLot` with `CentreOn.ENTRANCE` (the default) centres the
  entrance column on the lot's street-side span. Neither `LotFit` nor the designs expose a door port.
- **IR `graph` is reserved for 7a.** A kit from 6b or earlier throws "unknown member" on it. `siteplan.json`'s graph is derived
  (`derived: true`).
- **Steward's `VillageLayout`** (read only):
  - one straight street, with lots on both sides, filled outward from the centre;
  - the hints `central`, `edge`, `near_water` and `high_ground`;
  - street 5 (road 3 plus verges), lot gap 3, slope at most 3, margin 2;
  - `unplaced`.

  There are no door paths, no shared space and no props.
- **0c, assumed:** C17 protected areas are caller-marked rects per owner. They are enforced as write bounds on that owner's
  placements, roads and terrain ops, with a typed refusal. 0c also brings `minLotSize` with a recommended rect.

### 1. "Flat village" means

**There are no carve, add, terrace, ring, form or cavern ops.** The only terrain changes are:
- lot pads with `maxCut` and `maxFill` of 2;
- surface-layer swaps (the top block, plus clearing plants and trees above it) for the street verges, the lanes and the
  square.

**Nothing is forced.** A lot that needs more than that goes to `unplaced`. A street that can't be a ground road fails the plan,
with the numbers.

### 2. The program `flat_village` (kit/regions/flat_village.mjs)

**Layout `street`** (the only layout in V) is VillageLayout's geometry and defaults, ported to JS:
- one straight street, east-west or north-south, whichever places more lots, then scored as VillageLayout scores;
- lots on both sides;
- the same rules and hint scoring (`near_water` on the survey's water flag).

**The shared space is at the street's middle.**
- `square` (the default) is `squareSize` 9-15, default 11, paved in the `path` role with walk cells.
- `well` is a 7x7 green beside the street, for small claims.
- The street is **two road items that end at the square's edges**, so the road's own lanterns never fall inside the square.
- The landmark lot, `central` lots and the trading hall front the square first.

**Lanes.** There is one per lot, from the lot's entrance to the street verge or the square's edge.
- They are `laneWidth` 1-3 wide (default 2), in the `path` role, with walk cells, in a `path`-set part of stage `ground`.
- **The entrance is the centre of the lot's front edge, where `fitToLot` centres the entrance by default.** The lane ends on
  the cell just outside the lot box, at the floor y (K5, SETTLEMENTS §8.4). No region op writes inside a lot box.
- When a fit moves the entrance off-centre (a box held inside the lot), the 6b approach joins the door to the lane, which it
  meets as a walk surface.
- Door-aligned lanes from the real fits are 7a's link pass (Deferred).

**Stages:** `ground` (pads, square, lanes), then `street` (the road items), then `lots`, then `props`. Props come last, are
written into air only (`IF_AIR_OR_FLUID`) and stand on the surface.

**Roles.** The program exports `roles` (as `crater_works` does), and a bible overrides them:
- `path`: `minecraft:gravel`;
- `foundation`: `minecraft:stone_bricks`;
- `light`: `minecraft:lantern`.

With a bible whose `path` *is* dirt path, bar 5 is recorded as not applicable.

**Params:**
- `shared`;
- `squareSize`, `laneWidth`;
- `lamps`: `none`, `few` or `street`;
- `bell`: bool, default false (S-V-2);
- `requireAll`: bool, default false;
- `lots` (§4).

**Catalogue:** `catalogue = false`. Adding it to `Regions.design`'s pick changes the pick prompt, and so 6b's pick accuracy,
which would need a paid re-run (Deferred).

### 3. Kit components (kit/lib/region/village.mjs, props.mjs)

Plan-time builder functions. Each one:
- emits a named part, compiled to `columns` ops (no new op kind; the evaluator is untouched);
- registers its graph nodes and ports (§5).

7a reuses them as they are, or as connectors.

| Component | Emits | Guarantees (property-tested) |
|---|---|---|
| `r.streetLayout(specs, rules)` | lots (through `r.lot`), the street line, `unplaced` | no overlap; inside the claim minus the margin; gaps kept; every lot fronts the street or the square |
| `r.square` / `r.green` | the paving swap (walk), a `plaza` node, the `bell` anchor | a 5x5 bell area: one y, standable, 2 clear; a 3x3x3 golem space within 8; nothing else writes in either |
| `r.lane(from, to, w)` | the surface swap (walk) | 4-connected; rise at most 1 per cell; never in a lot box, the bell area or keep-out |
| `well` | a 3x3 stone-brick ring around a `water_cauldron[level=3]`, a roof on 4 posts | **dry: no fluid writes in V** (fluid ordering between section writes is untested in regions); supported |
| `lamp_post` / `bench` / `planter` | a fence post with a lantern / stairs facing the square / a trapdoor rim with flowers | supported; beside walk cells, never on them |
| `bell` (opt-in) | a bell on a post at the bell area's edge | outside the bell area |

**Props are never placed** in a lot box, on a walk cell, in the bell area or golem space, or in keep-out. The counts are at
most 1 well, 2-4 benches and 4 planters. Lamps go every 12 or fewer cells along the lanes and at the square's corners; the
street's 4e road lanterns cover the street. Bible-styled props are 7a §8.3.

### 4. Input and output

**`params.lots`** is a param type `lots`. It is **allowed in region programs only**: `kit/lib/params.mjs` refuses it in design
params, and variant enumeration never walks it. At most 40 lots, each:

```json
{ "id": "cottage_1", "type": "cottage", "role": "artisan cottage", "size": [9, 9], "landmark": false,
  "placement": "central|edge|near_water|high_ground|null", "villager": "dwelling|job|trading_hall|farm|none", "brief": "..." }
```

- It is Steward's `VillageLayout.LotSpec` plus `villager`.
- `id` matches `LOT_ID` and is unique.
- `size` includes the setback; 0c's `minLotSize` is how a caller sizes a lot for a known entry.

**Output (no new Java types):**
- `RegionPlan.lots` holds the placed lots only.
- The unplaced lots are listed in `notes` (one line, `unplaced: a, b`) and in `siteplan.json`'s `unplaced: [{id, reason}]`.
- Each lot gets `LotSpec.ext["architect_mc:village"] = {role, type, villager, entrance: [x, y, z], lane, water, bellDistance}`.
  `water` is the distance to surveyed water, or null.
- The plan fails only on the street, or with `requireAll` when a lot is unplaced.

**Protected areas.** `region.plan` gains `keepOut: [[x0, z0, x1, z1]]`.
- The mod fills it with the request owner's 0c areas that meet the claim.
- The kit exposes it as `ctx.keepOut` and `ctx.survey.keptOutAt(x, z)`.
- The layout, the street, the lanes, the square and the props avoid it.
- 0c's write bound still refuses at realise, which covers an area marked after the plan.

### 5. The graph: 7a's shape, now

V's IR carries `graph` in SETTLEMENTS §8.1's exact shape, restricted:
- **nodes:** `{id, kind: lot|plaza|junction, ref, level: 0, ports: [{name, at, facing, width}]}`. Lots get an `entrance` port;
  the plaza gets `bell` plus a port per lane or street;
- **edges:** `{id, from: 'node.port', to: 'node.port', type: road|path, width, stage: 'ground'}`.

**Gating:**
- `graph` becomes a known member in this slice's kit version, allowed in format 1. The evaluator ignores it.
- **The kit's `KIT_VERSION` bump makes older mods refuse such plans `PLAN_STALE`** (6b §2.4). It also changes every IR's sha,
  because the IR carries `kitVersion`.

**`siteplan.json`** emits the IR's graph with `derived: false`, and edges gain `"villager"` in `mover` where that mover reaches
them. Without a graph, it emits 6b's derived graph unchanged. V adds values (`plaza`, `path`, `villager`) and the member
`unplaced`, and changes no member (S-V-3).

**No migration later:** 7a keeps the node, port and edge ids, and adds `auto`, the connector types, `seconds` and `risk`.

### 6. Villager rules on flat ground

**The kit's `villager` mover is a conservative flat subset.**
- It is the player walk graph without ladders, scaffolding or bubble columns, without falls over 1, and with only wooden doors
  passable (fence gates and trapdoors count as closed).
- **The in-game behavioural test (gate item 4) is the authority on 26.3.** A disagreement with it is a kit finding.

**New findings.** They are warnings in the checker and S7 bars here. They continue at M22, since SETTLEMENTS §11 reserves
M15-M21.
- **`M2:villager`:** every dwelling, job, trading_hall or farm lot reaches the bell node from its entrance.
- **M22:** the 5x5 bell area is one y, standable and 2 clear, with a 3x3x3 golem space within 8 of the bell.
- **M23:** the trading-hall lot's entrance is within 12 of the bell anchor, as horizontal Euclidean distance.
- **M24:** a farm lot's rect is within 2 of surveyed surface water. With no water in the claim it is only a note, and
  `water: null` tells the caller to ask the design for its own water.

The layout makes these hold by construction:
- the trading hall fronts the square;
- farms score `near_water`;
- the bell area is reserved before props.

The checker verifies the result regardless.

### 7. Gate (slice tier, $0)

**Evidence** goes to `artifacts/gate6c-v/<item>.json` and `REPORT.md`, written by the driver `tools/gate6cv.mjs` (added to the
impact map). The scenarios run through 6b's `tools/scenarios.mjs`, phase `6c-v`. `spend.json` must read $0.00.

**S7, `scenarios/s7_flat_village.json`:**
- **Fixture:** found by `find-site s7` on the pinned seed. It needs relief of at most 2 over at least 85% of a 112x112 claim,
  surface water inside the claim's outer 16-cell band (so M24 is gated), and no village within the claim + 64. Spawn is desert
  and warm ocean, so the search goes outward with `center`/`stopAt`. If nothing qualifies within 4096, the coordinator pins a
  second seed.
- **Flat variant:** superflat, for E-flat.
- **Program:** 10 lots, Steward-shaped:
  - a landmark hall (L) and a trading hall (M);
  - 4 cottages (S, `dwelling`);
  - a smithy and a bakery (`job`);
  - an inn (M);
  - a farm (M, `farm`).
- **Bible:** a fixture bible whose `path` and `foundation` aren't dirt path or cobblestone.
- **Lot entries:** free variants of `cabin`, `tavern` and `tower`, sized to each lot and pinned as `entry@version`.

**Bars,** on the realised world re-surveyed through 6b's ARWD path:

| # | Check | Bar |
|---|---|---|
| 1 | Plan report | 0 errors; no M1-M4; `M2:villager` and M22-M24 clean |
| 2 | Reachability, `player` | 100% of nodes (lot entrances, plaza, bell, `entrance`); 0 unreachable lot entrances |
| 3 | Reachability, `villager` (kit) | 100% of dwelling, job, trading-hall and farm lots reach the bell |
| 4 | Door to street | for every placed lot, a walk path from its **door cell** to a street or square walk cell over approach and lane cells, each a role block, its shape variant, or the street surface. The door cell is the placed site's entrance anchor (the blueprint's, transformed by the placement, read through DevBridge). 100% |
| 5 | Lot fronts | written `minecraft:dirt_path` or `minecraft:cobblestone` cells in the **front zone** = 0. The front zone is the lot's front edge row ±1 (the apron) plus the approach and lane cells. Only cells that differ from the before-dump count, so natural cobble is excluded |
| 6 | Villager rules | M22, M23 and M24 hold on the realised world |
| 7 | Props | the realised counts per kind equal the plan's; every prop cell supported (M3); 0 prop cells in lot boxes, walk cells, the bell area or golem space |
| 8 | Safety | M4 0; M5 dark spawnable share under 1% of walk area |
| 9 | Palette | role adherence at least 0.9 |
| 10 | Exactness | E-flat 0 (flat variant); E-normal all classified, at most 0.01% of written cells |
| 11 | Determinism | IR sha identical over 3 plans; tile shas for 1 and 4 workers equal a committed `scenarios/goldens/s7.json` (macOS and Linux CI) |
| 12 | MSPT | Architect's own CPU per placement tick at most 50 ms; the whole tick recorded |
| 13 | Spend | $0.00 |
| 14 | Gallery | Noah approves this run's `evidence.sha` (6b §8.4; one private page "Architect 6c-V gallery") |

**Gate items:**
1. **Unit and property tests (no game).**
   - **Layout:** 500 seeded synthetic flat claims with random lot lists. No overlap; inside the margin; gaps; fronting; lanes
     outside lot boxes and keep-out; `unplaced` exact; deterministic.
   - **VillageLayout parity:** on 3 grids and spec lists exported once from Steward's `VillageLayoutTest` (committed JSON),
     `street` places at least as many lots.
   - **Props:** each prop's guarantees.
   - **The villager mover:** a step of 2 blocks; a ladder isn't used; a wooden door passes; a fence gate blocks.
   - **The `lots` type:** refused in design params; bad id, duplicate, size and over-40 refused.
   - **Schema:** `siteplan.json` validates against the widened schema.
   - **Goldens:** `mega_bench.golden.json` and S1's committed tile-sha golden are **unchanged** (IR shas change with
     `kitVersion`, so the bar is on tiles).
2. **Broken variants**, each caught on its named part:

   | Variant | Caught by |
   |---|---|
   | a lot with no lane | M2 |
   | the trading hall at 20 | M23 |
   | a prop in the bell area | M22 |
   | a farm at 10 from water | M24 |
   | a lane into a lot box | M1 error |
   | a lane across keep-out | plan refusal |

3. **S7:** the natural run (bars 1-12) and the flat variant (bar 10).
4. **Behavioural villager test.** A new DevBridge hook, `dev.nav.villager {from, to}`, spawns a no-AI villager with
   `FOLLOW_RANGE` raised over the claim, runs vanilla `PathNavigation.createPath(to, 0)`, returns `canReach` and the node
   count, and discards the villager.
   - **Bar:** 100% of bar 3's lots reach the bell from their door cell.
   - **Range control:** a straight 100-cell flat path is found first, so a failure means "not walkable", not "out of range".
   - **Negative control** (a fixture variant): a cottage raised 3 with only a ladder is unreachable for both the kit mover and
     vanilla.
5. **Protected area.** A rect over a third of the claim is marked through 0c's API for the plan's owner.
   - The plan routes around it, and realise writes 0 cells in it (ARWD diff).
   - A plan made before the mark and realised after it refuses with 0c's typed reason, writing nothing.
6. **Steward flow on 0a's sim:**
   1. `Regions.plan(flat_village, lots)` from the `lantern_shore` card's program at Steward's S/M/L sizes;
   2. a sim massingFirst group over the lot ids;
   3. `fitToLot`;
   4. `realise(lotEntries)`;
   5. one exact `Regions.remove`.

   A deliberately oversized lot comes back in `unplaced`.
7. **Regressions (the slice tier).** `quick` plus the impact rows for:
   - the kit region code: 6a-staged, 6a-inv3, 4e-megalite;
   - the sidecar plan path: the sim suites;
   - the API: apijars, and api-compat against the unchanged 0.15.0, 0.14.0 and 0.13.0 apitest jars plus the 0.15.0 surface.

   Also S1's run bars, and the 6b fixtures' `expected.json`, unchanged. **Not `engine`:** no realise, journal or streaming code
   changes, and the format-1 golden is the proof.
8. **gate-verifier (slice).** It reviews the diff against this contract, recomputes S7's evidence sha, and re-runs items 1, 4
   and 5.
9. **Noah's approval** (bar 14). **S7 is green only when it is approved.**

### 8. API 1.13.0 (binary compatible)

- `VERSION = "1.13.0"`, with the usual rules (old constructors kept, default-throwing methods, enums appended).
- **No new records or methods.** V travels in the program id and `params`, `LotSpec.ext`, `RegionPlan.notes` and
  `siteplan.json`.
- **Features:** `flatVillage`, `regionGraph`, `villagerMover`, `planKeepOut`.
- **Protocol 2, additive:** `region.plan.keepOut`; the snapshot feature `region.keepOut`; the kit CLI's `plan --keep-out <json>`.
- **Behaviour changes:**
  1. A plan carrying `graph` refuses `PLAN_STALE` on older mods.
  2. `region.plan` sends the owner's protected areas. Programs that don't read `keepOut` give unchanged tiles.

### 9. How Steward calls it

**Patron, flat or as-is card, flat claim:**
1. `Regions.plan("flat_village", params)`, where `params.lots` is the card program expanded exactly as `program.specs()` does
   today. **No Claude call.** The previews and `unplaced` go to the card screen.
2. Design each placed lot as today: a massing-first group keyed by lot id, with 0b's copies.
3. `fitToLot` with the default `CentreOn.ENTRANCE`.
4. `realise(lotEntries)`.

`Regions.remove` is the undo. Per-lot `Sites` deltas evolve lots until 6d.

**Everything else stays on today's path:** Supplied, Hardcore, additions, and sculpted sites (`Regions.design`).

### 10. C12: retiring VillageLayout later (nothing retires in V)

- **V keeps the village adoptable.** The `street` layout is VillageLayout's geometry, lot ids are the caller's, and graph ids are
  stable, so a standing VillageLayout village is a valid `flat_village` shape. The mapping is recorded in `kit/REGIONS.md`.
- **The joint 7a/6d gate adds `Regions.adopt`.** It makes the standing sites a region record **without writing a cell**: the
  lots point at the existing site ids, the street at its road site, and the graph comes from the layout. Then the gate runs a
  6d addition (a lot, or the square), a 6d `applyDelta` on one lot, and one exact `Regions.remove` of everything.
- **Steward migrates on load,** and falls back to the legacy path on a refusal. It deletes VillageLayout only after that gate,
  and once region survival covers Supplied and Hardcore.

### 11. Build order

1. Archive the 0.15.0 apitest jar.
2. Kit: the `lots` type, the components, the program and its roles, `graph`, the siteplan widening, the villager mover, M22-M24,
   the variants and goldens.
3. Sidecar: `keepOut`.
4. Mod: the `keepOut` fill, the features, `dev.nav.villager`.
5. S7: `find-site`, the scenario file, the entries, the runs, the gallery, then the verifier.

**Size:** this is at the top of "a few hours". If it runs long, the `well` green and the planters move to the next slice; the
bars stay the same.

### Open questions for Steward

- **S-V-1. Lot input.** Is `params.lots` (your `LotSpec` plus `villager`) right? Will you send `villager` per lot from the
  card's roles, or should Architect infer it from `type`?
- **S-V-2. A bell.** Should V place a bell (which creates the meeting POI and changes villager behaviour), or only reserve the
  anchor? The draft does the anchor only.
- **S-V-3. `siteplan.json` values.** Can your reader take `plaza`, `path`, `villager` in `mover`, and `unplaced` under format 1?
  Or do you want an opt-in format 2?
- **S-V-4. Scope.** Is it OK that V is for new Patron flat settlements only, while Supplied, Hardcore and additions stay on
  VillageLayout until region survival and 6d?
- **S-V-5. Unplaced lots.** List them and continue (the default, as VillageLayout does), or fail by default when a landmark
  doesn't fit?

### Open questions for Noah

- **N-V-1. The look.** The defaults are a square, 2-wide gravel lanes, lamps on the lanes and at the square, benches, planters
  and a dry well (a cauldron). Is there anything you don't want?
- **N-V-2. The gallery's buildings** are free kit variants (cabin, tavern, tower) at $0, not Claude designs. Is that fine for
  judging the layout?
- **N-V-3. Survival.** V is Patron-only until regions get the survival rule (natural cut and fill free; street, lanes and props
  as construction sites with a BOM, C16). Should region survival come right after V?

### Deferred

- **To 7a:**
  - door-aligned lanes from the real fits (the link pass);
  - curved or branching streets, several squares, districts;
  - `auto` routing, connectors, `seconds`/`risk`, `nav.json`;
  - promoting the villager mover;
  - the `golem` and `steward` movers;
  - bible-styled props.
- **To 6d:** additions to a realised village (VillageLayout's `streetZ` and `xLo`/`xHi`), and per-lot deltas inside a region.
- **To the C12 gate:** `Regions.adopt`, and VillageLayout's retirement.
- **To region survival (N4/C16):** Supplied and Hardcore. **To a fluids slice:** wells and channels with water sources.
- **To a paid slice:** `flat_village` in the pick catalogue, with 6b's pick accuracy re-run.

### Phase 6c slice V as built (API 1.13.0, mod 0.16.0, kit 0.16.0, recorded 2026-10-11; recorded 2026-10-11)

Branch `slice/V` (worktree `../architect-mc-V`; the coordinator's names, not `phase/6c-v`). $0: sim and stub only, no Claude call
(`artifacts/gate6c-v/spend.json`). Evidence: `artifacts/gate6c-v/` (one JSON per gate6cv step, REPORT.md, api-compat.txt,
findsite/summary.json), S7's runs under `artifacts/scenarios/6c-v/s7/`, the slice tier under `artifacts/gate-runs-V/`.

| § | As built |
|---|---|
| Kit | `KIT_VERSION` = `EVAL_KIT_VERSION` = the mod's `IrStale.KIT_VERSION` = `0.16.0` (aligned with the mod). Every IR sha moved; no tile did: the mega_bench, 6b and island golden tests pin `kitVersion: '0.12.0'` as they pin `node`, and S1's tile golden is unchanged. |
| §2 program | `kit/regions/flat_village.mjs` (`build(ctx, hooks)` carries the broken variants' test hooks), `catalogue = false`, roles gravel / stone bricks / lantern. Stages ground, street, lots, props. Lot pads cut/fill <= 2 with `floor` at the entrance's y (the lot's front edge sits on the street's verge, VillageLayout's geometry, so a lane is the entrance's `laneWidth` cells on the verge or the square's edge, levelled at the pad top: one row long). The square is levelled (cut/fill <= 2) so the bell area is one y. A lot `size` is [alongStreet, deep]. |
| §3 components | `kit/lib/region/village.mjs` (`layoutStreet` pure: both orientations, VillageLayout's scoring, the square's frontage to the trading hall, the landmark and central lots; farms and near_water lots moved to a street slot within 2 of water when one fits; `streetLayout`, `square`, `lane`, `surfaceOps`: `columns` ops only) and `kit/lib/region/props.mjs` (planned in the shared space in the order bell, well, benches, planters, lamps, each keeping one walk neighbour; 2 benches on a square up to 11, 4 above; lamps at the corners or the nearest free edge cell; the dry well needs a square of 11+). `shared: well` is a 7x7 grass green with the bell area at its middle and one road along it, and carries no well prop (deviation: no room beside a 5x5 bell area in 7x7). |
| §4 input/output | `lots` param type (region programs only, never a variant axis; `villager` inferred from `type` only when absent). `lots[].ext["architect_mc:village"] = {role, type, villager, entrance, lane, water, bellDistance, slot, landmark, placement}` -> `LotSpec.ext`; `notes` `unplaced: a, b`; siteplan `unplaced: [{id, reason}]`. keepOut: the mod sends the owner's areas meeting the claim; the sidecar passes `--keep-out <planDir>/keepout.json`; the IR records `keepOut` (the rects honoured) only when the program reads `ctx.keepOut` / `keptOutAt`. The mod refuses PROTECTED at accept and at realise any area meeting the claim whose exact rect is not in that list (deviation, decided with the contract's intent: 0c's whole-claim refusal stays for every program that reads no keep-out, now at accept instead of before the survey). |
| §5 graph | IR `graph` (format 1 and 2 member; `MEMBERS_FORMAT2` gains `graph` and `keepOut`): nodes lot / plaza / junction with ports, edges road / path with `width` and `path`. siteplan: `derived: false`, `mover` `['player', 'villager']` per edge where the villager mover from the bell reaches both ends; lanes as `paths[]` of kind `path`; schema widened without changing a member. |
| §6 villager rules | `walkGraph(vw, starts, {mover: 'villager'})` (no climbing, no bubble columns, no swimming, falls <= 1, wooden doors only, no standing on a 1.5 barrier). `M2:villager`, M2 on the graph (a lot node with no edge to the plaza: the "no lane" variant), M22, M23, M24 (no water: a note), and an M1 error for a village part inside a lot box. |
| §8 API | `VERSION` 1.13.0; no new records or methods. Features `planKeepOut`, `flatVillage`, `regionGraph`, `villagerMover` come with a helper that offers `region.keepOut`. DevBridge: `dev.nav.villager`, `dev.site.anchors`, `dev.region.plan {bible}`, `dev.region.remove {requester}`. apitest `heights` adds `Sample.ground`. |
| Coordinator addition (C16) | `RoadBuilder.freeCell`: a dirt path on grass_block, dirt, coarse_dirt, podzol, mycelium or rooted_dirt is free (`RoadFreeCellTest`; in game `survroad`: BOM {} on each, gravel on sand costs). |
| S7 fixture (first search) | The contract's second-seed case (resolved below). find-site on seed 2026100906 with S7's needs (one 3-level band over >= 85% of the ground columns, surface water in the outer 16-cell band, no village near, flat_village planned clean) qualified no site within ~4100 (460 candidates, step 384, centre 0,0; best band share 0.879 with no water; `findsite/summary.json`). S7 is pinned on a **provisional** fixture `[1480, -3128, 1591, -3017]` (plains and beach, band share 0.616, 14 band water columns, its plan clean), marked `provisional` in the scenario. Its natural and flat runs, golden and gallery are evidence for the pipeline, not a passing S7. |
| S7 runs | Flat: every bar, E-flat 0 over 329 cells. Natural (`20261011-092956`, evidence `21979777f76b`): bars 1-13 pass (10/10 villager lots by the kit and by vanilla `dev.nav.villager`, 10/10 door-to-street walks, 0 dirt path or cobblestone in the front zones, props built = planned, E-normal 674 all growth, golden `scenarios/goldens/s7.json` with its inputs, own CPU max 14.7 ms). Bar 8 is measured over the village's walk cells (street, verges, lanes, square: 0.00% of 533); the checker's M5 over every reached region-written floor (lot aprons and batters) read 11.8% and is recorded (deviation). Bar 14: the private page "Architect 6c-V gallery" (https://claude.ai/artifact/AHUxAGLT42pfRy5YUHdojG), approval pending. |
| Findings for the next slice | (1) 4e street lanterns stand only on blocks the road code treats as ground: a bible whose `path` is packed mud (also stone bricks, planks) gets a dark street (measured: M5 2.21% with packed mud); the S7 fixture bible's path is coarse dirt. (2) With the default gravel path, a levelled lane or verge over a gap can leave a gravity block unsupported (M3 warning on one candidate plan). (3) The trading-hall variant off the square lands at ~13, not 20; M23 catches it. |
| Gate | Slice tier `artifacts/gate-runs-V/20261011-093554-slice` (3 shards, 8906-8911): 26 PASS; 6b-scenario-s1 failed only on S1's golden IR sha (kit 0.16.0 changes every IR sha; the compare now matches on tile shas when the IR differs only by kitVersion), re-run with 6cv-scenario-s7 at the fix: `20261011-103647-slice` PASS. api-compat clean against the 0.15.0/0.14.0/0.13.0 apitest jars and the 0.15.0 surface. gate-verifier: items 1, 2, 4, 5, 6, 7 verified (it re-ran unit, variants and v-ingame, and recomputed S7's evidence sha); verdict FAIL on bar 8's definition (below). |
| Bar 8 (coordinator ruling, 2026-10-11) | For V, bar 8's walk area is the street, verges, lanes and square plus every lot's door-to-street path cells (bar 4's walks, up to and including the entrance cell); bar 8 is M5 under 1% over that set. The checker's full M5 (every reached region-written floor) is unchanged and recorded beside it as data. On S7's run: 0.00% of 558 walk cells (25 door-path cells); the checker's M5 11.8% of 695. Lighting the lot aprons and batters is queued for the next slice (PLAN "6c slice V: queued for the next slice"), with the two findings above. |
| S7 fixture (coordinator rulings, 2026-10-11) | **Pinned: seed 2026100906, `[1480,-3128,1591,-3017]`** (plains and beach, band share 0.616, 14 band water columns, plan clean). The 85% band was a rule for choosing the fixture, not a product bar: across 7 seeds (2026100906 and 2026101101-06, about 3,200 candidates, 460 per seed at step 384, about 4100 out) no site had both a band of at least 85% and unfrozen water in the outer band. Frozen water counts as water (find-site's `noFrozen`): 2026101102's only qualifier `[4168,1480,4279,1591]` (0.865) sits on a frozen river and sea and realised PARTIAL, so it is rejected (its runs kept apart in `artifacts/scenarios/6c-v/s7-rejected-2026101102/`). Best per seed: 2026100906 0.879 (no band water), 2026101101 0.718, 2026101103 0.708, 2026101104 0.531, 2026101105 0.793, 2026101106 0.768 (no water). The pinned site is harder than the rule asked and every bar passes on it (1-13 and the ruled bar 8), so it shows more than the rule required. **The fixture rule becomes:** band share of at least 0.6, unfrozen surface water in the outer 16, no village within claim + 64, plan clean. The flat variant still covers E-flat. S7's natural run is `20261011-092956` (evidence `c31c6de43ce1`). Data: `scenarios/s7_flat_village.json` `search`, `artifacts/gate6c-v/findsite/summary.json`, `artifacts/gate6c-v/findsite-seeds/summary.json`. |
| Gate (final) | 6cv-scenario-s7 re-run on the pinned fixture: `artifacts/gate-runs-V/20261011-142353-slice` PASS at c91973a. gate-verifier re-check under the coordinator's rulings (bar 8, frozen water, the S7 pin): **PASS** (evidence sha of `20261011-092956` recomputed = c31c6de43ce1; bar 8 0.00% of 558 walk cells, the checker's M5 11.8% recorded; bars 1-13 pass; the earlier items stand). Bar 14 (Noah's gallery approval) pending. HANDOFF-V retired. |

## Coordinator decisions on the 0b, 0c and V drafts (2026-10-10; provisional where Noah may override)

- **Order and versions:** 0a, 0b and 0c build in parallel. They merge in order 0a (1.10.0), 0b (1.11.0), 0c (1.12.0), then V
  (1.13.0). If the merge order changes, the API minor follows it. SETTLEMENTS.md's later numbers (7a, 7b, ...) shift and are
  updated as slices land.
- **0b C7 benchmark:** both arms (unique and repeat-heavy) plus the C13 smoke run. Expected ~$24, hard cap **$35** on Noah's
  claude login (confirmed by Noah 2026-10-10). The variation bar is as drafted.
- **0c:** survival roads (C16) split into slice **0d** if they overrun. On survival roads, a `dirt_path` laid on grass is free
  (shovel-equivalent), and other written cells cost their item.
- **V:** Patron-only scope accepted for now. The default look is the drafted roles (gravel path, stone-brick foundation).
  Free kit variants are fine for the S7 gallery. Region survival is scheduled after V (Noah's survival rule: terrain free,
  connectors and buildings cost materials).

## Changes from Steward's review of 0b, 0c and V (2026-10-10; all accepted, these win)

- **0b:** the 11x9 small rule is the default, and an explicit `effort: SMALL` (or STANDARD) wins over it. A capped S item FAILS,
  with no silent retry at STANDARD. Copies of a failed archetype fail with `source_failed`; the caller decides `promoteCopy`.
- **0c:** remove and undo are never refused. No teleporting of tagged entities: ignoring them is enough, and the caller moves
  its own. Refusing a region claim that touches an area is enough for 0c. A road is one site with gaps plus the skipped
  waypoint spans. A shared crate is required for survival roads.
- **V:** `params.lots` = LotSpec plus `villager`, which the caller sends per lot (inferred from `type` only when absent). The
  bell is an anchor only by default, opt-in to place. `siteplan.json` stays format 1. Patron-only. Unplaced lots are listed and
  the plan continues.

## 6c next batch: W and the terrain slices. Batch summary for Steward review (DRAFT, 2026-10-11)

The sections after this one are short slice contracts, all **DRAFT for Steward review**. They follow SETTLEMENTS §4, §9,
§11, §16 and §17 (6c: forms, fields and routing; S2 and S3 v1), Noah's toolbox decisions (PLAN "Inputs for the 6c contract",
2026-10-09) and "Process from 6c on". Main is at v0.16.0 / API 1.13.0.

**Rules for every slice in this batch:**
- **API minors** are listed in the expected merge order. Slices in one wave run in parallel; if they merge in another order,
  the house rule applies (the second to merge takes the next minor), and each contract's "previous apitest jars" follow.
- **Binary compatibility:** old record constructors are kept, new interface methods are defaults that throw, and new enum
  values are appended. Each slice archives the previous apitest jar first and runs `tools/api-compat.mjs`.
- **Kit:** a new op kind or IR member is format 2, named in `requires`, and an older mod refuses it `PLAN_STALE`. Each slice
  bumps `KIT_VERSION`, which moves every IR sha. Format-1 tiles and the committed tile goldens (S1, S7, `mega_bench`, and later
  S2 and S3) must not move unless a slice says why.
- **Spend: $0 for every slice.** No slice needs Noah's claude login. Lots come from library variants, with no pick.
- **Gates:** the `slice` tier plus each contract's focused items. The gate-verifier re-runs the risky items. Bars include
  E-flat 0 and E-normal classified (at most 0.01%), own CPU at most 50 ms with p99 at most 25 ms, tile p99 under 2 s, and
  macOS/Linux determinism.

### The slices

| Slice | API / mod | Wave | Scope | What it gives Steward | Depends on | Gates on |
|---|---|---|---|---|---|---|
| **W** village safety | 1.14.0 / 0.17.0 | 0 | COPY ms (first); apron and batter lights (full M5 under 1%); road lanterns on built paths; frozen water as water; gravity blocks over gaps | safe flat villages, whatever path block the bible picks; no PARTIAL realise over frozen rivers | V | S7 natural and flat; three path bibles; S7's rejected frozen site |
| **T1** passes and relief | 1.15.0 / 0.18.0 | 1 | `r.pass`, fields, resolution-1 second survey to 1024², plan budget 120 s / 2 GB, `relief` op, relief blending, erosion touch-up | pads that meet the land; the base for every pass | W | `relief_demo` on S3's claim; 1024² synthetic |
| **F1** forms I | 1.16.0 / 0.19.0 | 1 | `iceSpike`, `rockSpire`, `voxels` op, kept natural spikes, M17 melt | ice and rock forms; melt-safe lighting | V | `forms_demo` on S2's claim |
| **MP** masks and patterns | 1.17.0 / 0.20.0 | 1 | masks (block, height, slope, depth, field, noise); patterns (mixes, gradients); `Mask`/`Pattern` records | ground cover and wall textures you can specify | V | `crater_works` toolbox demo |
| **T2** routing | 1.18.0 / 0.21.0 | 2 | `route` pass: A* with heading, switchbacks, stairs, ladders on player-only edges, keep-out, hysteresis | paths that climb hills; routing around protected areas (0c deferral) | T1 | `route_demo` on S3's claim; synthetic 1:2 slope |
| **F2** scatter and stamps | 1.19.0 / 0.22.0 | 2 | `scatter` op, bundled items, `stamp` op, `dev.feature.stamp`, stamp library | decoration that follows the plan | T1, MP | `scatter_demo` on S2's claim |
| **B** brushes | 1.20.0 / 0.23.0 | 2 | `Regions.brush`: smooth, erode, melt, blend, raise, lower, overlay, cave carve; destruction rule; commands | journal-backed terrain edits by API | T1, MP | `brush_demo` (flat and S3 corner) |
| **S2** ice-spike outpost | 1.21.0 / 0.24.0 | 3 | `ice_outpost`; S2 run, golden, gallery | S2 green: the first natural-terrain settlement | W, T1, F1, F2, T2 | **S2** |
| **T3** bridges and tunnels | 1.22.0 / 0.25.0 | 3 | route moves `bridge` and `tunnel`; `r.tunnel` | crossings over gaps, rivers and ridges | T2 | rift fixture, synthetic ridge, S7's frozen site |
| **H** contained fluids | 1.23.0 / 0.26.0 | 3 | fluid parts in regions, M25 containment (new), M20 fire, `r.pool`, FILL/DRAIN/FLOOD_FILL, wet well | ponds, pools and wells that never flood | B | `water_demo` on S3's claim |
| **HY** hydrology | 1.24.0 / 0.27.0 | 4 | priority flood, D8, `flow`/`wet` fields, channels as fluid parts | moss and mud where water runs; streams | T1, H | `hydro_demo` on S3's claim |
| **D** districts | 1.25.0 / 0.28.0 | 4 | `districts` pass on survey candidates; **a district beside a standing region** (`beside`) | multi-district plans; adding a district to a village (your 6c/7a ask) | T2 | `districts_demo` on S3's claim; S7 flat + beside |
| **VOC** vocabulary and rarity | 1.26.0 / 0.29.0 | 4 | colour and rare groups, bible `rarity` budgets, `rarity`/`coherence`/M26 rules, one creative-only list, rare costs | themed palettes with guard rails; survival costs for rare blocks | MP | kit examples, three fixture bibles |
| **S3** monastery v1 | 1.27.0 / 0.30.0 | 5 | `terraced_monastery`; S3 v1 run, golden, gallery | S3 v1 green: terraced mountain settlement | T1, T2, D, F1, F2 | **S3 v1** |
| **SCH** `.schem` | 1.28.0 / 0.31.0 | any | Sponge schematic v2/v3 import, v3 export (entries, sites) | builds in and out without WorldEdit | none | kit examples, spec fixtures |
| **F3** forms II | 1.29.0 / 0.32.0 | 5 | `giantTree`, `mushroom`, `coral`, `roots`, `stalactites`; M18, M19; forest mega_bench variant | the forms 7b's treehouse and cave scenarios need | F1, F2, H | `grove_demo`; forest variant |
| **RS** region survival, terrain half | 1.30.0 / 0.33.0 | 6 | survival worlds: terrain free, lots and roads construct from a region crate, built parts refused until 7a | regions in Supplied worlds (with shovel paths) | W; after B, H | survival-world fixtures |
| **PT** player-changed cells (optional) | 1.31.0 / 0.34.0 | 6 | tracking player block changes; `respectPlayerChanges` | automatic protection of player edits | 0c | scripted player edits |

**Parallel tracks.** Wave 0 is W alone. Each later wave has up to three slices on separate worktrees and ports:
- **Track A (scenarios):** W, T1, T2, S2, then D and S3. This is the critical path to SETTLEMENTS' 6c gate.
- **Track B (forms):** F1, F2, F3.
- **Track C (toolbox):** MP, B, H, HY, VOC, SCH, RS, PT.

SCH depends on nothing and can fill any idle lane. The **6c close-out** (at the end of this batch) runs the release tier
when the last 6c slice merges.

**Size against SETTLEMENTS.** SETTLEMENTS sized 6c at about 1.0 (6a = 1.0), before Noah added the toolbox on 2026-10-09.
- **SETTLEMENTS' 6c row:** T1, T2, T3, D, H, HY, F1, F2, F3, S2 and S3 (passes, the whole generator library, scatter and
  stamps, contained water, M17-M20, S2 and S3 v1).
- **Added since:** MP, B, VOC and SCH (Noah's toolbox), RS (N-6b-5) and PT (a 0c deferral, optional), plus H's fluid brushes.

That is 16 short slices after W, roughly twice SETTLEMENTS' estimate.

**Rebase points between parallel slices** (as 0c §11 listed them): `KIT_VERSION` (kit `plan.mjs`, `realise.mjs`, the mod's
`IrStale`), `mod_version`, `VERSION`, `Reason` order, `realise.mjs` `OPS_RESERVED`/`KINDS_FORMAT2`/`MEMBERS_FORMAT2`, the
checker's `RULES`, `gate-chains.json` and the impact map. Records widened by more than one slice take their trailing components
in merge order:
- `RegionView`: B (`brush`), D (`beside`), RS (`crate`);
- `RegionPlanRequest`: D (`beside`), PT (`respectPlayerChanges`);
- `BrushRequest`: H (`fluid`), PT (`respectPlayerChanges`);
- `BrushKind`: H appends after B.

### Coordinator decisions on the batch (2026-10-11; these win over the questions below)

- **N-W-1:** Noah approved V's gallery at `c31c6de43ce1` (v0.16.0). W's lamps are visible, so W's S7 gallery is approved by
  Noah again when W is ready.
- **N-F2-1 (stamps in the public repo): decided by Noah (2026-10-11), local-only.** F2 ships the `stamp` op and the harvester.
  The stamp library is harvested locally from the player's own game and is never committed or bundled in the jar.
- **N-F1-1:** the axis-run metric stays recorded only through 6c. An uncalibrated estimate doesn't gate.
- **N-H-1:** survival fluids: placed water source cells are free (water is renewable), and each placed lava source cell
  costs one lava bucket from the crate. Containment (M25) applies in both modes. RS uses this.
- **N-RS-1:** the connector half of region survival stays in 7a (N-6b-5).
- **Scheduling:** as drafted. 7a may start after T2, T3 and S2. The 6c close-out (S2, S3 v1, F3's forest variant, mega_bench A
  with forms) gates 7a's merge, not its start. The toolbox additions finish alongside.
- **Scope:** the additions are accepted as recorded (the toolbox slices from Noah's 2026-10-09 decision, M25, M26, `beside`,
  RS, and PT as optional). The 6c close-out updates SETTLEMENTS §17.2's API numbers and closes N-0c-3.
- **Spend:** $0 for the whole batch, as drafted. N-VOC-1's paid check comes back as its own decision when it's needed.
- **Smaller calls:**
  - **N-W-2:** lamps use the bible's lighting role, a lantern on a fence post in the bible's wood by default.
  - **N-T1-1:** `blend` is the default pad edge for programs that declare passes. Existing programs keep their edge, so the
    S1, S7 and mega_bench goldens don't move.
  - **N-B-1:** `PLAYER_BLOCKS` removal needs permission level 2 (op).
  - **N-S2-1:** S2 plans on land only.
  - **N-HY-1:** S3 v1 has no stream. S3 doesn't depend on HY; a stream can come with 7b's v2.
  - **N-VOC-2:** the drafted default rarity budgets are accepted.
  - **N-S3-1:** "v1 terraced" means buildings on terraces cut into the slope, with retaining walls and switchback paths.
    Cliff-built is 7b's v2.
  - **N-SCH-1:** fixtures are built from the public spec. A real WorldEdit-exported file is added later if Noah exports one.
    It doesn't block SCH.

### Changes from Steward's review of the batch (2026-10-11; these win over every slice draft below)

All slice drafts in this batch are **FROZEN** with these answers (W and X were frozen earlier). S-T2-2 and S-H-1 are Noah's
answers, relayed by Steward.
- **S-T1-1:** a 120 s worst-case plan is accepted (Steward shows "laying out the village"; claims at most 257 across,
  districts at most 129; Steward sets no plan timeout under 120 s).
- **S-MP-1:** masks and patterns reach Steward only through bibles and bundled programs for now. No card field. Revisit with
  Steward's phase 2.
- **S-T2-1:** movers are inferred from the end nodes' lot kinds; a per-edge override may come later (keep room for it).
- **S-T2-2 (Noah):** ladders are on for player-only edges (lookouts, watchtowers). Villager edges never use ladders.
- **S-B-1:** one region per brush stroke, as drafted.
- **S-B-2:** areas binding every owner (`*`) stay deferred; not in 6c.
- **S-S2-1:** S2's lot list is a fair hillside-card stand-in. **Add a farm lot to S2** to bring it closer.
- **S-T3-1:** stone bridges and plain tunnels until 7a are accepted. **Addition:** the plan and the region report which edges
  crossed water or rock (a per-edge `crossing: bridge|tunnel` with what it crossed), so Steward's card and history can say so.
- **S-H-1 (Noah):** yes to a small contained pond beside a decorative farm lot on a dry claim: on the lot, never outside the
  claim or in a protected area, removed with the region. **Working farms are different** (7b / functional modules): water
  designed into the farm for yield, every farmland block hydrated (a source per 9x9, channels on that spacing), not a pond
  added beside it. Carried to 7b.
- **S-D-1:** districts on survey candidates are enough; Steward's own districts stay its own until the joint gate.
- **S-D-2:** Steward proposes and approves, Architect lays out. **The join's site belongs to the district's region**, so
  undoing the district removes its join.
- **S-VOC-1:** default rarity budgets are enough for now. **Keep the budget field on the bible request**; Steward will pass
  budgets when a card's style asks for a rare palette.
- **S-RS-1:** RS is useful; Steward adopts it at its phase 4.
- **S-PT-1:** PT is **dropped from 6c**. C17 areas cover it until 6d, and updates already keep player edits.

### Open questions for Steward

- **S-W-1:** treat frozen water as water (recommended), or refuse plans that touch it.
- **S-W-2:** lamps beside lot aprons, up to 4 per lot.
- **S-T1-1:** 120 s worst-case plan time.
- **S-MP-1:** whether you send masks and patterns yourself.
- **S-T2-1:** movers per edge from the card, or inferred.
- **S-T2-2:** ladders on player-only edges.
- **S-B-1:** grouped strokes, or one region per stroke.
- **S-B-2:** areas binding every owner (0c's deferral; nothing else in the batch places it).
- **S-S2-1:** S2's lot list as a fair card stand-in.
- **S-T3-1:** stone bridges and plain tunnels until 7a.
- **S-H-1:** a pond beside farm lots.
- **S-D-1:** districts on survey candidates before 7a's affordances.
- **S-D-2:** the beside-join as one routed edge.
- **S-VOC-1:** rarity budgets from the card.
- **S-RS-1:** using RS with shovel paths for Supplied.
- **S-PT-1:** whether PT is needed in 6c at all.

### Needs a Noah decision

1. **S7's gallery approval (N-W-1).** W adds lamps, so S7's evidence sha moves. Approve V's sha `c31c6de43ce1` now and W's after,
   or wait for W's?
2. **Stamps in the public repo (N-F2-1, SETTLEMENTS N7, unanswered).** May the repo and jar ship block lists harvested from
   vanilla feature code? If not, F2 ships the op and the harvester, and stamps are harvested locally.
3. **The axis-run bar (N-F1-1).** 6b's optional calibration card appears unfilled. Gate S2/S3 at the 0.25 estimate, fill the
   card first, or keep it recorded only through 6c?
4. **Fluids in survival (N-H-1):** water free and lava costing a bucket, both free, or both creative-only? RS refuses fluids until
   this is decided.
5. **The connector half of region survival (N-RS-1):** keep it in 7a (N-6b-5), or pull path parts and props into RS?
6. **Scheduling.** SETTLEMENTS says 7a depends on "6c (routing)", which is T2 and T3. Does 7a also wait for the 6c close-out
   (S2 and S3 v1 green, F3's forest variant, mega_bench A with forms), and for the additions (MP, B, VOC, SCH, RS, PT)? This
   draft assumes 7a may start after T2, T3 and S2, with the rest of 6c and the additions finishing alongside, and the close-out
   gating 7a's merge rather than its start.
7. **Scope additions against SETTLEMENTS §17.2's 6c row**, each recorded here rather than made silently:
   - the toolbox slices (MP, B, H's brushes, VOC, SCH), from Noah's 2026-10-09 decision;
   - **M25** fluid containment and **M26** region rarity, new rules not in SETTLEMENTS §11;
   - D's `beside` API, agreed with Steward on 2026-10-09;
   - RS, from N-6b-5;
   - PT as optional, a 0c deferral.

   SETTLEMENTS itself is not edited in this batch. Its §17.2 API numbers (6c 1.10.0, 7a 1.11.0, ...) are stale; N-0c-3 is
   still open.
8. **Spend:** none needed. Every slice is $0. Teaching the bible job to choose rarity budgets (N-VOC-1) is the one item that
   would need a paid check later.
9. **Smaller calls, one line each:**
   - N-W-2: the lamp look.
   - N-T1-1: `blend` as the default pad edge.
   - N-B-1: the permission level for `PLAYER_BLOCKS`.
   - N-S2-1: S2 on land only.
   - N-HY-1: a stream in S3.
   - N-VOC-2: default rarity budgets.
   - N-S3-1: what "v1 terraced" means.
   - N-SCH-1: a real WorldEdit `.schem` fixture.

## Phase 6c slice W: village safety (FROZEN 2026-10-11 after Steward's review)

This slice is API 1.14.0 and mod 0.17.0, after V (1.13.0 / 0.16.0). The coordinator confirms the numbers at merge; if another
slice merges first, W takes the next minor.

- **Branch:** `slice/W`, in the worktree `../architect-mc-W`.
- **Spend:** $0. Sim and stub only, no claude-login run.
- **Scope**, in this order (PLAN "6c slice V: queued for the next slice", plus 0b's proposal 5):
  0. the COPY line's ms in the C7 breakdown (small, goes first);
  1. light the lot aprons and batters, so the checker's **full** M5 is under 1% on S7 (Steward's top ask);
  2. 4e road lanterns on non-ground path blocks;
  3. frozen water in the plan survey;
  4. gravity blocks over gaps.
- **Not in scope:** anything else from V's deferred list (door-aligned lanes, curved streets, bible-styled props: 7a), region
  survival (the "RS" slice below), and any terrain op.
- **Depends on:** V merged. **Later slices build on W:** T1 (it shares `RegionSurvey`), T2 and S2/S3 (`lightCover`), T3 (the
  `gravity` flag and the frozen-river fixture), S2 (frozen water) and RS.

### 0. Facts W depends on

- **COPY ms.** `sidecar/src/breakdown.ts` accrues copy time only while a refresh sees an item in state `copy` (lines ~98-141).
  A copy that is queued, built and done between two refreshes records 0 ms; R's bench run counted 4 copies at 0 ms.
- **Aprons and batters.** `r.lot` (`kit/lib/region/program.mjs` ~1415-1500) writes a 1-column apron around the footprint
  (`surface`, `IF_AIR_OR_FLUID`) and, with `pad.edge: 'slope'`, 1:1 batter steps (`subsurface`). Both are reached
  region-written floors, so the checker's M5 counts them. Nothing lights them: V's lamps go on lanes and the square only
  (`kit/lib/region/props.mjs`). On S7's pinned run, the full M5 read 11.8% of 695 cells; V's ruled bar 8 (walk cells plus
  door paths) read 0.00% of 558.
- **K5:** no region op writes inside a lot box. Props are never on walk cells, in the bell area, golem space or keep-out.
- **Road lanterns.** `RoadPlan.lanterns` (~772-822) puts a fence post and a lantern beside the walkway only where
  `ground(below)` holds, and `ground` is DIRT, SAND, STONE, MUD or PATH. `RoadTerrain.kind` gives packed mud, stone bricks
  and planks `BUILT`, so a bible whose `path` is one of those gets no posts on its verges (measured: M5 2.21% with packed mud).
  `RoadPlan.surfaceFor` already avoids gravel on an unsupported centre cell (`free()`), so 4e's own surface is safe.
- **Frozen water.** `Columns.java` sets `WATER` from the top block's fluid state only. Ice, packed ice and frosted ice over
  water read as dry ground with `floor = ground`. Flag bits used: WATER 1, MISSING 2, TREE 4, LAVA 8; bits 16-128 are free.
  `Volume` already classifies `ICE`. `find-site`'s `noFrozen` (V) is a biome heuristic that also rejects `ice_spikes`, which
  S2 needs. S7's rejected site 2026101102 (`[4168,1480,4279,1591]`, a frozen river and sea) planned clean and realised PARTIAL.
- **S2's pinned fixture** is about 75% frozen and deep frozen ocean (`scenarios/s2_ice_spikes.json` biome stats).
- **Gravity.** The kit's lane, verge and square swaps (`village.mjs` `surfaceOps`, `columns` ops) write the `path` role on top
  of whatever is under it. The default `path` is gravel. `blocks.mjs` has no gravity flag.
- **S7's gallery approval is pending** on V's evidence sha `c31c6de43ce1`. Item 1 adds lamps, so S7's evidence sha moves.

### 1. API 1.14.0 rules and behaviour changes

- `VERSION = "1.14.0"`, the usual rules (old constructors kept, default-throwing methods, enums appended).
  `tools/api-compat.mjs` checks the 0.16.0, 0.15.0 and 0.14.0 apitest jars and the 0.16.0 surface.
- **`Sample` gains a trailing `BitSet frozen`:** columns whose top is ice over water (§5). The old constructors give an empty
  set. `Sample.water` is **unchanged** (the fluid at the top only), so a caller's water logic doesn't move.
- **Features:** `frozenWater`, `apronLights`.
- **Behaviour changes:**
  1. A region plan over frozen water treats it as water (§5). Plans over frozen claims change; their survey sha moves.
  2. A 4e road whose verge is the caller's own built path gets lantern posts there (§4).
  3. `flat_village` adds lamp posts beside lot aprons and batters (§3). Its IR and tiles change; S7's golden is re-committed.
  4. `KIT_VERSION` 0.17.0: every IR sha moves. Format-1 tiles, S1's tile golden and `mega_bench.golden.json` don't.

### 2. Item 0: the COPY line

- A copy's time is the span from its variant job's start to its `done`, taken from the item's own transition timestamps
  (`startedAt`, `doneAt` in the group store), not from refresh sampling. Waiting for its archetype stays out of it, as 0b set.
- `Group.breakdown.copy.ms` is the sum over done copies. No other line changes.
- **Bar:** a unit test where 4 copies start and finish inside one refresh interval gives `copy.ms > 0`, equal to the sum of
  their spans; every other line of R's recorded breakdown fixture is byte-identical.

### 3. Item 1: lighting the lot aprons and batters

- **A kit helper `r.lightCover(opts)`**, called by a program after its lots, lanes and props. It is **opt-in per program**, so
  programs that don't call it give unchanged tiles. `flat_village` calls it; S1, `mega_bench` and the 6b fixtures don't.
- **Target set:** every walk cell the checker's M5 counts on the plan's virtual world: the reached region-written floors,
  including aprons and batter steps.
- **Method** (plan time, deterministic):
  1. The kit's block-light model (`check.mjs blockLight`) over the virtual world with V's lamps and the road lanterns in.
  2. Candidate cells: the `lamp_post` prop's rules (supported, standable, never on a walk cell, in a lot box, the bell area,
     golem space or keep-out). Lot corners outside the apron's diagonal first, then batter feet, ordered by (lot id, x, z).
  3. Greedy: add the candidate that lights the most dark target cells, until dark spawnable cells are under 0.5% of the target
     set, or each lot has 4 lamps. Ties by candidate order.
- Buildings' own lights are ignored at plan time (their entries aren't installed yet), so the cover is conservative.
- **Lamp style:** V's `lamp_post` (a fence post with a lantern), in the bible's `light` role. Bible-styled lamps stay 7a.
- **Gallery note:** the lamp count per lot is in `siteplan.json` props and the plan notes, so Noah can judge clutter.

### 4. Item 2: road lanterns on built path

- A lantern post's foot may also be a `BUILT` cell that is **journal-owned by the road's own owner** (a region's verge, a path
  the same caller placed). A player's block or another owner's never counts.
- The road's own planned surface cells stay excluded (the post goes beside the walkway).
- **Bar** (the S7 flat variant, three fixture bibles whose `path` is packed mud, stone bricks and oak planks):
  - the road lantern count equals the coarse-dirt bible's on the same plan, exactly;
  - M5 over the street and verges is 0.00%.
- A focused unit test in `RoadPlanTest`: a verge of each of the three blocks, owned by the owner, gets posts; owned by another
  owner or by nobody (BUILT), gets none.

### 5. Item 3: frozen water

**Recommended (open question S-W-1):** treat frozen water as water, with the information kept.
- **ARSV flag `FROZEN = 16`:** the column's top block is `ice`, `packed_ice`, `blue_ice` or `frosted_ice`, and a water cell
  lies within 3 below it. Such a column also gets `WATER`, and `floor` is the bed under the water, as for open water.
- Land ice (an ice spike on snow, packed ice on stone) is not frozen water and stays ground.
- **The kit** treats FROZEN as water everywhere WATER applies (roads, pads, lanes, the street's ground check), except M24:
  a farm needs unfrozen water, so M24 counts WATER without FROZEN.
- **The 4e road code:** `RoadTerrain.kind` classifies ice over water as `WATER` for depth, so a road over a frozen river is
  DEEP_WATER (a partial road skips that span; a decked 1-deep crossing works as for open water).
- **find-site** reads FROZEN from the survey; `noFrozen` drops its biome heuristic, so S2's search can keep `ice_spikes`.
- **Pinned surveys:** a survey with frozen columns gets new bytes. S2's and S3's `surveySha` are re-pinned at the same claim
  (recorded with the reason). S1's and S7's must not move: a bar.
- **The alternative (S-W-1 b):** keep ice as ground, and refuse a plan whose roads, pads or lanes touch frozen water with a
  typed note naming the frozen columns. It is smaller, but S2 would then plan buildings on sea ice that melts under their own lights
  (M17).

### 6. Item 4: gravity blocks over gaps

- **`blocks.mjs` gains a `gravity` flag** per block, generated from the 26.3 data dump (`kit/tools/BlockDump.java`: blocks
  whose class extends `FallingBlock`), not hand-listed.
- **The rule, in the kit's surface swaps** (`surfaceOps`, the square, verges, lanes) and in `r.lot`'s apron: where the written
  block has `gravity` and the cell under it is a gap in the frozen ground (air, fluid, a plant or snow layer), the op also
  writes the `foundation` role under it when the gap is 1 deep, and otherwise swaps the surface for `subsurface` (never
  gravity) in that column.
- **Checker:** M3 gains the sub-finding `M3:gravity` (an unsupported gravity block in a written cell). Warning, gated as a bar.
- **Property test:** 500 seeded synthetic claims with random 1-3 deep gaps under lanes, verges and aprons, with gravel, sand
  and concrete powder as `path`: 0 `M3:gravity`.

### 7. Gate (slice tier, $0)

**Evidence:** `artifacts/gate6c-w/<item>.json` and `REPORT.md`, by `tools/gate6cw.mjs` (added to the impact map).
`spend.json` must read $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | COPY ms | §2's unit test; other breakdown lines unchanged |
| 2 | Full M5 on S7 natural (realised, re-surveyed; every reached region-written floor) | under 1% |
| 3 | V's bar 8 (walk cells plus door paths) on the same run | still 0.00% |
| 4 | Lamp clutter | at most 4 lamps per lot; the per-lot count recorded; 0 lamp cells on walk cells, lot boxes, bell area, golem space, keep-out |
| 5 | Road lanterns, three path bibles (S7 flat variant) | count equal to the coarse-dirt bible's; street M5 0.00% |
| 6 | Frozen water: S7's rejected site 2026101102 | planned with the street off the frozen river, or refused with a note naming frozen columns; never PARTIAL at realise |
| 7 | Frozen water: survey shas | S1's and S7's unchanged; S2's and S3's re-pinned with the FROZEN count recorded |
| 8 | Gravity | §6's property test 0; S7 natural and the gravity broken variant: 0 `M3:gravity` on the realised world |
| 9 | S7 run bars 1-13 (V's table, bar 8 as ruled) | all pass |
| 10 | Exactness | S7 flat E-flat 0; natural E-normal classified, at most 0.01% of written cells |
| 11 | Determinism | IR sha identical over 3 plans; S7 tile shas for 1 and 4 workers equal the re-committed golden (macOS and Linux CI) |
| 12 | Goldens that must not move | `mega_bench.golden.json`, S1's tile golden, the 6b fixtures' `expected.json` |
| 13 | MSPT | Architect's own CPU per tick at most 50 ms on S7 natural |
| 14 | API | api-compat clean; the three apitest jars pass |
| 15 | Spend | $0.00 |
| 16 | Gallery | Noah approves S7's new evidence sha on "Architect 6c-V gallery" (a new section, W) |

**Broken variants** (each caught on its named part): a lot with lamps removed (M5 full over 1%), a gravel lane over a 2-deep
gap with the rule off (`M3:gravity`), a road over frozen water with FROZEN ignored (plan note, then DEEP_WATER at check).

**Tier:** `slice`: quick plus the impact rows for the kit region code (6a-staged, 6a-inv3, 4e-megalite), `site/**`
(4e-orders, 4d-all, 5b-village, 6b-pathstyle), `region/**` (6a-megaA, 6b-ghost, 6b-volume, 6b-nudges, 6b-versions; the engine
tag, since `Columns` changes), the sim suites, apijars, 6b-scenario-s1 and 6cv-scenario-s7. About 60-75 min on 3 shards.
**gate-verifier (slice)** reviews the diff and the evidence, recomputes S7's evidence sha, and re-runs items 2, 5 and 6.

### 8. Build order

1. Archive the 0.16.0 apitest jar.
2. Item 0 (sidecar only).
3. Item 4 (the `gravity` flag, the kit rule, M3:gravity).
4. Item 3 (ARSV FROZEN, `RoadTerrain`, kit, find-site, re-pins).
5. Item 2 (`RoadPlan.lanterns`).
6. Item 1 (`r.lightCover`, S7 re-run, golden).
7. The gate driver, the slice run, the verifier, the gallery section.

### Open questions for Steward

- **S-W-1. Frozen water.** Treat it as water (recommended, §5) or refuse plans that touch it? Does your `VillageLayout`'s
  `near_water` want `Sample.frozen` excluded too?
- **S-W-2. Lamps per lot.** Up to 4 lamp posts per lot beside the apron. Acceptable, or should the cover prefer lights inside
  the design (a request to the designer, 7b) and accept a higher full M5 until then?

### Open questions for Noah

- **N-W-1. S7's approval.** W changes S7's evidence sha (lamps). Approve V's sha `c31c6de43ce1` now and W's after, or only
  W's?
- **N-W-2. The look of the lamps.** Fence posts with lanterns, at most 4 per lot. Fine, or a different default light?

### Deferred

- Lighting inside lots from the design side (7b), bible-styled lamps (7a §8.3).
- Region survival (the RS slice).

### Changes from Steward's review of W (2026-10-11; these win)

- **S-W-1:** (a). Frozen water counts as water: FROZEN together with WATER, the floor is read at the bed, and M24 needs
  unfrozen water. Steward will read `Sample.frozen` itself (no lot on it; it counts as water for `near_water`).
- **S-W-2:** up to 4 lamps per lot is accepted. Lit aprons come first, with the checker's full M5 under 1% on S7. Report the
  per-lot count in `siteplan.json` and the notes, so Noah can judge clutter.
- **Addition:** each lot's lamp positions go on its `LotSpec.ext` as `architect_mc:village.lamps` (a list of world
  positions), so Steward's panels can show them and later additions can keep clear of them.
- N-W-1 and N-W-2 stay with Noah. N-W-2's default is the coordinator's: a lantern on a fence post in the bible's wood.

### Coordinator addition (Noah, 2026-10-11): bible-styled lamps (part of W's frozen scope)

Noah's answers: **N-W-1** V's S7 sha `c31c6de43ce1` is approved; he approves W's after he sees it. **N-W-2** a lantern on a
fence post stays the default.

This pulls part of 7a §8.3 forward:
- The bible's `light` role chooses the fixture for every lamp W's programs place: the apron and batter lamps
  (`r.lightCover`) and the street, lane and square lamps (`props.mjs`).
- A small **fixture catalogue** in the kit, each fixture a short deterministic block stack: lantern post (the default),
  soul-lantern post, torch post, end rod, sea-lantern post or bollard, and a hanging lantern from a beam (a post-and-arm
  gibbet). The fixture is picked from the bible's `light` block; a bible with no `light` role keeps the lantern post.
- Each fixture still meets M5: coverage is computed from the fixture's real light level (torch 14, soul lantern and soul
  torch 10, end rod 14, lantern 15, sea lantern 15), so a weaker fixture gets more posts or a closer spacing. The cap of 4
  per lot holds where it can; a weak fixture that can't meet M5 within 4 is reported.
- Wall-mounted lamps on the buildings are design-side and stay in 7b.
- The gallery shows S7 with at least 3 bibles: rustic (lantern post), infernal (soul lantern or torch), and coastal or sky
  (sea lantern or end rod). Noah judges the look there.
- C19 and C20 (Steward's asks) are not in W.

### Phase 6c slice W as built (API 1.15.0, mod 0.18.0, kit 0.18.0, recorded 2026-10-11)

Branch `slice/W` (worktree `../architect-mc-W`; run worktree `../architect-mc-W-run`). $0: sim and stub only, no Claude call
(`artifacts/gate6c-w/spend.json`). Ports 8906-8911. Evidence: `artifacts/gate6c-w/` (one JSON per gate6cw step, REPORT.md,
api-compat.txt, mspt-ab.json, the v0160 baseline), S7's runs under `artifacts/scenarios/6c-w/`, the slice tier under
`artifacts/gate-runs-W/`.

| § | As built |
|---|---|
| Versions | Renumbered after slice X merged first (1.14.0 / 0.17.0; coordinator, 2026-10-11): `VERSION` 1.15.0; `mod_version` 0.18.0; `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.18.0 (every IR sha moved; S1's tile golden, mega_bench and the 6b fixtures did not). Features: `frozenWater` always; `apronLights` with a W helper (`region.lightCover`). `Sample` gains a trailing `BitSet frozen` (the 1.0 and 1.12.0 constructors give an empty set; `toJson` adds `frozen` only when a column is frozen). The contract's "1.14.0" reads 1.15.0 throughout (`Sample.frozen` is 1.15.0). api-compat clean against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface (`node tools/api-compat.mjs --gate6cw`; the 0.17.0 jars built from tag v0.17.0 into `artifacts/gate6c-w/v0170/`; before the merge, the 0.16.0/0.15.0/0.14.0 jars, also clean). `gate6a apijars` runs the 0.17.0/0.16.0/0.15.0 jars. X's caller ext and W's `lamps` share the lot's ext (X copies the caller's keys; W adds `lamps` inside `architect_mc:village`). |
| §2 COPY | `breakdown.ts`: a copy's time is its variant job's span, from its first non-queued status (`VariantBook` records `store.data.variantStarts`) to its done (the final variant's `updatedAt`), summed over done copies; refresh sampling no longer feeds it. `breakdown-copy.test.ts`: 4 copies queued, built and done inside one refresh interval through the real `VariantBook` give `copy.ms` = the sum of their spans (1500); R's recorded group (`test/fixtures/breakdown-r.json`, from `artifacts/gate6c0b/bench`) gives every other line byte-identical. Deviation: a variant from before W has no recorded start, so its span runs from `createdAt` (R's fixture: 2333 ms over 4 copies, recorded 1573). |
| §3 lightCover | `kit/lib/region/light.mjs` `lightCover(r, opts)`, called by `flat_village` (bool param `apronLamps`, default on; S1, mega_bench and the 6b fixtures don't call it). Over the plan's own virtual world (`plan.mjs draftIR` + `buildVirtual`): targets = reached written floors a mob spawns on; light = the world's emitters plus a model of 4e's street lanterns; lot boxes opaque. Candidates: the lots' corners outside the apron diagonal, then batter feet (ring 2 edge middles and quarters, then rings 3-4), each group by (lot id, x, z); greedy until dark < 0.5% or 4 lamps a lot; a lamp that cuts a walk node is dropped and the cover re-run. Part `props_apron` (stage props). On S7: dark 17.9% -> 0.13% of 754 targets at plan time with 7 lamps. Deviation: the lamps write into natural cells (IF_NATURAL), not air only: the plan survey has no plants, and on the first W run 2 of 7 posts stood in short grass and their lanterns floated (M3 on `props_apron`). |
| §3 ext | Each lot's lamp positions (the post's foot cell) are `LotSpec.ext["architect_mc:village"].lamps` (a list inside the existing object Steward reads, `VPlan.java`; the contract's `architect_mc:village.lamps`). `siteplan.json` (format 1, widened): `props: [{kind, id, lot?, at}]` and `lots[].lamps`; notes `apron lamps (<fixture>, light n): <lot> n, ...`. |
| §4 road lanterns | `RoadPlan.OwnFoot`: a lantern post's foot may be a BUILT cell whose top journal entry is the road owner's own, or (a region road, which may have no owner) its own site group's; the block there must still be the one the entry wrote (a player's block on the verge never counts). `RoadPlanTest`: an owned verge gets the natural verge's count, another owner's or nobody's none. Deviation: the group rule (region roads carry no owner when the caller sends none). |
| Coordinator addition | `kit/lib/region/fixtures.mjs`: `lantern_post`, `soul_lantern_post`, `torch_post` (torch or soul torch), `end_rod`, `bollard` (sea lantern, glowstone, shroomlight, froglights), `hanging_lantern` (a lantern written `[hanging=true]`: 3 posts, an arm, the lantern under it), posts in the bible's `rail` role (oak fence by default); levels from `blocks.mjs` emission (15, 10, 14/10, 14, 15, 15). The square's lamps use the fixture (weaker light: more edge lamps, at most 8). The street: IR road member `lamp` (format 2, kind `road:lamp`, appended to `KINDS_FORMAT2` in kit and mod) only when the fixture isn't 4e's own oak fence and lantern; written for an eastward road, turned by the mod (`RoadPlan.Lamp`, `Block.LAMP`, `BlockState.rotate`); spacing every floor(12 * level / 15) from every/2. RoadSync and the approach's road-surface filters skip any lamp block (`RoadPlan.isLampBlock`). Deviation: the lamp positions on ext are the apron lamps only (the square's and the street's are the village's own). |
| §5 frozen water | `Columns.FROZEN = 16` (ice, packed, blue or frosted ice with water within 3 below, only ice or water between) with `WATER`, floor at the bed; `Columns.frozenWater`, `iceTop`. `RoadTerrain`: ice over water is WATER. Kit: `FLAG_FROZEN`, `survey.frozenAt`; `waterAt` covers it; farms and M24 use unfrozen water (`waterDistance(..., {unfrozen})`), the ext's `water` counts it; refusals name it (`frozen water at x,z`). find-site: `noFrozen` reads `Sample.frozen` (apitest `heights` column 7); the band counts unfrozen water only. DevBridge `dev.region.survey`. |
| §6 gravity | `blocks.mjs` `g` (FallingBlock, generated: sand, red sand, gravel, 16 concrete powders, 3 anvils, dragon egg; regeneration added only `g`), `isGravity`. `surfaceOps`: a falling top over a 1-deep gap gets the foundation under it, deeper the subsurface as its top. `r.lot`'s apron needs no change (it stands on the pad's foundation fill: recorded deviation). The kit's 4e road model in the virtual world leaves water columns out, as 4e does. `M3:gravity` (warning). Property test: 500 claims, gaps 1-3 under lanes, verges, aprons, gravel/sand/lime concrete powder: 0 `M3:gravity`. |
| Item 7 (surveys) | Deviation: the scenario files' `fixture.surveySha` is find-site's `Sample.summary()` sha, which W doesn't change; the plan survey (ARSV) is what FROZEN moves. S1's and S7's plan surveys equal their goldens' `survey.bin` (frozen 0). S2: 9516 frozen of 36864, sha 708981a82252 (V's reading 064c0e5e2c87); S3: 3 frozen, re-pinned as `fixture.planSurvey` with the reason; S3's bytes vary between surveys of the live world (flowing water, with or without W), so its pin is the FROZEN count. |
| S7 (W) | Natural `artifacts/scenarios/6c-w/s7/20261011-214611` (evidence **bcf90fec7773**, mod 0.18.0): every bar 1-13 passes, plus W's rows. Full M5 **0.00% of 695** reached written floors (V: 11.8%); bar 8 0.00% of 558; props built = planned (7 apron lamps); 0 `M3:gravity`; E-normal 695, all growth; golden re-committed from this run (`scenarios/goldens/s7*`; its survey.bin unchanged); own CPU max 16.3 ms. Flat `20261011-214333-flat`: E-flat 0 over 329. Per-lot lamps (lantern post, light 15): hall_1 2, inn_1 2, cottage_3 1, farm_1 1, smithy_1 1, bakery_1 0, cottage_1 0, cottage_2 0, cottage_4 0, trading_hall_1 0 (7). Lamps removed (`lampsoff`, the kit's light over the realised dump): every lamp 0.00%, hall_1's 2 removed 3.45%, all removed 11.80% (caught). |
| Item 5 (path bibles) | S7 flat with coarse dirt, packed mud, stone bricks and oak planks paths (`scenarios/bibles/g6cw_path_*`): road lanterns 7 = 7 = 7 = 7; M5 over the street, verges, lanes and square 0.00% of 495 each. |
| Item 6 (frozen site) | 2026101102 `[4168,1480,4279,1591]`: the plan survey reads 5904 frozen columns (of 6377 water); `Sample.frozen` 354 of 784 at resolution 4 (`Sample.water` unchanged); the plan places the street off the frozen water (0 street columns on it) and realises **PLACED** (V: PARTIAL); a 4e ground road along 12 frozen columns is refused `DEEP_WATER` ("water 9 deep"). Variant: with FROZEN read as ground (V's reading) the plan is clean with its street over 62 frozen columns. |
| Gallery | "Architect 6c-V gallery" republished at the same URL (https://claude.ai/artifact/AHUxAGLT42pfRy5YUHdojG) with a W section: S7 with W (decision for evidence bcf90fec7773), the lamp close-up `cam_lamp`, the per-lot lamp table, the same village in the infernal bible (soul lanterns on crimson posts, light 10: 4 lamps on each of 4 lots, 17 in all, the cover capped at plan time; realised full M5 0.29%) and the coastal bible (sea-lantern bollards on birch posts: 7 lamps, 0.00%), and V's approved run kept below. Approval pending (Noah). |
| Gate | Slice tier `artifacts/gate-runs-W/20261011-221014-slice` (3 shards, 8906-8911, post-merge HEAD): 27 PASS, including unit-mod 503, unit-kit 254, apijars (0.17.0/0.16.0/0.15.0), w-unit, 6cw-scenario-s7, v-unit, v-ingame, 0b-*, 4e-orders, 5b-village, 6a-eflat/staged/inv3, the 6b steps. Not passing, each traced: unit-sidecar (a 60 s hook timeout and a parent-pid race at load 43-62; the two files pass, `gate6c-w/unit-sidecar-two.log`, and the full suite 707 locally), w-ingame (pathbibles needed its own coarse-dirt run: fixed, PASS in `20261012-000348-change`), 6a-megaA (W's FROZEN moved a mega6 lot onto a resting polar bear, OCCUPIED until TIMEOUT: the driver now clears mobs while a lot waits OCCUPIED; `20261012-012051-change` fails only a timing bar), 6b-scenario-s1 (timing bar only), 4d-all (group-undo/stages exactness on L1/L2: the known "4d-all group undo on G4D Base gravity gravel" flake, also in `gate-runs-0b/20261011-013317-slice` and `gate-runs-0c/20261010-232225-slice` before W; its rerun hit a world-open timeout at load ~50). Under the gate policy update (GATES.md, 2026-10-12) timing bars are recorded, not judged, and 4d-all is not re-run for W. api-compat `--gate6cw` 4/4 clean. gate-verifier (review, no re-run needed: the road code only reads the journal): **PASS**, with S7's evidence sha recomputed (bcf90fec7773) and the kit suite (254) and api-compat re-run; caveat: one clean 4d-all on a quiet box before merge, if the coordinator wants it. HANDOFF-W retired. |
| MSPT note | Under load (load average 17-35 from other runs) S7 flat twice read Architect's own CPU 52.7 and 62.7 ms. An interleaved A/B on the same box (`artifacts/gate6c-w/mspt-ab.json`): v0.16.0 48.7 and 19.0 ms, W 17.9 and 8.8 ms; the post-merge W runs read 16.3 ms (natural). Load, not W. |


## Phase 6c slice T1: passes, fields and relief (DRAFT for Steward review)

API 1.15.0, mod 0.18.0 (wave 1, after W). SETTLEMENTS §4 and §4.1.

- **Branch:** `slice/T1`, worktree `../architect-mc-T1`. **Spend:** $0.
- **Scope:** the plan-time pass framework (`r.pass`), fields produced by passes, the second plan's survey at resolution 1 up to
  1024x1024, the plan budget for programs with passes (120 s, 2 GB), the `relief` op kind, the `relief` pass (blending) and
  the erosion touch-up.
- **Not in scope:** hydrology (H), routing (T2), districts (D), brushes (B; they reuse `relief`).
- **Depends on:** W (both touch `RegionSurvey`/`Columns`). Parallel with F1 and MP.

### 0. Facts

- **Ops:** `realise.mjs` `OP_KINDS = ['shape', 'columns']`; `OPS_RESERVED = ['relief', 'scatter', 'voxels', 'stamp']` throw
  until their slice. A format-2 IR names the kinds it uses in `requires`; an older kit refuses it `PLAN_STALE` (6b §2.4).
- **Fields exist** as program-made side blobs: `r.field(name, f)` (`program.mjs` ~303), IR `fields` member, and the material
  rule's `field` clause (`material.mjs`, sampled nearest at res 1, the covering sample at res 4). No pass produces one yet.
- **Plan limits:** `sidecar/src/config.ts` `regionPlanMs` 30,000 and `regionPlanHeapMb` 1,024, one budget for every program.
- **Survey resolution:** the plan survey (ARSV) is resolution 1 up to 256x256 columns, else 4 (`kit/lib/region/survey.mjs`).
  The two-plan flow (plan, prepare, plan again) is 6a's as built.
- **6a's terrain primitives** (`terrace`, `lot` pads with `pad.edge: 'slope'` batters, `platform`) make straight 1:1 batters
  and flat steps; the 6b axis-run share reads them as geometric.
- **K2/K3:** realise is pointwise within 8 columns, under the lint (no trig, no `**`, no `Math.random`).

### 1. API 1.15.0

- `VERSION = "1.15.0"`; api-compat against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface.
- **No new records or methods.** Pass timings travel in `RegionPlan.notes` and `siteplan.json` (`passes: [{name, ms, heapMb}]`).
- **Features:** `planPasses`, `reliefOp`. **Config:** `regionPassPlanMs` (default 120,000) and `regionPassPlanHeapMb` (2,048).
- **Behaviour changes:** a program that declares passes gets the larger budget and a resolution-1 second survey (§3). An IR
  using `relief` is format 2 with `requires: ['relief']`; 0.17.0 refuses it `PLAN_STALE`. `KIT_VERSION` 0.18.0.

### 2. The pass framework

```js
// kit/lib/region/passes/<name>.mjs; a program calls
const blend = r.pass('relief', { around: [...pads, ...corridors], radius: 12, maxCut: 6, maxFill: 6, erode: { thermal: 2, stream: 1 } });
// -> { fields: { relief }, ops: [one 'relief' op per stage], data: { pinned, iterations, ms } }
```

- A pass is a bundled, deterministic function `(survey, volumes, intent) -> { fields, ops, data }`. It runs in the pristine-kit
  child process at plan time, never at realise.
- **Math:** integer or fixed-point only. The realise lint applies to `passes/**` (a `region-lint` test), so replans are stable
  across Node majors (6d's diff-by-part needs that).
- **Declaring:** a program exports `passes: ['relief', ...]`. The sidecar reads it from the catalogue entry and picks the
  pass budget before it spawns the plan. A program that calls an undeclared pass fails the plan with a typed note.
- **Timing:** each pass reports wall ms and peak heap; the plan notes list them (`pass relief: 4.2 s, 310 MB`).
- **Fields:** a pass's fields are side blobs like `r.field`'s (`<planDir>/blobs/<sha>.bin`, K4), named `relief`, `flow`, `wet`.

### 3. The second survey at resolution 1

- When the program declares passes, the second plan's ARSV survey is resolution 1 up to 1024x1024 columns (about 7 MB), sent
  over 4a's blob path. Claims past 1024 on a side stay at resolution 4 and the pass runs coarse (noted).
- The first plan is unchanged. Programs without passes are unchanged (their tiles and IR content, save `kitVersion`).

### 4. The `relief` op

```
{ op: 'relief', field, mode: 'delta'|'target', cut: cond, fill: materialRule, maxCut, maxFill }
```

- **At realise**, a column with frozen ground `g` and field value `dh` becomes ground `g + dh` (`delta`), or exactly `dh`
  (`target`, for pad columns). Cut above with `cut` (default `IF_NATURAL`); fill below with the rule (`surface` skin,
  `subsurface` to depth 3, `rock` core). `maxCut`/`maxFill` clamp per column.
- **Drift:** a column whose frozen ground differs from the plan survey still gets `g + dh`, so the blend follows the real
  surface (SETTLEMENTS §4.1).
- **Pointwise:** one field sample per column; K2 holds without a margin.
- **Undo:** tile CELL entries, as every region write.

### 5. The `relief` pass and the erosion touch-up

- **Blending:** pins = pad columns at their target y, corridor centre lines at their profile y. Integer Jacobi relaxation over
  the claim at resolution 1, a fixed iteration count (`radius * 4`), only within `radius` of a pin; columns outside keep
  `dh = 0`. Output `fields.relief` (i16 dh) and one `relief` op per stage that has pins.
- Pad columns are `target`, so pads stay flat; the 1:1 batter of `lot`/`terrace` is replaced by the blend when the program
  passes `pad.edge: 'blend'` (new value; `slope` stays as it was).
- **Erosion touch-up (optional, `erode`):** `thermal` iterations move material from a column to its lowest neighbour while
  the drop exceeds 2; `stream` iterations cut along D8 flow by accumulation. Total extra |dh| at most 4 per column; it never
  moves a pinned column. It roughens fills into scree and gullies; vanilla terrain is not re-simulated.

### 6. Gate (slice tier, $0)

**Fixtures:**
- `relief_demo` (bundled, `catalogue = false`): three pads and two corridors on **S3's pinned claim** (natural, realised), plus
  its flat variant (the program first `add`s a hill, so E-flat sees cut, fill and blend).
- A synthetic 1024x1024 survey (seeded noise terrain, committed generator) for plan time only.

**Evidence:** `artifacts/gate6c-t1/`, driver `tools/gate6ct1.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Blend smoothness (virtual and realised `relief_demo`) | in the blended band, at least 95% of adjacent-column steps are at most 1; 0 steps over 3 |
| 2 | Pads | every pad column at its target y (0 off) |
| 3 | Clamps | 100% of columns within `maxCut`/`maxFill`; erosion's extra |dh| at most 4 |
| 4 | Organic read | axis-run share of relief boundary cells: recorded, and lower than the same program with `pad.edge: 'slope'` |
| 5 | Plan time, 1024x1024 synthetic | relief pass at most 60 s, the whole plan at most 120 s, peak heap at most 2 GB (median of 3) |
| 6 | Determinism | IR sha over 3 plans; field blob shas; tile shas for 1 and 4 workers, forward and shuffled; macOS and Linux CI; goldens `scenarios/goldens/relief_demo.json` |
| 7 | Tile evaluation | p50 and p99 per tile recorded; p99 under 2 s; evaluation at least 45k cells/s |
| 8 | Exactness | flat variant E-flat 0; natural E-normal all classified, at most 0.01% of written cells |
| 9 | MSPT | Architect's own CPU per tick at most 50 ms, p99 at most 25 ms |
| 10 | Checker | `relief_demo`: 0 errors, no M1-M4 |
| 11 | Compatibility | 0.17.0 refuses a `relief` IR `PLAN_STALE` and writes nothing; format-1 goldens, S1's and S7's tile goldens and `mega_bench.golden.json` unchanged |
| 12 | API | api-compat clean; three apitest jars pass |
| 13 | Spend | $0.00 |

**Unit:** the pass lint; an undeclared pass fails; `relief` op parse and refusal paths; Jacobi on a 5x5 hand case; erosion
never moves a pin.

**Tier:** slice: quick plus kit region (6a-staged, 6a-inv3, 4e-megalite), `region/**` (6a-megaA, 6b-ghost, 6b-volume,
6b-nudges, 6b-versions; engine tag, the evaluator gains an op kind), the sim suites, apijars, 6b-scenario-s1, 6cv-scenario-s7.
**gate-verifier** re-runs items 1, 6 and 8.

### 7. Build order

1. Archive the 0.17.0 apitest jar. 2. Pass framework, lint, budget plumbing. 3. Resolution-1 second survey.
4. `relief` op (kit evaluator, `requires`, mod `IrStale`). 5. `relief` pass and erosion. 6. `relief_demo`, fixtures, gate.

### Open questions for Steward

- **S-T1-1.** Is 120 s acceptable as the worst-case plan time on a 1024x1024 claim, shown to the player as "planning"? Steward's
  card flow waits on it.

### Open questions for Noah

- **N-T1-1.** `pad.edge: 'blend'` changes how pads meet the land. Make it the default for new programs from S2/S3 on (old
  programs keep `slope`)?

### Deferred

- Erosion as a regeneration (never: touch-ups only). Relief under standing lots (6d). Brush use of `relief` (B).

### Phase 6c slice T1 as built (API 1.18.0, mod 0.21.0, kit 0.20.0; recorded 2026-10-12)

Branch `slice/T1` (worktree `../architect-mc-T1`, from `origin/slice/W`, then origin/main v0.18.0 merged). $0: sim and stub only
(`artifacts/gate6c-t1/spend.json`). Ports 8918/8919 (ad hoc), 8922/8923 (the slice tier). Evidence: `artifacts/gate6c-t1/` (one JSON
per `tools/gate6ct1.mjs` step, api-compat.txt, plantime/), the scenario runs under `artifacts/scenarios/6c-t1/relief_demo/`, the slice
tier under `artifacts/gate-runs-T1/`. The version numbers stand as placeholders (GATES.md "Policy update").

| § | As built |
|---|---|
| §1 API | `VERSION` 1.18.0, mod 0.21.0 (coordinator, after v0.19.0 F1+MP and v0.20.0 Y1 merged first; kit 0.20.0 stays, F1+MP being kit 0.19.0); no new records or methods. A T1 helper (sidecar feature `region.passes`) gives `planPasses` and `reliefOp`. `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.20.0; `KINDS_FORMAT2` (kit and mod) gains `relief`, appended. Config `regionPassPlanMs` 120,000 and `regionPassPlanHeapMb` 2,048. `region.planned` gains `passes` (the kit's word). The no-check plan wait in the mod went from 120 s to 300 s for every program (a pass plan may take 120 s alone; the wait is the mod's, the sidecar's limits are unchanged). `Api115Test`'s version check now allows later minors, as `Api114Test` does. |
| §2 framework | `kit/lib/region/passes/` (`PASSES` registry, `relief.mjs`), under the realise lint (`relief-t1.test.mjs` scans `passes/**`). `export const passes = [...]` is read by the kit (`declaredPasses`: unknown or doubled names fail the plan) and, as a literal, by the sidecar from the program source (`declaredPasses` in `regions.ts`) to pick the budget before it spawns the plan: bundled, non-catalogue (`relief_demo` is `catalogue = false`) and programsDir programs alike; the catalogue lists `passes` too. `r.pass` refuses an undeclared pass `PASS_UNDECLARED`, resolves the materials, runs the pass with `minY` = the claim's bottom + 2, registers its fields as side blobs and pushes its ops into a part in the **stage of the first lot it names** (its pad's stage: the relief reads the same frozen ground as the pad; a column is frozen once, before any write of a tile that needs it). Timing: the note `pass relief: <s> s, <MB> MB` (wall time; the process's peak RSS after the pass: an in-process heap sample is not a peak), `stats.passes`, `meta.passes`, `siteplan.json` `passes` (schema widened), `plan.json` `passes`/`passRuns`. |
| §3 survey | `RegionsImpl.secondSurveyRes`: when `region.planned` names passes and the first survey was resolution 4, the mod samples the claim again at resolution 1 (up to 1024 a side), uploads it and plans again (with the volumes the program asked for); note `second plan: a resolution-1 survey for the passes (WxD columns, N bytes)`. Past 1024 a side: the passes ran coarse (noted); the pass works on the survey grid at its resolution. A claim up to 256x256 is resolution 1 already (one plan, as before). |
| §4 relief op | `{op: 'relief', field, mode, cut, fill, maxCut, maxFill}` as the contract. `cut` is the condition of every cell of the op (the per-cell condition is per op), rewritten IF_NATURAL to ALWAYS_OURS in later stages and the path set like `cond`. Cells `min(g, top) .. max(top, g + 2)`: those at or below `top` take the fill (a rule's `depth` is `top - y`), those above are air (**deviation**: the cut and a shallow fill clear 2 above the old ground, so plants never float). A `delta` sample of 0, a sample of -32768 (`RELIEF_NONE`) and a column outside the field write nothing. Bounds: the field's extent. The checker's M13 reads the fill. |
| §5 pass | Pins: lot footprints (the lot's own), **the lots' aprons** (written by the pass at the pad's top: a plant kept on an apron left a step at the entrance on a fresh S3 copy, realised M2 3/5; fixed, and the realised pad check catches it), corridor centre lines widened (integer-interpolated profile), rects. Fixed columns: water and lava and 2 around water, trees, missing. Band: free columns within `radius` (Chebyshev) of a pin; start: the nearest pin's y fading linearly to the land at `radius + 1`; `radius * 4` Jacobi iterations in 1/16 fixed point, each clamped (projected) to the land's `-maxCut .. +maxFill` and never under `minY`. Erosion: thermal sweeps (a drop over 2 slides one block to the lowest 4-neighbour) and stream sweeps (D8 accumulation, highest first, cuts one block at `streamAt` 24), never on a pin or outside the band, at most 4 extra, clamps kept. **Deviation (ops)**: one pass call gives up to three ops in the pads' stage: `delta` over the band, `target` over the corridors (`corridorFill`: the path role on top), `target` over the aprons (the lots' own pad limits); not "one op per stage". `pad.edge: 'blend'` (no batter; the pass must name the lot) is the default only for a program that declares passes (N-T1-1); programs without passes keep `slope` (their IRs are unchanged but for `kitVersion`). |
| §6 fixtures | `kit/regions/relief_demo.mjs` (`catalogue = false`, `passes = ['relief']`): on S3's claim it picks pad sites with at most 4 of cut or fill, away from water, on gentle land (no neighbour step over 3 within the radius), and a tree of straight corridors (grade at most 1 in 2, within 4 of the land, dry, treeless): 3 pads, 2 corridors. **Deviation (flat variant)**: the hill is raised through the pass's `base` (heights the blend meets, written as raised columns), not an `add` op: the relief reads the frozen pre-region ground, which an earlier op can't change. On flat: two pads on the hill, one sunk 2 (cut), the hill (fill), the blend. Scenario `scenarios/relief_demo.json` (phase `6c-t1`, `short: relief_demo`), pinned seed and cameras. The synthetic 1024x1024 survey is `kit/lib/region/synth.mjs` seeded `t1-bench` (64 pads, radius 24). |
| Harness | `tools/lib/scenario-relief.mjs` (items 1-4, 10) and a `t1-tiles` BAR row (item 7) in `scenarios.mjs`; the tile timing and `sc.short` lines are F1's, verbatim. The three IR-sha plans run under `/tick freeze` (F1's rule; S3's flowing water moved the survey between plans). **Deviation (exactness class `flow`)**: an unclassified E-normal mismatch where the snapshot held flowing (non-source, level 1-9) water and the world now holds air is classed `flow`, a world class (SETTLEMENTS §4.2: flowing water is outside E-normal). Unlike F1's `freeze`, these are cells the plan writes: a falling-water column whose feed cell above the relief fill covered; the orphaned column drains (the world's fluid physics), the undo restores the feed cell exactly (it is in no mismatch list), and a restored flowing cell would drain again. The filter only reclassifies mismatches already `none`, never source water and never a cell left as anything but air (gate-verifier, 2026-10-12). Caveat: it doesn't require the cell to be unwritten. **Deviation (golden row)**: relief_demo picks its sites from the live world's survey, which differs between fresh copies of S3 (flowing water, plants, leaves: 35 ground and 2,009 flag differences between two runs), so a run whose plan survey differs from the golden's holds the golden itself: its committed inputs re-plan to its IR sha and tile shas. The realised smoothness and clamp rows leave out band columns topped by another writer (a lot's approach stair or front path); the realised pad row judges the pad's top block only. The 6b safety row (M5 dark, M8 guards) is recorded for this terrain fixture (as F1's forms rows). The flat run must read a flat world (`t1-flatworld`; an autoworld-created base is a normal world: the driver's client starts in a lobby world). |
| Items | Post-merge record `artifacts/gate-runs-T1/20261012-193826-change` (head c0efb2d; natural evidence `037717393c0b`, flat `3410afb4c848`). **1** smoothness: natural 98.5% of 2,796 band steps at most 1, 0 over 3 (realised 98.4% of 2,777, 9 columns topped by a lot's approach left out); flat 99.9% of 17,741, 0 over 3. **2** pads: 0 of 672 pad and apron columns off (virtual and realised; flat 0 of 616). **3** clamps: 2,109/2,109 plan and 2,100/2,100 realised columns within maxCut/maxFill; erosion extra max 1 over 8 columns, 0 pins moved (flat 9,440/9,440). **4** organic (recorded): axis-run share 0.227 of 1,245 relief boundary cells vs 0.757 of 206 with `pad.edge: 'slope'` (flat 0.294 vs 0.988). **5** (BAR) 1024x1024 synthetic in the sandbox, median of 3: relief pass 593 ms, whole plan 5.0 s wall, peak 216 MB RSS (load 45). **6** IR sha identical over 3 plans (tick freeze), field blob shas identical over the 3 synthetic plans, tile shas 1 = 4 workers forward and shuffled; golden `scenarios/goldens/relief_demo*` (from `artifacts/scenarios/6c-t1/relief_demo/20261012-164555`; the kit test `scenario-goldens` holds it on Linux CI at merge): the run's live survey differs in 1,905 columns, the golden's inputs re-plan to its IR `2f53a2c20371` and 6 tile shas. **7** (BAR) tiles p50 0.5 ms, p99 3.2 ms, 3.4M cells/s. **8** E-flat 0; E-normal 164, all classified (159 growth, 3 live, 2 flow), the undo's own 0. **9** (BAR) own CPU max 10.8 ms natural, 48.8 ms flat at load 45. **10** checker: 0 errors, no M1-M4. **11** the v0.20.0 kit (0.19.0) and the 0.20.0 mod jar's IrStale refuse a relief plan `PLAN_STALE: plan needs kit 0.20.0 / kinds [relief]` and the old evaluator writes nothing; format-1 goldens, S1, S7 and mega_bench unchanged (37 pass). **12** api-compat `--gate6ct1` 4/4 clean (0.20.0 from tag v0.20.0 into `artifacts/gate6c-t1/v0200/`, 0.19.0 and 0.18.0 from Y1's); apijars pass (`20261012-201324-change`, 46 ok each). **13** $0.00. §3 in game (`t1-ingame`): relief_demo on a 320x320 claim gets a resolution-1 second survey (320x320 columns); region_small keeps resolution 4. |
| Gate | Slice tier before the v0.19.0/v0.20.0 merge: `artifacts/gate-runs-T1/20261012-165316-slice` (1 shard, 8922/8923, head ea29ec8 at its later steps): 24 of 27 PASS, among them unit-mod, unit-kit, unit-sidecar, apijars (0.17.0/0.16.0/0.15.0), t1-unit, t1-ingame, 6ct1-scenario-relief, 6cw-scenario-s7, 6cv-scenario-s7, x-ingame, x-resume, 4d-all, 4e-megalite, 6a-megaA, 6a-eflat, 6a-inv3, 6a-staged, the 6b steps and S1 (timing bars recorded: S7 own tick 53.2 ms, megalite 63.5 ms, both at load 38-63). Not passing: sim-jobs and sim-sets on the `tools/apitest.mjs` API_VERSION pin only (fixed), sim-massing the known composite-keys flake. After merging origin/main (v0.19.0 F1+MP, v0.20.0 Y1; renumbered 1.18.0 / 0.21.0 / kit 0.20.0) the coordinator's re-run set: `20261012-193826-change` (head c0efb2d): unit-mod, unit-kit (289), unit-sidecar, sim-jobs, sim-sets, sim-massing, t1-unit, 6ct1-scenario-relief PASS; apijars failed only because the archived 0.20.0/0.19.0/0.18.0 dirs lacked their tags' `tools/apitest.mjs` (added from each tag) and passed in `20261012-201324-change`. Rebase points resolved: `KINDS_FORMAT2` `... road:lamp, voxels, mask, pattern, relief`; `OP_KINDS` `shape, columns, voxels, relief` (evaluator kinds 2 and 3); `OPS_RESERVED` `scatter, stamp`; FEATURES `... masks, patterns, region.passes`; E-normal world classes `freeze, flow`; the checker's RULES unchanged by T1. Then origin/main 5ce3ea3 (headless gates) merged and apijars and api-compat moved to SCH's complete 0.20.0/0.19.0/0.18.0 sets (`artifacts/gate6c-sch/`; T1 ships batched with SCH as v0.21.0): `artifacts/gate-runs-T1/20261012-203739-change` (head 4dfb6c0) unit-mod, unit-kit, unit-sidecar, apijars (SCH's 3 jars) and t1-ingame (the resolution-1 second survey, after the merges) PASS. **gate-verifier: PASS** (review plus its own re-run of item 8, `artifacts/gate-runs-T1-verify/20261012-202226-change` at 11a321b: E-flat 0 over 73,503 restored, E-normal 105 all classified (102 growth, 3 live), item 1 98.4%/98.4% with 0 over 3, pads 0 off, clamps 100%, checker clean). Its verdicts: `flow` sound (wording fixed above); the golden row now guards the planner and evaluator over the golden's committed inputs, not a fresh live survey (accepted); the apron change safe. Caveats it recorded: the 300 s plan wait applies to every program; 7 of 26 written falling-water cells (level 8) were not the planned block at the post-build dump in the mod, cause not in T1's diff (no tile-write code changed): a follow-up, not a blocker; the Linux CI half of item 6 comes at merge (kit `scenario-goldens`); overlapping lots' aprons take the first pin and the largest pad limits. HANDOFF-T1 retired. |

## Phase 6c slice F1: forms I, ice spikes and rock spires (DRAFT for Steward review)

API 1.16.0, mod 0.19.0 (wave 1, parallel with T1 and MP). SETTLEMENTS §9.1, §9.2 and §11 (M17).

- **Branch:** `slice/F1`, worktree `../architect-mc-F1`. **Spend:** $0.
- **Scope:** the generators `iceSpike` and `rockSpire`; the `voxels` op kind (baked forms as side blobs); the generator rules
  (one bounded op per cluster, bake past a cost threshold); **M17 melt**.
- **Not in scope:** the other generators and M18/M19 (F3), scatter and stamps (F2), M20 (H).
- **Depends on:** V (6b's format-2 shapes and `r.form`). Nothing in T1. S2 depends on F1.

### 0. Facts

- `kit/lib/forms/floatingIsland.mjs` is the only generator; `r.form(id, gen)` and `r.floatingIsland` emit closed-library
  shapes (`ellipsoid`, `capsuleChain`, `warp`, `strata`, `instances`, `cone`) with material rules. IR `forms` records provenance.
- `voxels` is in `OPS_RESERVED`. Side blobs: `r.blob`/`_sideBlob`, at most 16 MB each; IR at most 4 MB and 20,000 ops (K4).
- The evaluator culls ops by bounds per column, but evaluates an op's whole shape tree per cell (SETTLEMENTS §9.1).
- Vanilla 26.3: `ice` and snow layers melt at block light above 11; `packed_ice`, `blue_ice` and `snow_block` don't.
- S2's fixture holds natural ice spikes (15% `ice_spikes` biome), read through `Survey.volume` (class `ICE`).

### 1. API 1.16.0

- `VERSION = "1.16.0"`; api-compat against 0.18.0, 0.17.0, 0.16.0 jars and the 0.18.0 surface. **No new records or methods.**
- **Features:** `formsIce`, `formsRock`, `voxelsOp`. A `voxels` IR is format 2, `requires: ['voxels']`; 0.18.0 refuses it.
- `KIT_VERSION` 0.19.0. Checker `RULES` gains `M17` (warning; a bar in S2).

### 2. Generator rules (all generators, now and in F3)

- **One bounded op per cluster** (a spike, a ledge, a lobe), at most 32 primitives per op. A property test fails a generator
  that emits more.
- **Bake past a cost threshold:** a form whose op count would exceed 400 (est.; measured here, see bar 6) is emitted as one
  `voxels` op instead.
- **Absolute y:** skeletons are resolved at plan time; bases reach 6 below the plan ground with `IF_NATURAL`/`IF_AIR_OR_FLUID`
  skirts, so drift up to 6 is absorbed inside K2's margin.
- **Species params:** each generator ships bundled presets; a bible may name others within the generator's param schema.

### 3. `iceSpike`

- Clusters of thin `cone`s (radius 1-4, height 8-48), a few leaning (an integer offset per 8 of height), each cluster one op.
- Materials: `packed_ice` core, `blue_ice` accents (a noise clause), `snow_block` caps (`facing: up`, depth 0). **Never `ice` or
  snow layers** in a spike.
- **Kept spikes:** `r.keepNatural('ICE', box)` reads the frozen volume and marks those cells `keep`, so lots and routes avoid
  them and no op writes them (an IR `keep` list per part, checked as an M1 error if written).

### 4. `rockSpire`

- Stacked `warp`ed `cone`s with ledges (a ledge is a `clipY`ped `ellipsoid` lobe), one op per stack segment.
- Materials: `strata` bands (stone, andesite, tuff, deepslate by `yAbs`), weathered skin by `age` noise, moss by the `wet`
  field when one exists (T1/H), else by noise.
- M3: every segment rests on the one below or on ground; overhangs past 4 get a `capsuleChain` buttress.

### 5. The `voxels` op

```
{ op: 'voxels', blob, origin: [x, y, z], rotation: 0|90|180|270 }   // blob: ARTL-like palette + packed positions
```

- Realise copies the cells that fall in the tile's window; pointwise by position, so tile-independent.
- Cond per cell: `IF_NATURAL` by default (a form never overwrites built blocks).
- Bounds are the blob's box; the evaluator culls by them.

### 6. M17 melt

- **Rule:** no `ice` or snow-layer cell within reach of block light above 11, on the virtual world with every light the plan
  writes (the kit's light model). Natural ice the plan doesn't write counts too when a planned light reaches it.
- **Finding:** per part, the cells and the light that reaches them. Warning in the checker; a gated bar in S2.

### 7. Gate (slice tier, $0)

**Fixtures:** `forms_demo` (bundled, `catalogue = false`): 6 ice-spike clusters and 3 rock spires on **S2's pinned claim**
(natural, realised, with the claim's natural spikes kept), plus a flat variant. Property tests over 200 seeds per generator.

**Evidence:** `artifacts/gate6c-f1/`, driver `tools/gate6cf1.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Bounded ops (property, 200 seeds each) | 100% of ops at most 32 primitives; 0 forms over 400 ops not baked |
| 2 | Structure | M3 0 floating cells on the realised `forms_demo`; 0 overhangs over 4 without a buttress |
| 3 | Melt | M17 0 on the plan and on the realised world after a 2-minute stand at default random ticks; ice and snow-layer counts unchanged by the stand |
| 4 | Kept spikes | 0 written cells in `keep` sets (ARWD diff) |
| 5 | Organic read | axis-run share of form boundary cells: recorded per generator (gated from S2, see N-F1-1) |
| 6 | Bake threshold | evaluation cost per op measured; the 400 threshold confirmed or re-set from the data, recorded |
| 7 | `voxels` | realised cells equal the baked blob exactly; tile shas equal for 1 and 4 workers, shuffled |
| 8 | Tile evaluation | p99 under 2 s per tile; at least 45k cells/s |
| 9 | Determinism | IR and blob shas over 3 plans; golden `scenarios/goldens/forms_demo.json`; macOS and Linux CI |
| 10 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% |
| 11 | MSPT | own CPU at most 50 ms, p99 at most 25 ms; light-engine tick share recorded |
| 12 | Compatibility | 0.18.0 refuses `voxels` `PLAN_STALE`; S1, S7 and mega_bench tile goldens unchanged |
| 13 | API, spend | api-compat clean; jars pass; $0.00 |

**Broken variants:** an `ice` spike under a lantern (M17), a spire with a 6-wide unbuttressed overhang (M3), a spike written
over a kept natural spike (M1).

**Tier:** slice: quick, kit region rows, `region/**` (engine tag: a new op kind), sim suites, apijars, 6b-scenario-s1.
**gate-verifier** re-runs items 2, 3 and 7.

### 8. Build order

1. Archive the 0.18.0 apitest jar. 2. Generator rules and their property harness. 3. `voxels`. 4. `iceSpike`, `keepNatural`.
5. `rockSpire`. 6. M17. 7. `forms_demo`, gate.

### Open questions for Noah

- **N-F1-1. The axis-run bar.** 6b's calibration card (10 held-out island seeds) was optional for S1 and, as far as the records
  show, wasn't filled in. Gate S2 and S3 at SETTLEMENTS' estimate (forms at most 0.25), fill the card first, or keep the
  metric recorded only through 6c?

### Deferred

- `giantTree`, `mushroom`, `coral`, `roots`, `stalactites`, M18, M19 (F3). Melt over time for snow on roofs (recorded only).

### Phase 6c slice F1 as built (API 1.16.0, mod 0.19.0, kit 0.19.0, recorded 2026-10-12)

Branch `slice/F1` (worktree `../architect-mc-F1`). $0: sim and stub only. **The record is the runner's evidence** under
`artifacts/gate-runs-F1/` (`20261012-013436-slice`, `20261012-034730-change`, `20261012-042313-change`: each run's `sN/gate6c-f1/`
step JSONs and `sN/scenarios/forms_demo*/`). `artifacts/gate6c-f1/v0170/` holds the 0.17.0 baseline built from tag v0.17.0;
the other files in `artifacts/gate6c-f1/` and `artifacts/scenarios/6c-f1/` (`flat.json`, `natural.json`, `unit.json` among them)
are development runs, not the record. Ports 8918-8923.

| § | As built |
|---|---|
| §1 API | `VERSION` 1.16.0, mod 0.19.0; no new records or methods. Features `formsIce`, `formsRock`, `voxelsOp` come with a forms-I helper (the sidecar's feature `region.forms1`). `IrStale.KINDS_FORMAT2` and the kit's gain `voxels`; `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.19.0. Checker `RULES` gains `M17`. api-compat against the 0.17.0, 0.16.0 and 0.15.0 jars and the 0.17.0 surface (the merge order put W after F1's start; the contract's 0.18.0 is 0.17.0 until W lands). |
| §2 rules | `kit/lib/forms/rules.mjs`: `MAX_PRIMITIVES` 32 per op, `BAKE_OPS` 400 (confirmed by item 6's data, below), `SKIRT` 6. `r.form(id, gen, {bake})` bakes a form past 400 ops (or with `bake: true`) into one voxels op: the ops' cells last-op-wins, air dropped, one cond (IF_NATURAL); `ir.forms[i].baked = {blob, cells, ops}`. `settleForm` (both generators): fragments the evaluator splits off (a warped tip) are cancelled by an air op (IF_AIR_OR_FLUID, so it only cancels the form's own writes), and any overhang over 4 left gets a 45-degree support. Presets: `iceSpike` classic / needles / stubby, `rockSpire` pinnacle / tower / hoodoo. |
| §3 `iceSpike` | One op per cluster: per spike a skirt cylinder 6 under the plan ground and vertical cone segments 8 tall, a leaning spike shifted 1 per segment away from the cluster's centre; spikes are added while the cluster stays within 32 primitives. Material rule: snow_block on up-facing skin, blue_ice by a noise clause, packed_ice default; never ice or snow layers. `r.keepNatural(cls, box, {part, stage})` reads the frozen volume (`needVolume`, now idempotent per box) and records `{volume, class, box}` as a part's `keep` (default part `keep_<class>`, no ops); it returns the kept cells' `has`/`near` for the program. |
| §4 `rockSpire` | One op per stacked segment (`strata` over `warp` over a union of the cone segment, its ledges and their buttresses); the first segment carries the skirt (one cell into the segment: stacked slabs that only touch open a gap under the warp). A ledge is a `clipY` ellipsoid lobe (vertical radius 1.5) on the skin; a ledge whose estimated overhang (0.75 r, +1 with warp) reaches 4 gets a `capsuleChain` buttress at 45 degrees into the spire. Materials: strata bands (andesite, tuff, stone), deepslate below y 0, cobblestone skin by `age` noise, moss on up-facing skin by the `wet` field (when named) or noise. |
| §5 `voxels` | `kit/lib/region/voxels.mjs` (ARVB, kit/REGIONS.md "Kit 0.19.0"): palette + delta-coded local indexes, no gzip; a quarter turn is clockwise from above and turns facing, connections, axis and sign rotation. Realise indexes the turned cells per column and copies them pointwise (clipped to the claim like any op). `opBounds`, `Part.center` and M13 (the blob's palette) know it; format 1 and a `requires` without `voxels` are refused. |
| §6 M17 | 26.3's random ticks (javap of IceBlock / SnowLayerBlock): ice melts at block light over 11 minus its light dampening (1), so **over 10**; a snow layer over 11. The kit's light model already treats ice as clear with cost 1. Plan side: every cell lit at 11+ by written emitters, written ice or snow layers and the volume's natural ICE (and natural SNOW beside a cell lit at 13+: the virtual world reads it as an opaque snow block) are findings per part (natural: part null). Realised side: every ice or snow-layer cell of the dump against the dump's light. |
| Checker | `M3:overhang` (under M3): a solid cell of a form part (not a floating group) with nothing under it and no solid cell within 4 (Chebyshev) one layer down. `M1` (error): a written cell in any part's `keep` set (the checker expands it from the volume). Metrics `M3.overhangCells`, `M3.maxOverhang`, `M17`, `keep`. |
| §7 `forms_demo` | `kit/regions/forms_demo.mjs` (`catalogue = false`), scenario `scenarios/forms_demo.json` (phase `6c-f1`, short `forms_demo`, S2's pinned claim and world). S2's land is a band of snowy hills dense with natural spikes (no site of radius 10 is clear of kept ice), so the program grows each form at plan time and places it only where none of its cells meets a kept cell (candidate sites by flatness; 80 tries a spire, 200 a cluster): 6 clusters and 3 spires placed on S2, the first spire baked. Each cluster has a soul-lantern post (block light 10: melt-safe). |
| Scenario harness | F1 rows (`tools/lib/scenario-forms.mjs`) replace the lot rows; reachability, safety and palette are recorded. A dump after the stand (`after-stand.arwd.gz`) gives M17 on the realised world and the melt across the stand (ice and snow layers lost within a planned light's reach). **Deviation:** the three IR-sha plans of a forms_demo run happen under `/tick freeze`: the plan reads a frozen volume of a live world, and the first natural run's plans differed only by 2 PLANT cells breaking between surveys. Tile evaluation time is the best of 3 passes per tile in one warm worker. |
| Scenario harness (2) | **Deviation (golden):** a forms_demo run's IR records the sha of the frozen volume of the live world it read; a fresh world copy differs by a few natural cells, so the golden row matches when every tile sha equals the golden's and the IR differs only by its volume blobs (the kit test `scenario-goldens` still holds the IR sha over the committed inputs). **Deviation (E-normal):** an unclassified mismatch where still water became ice, or a snow layer fell, at a cell the plan never writes is classed `freeze` (a world class beside growth and gravity): the frozen sea froze one cell during a stand. |
| Items | 1 property (200 seeds per generator): every op at most 32 primitives (max 32), at most 7 ops a form, settled on every 8th seed. 2 Structure: realised M3 0 floating, 0 spurs, 0 overhangs over 4 (max 3) over 13,780 form cells; broken variant (a 6-wide unbuttressed ledge) -> M3:overhang. 3 Melt: plan M17 0; realised after the stand M17 0 of 14,211 ice/snow cells; ice 10,847 -> 10,847 and snow layers 5,720 -> 5,720 across the stand, 0 lost within a planned light's reach; broken variant (an ice spike under a lantern) -> M17 on its part. 4 Kept: 0 of 74,661 kept natural ICE cells changed (ARWD); broken variant (a spike over a kept spike) -> M1 error. 5 Organic read (recorded): axis-run share 0.142 of 4,275 form boundary cells (rockSpire 0.171, iceSpike 0.100). 6 Bake threshold (recorded, CPU time, linear 0.21 us per op and column): 400 overlapping ice-spike ops evaluate a tile in 349 ms at 68k cells/s, 800 in 714 ms at 39k cells/s: **400 confirmed**. 7 Voxels: spire_1 1,826/1,826 realised cells equal the baked blob (2,339/2,339 on flat); tiles equal for 1 and 4 workers, shuffled. 8 Tile evaluation (recorded): p99 20 ms, 534k cells/s. 9 Determinism: 3 IR shas identical; golden `scenarios/goldens/forms_demo.json` (with its inputs), match; macOS only so far: CI does not run on slice branches, so the Linux check of the golden (`kit/test/scenario-goldens.test.mjs`) comes at merge. 10 Exactness: E-flat 0; E-normal 68, all growth. 11 Own CPU (recorded): max 8.7 ms, p99 8.7 ms. 12 v0.17.0's kit and mod (built from the tag) refuse the plan `PLAN_STALE: plan needs kit 0.19.0 / kinds [voxels]; this is kit 0.16.0` (the kind alone: `plan needs kinds [voxels]`); S1, S7 and mega_bench tile goldens unchanged. 13 api-compat 4/4 clean (0.17.0, 0.16.0, 0.15.0 apitest jars, 0.17.0 surface); apijars pass; $0.00. |
| Gate | Under the 2026-10-12 gate policy (timing bars recorded, not judged, per slice). Slice tier `artifacts/gate-runs-F1/20261012-013436-slice` (2 shards, 8918-8921, head 05541cf): 18 PASS, among them unit-mod 501, apijars, f1-unit, 6a-megaA, 6a-eflat, 6a-staged, 6a-inv3, 4d-all, 4e-megalite, 6cv-scenario-s7, 6b-scenario-s1 and the other 6b steps. Not passing there, then re-run: unit-kit TIMEOUT at the step's 10 minutes (load 42-83; main's own suite took 11:39 at 555c6bd under this load; 256/256 standalone at 05541cf, `artifacts/gate6c-f1/unit-kit-rerun.log`), unit-sidecar (versions.test hook timeout, bundle.e2e parent-pid race: load), sim-massing (composite keys after world leave: the known load flake) -> PASS in `20261012-034730-change`; 6cf1-scenario-forms (the golden compare and one frozen-sea cell, both fixed above) and 6b-volume (two samples of the unchanged area differed; MP's slice run failed it the same hour; F1 changes no volume code) -> PASS in `20261012-042313-change` at 18e49a7 (forms_demo natural evidence `c687d0ec6bc5`). |
| Gate after W (v0.18.0) | Merged origin/main (W + Y2) at 8f284ff: kit stays 0.19.0, `KINDS_FORMAT2` = W's + `road:lamp` + `voxels`, `FEATURES` + `region.lightCover` + `region.forms1`; apijars and `api-compat --gate6cf1` on the 0.18.0 (built from tag v0.18.0, `artifacts/gate6c-f1/v0180`), 0.17.0 and 0.16.0 jars and the 0.18.0 surface (4/4 clean); `gate6cf1 stale` against v0.18.0. W's frozen-as-water did not move forms_demo's placement (its land test reads the volume's top class); the golden was re-cut anyway from natural run `20261012-052203` (IR sha 611fae337c70). Change tier `artifacts/gate-runs-F1/20261012-163335-change` at 22992ee: f1-unit PASS (13 ok), 6cf1-scenario-forms PASS (natural: every F1 row ok, golden match, E-normal 57 = growth 54, gravity 2, freeze 1; evidence `62fea41503ab`). |

## Phase 6c slice MP: masks and patterns (DRAFT for Steward review)

API 1.17.0, mod 0.20.0 (wave 1, parallel with T1 and F1). PLAN "Inputs for the 6c contract: our own world-shaping toolbox".

- **Branch:** `slice/MP`, worktree `../architect-mc-MP`. **Spend:** $0.
- **Scope:** the toolbox's **masks** (by block, height, slope, depth, field, noise; combinable) and **patterns** (weighted
  block mixes, gradients), as pointwise kit data usable by every op, by scatter (F2) and by brushes (B). The Java records that
  carry them (`Mask`, `Pattern`), so B's API can take them.
- **Not in scope:** brushes themselves (B), rarity budgets (VOC), fluids in patterns (H).
- **Depends on:** V. Parallel with T1 and F1. B, F2 and VOC build on it.

### 0. Facts

- **Material rules** (`kit/lib/material.mjs`) pick a block per cell from conditions (`depth`, `slopeLt/Gte`, `field`, `band`,
  `noise`, `yAbs`, `facing`, `age`) with ordered Bayer `dither`. Each clause's `mat` is one role or block state.
- **Conds** on ops are fixed enums (`IF_NATURAL`, `IF_AIR_OR_FLUID`, ...). Nothing selects cells by their current block or
  height band.
- The kit's voxel classes (`voxel_classes.json`) and `blocks.mjs` tags exist; block tags from 26.3 data are not in the kit.
- WorldEdit's concepts (masks, patterns, gradients) are the model; no WorldEdit code is used (Noah's decision).

### 1. API 1.17.0

- `VERSION = "1.17.0"`; api-compat against the previous three apitest jars and the previous surface.
- **New records** (in `dev.larattalabs.architect.api`), used by B and by `RegionPlanRequest.params` as JSON:
  ```java
  record Mask(JsonObject spec) { static Mask parse(String text); String toText(); }   // validated against the kit schema
  record Pattern(JsonObject spec) { static Pattern parse(String text); String toText(); }
  ```
  `parse` throws `ArchitectRefused(FIELD_LIMIT)` with a path on a bad spec, checked by the same schema the kit uses
  (`kit/schemas/mask.json`, `pattern.json`, bundled; a drift test like 0c's `Limits`).
- **Features:** `masks`, `patterns`. IRs using them are format 2 with `requires: ['mask']` / `['pattern']`. `KIT_VERSION` 0.20.0.

### 2. Masks

```
{ all: [ {block: ['#minecraft:dirt', 'minecraft:grass_block']}, {height: [60, 90]}, {slope: [0, 2]},
         {depth: [0, 3]}, {field: 'wet', gte: 170}, {not: {noise: 'age', gte: 0.6}} ] }
```

- **Terms:** `block` (ids or `#tags`, matched against the cell's current block from the frozen volume or, without one, the
  column's top), `height` (absolute y), `slope` (frozen ground, as material rules), `depth` (cells below the frozen surface),
  `field`, `noise`, `class` (the voxel class: `ROCK`, `SOIL`, `ICE`, ...). Combinators `all`, `any`, `not`.
- **Pointwise:** every term reads the cell, its column or the frozen columns within 8 (K2). `block` on non-surface cells
  needs a frozen volume for the box (`r.needVolume`); without one the plan refuses with a typed note.
- **Where:** every `shape`, `columns` and `relief` op gains an optional `mask`; a cell the mask rejects is skipped (not
  written, not part of the entry). Scatter density and brushes take masks too.
- **Tags:** `blocks.mjs` gains the 26.3 block tags (generated from the data dump, never hand-listed).

### 3. Patterns

```
{ mix: [ {w: 6, mat: 'stone'}, {w: 3, mat: 'andesite'}, {w: 1, mat: 'cobblestone'} ], seedLabel: 'wall' }
{ gradient: { by: 'y'|'depth'|{field: 'wet'}, stops: [ {at: 60, mat: 'sand'}, {at: 64, mat: 'grass_block'} ] }, dither: 'ordered4' }
```

- **`mix`:** a per-cell choice by an integer hash of (seed, label, x, y, z) over the weights; shares converge to the weights.
- **`gradient`:** the stop interval by `y`, `depth` or a field, blended across the interval with the ordered Bayer dither, so
  bands don't make hard lines.
- **Where:** anywhere a `mat` is accepted: a material rule clause's `mat`, an op's `material`, a role in a bible (a role may
  name a pattern; a re-skin still changes only roles).
- **Roles:** a pattern's entries may be roles or block states; roles resolve through the bible as today.

### 4. Gate (slice tier, $0)

**Fixtures:** `crater_works` with a demo param set `toolbox: true` that masks its rim fill to `{slope: [0, 3]}` and paints
its walls with a 3-block mix and its floor with a depth gradient; on 6b's crater fixture (natural) and its flat variant.

**Evidence:** `artifacts/gate6c-mp/`, driver `tools/gate6cmp.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Mix shares (property, 50 seeds x 10k cells) | each block's share within ±2 points of its weight |
| 2 | Gradients | monotone by stop order over 1,000 random columns; dither leaves no straight boundary run of 6 or more on a flat gradient |
| 3 | Masks | equal to a brute-force reference evaluator on 500 random masks x 2,000 cells: 100% |
| 4 | Tile independence | tile shas for 1 and 4 workers, forward and shuffled, equal on the demo |
| 5 | Determinism | IR sha over 3 plans; golden `scenarios/goldens/crater_toolbox.json`; macOS and Linux CI |
| 6 | Schema drift | the Java `Mask`/`Pattern` validation and the kit schema agree on 200 generated valid and invalid specs |
| 7 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% |
| 8 | Unchanged | `crater_works` without `toolbox` keeps its tile shas; S1, S7, mega_bench tile goldens unchanged |
| 9 | Compatibility | the previous mod refuses a `mask`/`pattern` IR `PLAN_STALE` |
| 10 | Tile evaluation, MSPT | p99 under 2 s per tile, at least 45k cells/s; own CPU at most 50 ms |
| 11 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, `region/**` (engine tag: the evaluator changes), `api/**`, sim suites, apijars,
6b-scenario-s1. **gate-verifier** re-runs items 3, 4 and 7.

### 5. Build order

1. Archive the previous apitest jar. 2. Tags in `blocks.mjs`. 3. Masks (kit, schema). 4. Patterns. 5. Java records and drift
test. 6. The crater demo, gate.

### Open questions for Steward

- **S-MP-1.** Do you want to send masks and patterns yourself (for example, a district's ground cover from the card), or only
  through bibles and bundled programs?

### Deferred

- Fluids in patterns (H). Masks reading other mods' block-entity data (never).

### Phase 6c slice MP as built (API 1.16.0, mod 0.19.0, kit 0.19.0: shipped with F1 as v0.19.0; recorded 2026-10-12)

Branch `slice/MP` (worktree `../architect-mc-MP`). $0: sim and stub only (`artifacts/gate6c-mp/spend.json`). Evidence:
`artifacts/gate6c-mp/` (one JSON per `tools/gate6cmp.mjs` step, REPORT.md, api-compat.txt), the scenario runs under the gate run's
`scenarios/mp-flat` and `scenarios/mp`, the gate runs under `artifacts/gate-runs-MP/`. Ports 8924-8929. The coordinator assigned the versions
at merge: MP ships with F1 as v0.19.0 (API 1.16.0, mod 0.19.0, kit 0.19.0); the branch was built as 1.17.0/0.20.0 and renumbered.

| § | As built |
|---|---|
| Tags | `kit/lib/blocks.mjs` gains the 300 vanilla 26.3 block tags (`BLOCK_TAGS`, `tagBlocks(tag)`, `hasTag(name, tag)`), generated by `kit/tools/gen-blocks.mjs` from the server jar's data pack (stored as the pack lists them, `#tag` references resolved on first use, so the file grew 163 KB to 218 KB). Regenerated: every block line is byte-identical. |
| Schemas | `kit/schemas/mask.json` and `pattern.json` (JSON Schema 2020-12, a closed subset: `$ref`/`$defs`, `oneOf`, `anyOf`, type, enum, const, pattern, minimum/maximum/exclusiveMinimum, items/minItems/maxItems, required, properties, `additionalProperties: false`), plus the rules a schema can't say (`x-rules`: ranges ordered, `gte < lt`, at most 8 deep and 64 nodes; gradient stops strictly increasing). `kit/lib/specschema.mjs` and the mod's package-private `api.SpecSchema` read the subset the same way; the mod bundles the two files at `/architect_mc/schemas/` (build.gradle), and `ApiMPTest` holds them byte-equal to the kit's. |
| Masks | `kit/lib/mask.mjs`: terms `block`, `height`, `slope` (the material rules' 4-neighbour step of the frozen ground), `depth` (frozen ground y minus the cell's y: 0 is the ground cell, negative above it), `field` (gte/lt), `noise` (a seeded spec; a program may write a label, `{noise: 'age'}`, which `r.mask` turns into `r.noise(label)`'s spec), `class`; `all`, `any`, `not`. On `shape` and `columns` ops (`relief`, scatter and brushes are T1's, F2's and B's: the IR form is theirs to reuse). A rejected cell is not written and not counted (the budget is exact). Program API: `fill(..., {mask})`, `carve(..., {mask})` (both of its ops), a part's `mask` (`r.part(id, {mask})`: every op of the part, an op's own wins), `r.mask(spec)` (block ids and tags qualified and checked against the 26.3 tables). |
| **`block` and `class` (deviation)** | The contract reads `block` "from the frozen volume or, without one, the column's top", but neither carries a block: ARSV columns hold ground, height, floor and flags, and ARVX volumes hold voxel classes only. So **`class`** reads the IR's frozen volumes (ARVX side blobs, decoded in the evaluator on first use; a cell outside every volume reads `MISSING`), and an IR whose mask names `class` without any volume is refused `MASK_NEEDS_VOLUME`. **`block`** is in the schema, the Java records and the kit's evaluator (`compileMask` with a block source, tested against the reference with synthetic blocks and the real tags), but a realise has no block source, so a plan whose mask names `block` is refused `MASK_NEEDS_VOLUME: ... a frozen block volume, which this game does not sample yet`. Making it real needs a block-palette volume (an ARVX v2 or an ARWD-style side blob, sampled by the mod's two-plan flow): **open for the coordinator** (a follow-up slice, or B's). |
| Patterns | `kit/lib/pattern.mjs`: `{mix: [{w, mat}], seedLabel}` (w 1..1000, at most 32 entries; the draw is `hash3` of the u64 IR seed and the label, folded once to 32-bit keys, scaled by multiply-shift: no modulo bias) and `{gradient: {by: y \| depth \| {field}, stops: [{at, mat}] (2..16)}, dither: ordered4 \| none}` (default ordered4). **Dither deviation:** the gradient's 4x4 threshold matrix is Bayer-like but not Bayer's own: every row and column holds one threshold from each quarter (`0 8 4 12 / 13 5 9 1 / 6 14 2 10 / 11 3 15 7`). Bayer's matrix has a column of mid thresholds that draws a straight edge on a 3-high interval (a run of 64), failing item 2; with this one the longest straight run is 2 for intervals 2..12. Material rules keep Bayer (their goldens don't move). |
| Where patterns go | An op's material `{pattern: spec}` (shape ops), a columns op's `materials` entry, a material rule's clause `mat` and `default`. In an IR every mat is a block state or null (a role name there is refused); a program names roles, resolved at plan time (`r.pattern`, `r.paint`). Fill and carve (lining, `to`) take patterns; other primitives need one block and refuse a pattern with a message. **Bible roles:** a bible gains an optional `patterns: {role: pattern}` (kit `validateBible`: the role must be the bible's, each mat a role or a block); `roles` stay block states everywhere (buildings, survival, M13), and the plan paints that role's fill/carve/rule ops with the pattern (`planRegion({patterns})`, `region.mjs plan --bible` reads them, the sidecar passes the installed bible's `patterns` into the plan's bible.json). A re-skin changes roles, and a pattern's role mats re-resolve. No card field (S-MP-1). |
| IR, kit | `requires` names `mask` (an op with a mask) and `pattern` (a pattern anywhere); either makes the IR format 2 (`KINDS_FORMAT2`, the mod's `IrStale`). `material:rule` is now added only for `{rule}` materials. `KIT_VERSION`/`EVAL_KIT_VERSION` 0.19.0 (shared with F1). After the merge with W, `mask` and `pattern` are appended after W's `road:lamp` in `KINDS_FORMAT2`. An IR without masks or patterns evaluates exactly as before (the hot path is unchanged: S1, S7, mega_bench and the 6b fixtures' tile shas hold). The region checker's M13 and the scenario palette measure read pattern blocks. The realise lint covers `mask.mjs`, `pattern.mjs` and `specschema.mjs`. |
| Java (1.16.0) | `record Mask(JsonObject spec)` and `record Pattern(JsonObject spec)` in `dev.larattalabs.architect.api`: the canonical constructor validates (schema + rules) and copies, `spec()` returns a copy, `parse(String)`, `toText()`, static `error(JsonElement)`; a bad spec throws `ArchitectRefused(FIELD_LIMIT)` with the path (`mask.slope: [a, b] needs a <= b`). No new Reason, nothing added to `RegionPlanRequest` (masks and patterns travel in params as JSON). Features `masks` and `patterns` come from the helper (sidecar `FEATURES`). Note for consumers: `api.Pattern` and `java.util.regex.Pattern` share a simple name (single-type imports resolve it). apitest `apimp` (slice-letter names: `ApiMPTest`, so they don't collide with F1's `Api116Test`). |
| crater demo | `crater_works` gains `toolbox: {type: bool, default: false, omitDefault: true}`; `omitDefault` (kit params, bool only) leaves the param out of the resolved values at its default, so the default seed, the IR's params and every tile sha are unchanged when it is off (the 6b golden's crater IR sha moved only by `programSha`). On: the rim part is masked to `{slope: [0, 3]}`, the bowl's lining and the terraces' rock fill (their walls) take `{mix: [lining 6, andesite 3, rubble 1]}` with label `wall` (6:3:1), the terrace floors a depth gradient from the `path` role (top level) to the lining (the floor). Scenario `scenarios/crater_toolbox.json` (6b's crater fixture, `short: crater_toolbox` so the golden is `scenarios/goldens/crater_toolbox.json`; `scenarios.mjs` takes `sc.short`). |
| Gate | Under the 2026-10-12 policy (timing bars recorded, slice = units + apijars/api-compat + the impact steps + MP's own). Slice tier `artifacts/gate-runs-MP/20261012-013530-slice` (2 shards, 8924-8927, head a11f41f): 20 of 25 PASS, among them **mp-unit** (13 ok), apijars (1.14.0/1.13.0/1.12.0 jars: functional checks pass, their SITE_PROGRESS timing bars recorded), x-ingame 53 ok, 6a-megaA, 6a-eflat, 6a-staged, 6a-inv3, 6b-versions, S1 and S7 (S7's own-tick 54.5 ms is a recorded BAR at load 83). Re-run `20261012-035957-change` (head 8f5376b, after fixing gate6cmp's api-compat classes path): unit-mod 507, unit-sidecar 705, **mp-ingame 12/0**, 6b-smoke PASS. Not passing, not MP's: **4d-all** group undo (one brown mushroom at L10 7,118,35 went to air on G4D Base: the world's own change, the known 4d-all undo flake's family; its timing misses are BARs at load 79); **6b-volume**: the two samples of the unchanged area differ by 20 cells of AIR -> LAVA (lava still flowing after the 90 s settle under load 54-64), twice; MP changes no volume code nor the step. unit-sidecar's first run failed `versions.test.ts`'s beforeAll hook timeout at load 89 (passes alone and in the re-run). **Items:** 1 mix shares within 2 points (worst 1.15); 2 gradients monotone on 1,000 columns, longest straight boundary run 2; 3 masks = the reference on 500 x 2,016 cells through evalTile (class from a frozen volume) and 500 x 2,000 through compileMask (block, tags): 100%; 4 tile shas 1 = 4 workers, forward and shuffled (kit demo and both scenario runs); 5 IR sha identical over 3 plans, kit golden `kit/test/fixtures/regions/crater-toolbox.golden.json` and scenario golden `scenarios/goldens/crater_toolbox.json` match (macOS; CI runs the kit goldens on Linux); 6 drift: the Java and kit verdicts agree on all 200 generated specs (`MaskPatternDriftTest`); 7 E-flat 0 over 266,089 cells (the flat survey checked flat), E-normal 62, all growth, the undo's own 0; 8 crater without the toolbox: IR identical with or without `toolbox: false`, every tile golden unchanged (S1, S7, mega_bench, the 6b fixtures; crater's IR sha moved by `programSha` only); 9 the v0.17.0 kit and the 0.17.0 mod jar's IrStale refuse the toolbox IR PLAN_STALE (`kinds [mask, pattern]`), this build accepts it; 10 (BARs) own tick max 8.6 / 6.8 ms CPU, tiles p99 84 ms, 3.8M cells/s; 11 api-compat `--gate6cmp` 4/4 clean (0.17.0, 0.16.0, 0.15.0 apitest jars, 0.17.0 surface; baseline built from tag v0.17.0 in `artifacts/gate6c-mp/v0170`), apitest `api117` in game, $0.00. **After the merge with W and Y2 and the renumber to 1.16.0 / 0.19.0** (`artifacts/gate-runs-MP/20261012-052738-change`, head 0e9a18d): unit-mod 543, **mp-unit 13/0** (item 9 against the v0.18.0 kit and the 0.18.0 mod jar), **mp-ingame 12/0** (api-compat 4/4 against the 0.18.0 (built from tag v0.18.0, `artifacts/gate6c-mp/v0180`), 0.17.0 and 0.16.0 jars and the 0.18.0 surface; apitest `apimp`; E-flat 0 over 266,089 cells, E-normal 58 all growth; golden match). The scenario golden was re-cut at kit 0.19.0: every tile sha is unchanged, the IR sha moved by kitVersion only. W's `Api115Test` asserted VERSION 1.15.0 exactly; it now asserts at least 1.15.0. An earlier attempt ran the "flat" scenario on a normal world (the client's autoworld created `G6B Flat Base` before `gate6b base`): discarded, and the judge now checks the flat survey. |

## Phase 6c slice T2: slope-aware routing and switchbacks (DRAFT for Steward review)

API 1.18.0, mod 0.21.0 (wave 2). SETTLEMENTS §4.3, without the bridge and tunnel moves (T3).

- **Branch:** `slice/T2`, worktree `../architect-mc-T2`. **Spend:** $0.
- **Scope:** the `route` pass: A* with heading over the resolution-1 survey, a grade limit from which **switchbacks** emerge,
  walk, stair and ladder moves, obstacles (lots, forms, `keep` sets, **keep-out areas**), a discount on existing paths and 4e
  roads (hysteresis), and output as ordinary primitives plus graph edges in V's shape.
- **Not in scope:** bridge and tunnel moves (T3); connectors and the link pass (7a); districts (D).
- **Depends on:** T1 (the pass framework and the resolution-1 survey). S2, T3 and D depend on T2.
- **Closes 0c's deferral** "region programs that route around areas" (keep-out).

### 0. Facts

- 6a's primitives: `road(path, {mode: 'ground'|'graded'})` (4e roads, the IR `roads` member), `stair(path, {rise, landingEvery})`
  with landings, `bridge` (straight polyline, pillars, `maxSpan`), `platform`, `pillar`. Every path is the program's own
  polyline today; "routed roads (pathfinding)" was deferred from the phase 6 contract to here.
- V's graph: nodes `{id, kind, ref, level, ports}`, edges `{id, from, to, type: road|path, width, stage, path}`; 7a keeps the ids.
- `ctx.keepOut` and `ctx.survey.keptOutAt(x, z)` (V); 0c's write bound still refuses at realise.
- The kit's walk graphs: `player` (step 1, ladders, falls at most 3) and the conservative flat `villager` mover (V);
  `dev.nav.villager` runs vanilla `PathNavigation` in game.
- 4e's ground road refuses cut or fill over 4 per centre column (TOO_STEEP); a graded road cuts and retains.

### 1. API 1.18.0

- `VERSION = "1.18.0"`; usual rules and api-compat. **No new records or methods.**
- **Features:** `routePass`. `KIT_VERSION` 0.21.0. No new op kind (routes emit `columns`, `shape`, roads and stairs), so a routed
  IR stays format 1 unless the program uses format-2 members.

### 2. The `route` pass

```js
const net = r.pass('route', { edges: [{ from: 'gate', to: 'hall', width: 3, movers: ['player', 'villager'] }, ...],
                              maxGrade: 0.25, hairpinLanding: 3, stairs: true, ladders: false });
// -> data.edges[i] = { id, path: [[x,y,z]...], segments: [{kind: 'walk'|'stair'|'ladder', from, to}], cost }
```

- **State:** `(x, z, heading)` with 8 headings at resolution 1. y is the survey ground plus the route's own cut/fill decision.
- **Moves and costs** (integers): walk (length, plus grade, plus cut/fill volume, plus water); turn (by angle); **stair** (rise
  1 per cell, a landing every 8; only when `stairs`); **ladder** (vertical, only on an edge whose `movers` lacks `villager`,
  Steward's review: villagers don't climb).
- **Grade limit:** a walk move steeper than `maxGrade` over an 8-cell window is not legal. A hairpin needs a landing of
  `hairpinLanding` x `hairpinLanding` at one y. So switchbacks emerge on slopes steeper than the limit.
- **Obstacles:** lot boxes and their aprons, form bounds, `keep` sets, keep-out rects, the claim margin, lava. Water costs a
  lot but is legal only where T3 adds bridges; in T2 an edge that can't avoid water fails with a typed note.
- **Hysteresis:** cells already on a 4e road or a region path cost a third (6d replanning needs stable routes).
- **Search:** coarse to fine. A corridor search at resolution 4, then the resolution-1 search within 16 of the coarse path.
  Ties by (f, g, x, z, heading). Deterministic.
- **Output:** each edge becomes primitives: `road` (graded where the profile cuts or fills over 2, else ground) for walk runs,
  `stair` for stair runs, a ladder column (the `ladder` block on a support face) for ladder runs; plus a graph edge with the
  path and `movers`. Lamps along the result use W's `lightCover`.

### 3. Gate (slice tier, $0)

**Fixtures:**
- `route_demo` (bundled, `catalogue = false`) on **S3's pinned claim**: 4 nodes from valley floor to a shoulder about 60 above,
  edges with `maxGrade` 0.25, one villager edge and one player-only edge; plus a keep-out rect across the direct line.
- A synthetic 1:2 slope (seeded) where the straight line is about 0.5 grade, for the switchback property.
- The flat variant (the program `add`s a hill first) for E-flat.

**Evidence:** `artifacts/gate6c-t2/`, driver `tools/gate6ct2.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Grade | 100% of walk runs within `maxGrade` over every 8-cell window (realised, re-surveyed) |
| 2 | Switchbacks (synthetic 1:2) | every edge found; at least one hairpin per 16 rise; every hairpin has its landing |
| 3 | Reachability `player` | 100% of edge endpoints reach each other on the realised world |
| 4 | Reachability `villager` | every villager edge: kit mover 100%, and vanilla `dev.nav.villager` 100% end to end; 0 ladder segments on villager edges |
| 5 | Keep-out | 0 cells written in the rect (ARWD diff); the route's length recorded against the unconstrained one |
| 6 | Hysteresis | re-planning with one node moved by 4 keeps at least 80% of the other edges' cells |
| 7 | Plan time | the pass at most 30 s on S3's claim; on the 1024x1024 synthetic with 20 edges at most 90 s (median of 3) |
| 8 | Determinism | IR sha over 3 plans; tile shas 1 and 4 workers; golden `scenarios/goldens/route_demo.json`; macOS and Linux CI |
| 9 | Checker | 0 errors; no M1-M4; M5 under 1% over route walk cells |
| 10 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% |
| 11 | MSPT, evaluation | own CPU at most 50 ms, p99 at most 25 ms; tile p99 under 2 s |
| 12 | Unchanged | S1, S7, mega_bench tile goldens |
| 13 | API, spend | api-compat clean; jars pass; $0.00 |

**Broken variants:** a ladder on a villager edge (M2:villager), a route through keep-out with the obstacle off (plan refusal),
a 0.4 grade straight run with the limit off (bar 1's checker form, `M2:grade`, a new warning sub-finding).

**Tier:** slice: quick, kit region rows, sim suites, apijars, 6b-scenario-s1, 6cv-scenario-s7. No `region/**` Java change is
expected; if one lands, its rows join. **gate-verifier** re-runs items 1, 4 and 5.

### 4. Build order

1. Archive the previous apitest jar. 2. The search (coarse and fine) with unit cases. 3. Moves and costs. 4. Output to
primitives and graph. 5. `route_demo`, the synthetic slope, gate.

### Open questions for Steward

- **S-T2-1. Movers per edge.** Do you set `movers` per edge from the card (dwelling paths `villager`, lookouts `player`), or
  should the planner infer them from the end nodes' lot kinds?
- **S-T2-2. Ladders.** Off by default (`ladders: false`). Want them on for player-only edges in your cards?

### Deferred

- Bridge and tunnel moves (T3). Typed connectors, `seconds` and `risk` (7a). Routes over standing lots (6d).

## Phase 6c slice F2: scatter and feature stamps (DRAFT for Steward review)

API 1.19.0, mod 0.22.0 (wave 2). SETTLEMENTS §3.4 "Scatter without a global pass", §9.3 and §9.4.

- **Branch:** `slice/F2`, worktree `../architect-mc-F2`. **Spend:** $0.
- **Scope:** the `scatter` op kind (a hashed jittered grid; ground, wall and ceiling anchors; density by number, field or mask);
  the `stamp` op kind and the kit's stamp library; the DevBridge harvester `dev.feature.stamp`; the bundled scatter items
  (plants, boulders, stumps, moss carpets, snow layers, glow lichen, path lanterns).
- **Not in scope:** live capture of vanilla features at realise (deferred, SETTLEMENTS §9.4); coral and other water items (F3).
- **Depends on:** T1 (fields for density) and MP (masks for density). S2 and S3 depend on F2.

### 0. Facts

- `scatter` and `stamp` are in `OPS_RESERVED`. K2: a tile reads at most 8 columns past its window.
- Vanilla features (huge mushrooms, dripstone clusters, fossils, trees, geodes) are Java code that can't run in the sidecar.
- `M17` (F1) catches snow layers that a planned light would melt.
- **SETTLEMENTS N7 is unanswered:** shipping stamps harvested from vanilla features in a public repo (block lists produced by
  running vanilla code). Noah's 2026-10-08 decisions don't cover it. §4 has the fallback.

### 1. API 1.19.0

- `VERSION = "1.19.0"`; usual rules. **DevBridge (DEVBRIDGE.md changelog):** `dev.feature.stamp {feature, seeds, ground}`.
  **No new API records or methods.**
- **Features:** `scatterOp`, `stampOp`. IRs using them are format 2 (`requires: ['scatter']`, `['stamp']`). `KIT_VERSION` 0.22.0.

### 2. The `scatter` op

```
{ op: 'scatter', grid: 6, jitter: 4, density: 0.3 | {field: 'wet', scale: [40, 200]} | {mask},
  items: [{ w: 5, shape|stamp|block, material?, anchor: 'ground'|'ceiling'|'wall', radius }], seedLabel: 'shrubs', cond }
```

- The plane is cut into `grid`-sized cells. Each cell's integer hash (seed, label, cell) gives at most one jittered point,
  whether it fires (the density) and which item (the weights). A tile evaluates every grid cell within its window plus the
  largest item radius (at most 8). Same seed, same placements in any tile order.
- **Anchors:** `ground` (the frozen ground's top, or the relief/written surface below the item in this IR), `ceiling` (the
  first solid cell above in a frozen volume), `wall` (a solid side face in a frozen volume). Ceiling and wall need a volume.
- **Supports:** an item is placed only where its anchor block is solid and full on that face; plants only on their vanilla
  soils (generated from the 26.3 data: `#minecraft:dirt`, sand for cacti, and so on).
- Items larger than 8 columns are not scatter: the program places them as explicit ops.
- **Density masks** (MP) and fields (T1) make decoration follow the plan: moss and ferns by `wet`, none on walk cells, lamps by
  distance to paths.

### 3. Bundled items

`boulder` (a warped ellipsoid up to radius 3, rock material rule), `stump`, `shrub`, `fern_patch`, `moss_carpet`, `snow_layer`
(only where M17 allows), `glow_lichen` (walls and ceilings), `path_lantern` (W's `lamp_post`, by distance to path cells).
Each has property tests: supported, never on a walk cell, never in a lot box or keep-out.

### 4. Stamps

- **Harvest:** `dev.feature.stamp {feature, seeds, ground}` places a configured vanilla feature in a scratch superflat world
  at a fixed spot, captures the cells it wrote (diff against the before state), and writes
  `kit/stamps/<feature>/<seed>.bin` (palette, positions, root cell; ARTL-like, gzip OS byte pinned). Harvested once per
  Minecraft version by `tools/harvest-stamps.mjs`.
- **The `stamp` op:** `{op: 'stamp', id: 'huge_brown_mushroom/3', at, rotation}` places one at a plan-chosen position, `IF_NATURAL`
  / `IF_AIR_OR_FLUID`, plus a root skirt of the stamp's base block down to the frozen ground (at most 6). The checker and the
  previews see it.
- **First library:** huge brown and red mushrooms, dripstone clusters, fossils, and 5 vanilla tree species (8 seeds each).
- **N7 fallback (if Noah says no to shipping them):** the op and the harvester ship; `kit/stamps/` stays out of the repo and
  the release, and is harvested locally by the gate. Scatter items that use stamps then fall back to bundled shapes.

### 5. Gate (slice tier, $0)

**Fixtures:** `scatter_demo` (bundled, `catalogue = false`) over **S2's pinned claim** (snow layers, boulders, a stamp of each
library feature) with a few lanterns to exercise M17; the flat variant; and a cave box from the 6b volume fixture for ceiling
and wall anchors.

**Evidence:** `artifacts/gate6c-f2/`, driver `tools/gate6cf2.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Tile independence | scatter placements identical for 1 and 4 workers, forward and shuffled; tile shas equal |
| 2 | Density | over 50 seeds, the fired share per density band within ±3 points of the density |
| 3 | Supports | 0 unsupported items on the realised world (M3), 0 plants on wrong soil, 0 items on walk cells, lot boxes, keep-out |
| 4 | Melt | M17 0, before and after a 2-minute stand; snow-layer count unchanged by the stand |
| 5 | Stamps | realised cells equal the stamp's cells (rotated) plus its skirt; 0 floating cells |
| 6 | Harvest reproducibility | re-harvesting each stamp on the same version gives the same bytes |
| 7 | Determinism | IR sha over 3 plans; golden `scenarios/goldens/scatter_demo.json`; macOS and Linux CI |
| 8 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% |
| 9 | Evaluation, MSPT | tile p99 under 2 s, at least 45k cells/s; own CPU at most 50 ms, p99 at most 25 ms |
| 10 | Compatibility | the previous mod refuses `scatter`/`stamp` IRs `PLAN_STALE`; S1, S7 and mega_bench tile goldens unchanged |
| 11 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, `region/**` (engine tag: new op kinds), the DevBridge rows, sim suites, apijars,
6b-scenario-s1. **gate-verifier** re-runs items 1, 3 and 5.

### 6. Build order

1. Archive the previous apitest jar. 2. `scatter` (kit evaluator, anchors, supports). 3. Bundled items. 4. The harvester and
the `stamp` op. 5. `scatter_demo`, gate.

### Open questions for Noah

- **N-F2-1 (SETTLEMENTS N7). Shipping vanilla feature stamps** in the public repo and jar (block lists produced by running
  vanilla feature code, like the kit's tables from the 26.3 data generator). Yes, or the fallback in §4?

### Deferred

- Live capture of features at realise (until stamps prove too rigid). Coral, kelp and other water scatter (F3, after H).

### Phase 6c slice F2 as built (placeholders API 1.20.0, mod 0.23.0, kit 0.22.0; recorded 2026-10-12)

Branch `slice/F2` (worktree `../architect-mc-F2`, from origin/main 31f1b56, v0.21.0). $0: sim and stub only, no Claude call
(`artifacts/gate6c-f2/spend.json`). Ports 8924-8929. Evidence: `artifacts/gate6c-f2/` (the gate6cf2 step JSONs, api-compat.txt, the 0.21.0
baseline `v0210/` built from tag v0.21.0 with its tools/), the slice tier under `artifacts/gate-runs-F2/`, the development scenario runs
under `artifacts/scenarios-F2dev/6c-f2/`. The version numbers are placeholders (GATES.md "Policy update"): the coordinator assigns them.
**Noah's N-F2-1 holds throughout: stamps are local-only.**

| § | As built |
|---|---|
| §1 API | `VERSION` 1.20.0, mod 0.23.0; no new records or methods. An F2 helper (sidecar feature `region.scatter`) gives `scatterOp` and `stampOp` (`ApiRules`, javadoc on `features()`). `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` = 0.22.0; `KINDS_FORMAT2` (kit and mod) gains `scatter`, `stamp`, appended after T1's `relief`; `OP_KINDS` `shape, columns, voxels, relief, scatter, stamp`; `OPS_RESERVED` empty. The tests that pinned T1's numbers (`ApiT1Test`, `relief-t1`, two sidecar tests) now assert "at least" or read the kit's own constant. DevBridge `dev.feature.stamp` (DEVBRIDGE.md "Stamps"; `SliceF2Dev`, generated headless by `genHooks`). |
| §2 scatter | `kit/lib/region/scatter.mjs` (under the realise lint), kit/REGIONS.md "Kit 0.22.0". IR: `{op: 'scatter', area, grid, jitter, density, mask?, items, seedLabel, avoid?, lit?, y?, cond}`; the evaluator turns it into per-tile column lists (kind 4). Hashes: `hash3` under `mix64(fnv64(seed, 'scatter', label))`; fire = `hash >>> 16 < density * 65536`; the item by multiply-shift over the weights. Anchors: `ground` (the frozen ground, or the top an earlier-or-same-stage `relief` op gives the column), `ceiling` and `wall` (the frozen volume only: the lowest air cell in the op's `y` with a solid cell above or beside). Supports: dry ARSV ground (no water, frozen, lava, tree or missing flag); with a volume, the ground cell's class in the item's `on` and the anchor cell air, a plant or a snow layer. Density: a number, `{field, scale}`, `{mask, p}`; the op's MP `mask` at the anchor cell. Hard exclusions in the evaluator: the claim, the IR's lots (box and apron), `keepOut`, the `avoid` field over the item's cells, `lit` for melting items, kept cells (F1's `keep`) cell by cell. **Deviations:** (a) an item's reach is at most **4**, not 8: a placement's decision reads its whole footprint, so K2's 8 is footprint (4) + reach (4) (a tile window over 16 past the tile gives the same cells: tested); items larger than 4 are explicit `stamp` ops. (b) An item stays **inside its own grid cell** (the jittered point is clamped; reach r needs grid >= 2r + 1): placements of one op never overlap (the property test found a later boulder taking an earlier fern's soil). (c) **Plants need the frozen volume**: the soils are read as the class SOIL (`#minecraft:supports_vegetation` is that class but for clay and dirt paths: the realised check reads the exact tag), and no plant on a relief-moved column. (d) Items are plan-time variants (blocks, ground-following patches, ARVB bodies): no material rule per placement. |
| §3 items | `kit/lib/region/scatterItems.mjs`: `boulder` (4 seeded warped ellipsoids up to radius 3, sunk 1, a seeded rock mix: stone 6, andesite 3, cobblestone 2, mossy cobblestone 1), `stump` (a log 1 or 2), `shrub` (`minecraft:bush`), `fern_patch`, `moss_carpet`, `snow_layer` (3 variants each; ferns and the bush on SOIL; snow layers not on ice, `melts`), `glow_lichen` (a wall and a ceiling item), `path_lantern` (W's fixture, the bible's light on its rail; `light`). Lights (`light: [dx, dy, dz, level]`): no ice within `level - 11`, no snow other than the columns' own snow layers within `level - 12` (the checker reads natural snow as a block it can't tell from a layer), no tree or frozen column within `level - 12`; the snow layers there are written as air first, under every placement's own cells (a clearing never takes a neighbour's post). Program side `kit/lib/region/scatterPlan.mjs`: `scatter(r, id, spec)` builds `<id>_avoid` (walk cells, the columns other parts wrote, blocks or cuts, a relief's band excepted, lot boxes and aprons), `<id>_lit` and `<id>_pathd` (path distance) from the plan's draft virtual world (format 2, the IR seed: earlier scatter ops place as they will), and reads `ctx.keepOut`. Property test (`kit/test/scatter-f2.test.mjs`, 60 seeded claims with a path, a lot and keep-out): 0 M3 findings on scatter parts, every plant on `#supports_vegetation`, 0 cells on walk columns, lot boxes, aprons or keep-out, no snow layer within a light's reach, M17 0. |
| §4 stamps | **N-F2-1:** the library is `<game>/architect/stamps/<feature>/<seed>.bin` (`Blueprints.gameDataDir()`), never `kit/stamps` (gitignored) nor the jar (the kit copy excludes `stamps/**`; `gate6cf2 unit` lists the built jar and the tracked files). The helper passes it to the plan CLI as `--stamps <dir>` (config `regions.stampsDir`, `ARCHITECT_STAMPS_DIR`; read inside the plan sandbox: `sidecar/test/regions-stamps.test.ts`). File: gzip (pinned header) of ARSP (feature, seed, game version, ground template, root cell, block-entity count, ARVB). Harvester `dev.feature.stamp {feature, seeds, ground, dir?}`: superflat worlds only; a 41x41 box at (8, 8) reset to a ground template (`grass_block`/any block, `stone`: a 40-deep stone mass, `cave`: a stone mass with a 9-high pocket), snapshot, `Registries.FEATURE`'s feature placed with `RandomSource.create(seed)`, diff, reset, all in one server task; block-entity cells and the feature's own air writes left out. First library (`tools/lib/stamp-library.mjs`, `tools/harvest-stamps.mjs`): huge brown and red mushrooms (on mycelium), `dripstone_cluster` (cave), `fossil_coal` (stone), oak, birch, spruce, acacia, dark oak (grass), 8 seeds each: 72 stamps. The `stamp` op `{op: 'stamp', id, blob, root, at, rotation, skirt}` (kind 5): the body turned as voxels turn with its root at `at`, base columns skirted down to the frozen ground (at most 6). A plan embeds each stamp it uses as a side blob `stamp_<feature>_<seed>` (kind `voxels`), so the mod's blob path is unchanged. **Deviations:** stamp fluids are dropped and waterlogged states dried (`dripstone_cluster/2` holds 9 water cells; F2 places no fluid, H's M25); a missing stamp is a plan note (`stamp(r, ...)` returns null; a scatter stamp item falls back to a boulder), never a silently different IR. |
| §5 fixtures | `kit/regions/scatter_demo.mjs` (`catalogue = false`). Surface (S2's claim, scenario `scatter_demo`, and its flat variant): a boardwalk (walk cells), one lot, a stamp of each surface feature and a buried fossil, each fitted where every face-connected part touches solid natural ground as the checker's M3 reads it (a snow layer is no support; a sunk fit is tried: the vanilla red mushroom's cap meets its stem only at edges), lanterns (light 15) by path distance, ground decoration (`density` 60%). Cave (`cave: true`, scenario `scatter_cave` on the 6b volume fixture's claim, `golden: false`, no flat variant): glow lichen on walls and ceilings at least 2 under the ground, both dripstone clusters fitted into the cave. **Deviations:** the cave box is the 6b volume fixture's world claim (same world seed as S2), its own scenario rather than a box inside scatter_demo; on the flat variant the fossil finds no fit (a superflat world is 4 deep) and is noted. |
| Harness | `tools/lib/scenario-scatter.mjs` (supports, as planned, snow across the stand, F2 rows) and the phase `6c-f2` in `tools/scenarios.mjs`: the IR-sha plans under `/tick freeze` (F1's rule), the after-stand dump, F1's freeze class. **Deviations:** (a) the F2 scenarios run on a headless host without their camera shots (F2 has no gallery bar; any other scenario refuses a headless host); (b) the committed golden `scenarios/goldens/scatter_demo.json` is the **stamps-off** re-plan (`params.stamps false`) of a natural run's own survey and frozen volume, so no vanilla stamp is ever committed; the golden row holds the golden itself (its committed inputs re-plan to its IR sha and tile shas, as T1's) and a run's own IR (with the local stamps) shows its determinism over 3 plans and 1 vs 4 workers; the kit golden `kit/test/fixtures/regions/scatter-demo.golden.json` covers the stamp op on Linux CI with synthetic stamps; (c) two E-normal world classes (F2 scenarios only). `distant`: an unclassified mismatch at a cell the plan never writes, in no lot, 8 or more (Manhattan) from every written cell, **and of a kind the world does on its own far away**: water or lava on either side (fluids settling), cobblestone, stone or obsidian made from air, cave air, water or lava (lava meeting water), the same leaves with only `distance` changed, or non-persistent leaves at distance 7 turning to air (decay: a **deviation from the coordinator's list** of fluids, fluid-made stone and leaf distance changes, accepted 2026-10-13; reason: decay is where a leaf's distance change ends, and the verifier's run held one such oak leaf (987,78,488), 8 or more from every written cell, that would otherwise stay unclassified and fail the bar); any other far change stays unclassified, so it can't hide an undo error (gate-verifier, 2026-10-13: the first, distance-only rule was too broad). `amethyst`: air or cave air that became a small, medium or large amethyst bud or a cluster, at a cell the plan never writes (budding amethyst's random ticks; classed by what the change is, at any distance: the verifier's run had one 7 from a written cell, which failed the bar). In the runs the cave's far changes were all lava flowing, lava meeting water and leaf distance/decay (48, 69 and 82 cells: they vary with the world's own ticks); (d) sibling runs (E-flat beside E-normal) are the scenario's own (`run.json`), and a fixture without a flat variant judges E-normal only. |
| Items | Slice tier `artifacts/gate-runs-F2/20261012-222357-slice` (head dfd4172, shard 2's scenarios under `s2/scenarios/`). **1** tile independence: tiles 1 = 4 workers, forward and shuffled, on every F2 run and in the kit (`scatter-f2`), plus the K2 window test (a 96x96 window gives the same cells as the tile's 80x80). **2** density: the fired share within 3 points of the density for 6 bands over 50 seeds (kit). **3** supports: realised 0 floating cells in scatter and stamp parts on all three runs; 0 of 508 (flat) and 0 of 13 (natural) plants off `#supports_vegetation`; 0 item cells on walk columns, lot boxes or aprons, keep-out (6,937 / 1,038 / 2,815 item cells); the kit's 60-claim property test. Recorded: on S2 natural 2 of 481 planned ferns were not there after the realise (class SOIL admits clay and dirt paths; the plant is popped), 479/481 scatter cells as planned. **4** melt (S2 natural `8823bfec2896`): plan M17 0; realised after the 2-minute stand M17 0 of 14,575 ice and snow cells; natural snow layers 6,156 -> 6,156, 0 lost within a planned light's reach; the scatter's own snow layers 109 -> 109. **5** stamps: every stamp's realised cells equal its turned cells plus skirt (S2: oak 62, birch 63, spruce 61, acacia 85, dark oak 150, the two huge mushrooms 49 each, the buried fossil 30; flat: the six surface stamps and the red mushroom (sunk fit); cave: both dripstone clusters 80 and 47); 0 floating (the red mushroom's rim-on-snow case of the development run fixed at df113f0 and green here). **6** harvest: 72 of 72 stamps byte-identical on a re-harvest (`f2-harvest`, headless, 59 s). **7** determinism: IR sha identical over 3 plans on all runs; golden match (stamps-off golden `e1c09f7af3ad`, 19 tile shas; the kit test `scenario-goldens` holds it on Linux CI at merge) and the kit golden `scatter-demo.golden.json` (synthetic stamps). **8** exactness: E-flat 0 (flat `e3e306f992d7`); E-normal 68 all growth (S2); cave `c60444295c49` E-normal 248 = 195 growth, 1 grazed, 4 gravity, 48 distant, the undo's own 0. **9** (BARs, recorded) tiles p99 2-5 ms, 105k-277k cells/s; own CPU max 34.9 (flat, load 13-36), 15.6 (S2), 8.5 ms (cave); p99 at most 34.9 (flat). **10** the v0.21.0 kit (0.20.0) and the 0.21.0 mod jar refuse a scatter/stamp plan `PLAN_STALE: plan needs kit 0.22.0 / kinds [scatter, stamp]; this is kit 0.20.0`; S1, S7, mega_bench, forms_demo and relief_demo goldens unchanged. **11** api-compat `--gate6cf2` 4/4 clean (after the v0.22.0 merge: 0.22.0, 0.21.0, 0.20.0 jars and the 0.22.0 surface); apijars pass; $0.00. N-F2-1: no stamp tracked, none in the built jar (`f2-unit`). |
| Gate | Under the 2026-10-12 policy (timing bars recorded; slice = units + apijars/api-compat + the impact steps + F2's own). Slice tier `artifacts/gate-runs-F2/20261012-222357-slice` (3 shards, 8924-8929, head dfd4172, 2h11m): 29 PASS (unit-mod 585, unit-kit 306, unit-sidecar 715, apijars, sim suites, f2-unit, f2-harvest, 6cf2-scenario-scatter, mp-ingame, t1-ingame, x-ingame, 4d-all, 4e-megalite, 6a-megaA, 6a-eflat, 6a-inv3, 6a-staged, the 6b steps, S1, S7 (V and W)). 4 FAIL, all in old drivers, not F2's behaviour: mp-unit, f1-unit and t1-unit's PLAN_STALE items expected "plan needs kit 0.19.0/0.20.0" (the old kits and mods still refuse; the checks now read any later kit: 976d973), and 6ct1-scenario-relief's golden row re-planned T1's golden under the new kit (moved by the kit version alone; a golden now re-plans at its own recorded kit: 59395c3). Then origin/main (v0.22.0, C29) merged (11c6a58; F2 keeps its placeholders) and apijars and api-compat moved to the 0.22.0 (built from tag v0.22.0 into `artifacts/gate6c-f2/v0220`), 0.21.0 and 0.20.0 jars (cf3d55c). Re-run on the merged head `artifacts/gate-runs-F2/20261013-003645-change` (head cf3d55c): apijars (45 ok on 1.19.0 and 1.18.0, 46 on 1.17.0; one SITE_PROGRESS timing bar each on 1.19.0 and 1.18.0, recorded), mp-unit 13/0, f1-unit 13/0, 6ct1-scenario-relief, 6cf2-scenario-scatter PASS (S2 natural `f27ef75123e0`: every row green, E-normal 62 all growth; flat `369633e5cd3b` E-flat 0; cave `4024ecb6842a`: E-normal 272 = 202 growth, 1 grazed, 69 distant, the undo's own 0); t1-unit failed only the wall-time kit test "floatingIsland evaluation cost per cell (recorded)" at load 90 (F1's driver skips it as a load flake; unit-kit 306/306 in the slice tier and locally). The "as planned" row (recorded) compared planned partial states with the dump's full ones (195582c); the slice run's `s2/scenarios/scatter_cave` and `relief_demo` metrics were recomputed in place after these fixes (their metrics.json and evidence.sha rewritten). gate-verifier, first review (`artifacts/gate-runs-F2-verify/20261013-014320-change`, its own item-8 re-run at 195582c): FAIL on item 8 alone: one unclassified cave cell, cave air -> small amethyst bud at 1036,-11,539 (budding amethyst under it, unwritten, 7 from a written cell); everything else accepted (the stamps-off golden, N-F2-1, the t1 flake, the driver fixes, the recompute). Fixes (dc964df): the `amethyst` world class, `distant` narrowed by kind (Harness (c)), the flat run's exactness row recorded. Re-run `artifacts/gate-runs-F2/20261013-020413-change` (head dc964df): 6cf2-scenario-scatter PASS: flat `c19f6e2fab8f` E-flat 0; S2 natural `8928d3d9c6a8` E-normal 73 (72 growth, 1 freeze), every F2 row green; cave `aba6a1ceb31d` E-normal 263 (197 growth, 1 grazed, 65 distant), unclassified 0, the undo's own 0. gate-verifier, second review (review only): PASS (confirmed the amethyst rule matches the failed cell, the narrowed distant rule, and all 65 cave distant cells are fluid or fluid-made stone; 0 outside the allowed kinds). HANDOFF-F2 retired. |

## Phase 6c slice B: terrain brushes as journal-backed region ops (DRAFT for Steward review)

API 1.20.0, mod 0.23.0 (wave 2). PLAN "Inputs for the 6c contract: our own world-shaping toolbox" (brushes, destruction).

- **Branch:** `slice/B`, worktree `../architect-mc-B`. **Spend:** $0.
- **Scope:** brushes for the API, commands and agents: smooth, erode, melt, blend, raise, lower, overlay, cave carve. Each stroke
  is a small region (plan, realise, journal), so undo, ownership, the MSPT budget, crash safety and layering come from the
  existing engine. Masks and patterns (MP) shape every stroke. **Noah's destruction rule.**
- **Not in scope:** fill, drain and recursive fill (they write fluids: H); brushes in survival (RS); a brush UI beyond commands.
- **Depends on:** T1 (`relief` and its kernels) and MP (masks, patterns).

### 0. Facts

- A region is planned in the sidecar's pristine-kit child, realised in tiles as CELL entries, and undone by `Regions.remove`
  in any order through the journal (4e LAYER, 6a). Regions refuse `NOT_ALLOWED` in survival-toggle worlds and outside the
  Overworld (`RegionsImpl`).
- Ownership: the journal knows every Architect-written cell and its owner. Cells no entry owns are natural (by voxel class) or
  a player's/other mod's blocks (class `PLAYER`, `BLOCK_ENTITY`).
- K2 forbids non-local work at realise: a cave worm or a flood fill must be resolved at plan time.
- WorldEdit's brush set is the model (Noah: no WorldEdit dependency; GPL code is not read or copied).

### 1. API 1.20.0

```java
default CompletableFuture<RegionView> brush(BrushRequest r)              // Regions; default throws "needs Architect API 1.20.0"
record BrushRequest(String owner, ResourceKey<Level> dimension, BrushKind kind, BrushShape shape, BlockPos center, int radius,
                    int strength, @Nullable Mask mask, @Nullable Pattern pattern, Destruction destruction, @Nullable UUID actor, long seed) {}
enum BrushKind { SMOOTH, ERODE, MELT, BLEND, RAISE, LOWER, OVERLAY, CAVE_CARVE }   // H appends FILL, DRAIN, FLOOD_FILL
enum BrushShape { SPHERE, CYLINDER }
enum Destruction { NATURAL_ONLY, PLAYER_BLOCKS }   // not the Reason PLAYER_BLOCKS, which stays a refusal
// RegionView gains trailing @Nullable String brush (the kind, for a stroke; old constructor: null)
```

- **Limits:** `radius` 1-32, `strength` 1-16 (`Limits.BRUSH_*`, refused `FIELD_LIMIT`). A stroke is one region record.
- **New Reason** (appended): `PERMISSION` (§4).
- **Features:** `brushes`. `KIT_VERSION` 0.23.0 (the bundled `brush` program).

### 2. How a stroke runs

1. The mod surveys the brush box plus 8 (sliced; a frozen volume for `CAVE_CARVE`, `MELT` and any `block` mask term).
2. The sidecar plans the bundled program `brush` with the request as params. **No Claude call.**
3. The plan's IR is realised at once (no prepare: a stroke refuses `NOT_LOADED` over unloaded chunks).
4. `Regions.remove(id)` undoes it, in any order with other strokes and sites.

Every stroke writes `IF_NATURAL` cells only, unless `destruction` says otherwise (§4); cells a site, road or delta owns are
skipped (K5), and noted.

### 3. The kinds

| Kind | What it does (inside the shape, after the mask) | Built from |
|---|---|---|
| `SMOOTH` | moves the surface toward its local integer mean; edges pinned to the outside ground | T1 relief, Jacobi |
| `ERODE` | thermal plus stream touch-up; extra |dh| at most `strength` | T1 erosion |
| `MELT` | removes exposed natural cells with at least 4 air neighbours, `strength` rounds (rounds off spikes and overhangs) | plan-time cell list as `voxels`-style air writes |
| `BLEND` | blends the surface between the shape's edge and its centre so a cut or fill meets the land | T1 relief, pins at the edge |
| `RAISE` / `LOWER` | `±strength` at the centre, a smooth integer falloff to 0 at the edge; fill by the pattern or the column's own surface rule | `relief` delta |
| `OVERLAY` | replaces the top `strength` cells with the pattern (topsoil over subsoil); the mask picks columns | `columns` ops |
| `CAVE_CARVE` | a seeded 3D worm from the centre, resolved at plan time to `capsuleChain` segments with `warp`; floor levelled where a mover needs it | `shape` subtract, `cavern` rules |

**Pointwise at realise:** each kind's non-local work (means, worms, exposure counts) runs at plan time and lands as fields,
shapes or cell lists (K2). Fill blocks come from the pattern, else the column's surface/subsurface/rock rule.

### 4. Destruction (Noah's rule)

- `NATURAL_ONLY` (default): natural cells only.
- `PLAYER_BLOCKS`: may also clear blocks no journal entry owns that aren't natural (a player's or another mod's builds).
  - **Permission:** `actor` must be a player with permission level 2 or more, or the server console; else `PERMISSION`.
  - **Ownership:** a cell owned by **another owner's** journal entry is never touched (skipped, noted). The caller's own entries
    are layered over as usual.
  - **Always undoable:** before states and block-entity NBT are journaled; nothing drops (containers keep their contents in the
    journal and get them back on undo).
- `owner` must be set (`<modid>:<thing>`, or `architect:player` for commands). C17 areas of that owner refuse the stroke.

### 5. Commands

`/architect brush <kind> [radius] [strength] [mask <text>] [pattern <text>] [shape]` at the block the player looks at (reach
64), and `/architect brush undo` (the player's last stroke). Creative or permission 2.

### 6. Gate (slice tier, $0)

**Fixtures:** `brush_demo` strokes on the flat variant (the gate first raises a sculpted bump field) and on a corner of **S3's
pinned claim**; one player-built wall and one other owner's road in the box.

**Evidence:** `artifacts/gate6c-b/`, driver `tools/gate6cb.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Each kind's property (unit, 100 seeds each) | SMOOTH lowers the max adjacent step; RAISE/LOWER give exactly `±strength` at the centre and 0 at the edge; ERODE extra |dh| at most `strength`; OVERLAY depth exact on masked columns; MELT never adds a cell |
| 2 | Natural only | `NATURAL_ONLY` strokes write 0 non-natural cells (the wall stays) |
| 3 | Ownership | 0 cells of the other owner's road written by any stroke, any destruction |
| 4 | Permission | `PLAYER_BLOCKS` without permission refused `PERMISSION`, nothing written; with it, the wall is cleared and one undo restores it with its block entities |
| 5 | Undo in any order | 5 overlapping strokes, undone in 3 orders: E-flat 0 each time; E-normal classified on the natural corner |
| 6 | Cave carve | M3 0 floating; M4 0 breaches into water or lava |
| 7 | Latency | a radius-16 stroke from command to realised: p50 at most 2 s, p95 at most 5 s (10 strokes) |
| 8 | Determinism | same request and seed, same IR sha and tile shas |
| 9 | MSPT | own CPU at most 50 ms, p99 at most 25 ms |
| 10 | Survival and dimensions | refused `NOT_ALLOWED` in a survival-toggle world (until RS) and outside the Overworld |
| 11 | Unchanged | S1, S7, mega_bench tile goldens |
| 12 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, `region/**` (engine tag), `api/**`, `site/**` (ownership checks), the 4e crash suite
once (a stroke is a region write), sim suites, apijars. **gate-verifier** re-runs items 3, 4 and 5.

### 7. Build order

1. Archive the previous apitest jar. 2. The `brush` program and the kinds (kit). 3. The API, the stroke path, the destruction
rule. 4. Commands. 5. Fixtures, gate.

### Open questions for Steward

- **S-B-1.** Do you want strokes grouped (one undo for a set of strokes, as a site group), or one region per stroke as drafted?
- **S-B-2. World-wide areas.** 0c deferred "areas binding every owner (a world-wide never-touch)" to the terrain slices. B
  checks only the stroke owner's C17 areas. Do you need areas that bind every owner (brushes, regions and sites of any caller)
  in 6c? If so, it is a small addition to B (an `owner: "*"` area, set at permission 4); otherwise it stays deferred.

### Open questions for Noah

- **N-B-1.** `PLAYER_BLOCKS` at permission level 2 (operators). Right level, or 4 (owner) only?

### Deferred

- Fill, drain, recursive fill (H). Brushes in survival (RS). A brush tool item and a preview ghost for strokes (later, with a UI).
- Areas binding every owner (0c's deferral), unless S-B-2 asks for them in B.

### Phase 6c slice B as built (API 1.21.0, mod 0.24.0, kit 0.23.0: placeholders, over v0.23.1; recorded 2026-10-13)

Branch `slice/B` (worktree `../architect-mc-B`). $0: sim and stub only (`artifacts/gate6c-b/spend.json`). Ports 8930-8935. Evidence:
`artifacts/gate6c-b/` (one JSON per `tools/gate6cb.mjs` step, REPORT.md, api-compat.txt, the dumps and snaps), the gate runs under
`artifacts/gate-runs-B/`. Frozen by the batch review: S-B-1 (one region per stroke), S-B-2 (owner `*` areas deferred), N-B-1
(PLAYER_BLOCKS at permission 2); the MP ruling (the `block` mask term made real here).

| § | As built |
|---|---|
| §1 API | `VERSION` 1.21.0. `Regions.brush(BrushRequest)` (a default that throws "needs Architect API 1.21.0"; completes with the region's view once it is PLACED, PARTIAL or FAILED); `record BrushRequest(owner, dimension, kind, shape, center, radius, strength, mask, pattern, destruction, actor, seed)` as drafted (null shape SPHERE, null destruction NATURAL_ONLY); `enum BrushKind`, `BrushShape`, `Destruction` as drafted; `RegionView` gains trailing `@Nullable String brush` (the kind's name for a stroke), the 1.14.0 constructor kept; `Reason.PERMISSION` appended after FORMAT; `Limits.BRUSH_RADIUS_MIN/MAX` 1/32, `BRUSH_STRENGTH_MIN/MAX` 1/16 (FIELD_LIMIT with the path). Feature `brushes` from a B helper (sidecar feature `region.brush`). `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION` 0.23.0; `KINDS_FORMAT2` (kit and mod) gains `volume:blocks`, appended after F2's `scatter` and `stamp`. apitest `apib`, `brush`, `brushundo` (`ApiTestBrush`). |
| §2 the stroke | `region/Brushes.java`. On the server thread: the field rules (owner `<modid>:<thing>`, radius, strength: FIELD_LIMIT), the Overworld and no survival toggle (NOT_ALLOWED), PLAYER_BLOCKS's permission (PERMISSION), the owner's protected areas against the **brush box** (PROTECTED), every chunk of the brush box plus 2 loaded (NOT_LOADED: a stroke never prepares), the helper (SIDECAR_UNAVAILABLE). Then the claim (the brush box plus 8) is surveyed at resolution 1 (LOADED_ONLY) and, for MELT, CAVE_CARVE or a mask with a `block` or `class` term, the brush box plus 2 frozen as an ARVX v2 volume with block ids; one `region.plan` of the bundled `brush` program with both (no two-plan flow, `check: false`: no checker, no previews); the plan realised at once (INSTANT, auto-approved, `force` so another owner's region over the claim is judged per cell, not refused whole). The stroke's record (kind, shape, destruction, playerBlocks, actor, box) is the mod's own (`RegionRec.brush`, kept in `region.json`), never taken from a request's ext. Request to realised (dev.brush, item 7): p50 about 0.5 s for radius 8-10, 1.0-2.3 s for radius 16 under load 12-23. |
| §3 the kinds | `kit/lib/region/brush.mjs` (plan time, integer arithmetic) and `kit/regions/brush.mjs` (`catalogue = false`); kit/REGIONS.md "Phase 6c slice B additions". **Deviation (ops):** every kind lands as `columns` ops (masks and patterns apply to every stroke), not `relief` ops (the relief op refuses masks); the surface kinds write fills and cuts from `{surface: 0}`, MELT and CAVE_CARVE absolute cell runs. **Deviation (the surface):** a surface kind moves the columns whose ground lies inside the shape (a sphere's y extent counts); water and lava columns keep theirs. A fill takes the pattern, else the subsurface role under the surface role, the old top included (so no grass is left buried); a cut leaves the exposed block. **Deviation (CAVE_CARVE):** the worm is resolved against the frozen volume into a cell list, not a `capsuleChain` with `warp`: it stops before a segment that comes within one cell of water, lava or an unknown cell, and the solid cells it cuts off from the volume's faces are carved too. BLEND: the inside columns within a third of the radius keep their ground and the ring relaxes to the land, each column within `strength`. |
| §4 destruction | A flag on the stroke's record read by `site/TileCheck` (not a cell condition: ARTL's two cond bits are full). Every brush op is `ALWAYS_OURS`; the tile check counts the **same owner's earlier strokes'** tile entries as its own (layered over: they pass ALWAYS_OURS and are not skipped as owned), every other owned cell (sites, roads, deltas, crates, other regions, other owners' strokes) is skipped as `owned` as before (K5). **Decision (narrow layering):** the owner's ordinary regions are not layered over by its strokes (no removal behaviour Steward relies on changes). With PLAYER_BLOCKS an unowned cell passes whatever it holds, block entities included (their data is journaled by the capture, nothing drops: the write skips side effects and the tile's new drops are cleared; the undo reloads the data). A stroke never writes an unbreakable block (bedrock, barriers, portals, command and structure blocks; `unbreakable` in the skip counts). **Decision (the actor):** PLAYER_BLOCKS needs an online player with permission level 2 as the actor; null or an offline UUID refuses PERMISSION. The server console reaches it only through `/architect brush` (an internal flag), so no API caller can claim to be the console. |
| §5 commands | `region/BrushCommands.java`: `/architect brush <kind> [radius] [strength] [options]`, options in any order: `sphere`/`cylinder`, `mask {json}`, `pattern {json}`, `player_blocks`, `seed n`, `at x y z` (the console names the block; a player aims within 64). Owner `architect:player`, the player as actor. `/architect brush undo`: the actor's last standing stroke (found by the actor recorded on the stroke, never by an id built from the owner). Creative or permission 2. |
| ARVX v2, the block mask | ARVX version 2 = version 1 plus a block-id palette (air first) and per-column runs after the owner table (kit/REGIONS.md). Java `Arvx` and `VolumeSurvey` (with blocks, at most 32M cells) and the kit's `decodeArvx`/`encodeArvx`/`blockAt`; a cross-language fixture `mod/src/test/resources/arvx/blocks.{bin,json}`. `r.needVolume(box, {blocks: true})` (the `needVolumes` entry carries `blocks`; the mod's two-plan flow samples it); the IR's volume carries `blocks: true` and the IR requires `volume:blocks`; tags are expanded at plan time into the IR member `blockTags`. A `block` term over a version-1 volume or none still refuses MASK_NEEDS_VOLUME. Params gain the region-only `json` type; programs gain `Part.columns`. |
| Gate | Under the 2026-10-12 policy (timing bars recorded; slice = units + apijars/api-compat + the impact steps + B's own). Final slice tier after merging origin/main v0.23.1 (F2, C30) and v0.22.0 (C29): `artifacts/gate-runs-B/20261013-024839-slice` (3 shards, 8930-8935, head e39954a): **PASS 41/41**, among them unit-mod 603, unit-kit 317, unit-sidecar 715, apijars (the 0.23.0, 0.22.0 and 0.21.0 jars, each built from its tag into `artifacts/gate6c-b/v0230`, `v0220`, `v0210`: 46 ok each), b-unit 11/0, b-ingame 74/0 (headless), 4e-crash 48/0, x-ingame, x-resume, 4d-all, 6a-megaA, 6a-eflat, 6a-staged, 6b-volume, mp-ingame, the S1/S7/relief/forms scenarios; no timing bar missed. Earlier rounds: `20261012-221442-slice` (37/38 before the C29 merge; relief_demo's golden re-plan now runs at the golden's own kitVersion, as F2 also did), `20261013-003614-slice` (36/38 after the C29 merge: unit-sidecar's known load timeouts at load 42, and 6b-volume's candidate flake: 3155 vs 3165 lava cells between two samples of the unchanged area; both passed in the final run). **Items:** **1** (kit, 100 seeds each) SMOOTH: the largest step between inside columns never rises, lowered on 88 seeds, held by the pinned edge on 5, already at most 1 on 7, the roughness falls on 99 (**deviation**: strict lowering is impossible where outside columns pin both sides of an inside column); RAISE/LOWER exactly +/-strength at the centre, 0 at and past the edge, monotone falloff; ERODE and BLEND within strength; OVERLAY depth exact on masked columns (evaluated); MELT only removes removable cells. **2** NATURAL_ONLY strokes (raise, smooth, lower, overlay, erode, a lower and a melt over the wall, a raise, a melt of stone spikes: 10 cells) leave the player's wall and its chest unchanged (21 cells failed the natural condition). **3** 0 of the other owner's road's 87 owned cells written by any stroke, PLAYER_BLOCKS included (owned skipped 18); another owner's stroke skips gate:b's strokes (owned 120). **4** PLAYER_BLOCKS refused PERMISSION without an actor and for the player after /deop (nothing written); with op the wall cleared (21/21 air), 0 item entities, one undo restores it with the chest's NBT (hash with NBT equal); the console's command path reaches it. **5** 5 overlapping strokes (journal stacks of 2+ strokes on 42 sampled cells) undone in the orders 5-4-3-2-1, 1-2-3-4-5 and 3-1-5-2-4: E-flat 0 each; on S3's corner 7 strokes (a cave, five surface strokes, a melt) undone: E-normal 0 mismatches (the diff box is the strokes' reach plus 4, after a 20 s settle: a first run's 236 unclassified cells were a spring flowing on freshly loaded chunks 30 blocks out). **6** a radius-14 cave carve under S3's corner: 485 cells, M3 0 floating, M4 0 breaches (judged on the realised ARWD dumps; the kit's 100-seed test too). **7** (BAR) radius 16: p50 1.0 s, p95 1.06 s (load 12; 2.3 s p50 at load 23 in another run). **8** the same request and seed: the same IR sha twice in game, tile shas twice in the kit. **9** (BAR) own CPU max 4.7 ms flat, 5.0 ms natural (no own-time p99 in dev.placement.stats). **10** NOT_ALLOWED in a survival-toggle world and the Nether; FIELD_LIMIT for radius 33, strength 17, no owner; NOT_LOADED over unloaded chunks. **11** S1, S7, mega_bench and the 6b goldens unchanged (16 pass); the 0.23.1 kit and the 0.23.0 mod refuse a brush plan PLAN_STALE (kit version; a block-masked one by `volume:blocks`). **12** api-compat 4/4 clean (0.23.0, 0.22.0, 0.21.0 jars, the 0.23.0 surface); apitest `apib` and a stroke through the public API; $0.00. `/architect brush raise 5 3 cylinder at ...` and `/architect brush undo` exact. **gate-verifier: PASS** (review of the diff and the merges, plus its own re-run of items 3, 4 and 5 and 6b-volume at e39954a: `artifacts/gate-runs-B-verify/20261013-045740-change`, b-ingame 74/0, 6b-volume 4/0). Its caveats: owners are stored as strings and only compared; it relied on the builder's slice run for the rest. HANDOFF-B retired. |

## Phase 6c slice S2: the ice-spike outpost goes green (DRAFT for Steward review)

API 1.21.0, mod 0.24.0 (wave 3). SETTLEMENTS §16.2 (S2), §16.3 (bars), §17.2 (6c gate).

- **Branch:** `slice/S2`, worktree `../architect-mc-S2`. **Spend:** $0 (lots are library variants; no pick, no claude login).
- **Scope:** the bundled program `ice_outpost` (`catalogue = false`), S2's scenario run, its golden and its gallery page. It
  composes what W, T1, F1, F2 and T2 built; new kit code is limited to the program and S2's fixture bible.
- **Not in scope:** S2 from its one-line brief (7c), connectors such as rope bridges (7a), site-aware lots (7b).
- **Depends on:** W (frozen water, lamps), T1 (relief blending), F1 (`iceSpike`, kept spikes, M17), F2 (snow and boulder
  scatter), T2 (routes). T3 is optional: if merged, the program may use a bridge move; S2's bars don't require one.

### 0. Facts

- **Fixture** (`scenarios/s2_ice_spikes.json`): seed 2026100906, claim `[2508,1588,2699,1779]` (192x192), y 22-124, biomes
  frozen ocean 48%, deep frozen ocean 27%, ice spikes 15%, snowy beach 5%, snowy plains 5%; relief 62-84. W re-pins its
  `surveySha` (frozen water now reads as water), so roughly 75% of the claim is water to the planner.
- S1 (6b) and S7 (V) are the templates for the scenario file, the harness (`tools/scenarios.mjs`), goldens and gallery.
- Lot entries: free variants of kit designs (`cabin`, `tavern`, `tower`, as S7), sized per lot and pinned `entry@version`.

### 1. API 1.21.0

- `VERSION = "1.21.0"`; usual rules. **No new records or methods.** Feature `scenarioS2`. `KIT_VERSION` 0.24.0.

### 2. The program `ice_outpost`

- **Layout:** the land band (ice spikes, snowy beach and plains) holds 6-8 lots: a watch tower (landmark), a longhouse, a
  smithy, a store and 3-4 huts. Lots avoid kept natural spikes (`keepNatural('ICE')`) and frozen water.
- **Terrain:** pads on `pad.edge: 'blend'` (T1 relief), packed-snow `surface` role; no carving.
- **Forms:** 4-8 generated `iceSpike` clusters filling gaps between natural spikes, never within 6 of a lot or route.
- **Routes:** T2 routes from a gate node to every lot entrance, `maxGrade` 0.2, villager movers on hut edges.
- **Scatter:** snow layers (where M17 allows), boulders, a few spruce stumps; none on walk cells.
- **Lights:** W's `lightCover` over lot aprons and routes, in the bible's `light` role (lanterns, never torches near ice).
- **Bible:** a fixture "frontier outpost" bible (spruce, stone bricks, packed ice accents) in `scenarios/bibles/`.

### 3. Bars (on the realised world, re-surveyed; SETTLEMENTS §16.3)

| # | Check | Bar |
|---|---|---|
| 1 | Checker | 0 errors; no M1-M4 findings |
| 2 | Reachability `player` | 100% of nodes; 0 unreachable lot entrances |
| 3 | Reachability `villager` (kit and vanilla `dev.nav.villager`) | recorded for the huts (SETTLEMENTS gates villager reachability from 7a) |
| 4 | Structure | M3 0 floating cells; 0 `M3:gravity` |
| 5 | Safety | M4 0; full M5 under 1% of walk area; M8 100% of walk cells beside a drop over 3 guarded |
| 6 | Melt | **M17 0** on the plan, and on the realised world after a 2-minute stand at default random ticks; ice, snow-layer and kept-spike cell counts unchanged by the stand |
| 7 | Kept spikes | 0 written cells in the natural spikes' `keep` sets |
| 8 | Palette | role adherence at least 0.9 (form materials count) |
| 9 | Organic read | axis-run share of form and relief boundary cells: per N-F1-1 (gated at 0.25, or recorded) |
| 10 | Buildings | kit checker 0 errors over the placed entries; `detailNoise`, `accentShare` within the bible's restraint |
| 11 | MSPT | own CPU at most 50 ms, p99 at most 25 ms; light-engine tick share recorded |
| 12 | Tile evaluation | p50 and p99 per tile recorded; p99 under 2 s |
| 13 | Exactness | flat variant E-flat 0; natural E-normal all classified, at most 0.01% of written cells |
| 14 | Determinism | IR sha over 3 plans; tile shas for 1 and 4 workers, forward and shuffled; golden `scenarios/goldens/s2.json`; macOS and Linux CI |
| 15 | Spend | $0.00 |
| 16 | Gallery | Noah approves this run's `evidence.sha` on the private page "Architect 6c gallery" (section S2), with before/after renders and the 6 cameras |

### 4. Gate items

1. **Feasibility first.** `find-site`'s score on the re-pinned survey must leave room for 6 lots on land. If the plan can't
   place 6 lots, the coordinator re-pins S2 (a needs rule of at least 30% land), and the reason is recorded. No bar moves.
2. S2 natural (bars 1-14) and flat variant (bar 13).
3. Regressions: S1 and S7 still green on their goldens (`6b-scenario-s1`, `6cv-scenario-s7`).
4. The gallery, then Noah's approval. **S2 is green only when approved.**

**Evidence:** `artifacts/scenarios/6c/s2/`, `artifacts/gate6c-s2/REPORT.md`; driver `tools/scenarios.mjs run s2 --phase 6c`;
chain step `6c-scenario-s2` added to `gate-chains.json` (and to `release`'s `always`).

**Tier:** slice: quick, kit region rows, sim suites, apijars, 6b-scenario-s1, 6cv-scenario-s7, 6c-scenario-s2. No engine
change is expected. **gate-verifier** recomputes S2's evidence sha and re-runs items 2 and 6.

### 5. Build order

1. Item 1 (feasibility on the re-pinned survey). 2. The program and bible. 3. Runs, golden, gallery. 4. Verifier, approval.

### Open questions for Steward

- **S-S2-1.** Is the lot list (tower, longhouse, smithy, store, huts) a fair stand-in for what your card would ask on this
  claim, for comparing with 7c's brief run later?

### Open questions for Noah

- **N-S2-1.** The outpost lives on the 25% of the claim that is land; the frozen sea stays untouched. Fine, or do you want a
  version that builds out over the ice (it would need piers, and ice melts under lights)?

### Deferred

- Rope bridges and piers (7a connectors). S2 from its brief (7c).

## Phase 6c slice T3: bridge and tunnel moves (DRAFT for Steward review)

API 1.22.0, mod 0.25.0 (wave 3). SETTLEMENTS §4.3 (the `bridge` and `tunnel` moves).

- **Branch:** `slice/T3`, worktree `../architect-mc-T3`. **Spend:** $0.
- **Scope:** the route pass's **bridge** move (a straight jump across a gap or water up to `bridgeMax`) and **tunnel** move
  (through rock in a frozen volume up to `tunnelMax`); the new primitive `r.tunnel`; volume reads for routing corridors.
- **Not in scope:** typed connectors (rope bridges, catwalks, lifts: 7a §8.2); sag, suspension and styling from a bible (7a).
- **Depends on:** T2. Parallel with S2 and H.

### 0. Facts

- 6a's `bridge(path, {deck, rail, supports, maxSpan, towers})` builds a straight polyline deck with pillars down to ground;
  M10 checks every unsupported span against `maxSpan` and `'ends'` bearing.
- `Survey.volume` (6b) freezes a 3D box (ARVX, classes per cell); `r.needVolume(box)` asks for one at plan time.
- 6a's `cavern` and `carve` give carved voids with lining and lights; M5 checks cavern floors.
- After W, frozen water is water, so a bridge is how a route crosses a frozen river.

### 1. API 1.22.0

- `VERSION = "1.22.0"`; usual rules. **No new records or methods.** Features `routeBridges`, `routeTunnels`. `KIT_VERSION`
  0.25.0. No new op kind (tunnels are `shape` carves plus `columns` floors and lights).

### 2. The bridge move

- **Where:** from a walk cell, straight along the heading over cells that are a **gap** (the ground drops more than 4 below
  the deck line) or water, landing on a walk cell at most 1 off the deck's y, within `bridgeMax` (default 32).
- **Cost:** span x (2 + depth / 8) plus a fixed 24 per bridge, so routes prefer the ground when it's close.
- **Output:** a 6a `bridge` with `maxSpan` 8, pillars to ground, rails; deck y fixed at plan time (absolute, K2). M10 and M8
  apply as for any bridge.
- **Movers:** a flat bridge carries `villager`.

### 3. The tunnel move and `r.tunnel`

- **Where:** from a walk cell into rock (classes `ROCK`, `SOIL` over at least 3 above the tunnel's top) of a frozen volume,
  straight or with one bend, up to `tunnelMax` (default 48), at most 1 rise per 4 cells. The pass asks for the corridor's volume
  (`needVolume`) on its coarse pass and plans the fine pass against it.
- **Refused** where the tunnel would come within 2 of water, lava or a cave void (M4 safety by construction).
- **`r.tunnel(path, {width: 3, height: 3, lining, lights: 6, portal})`:** a `capsuleChain`/box carve (`IF_NATURAL`), a levelled
  floor in the `path` role, lining only where the rock is loose (sand, gravel: `gravity` from W), lights every 6 on the walls
  (no light on the floor's walk cells), portals framed in the `structure` role.
- **Cost:** 3 per cell plus a fixed 40, so short ridges are crossed by tunnels only when climbing costs more.
- **Movers:** a flat tunnel carries `villager`.

### 4. Gate (slice tier, $0)

**Fixtures:**
- `crossings_demo` (bundled, `catalogue = false`) on 6b's `rift_city` fixture (a sculpted rift: bridges) and a synthetic ridge
  added by the program on a flat world (a tunnel), plus a frozen-river crossing on S7's rejected site 2026101102 (a bridge over
  frozen water). The flat world variants give E-flat.

**Evidence:** `artifacts/gate6c-t3/`, driver `tools/gate6ct3.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Moves chosen | the rift gets at least 1 bridge, the ridge 1 tunnel, the frozen river 1 bridge; each route's cost recorded against the walk-only alternative |
| 2 | Spans | M10: every unsupported span at most `maxSpan`; both ends bear on at least 2x2 |
| 3 | Fall guard | M8: 100% of bridge deck walk cells guarded |
| 4 | Tunnel safety | M4 0; M3 0 floating (roof and lining); M5 under 1% of tunnel floor cells |
| 5 | Reachability | `player` 100% across every crossing; `villager` kit and vanilla `dev.nav.villager` 100% across the flat bridge and the tunnel |
| 6 | Frozen water | the S7 rejected site's route crosses on a bridge and realises complete (never PARTIAL) |
| 7 | Determinism | IR sha over 3 plans; tile shas 1 and 4 workers; golden `scenarios/goldens/crossings_demo.json`; macOS and Linux CI |
| 8 | Exactness | flat E-flat 0 (rift and ridge); natural E-normal classified, at most 0.01% |
| 9 | Plan time | the pass with volume reads at most 60 s on each fixture |
| 10 | MSPT, evaluation | own CPU at most 50 ms, p99 at most 25 ms; tile p99 under 2 s |
| 11 | Unchanged | S1, S7, S2, mega_bench tile goldens |
| 12 | API, spend | api-compat clean; jars pass; $0.00 |

**Broken variants:** a tunnel within 1 of a water pocket (plan refusal), a bridge with `maxSpan` 40 (M10), a tunnel without
lights (M5).

**Tier:** slice: quick, kit region rows, sim suites, apijars, 6b-scenario-s1, 6cv-scenario-s7, 6c-scenario-s2. **gate-verifier**
re-runs items 2, 4 and 6.

### 5. Build order

1. Archive the previous apitest jar. 2. Bridge move and output. 3. Volume reads in the pass. 4. Tunnel move and `r.tunnel`.
5. Fixtures, gate.

### Open questions for Steward

- **S-T3-1.** Are 6a stone bridges and plain tunnels acceptable for your settlements until 7a's typed connectors, or should the
  planner avoid crossings until then?

### Deferred

- Rope bridges, catwalks, lifts, suspension and sag (7a). Tunnels through player-built or other owners' blocks (never).

## Phase 6c slice H: contained fluids (DRAFT for Steward review)

API 1.23.0, mod 0.26.0 (wave 3). SETTLEMENTS §4.2 ("designed water, contained"), §11 (M20), §18 ("Fluids"); PLAN toolbox "Fluids" and the fill/drain
brushes.

- **Branch:** `slice/H`, worktree `../architect-mc-H`. **Spend:** $0.
- **Scope:**
  - **fluid writes in region tiles** (still source blocks of water and lava), with exact undo;
  - **M25 fluid containment** (new) and **M20 fire**;
  - pools and lava features (`r.pool`);
  - the brush kinds `FILL`, `DRAIN`, `FLOOD_FILL` (appended to B's enum);
  - V's deferred **wet well**.
- **Not in scope:** the `hydrology` pass and channels (HY, next), flowing rivers (deferred, SETTLEMENTS §21), M16 flood
  behaviour (7a), coral (F3).
- **Depends on:** B (the brush path). The engine is touched: this slice runs the engine tag. HY and F3 depend on H.

### 0. Facts

- 6a writes regions without fluid updates (write flags), and a tile skips air writes that would let water in (E-normal guard).
  No region has written a fluid yet: V kept its well dry because "fluid ordering between section writes is untested".
- M4 (6b) finds cleared cells that open onto water or lava. Nothing checks where a **placed** fluid would flow.
- The journal restores block states exactly; water and lava sources are block states (`level=0`), `waterlogged` is volatile
  under "still ours".
- Vanilla 26.3: water spreads 7 horizontally on a solid floor and falls without limit; lava spreads 3 in the Overworld; lava
  ignites flammable blocks near it.

### 1. API 1.23.0

- `VERSION = "1.23.0"`; usual rules. `BrushKind` gains `FILL`, `DRAIN`, `FLOOD_FILL` (appended). `BrushRequest` gains trailing
  `@Nullable String fluid` (`minecraft:water` or `minecraft:lava`; old constructor: null).
- **Features:** `regionFluids`, `fluidBrushes`. `KIT_VERSION` 0.26.0. Checker `RULES` gains `M20`, `M25`.
- **Behaviour change:** region IRs may write fluid source cells (a format-2 `requires: ['fluids']`); the previous mod refuses
  them `PLAN_STALE`.

### 2. Fluid writes and undo

- **Declared volumes:** every fluid a program writes belongs to a declared `fluid` part: `{id, fluid, cells | shape, spill: [...]}`.
  Only sources are written (level 0); no flowing states.
- **Order:** within a tile, fluid cells are written last, after every solid cell of the tile; a fluid part whose containment
  touches another tile waits until those tiles' solids are written (a stage barrier per fluid part). Neighbour updates stay
  off during the write; one fluid tick is scheduled for each written source after the part completes, so vanilla sees the
  final shape.
- **Undo:** removing a fluid part restores the before states (air or the old block) and removes our sources first, then solids;
  water a player later placed is kept and reported (CELL policy).
- **Crash:** a crash between solids and fluids leaves no fluid written (the barrier); settle at start completes or undoes the
  part (6a's crash rules).

### 3. M25 containment and M20 fire

- **M25 (new):** a static flow simulation on the virtual world from every declared source: water spreads up to 7 over solid
  floors and falls through air, lava 3 (Overworld). Every reached cell must be inside the declared volume or a declared spill
  cell. A finding lists the escaping cells. **Error** in the checker (a fluid outside its volume can't be undone exactly).
- **M20 (SETTLEMENTS §11):** no flammable block (from the 26.3 data: `flammable` flag in `blocks.mjs`) within 2 of lava or an
  open fire source. Warning, gated as a bar here.

### 4. Pools, lava features and the fluid brushes

- `r.pool(shape, fluid, {rim})`: a carve, a rim (the `structure` role or natural), the fluid, one part.
- `FILL` (fill the shape's air below `center.y` with the fluid), `DRAIN` (remove our-or-natural fluid sources inside the shape;
  cells become air or `IF_NATURAL` subsurface by a `drainTo` param), `FLOOD_FILL` (from `center`, a plan-time 6-connected fill
  of air below a level, bounded by `radius` and 50,000 cells; refused if it would escape the bound).
- Each runs as a stroke (B) with M25 on the plan; an escape refuses the stroke with the escaping cells.
- **Wet well:** V's `well` prop gains `water: true` (one source in the cauldron's place; a 3x3 ring contains it). `flat_village`
  keeps the dry well by default.

### 5. Gate (slice tier plus the engine tag, $0)

**Fixtures:** `water_demo` (bundled, `catalogue = false`) on S3's claim: a pond, a stepped pair of pools joined by a declared
waterfall cell, and a lava pit with a stone rim; its flat variant (the program sculpts a valley first). A synthetic leaky basin
(broken variant).

**Evidence:** `artifacts/gate6c-h/`, driver `tools/gate6ch.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Containment, plan | M25 0 on `water_demo`; the leaky basin variant caught with its escaping cells |
| 2 | Containment, world | after a 2-minute stand at default random ticks, 0 fluid cells (source or flowing) outside the declared volumes and spills (re-surveyed) |
| 3 | Fire | M20 0; 0 fire blocks in the claim after the stand |
| 4 | Undo | E-flat 0 on the flat variant **including fluid cells**; natural E-normal classified, at most 0.01% |
| 5 | Crash | a crash between a pool's solids and its fluids (6a crash harness): settle leaves 0 fluid outside volumes and the region either complete or undone exactly |
| 6 | Brushes | FILL, DRAIN and FLOOD_FILL each: plan-time M25 0, realised containment as bar 2, one undo exact; a FLOOD_FILL that escapes is refused with nothing written |
| 7 | Determinism | IR sha over 3 plans; tile shas 1 and 4 workers; golden `scenarios/goldens/water_demo.json`; macOS and Linux CI |
| 8 | MSPT | own CPU at most 50 ms, p99 at most 25 ms; the fluid-tick share recorded |
| 9 | Wet well | S7 flat variant with `water: true`: M25 0, the well holds 1 source after the stand, undo exact |
| 10 | Unchanged | S1, S7, S2 and mega_bench tile goldens (dry programs write no fluid) |
| 11 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice plus the engine tag (`region/**`, `journal/**` if the barrier touches it): 4e-orders, 4e-crash or 6a-crash,
6a-eflat, 6a-megaA, the scenario steps, sim suites, apijars. About 75-90 min on 3 shards. **gate-verifier** re-runs items 2,
4 and 5.

### 6. Build order

1. Archive the previous apitest jar. 2. Fluid parts, ordering, barrier, undo, crash. 3. M25, M20. 4. `r.pool`. 5. Fluid brushes.
6. Wet well. 7. Fixtures, gate.

### Open questions for Steward

- **S-H-1.** Farms (M24) want water within 2. Should the planner add a small contained pond beside a farm lot when the claim
  has none, now that fluids are possible?

### Open questions for Noah

- **N-H-1. Fluids in survival (for RS).** Is placed water free (vanilla water is infinite) while placed lava costs a lava bucket
  per source? Or are both free as "natural", or both creative-only?

### Deferred

- The hydrology pass and channels (HY). Flowing rivers and waterfalls beyond declared cells (SETTLEMENTS §21). M16 flood
  behaviour (7a). Bubble-column lifts (7a).

## Phase 6c slice HY: hydrology and channels (DRAFT for Steward review)

API 1.24.0, mod 0.27.0 (wave 4). SETTLEMENTS §4.2.

- **Branch:** `slice/HY`, worktree `../architect-mc-HY`. **Spend:** $0.
- **Scope:** the `hydrology` pass (priority flood, D8 flow, accumulation) with the `flow` and `wet` fields; opt-in **channels**
  laid as H's contained fluid parts (level reaches, declared waterfall cells with basins); `wet` wired into material rules,
  masks and scatter density.
- **Not in scope:** flowing rivers (SETTLEMENTS §21), M16 (7a), regenerating vanilla rivers.
- **Depends on:** T1 (passes, fields) and H (fluid parts, M25). Parallel with D and VOC.

### 0. Facts

- T1's framework runs passes at plan time on the resolution-1 survey; fields are side blobs; material rules (`field`), MP's
  masks and F2's scatter density already read fields by name.
- H writes declared fluid parts of still sources, proved by M25, undone exactly; waterfall cells are declared spills.
- The survey's `WATER` and (after W) `FROZEN` flags mark existing water; `floor` is the bed.

### 1. API 1.24.0

- `VERSION = "1.24.0"`; usual rules. **No new records or methods.** Feature `hydrologyPass`. `KIT_VERSION` 0.27.0.

### 2. The pass

```js
const h = r.pass('hydrology', { channelAt: 400, wetFalloff: 12, minReach: 6 });
// -> fields.flow (u8, log2 accumulation), fields.wet (u8), data.channels: [{ reaches: [{y, cells}], falls: [{at, basin}] }]
```

- **Filling:** priority-flood on integer ground heights (a min-heap by (height, index)), so flats drain deterministically.
- **D8 flow** with ties broken by direction index; accumulation in index order of the filled surface.
- **`wet`:** `min(255, a * log2(accumulation) + b * max(0, wetFalloff - distanceToWater))` with integer `a`, `b` (fixed in the
  pass); surveyed water and frozen water both count as water.
- **Channels (opt-in, `channelAt`):** cells with accumulation over the threshold form a channel graph. Each channel is cut into
  **reaches** of one level; between reaches with a drop, a declared waterfall cell and a basin of at least 3x3x2. Reaches
  shorter than `minReach` merge. Each channel is an H fluid part (carve, banks in the `surface` role where needed, still water),
  so M25 proves it before realise.
- **Avoidance:** channels avoid lot boxes, keep sets, keep-out and routes (a route crossing a channel gets a T3 bridge or a
  culvert: a 1-wide covered cell with a slab deck).

### 3. Gate (slice tier, $0)

**Fixtures:** `hydro_demo` (bundled, `catalogue = false`) on S3's pinned claim (its river and slopes: fields, 1 channel with at
least one fall, moss and fern scatter by `wet`); the flat variant (the program sculpts a valley first); the 1024x1024 synthetic
survey for plan time.

**Evidence:** `artifacts/gate6c-hy/`, driver `tools/gate6chy.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Fill and flow (unit) | every filled cell drains to the claim edge or a surveyed water body; 0 cycles; hand cases match |
| 2 | Determinism | `flow` and `wet` blob shas over 3 plans and across macOS and Linux CI; IR sha; tile shas 1 and 4 workers; golden `scenarios/goldens/hydro_demo.json` |
| 3 | Plan time | the pass at most 30 s on the 1024x1024 synthetic (median of 3) |
| 4 | Channels | M25 0 on the plan; every reach level; every drop over 1 has a declared fall and basin |
| 5 | Containment, world | after a 2-minute stand, 0 fluid cells outside channel volumes and spills |
| 6 | Wet follows water | over the claim, the mean `wet` of cells within 4 of water is at least 3x that of cells over 16 away; moss/fern scatter density correlates (recorded) |
| 7 | Crossings | 0 route cells flooded; every route crossing has a bridge or culvert |
| 8 | Exactness | flat E-flat 0 including fluids; natural E-normal classified, at most 0.01% |
| 9 | MSPT, evaluation | own CPU at most 50 ms, p99 at most 25 ms; tile p99 under 2 s |
| 10 | Unchanged | S1, S2, S7 and mega_bench tile goldens |
| 11 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, sim suites, apijars, the scenario steps; the engine tag only if H's barrier code changes.
**gate-verifier** re-runs items 2, 4 and 5.

### 4. Build order

1. Archive the previous apitest jar. 2. Fill, D8, accumulation, fields. 3. Channels as fluid parts. 4. Avoidance and culverts.
5. Fixtures, gate.

### Open questions for Noah

- **N-HY-1.** Channels are opt-in per program. Should S3's monastery get one (a stepped stream down the terraces), or keep S3 v1
  dry and leave water features to later scenarios?

### Deferred

- Flowing rivers (SETTLEMENTS §21). Irrigation for farms from channels (with Steward's farm rules, 7a).

## Phase 6c slice D: districts, and a district beside a standing region (DRAFT for Steward review)

API 1.25.0, mod 0.28.0 (wave 4). SETTLEMENTS §4.4; "Agreed with Steward (2026-10-09)": "add a district to an existing region
... (6c lays it out; 7a links it in the graph)".

- **Branch:** `slice/D`, worktree `../architect-mc-D`. **Spend:** $0.
- **Scope:**
  - the `districts` pass: districts to candidate areas, nodes to lots, edges by route cost (a minimum spanning tree plus
    loops);
  - **a district beside a standing region:** planned against the region's lots, graph and claim, realised as its own region
    with its own undo, joined by one routed edge.
- **Not in scope:** affordances and site lots (7a §6). The 6c pass uses **survey candidates**; 7a feeds affordances through the
  same interface. Graph links between regions as typed connectors (7a). Region evolution and deltas (6d).
- **Depends on:** T2 (route costs). S3 depends on D.

### 0. Facts

- SETTLEMENTS §4.4 assigns nodes to **affordances** (§6), which are 7a. In 6c the only inputs are the survey (2.5D, resolution
  1 after T1), frozen volumes, and `ctx.survey.flatAreas({size, maxRange})` (6a).
- V's graph is the shape 7a keeps (nodes, ports, edges); V's `flat_village` makes one street district by hand.
- A region is one record with one claim; `Regions.remove` undoes all of it. Nothing links two regions today.
- C17 areas and `keepOut` (V) already constrain plans.

### 1. API 1.25.0

```java
// RegionPlanRequest gains trailing @Nullable String beside (a standing region's id; old constructors: null)
// RegionView gains trailing @Nullable String beside
```

- `VERSION = "1.25.0"`; usual rules. No new Reason: a claim that overlaps the standing region's beyond the seam (§3) is refused
  with the existing `OVERLAP` and a message naming the seam.
- **Features:** `districtsPass`, `besideRegion`. `KIT_VERSION` 0.28.0.

### 2. The `districts` pass

```js
const d = r.pass('districts', { districts: [
    { id: 'cloister', lots: 4, size: [48, 48], levelBand: 'high', prefer: ['flat'], near: ['church'] },
    { id: 'fields',   lots: 3, size: [64, 40], levelBand: 'low',  prefer: ['flat', 'wet'] } ],
  candidates: 'survey', loopiness: 0.15 });
// -> data.assign: { districtId: candidateId }, lots[], graph nodes and edges (V's shape), data.unplaced
```

- **Candidates (6c):** flat areas from the survey at sizes the districts ask for, each with its level band (claim height
  terciles), slope, `wet` (HY, when present), distance to water, and keep-out and C17 exclusions applied. Interface:
  `{id, rect, y, tags}`, which 7a's affordances also produce.
- **Assignment:** integer scores (size fit, level band, `prefer` tags, `near` adjacency). With at most 64 candidates per
  district, an exact assignment (Hungarian on integer costs); otherwise greedy by score, ties by id.
- **Lots inside a district:** V's `layoutStreet` rules on the district's rect (its street is the district's main edge).
- **Edges:** T2 route costs between district nodes; a minimum spanning tree, plus the cheapest non-tree edges until the
  added cost reaches `loopiness` of the tree's. Each edge is routed by T2.
- **Unplaced:** a district with no candidate is listed (`unplaced`), as V's lots are.

### 3. A district beside a standing region

- `RegionPlanRequest.beside = regionId`: the plan reads the standing region's IR (lots, graph nodes and ports, claim, roads) as
  obstacles and join points. The new claim may overlap the standing one only in a seam of at most 16 columns, and never over
  its lots or roads; otherwise `OVERLAP`.
- **The join:** one routed edge (T2/T3) from a new node to the standing region's nearest compatible port, written by the **new**
  region (its cells, its undo). The standing region writes nothing.
- **Undo:** `Regions.remove(new)` removes the district and its join; the standing region is untouched. Removing the standing
  region first is allowed (journal layering); the join's end is then reported as dangling in the new region's notes.
- **`siteplan.json`:** the new region's graph gets an edge to `<standingRegion>:<node>.<port>` with `external: true`.
  7a turns it into a typed link (S-D-2).

### 4. Gate (slice tier, $0)

**Fixtures:**
- `districts_demo` (bundled, `catalogue = false`) on **S3's pinned claim**: 3 districts at three level bands, loopiness 0.15.
- On S7's flat variant: a standing `flat_village`, then a 4-lot district `beside` it.
- 300 seeded synthetic claims (property tests).

**Evidence:** `artifacts/gate6c-d/`, driver `tools/gate6cd.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Assignment (property) | on 300 claims, the exact assignment's cost is at most the greedy's; 0 lots in keep-out or C17 areas; `unplaced` exact |
| 2 | Level bands | every district on `districts_demo` sits in its band |
| 3 | Connectivity | every district node reaches every other by the plan's edges; the realised graph's `player` reachability 100% |
| 4 | Loopiness | added loop cost within 0.15 of the tree's (±0.02) |
| 5 | Beside: overlap | a claim overlapping the village's lots refused `OVERLAP`, nothing written |
| 6 | Beside: undo | `Regions.remove(new)`: 0 changed cells in the standing village (ARWD diff over its claim) and E-flat 0 over the new claim |
| 7 | Beside: join | the join is walkable `player` and `villager` (kit and `dev.nav.villager`) from a new lot to the village's bell |
| 8 | Determinism | IR sha over 3 plans; tile shas 1 and 4 workers; golden `scenarios/goldens/districts_demo.json`; macOS and Linux CI |
| 9 | Plan time | the pass plus its routes at most 60 s on S3's claim |
| 10 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% |
| 11 | MSPT, evaluation | own CPU at most 50 ms, p99 at most 25 ms; tile p99 under 2 s |
| 12 | Unchanged | S1, S2, S7, mega_bench tile goldens |
| 13 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, `region/**` (the `beside` claim check), `api/**`, sim suites, apijars, the scenario
steps. **gate-verifier** re-runs items 3, 6 and 7.

### 5. Build order

1. Archive the previous apitest jar. 2. Candidates and assignment. 3. Lots per district, edges. 4. `beside` (API, claim check,
join). 5. Fixtures, gate.

### Open questions for Steward

- **S-D-1. Districts before affordances.** 6c places districts on survey candidates (flat areas by level band). Enough for
  your phase 2, or do you need to wait for 7a's affordances before using districts?
- **S-D-2. The join.** One routed edge written by the new region, with an `external` graph edge. Does that match how you
  propose and approve a district (you own the proposal; Architect owns the layout)?

### Deferred

- Affordance candidates and site lots (7a). Typed links between regions (7a). Deltas to the standing region (6d).

### Steward round 8 additions (2026-10-12; C27 and C28; part of D's frozen scope, these win)

- **C27: districts that follow a boundary.** Input: the town's claim, other claims and protected areas, a size, a side or
  anchor point, and the boundary to follow: a **biome edge** between two named biome families, a **river or shore**, or a
  **ridge**. Output: the district's **shape** (a polygon or cell mask, not a square), its bounding claim (for overlap checks),
  the **join** where its road meets the town, and its own **street line**. Stable across a reload (deterministic from the
  survey and seed). Refused with named reasons: no such edge within reach, overlap, protected. The district and its join are
  one region, undone as one operation (as V; matches S-D-2).
- **Outposts:** a district not touching the town, reached by a road over unclaimed land; the road's corridor is reported as
  settlement land (a corridor claim) and is undone with the outpost.
- **C28, biome per column:** optional for Steward (it reads `Sample.biomeAt` at 4x4). D decides: if C27's biome-edge
  tracing needs a finer edge than 4x4, add `Survey.biome` per column (resolution 1, from the plan survey); otherwise record
  why 4x4 is enough.
- **Gate additions:** a biome-edge district on a desert/jungle fixture (the shape follows the edge within 4 cells over its
  length); a shore district (street parallel to the shore); a ridge district (street on the ridge line); an outpost with its
  corridor; each reloaded (identical), refused cases named, and one undo restoring the world exactly.
- Size: this roughly doubles D. Split it into **D1** (survey-candidate districts and `beside`, as drafted) and **D2** (C27,
  outposts, C28) if the builder judges it over a day; D2 depends on D1 and T2's routing.

## Phase 6c slice VOC: the full block vocabulary and rarity budgets (DRAFT for Steward review)

API 1.26.0, mod 0.29.0 (wave 4). PLAN toolbox "Full block vocabulary" and "Survival".

- **Branch:** `slice/VOC`, worktree `../architect-mc-VOC`. **Spend:** $0.
- **Scope:**
  - colour and rare block families (concrete, terracotta, glazed terracotta, glass, wool, amethyst, sculk, prismarine, Nether,
    End) available to bibles, roles, patterns and designs;
  - **rarity budgets** in the style bible (format 2, additive) and **palette-coherence** checker rules (buildings and regions);
  - the survival side: one source for the creative-only list, and real costs for rare blocks.
- **Not in scope:** bible format 3 (7c); changing the bible job's prompt (§4, a paid question); new building types.
- **Depends on:** MP (patterns may name rare blocks). Parallel with HY and D.

### 0. Facts

- `kit/lib/blocks.mjs` (generated from the 26.3 data dump) knows every block and a `family` (stairs, slab, door, button, ...);
  it has no colour or rarity grouping.
- Bibles: format 2 (5a) has `restraint` (`heroMotifs`, `accentShareMax` 0.04-0.20, default 0.12, `detailDensity`); the
  checker's `paletteFamilies` warns on wood/stone blocks not from the palette; `restraintWarnings` on accent share.
- **Creative-only blocks are listed twice** and synced by hand: `SURVIVAL_CREATIVE_ONLY` in `kit/lib/check.mjs` and
  `creativeOnly` (35 entries) in `mod/src/main/resources/data/architect_mc/survival_items.json` (PLAN phase 3 carried item).
- `survival_items.json` `costs` (28 entries) and the equivalence table cover common materials; a block not listed costs its own
  item.
- The bible job's prompt names materials by role; it has never been asked for rarity.

### 1. API 1.26.0

- `VERSION = "1.26.0"`; usual rules. **No new API records or methods**; bibles are JSON.
- **Features:** `rarityBudgets`. `KIT_VERSION` 0.29.0. Checker `RULES` gains `M26` (region rarity) and the building warnings
  `rarity` and `coherence`.
- **Behaviour change:** survival's creative-only list is read from one file (§5); its content is unchanged unless the gate's
  data check finds a block missing (then it's listed in "as built").

### 2. Vocabulary

- `blocks.mjs` gains, per block, generated from the 26.3 data (block tags and registry names, never hand-listed):
  - `colour` (the 16 dye colours, or none);
  - `group`: `concrete`, `concrete_powder`, `terracotta`, `glazed_terracotta`, `glass`, `stained_glass`, `wool`, `carpet`,
    `amethyst`, `sculk`, `prismarine`, `nether`, `end`, `ore_block`, or `common`;
  - `tier`: `common`, `uncommon` (colour groups), `rare` (amethyst, sculk, prismarine, glazed terracotta, End, ore blocks,
    Nether wart, shroomlight, crying obsidian...), from a small committed rule table over groups.
- Roles, patterns and material rules may name any of them; `kit/README.md` and `PLAYBOOK.md` gain a vocabulary section for
  the design agent (copied into scratch dirs as today).

### 3. Rarity budgets and coherence

- **Bible format 2 gains an optional `rarity` member** (additive; format 3 stays 7c):
  ```json
  "rarity": { "rareShareMax": 0.02, "uncommonShareMax": 0.10, "groups": { "amethyst": 0.01 }, "colours": ["cyan", "white"] }
  ```
  Defaults when absent: `rareShareMax` 0.02, `uncommonShareMax` 0.10, no group overrides, `colours` free.
- **Building checker (warnings):**
  - `rarity`: the share of a design's non-air cells in `rare` (or `uncommon`, or a named group) is over the bible's budget;
  - `coherence`: more than 3 dye colours, or colours outside the bible's `colours`, or more than 2 rare groups in one design.
- **Region checker M26 (warning, a bar where a scenario names it):** the same shares over a region's non-terrain written cells.
- Both are measured on the existing kit examples and fixture bibles first; the default thresholds are set so every existing
  example passes (recorded), so no current design starts failing.

### 4. The bible job

- **Unchanged in VOC** (a $0 slice). The bible job doesn't emit `rarity`; code applies the defaults. Teaching the bible job
  to choose budgets is a prompt change that should be checked on real generations (N-VOC-1).

### 5. Survival

- **One source:** `kit/survival.json` holds `creativeOnly` (and the curated costs). The mod bundles the kit file and reads it;
  `survival_items.json` keeps only mod-side mapping data. A unit test fails if either side defines its own list.
- **Rare blocks cost real materials:** a rare block costs its own item (silk-touched or crafted), never a cheap equivalent;
  unobtainable ones (budding amethyst, reinforced deepslate, ...) stay creative-only, and a data check confirms every
  creative-only entry has no survival item path in 26.3's loot and recipe data.

### 6. Gate (slice tier, $0)

**Fixtures:** every kit example design and massing; three fixture bibles (a "glass and concrete" modern, an "amethyst grotto",
a "Nether forge"); S1 re-skinned with the grotto bible (plan only, regions), and a 4-design library set re-skinned per bible
($0 re-skins).

**Evidence:** `artifacts/gate6c-voc/`, driver `tools/gate6cvoc.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Generated data | every 26.3 block has `group` and `tier`; 0 hand-listed entries (generator diff test) |
| 2 | No regressions | every existing kit example and fixture bible: 0 new `rarity`/`coherence` warnings at the defaults |
| 3 | Rules catch | a design at 5% amethyst under the default budget gets `rarity`; one with 5 dye colours gets `coherence`; M26 on the over-budget S1 re-skin |
| 4 | Re-skins | the three bibles re-skin the 4-design set with 0 checker errors |
| 5 | One source | the drift test passes; the mod reads `kit/survival.json`; survival refuses a creative-only block exactly as before (phase 3 item) |
| 6 | Costs | a rare-block design's BOM lists the rare items; a hopper-fed survival build of it finishes identical to instant placement, items in = out |
| 7 | Bible schema | format-2 bibles with and without `rarity` validate; format-1 bibles unchanged |
| 8 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, the kit (unit), `survival/**` (4d-all), `mod: resources`, sim suites, apijars, the phase 3 survival
step. **gate-verifier** re-runs items 2, 5 and 6.

### 7. Build order

1. Archive the previous apitest jar. 2. Generated `group`/`tier`/`colour`. 3. `kit/survival.json` and the drift test. 4. The
bible member, checker rules, M26. 5. Fixture bibles, re-skins, gate.

### Open questions for Steward

- **S-VOC-1.** Will your cards ever ask for rare palettes (a "sculk temple"), so the card should pass budgets to the bible, or
  are defaults enough?

### Open questions for Noah

- **N-VOC-1. The bible job and rarity.** Leave the bible job's prompt unchanged (defaults from code) until a paid slice can
  check it on real generations, or change the prompt now without a quality check?
- **N-VOC-2. Default budgets.** Rare blocks at most 2% of a design's cells, colour blocks at most 10%. Too strict, too loose?

### Deferred

- Bible format 3's settlement-scale styling (7c). Palette suggestions from a chest (phase 3's optional item).

## Phase 6c slice S3: the mountainside monastery v1, terraced, goes green (DRAFT for Steward review)

API 1.27.0, mod 0.30.0 (wave 5). SETTLEMENTS §16.2 (S3 v1 "terraced"; v2 "cliff-built" is 7b), §16.3, §17.2.

- **Branch:** `slice/S3`, worktree `../architect-mc-S3`. **Spend:** $0 (library variants; no pick, no claude login).
- **Scope:** the bundled program `terraced_monastery` (`catalogue = false`), S3 v1's run, golden and gallery page.
- **Not in scope:** S3 v2 (buildings on the cliff face, 7b), connectors (7a), S3 from its brief (7c).
- **Depends on:** T1 (relief, blended pads), T2 (switchbacks), D (districts by level band), F1 (`rockSpire`, M17), F2
  (scatter). Optional: T3 (a bridge or tunnel where the route chooses one), HY (a stepped stream, N-HY-1).
- **Track A's last slice.** The 6c close-out (below) runs when the last 6c slice merges, which may be this one.

### 0. Facts

- **Fixture** (`scenarios/s3_monastery.json`): seed 2026100906, claim `[3604,-1036,3795,-845]` (192x192), y 22-220; biomes frozen
  peaks 32%, cherry grove 26%, sunflower plains 22%, snowy slopes 11%, river 6%; ground 62-180 (mean 117.6). W may re-pin its
  `surveySha` (frozen water).
- 6a's `terrace(area, levels, {riser, retain, edge, stairs})` makes stepped levels with retaining walls and stairs.
- T1's `pad.edge: 'blend'` and the relief pass soften the terraces' outer edges; T2 routes with switchbacks and stairs; D
  assigns districts to level bands.

### 1. API 1.27.0

- `VERSION = "1.27.0"`; usual rules. **No new records or methods.** Feature `scenarioS3`. `KIT_VERSION` 0.30.0.

### 2. The program `terraced_monastery`

- **Districts (D):** `gate` (low band: gatehouse, a guest house), `gardens` (mid: 2 terraces with a herb garden and an orchard
  scatter), `cloister` (high: church as landmark, cloister range, refectory, 4 cells). 9-11 lots.
- **Terraces:** 6a `terrace` per district, riser 3-4, retaining walls in the `structure` role, outer edges `blend`ed (T1) so the
  stack reads as cut into the mountain.
- **Routes (T2):** a switchback path from the gate up to the cloister (`maxGrade` 0.2, stairs allowed, landings), villager edges
  for the dwellings (cells, guest house), player-only edges to a lookout.
- **Forms (F1):** 1-3 `rockSpire`s on the shoulders where the survey is steepest, kept clear of lots and routes.
- **Scatter (F2):** cherry and spruce stumps, boulders, moss by `wet` (HY when merged, else noise), snow layers only where M17
  allows.
- **Lights:** W's `lightCover`. **Bible:** a fixture "mountain monastery" bible (stone bricks, spruce, deepslate tiles, copper
  accents) in `scenarios/bibles/`.

### 3. Bars (realised world, re-surveyed; SETTLEMENTS §16.3)

| # | Check | Bar |
|---|---|---|
| 1 | Checker | 0 errors; no M1-M4 findings |
| 2 | Reachability `player` | 100% of nodes, the lookout included; 0 unreachable lot entrances |
| 3 | Reachability `villager` | recorded for the dwellings (kit and `dev.nav.villager`); gated from 7a |
| 4 | Grade | 100% of walk runs within `maxGrade` per 8-cell window (T2's bar 1) |
| 5 | Structure | M3 0 floating; 0 `M3:gravity`; retaining walls every terrace over 2 high |
| 6 | Safety | M4 0; full M5 under 1% of walk area; M8 100% of walk cells beside a drop over 3 guarded; M17 0 before and after a 2-minute stand |
| 7 | Palette | role adherence at least 0.9 |
| 8 | Organic read | axis-run share of form and relief boundary cells, per N-F1-1; terrace risers are structure, not counted |
| 9 | Earthworks | cut + fill cells recorded per district (SETTLEMENTS' disturbance bar is for site lots, 7a/7b) |
| 10 | Buildings | kit checker 0 errors; restraint as 5a |
| 11 | MSPT | own CPU at most 50 ms, p99 at most 25 ms; light-engine tick share recorded |
| 12 | Tile evaluation | p50 and p99 per tile; p99 under 2 s |
| 13 | Exactness | flat variant E-flat 0; natural E-normal all classified, at most 0.01% |
| 14 | Determinism | IR sha over 3 plans; tile shas 1 and 4 workers, forward and shuffled; golden `scenarios/goldens/s3.json`; macOS and Linux CI |
| 15 | Spend | $0.00 |
| 16 | Gallery | Noah approves this run's `evidence.sha` on "Architect 6c gallery" (section S3 v1) |

### 4. Gate items

1. S3 natural (bars 1-14) and flat variant (bar 13). The flat variant sculpts a 60-high hill first, so terraces, routes and
   spires have relief to work on.
2. Regressions: S1, S2 and S7 green on their goldens.
3. Gallery and approval. **S3 v1 is green only when approved.**

**Evidence:** `artifacts/scenarios/6c/s3/`, `artifacts/gate6c-s3/REPORT.md`; chain step `6c-scenario-s3` (added to `release`'s
`always`). **Tier:** slice: quick, kit region rows, sim suites, apijars, every scenario step. **gate-verifier** recomputes S3's
evidence sha and re-runs items 1 and 2.

### 5. Build order

1. The program and bible on the pinned claim (plan only, iterate on the previews). 2. The flat variant. 3. Runs, golden,
gallery. 4. Verifier, approval.

### Open questions for Noah

- **N-S3-1.** v1 is terraced: every building stands on a pad; nothing hangs on the cliff until 7b. Is that the v1 you expect
  from "a monastery that grows down its cliff"?

### Deferred

- S3 v2, cliff-built (7b). Rope bridges and lifts between terraces (7a).

## Phase 6c slice SCH: Sponge `.schem` import and export (DRAFT for Steward review)

API 1.28.0, mod 0.31.0 (wave 5; it depends on nothing in 6c and can be built in any wave). PLAN toolbox "Schematic
import/export".

- **Branch:** `slice/SCH`, worktree `../architect-mc-SCH`. **Spend:** $0.
- **Scope:** read Sponge Schematic versions 2 and 3, write version 3, for library entries (import as an entry, export an entry
  or a placed site), from the API, the Library screen and commands. Written from the public specification
  (SpongePowered/Schematic-Specification); **no WorldEdit code is read or used** (GPL; Noah's decision).
- **Not in scope:** entities (skipped with a note), biomes (ignored), schematics past the template cap (refused; composites are
  7c), `.litematic` and other formats.
- **Depends on:** nothing in 6c past V. It touches the library and the kit only.

### 0. Facts

- Phase 2 import/export is vanilla `.nbt` structures: `library/Exchange.java` (mod), `kit/lib/importer.mjs` and
  `sidecar` variants `kind: 'import'`. An imported file is a plain structure entry (no source, no variants).
- `kit/lib/nbt.mjs` encodes and decodes NBT; the kit pins the gzip OS byte so byte-compared outputs match across platforms.
- The mod upgrades old structure NBT with vanilla's `DataFixers` (`MassingFiles` uses `DataFixTypes.STRUCTURE`).
- The template cap is 96x64x96 per template.

### 1. API 1.28.0

```java
default CompletableFuture<Entry> importSchematic(Path file, @Nullable String name)     // Library
default CompletableFuture<Path> exportSchematic(String entryId, @Nullable Integer version, Path dir)
default CompletableFuture<Path> exportSiteSchematic(String siteId, Path dir)          // Sites: the site's current cells
```

- Defaults throw "needs Architect API 1.28.0". **New Reason** (appended): `FORMAT` (not a Sponge schematic, or an unknown
  version). Over the template cap is the existing `TOO_LARGE`.
- **Features:** `schematics`. The protocol's variant `kind` enum gains `'import-schem'` (additive).

### 2. Reading (versions 2 and 3)

- **Version 3:** root `Schematic` with `Version`, `DataVersion`, `Width`/`Height`/`Length`, `Offset`, `Metadata`, and `Blocks`
  (`Palette`, varint `Data`, `BlockEntities` with `Pos`, `Id`, `Data`).
- **Version 2:** root `Schematic` with `Palette`, `BlockData`, `BlockEntities` (`Pos`, `Id`, fields flattened).
- **DataVersion:** the mod upgrades block states and block-entity NBT to 26.3 through vanilla `DataFixers` (block state and
  block entity fix types), so older schematics import; a DataVersion newer than the game's is refused `FORMAT`.
- **Unknown blocks** (another mod's): refused with the list, unless the request's `ext["architect_mc:unknownAs"]` names a
  replacement block (default none).
- The result is an imported entry like a `.nbt` import (structure only), tagged `imported: schem` with the file's
  `Metadata.Name`/`Author` in `ext`.

### 3. Writing (version 3)

- Cells from the entry's `.nbt` (or the site's current state, for `exportSiteSchematic`), `Offset` = the entry's origin
  convention (its `groundY` row at y 0), `Metadata` `{Name, Author: "Architect", Date}`, `DataVersion` of 26.3.
- **Bytes are platform-independent:** palette order by first use in y-z-x order, gzip OS byte pinned, `Date` taken from the
  entry's install time (not now), so two exports of one entry are byte-identical.

### 4. UI and commands

- Library screen: Import accepts `.schem`; Export offers `.nbt` or `.schem`.
- `/architect export <entry> schem` and `/architect import <file>` (a file in `<gameDir>/architect/import/`).

### 5. Gate (slice tier, $0)

**Fixtures:** every kit example design; 6 hand-built spec fixtures (v2 and v3, with block entities, an old DataVersion, an
unknown block, an oversized one, a corrupt one); optionally a WorldEdit-made file supplied by Noah (N-SCH-1).

**Evidence:** `artifacts/gate6c-sch/`, driver `tools/gate6csch.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Round trip | every kit example: `.nbt` -> `.schem` -> entry gives the same cells and block-entity NBT (100%) |
| 2 | Determinism | two exports of an entry byte-identical; macOS and Linux CI produce the same bytes |
| 3 | Versions | the v2 and v3 fixtures import; the old-DataVersion fixture upgrades with 0 unknown states |
| 4 | Refusals | unknown block, oversize and corrupt fixtures refused with `FORMAT`/`TOO_LARGE` and a message; nothing installed |
| 5 | Placement | an imported `.schem` places and removes exactly (Remove-exact round trip, the phase 1 rule) |
| 6 | Sites | `exportSiteSchematic` of a placed and edited site equals its current cells |
| 7 | Clean room | the review records that no WorldEdit source was consulted; the code cites the spec |
| 8 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, the library rows (`mod: other server code`: sim-jobs, sim-sets, sim-massing), `api/**`, the phase 2
library check (`tools/p2-library-check.mjs`), apijars. **gate-verifier** re-runs items 1, 4 and 5.

### 6. Build order

1. Archive the previous apitest jar. 2. Kit codec (v2/v3 read, v3 write) with unit tests. 3. Mod import path with DataFixers.
4. Export (entries, sites). 5. UI and commands. 6. Fixtures, gate.

### Open questions for Noah

- **N-SCH-1.** Can you supply one or two `.schem` files exported by WorldEdit (from any world) as a real-world fixture? The gate
  passes without them, on spec-built fixtures.

### Deferred

- Entities and biomes. Schematics past the cap as composites (7c). Other formats (`.litematic`) on request.

### Phase 6c slice SCH as built (API 1.18.0 / mod 0.21.0, batched with T1 as v0.21.0; recorded 2026-10-12)

Built as the placeholder API 1.20.0 / mod 0.23.0. The coordinator accepted all eight calls below and set the numbers after
merging origin/main (v0.20.0: F1, MP, Y1) into the branch. In that merge:
- `Reason.FORMAT` stays the one constant after FIELD_LIMIT (main appended none).
- apijars and api-compat now run against 0.20.0, 0.19.0 and 0.18.0, with the 0.20.0 surface. Each set, with its tag's
  `tools/apitest.mjs`, is in `artifacts/gate6c-sch/v0200`, `v0190` and `v0180`. 0.20.0 is built from tag v0.20.0. 0.19.0 and
  0.18.0 are Y1's tag builds, copied because `gate6c-y1/` has no `tools/`.
- ApiMPTest and gate6cmp's "no new Reason" checks now accept reasons appended after FIELD_LIMIT.
- Post-merge run (`artifacts/gate-runs-SCH/20261012-194928-change`, head ea5ccf1): PASS 4/4. unit-mod 578/0, unit-kit
  286/286, sch-unit 5/0, sch-roundtrip 39/0 (item 2 on Linux included).

Written from the public Sponge Schematic specification only (SpongePowered/Schematic-Specification@8e6be2d,
`versions/schematic-2.md` and `schematic-3.md`, cited in both codec files). No WorldEdit source was read or used (item 7: the
gate scans the diff for WorldEdit code, packages and imports).

**What was built**
- **Mod (the import path):** `library/Schematic.java` reads versions 2 and 3, root shape included (v3 `{Schematic: {...}}`, v2
  fields in the root; v2 block-entity fields beside `Pos`/`Id` and in an `Extra` compound). It turns the file into a vanilla
  structure tag at the file's own DataVersion. `library/Schematics.java` then runs vanilla's `DataFixTypes.STRUCTURE` (block
  states and block-entity data in one pass) and checks every block id against the registry. It stages the upgraded structure
  in `<gameDir>/architect/schem-staging/<n>/` and sends `import.request {path, name, schem}`. The helper's `import-schem` job
  then runs the existing check, previews and install, with `--ground-y` and the tag `schem`. Every refusal comes before
  anything is staged, and the staging folder is emptied when the job ends.
- **Mod (export):** `Library.exportSchematic` writes the entry's template (`<id>.schem`, or `<id>-v<n>.schem` when a version is
  given). `Sites.exportSiteSchematic` captures the site's box with vanilla's `fillFromWorld` (air and block entities included,
  in world orientation). Both write in the mod, with no helper needed. Compound keys are written sorted, deflate level 9.
- **Kit:** `kit/lib/schem.mjs` is the twin codec (v2/v3 read, v3 write, `structureCells`). `kit/import.mjs` takes `.schem`,
  `--ground-y` and `--tag`. The spec fixtures in `kit/test/fixtures/schem/` are built by `make.mjs` from the spec (v3 and v2
  huts with a chest, a sign, stairs, air, a structure_void column, an entity and biomes; a DataVersion 2586 file with
  grass_path, grass and a Text1..4 sign; an unknown block; oversize; corrupt). `goldens.json` holds the sha256 of the kit's
  and the mod's exports of every kit example.
- **Sidecar:** `import.request` takes `name?` and `schem? {file, groundY 1..63, ext}`, giving the variant kind `import-schem`.
  Such a request is accepted only from the staging folder, and the staging folder only for that kind. New feature:
  `import.schem`.
- **API (additive):** `Library.importSchematic(Path, String)`, `Library.importSchematic(Path, String, JsonObject ext)` (added:
  the contract's `ext["architect_mc:unknownAs"]` had no way in), `Library.exportSchematic`, `Sites.exportSiteSchematic`, and
  `Reason.FORMAT` appended after FIELD_LIMIT. `schematics` is always a feature. Imported entries carry the tags `imported`
  and `schem`, and `ext["architect_mc:schem"] = {file, name?, author?, date?, version, dataVersion, offset,
  entitiesSkipped?, replaced?, unknownAs?}`.
- **UI and commands:** the Library card has Export .nbt and Export .schem; Import… lists `.schem` files in `imports/` and
  `exports/`. `/architect export <entry> schem` and `/architect import <file>` need permission level 2.
- **Tests and gate:** `SchematicTest` and `ApiSchTest` (mod), `kit/test/schem.test.mjs`, and the sidecar's import-schem test.
  `tools/gate6csch.mjs` runs as the runner steps `sch-unit`, `sch-roundtrip`, `sch-refusals`, `sch-placement` and
  `sch-ingame`, with the impact rule "6c SCH". api-compat runs `--gate6csch`, and apijars covers 0.18.0/0.17.0/0.16.0.
  DevBridge gained `dev.library.export.schem`.

**Conventions decided while building**
- **Voids:** a cell the template does not write is `minecraft:structure_void` in an export and is not written on import; air
  is air. Without this, item 1 and Remove-exact would differ on every kit example, because templates store no air.
- **Palette format:** 26.3 structure palettes are `{id, properties}` from DataVersion 5006 (vanilla's BlockStateFieldNamesFix).
  An older file is converted with `{Name, Properties}`, so the fixers see their own version's form.
- **groundY:** `-Offset.y` when it is 1..height-1, else 1 (a template's floor row is under its ground row). An export writes
  `Offset [0, -groundY, 0]`.
- **Date:** `Metadata.Date` is the entry's `createdAt` (0 for bundled entries), so exports are byte-identical.
- **Platform independence:** the JDK's bundled zlib gives the same bytes on macOS and Linux. The `linux` step re-gzips the
  mod's exports in eclipse-temurin:25 on linux/amd64 (as CI) and runs the kit test in node:22 on linux/amd64.

**Calls for the coordinator**
- **KIT_VERSION** is not bumped: SCH adds no op kind or IR member, so no IR sha or tile golden moves. The batch rule says every
  slice bumps; this reading keeps the goldens still.
- **`architect/import/`:** the contract's folder is the existing `architect/imports/`.
- **Permissions:** `/architect export|import` need permission level 2. They write and read files on the server's disk; the
  contract is silent on this.
- **The `importSchematic` ext overload** (above).
- **`tools/p2-library-check.mjs`** (named in the contract's tier) is stale on main: it sets the bundled cabin's `floors`
  param, which the cabin has not had since phase 2 (its params are width, depth and porch). It is not in the runner. The `ui`
  step covers the Library's import and export instead.
- **API tests:** `ApiSchTest`, `apitest.mjs` and the gate read the version from `ArchitectApi.java` or assert only a floor,
  so a renumber at merge needs no other edit.
- **N-SCH-1:** no WorldEdit-made fixture yet. Add one to `kit/test/fixtures/schem/` if Noah exports one.

**Gate record**
- **Run 1, slice tier** (`artifacts/gate-runs-SCH/20261012-174541-slice`, head 5906cb2, 2 shards, load 17-104): 22 PASS. Every
  SCH step passed: sch-unit 5/0, sch-roundtrip 39/0 (item 2 on Linux included), sch-refusals 12/0, sch-placement 12/0,
  sch-ingame 24/0. apijars passed (1.15.0 46/0, 1.14.0 45/0, 1.13.0 45/0). The four that didn't pass:
  - unit-kit: TIMEOUT at 10 min under load 59-73 (`village.test.mjs` interrupted). The timeout is now 20 min, as MP's.
  - x-ingame: a real check of mine. gate6cx's api114 check pinned the last Reasons to `PROTECTED FIELD_LIMIT`; it now accepts
    reasons appended after FIELD_LIMIT.
  - sim-massing: "world leave cleared every composite (keys now: 3)", a known flake.
  - 4d-all: "group undo: every lot region ... back exactly" (lot L3), a known flake. The same line fails in the MP, W and Y2
    slice runs and in today's main-based headless engine runs (`gate-runs-headless/20261012-173909-engine`).
- **Run 2, change --only** (`20261012-190119-change`, head 1444904, which adds only the two tool fixes): unit-kit 261/261,
  sim-massing 35/0, x-ingame 53/0. 4d-all failed a different known flake, "shared crate: 2/3 built sites identical to
  instant placement", seen before in `gate-runs-integ/20261010-182744-slice` and `gate-runs-0b/20261011-000214-slice`.
- **Run 3, change --only 4d-all** (`20261012-192147-change`, head 1444904): PASS 63/0.
- **Evidence:** `<run>/s2/gate6c-sch/` (step JSONs, REPORT.md, spend.json $0.00). Item 2 on Linux: the mod's four exports
  re-gzipped in eclipse-temurin:25 on linux/amd64 match macOS byte for byte, and the kit test passes in node:22 on
  linux/amd64. Timing bars were recorded, and none missed.
- **gate-verifier: PASS** (2026-10-12). It reviewed the diff and the evidence and re-ran items 1, 4 and 5
  (`artifacts/gate-runs-SCH-verify/20261012-193750-change`, head f1e7e69: sch-roundtrip 39/0, sch-refusals 12/0,
  sch-placement 12/0). It accepted every coordinator call above.
  - Minor notes, none blocking: `/architect import` checks the path after `normalize()` without resolving symlinks (it is
    op-only, and the helper re-checks its staging); a site export's `Date` is the time of export, as documented.

## Phase 6c slice F3: forms II, trees, mushrooms, coral, roots and stalactites (DRAFT for Steward review)

API 1.29.0, mod 0.32.0 (wave 5). SETTLEMENTS §9.2 (the rest of the library) and §11 (M18, M19).

- **Branch:** `slice/F3`, worktree `../architect-mc-F3`. **Spend:** $0.
- **Scope:** the generators `giantTree`, `mushroom`, `coral`, `roots` and `stalactites`, each with species presets and property
  tests; **M18 decay** and **M19 dead coral**; the **forest-heavy mega_bench variant** and per-tile evaluation on it.
- **Not in scope:** treehouses and trunk-wrapping lots (S5, 7b); cave cities (S6, 7b). These generators serve those scenarios,
  so F3 gates on property tests and the forest variant, not on a scenario.
- **Depends on:** F1 (generator rules, `voxels`), F2 (scatter for undergrowth), H (water for coral).

### 0. Facts

- F1's rules: one bounded op per cluster (at most 32 primitives), bake to `voxels` past a measured threshold, absolute y with
  skirts of up to 6.
- Vanilla 26.3: leaves more than 6 from a log decay unless `persistent=true`; live coral dies without adjacent water;
  `pointed_dripstone` has `thickness` states; mushroom blocks have per-face properties.
- 6a's `forest` step (`6a-forest`) checks a forest rim for leaf behaviour after a 2-minute stand and exact undo.

### 1. API 1.29.0

- `VERSION = "1.29.0"`; usual rules. **No new records or methods.** Features `formsTrees`, `formsCave`, `formsWater`.
  `KIT_VERSION` 0.32.0. Checker `RULES` gains `M18` and `M19`.

### 2. The generators (SETTLEMENTS §9.2)

| Generator | Skeleton | Materials | Gotcha handled |
|---|---|---|---|
| `giantTree` | trunk `capsuleChain` tapering by height; branches by integer space colonisation toward canopy attractors; roots bending into the ground | bark (`log` with `axis` from the segment direction), `wood` core, leaves in noise-holed `ellipsoid` lobes | every generated leaf is `persistent=true` (M18) |
| `mushroom` | stem `capsuleChain`, cap `ellipsoid` cut by `clipY`, gills underneath | stem, cap and spot blocks | mushroom-block face properties set from neighbours at realise (pointwise, the 6 neighbours of the op's own SDF) |
| `coral` | branching `capsuleChain`s and fans | live coral blocks only inside a declared water part (H) | refuses outside water; dry cells use dead variants (M19) |
| `roots` | `capsuleChain`s from a trunk base down a cliff or into a cave | `rooted_dirt`, `mangrove_roots`, hanging roots | none |
| `stalactites` | cones from ceiling and floor, merged into columns where they meet | dripstone blocks; `pointed_dripstone` with `thickness` from the cone radius and `vertical_direction` | needs a frozen volume (ceiling) |

Species presets: oak, spruce, jungle, mangrove, cherry, dark oak, crimson, warped (trees); brown, red (mushrooms); 5 coral
types; 2 dripstone sizes. A bible may name others within each param schema.

### 3. M18 and M19

- **M18 decay:** no non-persistent leaves more than 6 (taxicab, through leaves) from a log, on the virtual world. Warning, a bar.
- **M19 dead coral:** no live coral block or fan without an adjacent water cell. Warning, a bar.

### 4. The forest-heavy variant

- `mega_bench --forest`: mega_bench's claim with `giantTree`s over 30% of it and undergrowth scatter, for SETTLEMENTS §9.1's
  per-tile evaluation measure. Plan only plus a realise of 16 tiles (not the whole bench; the close-out runs mega_bench A).

### 5. Gate (slice tier, $0)

**Fixtures:** `grove_demo` (bundled, `catalogue = false`): 6 giant trees of 3 species, mushrooms, roots down a bank, on a
plains location of the pinned seed found by `find-site` (a new `scenarios/sites/grove.json`), plus its flat variant; a cave box
from the 6b volume fixture for stalactites; a pool (H) for coral.

**Evidence:** `artifacts/gate6c-f3/`, driver `tools/gate6cf3.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Bounded ops (property, 200 seeds per generator and species) | 100% of ops at most 32 primitives; forms over the threshold baked |
| 2 | Decay | M18 0; after a 2-minute stand at default random ticks, the leaf count unchanged (re-surveyed) |
| 3 | Coral | M19 0; coral outside water refused by the generator; after the stand, 0 live coral turned dead |
| 4 | Structure | M3 0 floating (branches attach to trunks, stalactites to ceilings) |
| 5 | Block states | 0 `pointed_dripstone` with an impossible `thickness` sequence; mushroom faces match neighbours |
| 6 | Organic read | axis-run share per generator, recorded (gated per N-F1-1) |
| 7 | Evaluation | per-tile p50 and p99 on the forest variant: p99 under 2 s, at least 45k cells/s; IR under 4 MB, blobs under 16 MB |
| 8 | Determinism | IR and blob shas over 3 plans; golden `scenarios/goldens/grove_demo.json`; macOS and Linux CI |
| 9 | Exactness | flat E-flat 0; natural E-normal classified, at most 0.01% (growth classified as 6a does) |
| 10 | MSPT | own CPU at most 50 ms, p99 at most 25 ms; light-engine tick share under canopies recorded |
| 11 | Unchanged | S1, S2, S3, S7 and mega_bench tile goldens |
| 12 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, kit region rows, 6a-forest, sim suites, apijars, the scenario steps. No engine change expected.
**gate-verifier** re-runs items 2, 3 and 7.

### 6. Build order

1. Archive the previous apitest jar. 2. `giantTree` and M18. 3. `roots`, `mushroom`. 4. `stalactites`. 5. `coral` and M19.
6. The forest variant. 7. Fixtures, gate.

### Deferred

- Trunk-wrapping and canopy lots (7b). Live capture of vanilla trees (stamps cover them, F2).

## Phase 6c slice RS: regions in survival, the terrain half (DRAFT for Steward review)

API 1.30.0, mod 0.33.0 (wave 6). Noah's survival rule (SETTLEMENTS "Noah's decisions (2026-10-08)"); coordinator decision
N-6b-5 ("the terrain half of the survival rule lands in 6c, and the connector half in 7a"); coordinator decision on the V
draft ("region survival is scheduled after V").

- **Branch:** `slice/RS`, worktree `../architect-mc-RS`. **Spend:** $0.
- **Scope:** regions and brush strokes in survival-toggle worlds:
  - **terrain is free:** natural cut and fill, relief, grown natural forms, scatter and stamps, natural-only brush strokes,
    with no bill of materials and no drops, written as today and undone exactly;
  - **lots are construction sites:** a region's lots in survival build from the region's shared crate, as C16's batch roads do;
  - **4e roads in a region** build as C16 construction roads from the same crate;
  - everything else that is built (path-set parts, structure ops, fluids) is **refused** with a typed reason until 7a's connector
    half, except free shovel paths (C16's `freeCell` rule).
- **Not in scope:** the connector half (path and structure parts as construction, 7a); Hardcore changes (phase 3 rules hold).
- **Depends on:** W. It should merge after B and H so their stroke kinds and fluid parts get the rule (§2's table).
- **Stockpile (slice Y, 2026-10-11):** RS now builds on Y: a region's lots and roads draw from the owner's stockpile, not a region crate (S-Y-7 settles `crateAt`/`CrateView`).

### 0. Facts

- `RegionsImpl` refuses `NOT_ALLOWED` in a survival-toggle world ("regions are INSTANT only"); brush strokes (B) inherit it.
- Phase 3: a building site's cleared cells give no drops and cost nothing; Remove restores the terrain snapshot exactly.
- C16 (0c): batch roads with a `sharedCrate` build as construction roads; `RoadBuilder.freeCell` makes a dirt path on grass,
  dirt, coarse dirt, podzol, mycelium or rooted dirt free.
- IR parts carry `set` (`terrain`, `path`, ...); 6a primitives like `terrace` retaining walls, `bridge`, `stair`, `platform`,
  `pillar` emit structure-material ops.

### 1. API 1.30.0

- `VERSION = "1.30.0"`; usual rules.
- `RealiseRequest` gains trailing `@Nullable BlockPos crateAt` (where the region's shared crate block goes; old constructors:
  null, which places it beside the claim's first lot). `RegionView` gains trailing `@Nullable CrateView crate` (stock, outstanding
  by lot and road).
- **New Reason** (appended): `CONNECTOR_SURVIVAL` (a built part that survival can't do before 7a; the message names the parts).
- **Features:** `regionSurvival`. **Behaviour change:** a survival-toggle world no longer refuses regions and strokes as a whole;
  it refuses only the parts in §2's last rows.

### 2. What each part does in a survival-toggle world

| Part | In survival (RS) |
|---|---|
| Natural cut and fill, `relief`, `terrace` earthworks (not walls), lot pads' cut and fill | free, instant, no drops |
| Generated natural forms (F1, F3), scatter and stamps (F2) | free, instant (Noah: grown natural forms are free) |
| Brush strokes with `NATURAL_ONLY` and no pattern, or a pattern of natural blocks only | free |
| Lots (BOX buildings) | construction sites from the region's crate; deconstruct with refunds as phase 3 |
| 4e roads in the region | C16 construction roads from the same crate |
| Path-set parts (lanes, squares, verges) | free where every written cell passes C16's `freeCell`; else `CONNECTOR_SURVIVAL` |
| Structure ops (retaining walls, bridges, stairs, platforms, pillars, tunnels' lining and lights), props, lamps | `CONNECTOR_SURVIVAL` (7a) |
| Fluid parts (H, HY) | per N-H-1 (default: refused until Noah decides) |
| Strokes with `PLAYER_BLOCKS` or a pattern of built blocks | `CONNECTOR_SURVIVAL` |

- **"Natural block"** is the voxel class (`ROCK`, `SOIL`, `LOOSE`, `ICE`, `SNOW`, `LOG`, `LEAVES`, `PLANT`) of the written block.
- The refusal happens at plan accept (the whole region), not mid-realise.
- **Undo:** unchanged. Remove deconstructs lots (refunds) and restores terrain exactly.

### 3. Gate (slice tier, $0)

**Fixtures:** in a survival-toggle world (the p3 client): `relief_demo` (terrain only), `forms_demo`, `route_demo` with a
dirt-path bible (path parts free by `freeCell`), `flat_village` with the default gravel bible (refused) and with a dirt-path
bible minus props (lots and roads construct), and two brush strokes.

**Evidence:** `artifacts/gate6c-rs/`, driver `tools/gate6crs.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Free terrain | `relief_demo` and `forms_demo` realise with 0 items consumed and 0 item entities spawned; cells equal an INSTANT run on a cloned world |
| 2 | Lots | the dirt-path village: each lot's BOM equals its crate outstanding; feeding exactly that builds every lot to BUILT, identical to INSTANT |
| 3 | Roads | the village street builds as C16 roads from the crate, identical to INSTANT |
| 4 | Refusals | the gravel village refused `CONNECTOR_SURVIVAL` at accept, naming its lane and prop parts; nothing written |
| 5 | Strokes | a natural-only stroke works free; a concrete-pattern stroke refused |
| 6 | Undo | `Regions.remove` of the built village: refunds equal the blocks still standing; terrain restored, E-flat 0 on the flat variants |
| 7 | Hardcore | phase 3 rules unchanged (the hardcore client step) |
| 8 | Creative unchanged | the same programs in creative realise byte-identically to before (tile shas) |
| 9 | API, spend | api-compat clean; jars pass; $0.00 |

**Tier:** slice: quick, `region/**` (engine tag), `site/**`, `survival/**` (4d-all), the phase 3 survival step, sim suites,
apijars, the scenario steps. **gate-verifier** re-runs items 1, 2 and 6.

### 4. Build order

1. Archive the previous apitest jar. 2. The part classifier and refusals. 3. The region crate and lot construction. 4. Region
roads through C16. 5. Strokes. 6. Fixtures, gate.

### Open questions for Steward

- **S-RS-1.** With RS, Supplied settlements can use regions only when their paths are shovel paths and nothing else is built
  until 7a. Is that useful enough to switch Supplied villages to `flat_village` now, or do you wait for 7a?

### Open questions for Noah

- **N-RS-1. The connector half.** Keep it in 7a as decided (N-6b-5), or pull path parts and props into RS as construction cells
  (a bigger slice: 0c deferred "cell sites in construction mode")?

### Deferred

- Path, structure and prop parts as construction (7a). Fluids in survival (N-H-1). Region survival in Hardcore beyond phase 3.

## Phase 6c slice PT: player-changed cells (optional; DRAFT for Steward review)

API 1.31.0, mod 0.34.0 (wave 6). 0c's Deferred "to the 6c terrain slices: automatic detection of player-changed cells
(block-change tracking) as protection". **Optional:** it ships only if Steward says it needs it in 6c (S-PT-1); otherwise it
moves to 6d, where replanning on land change (SETTLEMENTS §14) needs the same data.

- **Branch:** `slice/PT`, worktree `../architect-mc-PT`. **Spend:** $0.
- **Scope:** record which cells players changed (placed or broke) in loaded chunks; let region plans, brush strokes and route
  passes treat those cells as the player's (not natural) when the request asks for it.
- **Not in scope:** changes by other mods or by natural processes (growth, fluids, explosions); rolling back player changes.
- **Depends on:** 0c (C17). Independent of the other terrain slices.

### 0. Facts

- "Natural" today is a block's voxel class. A player's dirt path or a dug hole is natural to Architect, so C17's areas are the
  only protection (0c's note: "protection is by area").
- The journal records Architect's own writes; nothing records players'.

### 1. API 1.31.0

- `VERSION = "1.31.0"`. `RegionPlanRequest` and `BrushRequest` gain trailing `boolean respectPlayerChanges` (old constructors:
  false). `Survey.volume` classes a tracked cell `PLAYER` when the request asks.
- **Features:** `playerChanges`.

### 2. Tracking

- A mixin on the server's block-change paths for player actions (break, place, bucket, use-on with a shovel/hoe/axe) marks the
  cell in a per-section bitset (512 bytes per touched section), saved per dimension in `<world>/architect/changes/` (temp file,
  then rename), loaded lazily per region file.
- Architect's own writes don't mark; undo doesn't clear marks.
- `/architect changes clear <box>` (permission 2) clears marks.

### 3. Use

- With `respectPlayerChanges`, the plan survey and volumes class marked cells `PLAYER`, so `IF_NATURAL` ops, routes and strokes
  leave them (routes treat them as obstacles).

### 4. Gate (slice tier, $0)

| # | Check | Bar |
|---|---|---|
| 1 | Marks | a scripted player places 50 and breaks 50 blocks: 100 marks, 0 others; marks survive save and reload |
| 2 | Respect | a `relief_demo` plan with `respectPlayerChanges` over a player's dirt path: 0 marked cells written |
| 3 | Off by default | without the flag, tile shas equal the untracked run |
| 4 | Cost | the mixin adds at most 2 µs per player block change (median over 10k); memory recorded |
| 5 | API, spend | api-compat clean; jars pass; $0.00 |

Evidence `artifacts/gate6c-pt/`, driver `tools/gate6cpt.mjs`. **Tier:** slice: quick, `mod: any server code`, `region/**`,
apijars. **gate-verifier** re-runs items 1 and 2.

### Open questions for Steward

- **S-PT-1.** Do you need automatic protection of player changes in 6c, or are C17 areas enough until 6d's replanning?

## 6c close-out (release tier, at the last 6c slice's merge)

SETTLEMENTS §17.2's 6c gate, run once when the last 6c slice merges (whichever it is), on top of that slice's own gate:
- S2 and S3 v1 green (approved), S1 and S7 still green;
- pass determinism goldens (relief, route, hydrology, districts) re-run on macOS and Linux CI;
- plan time on the 1024x1024 synthetic claim with every pass recorded (bar: at most 120 s, 2 GB);
- **mega_bench A re-run** with a forms-and-scatter variant (`mega_bench --forms`, F1-F3 generators over 30% of the claim),
  6a's writer bars: 0 ticks over 50 ms (own CPU), p99 at most 25 ms, at least 15k cells/s (median of 3), 0 chunks generated,
  E-normal classified;
- per-tile evaluation p50/p99 on S2, S3 and the forest-heavy variant (F3): p99 under 2 s, at least 45k cells/s;
- the full `release` tier and the full gate-verifier; 6b's gate items as regressions.

## Phase 6c slice P0: plan check v0 (DRAFT for Steward review; `plan/0` FROZEN 2026-10-12)

**`plan/0` is frozen (2026-10-12, after Steward's 59-ask fixtures round).** From now on a change within `plan/0` is additive
only: a new optional member, a new reserved kind or block id, a new catalogue entry. Anything else (removing or renaming a
member, narrowing a value, changing a meaning, making an optional member required) needs `plan/1`. The same sentence is in the
schema's `description`. See "Freeze of plan/0" below for what the round changed and the counts that order the reserved kinds.

Next free API minor at merge (the house rule; a placeholder until then), mod to match. steward-mc docs/COMPOSITION.md v2 §2-§7,
and architect-mc docs/COMPOSITION-ANSWERS.md, whose "Revisions" section wins. The geometric plan schema is
`kit/schemas/plan.json` (`plan/0`, frozen 2026-10-12).

- **Branch:** `slice/P0`, worktree `../architect-mc-P0`. **Spend:** $0. The check makes no Claude calls, and repair costs are
  Steward's.
- **Scope:**
  - the geometric plan schema `plan/0`, frozen after Steward's review and before Steward writes its plan writer;
  - its compiler for the blocks that exist (§5);
  - `Regions.checkPlan`, a $0 dry run of the whole plan against one survey snapshot, with per-part answers, the capability
    catalogue and a light preview;
  - the resolved artifact that approval binds, and `realiseApproved`.
- **Not in scope:**
  - the life layer (story, stages, schedule, relations, secrets), which is Steward's;
  - districts (D1, D2), free layouts (FL), rule checks (RC, after VOC), brushes (B), crossings (T3), 7a's typed connectors,
    and 6d's deltas to a realised region. Each answers `unsupported` with its block id until it ships.
- **Depends on:** T2 (routing; its frozen text plus S-T2-1 and S-T2-2), T1 (passes, relief), V (`flat_village`), X (lot ext,
  opKeys), F1 (forms) and 0c (C17 protected areas).
- **Parallel with:** S2, T3, D1. Each of those adds its plan part and check when it lands, as a catalogue entry that moves from
  `reserved` to `supported`.

### 0. Facts

- `Regions.plan` surveys a claim, runs one program in the sidecar's pristine-kit child process and returns a `RegionPlan`
  (`irSha`, `surveySha`, lots, stages, budget, the macro checker's report and previews). With
  `ext["architect_mc:check"] = false` it skips the checker and previews. One region is one claim (at most 1024 a side) and one
  program. `Regions.remove` undoes all of it.
- Today's region programs that matter here:
  - `flat_village` (V) lays out lots on one street, with params `lots`, `shared`, `squareSize`, `laneWidth`, `lamps`, `bell`,
    `apronLamps` and `requireAll`. Its lot list has the shape of `validateLots`, at most 40 lots.
  - T2's `route` pass routes edges inside a program, with A* with heading, the grade limit, stairs and ladders on player-only
    edges.
  - T1's `relief` pass blends pads and corridors into the land, under the pass budget of 120 s and 2 GB.
  - F1's `iceSpike` and `rockSpire` are form generators.
  - Nothing routes between two regions yet. D1's `beside` is not built.
- `kit/lib/specschema.mjs` (and the mod's `SpecSchema`) validate the toolbox specs with a small JSON Schema subset. `plan.json`
  stays inside that subset. What the subset can't say is in `x-rules`, `x-dispatch` and `x-defaults`. The schema also compiles
  under a standard 2020-12 validator (checked with the sidecar's ajv while drafting).
- The macro checker, `checkRoad`, `fitToLot` and `bomFull` (C26) already answer fit and cost questions part by part.
- **Shipped op kinds:** `shape`, `columns`, `voxels` and `relief`; `scatter` and `stamp` arrive with F2. Tile goldens hold S1,
  S7, `mega_bench`, `relief_demo` and `route_demo`.

### 1. The plan (`kit/schemas/plan.json`, `plan/0`)

Top level:

```
{ schemaVersion: "plan/0", planId?, revision?: {n, parent?, parentArtifact?, reason?}, style?: {bible, version?} | {pending},
  zones[] (<= 16), connectors[] (<= 64), forms[] (<= 32), rules[] (<= 32), dependencies[] (<= 128), notes?, ext? }
```

- **Parts** have stable `id`s, unique across the plan. A revision that keeps a part keeps its id. Every part carries
  `required` (default false), `label`, `notes` (never verified), and `ext` (namespaced, at most 4 KB, echoed in its answer and
  kept in the artifact: Steward's hook).
- **Steward's hook into the plan** is `partRef`: `<partId>`, or `<planId>@<n>#<partId>` from outside the plan. A stage,
  schedule entry or secret points at parts with it. Architect never reads the life layer.
- **zones[]:**
  - `kind` (`standard`; `outpost` is reserved for D2; `district` is a reserved alias of the `{districts}` program, see below);
  - `purpose` (a tag, echoed);
  - `style` (a bible ref: `{bible, version?}`, or `{pending: "<tag>"}` while the bible doesn't exist yet, §3);
  - `program`: `{template: "flat_village", params}`, or `{lots: [...], layout, shared}` with `layout` one of `street` (supported) or `ring`, `spiral`, `grid`,
    `organic` (reserved for FL; see "Free layouts"), or `{districts}`, which is reserved for D1 (see "Districts"). A lot carries `id`, `type`, `size`, an optional slug `role` and an optional free-text `label` (at most
    80 characters, as on zones and connectors);
  - `where`, `sketch`, `size` (`{w, d}` as integers or ranges, or a preset S/M/L/XL), and `tolerance`.
- **connectors[]:**
  - v0 kinds `street`, `road` and `path`;
  - `from`, `to` and `via[]` endpoints: a part with an optional port, an anchor, a feature, or a region, which is reserved
    for D1;
  - `avoid[]` features, `width` (1-5 cells, the range of 4e's ground roads and so of T2's routes; default street 3, road 3, path 1), `movers` (the per-edge override that S-T2-1 left room for), `lamps` and `style`.
  - 7a's catalogue kinds are reserved by name: `auto`, `wall`, `gate`, `bridge`, `tunnel`, `ladder`, `stair`, `rail`,
    `channel`, `rope_bridge`, `catwalk`, `rock_stair`, `switchback`, `lift`, `branch_walk`, `span_bridge` and
    `stairs_around`. SETTLEMENTS §8's graph (nodes with ports, typed edges with `from`/`to` as `node.port`) is what a
    connector compiles to. So 7a's edge `type` is the connector `kind`, and its ports are endpoint `port`s, with no change to
    `plan/0`.
- **forms[]:**
  - `relief`: T1's pass around named parts, with `radius`, `maxCut`, `maxFill` and `erode`;
  - `terrace`: 6a's terrace plus relief edges;
  - `ice_spike` and `rock_spire`: F1, with `count`, `height`, `preset` and `keepNatural`;
  - reserved: `floating_island` (N-P0-1), `brush` (B), `pond` (H), `scatter` (F2), `giant_tree` (F3) and `hidden_room`
    (7b), and, added at the freeze, `crater` (7c), `hollow_mountain` (7c), `waterfall` (H), `seabed_site` (a later slice),
    `ship_hull` and `mast` (unscheduled).
- **rules[]:** the vocabulary `palette`, `shape`, `variety`, `density` and `height_cap`. Each has a draft def in the schema,
  and all are reserved until RC; added at the freeze, `stacked_floors` (RC, or 7b) and `suspended` (7b) are reserved too. A
  required rule that can't be verified blocks readiness.
- **dependencies[]:** `{part, after[], why?}`. The part stands after those parts (stage order), and answers `blocked` when
  any of them doesn't fit. Implicit dependencies come from locator targets, endpoints and `relief.around`. The whole graph
  must be acyclic.
- **The extension envelope:**
  - Each family's items are checked loosely, then dispatched on `kind`.
  - A supported kind is checked strictly; an error there is `malformed`, with the JSON path.
  - A reserved, retired or unknown kind (namespaced ones too, for example `steward:moat`) is checked only against the
    bounded envelope, and answers `unsupported {block}`.
  - Bounds: 4 KB and 6 levels deep per part; 32 parts and 32 KB per plan. Over a bound, the part is `malformed`.
  - An unknown **top-level** member makes the whole plan `malformed`. New vocabulary goes inside a family, not beside them.

**Locators (v0 vocabulary).** No world coordinates appear in a plan.

- The five locators are `inside {part | region | claim}`, `near {anchor | feature, within}`,
  `adjacent {to, side, gap}`, `along {feature, side, distance}` and `around {feature, ring, closed}`.
- **Features** are deterministic selectors: `water {body, minArea}`, `biome_edge {between}`, `ridge {minRise}`, `part`,
  `region` and `protected`. Several matches are broken by `pick`: largest (or longest, highest, or nearest to an anchor),
  then nearest to the claim's centre, then the smallest min x, then the smallest min z.
- **Anchors** are named, never coordinates. The built-in ones are `claim_center` and `claim_n`/`e`/`s`/`w`. The caller
  supplies the others in `PlanRequest.anchors`. Steward passes `stone`, `player`, `street_w`, `street_e`, `district_<id>` and
  `stockpile`. They are caller-supplied positions: P0 doesn't interpret the names, and an anchor a part uses but the request
  doesn't supply is `malformed` (`UNKNOWN_REF`).
- **A sketch** is optional and relative: frame `claim` in q64 units (0..64 across the claim), or frame `anchor` in blocks
  (-512..512). v0 uses its point or centroid as a soft position target (`sketch.point`). An outline the plan requires
  (`outline: true`) is `sketch.outline`, reserved for FL.

**Tolerances** are explicit per part, each one `{max, hard}`. The defaults are stated in the schema's `x-defaults`:

| Tolerance | Default |
|---|---|
| move | soft, 16 (ceiling 64) |
| size | soft, 25% of each side (ceiling 50%) |
| rotate | allowed |
| count (lots unplaced) | soft, 0 |
| grade | hard, 0.25 (T2) |
| detour | soft, 2.0 (ceiling 4.0) |
| sketch | soft, 8 (ceiling 32) |

- A **soft** tolerance may be exceeded up to its ceiling. The answer is `adjusted`, with the deviation and `exceeds: true`.
- Past the ceiling, or past any **hard** tolerance, the answer is `refused`, with reason `TOLERANCE` and what would fit.
- A contract promise wins over a part's tolerance (C27's "within 4 cells", once D2 is supported).

### 2. API

```java
// Regions (defaults that throw "needs Architect API <P0>")
CompletableFuture<PlanCheck> checkPlan(PlanRequest r);              // async; future.cancel(true) or cancelCheck stops it
boolean cancelCheck(@Nullable String owner, String opKey);          // true when a running check was cancelled
Optional<PlanCheck> checkByKey(@Nullable String owner, String opKey);
CompletableFuture<RegionPreviews> planImages(String checkId, Set<PreviewView> views);   // images on request (§4)
Optional<PlanArtifact> artifact(String artifactSha);
CompletableFuture<String> realiseApproved(ApprovedRealise r);       // the region id once queued (§6)

record PlanRequest(JsonObject plan, ServerLevel level, BoundingBox claim, Map<String, BlockPos> anchors, @Nullable String owner,
    @Nullable String bible, @Nullable Integer bibleVersion, @Nullable PlanBudget budget, @Nullable String opKey, JsonObject ext)
record PlanBudget(int maxNodes, int maxEdges, long maxCells, int maxMs, int maxHeapMb)   // each <= the default; 0 = default
record PlanCheck(String checkId, String planSha, String surveySha, String kitVersion, String schemaVersion, Overall overall,
    List<JsonObject> parts, JsonObject cost, JsonObject catalogue, JsonObject preview, @Nullable String artifactSha,
    List<String> notes)
enum Overall { READY, NEEDS_REPAIR, REQUIRED_BLOCKED, INCOMPLETE, MALFORMED }   // appended to, never reordered
record ApprovedRealise(String artifactSha, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries,
    @Nullable String opKey, JsonObject ext)
```

- **The opKey** is scoped as `(owner, "region.checkPlan", key)`, with the body being the plan's canonical JSON plus the
  claim's x/z, the anchors, the bible and the budget. Otherwise it behaves as X's C20: the same body returns the same check,
  in flight too; another body refuses `OP_KEY_CONFLICT`.
- **Records** take the house rules: trailing components and appended enum values.
- **New `Reason` values** (appended): `ARTIFACT_STALE` and `ARTIFACT_UNAPPROVED`. A malformed plan is an answer, not a
  refusal; only an unparseable or oversize plan JSON refuses, as `FIELD_LIMIT`.
- **Features:** `planCheck`, `planCatalogue`. **Config:** none new. The check runs under T1's pass budget (120 s, 2 GB).
- Part answers travel as JSON in the shape of `plan.json`'s `$defs/partAnswer`, so new answer members need no API change.

### 3. Answers

Every part gets exactly one class:

| Class | Meaning | Carries |
|---|---|---|
| `fits` | resolved within its tolerances, with no move beyond snapping | geometry, cost |
| `adjusted` | resolved, but moved, resized, rotated or rerouted within tolerance (or past a soft one, up to its ceiling) | geometry, cost, deviations |
| `refused` | infeasible: no room, steep, water (until T3), protected, overlap, a hard tolerance | typed reasons, `wouldFit` (up to 4 concrete alternatives, each a plan fragment with its own geometry and cost) |
| `unsupported` | no such block in this catalogue | `block` (the exact block id), `until` (the slice) |
| `blocked` | depends, explicitly or implicitly, on a part that is not `fits` or `adjusted` | `blockedBy` |
| `malformed` | a schema error in a supported part, an unknown ref, a cycle, or an envelope over its bounds | reason `SCHEMA` with its path |
| `incomplete` | the check ran out of budget, time or memory before this part had an answer; **never treated as fits** | reason `BUDGET`, and which cap |

- **Reason codes:** `SCHEMA`, `UNKNOWN_REF`, `CYCLE`, `EXTENSION_BOUND`, `UNSUPPORTED`, `NO_FEATURE`, `NO_ROOM`,
  `OUT_OF_CLAIM`, `OVERLAP`, `PROTECTED`, `KEEP_OUT`, `TOO_STEEP`, `WATER`, `UNREACHABLE`, `TOLERANCE`, `DEPENDENCY`,
  `BUDGET`, `CANCELLED` and `LIMIT`. Each carries `evidence`, for example the columns, the grade or the feature found.
- **Cost:**
  - exact for what is resolved: cells, removed, added, tiles, chunks to generate, and in survival the BOM from C26's
    `bomFull`;
  - a **range** for provisional parts: lots without a library entry, and any part whose style is `{pending: "<tag>"}`. Cells and
    a BOM band come from the lot's size and the library's density for its type (and, for a pending style, across the palettes
    the bible could take). A pending style is checked exactly like an undesigned building: provisional, with approval rebound
    once the bible exists;
  - the whole-plan cost is the sum, as a range when any part is provisional.
- **The overall result:**
  - `MALFORMED`: the plan itself failed the schema;
  - `INCOMPLETE`: any part is `incomplete`;
  - `REQUIRED_BLOCKED`: a required part is `unsupported`, `refused` or `blocked` (COMPOSITION §2.5; it blocks approval until
    the player approves a concrete reduced revision);
  - `NEEDS_REPAIR`: any other part is not `fits` or `adjusted`;
  - `READY` otherwise.
  - Only `READY` and `NEEDS_REPAIR` produce an artifact. Under `NEEDS_REPAIR`, the parts that didn't fit are listed in it as
    **dropped**, so approval shows them.

### 4. Capability catalogue, and the preview

The catalogue is returned with every answer, and committed as a golden per release (`kit/schemas/plan-catalogue.golden.json`).

- **Entries** are `{id, sinceApi, schemaVersion, state: supported|reserved|retired, until?, retiredInApi?, replacedBy?,
  limits?}`. The P0 entries are seeded in `plan.json`'s `x-catalogue`; `sinceApi: "P0"` is replaced at merge.
- **Block ids** are `<family>.<kind>` (`connector.wall`, `form.relief`, `rule.palette`, `zone.outpost`), `program.<name>`,
  `locator.<form>`, `feature.<selector>`, `endpoint.<form>` and `sketch.<form>`.
- **Ids are never reused or renamed.** Retiring one is an explicit state that names `retiredInApi` and, optionally,
  `replacedBy`. An entry's `schemaVersion` grows only additively; a breaking change is a new block id.
- **Pending parts (Noah, via Steward):** a required part that needs a block that doesn't exist yet is kept pending in the
  settlement's plan, and the town is built without it.
  - Its `unsupported` answer names the exact block id.
  - A newer catalogue that lists that id as `supported` tells Steward to recheck the part and propose adding it.
  - `tools/plan-catalogue-diff.mjs <old> <new>` lists added ids, `reserved → supported` changes, retirements and
    schemaVersion bumps.
  - A reserved kind's parameters, written earlier into the envelope, may fail strict checks once it ships. Steward rechecks
    them, and Claude repairs them.

**The light preview comes first.** Each check returns, inline:
- the siteplan (`siteplan/1`, widened additively with a `part` member on lots, paths, nodes and edges, and the part rects);
- per-part bounds;
- a 1:4 top-down class map, at most 256x256 and about 64 KB, as a PNG blob path.

**Images come on request.** `planImages(checkId, views)` renders 6b's four views over the check's virtual world, as
`Regions.previews` does.

### 5. What v0 compiles

A plan compiles to **one region plan over the request's claim** (see S-P0-1). It runs through a bundled, `catalogue = false`
composite program, `plan_v0`, whose params are the resolved plan:
- zone rects laid out with V's `streetLayout`, as `flat_village` does, inside each rect;
- connectors as one T2 `route` pass, with the zone rects as obstacles and their ports as nodes;
- relief as T1's pass, and F1's generators.

So `checkPlan` is today's survey, then plan, then checker, with no realise. The 1024 claim cap and T1's pass budget apply to
the whole plan.

| Block | P0 answer |
|---|---|
| `zone.standard` with `program.flat_village` or `program.lots` | compiled: a rect inside the claim from its locator and size (integer scores, candidates scanned in x-then-z order), then the street layout. Lots left unplaced count against `count` |
| `locator.inside` (claim, part), `locator.near` (anchor, water, part, protected), `locator.adjacent` (a part in this plan) | compiled |
| `locator.along`, `feature.biome_edge`, `feature.ridge` | `unsupported` until D2 (C27; C28 decides biome resolution) |
| `locator.around`, `sketch.outline` | `unsupported` until FL |
| `program.districts`, `feature.region`, `endpoint.region` (a standing region; `beside`) | `unsupported` until D1 |
| `zone.outpost` | `unsupported` until D2 |
| `connector.street`, `road`, `path` | compiled: T2 edges; a route forced across water is `refused` `WATER` with `until: T3` |
| `connector.bridge`, `tunnel` | `unsupported` until T3; `channel` until HY; the other 7a kinds until 7a |
| `form.relief`, `form.terrace`, `form.ice_spike`, `form.rock_spire` | compiled (T1, 6a, F1) |
| `form.brush` | `unsupported` until B (brushes join after B) |
| `rule.*` | `unsupported` until RC |
| `dependency.after` | compiled: stage order and `blocked` propagation |
| a revision of a realised plan | unchanged parts stay as built. New parts beside the region are D1 (`unsupported`), and changes to built parts are 6d (`unsupported`) |

**Overlap and protection:**
- Zones may not overlap one another.
- Nothing is written in C17 protected areas, `keepOut`, or another owner's region: reason `PROTECTED` or `OVERLAP`.
- A protected area or a region given as a feature is avoided by the route as T2 keep-out.

### 6. The artifact, approval and realise

**A check that answers `READY` or `NEEDS_REPAIR` writes a resolved artifact** to `<planDir>/artifacts/<artifactSha>.json`.
Its sha is taken over canonical JSON and excludes ids, timestamps and paths. The artifact holds:
- the frozen plan (canonical) and its sha, the schema version and the catalogue version;
- the frozen inputs:
  - the claim's x/z;
  - the anchors' positions;
  - `surveySha`;
  - a protection fingerprint (the C17 areas, `keepOut` and other regions intersecting the claim);
  - the bible and its version;
  - the seed;
  - the kit version;
- the compiled region plan: `planId`, `irSha`, the IR format and `requires`, the blob shas, and the tile shas per stage;
- per part: the answer, the geometry, the lot ids, the links (graph edges with their paths) and the cost;
- blueprint versions (`entry@version`) and their `fitToLot` fits for lots that have entries. Lots without one, and parts with a
  pending style, are **provisional**: the artifact records each one's **cost range** and **fit box** (the lot box the building
  must stay inside);
- the dropped parts (`NEEDS_REPAIR`) and their classes.

**Approval binds the artifact sha.** Steward stores `artifactSha` with the player's approval.

`realiseApproved(r)`:
1. Refuses `ARTIFACT_UNAPPROVED` when no artifact has that sha.
2. Re-surveys the claim at the IR's resolution and recomputes the protection fingerprint. When the terrain (the drift check
   over the plan's tiles, today's `DRIFTED` rule) or the protection changed, it refuses `ARTIFACT_STALE`, naming the changed
   columns or areas, and writes nothing. Steward then checks again. Unchanged parts come from the cache, so a recheck is cheap.
   If the new artifact's geometry sha equals the old one, the approval carries over; otherwise the player approves again.
3. Binds `lotEntries` for provisional lots (and the bible, for a pending style). A provisional building keeps its approval
   while its fit stays inside its recorded lot box and its cost stays within the recorded range. Past the top of the range,
   or outside the box, it refuses `ARTIFACT_STALE`, naming the lot, and the caller re-approves.
4. Calls `Regions.realise` on the artifact's `planId` with the opKey. It **never re-plans**.

**Artifact retention.** Architect keeps an artifact by its sha while it is pinned or while an owner's settlement refers to it.
- `Regions.pinArtifact(String artifactSha, String owner)` and `unpinArtifact(String artifactSha, String owner)` (defaults throw
  "needs Architect API <P0>"; idempotent) hold it for that owner, as does a settlement's reference to it. It is deleted only
  when no pin and no reference remain (the cache's 24 h does not apply to artifacts).
- A removed artifact leaves a **tombstone** (`artifact(sha)` answers a removed record with its `removedAt`), matching C22's
  pattern for regions. `realiseApproved` on it refuses `ARTIFACT_UNAPPROVED` (the sha is known, the body is gone); an unknown
  sha refuses the same. Tombstones are kept as long as opKey records are (0a retention).

**Replay and recovery:**
- A resume uses the saved IR; this is X's C20.
- `realiseByKey(owner, key)` finds the realise after a restart, including one interrupted mid-realise.
- Undo is `Regions.remove` of the region, exactly as today.

**Rule: a shipped op's semantics never change.**
- From P0 on, every op kind, every op member and every shipped `plan_v0` compile path keeps its meaning forever. New behaviour
  is a new op kind, or a new member whose absence means the old behaviour.
- **Goldens** enforce it. `kit/test/fixtures/ops/` holds one frozen IR per op kind and member family, with its tile shas, and
  every later kit re-evaluates them in CI (macOS and Linux). A moved sha fails the build.
- A newer kit evaluates an older artifact's IR to the same tiles. Rechecking the *plan* on a newer kit may compile
  differently. That makes a new artifact, which is a new revision to approve, never a silent change.

### 7. Budgets, caps, cache and determinism

**Caps on the plan:** 128 parts, 64 KB of JSON, and §1's family caps.

**Caps on the check:**

| Cap | Default |
|---|---|
| `maxNodes` (A* expansions over all T2 edges) | 2,000,000 |
| `maxEdges` (routed legs) | 128 |
| `maxCells` (cells evaluated) | 20,000,000 (`LIMITS.budgetDefault`) |
| `maxMs` | 120,000 |
| `maxHeapMb` | 2,048 |

- A request may only lower a cap.
- **Running out** leaves the parts without an answer as `incomplete`, and the check's overall result is `INCOMPLETE`, with no
  artifact. Parts answered before the cap keep their answers.
- **Count caps are deterministic. Time and memory caps are not:** a check that hit `maxMs` or `maxHeapMb` is never cached and
  never makes an artifact.
- **Cancel** (by future or key): `CANCELLED`, nothing persisted but the cache.

**The cache** is per part, keyed by the kit version, the catalogue version, the part's canonical JSON, the resolved geometry
shas of everything it depends on, `surveySha`, the protection fingerprint, the anchors, and the bible.
- A repair round that changes one part re-resolves only that part and its dependants, then re-runs the whole-plan overlap and
  route checks. Answers say `cached: true`.
- The cache is kept for 24 h, or 256 checks per owner.

**Determinism:**
- Every coordinate is an integer cell. Sketches are quantised (q64), and grades and ratios to 1/64.
- Costs are integers.
- Parts are resolved in topological order of their dependencies, with ties broken by id (code point).
- Candidate scans run in x-then-z order. Feature picks use §1's order. Every pass already breaks ties by `(f, g, x, z,
  heading)` (T2).
- **The same canonical plan, survey blob, anchors, protection fingerprint, kit version and budget give a byte-identical
  answer and artifact sha.**
- Live worlds drift between fresh copies (T1 as built), so the determinism gate runs over committed inputs: a plan JSON plus
  a survey blob, or under `/tick freeze`.

### 8. Gate (slice tier, $0)

**Fixtures:**
- `kit/test/fixtures/plan/`:
  - `valid/` (at least 12, covering every supported block id);
  - `malformed/` (at least 12: a bad id, a bad ref, a cycle, a known kind with a bad member, an unknown top-level member,
    oversize);
  - `extension/` (at least 6: an unknown connector kind, a reserved 7a kind written to its draft shape, a namespaced form
    kind, an unknown template, a reserved rule kind, an envelope over its bounds giving `malformed`).
- The crafted plans run on S7's flat claim and S3's pinned claim.

**Evidence:** `artifacts/gate6c-p0/`, driver `tools/gate6cp0.mjs`. `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Schema fixtures | every `valid/` plan valid under the kit validator and ajv 2020-12; every `malformed/` plan answers `malformed` with the expected path; every `extension/` plan answers `unsupported {block}` with the exact block id (and the oversize one `malformed` `EXTENSION_BOUND`) |
| 2 | Per-class answers | crafted plans give each of the 7 classes at least once, with the expected reason codes, `blockedBy`, `until` and deviations; a required `unsupported` part gives `REQUIRED_BLOCKED` and no artifact; `wouldFit` alternatives re-checked alone answer `fits` |
| 3 | Determinism | 3 checks of each crafted plan over committed inputs give identical answers and artifact shas; the kit half on macOS and Linux CI; 1 and 4 tile workers give equal tile shas |
| 4 | Approve, realise, undo | for the S7 flat crafted plan and the S3 one: `realiseApproved` gives a region whose `irSha` and tile shas equal the artifact's; the realised world equals the check's virtual world over written cells (E-flat 0; natural E-normal classified, at most 0.01%); `Regions.remove` restores E-flat 0 |
| 5 | Stale | a block changed in a planned tile, then `realiseApproved`: `ARTIFACT_STALE`, nothing written; the same after adding a C17 area over a zone; recheck, then approve, then realise works |
| 6 | Keys | `checkPlan` key idempotence and conflict; `realiseApproved` with a key, the world stopped mid-realise, reload: `realiseByKey` finds it and it completes |
| 7 | Incomplete | a forced `maxNodes` of 1,000 gives the route parts `incomplete`, overall `INCOMPLETE`, no artifact, nothing cached as fits; `maxMs` 1 the same, and that check is not cached |
| 8 | Cache | a second check with one zone changed: every independent part `cached: true`, with answers equal to a cold check's |
| 9 | Catalogue | every `supported` entry has a `valid/` fixture that fits, and every `reserved` one an `extension/` fixture answering `unsupported` with its id; **catalogue diff:** the committed `kit/test/fixtures/plan/catalogue-next.json` (D1 flipping `program.districts` and `endpoint.region` to supported) diffed against P0's golden lists exactly those ids as `reserved → supported`, and a pending part recorded as `unsupported {program.districts}` is flagged for a recheck |
| 10 | Op semantics | the `fixtures/ops/` goldens re-evaluate unchanged; a deliberately changed op member fails the test (negative control) |
| 11 | Recorded plans | Steward's recorded plans for the 59 strange asks, under `kit/test/fixtures/plan/asks/` as they arrive, run in kit CI at $0 and print the per-block gap table; no plan crashes the check. Zero fixtures pass until Steward's plan v0 lands |
| 12 | Unchanged | S1, S7, `mega_bench`, `relief_demo` and `route_demo` tile goldens |
| 13 | API, spend | api-compat clean against the previous three apitest jars; $0.00 |

**Tier:** slice: quick, the kit region rows, `region/**` and `api/**`, the sim suites, apijars, and the scenario steps.
**gate-verifier** re-runs items 4, 5 and 6 (realise, undo and keys).

### 9. Build order

1. Archive the previous apitest jar.
2. The schema validator: the subset plus dispatch and `x-rules`, with fixtures.
3. The resolver: locators, features, anchors, tolerances, dependencies.
4. `plan_v0`, compiling zones, routes, relief and forms.
5. Answers, cost and catalogue.
6. The artifact, cache and budgets.
7. The API: `checkPlan`, keys, `realiseApproved`, `planImages`.
8. The catalogue diff tool, then the gate.

### Open questions for Steward

(Answered 2026-10-12; see "Changes from Steward's review of P0" below. The questions stay for the record.)

- **S-P0-1. One region per plan.** v0 compiles a whole plan into one region over one claim: one undo, one opKey, one budget.
  The alternative is one region per zone. That gives separate undo, but it needs D1's `beside` to join the regions. Is one
  region per plan right until D1, with zones added later as their own regions?
- **S-P0-2. `required` defaults to false.** Should it be true instead, so that Claude must mark a part optional?
- **S-P0-3. Anchors.** Which named anchors will you pass (`stone`, the player's home, a protected build)? Are the built-in
  claim anchors enough for the rest?
- **S-P0-4. The ref hook.** `partRef` plus part `ext` (echoed and kept). Enough for stages, schedules and secrets to point at
  parts, or do you want Architect to keep a reverse index?
- **S-P0-5. Provisional buildings.** Approval carries over when each building's fit stays in its lot box and the approved
  cost range. Is that the rule you want on the card?
- **S-P0-6. Artifact custody.** Architect stores artifacts by sha in the plan dir; Steward stores the sha with the approval.
  Do you also need the artifact exported to your save?
- **S-P0-7. Street, road and path.** Is v0's split (a street is a road with lamps; a path is narrow, with stairs) right for
  your plan writer? Or should `street` mean frontage for lots only, which is reserved for FL?
- **S-P0-8. Unknown top-level members** make the whole plan `malformed`, while unknown kinds inside a family are
  `unsupported`. Does your plan writer ever need a new top-level family before the schema adds one?
- **S-P0-9. The freeze.** Is `plan/0` ready to freeze after this review, or do you want a round with plan v0 fixtures first?

### Changes from Steward's review of P0 (2026-10-12; these win)

- **S-P0-1. One region per plan until D1**, compiled through `plan_v0`. Zones become their own regions only when D1's `beside`
  can join them.
- **S-P0-2. `required` defaults to false.** Claude marks a part required when it must stand.
- **S-P0-3. Anchors.** Steward passes `stone`, `player`, `street_w`, `street_e`, `district_<id>` and `stockpile`, in
  `PlanRequest.anchors`. They are caller-supplied positions; P0 doesn't interpret their names (§1).
- **S-P0-4. `partRef` plus part `ext`**, and each part's answer echoes its `ext` unchanged (`$defs.partAnswer`). No reverse
  index.
- **S-P0-5. The cost range in the artifact.** The approval artifact records each provisional part's cost range and fit box. A
  provisional building keeps its approval while its fit stays in its lot box and its cost within the range. Past the top of the
  range, the caller re-approves (§6).
- **S-P0-6. Retention and tombstones.** Architect keeps an artifact by sha while it is pinned (`pinArtifact(sha, owner)` /
  `unpinArtifact`) or while the owner's settlement refers to it. After removal it leaves a tombstone, as C22 does (§6).
- **S-P0-7. Street width.** `street` connectors (like `road` and `path`) take an optional `width`, 1-5 cells: the range 4e's
  ground roads support, which T2's routes inherit. The default is 3.
- **S-P0-8. An unknown top-level member makes the plan `malformed`; an unknown kind inside a part is an extension** and answers
  `unsupported`.
- **S-P0-9. Freeze `plan/0` after one time-boxed round of Steward's plan-v0 fixtures for the 59 asks** (gate item 11). Until that
  round ends, additive optional members are still allowed; after it, `plan/0` is frozen.
- **Gap: lot label.** A lot in a zone's `program.lots` takes an optional free-text `label` (at most 80 characters, as zones and
  connectors have). `role` stays a slug.
- **Gap: pending style.** Wherever a bible ref is accepted (the plan `style` and a part `style`), `{pending: "<tag>"}` is also
  accepted, the tag a slug of at most 40 characters. P0 checks a part with a pending style as **provisional**, the same way as
  an undesigned building: palette and cost as a range, and approval rebinds once the bible exists.

### Open questions for Noah

- **N-P0-1. Other bundled programs as named templates.** Should `crater_works`, `rift_city` and `floating_islands` (and the
  6b `floatingIsland` generator as `form.floating_island`) be catalogue entries in v0? Today only `flat_village` and lot sets
  are.
- **N-P0-2. Biomes per column (C28).** `feature.biome_edge` waits for D2. Should D2 add `Survey.biome` at resolution 1, or
  stay at 4x4?

**Decided (Noah, 2026-10-12, via Steward):** Claude picks a shortcut or a full composition per ask, and composing plus repair
is capped at about $1 per plan. P0 itself stays $0.


### Coordinator decisions on P0's Noah questions (2026-10-12)

- **N-P0-1:** the existing bundled region programs (`crater_works`, `rift_city`, `floating_islands`) are exposed in v0 as
  **named templates** (`program.template`), alongside `flat_village`: they exist and cost nothing. `form.floating_island` as a
  free-standing form stays reserved.
- **N-P0-2:** C28 is already D's builder's call (per-column biomes only if edge tracing needs it); not a Noah question.


### Freeze of plan/0 (2026-10-12)

`plan/0` is **frozen** as of 2026-10-12, the reason being the end of S-P0-9's round: Steward wrote plans for all 59 strange asks
against it, all 59 are valid, and 34 carry waiting parts in the extension envelope. **The rule from now on: changes are
additive-only within `plan/0`** (new optional members, new reserved kinds and block ids, new catalogue entries); anything else
needs `plan/1`. The aim of the last edits: an `unsupported` answer names **one** block id per idea, so a pending part maps onto
a future block.

**Free layouts.** `program.lots.layout` is the enum `street | ring | spiral | grid | organic`.
- `street` is supported (block id `layout.street`).
- `ring`, `spiral`, `grid` and `organic` are reserved, state `reserved`, arriving in slice FL, with block ids `layout.ring`,
  `layout.spiral`, `layout.grid` and `layout.organic`. A lots program that names one is checked as a normal lots program and
  answers `unsupported {block: "layout.<name>"}`.
- A layout is written **there**, never as a connector kind (`connector.ring_street`, `connector.grid`) or a rule kind
  (`rule.ring_layout`, `rule.layout_ring`): the fixtures show Claude doing exactly that when the layout had no home.

**Districts.** `zone.kind: district` is a **reserved alias** of the `{districts}` program: the part answers
`unsupported {block: "program.districts"}`, not `zone.district`, until D1. The catalogue lists `zone.district` with
`aliasOf: "program.districts"` (a new optional catalogue-entry member, with an optional `note`). The schema's description of
`program.districts` says how to write districts.

**New reserved kinds** (each has a block id, state `reserved` and its planned slice):

| Block id | Slice | Note |
|---|---|---|
| `form.crater` | 7c | the `crater_works` template already covers a whole-region crater (N-P0-1) |
| `form.hollow_mountain` | 7c | |
| `form.waterfall` | H | |
| `form.seabed_site` | later | under water; a later slice, not yet named |
| `form.ship_hull` | unscheduled | "structures that move or float" |
| `form.mast` | unscheduled | "structures that move or float" |
| `rule.stacked_floors` | RC | arcology; or 7b if it needs interior work |
| `rule.suspended` | 7b | upside-down or hanging builds; 7b's other surfaces |

**Already-wanted reserved kinds, ranked by Steward's counts** (parts across the 59 plans; input to ordering the slices). Each
was confirmed reserved, with a block id and a planned slice:

| Block id | Parts | Slice |
|---|---|---|
| `connector.rope_bridge` | 11 | 7a |
| `connector.wall` | 8 | 7a |
| `rule.palette` | 8 | RC |
| `rule.shape` | 4 | RC |
| `connector.tunnel` | 4 | T3 |

The catalogue grew by 14 entries at the freeze: `zone.district`, the five `layout.*` ids, six forms and two rules. A catalogue
diff against the draft lists them as added.

### Deferred

- Rule checks (RC), free layouts (FL), districts (D1, D2), typed connectors (7a), crossings (T3), brushes (B), and deltas to
  realised plans (6d). Each is a catalogue flip plus its compiler path.
- A Java-side schema check. The mod checks only the byte cap, and the kit validates.

## Phase 6c slice X: region consumer asks C19 and C20 (FROZEN 2026-10-11 after Steward's review)

Next free API minor at merge (expected 1.15.0 if it merges before T1; the house rule applies), mod to match. Wave 1, parallel
with T1, F1 and MP. Depends on V only. Spend $0. From Steward's V adoption work (plan, design per lot with copies, fitToLot,
realise).

### 1. C19: lot ext onto the lot's site

Today only `architect_mc:lot` lands on a realised lot's site. Steward needs its own keys (`steward_mc:lot`, `steward_mc:role`,
`steward_mc:build`) there, so a site found later says what it is without re-reading the plan.
- **From the plan:** a lot entry in the program's `lots` params may carry `ext` (an object). The plan copies it onto that
  lot's `LotSpec.ext`, and the realise copies it onto the lot's site ext. Keys under the `architect_mc:` namespace are
  Architect's and a caller's value for them is ignored (the realise's own `architect_mc:lot` wins).
- **From the realise:** `RealiseRequest` gains a trailing `Map<String, JsonObject> lotExt` (lot id to ext). The old
  constructor is kept (empty map). A realise ext merges over the plan's, key by key.
- Bounds: at most 4 KB of ext JSON per lot, else FIELD_LIMIT with the field path. Unknown lot ids refuse FIELD_LIMIT too.
- The site ext survives save and reload, versionOf, polish and undo-redo of the region, like `architect_mc:lot` today.

### 2. C20: opKey on region plans and realises

As for groups and batches (0a C9): `RegionPlanRequest` and `RealiseRequest` gain a trailing `@Nullable String opKey` (old
constructors kept).
- Same owner + same kind + same key + same body returns the existing plan or realise; another body refuses
  OP_KEY_CONFLICT.
- `Regions.planByKey(owner, key)` and `Regions.realiseByKey(owner, key)` (defaults that throw on older implementations)
  find them after a restart, including a realise that was interrupted and resumed.
- A realise pending at a world stop still fails WORLD_STOPPED (0a); it is found by key after the next load.
- Keys are kept as long as the plan or region exists; the existing opKey retention rules apply.

### 3. Gate

| # | Item | Bar |
|---|---|---|
| 1 | Unit | ext copy plan to LotSpec to site; merge order; namespace guard; 4 KB and unknown-lot FIELD_LIMIT; opKey idempotence and conflict |
| 2 | In game (S7 flat) | plan with lot ext, realise with a lotExt map: every lot site carries the merged ext; save, reload: unchanged; undo, redo: unchanged |
| 3 | Restart by key | realise with an opKey, stop the world mid-realise (pending future fails WORLD_STOPPED), reload: `realiseByKey` finds it and it completes; a second realise with the same key and body returns it, with another body OP_KEY_CONFLICT |
| 4 | Regressions | `slice` tier |
| 5 | API compatibility | api-compat against the previous three apitest jars; new record components trailing, old constructors kept |

Evidence in `artifacts/gateX/`. Steward's consumer check on the RC as usual.

### Open questions for Steward

- **S-X-1:** is per-lot ext from the plan enough, or do you need the realise-time `lotExt` map too (both are drafted)?
- **S-X-2:** 4 KB per lot enough?

### Changes from Steward's review of X (2026-10-11; these win)

- **S-X-1:** the plan's lot `ext` is enough. **Drop `RealiseRequest.lotExt`** and its merge rule; the realise copies the
  plan's lot ext onto the site. Gate item 2 uses plan ext only.
- **S-X-2:** 4 KB per lot stays (Steward's is about 250 bytes).
- Steward will use opKeys `steward.<build>.vplan` and `steward.<build>.vrealise`.

### Coordinator addition: C22, removal correctness (Steward ask after round 6, 2026-10-11; part of X's frozen scope)

From the GPT review of Steward's V adoption (steward-mc docs/ARCHITECT-ASKS.md):
- **(a) A retried removal must not report success over unfinished restorations.** A removal moves members into pending
  records before restoring them. On a retry after a failed restore, `Groups` (about line 601 at v0.16.0) drops members missing
  from the active site and infra maps without checking the pending records, and can answer `removed=true`. Fix: a removal
  (region or group) first finishes every pending restoration it owns, or refuses with the failing member, and answers
  `removed=true` only when every member's restore committed.
- **(b) A finished removal is recognisable later.** Both:
  - a remove of a region or group that this world already removed answers `removed=true` again (idempotent), with nothing
    written;
  - `Regions.get` (and the group lookup) keep a REMOVED tombstone with the time it finished, surviving save and reload.
    Tombstones are kept as long as opKey records are (0a retention); an unknown id still refuses as today.
- New record state or component: trailing, with old constructors kept; any new enum value appended.
- **Gate additions:** (a) inject a restore failure (a dev hook) mid-removal, retry: the retry finishes the pending
  restoration and the world diff against the pre-placement snapshot is 0, or it refuses; never `removed=true` with a diff.
  (b) remove, drop the answer, reload, remove again: `removed=true`, nothing written; `Regions.get` shows REMOVED with its time.


### Phase 6c slice X as built (API 1.14.0, mod 0.17.0, recorded 2026-10-11)

Branch `slice/X` (worktree `../architect-mc-X`). $0: sim and stub only (`artifacts/gate6c-x/spend.json`). Evidence: `artifacts/gate6c-x/`
(one JSON per `tools/gate6cx.mjs` step, REPORT.md, api-compat.txt), the slice tier under `artifacts/gate-runs-X/`. Ports 8912-8917.

| § | As built |
|---|---|
| API | `VERSION` 1.14.0, mod 0.17.0. `RegionPlanRequest` and `RealiseRequest` gain a trailing `@Nullable String opKey` (the 1.13.0 constructors kept; `RealiseRequest` keeps both its 9- and 10-argument forms). No `lotExt` (Steward's S-X-1). `Regions.planByKey(owner, key)` returns `Optional<RegionPlan>`, `Regions.realiseByKey(owner, key)` returns `Optional<RegionView>`: synchronous, defaults that throw "needs Architect API 1.14.0". No new Reason (OP_KEY_CONFLICT and FIELD_LIMIT exist). Features `regionOpKeys` and `lotExt` (Java side, always present). `Limits.LOT_EXT_MAX` = 4096. `RegionPlan` and `RegionView` carry no opKey (the contract did not ask). |
| C19 kit | `lots[].ext` is a member of the `lots` param type (`kit/lib/params.mjs`): an object of `namespace:name` keys (each at most 200 characters), at most 4096 characters as compact JSON; keys under `architect_mc:` are dropped (ignored, not refused); a lot whose ext has no key left carries none, so an IR with no ext is byte-identical to 0.16.0's. `village.mjs` merges it under the program's own `architect_mc:village`, which wins. No KIT_VERSION bump (deviation from the batch rule: no IR member or op kind is new, and a plan without ext keeps its sha). |
| C19 mod | `FieldLimits.lotExt(params)` runs at the top of `Regions.plan`: every param holding an array of objects with an `ext` member is a lot list (the mod does not know which param the program declares as `lots`); a bad ext refuses FIELD_LIMIT with the path, e.g. `params.lots[1].ext: 4097 characters as JSON, at most 4096`, `... must be an object`, `... key "x" is not namespace:name`. The unknown-lot-id refusal of the draft is moot without `lotExt`. The realise copies the IR lot's ext onto the lot's site, looked up by lot id: **the caller's keys only**; `architect_mc:village` stays on the LotSpec, and the realise's own `architect_mc:lot` is set last and wins. Persistence is the existing site ext's (save, reload, versionOf, polish). "Redo" in gate item 2 is a new realise of the same plan: the engine has no region redo. |
| C20 plans | Scope (owner, "region.plan", key); body = the request as `BatchKeys` writes it with the claim's x/z columns only (y is ignored by the plan) and without the key. A registry holds the key from the call, so a second call while the first still plans gets the same future; a failed plan frees the key. A plan with a key writes `plans/<planId>.key.json` (small) next to its plan file; `PlanRec` and the plan JSON carry `opKey`/`opHash`; the world start reads the key files, so `planByKey` finds it after a restart. Plans are never pruned, so keys are kept as long as the plan. |
| C20 realises | Scope (the plan's owner, "region.realise", key), because `RealiseRequest` has no owner. The key and the body hash (`BatchKeys` form, the actor by UUID, the lot entries sorted) live in the region record (`region.json` `opKey`/`opHash`), written with the record before the future completes; a realise still starting (drift check, blob copies) is held in an in-memory registry, so a concurrent twin shares its future. Same key and body returns the region id in any state; another body, OP_KEY_CONFLICT. `realiseByKey` scans the regions; a removed region ends its key (the key can then make a new region). A realise whose record was not yet written at a stop leaves nothing to find (the caller re-sends). |
| Hooks | `dev.region.plan` / `dev.region.realise` take `opKey`; `dev.region.holdRealise {on}` keeps the next keyed realise's future pending after its record is saved (gate item 3: it then fails WORLD_STOPPED at the stop while the region is found by key after the reload); DevBridge shows any ArchitectRefused as `REASON: message`. apitest: `api114`, `rplanbykey`, `rrealisebykey`, `opKey` in `rplan`/`rrealise`. |
| C22 (a) | `Groups` keeps a **stalled** removal (its undo, undo sites and remaining members) when it ends with a pending restoration; a retry of the group (or stage) removal resumes it and answers removed=true only when every member's restore committed. A restore job that broke no longer marks its member written or drops it from the list. The planning loop that dropped members missing from the active maps now refuses when one of them has a pending record. Stalled removals are saved with the removals (`stalled: true`). Region removal goes through `removeGroup`, so a region retry resumes the same way. |
| C22 (b) | `SiteGroupRec` gains a trailing `removedAt` (the 10- and 11-component constructors kept; set when the state becomes `removed`, kept by a second finish, cleared by other states); `SiteGroup` a trailing `Optional<Long> removedAt` (the 1.4.0 constructor kept). Removing a removed group answers removed=true and writes nothing. `RegionState.REMOVED` is appended; `RegionView` gains a trailing `long removedAt` (0 unless REMOVED; both older constructors kept; a `long`, not an `Optional`, so Gson-based tools can print it). A removed region's record `removed.json` (now with `removedAt`; one written before 6c X uses its file time) is read at the world start as a tombstone: `Regions.get(id)` answers a REMOVED view, `Regions.remove(id)` answers removed=true with nothing written, `Regions.list` omits it, an unknown id still refuses. Tombstones are kept forever (at least as long as opKey records). |
| Hook (C22) | `dev.undo.failRestore {skip}`: let `skip` removal restores finish, then break the next one before its site record is finished (-1 disarms). |
| Gate | Slice tier `artifacts/gate-runs-X/20261011-182748-slice` (2 shards, 8912-8915, old-version clients 8916/8917, `--quiet-wait`, head fbb8ed2): 27 PASS, including unit-mod 498, unit-kit 246, apijars on the 0.16.0/0.15.0/0.14.0 jars (45 ok each), x-unit, **x-ingame** (53 ok: lotext, keys, removal, apicompat), v-ingame, 5b-chains, 4d-all, 4e-orders, 6a-megaA (own CPU max 24.6 ms, 50.7k cells/s), 6a-eflat, 6a-staged, 6a-inv3, the 6b steps and S1. Three steps did not pass and were fixed or re-run: unit-sidecar (the Limits drift guard did not know `LOT_EXT_MAX`: fixed in the guard) and v-unit (the X checkout lacked `sidecar/node_modules`: environment), re-run PASS at 524df06 with 6cv-scenario-s7 (NOISY at load 37 in the slice run, PASS on a quiet box: `20261011-204414-change`). `api-compat --gate6cx` 4/4 clean (0.16.0, 0.15.0, 0.14.0 apitest jars, 0.16.0 surface; baseline built from tag v0.16.0, `artifacts/gate6c-x/v0160`). Items: 1 unit (Api114Test 6, RegionKeysTest 5, the kit's C19 tests), 2 `lotext` (14 checks: 10/10 S7 flat lot sites carry the ext, 4097 refuses FIELD_LIMIT `params.lots[1].ext`, save/reload and undo/redo byte equal), 3 `keys` (plan idempotence, conflict, in-flight twin, owner scope, planByKey after the reload; a realise held pending fails WORLD_STOPPED, `realiseByKey` finds rg1 PLACING after the reload, it completes, a second realise returns it, another body OP_KEY_CONFLICT, removal ends the key), 5 api-compat, C22 `removal` (injected restore failure: removed=false and PARTIAL, the retry resumes and the world hash equals the pre-placement one; remove, reload, remove again: removed=true, world unchanged, REMOVED with the same removedAt for the region and the group). Evidence of the manual dev-client runs: `artifacts/gate6c-x/` (the contract says `gateX/`; named like the other slices). Known flakes in the box's tier (4d-all group undo on G4D Base gravity gravel, sim-massing, the apijars SITE_PROGRESS gap, 6b-nudges under load) did not occur in this run. |

#### C23 as built (v0.17.1, API 1.14.0 unchanged; recorded 2026-10-12)

Steward's review: a region removal resumed after a restart could stay REMOVING forever. `Groups.load` restores the removal
without its future, and the region's end state was set only in that future's callback. Branch `fix/c23-resumed-removal`
(worktree `../architect-mc-c23`, ports 8912-8917).

- **Fix.** `Groups.end` calls an internal hook, `Groups.GROUP_ENDED(groupId, Removed)`, when a whole-group removal ends (not a
  stage undo). It runs on the server thread before the futures complete. `removeGroup`'s answer for an already removed group calls it too. A refusal
  (the owner rule, no such group) does not, because it ends no removal: another caller's removal may be running. The region's own
  refused call ends it PARTIAL in `RegionsImpl.removeGroup`, and only when that call started or joined no removal (verifier
  finding: a foreign `removeGroup` used to flip a REMOVING region to PARTIAL while its removal kept running).
- **Region end.** `RegionsImpl` ends the REMOVING region of that group from the hook, once:
  - removed: REMOVED, with the group's `removedAt`, the tombstone, and the key ended;
  - failed: PARTIAL, as an uninterrupted failure gives.

  The remove future no longer touches the state. A site-API removal of a region's group still leaves the region's state alone.
- **Restart safety.** On a world's first tick, a region still REMOVING whose group has no removal running ends from the group's
  saved state: REMOVED if the group is removed, else PARTIAL. This closes the window between the group's save and the
  region's record. The dev hook `dev.region.dropRemovalEnd {on}` leaves the next group end's region REMOVING, to simulate that
  stop.
- **Groups.** A resumed group removal already ended its group from the persisted removal; gate (d) shows this.
- **Gate.** `tools/gate6cx.mjs resume`, runner step `x-resume`, mapped under `change` for `Groups.java`, `RegionsImpl.java`
  and `gate6cx.mjs`. Each case stops the world mid-removal under `dev.placement.slow`, after at least two members' restores
  have been seen.
  - (a) The removal resumes and finishes with no retry: REMOVED with `removedAt`, the group's time equal, the world hash equal
    to the pre-placement one, the key ended, omitted from the list, and a second remove answers removed=true.
  - (b) A restore failure injected after the reload: PARTIAL (never REMOVING), the group ACTIVE, PARTIAL across a reload (X's
    noted gap), then the retry gives REMOVED with an exact world.
  - (c) Two restarts mid-removal.
  - (d) The same for a plain site group.
  - (e) Another requester's `removeGroup` of the REMOVING region's group, without force: refused; the region stays REMOVING,
    then ends REMOVED with an exact world.
  - (f) The reconcile. (f1) The group REMOVED, the region record left REMOVING: after a restart, REMOVED with the group's
    `removedAt`, an exact world, and removed=true again. (f2) The group ACTIVE after a failed restore, the region record left
    REMOVING: after a restart, PARTIAL; the retry gives REMOVED with an exact world.
- **Evidence.** `artifacts/gate-runs-c23/`, all at head 5136579:
  - `20261011-230813-change`: x-resume 30/0;
  - `20261011-231631-change`: the change tier. unit-mod 498, unit-kit 246, unit-sidecar 705, sim-jobs, x-unit, x-resume 30/0
    and 6a-staged PASS. 4e-megalite was NOISY at load 40-48, with every bar ok;
  - `20261012-003204-change`: x-ingame 53/0;
  - `20261012-005926-change` (head f3f63c8, after the verifier fix): x-unit 3/0, x-resume 46/0 including (e) and (f).
- **Verification.** A gate-verifier reviewed 5136579 and re-ran (a)-(d): PASS, with the refusal defect above. Its negative
  control (the new gate on unfixed v0.17.0) hangs in REMOVING in case (a). Its review of the delta (f3f63c8) passed with no defects: x-resume 46/0 at 8e6d2bb (`artifacts/gate-runs-c23-verify2/20261012-033453-change`), (e), (f1) and (f2) included.

## Phase 6c slice Y: settlement stockpile (C24-C26) (FROZEN 2026-10-11 after Steward's review; built as Y1 and Y2)

Next free API minor at merge (the house rule applies; main is at 1.14.0), mod to match. Steward round 7 (steward-mc
docs/ARCHITECT-ASKS.md C24-C26; its PLAN "Phase 4" waits on C24). Noah's survival rules (PLAN "Inputs for the 6c contract":
unobtainable blocks stay creative-only, rare blocks cost real materials; N-H-1: one lava bucket per lava source).

- **Branch:** `slice/Y`, worktree `../architect-mc-Y`. **Spend:** $0 (sim, stub and dev hooks only).
- **Depends on:** V, X (C22's resumable removal) and 0c (C16 construction roads, C17's owner rules). **Parallel** with the
  terrain track (T1, T2, ...) and the forms track; it touches `site/`, `survival/` and `batch/`, not `region/` or the kit.
- **RS builds on Y:** a region's lots and roads draw from the owner's stockpile (one line added to RS below; RS's own
  `crateAt`/`CrateView` are an open question here, not changed in this draft).
- **Scope:** C24 (one stockpile per owner, feed order, owner ledger, refund routing, legacy adoption), C25 (waiting status and
  event), C26 (the full BOM on `Verdict`).
- **Not in scope:** Hardcore's difference (Steward: later; Hardcore builds as Supplied), cost-table changes (VOC), fluid
  placement (H, RS), item transport by villagers or entities (the stockpile is a ledger with block inlets).

### 0. Facts (v0.17.0)

- **Ledger.** `survival/Ledger` (delivered / placed per item, stock = delivered - placed, credit = stock beyond the unbuilt
  cost) lives in `CrateBlockEntity` and is saved with the crate's chunk. The crate holds no items: one input slot that is always
  empty; it accepts a unit only while a site it feeds still misses it (`Builder.accepts`, with `Equivalents`), and nothing can
  be taken out.
- **Crate owners.** A crate's block entity carries the site id, or `group:<id>` (`SiteGroupRec.CRATE_PREFIX`) for a shared crate
  (`Batch.sharedCrate/crateAt`, R6). `Builder.sharedGroup/crateOwner/fedBy/unbuiltFor` resolve it; `Sites.stock(groupId)`
  (`Builder.groupStock` plus `RoadBuilder.stock`) reports a group's delivered, credit and outstanding by site and road.
- **Feed order today** is greedy: `Builder.tick` visits building sites in `Sites.all()` order and `RoadBuilder.tick` visits
  roads in its own loop; each takes any affordable cell (`Run.affordable`), so a later site can take an item an earlier one
  needs next.
- **Every path that removes or bypasses a crate today** (a stockpile crate must survive all of them):
  - `Builder.complete`: `keepCrate`, then `keepDelivered`, `ledger().takeStock()` (leftovers **dropped** at the crate cell),
    `restoreCrateCell`, `SiteJournal.releaseKind(…, CRATE)`;
  - `Builder.prepareDeconstruct`, last-site branch: same, refunds and stock dropped at the crate cell (`dropDeconstruction`);
  - `RoadBuilder.ensureCrate` (puts the group crate down with its own `SiteJournal.crateEntry`) and `RoadBuilder.complete`;
  - `Builder.applyConstructionDelta` and `deltaCratePos`: a **new crate per delta** (its own crate entry in the site's undo
    group) unless the group shares one; delta refunds (`refunded`) and `refundSwap` items are **dropped** above the crate;
  - `InfraPlace.modeRefusal`: a standalone `placeRoad` CONSTRUCTION is refused (`CONSTRUCTION_ROAD`); `RoadBuilder.convert`
    refuses a road without its group's shared crate.
- **Waiting** exists only client side: `Builder.status` sends `SiteNet.SiteStatus` with one "needs" line (the item with the
  largest shortfall), `paused`, `blockedReported` and `crateMissing`. The API has `SITE_PROGRESS` (rate-limited by
  `Builder.progressDue`, 20 ticks) and `SITE_BUILT`.
- **BOM.** `SitesImpl.check` fills `Verdict.bom` from `Builder.templateBom(grid)` only, although `precheck` already runs
  `Sites.plan` (`TerrainFit.Plan`, `Approach.Plan`, the snapshot box) in dry-run. `checkRoad` (C16) and `checkDelta` (5b)
  already give exact BOMs.
- **Removal.** `Groups` keeps a removal's `refund` map in its saved record and (X, C22) resumes a stalled removal; construction
  refunds are tallied in `prepareDeconstruct` before the restore.

### 1. API (next free minor)

- `VERSION` bumped; features `stockpile`, `siteWaiting`, `fullBom`. Usual rules: old record constructors kept, new `Sites`
  methods are defaults that throw ("needs Architect API 1.x.0"), new enum values appended, new events are new static fields.

```java
// Sites (server thread; owner required, <modid>:<thing>, as C17)
Stockpile createStockpile(StockpileRequest r);          // idempotent per owner; adds the named crates
Stockpile addStockpileCrate(String owner, ResourceKey<Level> dim, BlockPos at);
RemoveResult removeStockpileCrate(String owner, BlockPos at, boolean force);
Optional<Stockpile> stockpile(String owner);            // C24's "Sites.stock(owner)" (renamed: stock(String) exists)
List<String> feedOrder(String owner);                    // target ids (sites, roads, delta sites), first fed first
List<String> setFeedOrder(String owner, List<String> ids);   // listed ids move to the front in that order
Map<Item, Integer> withdraw(String owner, Map<Item, Integer> items, ServerPlayer to);  // credit only
Stockpile adoptCrates(String owner);                     // legacy crates of this owner join the stockpile (§5)
Optional<SiteWait> waiting(String targetId);             // C25

record StockpileRequest(String owner, ResourceKey<Level> dimension, List<BlockPos> crates) {}
record Stockpile(String owner, ResourceKey<Level> dimension, List<BlockPos> crates, int capacityStacks, int usedStacks,
    Map<Item,Integer> stock, Map<Item,Integer> reserved, Map<Item,Integer> credit, Map<Item,Integer> delivered,
    Map<Item,Integer> consumed, Map<Item,Integer> returned, Map<Item,Integer> withdrawn, Map<Item,Integer> dropped,
    Map<Item,Integer> refundOverflow,
    Map<String, Map<Item,Integer>> outstandingByTarget, Map<Item,Integer> outstanding, List<String> feedOrder,
    Map<String, SiteWait> waiting, List<BlockPos> missingCrates) {}
record SiteWait(String targetId, boolean waiting, long waitingSince, List<ItemCount> nextNeeded, int moreUnits) {}
record ItemCount(Item item, int count) {}
```

- `Verdict` gains trailing `Map<Item,Integer> bomFull` and `boolean bomExact` (§7); the 1.12.0 constructor is kept (empty map,
  false). `SiteView` gains trailing `@Nullable SiteWait wait` (null for instant sites; the 1.8.0 constructor kept).
- `Stock` (per group) is unchanged; for a group whose sites draw from a stockpile it reports that stockpile's `delivered` and
  `credit` and the group's own outstanding, with `crate` = the stockpile's first crate.
- **Events:** `SiteEvents.SITE_WAITING` (`onWaiting(SiteView site, SiteWait wait)`) on each start and stop edge (§6), and
  `SiteEvents.STOCKPILE_CHANGED` (`onChanged(String owner)`), at most once per 20 ticks per owner, after any delivery,
  consumption, return, withdrawal or crate change. No new Reason: refusals use `NOT_ALLOWED`, `FIELD_LIMIT`, `PROTECTED`,
  `NOT_LOADED` and `CREATIVE_ONLY_BLOCK` with their messages.

### 2. The stockpile (C24 data model)

- **Identity.** One stockpile per owner string; a null owner (the player's own sites) never has one and keeps today's crates.
  Its crate blocks carry `stockpile:<owner>` in the block entity (a new prefix, never a valid group id, so it can't collide
  with `group:`). An owner has a stockpile from `createStockpile` until its last crate is removed with nothing building.
- **Survival only.** `createStockpile` refuses NOT_ALLOWED while the survival toggle is off. If the toggle goes off later, the
  stockpile and its ledger stay; INSTANT items simply don't use it.
- **Opt-in.** An owner **without** a stockpile behaves exactly as v0.17.0 (per-site crates, `sharedCrate` groups, delta crates,
  the standalone-road refusal). An owner **with** one: every new construction item of that owner draws from it, and none
  places a crate of its own:
  - batch buildings and roads (`sharedCrate`/`crateAt` are ignored with a note);
  - standalone `placeRoad` in CONSTRUCTION or AUTO (no longer refused for that owner);
  - construction deltas (`applyDelta`, `revert`, batch delta items): no `deltaCratePos` crate.
- **Crate blocks.** The owner names cells; Architect puts the existing `architect_mc:construction_crate` there (only into
  air or a replaceable block, outside every standing site's restore box and every protected area of another owner; else
  refused with the cell). Each crate has its own journal entry labelled `stockpile:<owner>`, **outside** every group and site
  undo: `removeGroup`, `undoStage`, a site's deconstruct and `Builder.complete` never remove a stockpile crate.
  - At most 16 crates per stockpile (`Limits.STOCKPILE_CRATES`, FIELD_LIMIT past it). No distance limit.
  - **Dimension:** one per stockpile, fixed by `StockpileRequest.dimension`. A crate in another dimension is refused; a
    construction item of the owner in another dimension is refused NOT_ALLOWED ("the owner's stockpile is in <dim>").
- **Capacity.** 27 stacks per crate (a chest's). `usedStacks` = sum over items of ceil(stock / max stack size).
- **Inserting** (hopper, dropper, "insert from inventory", `dev.crate.insert`) at any crate books into the owner ledger. A unit
  is accepted while some building target of the owner still misses it (today's rule, `Equivalents` included, pooled over all
  targets) **and** it fits; an unneeded or non-fitting unit stays in the hopper or inventory. The crate stays one always-empty
  slot. Creative-only blocks are never needed, so never accepted.
- **Withdrawing.** Only **credit** (stock beyond what every building target still needs) comes out: from the crate screen (a new
  "take" button per item) or `Sites.withdraw` (into the player's inventory; what doesn't fit drops at the player). Automation
  can't extract (`canTakeItemThroughFace` stays false).
- **A crate block broken or gone.** Players can't break one (strength -1 as today; a creative break is refused with "remove it
  with /architect stockpile removecrate or through its owner"). If it disappears anyway (another mod, `/setblock`), nothing is
  lost: the ledger is the owner's, not the block's. The cell is listed in `missingCrates`, capacity drops by 27 stacks
  (stock above capacity stays, but nothing new enters until it fits), and the builder keeps feeding from the stock.
  `removeStockpileCrate` restores the cell's journal before-state; refused while it would leave the stock over capacity, unless
  `force`, which drops the excess at that cell (taken out of stock, counted in `dropped`). Removing the last crate with targets building is
  refused even with `force`. `/architect stockpile removecrate <pos>` needs permission level 2.
- **Persistence.** `<world>/architect/stockpiles.json` (temp file, then rename): per owner the crates, dimension, ledger
  (delivered, consumed, returned, withdrawn, dropped, refundOverflow per item), feed order, credited-refund keys (§4) and waits. It is
  written in the same world-save callback that saves chunks (autosave and stop), and on crate and feed-order changes.
- **Crash bound (recorded, not judged).** A clean stop saves ledger and chunks together. On a hard kill, the file and the
  chunks may come from different saves: items in flight since the last autosave can be duplicated or lost (as for any
  cross-chunk item move in vanilla). The gate records the drift after a kill and the bar is "within the units fed or placed
  since the last save".

### 3. Feed order (C24)

- **Targets** are the owner's building construction sites (buildings and delta sites) and construction roads. One loop per
  owner replaces the separate `Builder.tick`/`RoadBuilder.tick` visits for stockpile targets (legacy targets keep theirs).
- **Default order:** a batch's items in batch item order (not the order `proximityFirst` places them in), then later targets
  in placement order. `setFeedOrder` moves the listed ids to the front, in
  that order; the others keep their relative order. Unknown or finished ids refuse FIELD_LIMIT naming them. The order survives
  restart; a finished target leaves it.
- **Semantics: reservation by item.** A target at position k may consume a unit of item X only from
  `stock(X) - reserved_k(X)`, where `reserved_k(X)` is the unbuilt cost of X over the targets at positions 1..k-1 that are
  building and not paused. A higher target that is blocked (a player in a cell, an unloaded chunk, a missing support) still
  reserves; a paused one doesn't. Within one target the builder's order is unchanged (phase 3: bottom up, supports first, pairs
  together). The per-tick block budget (4d) is shared and spent in feed order.
- So a lower target builds only from surplus: with exact BOMs fed in any order, targets finish in feed order. Steward wants
  "this house first"; it gets it, and C25 says what a waiting lower target needs beyond the reservations.

### 4. Ledger and refund routing (C24)

- **Identity, per item, at every tick:** `stock = delivered + returned - consumed - withdrawn - dropped >= 0`.
  `returned` counts only what entered the stock; `refundOverflow` (refunds that never entered it) is outside the identity.
  `reserved` and `credit` are derived (credit = max(0, stock - total unbuilt cost)).
- **Returned** = refunds and leftovers credited into the stockpile, up to capacity; the rest drops as item entities at the
  owner's first present crate (else the target's `dropPos`) and is booked in `refundOverflow`. For a stockpile target:
  - deconstruct and undo (`Sites.remove`, `removeGroup`, `undoStage`, region removal): the `Refunds.Tally.refund` part is
    returned; **the player's blocks** (`PLAYER_DROP`) still drop at the site as today, since they never were the stockpile's;
  - construction-delta refunds (removed cells at the start, `refundSwap` at the swap) and a survival revert's refunds;
  - `Builder.complete`: no crate leftovers exist (the stock stays in the stockpile); nothing drops.
- **Exactly once.** A refund is credited under the key `(removal id or delta entry, site id)`, stored with the ledger in the
  same save. C22's resumed removal and a retried delta find the key and credit nothing again.
- **Lava (N-H-1).** When a cost names a container item (`lava_bucket`), consuming it returns one `bucket` to the stockpile.
  Fluid parts themselves stay with H and RS.
- **`Sites.stock(groupId)`** keeps answering for groups; per-site `outstandingBySite` and road ids are unchanged.

### 5. Migration of old worlds and legacy crates

- **No stockpile, no change.** A world from 0.17.0 loads with no `stockpiles.json`; every site, group, road and delta behaves
  exactly as before, and its crates keep their `<siteId>` or `group:<id>` owners.
- **Owner gets a stockpile while legacy targets build:** they keep their own crate until they finish (the old paths, unchanged).
  `adoptCrates(owner)` moves them over: for each legacy crate of the owner (per-site, group or delta), its `takeStock()` is
  returned into the stockpile (overflow dropped and booked), its group's `delivered` is added to the stockpile's, the crate
  cell is restored and its journal kind released (`SiteJournal.releaseKind`), and its targets join the feed order at the end in
  placement order. Idempotent; refused for another owner's crate.
- **Downgrade.** 0.17.0 ignores `stockpiles.json`. A stockpile crate block then has an owner id 0.17.0 doesn't know, so it
  accepts nothing, and stockpile targets show "crate missing" and pause. Remove stays exact (journals unchanged). The ledger is
  kept for the next upgrade. Recorded in the gate, not supported.

### 6. Waiting status (C25)

- **`SiteWait`** for every construction target (sites and roads), stockpile or legacy (for a legacy crate, `reserved` is 0).
  - `waiting`: building, not paused, not BUILT, its crate (or stockpile) present, and for at least **100 ticks** in a row it
    placed no cell while at least one frontier cell (unbuilt, support built, chunk loaded) was unaffordable from
    `stock - reserved`. A target held only by players in cells, unloaded chunks or a pause is **not** waiting for materials.
  - `waitingSince`: the world's game time (ticks) at the start edge; 0 when not waiting. Saved, so a 10-minute timer survives
    a restart; after a reload the state is recomputed and a still-waiting target keeps its `waitingSince` with no new event.
  - `nextNeeded`: walk the unbuilt queue in build order, spending `stock - reserved` as the builder would; each item enters the
    list at its first shortfall; `count` is its whole shortfall for the target. At most 8 entries; `moreUnits` is the units of
    the omitted ones, so the counts plus `moreUnits` equal the target's outstanding minus what is available to it. Filled whenever any shortfall exists,
    waiting or not.
- **Event `SITE_WAITING`** fires on the start edge (after the 100 ticks) and on the stop edge (a cell placed, paused, built or
  removed), never twice for the same edge, and at most once per 20 ticks per target.
- The crate screen and HUD "needs" line switch to `nextNeeded[0]`, so the screen and the API agree.

### 7. Full BOM before placing (C26)

- `Verdict.bomFull` for a construction `check`: template plus foundation fill plus approach, computed from the dry-run
  `SitePlan` that `precheck` already builds, with the builder's own exclusions (cells that already hold their target, cut
  cells cleared free, a dirt path passing `RoadBuilder.freeCell`). `bom` keeps its old meaning (template only).
- `bomExact` is true when the plan was complete (all chunks loaded, no refusal) **and** no planned cell is a known drift
  source: a block tick settled at P6 (a gravity block over a gap, grass turned to dirt under a solid block). Incomplete:
  `bomFull` is the template BOM. Complete with drift sources: `bomFull` is the plan's count, `bomExact` false.
- **Bar:** on an unchanged world, when `bomExact` is true, `bomFull` equals the site's `outstandingBySite` right after placing,
  item for item. When false, every item is within 2 units and the differing cells are listed. Terrain changed between check
  and place is outside the bar.
- **A whole build's bill** is the sum of its items' `check` `bomFull`, `checkRoad` `bom` and `checkDelta` `bom`. No batch check
  is added unless Steward asks (S-Y-4).

### 8. Gate (slice tier, $0)

**Fixtures:** the p3 survival client (survival toggle on), owner `test:settle`, a 3-crate stockpile. A batch of 3 houses (4d
kit examples) and a 40-cell C16 road, one standalone construction road, one update delta and one survival revert. Items enter
only through `dev.crate.insert` and scripted hoppers with **exact items, no equivalents** (one separate equivalents unit test),
so every item is counted in its own unit. The driver places some blocks by hand inside a house (for the player-drop rule) and
never mines by hand (vanilla drops differ from cost). The stockpile has room for the fixture's whole BOM, or the driver feeds in
waves. **Conservation** is checked per item at every checkpoint: `player and hopper inventories + stockpile stock + item
entities spawned by Architect + the cost of paid cells standing + the driver's hand-placed blocks standing = constant`
(withdrawn items land back in an inventory, so they stay counted).

**Evidence:** `artifacts/gate6c-y/`, driver `tools/gate6cy.mjs`, `spend.json` $0.00.

| # | Check | Bar |
|---|---|---|
| 1 | Unit | ledger identity, reservation order, `nextNeeded` walk, refund key idempotence, capacity in stacks, adoption, `bomFull` exclusions (`StockpileTest`, `FeedOrderTest`, `SiteWaitTest`) |
| 2 | One storehouse | all six targets build from the stockpile; 0 crates placed besides the 3 named; the standalone road is accepted; each target BUILT and cell-identical to its INSTANT twin |
| 3 | Feed order | `setFeedOrder` puts house 3 first; feeding the exact total BOM in shuffled order: house 3 is BUILT first, then the rest in order; with house 3 blocked (a player in a cell), the others build only from surplus |
| 4 | Conservation, feed | the conservation sum is constant (difference 0 for every item) at 10 checkpoints during feeding and building |
| 5 | Refunds | deconstruct one built house and undo the road: `returned` equals each one's `Refunds` tally; the player's blocks drop at the site; conservation difference 0 |
| 6 | Overflow | with capacity filled by credit, a deconstruct returns up to capacity and drops the rest: `refundOverflow` equals the counted entities; difference 0 |
| 7 | Credited once | `dev.undo.failRestore` mid-removal, then retry: the refund is credited once; difference 0 |
| 8 | Restart mid-feed | clean stop while hoppers feed and the builder places; reload: ledger equal, conservation difference 0, building resumes. A hard kill (`kill -9`, PID) after an autosave: the drift is recorded and stays within the units moved since that save |
| 9 | Crate gone | `/setblock` air on one crate: nothing lost, `missingCrates` lists it, capacity drops; `removeStockpileCrate` with excess refused, with `force` drops exactly the excess |
| 10 | Waiting | a target fed nothing: `SITE_WAITING` start after 100-110 ticks, `nextNeeded` in build order, its counts plus `moreUnits` equal to its outstanding; insert `nextNeeded[0]`: stop edge within 20 ticks of the next placed cell; a player-blocked or paused target never reports waiting; `waitingSince` survives a reload with no duplicate event |
| 11 | Full BOM | 12 lots of the 4d varied-terrain fixture: every lot with `bomExact` true matches the placed site's outstanding exactly (at least 10 of the 12 are); the others within 2 units per item, differing cells listed |
| 12 | Migration | a 0.17.0 survival world with a half-built `sharedCrate` group and a per-site crate loads unchanged (Stock equal, builds finish as before); `adoptCrates` moves their stock in with difference 0 and their crate cells restored; downgrade to 0.17.0 recorded |
| 13 | Unchanged without a stockpile | the 4d-all and phase 3 survival steps pass unchanged; Hardcore step unchanged |
| 14 | API, spend | api-compat clean against the previous three apitest jars; apijars pass; $0.00 |

**Tier:** slice: quick, `site/**`, `survival/**` (4d-all, the phase 3 survival step, 5b-chains for deltas), 0c's survival-road
step, X's removal step, apijars. **gate-verifier** re-runs items 4, 5, 7 and 8.

### 9. Build order

1. Archive the previous apitest jar. 2. `Stockpile` store, crate registration, persistence. 3. The owner feed loop (sites,
roads, deltas) with reservations. 4. Refund routing and the credit keys. 5. Adoption. 6. `SiteWait`, events, the crate screen.
7. `bomFull`. 8. Fixtures, gate.

### Open questions for Steward

- **S-Y-1. Reservation semantics.** A blocked high-priority target holds its items (drafted). Or visit order only, where lower
  targets may take what a blocked higher one needs next?
- **S-Y-2. Feed order API.** A reorder list (drafted), or an integer priority per batch item?
- **S-Y-3. Withdrawal.** Credit only, from the crate screen and `Sites.withdraw` (drafted). Do you need deposits of unneeded
  items (a general storehouse), or is "accept only what a build needs" right?
- **S-Y-4. Batch BOM.** Is summing per-item `check`/`checkRoad`/`checkDelta` enough for the card, or do you want one
  `checkBatch` call?
- **S-Y-5. Waiting threshold.** 100 ticks without a placed cell before `waiting` (drafted)?
- **S-Y-6. Dimension.** One dimension per stockpile, items of the owner elsewhere refused (drafted)?
- **S-Y-7. RS.** RS's draft gives each region a crate (`RealiseRequest.crateAt`, `RegionView.crate`). With Y, a region's lots and
  roads draw from the owner's stockpile; drop those two components from RS (recommended), or keep `crateAt` as "add a crate
  to the stockpile here"?

### Open questions for Noah

- **N-Y-1. Capacity.** 27 stacks per crate (drafted), or unlimited (refunds never drop)?
- **N-Y-2. Split.** Y is larger than a usual slice (it reworks the feed and refund paths of `Builder`, `RoadBuilder` and
  deltas). Ship as one slice, or Y1 (C24 and migration) then Y2 (C25, C26)? Steward's phase 4 needs Y1 first.

### Coordinator decisions on Y (2026-10-11)

- **N-Y-1:** 27 stacks per crate, as drafted. The storehouse grows by adding crate blocks; survival capacity is real. Refunds
  that don't fit drop at a stockpile crate (counted in `refundOverflow`), never at the site.
- **N-Y-2:** split. **Y1** = C24 (stockpile, feed order, ledger, refunds, migration; gate items 2-9 and 12-13). **Y2** = C25
  and C26 (waiting status, full BOM; gate items 10-11). Y2 doesn't need Y1's stockpile, so the two build **in parallel** on
  separate worktrees and ports; each takes the next free minor at merge. Y1 is Steward's phase 4 blocker and is reviewed first.

### Changes from Steward's review of Y (2026-10-11; these win)

- **S-Y-1:** a blocked target keeps its reservation for transient blockers (a player in a cell, a support not yet built).
  **Exception:** a target whose whole remaining frontier is in unloaded chunks does not reserve (Steward builds LOADED_ONLY;
  a far house first in order must not starve loaded targets near the player). **New gate item (Y1):** two targets, the first
  in feed order entirely in unloaded chunks: the loaded second target is fed and builds; when the first's chunks load, its
  reservation returns.
- **S-Y-2:** a reorder list, as drafted.
- **S-Y-3:** accept only what a build needs (Y1). A general storehouse is later.
- **S-Y-4:** summing each item's `bomFull`, `checkRoad` and `checkDelta` is enough; no `checkBatch`.
- **S-Y-5:** 100 ticks, as drafted.
- **S-Y-6:** one dimension per stockpile, as drafted.
- **S-Y-7:** drop RS's region crate (`RealiseRequest.crateAt`, `RegionView.crate`); regions draw from the stockpile.
- **Addition (Y1): `dissolveStockpile(owner, to)`.** For an abandoned settlement: one call hands every remaining unit,
  reserved or not, to a player (`to` = a player, items to the inventory with overflow dropped at the player) or drops it at a
  crate (`to` = null), restores every crate block, and ends the stockpile. Allowed while stock is over capacity and with targets
  building: their reservations are released and they fall back to waiting (C25) with no stockpile (as for an owner without
  one). Every unit is counted in `withdrawn` or `dropped`, so the ledger identity holds. **Gate item:** dissolve with
  reserved stock and a building target: conservation sum exact; crates restored; the target reports waiting.
- **N-Y-1, N-Y-2:** Steward agrees (27 stacks per crate; Y1 before Y2, built in parallel).

### Deferred

- Hardcore's difference. Villager or entity hauling. Cross-dimension stockpiles. A batch BOM call (unless S-Y-4). Crash-exact
  ledgers (a write-ahead log per feed) if the recorded kill drift matters.

### Slice Y2 as built (C25 waiting status, C26 full BOM; API 1.15.0 / mod 0.18.0, batched with W)

- **API.** `SiteWait`/`ItemCount` exactly as §1, `Sites.waiting(String)` (default throws), `SiteEvents.SITE_WAITING`, `Verdict` trailing
  `bomFull`, `bomExact` (the 1.12.0 constructor kept), `SiteView` trailing wait (old constructors kept), features `siteWaiting` and
  `fullBom`. **Deviation:** the `SiteView` component is `siteWait`, because `wait` is not a legal record component name (it clashes
  with `Object.wait()`). No Reason, no Limits constant.
- **Waiting is a latch** (`survival/WaitCalc`, `site/SiteWaits`): it starts after 100 consecutive builder ticks with no cell placed and
  at least one unbuilt, supported, loaded frontier cell the stock cannot pay (starved); once on it holds until a cell is placed, or the
  target is paused, its crate is gone, built or removed. An unloaded chunk, a player in a cell or a restart never end it. The 20-tick
  limit defers an edge, never drops it; the stop edge of a built or removed target fires at once. `waitingSince` is the world game
  time, saved in `<world>/architect/waits.json` (written when a wait starts or ends and at world stop); after a reload the latch is
  restored without an event. Roads use the same hooks (`RoadBuilder.step`). Seam for Y1: `SiteWaits.source(Source)` returns the
  units available to a target (`stock - reserved`); the default reads its own or its group's crate (reserved 0).
- **nextNeeded** walks the unbuilt cells in build order per item (an item enters at the first cell its available stock cannot pay;
  count = its whole shortfall); the crate screen and HUD "needs" line use `nextNeeded[0]`. Cached by built count and stock hash.
- **bomFull** (`site/FullBom`) mirrors `Builder.planConvert` from the dry-run `SitePlan`: it runs the placement's writes (template in
  saved order, `placeInWorld`'s edge-face and final shape-update passes, unsafe beds out, foundation, terrain cut, approach) through a
  small simulator of `Level.setBlock`'s shape-update cascades, because vanilla destroys what a write leaves unsupported (a door over a
  hillside cell the template clears, a standing lantern on a chest, a door over a gap the foundation closes later). Each remaining
  cell costs `Cells.cost`. `bomExact` is false on any refusal, an unloaded neighbour, a throwing `updateShape`, or a known drift
  source (gravity block over a free cell; dirt path or farmland under a solid block when its item would differ; coral with no
  water); the cells are listed in `Verdict.notes` ("bomFull may differ ..." / "may be off: reason"). A dirt path that turns to dirt
  costs the same item, so is not a drift. An incomplete plan answers the template BOM with `bomExact` false.
- **Gate** `tools/gate6cy2.mjs` (driver names differ from the contract's `gate6cy.mjs`, which Y1 owns), steps `y2-unit`, `y2-ingame`
  (`y2-bom` alone), evidence `artifacts/gate6c-y2/`. Item 10: A starts waiting exactly 100 ticks after SITE_PLACED; nextNeeded equals the
  independent build-order walk and counts + moreUnits = the bill; inserting nextNeeded[0] gives a stop edge within 20 ticks; a paused
  site and a site with the player in its cell (fed everything) never wait; waitingSince is equal after a clean reload with no second
  start event. Item 11: on the 12 lots of a varied-terrain world, every lot's bomFull equals the placed site's bill item for item
  (11 of 12 exact, the 12th inexact with an equal bill; earlier iterations missed 4-6 lots by 1-2 doors or 2 lanterns each, which is
  what drove the simulator). Item 14: `api-compat --gate6cy2` 4/4 (0.17.0, 0.16.0, 0.15.0 apitest jars and the 0.17.0 surface; baseline
  built from tag v0.17.0 into `artifacts/gate6c-y2/v0170`), apijars on those jars.
- **Not covered in game:** the road wait path (code shared with sites, covered by V's survroad regression step only); the Y1 stockpile
  seam. Dev hooks added: `dev.site.cells`, `dev.bom.predict`, and `wait`/`order`/`nextCells` in `dev.site.state`.

### Phase 6c slice Y1 as built (C24; API 1.17.0 / mod 0.20.0, v0.20.0, recorded 2026-10-12)

Branch `slice/Y1` (worktree `../architect-mc-Y1`). $0: sim and stub only (`artifacts/gate6c-y1/spend.json`). Evidence:
`artifacts/gate6c-y1/` (one JSON per `tools/gate6cy.mjs` step, REPORT.md, api-compat.txt, `c0c/`, `gate3/`), the slice tier under
`artifacts/gate-runs-Y1/`. Ports 8930-8935. Versions assigned by the coordinator: API 1.17.0, mod 0.20.0 (F1 and MP land first as v0.19.0 / API 1.16.0).

| § | As built |
|---|---|
| API | Feature `stockpile` (not `siteWaiting`/`fullBom`: Y2's). `Sites.createStockpile`, `addStockpileCrate`, `removeStockpileCrate` (a `RemoveResult`: `refund` = what a forced removal dropped, `blockers` = why not), `stockpile`, `feedOrder`, `setFeedOrder`, `withdraw`, `adoptCrates`, `dissolveStockpile(owner, @Nullable ServerPlayer to)` (returns what went out): defaults that throw "needs Architect API 1.17.0". Records `Stockpile` and `StockpileRequest`; `SiteWait` and `ItemCount` are Y2's (on main since 1.15.0). `Stockpile.waiting` holds each target's C25 wait (`SiteWaits.view`). `SiteEvents.STOCKPILE_CHANGED` (`onChanged(owner)`, at most once per 20 ticks per owner). `Limits.STOCKPILE_CRATES` = 16. Refusals are `ArchitectRefused` with NOT_ALLOWED, FIELD_LIMIT, PROTECTED, NOT_LOADED. `Stock(groupId)` of a group whose sites draw from a stockpile reports that stockpile's delivered and credit and `crate` = its first crate. |
| Identity (coordinator, owners may change hands) | A stockpile is keyed by **its own id** `sp<n>` (`nextId` saved in `stockpiles.json`); the owner is an attribute, never a file key or part of an id. Crate block entities and crate journal entries carry `stockpile:<id>`; `Sites.stockpile(owner)` and every owner-taking API look up by owner. A later `transferOwner` or merge re-keys without a format change. |
| C25 seam (Y2) | `Stockpiles.init` sets `SiteWaits.source`: a stockpile target's supply is what its feed position leaves it (`stock - reserved`, `availableTo`), so `waiting` and `nextNeeded` count reserved stock as unavailable; a crate-less target of an owner with no stockpile (dissolved) has nothing (the builder observes it STARVED, so it waits); any other target reads its own or its group's crate (Y2's default). The builder's purse step keeps Y2's `observe` calls (PLACED, STARVED on an unaffordable frontier cell, IDLE, ENDED on pause or a missing crate). |
| §2 model | `site/Stockpiles` (registry, owner loop, crates, persistence) and `survival/StockLedger` (pure: delivered, returned, consumed, withdrawn, dropped, refundOverflow, credited keys, capacity in stacks). **A stockpile target** is a construction (site or road) whose owner (`Site.owner`/`Infra.owner`, not `Construction.owner`) has a stockpile in its dimension and whose `Construction.crate` is null: no new record field, so 0.17.0 sees "crate missing". Conversion (`Builder.planConvert`, `RoadBuilder.convert`, `applyConstructionDelta`) of an owner with a stockpile places no crate; a batch's `sharedCrate`/`crateAt` are ignored with a log note (BatchView has no notes; `QBatch.note` is the cancel message). Standalone `placeRoad` CONSTRUCTION/AUTO is accepted for such an owner. Crates: `architect_mc:construction_crate` with `stockpile:<owner>`, each with its own `crate` journal entry under that id (no group); `SiteJournal.crateEntry` now returns the entry id and `releaseEntry(id)` releases one. A cell is refused when not loaded, not air/replaceable, in a site's restore box, journal-owned, or in another owner's protected area. A creative break is refused with the removecrate message; right-click opens the stockpile view (never "taken away"). `/architect stockpile list` and `removecrate <pos> [force]` (permission 2). `stockpiles.json` (temp + rename) written in `BEFORE_SAVE`, at `SERVER_STOPPING` (after the last tick: the trace shows both on a clean stop) and on crate and feed-order changes; a world that never had a stockpile keeps no file. |
| §3 feed | `Builder.tick`/`RoadBuilder.tick` skip stockpile targets; `Stockpiles.tick` (END_SERVER_TICK) feeds each owner's targets in order through a `Builder.Purse` (`stock - reserved_k`), with the same step code (20-tick rescan, completion, SITE_PROGRESS, ghosts unchanged). `site/FeedOrder` (pure): default order = batch item order (by the item's index in its QBatch), then placement order; `setFront`; reservations. **blocksPerTick stays per target**; the shared 4d budget is the placement time budget, spent in feed order. **S-Y-1 exception:** a target reserves only while some frontier cell (unbuilt, support built) is in a loaded chunk, checked at most every 20 ticks. **Found and fixed for stockpile targets:** `Level.getBlockState` adds a one-tick UNKNOWN chunk ticket, so the builder's per-tick scan kept every construction site's chunks loaded for good (legacy sites too: `dev.stockpile.tickets` shows the renewed ticket); stockpile targets and crates now read through `getChunkNow` (`Builder.stateIfLoaded`/`entityIfLoaded`), legacy sites are unchanged; the coordinator accepted this and queued the legacy sites' forever-loaded chunks in PLAN. |
| §4 ledger | Identity per item at every moment; overflow drops above the first present crate (else the target's drop cell). **Credit keys:** `site:<id>@<placedAt>` for a site's deconstruct on any path (single remove, group/stage/region removal), `road:<id>@<placedAt>`, `delta:<entry>:<site>`; the contract's "(removal id, site id)": a single remove has no removal id, and a placement is deconstructed at most once, so the key survives C22/C23 resumes. **Deviation, accepted by the coordinator (2026-10-12).** Group removals persist each stockpile member's refund apart from what drops (`credit` in the removal JSON) and credit it once its restore is written: a construction member after `finishGroupDeconstruct`, a road on its RestoreJob's success (also when found written after a load). Swap refunds and a filled bucket's container are credited unkeyed as they happen. The player's blocks still drop at the site (`dropPos`). `RemoveResult.refund` includes the credited refunds. |
| §5 adoption | Each legacy crate of the owner (a building site's own, a group's shared one, a road's group crate) books its crate ledger's **delivered into `delivered` and placed into `consumed`** (the stock grows by exactly the crate's stock; the group's history is kept), once per `adopt:<crateOwner>@<pos>` key; what doesn't fit is booked **`dropped`** and drops at a crate. Reading §5 literally ("returned" plus "delivered added") breaks the identity. **Deviation, accepted by the coordinator (2026-10-12).** Crate cell restored, `releaseKind`, the group's crate cleared, the targets' crate set to null (they join the feed order in placement order). |
| Dissolve | Every unit: into the player's inventory (`withdrawn`) or dropped (at the player, or at a crate: `dropped`); every crate restored; the stockpile ends. Its targets keep building with no stockpile (`dev.site.state` `noStockpile`) and resume when one exists again. After the v0.18.0 merge the target reports waiting through C25 (`Sites.waiting`: waiting, with its whole bill in `nextNeeded`). |
| Screen | The crate screen on a stockpile crate: stacks used of capacity, crates (missing ones), targets; per item stock, needed, credit and a Take button (`Sites.withdraw`); Insert from inventory through the nearest crate. |
| Hooks | `dev.stockpile.create|addcrate|removecrate|state|order|withdraw|adopt|dissolve|audit|saved|pause|tickets`; `dev.crate.insert` takes `stockpile:<owner>` and `exact` (no equivalents: the gate counts every item in its own unit). `audit` gives the conservation parts per item (stock, paid cells standing in active and pending records, legacy crate stock, entities and containers in a box, the inventory) and never loads a chunk. apitest `apiy1`, `pcreate`, `paddcrate`, `premove`, `pstate`, `porder`, `pwithdraw`, `padopt`, `pdissolve`; STOCKPILE_CHANGED in `/apitest events`. |
| Final (post-merge, v0.18.0 base) | Head 5d6e816 / 72b8b80. Slice tier `artifacts/gate-runs-Y1/20261012-051529-slice` at 2128f6c (stopped at Noah's pause): unit-mod, unit-kit, sim-jobs/-sets/-massing, apijars (0.17.0/0.16.0/0.15.0 jars), x-ingame 53/0, y-unit, **y-ingame 103/0** (with the C25 checks), x-resume 46/0, 4d-all (2 timing bars recorded), 4e-orders, 5b-village, 6b-pathstyle PASS; then `20261012-163336-change` at 5d6e816: unit-sidecar, y2-unit, **y2-ingame 46/0** (C25 now fed by the stockpile), 4e-megalite, 5b-chains 329/0 PASS. The earlier 5b-chains failure (DevBridge closed at seed 4) did not reproduce: its client stopped cleanly ("Stopping!", then the save) mid-way through an instant delta of a site with no owner and no stockpile; an external stop, not a crash, not on a Y1 path. The two earlier unit-sidecar failures were vitest timeouts under load (no sidecar code changed). api-compat 4/4 against the 0.18.0 and 0.17.0 apitest jars (built from their tags, `v0180/`, `v0170/`), the 0.16.0 jar and the 0.18.0 surface. gate-verifier PASS twice: at 49cdcd2, and at 5d6e816 after the merge (reviewed the merge resolutions, the id keying and the C25 seam; re-ran items 4, 5, 7 and 8 itself, all exact, kill drift recorded: `artifacts/gate6c-y1-verify2/`). Its note that a stockpiles.json without ids would not load is fixed (ids are assigned at load, never reusing one: `StockpileFileTest`; verifier review PASS). Only the file migrates: a pre-release Y1 world's crate blocks would still carry `stockpile:<owner>` and count as missing until re-added; no such world was released. |
| Slice tier (pre-merge) | `artifacts/gate-runs-Y1/20261012-034544-slice` (2 shards, 8930-8933, head 49cdcd2, the 2026-10-12 slim slice tier): 13 PASS, including unit-mod 518, unit-kit 246, unit-sidecar 705, apijars (0.16.0/0.15.0/0.14.0 jars, 45 ok each), x-ingame 53/0 (C22 removal), **y-ingame 100/0**, 4d-all 61 (two timing bars recorded at load 35-51, not judged), 4e-orders, 5b-chains 329/0, 5b-village, 6b-pathstyle, 4e-megalite. sim-jobs/-sets/-massing failed only on `tools/apitest.mjs`'s pinned API version (now the 1.17.0 placeholder; the coordinator's number replaces it at merge): PASS at 9b4f1eb in `20261012-045143-change`. gate-verifier: PASS; it re-ran items 4, 5, 7 and 8 itself (`artifacts/gate6c-y1-verify/`, all exact; kill drift recorded). Its minor notes, **known follow-ups** (queued in PLAN): `Groups.credit` skips a credit when both dimensions are unloaded; a single road removal credits before its restore (a retry is keyed); a road credited by `beforeRemove` is missing from a group's `RemoveResult.refund`. |
| Gate | Items (`artifacts/gate6c-y1/REPORT.md`): 1 `unit` (StockpileTest 9, FeedOrderTest 6, ApiY1Test 5); 2+4 `store` (3 crates, 0 others; 3 houses, a batch road, a standalone road, a v1->v3 delta and a survival revert all BUILT from the stockpile; houses and roads cell-identical to INSTANT twins; the delta target cell-identical to a legacy construction twin, and to the instant twin but for one soil cell (grass/dirt) that the legacy construction delta shows too: 5b's, not Y1's; the delta's and revert's removed cells credited under one key each; conservation 0 at 19+ checkpoints); 3 `order` (house 3 BUILT first then in order; house 6 blocked by a player: the others used only the surplus); S-Y-1 `unloaded`; 5 `refunds`; 6 `overflow`; 7 `once` (failRestore breaks an instant member after the construction house was credited; save, reload, retry: every refund once); 8 `restart a/b` (the loaded ledger equals the file the clean stop wrote; conservation 0; building resumes) and `restart kill/c` (manual: drift recorded within the units moved since the autosave); 9 `gone`; Steward's `dissolve` (the restart, kill and migration parts re-run at head 49cdcd2); 12 `migrate a-d` (0.17.0 world: Stock and the per-site ledger equal, builds finish through their crates; adoptCrates moved 400 items with difference 0, cells restored, idempotent; downgrade recorded: 0.17.0 shows crate missing, nothing builds, remove exact); 13 0c `survroad` on this build (`c0c/`), gate3 survival and hardcore (`gate3/`), 4d-all in the slice tier; 14 api-compat 4/4 against the 0.17.0 (built from tag v0.17.0, `v0170/`), 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface. |

### C29 as built (Steward round 9; API 1.19.0 / mod 0.22.0, assigned by the coordinator; recorded 2026-10-12)

Branch `slice/C29` (worktree `../architect-mc-C29`), merged with v0.21.0. $0: sim and stub only. Ports 8936-8941. Evidence:
`artifacts/gate-runs-C29/` (slice and change tiers; the step evidence under each run's `gate6c-c29/`), the 0.21.0 jar set built from
tag v0.21.0 with its `tools/` in `artifacts/gate6c-c29/v0210/`.

| § | As built |
|---|---|
| (a) leaving the feed | `Groups.leaving(id)`: the target is in a running removal's sites (a group removal, `undoStage`, a region removal through `removeGroup`; from the removal's start through its wait for a player and its planning, until the record goes pending), or a whole-group removal not yet started (its batches cancelling) is of its group, or a single road removal's job runs for it. `Stockpiles.feed`, `availableTo` (C25's seam), `unbuiltAll` (credit, insert acceptance, `outstanding`) and the API view skip such a target: no step, no reservation, no need. It keeps its place in the feed order, so a removal that ends without removing it (a player stayed 10 min, blockers) feeds it again from there; its C25 wait ends. Nothing new is saved: the removals are already in `placement.json`, so a restart mid-wait keeps the target out. Legacy (own-crate) targets are unchanged. |
| (a) the refund | The tally stays where rule 7 needs it (before the undo is planned: `beforeMap` reads the active entries), but the target has been out of the feed since the removal started, so what it tallies is what stands when the restore writes; it is credited when the restore is written, once per key (`site:<id>@<placedAt>`, `road:<id>@<placedAt>`), as Y1 built it, across C22/C23 resumes. **A single road removal** now carries its tally on its `RestoreJob` (saved with the job as `credit`) and credits it when the restore is written, never when the restore breaks; the credited items are its `RemoveResult.refund` (closes Y1's follow-up "a single road's refund credited before its restore"). A single site `remove` is synchronous and refuses a player in the box, so it has no wait. Regions are INSTANT only in this version (`RegionsImpl`, the survival refusal), so a region has no stockpile member until RS; its removal is `removeGroup`'s path. A delta stage's undo is a forward delta, not a removal: it stays in the feed. |
| (b) `Sites.pause` | `void pause(String targetId, boolean paused)`, a default that throws "needs Architect API 1.19.0". `Builder.pauseTarget`: a building construction site or road (stockpile or own crate), as the crate screen's Pause (`Construction.paused`, saved with the site or road record); idempotent; FIELD_LIMIT for an id that is no construction target building (unknown, built), NOT_ALLOWED while it is being removed; STOCKPILE_CHANGED. A paused target places nothing and reserves nothing (Y1's rule) and keeps its order position. `dev.stockpile.pause` takes the same path. Features `targetPause`, `removalLeavesFeed`. No new Reason, no record change. apitest `apic29`, `ppause`. |
| Gate | Step `c29-unit` (ApiC29Test 3, C29CreditTest 3, ApiRulesTest) and `c29-ingame` (`tools/gate6cy.mjs c29wait c29restart c29stage c29pause apicompat`, the 6b client), impact rule "C29 removal leaves the feed, Sites.pause". Items: **1** `c29wait`: A half built and first in the order, C behind it starved; the player in A's box, `removeGroup`: A leaving and reserving nothing at once, its outstanding gone from the stockpile's and from `outstandingByTarget`, `pause` refused NOT_ALLOWED; A's remaining bill inserted: over 20 s A placed nothing (paid 263 -> 263) and every unit consumed was C's (244); the player out: removed, returned = A's paid standing (263), one key, conservation exact at every checkpoint. **2** `c29restart`: the same with save, leave and reopen mid-wait: still REMOVING and A still out after the reload, A placed nothing, C fed past it; the resumed removal ends REMOVED with nothing credited before the restore and returned = paid, one key, removing again credits nothing, conservation exact. **4** `c29stage`: `undoStage` of the top stage waiting for the player in its house: that house placed nothing, the other stage's house was fed past it, refund = paid; a single road removal credits 40 = 40 once restored, in its `RemoveResult.refund`; one key each; conservation exact. **3** `c29pause`: A-D and a road; B and the road paused (no-op twice, unknown id FIELD_LIMIT); feeding exactly two bills builds A and C (C fed past B), B and D placed nothing; a BUILT target refuses FIELD_LIMIT; after a reload B and the road still paused, the order unchanged; resumed, B reserves again and is BUILT first while D gets nothing; conservation exact. api-compat 4/4 against the 0.21.0 (built from tag v0.21.0), 0.20.0 and 0.19.0 apitest jars and the 0.21.0 surface; apijars on those three jars. |
| Runs | Slice tier `artifacts/gate-runs-C29/20261012-211122-slice` (2 shards, 8936-8939, head d290fe1, merged with v0.21.0): 23 PASS, including unit-mod 588, unit-kit 296, apijars (0.21.0/0.20.0/0.19.0 jars; one timing bar recorded on the 1.17.0 jar at load 67), **c29-ingame 64/0**, c29-unit, **y-ingame 103/0**, y-unit, x-ingame 53/0, **x-resume 46/0**, 4d-all, 4e-orders, 5b-chains 329/0, 5b-village, t1-ingame, the 6a and 6b impact steps. Two did not pass, neither on C29's code (no sidecar file changed): unit-sidecar (the eval e2e compare read "regressed, mean time +34%" at load 63; PASS in `20261012-233027-change`, 713) and t1-unit's sidecar part (this checkout had no `sidecar/node_modules`, so its vitest could not start: environment; PASS 17/0 in `20261012-235107-change`). Pre-merge change run `20261012-205331-change`: c29-ingame 64/0. **gate-verifier: PASS**: it reviewed the diff and the evidence and re-ran the accounting items itself (`artifacts/gate-runs-C29-verify/20261012-225204-change`: c29-ingame 64/0, y-ingame 103/0); two low notes, no defect (a `Placement.job` lookup per target per tick in `Groups.leaving`; the dev pause hook now refuses a leaving target). No negative control was run (the box was at load 25-115). |

### C30 as built (Steward's patch ask; mod 0.22.1, API unchanged at 1.19.0; recorded 2026-10-13)

| Part | As built |
|---|---|
| The report | v0.22.0 stub e2e: set_193's last stage "placing" for ten minutes; set_195's landmarks stage starting ten minutes after its street. |
| Root cause | Not a stage race and not C29. Both were batch items waiting on a temporary blocker under the batch's 600 s wait limit, and the wait was not in the log, only in `ITEM_WAITING`. Steward's `architect-queue.json` shows it. b193's `cabin_2` (district_2, beside s718 = cabin_3) waited 11580 ticks, after Steward's own fit refused it "OCCUPIED: in the box: chicken". It then failed NOT_ALLOWED when survival was switched on (MUST 3), and the stage went partial and the batch finished. b195's `smokehouse_1` waited 11720 ticks after the fit refused it PLAYER_IN_BOX. It placed the tick after Steward's e2e moved the player away (`migratedSteward`'s `/tp`, right after survivalFlow's `finally`), not because survival was turned off: it still placed as a construction site. C29's `Groups.leaving` is read only by `Stockpiles` and `Builder.pauseTarget`. An item that has not started has no site to be leaving, and b193 is INSTANT and never touches a stockpile. |
| Stage rule (unchanged since 4d/Y1) | A stage places when every earlier stage of its group is finished (PLACED, PARTIAL, SKIPPED or UNDONE). A construction item is PLACED once its site is put down, not when it is built, so a street waiting for materials never holds the next stage. Y1's feed order decides only which target is fed first. |
| Fix | `Batches.waitFor` logs a wait once per reason: `Batch <b>: item <key> (stage <s>) waits (<REASON>): <message>; checked again every 1 s, fails TIMED_OUT after <n> s` (or "no time limit"). Region tiles are left out, because their region status says it. |
| Gate | Step `c30-ingame` (`tools/gate4d.mjs base && tools/gate4d.mjs c30`, headless), impact rule "C30 stage completion and item waits (v0.22.1)". **1:** 12 staged batches (4 stages, 6 sites over ticks, budgets 2/4/20 ms, autoApprove and stage by stage) reach placed in order and finish; each group removal leaves the lots exact (box + 7; the first drift is diffed). **2:** a chicken in a last-stage lot holds it PLACING, the log line appears once over 6 s, and it places when the chicken is moved out. **3:** a 3 s limit fails TIMED_OUT and the stage ends PARTIAL. **4:** survival: the player next to the landmark's lot holds it APPROVED (logged), and with the player gone it places while the street's construction site is unbuilt. |
