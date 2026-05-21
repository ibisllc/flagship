#!/usr/bin/env bash
# Reproducibly build the Flagship NETBOOT base ISO (Debian 12 netinst).
#
# WHY THIS EXISTS (W12, 2026-05-21):
# Alpine 3.21 standard ISO, booted in apkovl-mode on a Hetzner cx23 cloud
# VM, doesn't mount its modloop-lts kernel-modules squashfs. /lib/modules
# stays empty; `af_packet` can't load; udhcpc can't open AF_PACKET raw
# sockets; DHCP never sends Discover; the bootstrap has no network to
# apk-add nodejs+git+curl+jq from, and exits silently. Live-confirmed
# 2026-05-21 by reading the bootstrap log we persisted to /dev/sda
# offset 1 GiB from a rescue boot.
#
# Debian d-i (Debian installer) is the canonical preseed-driven Linux
# installer. Its installer kernel has every common driver built IN (not
# modular) — virtio_net + realtek + intel + af_packet all live in the
# vmlinuz, not in a separately-mounted squashfs. DHCP works on every
# common cloud VM out of the box. d-i has 20+ years of operator trust,
# is reproducibly built upstream, and is exactly the right shape for
# "boot → fetch base from CDN → install → reboot → first boot under
# our control."
#
# The trailer-at-disk-end mechanism (packages/iso-personalizer/) stays
# UNCHANGED — d-i ignores bytes past its filesystem; the trailer at
# `disk_size - trailer_size` is reachable from the chrooted /target
# during preseed's late_command, and from our /flagship/install.sh
# script that runs in there.
#
# Inputs (env):
#   SOURCE_DATE_EPOCH  — required, for deterministic build (mtimes,
#                        volid date, etc.). Defaults to 1700000000.
#   DEBIAN_VERSION     — default '12.7.0' (latest Bookworm netinst).
#   DEBIAN_ARCH        — default 'amd64'.
#
# Output:
#   $1 — path to write the assembled ISO to.
#   $1.sha256 — adjacent file with `sha256  basename` line.
#
# Reproducibility checklist (must stay in sync with the GHA workflow):
#   - SOURCE_DATE_EPOCH set, every tool that respects it does so.
#   - xorriso called with deterministic options (no embedded build
#     timestamp, sorted directory entries, fixed iso volume id).
#   - Debian netinst ISO sha256 verified before use.
#   - All injected scripts (preseed.cfg, install.sh, parse-trailer.sh,
#     late-command.sh) come from a checked-in directory; no Date.now()
#     or random in the build pipeline.

set -euo pipefail

# ── Pinned inputs ──────────────────────────────────────────────────
DEBIAN_VERSION="${DEBIAN_VERSION:-12.7.0}"
DEBIAN_ARCH="${DEBIAN_ARCH:-amd64}"

# Official Debian mirror. The release tree under /cdimage/release/<v>/
# moves into /cdimage/archive/<v>/ a few months after each point
# release; if a future build complains "404 not found", try
#   DEBIAN_BASE_URL=https://cdimage.debian.org/cdimage/archive/12.7.0/amd64/iso-cd
# Mirror is pinned to .org over HTTPS; SHA-256 is canonical (below).
DEBIAN_BASE_URL="${DEBIAN_BASE_URL:-https://cdimage.debian.org/cdimage/release/${DEBIAN_VERSION}/${DEBIAN_ARCH}/iso-cd}"
DEBIAN_ISO_NAME="debian-${DEBIAN_VERSION}-${DEBIAN_ARCH}-netinst.iso"
DEBIAN_URL="${DEBIAN_BASE_URL}/${DEBIAN_ISO_NAME}"

# To bump: download the new ISO, sha256sum it, paste here. Mismatched
# checksum aborts the build before any further work. Debian publishes
# SHA256SUMS alongside the ISO; verify upstream.
declare -A DEBIAN_SHA256
DEBIAN_SHA256["12.7.0-amd64"]="e7e09b4bf03075cf3a6dc4e63ff03c2c0cd9b836447632d2c5cc1b5d68a87b88"

OUT_PATH="${1:?usage: build-flagship-netboot-iso.sh <out.iso>}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"
export SOURCE_DATE_EPOCH

