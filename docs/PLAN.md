# Architect: plan

Architect is a Fabric mod for Minecraft (26.3) that designs buildings with Claude. Describe a building or
mark a plot, review it as a ghost, then place it, keep it in your library, or (in survival) build it
by feeding a construction site materials.

It started as the building designer in the AgentCraft fork (`nlaratta/agentcraft`, itself a fork of
`blendi-remade/agentcraft`, MIT). This repo lifts that feature out and generalizes it. It is not a
fork and does not track upstream.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-04 | New public repo `larattalabs/architect-mc`; distributable. |
| 2026-10-04 | **Singleplayer only.** Same architecture as AgentCraft: the mod talks to a local Node sidecar over a localhost WebSocket. The sidecar runs Claude through the Claude Agent SDK, and the design agent's kit code runs locally. Dedicated servers are out of scope; supporting them would first require sandboxing the agent-written code. |
| 2026-10-04 | **Auth:** an Anthropic API key is the supported path. An opt-in `--use-claude-login` / `useClaudeLogin` runs on the user's local `claude` CLI login instead. It is off by default and documented as personal use only, because Anthropic does not allow third-party products to offer claude.ai login ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)). Pattern: AgentCraft `foreman/src/agents/claude/auth.ts`. |
| 2026-10-04 | **Survival is a per-world toggle.** Off: placement is instant, as in AgentCraft. On: placing creates a construction site that builds as it is fed materials. |
| 2026-10-04 | **The mod launches the sidecar itself** (finds node, installs the Agent SDK on first run, reuses a running one, stops what it started). AgentCraft should get the same feature; requested in its session. |
| 2026-10-04 | Mod id `architect_mc`: the Modrinth slug `architect` is taken (an old biome mod). The display name stays Architect for now. |
| 2026-10-04 | Branding: "Powered by Claude" is fine. The name must never include "Claude Code". |

## Architecture

```
Minecraft (Fabric mod)                         Architect sidecar (Node, localhost:7979)
  design form / plot marker  --design.request-->  design queue
  library screen             <--design.upsert--   design agent (Agent SDK, scratch dir per job)
  ghost placement / sites                         pristine-kit checker (child process)
  construction sites (survival)                   renderer (previews)
                                                  installs .nbt + sidecar + source into the library
```

- **Sidecar:** a slim extraction of the AgentCraft Foreman. It keeps only the design job: queue, scratch
  dirs, the aux turn runner, the permission policy that refuses network, subagents and prompts,
  usage-limit hold and resume, session resume, the state store, WebSocket and protocol, and auth. No goals, tasks,
  agents, git or PRs.
- **Mod:** placement, ghost, plot marking, design form, library, and survival sites. The mod starts the
  sidecar itself (it finds `node`, installs the Agent SDK on first run, then spawns the bundled sidecar), so
  players never run it by hand. Details: docs/CONTRACT.md "Launcher".
- **Blueprint kit:** `tools/blueprints` from AgentCraft (kit, block table, checker, renderer), with
  checker **profiles per building type** instead of AgentCraft's office anchors.

## What comes from AgentCraft

| AgentCraft path | Here | Change |
|---|---|---|
| `mod/.../building/` TerrainFit, Approach, Occupancy, BlueprintTransform, TemplateGrid, GhostModel, Reconcile, Blueprint(s) | `mod/.../placement/` | Drop repos, wings, leads, routing, trophies, roads. The `fixture` kind (a repo-less building) is the starting point. |
| `mod/.../building/` Buildings, Building | `mod/.../site/` | Records without repos; Remove/Move as is in creative; survival rules below. |
| `mod/.../client/building/` BuildPlacement, GhostRenderer, PlacementHud, PlotMarker, PlotHud, TemplateCells, BlueprintPreview | `mod/.../client/placement/` | Mostly as is. |
| `mod/.../client/design/`, `building/DesignSpec` | `mod/.../client/design/` | Generalize the styles and features; add the building type. |
| `foreman/src/designs.ts`, `agents/claude/design.ts`, auth, store, server, protocol (design messages) | `sidecar/` | Brief and system prompt rewritten for general buildings. |
| `tools/blueprints/` | `kit/` | Checker profiles; examples for each type. |

When code is copied, the upstream MIT notice stays (see LICENSE).

## Phases

Each phase ends at a gate that is checked in a dev client (DevBridge screenshots), never in a real world.

### Phase 1: Extract and generalize (creative placement)
- Standalone mod and sidecar; the form → design → ghost → place → remove path works end to end.
- Building types, each with a checker profile, e.g. house, cabin, tower, shop, tavern, barn, smithy,
  chapel, gatehouse. The profiles check what a player cares about: a door that opens, floors reachable
  by stairs, a closed roof, a lit interior (optional per type), and nothing floating.
- API key auth plus the opt-in claude login, with a status line in-game.
- **Gate:** from a fresh dev world, generate a cabin at preset M and a tower on a marked plot; both pass
  the checker, place, and Remove restores the terrain exactly.

**Status: PASSED 2026-10-04** (independent gate-verifier). A real Claude cabin (preset M, 13x14x16) and a tower on an
11x11 plot (11x30x11) each passed the pristine-kit check on round 1, about 4 min and about $1 each. Both were placed through the ghost on rough
terrain and removed with the snapshot box restored cell for cell. The bundled first-run launcher path works
(extract, npm ci, spawn); the run found and fixed a first-run crash. Evidence: `artifacts/gate1/REPORT.md` (local).

