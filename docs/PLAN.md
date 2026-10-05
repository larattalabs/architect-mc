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
| 2026-10-05 | **Publishing the API artifact:** GitHub Packages from CI on release tags (`v*`), as `dev.larattalabs:architect_mc`. It's free for public packages. GitHub's Maven registry needs a token even to read public packages: Steward's CI reads it with GITHUB_TOKEN once the package grants steward-mc access, and outside builders need a PAT with `read:packages`. Modrinth Maven (anonymous reads) is the option if Architect ships there. |
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

### Phase 3 status
**PASSED 2026-10-05** (gate-verifier PASS, no blocking caveats; `artifacts/gate3/REPORT.md`, local). In a fresh survival world
a cabin site (507 cells, a 506-item bill of materials) was fed by hoppers from chests holding exactly that bill, partly as logs.
It built to a state identical to an instant placement at the same spot (same hash, block entities included). Mining 3 blocks
and deconstructing refunded exactly 506 - 3, and the terrain hash returned to the original. Creative stays instant; hardcore
can't change the toggle or finish without cheats. Tests: mod 162, kit 60, sidecar 432. The verifier found no dupe path in
the code.

Carried forward:
- **Terrain drops:** the current decision is no drops plus exact Remove. Noah hasn't confirmed; it's cheap to flip or to make a per-world option.
- ~~Singular item names~~ fixed: the HUD says "needs 112 × spruce log". Equivalents still cover whole-number yields only (no planks to stairs/panes).
- The creative-only list lives in two places (survival_items.json, kit check.mjs), synced by hand.
- Hardcore was fed through a dev hook in the gate; a real-hopper hardcore run is still to do.

## After phase 3: asks from Steward (accepted 2026-10-05)

Steward (`~/Developer/LarattaLabs/steward-mc`, a sibling mod that founds whole settlements and depends on Architect) asked
for A1-A9 (`steward-mc/docs/ARCHITECT-ASKS.md`). All are accepted. Each must also be useful to Architect players on its
own. A9 is phase 3 itself. Order (Noah can reorder):

