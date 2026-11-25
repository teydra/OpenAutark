#!/bin/bash
# Installs and builds the parts of apps/desktop and services/remote-relay the Simulator run needs, starts the PC (e2e-pc.mjs) in the
# background and waits until it wrote <out-dir>/pc.json. usage: pc-up.sh <checkout-root> <out-dir>
set -euo pipefail
ROOT=$(cd "$1" && pwd)
mkdir -p "$2"
OUT=$(cd "$2" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
stamp() { echo "[$(date +%H:%M:%S)] $*"; }
stamp "node $(node --version)"
stamp "meeting server: npm ci"
( cd "$ROOT/services/remote-relay" && npm ci --no-audit --no-fund --loglevel=error )
stamp "desktop: npm ci (no install scripts: no Electron binary is needed)"
( cd "$ROOT/apps/desktop" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error )
stamp "desktop: build the headless runtime and the phone UI"
( cd "$ROOT/apps/desktop" && node scripts/build.mjs --only cli,ui && ls app | head -20 )
stamp "starting the PC"
nohup node "$HERE/e2e-pc.mjs" "$ROOT" "$OUT" > "$OUT/pc.stdout" 2> "$OUT/pc.stderr" &
echo $! > "$OUT/pc.pid"
for i in $(seq 1 180); do
  [ -f "$OUT/pc.json" ] && break
  kill -0 "$(cat "$OUT/pc.pid")" 2>/dev/null || { echo "the PC stopped early:"; tail -30 "$OUT/pc.stderr"; tail -10 "$OUT/pc.stdout"; exit 1; }
  sleep 1
done
[ -f "$OUT/pc.json" ] || { echo "the PC did not come up in 3 minutes"; tail -30 "$OUT/pc.stderr"; exit 1; }
stamp "the PC is up"
cat "$OUT/pc.json"; echo
