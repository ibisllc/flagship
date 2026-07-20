#!/usr/bin/env bash
# Release guard — fail a RELEASE build if a dev-mode bring-up backdoor is still
# present in the shipping source.
#
# WHY THIS EXISTS (CLAUDE.md → "GA close-out TODO" Bucket-C item 4):
# We are still in dev, so a known backdoor is LEFT ENABLED for hardware
# bring-up and MUST be removed before GA (Bucket-C item 3):
#   1. the burn-time LUKS recovery passphrase BURN_PASSPHRASE
#      (`flagship-build-time-luks-rekey-me-immediately`), a kept known constant in
#      packages/flagship-builder/src/userdata.ts + the Swift UserData.swift mirror.
# A forgotten backdoor must never silently ship. This gate makes a RELEASE build
# FAIL while it is still live in source; the normal dev / PR / gym path stays
# GREEN with the constants present (it only runs under RELEASE=1).
#
# The `debug`/`flagship` console account is NOT a backdoor anymore — it is a
# SHIPPING v1 feature (owner decision, 2026-07-05): advanced users can enable
# SSH/console tinkering on their own box. It is consent-as-crypto: the creds
# exist ONLY when the box verifies an owner-IRK-signed `flagship/debug-access/v1`
# grant minted from the phone's biometric-gated Advanced toggle
# (packages/server-daemon/src/debugAccessGate.ts — the single sanctioned home).
# This guard therefore (a) EXEMPTS debugAccessGate.ts from the debug-account
# scans, (b) still FAILS if those creds appear anywhere ELSE (a regression to an
# unconditional inline bake), and (c) positively ASSERTS the gate file still
# routes through verifyDebugAccessGrant — so stripping the verification while
# keeping the creds also fails the release.
#
# DESIGN — what it flags vs. what it tolerates:
# The builder already carries a `stripDebugFeatures()` defense (userdata.ts /
# UserData.swift) that REMOVES the debug account + banner from every production
# image and throws if a marker survives. That function — and the tests that prove
# it — legitimately MENTION the `debug:flagship` marker (in a strip regex / an
# assertion) even though they are the defense, not the backdoor. So this gate does
# NOT just grep for the bare string everywhere; it targets the LOAD-BEARING
# definitions that constitute an actually-shippable backdoor:
#   - the literal BURN_PASSPHRASE assignment, and
#   - the `echo 'debug:flagship' | chpasswd` shell line that bakes the account
#     into a real image,
# and it explicitly skips test files + the documented strip machinery. When the
# owner does Bucket-C items 2+3 (delete BURN_PASSPHRASE, drop the useradd/chpasswd
# block, re-enable the luksRemoveKey guard), this gate goes green under RELEASE=1.
#
# HOW THE RELEASE PATH IS TRIGGERED:
#   RELEASE=1 bash scripts/release-guard.sh
# In dev / PR / gym (RELEASE unset or != 1) it prints what it found and exits 0
# (advisory). In CI it is wired as a separate `release-guard` job that only runs
# on a release trigger (a `release` tag, or the manual workflow_dispatch with
# release=true) — see .github/workflows/release-guard.yml. There is a self-test
# at scripts/release-guard.test.ts.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# Scan the repo root by default. RELEASE_GUARD_ROOT overrides the scanned tree —
# used ONLY by scripts/release-guard.test.ts to exercise the clean (post-GA,
# backdoors-removed) tree against a fixture. Production callers never set it.
root="$(cd "${RELEASE_GUARD_ROOT:-$here/..}" && pwd)"

