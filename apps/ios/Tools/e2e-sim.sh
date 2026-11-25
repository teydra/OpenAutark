#!/bin/bash
# The Simulator half of the run: the E2E UI test (E2E/AutarkE2EUITests.swift) launches the app against the real PC (pc-up.sh started it),
# watches it pair, waits for the page's chat, types "Hallo" into it, taps Send, waits for the Echo answer and writes the screenshots.
# This script only runs that test (built before by `xcodebuild build-for-testing`, see ios-e2e.yml) and keeps what it left behind.
# It exits with the test's status: no chat or no answer on screen means red.
# usage: e2e-sim.sh <simulator-udid> <derived-data-dir> <pc-out-dir> <screenshots-dir>   (run in apps/ios)
UDID=$1; DD=$2; OUT=$3; SHOTS=$4
mkdir -p "$SHOTS"
stamp() { echo "[$(date +%H:%M:%S)] $*"; }
stamp "PC: $(cat "$OUT/pc.json")"

# the UI test finds the PC's folder and the screenshot folder through these (a fallback file for the case the variables do not arrive)
printf '{"out":"%s","shots":"%s"}' "$OUT" "$SHOTS" > /tmp/autark-e2e-config.json
export TEST_RUNNER_AUTARK_E2E_OUT="$OUT" TEST_RUNNER_AUTARK_E2E_SHOTS="$SHOTS"

xcrun simctl ui "$UDID" appearance light || true

# diagnostics: what the app and the page's web process do after the PC accepted the phone (the run of 24.11.2026 21:50 hung there:
# every UI query timed out). `sample` shows where each thread of those processes is; the files go into the artifact.
sampler() {
  for _ in $(seq 1 400); do grep -q '"event":"accepted"' "$OUT/pc.log" 2>/dev/null && break; sleep 1; done
  prev=0
  for at in 5 25 55 90; do
    sleep $((at - prev)); prev=$at
    for pid in $(pgrep -f 'Autark.app/Autark$|com.apple.WebKit.WebContent' | head -4); do
      name=$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)")
      sample "$pid" 3 -file "$SHOTS/sample-$at-$name-$pid.txt" > /dev/null 2>&1
    done
    ps -axo pid,pcpu,rss,comm 2>/dev/null | sort -k2 -nr | head -8 > "$SHOTS/ps-$at.txt"
  done
}
# Opt in for a suspected hang; sampling and its diagnostics compete with WebKit on the runner.
SAMPLER=
if [[ "${AUTARK_E2E_SAMPLE:-0}" == 1 ]]; then
  sampler &
  SAMPLER=$!
fi

set -o pipefail
xcodebuild test-without-building \
  -project Autark.xcodeproj -scheme AutarkE2E \
  -destination "id=$UDID" \
  -derivedDataPath "$DD" \
  -only-testing:AutarkE2EUITests/AutarkE2EUITests/testPairOpenChatSendAndEcho \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | tee "$SHOTS/xcodebuild-test.log" | grep -E 'AUTARK-E2E|Test Case|error:|failed|passed|Executed|\*\* TEST' | tail -n 80
STATUS=${PIPESTATUS[0]}
stamp "xcodebuild test exit status $STATUS"
if [[ -n "$SAMPLER" ]]; then kill "$SAMPLER" 2>/dev/null || true; fi

# the Simulator's own picture of the end, independent of the test's screenshots
xcrun simctl io "$UDID" screenshot "$SHOTS/99-simulator-ende.png" || true
ls -l "$SHOTS" || true
exit "$STATUS"
