#!/usr/bin/env bash
# Build the assets directory of the static-only webapp Worker (flagship-webapp:
# webapp. and remote.flagshipserver.com) from apps/web/public/webapp and deploy it.
# Runs BEFORE flagship-com in apps/com `npm run deploy`: the first run points the webapp.
# and remote. custom domains at this Worker (flagship-com no longer lists them), so
# they never have a moment with no owner. Never deploys from a dirty or unbuilt tree: the guard
# below is the same one flagship-com's predeploy runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx tsx scripts/static-assets.ts check
npx tsx scripts/static-assets.ts build-webapp
cd apps/webapp-static
wrangler deploy "$@"
