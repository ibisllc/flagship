#!/bin/sh
# End-to-end QEMU proof of the REAL install path (NOT the dry-run PoC).
#
# Stage 1 — INSTALL: boot the stock Alpine standard ISO with the e2e apkovl
#   applied (the overlay drops the real installer.sh + a signed recipe and runs
#   it at the default runlevel). The installer runs non-dry-run against a blank
#   virtio target disk: recipe-sig verify -> partition -> LUKS -> LVM ->
#   apk --root base lay-down + configure -> GRUB BIOS+UEFI -> success gate.
#   PASS iff the serial log shows FLAGSHIP_E2E_INSTALL_OK.
#
# Stage 2 — BOOT THE INSTALLED DISK: detach the ISO and boot the target disk
#   STANDALONE (BIOS via SeaBIOS). PASS iff the installed Alpine reaches a login
#   prompt — i.e. GRUB -> kernel -> initramfs unlocked LUKS (keyfile on /boot in
#   the harness) -> LVM root -> OpenRC -> getty. This proves the disk the
#   installer left behind is genuinely bootable, not just that commands exited 0.
#
# Apple-Silicon note: x86_64 under TCG (no HW accel) — correct but slow. The
# install stage apk-adds the tool set over QEMU user-net, so allow several
# minutes. This is the only step a human cannot replace except #7 (real bare
# metal). Pin matches scripts/build-flagship-iso.sh so the e2e and the shipped
# base agree.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSETS="$HERE/assets"
mkdir -p "$ASSETS"

ALPINE_VERSION="${ALPINE_VERSION:-3.21.0}"
ALPINE_ARCH="x86_64"
ALPINE_SHA256="${ALPINE_SHA256:-201e2ba601be5b861345a308591e3e547bf6d210945dfaab3e3251b8dea64b8b}"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ALPINE_ARCH}/alpine-standard-${ALPINE_VERSION}-${ALPINE_ARCH}.iso"

BASE_ISO="$ASSETS/alpine-standard-${ALPINE_VERSION}-${ALPINE_ARCH}.iso"
E2E_ISO="$ASSETS/flagship-e2e.iso"
APKOVL="$ASSETS/flagship-e2e.apkovl.tar.gz"
TARGET="$ASSETS/e2e-target.qcow2"
INSTALL_LOG="$ASSETS/e2e-install-serial.log"
BOOT_LOG="$ASSETS/e2e-boot-serial.log"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1"; exit 2; }; }
need qemu-system-x86_64
need xorriso
need qemu-img

# ── 1. fetch + verify the pinned base ISO (cached) ────────────────────────────
if [ ! -s "$BASE_ISO" ]; then
    echo "[e2e] fetching $ALPINE_URL"
    curl -fSL --retry 3 --retry-delay 5 -o "$BASE_ISO" "$ALPINE_URL"
fi
actual="$(shasum -a 256 "$BASE_ISO" 2>/dev/null | awk '{print $1}' || sha256sum "$BASE_ISO" | awk '{print $1}')"
if [ "$actual" != "$ALPINE_SHA256" ]; then
    echo "[e2e] ERROR: base ISO sha256 mismatch"
    echo "  expected: $ALPINE_SHA256"
    echo "  got:      $actual"
    exit 3
fi
echo "[e2e] base ISO sha256 verified"

# ── 2. build the e2e apkovl (real installer + signed recipe) ──────────────────
echo "[e2e] building e2e apkovl"
( cd "$HERE" && npx tsx scripts/build-e2e-apkovl.mjs "$APKOVL" )

