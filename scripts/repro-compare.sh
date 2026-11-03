#!/usr/bin/env bash
#
# repro-compare — build one commit's box artifact twice, independently, and report every file that differs
# (release plan G9; docs/architecture-v2/owner-builds.md "Reproducibility"). It claims nothing it did not
# measure: the report says which builder pair was compared.
#
#   bash scripts/repro-compare.sh --commit <40-hex> --arch amd64|arm64 --out <dir> [--no-rust]
#        [--repo <path>] [--second-where local|vm] [--against <dir with an existing flagship-box-*.tar.gz>]
#
# Build A is always local (scripts/lib/box-build.sh, its own staging folder). Build B is a second local
# build in a different staging folder, or a VM build (--second-where vm), or an artifact you already have
# (--against, e.g. the endorsed one downloaded from flagshipserver.com/build/iso). Writes <out>/a, <out>/b
# and <out>/report.json. Exit 0 identical, 1 different (see the report), 2 usage, 3 a build failed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
COMMIT="" ARCH="" OUT="" NO_RUST=0 SECOND=local AGAINST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-rust) NO_RUST=1; shift ;;
    --second-where) SECOND="$2"; shift 2 ;;
    --against) AGAINST="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "--commit must be 40 hex characters" >&2; exit 2; }
case "$ARCH" in amd64|arm64) ;; *) echo "--arch must be amd64 or arm64" >&2; exit 2 ;; esac
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
mkdir -p "$OUT/a" "$OUT/b"; OUT="$(cd "$OUT" && pwd)"
NAME="flagship-box-${COMMIT:0:12}-$ARCH"
# shellcheck source=lib/box-build.sh
. "$HERE/lib/box-build.sh"

echo "▸ build A (local, $(uname -sm))"
box_build_local "$REPO" "$COMMIT" "$ARCH" 0 "$OUT/a" "$NO_RUST" || exit 3
if [ -n "$AGAINST" ]; then
  cp "$AGAINST/$NAME.tar.gz" "$OUT/b/" || { echo "no $NAME.tar.gz in $AGAINST" >&2; exit 2; }
  B_DESC="given artifact from $AGAINST"
elif [ "$SECOND" = vm ]; then
  # --no-rust applies to both builds, so a Mac (which cannot link Rust for Linux) compares like with like.
  vm_flags=(); [ "$NO_RUST" = 1 ] && vm_flags+=(--no-rust)
  bash "$HERE/box-artifact-vm.sh" --repo "$REPO" --commit "$COMMIT" --sequence 0 --out "$OUT/b" --arch "$ARCH" ${vm_flags[@]+"${vm_flags[@]}"} || exit 3
  B_DESC="UpCloud Debian 13 VM ($(if [ "$NO_RUST" = 1 ]; then echo "no Rust"; else echo "with Rust"; fi))"
else
  # A second, independent staging folder; a different umask too, which a reproducible build must not see.
  echo "▸ build B (local, second staging folder, umask 0002)"
  ( umask 0002; box_build_local "$REPO" "$COMMIT" "$ARCH" 0 "$OUT/b" "$NO_RUST" ) || exit 3
  B_DESC="local, second staging folder"
fi
echo "▸ comparing (A: local $(uname -sm); B: $B_DESC)"
set +e
(cd "$REPO" && node --import tsx tools/box-artifact/compare.ts files "$OUT/a/$NAME.tar.gz" "$OUT/b/$NAME.tar.gz" --report "$OUT/report.json")
rc=$?
set -e
node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);const r=JSON.parse(fs.readFileSync(f,"utf8"));r.builders={a,b};fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n")' \
  "$OUT/report.json" "local $(uname -sm)" "$B_DESC"
exit $rc
