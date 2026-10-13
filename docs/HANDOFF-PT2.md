# HANDOFF: slice PT2 (adopt a build as a site)

Branch `slice/PT2`, worktree `../architect-mc-PT2`, from origin/main b8a8908 (v0.27.0 / API 1.24.0). Placeholders: API 1.28.0,
mod 0.31.0, kit 0.29.0 (the coordinator renumbers at merge). Ports 8924-8929. $0 (sim only). Contract: docs/CONTRACT.md "Phase 6c
slice PT2"; its "Changes from Steward's review" and "Coordinator decisions" win.

## Assumptions checked against the Java (2026-10-13)

- **0.27.0 and an `adopt` journal entry:** kept, but misread: `SiteJournal.main()` takes it as the main entry, `Sites.reconcile`
  rebuilds a lost record of a non-`site` main entry as an Infra, and a 0.27.0 remove runs the BOX undo (writes every `before`
  over the player's later edits; its writer scope clears every PT record). Decision: files holding an `adopt` entry are written
  as journal file version 4 (0.27.0's `known()` refuses it, 4e's downgrade rule, PT's v3 precedent); every other file unchanged.
- **3-pass capture:** `ChangeTracker` + re-read; captures over 50,000 cells are sliced; unit-tested settle loop.
- **`free` bitset:** not needed. An adopted site has no construction record; `Builder.paidCells` of such a site is empty, and a
  survival delta's queue holds only its own cells.
- **before == after:** harmless on disk, wrong on undo (BOX writes `before`). Un-adopt never plans an undo of the adopt entry:
  the deltas above it are undone, then the adopt entry is released.

## Deviations so far

- Entry id `adopted_<8 hex>` (the kit and the sidecar require `[a-z0-9_]+`).
- Blueprint JSON: `source` keeps the `.mjs` file name (Blueprint.java, Views, Wire0b read it); `sourceKind: "captured"` marks a
  captured source.
- `builds.json`: an adopted build is written `state: <priorState>` plus `adopted {site, prior}` (0.27.0's `BuildState.valueOf`
  would throw on `ADOPTED` and drop the rest of the index); the new reader maps it to `ADOPTED`.

## Status (2026-10-13)

- Built: API (adopt, adoptedSite, AdoptResult, Build.siteId, BuildState.ADOPTED, Reason.ADOPT_REFUSED, SiteEvents.ADOPTED,
  DeltaVerdict/EntryVersion capturedChanged/capturedTotal, feature `adopt`), `site/Adopt.java` (checks, capture with a sliced
  3-pass path, entry files, site record, the adopt journal entry as v4 files, un-adopt by remove, load-time repair), Builds ADOPTED
  rules (never demotes, survives merges, no merge of two adopted, a release refuses), implicit consent for the site's own cells,
  the adopted base in SiteCells/beforeMap/reconcile, deconstruct restricted to the deltas' cells, placed_elsewhere, the library
  delete refusal, kit `lib/adopt.mjs` + checker relaxations for captured sources, sidecar adopted_polish and `adopted` carried by
  versionOf's install.
- Tests: kit `adopt-pt2.test.mjs`, sidecar `adopt-pt2.test.ts`, Java AdoptTest, JournalAdoptTest, BuildsAdoptTest, ApiPT2Test.
- Gate: `tools/gate6cpt2.mjs` (unit, refusals, adopt, flow, undoA, survival, protect, states, elsewhere, old027, report);
  gate-chains `pt2-unit`, `pt2-ingame`, `pt2-survival`. Runs under `artifacts/gate-runs-PT2/` (run dir `../architect-mc-PT2-run`,
  ports 8924:8925). `GATE6CPT2_STEPS=a,b` picks in-game steps. 0.27.0 archive: `artifacts/gate6c-pt2/v0270` (its worktree
  `../architect-mc-PT2-v0270`, also used by `old027`).
- First run: unit and adopt (items 2, 3) pass.
- Next: flow, undoA, elsewhere, refusals, protect, states, survival; then the slice tier, the verifier, the as-built.
