#!/bin/zsh
# Dev client for the README screenshots: no Claude usage, no credentials, ports away from the defaults (another session may
# use 7890/7891). Three modes:
#
#   tools/run-readme-client.sh            the real sidecar with the sim designer (`--backend sim`), started here; the game
#                                         reuses it. Variants and imports run through the real kit; a "design" installs a
#                                         kit example after a few fake progress steps. World, library and placement shots.
#   tools/run-readme-client.sh --stub     the stub sidecar (mod/src/test/resources/stub-sidecar), started by the game:
#                                         Designs-tab progress lines without the sim's "(simulated)" suffix.
#   tools/run-readme-client.sh --helper   the real sidecar with the Claude designer, started by the game, with no
#                                         credentials: a new player's Status tab ("no credentials yet"). Don't submit designs.
#   tools/run-readme-client.sh --stop     stop the sim sidecar the default mode started
#
# Then: node tools/devcli.mjs --port 7991 wait. Steps and camera positions: tools/scenes/readme.json.
# Needs sidecar/dist/main.mjs (cd sidecar && npm run build). Screenshots go to artifacts/readme/ (ARCHITECT_SHOTS_DIR).
set -e
W=${0:A:h:h}
MODE=sim
case $1 in
  --stub) MODE=stub; export ARCHITECT_SIDECAR_DIR=$W/mod/src/test/resources/stub-sidecar ;;
  --helper) MODE=helper ;;
  --stop) MODE=stop ;;
esac
export ARCHITECT_PORT=${ARCHITECT_PORT:-7990}
export ARCHITECT_DEV_PORT=${ARCHITECT_DEV_PORT:-7991}
export ARCHITECT_SIDECAR_DIR=${ARCHITECT_SIDECAR_DIR:-$W/sidecar}
export ARCHITECT_KIT_DIR=${ARCHITECT_KIT_DIR:-$W/kit}
export ARCHITECT_SHOTS_DIR=${ARCHITECT_SHOTS_DIR:-$W/artifacts/readme}
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@25}
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-$W/.gradle-home}
# No credentials reach the helper or the game.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_SCOPES
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY

DATA=$W/mod/run/architect/sidecar-data
PIDFILE=$DATA/readme-sim.pid
if [[ $MODE == stop ]]; then
  [[ -f $PIDFILE ]] && kill $(<$PIDFILE) 2>/dev/null && echo "stopped sim sidecar $(<$PIDFILE)"
  rm -f $PIDFILE
  exit 0
fi

mkdir -p $DATA $W/mod/run/architect/library $ARCHITECT_SHOTS_DIR
if [[ $MODE == sim ]] && { ! [[ -f $PIDFILE ]] || ! kill -0 $(<$PIDFILE) 2>/dev/null; }; then
  node $ARCHITECT_SIDECAR_DIR/dist/main.mjs --port $ARCHITECT_PORT --data $DATA --library $W/mod/run/architect/library \
    --kit $ARCHITECT_KIT_DIR --backend sim > $DATA/readme-sim.out 2>&1 &
  echo $! > $PIDFILE
  for i in {1..50}; do [[ -f $DATA/sidecar.json ]] && break; sleep 0.2; done
  echo "sim sidecar pid $(<$PIDFILE) on :$ARCHITECT_PORT"
fi
cd $W/mod
exec ./gradlew --offline runClient
