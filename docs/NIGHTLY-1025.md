# Nightly 2026-10-25: triage

Run: `artifacts/gate-runs-nightly/20261025-080033-release` (release --full --nightly, turbo 5 shards + 3 offline lanes) on main
331ea0f6. Result: 155 PASS, 40 FAIL, 25 TIMEOUT in 13h19m. Machine load during the run: p50 18.2, p90 28.8, max 74.2.
Re-runs on branch fix/nightly-1025, off origin/main 98d0f3f3, out dir `artifacts/gate-runs-n1025/` (local evidence only):
- **A** `20261025-230130-change`: 30 offline steps, 3 shards, at 98d0f3f3. Done in 17m51s: 26 PASS, 4 FAIL. The 4 FAILs are the (b)
  fixes below.
- **B** `20261025-231926-change`: 24 in-game and crash steps, 3 shards. Still running when this was written.
- **D** (`../architect-mc-n1025-runD`): the four fixed (b) steps at the branch head.
- **C** (`../architect-mc-n1025-runC`): the 11 timing steps, 1 shard, `--judge-timing --quiet-wait`.
- **E** (`../architect-mc-n1025-runE`): 4e-orders-full then 4e-crash-full. B ran crash without orders, so it failed on its own
  `after` dependency.

D, C and E were queued behind B. "pending" in the table means no result had come in when this doc was committed.

Classes: **(a)** real product bug; **(b)** stale test expectation; **(c)** flake, load or timeout; **(d)** infra.

## Root causes (grouped)

