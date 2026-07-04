#!/usr/bin/env bash
#
# gym:weekly — the ONE unattended command a weekly CI job runs.
#
# Wraps gym:total (the overnight mock matrix + real-cloud e2e) with everything
# an unattended run needs around it:
#
#   Phase 0   warm the gym Fly data plane (scale flagship-services-gym 1 machine
#             up, poll it healthy) + verify the gym Worker health.
#   Phase 0b  re-zero the gym D1 (flagship-state-gym) via the guarded
#             wipe-all-users.sh runner (runbook step 5 — isolation by zeroing).
#             The runner itself HARD-REFUSES a non-prod env pointed at prod's
#             flagship-state, and this script never sets WIPE_ENV=prod.
#   Phase 0c  boot the simulators the native legs need: the newest available
#             iPhone simulator (if none is booted) and the `flagship_gym` AVD
#             headless (if no adb device is up).
#   Phase 1   run scripts/gym-total.sh (mock matrix → live e2e → gating e2e).
#             WEEKLY MEANS FULL: gym-total's exit 3 ("mocks passed, cloud
#             skipped — no secrets") is a FAILURE here, not a soft pass.
#   Phase 2   cleanup (trap EXIT, runs even on failure): scale Fly back to 0
#             and shut down the AVD if WE booted it.
#
# Usage:
#   npm run gym:weekly                      # the whole weekly gate
#   bash scripts/gym-weekly.sh [flags]
#
# Flags:
#   --skip-ios-sim     don't touch the iOS simulator (its leg will self-skip)
#   --skip-avd         don't boot the Android AVD (its leg will self-skip)
#   --skip-sims        both of the above
#   --no-scale-down    leave the gym Fly app scaled up after the run
#   --skip-wipe        don't re-zero the gym D1 (debugging reruns only)
#   --dry-run          walk every phase, execute NOTHING external (also
#                      GYM_WEEKLY_DRY_RUN=1) — the CI-less self-test
#
# Env:
#   GYM_FLY_APP        the gym Fly app (default flagship-services-gym)
#   GYM_HEALTH_URL     gym Worker health (default https://gym.flagshipserver.com/api/health)
#   GYM_WIPE_D1        the gym D1 to wipe (default flagship-state-gym)
#   GYM_WEEKLY_DRY_RUN =1 for --dry-run
#   + everything .gym-secrets.env provides (GYM_ADMIN_SECRET etc — required,
#     because exit 3 fails weekly mode).
#
# Exit: 0 = green; non-zero = any red phase.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 2
REPO="$(pwd)"
export PATH="$HOME/.fly/bin:$PATH"

FLY_APP="${GYM_FLY_APP:-flagship-services-gym}"
HEALTH_URL="${GYM_HEALTH_URL:-https://gym.flagshipserver.com/api/health}"
WIPE_D1_NAME="${GYM_WIPE_D1:-flagship-state-gym}"
DRY="${GYM_WEEKLY_DRY_RUN:-0}"

skip_ios=0 skip_avd=0 scale_down=1 do_wipe=1
for arg in "$@"; do
  case "$arg" in
    --skip-ios-sim) skip_ios=1 ;;
    --skip-avd) skip_avd=1 ;;
    --skip-sims) skip_ios=1; skip_avd=1 ;;
    --no-scale-down) scale_down=0 ;;
    --skip-wipe) do_wipe=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,47p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

started_epoch="$(date +%s)"
phase() { echo; echo "════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════"; }

# In dry-run every external command is PRINTED, never executed. `run` is for
# commands whose failure should fail the phase; `try` tolerates failure.
run() { if [ "$DRY" = "1" ]; then echo "DRY-RUN would exec: $*"; else "$@"; fi; }
try() { if [ "$DRY" = "1" ]; then echo "DRY-RUN would exec: $*"; else "$@" || true; fi; }

# ── secrets (same contract as gym-total.sh) ─────────────────────────────────
SECRETS="$REPO/.gym-secrets.env"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
  echo "▸ loaded gym secrets from .gym-secrets.env"
else
  echo "▸ no .gym-secrets.env — weekly mode REQUIRES the cloud half; this run will fail at Phase 1"
