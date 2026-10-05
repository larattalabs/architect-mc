#!/bin/zsh
# Dev client for the phase 4a API checks (apitest on the classpath): DevBridge and sidecar on 8190/8191 (other sessions use 7890/7891 and 7990/7991, 8090/8091),
# the stub sidecar (no Claude), the checkout's kit, screenshots into artifacts/apitest/shots/.
#   ARCHITECT_AUTOWORLD_NAME="API Survival" ARCHITECT_AUTOWORLD_MODE=survival ARCHITECT_AUTOWORLD_CHEATS=1 tools/run-apitest-client.sh
#   (then: ARCHITECT_DEV_PORT=8191 node tools/devcli.mjs wait)
# ARCHITECT_AUTOWORLD_MODE: creative | survival | hardcore (hardcore worlds get no cheats unless ARCHITECT_AUTOWORLD_CHEATS=1).
set -e
W=${0:A:h:h}
export ARCHITECT_PORT=${ARCHITECT_PORT:-8190}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8191}
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
