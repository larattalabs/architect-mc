# Phase 6b: working notes (handoff)

Branch `phase/6b` (worktree `../architect-mc-6b`), from `main` at 7c21385 (v0.11.0 / API 1.8.0 plus the frozen 6b contract).
The spec is docs/CONTRACT.md "# Phase 6b contract" (frozen), with "Changes from Steward's review of 6b" winning. Do not
merge, tag or publish. This file is retired into CONTRACT "Phase 6b as built" when the gate passes.

## State

| Build step (CONTRACT §13) | State |
|---|---|
| 1. 0.11.0 apitest jar archived; player-block `Reason` pinned | jars archived (below); the `Reason` question pinned by code reading, an in-game pin is pending |
| 2. Kit: IR format 2, shapes, material rules, primitives, `floatingIsland`, ARVX | not started |
| 3. Kit: virtual world, M1-M14, prefix checks, previews, `siteplan.json` | not started |
| 4. Bundled programs and fixtures, expected reports, broken variants | not started |
| 5. Sidecar: check, preview, blobs, `hello` versions, `region.design` | not started |
| 6. Mod: blobs, `PLAN_STALE`, `Survey.volume`, previews/check/design/nudge, ghost, commands, DevBridge, API 1.9.0 | not started |
| 7. Tools: `find-site.mjs`, `scenarios.mjs`, scenario files, `gate6b.mjs` | not started |
| 8. Gate items 1-10, 12; S1 run and gallery (11); gate-verifier (13) | not started |

## The 0.11.0 jars (build step 1)

Built from tag `v0.11.0` (dd622d6) in a temporary worktree `../architect-mc-v0110` (sidecar bundled, `gradlew build -x test`),
which was removed afterwards. Archived in the main checkout (gitignored `artifacts/`):

- `artifacts/gate6b/v0110/architect_apitest-0.11.0.jar` sha256 `d00649738b5ee727900f57b86b32d6967ceb3de6266ecaf5d91e2eba3b4338c6`
- `artifacts/gate6b/v0110/architect_mc-0.11.0.jar` sha256 `1c7b0b23cbbc76e565219c7f2b47d4e58e9f52c4d736ebfc7be5fa8a56b32c04`
- `artifacts/gate6b/v0110/src/` (`git archive v0.11.0`) and `tools/` (`apitest.mjs`, `lib/`), as 6a's `v0100`.

## The player-block question (§7.3 case (a))

Code reading of 0.11.0 (`site/Sites.java` `checkSite`): a LAYER placement refuses only on journal-owned overlaps
(`OVERLAP_BUSY`, `OVERLAP_OWNED`, `LAYER_DEPTH`), block entities (`BLOCK_ENTITIES`), lava, doors cut, occupancy and build
height. A non-natural block without a block entity that no entry owns is neither checked nor refused: the placement
overwrites it and the snapshot gives it back on remove. So 0.11.0 **only clears it**, and 6b adds the appended
`Reason.PLAYER_BLOCKS`, scoped narrowly (see "Decisions"). Still to do: confirm in game with the 0.11.0 jar.

## Decisions made while building

- The format-1 golden (`kit/test/fixtures/regions/mega_bench.golden.json`) pins `irSha`, and the IR records `kitVersion`. The
  golden test now plans with `kitVersion: '0.11.0'` explicitly (as it pins `node: 'golden'`); the file itself is unchanged.

## Spend

$0 so far (artifacts/gate6b/spend.json is written by the paid steps).
