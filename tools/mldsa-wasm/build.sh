#!/usr/bin/env bash
# Builds apps/web/public/webapp/vendor/mldsa-wasm/mldsa65.wasm from the vendored mldsa-native v2.0.0
# (the iOS C target's pq_mldsa.c), freestanding wasm32, no imports. The SHA-256 of the output is
# pinned in apps/web/public/webapp/lib/mldsaWasm.js; --check fails when the committed file differs
# from a fresh build or from the pin.
#
#   bash tools/mldsa-wasm/build.sh           rebuild
#   bash tools/mldsa-wasm/build.sh --check   compare only
#
# Needs a clang with the wasm32 target (Homebrew llvm) and wasm-ld (LLVM's, or the one in a Rust
# toolchain: rustlib/<host>/bin/gcc-ld/wasm-ld). CLANG and WASM_LD override the search.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PQ="$ROOT/apps/mobile/shared/Sources/CFlagshipPQ"
OUT="$ROOT/apps/web/public/webapp/vendor/mldsa-wasm/mldsa65.wasm"
PIN_FILE="$ROOT/apps/web/public/webapp/lib/mldsaWasm.js"

CLANG="${CLANG:-}"
if [ -z "$CLANG" ]; then
  for c in /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang "$(command -v clang || true)"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" --print-targets 2>/dev/null | grep -q wasm32; then CLANG="$c"; break; fi
  done
fi
[ -n "$CLANG" ] || { echo "no clang with the wasm32 target (brew install llvm)" >&2; exit 2; }
WASM_LD="${WASM_LD:-$(command -v wasm-ld || true)}"
if [ -z "$WASM_LD" ]; then
  WASM_LD="$(ls "$HOME"/.rustup/toolchains/*/lib/rustlib/*/bin/gcc-ld/wasm-ld 2>/dev/null | head -1 || true)"
fi
[ -n "$WASM_LD" ] || { echo "no wasm-ld (LLVM lld or a Rust toolchain)" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$CLANG" --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib -fno-builtin -fdebug-prefix-map="$ROOT"=. \
  -ffile-prefix-map="$ROOT"=. -I"$ROOT/tools/mldsa-wasm/include" -I"$PQ" -I"$PQ/include" -I"$PQ/vendor/mldsa" \
  -c "$ROOT/tools/mldsa-wasm/mldsa_wasm.c" -o "$TMP/mldsa.o"
"$WASM_LD" --no-entry --strip-all --export-dynamic -z stack-size=1048576 --initial-memory=2097152 \
  --export=__heap_base "$TMP/mldsa.o" -o "$TMP/mldsa65.wasm"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
NEW="$(sha "$TMP/mldsa65.wasm")"
PIN="$(sed -n 's/^export const MLDSA_WASM_SHA256 = "\([0-9a-f]\{64\}\)";$/\1/p' "$PIN_FILE" 2>/dev/null || true)"
if [ "${1:-}" = "--check" ]; then
  [ -f "$OUT" ] || { echo "missing $OUT" >&2; exit 1; }
  OLD="$(sha "$OUT")"
  [ "$OLD" = "$NEW" ] || { echo "$OUT is stale (committed $OLD, fresh build $NEW): bash tools/mldsa-wasm/build.sh" >&2; exit 1; }
  [ "$OLD" = "$PIN" ] || { echo "MLDSA_WASM_SHA256 in $PIN_FILE ($PIN) does not match $OUT ($OLD)" >&2; exit 1; }
  echo "mldsa65.wasm matches its build and its pin ($OLD)"
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
cp "$TMP/mldsa65.wasm" "$OUT"
echo "wrote $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes) sha256 $NEW"
[ "$PIN" = "$NEW" ] || echo "update MLDSA_WASM_SHA256 in $PIN_FILE to $NEW"
