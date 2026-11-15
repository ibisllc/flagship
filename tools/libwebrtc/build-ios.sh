#!/usr/bin/env bash
# build-ios.sh <workdir> <outdir>: WebRTC.xcframework (iOS arm64, simulator arm64 + x86_64) with the overlay.
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
python3 tools_webrtc/ios/build_ios_libs.py \
  --output-dir "$work/out-ios" \
  --deployment-target "$IOS_DEPLOYMENT_TARGET" \
  --arch device:arm64 simulator:arm64 simulator:x64 \
  --extra-gn-args $(grep -v "^#" "$here/gn-args.txt")
rm -rf "$out/WebRTC.xcframework"
cp -R "$work/out-ios/WebRTC.xcframework" "$out/"
grep -rq RTCFlagshipFrameCrypto "$out/WebRTC.xcframework"/*/WebRTC.framework/Headers/WebRTC.h \
  || { echo "build-ios: RTCFlagshipFrameCrypto is not in the umbrella header" >&2; exit 1; }