| Phase | Asks | What it is for Architect players | Notes |
|---|---|---|---|
| 4a | **A8** public API + protocol version, with Round 2 **R2**, **R5**, **R7** (registry/events), **R11** | Other mods and scripts can use the library, jobs, ghost and sites | First because it unblocks Steward. Java API package `dev.larattalabs.architect.api` (a Fabric entrypoint, semver'd); `protocol` negotiated in `hello`. **Full job API** (R2): `job.run` with streamed progress, cancel, resume after restart, a hard budget stop in the sidecar (SDK `maxBudgetUsd`), cost with cache-read tokens, and **mod-provided tools** (the agent calls a tool, the sidecar forwards it to the client over ws, the client answers). **Open metadata** (R5): an `ext` namespace on entries and blueprints, named connector **ports**, and an **owner** tag on sites; Architect's UI asks before removing an owned site. **Site registry and events** (R7): placed/removed/failed, with the blocked reason. DevBridge/devcli documented for reuse on other ports (R11). |
| 4b | **A1** style bible + **A2** parallel/hierarchical jobs, with **R3**, **R4**, **R9**, **R10** | "Design a matching set": one style, N buildings in parallel | Bible = JSON + prose in `<gameDir>/architect/bibles/<id>.json`, referenced from entries. Job groups: concurrency N, a model per job, cost per job and in aggregate, a group-wide usage-limit hold/resume (R9). **Named parts** with stable ids in the kit (`bp.part('wing', ...)`) plus a per-bible **component library** (window styles, lantern posts, trims) generated once and imported by every design in the set (R3). **Open types** (R4): a design may declare its checker profile from a menu of rules instead of a preset type. **Collections** (R10): by bible or set, in the Library. |
| 4c | **A3** massing pass | A cheap coarse ghost to approve before paying for detail | Massing = a kit design with volumes (and part ids) only; the detail job takes it as input. |
| 4d | **A7** batch placement over ticks + **site groups** (R1 minimum) + **R6** + R7's persistent queue | Placing a set at once; big builds without a lag spike | Generalises phase 3's builder. A **site group** (parent id; one undo group over separate lots); a **persistent placement queue** that waits for chunks and survives relogs; "wait until clear" instead of an occupancy refusal; a group **crate/stockpile** shared by a group's survival sites and queryable by API (R6). Also, for Steward's staged builds and megastructures (steward-mc A5B-SPEC §6a): a **per-tick time budget** (not only a block count), **per-stage state** (ordered stages, each its own change-set group; approve, skip, reorder, undo), and shared cell lists per module type. |
| 4e | **A5a** infrastructure (R1), **journal-backed** (decided 2026-10-05) | Roads and bridges between buildings; overlapping builds; builds larger than one template | Sites are backed by a **layered change-set journal** instead of nested sites: each placement is a change-set (cells it wrote, plus guard cells: the row under it and held leaves) with old state + BE data, stored per chunk section. Overlap is legal, and undo works in any order through ownership hand-down. Ported from AgentCraft's `WorldJournal` (contract J1; `_import/mod/src/main/java/dev/agentcraft/journal/`, ~2000 lines with tests; this port had dropped it): BOX policy for buildings (exact restore), CELL policy for roads and terrain ops (restore only where the world still holds what we wrote; the player's later blocks are kept and reported). "Still ours" ignores a short list of volatile properties (door open, powered, lit, leaf distance...). Crash safety as AgentCraft (draft before write, settle at world start). Existing box snapshots migrate to one BOX change-set each. Acceptance bar: today's Remove-exact round trips, plus overlap and any-order undo tests. Scale is checked with Steward's `mega_bench` fixture (a synthetic 1000x1000 region: journal cells/sec per tick budget, group and lot undo time, peak memory, journal size, sidecar evaluation and ws streaming, unloaded chunks), which also serves as a regression test. Site stays the user-facing handle; groups (4d) are change-set groups; region programs realise lazily per chunk section. |
| 5a | **A4** critique loop + **R8** eval harness | Better designs without reviewing each one; data for Opus vs Sonnet | A separate, cheaper reviewer turn on the renders (and the neighbours'), bounded rounds. An eval harness: a prompt set scored by the checker and the critique, cost and time per model tier. Candidates from Steward's tooling survey (`steward-mc/docs/BUILDER-TOOLING.md`, unverified, check before adopting): **textured renders** (block-model-renderer + mcmeta assets) instead of the flat-colour renderer; **layered ASCII slices** as a second critique view; new checker **warnings** for stair/door/trapdoor facing and required components (attachment support already exists); a `minecraft-structure-design` playbook for the design agent, kept as a kit doc copied into each scratch dir (never via `settingSources`, which would bypass the permission policy). Not adopted: minecraft-data (the kit's block table is generated from the 26.3 data generator plus a class dump, which is authoritative). Optional later: a HeadlessMC nightly as a slow CI gate beside the DevBridge gates. |
| 5b | **A6** delta apply | Edit a placed building ("add a wing") without rebuilding it | Diffs by named part (R3) so changes stay local; extends the snapshot for new cells before writing, so Remove stays exact. |
| 6 | **A5b** macro kit + macro checker | Terraforming builds: platforms, carved stairs, terraces, caverns | The Steward session writes the spec (`steward-mc/docs/A5B-SPEC.md`); Architect reviews it and turns it into a CONTRACT section when building it. |

Round 2 (R1-R11, `steward-mc/docs/ARCHITECT-ASKS.md`) is all accepted 2026-10-05 and folded in above.

**Phase 4b status: PASSED 2026-10-05, with caveats** (gate-verifier; `artifacts/gate4b/REPORT.md`, local). API 1.2.0 / mod 0.5.0.
Real Claude: bible "Mosswater Stilts" ($1.40) and a 3-building group ($6.68, 22.7 min); blind critics rate the bible set 9/10 and 8/10 "set"
vs a no-bible control at 5/10 and 4/10; the verifier, looking independently, agrees in direction. Sim: 38/38 API checks (restart mid-group, soft budget,
usage hold, re-skin, open type). Caveats:
- The ±50% estimate check FAILED on the real run and was repaired by calibrating the seeds on the same data. Its first out-of-sample
  test is the 4c gate.
- The wall-time rule was amended after the run, to per-wave.
- Real runs went over the WebSocket; the Java path is sim-only.
- The bible set is cluttered and less legible, which is 5a's (critique loop) job.

**Phase 4c status: PASSED 2026-10-05** (gate-verifier, every item reproduced; `artifacts/gate4c/REPORT.md`, local). API 1.3.0 / mod
0.6.0.
- **Real massing:** $0.21 / 0.9 min, 8 masses.
- **Redirect to an L-shape with a lookout tower:** $0.17 / 0.8 min, 12 masses.
- **Detail from it:** $3.40 / 13.8 min, conformance 0 errors and 0 issues. The verifier rebuilt it independently.
- **The estimate's first out-of-sample check:** +31% on both cost and time, within ±50%. That closes the 4b caveat, with one sample.
- **Sim:** 35/35 (massingFirst approval with a restart, owner enforcement); the composite preview shows all 5 styles and the cell cap.
- One sidecar bug (conformance issues failed detail rounds) was found and fixed before the gate.

**Phase 4a status: PASSED 2026-10-05** (gate-verifier; `artifacts/gate4a/REPORT.md`, local). Public API 1.1.0 / mod 0.4.1,
published to GitHub Packages (0.4.0, 0.4.1) and resolved by Steward's CI. API checks 44-47 per run with 0 failures
(stub/protocol 1 and real sidecar/protocol 2). Jobs: 32 sim checks plus 8 catch-up checks. Real Claude: structured jobs on
Steward's concept-card schema (validated with Ajv), an agent job with a tool, and a restart mid tool call; $0.007-0.019 each.
Protocol 1 is unchanged. Open: Java API -> real Claude end to end is covered by sim only (Steward's first in-game concept card
will exercise it); the paused-game test used a 10 s timeout.

Conflicts with Architect's current contracts, to resolve in those phases:
- **Sites never overlap**, and placement refuses an overlap. Settlements put buildings on top of a macro terrain site, so
  they need **nested sites**: a child inside a parent, with remove order child-first and the parent's snapshot unaffected.
- **Size cap** 96x64x96 per template and per snapshot. Macro sites need chunked snapshots and region-sized programs.
- **Survival is per world** and its change needs permission 2. Steward's per-settlement "Patron" (free builds) in a
  survival world would bypass that, so the API takes a placement mode only within what the world allows.
- **Occupancy refuses** when the player is in the box. Batch placement near the player needs a "wait until clear" mode,
  not a refusal.
- **One sidecar.** Two mods must not each install the SDK (~200 MB) and keep separate auth. Steward's Claude calls go
  through Architect's sidecar via A8.

## Open questions
- Track AgentCraft fixes to the copied placement code, or treat the copy as independent from now on?
- Cost: measure tokens and time per design in phase 1, and show an estimate in the form.
