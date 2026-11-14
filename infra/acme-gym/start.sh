#!/bin/sh
# Pebble (ACME on 127.0.0.1:14000, management on :15000, both loopback only) and Caddy (the one public port, 8080, behind
# Fly's TLS). If either exits the machine stops and Fly restarts it: a fresh Pebble with a new root, which the gym
# harness notices (tools/live-e2e/lib/acmeTrust.ts). DNS-01 is checked against Cloudflare's real records via 1.1.1.1.
set -eu
PEBBLE_VA_NOSLEEP=1 /usr/local/bin/pebble -config /pebble/pebble-config.json -dnsserver 1.1.1.1:53 &
pebble=$!
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy=$!
trap 'kill $pebble $caddy 2>/dev/null' INT TERM
while kill -0 $pebble 2>/dev/null && kill -0 $caddy 2>/dev/null; do sleep 2; done
kill $pebble $caddy 2>/dev/null || true
exit 1
