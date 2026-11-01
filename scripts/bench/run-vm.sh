#!/usr/bin/env bash
#
# run-vm — the G8/G10 evidence on a throwaway UpCloud Debian 13 VM (amd64): build every box Rust binary for
# x86_64 and aarch64, run the Rust tests natively and (for aarch64) under qemu-user, run the fuzz targets for a
# bounded time, build both box artifacts, and run the benchmarks in scripts/bench. The VM is named
# bench-g10-<phase>-<stamp> and deleted at the end, also on failure, unless --keep.
#
#   bash scripts/bench/run-vm.sh --phases build,test,fuzz,artifact,bench [--plan 8xCPU-32GB] [--zone us-nyc1]
#        [--fuzz-secs 300] [--bins <dir with x86_64 release binaries, for a bench-only VM>] [--out <dir>] [--keep]
#        [--test-arches x86_64,aarch64] [--benches startup,relay,access,ingress] [--fuzz-only <target regex>]
#
# The working tree is sent as it is (no commit needed; node_modules, rust/target, apps/mobile and the Studios are
# left out); the artifact phase makes a throwaway commit of it ON THE VM, because build.ts builds from a commit.
# Results (logs, binaries' hashes and file types, JSON-lines benchmark results, the release binaries as a tarball)
# land in --out (default gym-results/bench-g10-<stamp>). UpCloud has no arm64 machines: aarch64 runs here under
# qemu-user, and natively only on an arm64 host (scripts/bench/arm64-local.sh on an Apple-silicon Mac).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PHASES="build,test" FUZZ_ONLY="." TEST_ARCHES="x86_64,aarch64" BENCHES="startup,relay,access,ingress" VM_KEEP=0 VM_ZONE="us-nyc1" VM_PLAN="" FUZZ_SECS=300 BINS="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phases) PHASES="$2"; shift 2 ;;
    --plan) VM_PLAN="$2"; shift 2 ;;
    --zone) VM_ZONE="$2"; shift 2 ;;
    --fuzz-secs) FUZZ_SECS="$2"; shift 2 ;;
    --fuzz-only) FUZZ_ONLY="$2"; shift 2 ;;
    --bins) BINS="$2"; shift 2 ;;
    --test-arches) TEST_ARCHES="$2"; shift 2 ;;
    --benches) BENCHES="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep) VM_KEEP=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
