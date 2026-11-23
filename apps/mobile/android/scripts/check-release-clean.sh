#!/usr/bin/env bash
# Fails when a release build carries mock data, gym seams or developer mode.
# Run after `./gradlew :app:assembleRelease :wear:assembleRelease` from
# apps/mobile/android. Two checks per module:
#   1. compiled classes (before R8): no mock / fixture / gym / developer class
#      was compiled into the release variant at all;
#   2. the release APK's dex: none of their tell-tale strings survived.
# Plus device reach (phone app): no hardware feature Play would require. aapt2
# applies Play's rules: a permission such as CAMERA implies its feature unless
# the manifest declares it required="false", and Play then hides the app from
# every device without it (build 12 lost ~1,577 devices). The unit test
# DeviceReachTest checks the merged manifest the same way.
# And native debug symbols in the phone AAB (Play's crash reports): AGP
# extracts them only when an Android NDK is installed (it needs objcopy);
# without one it builds the AAB anyway, with no symbols and only a warning.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
CLASS_RE='/(Mock[A-Z][A-Za-z0-9]*|DemoFixtures|SmokeMode|SmokeModeConfig|GymSeams|FixedPodClients|FakePasskeyApp|DeveloperSettings|DeveloperScreen[A-Za-z]*)(\$[^/]*)?\.class$'
STRING_RE='flagship\.smoke|flagship\.apexHost|unlock developer|Developer unlocked|MockScreensClient|bright-maple|Personal notes \+ recipes|useLiveClient|mockLatency|fake-passkey'

check_module() {
  local module=$1 classes=$2 apk=$3
  if [ ! -d "$classes" ]; then echo "missing $classes (build $module release first)"; fail=1; return; fi
  if [ ! -f "$apk" ]; then echo "missing $apk (build $module release first)"; fail=1; return; fi
  local hits
  hits=$(find "$classes" -name '*.class' | grep -E "$CLASS_RE" || true)
  if [ -n "$hits" ]; then
    echo "FAIL $module: release compiled debug-only classes:"; echo "$hits" | sed 's/^/  /'; fail=1
  fi
  local tmp; tmp=$(mktemp -d)
  unzip -q -o "$apk" 'classes*.dex' -d "$tmp"
  hits=$(cat "$tmp"/classes*.dex | LC_ALL=C grep -aoE "$STRING_RE" | sort -u || true)
  rm -rf "$tmp"
  if [ -n "$hits" ]; then
    echo "FAIL $module: release dex carries debug-only strings:"; echo "$hits" | sed 's/^/  /'; fail=1
  fi
  [ $fail -eq 0 ] && echo "ok $module: no mock data, gym seams or developer mode in release"
}

check_reach() {
  local apk=$1 sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}" aapt2 hits
  [ -f "$apk" ] || return 0
  aapt2=$(ls -d "$sdk"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)
  if [ -z "$aapt2" ]; then echo "missing aapt2 (Android build-tools under $sdk)"; fail=1; return; fi
  # Required ("uses-feature:") and implied ("uses-implied-feature:") hardware; faketouch is every device.
  hits=$("$aapt2" dump badging "$apk" | grep -E "^[[:space:]]*uses-(implied-)?feature: name='android\.hardware\." | grep -v "'android.hardware.faketouch'" || true)
  if [ -n "$hits" ]; then
    echo "FAIL app: Play would hide the app from devices without these (declare them required=\"false\" in app/src/main/AndroidManifest.xml):"
    echo "$hits" | sed 's/^/  /'; fail=1
  else
    echo "ok app: every hardware feature is optional (device reach)"
  fi
}

check_symbols() {
  local aab=$1
  [ -f "$aab" ] || return 0
  if unzip -l "$aab" | grep 'BUNDLE-METADATA/com.android.tools.build.debugsymbols/' >/dev/null; then
    echo "ok app: native debug symbols in the AAB"
  else
    echo "FAIL app: no native debug symbols in $aab. Install the NDK AGP 8.9 defaults to (sdkmanager \"ndk;27.0.12077973\", about 1.5 GB) and rebuild :app:bundleRelease"
    fail=1
  fi
}

check_module app app/build/tmp/kotlin-classes/release app/build/outputs/apk/release/app-release.apk
check_reach app/build/outputs/apk/release/app-release.apk
check_symbols app/build/outputs/bundle/release/app-release.aab
check_module wear wear/build/tmp/kotlin-classes/release wear/build/outputs/apk/release/wear-release.apk
exit $fail
