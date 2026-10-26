#!/usr/bin/env bash
#
# full-test-vm — run every test suite of one commit on a throwaway Debian 13 VM (UpCloud), so the
# results do not depend on a loaded laptop: tsc, the full vitest run, cargo fmt/clippy/test/deny,
# the Go tests, the crypto-graph check and the keyd TS<->Rust cross-check (Linux only). The VM is
# deleted at the end, also on failure, unless --keep. Results land in gym-results/full-test-<stamp>/.
#
#   bash scripts/full-test-vm.sh [--commit <sha>] [--keep] [--zone de-fra1] [--plan 8xCPU-32GB]
#
# Needs: ~/.config/flagship/upcloud-token (the gym tooling's token), ssh, curl, python3.
# Every VM it makes carries the label flagship-env=release-test.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="" VM_KEEP=0 VM_ZONE="de-fra1" VM_PLAN="8xCPU-32GB"
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --keep) VM_KEEP=1; shift ;;
    --zone) VM_ZONE="$2"; shift 2 ;;
    --plan) VM_PLAN="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
COMMIT="$(git -C "$REPO" rev-parse "${COMMIT:-HEAD}")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/gym-results/full-test-$STAMP"
mkdir -p "$OUT"
# shellcheck source=lib/upcloud-vm.sh
. "$REPO/scripts/lib/upcloud-vm.sh"

vm_up "release-test-${COMMIT:0:12}-$(echo "$STAMP" | tr "[:upper:]" "[:lower:]")" release-test
vm_send_commit "$REPO" "$COMMIT"
vm_toolchains "$REPO" "$OUT/setup.log"
# cargo-deny is built on the VM; a flaky crates.io fetch once left the suite with "no such command: deny"
# and a false red, so retry and keep the output where setup.log is.
for attempt in 1 2 3; do
  "${VM_SSH[@]}" '/root/.cargo/bin/cargo install --locked cargo-deny' >>"$OUT/setup.log" 2>&1 && break
  say "cargo-deny install failed (attempt $attempt)"
  sleep 10
done

run_suite() { # run_suite <name> <command>: on the VM, output to $OUT/<name>.log, exit code to $OUT/<name>.rc
  say "suite $1"
  set +e
  vm_run "$2" > "$OUT/$1.log" 2>&1
  echo $? > "$OUT/$1.rc"
  set -e
  echo "  exit $(cat "$OUT/$1.rc")"
}
run_suite npm-ci "npm ci --no-audit --no-fund"
run_suite tsc "npx tsc -b"
run_suite vitest "npx vitest run --reporter=default --reporter=json --outputFile=/root/vitest.json"
"${VM_SSH[@]}" cat /root/vitest.json > "$OUT/vitest.json" 2>/dev/null || true
run_suite cargo-fmt "cd rust && cargo fmt --all --check"
run_suite cargo-clippy "cd rust && cargo clippy --all-targets -- -D warnings"
run_suite cargo-test "cd rust && cargo test"
run_suite cargo-deny "cd rust && cargo deny check"
run_suite go-tls-frontend "cd installer/tls-frontend && go test ./..."
run_suite go-unseal "cd installer/unseal-helper && go test ./..."
run_suite crypto-graph "node scripts/crypto-graph-check.mjs"
run_suite keyd-crosscheck "npx vitest run packages/keyd/tests/rustBackend.test.ts"

python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
rows = []
for f in sorted(os.listdir(out)):
    if f.endswith(".rc"):
        rows.append((f[:-3], open(os.path.join(out, f)).read().strip()))
lines = [f"{'OK ' if rc == '0' else 'FAIL'} {name} (exit {rc})" for name, rc in rows]
try:
    v = json.load(open(os.path.join(out, "vitest.json")))
    lines.append(f"vitest: {v['numPassedTests']} passed, {v['numFailedTests']} failed, {v['numPendingTests']} skipped of {v['numTotalTests']}")
    for t in v["testResults"]:
        for a in t["assertionResults"]:
            if a["status"] == "failed":
                lines.append(f"  ✗ {os.path.relpath(t['name'], '/root/fs')} > {a['fullName']}")
except Exception as e:
    lines.append(f"vitest: no json ({e})")
open(os.path.join(out, "SUMMARY.txt"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines[:80]))
PY
echo "results: $OUT"
FAILED=$(grep -c '^FAIL' "$OUT/SUMMARY.txt" || true)
[ "$FAILED" = 0 ]