has() { case ",$PHASES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# The benchmark contract (IMPLEMENTATION-PLAN.md §5.3) names a 4 GiB / 2-vCPU guest; building wants more cores.
[ -n "$VM_PLAN" ] || { if [ "$PHASES" = bench ]; then VM_PLAN="2xCPU-4GB"; else VM_PLAN="8xCPU-32GB"; fi; }
STAMP="$(date -u +%Y%m%dt%H%M%Sz)"
OUT="${OUT:-$REPO/gym-results/bench-g10-$STAMP}"
mkdir -p "$OUT"
export VM_ZONE VM_PLAN VM_KEEP
# shellcheck source=../lib/upcloud-vm.sh
. "$REPO/scripts/lib/upcloud-vm.sh"

vm_up "bench-g10-${PHASES//,/-}-$STAMP" bench-g10
say "sending the working tree"
COPYFILE_DISABLE=1 tar -C "$REPO" --no-xattrs -czf - --exclude=node_modules --exclude=./rust/target --exclude=./apps/mobile --exclude=./apps/builder-mac \
  --exclude=./apps/builder-windows --exclude=./store --exclude=./gym-results --exclude='*.tsbuildinfo' --exclude=./.git \
  --exclude='./apps/*/dist' --exclude='./packages/*/dist' --exclude='*/fuzz/target' --exclude='*/fuzz/artifacts' . \
  | "${VM_SSH[@]}" 'mkdir -p /root/fs && tar --no-same-owner -xzf - -C /root/fs'
vm_toolchains "$REPO" "$OUT/setup.log" || { tail -20 "$OUT/setup.log"; exit 1; }
[ "$PHASES" = bench ] || vm_run "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross cmake qemu-user qemu-user-binfmt file binutils >/dev/null && (cd rust && rustup target add aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu >/dev/null) && echo cross toolchain ready" >>"$OUT/setup.log" 2>&1

CROSS='export CARGO_INCREMENTAL=0 CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUNNER="qemu-aarch64 -L /usr/aarch64-linux-gnu" QEMU_LD_PREFIX=/usr/aarch64-linux-gnu'
PKGS="-p flagship-keyd -p flagship-broker -p flagship-core -p flagship-wasi -p flagship-gpu -p flagship-updater -p flagship-access -p flagship-ingress -p flagship-relay -p flagship-boot"
BIN_NAMES="flagship-keyd flagship-broker flagship-core flagship-wasi-worker flagship-gpud flagship-updater flagship-access flagship-ingress flagship-relay flagship-boot"

if has build; then
  say "building the box binaries for x86_64 and aarch64"
  vm_run "$CROSS; cd rust && for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do s=\$(date +%s); cargo build --release --locked --target \$t $PKGS || exit 1; echo \"\$t release build: \$(( \$(date +%s) - s )) s\"; done
    mkdir -p /root/bins && for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do mkdir -p /root/bins/\$t; for b in $BIN_NAMES; do cp target/\$t/release/\$b /root/bins/\$t/; done; done
    cd /root/bins && file */* && sha256sum */* && ls -l */* && for b in */*; do echo \"\$b: \$(\$([ \${b%%/*} = aarch64-unknown-linux-gnu ] && echo 'qemu-aarch64 -L /usr/aarch64-linux-gnu') ./\$b --version 2>&1 | head -1)\"; done" | tee "$OUT/build.log"
  "${VM_SSH[@]}" 'tar -C /root/bins -czf - .' > "$OUT/bins.tar.gz"
fi

if has test; then
  case ",$TEST_ARCHES," in *,x86_64,*)
  say "cargo test: x86_64 native"
  vm_run "export CARGO_INCREMENTAL=0; cd rust && cargo test --locked --no-fail-fast --workspace --target x86_64-unknown-linux-gnu > /root/test-x86_64.log 2>&1 < /dev/null; rc=\$?; grep -E \"^test result|FAILED|panicked|error: \" /root/test-x86_64.log; exit \$rc" > "$OUT/test-x86_64.log" 2>&1 && say "x86_64 tests green" || say "x86_64 tests FAILED (see test-x86_64.log)" ;; esac
  case ",$TEST_ARCHES," in *,aarch64,*)
  say "cargo test: aarch64 under qemu-user"
  vm_run "$CROSS; cd rust && cargo test --locked --no-fail-fast --workspace --target aarch64-unknown-linux-gnu > /root/test-aarch64.log 2>&1 < /dev/null; rc=\$?; grep -E \"^test result|FAILED|panicked|error: \" /root/test-aarch64.log; exit \$rc" > "$OUT/test-aarch64.log" 2>&1 && say "aarch64 tests green" || say "aarch64 tests FAILED (see test-aarch64.log)" ;; esac
fi

if has fuzz; then
  say "fuzzing, $FUZZ_SECS s per target"
  vm_run "cd rust && rustup toolchain install nightly --profile minimal >/dev/null 2>&1 && cargo install --locked cargo-fuzz >/dev/null 2>&1 && echo cargo-fuzz ready" > "$OUT/fuzz.log" 2>&1
  for dir in crates/flagship-relay/fuzz fuzz; do
    vm_run "cd rust/$dir 2>/dev/null || exit 0; for t in \$(cargo +nightly fuzz list | grep -E '$FUZZ_ONLY'); do echo \"== $dir \$t\"; mkdir -p corpus/\$t; cargo +nightly fuzz run \$t corpus/\$t -- -max_total_time=$FUZZ_SECS -rss_limit_mb=2048 2>&1 | grep -E '^#[0-9]+ +DONE|Done [0-9]+ runs|SUMMARY|ERROR|panicked|crash-' | tail -5; echo \"exit \${PIPESTATUS[0]}\"; done" >> "$OUT/fuzz.log" 2>&1 || true
  done
  "${VM_SSH[@]}" 'cd /root/fs/rust && tar -czf - $(ls -d crates/flagship-relay/fuzz/artifacts fuzz/artifacts 2>/dev/null)' > "$OUT/fuzz-artifacts.tar.gz" 2>/dev/null || true
  grep -E '^== |DONE|Done|exit|SUMMARY|crash' "$OUT/fuzz.log" || true
fi

