#!/usr/bin/env bash
# Put the pinned gVisor bundles in Flagship's own mirror: the R2 `flagship-iso`
# bucket, which .com serves at /build/iso/<name>. Boxes try it before
# storage.googleapis.com (which answered 403 to a whole cloud provider's
# address range) and still check the bundle against the SHA-512 pinned in
# packages/server-daemon/src/appSandbox/gvisor.ts.
#
#   scripts/publish-gvisor-mirror.sh             download both processors, check them, upload
#   scripts/publish-gvisor-mirror.sh --dry-run   download and check only
#   --bucket <name>      another bucket (the gym's: flagship-iso-gym, served at gym.flagshipserver.com)
#   --skip-if-at <url>   do nothing for a bundle already served at <url>/<name> (gym-refresh uses it)
#
# Needs curl, sha512sum or shasum, and (to upload) a logged-in `wrangler` on PATH.
# Run it again whenever GVISOR_RELEASE changes; the object name carries the
# release, so an old box keeps finding its own bundle.
set -euo pipefail
dry=0
bucket=flagship-iso
served=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --bucket) bucket="$2"; shift ;;
    --skip-if-at) served="${2%/}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
src="$(cd "$(dirname "$0")/.." && pwd)/packages/server-daemon/src/appSandbox/gvisor.ts"
release=$(sed -nE 's/^export const GVISOR_RELEASE = "([^"]+)";/\1/p' "$src")
[ -n "$release" ] || { echo "can't read GVISOR_RELEASE from $src" >&2; exit 1; }
[ "$dry" = 1 ] || command -v wrangler >/dev/null || { echo "wrangler isn't on PATH" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha512() { if command -v sha512sum >/dev/null; then sha512sum "$1" | cut -d' ' -f1; else shasum -a 512 "$1" | cut -d' ' -f1; fi; }

for arch in x86_64 aarch64; do
  want=$(sed -nE "s/^  $arch: \"([0-9a-f]{128})\",/\1/p" "$src")
  [ -n "$want" ] || { echo "no pinned SHA-512 for $arch in $src" >&2; exit 1; }
  name="gvisor-$release-$arch.tar.zstd"
  if [ -n "$served" ] && curl -fsSI --max-time 20 "$served/$name" >/dev/null 2>&1; then
    echo "== $name: already served at $served"
    continue
  fi
  echo "== $name: downloading"
  curl -fsSL --retry 3 -o "$work/$name" "https://storage.googleapis.com/gvisor/releases/release/$release/$arch/gvisor.tar.zstd"
  got=$(sha512 "$work/$name")
  [ "$got" = "$want" ] || { echo "$name doesn't match the pinned SHA-512 (got $got)" >&2; exit 1; }
  echo "   matches the pin"
  if [ "$dry" = 1 ]; then rm -f "$work/$name"; continue; fi
  wrangler r2 object put "$bucket/$name" --file "$work/$name" --content-type application/octet-stream --remote
  rm -f "$work/$name"
done
echo "Done. Check: curl -fsSI https://flagshipserver.com/build/iso/gvisor-$release-x86_64.tar.zstd"
