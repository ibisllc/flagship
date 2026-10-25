# upcloud-vm — a throwaway Debian 13 VM on UpCloud for work that must not depend on this laptop or
# on GitHub Actions (scripts/full-test-vm.sh, scripts/box-artifact-vm.sh). Source it, then:
#
#   vm_up <name> <label>          create, wait for ssh; sets UUID, IP, VM_SSH (array), VM_WORK
#   vm_send_commit <repo> <sha>   a one-commit shallow clone at /root/fs: the real commit object, so
#                                 its id and timestamp are the repository's own
#   vm_toolchains <repo> [log]    Node from release/security-floor.json, Rust per rust-toolchain.toml, Go
#   vm_run <command>              runs on the VM with the toolchains on PATH, in /root/fs
#
# The VM is deleted on exit (also on failure) unless VM_KEEP=1. Needs ~/.config/flagship/upcloud-token,
# ssh, curl, python3. Env: VM_ZONE (de-fra1), VM_PLAN (8xCPU-32GB), VM_KEEP.
VM_ZONE="${VM_ZONE:-de-fra1}" VM_PLAN="${VM_PLAN:-8xCPU-32GB}" VM_KEEP="${VM_KEEP:-0}"
VM_TOKEN="$(cat "$HOME/.config/flagship/upcloud-token")"
case "$VM_TOKEN" in *:*) VM_AUTH=(-u "$VM_TOKEN") ;; *) VM_AUTH=(-H "Authorization: Bearer $VM_TOKEN") ;; esac
VM_API=https://api.upcloud.com/1.3
VM_TEMPLATE=01000000-0000-4000-8000-000020080100   # Debian GNU/Linux 13 (Trixie)
VM_GO=go1.26.3
UUID="" IP="" VM_WORK="$(mktemp -d)"
VM_SSH=()
say() { echo "▸ $*"; }
vm_api() { curl -fsS -m 60 "${VM_AUTH[@]}" -H 'content-type: application/json' "$@"; }

vm_down() {
  local rc=$?
  if [ -n "$UUID" ] && [ "$VM_KEEP" = 0 ]; then
    say "deleting the VM $UUID"
    vm_api -X POST -d '{"stop_server":{"stop_type":"hard","timeout":"60"}}' "$VM_API/server/$UUID/stop" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      [ "$(vm_api "$VM_API/server/$UUID" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["state"])' 2>/dev/null)" = stopped ] && break
      sleep 4
    done
    curl -sS -m 60 -o /dev/null -w "  delete: %{http_code}\n" "${VM_AUTH[@]}" -X DELETE "$VM_API/server/$UUID?storages=1&backups=delete" || true
  elif [ -n "$UUID" ]; then
    say "kept the VM $UUID (root@$IP, key $VM_WORK/key): delete it yourself"
  fi
  [ "$VM_KEEP" = 1 ] || rm -rf "$VM_WORK"
  exit $rc
}

vm_up() { # vm_up <name> <label value>
  local name="$1" label="$2" body state s
  trap vm_down EXIT
  ssh-keygen -q -t ed25519 -N "" -f "$VM_WORK/key"
  say "creating $name ($VM_PLAN, $VM_ZONE)"
  body=$(python3 - "$name" "$VM_ZONE" "$VM_PLAN" "$VM_TEMPLATE" "$(cat "$VM_WORK/key.pub")" "$label" <<'PY'
import json, sys
name, zone, plan, template, pub, label = sys.argv[1:]
print(json.dumps({"server": {
  "zone": zone, "plan": plan, "title": name, "hostname": name, "metadata": "yes",
  "labels": {"label": [{"key": "flagship-env", "value": label}]},
  "login_user": {"create_password": "no", "ssh_keys": {"ssh_key": [pub]}},
  "storage_devices": {"storage_device": [{"action": "clone", "storage": template, "title": f"{name}-disk", "size": 80, "tier": "maxiops"}]},
  "networking": {"interfaces": {"interface": [{"type": "public", "ip_addresses": {"ip_address": [{"family": "IPv4"}]}}, {"type": "utility", "ip_addresses": {"ip_address": [{"family": "IPv4"}]}}]}},
}}))
PY
)
  UUID=$(vm_api -X POST -d "$body" "$VM_API/server" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["uuid"])')
  for _ in $(seq 1 90); do
    s=$(vm_api "$VM_API/server/$UUID")
    state=$(echo "$s" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["state"])')
    IP=$(echo "$s" | python3 -c 'import sys,json
d=json.load(sys.stdin)["server"]
print(next((a["address"] for i in d["networking"]["interfaces"]["interface"] if i["type"]=="public" for a in i["ip_addresses"]["ip_address"] if a["family"]=="IPv4"),""))')
    [ "$state" = started ] && [ -n "$IP" ] && break
    sleep 5
  done
  [ "$state" = started ] || { echo "the VM did not start"; return 1; }
  VM_SSH=(ssh -q -i "$VM_WORK/key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$VM_WORK/known_hosts" -o ConnectTimeout=10 -o ServerAliveInterval=30 "root@$IP")
  for _ in $(seq 1 60); do "${VM_SSH[@]}" true 2>/dev/null && break; sleep 5; done
  say "VM up at $IP"
  say "installing git (the bare image has none)"
  "${VM_SSH[@]}" 'export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null && apt-get install -y -q git >/dev/null'
}

vm_send_commit() { # vm_send_commit <repo> <40-hex commit>
  local repo="$1" commit="$2" shallow="$VM_WORK/shallow"
  say "sending ${commit:0:12}"
  git init -q "$shallow"
  git -C "$shallow" fetch -q --depth 1 --upload-pack="git -c uploadpack.allowAnySHA1InWant=true upload-pack" "file://$repo" "$commit"
  git -C "$shallow" -c advice.detachedHead=false checkout -q "$commit"
  tar -C "$shallow" -czf - . | "${VM_SSH[@]}" 'mkdir -p /root/fs && tar --no-same-owner -xzf - -C /root/fs'
  rm -rf "$shallow"
}

vm_toolchains() { # vm_toolchains <repo> [log file]
  local node_v
  node_v=$(node -e 'console.log(require(process.argv[1]).node.minimum)' "$1/release/security-floor.json")
  say "installing toolchains (Node $node_v, Rust from rust-toolchain.toml, $VM_GO)"
  "${VM_SSH[@]}" bash -s "$node_v" "$VM_GO" <<'SETUP' > "${2:-/dev/null}" 2>&1
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl xz-utils build-essential pkg-config libssl-dev python3 jq openssl xxd cryptsetup gnupg dirmngr
curl -fsSL "https://nodejs.org/dist/v$1/node-v$1-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
curl -fsSL "https://go.dev/dl/$2.linux-amd64.tar.gz" | tar -xz -C /usr/local
cd /root/fs/rust && /root/.cargo/bin/rustup show active-toolchain >/dev/null
SETUP
}

vm_run() { "${VM_SSH[@]}" "export PATH=/usr/local/go/bin:/root/.cargo/bin:\$PATH; cd /root/fs && $1"; }
