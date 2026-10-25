#!/bin/bash
# Milestone 7 (GPU) drill box: a throwaway Debian 13 VM, or a GPU box booted for a hardware
# receipt, gets this tree's rust/ workspace, builds flagship-gpu `--locked` with the pinned
# toolchain, runs its test suite on Linux, and installs flagship-gpud. Real Podman is installed so
# the self-test can inject a simulated CDI device into a container.
#
#   setup-box.sh <path to rust.tar.gz>
set -euo pipefail
SRC_TAR="$1"
export DEBIAN_FRONTEND=noninteractive
log() { echo "[m7-setup $(date -u +%H:%M:%S)] $*"; }

log "packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl jq build-essential pkg-config podman crun busybox-static >/dev/null
podman --version

log "source"
rm -rf /opt/flagship-m7 && mkdir -p /opt/flagship-m7
tar -xzf "$SRC_TAR" -C /opt/flagship-m7
cd /opt/flagship-m7/rust

log "rust (rustup, the toolchain rust-toolchain.toml pins)"
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal >/dev/null
fi
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

log "build"
cargo build --release --locked -p flagship-gpu
install -m 0755 target/release/flagship-gpud /usr/local/bin/flagship-gpud

if [ "${M7_RUN_TESTS:-1}" = 1 ]; then
  log "flagship-gpu tests on Linux"
  cargo test --release --locked -p flagship-gpu 2>&1 | grep -E "^test result|FAILED|panicked" || true
  cargo test --release --locked -p flagship-gpu >/tmp/m7-cargo-test.log 2>&1 && echo "cargo-test: ok" || { echo "cargo-test: FAILED"; tail -40 /tmp/m7-cargo-test.log; exit 1; }
fi
log "done: $(sha256sum /usr/local/bin/flagship-gpud | cut -c1-16)"
