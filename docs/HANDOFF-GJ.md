# HANDOFF: slice GJ (a district joins a walled town through a standing gate)

Contract: docs/CONTRACT.md "Phase 7a slice GJ" (FROZEN 2026-10-20). D3's as-built wins over GJ's facts about D3.
Branch `slice/GJ` off origin/main d8da5f21, worktree `../_work/architect-mc-GJ`. Ports 8912-8917 (run dir, out and lock of its own).
DEV MODE: unit tests, instant lints, the slice's own in-game steps; the verifier re-runs items 6, 7 and 9 (removal, dry check).

## Status

- [ ] kit: gate geometry from an IR (`besideGates`), the third step (`gateJoin.mjs`), the districts emission, the IR's `reach.gate`,
      M28's gate rule, land; gj-unit tests
- [ ] mod: `BesideReach.gates` (parity), the wall region's reach inputs, the re-check's gate rule, dangling on the wall region's removal
- [ ] sidecar: the reach inputs' `gates` file
- [ ] plan/0 endpoint.region through a gate (`v7a_gj_endpoint`)
- [ ] driver `tools/gate7agj.mjs`, steps gj-unit / gj-ingame in gate-chains, step-inputs rebuilt
- [ ] in-game run (HOLD: the coordinator asked for no Minecraft runs during Steward's K3 RC until told)
- [ ] gate-verifier; push

## Design notes (as being built)

- The plan meta (`meta.walls`) is not in the IR the mod holds, so a standing region's gates are read from its IR: each graph node
  `kind: gate` (its `at`, port `facing` and `width`) and the opening columns of its wall part `w_<ref>` (a column with air, a door or
  a fence gate at `at.y` and a write above it, 4-connected to `at`'s column). The kit's `besideGates` and Java's `BesideReach.gates`
  are the same rule, checked equal on fixtures.
- D3's `d3_walled` (tools/gate6cd3.mjs item 11) is a SEALED ring (`gates: 0`): as built it is GJ's `gj_sealed`, and stays NO_JOIN
  [wall]. GJ's item 3 uses a new gated C38 ring (gates.min's default).
- Byte identity: the gates travel as their own member of the reach inputs (`gates`), never in `standing` (whose sha every reach IR
  records). The third step runs only where D3's reach step would throw `[wall]`.

## K3 follow-up (passage gates)

(filled in as built)

## RC note for Steward

(filled in as built)
