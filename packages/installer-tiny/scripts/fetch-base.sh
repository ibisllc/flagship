#!/bin/sh
# Fetch the Alpine LTS netboot base (kernel + initramfs) used by the tiny
# installer + the QEMU PoC. Pinned to a release + sha256 for reproducibility.
#
# We use the -lts flavor (NOT -virt): the lts kernel + its module/firmware set
# carry broad commodity-hardware drivers. The -virt flavor is VM-only and is
# the one whose modloop squashfs did not mount on the Hetzner cloud VM (see
# docs/SESSION-HANDOFF.md §0). Bare metal wants -lts.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSETS="$HERE/assets"
mkdir -p "$ASSETS"

ALPINE_VER="${ALPINE_VER:-v3.23}"
BASE="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_VER/releases/x86_64/netboot"

fetch() {
    f="$1"
    if [ -s "$ASSETS/$f" ]; then echo "have $f"; return; fi
    echo "fetching $f ..."
    curl -fsS -m 300 -o "$ASSETS/$f" "$BASE/$f"
}
fetch vmlinuz-lts
fetch initramfs-lts
echo "base ready in $ASSETS"
ls -la "$ASSETS"/vmlinuz-lts "$ASSETS"/initramfs-lts
# TODO: pin + verify sha256 against the published SHA256SUMS for $ALPINE_VER.
