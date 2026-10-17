#!/usr/bin/env bash
# Derive the Flagship ISO SEED from a stock Debian netinst ISO.
#
# The seed differs from the stock base in exactly three ways, all applied with
# xorriso (no proprietary tooling, fully reproducible):
#   1. the default boot entry auto-preseeds from /cdrom/flagship/preseed.cfg
#      (BIOS + UEFI), with a short timeout so an unattended boot proceeds;
#   2. a GENERIC preseed.cfg is added at /flagship/preseed.cfg — it carries NO
#      per-recipe data; instead its early_command reads the recipe from a FAT
#      partition labeled "FLAGSHIP" that the builder (phone/desktop) appends to
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
sed 's/^timeout .*/timeout 30/; s/^default .*/default flagship/' "$work/isolinux.cfg" > "$work/isolinux.cfg.new"
mv "$work/isolinux.cfg.new" "$work/isolinux.cfg"

# Pre-declare an EMPTY FLAGSHIP FAT16 partition (label FLAGSHIP), registered in
# BOTH the GPT and the MBR by xorriso -append_partition. This is the fix for the
# GPT-isohybrid problem: Linux ignores MBR-only entries on a GPT disk, so the
# partition the installer must find has to live in the GPT. Declaring it here,
# once, at build time means the builder does ZERO partition-table surgery — it
# streams the seed verbatim (including this empty partition) and overwrites the
# partition's CONTENTS with the per-recipe preseed FAT. 16 MiB leaves headroom
# over the ~33 KB preseed.
#
# The empty FAT is a committed image, not formatted here: mformat's boot sector
# differs between mtools releases (version in the OEM name, and more), which
# made every toolchain produce a different seed. gzip decompression is
# byte-exact everywhere, and the hash check makes a swapped image fail loudly.
EMPTY_FAT_GZ="$(dirname "$0")/flagship-empty-fat16.img.gz"
EMPTY_FAT_SHA256="28614a99ff64bb58a5dadaf431a4be3d450b5d7dc8896454885ccbd99e85e480"
empty_fat="$work/flagship-empty.fat"
gzip -dc "$EMPTY_FAT_GZ" > "$empty_fat"
if [ "$(sha256sum "$empty_fat" | cut -d' ' -f1)" != "$EMPTY_FAT_SHA256" ]; then
  echo "error: $EMPTY_FAT_GZ does not decompress to the pinned empty FAT" >&2
  exit 1
fi

# xorriso stamps its own version into the volume's Preparer Id. Keep the stock
# base's value instead, so the seed doesn't depend on which xorriso built it.
PREPARER="$("$XORRISO" -indev "$SRC" -pvd_info 2>/dev/null | sed -n 's/^Preparer Id  : //p')"

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
  -preparer_id "$PREPARER" \
  -volume_date all_file_dates "=$EPOCH" \
  -volume_date "c" "$EPOCH" \
  -volume_date "m" "$EPOCH" \
  -volume_date "f" "$EPOCH" \
  -volume_date "x" "$EPOCH" \
  -volume_date uuid "$EPOCH" 2>&1 | grep -vE '^xorriso : UPDATE' || true

echo ">> seed sha256:"
sha256sum "$OUT"
