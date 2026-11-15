#!/usr/bin/env bash
# fetch.sh <ios|android> <workdir>: depot_tools and the WebRTC checkout at the pinned commit, no history.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/pins.env"
platform="$1"
work="$2"
case "$platform" in
  ios) target_os='["ios", "mac"]' ;;
  android) target_os='["android", "unix"]' ;;
  *) echo "usage: fetch.sh <ios|android> <workdir>" >&2; exit 2 ;;
esac
mkdir -p "$work"
cd "$work"
if [ ! -d depot_tools/.git ]; then
  git init -q depot_tools
  git -C depot_tools fetch -q --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_COMMIT"
  git -C depot_tools checkout -q FETCH_HEAD
fi
export PATH="$work/depot_tools:$PATH"
export DEPOT_TOOLS_UPDATE=0
cat > .gclient <<GCLIENT
solutions = [{
  "name": "src",
  "url": "https://webrtc.googlesource.com/src.git@$WEBRTC_COMMIT",
  "deps_file": "DEPS",
  "managed": False,
  "custom_deps": {},
}]
target_os = $target_os
GCLIENT
gclient sync --nohooks --no-history --shallow -D --revision "src@$WEBRTC_COMMIT" -j 8
test "$(git -C src rev-parse HEAD)" = "$WEBRTC_COMMIT"
gclient runhooks
