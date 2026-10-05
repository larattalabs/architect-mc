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
