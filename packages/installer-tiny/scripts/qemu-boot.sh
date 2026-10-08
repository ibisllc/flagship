#!/bin/sh
# Boot the PoC initramfs in QEMU (TCG on Apple Silicon — slow but works) and
# assert it reaches the installer + walks every phase. Exits 0 iff the PoC
# sentinel "FLAGSHIP_POC_OK" appears on the serial console.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSETS="$HERE/assets"
KERNEL="$ASSETS/vmlinuz-lts"
INITRD="${1:-$ASSETS/initramfs-poc}"
LOGF="$ASSETS/qemu-serial.log"

[ -s "$KERNEL" ] || { echo "missing kernel; run fetch-base.sh"; exit 1; }
[ -s "$INITRD" ] || { echo "missing initrd; run build-poc-initramfs.sh"; exit 1; }

echo "booting QEMU (q35, 1G, TCG)... serial -> $LOGF"
timeout 180 qemu-system-x86_64 \
    -M q35 -m 1024 -accel tcg -smp 2 \
    -kernel "$KERNEL" -initrd "$INITRD" \
    -append "console=ttyS0 rdinit=/init quiet" \
    -nographic -no-reboot 2>&1 | tee "$LOGF" || true

echo "=================================================="
if grep -q "FLAGSHIP_POC_OK" "$LOGF"; then
    echo "PoC PASS: installer booted, reached shell, walked all phases."
    exit 0
else
    echo "PoC FAIL: sentinel not found in serial log ($LOGF)."
    exit 1
fi
