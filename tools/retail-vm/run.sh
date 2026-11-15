#!/usr/bin/env bash
# Retail image smoke test in a VM (docs/retail-box-setup.md §16.4). For a cloud machine, not a laptop:
# Linux x86-64 with /dev/kvm, qemu-system-x86 + qemu-utils, cloud-image-utils (cloud-localds), curl,
# xz, Node 24 + npm. Run from a checkout of the branch under test:
#
#   bash tools/retail-vm/run.sh [workdir]
#
# What it does: builds this tree (npm ci, tsc), boots Debian 13's generic cloud image (the standard
# kernel: the cloud kernel has no Bluetooth), hands the guest this tree on a raw tar disk, and the guest
# (guest.sh) runs the retail layer the image builder would, starts BlueZ's virtual controllers
# (btvirt over hci_vhci: two linked controllers, hci0 for the box, hci1 to scan from), then checks:
#   - the image carries no box key, and keyd makes one at its first start (and keeps it on restart);
#   - the claim service runs as flagship-claim with no capabilities, the daemon stays off, and the
#     claim helper refuses anything but the claim's own steps;
#   - the claim GATT service advertises: the adapter has an active advertising instance, and a scan
#     from hci1 finds the claim service UUID.
# The verdict is the guest's "RETAIL-VM: PASS" on the serial console; exit 0 on pass, 1 otherwise.
#
# Not covered here: the signed box release the real factory installs (the guest gets this tree
# instead), the LUKS factory key, a real radio and button (docs §16.2).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${1:-$(mktemp -d -t retail-vm-XXXXXX)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
IMAGE_URL="${DEBIAN_IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2}"
VM_TIMEOUT="${VM_TIMEOUT:-2400}"
NODE_VERSION="$(node -p 'require(process.argv[1]).node.minimum' "$REPO/release/security-floor.json")"

[ -e /dev/kvm ] || { echo "retail-vm: /dev/kvm is missing (needs a machine with KVM)"; exit 2; }
for c in qemu-system-x86_64 qemu-img cloud-localds curl xz node npm sha512sum sha256sum; do
    command -v "$c" >/dev/null || { echo "retail-vm: $c is missing"; exit 2; }
done
echo "retail-vm: work dir $WORK"

echo "retail-vm: building the tree"
(cd "$REPO" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null \
    && npx tsc -b packages/boot-chain packages/keyd packages/flagship-builder packages/server-daemon)

echo "retail-vm: fetching and checking the Debian image and Node $NODE_VERSION"
img="$(basename "$IMAGE_URL")"
curl -fsSL -o "$WORK/$img" "$IMAGE_URL"
curl -fsSL -o "$WORK/SHA512SUMS" "${IMAGE_URL%/*}/SHA512SUMS"
(cd "$WORK" && grep " $img\$" SHA512SUMS | sha512sum -c -)
node_tar="node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL -o "$WORK/$node_tar" "https://nodejs.org/dist/v$NODE_VERSION/$node_tar"
curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$WORK" && grep " $node_tar\$" SHASUMS256.txt | sha256sum -c -)

echo "retail-vm: packing the tree for the guest"
stage="$WORK/stage"
rm -rf "$stage" && mkdir -p "$stage"
cp "$WORK/$node_tar" "$stage/node.tar.xz"
tar -C "$REPO" --exclude=.git --exclude='./apps/mobile' --exclude='./apps/builder-*' -cf "$stage/flagship.tar" .
cp "$REPO/tools/retail-vm/guest.sh" "$stage/guest.sh"
tar -C "$stage" -cf "$WORK/payload.tar" node.tar.xz flagship.tar guest.sh

qemu-img create -f qcow2 -b "$WORK/$img" -F qcow2 "$WORK/disk.qcow2" 16G >/dev/null
cat > "$WORK/user-data" <<'USERDATA'
#cloud-config
runcmd:
  - [ bash, -c, "mkdir -p /run/payload && tar -C /run/payload -xf /dev/vdc && exec bash /run/payload/guest.sh" ]
USERDATA
cloud-localds "$WORK/seed.img" "$WORK/user-data"

echo "retail-vm: booting (serial log: $WORK/serial.log)"
rm -f "$WORK/serial.log"
timeout "$VM_TIMEOUT" qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 \
    -drive file="$WORK/disk.qcow2",if=virtio,format=qcow2 \
    -drive file="$WORK/seed.img",if=virtio,format=raw,readonly=on \
    -drive file="$WORK/payload.tar",if=virtio,format=raw,readonly=on \
    -nic user,model=virtio-net-pci \
    -serial file:"$WORK/serial.log" -display none -no-reboot || true

grep -a "RETAIL-VM:" "$WORK/serial.log" || true
if grep -aq "RETAIL-VM: PASS" "$WORK/serial.log"; then
    echo "retail-vm: PASS"
    exit 0
fi
echo "retail-vm: FAIL (see $WORK/serial.log)"
exit 1
