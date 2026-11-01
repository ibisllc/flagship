#!/usr/bin/env bash
#
# owner-build — build a box release artifact yourself, away from any running box, and compare it with
# the one Flagship endorsed (release plan G9; docs/architecture-v2/owner-builds.md).
#
#   bash scripts/owner-build.sh --commit <40-hex> --arch amd64|arm64 --out <dir>
#        [--where local|vm] [--repo <path>] [--sequence N] [--no-rust]
#        [--endorsed-base https://flagshipserver.com/build/iso] [--offline]
#
#   --where local  (default) builds on this machine in a throwaway staging folder: a fresh HOME and TMPDIR,
#                  an environment emptied of everything but PATH and locale (env -i), the commit's OWN build
#                  tools installed from its own lockfile with scripts off, never this checkout's. It refuses to
#                  run on a Flagship server (an owner build never happens beside live keys or data). To match
#                  the endorsed digest the host must be the endorsed builder's platform: Linux on the same
#                  architecture, Node, Go and Rust at the pinned versions (see the doc).
#   --where vm     builds on a throwaway UpCloud Debian 13 VM (scripts/box-artifact-vm.sh; needs your
#                  ~/.config/flagship/upcloud-token; amd64 only; the VM is deleted afterwards).
#
# Then it fetches the endorsed manifest for the same commit and architecture and runs
# `tools/box-artifact/compare.ts endorsed`: "matches" means the build IS the endorsed release and may be
# installed with that manifest; "differs" means it is your own code, which a box refuses unless your
# local-build policy names its exact digest (not available in 0.3). Nothing is installed, signed or uploaded.
# Exit 0 matches, 1 differs, 2 usage, 3 the build failed (nothing on any box changed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
COMMIT="" ARCH="" OUT="" WHERE=local SEQ=0 NO_RUST=0 OFFLINE=0
BASE="https://flagshipserver.com/build/iso"
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --where) WHERE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --sequence) SEQ="$2"; shift 2 ;;
    --no-rust) NO_RUST=1; shift ;;
    --endorsed-base) BASE="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "--commit must be 40 hex characters" >&2; exit 2; }
case "$ARCH" in amd64|arm64) ;; *) echo "--arch must be amd64 or arm64" >&2; exit 2 ;; esac
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
case "$WHERE" in local|vm) ;; *) echo "--where must be local or vm" >&2; exit 2 ;; esac
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
NAME="flagship-box-${COMMIT:0:12}-$ARCH"

# shellcheck source=lib/box-build.sh
. "$HERE/lib/box-build.sh"

if [ "$WHERE" = vm ]; then
  [ "$ARCH" = amd64 ] || { echo "the VM path builds amd64 only" >&2; exit 2; }
  [ "$NO_RUST" = 0 ] || { echo "the VM path always builds the Rust binaries" >&2; exit 2; }
  bash "$HERE/box-artifact-vm.sh" --repo "$REPO" --commit "$COMMIT" --sequence "$SEQ" --out "$OUT" || exit 3
else
  box_build_local "$REPO" "$COMMIT" "$ARCH" "$SEQ" "$OUT" "$NO_RUST" || exit 3
fi
[ -f "$OUT/$NAME.tar.gz" ] || { echo "the build left no $NAME.tar.gz" >&2; exit 3; }
echo "▸ built $(shasum -a 256 "$OUT/$NAME.tar.gz" | cut -d' ' -f1)  $NAME.tar.gz"

if [ "$OFFLINE" = 1 ]; then
  echo "▸ offline: compare it yourself with: npx tsx tools/box-artifact/compare.ts endorsed --artifact $OUT/$NAME.tar.gz --manifest <endorsed $NAME.manifest.json> --commit $COMMIT --arch $ARCH"
  exit 1
fi
if ! curl -fsS --proto '=https' -m 60 -o "$OUT/$NAME.endorsed.manifest.json" "$BASE/$NAME.manifest.json"; then
  echo "▸ no endorsed manifest at $BASE/$NAME.manifest.json: this commit was not released for $ARCH, so the build stands on its own"
  exit 1
fi
(cd "$REPO" && node --import tsx tools/box-artifact/compare.ts endorsed --artifact "$OUT/$NAME.tar.gz" \
  --manifest "$OUT/$NAME.endorsed.manifest.json" --commit "$COMMIT" --arch "$ARCH")
