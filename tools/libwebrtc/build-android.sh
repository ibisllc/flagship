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
  --extra-gn-args $(grep -v "^#" "$here/gn-args.txt") use_hashed_jni_names=false jni_zero_per_file_natives=true
unzip -l "$out/libwebrtc.aar" | grep -q 'classes.jar' || { echo "build-android: no classes.jar" >&2; exit 1; }
unzip -p "$out/libwebrtc.aar" classes.jar > "$work/classes.jar"
unzip -l "$work/classes.jar" | grep -q 'org/webrtc/FlagshipFrameCrypto.class' \
  || { echo "build-android: FlagshipFrameCrypto is not in the AAR" >&2; exit 1; }
# Every class the jar uses is in it and every native method has its symbol in each ABI's library:
# libwebrtc-157-43884507084 shipped without org/webrtc/PeerConnectionFactoryJni and the other generated bridges (the
# per-file JNI settings above and apply-overlay.py fix that), so the first call threw NoClassDefFoundError.
nm=""
for c in "$work"/src/third_party/android_toolchain/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm \
         "$work/src/third_party/llvm-build/Release+Asserts/bin/llvm-nm" "$(command -v llvm-nm || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then nm="$c"; break; fi
done
[ -n "$nm" ] || { echo "build-android: no llvm-nm to check the AAR's JNI symbols" >&2; exit 1; }
python3 "$here/check-aar.py" "$out/libwebrtc.aar" "$nm"
