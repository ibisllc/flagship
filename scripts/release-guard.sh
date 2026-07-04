#!/usr/bin/env bash
# Release guard — fail a RELEASE build if a dev-mode bring-up backdoor is still
# present in the shipping source.
#
# WHY THIS EXISTS (CLAUDE.md → "GA close-out TODO" Bucket-C item 4):
# We are still in dev, so two known backdoors are LEFT ENABLED for hardware
# bring-up and MUST be removed before GA (Bucket-C items 2 + 3):
#   1. the burn-time LUKS recovery passphrase BURN_PASSPHRASE
#      (`flagship-burn-time-luks-rekey-me-immediately`), a kept known constant in
#      packages/flagship-burner/src/userdata.ts + the Swift UserData.swift mirror.
#   2. the `debug` / `flagship` console sudo user the burner bakes in for on-box
#      console login during bring-up (`echo 'debug:flagship' | chpasswd`).
# A forgotten backdoor must never silently ship. This gate makes a RELEASE build
# FAIL while either backdoor is still live in source; the normal dev / PR / gym
# path stays GREEN with the constants present (it only runs under RELEASE=1).
#
# DESIGN — what it flags vs. what it tolerates:
# The burner already carries a `stripDebugFeatures()` defense (userdata.ts /
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

# Each finding is "<marker label>\t<file>:<line>: <text>".
findings=()

scan() {
  local label="$1" pattern="$2"
  # -I skip binary, -n line numbers, -E extended regex, -r recursive.
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    local file="${hit%%:*}"
    exclude_path "$file" && continue
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
  '(BURN_PASSPHRASE|burnPassphrase)[[:space:]]*=[[:space:]]*"flagship-burn-time-luks-rekey-me-immediately"'

# Backdoor 2 — the `debug:flagship` console account. Since the 2026-06-30
# console lockdown the inline bootstrap machinery is gone; the account is baked
# ONLY by the owner-grant debug gate (server-daemon debugAccessGate.ts), whose
# known-password constant + templated `echo '…' | chpasswd` line are the
# load-bearing definitions this guard targets. The legacy literal forms stay in
# the patterns so a regression to the old inline bake is also caught.
scan "debug console user (password constant)" \
  'DEBUG_PASSWORD[[:space:]]*=[[:space:]]*"flagship"'

scan "debug console user (chpasswd)" \
  "echo '?(debug|\\\$\\{DEBUG_USER\\}):(flagship|\\\$\\{DEBUG_PASSWORD\\})'?[[:space:]]*\\|[[:space:]]*chpasswd"

# Backdoor 2 (companion) — the `useradd … debug` line for the same account
# (shell form or the gate's argv form ending in DEBUG_USER).
scan "debug console user (useradd)" \
  'useradd([[:space:]].*[[:space:]]debug([[:space:]]|$)|.*DEBUG_USER)'

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
  echo "items 2+3 before release: delete BURN_PASSPHRASE + the debug-user useradd/chpasswd," >&2
  echo "re-enable the luksRemoveKey guard (CLAUDE.md → GA close-out TODO)." >&2
  exit 1
fi

echo >&2
echo "release-guard: dev/PR build (RELEASE!=1) — backdoors are EXPECTED in dev; not failing." >&2
echo "              run with RELEASE=1 to enforce the release gate." >&2
exit 0
