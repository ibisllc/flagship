#!/usr/bin/env bash
# Native iOS store captures (docs/store-assets/capture-plan.md): StoreCaptureTests on the iPhone 6.9" and iPad 13"
# simulators, and the Watch app's 07/07b on an Apple Watch Ultra 3 (launched straight into the store world: there is
# no watch UI-test target), every ga language, into store/captures/ios/<lang>/<device>/<id>.png.
#
#   bash scripts/store-assets/capture-ios.sh [--lang ja,de] [--device iphone-6.9,ipad-13,watch-ultra] [--only 03,08] [--keep-build]
#   (--keep-build also keeps the simulators; --only retakes just those slides and keeps the others)
#
# Builds once (build-for-testing into a throwaway DerivedData that is deleted at the end unless --keep-build), then
# runs the one test per device and language. Simulators: an iPhone 17 Pro Max and an iPad Pro 13-inch are created
# for the run and deleted after it. One simulator runs at a time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer}"
DD="${STORE_DERIVED_DATA:-$ROOT/../flagship-store-dd}"
LANGS="$(node -e 'const l=require(process.argv[1]);console.log(l.locales.filter(x=>x.status==="ga").map(x=>x.code).join(","))' "$ROOT/i18n/locales.json")"
DEVICES="iphone-6.9,ipad-13,watch-ultra"
KEEP=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lang) LANGS="$2"; shift 2 ;;
    --device) DEVICES="$2"; shift 2 ;;
    --keep-build) KEEP=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

sim() { # <name> <device type> <iOS|watchOS> -> udid (created on the newest runtime of that platform if missing)
  local udid
  udid="$(xcrun simctl list devices available -j | node -e '
    const d=JSON.parse(require("fs").readFileSync(0,"utf8")).devices;
    for (const [rt, list] of Object.entries(d)) if (rt.includes(process.argv[2])) for (const x of list) if (x.name===process.argv[1]) { console.log(x.udid); process.exit(0); }' "$1" "$3")"
  if [ -z "$udid" ]; then
    local runtime
    runtime="$(xcrun simctl list runtimes -j | node -e '
      const r=JSON.parse(require("fs").readFileSync(0,"utf8")).runtimes.filter(x=>x.platform===process.argv[1]&&x.isAvailable);
      console.log(r[r.length-1].identifier)' "$3")"
    udid="$(xcrun simctl create "$1" "$2" "$runtime")"
  fi
  echo "$udid"
}

# macOS ships bash 3.2: no associative arrays.
simname() { case "$1" in iphone-6.9) echo "Store iPhone 17 Pro Max" ;; ipad-13) echo "Store iPad Pro 13-inch" ;; watch-ultra) echo "Store Apple Watch Ultra 3" ;; esac; }
simtype() {
  case "$1" in
    iphone-6.9) echo "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max" ;;
    ipad-13) echo "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB" ;;
    watch-ultra) echo "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm" ;;
  esac
}

STATUS_TIME="$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-10-21 09:41:00" "+%Y-%m-%dT%H:%M:%S.000%z" | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/')"

PROJECT="$ROOT/apps/mobile/ios/App/FlagshipApp.xcodeproj"
# STORE_SKIP_BUILD=1 reuses the products a --keep-build run left (another device or language on a tight disk: its
# intermediates may then be deleted, only Build/Products is read).
if [ "${STORE_SKIP_BUILD:-0}" != 1 ]; then
  echo "building for testing into $DD"
  xcodebuild build-for-testing -project "$PROJECT" -scheme FlagshipApp -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO -quiet
fi
XCTESTRUN="$(ls "$DD"/Build/Products/*.xctestrun | head -1)"