fi
export FLAGSHIP_ADMIN_SECRET="${FLAGSHIP_ADMIN_SECRET:-${GYM_ADMIN_SECRET:-}}"
export GYM_ADMIN_SECRET="${GYM_ADMIN_SECRET:-${FLAGSHIP_ADMIN_SECRET:-}}"

# ── Phase 2 (cleanup) is armed FIRST so it runs whatever happens ────────────
we_booted_avd=0
cleanup() {
  local rc=$?
  phase "PHASE 2 — cleanup (always runs)"
  if [ "$scale_down" -eq 1 ]; then
    echo "▸ scaling $FLY_APP back to 0 machines"
    try flyctl scale count 0 -a "$FLY_APP" --yes
  else
    echo "▸ --no-scale-down: leaving $FLY_APP up"
  fi
  if [ "$we_booted_avd" -eq 1 ]; then
    echo "▸ shutting down the headless AVD we booted"
    try "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" emu kill
  fi
  exit "$rc"
}
trap cleanup EXIT

# ── Phase 0 — warm the gym Fly app + verify both planes ─────────────────────
phase "PHASE 0 — warm up the gym data plane ($FLY_APP)"
# Tolerant: already-at-1 is a no-op; a transient flyctl error is not fatal
# because the health poll below is the real gate.
try flyctl scale count 1 -a "$FLY_APP" --yes

if [ "$DRY" = "1" ]; then
  echo "DRY-RUN would poll: flyctl machines list -a $FLY_APP --json → a machine 'started' (≤5 min)"
  echo "DRY-RUN would poll: curl -fsS $HEALTH_URL → 200 (≤2 min)"
else
  echo "▸ polling for a started machine (up to 5 min)…"
  machine_ok=0
  for _ in $(seq 1 30); do
    if flyctl machines list -a "$FLY_APP" --json 2>/dev/null | grep -q '"state":[[:space:]]*"started"'; then
      machine_ok=1; break
    fi
    sleep 10
  done
  [ "$machine_ok" -eq 1 ] || { echo "✗ no started machine on $FLY_APP after 5 min" >&2; exit 1; }
  echo "✓ $FLY_APP has a started machine"

  echo "▸ verifying the gym Worker: $HEALTH_URL"
  health_ok=0
  for _ in $(seq 1 12); do
    if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then health_ok=1; break; fi
    sleep 10
  done
  [ "$health_ok" -eq 1 ] || { echo "✗ gym Worker health failed: $HEALTH_URL" >&2; exit 1; }
  echo "✓ gym Worker healthy"
fi

# ── Phase 0b — re-zero the gym D1 (runbook step 5) ──────────────────────────
phase "PHASE 0b — wipe the gym DB ($WIPE_D1_NAME)"
if [ "$do_wipe" -eq 0 ]; then
  echo "▸ --skip-wipe: leaving $WIPE_D1_NAME as-is"
elif [ "$WIPE_D1_NAME" = "flagship-state" ]; then
  # Belt to the runner's braces: this script must never even ATTEMPT prod.
  echo "✗ GYM_WIPE_D1 must never be the prod DB (flagship-state)" >&2
  exit 1
else
  # ONE table list (parsed from the canonical .sql by the runner) — never
  # duplicated here. The runner ALSO hard-refuses env≠prod + d1=flagship-state.
  run env WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1="$WIPE_D1_NAME" \
    WIPE_WRANGLER_CONFIG=wrangler.gym.toml \
    bash scripts/wipe-all-users.sh --yes
fi

# ── Phase 0c — boot the simulators the native legs need ─────────────────────
phase "PHASE 0c — simulators (iOS sim + flagship_gym AVD)"
if [ "$skip_ios" -eq 1 ]; then
  echo "▸ --skip-ios-sim: iOS leg will detect-and-skip if nothing is booted"
elif [ "$DRY" = "1" ]; then
  echo "DRY-RUN would: xcrun simctl list … | pick the newest available iPhone | simctl boot (if none booted)"
elif xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
  echo "✓ an iOS simulator is already booted"
else
  # Newest available iPhone = last iPhone line in simctl's version-ordered list.
  udid="$(xcrun simctl list devices available | grep -E "iPhone" | grep -oE "[0-9A-F-]{36}" | tail -1 || true)"
  if [ -n "$udid" ]; then
    echo "▸ booting iOS simulator $udid"
    xcrun simctl boot "$udid" || true
    xcrun simctl bootstatus "$udid" -b || true
    echo "✓ iOS simulator booted"
  else
    echo "▸ no available iPhone simulator found — the iOS leg will self-skip"
  fi
