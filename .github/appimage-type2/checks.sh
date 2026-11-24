#!/usr/bin/env bash
# Checks a Linux AppImage on a CI runner without libfuse2. One step per call: checks.sh <a|b|c|d|e>
# env: VARIANT = type2 | legacy, IMAGE = path of the AppImage, EXPECT_START = pass | fail (does it start without FUSE2?)
# Owns: printing the evidence for task_gcje1607 a-e. Never: touches a real profile or a real keyring; synthetic values only.
set -uo pipefail
step=${1:?a|b|c|d|e}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
img=$(readlink -f "${IMAGE:?}")
variant=${VARIANT:?}
expect=${EXPECT_START:?}

case "$step" in
a)
  echo "== a) libfuse2 is not installed on this runner ($variant)"
  . /etc/os-release; echo "runner: $PRETTY_NAME, glibc $(ldd --version | head -1)"
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends xvfb xauth x11-utils dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools \
    libgtk-3-0t64 libnss3 libasound2t64 squashfs-tools binutils file xxd
  echo "--- before: $(dpkg-query -W -f='${Package} ${Version} ${Status}\n' libfuse2t64 2>&1 | head -1)"
  sudo apt-get purge -y libfuse2t64 2>&1 | tail -4 || true
  echo "--- dpkg -s libfuse2 libfuse2t64 (must fail)"
  if dpkg -s libfuse2 libfuse2t64; then echo "FAIL: libfuse2 is installed"; exit 1; else echo "dpkg exit $? -> not installed"; fi
  echo "--- no libfuse.so.2 anywhere the loader looks:"
  if ldconfig -p | grep -F 'libfuse.so.2'; then echo "FAIL: libfuse.so.2 is known to the loader"; exit 1; else echo "ldconfig: no libfuse.so.2"; fi
  echo "--- what FUSE parts remain (fuse3 is the runtime's own mount path):"
  dpkg -l | grep -i fuse || true; ls -l /dev/fuse; command -v fusermount fusermount3 || true
  ;;
b)
  echo "== b) AppImage type and runtime ($variant)"
  ls -l "$img"
  echo "--- bytes 0..11 (ELF magic, then 'AI' + type at offset 8)"
  head -c 12 "$img" | xxd
  t=$(dd if="$img" bs=1 skip=8 count=3 2>/dev/null | xxd -p)
  echo "bytes 8..10 = $t (expected 414902 = 'AI\\x02')"
  [ "$t" = 414902 ] || { echo "FAIL: not AppImage type 2"; exit 1; }
  file "$img" | cut -c1-300
  python3 "$here/glibc-min.py" "$img" > "$RUNNER_TEMP/glibc-b.txt" 2>&1; head -6 "$RUNNER_TEMP/glibc-b.txt" | cut -c1-300
  echo "--- --appimage-version (runs the runtime only; needs libfuse2 for the legacy one):"
  "$img" --appimage-version 2>&1 | head -5; echo "exit ${PIPESTATUS[0]}"
  ;;
