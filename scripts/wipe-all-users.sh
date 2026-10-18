#!/usr/bin/env bash
# Tolerant prod user-wipe runner — GUARDED.
#
# WHY THIS EXISTS: prod D1's schema drifts from the repo's migration files
# (migrations are applied to prod by hand, ad hoc — not every numbered
# migration is necessarily live). The companion .sql run via
# `wrangler d1 execute --file` is ONE transaction, so the first
# `DELETE FROM <table-not-in-prod>` aborts the whole wipe and nothing is
# deleted. This runner deletes each table INDEPENDENTLY, so a table that
# isn't in prod is SKIPPED instead of fatal — the wipe adapts to whatever
# prod actually has.
#
# The table list is sourced from the canonical .sql so there is one source of
# truth. PRESERVES marketplace_listings (catalog) + CF/SQLite internals.
#
# ── GUARDS (AGENTS.md → "GA close-out" item 1) ────────────────────────────────
# This script can delete every user + server in one command, demo accounts and
# the store-review account included. It cannot be pointed at a database by
# default or by accident:
#   1. WIPE_ENV and WIPE_D1 are REQUIRED. Nothing defaults to prod.
#   2. The pair must be consistent: env "prod" is the PROD database
#      (flagship-state) and nothing else; any other env must name its own D1.
#   3. A row-count PREVIEW runs first. Without --yes the script STOPS there.
#   4. --yes plus WIPE_CONFIRM equal to WIPE_ENV is needed to delete.
#   5. A PROD wipe additionally needs a human at a terminal: stdin must be a
#      TTY and the operator must TYPE the database name. No env var can answer
#      that prompt, so CI, agents and pipes can never wipe prod.
# An audit line (timestamp · env · D1 · operator · rows) is printed before the
# delete and after it completes. scripts/release-guard.sh fails (always, dev
# too) if any of these guards is removed.
#
# Usage:
#   # dry run (preview only, deletes nothing):
#   WIPE_ENV=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh
#   # wipe the gym DB:
#   WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym \
#       WIPE_WRANGLER_CONFIG=wrangler.gym.toml bash scripts/wipe-all-users.sh --yes
#   # wipe PROD (owner at a terminal; you will be asked to type "flagship-state"):
#   WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod \
#       bash scripts/wipe-all-users.sh --yes
#
# Env:
#   WIPE_ENV      target env name (required); WIPE_CONFIRM must match it.
#   WIPE_CONFIRM  must equal WIPE_ENV to authorize a real delete.
#   WIPE_D1       wrangler D1 binding/name (required; prod is "flagship-state").
#   WIPE_WRANGLER_CONFIG  optional wrangler --config path (e.g.
#                 wrangler.gym.toml, relative to apps/com). Unset = prod
#                 behavior unchanged (apps/com/wrangler.toml).
# (needs a shell already authenticated to Cloudflare / wrangler.)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/wipe-all-users-prerelease-2026-06-02.sql"
com_dir="$here/../apps/com"

for arg in "$@"; do
  case "$arg" in -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 0 ;; esac
done

PROD_D1="flagship-state"
target_env="${WIPE_ENV:-}"
d1="${WIPE_D1:-}"
wr_config="${WIPE_WRANGLER_CONFIG:-}"

# GUARD 1: nothing defaults to prod.
if [ -z "$target_env" ] || [ -z "$d1" ]; then
  echo "REFUSING TO RUN: WIPE_ENV and WIPE_D1 are both required (no default target)." >&2
  echo "  e.g. WIPE_ENV=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh" >&2
  exit 1
fi

# GUARD 2: env and database must agree. A non-prod env may NEVER point at the
# prod D1, and "prod" may never point at anything else (so a typo'd WIPE_ENV
# can't borrow prod's weaker-looking path).
if [ "$target_env" != "prod" ] && [ "$d1" = "$PROD_D1" ]; then
  echo "REFUSING TO WIPE: WIPE_ENV='$target_env' but WIPE_D1 is the PROD database ($PROD_D1)." >&2
  echo "A non-prod wipe must name its own D1, e.g.:" >&2
  echo "  WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh --yes" >&2
  exit 1
fi
if [ "$target_env" = "prod" ] && [ "$d1" != "$PROD_D1" ]; then
  echo "REFUSING TO WIPE: WIPE_ENV=prod must name the prod database WIPE_D1=$PROD_D1 (got '$d1')." >&2
  exit 1
fi

# --yes (or --force) is the only way past the dry-run preview.
proceed=0
for arg in "$@"; do
  case "$arg" in
    --yes|--force) proceed=1 ;;
    --dry-run) proceed=0 ;;
    *)
      echo "unknown argument: $arg (try --yes, --dry-run, --help)" >&2; exit 2 ;;
  esac
