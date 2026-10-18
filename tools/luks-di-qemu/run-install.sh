#!/usr/bin/env bash
# usage: WORK=dir run-install.sh <tag> <iso>   (iso: absolute path; kernel+initrd in $WORK/k, see README)
# installs onto $WORK/<tag>.qcow2, serial -> $WORK/<tag>.serial.log
set -eu
WORK="${WORK:?set WORK to the directory holding k/vmlinuz and k/initrd.gz}"
cd "$WORK"
tag="$1"; iso="$2"
rm -f "$tag.qcow2" "$tag.vars.fd" "$tag.serial.log"
qemu-img create -f qcow2 "$tag.qcow2" 12G >/dev/null
dd if=/dev/zero of="$tag.vars.fd" bs=1m count=64 2>/dev/null
exec qemu-system-aarch64 -machine virt -accel hvf -cpu host -m 4096 -smp 4 \
  -drive if=pflash,format=raw,readonly=on,file=/opt/homebrew/share/qemu/edk2-aarch64-code.fd \
  -drive if=pflash,format=raw,file="$tag.vars.fd" \
  -drive file="$tag.qcow2",if=none,id=hd,format=qcow2 -device virtio-blk-pci,drive=hd \
  -drive file="$iso",if=none,id=cd,media=cdrom,readonly=on -device virtio-scsi-pci -device scsi-cd,drive=cd \
  -nic user,model=virtio-net-pci \
  -kernel k/vmlinuz -initrd k/initrd.gz \
  -append "auto=true priority=critical preseed/file=/cdrom/preseed.cfg ${DI_FRONTEND:-DEBIAN_FRONTEND=text} console=ttyAMA0,115200" \
  -serial file:"$tag.serial.log" -monitor unix:"$tag.mon,server,nowait" -display none -no-reboot
