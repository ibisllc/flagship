#!/usr/bin/env bash
#
# gym-relay-c — the gym relay mesh's third relay `gym-c`: the Rust relay, built from the gym worktree, on an UpCloud
# Debian 13 VM with Caddy for TLS (docs/architecture-v2/relay-mesh.md §14.1, docs/runbooks/relay-mesh.md "Gym").
#
#   bash scripts/gym-relay-c.sh up [--dry-run]   create the VM (gym-labelled, so the fleet sweep reaps it), build and
#                                               start the relay and Caddy; on an existing VM: rebuild and restart
#   bash scripts/gym-relay-c.sh dns [--apply]   gym-c.tunnel.gym.flagship.services at the VM (dry run by default)
#   bash scripts/gym-relay-c.sh status          VM, services, /api/health
#   bash scripts/gym-relay-c.sh drain           stop the relay (SIGTERM: it drains); the live group's "relay leaving"
#   bash scripts/gym-relay-c.sh start           start it again; the live group's "relay joining"
#   bash scripts/gym-relay-c.sh down [--dry-run]  remove its DNS and destroy the VM (state file and all)
#
# Before `up`: admit it on the gym (`npm run relays -- add gym-c <key> full fra --ipv4 <ip>` once the VM has its address,
# then `update` if the address changes), and have these files:
#   ~/.config/flagship/gym-relay-c.seed       node scripts/relay-key.mjs new ~/.config/flagship/gym-relay-c.seed
#   ~/.config/flagship/gym-relay-c-cf-token   Cloudflare API token, Zone.DNS:Edit on flagship.services (Caddy DNS-01;
#                                             ~/.config/flagship/gym-dns-token is used when this file is absent)
#   ~/.config/flagship/upcloud-token          the gym's UpCloud token
#   GYM_USAGE_REPORT_SECRET in the environment or in .gym-secrets.env
#
# Env: GYM_RELAY_C_SRC (source tree; default the gym worktree ~/.cache/flagship/gym-worktree, else this checkout),
#      GYM_RELAY_C_ZONE (UpCloud zone, default de-fra1), GYM_RELAY_C_PIN (maintainer pin; default the source tree's),
#      GYM_RELAY_C_STATE (default ~/.config/flagship/gym-relay-c/state.json).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-help}" in
  -h|--help|help) sed -n '2,24p' "$0"; exit 0 ;;
esac
cd "$REPO"
exec npx tsx tools/live-e2e/relay-c-cli.ts "$@"
