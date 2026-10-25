#!/usr/bin/env bash
# Builds the WASI fixture apps with the pinned toolchain and copies them where
# the worker's tests and the live gym read them. Run after changing the SDK or
# an example; commit the .wasm files and FIXTURES.sha256 with the change.
#   rustup target add wasm32-wasip1   (once)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../crates/flagship-wasi/tests/fixtures"
cd "$here"
RUSTFLAGS="--remap-path-prefix=$here=/flagship-wasi-sdk" \
  cargo build --locked --release --target wasm32-wasip1 --examples
for app in wasi-fixture wasi-hostcalls; do
  cp "target/wasm32-wasip1/release/examples/$app.wasm" "$out/sdk-$app.wasm"
done
(cd "$out" && shasum -a 256 sdk-wasi-fixture.wasm sdk-wasi-hostcalls.wasm > FIXTURES.sha256)
cat "$out/FIXTURES.sha256"
