#!/bin/bash
# The app's own phone interface (owner 27.11.2026): builds apps/desktop's UI (`node scripts/build.mjs --only ui`), copies app/ui whole to
# <apps/ios>/build/ui (project.yml carries that folder in the app as `ui`, the app answers the company's origin from it) and writes the
# list of its files next to it, ui.json (scripts/ui-list.mjs, unsigned: the app's own package needs no signature; a later interface is
# published apart and verified by the app). The same steps as apps/android/build.ps1's interface part. Nothing here is committed
# (build/ is ignored). Run before `xcodegen generate`.
# usage: build-ui.sh [<checkout root, default: the repository this script is in>]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "${1:-$HERE/../../..}" && pwd)
DESKTOP="$ROOT/apps/desktop"
TARGET="$HERE/../build/ui"
stamp() { echo "[$(date +%H:%M:%S)] $*"; }
[ -d "$DESKTOP/node_modules" ] || { stamp "desktop: npm ci (no install scripts: no Electron binary is needed)"; ( cd "$DESKTOP" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error ); }
stamp "desktop: build the phone UI"
( cd "$DESKTOP" && node scripts/build.mjs --only ui )
[ -f "$DESKTOP/app/ui/index.html" ] || { echo "the interface (apps/desktop/app/ui/index.html) was not built"; exit 1; }
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$DESKTOP/app/ui/." "$TARGET/"
( cd "$DESKTOP" && node scripts/ui-list.mjs "$TARGET" )
[ -f "$TARGET/ui.json" ] || { echo "the interface list (ui.json) was not written"; exit 1; }
[ ! -f "$TARGET/ui.json.sig" ] || { echo "an unsigned list must not carry a signature"; exit 1; }
stamp "the app's interface: $(find "$TARGET" -type f | wc -l | tr -d ' ') files, $(du -sk "$TARGET" | cut -f1) KB in $TARGET"