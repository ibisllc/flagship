#!/bin/bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: scripts/build-vm-appliance-mac.sh <debian.iso> <base.raw> <arm64|amd64> <git-ref>" >&2
  exit 2
fi

SOURCE_ISO="$1"
OUTPUT_RAW="$2"
ARCH="$3"
GIT_REF="$4"
STUDIO_BIN="${FLAGSHIP_STUDIO_BIN:-/Applications/Flagship Studio.app/Contents/MacOS/FlagshipStudio}"
WORK_DIR="$(mktemp -d /private/tmp/flagship-appliance.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -e "$OUTPUT_RAW" ] || [ -e "$OUTPUT_RAW.json" ]; then
  echo "refusing to replace an existing appliance or manifest" >&2
  exit 2
fi
if [ ! -x "$STUDIO_BIN" ]; then
  echo "signed Flagship Studio binary not found: $STUDIO_BIN" >&2
  exit 2
fi

node packages/flagship-builder/dist/cli.js appliance-factory-iso \
  "$SOURCE_ISO" "$WORK_DIR/factory.iso" --git-ref "$GIT_REF"
"$STUDIO_BIN" --vm-appliance-factory \
  --factory-iso "$WORK_DIR/factory.iso" --work-dir "$WORK_DIR/vm" --output "$OUTPUT_RAW"
node packages/flagship-builder/dist/cli.js appliance-manifest \
  "$OUTPUT_RAW" "$OUTPUT_RAW.json" --arch "$ARCH" --git-ref "$GIT_REF"

echo "appliance: $OUTPUT_RAW"
echo "manifest:  $OUTPUT_RAW.json"
