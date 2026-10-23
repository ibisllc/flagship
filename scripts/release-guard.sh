#!/usr/bin/env bash
# Release guard — fail a RELEASE build if a dev-mode bring-up backdoor is still
# present in the shipping source.
#
# WHY THIS EXISTS (CLAUDE.md → "GA close-out TODO" Bucket-C item 4):
# A forgotten backdoor must never silently ship. This gate makes a build FAIL
# while one is live in source.
#
# The burn-time LUKS passphrase (GA close-out item 2) is GONE: the installer
# generates a random one per install, the bootstrap removes it and fails the
# install unless exactly one key slot remains. So, in EVERY build (dev too),
# this guard fails if:
#   (L1) a constant install-time passphrase is defined or a
#        `flagship-build-time-luks...` / `flagship-burn-time-luks...` string
#        returns anywhere in shipping source;
#   (L2) the key removal is disabled again (`if false; then` anywhere in
#        packages/flagship-builder/src);
#   (L3) the bootstrap in userdata.ts adds a LUKS key but no longer removes the
#        old one, or no longer calls flagship_assert_single_luks_slot after
#        `cryptsetup luksRemoveKey`.
# The VM appliance's published FACTORY key (APPLIANCE_FACTORY_KEY in
# appliance.ts) is a different thing: the image holds no owner data and the
# specializer removes and verifies that slot.
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
# DESIGN — what it flags vs. what it tolerates (dev-mode bring-up markers):
# The builder already carries a `stripDebugFeatures()` defense (userdata.ts /
# UserData.swift) that REMOVES the debug account + banner from every production
# image and throws if a marker survives. That function — and the tests that prove
# it — legitimately MENTION the `debug:flagship` marker (in a strip regex / an
# assertion) even though they are the defense, not the backdoor. So this gate does
# NOT just grep for the bare string everywhere; it targets the LOAD-BEARING
# definitions that constitute an actually-shippable backdoor:
#   - a `useradd … debug` outside the gate, which bakes the account into a
#     real image,
# and it explicitly skips test files + the documented strip machinery.
#
# HOW THE RELEASE PATH IS TRIGGERED:
#   RELEASE=1 bash scripts/release-guard.sh
# In dev / PR / gym (RELEASE unset or != 1) it prints what it found and exits 0
# (advisory), except for a debug-password finding (header (a)/(c)) and a LUKS
# finding (L1-L3), which always exit 1. In CI it is wired as a separate `release-guard` job that only runs
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
  done < <(scan_source_files "$pattern")
}

# Every source file's matches as "<abs path>:<line>:<text>". In a git checkout only the files git
# knows (tracked, or untracked and not ignored): walking the tree also walks .claude/worktrees,
# node_modules and build output, which hangs the guard in a checkout with many worktrees.
scan_source_files() {
  local pattern="$1"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -z "$(git -C "$root" rev-parse --show-prefix)" ]; then
    (cd "$root" && git ls-files -z --cached --others --exclude-standard -- '*.ts' '*.swift' '*.kt' '*.sh' '*.mjs' '*.js' \
      | xargs -0 grep -InE "$pattern" /dev/null 2>/dev/null | sed "s#^#$root/#")
  else
    grep -rInE "$pattern" \
      --include="*.ts" --include="*.swift" --include="*.kt" --include="*.sh" \
      --include="*.mjs" --include="*.js" \
      "$root" 2>/dev/null
  fi
}

