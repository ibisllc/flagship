#!/usr/bin/env bash
#
# box-artifact-vm — build one commit's box artifact (unsigned, Rust included) on a throwaway UpCloud
# Debian 13 VM, with the same steps as .github/workflows/box-artifact.yml, so the gym never depends on
# GitHub Actions. The VM is deleted at the end, also on failure. amd64 only (UpCloud's machines).
#
#   bash scripts/box-artifact-vm.sh --repo <repository> --commit <40-hex> --sequence <n> --out <dir>
#
# Writes flagship-box-<commit12>-amd64.{tar.gz,manifest.unsigned.json} (and the build's other outputs)
# into <dir>. Signing stays on this machine (scripts/gym-box-artifact.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="" COMMIT="" SEQ="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --sequence) SEQ="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$SEQ" ] && [ -n "$OUT" ] || { echo "usage: --repo --commit --sequence --out" >&2; exit 2; }
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "commit must be 40 hex characters" >&2; exit 2; }
# shellcheck source=lib/upcloud-vm.sh
. "$HERE/lib/upcloud-vm.sh"

vm_up "box-artifact-${COMMIT:0:12}-$(date -u +%Y%m%dt%H%M%Sz)" box-artifact
vm_send_commit "$REPO" "$COMMIT"
vm_toolchains "$REPO" "$VM_WORK/setup.log" || { tail -20 "$VM_WORK/setup.log"; exit 1; }
say "building ${COMMIT:0:12} amd64 (sequence $SEQ)"
vm_run "npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx tsx tools/box-artifact/build.ts build --commit $COMMIT --arch amd64 --sequence $SEQ --out /root/out --repo /root/fs"
mkdir -p "$OUT"
"${VM_SSH[@]}" 'tar -C /root/out -czf - .' | tar -xzf - -C "$OUT"
say "artifact in $OUT: $(cd "$OUT" && ls flagship-box-* | tr '\n' ' ')"