IFS=, read -ra devs <<< "$DEVICES"
IFS=, read -ra langs <<< "$LANGS"
watch() { # <udid>: the Watch app on the store world, both states, every language
  local udid=$1 lang out id
  xcrun simctl install "$udid" "$DD/Build/Products/Debug-watchsimulator/FlagshipWatchApp.app"
  for lang in "${langs[@]}"; do
    sim_language "$udid" "$lang"
    out="$ROOT/store/captures/ios/$lang/watch-ultra"
    echo "== watch-ultra $lang -> ${out#$ROOT/}"
    mkdir -p "$out"
    for id in 07 07b; do
      SIMCTL_CHILD_FLAGSHIP_STORE_WORLD="$(cat "$ROOT/store/demo-world.json")" xcrun simctl launch --terminate-running-process "$udid" \
        com.flagshipserver.app.watchkitapp -AppleLanguages "($lang)" -AppleLocale "$(locale_of "$lang")" -watch-store-world \
        $([ "$id" = 07b ] && echo -watch-store-waiting) >/dev/null
      sleep 6
      xcrun simctl io "$udid" screenshot "$out/$id.png" >/dev/null 2>&1
      # watchOS takes no status-bar override: set the clock to 9:41 in the picture (scripts/store-assets/watch-clock.mjs)
      node "$ROOT/scripts/store-assets/watch-clock.mjs" "$out/$id.png" "$(status_time ipad-13 "$lang")"
    done
  done
}
# The simulator's own language and region (its status bar, the iPad's date): the global preferences, then a restart,
# since SpringBoard reads them only at boot (store review: the iPad's status-bar date was English in every language).
sim_language() { # <udid> <lang>
  xcrun simctl spawn "$1" defaults write -g AppleLanguages -array "$2"
  xcrun simctl spawn "$1" defaults write -g AppleLocale -string "$(locale_of "$2")"
  xcrun simctl shutdown "$1" >/dev/null 2>&1 || true
  xcrun simctl boot "$1"
  xcrun simctl bootstatus "$1" -b >/dev/null
}
status_time() { # <device> <lang>: the clock as the status bar shows it
  case "$1" in
    ipad-13) case "$2" in en|ja|zh-Hans) echo "9:41" ;; *) echo "09:41" ;; esac ;;
    *) echo "$STATUS_TIME" ;;
  esac
}
locale_of() { case "$1" in en) echo en_US ;; ja) echo ja_JP ;; zh-Hans) echo zh_CN ;; pt-BR) echo pt_BR ;; *) echo "$1_$(echo "$1" | tr a-z A-Z)" ;; esac; }

for dev in "${devs[@]}"; do
  if [ "$dev" = watch-ultra ]; then platform=watchOS; else platform=iOS; fi
  udid="$(sim "$(simname "$dev")" "$(simtype "$dev")" "$platform")"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  if [ "$dev" = watch-ultra ]; then watch "$udid"; fi
  for lang in "${langs[@]}"; do
    [ "$dev" = watch-ultra ] && break
    out="$ROOT/store/captures/ios/$lang/$dev"
    echo "== $dev $lang -> ${out#$ROOT/}"
    if [ -n "$ONLY" ]; then for id in ${ONLY//,/ }; do rm -f "$out/$id.png"; done; else rm -f "$out"/0*.png "$out"/x*.png; fi
    last="${ONLY##*,}"; last="${last:-08}"
    sim_language "$udid" "$lang"
    # Set again after each restart. The iPad shows a date beside the time: an ISO --time fixes it, but simctl then
    # writes it in English whatever the language, so the iPad gets the time as plain text and SpringBoard writes the
    # (capture day's) date in the simulator's language.
    xcrun simctl status_bar "$udid" override --time "$(status_time "$dev" "$lang")" --batteryState charged --batteryLevel 100 \
      --cellularMode active --cellularBars 4 --wifiBars 3 --operatorName ""
    TEST_RUNNER_STORE_LANG="$lang" TEST_RUNNER_STORE_OUT="$out" TEST_RUNNER_STORE_WORLD="$ROOT/store/demo-world.json" TEST_RUNNER_STORE_ONLY="$ONLY" \
      xcodebuild test-without-building -xctestrun "$XCTESTRUN" -destination "platform=iOS Simulator,id=$udid" \
      -only-testing:FlagshipAppUITests/StoreCaptureTests -quiet > "$DD/test-$dev-$lang.log" 2>&1 &
    pid=$!
    # xcodebuild sometimes never returns after the test has finished on an iPad: stop waiting a minute after the last shot.
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f "$out/$last.png" ] && [ $(( $(date +%s) - $(stat -f %m "$out/$last.png") )) -gt 60 ]; then kill "$pid"; break; fi
      sleep 5
    done
    wait "$pid" 2>/dev/null || true
    n=$(ls "$out"/0*.png 2>/dev/null | wc -l | tr -d ' ')
    if [ "$n" != 7 ]; then echo "  only $n of 7 captures; log: $DD/test-$dev-$lang.log" >&2; failed=1; fi
  done
  xcrun simctl status_bar "$udid" clear 2>/dev/null || true
  xcrun simctl shutdown "$udid"
  # The store simulators hold gigabytes once booted; recreate them next time.
  [ "$KEEP" = 1 ] || xcrun simctl delete "$udid"
done

if [ "$KEEP" = 0 ]; then rm -rf "$DD"; fi
echo "done: store/captures/ios"
exit "${failed:-0}"
