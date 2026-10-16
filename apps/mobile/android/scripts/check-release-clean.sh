#!/usr/bin/env bash
# Fails when a release build carries mock data, gym seams or developer mode.
# Run after `./gradlew :app:assembleRelease :wear:assembleRelease` from
# apps/mobile/android. Two checks per module:
#   1. compiled classes (before R8): no mock / fixture / gym / developer class
#      was compiled into the release variant at all;
#   2. the release APK's dex: none of their tell-tale strings survived.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
CLASS_RE='/(Mock[A-Z][A-Za-z0-9]*|DemoFixtures|SmokeMode|SmokeModeConfig|GymSeams|FixedPodClients|DeveloperSettings|DeveloperScreen[A-Za-z]*)(\$[^/]*)?\.class$'
STRING_RE='flagship\.smoke|flagship\.apexHost|unlock developer|Developer unlocked|MockScreensClient|bright-maple|Personal notes \+ recipes|useLiveClient|mockLatency'

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

check_module app app/build/tmp/kotlin-classes/release app/build/outputs/apk/release/app-release.apk
check_module wear wear/build/tmp/kotlin-classes/release wear/build/outputs/apk/release/wear-release.apk
exit $fail
