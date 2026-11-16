#!/usr/bin/env bash
# Runs inside the retail smoke VM (tools/retail-vm/run.sh), as root, from cloud-init. Every verdict
# line starts with "RETAIL-VM:" on the serial console; the last one is PASS or FAIL.
set -euo pipefail
P=/run/payload
SVC_UUID=6f3c1a00-5e1b-4f0a-9c55-f1a95e5b0c01
say() { echo "RETAIL-VM: $*" | tee -a /dev/ttyS0; }
fail() { say "FAIL $*"; journalctl -u flagship-keyd -u flagship-daemon -u flagship-claim -u flagship-claim-helper -u bluetooth --no-pager -n 120 > /dev/ttyS0 2>&1 || true; systemctl poweroff; exit 1; }
trap 'fail "guest.sh line $LINENO"' ERR
wait_for() { local n="$1"; shift; for _ in $(seq 1 "$n"); do if "$@"; then return 0; fi; sleep 1; done; return 1; }

say "guest up: $(uname -r)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends bluez bluez-test-tools rsync jq xz-utils >/dev/null
command -v btvirt >/dev/null || fail "btvirt is missing (bluez-test-tools)"

tar -xJf "$P/node.tar.xz" -C /usr/local --strip-components=1
mkdir -p /opt/flagship
tar -C /opt/flagship -xf "$P/flagship.tar"
say "node $(/usr/local/bin/node --version), tree unpacked"

# Stand-in for the appliance prepare step, whose marker the layer checks (the real factory installs
# the signed release at /opt/flagship and writes it).
mkdir -p /etc/flagship
touch /etc/flagship/appliance-ready
/usr/local/bin/node --input-type=module -e '
import { buildRetailImageLayerScript } from "/opt/flagship/packages/flagship-builder/dist/index.js";
process.stdout.write(buildRetailImageLayerScript());
' > /root/retail-layer.sh
bash /root/retail-layer.sh > /dev/ttyS0 2>&1 || fail "the retail layer failed"
say "retail layer applied"

[ -z "$(ls -A /var/lib/flagship-keyd 2>/dev/null)" ] || fail "keyd state is on the image"
[ -f /etc/flagship/retail-image.json ] || fail "no retail marker"
say "image carries no box key"

# Two linked virtual controllers: hci0 (the box) and hci1 (a phone stand-in that scans).
modprobe hci_vhci
systemd-run --unit=flagship-btvirt /usr/bin/btvirt -l2 >/dev/null
wait_for 20 test -e /sys/class/bluetooth/hci1 || fail "btvirt made no controllers"
systemctl daemon-reload
systemctl reload dbus.service
udevadm control --reload
systemctl restart bluetooth.service
say "virtual controllers up: $(ls /sys/class/bluetooth | tr '\n' ' ')"

systemctl start flagship-keyd.service
wait_for 60 test -S /run/flagship-keyd/keyd.sock || fail "keyd did not start"
stat -c '%U %a' /var/lib/flagship-keyd/identity.key | grep -q '^flagship-keyd 400$' || fail "identity.key owner or mode"
key1="$(sha256sum /var/lib/flagship-keyd/identity.key | cut -c1-16)"
systemctl restart flagship-keyd.service
wait_for 60 test -S /run/flagship-keyd/keyd.sock || fail "keyd did not restart"
[ "$(sha256sum /var/lib/flagship-keyd/identity.key | cut -c1-16)" = "$key1" ] || fail "keyd made a second key on restart"
say "keyd made its own identity at first start and kept it"

[ ! -e /etc/flagship/daemon.env ] || fail "daemon.env on an unclaimed image"
systemctl start flagship-claim-helper.service flagship-claim.service
wait_for 120 sh -c 'journalctl -u flagship-claim --no-pager | grep -q "this box has no owner yet: claim service as uid"' || fail "the claim service did not start"
pid="$(systemctl show -p MainPID --value flagship-claim.service)"
[ "$pid" -gt 0 ] || fail "the claim service has no process"
claim_uid="$(awk '/^Uid:/ {print $2}' "/proc/$pid/status")"
[ "$claim_uid" = "$(id -u flagship-claim)" ] && [ "$claim_uid" != 0 ] || fail "the claim service runs as uid $claim_uid, not flagship-claim"
grep -q '^CapEff:[[:space:]]*0000000000000000$' "/proc/$pid/status" || fail "the claim service holds capabilities"
say "claim service runs as flagship-claim (uid $claim_uid), no capabilities"
systemctl start flagship-daemon.service || true
[ "$(systemctl show -p ActiveState --value flagship-daemon.service)" != active ] || fail "the daemon runs on a box with no owner"
say "daemon stays off until a claim's first boot"
# The helper answers only the claim's own steps: power, as the claim account, is refused.
refusal="$(runuser -u flagship-claim -- /usr/local/bin/node --input-type=module -e '
import { PrivdClient } from "/opt/flagship/packages/privd/dist/index.js";
const c = new PrivdClient("/run/flagship-claim-helper/helper.sock");
try { await c.power("reboot"); console.log("ALLOWED"); } catch (e) { console.log(e.code ?? e.message); } finally { c.close(); }
' 2>&1 | tail -n1)"
[ "$refusal" = forbidden ] || fail "the claim helper answered power with: $refusal"
say "claim helper refuses anything but the claim steps"

hci0="$(cat /sys/class/bluetooth/hci0/address 2>/dev/null || true)"
advertising() {
    bluetoothctl show "$hci0" 2>/dev/null | grep -Eq 'ActiveInstances: 0x0*[1-9]' \
        || btmgmt --index 0 advinfo 2>/dev/null | grep -Eiq 'instances list with [1-9]'
}
wait_for 120 advertising || fail "no active advertising instance on hci0"
say "hci0 ${hci0:-?} advertises"

hci1="$(cat /sys/class/bluetooth/hci1/address 2>/dev/null || bluetoothctl list | awk 'NR==2 {print $2}')"
# One bluetoothctl session per question, each pointed at hci1 first.
btc() { { echo "select $hci1"; for c in "$@"; do echo "$c"; sleep 1; done; } | bluetoothctl 2>/dev/null || true; }
found=0
for _ in 1 2 3; do
    { echo "select $hci1"; echo "scan le"; sleep 20; echo "scan off"; } | bluetoothctl >/dev/null 2>&1 || true
    for dev in $(btc devices | awk '/^Device / {print $2}' | sort -u); do
        if btc "info $dev" | grep -qi "$SVC_UUID"; then found=1; say "hci1 sees the claim service on $dev"; fi
    done
    [ "$found" = 1 ] && break
done
[ "$found" = 1 ] || fail "a scan from hci1 did not find the claim service $SVC_UUID"

say "PASS"
systemctl poweroff