done

# Pull the table names out of the canonical .sql (no spaces in table names, so
# plain word-splitting is safe + portable to macOS bash 3.2).
tables="$(grep -oiE 'DELETE FROM [a-z_]+' "$sql" | sed -E 's/DELETE FROM //I' | sort -u)"
if [ -z "$tables" ]; then
  echo "ERROR: no DELETE targets parsed from $sql — refusing to run" >&2
  exit 1
fi

cd "$com_dir"

# A scalar count for one table. Prints a number, or "-" when the table is absent
# in this env (the wrangler call fails) so the preview mirrors what the delete
# loop will actually skip. Best-effort: it never aborts the preview.
count_table() {
  local t="$1" out n
  out="$(npx wrangler d1 execute "$d1" ${wr_config:+--config "$wr_config"} --remote \
          --command "SELECT count(*) AS n FROM $t;" --json </dev/null 2>/dev/null)" || {
    echo "-"; return 0;
  }
  # wrangler --json returns [{"results":[{"n":N}],...}]; pull the first integer.
  n="$(printf '%s' "$out" | grep -oE '"n"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$')"
  echo "${n:-0}"
}

echo "── wipe preview ──────────────────────────────────────────────"
echo "  target env : $target_env     D1: $d1"
echo "  tables     : $(printf '%s\n' "$tables" | grep -c .)"
echo "  preserves  : marketplace_listings + CF/SQLite internals"
echo

total=0; present=0; absent=0
for t in $tables; do
  c="$(count_table "$t")"
  if [ "$c" = "-" ]; then
    printf '  %-32s %s\n' "$t" "absent"; absent=$((absent + 1))
  else
    printf '  %-32s %s row(s)\n' "$t" "$c"; present=$((present + 1)); total=$((total + c))
  fi
done
echo
echo "  → would delete ~$total row(s) across $present table(s) ($absent absent)"

# Gate 1 + 2 + 3: require --yes AND a matching WIPE_CONFIRM token.
if [ "$proceed" -ne 1 ]; then
  echo
  echo "DRY RUN — nothing deleted. To really wipe:"
  echo "  WIPE_ENV=$target_env WIPE_D1=$d1 WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes"
  exit 0
fi

confirm="${WIPE_CONFIRM:-}"
if [ "$confirm" != "$target_env" ]; then
  echo >&2
  echo "REFUSING TO WIPE: WIPE_CONFIRM must equal the target env." >&2
  echo "  target env   : $target_env" >&2
  echo "  WIPE_CONFIRM : '${confirm:-<unset>}'" >&2
  echo "Re-run with:  WIPE_ENV=$target_env WIPE_D1=$d1 WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes" >&2
  exit 1
fi

# GUARD 5: production needs a person at a terminal typing the database name.
if [ "$target_env" = "prod" ]; then
  if [ ! -t 0 ]; then
    echo >&2
    echo "REFUSING TO WIPE PRODUCTION: stdin is not a terminal. A prod wipe needs a person" >&2
    echo "typing the database name; no flag or environment variable can answer for them." >&2
    exit 1
  fi
  echo >&2
  echo "THIS DELETES EVERY USER AND SERVER IN PRODUCTION ($d1), demo and store-review accounts included." >&2
  printf 'Type the database name (%s) to continue: ' "$d1" >&2
  typed=""
  read -r typed || true
  if [ "$typed" != "$d1" ]; then
    echo "REFUSING TO WIPE PRODUCTION: typed '${typed}', expected '$d1'." >&2
    exit 1
  fi
fi

operator="${USER:-$(id -un 2>/dev/null || echo unknown)}"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "AUDIT $stamp · WIPE START · env=$target_env d1=$d1 operator=$operator approx_rows=$total"

wiped=0; skipped=0
for t in $tables; do
  if npx wrangler d1 execute "$d1" ${wr_config:+--config "$wr_config"} --remote \
       --command "DELETE FROM $t;" </dev/null >/dev/null 2>&1; then
    echo "  wiped  $t"; wiped=$((wiped + 1))
  else
    echo "  skip   $t (absent in $target_env)"; skipped=$((skipped + 1))
  fi
done

stamp_done="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "AUDIT $stamp_done · WIPE DONE · env=$target_env operator=$operator wiped=$wiped skipped=$skipped"
echo "done: $wiped wiped, $skipped skipped"
if [ "$wiped" -eq 0 ]; then
  echo "WARNING: nothing wiped — check wrangler auth + the '$d1' binding" >&2
  exit 1
fi
