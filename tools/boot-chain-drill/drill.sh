#!/bin/bash
# The boot chain refresh on a real Debian 13 VM: an installed chain, a refresh staged as a one-time
# GRUB trial, the reboot into it, its promotion to the default, and a broken chain that panics in
# its trial and falls back to the default by itself.
#
#   bash tools/boot-chain-drill/drill.sh                     UpCloud amd64, BIOS (deleted on exit;
#                                                            needs ~/.config/flagship/upcloud-token)
#   DRILL_BACKEND=qemu DRILL_IMAGE=<debian-13-genericcloud-arm64.qcow2> bash tools/boot-chain-drill/drill.sh
#                                                            local QEMU arm64, UEFI (hvf on a Mac)
#
# The real unlock hook and premount run in the VM's initramfs; the VM has no encrypted root, so the
# premount ends at its LUKS check. Which premount ran shows in its log, written to the filesystem
# labelled FLAGSHIP_BOOT (the drill relabels the VM's root filesystem to give it one).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DRILL_BACKEND="${DRILL_BACKEND:-upcloud}"
NODE_V=$(node -e 'console.log(require(process.argv[1]).node.minimum)' "$REPO/release/security-floor.json")
fail() { echo "DRILL FAILED: $*"; exit 1; }

if [ "$DRILL_BACKEND" = upcloud ]; then
  VM_PLAN="${VM_PLAN:-2xCPU-4GB}"
  # shellcheck source=../../scripts/lib/upcloud-vm.sh
  . "$REPO/scripts/lib/upcloud-vm.sh"
  NODE_ARCH=x64
  backend_up() { vm_up "flagship-bootchain-drill" bootchain-drill; }
  on() { "${VM_SSH[@]}" "$@"; }
  hard_restart() { vm_api -X POST -d '{"restart_server":{"stop_type":"hard","timeout":"60"}}' "$VM_API/server/$UUID/restart" >/dev/null; }
else
  [ -f "${DRILL_IMAGE:-}" ] || fail "set DRILL_IMAGE to a Debian 13 genericcloud arm64 qcow2"
  VM_WORK="$(mktemp -d)"
  NODE_ARCH=arm64
  QEMU_SHARE="${QEMU_SHARE:-/opt/homebrew/share/qemu}"
  PORT="${DRILL_SSH_PORT:-2229}"
  say() { echo "▸ $*"; }
  qemu_down() {
    local rc=$?
    [ -f "$VM_WORK/qemu.pid" ] && kill "$(cat "$VM_WORK/qemu.pid")" 2>/dev/null || true
    say "stopped the VM; serial console kept at $VM_WORK/console.log"
    exit $rc
  }
  backend_up() {
    trap qemu_down EXIT
    ssh-keygen -q -t ed25519 -N "" -f "$VM_WORK/key"
    qemu-img create -q -f qcow2 -b "$(cd "$(dirname "$DRILL_IMAGE")" && pwd)/$(basename "$DRILL_IMAGE")" -F qcow2 "$VM_WORK/disk.qcow2" 12G
    cp "$QEMU_SHARE/edk2-arm-vars.fd" "$VM_WORK/vars.fd"
    mkdir -p "$VM_WORK/seed"
    printf 'instance-id: bootchain-drill\nlocal-hostname: bootchain-drill\n' > "$VM_WORK/seed/meta-data"
    printf '#cloud-config\ndisable_root: false\nssh_pwauth: false\nusers:\n  - name: root\n    ssh_authorized_keys:\n      - %s\n' "$(cat "$VM_WORK/key.pub")" > "$VM_WORK/seed/user-data"
    hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "$VM_WORK/seed.iso" "$VM_WORK/seed"
    qemu-system-aarch64 -M virt -accel hvf -cpu host -smp 2 -m 2048 \
      -drive if=pflash,format=raw,readonly=on,file="$QEMU_SHARE/edk2-aarch64-code.fd" \
      -drive if=pflash,format=raw,file="$VM_WORK/vars.fd" \
      -drive file="$VM_WORK/disk.qcow2",if=virtio,format=qcow2 \
      -drive file="$VM_WORK/seed.iso",if=virtio,format=raw,readonly=on \
      -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:"$PORT"-:22 \
      -display none -serial file:"$VM_WORK/console.log" -monitor unix:"$VM_WORK/monitor.sock",server,nowait \
      -daemonize -pidfile "$VM_WORK/qemu.pid"
    VM_SSH=(ssh -q -i "$VM_WORK/key" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=30 root@127.0.0.1)
    for _ in $(seq 1 90); do on true 2>/dev/null && break; sleep 5; done
    on true || fail "the VM did not come up"
    say "VM up (QEMU, serial console in $VM_WORK/console.log)"
  }
  on() { "${VM_SSH[@]}" "$@"; }
  hard_restart() { echo system_reset | nc -U "$VM_WORK/monitor.sock" >/dev/null; }