fi

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
if [ "$skip_avd" -eq 1 ]; then
  echo "▸ --skip-avd: Android leg will detect-and-skip if no emulator is up"
elif [ "$DRY" = "1" ]; then
  echo "DRY-RUN would: adb devices | boot flagship_gym -no-window -no-audio (if none) | wait sys.boot_completed"
elif [ -x "$ADB" ] && "$ADB" devices 2>/dev/null | grep -qE "emulator-[0-9]+[[:space:]]+device"; then
  echo "✓ an Android emulator is already up"
elif [ -x "$ANDROID_HOME/emulator/emulator" ] && "$ANDROID_HOME/emulator/emulator" -list-avds 2>/dev/null | grep -qx "flagship_gym"; then
  echo "▸ booting flagship_gym headless"
  "$ANDROID_HOME/emulator/emulator" -avd flagship_gym -no-window -no-audio -no-snapshot >/dev/null 2>&1 &
  we_booted_avd=1
  "$ADB" wait-for-device
  echo "▸ waiting for sys.boot_completed (up to 5 min)…"
  avd_ok=0
  for _ in $(seq 1 60); do
    if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then avd_ok=1; break; fi
    sleep 5
  done
  if [ "$avd_ok" -eq 1 ]; then echo "✓ AVD booted"; else echo "▸ AVD never finished booting — Android leg will self-skip"; fi
else
  echo "▸ no flagship_gym AVD (see docs/runbooks/gym-test-env.md) — the Android leg will self-skip"
fi

# ── Phase 1 — the full gym:total gate ───────────────────────────────────────
phase "PHASE 1 — gym:total (mock matrix → live e2e → gating e2e)"
total_log="${TMPDIR:-/tmp}/gym-weekly-total-$$.log"
total_rc=0
if [ "$DRY" = "1" ]; then
  echo "DRY-RUN would exec: bash scripts/gym-total.sh (tee → $total_log)"
  echo "DRY-RUN: exit 3 (cloud skipped) would be treated as FAILURE — weekly means full"
else
  set +e
  bash scripts/gym-total.sh 2>&1 | tee "$total_log"
  total_rc=${PIPESTATUS[0]}
  set -e
fi

# ── Final one-screen report ─────────────────────────────────────────────────
phase "WEEKLY REPORT"
verdict_of() { # $1=pass-marker  $2=fail-marker
  if [ "$DRY" = "1" ]; then echo "dry-run"; return; fi
  if grep -qF "$1" "$total_log" 2>/dev/null; then echo "PASS"
  elif grep -qF "$2" "$total_log" 2>/dev/null; then echo "FAIL"
  else echo "not-run"; fi
}
mock_v="$(verdict_of "✓ mock matrix PASSED" "✗ mock matrix FAILED")"
live_v="$(verdict_of "✓ live backend e2e PASSED" "✗ live backend e2e FAILED")"
gate_v="$(verdict_of "✓ live gating e2e PASSED" "✗ live gating e2e FAILED")"
results_dir="$(ls -1dt gym-results/*/ 2>/dev/null | head -1 || true)"
elapsed=$(( $(date +%s) - started_epoch ))
printf '  mock matrix : %s\n'  "$mock_v"
printf '  live e2e    : %s\n'  "$live_v"
printf '  gating e2e  : %s\n'  "$gate_v"
printf '  results dir : %s\n'  "${results_dir:-<none>}"
printf '  duration    : %dm%02ds\n' $((elapsed / 60)) $((elapsed % 60))

if [ "$DRY" = "1" ]; then
  echo "  verdict     : DRY-RUN OK (no external command executed)"
  exit 0
fi
if [ "$total_rc" -eq 3 ]; then
  echo "  verdict     : FAILED — cloud half was SKIPPED (no secrets); weekly means FULL" >&2
  exit 1
fi
if [ "$total_rc" -ne 0 ]; then
  echo "  verdict     : FAILED (gym-total exit $total_rc) — see $total_log + gym-results/" >&2
  exit "$total_rc"
fi
echo "  verdict     : OK — weekly gym is green"
exit 0
