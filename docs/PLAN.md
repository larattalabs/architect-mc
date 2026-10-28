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

Steward (`~/Developer/LarattaLabs/Minecraft/steward-mc`, a sibling mod that founds whole settlements and depends on Architect) asked
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

**Phase 6b status: PASSED 2026-10-10** (release gate-verifier PASS WITH CAVEATS on 8f8d816: megaA Architect CPU max
35.9 ms in its run; 37.1/42.3/51.5 ms in the builder's runs under load, the 51.5 accepted with a caveat; S1 evidence sha recomputed
and matching. S1 approved by Noah in the coordinator chat; the gallery page recorded no document, so the approval is recorded
in artifacts/scenarios/6b/approvals.json). Built on branch `phase/6b`, API 1.9.0 / mod 0.12.0; `artifacts/gate6b/REPORT.md`
and `artifacts/scenarios/6b/`, local). The checker (M1-M14), previews and site plan, IR format 2, Survey.volume (268M-cell
limit), template-first `Regions.design` (picks 6 of 6), Steward's crater and rift gates on the claude login, the command path
and nudges, versioning (a)-(c), the region-lot entrance style and `PlaceRequest.pathStyle`, and S1 (floating islands) green on
every run bar (final run 20261010-055851, evidence 1bf0b8e36a1f); S1 waits for Noah's gallery approval. S2-S6 fixtures pinned. The
engine chain's MSPT failures were the shared machine's load (v0.11.2 fails the same bars); the MSPT bars now judge Architect's own
per-tick CPU time, and the group undo's planner no longer degrades on packed-position hashes (fastutil maps).

**Phase 6a status: PASSED 2026-10-09** (gate-verifier PASS WITH CAVEATS on 43f9304; its six findings were then fixed on
phase/6a (per-stage drift, freeze before lot/road writes, maxWait opt-in, always-on generated-chunk log, RG5 and E-normal `live`
tightened, throughput warm-up) and re-verified: crash, E-flat, inv3, staged, megaA, 4d, 5b, sim suites, apitest jars. Open:
the nudge action API (6b), the unexplained 161 generated chunks in one early run (now logged), a structure-template memory
leak on repeated 5b sizecap runs (also on 0.10.x). Original record: built (2026-10-09; branch `phase/6a`, API 1.8.0 / mod 0.11.0;
`artifacts/gate6a/REPORT.md`, local). The macro kit engine, regions (plan, prepare, realise, remove) and mega_bench at full
size: realise 9.56M cells at about 55-59k cells/s, MSPT max under 37 ms, 0 chunks generated, exact undo (E-flat 0, E-normal all
classified). The 4e timeouts were lost shared chunk tickets and its spikes journal reads on the server thread, both fixed.

**Phase 4b status: PASSED 2026-10-05, with caveats** (gate-verifier; `artifacts/gate4b/REPORT.md`, local). API 1.2.0 / mod 0.5.0.
Real Claude: bible "Mosswater Stilts" ($1.40) and a 3-building group ($6.68, 22.7 min); blind critics rate the bible set 9/10 and 8/10 "set"
vs a no-bible control at 5/10 and 4/10; the verifier, looking independently, agrees in direction. Sim: 38/38 API checks (restart mid-group, soft budget,
usage hold, re-skin, open type). Caveats:
- The ±50% estimate check FAILED on the real run and was repaired by calibrating the seeds on the same data. Its first out-of-sample
  test is the 4c gate.
- The wall-time rule was amended after the run, to per-wave.
- Real runs went over the WebSocket; the Java path is sim-only.
- The bible set is cluttered and less legible, which is 5a's (critique loop) job.

**Phase 5b status: SHIPPED 2026-10-08** (gate-verifier: delta apply passes. Polish failed G1/G2 and G4 (the critic accepted 0
steps; estimate within 50% on 2/4), so per the contract polish stays behind a dev flag (`-Darchitect.dev.polish=true` for the
Library button; API callers can still request it). Next lever: the critic itself, not the prompts. Original record: BUILT (2026-10-08; branch `phase/5b`, API 1.7.0 / mod 0.10.0;
`artifacts/gate5b/REPORT.md`, local).** Delta apply: every $0 gate item passes (in-game exactness: chains E1 273/273, edits,
layers 6/6 orders, crash D1-D8 + save variants + K5-K7, history, ghost; survival items in = out; the village delta batch at
MSPT 11 ms; the size cap 589k cells with no tick over 50 ms; F1/F2; the 4d, 4e, sim and 1.6.0/1.5.0-jar regressions).
Polish: built and frozen, but the eval's smoke tier stopped on its stop rule (4 of 4 briefs accepted no step: 5a's critic
does not mark a targeted issue resolved even when the fix is visible), so G1/G2 are not shown; spend $9.17 of the $80
cap. Polish's label (experimental / dev flag) is Noah's call.

**Phase 5a status: SHIPPED AS RE-SCOPED 2026-10-08** (Noah's decision: the loop's quality gates G1/G2 failed, so the loop ships
**experimental**, off by default and labelled so in the UI and README; the harness, report critiques, bible format 2, job.images,
API 1.6.0 and the migration tests ship as built, since G3/G4 and every regression passed. Improving the loop (a critic calibrated
so 7 is reachable, revisions aimed at the top issue, in-place fixes via 5b delta apply) is later work, re-gated on the same eval).
Original gate record follows: BUILT, the builder's run did NOT pass it (2026-10-08; branch `phase/5a`, API 1.6.0 /
mod 0.9.0; `artifacts/gate5a/REPORT.md`, local; `eval/results/{smoke,full,opus-subset}/summary.json`). The critique loop, the
critic (Sonnet, image blocks under the claude login), the eval harness (`tools/eval.mjs`), bible format 2 with restraint and
hygiene, report critiques, `job.images` and the migration unit tests are built and tested (sidecar 536, kit 126, mod 339; sim API
suites, the unchanged 1.5.0 jar and the 4e migration step re-run clean). Real gate, $93 API-equivalent of the $150 cap:
- **G1 not shown:** 18 Sonnet briefs, all revised; the blind Opus judge preferred the final 7 times, round 0 6 times, 5 ties (p 0.50).
- **G2 failed:** the critic's own mean rose only 5.48 -> 5.76 (bar +1.0); it scores 5-6 and never ships at 7.
- **G3 and G4 passed:** no checker errors or new warnings; loop spend 52% of round 0, +3.2 min, estimates within +-50% for 16/18.
- **Clutter:** the format-2 Mosswater set is far less noisy (detailNoise 0.27 vs 0.47) and wins on legibility 2 of 3, but the
  form-lens critic rated it "set" 6/10 (bar 7).
