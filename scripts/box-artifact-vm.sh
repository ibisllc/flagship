#!/usr/bin/env bash
#
# box-artifact-vm — build one commit's box artifact (unsigned, Rust included) on a throwaway UpCloud
# Debian 13 VM, with the same steps as .github/workflows/box-artifact.yml, so the gym never depends on
# GitHub Actions. The VM is deleted at the end, also on failure. UpCloud's machines are amd64: an arm64
# artifact is cross-built there (Debian's aarch64 GNU toolchain for the Rust and C parts, GOARCH for Go,
# npm --cpu for the platform packages, the official arm64 Node archive), and build.ts refuses any binary
# whose ELF machine is not arm64. CI builds arm64 natively on ubuntu-24.04-arm.
#
#   bash scripts/box-artifact-vm.sh --repo <repository> --commit <40-hex> --sequence <n> --out <dir> [--arch amd64,arm64] [--no-rust]
#
# --no-rust builds the JS half only (as on a Mac, which cannot link Rust for Linux), so a cross-machine
# comparison with a Mac build compares like with like. VM_LABEL (default box-artifact) is the VM's
# flagship-env label; `gym` puts it in the gym sweep's reach if it ever outlives this script.
# Writes flagship-box-<commit12>-<arch>.{tar.gz,manifest.unsigned.json} (and the build's other outputs)
# into <dir> for each arch (default amd64). Signing stays on this machine (scripts/gym-box-artifact.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="" COMMIT="" SEQ="" OUT="" ARCHES="amd64" NO_RUST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --sequence) SEQ="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --arch) ARCHES="$2"; shift 2 ;;
    --no-rust) NO_RUST=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$SEQ" ] && [ -n "$OUT" ] || { echo "usage: --repo --commit --sequence --out" >&2; exit 2; }
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "commit must be 40 hex characters" >&2; exit 2; }
for a in ${ARCHES//,/ }; do case "$a" in amd64|arm64) ;; *) echo "--arch takes amd64 and/or arm64, not $a" >&2; exit 2 ;; esac; done
# shellcheck source=lib/upcloud-vm.sh
. "$HERE/lib/upcloud-vm.sh"

vm_up "box-artifact-${COMMIT:0:12}-$(date -u +%Y%m%dt%H%M%Sz)" "${VM_LABEL:-box-artifact}"
vm_send_commit "$REPO" "$COMMIT"
vm_toolchains "$REPO" "$VM_WORK/setup.log" || { tail -20 "$VM_WORK/setup.log"; exit 1; }
case ",$ARCHES," in *,arm64,*)
  say "installing the aarch64 cross toolchain"
  vm_run "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross cmake >/dev/null && (cd rust && rustup target add aarch64-unknown-linux-gnu >/dev/null)" ;;
esac
vm_run "npm ci --ignore-scripts --no-audit --no-fund >/dev/null"
for ARCH in ${ARCHES//,/ }; do
  say "building ${COMMIT:0:12} $ARCH (sequence $SEQ)"
  vm_run "npx tsx tools/box-artifact/build.ts build --commit $COMMIT --arch $ARCH --sequence $SEQ --out /root/out --repo /root/fs$([ "$NO_RUST" = 1 ] && echo " --no-rust")"
done
mkdir -p "$OUT"
"${VM_SSH[@]}" 'tar -C /root/out -czf - .' | tar -xzf - -C "$OUT"
say "artifact in $OUT: $(cd "$OUT" && ls flagship-box-* | tr '\n' ' ')"
