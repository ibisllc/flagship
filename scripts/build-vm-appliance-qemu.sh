#!/bin/bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: scripts/build-vm-appliance-qemu.sh <debian.iso> <base.raw> <amd64|arm64> <git-ref>" >&2
  echo "requires FLAGSHIP_QEMU_CODE and FLAGSHIP_QEMU_VARS; optional FLAGSHIP_QEMU_SYSTEM/FLAGSHIP_QEMU_IMG" >&2
  exit 2
fi

SOURCE_ISO="$1"
OUTPUT_RAW="$2"
ARCH="$3"
GIT_REF="$4"
: "${FLAGSHIP_QEMU_CODE:?set FLAGSHIP_QEMU_CODE to the read-only UEFI code image}"
: "${FLAGSHIP_QEMU_VARS:?set FLAGSHIP_QEMU_VARS to the UEFI vars template}"
QEMU_IMG="${FLAGSHIP_QEMU_IMG:-qemu-img}"
if [ "$ARCH" = "arm64" ]; then
  QEMU_SYSTEM="${FLAGSHIP_QEMU_SYSTEM:-qemu-system-aarch64}"
  MACHINE="virt"
else
  QEMU_SYSTEM="${FLAGSHIP_QEMU_SYSTEM:-qemu-system-x86_64}"
  MACHINE="q35"
fi
WORK_DIR="$(mktemp -d /tmp/flagship-appliance.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -e "$OUTPUT_RAW" ] || [ -e "$OUTPUT_RAW.json" ]; then
  echo "refusing to replace an existing appliance or manifest" >&2
  exit 2
fi

node packages/flagship-builder/dist/cli.js appliance-factory-iso \
  "$SOURCE_ISO" "$WORK_DIR/factory.iso" --git-ref "$GIT_REF"
"$QEMU_IMG" create -f raw "$OUTPUT_RAW" 64G
cp "$FLAGSHIP_QEMU_VARS" "$WORK_DIR/vars.fd"

COMMON_ARGS=(
  -machine "$MACHINE" -accel kvm -cpu host -smp 4 -m 6144M
  -drive "if=pflash,format=raw,readonly=on,file=$FLAGSHIP_QEMU_CODE"
  -drive "if=pflash,format=raw,file=$WORK_DIR/vars.fd"
  -drive "id=flagship-main,if=none,format=raw,file=$OUTPUT_RAW"
)
if [ "$ARCH" = "arm64" ]; then
  COMMON_ARGS+=( -device ahci,id=ahci -device ide-hd,drive=flagship-main,bus=ahci.0 )
else
  COMMON_ARGS+=( -device ide-hd,drive=flagship-main )
fi
"$QEMU_SYSTEM" "${COMMON_ARGS[@]}" \
  -device qemu-xhci \
  -drive "id=flagship-installer,if=none,format=raw,readonly=on,file=$WORK_DIR/factory.iso" \
  -device usb-storage,drive=flagship-installer \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -device virtio-rng-pci -display none -serial stdio -no-reboot

node packages/flagship-builder/dist/cli.js appliance-manifest \
  "$OUTPUT_RAW" "$OUTPUT_RAW.json" --arch "$ARCH" --git-ref "$GIT_REF"
echo "appliance: $OUTPUT_RAW"
echo "manifest:  $OUTPUT_RAW.json"
