#!/usr/bin/env bash
# Reproducibly build the Flagship base ISO (Alpine 3.21 + apkovl).
#
# ── LEGACY / NOT FOR CLOUD INSTALLS ──────────────────────────────
# As of W12 (2026-05-21) this script is kept only for the /build/
# flow on REAL HARDWARE (USB stick installs to bare-metal boxes). The
# cloud-demo install path uses scripts/build-flagship-netboot-iso.sh,
# which builds a Debian-12-netinst-based ISO that's known-working on
# Hetzner / DigitalOcean / Vultr cloud VMs.
#
# Why the split: Alpine 3.21 standard ISO booted in apkovl-mode on a
# Hetzner cx23 cloud VM doesn't mount its modloop-lts kernel-modules
# squashfs. /lib/modules stays empty; af_packet can't load; udhcpc
# fails on AF_PACKET raw sockets; DHCP never sends Discover; the
# bootstrap has no network. Live-confirmed 2026-05-21. Debian d-i's
# installer kernel has every common driver built IN, so cloud DHCP
# works out of the box.
#
# The two ISOs (alpine + debian-netinst) will be unified into a single
# /build/ flow in a follow-up commit after the demo path is verified
# live end to end. Until then: keep using this script ONLY for bare-
# metal /build/ ISOs.
#
# Inputs:
#   - The pinned Alpine standard ISO (URL + sha256 below).
#   - The Flagship apkovl tarball, emitted from packages/installer-apkovl.
#   - SOURCE_DATE_EPOCH (env): all file mtimes inside the resulting ISO
#     are clamped to this; the workflow derives it from the commit's
#     timestamp so two builds of the same git ref produce the same
#     byte-for-byte ISO.
#
# Output:
#   $1 — path to write the assembled ISO to.
#   $1.sha256 — adjacent file with `sha256  basename` line.
#
# Reproducibility checklist (must stay in sync with the GHA workflow):
#   - SOURCE_DATE_EPOCH set, every tool that respects it does so
#     (xorriso supports it via --set_filter / -volid date arguments;
#      we pass it explicitly).
#   - xorriso called with deterministic options (no embedded build
#     timestamp, sorted directory entries, fixed iso volume id).
#   - apkovl emitted from a deterministic Node script (no Date.now()
#     or random in the tar; verified upstream by buildApkovl tests).
#   - Alpine ISO sha256 verified before use.

set -euo pipefail

# ── Pinned inputs ──────────────────────────────────────────────────
ALPINE_VERSION="${ALPINE_VERSION_OVERRIDE:-3.21.0}"
ALPINE_ARCH="x86_64"
ALPINE_FLAVOR="standard"  # standard ships with the kernel + apk we need.

# Mirror is pinned to the .com mirror (geographically closest); SHA-256
# is canonical. Update both if you bump ALPINE_VERSION.
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ALPINE_ARCH}/alpine-${ALPINE_FLAVOR}-${ALPINE_VERSION}-${ALPINE_ARCH}.iso"

# To bump: download the new ISO, sha256sum it, paste here. Mismatched
# checksum aborts the build before any further work.
#
# Alpine has been observed to RE-PUBLISH a patch release with the same
# point-version string (3.21.0 was reissued at some point with different
# bytes). To avoid chasing reissues, pin to the LATEST patch in the
# series rather than the first.
declare -A ALPINE_SHA256
ALPINE_SHA256["3.21.0"]="201e2ba601be5b861345a308591e3e547bf6d210945dfaab3e3251b8dea64b8b"

OUT_PATH="${1:?usage: build-flagship-iso.sh <out.iso>}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1700000000}"
export SOURCE_DATE_EPOCH

WORK_DIR="$(mktemp -d -t flagship-iso.XXXXXX)"
# xorriso -extract preserves the Alpine ISO's read-only dir modes (apks/ is
# 0555), so a plain `rm -rf` can't unlink files inside them and exits non-zero
# — which, as an EXIT trap, would fail the whole build even though the ISO was
# written fine. Restore owner-write before removing, and never let cleanup
# failure mask the build's real exit status.
trap 'chmod -R u+w "$WORK_DIR" 2>/dev/null || true; rm -rf "$WORK_DIR" 2>/dev/null || true' EXIT