1. **(d) Base-world host flip and world-creation timeout.** In the same run dir, a headless-server step builds `G6B Seed Base`
   (or Flat) stamped `host: server`. The next client step finds it stale (basestamp.mjs, 35b504f1), quarantines it and calls
   `dev.world.open` to create it again. That handler's budget is 10 s (`DevCommands.java:144`, `DevBridge.register("dev.world.open",
   10_000, …)`). Under load, "Selecting global world spawn" alone took about 9 s (client log, nightrun s1, 06:16:55 to 06:17:04), so
   the open timed out. The driver then quit, which left an unstamped half-made world. The next step quarantined that one as
   "unstamped", and the cycle repeated. `architect-mc-nightrun/mod/run/saves-stale` holds 11 Seed Base copies from this one run.
   Suggested fixes, not made here:
   - a longer handler budget for a create (preset/seed given);
   - or one base per host (`G6B Seed Base Srv`), as the claim worlds already do.
2. **(c) The offline lanes overcommitted the CPU.** Eight workers each sized `node --test` and plan workers for the whole machine
   (load p90 28.8). unit-kit (20 min) and unit-sidecar (15 min) timed out first. That turned off kit-reuse and sidecar-reuse, so
   every unit driver re-ran the whole suites itself. The result:
   - kit-suite readers printed "-1 pass, -1 fail" (t2, s3, d3);
   - the history timeouts cut steps that were still running: umt-long 17/40, apijars 15/30, water-lint 11/20, lint-structure 16/25,
     6a-crash 34/40, and every `*-unit` 1h+ timeout.
   On a 3-shard re-run, every one of these passes, in seconds to a few minutes.
3. **(d) ANSI colour in the nightly's vitest output.** launchd's bare environment, with no TERM and no agent variables, makes vitest
   colour its summary even into a pipe. When sidecar-reuse fell back (cause 2), the drivers' `/Tests\s+\d+ passed/` check failed on
   "Tests [22m [1m[32m25 passed". Affected: sch-unit, p0-unit, coa-unit item 3, pt2-unit.
   - Fixed in af2b8147: `tools/nightly.mjs` sets `NO_COLOR=1` for its runner. Verified with `env -i … NO_COLOR=1 npx vitest run`.
   - It takes effect only once main has it, because the LaunchAgent runs nightly.mjs from the main checkout.
4. **(c) Timing bars under load.** Every functional row passed; only the bars missed, at load 18-44:
   - 4e-megalite, 4d-all-full, 5b-village, 6a-megaA (its E-normal row is ok: 28 mismatches, gravity 27 and live 1, cap 1018);
   - 6b-smoke (120.7 s against a 120 s bar);
   - mp-ingame, b-ingame, pt-ingame;
   - the scenarios relief, s7 and s1.
   Re-run judged in batch C.
5. **(b) The asks tables and byte identity didn't keep up with 7a CL, K2 and the foundation.** With HEAD = origin/main, the drivers'
   "before" kits pre-date CL: `../architect-mc-F3-main` is at f46e1840 and `../architect-mc-KC-main` at 477c573f (both 2026-10-23),
   and CL merged at 36badab7. The base trees now:

   | tree | commit |
   |---|---|
   | CL-main | 331ea0f6 |
   | K2-main, RS-main, VOCc-main | 98d0f3f3 |

   - vocc-unit, hy-unit and kc-unit were already fixed on main by af947a2a (`clAskLine` in fl-norm). A: PASS.
   - coa-unit, f3-unit, rs-unit and k2-unit are fixed on this branch (see "Fixes").
6. **(a) Known: RoadTerrain treats natural packed ice as BUILT.** rs-survival/p4 item 14 ends PARTIAL at 96.7%. This is already
   recorded in PLAN.md "Queued from 6c close-out B" and CONTRACT §11 ("Item 14 stays failing, recorded"). It has failed identically
   since 2026-10-23 05:00.

## Table

| step | class | cause | action | re-run |
|---|---|---|---|---|
| umt-long | c | history timeout 17 min under load (2) | re-run | A PASS 4m25s |
| unit-kit | c | 20-min timeout, load 33 (2) | re-run | A PASS 8m05s |
| unit-sidecar | c | 15-min timeout (2) | re-run | A PASS 2m15s |
| sim-massing | c | "world leave cleared every composite (keys now: 3)": a race under load; passed 4 times on 10-23 | re-run | B pending |
| apijars | c | timeout 15/30, bars missed under load | re-run | B pending |
| 0a-keys | c (pending) | the group op sent before the kill was not adopted; the driver sleeps a fixed 3 s before SIGKILL (gate6c0a.mjs:735). Crash recovery stays strict: (c) only if B passes | re-run | B pending |
| mp-ingame | c | bar: own tick 63.5 > 50 ms | judged re-run | C pending |
| sch-unit | d | ANSI (3) after the reuse fallback (2) | NO_COLOR fix | A PASS |
| v-unit | c | 30-min timeout (2) | re-run | A PASS 28s |
| w-unit | c | 45-min timeout; item 12 "44 pass, 1 fail" read the goldens' kit-suite fallback under load (2) | re-run | A PASS 16s |
| w-ingame | d | world.open cascade (1) | re-run | B PASS |
| x-unit | c | timeout (2) | re-run | A PASS |
| y2-ingame | d | its own `openWorld` (gate6cy2.mjs:93) timed out on dev.world.open: same 10-s budget (1); no rebuild line | re-run | B pending |
| t1-unit | c | timeout (2) | re-run | A PASS |
| b-ingame | c | bar: strokes p50 3.8 s > 2 s | judged re-run | C pending |
| pt-ingame | c | bar: classifier 7.89 ms > 1 ms | judged re-run | C pending |
| pt2-unit | d | ANSI (3) | NO_COLOR fix | A PASS |
| 6ct1-scenario-relief | c | bar: own tick 83 ms | judged re-run | C pending |
| t2-unit | c | the kit suite missing (2) and timeout | re-run | A PASS |
| p0-unit | d | ANSI (3) | NO_COLOR fix | A PASS |
| c38-unit | c | timeout, silent after `== unit` (2) | re-run | A PASS 1m36s |
| coa-unit | b+d | item 6: CL's three climbs against the committed asks-after.txt; item 3: ANSI | fix c9a043e2 | A FAIL (old driver), D pending |
| rs-unit | b | asks tables: CL x3, rail_1 `until CR` (foundation), castle_city walk (K2) | re-cut df9373d4 | A FAIL (old tables), D pending |
| rs-survival/p4 | a | item 14 PARTIAL 96.7% (6) | write-up | B FAIL (same) |
| t3a-unit | c | timeout (2) | re-run | A PASS |
| t3a-look | d | world.open cascade (1) | re-run | B pending |
| k1b-unit | c | timeout (2) | re-run | A PASS |
| t3b-unit | c | timeout (2) | re-run | A PASS |
| t3b-look | d | cascade (1) | re-run | B pending |
| h-unit | c | timeout (2) | re-run | A PASS |
| u3-ingame | c | dev.style.designState timed out under load (load 36) | re-run | B pending |
| vocc-unit | b | CL movers; fixed on main (af947a2a) | none | A PASS |
| 6cvoc-look | d | cascade (1) | re-run | B pending |
| hy-unit | b/c | CL movers (fixed on main) plus timeout | none | A PASS |
| hy-ingame/p3 | c | checkPlan BUDGET: "took longer than 88.1 s" (the maxMs sandbox cap) under load | re-run | B PASS |
| kc-unit | b | CL movers; fixed on main (af947a2a) | none | A PASS |
| cl-look | d | cascade (1) | re-run | B pending |
| f3-unit | b | §9: CL's three moved against the pre-CL F3-main kit | fix d8c73dec | A FAIL (old driver), D pending |
| fl-look | d | cascade (1) | re-run | B PASS |
| water-lint | c | history timeout 11 min (2) | re-run | A PASS 32s |
| s2-unit | c | timeout (2) | re-run | A PASS |
| s3-unit | c | the kit suite missing (2) | re-run | A PASS |
| s3-plan | c | checkPlan BUDGET: "took longer than 31/46.7 s" under load | re-run | B pending |
| d-unit | c | timeout (2) | re-run | A PASS |
| k1a-unit | c | timeout (2) | re-run | A PASS |
| k1a-look | d | cascade (1) | re-run | B pending |
| k2-unit | b | after the K2 merge (23235708), base = head: "castle_city UNCHANGED", "moved []" | fix 6d85c744 | A FAIL (old driver), D pending |
| k2-look | d | cascade (1) | re-run | B pending |
| d2-ingame | c (pending) | quay undo: 82 "none" cells, water flowing into air at 3651,110,-994. Undo is strict: (c) only if B passes; otherwise check whether that claim's water was unsettled | re-run | B pending |
| d3-unit | c | the kit suite missing (2) and timeout | re-run | A PASS |
| 6cv-scenario-s7 | c/d | bar: own tick 91 ms; scorecard "golden differs" after the base rebuild on the other host (1) | judged re-run | C pending |
| 4e-megalite | c | bars at load 3-6 (contended earlier) | judged re-run | C pending |
| 4d-all-full | c | bars: own tick 96 ms, load 31 | judged re-run | C pending |
| 4e-crash-full | c | timeout 30 min; rows ok until cut | re-run with 4e-orders-full | B FAIL (no orders in the run: my error), E pending |
| 5b-village | c | bar 29.8 > 25 ms | judged re-run | C pending |
| 6a-megaA | c | bar: own tick max 70 ms; E-normal ok | judged re-run | C pending |
| 6a-crash | c | history timeout 34/40 | re-run | B PASS |
| 6a-eflat-full | c | timeout 30 min; rows ok | re-run | B pending |
| 6b-smoke | c | checktime 120.7 > 120 s | judged re-run | C pending |
| 6b-ghost | d | cascade (1) | re-run | B pending |
| 6b-commands | c | the plan never landed ("No plan") after the base rebuilds; hung to the timeout | re-run | B pending |
| 6b-nudges | c | the devserver restarted the sidecar (STOP_THEN_START: the health check answered empty under load); plan refused SIDECAR_UNAVAILABLE in the gap | re-run | B pending |
| 6b-versionc | d | cascade (1) | re-run | B pending |
| 6b-scenario-s1 | c/d | bar: own tick 87 ms; scorecard golden differs after the host-flip rebuild (1) | judged re-run | C pending |
| lint-structure | c | history timeout 16 min (2) | re-run | A PASS 25s |

## Fixes on fix/nightly-1025

- **af2b8147** `tools/nightly.mjs`: `NO_COLOR=1` for the runner. This is a (d) harness fix, outside the (b) scope; drop it if unwanted.
- **6d85c744** `tools/gate7ak2.mjs`: K2 is on main (23235708). `mergedIf: kit/test/k2.test.mjs`, and item 3 accepts `[]` when the
  base has K2. Same pattern as gate7acl.mjs `onMain`.
- **c9a043e2** `tools/lib/gate6ccoa-kit.mjs` item 6: past close-out A, the tables compare through `clAskLine`, without the CL
  gap-table rows or the tally line. This is af947a2a's normalisation. Checked offline against A's tables: before and after both
  equal the committed asks-after.txt.
- **d8c73dec** `tools/gate6cf3.mjs` §9: `lines` uses `clAskLine(f7aAskLine(l))`. Checked offline against A's tables: moved `[]`,
  committed true.
- **df9373d4** `kit/test/fixtures/plan/rs/asks-{creative,survival}.md`: re-cut from rs-unit's own output at 98d0f3f3. The diff is
  only:
  - CL's three climbs and the tally/gap rows they change;
  - rail_1 `until CR`;
  - castle_city curtain_wall held 26 -> 170, paid 9130 -> 11647, bom 9184 -> 11701 (K2's walk).

## Real bugs (for the coordinator)

- **rs-survival item 14** (already queued). `RoadTerrain.kind`'s ground lists lack natural blocks that `TerrainFit.natural` counts
  (packed ice and others). street_e stops on untouched `minecraft:packed_ice` at 3750,151,-999..-997, and the region ends PARTIAL
  at 96.7%. See PLAN.md "Queued from 6c close-out B" and CONTRACT §11. No fix here.
- **Pending B:** 0a-keys and d2-ingame. If either fails again on a quieter machine, promote it to (a); both are strict (crash
  recovery, undo).
