#!/usr/bin/env bash
#
# gym-ios-device — build "Flagship Gym", a separate iOS app pointed at the gym, and install it on a real phone
# beside the production Flagship app (gym branches only; never on main).
#
# The gym app has its own bundle id (com.flagshipserver.app.gym, with .widgets / .watchkitapp / ...), its own app
# group (group.com.flagshipserver.app.gym) and so its own Keychain, so it can never read, overwrite or erase the
# production app's keys. Its Info.plist names the gym apex (FlagshipGymApexHost, read by GymLaunch in Debug builds),
# so even a plain launch from the home screen talks to the gym, never to flagshipserver.com.
#
# It is an ad hoc (release-testing) export of a Debug archive: ad hoc signing gives the app production APNs and
# PushKit tokens, which the team's APNs key (production only) can reach; a development build's sandbox tokens can't.
# The gym Worker's APNS_BUNDLE_ID must be com.flagshipserver.app.gym and APNS_HOST unset.
#
# The bundle id edits are made in the working tree for the build and reverted on exit; nothing is committed.
#
# Usage: bash scripts/gym-ios-device.sh --device <devicectl id> [--apex gym.flagshipserver.com] [--no-install]
# Env:   DEVELOPER_DIR (Xcode), GYM_IOS_OUT (default ~/.cache/flagship/gym-ios)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APEX="gym.flagshipserver.com" DEVICE="" INSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --apex) APEX="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$APEX" != "flagshipserver.com" ] || { echo "refusing: the gym app must not point at production" >&2; exit 2; }
[ "$INSTALL" = 0 ] || [ -n "$DEVICE" ] || { echo "--device <id> is required (xcrun devicectl list devices)" >&2; exit 2; }

IOS="$REPO/apps/mobile/ios"
OUT="${GYM_IOS_OUT:-$HOME/.cache/flagship/gym-ios}"
TEAM="8G8RHBU9BN"
BUNDLE="com.flagshipserver.app.gym"
GROUP="group.com.flagshipserver.app.gym"
EDITED=(
  apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj
  apps/mobile/ios/App/Info.plist
  apps/mobile/ios/App/WatchApp/Info.plist
  apps/mobile/ios/App/FlagshipApp.entitlements
  apps/mobile/ios/App/WidgetExtension/FlagshipWidgets.entitlements
  apps/mobile/ios/App/WatchApp/FlagshipWatchApp.entitlements
  apps/mobile/ios/App/WatchWidgets/FlagshipWatchWidgets.entitlements
  apps/mobile/ios/App/Shared/PodStatusSnapshot.swift
  apps/mobile/ios/App/WatchApp/WatchConnectivityClient.swift
  apps/mobile/ios/App/WatchWidgets/ProvisionPhaseComplication.swift
)
cd "$REPO"
[ -z "$(git status --porcelain -- "${EDITED[@]}")" ] || { echo "uncommitted changes in the files this script edits" >&2; exit 1; }
revert() { git -C "$REPO" checkout -- "${EDITED[@]}"; }
trap revert EXIT

perl -pi -e 's/(PRODUCT_BUNDLE_IDENTIFIER = )com\.flagshipserver\.app\b/$1'"$BUNDLE"'/; s/INFOPLIST_KEY_CFBundleDisplayName = Flagship;/INFOPLIST_KEY_CFBundleDisplayName = "Flagship Gym";/' \
  apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj
perl -pi -e 's/group\.com\.flagshipserver\.app(?![\w.])/'"$GROUP"'/g' "${EDITED[@]:3}"
/usr/libexec/PlistBuddy -c "Set :WKCompanionAppBundleIdentifier $BUNDLE" apps/mobile/ios/App/WatchApp/Info.plist
/usr/libexec/PlistBuddy -c "Add :FlagshipGymApexHost string $APEX" apps/mobile/ios/App/Info.plist
grep -q "PRODUCT_BUNDLE_IDENTIFIER = com.flagshipserver.app;" apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj \
  && { echo "a production bundle id is left in the project" >&2; exit 1; }
if grep -rn 'group\.com\.flagshipserver\.app[^.]' "${EDITED[@]:3}" | grep -v "$GROUP"; then echo "a production app group is left" >&2; exit 1; fi

rm -rf "$OUT"; mkdir -p "$OUT"
xcodebuild -project "$IOS/App/FlagshipApp.xcodeproj" -scheme FlagshipApp -configuration Debug \
  -destination generic/platform=iOS -derivedDataPath "$OUT/dd" -archivePath "$OUT/FlagshipGym.xcarchive" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" archive | tail -5
cat > "$OUT/export.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>release-testing</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM</string>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath "$OUT/FlagshipGym.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/export.plist" -allowProvisioningUpdates | tail -5
IPA="$(ls "$OUT"/export/*.ipa)"
mkdir -p "$OUT/app" && (cd "$OUT/app" && unzip -q "$IPA")
APP="$(ls -d "$OUT"/app/Payload/*.app)"
echo "built $APP"
codesign -d --entitlements :- "$APP" > "$OUT/entitlements.plist" 2>/dev/null
grep -A1 -E 'aps-environment|application-identifier|application-groups' "$OUT/entitlements.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$OUT/entitlements.plist" 2>/dev/null)" = production ] \
  || { echo "the signed app has no production push entitlement: not installing" >&2; exit 1; }
/usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$APP/Info.plist" | grep -q voip \
  || { echo "the app has no voip background mode: not installing" >&2; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")" = "$BUNDLE" ] || { echo "wrong bundle id" >&2; exit 1; }
if [ "$INSTALL" = 1 ]; then
  xcrun devicectl device install app --device "$DEVICE" "$APP"
fi
rm -rf "$OUT/dd"
echo "done: $BUNDLE -> $APEX"
