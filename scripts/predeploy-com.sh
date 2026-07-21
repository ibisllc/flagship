#!/usr/bin/env bash
# Predeploy guard for the apps/com Cloudflare Worker.
#
# Cloudflare's wrangler treats `--routes X` as a *full* reconciliation:
# it drops every route attached to the Worker that isn't in `X` and
# silently re-attaches only the ones passed. We've burned production on
# this exact foot-gun (see the discovery note in apps/com/wrangler.toml,
# 2026-05-10) — losing web.flagshipserver.com or the www host because a
# one-off command line specified a narrower route set than what the
# Worker was previously serving.
#
# Routing for the .com Worker belongs in apps/com/wrangler.toml under
# the `routes = [...]` array. To change a route, edit the toml and
# redeploy with a bare `npx wrangler deploy`.
#
# It ALSO guards against the SECOND foot-gun documented in CLAUDE.md:
# `wrangler deploy` bundles the apps/com import of the BUILT workspace
# packages' `dist/` (control-plane / storage / protocol). A deploy
# without a fresh `npx tsc -b` silently ships STALE handler logic — the
# "outstanding-orders endpoint deployed yet never worked" class of bug.
# So before letting a deploy proceed we fail if any bundled package's
# `src/` is newer than its `dist/` (i.e. dist is missing or out of date).
#
# Usage:
#   scripts/predeploy-com.sh [args-that-would-be-passed-to-wrangler]
#
# Exits 0 when the args are safe AND every bundled dist is up to date;
# exits 1 on a --route(s) flag OR a stale/missing dist. Set
# FLAGSHIP_SKIP_DIST_FRESHNESS=1 to bypass only the freshness check (the
# route guard always runs).

set -euo pipefail

bash "$(dirname "$0")/private-name-storage-guard.sh"

# Repo root, resolved from this script's location so the freshness check
# works regardless of the caller's cwd. FLAGSHIP_DIST_CHECK_ROOT lets the
# test suite point the freshness check at a throwaway fixture tree.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${FLAGSHIP_DIST_CHECK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

POINTER="apps/com/wrangler.toml"
BAD=()

for arg in "$@"; do
  case "$arg" in
    --routes|--route)
      BAD+=("$arg")
      ;;
    --routes=*|--route=*)
      BAD+=("$arg")
      ;;
  esac
done

if [ "${#BAD[@]}" -gt 0 ]; then
  echo "" >&2
  echo "================================================================" >&2
  echo "REFUSING TO DEPLOY: --route(s) flag detected" >&2
  echo "================================================================" >&2
  echo "" >&2
  echo "Offending arg(s): ${BAD[*]}" >&2
  echo "" >&2
  echo "Why this is blocked:" >&2
  echo "  Cloudflare wrangler treats \`--routes X\` as a full reconciliation:" >&2
  echo "  every route NOT in X is silently dropped from the Worker. We have" >&2
  echo "  lost production hosts to this exact foot-gun before." >&2
  echo "" >&2
  echo "What to do instead:" >&2
  echo "  1. Edit the \`routes = [...]\` array in $POINTER." >&2
  echo "  2. Deploy with a bare \`npx wrangler deploy\` (no --route flags)." >&2
  echo "" >&2
  echo "================================================================" >&2
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Build-freshness gate (OPS-1).
#
# `wrangler deploy` bundles apps/com's import of these workspace packages
# from their BUILT dist/. If src/ is newer than dist/, the deploy ships
# stale logic. We compare the newest mtime under each package's src/
# against the newest mtime under its dist/; if any src is newer (or dist
# is missing/empty), refuse the deploy and tell the operator to run
# `npx tsc -b`.
# ──────────────────────────────────────────────────────────────────────

# Packages whose dist/ the Worker bundles (apps/com/package.json deps).
# boot-core ships the /api/boot/* router now mounted on flagship-com.
BUNDLED_PKGS="control-plane storage protocol boot-core"

