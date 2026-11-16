#!/usr/bin/env bash
# package.sh <outdir>: zips what the build scripts left in <outdir> and writes SHA256SUMS and manifest.json, which
# record the pins the binaries came from. The apps take a binary only by these checksums.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/pins.env"
out="$(cd "$1" && pwd)"
cd "$out"
files=()
if [ -d WebRTC.xcframework ] && [ ! -f WebRTC.xcframework.zip ]; then
  rm -f WebRTC.xcframework.zip
  # Fixed order and times, so the same build zips to the same bytes.
  find WebRTC.xcframework -exec touch -h -t 202001010000 {} +
  find WebRTC.xcframework | LC_ALL=C sort | zip -q -X -y -@ WebRTC.xcframework.zip
fi
for f in WebRTC.xcframework.zip libwebrtc.aar FlagshipTurn.xcframework.zip flagship-turn-android.zip; do
  [ -f "$f" ] && files+=("$f")
done
# Every library must be there: a missing one would ship unpinned.
[ "${#files[@]}" -eq 4 ] || { echo "package: expected 4 libraries in $out, found ${#files[@]}" >&2; exit 1; }
shasum -a 256 "${files[@]}" > SHA256SUMS
{
  printf '{\n  "webrtcMilestone": %s,\n  "webrtcBranch": %s,\n  "webrtcCommit": "%s",\n' \
    "$WEBRTC_MILESTONE" "$WEBRTC_BRANCH" "$WEBRTC_COMMIT"
  printf '  "depotToolsCommit": "%s",\n  "iosDeploymentTarget": "%s",\n' "$DEPOT_TOOLS_COMMIT" "$IOS_DEPLOYMENT_TARGET"
  printf '  "flagshipCommit": "%s",\n  "files": {\n' "${GITHUB_SHA:-$(git -C "$here" rev-parse HEAD)}"
  n=0
  while read -r sum name; do
    n=$((n + 1))
    sep=","; [ "$n" -eq "${#files[@]}" ] && sep=""
    printf '    "%s": "%s"%s\n' "$name" "$sum" "$sep"
  done < SHA256SUMS
  printf '  }\n}\n'
} > manifest.json
cat SHA256SUMS