# Verify required tools exist before doing any network fetch — fail fast
# on a fresh box that's missing xorriso (the only non-coreutils dep).
for t in curl sha256sum xorriso; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "error: required tool '$t' not on PATH" >&2
    exit 2
  fi
done

WORK_DIR="$(mktemp -d -t flagship-netboot-iso.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

EXPECTED_SHA="${DEBIAN_SHA256["${DEBIAN_VERSION}-${DEBIAN_ARCH}"]:-}"
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "error: no pinned sha256 for Debian ${DEBIAN_VERSION}-${DEBIAN_ARCH}; update DEBIAN_SHA256 in $0" >&2
  exit 2
fi

# Locate the source files we'll inject into the ISO. The script lives in
# scripts/; the inject sources live in packages/installer-netboot/.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INJECT_DIR="$REPO_ROOT/packages/installer-netboot"
for f in preseed.cfg install.sh parse-trailer.sh late-command.sh; do
  if [[ ! -f "$INJECT_DIR/$f" ]]; then
    echo "error: missing inject source $INJECT_DIR/$f" >&2
    exit 2
  fi
done

echo "[netboot-iso] Debian $DEBIAN_VERSION ($DEBIAN_ARCH-netinst)"
echo "[netboot-iso] SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
echo "[netboot-iso] work dir: $WORK_DIR"
echo "[netboot-iso] inject dir: $INJECT_DIR"

# ── 1. Fetch + verify the Debian netinst ISO ─────────────────────
DEBIAN_ISO="$WORK_DIR/debian-base.iso"
echo "[netboot-iso] fetching $DEBIAN_URL"
curl -fSL --retry 3 --retry-delay 5 -o "$DEBIAN_ISO" "$DEBIAN_URL"

actual_sha=$(sha256sum "$DEBIAN_ISO" | awk '{print $1}')
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "error: Debian ISO sha256 mismatch" >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  got:      $actual_sha" >&2
  echo "If Debian genuinely re-released, update DEBIAN_SHA256 in $0." >&2
  exit 3
fi
echo "[netboot-iso] sha256 verified: $actual_sha"

# Early-exit hook for `--fetch-only`: callers (CI smoke, dev iteration)
# can verify the upstream fetch + sha pin without paying for repack.
if [[ "${2:-}" == "--fetch-only" ]]; then
  echo "[netboot-iso] fetch-only requested; skipping repack"
  echo "[netboot-iso] (debian netinst saved at $DEBIAN_ISO)"
  exit 0
fi

# ── 2. Extract the Debian netinst ISO into a working tree ──────
EXTRACTED="$WORK_DIR/extracted"
mkdir -p "$EXTRACTED"
echo "[netboot-iso] extracting Debian ISO"
xorriso -osirrox on -indev "$DEBIAN_ISO" -extract / "$EXTRACTED" >/dev/null

# xorriso preserves the read-only mode on extracted files; subsequent
# steps need to write to the boot configs.
chmod -R u+w "$EXTRACTED"

# ── 3. Inject Flagship preseed + scripts ───────────────────────
echo "[netboot-iso] injecting preseed.cfg + /flagship/*"
cp "$INJECT_DIR/preseed.cfg" "$EXTRACTED/preseed.cfg"
mkdir -p "$EXTRACTED/flagship"
cp "$INJECT_DIR/install.sh"          "$EXTRACTED/flagship/install.sh"
cp "$INJECT_DIR/parse-trailer.sh"    "$EXTRACTED/flagship/parse-trailer.sh"
cp "$INJECT_DIR/late-command.sh"     "$EXTRACTED/flagship/late-command.sh"
chmod 755 "$EXTRACTED/flagship/install.sh" "$EXTRACTED/flagship/parse-trailer.sh" "$EXTRACTED/flagship/late-command.sh"

