#!/bin/bash
# usage: check.sh build|test [filter]   – syncs apps/ios from the Windows clone into ~/ios and builds there (WSL, Linux Swift)
export PATH=$HOME/swift/swift-6.4.3-RELEASE-ubuntu24.04/usr/bin:/usr/local/bin:/usr/bin:/bin
SRC="/mnt/c/Users/Heess/AppData/Roaming/Autark Companies/company-2/workspace/apple-plattformen/repo/apps/ios"
mkdir -p ~/ios
rsync -a --delete --exclude .build "$SRC/" ~/ios/
cd ~/ios
mode=$1; shift
if [ "$mode" = build ]; then swift build 2>&1 | tail -${LINES_MAX:-80}; else swift test "$@" 2>&1 | tail -${LINES_MAX:-120}; fi
