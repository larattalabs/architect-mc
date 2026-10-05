#!/bin/zsh
# Dev client for the phase 4d gate (tools/gate4d.mjs): DevBridge and sidecar on 8890/8891 (other sessions use 7890-8791 and
# 8490/8590), apitest on the classpath, the stub sidecar (no Claude), the checkout's kit, screenshots into artifacts/gate4d/shots/.
#   ARCHITECT_AUTOWORLD_NAME="G4D Base" tools/run-gate4d-client.sh
#   (then: ARCHITECT_DEV_PORT=8891 node tools/devcli.mjs wait; ARCHITECT_DEV_PORT=8891 node tools/gate4d.mjs)
# ARCHITECT_AUTOWORLD_MODE: creative (default) | survival | hardcore.
set -e
W=${0:A:h:h}
export ARCHITECT_PORT=${ARCHITECT_PORT:-8890}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8891}
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/mod/src/test/resources/stub-sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$W/artifacts/gate4d/shots}
export ARCHITECT_FOCUS=${ARCHITECT_FOCUS:-0}
export STUB_COPY_FROM=${STUB_COPY_FROM:-$W/kit/examples/cabin}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
cd $W/mod
export ARCHITECT_APITEST=1
exec ./gradlew --offline --no-daemon :runClient
