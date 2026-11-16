#!/usr/bin/env bash
# pin-release.sh <tag>: points both apps at a GitHub release of .github/workflows/libwebrtc.yml's output. Writes
# tools/libwebrtc/release.env (read by apps/mobile/android/app/build.gradle.kts) and the `webrtcRelease` line of
# apps/mobile/ios/Package.swift, with the checksums in tools/libwebrtc/artifacts.sha256 (the pin; record it first with
# use-artifacts.sh <run> --record). Checks that the release holds exactly those files with those checksums.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tag="${1:?usage: pin-release.sh <tag>}"
repo="${FLAGSHIP_RELEASE_REPO:-ibisllc/flagship}"
pin="$here/artifacts.sha256"
[ -s "$pin" ] || { echo "pin-release: $pin is empty" >&2; exit 1; }
sum() { awk -v n="$1" '$2 == n { print $1 }' "$pin"; }
for f in WebRTC.xcframework.zip FlagshipTurn.xcframework.zip libwebrtc.aar flagship-turn-android.zip; do
  [ -n "$(sum "$f")" ] || { echo "pin-release: no checksum for $f in $pin" >&2; exit 1; }
done
# The release's own SHA256SUMS must be the pin.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "$tag" --repo "$repo" --pattern SHA256SUMS --dir "$tmp"
diff <(sort "$pin") <(sort "$tmp/SHA256SUMS") >/dev/null || { echo "pin-release: $tag's SHA256SUMS is not $pin" >&2; exit 1; }
base="https://github.com/$repo/releases/download/$tag"
printf 'RELEASE_TAG=%s\nRELEASE_BASE_URL=%s\n' "$tag" "$base" > "$here/release.env"
line="let webrtcRelease: (base: String, webrtc: String, turn: String)? = (\"$base\", \"$(sum WebRTC.xcframework.zip)\", \"$(sum FlagshipTurn.xcframework.zip)\")"
python3 - "$root/apps/mobile/ios/Package.swift" "$line" <<'PY'
import re, sys
p, line = sys.argv[1], sys.argv[2]
s = open(p).read()
s2, n = re.subn(r'^let webrtcRelease: .*$', lambda m: line, s, flags=re.M)
assert n == 1, "webrtcRelease line not found"
open(p, "w").write(s2)
PY
echo "pin-release: both apps now use $tag"
