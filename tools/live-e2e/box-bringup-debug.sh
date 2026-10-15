#!/usr/bin/env bash
# Debug a gym box that won't come up: SSH in and dump the bootstrap + daemon logs.
#
# Gym boxes have no SSH key unless the gym Worker holds the debug-only secret
# UPCLOUD_SSH_PUBLIC_KEY when the box is created (docs/sample-users.md §17.1):
#   ssh-keygen -t ed25519 -N '' -f ~/.ssh/gym-debug
#   (cd apps/com && npx wrangler secret put UPCLOUD_SSH_PUBLIC_KEY --config wrangler.gym.toml < ~/.ssh/gym-debug.pub)
# then provision a box (e.g. fleet-cli.ts add-box <user> dbg), and delete the
# secret again when done (wrangler secret delete UPCLOUD_SSH_PUBLIC_KEY --config wrangler.gym.toml).
#
# Usage: bash tools/live-e2e/box-bringup-debug.sh <box public IPv4> [ssh key, default ~/.ssh/gym-debug]
# (The IPv4 is in the UpCloud console, or GET /api/dev/sample-user/<user> → provider.ipv4 for a demo box.)
set -uo pipefail
IP="${1:?usage: box-bringup-debug.sh <ip> [key]}"
KEY="${2:-$HOME/.ssh/gym-debug}"
for u in root debian; do
  if ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR "$u@$IP" true 2>/dev/null; then
    exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR "$u@$IP" \
      'sudo bash -c "uptime; echo === bootstrap; tail -n 60 /var/log/flagship-bootstrap.log; echo === register; tail -n 20 /var/log/flagship-first-boot-register.log; echo === daemon; journalctl -u flagship-daemon --no-pager -n 120"'
  fi
done
echo "no SSH login worked on $IP (was UPCLOUD_SSH_PUBLIC_KEY set when the box was created?)"
exit 1
