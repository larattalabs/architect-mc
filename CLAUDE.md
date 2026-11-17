@AGENTS.md

# Claude Code specifics

- Gate checks are never self-certified. Who checks what follows docs/GATES.md "Speed rules" and "Lighter verification": light
  slices get no verifier; a strict slice gets its own early GPT review; per release the independent `gate-verifier` re-runs the
  strict steps (`gate-run.mjs change --only <steps> --no-cache`: an explicit list looks up the cache since slice GX, and a
  verifier never accepts a cached result).
- Subagents you start follow these same rules. They push their own branches and the parent merges them.
- Background waits: keep at most one at a time, with long blocks (15-20 min) or a single until-loop. Never stack short polls.
- Speed rules (docs/GATES.md "Speed rules", the current set; summary in AGENTS.md): pick the tier the brief names; re-run only
  failing steps; run only the unit tests for the files you touched plus their direct dependents (full suites at the batch merge,
  or when you touch shared core); timing benches flag, they don't fail; as-builts 10-15 lines.
