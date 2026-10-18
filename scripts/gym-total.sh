#!/usr/bin/env bash
#
# gym:total — the OVERNIGHT comprehensive gate.
#
# Two halves:
#   1. The full DETERMINISTIC mock matrix (= `gym:locked`): every fixture-backed
#      frontend scenario across web · iOS · iPad · Android, NO cloud, NO backend.
#   2. The REAL-CLOUD live run (tools/live-e2e/shared-run.ts): provisions ONE
#      shared fleet of UpCloud gym boxes (account A with two boxes, account B
#      with one), runs every scenario group against it (backend chain, access
#      gating, enforcement controls, server order, runtimes, access lists,
#      sharing, app copy, update, revoke/delete), then TEARS the fleet DOWN.
#
# Secrets come from the gitignored .gym-secrets.env (GYM_ADMIN_SECRET at minimum;
# GYM_DEMO_IRK_KEK + GYM_AI_API_KEY unlock the signed + BYOK-model checks). With
# NO secrets present the cloud half is SKIPPED (clean message) and only the mock
# matrix runs — so this is safe to invoke anywhere.
#
# Verdict (exit code): 0 = everything that ran passed · 1 = a phase FAILED ·
# 3 = mock matrix passed but the cloud half was skipped (no secrets).
#
# The fleet is torn down at the end, on failure and on a signal. To keep it
# for a rerun, call shared-run.ts --keep / --reuse <fleet.json> directly.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
REPO="$(pwd)"

SECRETS="${GYM_SECRETS_FILE:-$REPO/.gym-secrets.env}"
if [ ! -f "$SECRETS" ]; then
  common="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common" ] && [ -f "$(dirname "$common")/.gym-secrets.env" ] && SECRETS="$(dirname "$common")/.gym-secrets.env"
fi
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
  echo "▸ loaded gym secrets from .gym-secrets.env"
else
  echo "▸ no .gym-secrets.env — the cloud half needs it (see docs/runbooks/gym-test-env.md)"
fi

# The live drivers accept GYM_ADMIN_SECRET or FLAGSHIP_ADMIN_SECRET; normalize so
# either name in the secrets file works.
export FLAGSHIP_ADMIN_SECRET="${FLAGSHIP_ADMIN_SECRET:-${GYM_ADMIN_SECRET:-}}"
export GYM_ADMIN_SECRET="${GYM_ADMIN_SECRET:-${FLAGSHIP_ADMIN_SECRET:-}}"

fail=0
phase() { echo; echo "════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════"; }

# ── Phase 1: the deterministic mock matrix (no cloud) ───────────────────────────
phase "PHASE 1/2 — deterministic frontend matrix (gym:locked, no cloud)"
if [ "${GYM_SKIP_MOCKS:-0}" = "1" ]; then
  echo "▸ GYM_SKIP_MOCKS=1: mock matrix skipped"
elif npm run --silent gym:locked; then
  echo "✓ mock matrix PASSED"
else
  echo "✗ mock matrix FAILED"
  fail=1
fi

# ── Cloud gate: need an admin secret to provision real boxes ────────────────────
if [ -z "${GYM_ADMIN_SECRET:-}" ]; then
  phase "CLOUD HALF — SKIPPED (no GYM_ADMIN_SECRET)"
  echo "Populate .gym-secrets.env (GYM_ADMIN_SECRET + GYM_DEMO_IRK_KEK + GYM_AI_API_KEY)"
  echo "to provision real servers. The mock-matrix verdict above still stands."
  if [ "$fail" -eq 0 ]; then exit 3; else exit 1; fi
fi

# ── Phase 2: the live run on one shared UpCloud fleet (always torn down) ────────
# Exit 0 = every group green · 1 = a check failed (a control bypassed counts) ·
# 3 = nothing failed but something was SKIPPED (inconclusive, never a pass).
# DNS canary first (30 s, throwaway names): a challenge TXT must not darken a name
# (docs/wildcard-dns.md "Live verification"). Needs GYM_DNS_TOKEN; skipped without it.
if [ -n "${GYM_DNS_TOKEN:-}" ]; then
  if npx tsx tools/live-e2e/dns-ent-experiment.ts --canary >/dev/null; then
    echo "✓ DNS canary: a challenge TXT leaves the box's names answering"
  else
    echo "✗ DNS canary FAILED: a challenge TXT darkened a name (docs/wildcard-dns.md section 11)"
    fail=1
  fi
fi
phase "PHASE 2/2 — live run on a shared UpCloud fleet (provision → every group → teardown)"
npx tsx tools/live-e2e/shared-run.ts ${GYM_LIVE_GROUPS:+--groups "$GYM_LIVE_GROUPS"}
live_rc=$?
if [ "$live_rc" -eq 0 ]; then
  echo "✓ live run PASSED"
elif [ "$live_rc" -eq 3 ]; then
  echo "· live run SKIPPED (inconclusive — a group couldn't run)"
else
  echo "✗ live run FAILED"
  fail=1
fi

# ── Verdict ─────────────────────────────────────────────────────────────────────
phase "VERDICT"
if [ "$fail" -eq 0 ]; then
  echo "✓ gym:total OK — the frontend matrix AND the real-cloud e2e are all green."
else
  echo "✗ gym:total FAILED — see the phase markers above. Artifacts under gym-results/."
fi
exit "$fail"
