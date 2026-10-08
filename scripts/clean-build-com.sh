#!/usr/bin/env bash
# Rebuild every package the apps/com Worker bundles from an empty dist/.
#
# `tsc -b` never deletes the output of a source file that has gone away, so
# a deleted module (or one left behind by checking out a feature branch)
# keeps its compiled .js in dist/ indefinitely. Nothing imports it today, but
# a stale file one re-added export away from the bundle is exactly what
# predeploy's orphan gate refuses. Removing dist/ alone is not enough: the
# tsbuildinfo would tell `tsc -b` the project is up to date and skip it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=com-bundled-packages.sh
. "$REPO_ROOT/scripts/com-bundled-packages.sh"

targets=()
for pkg in $BUNDLED_PKGS; do
  rm -rf "$REPO_ROOT/packages/$pkg/dist" "$REPO_ROOT/packages/$pkg/tsconfig.tsbuildinfo"
  targets+=("$REPO_ROOT/packages/$pkg")
done
npx --prefix "$REPO_ROOT" tsc -b "${targets[@]}"
