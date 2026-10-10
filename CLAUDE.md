@AGENTS.md

# Claude Code specifics

- Gate checks are verified by an independent `gate-verifier` agent, never by the builder itself. Per slice it reviews the
  diff plus the runner's evidence and re-runs only the risky steps; at release it reproduces everything.
- Subagents you start follow these same rules. They push their own branches and the parent merges them.
- Background waits: keep at most one at a time, with long blocks (15-20 min) or a single until-loop. Never stack short polls.
