# HANDOFF 0b: reuse and bounded effort (API 1.11.0, mod 0.14.0)

Resume notes for slice 0b (docs/CONTRACT.md "Phase 6c slice 0b" and "Coordinator decisions on the 0b, 0c and V drafts").
Delete this file when the gate passes.

## Where

- Worktree `../architect-mc-0b`, branch `slice/0b` (from origin/main cd60e38).
- Ports **8906-8911** (gate runner `--ports`, ad-hoc clients, the bench client). Other slices use 8890-8905.
- Kill only own processes, by PID. No Discord. Commits end with the Opus 5.5 co-author line.

## Deviations (recorded as they happen)

1. Worktree and branch follow the coordinator (`../architect-mc-0b`, `slice/0b`), not the contract's `phase/6c-0b`.
2. Build order step 1 (archive the 0.13.0 apitest jar "before any 0b change") can't run before 0a is tagged. When `v0.13.0`
   exists, the jar is built from a clean checkout of the tag (not from this branch) into `artifacts/gate6c0b/v0130/`.
3. The `slice` tier runner is not on main yet (main has quick/regress/engine). Use it if it lands before the gate; otherwise
   the existing chains.

## Plan and status

Independent of 0a (do first):

- [ ] kit: `Blueprint` mirror + `build.mjs --mirror` (kit/lib/mirror.mjs), the mod oracle fixture and the kit test
- [ ] kit: `kit/lib/smalls.mjs` (rack, stall, well, shed), checker under every built-in bible; the SMALL brief
- [ ] sidecar: group `count` / `copyOf` / `copyCap` expansion, COPY_REFUSED details (sidecar/src/copies.ts)
- [ ] sidecar: copy recipes (palette shift, param, mirror), the 2-lever / 10% test over every example x bible
- [ ] sidecar: the COPY stage on the VariantRunner (--max, mirrored conformance, derived bible), fallback, source_failed,
      promoteCopy (sidecar half), copies while paused_budget
- [ ] sidecar: `derivation` + `variantOfVersion` (VARIANT, RESKIN, COPY), polish carry, byte-identical rebuild
- [ ] sidecar: C2 size rule (`smallBySize`, 11 x 9 either way)
- [ ] sidecar: C8 caps (2 rounds, 40 turns, medium, $1.50 cumulative per detail pass)
- [ ] sidecar: C13 `versionOf` (context files, frame guard, head + 1, base_moved, refusals, sim)

After 0a merges (merge origin/main first):

- [ ] Java API 1.11.0 records/enums (after 0a's: ArchitectRefused.detail, Reasons, GroupRequest after opKey), promoteCopy,
      versionOf + the site capture, Estimate.Kind SMALL/CHANGE, smallOriginals
- [ ] Breakdown COPY stage, estimates (COPY real, SMALL, CHANGE), sim costs for SMALL
- [ ] gate driver tools/gate6c0b.mjs items 1-8; slice run; gate-verifier
- [ ] §6 benchmark (paid, claude login, cap $35, spend.json before each paid step)

## Decisions taken (not in the contract)

(none yet)
