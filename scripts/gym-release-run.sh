#!/usr/bin/env bash
#
# The release gate's live gym: refresh the gym, take the gym lock, run EVERY live group (the 0.3 groups
# included), let the runner tear its fleet down, release the lock, and print one summary line. It runs
# twice, once per container stack (arch-v2: every group; classic: the groups covering existing boxes).
# Exits 0 when both are green, 3 when nothing failed but something was skipped (not proven), 5 when
# classic is green but arch-v2 is not (new boxes must be built on classic), 6 when every group is green
# except the policed app browser's (browser-grants: the browser must ship off, release/box-release.json
# `appBrowser`), any other code when classic failed. The browser group's verdict is also written to
# gym-results/release-<stamp>-arch-v2/browser-verdict (pass | fail | skip | off | not-run) and printed
# on its own line.
#
#   bash scripts/gym-release-run.sh [--skip-refresh] [--groups a,b] [--dry-run]
#
# Env (passed through to scripts/gym-refresh.sh): GYM_REFRESH_ARGS (e.g. --skip-fly-deploy when only box code changed), GYM_BASE_REF, GYM_START_REF (e.g. origin/gym-ux to run
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
# Production runs on Workers Paid (2026-10-20), so the 10 ms Free-plan figure is reported, not failed.
export WORKERS_PLAN="${WORKERS_PLAN:-paid}"
if [ "$DRY" = 0 ] && { [ -z "${GYM_ADMIN_SECRET:-}" ] || [ -z "${GYM_DEMO_IRK_KEK:-}" ]; }; then
  echo "✗ GYM_ADMIN_SECRET and GYM_DEMO_IRK_KEK are required (load $SECRETS)" >&2
  exit 2
fi

cd "$REPO"
if [ "$REFRESH" = 1 ]; then
  # shellcheck disable=SC2086
  run bash scripts/gym-refresh.sh ${GYM_REFRESH_ARGS:-}
fi

