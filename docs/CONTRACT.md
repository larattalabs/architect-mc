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
   - Breaking the crate is refused while the site is building (unbreakable; it shows a message to use Deconstruct).
5. **Equivalents** (`data/architect_mc/equivalents.json`, curated):
   - 1 log or stem (any wood) = 4 planks of that wood
   - 1 planks = 2 slabs of that wood
   - stone ↔ stone bricks (1:1), cobblestone ↔ cobblestone variants (1:1)
   - 1 iron ingot = 1 iron bars × 16/6 (rounded down)
   - and similar small ones
   An inserted item that only an equivalent needs is converted on insert. Leftovers stay as credit in the crate.
6. **Builder.**
   - Each server tick, a building site places up to `blocksPerTick` (default 4, config 1-64) queued cells whose item is
     in the crate. Place sounds play quietly at the cell.
   - A cell whose position now holds something else (a player's block or a mob) is skipped and retried later. After
     200 ticks it's reported in the crate screen as "blocked at x,y,z".
   - When the queue is empty: `state: "built"`, the crate drops its leftover items (credit too, as items) and turns into
     air, and a toast plus chat note fires. The crate cell is restored from its own snapshot.
7. **Ghost.**
   - The server syncs each building site's **remaining** cells to clients in range, through a custom payload
     `architect_mc:site_ghost {siteId, origin, rotation, blueprintId, built: bitset}`. Clients derive the remaining
     cells from the template plus the bitset.
   - GhostRenderer draws the remaining cells translucent; the next cells, whose items are delivered, are tinted green.
   - The ghost is kept across relogs and restarts; the state is in the site record.
8. **Remove / deconstruct in survival** (from the crate screen, the Library's Placed view, or `/architect remove`).
   - For every cell of the box:
     - if the current state equals what the site placed there, the cell's item is **refunded**;
     - else if the current state differs from the snapshot and is not air, it is the player's block: it **drops as an item** at the cell;
     - else nothing.
   - Then the snapshot is restored, as now.
   - Refunds plus the crate's stored items and credit drop at the crate's position as item entities, or go into the
     crate's inventory if there's room, until the player empties it. Decide which, and document.
   - **Blocks the player mined from a site are not refunded**: they already have the item. That's the no-dupe rule.
   - A container the player filled still refuses Remove (as now).
   - Move in survival is refused ("deconstruct and place again").
9. **Leaf guard and bed safety** apply as now. A bed that bed safety leaves out is not queued and not charged.

## Site record additions

`state: "building"|"built"` (absent = built, as in phases 1-2), `queue` (a compact form: indexes into the template grid plus
the foundation/approach cells), `built` (a bitset), `crate {pos, snapshot}`, `ledger { delivered: {item: n}, credit: {item: n} }`.
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
- feed it from a **hopper chain** out of chests holding exactly the BOM, part of it as logs (equivalents);
- watch it finish: the built site equals an instant placement of the same design at the same spot, every cell;
- mine 3 placed blocks (the player keeps the items), then deconstruct: the refund equals BOM − 3 mined, the 3 aren't
  refunded again, and the terrain is restored exactly;
- a creative world with the toggle off still places instantly;
- a hardcore world works without cheats, except the toggle change.

gate-verifier checks the result.