fi

(cd "$REPO" && npx esbuild tools/boot-chain-drill/harness.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning --outfile="$VM_WORK/harness.mjs")

backend_up
h() { on "node /root/harness.mjs $*"; }
expect_in() { # expect_in <what> <text> <haystack>
  case "$3" in *"$2"*) echo "  ok: $1" ;; *) echo "$3"; fail "$1: expected '$2'" ;; esac
}
wait_up() {
  local waited=0
  sleep 15
  until on true 2>/dev/null; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge "${1:-480}" ]; then return 1; fi
  done
}
reboot_vm() {
  local before; before=$(on 'cat /proc/sys/kernel/random/boot_id')
  on 'systemctl reboot' 2>/dev/null || true
  if ! wait_up "${1:-480}"; then
    say "no ssh after the reboot: restarting the VM from outside (a hung boot)"
    hard_restart
    wait_up 480 || fail "the VM did not come back after a hard restart"
    HARD_RESTART=1
  fi
  [ "$(on 'cat /proc/sys/kernel/random/boot_id')" != "$before" ] || fail "the VM did not reboot"
}
HARD_RESTART=0

say "preparing the VM"
on 'cat > /root/harness.mjs' < "$VM_WORK/harness.mjs"
on bash -s "$NODE_V" "$NODE_ARCH" <<'SETUP'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q cryptsetup-bin lvm2 openssl curl xxd ca-certificates initramfs-tools zstd xz-utils busybox >/dev/null
curl -fsSL "https://nodejs.org/dist/v$1/node-v$1-linux-$2.tar.xz" | tar -xJ -C /usr/local --strip-components=1
echo "firmware: $([ -d /sys/firmware/efi ] && echo UEFI || echo BIOS); kernel $(uname -r); $(grub-install --version 2>/dev/null || true)"
echo "cmdline: $(cat /proc/cmdline)"
root=$(findmnt -n -o SOURCE /); fstype=$(findmnt -n -o FSTYPE /)
echo "root: $root ($fstype), label '$(blkid -s LABEL -o value "$root" || true)'"
grep -q 'LABEL=' /etc/fstab /proc/cmdline && { echo "the root is named by its label: relabelling would break the boot"; exit 1; }
[ "$fstype" = ext4 ] || { echo "the root is not ext4"; exit 1; }
e2label "$root" FLAGSHIP_BOOT
# The premount mounts FLAGSHIP_BOOT before the root is mounted; load ext4 early so that mount works
# where ext4 is a module (Debian amd64).
grep -qx ext4 /etc/initramfs-tools/modules || echo ext4 >> /etc/initramfs-tools/modules
grep -c 'custom.cfg' /boot/grub/grub.cfg >/dev/null && echo "grub.cfg sources custom.cfg"
grep -q 'next_entry' /boot/grub/grub.cfg && echo "grub.cfg honours next_entry"
true
SETUP

