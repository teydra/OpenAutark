#!/bin/bash
# Runs the Swift phone (Linux build) against the real meeting server + real desktop PC code (tools/real-pc.mjs), in WSL.
# usage: interop.sh            – syncs apps/ios and tools into ~, starts the harness, runs the RealPcInteropTests, stops the harness
export PATH=$HOME/swift/swift-6.4.3-RELEASE-ubuntu24.04/usr/bin:$HOME/node/node-v24.18.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
BASE="/mnt/c/Users/Heess/AppData/Roaming/Autark Companies/company-2/workspace/apple-plattformen"
CODE="/mnt/c/Users/Heess/Projekte/Proactive Agent Workforce/code"
mkdir -p ~/ios ~/tools
rsync -a --delete --exclude .build "$BASE/repo/apps/ios/" ~/ios/
cp "$BASE/tools/real-pc.mjs" ~/tools/
LOG=$HOME/real-pc.log
rm -f "$LOG"
mkfifo ~/real-pc.in 2>/dev/null || true
# the harness ends when its stdin closes: keep a writer open for the length of this script
exec 9<>~/real-pc.in
node --experimental-strip-types ~/tools/real-pc.mjs "$CODE" <&9 > "$LOG" 2> ~/real-pc.err &
PC=$!
for i in $(seq 1 50); do grep -q '"event":"ready"' "$LOG" 2>/dev/null && break; sleep 0.2; done
READY=$(grep '"event":"ready"' "$LOG" | head -1)
if [ -z "$READY" ]; then echo "harness did not start"; cat ~/real-pc.err | head -20; kill $PC 2>/dev/null; exit 1; fi
export AUTARK_REAL_RELAY=$(echo "$READY" | sed -E 's/.*"relay":"([^"]+)".*/\1/')
export AUTARK_REAL_REMOTE_ID=$(echo "$READY" | sed -E 's/.*"remoteId":"([0-9]+)".*/\1/')
export AUTARK_REAL_VERSION=$(echo "$READY" | sed -E 's/.*"version":"([^"]+)".*/\1/')
export AUTARK_REAL_LOG="$LOG"
echo "harness: $AUTARK_REAL_RELAY remote id $AUTARK_REAL_REMOTE_ID"
cd ~/ios
swift test --filter RealPcInteropTests 2>&1 | grep -E "error|passed|failed|Executed|XCTAssert|skipped|Test Case" | head -40
echo "--- harness events"
grep -v '"event":"http"' "$LOG" | cut -c1-200 | head -30
grep '"event":"http"' "$LOG" | cut -c1-160 | head -12
kill $PC 2>/dev/null
exec 9>&-
