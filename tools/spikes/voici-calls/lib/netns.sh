#!/usr/bin/env bash
# up: create netns 'phone' and the TUN link (the emulator process must own both TUNs: run it after 'up').
set -euo pipefail
case "${1:-}" in
  up)
    ip netns add phone 2>/dev/null || true
    ip netns exec phone ip link set lo up ;;
  addr)
    ip addr add 203.0.113.1/30 dev tunA; ip link set tunA up
    ip netns exec phone ip addr add 203.0.113.2/30 dev tunB
    ip netns exec phone ip link set tunB up
    ip netns exec phone ip route add default via 203.0.113.1 dev tunB 2>/dev/null || true ;;
  down)
    ip netns del phone 2>/dev/null || true ;;
esac
