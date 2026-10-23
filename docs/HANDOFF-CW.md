# HANDOFF: slice CW (catwalks along a face)

Branch `slice/CW`, worktree `../architect-mc-CW`, off `origin/7a/foundation` (merged through 0551d9c7). Contract: docs/CONTRACT.md "Phase
7a slice CW"; the as-built section follows it (its Gate row pending). Delete this file when the slice gate passes.

## Done (offline, $0)

- Kit: geometry, route row 10, compile hooks, M10:catwalk/M5catwalk, the catalogue flip, style chains, catwalks_demo, fixtures (valid/v7a_cw_cliff,
  cw/ r01-r05 u01-u03 k01, even/ew03), the lint's catwalk cases, the `catwalks` feature (one Java line, ApiCWTest).
- cw-unit locally: unit 4/4 items; unchanged 310 of 312 byte-identical, the 2 the foundation's F7A_MOVED.
- Shared edits pushed to 7a/foundation as 5ef1bc02 (`rec.t7`; the f7a test's diff rule): CL merges it.

## Queued

- `gate-run 7acw-pin` (PID 4264, its own process group): log `<main>/artifacts/gate7a-cw/pin-run.log`, run worktree `../architect-mc-CW-run`,
  ports 8936/8937, lock `<main>/artifacts/gate-runs/cw.lock`, evidence `<main>/artifacts/gate-runs/<ts>-7acw-pin/`. It waits for the
  v0.42.0 release's machine hold. **It writes `scenarios/sites/cliff_face.json` in the run worktree**: copy it to this branch and commit it
  before any other run reuses `../architect-mc-CW-run`. If no candidate of 160 meets the bar, report it (do not lower FACE_BAR or the
  `picks[0] === ok` rule).

## After v0.42.0 is tagged

1. Merge origin/main; commit the pinned site.
2. `node tools/gate-run.mjs slice --since origin/main` (about 81 steps: route.mjs and program.mjs hit "kit: region synthesis"); it holds
   cw-ingame, cw-survival, cw-natural, t2-unit, k1b-unit and cw-unit.
3. `node tools/gate-run.mjs 7acw-look ...` (a client), then the gallery for Noah (N-CW-1; the close-up: the rail on its bed, the lanes,
   a landing).
4. Gate-verifier (re-runs item 7); fill the as-built Gate row; push; "ready to merge".