c)
  echo "== c) start under xvfb without libfuse2 and without --appimage-extract-and-run ($variant, expected: $expect)"
  unset APPIMAGE_EXTRACT_AND_RUN
  export HOME; HOME=$(mktemp -d); export WORKFORCE_FAKE_ENGINE=1
  echo "unshare -Ur true (decides whether AppRun adds --no-sandbox): $(unshare -Ur true 2>&1 && echo works || echo refused)"
  log=$(mktemp)
  xvfb-run -a -s '-screen 0 1280x800x24' bash -c '
    "$1" >"$2" 2>&1 &
    pid=$!
    for i in $(seq 1 25); do sleep 1; kill -0 $pid 2>/dev/null || break; done
    if kill -0 $pid 2>/dev/null; then echo "ALIVE after ${i}s: pid $pid"; alive=1; else wait $pid; echo "EXITED early with code $? after ${i}s"; alive=0; fi
    echo "--- process tree"; ps -eo pid,ppid,etimes,args --forest | grep -E "AppImage|autark|Autark|electron|AppRun" | grep -v grep | cut -c1-200 | head -15
    echo "--- X windows"; xwininfo -root -tree | grep -E "has no name|\"" | head -12
    kill $pid 2>/dev/null; sleep 2; pkill -f "/tmp/\.mount_" 2>/dev/null
    exit $((1-alive))
  ' _ "$img" "$log"
  rc=$?
  echo "--- AppImage output (first 40 lines)"; head -40 "$log" | cut -c1-240
  if [ "$expect" = pass ]; then
    [ $rc -eq 0 ] && echo "RESULT c: starts without libfuse2 (as expected)" || { echo "RESULT c: FAIL, did not stay up"; exit 1; }
  else
    [ $rc -ne 0 ] && echo "RESULT c: does NOT start without libfuse2 (as expected for the legacy runtime)" || { echo "RESULT c: legacy unexpectedly started"; exit 1; }
  fi
  ;;
d)
  echo "== d) keyring: safeStorage backend and Autark's behaviour ($variant)"
  # the legacy runtime cannot start without libfuse2, so its keyring baseline runs extracted (its content is the same)
  [ "$variant" = legacy ] && export APPIMAGE_EXTRACT_AND_RUN=1 && echo "(legacy baseline: APPIMAGE_EXTRACT_AND_RUN=1)"
  export WORKFORCE_APPIMAGE=$img
  export HOME; HOME=$(mktemp -d "$RUNNER_TEMP/autark-vault-home.XXXXXXXX")
  export XDG_RUNTIME_DIR="$HOME/run" XDG_DATA_HOME="$HOME/data" XDG_CONFIG_HOME="$HOME/config"
  mkdir -m 700 "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
  unset GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
  cd "$repo/apps/desktop"
  export SCREENSHOTS="$RUNNER_TEMP/appimage-keyring-shots-$variant"
  xvfb-run -a dbus-run-session -- bash -uo pipefail -c '
    bad=0
    export XDG_CURRENT_DESKTOP=GNOME
    echo "--- start gnome-keyring (disposable, synthetic fixture only)"
    openssl rand -hex 32 | tr -d "\n" | gnome-keyring-daemon --daemonize --replace --unlock --components=secrets
    locked=$(gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets/collection/login --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked)
    [[ "$locked" == "(<false>,)" ]] || { echo "keyring still locked: $locked"; exit 1; }
    gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias default /org/freedesktop/secrets/collection/login >/dev/null
    printf %s disposable-fixture | timeout 20 secret-tool store --label=Autark-CI-Check app autark-keyring-ci
    [[ "$(timeout 20 secret-tool lookup app autark-keyring-ci)" == disposable-fixture ]] && echo "secret-tool round trip on the disposable keyring: ok"
    echo "--- scenario 1: gnome-keyring running, default flags (what a normal GNOME user gets)"
    timeout 120 node ../../.github/appimage-type2/probe-backend.mjs keyring-default || bad=1
    echo "--- scenario 2: gnome-keyring running, --password-store=gnome-libsecret"
    timeout 120 node ../../.github/appimage-type2/probe-backend.mjs keyring-libsecret --password-store=gnome-libsecret || bad=1
    echo "--- scenario 3: no D-Bus session at all (Secret Service unreachable)"
    timeout 120 node ../../.github/appimage-type2/probe-backend.mjs no-bus --no-bus || bad=1
    echo "--- the repository test: no keyring -> repair window, no DB; keyring -> secrets saved, encrypted and read back"
    node --test test/ui/linux-keyring-appimage.test.mjs || bad=1
    exit $bad
  '
  ;;
e)
  echo "== e) glibc minimum ($variant): runtime and content separately"
  python3 "$here/glibc-min.py" "$img"
  ;;
*) echo "unknown step $step"; exit 2;;
esac
