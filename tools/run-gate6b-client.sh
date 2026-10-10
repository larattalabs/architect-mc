#!/bin/zsh
# Dev client for the phase 6b gate (tools/gate6b.mjs): the real sidecar (sidecar/dist, --backend sim: no Claude, no keys) with
# this checkout's kit, apitest on the classpath, DevBridge 8891 and sidecar 8890 (ARCHITECT_DEV_PORT/ARCHITECT_PORT override).
# ARCHITECT_XMX caps the heap (default 4G).
#   ARCHITECT_AUTOWORLD_NAME="G6B Base" tools/run-gate6b-client.sh
set -e
W=${0:A:h:h}
MAIN=${W:h}/architect-mc
export ARCHITECT_PORT=${ARCHITECT_PORT:-8890}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8891}
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/sidecar}
# the sim backend, unless a paid gate step asks for the claude login (ARCHITECT_GATE6B_BACKEND=claude: the sidecar's
# secrets.json opt-in useClaudeLogin is written by tools/gate6b.mjs; never an API key: every ANTHROPIC_* / CLAUDE* is unset)
for v in ${(k)parameters[(I)ANTHROPIC_*]} ${(k)parameters[(I)CLAUDE*]}; do unset $v; done
export ARCHITECT_SIDECAR_BACKEND=${ARCHITECT_GATE6B_BACKEND:-sim}
[[ -f $ARCHITECT_SIDECAR_DIR/dist/main.mjs ]] || { echo "no $ARCHITECT_SIDECAR_DIR/dist/main.mjs (cd sidecar && npm run build)"; exit 1; }
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$MAIN/artifacts/gate6b/shots}
export ARCHITECT_FOCUS=${ARCHITECT_FOCUS:-0}
export STUB_COPY_FROM=${STUB_COPY_FROM:-$W/kit/examples/cabin}
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
