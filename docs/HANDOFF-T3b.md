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

- [ ] Java: `PlanRequest.load`, two-plan check, `generate`, stale rock
- [ ] kit: tunnelGeom (bore, cut, shell, lining, sealing, gravity, fluids, portals, lamps)
- [ ] foundation merged (`origin/t3/foundation`)
- [ ] tunnel row, compile hooks, posterns, lenient via, emission, checks, fixtures
- [ ] gate driver and items 2-6, 9 (tunnels), §9 tunnel rows, look
- [ ] slice tier, gate-verifier, as-built, push

## Asks of the foundation (T3a)

(none yet)