# (L1) No constant install-time LUKS passphrase, in any form. Fails every run.
luks_start=${#findings[@]}
scan "install-time LUKS passphrase constant" \
  'flagship-(build|burn)-time-luks|(BURN_PASSPHRASE|burnPassphrase)[[:space:]]*(:[^=]*)?=[[:space:]]*["'"'"'`]'

# (L2) The key removal must never be switched off again.
if [ -d "$root/packages/flagship-builder/src" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    findings+=("LUKS key removal disabled"$'\t'"$hit")
  done < <(grep -rInE 'if false; then' --include="*.ts" "$root/packages/flagship-builder/src" 2>/dev/null)
fi

# (L3) userdata.ts: a bootstrap that adds a LUKS key must remove the old one and
# prove a single slot after it.
LUKS_BOOTSTRAP_REL="packages/flagship-builder/src/userdata.ts"
if [ -f "$root/$LUKS_BOOTSTRAP_REL" ] && grep -qF 'cryptsetup luksAddKey' "$root/$LUKS_BOOTSTRAP_REL"; then
  remove_line="$(grep -nF 'cryptsetup luksRemoveKey' "$root/$LUKS_BOOTSTRAP_REL" | head -n1 | cut -d: -f1)"
  assert_line="$(grep -nF 'flagship_assert_single_luks_slot "$ROOT_LUKS_PART"' "$root/$LUKS_BOOTSTRAP_REL" | head -n1 | cut -d: -f1)"
  if [ -z "$remove_line" ]; then
    findings+=("LUKS key removal missing"$'\t'"$LUKS_BOOTSTRAP_REL: adds a LUKS key but never runs 'cryptsetup luksRemoveKey'")
  elif [ -z "$assert_line" ] || [ "$assert_line" -le "$remove_line" ]; then
    findings+=("LUKS single-slot proof missing"$'\t'"$LUKS_BOOTSTRAP_REL: 'flagship_assert_single_luks_slot' is not called after 'cryptsetup luksRemoveKey'")
  fi
fi
luks_count=$(( ${#findings[@]} - luks_start ))

# (I) The install and update path resolves nothing from a package repository, a source host or a
# compiler (SEC-INSTALL-001, SEC-NODE-001, SEC-UPD-001). Every box gets the signed release artifact
# for an exact commit; its Node ships inside it. Fails every run, dev included, when the bootstrap
# builders or the daemon's update code go back to NodeSource, git, npm or a Go toolchain, or when a
# recipe default names a branch. Comment lines are not code and are skipped.
install_start=${#findings[@]}
for rel in packages/flagship-builder/src/userdata.ts packages/flagship-builder/src/appliance.ts \
           packages/control-plane/src/demoCloudConfig.ts \
           packages/server-daemon/src/updateConsumer.ts packages/server-daemon/src/updateGuard.ts \
           packages/server-daemon/src/updateHealthGate.ts packages/server-daemon/src/artifactUpdate.ts; do
  [ -f "$root/$rel" ] || continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    text="${hit#*:}"
    case "$(printf '%s' "$text" | sed 's/^[[:space:]]*//')" in '#'*|'//'*|'*'*|'/*'*) continue ;; esac
    findings+=("install path resolves code from the network"$'\t'"$rel:$hit")
  done < <(grep -nE 'deb\.nodesource\.com|golang-go|git clone|npm (install|ci)\b|npx (tsx|tsc)|"npm"|"npx"|runner\("git"|apt-get install[^\n]*nodejs' "$root/$rel" 2>/dev/null)
done
for rel in packages/flagship-builder/src/userdata.ts packages/control-plane/src/demoAccountProvisioning.ts packages/control-plane/src/gymProvision.ts; do
  [ -f "$root/$rel" ] || continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    findings+=("recipe defaults to a branch"$'\t'"$rel:$hit")
  done < <(grep -nE 'installerGitRef[^;]*\|\|[[:space:]]*"main"|installerGitRef[^;]*\?\?[[:space:]]*"main"' "$root/$rel" 2>/dev/null)
done
install_count=$(( ${#findings[@]} - install_start ))

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

# Accounts are never bulk-wiped after GA (AGENTS.md Conventions): the pre-GA
# scrub tooling was deleted once it had run (git history keeps it). Any
# scripts/wipe-all-users* file that reappears fails every build, dev included.
wipe_start=${#findings[@]}
for f in "$root"/scripts/wipe-all-users*; do
  if [ -e "$f" ]; then
    findings+=("bulk user-wipe tooling reappeared"$'\t'"scripts/$(basename "$f")")
  fi
done
wipe_count=$(( ${#findings[@]} - wipe_start ))

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

if [ "$install_count" -gt 0 ]; then
  echo >&2
  echo "::error::The install and update path must use the signed box artifact only: no NodeSource," >&2
  echo "git clone, npm or Go toolchain on a box, and no recipe default that names a branch" >&2
  echo "(installer/install-box-artifact.sh, docs SECURITY-HARDENING-PLAN.md section 8.2)." >&2
  exit 1
fi

if [ "$luks_count" -gt 0 ]; then
  echo >&2
  echo "::error::The install-time LUKS key must be random per install, removed by the bootstrap" >&2
  echo "and proven gone (flagship_assert_single_luks_slot). A constant passphrase, a disabled" >&2
  echo "removal or a missing single-slot proof fails every build, dev included" >&2
  echo "(docs/luks-burn-passphrase-removal.md)." >&2
  exit 1
fi

if [ "$wipe_count" -gt 0 ]; then
  echo >&2
  echo "::error::scripts/wipe-all-users* is back. Accounts are never bulk-wiped after GA;" >&2
  echo "delete the file (it lives on in git history) instead of shipping a way to wipe users." >&2
  exit 1
fi

release="${RELEASE:-}"
if [ "$release" = "1" ] || [ "$release" = "true" ]; then
  echo >&2
  echo "::error::RELEASE build but a dev-mode backdoor is still present (AGENTS.md → GA close-out)." >&2
  echo "A debug user outside debugAccessGate.ts is a regression: owner debug access" >&2
  echo "ships ONLY from that file." >&2
  exit 1
fi

echo >&2
echo "release-guard: dev/PR build (RELEASE!=1) — backdoors are EXPECTED in dev; not failing." >&2
echo "              run with RELEASE=1 to enforce the release gate." >&2
exit 0
