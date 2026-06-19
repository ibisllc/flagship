#!/bin/bash
# One-off: provision a gym cpx31 box, find its raw Hetzner IP, SSH in, and dump
# the cloud-init + daemon logs to root-cause why full-platform boxes never
# register. Does NOT tear the box down (so the state survives inspection).
set -uo pipefail
cd /Users/harrywinner/flagship
set -a; . ./.gym-secrets.env; set +a
export FLAGSHIP_ADMIN_SECRET="$GYM_ADMIN_SECRET"
export FLAGSHIP_BASE_URL="https://gym.flagshipserver.com"
KEY=~/.ssh/gym_flagship_ed25519
SSHO="-i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8"
U="dbg$(date +%s | tail -c 7)"

echo "[debug] provisioning $U (cpx31, NO teardown)"
node scripts/sample-user.mjs create "$U" --size cpx31 2>&1 | tail -6 || echo "[debug] create CLI returned (poll timeout is expected)"

echo "[debug] resolving box IP via Hetzner API..."
IP=""
for i in $(seq 1 24); do
  IP=$(curl -s -H "Authorization: Bearer $GYM_HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const s=(j.servers||[]).sort((a,b)=>new Date(b.created)-new Date(a.created))[0];process.stdout.write((s&&s.public_net&&s.public_net.ipv4&&s.public_net.ipv4.ip)||"")}catch(e){}})')
  [ -n "$IP" ] && break
  sleep 10
done
echo "[debug] box IP = ${IP:-NONE}"
[ -z "$IP" ] && { echo "[debug] no IP; abort (check the box on Hetzner)"; exit 1; }

echo "[debug] waiting for SSH on $IP (flagship user)..."
UP=""
for i in $(seq 1 48); do
  if ssh $SSHO flagship@"$IP" 'echo ok' 2>/dev/null | grep -q ok; then UP=1; break; fi
  sleep 10
done
if [ -z "$UP" ]; then
  echo "[debug] SSH never came up in ~8 min — the box may not be booting, or the key/user is wrong."
  echo "[debug] box $U ($IP) STILL RUNNING — teardown: node scripts/sample-user.mjs delete $U"
  exit 2
fi

echo "=========================== DIAGNOSTICS $U @ $IP ==========================="
ssh $SSHO flagship@"$IP" 'bash -s' <<'REMOTE'
echo "--- uptime ---"; uptime
echo "--- cloud-init status ---"; sudo cloud-init status --long 2>&1 | head -8
echo "--- cloud-init-output.log (tail 70) ---"; sudo tail -70 /var/log/cloud-init-output.log 2>&1
echo "--- node / docker / jq ---"; node --version 2>&1; docker --version 2>&1; jq --version 2>&1
echo "--- /etc/flagship + /var/flagship ---"; sudo ls -la /etc/flagship /var/flagship 2>&1
echo "--- flagship-daemon status ---"; sudo systemctl status flagship-daemon --no-pager 2>&1 | head -18
echo "--- flagship-daemon journal (tail 90) ---"; sudo journalctl -u flagship-daemon --no-pager 2>&1 | tail -90
echo "--- first-boot-register journal (tail 40) ---"; sudo journalctl -u flagship-first-boot-register --no-pager 2>&1 | tail -40
echo "--- data-services journal (tail 20) ---"; sudo journalctl -u flagship-data-services --no-pager 2>&1 | tail -20
echo "--- box -> gym control plane reachable? ---"; curl -s -o /dev/null -w "gym health from box: %{http_code}\n" https://gym.flagshipserver.com/api/health 2>&1
echo "--- registrationUrl in env/blob ---"; sudo grep -rh "FLAGSHIP_CONTROL_PLANE_BASE_URL\|registrationUrl\|FLAGSHIP_SUBDOMAIN" /etc/flagship /etc/systemd/system/flagship-daemon.service 2>/dev/null | head
REMOTE
echo "=========================== END DIAGNOSTICS ==========================="
echo "[debug] box $U ($IP) is STILL RUNNING (billing). Teardown: node scripts/sample-user.mjs delete $U"
