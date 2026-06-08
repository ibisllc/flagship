#!/usr/bin/env bash
# Tolerant prod user-wipe runner.
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
# Usage:  bash scripts/wipe-all-users.sh
# (needs a shell already authenticated to Cloudflare / wrangler.)
#
# See CLAUDE.md open-work #11: disarm this before serving real users.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/wipe-all-users-prerelease-2026-06-02.sql"
com_dir="$here/../apps/com"

# Pull the table names out of the canonical .sql (no spaces in table names, so
# plain word-splitting is safe + portable to macOS bash 3.2).
tables="$(grep -oiE 'DELETE FROM [a-z_]+' "$sql" | sed -E 's/DELETE FROM //I' | sort -u)"

cd "$com_dir"
wiped=0; skipped=0
for t in $tables; do
  if npx wrangler d1 execute flagship-state --remote \
       --command "DELETE FROM $t;" </dev/null >/dev/null 2>&1; then
    echo "  wiped  $t"; wiped=$((wiped + 1))
  else
    echo "  skip   $t (absent in prod)"; skipped=$((skipped + 1))
  fi
done

echo "done: $wiped wiped, $skipped skipped"
if [ "$wiped" -eq 0 ]; then
  echo "WARNING: nothing wiped — check wrangler auth + the flagship-state binding" >&2
  exit 1
fi
