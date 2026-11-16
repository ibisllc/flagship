#!/usr/bin/env bash
# use-artifacts.sh <run-id> [--record] | --clean
#
# Puts the libraries one run of .github/workflows/libwebrtc.yml built where the app builds look for them:
#   apps/mobile/ios/Vendor/WebRTC/{WebRTC,FlagshipTurn}.xcframework
#   apps/mobile/android/vendor/webrtc/{libwebrtc.aar,jniLibs/<abi>/libflagship_turn_ffi.so}
# Every file must match tools/libwebrtc/artifacts.sha256 (the committed pin); --record writes the pin from this run
# instead (review and commit it). The download lands in tools/libwebrtc/.artifacts and is deleted afterwards; all three
# folders are git-ignored. --clean deletes the unpacked libraries again (disk rule: delete them when the build is done).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
ios="$root/apps/mobile/ios/Vendor/WebRTC"
android="$root/apps/mobile/android/vendor/webrtc"
dl="$here/.artifacts"
pin="$here/artifacts.sha256"

if [ "${1:-}" = "--clean" ]; then
  rm -rf "$ios" "$android" "$dl"
  exit 0
fi
run="${1:?usage: use-artifacts.sh <run-id> [--record] | --clean}"
record="${2:-}"

free_kb=$(df -k "$root" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $((5 * 1024 * 1024)) ]; then
  echo "use-artifacts: under 5 GB free on this disk; stopping." >&2
  exit 1
fi

rm -rf "$dl"
mkdir -p "$dl"
trap 'rm -rf "$dl"' EXIT
gh run download "$run" --name libwebrtc --dir "$dl"
cd "$dl"
shasum -a 256 -c SHA256SUMS
if [ "$record" = "--record" ]; then
  cp SHA256SUMS "$pin"
  echo "use-artifacts: wrote $pin from run $run; review and commit it."
else
  [ -s "$pin" ] || { echo "use-artifacts: $pin is empty; pass --record after reviewing a run" >&2; exit 1; }
  # The run's own list must be exactly the pin: same files, same checksums.
  diff <(sort "$pin") <(sort SHA256SUMS) >/dev/null || { echo "use-artifacts: run $run does not match $pin" >&2; exit 1; }
fi

rm -rf "$ios" "$android"
mkdir -p "$ios" "$android/jniLibs"
unzip -q WebRTC.xcframework.zip -d "$ios"
unzip -q FlagshipTurn.xcframework.zip -d "$ios"
cp libwebrtc.aar flagship-turn-android.zip "$android/"
unzip -q flagship-turn-android.zip -d "$android/jniLibs"
echo "use-artifacts: iOS libraries in $ios, Android in $android"
