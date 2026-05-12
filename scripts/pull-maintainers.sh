#!/usr/bin/env bash
# Pull the maintainers project from its standalone home at the SHA
# pinned in scripts/maintainers.pinned-sha (or MAINTAINERS_PINNED_SHA
# if set), then bundle its web-ui for serving at flagshipserver.com/
# maintainers/. Both steps are idempotent — fast-path checks at the
# top short-circuit if everything is already at the pinned SHA.
#
# Why: maintainers/ is NOT vendored into this repo. It's pulled at
# build time so we dogfood the same model adopters will use. See
# docs/maintainers-deployment.md for the full picture.
#
# Phases:
#   pull    — git-clone + reset to pinned SHA; install maintainers deps.
#   bundle  — esbuild-bundle the web-ui into the Worker's [assets].
#
# Used in these places:
#   - `npm install` preinstall hook   → runs `pull` (esbuild not yet present)
#   - `npm install` postinstall hook  → runs `bundle` (esbuild now present)
#   - Dockerfile                      → explicit pull, npm install, no
#                                       postinstall needed (lifecycle covers)
#   - `npm run pull-maintainers`      → runs the full default (pull + bundle)
#
# Args:
#   $1 = "pull" | "bundle" | "" (default = pull + bundle)
#
# Environment overrides:
#   MAINTAINERS_REPO_URL    default https://github.com/ibisllc/maintainers.git
#   MAINTAINERS_PINNED_SHA  default contents of scripts/maintainers.pinned-sha
#   SKIP_PULL_MAINTAINERS   set to 1 to bypass the entire script (e.g. for
#                           tests that need a frozen working copy)

set -euo pipefail

PHASE="${1:-all}"

if [[ "${SKIP_PULL_MAINTAINERS:-}" == "1" ]]; then
  echo "[pull-maintainers] SKIP_PULL_MAINTAINERS=1; skipping ($PHASE)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIN_FILE="$SCRIPT_DIR/maintainers.pinned-sha"

REPO_URL="${MAINTAINERS_REPO_URL:-https://github.com/ibisllc/maintainers.git}"
if [[ -n "${MAINTAINERS_PINNED_SHA:-}" ]]; then
  PINNED_SHA="$MAINTAINERS_PINNED_SHA"
elif [[ -f "$PIN_FILE" ]]; then
  PINNED_SHA="$(head -1 "$PIN_FILE" | tr -d '[:space:]')"
else
  echo "[pull-maintainers] error: no pinned SHA — set MAINTAINERS_PINNED_SHA or write $PIN_FILE" >&2
  exit 2
fi

if [[ -z "$PINNED_SHA" ]]; then
  echo "[pull-maintainers] error: pinned SHA is empty" >&2
  exit 2
fi

TARGET="$REPO_ROOT/maintainers"
BUNDLE_OUT="$REPO_ROOT/apps/web/public/maintainers/lib"
BUNDLE_FILE="$BUNDLE_OUT/web-ui.js"
PIN_SENTINEL="$BUNDLE_OUT/PIN.txt"
ESBUILD_BIN="$REPO_ROOT/node_modules/.bin/esbuild"

run_pull() {
  # Fast path: maintainers/ already at the pin.
  if [[ -d "$TARGET/.git" ]]; then
    local current
    current="$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "")"
    if [[ "$current" == "$PINNED_SHA" ]]; then
      echo "[pull-maintainers] [pull] already at $PINNED_SHA"
      return
    fi
  fi

  echo "[pull-maintainers] [pull] target SHA: $PINNED_SHA"
  echo "[pull-maintainers] [pull] source:     $REPO_URL"

  if [[ ! -d "$TARGET/.git" ]]; then
    rm -rf "$TARGET"
    echo "[pull-maintainers] [pull] cloning $REPO_URL into $TARGET"
    git clone --no-checkout "$REPO_URL" "$TARGET"
  fi

  cd "$TARGET"
  echo "[pull-maintainers] [pull] fetching $PINNED_SHA"
  git fetch --depth=1 origin "$PINNED_SHA" 2>/dev/null || git fetch origin
  git reset --hard "$PINNED_SHA"
  echo "[pull-maintainers] [pull] checked out $(git rev-parse HEAD)"
  cd "$REPO_ROOT"

  # Install maintainers' own deps so it's a usable workspace.
  if [[ -f "$TARGET/package-lock.json" || -f "$TARGET/package.json" ]]; then
    echo "[pull-maintainers] [pull] installing maintainers deps"
    (cd "$TARGET" && npm install --no-audit --no-fund --silent) || {
      echo "[pull-maintainers] [pull] warning: npm install in maintainers/ failed (continuing)" >&2
    }
  fi
}

run_bundle() {
  # Fast path: bundle already exists at the pinned SHA.
  if [[ -f "$BUNDLE_FILE" ]] && [[ -f "$PIN_SENTINEL" ]]; then
    local bundlePin
    bundlePin="$(head -1 "$PIN_SENTINEL" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$bundlePin" == "$PINNED_SHA" ]]; then
      echo "[pull-maintainers] [bundle] already at $PINNED_SHA"
      return
    fi
  fi

  if [[ ! -d "$TARGET/packages/web-ui/src" ]]; then
    echo "[pull-maintainers] [bundle] warning: maintainers/ not pulled yet; run pull first" >&2
    return
  fi

  if [[ ! -f "$ESBUILD_BIN" ]]; then
    echo "[pull-maintainers] [bundle] warning: esbuild not found at $ESBUILD_BIN" >&2
    echo "[pull-maintainers] [bundle] (run npm install at the repo root, then retry)" >&2
    return
  fi

  echo "[pull-maintainers] [bundle] esbuild → /maintainers/lib/web-ui.js"
  mkdir -p "$BUNDLE_OUT"
  "$ESBUILD_BIN" \
    "$TARGET/packages/web-ui/src/index.ts" \
    --bundle \
    --format=esm \
    --platform=browser \
    --target=es2022 \
    --outfile="$BUNDLE_FILE" \
    --log-level=warning
  echo "$PINNED_SHA" > "$PIN_SENTINEL"
  echo "[pull-maintainers] [bundle] wrote $(wc -c <"$BUNDLE_FILE") bytes"
}

case "$PHASE" in
  pull)
    run_pull
    ;;
  bundle)
    run_bundle
    ;;
  all|"")
    run_pull
    run_bundle
    ;;
  *)
    echo "[pull-maintainers] error: unknown phase '$PHASE' (expected: pull, bundle, all)" >&2
    exit 2
    ;;
esac

echo "[pull-maintainers] [$PHASE] done"
