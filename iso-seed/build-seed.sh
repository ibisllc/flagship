#!/usr/bin/env bash
# Derive the Flagship ISO SEED from a stock Debian netinst ISO.
#
# The seed differs from the stock base in exactly three ways, all applied with
# xorriso (no proprietary tooling, fully reproducible):
#   1. the default boot entry auto-preseeds from /cdrom/flagship/preseed.cfg
#      (BIOS + UEFI), with a short timeout so an unattended boot proceeds;
#   2. a GENERIC preseed.cfg is added at /flagship/preseed.cfg — it carries NO
#      per-recipe data; instead its early_command reads the recipe from a FAT
#      partition labeled "FLAGSHIP" that the burner (phone/desktop) appends to
#      the USB stick after streaming this seed verbatim;
#   3. nothing else — the El Torito / isohybrid boot equipment is replayed
#      byte-for-byte so the seed stays USB-bootable on BIOS and UEFI.
#
# Because per-recipe data lives on the appended partition, ONE seed serves every
# user — the phone never remasters an ISO. This script runs on a build host / CI
# (needs xorriso); it is NOT run on-device.
#
# Reproducibility: given the same stock base + this script + the same xorriso,
# the output is byte-identical (timestamps are pinned below). The resulting
# sha256 is what /api/iso-manifest pins and what the site/README document.
#
# Usage: build-seed.sh <stock-debian-netinst.iso> <out-seed.iso> [preseed.cfg]
set -euo pipefail

SRC="${1:?stock Debian netinst ISO}"
OUT="${2:?output seed ISO path}"
PRESEED="${3:-$(dirname "$0")/preseed.cfg}"
XORRISO="${XORRISO:-xorriso}"

# Pinned epoch so repacks are deterministic (2026-01-01T00:00:00Z). Any fixed
# value works; it only needs to be stable across builds for a reproducible sha.
EPOCH="2026010100000000"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo ">> extracting boot configs from $SRC"
"$XORRISO" -osirrox on -indev "$SRC" \
  -extract /boot/grub/grub.cfg "$work/grub.cfg" \
  -extract /isolinux/txt.cfg   "$work/txt.cfg" \
  -extract /isolinux/isolinux.cfg "$work/isolinux.cfg" 2>/dev/null
chmod +w "$work/grub.cfg" "$work/txt.cfg" "$work/isolinux.cfg"

# The auto-preseed kernel cmdline. `file=/cdrom/flagship/preseed.cfg` points d-i
# at the generic preseed baked below; the preseed's early_command then pulls the
# per-recipe data off the FLAGSHIP partition.
CMDLINE="auto=true priority=critical preseed/file=/cdrom/flagship/preseed.cfg"
# Test-only: FLAGSHIP_SEED_CONSOLE=ttyS0 routes d-i output to the serial port so
# a headless QEMU boot can be observed. NEVER set for a shipping seed (it changes
# the sha and exposes the installer console).
if [ -n "${FLAGSHIP_SEED_CONSOLE:-}" ]; then
  CMDLINE="$CMDLINE console=${FLAGSHIP_SEED_CONSOLE},115200"
fi

echo ">> patching UEFI grub.cfg (prepend a default Flagship auto entry)"
{
  echo "set default=0"
  echo "set timeout=3"
  echo "menuentry 'Flagship automated install' {"
  echo "    set background_color=black"
  echo "    linux    /install.amd/vmlinuz $CMDLINE vga=788 --- quiet"
  echo "    initrd   /install.amd/initrd.gz"
  echo "}"
  cat "$work/grub.cfg"
} > "$work/grub.cfg.new"
mv "$work/grub.cfg.new" "$work/grub.cfg"

echo ">> patching BIOS isolinux (default -> Flagship auto entry, short timeout)"
cat > "$work/txt.cfg" <<EOF
default flagship
label flagship
	menu label ^Flagship automated install
	kernel /install.amd/vmlinuz
	append $CMDLINE vga=788 initrd=/install.amd/initrd.gz --- quiet
EOF
# prompt 0 + a short timeout so BIOS auto-boots the default without a keypress.
sed -i 's/^timeout .*/timeout 30/; s/^default .*/default flagship/' "$work/isolinux.cfg"

# Pre-declare an EMPTY FLAGSHIP FAT16 partition (label FLAGSHIP), registered in
# BOTH the GPT and the MBR by xorriso -append_partition. This is the fix for the
# GPT-isohybrid problem: Linux ignores MBR-only entries on a GPT disk, so the
# partition the installer must find has to live in the GPT. Declaring it here,
# once, at build time means the burner does ZERO partition-table surgery — it
# streams the seed verbatim (including this empty partition) and overwrites the
# partition's CONTENTS with the per-recipe preseed FAT. 16 MiB leaves headroom
# over the ~33 KB preseed. mformat is deterministic, so the seed stays
# reproducible.
FLAGSHIP_MB="${FLAGSHIP_MB:-16}"
empty_fat="$work/flagship-empty.fat"
dd if=/dev/zero of="$empty_fat" bs=1M count="$FLAGSHIP_MB" status=none
# mtools stamps the volume-label dir entry with the wall clock; pin it so the
# empty FAT (and thus the seed) is reproducible. mtools honors SOURCE_DATE_EPOCH.
SOURCE_DATE_EPOCH=1767225600 mformat -i "$empty_fat" -v FLAGSHIP -N 464c4147 ::

echo ">> repacking seed -> $OUT (boot equipment replayed verbatim)"
rm -f "$OUT"
# -volume_date commands come AFTER the -map commands so the newly-added files
# also get the pinned epoch (all_file_dates rewrites every timestamp). Pinning
# creation/modification/effective/expiration + the volume uuid makes the repack
# byte-for-byte reproducible.
"$XORRISO" \
  -indev "$SRC" \
  -outdev "$OUT" \
  -boot_image any replay \
  -boot_image any gpt_disk_guid=f1a95417000000000000000000000001 \
  -map "$PRESEED" /flagship/preseed.cfg \
  -map "$work/grub.cfg" /boot/grub/grub.cfg \
  -map "$work/txt.cfg" /isolinux/txt.cfg \
  -map "$work/isolinux.cfg" /isolinux/isolinux.cfg \
  -append_partition 3 0x0e "$empty_fat" \
  -volume_date all_file_dates "=$EPOCH" \
  -volume_date "c" "$EPOCH" \
  -volume_date "m" "$EPOCH" \
  -volume_date "f" "$EPOCH" \
  -volume_date "x" "$EPOCH" \
  -volume_date uuid "$EPOCH" 2>&1 | grep -vE '^xorriso : UPDATE' || true

echo ">> seed sha256:"
sha256sum "$OUT"
