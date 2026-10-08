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
| 1. F1 sidecar-bundle guard, F2 USER/LOGNAME | not started |
| 2. Kit frame, parts.nbt, diff.mjs (scope), fixtures; round-0 rebuild tripwire | not started |
| 3. Sidecar entry versions, critique.json format 2, entry.* messages | not started |
| 4. Mod TemplateDelta, delta apply, revert, fold, crash points, survival, queue/stages, preview, UI | not started |
| 5. Polish on the sim backend | not started |
| 6. Java API 1.7.0, api-compat (1.6.0 and 1.5.0 jars) | not started |
| 7. Gate items 1-5, 8, 9 ($0) | not started |
| 8. Polish prompt development (cap $20), freeze, smoke, full, other real checks | not started |
| 9. Docs (CONTRACT as built, PLAN, README, DEVBRIDGE) | not started |

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

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-5b
(cd sidecar && npm ci && npm run build && npx vitest run)
node --test kit/test/*.test.mjs
(cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline)
```
