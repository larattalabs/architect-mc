# HANDOFF T3b: tunnels (resume notes; delete when the gate passes)

Branch `slice/T3b`, worktree `../architect-mc-T3b`, over main 3bed28fa (v0.35.0 + housekeeping). Placeholders: API 1.33.0,
mod 0.36.0, kit 0.34.0, catalogue 6 (the coordinator renumbers at merge). Ports 8918-8923. T3a (bridges) runs in parallel on
`slice/T3a` and owns the shared foundation (`origin/t3/foundation`): schema, catalogue, reason codes, versions, features,
`gate-chains.json` shared rows, the `SPECIAL_MOVES` stub rows and the compile hooks' stubs. T3b never edits the catalogue, the
schema or the reason-code files; anything it needs there is listed under "Asks of the foundation".

## Design decisions (locked before code)

1. **`PlanRequest.load`** (Steward's S-T3-6): a new record component `@Nullable LoadPolicy load`, mirroring
   `RegionPlanRequest.surveyLoad`. The 10-argument constructor stays (old jars link). null or `LOADED_ONLY` is `"loaded"`
   (today's behaviour); a policy that `loads()` is `"generate"`: the claim's survey and the volume pass load (and, for
   `LOAD_BOUNDED`, generate) the chunks they need. The opKey body adds `load` only when it is not the default, so every
   existing keyed check keeps its hash. DevBridge `dev.region.checkPlan {load: "loaded" | "generate"}`.
   "Within the existing tile caps": the claim cap (1024 a side) and the volume caps (4M cells per tunnel edge, 16M per
   plan); with `generate`, `incomplete VOLUME` remains only past them.
2. **The two-plan flow in `PlanChecks.check0`** runs only when the plan JSON has a `connectors[]` part of kind `tunnel` and
   the first plan's `needVolumes` is non-empty (whole-claim templates such as ice_outpost already call `needVolume`; a plan
   without a tunnel part plans once, byte-identical). Volumes null (chunks not generated under `loaded`) or REGION_LIMIT: the
   first plan stands, its tunnels already `incomplete VOLUME`, with the note "prepare, then check again".
3. **The budget across both plans:** `params.budget` is never changed for plan 2 (it is in the IR params and the artifact's
   inputs: a varying value would move the artifact sha). The combined deadline is the second plan's sandbox `timeoutMs`
   (the remaining time plus the grace), which is not hashed.
4. **The plan cache** keys zones and forms only; connectors are never cached, so a tunnel's `incomplete VOLUME` is never served
   from the cache.
5. **Caps in the kit:** the corridor box (§6: the ends' rect dilated by `approach + width + 3`, y from the lower end's feet - 16
   to the highest ground in the rect + 1) is computed in the kit; a corridor over 4,000,000 cells, or one that takes the plan's
   asked total over 16,000,000, is never asked and answers `incomplete VOLUME` with `evidence.cap`. A corridor with MISSING
   survey columns answers `incomplete VOLUME` (never NO_COVER or `tunnel.under`), so `generate` can turn it into a fit.
   Plan 2 matches volumes as K1b does: it iterates `ctx.volumes` and calls `needVolume(v.box)` on those covering a corridor.
6. **Guard cells for the stale rule:** the kit records, per tunnel, the exact void, shell and 2-cell buffer cells as per-column
   y runs, with the volume (sha, box) they were read from, in the artifact (covered by its sha), as a top-level `guards` member
   present only when a plan has a tunnel (every other artifact byte-identical). `realiseApproved` checks them **before** the
   terrain diff (so a mine near the surface names the tunnel): the original from `<world>/architect/volumes/<sha>.bin`
   (`Arvx.decode`), the box re-sampled (`GENERATED_ONLY`), the classes compared at the guard cells only; PLANT and AIR count
   as one class there (COMPOSITION A3: grass and flowers never stale an artifact). Any difference is `ARTIFACT_STALE` naming
   the tunnel part and up to 16 cells (before, now). Steward's plan v1 rechecks once on `ARTIFACT_STALE`
   (steward-mc COMPOSITION §6/A3): after a mine the recheck seals the cave and fits again; water 2 from the bore refuses.
7. **Module layout:** `kit/lib/connectors/tunnelGeom.mjs` is pure (no import of `plan/compile.mjs` or `region/program.mjs`; K1's
   cycle came from such an import). `r.tunnel` points at it. Compile hooks in `kit/lib/connectors/tunnel.mjs`, the move row in
   `kit/lib/region/passes/moves/tunnel.mjs`, `M3:tunnel`/`M4:tunnel` in `kit/lib/region/checkTunnels.mjs`.
   After merging the foundation: grep for any remaining throwing stub and any duplicate class member shadowing the real one.
8. **Gate:** driver `tools/gate6ct3b.mjs`, steps `t3b-unit`, `t3b-ingame`, `t3b-natural`, `t3b-look` (rows added through the
   foundation's `gate-chains.json` or by T3b on its own rows only). World prep copies `gate7ak1b natural` (mobs cleared, time,
   rules), stricter: a pinned hill with no trees within reach of the bore, fresh run dirs.

## Status

- [x] Java: `PlanRequest.load`, the two-plan check, `generate`, the stale rock (PlanChecks, RegionsImpl.volumesFor's policy,
      SliceP0Dev `load`/`volumePass`), `PlanChecksT3Test`
- [x] kit: `tunnelGeom.mjs` (profile, survey-first cover, corridor box, bore/cut, shell lining, cave sealing, falling-block
      lining (a fixed point over every written or carved cell's sand and gravel neighbours), the 2-cell fluid buffer, portals with
      arch stairs, parapets as wall blocks (cut sides and over a portal that opens on a cut), lamps, guard runs, `r.tunnel`)
- [x] foundation merged (rounds 1 and 2); the three stub files replaced by T3b's; `r.tunnel` defined in program.mjs
- [x] the tunnel row (with a fast grid check in the search; the emission re-checks with tunnelGeom), compile hooks (corridors,
      caps, `tunnel.under`, `incomplete VOLUME`), posterns (checkWalls: a postern's floor is no cut, its bore an opening in
      closure; `_unsafe.ignorePostern`), `M3:tunnel`/`M4:tunnel`/M6 (checkTunnels), the artifact's `guards` (finish.mjs)
- [x] fixtures: v37, v38b (auto tunnel), v40 (postern), e17 (tunnel.under), fixtures/plan/tunnel tn01-tn15; plan-t3b and
      tunnel-t3b tests; P0's harness runs a fixture's `terrain` and `volume`; t3-pending-b.json retired
- [x] crossings_demo's tunnel half (`crossingsTunnels.mjs`: the flat ridge with a sand band, a 3x3 and a 1-wide bore; the hill
      variant's line)
- [x] gate driver `tools/gate6ct3b.mjs` and its gate-chains rows (t3b-unit, t3b-ingame, t3b-natural, t3b-look; impact rule)
- [ ] in game: t3b-ingame (run 1 at 20261017-200006-change), pin the hill, t3b-natural, look and gallery
- [ ] slice tier, gate-verifier, as-built, push

## Asks of the foundation (T3a) and notes for the merge

- `kit/lib/region/plan.mjs` meta: T3b added `bridges` and `tunnels` before round 2 did the same (identical line, merged clean).
- `kit/test/plan-p0.test.mjs`: round 2's `svOf` kept; T3b's `run` adds the two-plan flow for a fixture with `volume`
  (`plan-helpers.mjs` `checkPlanVolumes`, `fixtureVolume`).
- `kit/lib/region/checkWalls.mjs` (K1a's file) gained the postern reading (additive; no other behaviour changes).
- `kit/lib/plan/finish.mjs` gained the artifact's `guards` (only in a plan with a tunnel: every other artifact byte-identical).
- v38 is T3a's (the auto edge that bridges); T3b's auto tunnel is `v38b_auto_tunnel`.
- crossings_demo's goldens: both halves change the program; the golden is cut once at integration.

## Deviations to record in "T3b as built"

- §9: `underwater_domes/glass_tunnels` answers `blocked` as recorded (its endpoint zone `colony` wants ocean water: refused
  NO_FEATURE on the asks claim); with the zone placed it answers `unsupported {tunnel.under}`. Gap table: connector.tunnel 4 ->
  tunnel.under 3, blocked 1.
- NO_COVER is answered only when some line has surface cover but the volume's rock does not give 2 site-solid (sand, caves); every
  line without surface cover is `tunnel.under` (S-T3-4), so the "hump with 1 cover" refusal reads as tn01 (sand over the roof).
- The refusal fixtures pin the line with `approach: 0` (else the route moves the bore away from the hazard).