EXPECTED_SHA="${ALPINE_SHA256[$ALPINE_VERSION]:-}"
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "error: no pinned sha256 for Alpine $ALPINE_VERSION; update ALPINE_SHA256 in $0" >&2
  exit 2
fi

echo "[build-iso] Alpine $ALPINE_VERSION ($ALPINE_ARCH-$ALPINE_FLAVOR)"
echo "[build-iso] SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
echo "[build-iso] work dir: $WORK_DIR"

# ── 1. Fetch + verify the Alpine ISO ─────────────────────────────
ALPINE_ISO="$WORK_DIR/alpine-base.iso"
echo "[build-iso] fetching $ALPINE_URL"
curl -fSL --retry 3 --retry-delay 5 -o "$ALPINE_ISO" "$ALPINE_URL"

actual_sha=$(sha256sum "$ALPINE_ISO" | awk '{print $1}')
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "error: Alpine ISO sha256 mismatch" >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  got:      $actual_sha" >&2
  echo "If Alpine genuinely re-released, update ALPINE_SHA256 in $0." >&2
  exit 3
fi
echo "[build-iso] sha256 verified: $actual_sha"

# ── 2. Build the Flagship apkovl ─────────────────────────────────
APKOVL="$WORK_DIR/flagship.apkovl.tar.gz"
echo "[build-iso] emitting apkovl"
npx tsx packages/installer-apkovl/scripts/emit-apkovl.mjs "$APKOVL"

# ── 3. Re-pack: REPLAY the source boot equipment + inject the apkovl ─
#
# CRITICAL (bare-metal UEFI fix): the previous build extracted the ISO and
# re-packed it with an isolinux/BIOS boot image ONLY — it dropped Alpine's
# UEFI boot entry entirely. On a modern UEFI machine that stick has no EFI
# boot, so the firmware never lists it in the boot menu (the exact symptom we
# hit on real hardware). `xorriso -boot_image any replay` reproduces the
# source ISO's FULL El Torito catalog (isolinux BIOS *and* the EFI boot image)
# AND the isohybrid MBR/GPT, so the result is a true BIOS+UEFI hybrid — `dd` it
# to USB and it boots on both. Same approach the Debian/Ubuntu burner uses
# (packages/flagship-burner/src/remasterIso.ts). Bonus: no dependency on a
# Linux-only `/usr/share/syslinux/isohdpfx.bin`, so the build is portable.
#
# We inject the apkovl by mapping the single file onto the source image
# (indev → outdev). Alpine's init scans every block device's root for
# *.apkovl.tar.gz on boot, so a root-level file is all it needs.
echo "[build-iso] re-packing (BIOS+UEFI replay) → $OUT_PATH"
mkdir -p "$(dirname "$OUT_PATH")"
rm -f "$OUT_PATH"
# Clamp the injected file's mtime so the output is bit-stable across builds.
touch -h -d "@$SOURCE_DATE_EPOCH" "$APKOVL"
xorriso \
  -indev "$ALPINE_ISO" \
  -outdev "$OUT_PATH" \
  -volid "FLAGSHIP_ALPINE_${ALPINE_VERSION//./_}" \
  -volume_date "all_file_dates" "=$SOURCE_DATE_EPOCH" \
  -volume_date "uuid" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00)" \
  -boot_image any replay \
  -map "$APKOVL" /flagship.apkovl.tar.gz \
  -- >/dev/null

# ── 5. Compute + write SHA-256 sidecar ───────────────────────────
sha=$(sha256sum "$OUT_PATH" | awk '{print $1}')
echo "$sha  $(basename "$OUT_PATH")" > "${OUT_PATH}.sha256"
echo "[build-iso] ✅ wrote $OUT_PATH"
echo "[build-iso] sha256: $sha"
