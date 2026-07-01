#!/usr/bin/env bash
# Admin-authority guard — Slice D §3.4 (docs/device-admin-tier-spec.md).
#
# WHY THIS EXISTS:
# Every `.com` SENSITIVE op (the "Com" rows of the §2 enforcement table —
# custom-domain, luks-lease deposit/revoke, cert soft/hard revoke, account +
# servers self-delete, server decommission, transfer offer/claim, release-name,
# watch-delegate mint/revoke, entitlement-revocation-list, service-invite
# create/revoke, and the admin-scope device-grant mint) MUST authorize the order
# through the GATED master-admin path (`authorizeSensitiveComOp` /
# `requireMasterAdmin`), never by verifying the order directly against the raw
# owner-IRK (`userRec.irkPubHex`, `owner.irkPubHex`, `acquirer.irkPubHex`,
# `irkPub`, `ownerIrkPub`, …). The gate falls back to the legacy owner-IRK
# verify ONLY when no admin master root is pinned — that fallback lives INSIDE
# the shared helper, so no handler should pass an IRK token to a `verify*` call.
#
# This gate is the correctness invariant that keeps a NEW (or a regressed)
# sensitive handler from silently re-introducing a raw owner-IRK verify and
# bypassing the authority split. For each allowlisted `file:function` it asserts,
# within that function's body:
#   1. a gate token is present   (authorizeSensitiveComOp | requireMasterAdmin
#                                  | signerRoot — the mint discriminator), and
#   2. NO sensitive `verify<Op>(…)` call passes a forbidden owner-IRK token as
#      its trusted-key argument.
#
# ENFORCEMENT MODE (mirrors scripts/release-guard.sh):
#   ADMIN_AUTHORITY_ENFORCE=1 bash scripts/admin-authority-guard.sh   → fail on a violation
# Default (PR / dev): ADVISORY — it prints any violation but exits 0, so a normal
# PR is never blocked. CI wires the enforcing path on the same triggers as the
# release guard (see .github/workflows/admin-authority-guard.yml). A self-test
# lives at scripts/admin-authority-guard.test.ts.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# Scan the repo root by default. ADMIN_AUTHORITY_GUARD_ROOT overrides the scanned
# tree — used ONLY by the self-test to point at a fixture. Production never sets it.
root="$(cd "${ADMIN_AUTHORITY_GUARD_ROOT:-$here/..}" && pwd)"

# The SENSITIVE `.com` handlers, as `<relpath>|<function>` pairs. This list is the
# single source of truth for "which handlers must route through the gate"; a unit
# test cross-checks it against the §2 table. A new sensitive handler added without
# the gate trips this guard.
SENSITIVE_HANDLERS=(
  "packages/control-plane/src/customDomain.ts|handleSetCustomDomain"
  "packages/control-plane/src/certRevocation.ts|handleSoftRevoke"
  "packages/control-plane/src/certRevocation.ts|handleHardRevoke"
  "packages/control-plane/src/accountDeletion.ts|handleAccountDeletionBundle"
  "packages/control-plane/src/serverDecommission.ts|handlePostDecommission"
  "packages/control-plane/src/serverTransfer.ts|handlePostTransferOffer"
  "packages/control-plane/src/serverTransfer.ts|handlePostTransferClaim"
  "packages/control-plane/src/serverRevoke.ts|handleServerReleaseName"
  "packages/control-plane/src/watchDelegates.ts|handleMintWatchDelegate"
  "packages/control-plane/src/watchDelegates.ts|handleRevokeWatchDelegate"
  "packages/control-plane/src/entitlementRevocations.ts|handlePostEntitlementRevocations"
  "packages/control-plane/src/luksKeys.ts|handleDepositAutoUnlockLease"
  "packages/control-plane/src/luksKeys.ts|handleRevokeAutoUnlockLease"
  "packages/control-plane/src/serviceInvites.ts|handleCreateServiceInvite"
  "packages/control-plane/src/serviceInvites.ts|handleRevokeServiceInvite"
  "packages/control-plane/src/secretMailbox.ts|handlePostSetLeaderDeposit"
  "packages/control-plane/src/deviceCapabilityGrants.ts|handleMintDeviceGrant"
)

# A gate token proves the handler routes authorization through the master-admin
# path. `signerRoot` covers the admin-scope grant-mint discriminator (§3.3),
# which uses the admin-root-vs-membership split directly rather than the shared
# order helper.
GATE_TOKENS='authorizeSensitiveComOp|requireMasterAdmin|signerRoot'

# A forbidden trusted-key token passed to a verify* call = a raw owner-IRK verify
# that skipped the gate. Matches irkPub / *.irkPubHex / ownerIrkPub / irkPublicKey.
FORBIDDEN_KEY='irkPub|irkPubHex|irkPublicKey'

findings=()

# Extract the body of `export async function <func>(` … up to the next top-level
# `export ` (or EOF). Prints the body lines with their original line numbers.
extract_function() {
  local file="$1" func="$2"
  awk -v fn="$func" '
    $0 ~ ("export async function " fn "\\(") { inside=1 }
    inside && NR>start_after {
      # stop at the NEXT export after we entered the function
      if (started && $0 ~ /^export /) { exit }
    }
    inside {
      if ($0 ~ ("export async function " fn "\\(")) { started=1; print NR": "$0; next }
      if (started) print NR": "$0
    }
  ' "$file"
}

for entry in "${SENSITIVE_HANDLERS[@]}"; do
  rel="${entry%%|*}"
  func="${entry#*|}"
  file="$root/$rel"
  if [ ! -f "$file" ]; then
    findings+=("MISSING FILE"$'\t'"$rel|$func — file not found")
    continue
  fi
  body="$(extract_function "$file" "$func")"
  if [ -z "$body" ]; then
    findings+=("MISSING FUNCTION"$'\t'"$rel|$func — function body not found")
    continue
  fi

  # 1. gate token present?
  if ! grep -qE "$GATE_TOKENS" <<<"$body"; then
    findings+=("NO GATE"$'\t'"$rel|$func — no master-admin gate ($GATE_TOKENS) in the function body")
  fi

  # 2. a sensitive verify* call passing a forbidden owner-IRK token?
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    findings+=("RAW OWNER-IRK VERIFY"$'\t'"$rel|$func: $hit")
  done < <(grep -nE "verify[A-Z][A-Za-z]*\(" <<<"$body" | grep -E "$FORBIDDEN_KEY")
done

count="${#findings[@]}"

if [ "$count" -eq 0 ]; then
  echo "admin-authority-guard: OK — every sensitive .com handler routes through the master-admin gate."
  exit 0
fi

echo "admin-authority-guard: found $count sensitive-handler authority violation(s):" >&2
for f in "${findings[@]}"; do
  label="${f%%$'\t'*}"
  loc="${f#*$'\t'}"
  echo "  [$label] $loc" >&2
done

enforce="${ADMIN_AUTHORITY_ENFORCE:-}"
if [ "$enforce" = "1" ] || [ "$enforce" = "true" ]; then
  echo >&2
  echo "::error::A sensitive .com op is not gated on master-admin authority. Route it through" >&2
  echo "authorizeSensitiveComOp / requireMasterAdmin (docs/device-admin-tier-spec.md §3)." >&2
  exit 1
fi

echo >&2
echo "admin-authority-guard: advisory run (ADMIN_AUTHORITY_ENFORCE!=1) — reporting only, not failing." >&2
echo "              run with ADMIN_AUTHORITY_ENFORCE=1 to enforce." >&2
exit 0
