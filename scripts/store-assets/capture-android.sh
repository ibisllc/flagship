#!/usr/bin/env bash
# Native Android store captures (docs/store-assets/capture-plan.md): StoreCaptureTest on one phone AVD, resized
# for the 7" and 10" tablets, every ga language, into store/captures/android/<lang>/<device>/<id>.png; and the
# Wear OS app's 06/06b (wear/src/test StoreWatchCaptureTest, Robolectric: the phone emulator can't hold the watch
# build, which shares the phone's applicationId) into store/captures/android/<lang>/wear/.
#
#   bash scripts/store-assets/capture-android.sh [--lang ja,de] [--device phone,tablet-7,tablet-10,wear] [--avd flagship_api35]
#
# Builds the debug app and its test APK, boots the AVD headless without saving a snapshot, puts the status bar in
# demo mode (09:41, full battery, no notifications), runs the test once per device size and language, and pulls
# the shots. The AVD's display size is restored and the emulator stopped at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
AVD="flagship_api35"
LANGS="$(node -e 'const l=require(process.argv[1]);console.log(l.locales.filter(x=>x.status==="ga").map(x=>x.code).join(","))' "$ROOT/i18n/locales.json")"
DEVICES="phone,tablet-7,tablet-10,wear"
while [ $# -gt 0 ]; do
  case "$1" in
    --lang) LANGS="$2"; shift 2 ;;
    --device) DEVICES="$2"; shift 2 ;;
    --avd) AVD="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
PKG=com.flagshipserver.app
RUNNER="$PKG.test/androidx.test.runner.AndroidJUnitRunner"
WORLD="$(base64 < "$ROOT/store/demo-world.json" | tr -d '\n')"

if [[ ",$DEVICES," == *,wear,* ]]; then
  echo "== wear $LANGS -> store/captures/android/<lang>/wear"
  (cd "$ROOT/apps/mobile/android" && STORE_CAPTURE_WEAR=1 STORE_LANGS="$LANGS" \
    ./gradlew -q :wear:testDebugUnitTest --tests com.flagshipserver.wear.StoreWatchCaptureTest --rerun)
  DEVICES="$(echo ",$DEVICES," | sed 's/,wear,/,/; s/^,//; s/,$//')"
  [ -n "$DEVICES" ] || { echo "done: store/captures/android"; exit 0; }
fi

(cd "$ROOT/apps/mobile/android" && ./gradlew -q :app:assembleDebug :app:assembleDebugAndroidTest)
APK="$ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="$ROOT/apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"

started=0
if ! "$ADB" get-state >/dev/null 2>&1; then
  "$SDK/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot-save >/dev/null 2>&1 &
  started=1
fi
"$ADB" wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done

cleanup() {
  "$ADB" shell wm size reset >/dev/null 2>&1 || true
  "$ADB" shell wm density reset >/dev/null 2>&1 || true
  "$ADB" shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true
  if [ "${pin_cleared:-0}" = 1 ]; then "$ADB" shell locksettings set-pin "$PIN" >/dev/null 2>&1 || true; fi
  "$ADB" shell svc power stayon false >/dev/null 2>&1 || true
  if [ "$started" = 1 ]; then "$ADB" emu kill >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# A headless emulator boots asleep behind the keyguard, which stops every activity at once. The gym's AVD keeps a
# screen-lock PIN (the app-lock scenarios need one): lift it for the run and put it back after.
PIN="${STORE_AVD_PIN:-1234}"
pin_cleared=0
if "$ADB" shell locksettings clear --old "$PIN" 2>/dev/null | grep -q cleared; then pin_cleared=1; fi
"$ADB" shell svc power stayon true
"$ADB" shell settings put system screen_off_timeout 2147483647
"$ADB" shell input keyevent KEYCODE_WAKEUP
"$ADB" shell wm dismiss-keyguard
"$ADB" install -r -t "$APK" >/dev/null
"$ADB" install -r -t "$TEST_APK" >/dev/null
"$ADB" shell settings put global sysui_demo_allowed 1
demo() { "$ADB" shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
demo enter
demo clock -e hhmm 0941
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e mobile hide
demo notifications -e visible false

IFS=, read -ra devs <<< "$DEVICES"
IFS=, read -ra langs <<< "$LANGS"
failed=0
for dev in "${devs[@]}"; do
  case "$dev" in
    # The phone at a slightly smaller display size (420 -> 370 dpi): slide 04 then holds the Members-only switch
    # and all three members, Lea's row included, between the app bar and the navigation bar.
    phone) "$ADB" shell wm size reset; "$ADB" shell wm density 370 ;;
    tablet-7) "$ADB" shell wm size 1200x1920; "$ADB" shell wm density 320 ;;
    tablet-10) "$ADB" shell wm size 1600x2560; "$ADB" shell wm density 320 ;;
    *) echo "unknown device: $dev" >&2; exit 2 ;;
  esac
  sleep 3
  for lang in "${langs[@]}"; do
    out="$ROOT/store/captures/android/$lang/$dev"
    echo "== $dev $lang -> ${out#$ROOT/}"
    rm -rf "$out"; mkdir -p "$out"
    # One retry: a cold emulator now and then misses a 20 s wait on the first run of a language.
    for attempt in 1 2; do
      "$ADB" shell input keyevent KEYCODE_WAKEUP
      "$ADB" shell am instrument -w -e class "$PKG.gym.StoreCaptureTest" -e storeLang "$lang" -e storeWorld "$WORLD" "$RUNNER" \
        | grep -E "OK \(|FAILURES|Error|Exception" | head -5 || true
      "$ADB" exec-out run-as "$PKG" tar c -C files store 2>/dev/null | tar x -C "$out" --strip-components 1 2>/dev/null || true
      n=$(ls "$out"/0*.png 2>/dev/null | wc -l | tr -d ' ')
      [ "$n" = 5 ] && break
      [ "$attempt" = 1 ] && { echo "  $n of 5 captures, retrying once" >&2; rm -f "$out"/0*.png; }
    done
    if [ "$n" != 5 ]; then echo "  only $n of 5 captures" >&2; failed=1; fi
  done
done
"$ADB" shell cmd locale set-app-locales "$PKG" --locales "" >/dev/null 2>&1 || true
echo "done: store/captures/android"
exit "$failed"
