#!/bin/zsh
# Dev client for the phase 2 library checks: DevBridge and sidecar on ports away from the defaults (another session may
# use 7890/7891), the stub sidecar, the checkout's kit, screenshots into artifacts/mod-p2/.
#   tools/run-p2-client.sh            (then: ARCHITECT_DEV_PORT=7991 ARCHITECT_GAME_DIR=mod/run node tools/devcli.mjs wait)
set -e
W=${0:A:h:h}
export ARCHITECT_PORT=${ARCHITECT_PORT:-7990}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-7991}
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/mod/src/test/resources/stub-sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$W/artifacts/mod-p2}
export STUB_COPY_FROM=${STUB_COPY_FROM:-$W/kit/examples/cabin}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
cd $W/mod
exec ./gradlew --offline --no-daemon runClient
