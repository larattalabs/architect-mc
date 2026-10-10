# Handoff: 6c slice 0c (placement polish and protected areas)

Branch `slice/0c`, worktree `../architect-mc-0c` (the contract names `phase/6c-0c` / `../architect-mc-6c-0c`; the coordinator's
names win). API 1.12.0, mod 0.15.0 (after 0a = 1.10.0 and 0b = 1.11.0). Ports 8912-8917. $0: no Claude calls.

## Status per item (contract §§)

| Item | State | Notes |
|---|---|---|
| §8 C17 protected areas | in progress | `site/Protected.java`; hooks: verdict (place, check, fitToLot, batch building, move), SiteDeltas.check (delta, checkDelta, batch delta, forward revert), revert (undo path: restore box), cells (API + batch), region plan start/accept + realise start. Roads: with §3's spans |
| §9 C18 owner-tagged entities | todo | |
| §2 minLotSize / recommendedLot | built (String); MassingRef overload waits for 0a's fitMassingToLot | `LotFitting.minSize/recommended`, `MinLotSizeTest` |
| §3 partial roads | todo | |
| §4 groundHeight | todo | capture the volume sha baseline before touching VolumeSurvey |
| §6 extend warning | todo | |
| §5 FIELD_LIMIT | after 0a (ArchitectRefused) and 0b (its bounded fields) | |
| §10 off-thread undo planning | after 0a (own-time percentiles), 2 h box | no journal/** change left on the branch if no-go |
| §7 C16 survival roads | last; split to `slice/0d` if it overruns | dirt_path on grass free (coordinator) |

## Deviations so far

- `LotFit`'s 1.4.0 constructor sets `recommendedLot` to the template box (the contract's "the lot passed in" isn't known to
  that constructor).
- Revert's undo path (no forward delta) is checked against the site's restore box, not per cell.

## Resume

- Build: `export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home; cd mod && ./gradlew build --offline`.
- The 0.14.0 baseline jars (apitest + mod) don't exist until 0b merges; archive them into `artifacts/gate6c0c/v0140/` then.
