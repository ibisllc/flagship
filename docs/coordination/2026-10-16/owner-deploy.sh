#!/usr/bin/env bash
# Owner-run deploy of everything on origin/main. Run the steps one by one (copy/paste), in order.
# Rule: deploy ONLY from a clean worktree of a pushed main commit, with its own node_modules.
set -euo pipefail
cd ~/flagship && git fetch origin
W=~/flagship-deploy-wt
rm -rf "$W"; git worktree add --detach "$W" origin/main
cd "$W" && git log --oneline -1 && npm ci

# 0. sanity: everything compiles and tests pass on this exact commit
npx tsc -b && npx vitest run packages apps/web tools/gym scripts

# 1. .com: D1 migration 0104 (only pending one) + peer-backup secrets (once; NEVER rotate PB_FILLER_SECRET)
cd "$W/apps/com"
npx wrangler d1 execute flagship-state --remote --file=../../packages/storage/migrations/0104_peer_backup_network.sql
node -e 'process.stdout.write(JSON.stringify(require("node:crypto").generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"jwk"})))' | npx wrangler secret put PB_TOKEN_RSA_JWK
openssl rand -hex 32 | npx wrangler secret put PB_FILLER_SECRET
openssl rand -hex 32 | npx wrangler secret put PB_TAG_SECRET
# ACCOUNT_READ_TOKEN_SECRET must already exist (check: npx wrangler secret list)
npm run deploy          # predeploy rebuilds bundled packages + checks migration drift; never call `wrangler deploy` directly

# 2. .services (Fly relay + peer-backup mailbox relay); drops every box tunnel for ~20 s
cd "$W" && export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# 3. verify
curl -s https://flagshipserver.com/api/health; echo
curl -s https://webapp.flagshipserver.com/service-worker.js | grep -m1 'SHELL_VERSION ='
curl -s https://flagship.services/api/health; echo
cd ~/flagship && git worktree remove --force "$W"
