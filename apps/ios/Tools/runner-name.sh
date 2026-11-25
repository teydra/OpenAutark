#!/bin/sh
# Konrad #53 (21.11.2026): the runner's host app is called "Autark Control" on the home screen. Xcode builds that host
# (<PRODUCT_NAME>-Runner.app) by copying its own XCTRunner.app template and expanding only the bundle id and CFBundleName macros
# (build log, CopyPlistFile), so no build setting reaches it: this sets CFBundleDisplayName in the built bundle afterwards.
# Bundle ids stay. Run it on every build of the runner before it is signed or installed (CI: Simulator and device bundle; the PC
# signs the device bundle anyway). macOS only (plutil).
#   runner-name.sh <path to AutarkRunnerUITests-Runner.app> [name]
set -eu
APP="$1"
NAME="${2:-Autark Control}"
test -f "$APP/Info.plist" || { echo "no Info.plist in $APP" >&2; exit 1; }
plutil -replace CFBundleDisplayName -string "$NAME" "$APP/Info.plist"
plutil -extract CFBundleDisplayName raw "$APP/Info.plist"
