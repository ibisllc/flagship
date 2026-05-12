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
# Usage:
#   scripts/predeploy-com.sh [args-that-would-be-passed-to-wrangler]
#
# Exits 0 when the args are safe, 1 when any --route(s) flag is seen.

set -euo pipefail

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

exit 0
