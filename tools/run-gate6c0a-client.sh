#!/bin/zsh
# Dev client for the phase 6c slice 0a gate (tools/gate6c0a.mjs): the helper BUNDLED in the build (architect-sidecar/, as in the
# published jar; ARCHITECT_SIDECAR_DIR and ARCHITECT_KIT_DIR are unset) started by the launcher with --backend sim, as a
# consumer would run it (README "Testing against Architect"): no Claude, no keys, no npm install. ARCHITECT_SIM_COSTS passes
# through (default "measured"). DevBridge and sidecar on 8903/8902 (ARCHITECT_DEV_PORT/ARCHITECT_PORT override).
#   ARCHITECT_AUTOWORLD_NAME="G6C0A Base" tools/run-gate6c0a-client.sh
set -e
W=${0:A:h:h}
MAIN=${W:h}/architect-mc
export ARCHITECT_PORT=${ARCHITECT_PORT:-8902}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8903}
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
unset ARCHITECT_SIDECAR_DIR ARCHITECT_KIT_DIR
export ARCHITECT_SIDECAR_BACKEND=sim
export ARCHITECT_SIM_COSTS=${ARCHITECT_SIM_COSTS:-measured}
[[ -f $W/sidecar/dist/main.mjs ]] || { echo "no $W/sidecar/dist/main.mjs: the build would bundle no helper (cd sidecar && npm run build)"; exit 1; }
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$MAIN/artifacts/gate6c0a/shots}
export ARCHITECT_FOCUS=${ARCHITECT_FOCUS:-0}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
cd $W/mod
if [[ ! -f run/options.txt ]]; then
	mkdir -p run && cp run-template/options.txt run/options.txt
fi
sed -i '' 's/^enableVsync:true/enableVsync:false/' run/options.txt
export ARCHITECT_APITEST=${ARCHITECT_APITEST:-1}
if [[ $ARCHITECT_APITEST == 0 ]]; then
	unset ARCHITECT_APITEST
fi
exec ./gradlew --offline --no-daemon :runClient
