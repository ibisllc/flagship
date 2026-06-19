#!/usr/bin/env bash
#
# gym:total — the OVERNIGHT comprehensive gate.
#
# Two halves:
#   1. The full DETERMINISTIC mock matrix (= `gym:locked`): every fixture-backed
#      frontend scenario across web · iOS · iPad · Android, NO cloud, NO backend.
#   2. The REAL-CLOUD live e2e: provisions actual gym Hetzner boxes and drives the
#      whole backend chain (provision → register → tunnel → LE cert → serve →
#      owner-IRK API → service install/serve/manage → vibe/git BYOK) AND the
#      service-access GATING e2e (restricted service + the three invite tiers),
#      then TEARS DOWN every box it created. This is why it's an overnight run.
#
# Secrets come from the gitignored .gym-secrets.env (GYM_ADMIN_SECRET at minimum;
# GYM_DEMO_IRK_KEK + GYM_AI_API_KEY unlock the signed + BYOK-model checks). With
# NO secrets present the cloud half is SKIPPED (clean message) and only the mock
# matrix runs — so this is safe to invoke anywhere.
#
# Verdict (exit code): 0 = everything that ran passed · 1 = a phase FAILED ·
# 3 = mock matrix passed but the cloud half was skipped (no secrets).
#
# Each live driver provisions + tears down its OWN fresh box (self-cleaning, so an
# unattended overnight run never leaks billing even if it dies mid-phase). To
# reuse one box instead (faster, but you must delete it), export
# LIVE_E2E_REUSE_USER=<user> before running.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
REPO="$(pwd)"

SECRETS="$REPO/.gym-secrets.env"
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
phase "PHASE 1/3 — deterministic frontend matrix (gym:locked, no cloud)"
if npm run --silent gym:locked; then
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

# ── Phase 2: live backend e2e (real box, full chain, self-teardown) ─────────────
phase "PHASE 2/3 — live backend e2e (provisions a REAL box → drives the chain → tears down)"
if npx tsx tools/live-e2e/run.ts; then
  echo "✓ live backend e2e PASSED"
else
  echo "✗ live backend e2e FAILED"
  fail=1
fi

# ── Phase 3: live service-access GATING e2e (real box, self-teardown) ───────────
phase "PHASE 3/3 — live gating e2e (restricted service + the 3 invite tiers, real box → tears down)"
if npx tsx tools/live-e2e/gating-drive.ts; then
  echo "✓ live gating e2e PASSED"
else
  echo "✗ live gating e2e FAILED"
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
