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
# Owner debug access (the `debug` user) is NOT a backdoor — it is a SHIPPING
# feature (owner decisions 2026-07-05 and 2026-10-16): an owner can let their
# own SSH key in for a while. It is consent-as-crypto and SSH-key only: the box
# lets a key in ONLY on a verified admin-signed `flagship/debug-access/v2`
# grant, until it expires or is revoked
# (packages/server-daemon/src/debugAccessGate.ts — the single sanctioned home).
# This guard therefore:
#   (a) FAILS ALWAYS (dev too) on any debug password: a `DEBUG_PASSWORD`
#       constant, a `chpasswd` for the debug user, or `PasswordAuthentication
#       yes` anywhere in shipping source (there is no password debug path);
#   (b) EXEMPTS only the gate from the `useradd debug` scan, and fails a
#       release if that appears anywhere else (an unconditional inline bake);
#   (c) positively ASSERTS the gate still verifies the grant and configures
#       sshd key-only with an expiry on the key (verifyDebugAccessGrant,
#       `AuthenticationMethods publickey`, `PasswordAuthentication no`,
#       `expiry-time=`), so weakening it fails.
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
#   - a `useradd … debug` outside the gate, which bakes the account into a
#     real image,
# and it explicitly skips test files + the documented strip machinery. When the
# owner does Bucket-C items 2+3 (delete BURN_PASSPHRASE, re-enable the
# luksRemoveKey guard), this gate goes green under RELEASE=1.
#
# HOW THE RELEASE PATH IS TRIGGERED:
#   RELEASE=1 bash scripts/release-guard.sh
# In dev / PR / gym (RELEASE unset or != 1) it prints what it found and exits 0
# (advisory), except for a debug-password finding (header (a)/(c)), which
# always exits 1. In CI it is wired as a separate `release-guard` job that only runs
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

# Debug access is SSH-key only. A debug password anywhere — the gate included —
# is a regression that fails every run, dev too (header (a)).
debug_start=${#findings[@]}
scan "debug password (constant)" 'DEBUG_PASSWORD[[:space:]]*='
scan "debug password (chpasswd)" '(debug|DEBUG_).*chpasswd|chpasswd.*(debug|DEBUG_)'
scan "debug password (sshd PasswordAuthentication yes)" 'PasswordAuthentication[[:space:]]+yes'

# The gate must still verify the grant and keep sshd key-only with an expiry
# on the key (header (c)).
if [ -f "$root/$DEBUG_GATE_REL" ]; then
  for need in 'verifyDebugAccessGrant' 'AuthenticationMethods publickey' 'PasswordAuthentication no' 'expiry-time='; do
    if ! grep -qF "$need" "$root/$DEBUG_GATE_REL"; then
      findings+=("debug gate no longer key-only and grant-verified"$'\t'"$DEBUG_GATE_REL: '$need' not found")
    fi
  done
elif grep -rIlq 'debug-access/v2' --include="*.ts" "$root/packages/server-daemon/src" 2>/dev/null; then
  # The gate moved without updating DEBUG_GATE_REL: fail rather than check nothing.
  findings+=("debug gate path stale"$'\t'"$DEBUG_GATE_REL: missing but the daemon handles debug-access/v2 elsewhere")
fi
debug_count=$(( ${#findings[@]} - debug_start ))

# An inline `debug` user outside the gate is an unconditional bake (header (b)).
scan "debug console user (useradd)" \
  'useradd([[:space:]].*[[:space:]]debug([^[:alnum:]_-]|$)|.*DEBUG_USER)' allow-debug-gate

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

if [ "$debug_count" -gt 0 ]; then
  echo >&2
  echo "::error::Debug access must be SSH-key only and grant-verified (debugAccessGate.ts)." >&2
  echo "A debug password or a weakened gate fails every build, dev included." >&2
  exit 1
fi

release="${RELEASE:-}"
if [ "$release" = "1" ] || [ "$release" = "true" ]; then
  echo >&2
  echo "::error::RELEASE build but a dev-mode backdoor is still present. Disarm Bucket-C" >&2
  echo "item 3 before release: delete BURN_PASSPHRASE (+ regenerate the engine bundle and" >&2
  echo "its vendored copies) and re-enable the luksRemoveKey guard (CLAUDE.md → GA close-out TODO)." >&2
  echo "A debug user outside debugAccessGate.ts is a regression: owner debug access" >&2
  echo "ships ONLY from that file." >&2
  exit 1
fi

echo >&2
echo "release-guard: dev/PR build (RELEASE!=1) — backdoors are EXPECTED in dev; not failing." >&2
echo "              run with RELEASE=1 to enforce the release gate." >&2
exit 0