# Echo the newest mtime (epoch seconds) of any regular file under $1,
# or empty when the dir is absent / has no files. POSIX-portable: uses
# find + a stat fallback that works on both BSD (macOS) and GNU.
newest_mtime() {
  dir="$1"
  [ -d "$dir" ] || return 0
  # Prefer find -printf (GNU); fall back to per-file stat (BSD/macOS).
  if find "$dir" -type f -printf '%T@\n' >/dev/null 2>&1; then
    find "$dir" -type f -printf '%T@\n' 2>/dev/null \
      | cut -d. -f1 | sort -n | tail -1
  else
    newest=0
    for f in $(find "$dir" -type f 2>/dev/null); do
      m="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)"
      [ "$m" -gt "$newest" ] 2>/dev/null && newest="$m"
    done
    [ "$newest" -gt 0 ] && echo "$newest"
  fi
}

if [ "${FLAGSHIP_SKIP_DIST_FRESHNESS:-0}" != "1" ]; then
  STALE=""
  for pkg in $BUNDLED_PKGS; do
    src_dir="$REPO_ROOT/packages/$pkg/src"
    dist_dir="$REPO_ROOT/packages/$pkg/dist"
    [ -d "$src_dir" ] || continue
    src_m="$(newest_mtime "$src_dir")"
    dist_m="$(newest_mtime "$dist_dir")"
    # Missing/empty dist, or src strictly newer than dist ⇒ stale.
    if [ -z "$dist_m" ]; then
      STALE="$STALE $pkg(dist missing)"
    elif [ -n "$src_m" ] && [ "$src_m" -gt "$dist_m" ]; then
      STALE="$STALE $pkg"
    fi
  done

  if [ -n "$STALE" ]; then
    echo "" >&2
    echo "================================================================" >&2
    echo "REFUSING TO DEPLOY: bundled package src is newer than dist" >&2
    echo "================================================================" >&2
    echo "" >&2
    echo "Stale / unbuilt package(s):${STALE}" >&2
    echo "" >&2
    echo "Why this is blocked:" >&2
    echo "  \`wrangler deploy\` bundles apps/com's import of the BUILT" >&2
    echo "  dist/ of these workspace packages. Deploying with src/ newer" >&2
    echo "  than dist/ silently ships STALE handler logic (a control-plane" >&2
    echo "  change that isn't compiled never reaches production)." >&2
    echo "" >&2
    echo "What to do instead:" >&2
    echo "  Run a fresh build, then redeploy:" >&2
    echo "    npx tsc -b" >&2
    echo "    cd apps/com && npx wrangler deploy" >&2
    echo "" >&2
    echo "  (Set FLAGSHIP_SKIP_DIST_FRESHNESS=1 to bypass only this check.)" >&2
    echo "" >&2
    echo "================================================================" >&2
    exit 1
  fi
fi

# ──────────────────────────────────────────────────────────────────────
# Migration-drift gate (OPS-2 enforcement).
#
# A deployed Worker can run AHEAD of the prod D1 schema (it bundles the
# BUILT storage/control-plane dist). A handler touching an unapplied
# migration's column throws at runtime (Cloudflare 1101 → HTTP 500). This
# 500'd every account creation once. The node helper compares the repo's
# migration files against the prod schema_version ledger and refuses the
# deploy on drift; it degrades to a warning when prod is unreachable.
#
# OPT-IN (FLAGSHIP_CHECK_PROD_MIGRATIONS=1, set by the predeploy npm
# script) so the unit tests that invoke this script directly — and would
# otherwise query prod from a wrangler-authed dev machine — never trigger
# it. Skipped under the dist-check fixture root too.
# ──────────────────────────────────────────────────────────────────────
if [ "${FLAGSHIP_CHECK_PROD_MIGRATIONS:-0}" = "1" ] && [ -z "${FLAGSHIP_DIST_CHECK_ROOT:-}" ]; then
  node "$REPO_ROOT/scripts/check-prod-migrations.mjs" || exit 1
fi

exit 0
