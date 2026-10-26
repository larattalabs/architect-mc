# HANDOFF: 7a slice LF (lifts), branch `slice/LF`

Resume notes for slice LF (docs/CONTRACT.md "Phase 7a slice LF: lifts, bubble columns against a face", and its "as built" table).
Delete this file when the slice merges.

## State

- Built and gated in DEV MODE on `slice/LF` (off main 87ed021e). Versions are `NEXT` placeholders; the coordinator numbers them at
  merge (`node tools/release-version.mjs ...`).
- **Not merged: LF needs a Steward RC** (CONTRACT §"LF changes the fluids stage and adds a global StillOurs row"; S-LF-2; GATES
  DEV MODE: "Steward RC only when the API Steward calls changes"). The coordinator relays the RC note below to Steward; nobody on the
  slice messages Steward.

## RC note for Steward (S-LF-2)

LF changes API Steward calls in three places, all additive:

1. **The journal's "still ours" gains a global row** (`journal/StillOurs.fluidHolds`): a cell written as `bubble_column` holds as any
   `bubble_column` (either `drag`), as a water source, or as air; a cell written as a water source holds as a `bubble_column`. It reaches
   everything that reads "still ours": deltas, `versionOf`, PT2's adopt counts, survival `matches`, the undo. Before LF, a written water
   source over soul sand or magma that vanilla turned into a column read as "not ours".
2. **The fluids stage has a new body**: a lift's column (`connector.lift`), written in the `fluids` stage as `bubble_column` states
   (the IR kind `bubbleColumns`, the fluid op's `bubble` member), census-exact (each column cell counted as a source of its body only
   as a column of its own drag), drained first on removal (H §4.1: the column, then after one settle bound the shell, doors and base).
   Its rows appear in the region's `architect_mc:fluids` ext (H's shape `{part, body, state, reason, at}`), and the siteplan's `waters[]`
   carries `kind: "lift"`.
3. **A new plan kind is supported**: `connector.lift` (catalogue entry reserved -> supported, schemaVersion 1, `limits {rise [4, 64],
   approach 32, shell 2, lightEvery 6, headroom 3, movers ["player"]}`; no frozen volume). Player-only by kind (S-7a-8): a part whose own
   `movers` names `villager` answers `refused MOVER` with a `stair` wouldFit where one fits alone, else a `path`'s. Your two recorded
   lifts (`treetop_village/storehouse_lift`, `upside_down/winch_lift`) now answer `refused NO_CLIMB` with a `path` wouldFit that fits alone
   (the asks claim is flat), not `unsupported`.

**What we ask you to run on the RC (S-LF-2, default yes):**
- a lift realised and removed (realiseApproved, then `Regions.remove`: E-flat 0, the columns drained first);
- a delta and a PT2 adopt over a standing lift (the column's own drag ticks change no count);
- with RS, a survival lift (the shell bought bottom up, soul sand and magma from the stockpile, the water free, the column written after
  its last paid cell; bills equal `cost.survival.bom`).

## API delta (exact)

| Where | Delta |
|---|---|
| Feature strings | `liftConnectors` (mod `ApiRules`: sidecar feature `region.lifts` -> `liftConnectors`; `ArchitectApi.features()` javadoc "Since NEXT"); sidecar `FEATURES` appends `region.lifts` |
| Catalogue (`kit/schemas/plan.json`, golden) | `connector.lift`: `reserved, until 7a, schemaVersion 0` -> `supported, schemaVersion 1, def #/$defs/connector.lift, sinceApi NEXT, limits {rise: [4, 64], approach: 32, shell: 2, lightEvery: 6, headroom: 3, movers: ["player"]}, note` (catalogue version unchanged: the coordinator's) |
| Plan answers | a lift part's `geometry.lifts: [{rise, down, side?, move, dir, from, to, crossing: {type: "lift", rise, down}, body}]`; `cost.bom` (its tower: the bubble cells are water, free); notes; refusals `NO_CLIMB {rise, need: 4}`, `SPAN {rise, min, max}`, `ANCHOR {why: face \| foot, cells}`, `HEADROOM {cells, need: 3}`, `WATER {columns}`, `PROTECTED {columns, kind?: body}`, `MOVER {movers, kind: lift}`, `UNREACHABLE`, `NO_ROOM {why: clear, body}` (KC at emit) |
| Graph | edge `type: "lift"`, `crossing {type: "lift", rise, down}`, `movers: ["player"]` |
| siteplan/1 | `lifts[] {id, part, foot, top, rise, down}` (the foundation's shape, now filled); `waters[].kind` gains `"lift"` |
| IR | format-2 kind `bubbleColumns` appended to `KINDS_FORMAT2` (kit `realise.mjs`, mod `IrStale`): a mod or kit before LF refuses such a plan PLAN_STALE; the `fluid` op's new member `bubble: [{state: "minecraft:bubble_column[drag=false\|true]", cells: runs}]` (each cell one of `cells`) |
| Journal | `StillOurs.fluidHolds`: the bubble column row (above) |
| Fluids stage (mod) | `RegionFluids`: the bubble set read; bubble cells written as their states by a re-write; a block tick instead of a fluid tick on them; the census requires the column of its drag; the gate's check reads a column cell as open |
| DevBridge (test hooks) | `dev.lift.ride`, `dev.lift.spawnRule` (docs/DEVBRIDGE.md changelog) |
| Not changed | no record, method, enum value or reason code; no `PlanChecks` change (a lift asks no frozen volume) |

## Gate evidence

See CONTRACT "Phase 7a slice LF as built" (Gate row) for the runs, and the gallery link. The verifier re-runs items 8 (exact undo), 9
(StillOurs) and 10 (survival).

## Next

1. Steward's RC (above), relayed by the coordinator.
2. Merge (coordinator): `release-version.mjs` stamps `sinceApi: NEXT` and the javadoc; FB (batch 7a-3) reads LF's airlock as M16's first
   designed exception.
