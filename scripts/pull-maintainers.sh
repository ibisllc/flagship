#!/usr/bin/env bash
# Pull the maintainers project from its standalone home at the SHA
# pinned in scripts/maintainers.pinned-sha (or MAINTAINERS_PINNED_SHA
# if set). Idempotent — if maintainers/ already exists at the right
# SHA, exits 0 silently.
#
# Why: maintainers/ is NOT vendored into this repo. It's pulled at
# build time so we dogfood the same model adopters will use. See
# docs/maintainers-deployment.md for the full picture.
#
# Used in three places:
#   - `npm install` preinstall hook (local dev)
#   - Dockerfile (Fly + Cloudflare-Worker bundle builds)
#   - GitHub Actions (CI)
#
# Environment overrides (rare):
#   MAINTAINERS_REPO_URL    default https://github.com/ibisllc/maintainers.git
#   MAINTAINERS_PINNED_SHA  default contents of scripts/maintainers.pinned-sha
#   SKIP_PULL_MAINTAINERS   set to 1 to bypass entirely (e.g. for tests on
#                           a frozen working copy)

set -euo pipefail

if [[ "${SKIP_PULL_MAINTAINERS:-}" == "1" ]]; then
  echo "[pull-maintainers] SKIP_PULL_MAINTAINERS=1; skipping"
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

# Fast path: already at the pin, nothing to do.
if [[ -d "$TARGET/.git" ]]; then
  current="$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "")"
  if [[ "$current" == "$PINNED_SHA" ]]; then
    echo "[pull-maintainers] already at $PINNED_SHA"
    exit 0
  fi
fi

echo "[pull-maintainers] target SHA: $PINNED_SHA"
echo "[pull-maintainers] source:     $REPO_URL"

if [[ ! -d "$TARGET/.git" ]]; then
  # Clone with --no-checkout so the working tree doesn't get the
  # default branch HEAD only to be immediately reset.
  rm -rf "$TARGET"
  echo "[pull-maintainers] cloning $REPO_URL into $TARGET"
  git clone --no-checkout "$REPO_URL" "$TARGET"
fi

cd "$TARGET"
# Fetch the pinned SHA explicitly. Works with both commit SHAs and
# tag/branch names; --depth=1 cuts a fresh checkout to ~5 MB.
echo "[pull-maintainers] fetching $PINNED_SHA"
git fetch --depth=1 origin "$PINNED_SHA" 2>/dev/null || git fetch origin
git reset --hard "$PINNED_SHA"
echo "[pull-maintainers] checked out $(git rev-parse HEAD)"

# Install maintainers' own deps so it's a usable workspace.
# Quiet by default; rerun with --verbose if you need the output.
if [[ -f "$TARGET/package-lock.json" || -f "$TARGET/package.json" ]]; then
  echo "[pull-maintainers] installing maintainers deps"
  (cd "$TARGET" && npm install --no-audit --no-fund --silent) || {
    echo "[pull-maintainers] warning: npm install in maintainers/ failed (continuing)" >&2
  }
fi

echo "[pull-maintainers] done"
