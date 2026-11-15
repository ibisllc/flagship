#!/usr/bin/env bash
# build-android.sh <workdir> <outdir>: libwebrtc.aar (arm64-v8a, armeabi-v7a, x86_64) with the overlay.
# CI only (.github/workflows/libwebrtc.yml): a checkout and build need tens of GB; never run it on the owner's Mac.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/pins.env"
work="$(cd "$1" && pwd)"
out="$2"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
export PATH="$work/depot_tools:$PATH" DEPOT_TOOLS_UPDATE=0
python3 "$here/apply-overlay.py" "$work/src"
cd "$work/src"
python3 tools_webrtc/android/build_aar.py \
  --build-dir "$work/src/out/android" \
  --output "$out/libwebrtc.aar" \
  --arch arm64-v8a armeabi-v7a x86_64 \
  --extra-gn-args $(grep -v "^#" "$here/gn-args.txt")
unzip -l "$out/libwebrtc.aar" | grep -q 'classes.jar' || { echo "build-android: no classes.jar" >&2; exit 1; }
unzip -p "$out/libwebrtc.aar" classes.jar > "$work/classes.jar"
unzip -l "$work/classes.jar" | grep -q 'org/webrtc/FlagshipFrameCrypto.class' \
  || { echo "build-android: FlagshipFrameCrypto is not in the AAR" >&2; exit 1; }