# ── 3. remaster the base ISO: embed the apkovl + force a SERIAL console boot ───
# Alpine's init scans every block device root for *.apkovl.tar.gz on boot (same
# mechanism scripts/build-flagship-iso.sh ships). We also rewrite the BIOS
# syslinux config so the ISO autoboots to ttyS0 — without `console=ttyS0` the
# kernel (and our launcher's /dev/console) go to the invisible VGA console and
# nothing reaches -nographic's serial. `-boot_image any replay` preserves the
# El Torito boot records so the remastered ISO still boots.
echo "[e2e] remastering ISO (apkovl at root + serial-console autoboot)"
SYSCFG_SRC="$ASSETS/syslinux.orig.cfg"
SYSCFG_NEW="$ASSETS/syslinux.serial.cfg"
rm -f "$SYSCFG_SRC" "$SYSCFG_NEW"
xorriso -osirrox on -indev "$BASE_ISO" -extract /boot/syslinux/syslinux.cfg "$SYSCFG_SRC" >/dev/null 2>&1
# SERIAL directive (isolinux -> serial), PROMPT 0 (autoboot, no input), and
# console=ttyS0 appended to the kernel cmdline.
{
    echo "SERIAL 0 115200"
    sed -e 's/^PROMPT .*/PROMPT 0/' \
        -e 's/^TIMEOUT .*/TIMEOUT 10/' \
        -e '/^APPEND /{/console=ttyS0/!s/$/ console=ttyS0,115200/;}' \
        "$SYSCFG_SRC"
} > "$SYSCFG_NEW"
rm -f "$E2E_ISO"
xorriso -indev "$BASE_ISO" -outdev "$E2E_ISO" \
    -boot_image any replay \
    -map "$APKOVL" /flagship.apkovl.tar.gz \
    -map "$SYSCFG_NEW" /boot/syslinux/syslinux.cfg >/dev/null 2>&1

# ── 4. blank target disk ──────────────────────────────────────────────────────
rm -f "$TARGET"
qemu-img create -f qcow2 "$TARGET" 12G >/dev/null

# ── 5. STAGE 1: boot the live ISO, run the real installer ─────────────────────
echo "[e2e] STAGE 1: install (serial -> $INSTALL_LOG) — TCG, be patient"
timeout "${E2E_INSTALL_TIMEOUT:-2400}" qemu-system-x86_64 \
    -M q35 -m 3072 -accel tcg -smp 2 \
    -cdrom "$E2E_ISO" \
    -drive file="$TARGET",if=virtio,format=qcow2 \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
    -nographic -no-reboot 2>&1 | tee "$INSTALL_LOG" || true

if ! grep -q "FLAGSHIP_E2E_INSTALL_OK" "$INSTALL_LOG"; then
    echo "=================================================="
    echo "[e2e] STAGE 1 FAIL: installer did not report OK (see $INSTALL_LOG)."
    grep -E "FLAGSHIP_E2E_INSTALL_FAIL|FATAL|does NOT verify|failed" "$INSTALL_LOG" | tail -20 || true
    exit 1
fi
echo "[e2e] STAGE 1 PASS: real install completed + success gate passed."

# ── 6. STAGE 2: boot the installed disk standalone (no ISO) ───────────────────
echo "[e2e] STAGE 2: boot the installed disk standalone (serial -> $BOOT_LOG)"
timeout "${E2E_BOOT_TIMEOUT:-300}" qemu-system-x86_64 \
    -M q35 -m 2048 -accel tcg -smp 2 \
    -drive file="$TARGET",if=virtio,format=qcow2 \
    -nographic -no-reboot 2>&1 | tee "$BOOT_LOG" || true

echo "=================================================="
# A booted Alpine prints "<hostname> login:" on the serial console once getty is
# up — that is the proof the installed disk is independently bootable.
if grep -Eq "login:|flagship-e2e" "$BOOT_LOG"; then
    echo "[e2e] STAGE 2 PASS: installed disk booted to a login prompt."
    echo "[e2e] E2E PASS (install + standalone boot)."
    exit 0
fi
echo "[e2e] STAGE 2 FAIL: installed disk did not reach a login (see $BOOT_LOG)."
tail -30 "$BOOT_LOG" || true
exit 1
