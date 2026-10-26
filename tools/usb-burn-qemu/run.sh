#!/usr/bin/env bash
# usage: WORK=dir run.sh <stick.img>
# Boots the burned stick as a USB disk on a blank target disk, through the seed's own BIOS boot entry
# (the stick must be built with FLAGSHIP_SEED_CONSOLE=ttyS0 so the installer talks on the serial port),
# lets debian-installer run unattended, and requires: the FLAGSHIP partition found, the recipe's late
# command run (the bootstrap proves it ran in the target) and the installer powering the machine off.
set -eu
WORK="${WORK:?set WORK to a scratch directory}"
stick="$1"
cd "$WORK"
rm -f target.qcow2 serial.log
qemu-img create -f qcow2 target.qcow2 12G >/dev/null
accel=tcg; [ -w /dev/kvm ] && accel=kvm
timeout "${TIMEOUT_SECONDS:-3000}" qemu-system-x86_64 -machine q35 -accel "$accel" -m 3072 -smp 2 \
  -drive file=target.qcow2,if=none,id=hd,format=qcow2 -device virtio-blk-pci,drive=hd \
  -drive file="$stick",if=none,id=usb,format=raw,readonly=on -device qemu-xhci -device usb-storage,drive=usb,bootindex=0 \
  -nic user,model=virtio-net-pci -serial file:serial.log -display none -no-reboot || status=$?
status="${status:-0}"
echo "qemu exit status: $status"
fail=0
check() { grep -q -- "$1" serial.log && echo "ok   $2" || { echo "FAIL $2"; fail=1; }; }
check "\[stick\] BOOTSTRAP-RAN blob=[1-9][0-9]* luks-key=present" "the recipe on the FLAGSHIP partition was loaded and its late command ran in the target"
if grep -q "recipe partition .* not found" serial.log; then echo "FAIL the installer could not find the FLAGSHIP partition"; fail=1; fi
[ "$status" = 0 ] && echo "ok   the installer finished and powered off" || { echo "FAIL the installer did not finish (status $status)"; fail=1; }
tail -n 25 serial.log | cut -c1-200
exit $fail
