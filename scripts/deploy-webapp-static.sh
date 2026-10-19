#!/usr/bin/env bash
# Build the assets directory of the static-only webapp Worker (flagship-webapp:
# webapp. and remote.flagshipserver.com) from apps/web/public/webapp and deploy it.
# Runs BEFORE flagship-com in apps/com `npm run deploy`: the first run points the webapp.
# and remote. custom domains at this Worker (flagship-com no longer lists them), so
# they never have a moment with no owner. Never deploys from a dirty or unbuilt tree: the guard
# below is the same one flagship-com's predeploy runs.
#
# This Worker owns the PRODUCTION hostnames, so it refuses (static-assets.ts deploy-guard) unless:
#   - HEAD is already on origin/main and the worktree is clean (override, for a deliberate case only:
#     FLAGSHIP_WEBAPP_DEPLOY_OVERRIDE=I-AM-SHIPPING-AN-UNVERIFIED-TREE-TO-THE-PRODUCTION-WEBAPP-HOSTNAMES),
#   - the webapp's BAKED_PIN is this tree's MAINTAINER_PINNED_MANDATE_HASH and it has no gym seam
#     (never waivable: the gym branch bakes its own CA pin; this once put it live on webapp.),
#   - no gym deployment is running (scripts/gym-refresh.sh deploys flagship-com-gym only; never waivable).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx tsx scripts/static-assets.ts deploy-guard "$ROOT/apps/web/public/webapp" "$@"
npx tsx scripts/static-assets.ts check
npx tsx scripts/static-assets.ts build-webapp
npx tsx scripts/static-assets.ts deploy-guard "$ROOT/apps/webapp-static/public" "$@"
cd apps/webapp-static
wrangler deploy "$@"
