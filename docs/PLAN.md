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
- **Risk-tiered gates** (docs/GATES.md):
  - change: unit tests plus mapped steps;
  - slice: quick plus affected steps;
  - release: the full chain plus the full independent gate-verifier, overnight and unattended.
  Duplicate heavy checks rotate at release, and routine tiers use mega-lite. Per slice, the verifier reviews the evidence and
  re-runs only the risky steps.
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