# Two passes (owner, 2026-10-24: the gym decides what new boxes are built on). arch-v2 runs every
# group on boxes built like a real new box (Podman + the Rust path); classic runs the groups that
# cover the boxes already out there (Docker + TS), which this release updates in place.
STACKS="${GYM_STACKS:-arch-v2 classic}"
CLASSIC_GROUPS="${GYM_CLASSIC_GROUPS:-core,gating,invites,one-list,update,backups,stack-switch}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
report() { # report <run dir> <stack>
  local summary="$1/summary.json"
  if [ -f "$summary" ]; then
    node -e '
      const s = require(process.argv[1]);
      const groups = Object.entries(s.summary ?? {});
      const t = groups.reduce((a, [, g]) => ({ pass: a.pass + g.pass, fail: a.fail + g.fail, skip: a.skip + g.skip }), { pass: 0, fail: 0, skip: 0 });
      console.log(`gym release run (${process.argv[3]}) ${process.argv[2]}: ${groups.length} groups, ${t.pass} passed, ${t.fail} failed, ${t.skip} skipped`);
      for (const [name, g] of groups) if (g.fail || g.skip) console.log(`  ${name}: ${g.pass} passed, ${g.fail} failed, ${g.skip} skipped`);
      console.log(`left after teardown: ${s.gymServersLeft ?? "?"} servers, ${s.gymDnsLeft ?? "?"} DNS records`);
    ' "$REPO/$summary" "$1" "$2" || true
  else
    echo "no summary at $summary (the runner crashed before writing it)"
  fi
}
# The policed browser's verdict, read from one run's summary: off (the release ships it off and the box
# serves none of its routes), pass, fail, skip or not-run; and whether any OTHER group failed.
BROWSER_GROUP=browser-grants
browser_verdict() { # browser_verdict <run dir>  ->  "<verdict> <other groups failed: 0|1>"
  node -e '
    const fs = require("fs");
    const [file, name, appBrowser] = process.argv.slice(1);
    if (!fs.existsSync(file)) { console.log("not-run 1"); process.exit(0); }
    const s = JSON.parse(fs.readFileSync(file, "utf8")).summary ?? {};
    const g = s[name];
    const others = Object.entries(s).some(([n, x]) => n !== name && x.fail > 0) ? 1 : 0;
    const v = !g ? "not-run" : g.fail ? "fail" : g.skip || !g.pass ? "skip" : appBrowser === "true" ? "pass" : "off";
    console.log(`${v} ${others}`);
  ' "$REPO/$1/summary.json" "$BROWSER_GROUP" "$(node -p 'require(process.argv[1]).appBrowser === true' "$REPO/release/box-release.json")"
}
# Boxes install the signed artifact the gym built for ITS tip (gym-refresh phase 4b), named in the gym
# worktree's box release; this checkout's own box release names another commit with no gym artifact.
if [ -z "${GYM_INSTALLER_GIT_REF:-}" ] && [ "$DRY" != 1 ]; then
  GYM_RELEASE_JSON="${GYM_WORKTREE:-$HOME/.cache/flagship/gym-worktree}/release/box-release.json"
  GYM_INSTALLER_GIT_REF="$(node -p 'require(process.argv[1]).commit' "$GYM_RELEASE_JSON" 2>/dev/null || true)"
  [[ "$GYM_INSTALLER_GIT_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "✗ the gym box release names no exact commit ($GYM_RELEASE_JSON)"; exit 2; }
fi
export GYM_INSTALLER_GIT_REF
CODE_ARCH=0 CODE_CLASSIC=0 BROWSER=not-run ARCH_OTHERS_FAILED=0
for STACK in $STACKS; do
  RUN_DIR="gym-results/release-$STAMP-$STACK"
  export GYM_RUN_DIR="$RUN_DIR" GYM_BOX_STACK="$STACK"
  GROUPS_ARG="$ONLY"
  [ "$STACK" = classic ] && [ -z "$ONLY" ] && GROUPS_ARG="$CLASSIC_GROUPS"
  echo "── pass: $STACK${GROUPS_ARG:+ (groups $GROUPS_ARG)}"
  set +e
  run npx tsx tools/live-e2e/shared-run.ts ${GROUPS_ARG:+--groups "$GROUPS_ARG"}
  c=$?
  set -e
  [ "$DRY" = 1 ] && continue
  report "$RUN_DIR" "$STACK"
  if [ "$STACK" = classic ]; then CODE_CLASSIC=$c; else
    CODE_ARCH=$c
    read -r BROWSER ARCH_OTHERS_FAILED < <(browser_verdict "$RUN_DIR")
    echo "$BROWSER" > "$REPO/$RUN_DIR/browser-verdict"
    echo "policed app browser (appBrowser $(node -p 'require(process.argv[1]).appBrowser === true' "$REPO/release/box-release.json")): $BROWSER (written to $RUN_DIR/browser-verdict)"
  fi
done
[ "$DRY" = 1 ] && { echo "dry run: nothing ran"; exit 0; }

# 0 both green · 3 nothing failed but something skipped · 5 classic green, arch-v2 not (build new
# boxes on classic) · 6 everything green but the policed browser (ship it off) · anything else:
# classic failed, the release is blocked.
if [ "$CODE_CLASSIC" != 0 ] && [ "$CODE_CLASSIC" != 3 ]; then
  echo "✗ the classic stack failed (exit $CODE_CLASSIC): boxes already out there would break"; exit "$CODE_CLASSIC"
fi
if [ "$CODE_ARCH" != 0 ] && [ "$CODE_ARCH" != 3 ] && [ "$BROWSER" = fail ] && [ "$ARCH_OTHERS_FAILED" = 0 ]; then
  echo "✗ every group passed except the policed app browser (browser-grants): the app browser must ship off for this release"; exit 6
fi
if [ "$CODE_ARCH" != 0 ] && [ "$CODE_ARCH" != 3 ]; then
  echo "✗ the arch-v2 stack failed (exit $CODE_ARCH); classic is green: new boxes must be built on classic"; exit 5
fi
if [ "$CODE_ARCH" = 3 ] || [ "$CODE_CLASSIC" = 3 ]; then echo "· nothing failed, but something was skipped: not proven"; exit 3; fi
echo "✓ every live check passed on both stacks"
exit 0