say "1. install release v1's boot chain and boot it"
h install
reboot_vm
on 'blkid "$(findmnt -n -o SOURCE /)"; ls /dev/disk/by-label; lsinitramfs /boot/initrd.img-$(uname -r) | grep -E "bin/(mount|busybox|umount)$" || true'
log=$(on 'cat /flagship-unlock.log')
expect_in "the v1 premount ran (it refuses the drill's boot host)" "is not https on an approved host" "$log"

say "2. release v2 approves the drill's boot host: stage it"
h release v2
out=$(h refresh v2)
echo "  $out"
expect_in "staged" '"action":"staged"' "$out"
on 'cat /boot/grub/custom.cfg; grub-editenv /boot/grub/grubenv list; ls -l /boot/flagship-initrd-trial.img'
expect_in "the default chain is still v1" "boot.gym.flagshipserver.com\"" "$(on 'grep ^APPROVED_BOOT_HOSTS= /etc/initramfs-tools/scripts/local-top/flagship-unlock')"

say "3. reboot into the trial, then promote it"
reboot_vm
cmdline=$(on 'cat /proc/cmdline')
expect_in "the trial entry booted" "flagship.bootchain=" "$cmdline"
expect_in "the trial booted with panic=30" "panic=30" "$cmdline"
expect_in "the v2 premount ran in the trial" "no crypto_LUKS partition" "$(on 'cat /flagship-unlock.log')"
out=$(h refresh v2)
echo "  $out"
expect_in "promoted" '"action":"refreshed"' "$out"
expect_in "the default chain is v2" "boot.drill.flagship.example" "$(on 'grep ^APPROVED_BOOT_HOSTS= /etc/initramfs-tools/scripts/local-top/flagship-unlock')"
on 'lsinitramfs -l /boot/initrd.img-$(uname -r) | grep -E "flagship-unlock|flagship-unseal" ; ls /boot/flagship-initrd-trial.img /boot/grub/custom.cfg 2>&1 || true'

say "4. an ordinary reboot runs v2 from the default entry"
reboot_vm
cmdline=$(on 'cat /proc/cmdline')
case "$cmdline" in *flagship.bootchain=*) fail "the trial entry booted again" ;; esac
expect_in "the v2 premount ran from the default initrd" "no crypto_LUKS partition" "$(on 'cat /flagship-unlock.log')"
out=$(h refresh v2)
echo "  $out"
expect_in "nothing to do" '"reason":"current"' "$out"

say "5. release v3 cannot boot: stage it, reboot, and watch it fall back"
out=$(h refresh v3)
echo "  $out"
expect_in "staged" '"action":"staged"' "$out"
reboot_vm 600
expect_in "the trial booted and panicked" "trial boot panicked" "$(on 'cat /flagship-drill-panic.log 2>/dev/null || true')"
cmdline=$(on 'cat /proc/cmdline')
case "$cmdline" in *flagship.bootchain=*) fail "still on the trial entry" ;; esac
expect_in "the default (v2) premount ran after the fallback" "no crypto_LUKS partition" "$(on 'cat /flagship-unlock.log')"
out=$(h refresh v3)
echo "  $out"
expect_in "rolled back" '"reason":"trial-boot-failed"' "$out"
out=$(h refresh v3)
expect_in "not tried again" '"reason":"failed-before"' "$out"
expect_in "the default chain is still v2" "boot.drill.flagship.example" "$(on 'grep ^APPROVED_BOOT_HOSTS= /etc/initramfs-tools/scripts/local-top/flagship-unlock')"
[ -z "$(on 'lsinitramfs /boot/initrd.img-$(uname -r) | grep flagship-drill-panic || true')" ] || fail "the broken piece reached the default initrd"
on 'ls /boot/flagship-initrd-trial.img /boot/grub/custom.cfg 2>&1 || true; grub-editenv /boot/grub/grubenv list'

say "DRILL PASSED (hard restart needed: $HARD_RESTART)"
