#!/bin/bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: scripts/build-vm-appliance-cloud-mac.sh <debian.qcow2> <sha512> <base.raw> <arm64|amd64> <git-ref> <qemu-img>" >&2
  exit 2
fi

SOURCE_QCOW2="$1"
EXPECTED_SHA512="$2"
OUTPUT_RAW="$3"
ARCH="$4"
GIT_REF="$5"
QEMU_IMG="$6"
STUDIO_BIN="${FLAGSHIP_STUDIO_BIN:-/Applications/Flagship Studio.app/Contents/MacOS/FlagshipStudio}"
WORK_DIR="$(mktemp -d /private/tmp/flagship-cloud-appliance.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -e "$OUTPUT_RAW" ] || [ -e "$OUTPUT_RAW.json" ]; then
  echo "refusing to replace an existing appliance or manifest" >&2
  exit 2
fi
if [ ! -x "$STUDIO_BIN" ] || [ ! -x "$QEMU_IMG" ]; then
  echo "signed Flagship Studio or qemu-img is unavailable" >&2
  exit 2
fi
if ! [[ "$EXPECTED_SHA512" =~ ^[0-9a-f]{128}$ ]]; then
  echo "expected SHA-512 is malformed" >&2
  exit 2
fi

ACTUAL_SHA512="$(shasum -a 512 "$SOURCE_QCOW2" | awk '{print $1}')"
if [ "$ACTUAL_SHA512" != "$EXPECTED_SHA512" ]; then
  echo "Debian cloud image SHA-512 mismatch" >&2
  exit 1
fi
echo "verified official Debian cloud image sha512=$ACTUAL_SHA512"

"$QEMU_IMG" convert -p -f qcow2 -O raw "$SOURCE_QCOW2" "$WORK_DIR/debian.raw"
node packages/flagship-builder/dist/cli.js appliance-cloud-factory-seed \
  "$WORK_DIR/factory-seed.iso" --git-ref "$GIT_REF"
"$STUDIO_BIN" --vm-appliance-factory \
  --cloud-base-raw "$WORK_DIR/debian.raw" \
  --factory-seed "$WORK_DIR/factory-seed.iso" \
  --work-dir "$WORK_DIR/vm" \
  --disk-gib 8 \
  --output "$OUTPUT_RAW"
node packages/flagship-builder/dist/cli.js appliance-manifest \
  "$OUTPUT_RAW" "$OUTPUT_RAW.json" --arch "$ARCH" --git-ref "$GIT_REF"

echo "appliance: $OUTPUT_RAW"
echo "manifest:  $OUTPUT_RAW.json"
