#!/usr/bin/env bash
#
# The release gate's live gym: refresh the gym, take the gym lock, run EVERY live group (the 0.3 groups
# included), let the runner tear its fleet down, release the lock, and print one summary line. Exits
# non-zero on any failure, and 3 when nothing failed but something was skipped (inconclusive), so the
# release script can tell "green" from "not proven".
#
#   bash scripts/gym-release-run.sh [--skip-refresh] [--groups a,b] [--dry-run]
#
# Env (passed through to scripts/gym-refresh.sh): GYM_BASE_REF, GYM_START_REF (e.g. origin/gym-ux to run
# the UX branch's gym), and the gym secrets file (.gym-secrets.env: GYM_ADMIN_SECRET, GYM_DEMO_IRK_KEK).
# GYM_SYNC_REPO (+ GYM_SYNC_BASE_REF, GYM_SYNC_NEXT_REF) turns the upstream-sync group on.
# FLAGSHIP_GYM_LOCK overrides the lock path. The lock is a file naming its holder (release.sh and the
# UX session read it the same way), created with noclobber so two runs cannot both take it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="${FLAGSHIP_GYM_LOCK:-/private/tmp/claude-501/flagship-locks/gym.lock}"
REFRESH=1
DRY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-refresh) REFRESH=0 ;;
    --dry-run) DRY=1 ;;
    --groups) ONLY="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

run() {
  echo "▸ $*"
  [ "$DRY" = 1 ] || "$@"
}

if [ -e "$LOCK" ]; then
  echo "✗ the gym lock is held ($LOCK): another session is using the gym. Owner: $(cat "$LOCK" 2>/dev/null || echo unknown)" >&2
  [ "$DRY" = 1 ] || exit 4
fi
if [ "$DRY" = 0 ]; then
  mkdir -p "$(dirname "$LOCK")"
  ( set -o noclobber; echo "release gate (scripts/gym-release-run.sh) $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$" > "$LOCK" ) 2>/dev/null \
    || { echo "✗ could not take the gym lock (taken meanwhile)" >&2; exit 4; }
  trap 'rm -f "$LOCK"' EXIT
fi

SECRETS="${GYM_SECRETS_FILE:-$REPO/.gym-secrets.env}"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
fi
export FLAGSHIP_ADMIN_SECRET="${FLAGSHIP_ADMIN_SECRET:-${GYM_ADMIN_SECRET:-}}"
export GYM_ADMIN_SECRET="${GYM_ADMIN_SECRET:-${FLAGSHIP_ADMIN_SECRET:-}}"
if [ "$DRY" = 0 ] && { [ -z "${GYM_ADMIN_SECRET:-}" ] || [ -z "${GYM_DEMO_IRK_KEK:-}" ]; }; then
  echo "✗ GYM_ADMIN_SECRET and GYM_DEMO_IRK_KEK are required (load $SECRETS)" >&2
  exit 2
fi

cd "$REPO"
if [ "$REFRESH" = 1 ]; then
  run bash scripts/gym-refresh.sh
fi

RUN_DIR="gym-results/release-$(date -u +%Y%m%dT%H%M%SZ)"
export GYM_RUN_DIR="$RUN_DIR"
set +e
run npx tsx tools/live-e2e/shared-run.ts ${ONLY:+--groups "$ONLY"}
CODE=$?
set -e
[ "$DRY" = 1 ] && { echo "dry run: nothing ran"; exit 0; }

SUMMARY="$RUN_DIR/summary.json"
if [ -f "$SUMMARY" ]; then
  node -e '
    const s = require(process.argv[1]);
    const groups = Object.entries(s.summary ?? {});
    const t = groups.reduce((a, [, g]) => ({ pass: a.pass + g.pass, fail: a.fail + g.fail, skip: a.skip + g.skip }), { pass: 0, fail: 0, skip: 0 });
    console.log(`gym release run ${process.argv[2]}: ${groups.length} groups, ${t.pass} passed, ${t.fail} failed, ${t.skip} skipped`);
    for (const [name, g] of groups) if (g.fail || g.skip) console.log(`  ${name}: ${g.pass} passed, ${g.fail} failed, ${g.skip} skipped`);
    console.log(`left after teardown: ${s.gymServersLeft ?? "?"} servers, ${s.gymDnsLeft ?? "?"} DNS records`);
  ' "$REPO/$SUMMARY" "$RUN_DIR" || true
else
  echo "no summary at $SUMMARY (the runner crashed before writing it)"
fi
case "$CODE" in
  0) echo "✓ every live check passed ($RUN_DIR)" ;;
  3) echo "· nothing failed, but something was skipped: not proven ($RUN_DIR)" ;;
  *) echo "✗ the live gym failed (exit $CODE, $RUN_DIR)" ;;
esac
exit "$CODE"
