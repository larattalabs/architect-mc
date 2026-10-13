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

## Status

- [ ] API, Builds, capture, kit adopt.mjs, journal, un-adopt, deltas, refusals, sidecar, hooks, gate, docs.
