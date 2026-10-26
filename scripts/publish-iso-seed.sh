#!/usr/bin/env bash
# Publish the USB boot seed built by iso-seed.yml: take the run's `iso-seed-amd64` artifact, check it
# against the pinned seed sha256, attach it to a GitHub release, and switch on FLAGSHIP_ISO_SEED in
# apps/com/wrangler.toml with the real url and size (the Android burn gets `download: null` until then).
#
#   scripts/publish-iso-seed.sh <run-id> [<release-tag>]
#
# Needs `gh` logged in. Afterwards: commit wrangler.toml and deploy .com. Overrides for tests:
# WORKFLOW, WRANGLER_TOML.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <run-id> [<release-tag>]" >&2; exit 2; }
run="$1"
repo=$(git rev-parse --show-toplevel)
workflow="${WORKFLOW:-$repo/.github/workflows/iso-seed.yml}"
toml="${WRANGLER_TOML:-$repo/apps/com/wrangler.toml}"
command -v gh >/dev/null || { echo "gh isn't on PATH" >&2; exit 1; }

pin=$(sed -n 's/^ *SEED_SHA256: *\([0-9a-f]\{64\}\) *$/\1/p' "$workflow")
base=$(sed -n 's#^ *BASE_URL: .*/archive/\([0-9.]*\)/amd64/.*#\1#p' "$workflow")
[ -n "$pin" ] && [ -n "$base" ] || { echo "can't read the seed pin from $workflow" >&2; exit 1; }
tag="${2:-iso-seed-debian-$base}"
asset="flagship-seed-debian-$base-amd64.iso"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "== run $run: downloading"
gh run download "$run" -n iso-seed-amd64 --dir "$work"
seed="$work/seed.iso"
[ -f "$seed" ] || { echo "run $run has no seed.iso in iso-seed-amd64" >&2; exit 1; }
got=$(shasum -a 256 "$seed" | cut -d' ' -f1)
[ "$got" = "$pin" ] || { echo "seed sha256 $got does not match the pin $pin" >&2; exit 1; }
size=$(wc -c < "$seed" | tr -d ' ')
mv "$seed" "$work/$asset"

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --title "Flagship USB seed, Debian $base" \
    --notes "The reproducible boot seed for the phone USB burn. sha256 $pin; rebuild it with iso-seed/build-seed.sh (docs/iso-seed-and-on-device-burn.md)."
fi
gh release upload "$tag" "$work/$asset" --clobber
url="https://github.com/ibisllc/flagship/releases/download/$tag/$asset"

line="FLAGSHIP_ISO_SEED = '{\"version\":\"flagship-seed-debian-$base\",\"url\":\"$url\",\"sha256\":\"$pin\",\"sizeBytes\":$size,\"attestation\":\"https://github.com/ibisllc/flagship/blob/main/docs/iso-seed-and-on-device-burn.md\"}'"
python3 - "$toml" "$line" <<'PY'
import re, sys
path, line = sys.argv[1], sys.argv[2]
s = open(path).read()
pat = re.compile(r"^#? ?FLAGSHIP_ISO_SEED = .*$", re.M)
if not pat.search(s):
    sys.exit("no FLAGSHIP_ISO_SEED line in " + path)
open(path, "w").write(pat.sub(lambda m: line, s, count=1))
PY
echo "== $asset is published ($size bytes). Commit $(basename "$toml") and deploy .com."
