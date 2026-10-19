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

- **Done (housekeeping 3): not code, not re-pinned.** Pre-existing and state-dependent: the same head fails and passes (PT-verify vs PT-bisect2 at 95e3cd5c, 2026-10-13); at aac5f588+ a fresh client run dir passes (sha = golden, `artifacts/gate-runs-hk3/20261019-195353-change`), a fresh headless one fails (572271bd, `gate-runs-hk3-exp/20261019-195821-change`), and a client run in that same dir passed once its bases were rebuilt (`gate-runs-hk3-exp/20261019-200831-change`). The cause is a base world made by the headless server (PT's level.dat finding), which the base stamp didn't tell apart: its recipe now carries the host (`basestamp.mjs` `gateHost`), so a base made by the other host is quarantined and rebuilt. The 5904-5907 frozen count (item 6) varies per run on one host; it is recorded only. No bisect was needed. ~~**w-ingame's s1_floating_islands golden fails on both hosts**~~ (sha 572271bd vs 3e5bd5b7), and its survey differs by host
  (5906 vs 5907 frozen-water columns). Confirm on main whether this is pre-existing, then re-pin or fix.
- **Done (housekeeping 3): harness, both.** (1) NOT_ALLOWED: the client reused a `G6B Y Survival` base the headless server had made in the same run dir (no cheats for the integrated server); the base mark now records its host and the other host rebuilds it (a client run in a dir a headless run had used: `store` 103/0, `gate-runs-hk3-exp/20261019-200831-change`). (2) The feed order: headless opened the survival world by name with the host's creative launch spec, so the dedicated server's default game type was creative and AUTO placed the batch road INSTANT (BUILT at once, never in the feed order, never paid: `once` then threw on its missing `paidByTarget`). `tools/lib/server-host.mjs` now opens an existing world in its own level.dat game mode, as AutoWorld does; and `store` accepts a target out of the feed order only when it is already BUILT (the API's list), judging the order over the rest. ~~**y-ingame:**~~ the client fails `store` with NOT_ALLOWED (instant placements need permission level 2); headless misses one
  target in the feed order. Investigate both before moving it to headless.

## Queued from the H batch integration (coordinator, 2026-10-19)

- **Done (housekeeping 3):** both re-cut for kit 0.35.0: only the IR's kitVersion moves. Verified: `kit/tools/region.mjs plan` over each golden's committed survey, params, seed and claim writes an ir.json byte-identical to the golden with only `kitVersion` bumped (and links_demo's one blob identical); every tile sha and the cell counts unchanged, 1 worker = 4 (links_demo 151,293 cells, 16 tiles, irSha 0088689a; links_demo_flat 38,383 cells, 6 tiles, irSha 81f39293). ~~**links_demo and links_demo_flat goldens are at kit 0.34.0.**~~ crossings_demo_flat was re-cut for 0.35.0 (only the IR's
  kitVersion moved). k1b-ingame compares links_demo_flat's IR sha, so re-cut it the same way (bump `kitVersion` in its `ir.json`,
  recompute `tileShas`, confirm tiles and cells unchanged) before the release tier.
- **Done (housekeeping 3):** the pattern was present in both (a 2- or 4-wide deck or bore running +z or -x stood one column off its walk, with no checker finding) and in the route's tunnel move's fast check. `latOn` moved to ropeGeom.mjs (bridgeGeom re-exports it) and is used by checkSpan, ropeCells, surfaceCover, tunnelGeom and the move's fast0. Fixtures `kit/test/fixtures/plan/even/ew01` (rope) and `ew02` (tunnel) run both ways on both axes, widths 2 (and 4 for tunnels): the deck's and floor's first and last rows equal the walk footprint's, M3/M4/M5/M6/M8/M10 clean, the player through the bore (`even-width-hk3.test.mjs`; both fail on main). Kit output changed for those inputs (no KIT_VERSION bump; the coordinator decides): v33's and v34's +z villager bridges moved onto the route's side (named exceptions in gate6ch-core's `UNCHANGED_EXCEPTIONS`, which t3a's `unchanged` now reads too; the stale r06/r07 left the list), and links_demo's nodes moved one column west so its decks stay on the same columns: its goldens' tiles, cells and blob are unchanged, the IR's graph, anchors and programSha moved (irSha 0e2f62f6, flat e803baaf; item 4's kitVersion-only re-cut was its own commit before this). ~~**The even-width lateral rule elsewhere.**~~ The H batch put a bridge deck's extra column on the route's side (bridgeGeom `latOn`:
  the route's `footprintOf` takes +x / +z). `ropeGeom.mjs` and `tunnelGeom.mjs` still use `lateral(width)` along `rightOf(dir)`, so an
  even-width rope bridge or bore running +z or -x stands one column off its walk too. Check them with a width-2 fixture.
- **Done (housekeeping 3):** retired. hb-unchanged ran H-core's `unchanged()` again and additionally required r06/r07 to differ; with H on main they plan the same (checked: 58 same, 0 differ but item 3's named v33/v34). H-core's item 11 (h-unit) and ha-unchanged already judge "only the named exceptions may differ" from `UNCHANGED_EXCEPTIONS`. ~~**hb-unchanged after the merge.**~~ H-b's item 11 still requires t3a/r06 and r07 to differ from origin/main. Once H is on main they
  won't, so relax it to "only the named exceptions may differ", as H-core's `unchanged()` (`UNCHANGED_EXCEPTIONS`) already does.
- **Done (housekeeping 3):** apijars runs the 0.37.0, 0.36.1 and 0.36.0 jars (API 1.34.0, 1.33.0, 1.33.0), each with its tag's `tools/apitest.mjs` and its own world (G6A Jar0370/0361/0360); v0.37.0 built from its tag (aac5f588, sidecar bundled) into `artifacts/gate6c-h/v0370` beside the H batch's v0361 and H-core's v0360. ~~**apijars over v0.36.1.**~~ `gate6a.mjs` apijars still runs the 0.36.0, 0.35.0 and 0.34.0 jars; api-compat `--gate6ch` now uses
  0.36.1 (built from its tag into `artifacts/gate6c-h/v0361`). Add 0.36.1 to apijars (with its base world) at the release tier.
- **6ct1-scenario-relief's falling water** (H-b's slice run): 2 unclassified falling-water cells far from any H part under the
  narrowed `flow` class. Re-check at the release tier; widen the class or record the cells.
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

