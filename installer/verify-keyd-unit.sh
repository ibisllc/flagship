#!/bin/bash
# Check the effective properties of the running flagship-keyd unit against the list the plan
# requires (SECURITY-HARDENING-PLAN.md 5.1). Run on the production appliance:
#
#   verify-keyd-unit.sh [unit]            # reads `systemctl show` (flagship-keyd.service by default)
#   verify-keyd-unit.sh --tlsd [unit]     # the TLS frontend's properties (flagship-tlsd.service)
#   verify-keyd-unit.sh [--tlsd] --from FILE   # reads saved `systemctl show` output (tests)
#
# Exit 0 when every property matches; 1 and the list of mismatches otherwise.
set -u
unit="flagship-keyd.service"
from=""
mode=keyd
if [ "${1:-}" = "--tlsd" ]; then mode=tlsd; unit="flagship-tlsd.service"; shift; fi
if [ "${1:-}" = "--from" ]; then from="$2"; elif [ -n "${1:-}" ]; then unit="$1"; fi

if [ -n "$from" ]; then shown=$(cat "$from"); else shown=$(systemctl show "$unit" 2>/dev/null) || { echo "cannot read $unit" >&2; exit 1; }; fi

fail=0
expect() {
  local key="$1" want="$2" got
  got=$(printf '%s\n' "$shown" | sed -n "s/^$key=//p" | head -n1)
  if [ "$got" != "$want" ]; then echo "MISMATCH $key: want '$want' got '$got'"; fail=1; fi
}
if [ "$mode" = "tlsd" ]; then
  expect User flagship-tlsd
  expect PrivateDevices yes
  expect ProtectKernelTunables yes
  expect ProtectKernelModules yes
  expect ProtectControlGroups yes
  expect RestrictNamespaces yes
  expect LockPersonality yes
else
  expect User flagship-keyd
  expect PrivateDevices yes
  expect PrivateNetwork yes
  expect ProtectKernelTunables yes
  expect ProtectKernelModules yes
  expect ProtectKernelLogs yes
  expect ProtectControlGroups yes
  expect ProtectClock yes
  expect ProtectHostname yes
  expect RestrictNamespaces yes
  expect RestrictRealtime yes
  expect RestrictSUIDSGID yes
  expect LockPersonality yes
fi
expect NoNewPrivileges yes
expect ProtectSystem strict
expect ProtectHome yes
expect PrivateTmp yes
expect MemoryDenyWriteExecute yes
expect LimitCORE 0
expect CapabilityBoundingSet ""
expect UMask 0077
if [ "$mode" = "tlsd" ]; then
  fam=$(printf '%s\n' "$shown" | sed -n 's/^RestrictAddressFamilies=//p' | head -n1 | tr -d ' ')
  case "$fam" in *AF_UNIX*AF_INET*|*AF_INET*AF_UNIX*) ;; *) echo "MISMATCH RestrictAddressFamilies: want Unix and IP only got '$fam'"; fail=1 ;; esac
  case "$fam" in *AF_PACKET*|*AF_NETLINK*) echo "MISMATCH RestrictAddressFamilies: raw families allowed '$fam'"; fail=1 ;; esac
  expect IPAddressDeny "any"
  exit $fail
fi
# RestrictAddressFamilies is a list: it must contain AF_UNIX and nothing else.
fam=$(printf '%s\n' "$shown" | sed -n 's/^RestrictAddressFamilies=//p' | head -n1 | tr -d ' ')
[ "$fam" = "AF_UNIX" ] || { echo "MISMATCH RestrictAddressFamilies: want 'AF_UNIX' got '$fam'"; fail=1; }
exit $fail
