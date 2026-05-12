#!/usr/bin/env bash
# Reproducibly build the Flagship base ISO.
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
trap 'rm -rf "$WORK_DIR"' EXIT

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

# ── 3. Extract the Alpine ISO into a working tree ────────────────
EXTRACTED="$WORK_DIR/extracted"
mkdir -p "$EXTRACTED"
echo "[build-iso] extracting Alpine ISO"
xorriso -osirrox on -indev "$ALPINE_ISO" -extract / "$EXTRACTED" >/dev/null

# Inject the apkovl at the root of the ISO9660 filesystem — Alpine's
# init scans every block device's root for *.apkovl.tar.gz on boot.
cp "$APKOVL" "$EXTRACTED/flagship.apkovl.tar.gz"

# Clamp every file's mtime so the resulting ISO is bit-stable.
find "$EXTRACTED" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# ── 4. Re-pack with xorriso, deterministic flags ────────────────
echo "[build-iso] re-packing → $OUT_PATH"
mkdir -p "$(dirname "$OUT_PATH")"
xorriso \
  -outdev "$OUT_PATH" \
  -volid "FLAGSHIP_ALPINE_${ALPINE_VERSION//./_}" \
  -volume_date "all_file_dates" "=$SOURCE_DATE_EPOCH" \
  -volume_date "uuid" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00)" \
  -joliet on \
  -map "$EXTRACTED" / \
  -boot_image isolinux bin_path=/boot/syslinux/isolinux.bin \
  -boot_image isolinux cat_path=/boot/syslinux/boot.cat \
  -boot_image isolinux system_area=/usr/share/syslinux/isohdpfx.bin \
  -- >/dev/null 2>&1 || {
    # Fall back: some environments don't have isohdpfx at the standard
    # path. In that case extract it from the source ISO (it lives in
    # the first 512 bytes for hybrid-bootable ISOs).
    dd if="$ALPINE_ISO" of="$WORK_DIR/mbr.bin" bs=1 count=432 2>/dev/null
    xorriso \
      -outdev "$OUT_PATH" \
      -volid "FLAGSHIP_ALPINE_${ALPINE_VERSION//./_}" \
      -volume_date "all_file_dates" "=$SOURCE_DATE_EPOCH" \
      -volume_date "uuid" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S00)" \
      -joliet on \
      -map "$EXTRACTED" / \
      -boot_image isolinux bin_path=/boot/syslinux/isolinux.bin \
  -boot_image isolinux cat_path=/boot/syslinux/boot.cat \
      -boot_image isolinux system_area="$WORK_DIR/mbr.bin" \
      -- >/dev/null
  }

# ── 5. Compute + write SHA-256 sidecar ───────────────────────────
sha=$(sha256sum "$OUT_PATH" | awk '{print $1}')
echo "$sha  $(basename "$OUT_PATH")" > "${OUT_PATH}.sha256"
echo "[build-iso] ✅ wrote $OUT_PATH"
echo "[build-iso] sha256: $sha"
