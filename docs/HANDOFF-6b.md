# Phase 6b: working notes (handoff)

Branch `phase/6b` (worktree `../architect-mc-6b`), from `main` at 7c21385 (v0.11.0 / API 1.8.0 plus the frozen 6b contract).
The spec is docs/CONTRACT.md "# Phase 6b contract" (frozen), with "Changes from Steward's review of 6b" winning. Do not
merge, tag or publish. This file is retired into CONTRACT "Phase 6b as built" when the gate passes.

## State

| Build step (CONTRACT §13) | State |
|---|---|
| 1. 0.11.0 apitest jar archived; player-block `Reason` pinned | jars archived (below); the `Reason` question pinned by code reading, an in-game pin is pending |
| 2. Kit: IR format 2, shapes, material rules, primitives, `floatingIsland`, ARVX | done (kit tests) |
| 3. Kit: virtual world, M1-M14, prefix checks, previews, `siteplan.json` | done |
| 4. Bundled programs and fixtures, expected reports, broken variants | done: `crater_works`, `rift_city`, `sky_isle`, `walled_hill`, `floating_islands`; the gate sites' recorded surveys are pending (find-site) |
| 5. Sidecar: check, preview, blobs, `hello` versions, `region.design` | done (subagent, merged from `phase/6b-sidecar`) |
| 6. Mod: blobs, `PLAN_STALE`, `Survey.volume`, previews/check/design/nudge, ghost, commands, DevBridge, API 1.9.0 | done in JVM tests (subagent, merged from `phase/6b-mod`); in-game checks pending |
| 7. Tools: `find-site.mjs`, `scenarios.mjs`, scenario files, `gate6b.mjs` | next |
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

- Programs and kit pieces added beyond the contract's list (all plan time): `Part.spiralTower` (a square spiral stair round a
  solid core; `crater_works`, `sky_isle`, `rift_city` and S1 use it), `stair({solid})` (a block under each tread, rails on
  every open side), `bridge({over: 'ours'})` (decks over the region's own forms), `Region.clearing` (an anchor on open
  ground), ring `baseY`, bridge `towers.at`, `floatingIsland` `anchorAt` and landing pads.
- The checker runs at full resolution everywhere: mega_bench takes about 21 s single-threaded (synthetic survey), inside the
  coarse bar of 60 s, so no coarse mode was built. `report.resolution` says `{coarse: 1}`.
- M8's barrier is a block at least 1.5 tall (fences, walls, panes, closed gates) or two blocks high.
- The floatingIsland cost bar (est. 2x a sphere per cell) is missed: about 20x; recorded, and the purpose (the tile limit and
  45k cells/s) is asserted instead.
- Gate item 10(c): the mod agent read 0.11.0's code: 0.11.0 drops a format-2 region record as unreadable at load (it never
  requests a tile); to pin in game.
- Linux determinism: the format-1 and format-2 goldens pass in a Node 22 Linux container (artifacts/gate6b/linux-determinism.txt).

## Spend

$0 so far (artifacts/gate6b/spend.json is written by the paid steps).