- Next decision (not tuned against the eval set): what to change in the loop (e.g. a critic calibrated so 7 is reachable, revisions
  that target the critic's top issue only, or a different judge), then re-run the full tier and compare.

**Phase 4e status: PASSED 2026-10-06** (gate-verifier, PASS WITH CAVEATS; reproduced every gate item in game on fresh terrain,
`artifacts/gate4e-verify/`, local; the 4d L5 mushroom loss confirmed pre-existing on the same world with the 0.7.0 jar).
Caveats carried forward: no migration unit tests (only the in-game step), add them in 5a; the 4 ms throughput margin is thin
(15.1k vs the 15k budget in the verifier's run); invariant iii is narrowed where a player edits a cell with a CELL entry over a
BOX entry (end state then depends on removal order, disclosed); the 1000x1000 run (recorded, not gated) had NOT_LOADED timeouts
and 237 ms ticks while generating terrain, to chase in phase 6. Built on branch `phase/4e`; API 1.5.0 / mod 0.8.0; the builder's run in
`artifacts/gate4e/REPORT.md`, local; deviations and measured numbers in CONTRACT "Phase 4e as built"). Sites are journal-backed
(AgentCraft `ab08a02`'s rules): overlap with LAYER, removal in any order, roads and cell sites, 0.7.0 worlds migrate.

**Phase 4d status: PASSED 2026-10-05** (gate-verifier reproduced every item on fresh terrain, `artifacts/gate4d-verify/`, local: 12/12
equal, MSPT max 33.9 ms at 4 ms (job start up to 23.6 ms, unsliced), survival max 30.2 ms, 0 ticks over 50 ms; phase 3 gate
re-run clean after the Remove change. Caveats carried to 4e: the toggle step now uses non-adjacent lots, so adjacency leaks are
only covered by equality/undo; strengthen it to adjacent lots allowing persistent-leaf diffs only. Job start and construction
conversion are unsliced; slice them if designs near the size cap break 50 ms.) Built on branch `phase/4d`; API 1.4.0 / mod 0.7.0;
builder's run in `artifacts/gate4d/REPORT.md`, local). Every gate item and gate addition passed in the builder's run: 12-lot
village via the queue identical to atomic (12/12 regions + the whole village), MSPT max 16.8 ms / mean 7.8 ms at 4 ms,
relog mid-item resumed identical, group undo exact in reverse order, stages, survival shared crate (3 sites from one hopper
chain, identical, stock matches; MSPT max 24.6 ms), fitToLot on 4 sides, 0-gap and OVERLAP, Patron, toggle, cancel mid-item,
appended group. Throughput: 12.1k / 20.5k / 33.9k cells/s at 1 / 4 / 10 ms (12-lot wall 2.2 / 1.3 / 0.8 s). The gate found
and fixed inexact Remove around worldgen trees (the leaf ring, also in the atomic path). Deviations: CONTRACT "Phase 4d as built".

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

## 6c slice 0b: the C7 benchmark and its proposals (2026-10-11)

Run: `tools/bench6c0b.mjs` on the 0b build (0a merged), Noah's claude login only, hard cap $35. **Spent $18.69.** Evidence
(local): `artifacts/gate6c0b/bench-U.json`, `bench-R.json`, `bench-C13.json`, `spend.json`, `bench.log`. One run per arm, each
with its own new bible, massingFirst with auto-approve, report critique. The bench drove the helper over the protocol without
a game (no lot placement; the C13 smoke had no site).

| | U (unique: 3 M) | R (repeat-heavy: 2 M x3 + 2 S) |
|---|---|---|
| total (bible + group) | **$9.14** (1.08 + 8.06) | **$8.28** (1.04 + 7.25) |
| per placement | $3.05 (3) | **$1.04** (8) |
| first detailed item, from the bible's start | 14.7 min | **7.5 min** |
| wall | 28.2 min | 18.8 min |
| BIBLE | $1.08, 12% | $1.04, 13% |
| MASSING | $0.51, 6% (3) | $0.63, 8% (4) |
| DETAIL | **$7.37, 81%** (3) | **$6.51, 79%** (4: 2 M $3.56 / $2.41, 2 S $0.65 / $0.64) |
| REPAIR | $0 (0 rounds) | $0 (0 rounds) |
| CRITIQUE | $0.18, 2% | $0.10, 1% (S items skip it) |
| COPY | n/a | $0, 4 copies (built in seconds) |
| fallbacks | 0 | 0 |

C13 smoke (versionOf on R's first archetype, "weathered, add a lean-to"): done, **$1.27, 5.0 min**, head + 1.

Against Steward's targets: under $5 for a starter settlement is **not shown** (R $8.28). The first usable result within 15 min
is shown (R 7.5 min, U 14.7 min).

**Proposals (for Noah and Steward; nothing changes automatically):**
1. **The next cut is DETAIL** (81% of U, 79% of R; BIBLE is 12-13%, under the 25% rule; REPAIR is 0). That calls for bounded
   effort for M buildings (a STANDARD-lite pass) or model tiering of the detail pass. An M original costs $2.2-3.6 here.
2. **Copies and SMALL work.** R's 8 placements cost about the same as U's 3 (-9% total, 3x cheaper per placement). Reaching
   $5 needs the M originals at about $1.5 each, or one M design per starter with the others as copies (copyCap 3 already
   used). Suggested Steward default: copies on (cap 3), S items as SMALL.
3. **Re-seed:** SMALL $0.6-1.5 -> **$0.5-1.0, 3-6 min** (measured $0.64-0.65; the 2 rounds / 40 turns / $1.50 caps were
   never hit). CHANGE $0.4-1.2 -> **$0.8-1.6, 4-8 min** (measured $1.27, 5.0 min). COPY: $0, seconds (as seeded).
4. **C8 caps: keep them.** Neither S item came near a cap (no repair round, about $0.65 of the $1.50). Noah to judge whether the
   S buildings look cheap; their previews are in `artifacts/gate6c0b/bench/library/`.
5. Minor follow-up: R's breakdown COPY line counted 4 copies but 0 ms (the copies built between two refreshes). It is time
   only, so no cost is affected; fix it in the next slice that touches breakdown.ts.

## 6c slice V: queued for the next slice (coordinator, 2026-10-11)

From V's gate (CONTRACT "Phase 6c slice V as built"):
1. **Light the lot aprons and batters.** On natural ground the pads' aprons and batters are reached region-written floors, and
   the checker's M5 counts them dark (11.8% on S7's provisional fixture). V's bar 8 is ruled over the walk cells plus the
   door-to-street paths; the full M5 is recorded as data until this lands.
2. **4e street lanterns on non-ground path blocks.** The road's lantern posts stand only on blocks the road code calls ground, so a
   bible whose `path` is packed mud, stone bricks or planks gets a dark street (measured: M5 2.21% with packed mud).
3. **Ice reads as dry ground in the plan survey.** A plan can look clean and then fail a road over a frozen river or sea
   (S7's rejected 2026101102 site realised PARTIAL). The survey should treat ice as water, or the plan should refuse.
4. **Gravity blocks over gaps.** With the default gravel `path`, a levelled lane or verge over a gap can leave an unsupported
   gravity block (an M3 warning on one candidate plan).

## v0.16.0 release tier (2026-10-11)

Run `architect-mc-rel016-out/20261011-164227-release` (3 shards, load 12-98 throughout from parallel slice builds): 28/31
pass. apijars (1.11.0 jar, SITE_PROGRESS gap) and 6b-commands (24 growth cells at load 32-57) passed on re-run. **4d-all**
failed on one bar only: Architect's own tick max <= 50 ms (53.3, 59.7, 50.1 ms; one tick over each time; 61 other checks ok).
An interleaved A/B (`architect-mc-ab-out`, ab.log) put v0.15.0 at 56.6 / 45.7 ms and v0.16.0 at 52.7 / 54.5 ms under similar
load: **load, not a v0.16.0 regression.** Coordinator verdict: v0.16.0's release tier passes.

**Queued (tools, next slice that touches gates):** 4d-all judges a single-tick max, which sits on the bar under load for both
versions. Record own-CPU p99 and `traceCpu` phases in 4d (as megaA does), judge p99 <= 25 ms with the max recorded, and keep
the 50 ms max only under `--quiet-wait`.

## 6c slice MP: coordinator rulings (2026-10-12)

- **The `block` mask term is accepted in MP as kit, schema and Java only.** A realise has no block source (plan surveys hold
  heights, frozen volumes hold voxel classes), so a plan naming `block` is refused MASK_NEEDS_VOLUME. **Making it real goes to
  slice B** (brushes need block masks in the world): a frozen volume that records block ids (ARVX v2 or a block palette).
- Accepted deviations: the non-Bayer ordered 4x4 dither (Bayer fails item 2 with a straight 64-cell edge); bible role patterns
  in a separate `patterns` member (roles stay plain block ids).
- **New candidate flake: 6b-volume** (20 cells AIR to LAVA between two samples: lava still flowing after the 90 s settle at
  load 54-64). Re-check at the next release tier in a quiet window, against main, before calling it a flake.

## Keep open: zones and the long-term direction (Steward, from Noah, 2026-10-12)

Not asks yet (Steward docs/PLAN.md "Zones", "Long-term direction"). Designs frozen now must not close these off.
- **Zones (after Steward's phase 4):** e.g. a settlement on a desert/jungle edge, a wall between the sides, each side
  specialising. Likely needs: biomes per column in the survey; districts laid along a biome edge, river or ridge (D's
  survey-candidate districts are the start); walls with gates along a zone boundary (7a typed connectors, bible-styled); several
  related bibles in one settlement.
- **Long term (not planned):** factions as owners; sites changing owner on conquest; claims that shrink, are contested and
  change hands; damage and repair as ordinary operations.

**Audit (coordinator, 2026-10-12):** owners are free strings on records (Site, groups, regions), never part of an id, so a
later `transferOwner` is additive. Owner-scoped state to move on a transfer: opKeys, tombstones, protected areas (C17) and Y1's
stockpile and ledger. Y1 keys its stockpile by its own id with the owner as an attribute, so a transfer or merge re-keys it
without a format change. **Rule for every slice:** no id derived from an owner string, no "owner never changes" assumption in
persisted formats. Candidate later asks: `Survey.biome` per column (T1's fields could carry it), boundary-following districts
(D), zone walls (7a).

## Queued from Y1 (coordinator, 2026-10-12)

- **Construction sites keep their chunks loaded forever:** the builder's per-tick `getBlockState` renews a chunk ticket. Y1
  changed it only for stockpile targets (its unloaded-frontier exception needs it); legacy per-build crate sites are unchanged.
  Decide and fix for all construction in a later slice (server load, LOADED_ONLY semantics).
- Y1 verifier follow-ups: a credit skipped when both dimensions are unloaded; a single road's refund credited before its
  restore (retry-safe by key); a road credited before removal missing from the group's `RemoveResult.refund`. (C29 closed the
  second: a single road removal credits when its restore is written.)

## Queued (coordinator, 2026-10-12)

- `tools/p2-library-check.mjs` is stale on main (sets a `floors` param the bundled cabin no longer has); fix or retire it.
  **DONE (chore/housekeeping-1): retired.** Removed it and `tools/run-p2-client.sh` (its only launcher). A manual phase-2 screenshot walk
  in no chain or tier; the `ui` step covers the Library's import/export, and the `dev.library.*` hooks stay for apitest.
- T1 follow-up: in game, 7 of 26 written falling-water cells were not the planned block after the build (verifier note);
  T1 changes no tile-write code. Investigate with H (fluids).
- The mod's no-check plan wait went from 120 s to 300 s for every program (T1), not only pass programs.

## C30 (Steward, 2026-10-12): patch v0.22.1

- No stage race was found. Steward's stalls were items waiting on a chicken and on the player, unlogged; 0.22.1 logs waits (CONTRACT "C30 as built").
- For Steward: it queues items its own fit refused as temporarily blocked (OCCUPIED, PLAYER_IN_BOX), and its e2e gives up at the same 600 s as the wait
  limit. Clear animals before every build and keep the player off the lots, or surface `ITEM_WAITING` in chat as it does material waits.

## C31 (T2's builder, 2026-10-13): patch v0.24.1

- Felling (6a's whole-trunk rule) now stops at the region owner's C17 areas, other owners' cells, the claim and non-LOG blocks.
  The kept part is recorded as `M3:tree_kept`. Undo was already exact before the fix (CONTRACT "C31 as built", under C17).
- Accepted limits (coordinator, 2026-10-13): a player-placed log can't be told from a grown one; an in-area leaf that hung only
  on felled logs may decay; a stroke fells into the claim's +8 margin.
- **Candidate item: player-placed tracking.** This covers the player-log limit: block-change tracking so that felling, and any
  natural-only write, can spare cells a player placed. It picks up the dropped slice PT ("Phase 6c slice PT: player-changed
  cells", S-PT-1: dropped from 6c, to 6d with replanning on land change).

## C32 (Steward, 2026-10-13): slice PT drafted

- Player-placed tracking, refined by Noah to **builds**: CONTRACT "Phase 6c slice PT: player-placed tracking (C32)" (DRAFT for
  Steward review). It supersedes the dropped PT draft; S-PT-1 is withdrawn for this case. Adopting a build as a site is a later
  slice, PT2 (outlined there). API: the next free minor at merge.

## Queued from T2 (gate-verifier, 2026-10-13)

- **Melt water into keep-out (a defect).** Default route lamps (a bible's lanterns, light 15) melt natural snow and ice beside
  the routes, and the melt water can run into a keep-out area. The survey records no snow, so the plan can't see it. route_demo
  uses soul lanterns (light 10, under vanilla's melt at 11) as a workaround; the scenario's E-normal class `melt` (unwritten
  cells only) is accounting, not a fix. Fix it in the survey (record snow and ice) or in `lightCover` (keep lamps whose light
  reaches over 11 away from snow near keep-out).
- **4e output-shape change: flag for S2, D and 6d.** A routed edge lays a 4e ground road only where a walk lies exactly on the
  surveyed ground. Most walk runs on real terrain are `_routeRun` columns (cut, fill, retaining), not 4e roads. A consumer that
  reads `ir.roads` for a region's paths sees only a fraction of them; read the graph edges' `segments` (or `meta.route`).
- **Realised M5 over the routes was 5.25%** on S3 (virtual 0.41%, flat 0.24%; 0.61% on the fresh-world re-run `20261013-064639-slice`): soul lanterns, live snow and plants.
  Recorded, not judged. Revisit with the lamp and melt fix.

## Queued from PT (coordinator, 2026-10-13)

- **Stale base worlds in reused run dirs (gate infra).** A reused run dir's `G6B Seed Base` level.dat (older creation path:
  data packs recorded, allowCommands 0) generated magma and bubble columns where the golden has water, moving S1's pinned
  survey sha. Fresh run dirs pass. Have gate-run detect and rebuild stale base worlds (or stamp base worlds with the creating
  tool version).
  **DONE (chore/housekeeping-1):** base worlds carry `architect-base-stamp.json` (hash of the creation recipe: recipe version, Minecraft
  version, preset, seed, rules; `tools/lib/basestamp.mjs`). `ensureBase()` in `tools/lib/run6b.mjs` (used by every `base` step of the
  G6B drivers, `seedBase` and `fresh`) moves an unstamped or mismatched base to `saves-stale/` (never deletes) and rebuilds it. Bump
  `BASE_RECIPE_VERSION` when the creation path changes. Unit test: `kit/test/basestamp.test.mjs`. Not covered: the G6A/G6C0c/6cx drivers'
  own base steps (other worlds).
- PT verifier notes: `PredicatePathsTest` matches only the literal `level.setBlock(`; comment or lock the off-thread clear in
  `Placed.changed`.

## Queued from C35 (coordinator, 2026-10-14)

- PT2 gate item 13 (`old027`, a 0.27.0 reader refuses adopt journal files) reads `../architect-mc-PT2-v0270`, a tag checkout that
  no longer has a `mod/` tree. Make the driver build or fetch the 0.27.0 reader into `artifacts/` (like the apijars baselines)
  instead of depending on a sibling worktree.
  **DONE (chore/housekeeping-1):** `old027Source()` in `tools/gate6cpt2.mjs` `git archive`s the v0.27.0 tag (fetching it if absent) into
  `<main>/artifacts/gate6c-pt2/v0270-<sha12>` (built via a temp dir and a rename, reused once `HEAD.txt` exists) and builds the reader with the
  run dir's `.gradle-home`; `PT2_V0270` still overrides.
- C35 limit: an adopted build's change never uses a bible for new cells, even if asked (new cells come from the captured
  blocks by role: wall, frame, roof). Forwarding a bible needs `Adopt.source()` to change; revisit if players ask.

## Queued from D1 (builder, 2026-10-13)

- **The beside join needs a standing street end in the seam.** A village whose streets end deeper than 16 columns inside its
  claim can't be joined (`NO_JOIN`). Steward's "add a district to a village" works when the village leaves a street end near
  its edge; a later slice could extend a standing street (a write into the standing region's footprint, so its undo story is
  needed first).
- **A districts zone in a plan/0 plan ignores its own `where` and size in v0** (placed around the zones and forms before it).
- **`near` is exact per phase, not jointly.** A district near another is placed after it.

## Queued (coordinator, 2026-10-14)

- **Catalogue `sinceApi` placeholders.** 75 plan-catalogue entries still say `sinceApi: "P0"` and the D1/D2 flips did not
  record a real version. `state` is what Steward compares across releases, so this isn't blocking, but stamp real API
  versions (P0 = 1.23.0; D1 = 1.27.0; D2 = 1.29.0; PT = 1.24.0) and make the merge-time renumber stamp new ones.
  **DONE (chore/housekeeping-1):** all 75 stamped from git history (unchanged since P0 = 1.23.0; reserved-to-supported flips D1 =
  1.27.0, D2 = 1.29.0, K1 = 1.32.0; C37's schemaVersion-2 entries 1.30.0; PT's two stay 1.24.0), schema pattern is semver only,
  `tools/catalogue-since-check.mjs` (run by `kit/test/catalogue-since.test.mjs`) fails on a non-semver or a future `sinceApi`,
  golden regenerated, `catalogueVersion` stays 5 (no entry's state or schemaVersion changed; metadata only).

## Open questions
- Track AgentCraft fixes to the copied placement code, or treat the copy as independent from now on?
- Cost: measure tokens and time per design in phase 1, and show an estimate in the form.

### Steward live-run feedback (2026-10-09), queued for 6c unless noted

- `LotFit.minLotSize` (x, z needed including setback), and `fitToLot` returns a recommended rect, so planners stop hardcoding a margin.
- Group events emit only on real transitions, with a `seq`/`lastAction` field (today `awaiting_approval` and `paused_budget` are re-sent while an action is in flight).
- `Group.cost.byKind` (bible, massing, detail, critique); today bible cost is excluded and critique sits inside item cost.
- `Survey.sample` gains `groundHeight` (the floor under trees), and `Survey.volume` the same.
- Region and plain-lot entrance style: in 6b (CONTRACT "6b addition: region lot entrances").
- Cost stays the main product constraint: a 4-design group with bible and report critiques took about 25-30 min and $12.3 notional.
- Durable finished batches: keep finished `BatchView`s across restarts, and catch up BATCH_DONE once per batch (like JOB_DONE), so a consumer that missed it before a stop can resume (Steward review, 2026-10-09).
- Steward phase-1 gate (2026-10-09, 8 buildings): measured detail $2.50-4.60 with a report critique (landmark $3.72), massing ~$0.19, bible $1.16. Re-seed `Designs.estimate` from these (above the 4b seeds of $0.8-2.5).
- Roads: a RoadRequest with one bad span (TOO_STEEP, "no ground within 8") is refused whole. Place the valid part, or report the failing span's waypoint indices so the caller can trim it.
- `DesignRequest.style` is capped at 40 chars in the sidecar's protocol and fails the whole group ("Too big"). Document the cap in the Java javadoc and refuse with a typed reason on the Java side before the round trip (also for other bounded fields).
- `extendGroup`: warn, or report the needed amount, when the new budget's 80% soft line is still below the spend, so the group re-pauses at once (Steward hit $30 -> $35 with $31 spent).

### Inputs for the 6c contract: our own world-shaping toolbox (Noah, 2026-10-09)

Decided: no WorldEdit or similar dependency. Its edits would bypass the journal (no exact undo, ownership, MSPT budget, crash
safety or survival BOM), it isn't agent-friendly or deterministic, it lags new MC versions, and its code is GPL. Build our own,
borrowing the concepts:
- **Terrain brushes as journal-backed region ops:** smooth, erode, melt, blend, raise/lower, overlay (topsoil over subsoil),
  fill/drain, recursive fill, cave carve.
- **Masks and patterns:** by block, height, slope or depth; weighted block mixes; gradients.
- **Schematic import/export** in the Sponge `.schem` format (WorldEdit's), so builds move in and out without WorldEdit at runtime.
- **Full block vocabulary:** colour and rare blocks (concrete, terracotta, glazed, glass, wool, amethyst, sculk, prismarine,
  Nether and End), steered by style-bible **rarity budgets** and palette-coherence checker rules.
- **Fluids:** water and lava features with containment checks (no flooding or fire spread past the intended volume); the
  journal restores fluids exactly.
- **Destruction:** carving natural terrain as now. Removing other players' or mods' blocks needs an explicit permission level
  and an ownership check, and is always undoable.
- **Survival:** unobtainable blocks stay creative-only; rare blocks cost real materials (Noah's survival rule applies).

### Process from 6c on (Noah, 2026-10-09)

- **Slices:** each phase is split into slices of a few hours, each with its own short contract (~300 lines), a focused gate and
  a minor release. Steward reviews each slice contract in the usual window.
- **Scope freeze:** new ideas during a slice go into the next slice unless they block the current one.
- **Risk-tiered gates** (docs/GATES.md; `node tools/gate-run.mjs change|slice|release`):
  - change: the unit suites plus the steps the change-impact map gives the changed paths (`--since <ref>`). Minutes.
  - slice: quick plus the affected steps. About 30 min.
  - release: everything, overnight and unattended, then the full independent gate-verifier.
  Duplicate heavy checks rotate at release, deterministically by release number (or ISO week), and the skips are printed: one
  crash suite (4e or 6a); megaA always (it carries E-normal) and E-flat always; the full megaB on engine-touching releases,
  otherwise full and `--fast` alternate; heap every other release; throughput as warm-up plus median of 3 only when
  realise/placement changed, otherwise one smoke run. Routine tiers use mega-lite; prepared worlds are restored by APFS clone,
  a client stays up between compatible steps, and runs shard across 2-3 clients (own ports and worktrees each).
  Per slice, the verifier reviews the diff and the runner's SUMMARY/evidence and re-runs only the risky steps (journal, undo,
  survival, or whatever the diff touches); full reproduction only at release. No Discord notify.
- **Later (after 6c):** a headless, server-only gate mode for the exactness and MSPT checks (faster, parallel, CI-able); the
  client stays for screenshots and the gallery.

### Steward round 3 (steward-mc docs/ARCHITECT-ASKS.md, Noah agreed) and where it lands

- **6c slice 0, "cost and API polish"** (sidecar/API only, slice-tier gate). It's the first slice of 6c, because cost is the
  main product constraint (Steward's phase 1 gate: $31 for 8 buildings). It takes:
  - **C1:** copies in a design group (`count`, or "variant of item X", made as free variants or re-skins, each its own item for placement, stages and undo);
  - **C2:** cheap small items (per-item or size-rule: no report critique, optional massing skip);
  - **C4:** stub sidecar support for consumers' $0 end-to-end gates (stub bibles, massing-first groups with approvals and redirects, well-formed fake massings);
  - **C5:** `Designs.estimate` re-seeded from the measured numbers;
  - **C6:** massing placement prediction (`fitToLot` for a massing: origin, rotation);
  - the already-queued items: minLotSize, group event seq, cost.byKind, groundHeight, durable batches and BATCH_DONE catch-up, partial roads, typed bounded-field refusals (the style cap), the extendGroup warning.
- **C3:** plain villages in **7a**. The settlement graph, lots, connectors, paths and props work for a flat village claim
  (a region with no terrain ops), not only for sculpted regions. 7a's contract is written that way; no separate phase.
- **Shared client UI kit** (copies in AgentCraft, Architect and Steward): a decision for Noah later. Possibly a small shared library.
- **Refinements (Steward, Noah agreed; steward-mc PLAN "Copies, adaptations and originals"):**
  - **C1 safeguards:** never copy landmarks or one-off buildings. At most 2-3 placements per design, then a new design (x6 becomes
    2 designs x 3). Each copy changes the palette, at least one exposed parameter where the design has one, and mirror or
    rotation. Every variant passes the full checker (it already does: `VariantRunner` runs the pristine-kit check). A copy that
    fails fit or the checker on its lot falls back to an original design, never forced. Copies carry `variantOf` and their
    source version from the start, so 6d needs no migration.
  - **C2 narrowed:** skip only the report critique on small items. Massings stay for everything.
  - **C5:** estimate by kind (original, adapted, copy), so a card can show e.g. "4 original, 3 designs adapted to 7 lots, 3 shared".
  - **7b, adapt first:** per lot, try `fitToSite` of an existing design first; an original design is the fallback (fit or checker
    fails, or a landmark). Steward sets the policy (copy caps, an "all original" card choice).
  - **6d, updates follow the source:** a new version of a source design is offered to its variants and site-adapted copies as one
    update, applied per lot, keeping each lot's adaptation.
  - **7c reuse across settlements:** promoted shapes are offered as a card choice, never applied automatically, and are
    re-checked, refitted and re-skinned to the new bible.

### Steward round 4 (C7-C12; steward-mc docs/ARCHITECT-ASKS.md "Round 4", from GPT-6.1 reviews, adopted by Noah) and the new order

All taken. 6c slice 0 is split as C11 asks, and a flat-village slice (C10) moves ahead of the terrain work:
1. **Slice 0a, consumer support:**
   - C4 stub sidecar for consumers' $0 e2e gates (Steward waits only on this);
   - C5 estimates by kind, re-seeded from measured numbers;
   - C6 massing placement prediction;
   - durable finished batches with BATCH_DONE catch-up;
   - **C9 caller operation ids**: an idempotency key on `bibles().request`, `designs().requestGroup` and `sites().queue` (same key returns the same job, group or batch), plus lookup by key;
   - **C7 cost and time breakdown per stage** on Group and in the job log: bible, massing, detail, repair rounds, critique, queueing, usage holds;
   - group event `seq`, `cost.byKind`, and `Bibles.cancel` returning a future.
2. **Slice 0b, reuse and bounded effort:**
   - C1 copies with the safeguards;
   - C2 no report critique on small items;
   - **C8 bounded effort for S-footprint buildings**: lower caps on repair rounds and tokens, and reusable kit components (racks, stalls, wells, sheds);
   - **C7's benchmark**: a unique-building settlement against a repeat-heavy one, to show which stage to cut. Steward's targets: a starter settlement under $5, the first usable result within 15 min. Greywater Hamlet was $13.76 and 70 min.
3. **Slice 0c, placement polish:**
   - minLotSize and a recommended rect;
   - partial roads, or the failing span reported;
   - groundHeight under trees;
   - typed refusals for bounded fields (the style cap);
   - the extendGroup re-pause warning.
4. **Slice V, flat village (C10):** on a flat claim: lots, a path from each door to the street, one shared space (a square or well) and a few props. Built so 7a's settlement graph and connectors generalise it later.
5. Then 6c's terrain slices (passes, toolbox, generators, fluids, schematics), then 7a.
- **C12:** VillageLayout retires only behind a joint 7a/6d gate: an existing Steward settlement migrates onto Architect lots and can still be updated (6d) and undone.
- Not now (Steward agrees): shared UI extraction, schematic interchange urgency, shape promotion. They wait for an observed need.

### Steward round 5 (C13-C17; steward-mc docs/ARCHITECT-ASKS.md "Round 5", Noah approved): what Steward's phase 3 needs

- **C13, design as the next version of an entry:** today only polish (dev flag) and revert install versions, and remix makes a
  new entry. Add `DesignRequest.versionOf(entryId[, siteId])`: a free-text change request, designed with the entry and (when
  given) the placed site's current state and the player's kept edits as context, installed as the entry's next version.
  Change requests then flow through checkDelta/applyDelta and `outdated`. **Slice 0b.**
- **C14, revert:** already supported. `Sites.revert(siteId, toVersion, actor)` (1.7.0) and applyDelta to an older
  `toVersion`; a version is pinned while a site stands at it (`EntryVersion.pinned`, never GC'd). **New in 0a:** caller pins
  (`Library.pinVersion/unpinVersion(entryId, version, owner)`), kept while any caller pin exists.
- **C15, a shared client UI library** (Noah 2026-10-09: GO, reversing an earlier "not yet". Repo larattalabs/lab-ui, MIT with both copyright lines; v0.1.0 = AgentCraft's stable generic UI; Architect migrates in a later slice) (world UI, nameplates, bubbles, plate declutter, screen kit, sprites) with AgentCraft and
  Steward. It reverses the earlier "not now". The repo and ownership decision is Noah's (a new public repo, e.g. larattalabs/*-ui).
  Coordinated with AgentCraft Main; Architect migrates after the library exists.
- **C16, streets in survival construction batches:** roads and paths as construction sites with a BOM (Noah's survival rule:
  connectors cost materials). **Slice 0c.**
- **C17, protected areas:** caller-marked write bounds that no placement, delta, road or terrain op of that owner touches
  (refused with a typed reason). "Natural" stays a block type; a player's dirt paths count as natural, so protection is by area.
  Automatic detection of player-changed cells (block-change tracking) comes later with the 6c terrain slices. **Slice 0c**
  (area marks), before V and the terrain work.
- **0a addition:** futures still pending at world stop fail with a distinct, typed reason (`WORLD_STOPPED`), not a generic error.
- **Gate tiers built** (branch tools/gate-tiers, merged after 6b to avoid gate-chains conflicts). Accepted for now: megaA's
  realise p99 bar is record-only, because the own-time bar has no percentile. **0a** adds own-time percentiles in
  `MsptTrace.stop()` and restores the p99 bar. On merge: add `6a-forest` and the 6b scenario steps to the chains, and update
  the apijars description.
- **C18 (Steward), the caller's own entities don't occupy (slice 0c):** occupancy checks ignore entities the request's owner
  marks as its own, through an entity tag `architect:owner=<owner>` matching the request's owner. That works for every API path
  (remove, delta, batch, revert) with no new request fields. An optional explicit UUID set on RemoveOptions/DeltaRequest/Batch
  can be added if a caller needs it.

## Queued from gate-speed (coordinator, 2026-10-17)

- **Done (housekeeping 2):** pt-nomod takes the launch file from its run worktree (GATE6B_RUN), building it there with `gradlew headlessLaunch` when missing. ~~pt-nomod reads the source checkout's `mod/build/headless-launch*.json`.~~ It fails whenever that checkout hasn't built
  headless; make it build or locate the launch file in its own run worktree.
- ~~A literal `${OUT }/gate7a-k1b/` directory committed in 1f946e2f~~: already removed (K1b's verifier fix); nothing tracked on main.
- **Done (housekeeping 2):** A/B at c2b094ea: only t1-ingame matched its client checks and moved (`host: server`); mp, sch and y2 use client-only hooks or shots, and w and y differ by host (GATES.md "Tried and kept on the client"). ~~More headless:~~ w-ingame (about 13 min on the client), t1-ingame and the sch/y/y2/mp-ingame steps use no client-only hooks.
  A/B them with `--host server` and move the ones that match.
- **Done (housekeeping 2):** plan-p0 split into plan-p0 + -valid + -det-1..3 + -asks (helpers in plan-p0-shared.mjs), the 500 claims into village-layout-1..4 (125 each); every driver lists the new files; kit suite 214/267 s -> 139/145 s (A/B/A/B, same box). ~~Split the slow kit test files.~~ plan-p0 (187 s) and one village test (138 s) set the kit suite's wall time.

## Queued from the T3 batch (integration, 2026-10-18)

- **Done (housekeeping 2, mod 0.36.1 placeholder):** the cause was TileCheck's dependents stage clearing every gravity block on any changed cell (a08669ff widened it from cleared cells); one whose support is solid before and after now stays (`gravityKept`), one over a free cell is still cleared and restored; probe `tile-gravity`, `TileGravityTest`.
  ~~Investigate: a sand cell resting on a tile-rewritten cell vanishes, with no falling entity.~~ T3b found it in game
  (crossings_demo flat): a sand cell of the band over the tunnel's lined roof was gone after the realise, and no falling-block
  entity was seen. T3b lines around it (73fc14bf: sand or gravel resting on any cell the tunnel rewrites is lined too), so T3's
  bars hold, but the cause is open. K1b likely met a relative on the rift site (desert sand under the landings; 15f77f67 put stone
  footings there), and T3a's frozen site saw worldgen sand drop 8-13 columns from any written cell under default rules. First
  suspect: the tile writer's own rule that what stood on a changed cell (snow, plants, sand, gravel, ...) is cleared with it as
  cells of the entry (d3f36c95, a08669ff), which would remove the sand by design rather than by gravity. Decide whether a
  gravity block on a rewritten support should be kept when the new support is solid, and add a probe: one sand cell on one
  rewritten cell, re-read after the realise, with the journal's entries for that column.
- **Done (housekeeping 2):** the ends moved apart diagonally too (1000 along, 40 across; the claim is at 1024 columns in x), so the corridor is ~1.6x the cap; t3b-natural asserts at least 1.25x and the same size on a second check. ~~Thin margin on T3b's cap fixture.~~ t3b-natural's "past the cap" case puts the corridor at 4,290,489 cells against the
  4,000,000-cell cap (7% over). A change to the corridor box (approach, dilation, the y span) could drop it under the cap and turn
  the expected `incomplete VOLUME` into a fit without any cap bug. Widen the ends (or assert the computed size is at least, say,
  1.5x the cap) the next time the driver is touched.
- **A street whose bridge fallback also fails still says `WATER (until T3)`** (compile.mjs's ROUTE_WATER answer). After T3 the
  `until` is stale: it should name H (S-T3-3) when the bridge fallback ran and still met water. No recorded ask hits it today
  (the before table lists none); fix with a fixture when T3's follow-ups are next touched.

## Queued (coordinator, 2026-10-18)

- **Done (housekeeping 2):** a history timeout counts only samples of the step's current definition (its chain entry and driver files, hashed at each sample's head through git); kit/test/gate-history.test.mjs. ~~History timeouts for young steps.~~ History put t3a-ingame's effective timeout at 10 min, so the T3 integration ran with
  `--no-history-timeouts`. Use the configured `timeoutMin` until a step has enough samples *from its current definition*
  (e.g. reset a step's history when its driver or chain entry changes), or raise the floor for in-game steps.

## Queued from housekeeping 2 (coordinator, 2026-10-18)

- **Done (housekeeping 3): not code, not re-pinned.** Pre-existing and state-dependent: the same head fails and passes (PT-verify vs PT-bisect2 at 95e3cd5c, 2026-10-13); at dfa07384 (main aac5f588 plus this branch, nothing on the survey path) a fresh client run dir passes (sha = golden, `artifacts/gate-runs-hk3/20261019-195353-change`), a fresh headless one fails (572271bd, `gate-runs-hk3-exp/20261019-195821-change`), and a client run in that same dir passed once its bases were rebuilt (`gate-runs-hk3-exp/20261019-200831-change`). The cause is a base world made by the headless server (PT's level.dat finding), which the base stamp didn't tell apart: its recipe now carries the host (`basestamp.mjs` `gateHost`), so a base made by the other host is quarantined and rebuilt. The 5904-5907 frozen count (item 6) varies per run on one host; it is recorded only. No bisect was needed. ~~**w-ingame's s1_floating_islands golden fails on both hosts**~~ (sha 572271bd vs 3e5bd5b7), and its survey differs by host
  (5906 vs 5907 frozen-water columns). Confirm on main whether this is pre-existing, then re-pin or fix.
- **Done (housekeeping 3): harness, both.** (1) NOT_ALLOWED: the client reused a `G6B Y Survival` base the headless server had made in the same run dir (no cheats for the integrated server); the base mark now records its host and the other host rebuilds it (a client run in a dir a headless run had used: `store` 103/0, `gate-runs-hk3-exp/20261019-200831-change`). (2) The feed order: headless opened the survival world by name with the host's creative launch spec, so the dedicated server's default game type was creative and AUTO placed the batch road INSTANT (BUILT at once, never in the feed order, never paid: `once` then threw on its missing `paidByTarget`). `tools/lib/server-host.mjs` now opens an existing world in its own level.dat game mode, as AutoWorld does, and `store`'s strict feed-order check holds headless too (an interim relaxation of it was reverted: it hid this cause). Headless at 66d97216+: y-ingame 103/0, with 4d-all 63/0, x-ingame 53/0 and pt2-survival 10/0 unchanged by the host fix (`gate-runs-hk3-exp/20261019-203344-change`). ~~**y-ingame:**~~ the client fails `store` with NOT_ALLOWED (instant placements need permission level 2); headless misses one
  target in the feed order. Investigate both before moving it to headless.

## Queued from the H batch integration (coordinator, 2026-10-19)

- **Done (housekeeping 3):** both re-cut for kit 0.35.0: only the IR's kitVersion moves. Verified: `kit/tools/region.mjs plan` over each golden's committed survey, params, seed and claim writes an ir.json byte-identical to the golden with only `kitVersion` bumped (and links_demo's one blob identical); every tile sha and the cell counts unchanged, 1 worker = 4 (links_demo 151,293 cells, 16 tiles, irSha 0088689a; links_demo_flat 38,383 cells, 6 tiles, irSha 81f39293). ~~**links_demo and links_demo_flat goldens are at kit 0.34.0.**~~ crossings_demo_flat was re-cut for 0.35.0 (only the IR's
  kitVersion moved). k1b-ingame compares links_demo_flat's IR sha, so re-cut it the same way (bump `kitVersion` in its `ir.json`,
  recompute `tileShas`, confirm tiles and cells unchanged) before the release tier.
- **Done (housekeeping 3):** the pattern was present in both (a 2- or 4-wide deck or bore running +z or -x stood one column off its walk, with no checker finding) and in the route's tunnel move's fast check. `latOn` moved to ropeGeom.mjs (bridgeGeom re-exports it) and is used by checkSpan, ropeCells, surfaceCover, tunnelGeom and the move's fast0. Fixtures `kit/test/fixtures/plan/even/ew01` (rope) and `ew02` (tunnel) run both ways on both axes, widths 2 (and 4 for tunnels): the deck's and floor's first and last rows equal the walk footprint's, M3/M4/M5/M6/M8/M10 clean, the player through the bore (`even-width-hk3.test.mjs`; both fail on main). Kit output changed for those inputs (no KIT_VERSION bump; the coordinator decides): v33's and v34's +z villager bridges moved onto the route's side (named exceptions in gate6ch-core's `UNCHANGED_EXCEPTIONS`, which t3a's `unchanged` now reads too; the stale r06/r07 left the list), and links_demo's nodes moved one column west so its decks stay on the same columns: its goldens' tiles, cells and blob are unchanged, the IR's graph, anchors and programSha moved (irSha 5c3f2341, flat 944083bf, equal to the in-game plans of the slice run; item 4's kitVersion-only re-cut was its own commit before this). ~~**The even-width lateral rule elsewhere.**~~ The H batch put a bridge deck's extra column on the route's side (bridgeGeom `latOn`:
  the route's `footprintOf` takes +x / +z). `ropeGeom.mjs` and `tunnelGeom.mjs` still use `lateral(width)` along `rightOf(dir)`, so an
  even-width rope bridge or bore running +z or -x stands one column off its walk too. Check them with a width-2 fixture.
- **Done (housekeeping 3):** retired. hb-unchanged ran H-core's `unchanged()` again and additionally required r06/r07 to differ; with H on main they plan the same (checked: 58 same, 0 differ but item 3's named v33/v34). H-core's item 11 (h-unit) and ha-unchanged already judge "only the named exceptions may differ" from `UNCHANGED_EXCEPTIONS`. ~~**hb-unchanged after the merge.**~~ H-b's item 11 still requires t3a/r06 and r07 to differ from origin/main. Once H is on main they
  won't, so relax it to "only the named exceptions may differ", as H-core's `unchanged()` (`UNCHANGED_EXCEPTIONS`) already does.
- **Done (housekeeping 3):** apijars runs the 0.37.0, 0.36.1 and 0.36.0 jars (API 1.34.0, 1.33.0, 1.33.0), each with its tag's `tools/apitest.mjs` and its own world (G6A Jar0370/0361/0360); v0.37.0 built from its tag (aac5f588, sidecar bundled) into `artifacts/gate6c-h/v0370` beside the H batch's v0361 and H-core's v0360. ~~**apijars over v0.36.1.**~~ `gate6a.mjs` apijars still runs the 0.36.0, 0.35.0 and 0.34.0 jars; api-compat `--gate6ch` now uses
  0.36.1 (built from its tag into `artifacts/gate6c-h/v0361`). Add 0.36.1 to apijars (with its base world) at the release tier.
- **6ct1-scenario-relief's falling water** (H-b's slice run): 2 unclassified falling-water cells far from any H part under the
  narrowed `flow` class. Re-check at the release tier; widen the class or record the cells.
  **Still intermittent (VOC batch, 2026-10-20):** the same "the undo's own" unclassified cells failed relief in D2's slice run
  (2026-10-13, 1), H-b's (2) and VOC-b's (4), and passed in hk3's slice run and others; relief_demo takes no compile pass. Not VOC's: on integrate/voc it passed
  (`artifacts/gate-runs-int-voc/20261020-030357-change`, unclassified 0).
- **The breach runoff past `watch`.** The removal's drain now takes only the body's cells, spill, watch, predicted flow and the
  census's recorded escapes (a player's water stays, §4.2). If a single breach's runoff ever reaches past the watch set, widen
  sim.mjs's watch reach instead of the drain.

## Queued from H-core (builder, 2026-10-18)

- **Recorded (item 14 b, T1's falling water):** relief_demo's committed inputs re-planned give FLUID_STATE 0, and no op names
  water or lava. The level-8 cells T1 saw came from vanilla flow into cells the plan cleared beside the stream. The `flow` class
  (scenarios.mjs `flowOf`) is now narrowed to unwritten cells more than 6 columns from any written column, or deep.
- **Recorded (item 14 a, under water):** a brush never takes a water column (brush.mjs), so no stroke rewrites a support under
  natural water: the sand stays, the undo is exact. The dry case is `tile-gravity`'s (housekeeping 2); H-core's impact rule runs it.
  TileCheck's gravity rule runs before the new under-water dependent rule, so a kept gravity block never becomes water.
- **Recorded (item 13):** M20's reach {side 3, below 1, above 3} follows 26.3's LavaFluid.randomTick (fire at most 2 up and 2
  aside; the block it lights one more; "below 1" is a margin). The probe counts only the posts the lava lit itself and keeps
  fire's own post-to-post spread apart; the gate's base turns fire off (`fire_spread_radius_around_player 0`), so the probe sets it
  to -1 for its two minutes.
- **A halt without a save loses an earlier stage's world writes while the journal keeps them PLACED** (H-core's FL1 without
  `+save`: the ground stage's pits and shells were gone after the restart). The fluids stage now re-checks every body after such a
  stop (cells open, shells and joins hold) and answers uncontained rather than writing into a lost shell. The general case (any
  stage's PLACED entries over chunks the halt did not save) is 6a's crash model ("journal wins" holds only with a save): decide
  whether settle at start should compare a stage's last entries with the world and re-apply them.
  **Answered (draft):** CONTRACT "Undo hardening C" (roll forward per cell after an unclean stop; release only once durable).

## Queued from the H RCs (coordinator, 2026-10-19)

- **Done (housekeeping 3):** ha-ingame's new item `ha-farm` (tools/lib/gate6ch-a.mjs) runs v49 and Steward's hamlet (now `kit/test/fixtures/plan/h/farm_hamlet.json`, read by h-batch.test.mjs too) through Regions.checkPlan and realiseApproved on fresh flat worlds at exact rules: PLACED after the bodies settle, each farm pond's census equal to its prediction, M25/M20/M17 0, Regions.remove E-flat 0 (`artifacts/gate-runs-hk3/20261019-200831-change`: v49 2 ponds, 351 written, 433 restored; hamlet 1 pond, 281 written, 369 restored). The other body kinds already went through realiseApproved with an exact undo: pond, pool, lava pit, fountain, waterfall and moat in ha-exact (water_demo, E-flat 0), quay, wet-pier beam and harbour wall in hb-flat (h-ingame). ~~**No in-game step realises an approved plan with a farm pond.**~~ Two farm-pond bugs (lots typed `farm` without `villager`,
  nested guard runs) reached Steward's RC check because our steps only checked such plans. Add a `realiseApproved` round
  for v49 and Steward's hamlet (type-implied farm lot) to ha-ingame, and generally: every H body kind should go through
  realiseApproved at least once in game.
- **Done (housekeeping 3, mod 0.37.1 placeholder):** `PlanChecks.guardMalformed` checks every guard before any survey (an object; `volume.sha` a string, `volume.box` 6 integers; `runs` a flat integer array, a whole number of quads) and answers ARTIFACT_STALE "guard N (<body> of <part>): the artifact's guard is malformed (...): check the plan again"; `PlanChecksHTest.malformedGuards`. ~~**Guard reader robustness:**~~ `PlanChecks.guardDiff` throws Gson's "Array must have size 1" on a malformed `runs`. Validate the
  shape and answer a clear error instead.

## Queued (coordinator, 2026-10-19)

- ~~**Farm irrigation (Steward S-HY-2, Noah's working/automated farms):**~~ **Slice IRR, in the CU/IRR/VOC-c batch (v0.40.0 RC).** a source per 9x9 inside a farm lot's field, as H bodies
  (contained, drain-first undo), set by an Architect member on the farm lot (for example `irrigate: true`). Lot designs never
  own fluids. A small slice after HY.
- ~~**VOC-c (S-VOC-2):**~~ **Slice VOC-c, in the CU/IRR/VOC-c batch (v0.40.0 RC).** `rule.palette` measured, with a `realiseApproved` refusal and Steward's RC check, after VOC-a and VOC-b.
- ~~**Copper weathering and undo** (VOC §10):~~ **Slice CU, in the CU/IRR/VOC-c batch (v0.40.0 RC).** `StillOurs` needs the same block, so oxidized copper is left behind by undo and
  removal. It is on main today. Its own slice, with verifier re-runs and Steward's pre-release check. **Evidence (VOC-b's
  drift probe, voc-natural):** under `dev.vocab.tick` 157 of 157 unwaxed copper cells of voc_copper_hall weathered, and after
  `Regions.remove` 134-138 of them remained standing (classified `growth`; VOC-b's runs and the verifier's re-run). Still queued
  after the VOC batch (v0.38.0). **Corrected by CU's item 1 (2026-10-20, the cell list kept):** none of those cells was copper.
  The hall is a lot, a BOX entry, restored exactly; the 147 cells that differed after the removal were all outside its lot box
  (124 grass_block->dirt, 5 dirt->grass, 8 amethyst buds: `growth`; 9 water/lava flowed into air; 1 bee nest), and the probe printed
  the growth count when no cell in the box differed. The real exposure was copper written as CELL tiles (cu_demo: all 28 weathered
  cells and a door half kept). Slice CU.
- **v0.37.1 bumps the kit to 0.35.1** (hk3's even-width rope bridge and tunnel fix changes kit output for v33/v34-style plans, so IrStale marks older IRs stale). The VOC and HY branches (kit placeholders 0.36.0 and 0.37.0) must merge main after this lands. Kit version sequence: 0.35.1 → VOC 0.36.0 → HY 0.37.0.

## Queued from the VOC batch (integration, 2026-10-20)

- **A wall through a fountain's basin (v51).** In `valid/v51_voc_forge` the forge wall's ring (`wall.around {feature: {part:
  forge}}`, ring 4-8) writes over the fountain's last basin row (5 water cells at y 65, z 2058) and five of its rim cells: the
  final cells are the wall's, the plan is READY, and the realised world equals the virtual one. The fountain's
  footprint (its rect grown by 1) is not kept by the wall's ring. Decide whether connectors keep forms' footprints (or refuse),
  with a fixture; until then v51's fountain shows polished blackstone 18 billed vs 13 standing in voc-ingame (listed, not judged).
- **v44's waterfall bill:** `cost.bom` stone 219 against 201 standing in its IR parts' final cells (offline virtual world, no other
  part in the plan). Untraced: a bill over a cell its own carve or shell writes twice, or a condition that keeps natural stone.
  Trace it as the fountain's was (h-a's bill test compares a part's bill with its written cells).


## Queued from the HY batch (integration, 2026-10-20)

- **A body's prediction ignores other bodies' falling water beside its spill** (HY-b's "for the batch" item 3, the spout case:
  vanilla takes a cell's level from any falling neighbour, so a fountain-fed lip ran 1 and 2 beside the spout's falling side in
  game). The generators keep apart where they know of it (HY-b's landings keep off a spout's curtain). Not a small fix: sim.mjs
  simulates one body over its own world, so a cross-body pass (or the other bodies' falling cells in each body's world) is needed,
  with a fixture where two bodies' flows meet. Its own slice item.
- **The router doesn't know the walls.** compile.mjs resolves courses (step 2) before `planWalls`, so a routed course meets a wall
  only at emit: where its reach is still for 2 cells past each face it gets a water gate (v58), else it is refused UNREACHABLE
  {kind: wall, why: still | step | corner | width}. A router that forces its profile level across a planned wall's line (or lays
  `gate.mjs reachAcross` there) would turn those refusals into water gates. Needs the walls' lines before the course's profile.
- **The 16-volume limit, the rest of it.** A course now asks one volume (the union of its reaches' boxes), so 3 courses of 6 reaches
  ask 3 (hy-b.test). A course whose union passes the per-part cap (4M cells) still asks one per reach, and every H body (pond,
  fountain, moat, ditch) still asks its own: a plan of many bodies can still pass the sidecar's 16 (`region.plan` `volumes.max(16)`).
  The riffle probe (hy/p01 and p01b) could be one plan again. If a real plan reaches 16, merge nearby bodies' boxes, or raise the cap
  with a memory measurement (each volume is decoded in the plan worker).
- **Fixture numbers:** VOC's `valid/v50_voc_village` and `v51_voc_forge` share their numbers with HY's `v50_stream` and `v51_canal`.
  Tests that pick fixtures by number filter by kind (hy-b.test's item 2 reads only channel fixtures). Renumber one family at a quiet
  moment, or keep the kind in every filter.
- **apijars over v0.38.0 before release.** api-compat `--gate6chy` runs the 0.38.0, 0.37.1 and 0.37.0 jars (v0.38.0 built from its tag
  into `artifacts/gate6c-hy/v0380`); `gate6a.mjs` apijars still runs VOC's set (0.37.1, 0.37.0, 0.36.1). Add 0.38.0 (with its base
  world) at the release tier.
- **HY-b's own uncrossed-wall refusal has no fixture now.** `hy/r11_wall` became the sealed-ring case once courses take water gates;
  HY-b's emit check (a wall within 1 of a reach, or over a step, with no crossing registered: UNREACHABLE wall) needs a fixture that
  reaches it (e.g. a wall line alongside a course).
- **HY-a's pinned shas on Linux.** `hy-a.test`'s flow/wet/courses shas were verified on macOS only (a pushed branch runs no CI): the
  PR or the merge's CI must show them on Linux.
- **`GATE6CHY_SKIP_CORE`** (HY-b's development switch: runs only the halves' items of an in-game step) is kept; no gate chain sets
  it, and a step run with it records `core: skipped (GATE6CHY_SKIP_CORE)` in its output.

## Queued (coordinator, 2026-10-20): priority

- ~~**Walls and other parts don't keep clear of fluid bodies (safety).**~~ **Slice KC (v0.39.1, CONTRACT "KC as built").**
- **6ct1-scenario-relief's falling-water cells** have now failed on D2, H-b, VOC-b, HY-b and HY-core. Investigate the root cause
  (T1's falling-water note) instead of re-running.

## Queued from the HY release (coordinator, 2026-10-20)

- **Two cheap tests from the HY integration verifier:**
  - a Java test running PlanChecks' sample cache with two guards on one volume sha;
  - an in-game stale check on a 2+ reach course with one cell changed in a single reach, confirming only that reach is named.

- ~~**6ct1-scenario-relief's falling-water cells**~~ **Root-caused and fixed (branch `fix/relief-flow`, 2026-10-20).** An undo
  defect, not load and not a missing class. S3's claim has a worldgen spring whose stream (x 3664-3672, y 122-125, z -980..-965)
  only starts flowing once the fresh copy's chunks tick, so relief_demo's survey (taken before the 90 s settle) never sees it.
  In 17 of 36 recorded runs the layout's relief fill covered the stream (`writtenFlowing` >= 16); every one of those had
  unclassified cells, and no other run did (load 7.9 failed, 52-89 passed). The fill writes dirt over the feeder (3671-3672,
  123, -972, level 1). Vanilla then drains the falling column below it (3671-3672, 122, -972), which the region never wrote, so
  it isn't in the journal. The undo restores the feeder exactly, but CELL entries are written with every side effect skipped, so
  the restored flowing water had no fluid tick. The column stayed air at +10 s and at +60 s. Fix: `site/FluidRearm` gives every
  non-source fluid cell a restore wrote one fluid tick once no removal and no restore or delta job is writing. With it, the
  column refills by +10 s. Older passes with these cells came only from T1's `flow` class, before H narrowed it.
  Not covered: HY-b's run also had 13 unwritten cells beside the stream (grass turned to flowing water) that were still dry
  after the realise; a re-tick can't undo a spread like that. No class added.

- ~~**voc-natural's unclassified water and lava**~~ **Root-caused and fixed (branch `fix/voc-natural`, 2026-10-20).** The
  world's own fluids, not an undo defect, not layout, and not HY. Item 9's E-normal diff named 4-9 `none` cells, every one air
  turned to flowing fluid: S3's cave stream (3756-3760, 37-39, -924/-923) and a lava spring (3787-3789, -2, -995..-990). The
  nearest written cell is 90 and 122 away (Chebyshev).
  - **World-driven.** A probe with no region at all took item 9's snapshot, then got the same 8 water cells at +15 s. They
    held from +15 s to +150 s: the stream's front, from a worldgen spring in fresh chunks, crosses the snapshot.
  - **Not HY.** c25c11cc (v0.38.0, before HY) fails with the same cells. v50n re-planned on one survey under the 0.38.0 and
    0.39.0 kits gives the same IR, apart from kitVersion, and the same blobs. The 0.39.0 re-plan reproduces the in-game irSha
    7e3edf02.
  - **Why it passed before (a correlation, not proven).** The four runs without housekeeping 3's base-host commits
    (35b504f1, 66d97216) have 0 fluid cells. The 8 with them all have fluid cells.
  - **Fix:** a gate-side world class in item 9 only, `farfluid` (`gate6cvoc-b.mjs` `farFluidOf`). It is F2's `distant` rule
    restricted to flowing fluid:
    - Each side is air, cave air, or non-source water or lava, and at least one side is that fluid.
    - The cell is unwritten, in no lot box, and at least 8 (Manhattan) from every written cell.
    - A source block, any other kind, and any cell near the plan stay unclassified (`kit/test/voc-farfluid.test.mjs`).
    - `RegionHash.classify` is unchanged.
  - Replayed over the 8 recorded failures that still have plan dirs: every `none` becomes `farfluid`, and `live` is untouched.

- ~~**s2-unit's M27:role (rubble = cobblestone)**~~ **Fixed (branch `fix/voc-natural`, 2026-10-20): the role data was wrong.**
  - **Cause:** VOC-b's `kit/vocab/roles.json` put `rubble` in the terrain row (`natural`: ROCK, SOIL, LOOSE, SNOW, ICE). But
    the kit's own default rubble is cobblestone (`program.mjs` `DEFAULT_MACRO_ROLES`; CONTRACT "the rustic default ... rubble is
    cobblestone"), and cobblestone has no voxel class, before VOC or after. So any bible that names rubble = cobblestone
    (S2's g6c_s2_outpost) trips M27:role.
  - **Not new since v0.38.0:** S2 feasibility passes on 5c61b6c7 (main before VOC) and fails on 0d665136 (v0.38.0) and on
    every later head. No VOC run selected s2-unit, and no run before KC's had VOC in it.
  - **Not the same cause as voc-natural.** The stonecutter putting cobblestone in the `stone` family is not involved:
    `natural` reads the voxel class (`v`), not `fam`.
  - **Fix:** `rubble` gets its own row, `all: [cube]` (a carve's lining and boulders, written as a full block). rock, surface
    and subsurface keep `natural`. `fitsRole` and M27:role are unchanged.

## Queued from slice KC (builder, 2026-10-20)

- **The rope row's OVERLAP and its nearest-landing wouldFit are not exercised.** k04's base already routes round the fountain, so
  the rope bridge relies on the backstop (`OVERLAP {kind: body}` with no wouldFit). Bridges likewise. A fixture whose only landing
  is in a body's watch would show it.
- **Courses don't route round planned walls.** A course routes at resolve, before the walls; a wall alongside it refuses it at emit
  (HY's UNREACHABLE wall) or by the backstop. Re-routing at emit with the walls as hard (but the water gate's straight run) is the
  contract's fuller reading.
- **A M25:clear finding with no plan part to refuse leaves the plan READY** (the apron lamps' `__lamps__`, a body with no part):
  the region check names it as an error. Only broken variants reach it today.
- **The strict watch makes a raised fountain's apron (7 past its basin) hard for every later writer.** If Steward's plans meet it
  often, S-KC-2's shell-grade allowance is the lever.

## Queued from the CU/IRR/VOC-c batch (integration, 2026-10-20)

Integrated on `integrate/batch-cu` as v0.40.0 (API 1.37.0, mod 0.40.0, kit 0.38.0, catalogue 9); CONTRACT "CU/IRR/VOC-c batch as
integrated". Fixed before the RC: IRR's breach sweep (the verifier's finding 2). Queued, not fixed here:

- **IRR: a removal that fails after the drain** (verifier note 3). `Sites.removeDetailed` (a journal commit failure) or a stage
  undo whose plan ends `Removed(false)` leaves the lot standing with its sources drained (`lotRemoved`, never written again).
  Blockers and players are checked before the drain, so it needs a failure after it. Either drain after the commit point, or
  rewrite the sources (clear `lotRemoved`) when the removal fails.
- **IRR: `SiteJournal.retake` reads the mask from the site record** (verifier note 1), which a new placement has not written yet.
  Latent (a Placing is always built without a tracker, so retake returns early). Carry the mask on the Placing.
- **IRR: hooks checked only in code** (verifier note 4): the stage undo, the placing rollback, the cascade and `removeLarge` call
  `RegionFluids.drainLot`, but no gate drives them in game. One irr-ingame case each (a stage undo of a farm's stage; a cascade
  over a farm lot; a large removal).
- **CU: plain `holds` left in three places** (CU's verifier): `Sites.journalOwn`, `Sites.foreignBlockEntities` and PT2's
  adopted-site edit count use plain `WorldJournal.holds`, not `holdsOurs` with its player-record check, so a player-placed weathered
  copper block entity there could count as ours. Route them through `WorldJournal.holdsOurs`, with a test each.
- **CU: the delta path's player-record check has no in-game test.** `SiteDeltas`' delta world treats a copper-equivalent cell that
  PT records as player-placed as the player's; only the undo planner's twin is driven in game (cu-ingame). Add a delta case: a
  player places a waxed copper block over Architect's copper, then a versionOf.
- **CU: the stale `M27:drift` text.** The kit's warning over copper ("an undo keeps a changed cell") is wrong since CU (undo and
  removal restore weathered copper). The kit was frozen by CU's contract; reword it in the next kit slice (kit output changes: a
  kitVersion bump and the named fixtures).
- ~~**Possible main bug: a road lantern post turns the lane's dirt_path to dirt, and removal leaves it.**~~ **Fixed on
  `fix/lamp-path`.** Not intermittent: it tracked IRR's field fixture. Every failing run (s01 at 55b8e277, 0aa3ded1, c3a4ef62; h0 at
  af13e28f) was before 3bce48c6, which moved the field's composter off its front-row dirt_path; every run since passed. The chain:
  street_e's lantern post stands at 9617,66,9091 on the region's own dirt_path verge (IR part `verges`, beside lane_farm_1; road
  writes skip side effects, so the path survives the post). The old composter at 9616,67,9091, over the field's own front-row path and
  written by the lot with shape updates, turned that path to dirt; dirt is sturdy, so the post reconnected west, and its state change
  sent a shape update down to the verge's path, which vanilla ticked to dirt outside the journal. The verge's entry still said
  dirt_path, so the undo kept the dirt (E-flat 1; the lot's own cell came back with its box). Fix: (1) `StillOurs.pathTurned`, used by
  the journal's ownership (`WorldJournal.holds`/`same`; PT's player record first via `cuEquivalent`): a cell written as dirt_path and
  now dirt (or grass spread onto it) is ours. `StillOurs.holds`, the builder's test, is unchanged. (2) `RoadPlan.lanterns`: a post (or
  a fixture cell) stands on a dirt path only when the road's owner wrote it; main took any dirt path (`ground()` includes PATH), and a
  village's path the road never wrote could never be restored. Tests: RoadPlanTest.noPostOnADirtPathNotOurs, PathTurnedTest,
  irr-ingame's `lp` case (every journaled path on farm_hamlet turned to dirt, the two road posts' paths by a block set beside each
  post: the chain reproduced; E-flat 163 at main's code, 0 with the fix: `artifacts/gate-runs-lamppath-pre/20261021-003336-6cirr`,
  `gate-runs-lamppath/20261021-001720-6cirr`). **Left:** the
  kit's street-lantern light model (`light.mjs` roadLights) takes any solid foot, a village path too (a kit slice: kitVersion bump);
  kit props stand on the square's dirt_path paving, covered by (1).
- **IRR's breach fix, its stated limit.** The drain's record of a breach is made at the drain from the fluid levels, not by a census
  (a breach comes after the body settled, when no census runs). Water where a foreign flow (a pond, a player's water) meets the
  breach's flow is spared, so a few cells of joint water can stay outside the lot after its removal. A periodic shell check that
  re-opens a census on a breach would record the flow as it runs, at a per-tick cost; only if Steward's worlds show such cells.
- **IRR's breach fix, in game: a foreign flow beside the breach.** The `spare` case puts the pond and the well under the flow, so
  the prune by a foreign *flowing* feeder (a player's flow meeting the breach's at a higher amount) is unit-tested only
  (RegionFluidsBreachTest). Add an irr-ingame case with a player's source on the ground beside the trench's exit.

## Queued (coordinator, 2026-10-20)

- **Discarding unrealised plans** (found drafting D3): nothing in the mod or sidecar discards a plan. Every `Regions.plan` keeps
  `plans/<id>.json` plus `.survey.bin` (0.4-0.9 MB each) and its sidecar directory. Add `Regions.discardPlan` and a world-start
  sweep of unrealised plans past an age.

## For the 6c close-out (coordinator, 2026-10-20; Steward round 12 asks)

- `realiseApproved` after ARTIFACT_STALE: the same opKey may re-check and retry (a stated rule), so Steward drops its second
  key (`vrealise2`).
- Pins expire with their opKey, so they can't leak.
- `Regions.discardPlan` plus a world-start sweep of unrealised plans.
- A route ending on a lot its zone couldn't place answers `blocked {dependency}` (naming the lot and zone), not refused NO_ROOM.
- `rule.palette` gains `scope: "lots" | "all"` (default "all" = today), and `exempt` accepts `ways` and `forms`.
- Take Steward's 12 re-recorded asks (steward-mc f-strange-asks) into the asks fixtures and gap table.
- Pond placement keeps a body's shell, spill and single-breach reach off every lot's box + 1 when it chooses a site, so it
  lands on a free site instead of refusing LEAK (Steward's F3 RC, 2026-10-21: a pond near stone, within 40 of a town zone,
  refused LEAK because its single-breach reach met lot cottage_1; near claim_n it fits). Main's kit does the same, so this
  is not an F3 issue. Gate: that plan places with 0 LEAK, plus a unit test where the only lot-clear site is the one chosen.

## Queued (coordinator, 2026-10-20)

- **pt2-ingame item 13 fails on main:** VOC-c appended `Reason.PALETTE` after `ADOPT_REFUSED`, so the check that
  ADOPT_REFUSED is the last Reason is stale. Make the check order-independent. Fix in the 6c close-out. **Done in close-out B:**
  `apipt2` reports ADOPT_REFUSED right after PLAYER_BUILD and ADOPTED right after PROVISIONAL (and the Reason names), and item 13
  judges those.
- **Stale asks tables after VOC-c** (found by the release-tool run): h-unit and ha-unit fail H-a item 10, and vocc-unit fails
  VOC-c item 3, because `rule.palette` became supported. Re-cut the tables (vocc's "after" table already matches) and fold them
  into the 6c close-out with Steward's 12 re-recorded asks. **Moved to close-out A** (coordinator, 2026-10-22), which re-cuts every
  asks table with Steward's 12 new asks.

## RS follow-ups (coordinator, 2026-10-21; Steward's supplied-plan run on the RS jar)

- Region tile and road item waits carry no build tag Steward can match. Give them the region and the part, as SITE_WAITING
  already does, so the steward can say which part waits for what.
- SITE_BUSY stage waits: give them a reason Steward can say ("the street waits for the walls").
- Steward found a region builds from materials only when the world's default mode isn't creative, while its batch path needs
  only the toggle. Write the rule into the RS contract text so callers don't have to discover it.

## Queued (coordinator, 2026-10-21; Noah: crash safety option A)

- **Diagnose-and-repair command** for builds left half-placed or half-restored by a crash with unsaved chunks.
  - **Report:** per site or region, cells where the world disagrees with the journal (expected vs found).
  - **Repair:** re-apply the journal's committed state to cells that still hold the operation's exact before-value (never
    player-changed cells). Report the rest.
  - Plus a DevBridge hook, gated by UMT properties and one in-game kill test without `+save`.
  - Steward ask: an API (not only a command), so its steward can say "this build came back half done; repair it?". The report is
    readable per site or region by API (it names the cells, expected vs found), and the repair can be invoked by API.
  - Small contract first. Steward should know about it (a repair changes the world).
- Full crash safety (Undo hardening C) is parked; see CONTRACT. No fsync for now.

## Undo hardening B queue (integration of patch v0.40.1, 2026-10-21)

Top first. Not fixed in v0.40.1.

- **DPT: a delta over a player's block loses its PT record.** `SiteDeltas`' D7 commit rewrites the delta's sections from
  `new Cell(q, layer, before, after)`, which drops the PT records its create annotated (`JournalStore.ptSource`). The removal puts the
  player's block back without its record. Production code; UMT mirrors it.
  - Repro: `UmtFindingsTest.dpt_aDeltaOverAPlayersBlockLosesItsRecord`. Tag [DPT].
  - Likely fix: `WorldJournal.withAfter` over the stored sections, as `SiteJournal.complete` (P7) does.
  - **Top of the queue** (coordinator, 2026-10-22): a production bug.
- **A tile re-run after RG4+save leaves its first entry PLACING (found by RP's rp-crash).** After an RG4+save crash the restart
  logs "0 job(s) to resume": the tile's Infra record was saved but its job was not, so the startup Sites check doesn't release
  the entry. The queue then re-runs the tile and writes a second entry, while the first stays PLACING. The region still reports
  PLACED.
  - Seen in `artifacts/gate-runs-RP/20261021-035819-change` (rp-crash), region rg4: c1 PLACING, c2 ACTIVE.
  - Risk: a later rollback of the leftover entry could write its befores under the re-run's entry.
  - RP reports it as `placingLeftover` in the region's realised record (CONTRACT "Slice RP", §6), so it is visible, not fixed.

- **F1 mirrored (found by fast checks P1, 2026-10-21):** when a building's box includes the pad's ground row, removing in the
  order road, lower building, pad, upper building leaves the lower building pending at every start. UMT tags it [F1]; gate4e's
  real fixture stands above the pad, so it isn't hit in game. Details: docs/GATES.md "Fast checks P1" (branch chore/gate-fast-p1).

- **F9: a road's head room over a site, removed top-down, is recovered** (umt-long on v0.40.1 and v0.41.0, found by close-out B).
  A road over a site's edge writes air over the site's blocks. Remove the road, then the site: at the next start the road's evidence
  reads the site's restored air as its own after, so it reads standing and RECOVERs. Its second removal writes the site's blocks back
  for good. This is F1's kind, which F1's fix (`laterWrite`) doesn't reach, because CELL evidence counts after-air cells.
  - Repro: `UmtFindingsTest.f9_aRoadsHeadRoomOverASiteRemovedTopDownIsRecovered` (PLAIN seed 604864872 shrunk). Tag [F9]: 5-6 per
    20000 fuzz scenarios.
- **F10: a plant over a delta's cell breaks at the removal.** A lot holds short grass (its before). A delta of the lot clears the
  grass block under it. The removal's one template over the union of their boxes places the plant over air, and V5 breaks it.
  - Repro: `UmtFindingsTest.f10_aPlantOverADeltasCellBreaksAtTheRemoval`. Tag [F10].
  - It rests on modelled template order and V5, so confirm it in game.

- **PTS: a player's block under two stacked boxes loses its PT record** (a fresh umt-long seed, 731542907). A site, then a lot over
  its edge, in one group, over a player's cobblestone with its record. After the group's removal (or removal one by one) the block is
  back without its record. Not yet isolated between `SiteJournal.restore`'s PT expectations for a lower entry and the modelled record
  restore. Repro: `UmtFindingsTest.pts_aPlayersBlockUnderTwoStackedBoxesLosesItsRecord`. Tag [PTS].

## Queued from 6c close-out B (builder, 2026-10-22)

- **S3's natural run: a monastery route cuts a retained terrace rim on some live surveys** (close-out B's final slice).
  - 6c-scenario-s3 failed bar 5 twice on B (`gate-runs/20261023-093624-slice`, `gate-runs-coB/20261023-103203-slice`): "rims
    546/549 retained (3 open)" at the guest house's level 102 (3662,98..99,-900..-898). routes_monastery's stair cut runs through the
    rim.
  - The run's survey re-planned with main's kit (f0649fb7) gives the same IR (programSha aside), so this is S3's survey dependence, not
    B's. Main's own run on another survey passed.
  - Harden the program so its route never cuts a retained rim, or refuse such a plan, as close-out B's S3_STRUCTURE does for M3.
- **6ct1-scenario-relief's realised == virtual row** shows 17 relief cells dirt_path -> dirt (3668,114,-937 and others) both on B
  (`20261023-093624-slice`) and on the 032705 run before B's CellCond change. Not B's; find the second path write.

- **RoadTerrain treats untouched natural packed ice (and other natural blocks) as a BUILT obstacle** (RS item 14, close-out B;
  coordinator: its own slice, which needs fixture re-cuts and a look check). **Fixed on fix/nightly-infra (2026-10-25):**
  `RoadTerrain.kind` falls back to the mod's natural rule (`TerrainFit.natural`, plus the region writes' `CellCond.alsoNatural`):
  a solid natural block is STONE ground, one with no collision a PLANT, never BUILT; farmland stays BUILT, ice over water stays WATER.
  The kit's road model (`kit/lib/lint/roads.mjs` roadKind) reads the virtual world's `naturalBlock` the same way, with the frozen-water
  check (`roadKindAt`). Unit: `RoadTerrainNaturalTest` (packed/blue/land ice, calcite; every natural block of the drift fixture).
  No kit fixture moved (unit-kit 901 pass).
  - **What happens.** rs02 on a survival copy of S3's claim: road:street_e fails "the road changes no cell". All 12 of its columns
    stop (kept 4, blocked 8) on `minecraft:packed_ice` ground at 3750,151,-999..-997, which no journal entry holds.
  - **Cause.** `RoadTerrain.kind`'s ground lists lack natural blocks that `TerrainFit.natural` has (ice, packed ice, blue ice, calcite,
    powder snow and others), so those fall through to BUILT. The region ends PARTIAL (96.7%).
  - **Evidence:** `artifacts/gate-runs-coB/20261023-080517-slice` (the failure names the block). The earlier runs
    `20261023-050602`, `20261023-061736` and `20261023-072735` show the same.
  - **Fix:** RoadTerrain treats a solid block that `TerrainFit.natural` counts as STONE ground. That moves 4e roads over such ground
    everywhere (S2's outpost over packed ice, among others). Re-cut the fixtures, check the look, then re-run item 14 to PLACED.
  - `Roads.heldByOwn` (close-out B) stays. A road whose columns its own region's entries hold is a no-op; this blocker is the world's,
    not the region's.

- **Model RS's region targets in the ledger lint.** `LedgerSim` covers building targets, a road and adoption. A region-target kind,
  built through production seams (`RegionTargets.newRun`'s held cells, run bills, `soilSame`, `leaving`), would let rs-survival items
  8-10 (conservation, refunds, the mid-build removal) move to REPLACE · ledger-lint. Today they stay in game, one build each.
- **Lava in the natural rule: ruled** (coordinator, 2026-10-22). There is no behaviour change: the mod never writes over lava, the kit
  keeps LAVA natural for survey reading and M20, and lava stays a named exception in `NaturalDriftTest`.
- **The kit's virtual world writes over lava** (found by the ruling's grep). `vworld.mjs`'s cell conditions read `pal.natural`
  (true for LAVA), so an IF_NATURAL or ALWAYS_OURS write over a lava cell, for example a carve through a frozen volume's LAVA, lands in
  the plan's virtual world while the mod skips it. Make the conditions refuse lava (a write-side natural without LAVA). That moves the
  virtual world for any plan that meets lava: re-cut and check byte identity.

## Queued from slice S3 (builder, 2026-10-21)

- **District routes ignore protected areas** (main, non-terraced districts): `emitDistricts` passes no keep-out of the plan's
  protected areas, other regions or builds to its route pass, so a district's street can cross a protected rect. S3 fixed it for
  terraced districts only (`routeKeepOut`, so byte identity holds); the fix for every district moves fixtures (re-cut them).
- **A route pass grades from the survey, not from an earlier pass's cells.** A later pass treated earlier runs only as `prefer`
  (x, z), so it cut its own stairs through them. S3's guarded passes make earlier runs obstacles and keep parapets, retaining
  walls and stair railings off them; unguarded passes (every other plan) still can cross. A shared-height rule would fix both.
- **The kit's volume classes vs the mod's natural rule.** The mod's `TerrainFit.natural` lacked generated ice (fixed in S3), while
  the kit's ICE class is natural. Audit the rest of `NATURAL_CLASSES` against `TerrainFit.natural` (e.g. LOOSE, PLANT kinds) with a
  drift test like `MaskPatternDriftTest`. **Done in close-out B** (`NaturalDriftTest`; CONTRACT "6c close-out B as built" §6). Lava
  is kept as a named exception, by the coordinator's ruling (no behaviour change).
- **Snow layers read as SNOW (solid) in a volume.** A top snow layer is passable in the world; S3's brink rails count it, the
  checker's M8 doesn't. A layer/block split in ARVX (or a `top` flag) would let M8 and the walk graph agree with the world.
- **meta.route holds only the last route pass.** S3 merges its passes into one record in its program; a kit-level `meta.routes`
  (every pass) would let the checker's route rules and the scenario rows read all of them for any plan.
- **The release tool's set test copied the real tree's placeholders** (fixed in S3: it counts them first).

## 6c scenario approvals (SETTLEMENTS §16.3: green = every bar passes and Noah approves the gallery page)

| Scenario | Approved | Evidence | Gallery | Recorded |
|---|---|---|---|---|
| S2, the ice-spike outpost (v0.31.0) | Noah, in chat with the coordinator, 2026-10-14T04:39:12Z | `932dafe971f1` | https://claude.ai/artifact/AHUxAGLT42pfRy5YUHdojG (section S2) | here by slice S3 (2026-10-20), from `artifacts/scenarios/6c/s2/approvals.json` (CONTRACT S3 §9 item 9) |
| S3 v1, the terraced monastery | Noah, in chat with the coordinator, 2026-10-21 (bar 16) | `39d6ddb1bbf3` (natural run 20261021-041532, slice tier 20261021-040412) | https://claude.ai/artifact/AHUxAGLT42pfRy5YUHdojG (section S3 v1) | here at the batch v0.41.0 integration (2026-10-21) |

## Queued from RS (moved from HANDOFF-RS.md and HANDOFF-RSb.md at the batch v0.41.0 integration, 2026-10-21)

- **RS item 14: rs02 on S3's natural claim in survival** (E-normal by S3 §6's classes). It waited for S3, which is in this batch;
  `tools/gate6crs.mjs` lists it as not built (the `survival` group's comment). **Built in close-out B** (`gate6crs.mjs item14`, in
  the `survival` group; CONTRACT "6c close-out B as built" §7).
- **The gate3 survival and Hardcore steps** (a GUI p3 client) were not run for RS-a. A Hardcore world now realises regions in
  survival (mode by world); "Hardcore unchanged" needs gate3's hardcore step green on a release with RS.
- Done here, no longer queued: RP's provenance for survival targets (HANDOFF-RS "Follow-ups", HANDOFF-RSb "Open"). Each target's
  cells are UNFINISHED at put-down and WRITTEN, with the target's site listed, once it is built (CONTRACT "Batch v0.41.0 as
  integrated").

## Queued from the batch v0.41.0 integration (2026-10-22)

- **Lamp spacing on V and D streets (look lint L-LAMP).** FL's look fix L3 (lamps 6 apart settlement-wide) applies only to plans with
  a free zone, so every other plan stays byte-identical. S7 (1 natural, 1 flat) and districts_demo (20 natural, 9 flat) keep their
  counts in `kit/test/fixtures/lint/baseline.json`. Extending the gap to V and D streets moves every street fixture: a slice of its
  own, with Noah's look.
- **S3's natural scenario depends on the live survey.** **Done in close-out B:** the run's survey lacked a tree's TREE flag (x
  3674-3677, z -945..-942), so the relief blended its grass over a stair flight's head-room cut. The monastery's trim now takes the
  relief's floating natural cells out, and an M3 left after the trim refuses the plan (`kit/test/s3-live.test.mjs` re-plans the
  recorded inputs). Before: Each natural run plans over the world as it stands, and the IR differs run to
  run. One run in this batch's gate (`gate-runs-0410/20261021-180501-slice`, IR afc7092eaf47, 11 lots) answered one M3/M8 finding
  (bars 1, 5, 6). S3's own branch kit plans that survey to the identical IR, and the re-run passed. A plan that can answer an M-rule
  finding on some surveys is S3's to harden.
- **Main's gate-chains.json carried two `release.always` keys** (P1's -full list, then P2's list built on the pre-P1 one; JSON keeps
  the last). The batch merge keeps one list: the -full twins plus the lints, p2-calibration, w-ingame, d2-ingame and
  6c-scenario-s3.
- **6a-megaB's "REGION_PROGRESS events for every stage" row fails on main.** **Done in close-out B:** the row skips stages with no
  items and names them (`tools/lib/megab.mjs`, `kit/test/megab.test.mjs`), and still fails a stage that has items and sends no event.
  The stuck item in the re-run (`20261022-065722-release`) was **lot_129, not lot_054**. lot_054 was placed 1 s after the relog
  (site s83, 02:01:42). lot_129 (lots-3) waited OCCUPIED on a polar bear through every lap, then NOT_LOADED for good once the walk had
  moved on. The driver now clears mobs on OCCUPIED, as megaA does, and its final wait visits each unfinished item (3 times at most).
  Before: mega_bench's IR has an empty `lots-4` stage, so the
  row can't pass. It failed the same way on ca50b90e and in the batch run. Skip empty stages in the check, or re-balance the bench.
  In one batch re-run, lot_054 (the relog row's item) stayed WAITING NOT_LOADED after the walk until the step timed out. Watch for it
  at the next release.
- **The P3 cutover for RS's rows** (rs `-smoke` twins) was not done in the batch. **Done in close-out B:** `rs-survival-smoke` (SMOKE
  only: the ledger lint doesn't model region targets; docs/FAST-CHECKS.md "P3 cutover").

## Queued from close-out A (builder, 2026-10-22)

- **Retire `kit/test/fixtures/plan/asks-8703dbd/`.** It holds Steward's first recordings of the 12 asks re-recorded at steward-mc 0c8f4a8.
  The slices before close-out A still judge those plans; the readers are listed in its README.
  - Re-cut those slices' committed asks tables and test expectations to the new recordings: K1a item 7, K1b, T3a §9, T3b §9, VOC-c
    items 1 and 3, H-a item 10, and the HY-b/KC/F3/S3/RS/FL asks items.
  - Then drop `asksFirstPath`, `tools/lib/asks-first.mjs` and the `current` option of `asksGap`, and remove the directory.
- **§5 left over:** the "no X" re-plan still swaps materials in parts that `exempt: [ways, forms]` leaves out of the measure. A shared
  green (`_green`) isn't classed as `ways`.

## Queued from the split false-PASS fix (coordinator, 2026-10-23)

- **4d-all split into parts fails group undo; whole it passes.** fix/split-false-pass's proof run
  (artifacts/gate-runs-splitfix/20261023-042653-slice): 4d-all/p2 failed "removeGroup completes", "sites removed in reverse
  placement order" and "the whole village back exactly"; the whole step passed 63/0 in close-out A's re-run. 4d-all and
  4d-all-full are unsplit for now (gate-chains.json). Find whether p2 depends on state p1's sections leave behind, or whether it's
  contention; re-split only with a split-proof pass.
- **gate6crs item 4's "consumed 0 items" can never fail** (found by fix/survival-off-storm): it reads a top-level `consumed`
  that `dev.stockpile.state` doesn't have (it is under `ledger`). Read `ledger.consumed` and prove the check goes red on a
  broken variant.

## Found by fix/s3-scenario (2026-10-23)

- **Why 6c-scenario-s3 failed bar 6 ("M4 3") on main, fixed in fix/s3-scenario.** No change since v0.41.0 caused it. S3's chunks
  are not in the seed base (it holds only the spawn regions), so every scenario world generates them fresh. The cherry trees at
  the z=-960 chunk edge come out differently from run to run. When a tree stands at (3636, 117-124, -960), the fountain room clears
  its trunk. The cleared cells then sit beside w_fountain_spout's spill (3637, 118-120, -960), and the realised M4 counted the
  spout's own flowing water as foreign fluid. The plan's M4 was 0, the census matched the prediction, and the after-stand dump
  showed no inflow.
  - The tree was present in 4 of the 11 natural runs since 2026-10-22, and M4 3 appeared in exactly those 4. One of them was on
    776f8ea5, three commits after v0.41.0, with no kit or scenario change.
  - v0.41.0's kit re-plans the failing survey to the same IR (b9c6c0bf6585), and its checker gives the same M4 3.
  - The fix: on a realised world, M4 skips a neighbour that holds a plan fluid body's own fluid in that body's cells, spill or
    predicted cells (kit/lib/region/check.mjs). Re-running `scenarios.mjs metrics` on the three failing runs turns bar 6 to ok,
    and nothing else changes.
- **Proposed hardening (not built): pre-generate S3's claim into the seed snapshot**, so every natural run plans over the same
  trees (the "S3's natural scenario depends on the live survey" item above). Flowing water would still move the survey a little.
- **The flat run prints "FAIL S3 14 … E-normal n/a"** on every run, back to the v0.41.0 release. It is display only: `runBad` in
  tools/scenarios.mjs excuses the flat run's exactness row when E-flat is 0, so the flat run reports 0 failures. Print it as
  recorded on the flat variant, so nobody reads it as the step's failure.

## Queued from the v0.42.0 release (integration, 2026-10-23)

- **pt-ingame item 15, the classifier's per-tick CPU bar (1 ms).** It missed in the release run (1.02 ms) and on a quiet re-run
  (1.30 ms, load 2.6), and in at least 15 slice runs since 2026-10-20 (1.01-2.34 ms), where timing is recorded, not judged. Profile the
  classifier's warm path, or re-set the budget with Noah.
- **Run worktrees keep their design library between runs.** Shard 1 (`architect-mc-gate-run`) held a leftover `adopted_057fbe3f`, which
  is how 6b-commands found the fill bug fixed in 0.42.0. Decide whether a run resets the library, or keep it as a free cross-step
  check; a driver that assumes a clean library can read the wrong entry first.
- **Benches and quiet-wait while other sessions run outside the gate slots.** Kit suites run directly (not through gate-run) don't
  take a slot, so a turbo run's isolated benches waited up to 30 min each for quiet; mp-ingame ran NOISY. Either have agents run
  suites through gate-run or count them in the quiet-wait.

## Queued (coordinator, 2026-10-23; Steward's v0.42.0 grove check)

- **Removal log wording:** c982 placed 3075 cells; its removal logged "3074 cells restored, 0 kept (changed since)". The
  missing cell is presumably the player's cobblestone, so "kept" should count it. Fix the count or the wording.
- **An exposed written-cell set for callers:** Steward's undo checks need "cells the plan wrote" (the IR's tile cells plus lot
  boxes) after the region is removed, and today only the kit's buildVirtual gives it. Consider a dev/API read of the realised
  record's cell positions that survives removal.

## Noah's ask (2026-10-23): fancier gates, piston or redstone driven

Noah approved K2's walls look and asked for fancier gates. Candidate slice **GM, gate mechanisms**, after K3 (towers and
gatehouses), since a gatehouse is the natural home for the mechanism.
- **Kinds to consider:** a piston portcullis (sticky pistons raising a bar grid), a piston drawbridge over a moat or ditch (H/HY
  water), double doors on a lever or button pair, a redstone-lit gate (lamps tied to the gate state), and a pressure-plate
  sally port.
- **What the contract must settle:**
  - Who opens it: a player lever or button, and whether villagers' paths treat a closed gate as passable (vanilla villagers open
    doors, not piston gates).
  - Default state: open by day, or player-closed.
  - Survival bill: redstone, pistons, the observer and repeater chain.
  - Undo and journal: block states of pistons and redstone, moving blocks, and powered states at save and restore.
  - The walk graph and the M2 movers through an open versus a closed gate.
  - Mob safety: a closed gate seals the wall line.
  - The look per bible.
  - A Steward offer ("add a portcullis to the main gate").
- **Gate:** in game, open and close cycles, an exact undo with pistons extended and retracted, villager paths with the gate open,
  and the survival BOM.

## Queued from slice D3 (coordinator, 2026-10-23)

- **Prepare covers claim + 2 chunks, but an edge tile off the 64 grid needs a third.** A region realised in never-generated land
  can then wait NOT_GENERATED after a prepare. This is a bug on main; see D3's as-built. Fix: prepare to the tiles' real chunk
  bounds.
- **A clearer NO_JOIN answer next to an unloaded town.** The beside check reads loaded chunks only (D3 §4), so the answer should
  say "load the town's chunks first" alongside the "not surveyed" counts.
- **coa-unit item 6 goes stale on every slice now that COA is on main.** Its "before" table is computed on the merge base.
  Normalise it as F7A_ASK_PARTS does, or compare against the committed tables only.

## Queued from slice K2 (builder, 2026-10-23)

- **Routes joining gate landings** (the K2 finding; the coordinator's rulings (b) and (i), 2026-10-23, then the fallback (ii)).
  - **The limit.** Auto gates where routes cross can't open on stepped natural banks (45° staircase shores): K1a's gate move needs a
    straight run perpendicular to the route held flat across the wall at the route's y, and S3's river bank drops 7-10 blocks across
    the wall's 4 cells wherever the line runs straight (it is mostly runs of 1-3 cells). K1a's gate move is unchanged.
  - **What K2 ships.** An along wall's gates.min gates are placed before routing when the bank is stepped (a level wall's wait for the
    routes, as K1a's), each on a gate landing: the gate's floor 2 cells each side, outside lanes ending at the water's edge (at most 2
    above it), inside a 1-wide flight along the wall's inner face (round its bends) up to the bank, open sides over a drop of more than 1
    filled and fenced; the cells are the wall's own part (undo journaled). On S3 (`v7a_k2_along_shore`, gates.min 2) both gates have
    landings (flights of 4 and 16 steps, within 8 of the wall) and the kit's player and villager pass each both ways. A gate whose
    landing doesn't fit is noted per gate; a route the wall cuts answers `refused UNREACHABLE {kind: wall, walls, round}`.
  - **Probe** (25 spine points, every 8th spine cell, a path from a point 12 inland along the normal to the shore cell): without the
    wall 11 of 25 route (adjusted), 11 run out of budget, 3 refuse on the bank itself. With the wall and its landings, 0 route: 24
    answer UNREACHABLE {kind: wall} (the 11 among them), 1 (spine cell 0) BUDGET either way. (Same before the landings.)
  - **Why routes don't join.** The landings go to the route pass as its `base` (the ground they make, merged with rope.base), but (1) an
    endpoint inside a landing keeps its survey y, so the edge starts off the base's ground; (2) T2's gate move wants the route at the
    gate's floor on the cell before the wall, and the floor is the shore's level (62-64) under a bank of 75-90: a route reaches it only
    down the landing's flight, which follows the wall's face round staircase bends, not T2's straight flights of 2..8 then 2 flat cells.
    Probe pair 144 routed directly: without the wall 45 cells; with the wall and the base, the 2M-node budget spent.
  - **Likely fix:** T2 learns the landing as a fixed segment (a "gate approach" special move from the flight's top cell through the gate
    to the outside cell, cost by length), and endpoints read the base's ground. Or a terraced gate landing a route can join along its
    length (cut and fill a bench along the wall at the flight's levels).
- **A shared lamp helper with M17 (soul lanterns near snow and ice)** (the coordinator, 2026-10-23): K1a's gate lamps and K2's walk lamps
  place the bible's light with no M17 swap (a light over 11 within reach of snow layers or ice melts them). Lift a helper (scatter.mjs
  already clears its reach) and use it in both.
- **K1a bug: dark gate-walk cells under a level-10 light** (found by K2's look variants, not fixed in K2): v30 in g7ak1_infernal (soul
  lantern, light 10) on S7's flat claim: M5 5 dark spawnable cells on the east gate's walk (1559-1560, 66, -3077..-3075), with or
  without a walk. K1a's one lamp a side doesn't cover a 3-wide gate's depth at light 10.

## Watch (coordinator, 2026-10-24)

- **rs-survival item 10 rs02m2: "region reads REMOVING after the reopen", but it read REMOVED.** This failed once each in two
  independent runs on 2026-10-24 (speed-audit-c's branch run and speed-audit-b's new run). Neither changed that code, and it had
  passed in about 18 earlier logs. If the nightly shows it again, treat it as a real race in the reopen-during-removal path, not
  a flake.
- **A natural-site survey drifts in trees and water (CL, 2026-10-24).** Two surveys of the same G6B Seed Base in one run differed in
  about 500 columns of trees and water, because chunk features aren't settled at survey time, and both differed from route_demo's
  golden. Any gate that plans on a natural site should expect that drift: don't pin an answer on a tree or a water cell, and check
  the step against more than one survey. CL's climbs pass trees at a cost (CL as built).
- **T2's self-crossing retry can block its own goal (CL, 2026-10-24).** A route that crosses itself is searched again with the
  crossing cells blocked and dilated; a crossing at the goal blocks the goal, so all 8 retries fail and the edge answers NO_ROUTE or
  ROUTE_WATER. CL keeps the ends open for climb edges only (byte identity). Fixing it for every edge may route edges that fail today:
  a small slice of its own, with the fixtures it moves named.

## Queued from the theme rule (CL theme fix, 2026-10-24)

The structure lint's S-THEME rule (Noah: "everything should be themed / fit") found these writers using blocks no role gives. Each is
a known exception in `kit/lib/lint/theme.mjs` `THEME_KNOWN` (recorded, not gated) until its fix lands:
- **T3's tunnel lamp** (`connectors/tunnelGeom.mjs` flush light): a light role that can't sit flush in the lining (a lantern) falls
  back to glowstone. Use the nearest role with a full-block emitter, or a lantern in a niche. Hits crossings_demo, tunnel_hill, the
  tunnel p0 fixtures and the even-width tunnels.
- **route_demo's lamps** (`kit/regions/route_demo.mjs`, `fixtureFor('minecraft:soul_lantern', ...)`): read the light role instead. The
  soul lantern's level 10 sets the lamp spacing, so the route_demo goldens re-cut.
- **forms_demo's lamp posts** (`kit/regions/forms_demo.mjs`, a spruce fence and a soul lantern): W's fixture for the light and rail
  roles. The forms_demo golden re-cuts.
- **HY-c's water-gate grate** (`fluids/gate.mjs` `GRATE_STATE`, iron bars): functional (still water passes, mobs don't). Either
  allow it as functional, or take a bars or pane role when the bible names one.
- **VOC-c's no-wood swaps** (`plan/palette.mjs`): an iron trapdoor on planters and an iron door in wall gates. The rule's own choice;
  a bible with a metal role could name it.

## UI track (Noah, 2026-10-24; audit notes in the coordinator's scratchpad, summarised here)
Decisions: pickers are FULL-SCREEN browsers where it makes sense (search, family rail, swatches or preview sheets, detail pane), built to grow later (favourites, tags, compare); inline they are compact chip rows (current + recents + "more…"). UI-1 and Steward's UI-3 fixes start now, alongside 7a. Mock APPROVED by Noah 2026-10-24 (https://claude.ai/artifact/6ZC5ktBTis9Y6xDPoeHN4j): compact row max 4 chips, rail/grid/detail browser, preview in the detail pane (world-ghost preview later), form opens Basics + Palette, Features/Rules/Parameters closed with counts. Rebindable placement keys deferred.
- UI-1 (lab-ui 0.2.0): tokens, Button/Chip, ScrollList, ChipRow +N, CollapsibleSection, Tooltip, EmptyState, Confirm, CompactPicker + PickerScreen, ChatPager; TextFieldView/TextModel/Toasts moved in.
- UI-2a (Architect): palette pickers (roof 36, stone 35, wood/accent 13), bible/style picker, design form (folding sections, scroll body, pinned footer), searchable Type/Tag/Collection/Bible/Import popups, Variants scroll, library detail Place/Edit/⋯ with Delete behind Confirm.
- UI-2b (Architect): paged chat lists (list, reload, build list, stockpile list, batches, groups, history, unknown-design error), clickable Undo on "Placed", placement HUD state chips + "?" legend + visible force-armed + icons instead of colour words, one progress strip, quieter launcher (debounce ready, plain errors), one colour palette.
- UI-3 (Steward, its own slice): dead toasts, inbox lines/terminal rows, Describe-again keeps words, Enter-to-start confirm, capped part offers with plain copy, allowance chips; card compaction, buildings filter/grouping, board ordering on 0.2.0.
- Later: rebindable placement keys (Esc opens pause when not placing); a terms glossary (design/blueprint/site/build/crate/stockpile).
- UI-2b terms (the wording pass on the strings it touched; UI-2a and UI-3 follow them): **design** = a building in the Library (never "blueprint" in player text; `Blueprint` stays the code name); **site** = a design placed in this world, and **construction site** = a site still building in survival; **build** = only a tracked player build (`/architect build`, the API's `Build`), never a placed design; **crate** = a construction site's supply crate, **stockpile** = the shared store of crates. The sidecar is the **design helper** in player text. Not renamed: API Reason text, `dev.*` hook names, existing messages outside UI-2b's scope.

## Queued (coordinator, 2026-10-24; Steward ask)
- DevBridge `dev.key`: send a key release after the press, like a real tap, with an optional hold time. Steward's card Start now needs two presses and counts a held key once; a press with no release lapses after 3 s, so it works today but isn't exact. Small; batch it with the next tooling slice.

## Style unification (Noah, 2026-10-24): replaces the form half of UI-2a
Model in docs/STYLE-UNIFY.md. Mock approved: https://claude.ai/artifact/F5rfEVgeErTArWfQiL76F9. Noah's decisions (the recommendations):
1. Built-in and hand-made Styles go to the generator **materials-only** (a new `DesignRequest.palette` with roles); `bible` set mode stays for Claude-made Styles and sets. U4's A/B confirms this.
2. A custom mix on a new design is **sent inline**; nothing is saved until "Save as style…".
3. The word-only style chips get authored materials and become built-in Styles: all six, Medieval, Nordic, Japanese, Cozy, Fantasy and Modern (coordinator, 2026-10-24: flat roofs already exist as kit.mjs roofFlat, so Modern gets a stairs-capable roof role and a flat `roofLanguage` shape hint).
4. The main rows stay **Wood / Stone / Roof / Accent**, each showing what it drives.
Slices: U0 kit (S), U1 wire + Steward review (M), U2 StyleForm model with Java/JS parity (M), U3 the unified editor + Style browser + Style editor on lab-ui 0.2.0 (L), U4 the materials-only vs bible A/B judged by design-critic (S). UI-2a's form and picker work is folded into U3.

## Queued (coordinator, 2026-10-24; found by Steward)
- lab-ui composite build: when ../lab-ui is a clean checkout exactly at the consumer's lab_ui_version tag, settings.gradle includeBuild()s it, and the substitution exposes only lab-ui's main source set, not its split client set, so `dev.larattalabs.labui.client.*` doesn't resolve. The same rule exists in Architect, Steward and AgentCraft. Fix in lab-ui (publish the client classes in the composite's variant) or in the shared rule. Workaround: -Plab_ui.dir=none. Also resolve lab_ui 0.2.0 into main's .gradle-home online once when UI-2b merges, so offline builds don't depend on the checkout.

## Queued from slice D3 (builder, 2026-10-23)

- **0.42.x note (main's since C23, fixed on slice/D3):** a region removal refused by the owner rule, or stopped before it wrote
  anything, ended the region PARTIAL with nothing removed. D3 now leaves it as it was and logs the reason (CONTRACT D3 as built,
  "Steward's RC").
- **gate6cx's api-compat under the frozen-source runner** finds every reference missing (no compiled classes in `<run dir>-src`);
  gate6cd3's apicompat compiles first (srcGradle). Worth the same in gate6cx.
- **`Prepare.chunksOf(claim)` misses a third chunk** for an edge tile's window off the 64-grid: a region realised in never-generated
  land after a prepare can wait NOT_GENERATED on its edge tiles (CONTRACT D3 as built).

- **Reach as a list (coordinator's ruling, D3).** plan/0's `endpoint.region` allows one standing region's reach per check; a second
  that needs the reach answers `NO_FEATURE {why: reach, kind: second}` (CONTRACT D3 §8 allows 2). The IR's `reach` is one member;
  making it a list touches the evaluator (`compileReach`), M28:beside, the land, the mod's re-check, TileCheck, Drift and Prepare.
- **A T on a diagonal or turning street** (D3's deferred list): side junctions only on axis-aligned runs of 9+ cells today.

### Queued with "use an existing Style" (Steward's U1 RC, 2026-10-24; not U1)
When Steward's settlements design with an existing Style, a settlement pins a player's Style version outside Architect. That
feature ships with a keyed `Bibles.pin(id, version, owner, key)` / `unpin(...)` (like `pinArtifact`). The version GC skips any
version a mod has pinned, and `bible.delete` refuses it, as it does for an entry's pin.

## UI/UX roadmap additions (Noah, 2026-10-24)
- **Now:** U3 also covers the Library screen, the rest of the old UI-2a: a grid with more rows; detail as Place / Edit / ⋯ with Delete behind Confirm; searchable Type, Tag, Collection and Import pop-ups; job progress visible from the Library; massing approval by mouse too; and no dead ends. The Library and the editor are designed together.
- **Now:** a nightly UI gallery. The nightly captures every Architect screen and HUD state at GUI scale 2 and 4 into artifacts/nightly/<date>/ui/. The coordinator runs design-critic over them in the morning review (no API key in the nightly). It reuses the UI-1 and UI-2b screenshot drivers.
- **Next, after U3:** a shared Jobs & spend panel across Architect and Steward: what's running, cost so far, usage-limit holds, what needs you, with links into either mod. Then safety on big actions: confirm before placing large builds (threshold) and before `/architect remove`, and an undo hotkey.
- **Before anyone else plays ("player-ready" pass):** first-run guidance (a guided first build, "?" keys, a one-line "what's this" per screen) and an accessibility pack (colour-blind-safe ghost palette, text-size option, rebindable placement keys).
- **Steward (after its district move and lab-ui 0.2.0 pass):** the talk log persists, the start takes fewer steps, the settlement screen gets keyboard navigation, a map legend, and a note for older building history.

## In-world interfaces (Noah, 2026-10-24): keep them in step with the screen work
- **Now:** the nightly UI gallery also captures the in-world pieces: the placement ghost's categories, the region ghost and its HUD, plot markers, and the survival crate. Steward's free e2e already shoots its own in-world pieces.
- **Now:** the one-term wording (design / site / construction site / crate / stockpile / design helper) also applies to in-world text: Steward's board cards, building labels and bubbles, and Architect's ghost and region labels.
- **Soon, lab-ui 0.3 (small slice, before U3):** semantic on-dark/in-world colour tokens, so HudInk becomes aliases and WorldUi, the board, plates and bubbles use one palette; and shared HUD zones (top-centre status, top-right toasts, bottom-centre placement, …) that both mods register into, so their HUD pieces never overlap.
- **In the accessibility pack:** a second cue besides colour in the world: ghost categories by outline style or marker icons, and a glyph beside the nameplate status dot and the map colours.
- **In the Jobs & spend panel design:** one shared state for "needs you" and spend, read by the panel, Steward's board and the nameplate alike.
- **After U3:** "Preview on ghost" in the Style browser: show the current design as a ghost in the world, wearing the hovered Style.

## U3 look approved (Noah, 2026-10-24)
The unified Design editor, the Style browser and editor, and the Library screens (gallery https://claude.ai/artifact/SchCjqK9aDRvcnnhTZbezi) are approved as built. Next in the Style unification: U4, the materials-only vs bible A/B (paid; needs Noah's spend approval).

## After U4 (Noah, 2026-10-24)
U4 (materials-only vs bible, $10.67): bible mode scored a bit higher on fit, but every built-in borrowed rustic's components, so variety dropped. The fit gain likely comes from the Style's shape hints. Noah's decisions:
1. **U5a (now):** the default for built-in and hand-made Styles is materials-only PLUS the Style's description, roof language and proportions as guidance in the brief. No shared components, no "follow it over your taste". A Style never borrows another Style's (rustic's) components.
2. **U5b (now):** support for adding parts (components) to any Style. A "Add parts…" action drafts a component set for an existing Style (a Claude bible job seeded from the Style, as a new version), plus a per-design "use this style's parts" option, available only when the Style has its own parts (set mode). Medieval's main wall moves off white terracotta (renders salmon) to a whiter block.
3. **Then:** author parts for the 15 built-ins without them (paid, about $20-40; confirm the cap with Noah first), then one A/B: hints vs parts-bible.

### U5 (slice/U5, built 2026-10-24; ready for review)
U5a and U5b as in CONTRACT "Style unification U5 (as built)". Decisions for Noah and the coordinator:
- A built-in's parts go on a hand-made copy (`bib_<name>_parts`), not a built-in version. The 15 then get authored parts by
  promoting copies' `components.mjs` into `kit/bibles/<id>/` (as rustic's).
- "Add parts" costs at most $1.16-1.55 per Style (the bible-job seed; no drafting pass), so at most about $17-23 for the 15.
- No Steward RC (additive; Steward's Claude bibles keep set mode).

Queued from U5:
- (a) the Style's hints on a massing request (Massing first gets them only at the detail pass);
- (b) cozy's plaster is white_terracotta (the same salmon);
- (c) parts jobs get their own estimate kind once measured;
- (d) a promotion tool for authored built-in parts.

### Built-in parts + A/B (chore/builtin-parts, 2026-10-24, PAID $18.39 of $40; CONTRACT "Built-in parts")
- (d) done: `tools/builtin-parts.mjs` (jobs, check, promote). All 15 built-ins got parts for $6.33, then were approved and promoted
  into `kit/bibles/<id>/`. Every built-in now has its own parts. The component check and the brief follow S-THEME, and rustic's
  campfire is gone.
- A/B (hybrid vs own parts, $12.07): own parts won 5 of 6 pairs, with fit 4.00 vs 3.50, quality 3.83 vs 3.00 and variety 4 vs 3.
- **For Noah:** default "Use this style's parts" on for every built-in (recommended), or keep it off. Decided 2026-10-24: **on** (`fix/parts-default-on`, CONTRACT "Parts default on for built-ins").
- Queued: japanese's set-mode accent share (R1B 0.171) is worth a look; parts jobs have their own estimate kind now that 15 are
  measured ($0.25-0.72, 1-3 min; the estimate said at most $1.16-1.55).

## Jobs & spend panel (Noah, 2026-10-26)
Design in docs/JOBS-PANEL.md; mock approved: https://claude.ai/artifact/VPc1AcQBiLSiznsaWc4JLF. Decisions (the recommendations):
1. Steward's Y inbox stays the deep decision screen; K is the cross-mod overview panel.
2. K is the key (check it against the 26.3 defaults).
3. The spend total covers today, in dollar estimates labelled "estimate".
4. A steward's idea does not light the nameplate "!"; "!" means blocked on you. Ideas show in the panel and the HUD pill.
Slices:
- J1, lab-ui 0.4.0 (M): JobBoard registry, the panel screen, the shared needs-you pill in TOP_LEFT, the K key registered once.
- J2, Steward (M, parallel): a server-side Attention single source for the inbox, nameplate and board; the usage-limit reset as a number; an agreement test.
- J3, Architect JobFeed (S): after J1.
- J4, Steward publishes its rows (S): after J1+J2.
- J5, toast refs plus gallery shots (S).

## Queued (coordinator, 2026-10-26)
- The Status tab's right column runs off the bottom at GUI scale 4 (the "Critique and revise" row is clipped); found by SAFETY. Make the Status tab scroll, or fold its sections, with the lab-ui ScrollList/CollapsibleSection.

## Feature order (Noah, 2026-10-26): interleave growth with 7a
The plan is in docs/NEXT-FEATURES.md. At most 3 gate lanes at once.
- **Wave 1:** RV (6d additive revisions: RV-a, then RV-b), SA spiral stairs, RK rock stairs. Noah approves the SA and RK looks.
- **Wave 2:** the rest of RV, then GR (growing a standing region), LF lifts, K3 towers and gatehouses. Noah approves a grown street, new-lot placement and the castle.
- **Wave 3:** GJ walled-town gate join, FB flood warning. The GM (fancy gates) contract is drafted alongside; GM is built after K3 and GJ.
- **Then:** FS, LC, AD.
- **Deferred:** the nav slice (seconds/risk/nav.json/steward mover) waits until Steward's villager phase asks. M8 fall protection as an error is decided at FB from its count.

## Steward's GR review (2026-10-26; steward-mc docs/ARCHITECT-ASKS.md "GR review"): folded into GR
- S-GR-1 to S-GR-5 and S-GR-7: the defaults are OK. A growth that a later district joined gets the NOT_ALLOWED "joined" reason.
- S-GR-6: no dry growth check needed (planRevision plus discardPlan covers it).
- Fixture correction (gr_beside, item 5): Steward has no dplan/dgrow keys. Each build plans and realises under steward.<buildId>.vplan / steward.<buildId>.vrealise (.vrealise2 after a stale re-check), and both carry ext steward_mc:district=<id> and steward_mc:build=<buildId>. The first building plans with Regions.plan beside the town, with a claim of the reservation plus 16 columns into the town's claim. A growth is an ordinary Steward build with the same key scheme.
- Ask 1: a growth's realise names its revision id, and EVERY site it wrote (buildings, lanes, street pieces, not only lots via LotState.revision) is identifiable as that revision's. Steward logs one history entry per growth and undoes it with undoRevision. RV should carry the revision id on realised sites.
- Ask 2: confirm land.outside shrinks after undoRevision (§7), so Steward can recompute its saved land.

## Looks approved (Noah, 2026-10-26)
- SA spiral stairs (gallery https://claude.ai/artifact/R6FS7zxuvCLBX9ei1Vwq13): approved.
- RK rock stairs (gallery https://claude.ai/artifact/APuLywy7CL3FY976oPMt6B): approved, with the parapet copings and the plateau end fixed before merge.
- LF lifts (gallery https://claude.ai/artifact/DSfY1N32us1YRUa3vLJNTL): approved (2026-10-27).

## GM contract notes (Steward, 2026-10-27), to fold into the GM contract before it builds
- The mechanism envelope is merged into the lot's existing `DesignRequest.Reserved` entry in the artifact (Steward option a: zero Steward change). For the design, the envelope cells are hard "never write", like the existing set; only Architect's region writes the mechanism blocks.
- "Add a portcullis to a standing gate" stays a reserved follow-up through Steward's versionOf/revision change-request path (not ruled out).
- Rest state open by default suits Steward (a settlement shouldn't wall out its own steward). Steward un-reserves connector.drawbridge in the GM RC.

## GM decisions (Noah, 2026-10-27)
1. **A proper lifting portcullis, not the sliding split grate.** The bars (the style's fence/bars role, with iron bars as the functional fallback) hang as one 3-high grid across the passage and lift straight UP into the gatehouse's winch room above the lintel. Mechanism: Java vertical piston extenders (one per column, tileable side by side), hidden in the winch room and needing at least 4 clear cells above the lintel; the K3 gatehouse's GM envelope grows to fit. The 1-block-per-piston limit is why this needs extenders, not plain sticky pistons. gm-probe must prove the extender on the running 26.3 server (20 open/close cycles, no dropped bars) before the slice builds on it; if it can't be made reliable, stop and report rather than fall back silently. Research note: the classic vanilla portcullis (a GameSkinny guide) is a 3-high gate on sticky-piston rows with timed repeaters; extenders are Java-only and timing-sensitive, hence the probe. This was GM-lift (about +1.5 days); it's now the default portcullis.
2. **Rest state: open by day.** A daylight sensor on a sky-exposed cell the gatehouse design gives (roof or crenel) drives open by day and shut at night. Controls at BOTH passage ends (a lever inside and outside; mobs can't flip levers) let a player open it at night, or close it by day. The contract specifies the logic: the daylight sensor sets the default, the levers override it, and there is a clear rule for which wins and when it resets (e.g. an override holds until the next dawn/dusk change). Villagers pass by day; a closed gate at night is player-only (MOVER).
3. **Drawbridge:** the flipping iron-trapdoor deck (GM-c).
4. **K1 wall gates** get the iron swing door pair too (GM-b).
Steward's notes from the section above apply: the envelope is merged into the lot's reserved set (never-write for designs), and the retrofit is a follow-up.
- GM day cycle (Noah, 2026-10-27): storms may close the gate. A daylight sensor reading lower in rain or thunder by day is accepted (N-GM-2 answered: storms close it).

## Coordinator handover and the v0.48.0 batch (2026-10-27)
- New coordinator session took over from "AgentCraft Mods". GR merged (970de3bc) after Steward's RC PASS; LF and K3 follow their RCs, then v0.48.0 (API 1.43.0, kit 0.44.0, catalogue 15).
- **GM gatehouse box (answered, docs/gm-contract 9b64bbf9 §4):** Steward designs wall gatehouses; every `onWall` lot has an exact `fitBox` sent as-is (no approach margin, no MIN_XZ = 7 clamp); 11 x 3 x 9 is the mechanism minimum, not the box.
- **K3 RC needs Steward's K3 adoption slice (k3-rc):** exact boxes for onWall lots, tower/gatehouse types, the passage as reserved, the closed-faces brief line plus the outer faces named in words, ARTIFACT_STALE "lot on wall" routed to a per-lot versionOf repair (2 rounds). Architect added the sim stand-in for wall lots and `sim:outerdoor` on slice/K3 (f91b4696); Steward passes `ext["architect:wallLot"].outerFaces` (corner towers need it).
- **GR follow-up (queued):** a growth's NO_ROOM `[street]` from the extension hides the real blocker (a wall part in the verge, a slope, or a reach shorter than the lot's width); name it. Seen on Steward's walled survival town "Supply Walls" (correct refusal until GJ).
- **Queued for Noah after v0.48.0:** a lot realise waits with no time limit on OCCUPIED (animals) or PLAYER_IN_BOX; Steward's e2e stalls were these. Consider a time limit or pushing animals out.
