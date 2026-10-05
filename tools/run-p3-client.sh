#!/bin/zsh
# Dev client for the phase 3 survival checks: DevBridge and sidecar on 8090/8091 (other sessions use 7890/7891 and 7990/7991),
# the stub sidecar (no Claude), the checkout's kit, screenshots into artifacts/gate3-dryrun/shots/.
#   ARCHITECT_AUTOWORLD_NAME="P3 Survival" ARCHITECT_AUTOWORLD_MODE=survival tools/run-p3-client.sh
#   (then: ARCHITECT_DEV_PORT=8091 node tools/devcli.mjs wait)
# ARCHITECT_AUTOWORLD_MODE: creative | survival | hardcore (hardcore worlds get no cheats unless ARCHITECT_AUTOWORLD_CHEATS=1).
set -e
W=${0:A:h:h}
export ARCHITECT_PORT=${ARCHITECT_PORT:-8090}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8091}
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/mod/src/test/resources/stub-sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$W/artifacts/gate3-dryrun/shots}
export ARCHITECT_FOCUS=${ARCHITECT_FOCUS:-0}
export STUB_COPY_FROM=${STUB_COPY_FROM:-$W/kit/examples/cabin}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
cd $W/mod
exec ./gradlew --offline --no-daemon runClient
