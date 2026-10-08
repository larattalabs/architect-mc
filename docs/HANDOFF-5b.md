# Phase 5b handoff (delta apply and polish)

Working notes for resuming phase 5b after a pause. Deleted only when the delta-apply gate passes.

- Branch `phase/5b` (worktree `~/Developer/LarattaLabs/architect-mc-5b`), from main 09a4a38 (v0.9.0 / API 1.6.0, 5b contract frozen).
- Spec: docs/CONTRACT.md "Phase 5b contract" (its last section, "Changes from Steward's review of 5b", wins; then "Coordinator
  decisions": N1 $80 cap / $100 ceiling, N6 paid survival revert).
- Evidence (local, not committed): `~/Developer/LarattaLabs/architect-mc/artifacts/gate5b/` (spend.json, REPORT.md, per-step JSON).
- Do not merge, tag or publish. Claude login only; never an API key.
- Ports: 8890/8891 the 5b gate client, 8892/8893 the 0.9.0 client, 8894/8895 the eval sidecar. Kill only processes we
  started, by PID.

## State

| Step (contract build order) | Status |
|---|---|
| 0. Baseline (09a4a38) | kit 126, sidecar 536, mod 339 tests, all green |
| 1. F1 sidecar-bundle guard, F2 USER/LOGNAME | DONE (mod: F1, launcher env; sidecar: loginenv.ts, the auth message) |
| 2. Kit frame, parts.nbt, diff.mjs (scope), fixtures; round-0 rebuild tripwire | DONE (merged from phase/5b-js): frame + `<id>.parts.nbt`, `kit/tools/diff.mjs`, `kit/lib/rebuild.mjs`, tavern versions `kit/test/fixtures/versions/tavern/v1..v5`, `node kit/tools/delta-fixtures.mjs --out <dir>` (31 pairs); tripwire 18/18 + 4/4 byte-identical (`artifacts/gate5b/round0-rebuild.json`) |
| 3. Sidecar entry versions, critique.json format 2, entry.* messages | DONE (merged): `sidecar/src/versions.ts`, criticHash = 5a's provenance hash, `entry.versions/delta/revert/pins`, `entry.versioned` |
| 4. Mod TemplateDelta, delta apply, revert, fold, crash points, survival, queue/stages, preview, UI | DONE: TemplateDelta (kit equality test, 31 pairs), EntryVersions, SitePlanner, DeltaPlanner (E1-E7 property tests), SiteDeltas (check, D1-D8, suffix revert, forward delta, fold at 6, settle), DeltaJob (> 50k cells, ticked), batch delta items + delta stage undo, delta ghost (KEPT), construction deltas (survival), UI (Placed view Update/History, Library Compare/Revert/Polish) |
| 5. Polish on the sim backend | DONE (merged): `sidecar/src/polish.ts` (prompts DRAFTS in `claude/polishprompts.ts`), `tools/eval.mjs import-round0`, `run --arm polish --from`; Java side (Designs.polish, entry.versioned, entry.pins) DONE |
| 6. Java API 1.7.0, api-compat (1.6.0 and 1.5.0 jars) | DONE: api-compat clean (1.6.0 jar 543 refs, 1.5.0 jar 466, 0.9.0 surface 1281, 0.8.0 surface 1088), `artifacts/gate5b/api-compat.txt`; apitest 1.7.0 steps |
| 7. Gate items 1-5, 8, 9 ($0) | item 1: tests green (kit 143, sidecar 577, mod 354). item 2: smoke, e1 pass; chains (12-op script + 20 seeds) running; edits, layers, crash, history, ghost written, not run. item 3: survival step written, not run. items 4-5: village and sizecap steps written, not run. item 8: F1/F2 checks pass (no-bundle Status screenshot TODO). item 9: eval sim tier + rescore byte-identical, polish sim arm run (`artifacts/gate5b/regress/`); in-game suites TODO |
| 8. Polish prompt development (cap $20), freeze, smoke, full, other real checks | not started (dev candidates: gate 2 `gen_gate_two_house`, 4b `gen_fisher_cottage`/`gen_lookout`/`gen_net_and_lantern`, 4c `gen_gull_and_kettle`; gate 1 ids to confirm from gate1/REPORT.md; $0 verifyRebuild first) |
| 9. Docs (CONTRACT as built, PLAN, README, DEVBRIDGE) | not started |

Gate steps: `node tools/gate5b.mjs <step>` with steps smoke, e1, chains, edits, layers, crash, history, ghost, survival,
village, sizecap (evidence in `artifacts/gate5b/<step>.json` / `.out`).

Notes: `test/bundle.e2e.test.ts` (4c massing group) failed once under load (the game client running) and passes alone.

## Spend (API-equivalent, claude login, cap $80, ceiling $100)

| What | USD |
|---|---|
| **total** | **0.00** |

The ledger of record is `artifacts/gate5b/spend.json`.

## Pinned cross-language formats (kit, sidecar, mod)

These are fixed before the work splits; the kit, the sidecar and the mod each read the others' files.

**Frame.** The blueprint JSON always records `frame: { origin: [ox, oy, oz] }` (kit from 5b on; missing = `[0,0,0]`).
Template coordinate `t` (the cell's `pos` in the `.nbt`) = design coordinate `d` + `origin`. Two versions are compared in
design coordinates.

**`<id>.parts.nbt`.** Gzip NBT root compound `{ names: list<string>, idx: int_array }`. `idx[i]` is the part of the i-th
compound of the `.nbt`'s raw `blocks` list **in file order** (the kit writes them sorted y, z, x after `finalize()`), -1 = in
no part, else an index into `names`. Readers decode the raw `.nbt` list themselves (vanilla `StructureTemplate.load` re-sorts
blocks). If `idx` length differs from the `blocks` list length the map is ignored (approximate labels, below). The map is
taken from the finalized cells (`cellPart` after `finalize()`; `set()` outside a part clears the cell's part). Writing it must
not change a byte of the `.nbt`.

**Cell values.** A cell is a written block (every compound of `blocks`, air included). Its value = the palette entry's block
id (key `id` or `Name`) + its properties (key `properties` or `Properties`), compared as a sorted map of strings, + the
block-entity compound (`nbt`), compared structurally (null = none). `added`: only in B; `removed`: only in A; `changed`: both,
values differ; `unchanged`: both, equal.

**Approximate labels** (no usable parts.nbt): from the blueprint JSON `parts: {name: {box: [x0,y0,z0,x1,y1,z1]}}` (template
coordinates): a cell's part is the part whose box contains it with the smallest volume; ties go to the first in the JSON's key
order; none = -1. The delta is then `approximate: true`.

**Part statuses.** A part exists in a version iff at least one cell is labelled with it. `ADDED` only in B, `REMOVED` only in
A, `CHANGED` if any added/removed/changed cell is labelled with it on either side, else `UNCHANGED`. Counts: an added cell
counts `added` under part(B); a removed cell `removed` under part(A); a changed cell `changed` under part(A) and, when
different, under part(B). `boxFrom` / `boxTo`: the part's cells' box in design coordinates in A / B (null when absent).
Unlabelled cells (-1) are not a part.

**Frame check.** `frameKept` = `front` equal and the entrance feet row (`groundY - origin.y`) equal.
**Frame hint** (a note only): over the parts present in both versions, if more than half of their A cells fail to match
B at the same design coordinate, try every translation v with |v| <= 8 per axis over a deterministic sample (at most 2000 of
those A cells, every k-th in y,z,x order, k = ceil(n/2000)); the best v (ties: smallest |v| sum, then x, y, z ascending) with
at least 90% matches gives `frameHint: [vx,vy,vz]` and the note "frame moved by vx,vy,vz: set origin, keep design coordinates".

**`node kit/tools/diff.mjs <a.nbt> <b.nbt> [--parts-a f] [--parts-b f] [--frame-a x,y,z] [--frame-b x,y,z] [--scope p,q]
[--new-parts n] [--max-share 0.5] [--max x,y,z] [--cells] [--json]`.** Next to each `.nbt` it reads `<base>.blueprint.json`
and `<base>.parts.nbt` when present (flags override). `--json` prints one line:
`{ ok, frameKept, approximate, parts: {name: {status, added, removed, changed, boxFrom, boxTo}}, added, removed, changed,
unchanged, notes[], violations[], frameHint? , cells? }`; `--cells` adds `cells: {added, removed, changed}`, each a list of
`[x,y,z]` design coordinates sorted y, z, x. Exit 0 = no violation, 1 = violations, 2 = bad usage. Violations (scope mode,
`--scope` given): `{kind, part?, cells?, message}` with kinds `outside_scope` (a non-unchanged cell whose part(A) or part(B) is
outside the allowed set; -1 counts as outside; one per part), `part_removed` (a part of A missing from B, not in scope),
`too_many_new_parts` (more new part names than `--new-parts`, default 2), `frame_changed`, `inputs_changed` (`params`,
`palette` or `values` differ between the two blueprint JSONs), `too_large` (B's size over `--max`), `too_many_changes`
((added + removed + changed) / A's written cells > `--max-share`). The allowed set = `--scope` names + B's new part names
(names not in A) when their count is within `--new-parts`.

**Entry versions on disk** (contract "Entry versions on disk"): `<library>/<id>/versions/<n>/` holds the same file names as
the top level (`<id>.nbt`, `<id>.blueprint.json`, `<id>.mjs`, `<id>.parts.nbt`, previews, `critique.json`, and `delta.json`
for a version made from a parent). A version folder is complete once renamed from `versions/.tmp-<n>-<rand>/`. The blueprint
JSON's `version` (absent = 1) and `versions` lineage are as specified. **Repair** (sidecar start and the mod's library load):
if the top-level `version` is lower than the highest complete `versions/<m>/`, the top-level files are replaced from
`versions/<m>/` (each `.tmp` + rename, the blueprint JSON last, keeping the top level's `favorite`, `userTags`,
`displayName` and `ext`); `.tmp-*` folders are deleted. The mod reads a site's pinned version from `versions/<v>/`, or from the
top level when `v` is the head and `versions/<v>/` does not exist (an entry never bumped).

## In-game runs

The gate client runs from the run worktree `~/Developer/LarattaLabs/architect-mc-5b-run` (detached; `git -C ../architect-mc-5b-run
checkout --detach phase/5b` and rebuild before a run), DevBridge 8891, sidecar 8890 (stub):

```sh
cd ~/Developer/LarattaLabs/architect-mc-5b-run && ARCHITECT_AUTOWORLD_NAME="G5B Smoke" nohup tools/run-gate5b-client.sh \
  > ../architect-mc/artifacts/gate5b/client.log 2>&1 &   # note the PID; stop with dev.quit, else kill that PID
cd ~/Developer/LarattaLabs/architect-mc-5b && ARCHITECT_DEV_PORT=8891 node tools/gate5b.mjs smoke
```

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-5b
(cd sidecar && npm ci && npm run build && npx vitest run)
node --test kit/test/*.test.mjs
(cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline)
```