Carried forward (known issues):
- ~~Leaf decay at the box edge~~ **fixed 2026-10-04** (`LeafGuard`): while a site stands, leaves within 6 of its box
  that may hang on logs inside it are held persistent (recorded in the site's pin with their original distance) and get
  their state back on Remove/Move; a new snapshot gives back leaves other sites hold inside it, and after a restore nearby
  sites hold again what they need. Verified: place, stand, move next door, undo, remove under 300x random ticks, with
  ~156k cells around both places identical.
- ~~BedSafety dropped~~ **ported back 2026-10-04**: template beds are left out where the bed rule makes them dangerous
  (verified: the bundled cabin in the Nether places with "1 bed left out", no bed blocks).
- ~~Leaves on unwritten floor-row cells~~ **fixed**: leaves are cleared in every row of the box the template doesn't write.
- **Nether ground:** "ground" placement (median surface) uses the motion-blocking heightmap, which is the bedrock roof in
  the Nether, so the ghost starts on the roof (an explicit origin works). Needs a floor search from the player's height.
- **Natural drops refuse placement:** sticks/saplings from leaf decay lying in a box refuse it ("pick them up first");
  `NaturalDrops` should treat leaf-decay drops as natural.
- The plot outline is hard to see under trees; the notes field and long toasts need polish.
- No-cheats play is untested (the commands have no permission check; the dev world has cheats on).

### Phase 2: Library
- Every design keeps its **parametric source** (`.mjs`) next to its `.nbt`, sidecar and previews. The
  source is the asset; the `.nbt` is build output. (AgentCraft keeps the source only in a scratch dir, and
  remix falls back to a weaker "sidecar only" mode when it is gone.)
- A library screen: browse with previews, tags, rename, delete, favourite.
- **Variants without Claude:** re-run the source at another size, floor count or material palette
  (oak → spruce → deepslate). Claude is for new designs; code is for variations.
- Remix (Claude edits an existing design), and import/export of `.nbt` (vanilla structure files).
- **Gate:** generate one design, make 3 palette and size variants without a Claude call, export one and
  import it into another world.

**Status: PASSED 2026-10-05** (gate-verifier PASS; its two caveats closed afterwards, see `artifacts/gate2/REPORT.md`, local).
A Claude town house came out parametric (width, depth, balcony) and palette-driven. 3 variants (birch, fortress, width 11 +
no balcony) took about 0.5 s each with no Claude call, and rebuilt byte-identical from their recorded inputs. The export
loads with vanilla `/place template`. A world-1 structure-block save imported in world 2 matches block for block. Metadata
survives a restart. Remove is exact over the snapshot box + 7 blocks after two fixes found in the run (leaf hold/release
without neighbour updates; the snapshot covers the ground row under the foundation).

Carried forward:
- ~~Natural drops refuse placement~~ **fixed 2026-10-05**: natural drops are cleared with a note; a player's item still refuses.
  (was: leaf litter, sticks and saplings from decay lying in a box refuse it
  ("pick them up first"). `NaturalDrops` must treat them as natural; it hit the gate run twice.
- ~~Stale bundled sidecar~~ **fixed 2026-10-05**: the extraction is keyed by a fingerprint of the bundle; node_modules are kept
  unless package-lock.json changes; a helper we started from the replaced bundle is restarted.
- **Exports carry no source:** an imported export is a plain structure (no variants). Export could include the `.mjs`
  and import could recognise an Architect export.
- **Nether ground:** the ghost's "ground" starts on the bedrock roof (see phase 1 notes).

### Phase 3: Survival (per-world toggle)
- **Construction site:** placing a design in survival puts down a persistent ghost plus a site block. The
  ghost is server-side, synced to clients and kept across relogs.
- **Bill of materials** from the template palette (`block.asItem()`, with special cases: doors, beds
  and tall plants count once for both halves, double slabs count 2, candle counts, wall torches and wall
  signs map to their item, and some blocks have no item).
- **Feeding:** the site block accepts **hopper input** and right-click deposits, so existing storage
  systems can feed it. It builds as materials arrive, a few blocks per tick: bottom-up, supports
  before attachables (torches, doors, ladders, signs).
- **Raw materials:** a small, curated equivalence table (1 log = 4 planks, cobblestone ↔ stone, ...),
  not a recipe-graph solver.
- **Terrain (revised 2026-10-05, see CONTRACT "Decision: terrain in survival"):** clearing a site gives no drops, and
  Remove still restores the terrain snapshot exactly. The player never receives the terrain, so restoring it can't
  duplicate anything.
- **Remove = deconstruct and refund:** blocks the site placed that are still there are refunded; the player's own blocks
  in the box drop as items; mined site blocks are not refunded (no dupes); then the terrain snapshot is restored.
- Optional: "design with what I have": pass a chest's contents to the designer as a palette constraint,
  or palette-swap a library design to match.
- **Gate:** in a survival dev world, place a site, feed it from a hopper chain, watch it finish, then
  deconstruct it and check that the refund matches the materials put in.

## Open questions
- Track AgentCraft fixes to the copied placement code, or treat the copy as independent from now on?
- Cost: measure tokens and time per design in phase 1, and show an estimate in the form.
