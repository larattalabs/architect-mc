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
4. Merge policy (coordinator, 2026-10-10): agents can't push to main. When the slice tier and the gate-verifier pass, push
   `slice/0b` and report "ready to merge"; the coordinator merges, tags and publishes.
5. slice/0a (1.10.0, in progress) was merged into slice/0b early (2026-10-10) so the 1.11.0 Java surface builds on 0a's
   types; when 0a lands on main, origin/main is merged again.
6. Item 2's "in game" fit check is a mod unit test (MirrorFitTest) of LotFitting.fit, the function fitToLot and
   fitMassingToLot both run, over the copy stage's own recipe for every kit example (kit/tools/mirror-fit-fixture.mjs), on
   4 street sides x 3 lot sizes. 0a's fitMassingToLot was not implemented yet when this was built.
7. The §6 bench drives the claude-login sidecar over the protocol (tools/bench6c0b.mjs) without a game: no placement on
   pad lots (placement is $0 and does not change the measured figures), and the C13 smoke runs without a site.
3. The `slice` tier runner is not on main yet (main has quick/regress/engine). Use it if it lands before the gate; otherwise
   the existing chains.

## Plan and status

Independent of 0a (do first):

- [x] kit: `Blueprint` mirror + `build.mjs --mirror` (kit/lib/mirror.mjs), the mod oracle fixture and the kit test
- [x] kit: `kit/lib/smalls.mjs` (rack, stall, well, shed), checker under every built-in bible; the SMALL brief
- [x] sidecar: group `count` / `copyOf` / `copyCap` expansion, COPY_REFUSED details (sidecar/src/copies.ts)
- [x] sidecar: copy recipes (palette shift, param, mirror), the 2-lever / 10% test over every example x bible
- [x] sidecar: the COPY stage on the VariantRunner (--max, mirrored conformance, derived bible), fallback, source_failed,
      promoteCopy (sidecar half), copies while paused_budget
- [x] sidecar: `derivation` + `variantOfVersion` (VARIANT, RESKIN, COPY), polish carry, byte-identical rebuild
- [x] sidecar: C2 size rule (`smallBySize`, 11 x 9 either way)
- [x] sidecar: C8 caps (2 rounds, 40 turns, medium, $1.50 cumulative per detail pass)
- [x] sidecar: C13 `versionOf` (context files, frame guard, head + 1, base_moved, refusals, sim)

After 0a merges (merge origin/main first):

- [x] Java API 1.11.0 records/enums (after 0a's: ArchitectRefused.detail, Reasons, GroupRequest after opKey), promoteCopy,
      versionOf + the site capture, Estimate.Kind SMALL/CHANGE, smallOriginals
- [x] Breakdown COPY stage, estimates (COPY real, SMALL, CHANGE), sim costs for SMALL
- [ ] the version bump (ArchitectApi.VERSION 1.11.0, mod_version 0.14.0) after 0a's 1.10.0 lands
- [ ] api-compat against the 0.13.0 / 0.12.0 / 0.11.0 apitest jars (0.13.0 jar from the v0.13.0 tag)
- [x] gate driver tools/gate6c0b.mjs (unit: items 1-4, 6, 7 offline: PASS 2026-10-10; ingame: items 5, 7)
- [ ] ingame PASS; slice run; gate-verifier
- [ ] §6 benchmark (tools/bench6c0b.mjs: paid, claude login, cap $35, spent + step cap <= $35 before each paid step)

## Steward's review (folded in)

- Small rule: explicit `effort` SMALL/STANDARD wins over the 11x9 rule (done in copies.ts itemEffort). Interpretation of "the
  11x9 rule is the default": it is how AUTO resolves when the group sets `smallBySize`; without `smallBySize` an item stays
  STANDARD, keeping §1's "behaves exactly as in 1.10.0". Flag to the coordinator if Steward meant smallBySize on by default.
- A capped S item fails (`budget` / `rounds`), no STANDARD retry: done (designer.ts, sim).
- Copies of a failed archetype fail with `source_failed`; the caller decides `promoteCopy`: done (groups.ts).

## Decisions taken (not in the contract)

- versionOf: the site files travel as blobs (`versionOf.siteNow`, `versionOf.siteEdits`, put by the mod); the sidecar pins
  `baseVersion` = the head; the new version inherits the head's bible pin; a polish is refused `busy` while a versionOf of
  the entry is unfinished (both make head + 1). The notes must be non-empty (the change request).
- Sim: `sim:frontchange` turns the front in round 1 of a versionOf (the frame guard makes it a repair round).

- Copies are never stopped by a group's hard cap (they cost $0); a copy whose archetype is stopped fails `source_failed`.
- promoteCopy is refused (COPY_REFUSED) with detail `not_copy`, `building` (not final yet) or `final` (group or item ended).
  A `source_failed` copy may be promoted while the group is still open.
- A recipe's levers count only when effective (the single-lever build changes a cell). Lever 1 offers both the roof-kin shift
  and the trim/frame swap (roof first), because a design may not use the roof's stone.
- The recipe seed is (group id, archetype key); the copy's ordinal picks its place, so siblings differ.
- Several `sim:repair` tokens are several repair rounds (gate item 6's "two sim:repair").