## Queued from the H RCs (coordinator, 2026-10-19)

- **Done (housekeeping 3):** ha-ingame's new item `ha-farm` (tools/lib/gate6ch-a.mjs) runs v49 and Steward's hamlet (now `kit/test/fixtures/plan/h/farm_hamlet.json`, read by h-batch.test.mjs too) through Regions.checkPlan and realiseApproved on fresh flat worlds at exact rules: PLACED after the bodies settle, each farm pond's census equal to its prediction, M25/M20/M17 0, Regions.remove E-flat 0 (`artifacts/gate-runs-hk3/20261019-200831-change`: v49 2 ponds, 351 written, 433 restored; hamlet 1 pond, 281 written, 369 restored). The other body kinds already went through realiseApproved with an exact undo: pond, pool, lava pit, fountain, waterfall and moat in ha-exact (water_demo, E-flat 0), quay, wet-pier beam and harbour wall in hb-flat (h-ingame). ~~**No in-game step realises an approved plan with a farm pond.**~~ Two farm-pond bugs (lots typed `farm` without `villager`,
  nested guard runs) reached Steward's RC check because our steps only checked such plans. Add a `realiseApproved` round
  for v49 and Steward's hamlet (type-implied farm lot) to ha-ingame, and generally: every H body kind should go through
  realiseApproved at least once in game.
- **Done (housekeeping 3, mod 0.37.1 placeholder):** `PlanChecks.guardMalformed` checks every guard before any survey (an object; `volume.sha` a string, `volume.box` 6 integers; `runs` a flat integer array, a whole number of quads) and answers ARTIFACT_STALE "guard N (<body> of <part>): the artifact's guard is malformed (...): check the plan again"; `PlanChecksHTest.malformedGuards`. ~~**Guard reader robustness:**~~ `PlanChecks.guardDiff` throws Gson's "Array must have size 1" on a malformed `runs`. Validate the
  shape and answer a clear error instead.
