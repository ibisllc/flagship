#!/usr/bin/env bash
#
# arm64-local — the arm64 half of the G8/G10 evidence on an Apple-silicon Mac: boots Debian 13 arm64 (the official
# genericcloud image, checked against Debian's SHA512SUMS) under QEMU with Apple's hypervisor (-accel hvf, native
# arm64, no emulation), 2 vCPUs and 4 GiB like the amd64 bench guest, copies in the aarch64 release binaries built by
# scripts/bench/run-vm.sh and the working tree, and runs the startup and relay benchmarks plus each binary's
# --version. The VM is stopped and its disk deleted at the end (the downloaded base image too, unless --keep-image).
#
#   bash scripts/bench/arm64-local.sh --bins <dir with aarch64-unknown-linux-gnu/> [--out <dir>] [--keep-image]
#        [--benches startup,relay,access,ingress] [--tests <tar.gz of aarch64 test executables>]
#
# --tests runs cargo test executables cross-built on the amd64 VM (paths under rust/target/aarch64-unknown-linux-gnu/
# debug, as `cargo test --no-run --target aarch64-unknown-linux-gnu` leaves them) natively here, from /root/fs/rust as
# cargo would: for the tests qemu-user cannot run (it does not emulate every file-descriptor and /proc behaviour).
#
# Needs: qemu-system-aarch64 with edk2-aarch64-code.fd (Homebrew qemu), hdiutil, ssh, curl. macOS on arm64 only.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BINS="" OUT="" KEEP_IMAGE=0 BENCHES="startup,relay,access,ingress" TESTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bins) BINS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep-image) KEEP_IMAGE=1; shift ;;
    --benches) BENCHES="$2"; shift 2 ;;
    --tests) TESTS="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || { echo "arm64-local runs on an Apple-silicon Mac" >&2; exit 2; }
