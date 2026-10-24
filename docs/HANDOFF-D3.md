# HANDOFF D3: districts beside a standing region town

Contract: docs/CONTRACT.md "## Phase 6c slice D3" (FROZEN 2026-10-20). Branch `slice/D3`, worktree `../architect-mc-D3`.
Main was frozen for v0.42.0 when this started (base 87d96dd6). Merge origin/main once v0.42.0 is tagged.

## Binding overrides (from the bottom of the contract; they win over §1-§14)

- Steward's finding: only in-flight towns refuse (`PREPARING`, `PLACING`, `REMOVING` -> `OVERLAP_BUSY`). `PLACED`, `PARTIAL`, and
  `FAILED` with cells standing are valid beside towns at plan, `checkBeside` and realise. `d3_town` gains a partial town (one lot
  failed) and the gate realises a district beside it.
- N-D3-1: today's 3-wide join look inside the town. N-D3-2: the join's route lamps skip spots within 6 of a town lamp.
- Versions: placeholders only (`NEXT`); no numbers set.
- v0.41.0 already carries FL and RS: item 16 (survival) is in scope (coordinator agreed 2026-10-23).

## Deviation agreed with the coordinator (2026-10-23): `besideReach.standing`

§2.4's `besideReach {survey, held}` lacks the town data the reach step needs (ctx.beside is clipped to SEAM_MAX + 8 and stays
byte-identical, §10). Added: `besideReach.standing` = the town's whole-claim footprint, its streets, its bodies and its lamp spots,
computed by the mod from the town IR (BesideCheck), with the kit's reference `besideStanding(id, claim, ir)` in
kit/lib/region/beside.mjs. Kept in the sidecar plan dir as `standing.json`; the IR's `reach.standingSha` covers it (reach-step plans
only). Not public API (sidecar wire and IR only). Record it in the as-built.

## The frozen interface (D3-a / D3-b)

### `besideReach` (region.plan, the kit's `--beside-reach <f>`, `ctx.besideReach`)

```
{
  survey:   ARSV columns, resolution 1, the town's claim (unloaded chunks FLAG_MISSING)
  held:     { runs: [[x0, z, x1, z]],     every column holding an active journal cell (guard leaves excluded), any owner but the
                                          district's own group
              town: [[x0, z, x1, z]],     the subset held only by the standing region's group
              terrain: [[x0, z, x1, z]] } the subset of `town` held only by the standing region's terrain-set entries
  standing: { id, claim, footprint: {lots, keep}, streets: [{id, width, points: [[x, y, z]], flagged}],
              bodies: {hard: runs, watch: runs}, lamps: [[x, z]] }
}
```
On disk (sidecar plan dir): `reach-survey.bin`, `held.json`, `standing.json`, and `beside-reach.json` naming them.

### IR (reach-step plans only; a seam-step plan's IR is today's)

- `reach: {standing, runs, rect, cells, hold, heldSha, surveySha, standingSha}`: `runs` the join's written columns outside the
  district's claim (row runs `[x0, z, x1, z]`), `hold` the contact columns whose town cells the district holds (row runs: the
  contract's `hold` op, carried in `reach` so the evaluator needs no new op kind; the mod journals each town-held cell of those
  columns as the district's at the start of the realise, before = after = the block standing).
- `meta.districts.join.step: "reach"`, `.junction: {kind: "end"|"side", at, side?, u?}`; `join_external.junction` the same.

## State (2026-10-23)

- [x] D3-a kit: reach step, candidates, frame/lead, IR reach, evalTile, M28/M25 foreign bodies, land.mjs, plan/0 reach, §9,
      lit reach (ruling B), broken variants; unit tests and the parity fixture.
- [x] D3-b mod + sidecar: reach inputs at plan (held, town survey, standing), realise re-check, TileCheck/Drift/Prepare reach,
      hold item, land ext + standingRemoved, checkBeside + dry, features, DevBridge hooks. Compiles; Java parity green.
- [x] Driver `tools/gate6cd3.mjs` (steps unit, apicompat, ingame, side, refusals, steward, along, kc, walled, pond, natural,
      survival), chain 6cd3, impact rule "6c D3", step-inputs rebuilt.
- [x] As-built section in CONTRACT.md (evidence row pending the in-game run); PLAN queue entries.
- [x] In-game steps green (2026-10-23): d3-ingame, d3-side, d3-walled, d3-natural, d3-survival (run 20261023-173030-6cd3 at
      b2b92d3d), d3-steward (20261023-173524-6cd3 at 5e0860a9), d3-unit (20261023-173830-6cd3). Evidence rows in the as-built.
- [x] Merged origin/main (v0.42.0) at 89b29157; head 41c19d00 pushed. step-inputs rebuilt (230 steps). Kit 819/0, gradle build
      green, lints green, sidecar regions tests green.
- [x] Slice tier `20261023-212002-slice`: every D3 step PASS; the unrelated load timeouts and failures were dropped by the
      coordinator (DEV MODE, 2026-10-24).
- [x] Gate-verifier PASS at 41c19d00.
- [x] Steward RC on 28720a05: finding 1 (a refused removal left the region PARTIAL: main's since C23) and finding 2 (own wall ->
      [wall]) fixed; d3-steward with the RC row 23/0 at 0d8eac82.
- [x] The verifier's strict re-run of the removal row: PASS (gate-runs-d3-verify/20261024-025722-change).
- [ ] Steward's re-run on the head.

## Notes from the first in-game round

- Towns off the spawn area: the driver prepares a throwaway plan over the claim grown by 16 (`generateFor`), because prepare's
  claim + 2 chunks misses an edge tile's window off the 64-grid (main's behaviour, noted in the as-built), and force-loads a town
  400 away while it plans beside it (§4: the town survey reads loaded chunks only).