# Only the shipping source surface. Tests assert the strip works (they must keep
# mentioning the marker), and built dist/ + nested git worktrees + deps are not
# the authoring surface — exclude them so the gate judges source, not artifacts.
# Paths are made relative to $root first, so the root's own location (which may
# itself live under a .claude/worktrees/ path) never trips the worktree filter.
exclude_path() {
  local rel="${1#"$root"/}"
  case "$rel" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .claude/worktrees/*|*/.claude/worktrees/*) return 0 ;;  # NESTED worktrees only
    dist/*|*/dist/*) return 0 ;;
    .build/*|*/.build/*) return 0 ;;                        # SwiftPM outputs
    */android/*/build/*) return 0 ;;                        # Gradle outputs
    tests/*|*/tests/*) return 0 ;;
    Tests/*|*/Tests/*) return 0 ;;
    *.test.ts) return 0 ;;
    *.test.swift) return 0 ;;
    scripts/release-guard.sh) return 0 ;;  # never flag this guard's own doc-comment
    *) return 1 ;;
  esac
}

# The one sanctioned home of the grant-gated debug creds (a v1 FEATURE, not a
# backdoor — see the header). Exempted from the debug-account scans; its grant
# verification is positively asserted below instead.
DEBUG_GATE_REL="packages/server-daemon/src/debugAccessGate.ts"
exempt_debug_gate() {
  [ "${1#"$root"/}" = "$DEBUG_GATE_REL" ]
}

# Each finding is "<marker label>\t<file>:<line>: <text>".
findings=()

scan() {
  local label="$1" pattern="$2" allow_gate="${3:-}"
  # -I skip binary, -n line numbers, -E extended regex, -r recursive.
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    local file="${hit%%:*}"
    exclude_path "$file" && continue
    [ "$allow_gate" = "allow-debug-gate" ] && exempt_debug_gate "$file" && continue
    findings+=("$label"$'\t'"$hit")
  done < <(grep -rInE "$pattern" \
      --include="*.ts" --include="*.swift" --include="*.kt" --include="*.sh" \
      --include="*.mjs" --include="*.js" \
      "$root" 2>/dev/null)
}

# Backdoor 1 — the burn-time LUKS recovery passphrase, as an actual definition.
# Matches the TS `BURN_PASSPHRASE = "...immediately"` and the Swift
# `burnPassphrase = "...immediately"` literal assignments.
scan "burn-time LUKS passphrase" \
  '(BURN_PASSPHRASE|burnPassphrase)[[:space:]]*=[[:space:]]*"flagship-build-time-luks-rekey-me-immediately"'

# Debug-account regression scans. The grant-gated home (debugAccessGate.ts) is
# EXEMPT — that path ships in v1 (see the header). Anywhere else these
# definitions appear is a regression to an unconditional inline bake and fails
# a release. The legacy literal forms stay in the patterns for the same reason.
scan "debug console user (password constant)" \
  'DEBUG_PASSWORD[[:space:]]*=[[:space:]]*"flagship"' allow-debug-gate

scan "debug console user (chpasswd)" \
  "echo '?(debug|\\\$\\{DEBUG_USER\\}):(flagship|\\\$\\{DEBUG_PASSWORD\\})'?[[:space:]]*\\|[[:space:]]*chpasswd" allow-debug-gate

scan "debug console user (useradd)" \
  'useradd([[:space:]].*[[:space:]]debug([[:space:]]|$)|.*DEBUG_USER)' allow-debug-gate

# Positive assertion — the exempted gate must still route its cred writes
# through the owner-grant verification. If someone strips the verify call but
# keeps the creds, the exemption above would otherwise hide it.
if [ -f "$root/$DEBUG_GATE_REL" ]; then
  if ! grep -qE 'verifyDebugAccessGrant' "$root/$DEBUG_GATE_REL"; then
    findings+=("debug gate no longer verifies the owner grant"$'\t'"$DEBUG_GATE_REL: verifyDebugAccessGrant not found")
  fi
elif grep -rInEq 'DEBUG_PASSWORD[[:space:]]*=[[:space:]]*"flagship"' \
    --include="*.ts" "$root/packages" 2>/dev/null; then
  # The gate moved without updating DEBUG_GATE_REL — fail loudly rather than
  # silently exempting nothing (the scans above would already be flagging it).
  findings+=("debug gate path stale"$'\t'"$DEBUG_GATE_REL: missing but debug creds exist elsewhere")
fi

count="${#findings[@]}"

if [ "$count" -eq 0 ]; then
  echo "release-guard: OK — no dev-mode bring-up backdoors found in source."
  exit 0
fi

echo "release-guard: found $count dev-mode bring-up backdoor marker(s) in source:" >&2
for f in "${findings[@]}"; do
  label="${f%%$'\t'*}"
  loc="${f#*$'\t'}"
  echo "  [$label] $loc" >&2
done

release="${RELEASE:-}"
if [ "$release" = "1" ] || [ "$release" = "true" ]; then
  echo >&2
  echo "::error::RELEASE build but a dev-mode backdoor is still present. Disarm Bucket-C" >&2
  echo "item 3 before release: delete BURN_PASSPHRASE (+ regenerate the engine bundle and" >&2
  echo "its vendored copies) and re-enable the luksRemoveKey guard (CLAUDE.md → GA close-out TODO)." >&2
  echo "Debug creds outside debugAccessGate.ts are a regression — the grant-gated debug" >&2
  echo "feature ships in v1 ONLY from that file." >&2
  exit 1
fi

echo >&2
echo "release-guard: dev/PR build (RELEASE!=1) — backdoors are EXPECTED in dev; not failing." >&2
echo "              run with RELEASE=1 to enforce the release gate." >&2
exit 0
