#!/bin/bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: scripts/build-vm-appliance-cloud-qemu.sh <debian.qcow2> <sha512> <base.raw> <arm64|amd64> <git-ref>" >&2
  echo "requires FLAGSHIP_QEMU_CODE and FLAGSHIP_QEMU_VARS; optional FLAGSHIP_QEMU_SYSTEM/FLAGSHIP_QEMU_IMG/FLAGSHIP_QEMU_ACCEL" >&2
  exit 2
fi

SOURCE_QCOW2="$1"
EXPECTED_SHA512="$2"
OUTPUT_RAW="$3"
ARCH="$4"
GIT_REF="$5"
: "${FLAGSHIP_QEMU_CODE:?set FLAGSHIP_QEMU_CODE to the read-only UEFI code image}"
: "${FLAGSHIP_QEMU_VARS:?set FLAGSHIP_QEMU_VARS to the UEFI vars template}"
QEMU_IMG="${FLAGSHIP_QEMU_IMG:-qemu-img}"
QEMU_ACCEL="${FLAGSHIP_QEMU_ACCEL:-kvm}"
if [ "$ARCH" = arm64 ]; then
  QEMU_SYSTEM="${FLAGSHIP_QEMU_SYSTEM:-qemu-system-aarch64}"
  MACHINE=virt
else
  QEMU_SYSTEM="${FLAGSHIP_QEMU_SYSTEM:-qemu-system-x86_64}"
  MACHINE=q35
fi
WORK_DIR="$(mktemp -d /tmp/flagship-cloud-appliance-qemu.XXXXXX)"
SUCCESS=0
SMOKE_PID=""
cleanup() {
  if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  if [ "$SUCCESS" -ne 1 ]; then
    if [ -f "$WORK_DIR/factory.log" ]; then
      cp "$WORK_DIR/factory.log" "$OUTPUT_RAW.factory.log"
    fi
    rm -f "$OUTPUT_RAW" "$OUTPUT_RAW.json"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [ -e "$OUTPUT_RAW" ] || [ -e "$OUTPUT_RAW.json" ]; then
  echo "refusing to replace an existing appliance or manifest" >&2
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

"$QEMU_IMG" create -f raw "$OUTPUT_RAW" 8G
"$QEMU_IMG" create -f qcow2 -F qcow2 -b "$SOURCE_QCOW2" "$WORK_DIR/debian-source.qcow2"
node packages/flagship-builder/dist/cli.js appliance-cloud-factory-seed \
  "$WORK_DIR/factory-seed.iso" --git-ref "$GIT_REF"
cp "$FLAGSHIP_QEMU_VARS" "$WORK_DIR/vars.fd"

set +e
"$QEMU_SYSTEM" \
  -machine "$MACHINE",accel="$QEMU_ACCEL" -cpu host -smp 4 -m 6144M \
  -drive "if=pflash,format=raw,readonly=on,file=$FLAGSHIP_QEMU_CODE" \
  -drive "if=pflash,format=raw,file=$WORK_DIR/vars.fd" \
  -drive "id=debian-source,if=none,format=qcow2,file=$WORK_DIR/debian-source.qcow2" \
  -device virtio-blk-pci,drive=debian-source \
  -drive "id=flagship-target,if=none,format=raw,file=$OUTPUT_RAW" \
  -device virtio-blk-pci,drive=flagship-target \
  -drive "id=factory-seed,if=none,format=raw,readonly=on,file=$WORK_DIR/factory-seed.iso" \
  -device virtio-blk-pci,drive=factory-seed \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -device virtio-rng-pci -display none -serial stdio -no-reboot 2>&1 | tee "$WORK_DIR/factory.log"
QEMU_FACTORY_STATUS=${PIPESTATUS[0]}
set -e

if ! grep -Fq '[appliance-factory] encrypted generalized target ready' "$WORK_DIR/factory.log"; then
  grep -F '[appliance-factory]' "$WORK_DIR/factory.log" | tail -40 >&2 || true
  echo "appliance factory guest did not report success" >&2
  exit 1
fi
if [ "$QEMU_FACTORY_STATUS" -ne 0 ]; then
  echo "factory QEMU exited $QEMU_FACTORY_STATUS after the guest success marker; continuing to independent boot smoke"
fi

# Guest poweroff does not tell QEMU whether cloud-init succeeded. Booting a
# disposable overlay makes the readiness marker an explicit artifact gate.
"$QEMU_IMG" create -f qcow2 -F raw -b "$OUTPUT_RAW" "$WORK_DIR/smoke-disk.qcow2"
cp "$FLAGSHIP_QEMU_VARS" "$WORK_DIR/smoke-vars.fd"
"$QEMU_SYSTEM" \
  -machine "$MACHINE",accel="$QEMU_ACCEL" -cpu host -smp 2 -m 2048M \
  -drive "if=pflash,format=raw,readonly=on,file=$FLAGSHIP_QEMU_CODE" \
  -drive "if=pflash,format=raw,file=$WORK_DIR/smoke-vars.fd" \
  -drive "id=smoke-disk,if=none,format=qcow2,file=$WORK_DIR/smoke-disk.qcow2" \
  -device virtio-blk-pci,drive=smoke-disk \
  -netdev user,id=smoke-net -device virtio-net-pci,netdev=smoke-net \
  -device virtio-rng-pci -display none -serial "file:$WORK_DIR/smoke.log" -no-reboot &
SMOKE_PID=$!
SMOKE_OK=0
for _attempt in $(seq 1 90); do
  if grep -Fq '[appliance] generalized base verified' "$WORK_DIR/smoke.log" 2>/dev/null; then
    SMOKE_OK=1
    break
  fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$SMOKE_PID" 2>/dev/null; then kill "$SMOKE_PID" 2>/dev/null || true; fi
wait "$SMOKE_PID" 2>/dev/null || true
SMOKE_PID=""
if [ "$SMOKE_OK" -ne 1 ]; then
  tail -80 "$WORK_DIR/smoke.log" >&2 || true
  echo "appliance boot smoke test did not reach the readiness marker" >&2
  exit 1
fi
echo "appliance boot smoke test reached the readiness marker"

node packages/flagship-builder/dist/cli.js appliance-manifest \
  "$OUTPUT_RAW" "$OUTPUT_RAW.json" --arch "$ARCH" --git-ref "$GIT_REF"
SUCCESS=1
rm -f "$OUTPUT_RAW.factory.log"
echo "appliance: $OUTPUT_RAW"
echo "manifest:  $OUTPUT_RAW.json"
