#!/bin/zsh
# Dev client for the phase 4a API checks (apitest on the classpath): DevBridge and sidecar on 8190/8191 (other sessions use 7890/7891 and 7990/7991, 8090/8091),
# the checkout's kit, screenshots into artifacts/apitest/shots/. Two sidecars:
#   (default)  the stub sidecar (protocol 1, no Claude)
#   --sim      the real sidecar (sidecar/, protocol 2) with its sim backend (--backend sim: designs and jobs without Claude),
#              started by the game's launcher, so `dev.launcher.restart` restarts it. Needs sidecar/dist (npm run build) and
#              sidecar/node_modules. No credentials reach the helper.
#   ARCHITECT_AUTOWORLD_NAME="API Survival" ARCHITECT_AUTOWORLD_MODE=survival ARCHITECT_AUTOWORLD_CHEATS=1 tools/run-apitest-client.sh [--sim]
#   (then: ARCHITECT_DEV_PORT=8191 node tools/devcli.mjs wait; node tools/apitest.mjs survival | jobs)
# ARCHITECT_AUTOWORLD_MODE: creative | survival | hardcore (hardcore worlds get no cheats unless ARCHITECT_AUTOWORLD_CHEATS=1).
set -e
W=${0:A:h:h}
export ARCHITECT_PORT=${ARCHITECT_PORT:-8190}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8191}
if [[ $1 == --sim ]]; then
  export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/sidecar}
  export ARCHITECT_SIDECAR_BACKEND=sim
  unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
  [[ -f $ARCHITECT_SIDECAR_DIR/dist/main.mjs ]] || { echo "no $ARCHITECT_SIDECAR_DIR/dist/main.mjs (cd sidecar && npm run build)"; exit 1; }
fi
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/mod/src/test/resources/stub-sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$W/artifacts/apitest/shots}
export ARCHITECT_FOCUS=${ARCHITECT_FOCUS:-0}
export STUB_COPY_FROM=${STUB_COPY_FROM:-$W/kit/examples/cabin}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
cd $W/mod
export ARCHITECT_APITEST=1
exec ./gradlew --offline --no-daemon :runClient
