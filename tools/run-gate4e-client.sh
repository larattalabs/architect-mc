#!/bin/zsh
# Dev client for the phase 4e gate (tools/gate4e.mjs): DevBridge and sidecar on 8891/8890 (the 0.7.0 client of the migration
# step uses 8893/8892; other sessions use other ranges), apitest on the classpath, the stub sidecar (no Claude), the checkout's
# kit, screenshots into artifacts/gate4e/shots/ of the main checkout.
#   ARCHITECT_AUTOWORLD_NAME="G4E Base" tools/run-gate4e-client.sh
#   (then: ARCHITECT_DEV_PORT=8891 node tools/devcli.mjs wait; ARCHITECT_DEV_PORT=8891 node tools/gate4e.mjs <step>)
# ARCHITECT_APITEST=0 leaves the apitest mod off the classpath (gate 11 puts the 1.4.0 apitest jar into mod/run/mods instead).
set -e
W=${0:A:h:h}
MAIN=${W:h}/architect-mc
export ARCHITECT_PORT=${ARCHITECT_PORT:-8890}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-8891}
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/mod/src/test/resources/stub-sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$MAIN/artifacts/gate4e/shots}
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
