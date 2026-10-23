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

## State

- [ ] D3-a kit
- [ ] D3-b mod + sidecar
- [ ] driver tools/gate6cd3.mjs, chain, impact rule, step-inputs
- [ ] runs, verifier, as-built, Steward RC
