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
# ── GUARDS (CLAUDE.md → "GA close-out TODO" item 1) ───────────────────────────
# This script can delete every user + server in one command. To stop it nuking a
# real prod DB by accident it now requires THREE things to actually delete:
#   1. A row-count PREVIEW runs first and prints what WOULD be deleted. Without
#      --yes the script STOPS there (a dry run); it deletes nothing.
#   2. --yes is required to proceed past the preview.
#   3. WIPE_CONFIRM must equal the target env name (WIPE_ENV, default "prod").
#      This binds the operator's intent to a specific environment so a
#      muscle-memory --yes can't wipe prod when gym was meant.
# An audit line (timestamp · env · D1 · operator · rows) is printed before the
# delete and after it completes.
#
# Usage:
#   # dry run (default) — preview only, deletes nothing:
#   bash scripts/wipe-all-users.sh
#   # really wipe PROD:
#   WIPE_CONFIRM=prod bash scripts/wipe-all-users.sh --yes
#   # wipe the gym/dev DB instead:
#   WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym \
#       bash scripts/wipe-all-users.sh --yes
#
# Env:
#   WIPE_ENV      target env name (default "prod"); WIPE_CONFIRM must match it.
#   WIPE_CONFIRM  must equal WIPE_ENV to authorize a real delete.
#   WIPE_D1       wrangler D1 binding/name (default "flagship-state").
# (needs a shell already authenticated to Cloudflare / wrangler.)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/wipe-all-users-prerelease-2026-06-02.sql"
com_dir="$here/../apps/com"

target_env="${WIPE_ENV:-prod}"
d1="${WIPE_D1:-flagship-state}"

# --yes (or --force) is the only way past the dry-run preview.
proceed=0
for arg in "$@"; do
  case "$arg" in
    --yes|--force) proceed=1 ;;
    --dry-run) proceed=0 ;;
    -h|--help)
      sed -n '2,42p' "$0"; exit 0 ;;
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
  out="$(npx wrangler d1 execute "$d1" --remote \
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
  echo "  WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes"
  exit 0
fi

confirm="${WIPE_CONFIRM:-}"
if [ "$confirm" != "$target_env" ]; then
  echo >&2
  echo "REFUSING TO WIPE: WIPE_CONFIRM must equal the target env." >&2
  echo "  target env   : $target_env" >&2
  echo "  WIPE_CONFIRM : '${confirm:-<unset>}'" >&2
  echo "Re-run with:  WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes" >&2
  exit 1
fi

operator="${USER:-$(id -un 2>/dev/null || echo unknown)}"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "AUDIT $stamp · WIPE START · env=$target_env d1=$d1 operator=$operator approx_rows=$total"

wiped=0; skipped=0
for t in $tables; do
  if npx wrangler d1 execute "$d1" --remote \
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
