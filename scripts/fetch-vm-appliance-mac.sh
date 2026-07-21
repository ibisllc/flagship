#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/fetch-vm-appliance-mac.sh <output.raw>" >&2
  exit 2
fi

OUTPUT_RAW="$1"
QEMU_IMG="${FLAGSHIP_QEMU_IMG:-/opt/homebrew/bin/qemu-img}"
URL_BASE="https://flagshipserver.com/build/iso/flagship-vm-appliance-arm64-main-b2b48ea72f50.qcow2"
ARCHIVE_SHA256="b2b48ea72f508f8e282e5f245dafc879656375a2a2842e04dc7f790102736426"
RAW_SHA256="d8e3d1cc4a39799824f0f955f9d63e6005c4bc574011887bc4a8f9dd829272a1"
ARCHIVE="${OUTPUT_RAW}.download.qcow2"
MANIFEST="${OUTPUT_RAW}.json"
PART_NAMES=(part-00 part-01 part-02 part-03 part-04 part-05 part-06 part-07 part-08 part-09 part-10)
PART_SHA256=(
  3ff886f5d1009f02d69cee17be29290b4dcb1afaf4cc164dec1c30ed2cd86a0c
  fca5e381b357726e7140bdbfb38c766ad9f9c162e51bdf283b0aa3dec0fa30b7
  c6b03acfaa76884aa389715a4961859afd9aa95ef777a14b57c16598b633f2fe
  a84c8118ce9deecf460b52980294311be55ab8befbba83471375859c0f0fe631
  86e6b693a5477bb6d21094f88053c7a9cd84b9e06161f20ce763f5ce7e3867b7
  ca9bb479046b2cce8b83489fa6ed351960b57f9755b000d2976732efcbedefd3
  f2363e2ca0152380a42a7a5ccce5d91d74b25a9141319233500d505c1ebb8924
  0c2ea18c1867cc4bc6cd154a5c1ac15a83c746ab11aecb4c249935ca8e5eedfa
  449b27d77839b2a91ef0b73c193fbe55345f19656410104502a303bf3ad8e56d
  6841b6a4bb89259f5bd7474b95b0e800d0f968b416b1c4d1083ee4a01fc8f60f
  3c4459bb6c76cc4634b38ecb47715ec1a9f4ecfc51166ef18eaad87553158d37
)

if [ -e "$OUTPUT_RAW" ] || [ -e "$MANIFEST" ]; then
  echo "refusing to replace an existing appliance or manifest" >&2
  exit 2
fi
if [ ! -x "$QEMU_IMG" ]; then
  echo "qemu-img is required (brew install qemu, or set FLAGSHIP_QEMU_IMG)" >&2
  exit 2
fi

for index in "${!PART_NAMES[@]}"; do
  name="${PART_NAMES[$index]}"
  part="${ARCHIVE}.${name}"
  curl --fail-with-body --location --continue-at - --output "$part" "$URL_BASE.$name"
  got="$(shasum -a 256 "$part" | awk '{print $1}')"
  if [ "$got" != "${PART_SHA256[$index]}" ]; then
    echo "downloaded appliance part checksum mismatch: $name" >&2
    exit 1
  fi
done
: > "$ARCHIVE"
for name in "${PART_NAMES[@]}"; do cat "${ARCHIVE}.${name}" >> "$ARCHIVE"; done
GOT_ARCHIVE_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$GOT_ARCHIVE_SHA256" != "$ARCHIVE_SHA256" ]; then
  echo "downloaded appliance checksum mismatch" >&2
  exit 1
fi
"$QEMU_IMG" check "$ARCHIVE"
"$QEMU_IMG" convert -p -f qcow2 -O raw "$ARCHIVE" "$OUTPUT_RAW"
GOT_RAW_SHA256="$(shasum -a 256 "$OUTPUT_RAW" | awk '{print $1}')"
if [ "$GOT_RAW_SHA256" != "$RAW_SHA256" ]; then
  echo "expanded appliance checksum mismatch" >&2
  exit 1
fi
chmod 600 "$OUTPUT_RAW"
cp apps/web/public/downloads/FlagshipVMAppliance-arm64.json "$MANIFEST.distribution"
node packages/flagship-builder/dist/cli.js appliance-manifest \
  "$OUTPUT_RAW" "$MANIFEST" --arch arm64 --git-ref main
rm -f "$ARCHIVE" "${ARCHIVE}.part-"*
echo "verified appliance: $OUTPUT_RAW"
echo "runtime manifest:   $MANIFEST"