[ -d "$BINS/aarch64-unknown-linux-gnu" ] || { echo "--bins must contain aarch64-unknown-linux-gnu/" >&2; exit 2; }
OUT="${OUT:-$REPO/gym-results/bench-g10-arm64-$(date -u +%Y%m%dt%H%M%Sz)}"
mkdir -p "$OUT"
CACHE="$HOME/.cache/flagship/bench-arm64"
mkdir -p "$CACHE"
FW="$(brew --prefix qemu 2>/dev/null || echo /opt/homebrew)/share/qemu/edk2-aarch64-code.fd"
[ -f "$FW" ] || FW=/opt/homebrew/share/qemu/edk2-aarch64-code.fd
IMG_BASE=https://cloud.debian.org/images/cloud/trixie/latest
IMG=debian-13-genericcloud-arm64.qcow2
NODE_V="$(node -e 'console.log(require(process.argv[1]).node.minimum)' "$REPO/release/security-floor.json")"
WORK="$(mktemp -d)"
PIDFILE="$WORK/qemu.pid"
say() { echo "▸ $*"; }
cleanup() {
  local rc=$?
  if [ -f "$PIDFILE" ]; then
    say "stopping the arm64 VM"
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 2
  fi
  rm -rf "$WORK"
  [ "$KEEP_IMAGE" = 1 ] || rm -f "$CACHE/$IMG"
  exit $rc
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

if [ ! -f "$CACHE/$IMG" ]; then
  say "downloading $IMG"
  curl -fsSL --proto '=https' -o "$CACHE/$IMG.part" "$IMG_BASE/$IMG"
  mv "$CACHE/$IMG.part" "$CACHE/$IMG"
fi
want="$(curl -fsSL --proto '=https' "$IMG_BASE/SHA512SUMS" | awk -v f="$IMG" '$2==f{print $1}')"
[ -n "$want" ] && [ "$(shasum -a 512 "$CACHE/$IMG" | cut -d' ' -f1)" = "$want" ] || { echo "$IMG does not match Debian's SHA512SUMS" >&2; rm -f "$CACHE/$IMG"; exit 1; }
say "image verified against SHA512SUMS"

qemu-img create -q -f qcow2 -F qcow2 -b "$CACHE/$IMG" "$WORK/disk.qcow2" 16G
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
mkdir -p "$WORK/seed"
printf 'instance-id: bench-g10-arm64\nlocal-hostname: bench-g10-arm64\n' > "$WORK/seed/meta-data"
cat > "$WORK/seed/user-data" <<EOF
#cloud-config
disable_root: false
users:
  - name: root
    ssh_authorized_keys: ["$(cat "$WORK/key.pub")"]
ssh_pwauth: false
EOF
hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "$WORK/seed.iso" "$WORK/seed"
PORT=$((20000 + RANDOM % 20000))
cp "$FW" "$WORK/code.fd"
say "booting Debian 13 arm64 (hvf, 2 vCPU, 4 GiB) with ssh on 127.0.0.1:$PORT"
qemu-system-aarch64 -M virt -accel hvf -cpu host -smp 2 -m 4096 \
  -drive if=pflash,format=raw,readonly=on,file="$WORK/code.fd" \
  -drive if=virtio,format=qcow2,file="$WORK/disk.qcow2" \
  -drive if=virtio,format=raw,readonly=on,file="$WORK/seed.iso" \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$PORT-:22 -device virtio-net-pci,netdev=n0 \
  -display none -serial file:"$OUT/console.log" -daemonize -pidfile "$PIDFILE"
SSH=(ssh -q -i "$WORK/key" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@127.0.0.1)
for _ in $(seq 1 90); do "${SSH[@]}" true 2>/dev/null && break; sleep 4; done
"${SSH[@]}" true || { echo "the arm64 VM did not come up (see $OUT/console.log)" >&2; exit 1; }
say "VM up; installing Node $NODE_V (official arm64 archive)"
"${SSH[@]}" "set -e; export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=600 update -q >/dev/null; apt-get -o DPkg::Lock::Timeout=600 install -y -q xz-utils file >/dev/null
  curl -fsSL https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-linux-arm64.tar.xz -o /tmp/node.tar.xz
  want=\$(curl -fsSL https://nodejs.org/dist/v$NODE_V/SHASUMS256.txt | awk '\$2==\"node-v$NODE_V-linux-arm64.tar.xz\"{print \$1}')
  echo \"\$want  /tmp/node.tar.xz\" | sha256sum -c - >/dev/null
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1" > "$OUT/setup.log" 2>&1
say "sending binaries and the working tree"
tar -C "$BINS" -czf - aarch64-unknown-linux-gnu | "${SSH[@]}" 'mkdir -p /root/bins && tar -xzf - -C /root/bins'
COPYFILE_DISABLE=1 tar -C "$REPO" --no-xattrs -czf - --exclude=node_modules --exclude=./rust --exclude=./apps/mobile --exclude=./apps/builder-mac \
  --exclude=./apps/builder-windows --exclude=./store --exclude=./gym-results --exclude='*.tsbuildinfo' --exclude=./.git \
  --exclude='./apps/*/dist' --exclude='./packages/*/dist' . | "${SSH[@]}" 'mkdir -p /root/fs && tar --no-same-owner -xzf - -C /root/fs'
if [ -n "$TESTS" ]; then
  say "running the aarch64 test executables natively"
  COPYFILE_DISABLE=1 tar -C "$REPO" --no-xattrs -czf - --exclude=./rust/target --exclude='*/fuzz/target' rust | "${SSH[@]}" 'tar --no-same-owner -xzf - -C /root/fs'
  "${SSH[@]}" 'mkdir -p /root/fs/rust && tar -xzf - -C /root/fs/rust' < "$TESTS"
  "${SSH[@]}" 'cd /root/fs/rust; rc=0; for t in target/aarch64-unknown-linux-gnu/debug/deps/*; do [ -x "$t" ] || continue
      c=$(basename "$t" | sed "s/-[0-9a-f]*$//"); case $c in flagship_*) d=crates/$(echo "$c" | tr _ -) ;; *) d=$(dirname $(grep -l "" crates/*/tests/$c.rs | head -1))/.. ;; esac
      echo "== $t ($d)"; (cd "$d" && "/root/fs/rust/$t" 2>&1 | grep -E "^test result|FAILED|panicked") || rc=1; done; exit $rc' 2>&1 | tee "$OUT/tests-native.log" || true
fi
say "running on native arm64"
"${SSH[@]}" "set -e; cd /root/fs; B=/root/bins/aarch64-unknown-linux-gnu
  (nproc; free -m; uname -r; uname -m; grep -m1 -i 'model\|implementer' /proc/cpuinfo || true) > /root/machine.txt
  file \$B/* | sed 's/, BuildID.*//'; for b in \$B/*; do echo \"\$(basename \$b): \$(\$b --version 2>&1 | head -1)\"; done
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null && { NODE_OPTIONS=--max-old-space-size=3072 npx tsc -b > /root/tsc.log 2>&1 || { tail -30 /root/tsc.log; exit 1; }; }
  rm -f /root/bench.jsonl
  for b in \$(echo $BENCHES | tr , ' '); do case \$b in
    startup) npx tsx scripts/bench/startup.ts --bin-dir \$B --out /root/bench.jsonl ;;
    relay) npx tsx scripts/bench/relay.ts --relay-bin \$B/flagship-relay --out /root/bench.jsonl ;;
    *) npx tsx scripts/bench/\$b.ts --bin-dir \$B --out /root/bench.jsonl || echo \"\$b bench failed\" ;;
  esac; done
  cat /root/machine.txt" 2>&1 | tee "$OUT/bench.log"
"${SSH[@]}" 'cat /root/bench.jsonl' > "$OUT/bench-arm64.jsonl" || true
say "results in $OUT"