if has artifact; then
  say "building the box artifact for amd64 and arm64 (throwaway commit of the sent tree)"
  vm_run "git config --global user.email bench@invalid; git config --global user.name bench; git init -q && git add -A >/dev/null && git commit -qm 'bench tree' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && C=\$(git rev-parse HEAD) && $CROSS && for a in amd64 arm64; do npx tsx tools/box-artifact/build.ts build --commit \$C --arch \$a --sequence 1 --out /root/out --repo /root/fs || exit 1; done
    node -e 'process.stdout.write(require(\"node:crypto\").randomBytes(32).toString(\"hex\"))' > /root/throwaway.key
    PUB=\$(node -e 'const c=require(\"node:crypto\");const s=Buffer.from(require(\"node:fs\").readFileSync(\"/root/throwaway.key\",\"utf8\"),\"hex\");const k=c.createPrivateKey({key:Buffer.concat([Buffer.from(\"302e020100300506032b657004220420\",\"hex\"),s]),format:\"der\",type:\"pkcs8\"});console.log(c.createPublicKey(k).export({format:\"der\",type:\"spki\"}).subarray(-32).toString(\"hex\"))')
    echo \"{\\\"keys\\\":[\\\"\$PUB\\\"],\\\"threshold\\\":1,\\\"pq\\\":{\\\"keyIds\\\":[],\\\"legacyManifests\\\":[]}}\" > /root/throwaway-trust.json
    for a in amd64 arm64; do N=flagship-box-\${C:0:12}-\$a; npx tsx tools/box-artifact/build.ts sign --manifest /root/out/\$N.manifest.unsigned.json --out /root/out/\$N.manifest.json --key-file /root/throwaway.key && npx tsx tools/box-artifact/build.ts verify --manifest /root/out/\$N.manifest.json --artifact /root/out/\$N.tar.gz --commit \$C --arch \$a --trust /root/throwaway-trust.json || exit 1
      bash installer/verify-box-artifact.sh --manifest /root/out/\$N.manifest.json --artifact /root/out/\$N.tar.gz --trust-keys \$PUB --threshold 1 --expect-sha256 \$(jq -r .manifest.artifactSha256 /root/out/\$N.manifest.json) --expect-commit \$C --arch \$a || exit 1
      mkdir -p /root/unpack-\$a && tar -xzf /root/out/\$N.tar.gz -C /root/unpack-\$a && echo \"\$a artifact:\" && (cd /root/unpack-\$a && find . -path '*installer/rust/flagship-*' -o -name node -path '*bin*' -o -name flagship-unseal -o -name flagship-tlsd | xargs file | sed 's/, BuildID.*//'); done
    ls -l /root/out" | tee "$OUT/artifact.log"
fi

if has bench; then
  if [ -n "$BINS" ]; then
    say "sending the x86_64 release binaries"
    tar -C "$BINS" -czf - x86_64-unknown-linux-gnu | "${VM_SSH[@]}" 'mkdir -p /root/bins && tar -xzf - -C /root/bins'
  fi
  say "benchmarks on $VM_PLAN"
  vm_run "(nproc; free -m; uname -r; lscpu | grep -E 'Model name|^CPU\\(s\\)') > /root/machine.txt; npm ci --ignore-scripts --no-audit --no-fund >/dev/null && { NODE_OPTIONS=--max-old-space-size=3072 npx tsc -b > /root/tsc.log 2>&1 || { tail -30 /root/tsc.log; exit 1; }; } && B=/root/bins/x86_64-unknown-linux-gnu && rm -f /root/bench.jsonl
    for b in \$(echo $BENCHES | tr , ' '); do case \$b in
      startup) npx tsx scripts/bench/startup.ts --bin-dir \$B --out /root/bench.jsonl ;;
      relay) npx tsx scripts/bench/relay.ts --relay-bin \$B/flagship-relay --out /root/bench.jsonl ;;
      *) npx tsx scripts/bench/\$b.ts --bin-dir \$B --out /root/bench.jsonl || echo \"\$b bench failed\" ;;
    esac; done
    cat /root/machine.txt" | tee "$OUT/bench.log"
  "${VM_SSH[@]}" 'cat /root/bench.jsonl' > "$OUT/bench-amd64.jsonl" || true
fi
say "results in $OUT"