# ── 4. Modify boot configs for auto-preseed ────────────────────
# Debian netinst's isolinux uses /isolinux/isolinux.cfg + included
# txt.cfg / menu.cfg under /isolinux/. We replace the menu so the
# default action is "auto install with /cdrom/preseed.cfg" with NO
# user interaction (priority=critical suppresses every prompt that
# isn't a hard-required preseed answer).
ISOLINUX_DIR="$EXTRACTED/isolinux"
if [[ -d "$ISOLINUX_DIR" ]]; then
  echo "[netboot-iso] patching isolinux config for auto-preseed"
  # The Bookworm isolinux.cfg includes adtxt.cfg / menu.cfg via
  # `include`. The simplest portable hack is to write a NEW isolinux.cfg
  # that defaults to a single auto-install entry. We retain the
  # original under .orig in case a future operator needs the rescue
  # entries.
  if [[ -f "$ISOLINUX_DIR/isolinux.cfg" ]]; then
    cp "$ISOLINUX_DIR/isolinux.cfg" "$ISOLINUX_DIR/isolinux.cfg.orig"
  fi
  cat > "$ISOLINUX_DIR/isolinux.cfg" <<'ISOCFG'
# Flagship netboot: auto-install via preseed, no menu, no timeout.
default flagship-auto
prompt 0
timeout 1

label flagship-auto
    kernel /install.amd/vmlinuz
    append vga=normal initrd=/install.amd/initrd.gz auto=true priority=critical preseed/file=/cdrom/preseed.cfg --- quiet
ISOCFG
fi

# Likewise for UEFI / grub.
GRUB_CFG="$EXTRACTED/boot/grub/grub.cfg"
if [[ -f "$GRUB_CFG" ]]; then
  echo "[netboot-iso] patching grub config for auto-preseed"
  cp "$GRUB_CFG" "$GRUB_CFG.orig"
  cat > "$GRUB_CFG" <<'GRUBCFG'
# Flagship netboot — auto preseed, no menu wait.
set timeout=1
set default="flagship-auto"

menuentry --id=flagship-auto "Flagship auto-install" {
    set background_color=black
    linux /install.amd/vmlinuz auto=true priority=critical preseed/file=/cdrom/preseed.cfg --- quiet
    initrd /install.amd/initrd.gz
}
GRUBCFG
fi

# Clamp every file's mtime so the resulting ISO is bit-stable.
find "$EXTRACTED" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# ── 5. Re-pack with xorriso, deterministic flags ───────────────
echo "[netboot-iso] re-packing → $OUT_PATH"
mkdir -p "$(dirname "$OUT_PATH")"
xorriso \
  -outdev "$OUT_PATH" \
  -volid "FLAGSHIP_DEBIAN_${DEBIAN_VERSION//./_}" \
  -volume_date "all_file_dates" "=$SOURCE_DATE_EPOCH" \
  -volume_date "uuid" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00 2>/dev/null || date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00)" \
  -joliet on \
  -map "$EXTRACTED" / \
  -boot_image isolinux bin_path=/isolinux/isolinux.bin \
  -boot_image isolinux cat_path=/isolinux/boot.cat \
  -boot_image isolinux system_area=/usr/share/syslinux/isohdpfx.bin \
  -- >/dev/null 2>&1 || {
    # Fall back: some environments don't have isohdpfx at the standard
    # path. Extract the MBR from the source ISO (the first 432 bytes of
    # any hybrid-bootable ISO).
    echo "[netboot-iso] system_area fallback — extracting MBR from source"
    dd if="$DEBIAN_ISO" of="$WORK_DIR/mbr.bin" bs=1 count=432 2>/dev/null
    xorriso \
      -outdev "$OUT_PATH" \
      -volid "FLAGSHIP_DEBIAN_${DEBIAN_VERSION//./_}" \
      -volume_date "all_file_dates" "=$SOURCE_DATE_EPOCH" \
      -volume_date "uuid" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00 2>/dev/null || date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00)" \
      -joliet on \
      -map "$EXTRACTED" / \
      -boot_image isolinux bin_path=/isolinux/isolinux.bin \
      -boot_image isolinux cat_path=/isolinux/boot.cat \
      -boot_image isolinux system_area="$WORK_DIR/mbr.bin" \
      -- >/dev/null
  }

# ── 6. Compute + write SHA-256 sidecar ───────────────────────────
sha=$(sha256sum "$OUT_PATH" | awk '{print $1}')
echo "$sha  $(basename "$OUT_PATH")" > "${OUT_PATH}.sha256"
echo "[netboot-iso] wrote $OUT_PATH"
echo "[netboot-iso] sha256: $sha"
