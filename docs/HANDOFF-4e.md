# Phase 4e handoff (journal-backed sites)

Branch `phase/4e` in the worktree `~/Developer/LarattaLabs/architect-mc-4e` (from `origin/main` 6de8f43, v0.7.0 / API 1.4.0 plus
the frozen 4e contract). Spec: docs/CONTRACT.md "Phase 4e contract", including "Coordinator decisions on N1-N7" and the final
"Changes from Steward's review" (which wins). Do not merge, tag or publish: the coordinator does that after the gate check.

## State

Started. Nothing built yet beyond this file.

## Gate status

Not run.

## Known issues

None yet.

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-4e
git fetch && git status
# build + unit tests
cp -c -R ~/Developer/LarattaLabs/architect-mc/.gradle-home . 2>/dev/null; cp -c -R ~/Developer/LarattaLabs/architect-mc/mod/.gradle mod/.gradle 2>/dev/null
cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline
```

In-game gate: ports 8890-8895 only (other sessions use other ranges). Kill only clients this session launched, by PID.
