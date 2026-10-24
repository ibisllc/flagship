#!/usr/bin/env bash
#
# full-test-vm — run every test suite of one commit on a throwaway Debian 13 VM (UpCloud), so the
# results do not depend on a loaded laptop: tsc, the full vitest run, cargo fmt/clippy/test/deny,
# the Go tests, the crypto-graph check and the keyd TS<->Rust cross-check (Linux only). The VM is
# deleted at the end, also on failure, unless --keep. Results land in gym-results/full-test-<stamp>/.
#
#   bash scripts/full-test-vm.sh [--commit <sha>] [--keep] [--zone de-fra1] [--plan 8xCPU-32GB]
#
# Needs: ~/.config/flagship/upcloud-token (the gym tooling's token), ssh, curl, python3.
# Every VM it makes carries the label flagship-env=release-test.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="" KEEP=0 ZONE="de-fra1" PLAN="8xCPU-32GB"
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --zone) ZONE="$2"; shift 2 ;;
    --plan) PLAN="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
COMMIT="$(git -C "$REPO" rev-parse "${COMMIT:-HEAD}")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/gym-results/full-test-$STAMP"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
TOKEN="$(cat "$HOME/.config/flagship/upcloud-token")"
case "$TOKEN" in *:*) AUTH=(-u "$TOKEN") ;; *) AUTH=(-H "Authorization: Bearer $TOKEN") ;; esac
API=https://api.upcloud.com/1.3
TEMPLATE=01000000-0000-4000-8000-000020080100   # Debian GNU/Linux 13 (Trixie)
NAME="release-test-${COMMIT:0:12}-$(echo "$STAMP" | tr "[:upper:]" "[:lower:]")"
say() { echo "▸ $*"; }
api() { curl -fsS -m 60 "${AUTH[@]}" -H 'content-type: application/json' "$@"; }

ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
UUID=""
cleanup() {
  local rc=$?
  if [ -n "$UUID" ] && [ "$KEEP" = 0 ]; then
    say "deleting the VM $UUID"
    api -X POST -d '{"stop_server":{"stop_type":"hard","timeout":"60"}}' "$API/server/$UUID/stop" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      [ "$(api "$API/server/$UUID" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["state"])' 2>/dev/null)" = stopped ] && break
      sleep 4
    done
    curl -sS -m 60 -o /dev/null -w "  delete: %{http_code}\n" "${AUTH[@]}" -X DELETE "$API/server/$UUID?storages=1&backups=delete" || true
  elif [ -n "$UUID" ]; then
    say "kept the VM $UUID (root@$IP, key $WORK/key): delete it yourself"
  fi
  [ "$KEEP" = 1 ] || rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT

say "creating $NAME ($PLAN, $ZONE)"
BODY=$(python3 - "$NAME" "$ZONE" "$PLAN" "$TEMPLATE" "$(cat "$WORK/key.pub")" <<'PY'
import json, sys
name, zone, plan, template, pub = sys.argv[1:]
print(json.dumps({"server": {
  "zone": zone, "plan": plan, "title": name, "hostname": name, "metadata": "yes",
  "labels": {"label": [{"key": "flagship-env", "value": "release-test"}]},
  "login_user": {"create_password": "no", "ssh_keys": {"ssh_key": [pub]}},
  "storage_devices": {"storage_device": [{"action": "clone", "storage": template, "title": f"{name}-disk", "size": 80, "tier": "maxiops"}]},
  "networking": {"interfaces": {"interface": [{"type": "public", "ip_addresses": {"ip_address": [{"family": "IPv4"}]}}, {"type": "utility", "ip_addresses": {"ip_address": [{"family": "IPv4"}]}}]}},
}}))
PY
)
RESP=$(api -X POST -d "$BODY" "$API/server")
UUID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["uuid"])')
for _ in $(seq 1 90); do
  S=$(api "$API/server/$UUID")
  STATE=$(echo "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["state"])')
  IP=$(echo "$S" | python3 -c 'import sys,json
d=json.load(sys.stdin)["server"]
print(next((a["address"] for i in d["networking"]["interfaces"]["interface"] if i["type"]=="public" for a in i["ip_addresses"]["ip_address"] if a["family"]=="IPv4"),""))')
  [ "$STATE" = started ] && [ -n "$IP" ] && break
  sleep 5
done
[ "$STATE" = started ] || { echo "the VM did not start"; exit 1; }
SSH=(ssh -q -i "$WORK/key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$WORK/known_hosts" -o ConnectTimeout=10 -o ServerAliveInterval=30 "root@$IP")
for _ in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 5; done
say "VM up at $IP"

say "installing git (the bare image has none)"
"${SSH[@]}" 'export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null && apt-get install -y -q git >/dev/null'
say "sending ${COMMIT:0:12}"
git -C "$REPO" archive --format=tar "$COMMIT" | gzip -1 | "${SSH[@]}" 'mkdir -p /root/fs && tar -xzf - -C /root/fs && cd /root/fs && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm tree'

say "installing toolchains (Node from the security floor, Rust from rust-toolchain.toml, Go)"
NODE_V=$(node -e 'console.log(require(process.argv[1]).node.minimum)' "$REPO/release/security-floor.json")
"${SSH[@]}" bash -s "$NODE_V" <<'SETUP' > "$OUT/setup.log" 2>&1
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl xz-utils build-essential pkg-config libssl-dev python3 jq openssl xxd cryptsetup
curl -fsSL "https://nodejs.org/dist/v$1/node-v$1-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
curl -fsSL https://go.dev/dl/go1.26.3.linux-amd64.tar.gz | tar -xz -C /usr/local
cd /root/fs/rust && /root/.cargo/bin/rustup show active-toolchain >/dev/null
/root/.cargo/bin/cargo install --locked cargo-deny >/dev/null 2>&1 || true
SETUP

run_suite() { # run_suite <name> <command>: on the VM, output to $OUT/<name>.log, exit code to $OUT/<name>.rc
  say "suite $1"
  set +e
  "${SSH[@]}" "export PATH=/usr/local/go/bin:/root/.cargo/bin:\$PATH; cd /root/fs && $2" > "$OUT/$1.log" 2>&1
  echo $? > "$OUT/$1.rc"
  set -e
  echo "  exit $(cat "$OUT/$1.rc")"
}
run_suite npm-ci "npm ci --no-audit --no-fund"
run_suite tsc "npx tsc -b"
run_suite vitest "npx vitest run --reporter=default --reporter=json --outputFile=/root/vitest.json"
"${SSH[@]}" cat /root/vitest.json > "$OUT/vitest.json" 2>/dev/null || true
run_suite cargo-fmt "cd rust && cargo fmt --all --check"
run_suite cargo-clippy "cd rust && cargo clippy --all-targets -- -D warnings"
run_suite cargo-test "cd rust && cargo test"
run_suite cargo-deny "cd rust && cargo deny check"
run_suite go-tls-frontend "cd installer/tls-frontend && go test ./..."
run_suite go-unseal "cd installer/unseal-helper && go test ./..."
run_suite crypto-graph "node scripts/crypto-graph-check.mjs"
run_suite keyd-crosscheck "npx vitest run packages/keyd/tests/rustBackend.test.ts"

python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
rows = []
for f in sorted(os.listdir(out)):
    if f.endswith(".rc"):
        rows.append((f[:-3], open(os.path.join(out, f)).read().strip()))
lines = [f"{'OK ' if rc == '0' else 'FAIL'} {name} (exit {rc})" for name, rc in rows]
try:
    v = json.load(open(os.path.join(out, "vitest.json")))
    lines.append(f"vitest: {v['numPassedTests']} passed, {v['numFailedTests']} failed, {v['numPendingTests']} skipped of {v['numTotalTests']}")
    for t in v["testResults"]:
        for a in t["assertionResults"]:
            if a["status"] == "failed":
                lines.append(f"  ✗ {os.path.relpath(t['name'], '/root/fs')} > {a['fullName']}")
except Exception as e:
    lines.append(f"vitest: no json ({e})")
open(os.path.join(out, "SUMMARY.txt"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines[:80]))
PY
echo "results: $OUT"
FAILED=$(grep -c '^FAIL' "$OUT/SUMMARY.txt" || true)
[ "$FAILED" = 0 ]
