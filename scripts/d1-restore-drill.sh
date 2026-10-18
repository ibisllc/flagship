#!/usr/bin/env bash
# Rehearse the D1 restore end to end against LOCAL databases, with a throwaway
# age key standing in for the offline one:
#
#   migrate A -> seed rows -> d1-backup.sh --local (export + encrypt)
#     -> decrypt -> import into an EMPTY database B -> compare A and B row for row
#
# It proves the dump file `wrangler d1 export` writes loads into a database that
# has had no migrations run (the export carries the schema), that the encrypted
# file round-trips, and that nothing is lost in the middle. docs/runbooks/
# d1-restore.md has the production steps; this is the same commands on local state.
#
#   bash scripts/d1-restore-drill.sh        (needs network only for npx to fetch wrangler once)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
WRANGLER=(npx --yes wrangler@4.151.0)

echo "== throwaway age key"
age-keygen -o "$W/key.txt" 2>/dev/null
age-keygen -y "$W/key.txt" > "$W/recipient.pub"

# Two scratch projects: wrangler keeps local D1 state next to the config it reads.
for P in A B; do
  mkdir -p "$W/$P"
  cat > "$W/$P/wrangler.toml" <<TOML
name = "drill"
compatibility_date = "2026-05-01"
[[d1_databases]]
binding = "DB"
database_name = "flagship-state"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "$ROOT/packages/storage/migrations"
TOML
done
wr() { local P="$1"; shift; (cd "$W/$P" && "${WRANGLER[@]}" "$@"); }

echo "== database A: migrate and seed"
wr A d1 migrations apply flagship-state --local >/dev/null
wr A d1 execute flagship-state --local --command \
  "INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES ('alice','aa',1),('bob','bb',2),('o''brien','cc',3);" >/dev/null

echo "== back up A"
D1_PROJECT_DIR="$W/A" D1_BACKUP_RECIPIENT_FILE="$W/recipient.pub" \
  bash "$ROOT/scripts/d1-backup.sh" --local "$W/out"
CT="$(ls "$W"/out/*.age)"
node "$ROOT/scripts/d1-backup-freshness.mjs" "$W/out/latest.json" --max-hours 1 >/dev/null

echo "== decrypt and import into an empty database B"
age -d -i "$W/key.txt" "$CT" | gunzip > "$W/restored.sql"
wr B d1 execute flagship-state --local --file "$W/restored.sql" >/dev/null

echo "== compare"
wr A d1 export flagship-state --local --no-schema --output "$W/A.data.sql" >/dev/null
wr B d1 export flagship-state --local --no-schema --output "$W/B.data.sql" >/dev/null
wr A d1 export flagship-state --local --no-data --output "$W/A.schema.sql" >/dev/null
wr B d1 export flagship-state --local --no-data --output "$W/B.schema.sql" >/dev/null
sort "$W/A.data.sql" > "$W/A.d" && sort "$W/B.data.sql" > "$W/B.d"
sort "$W/A.schema.sql" > "$W/A.s" && sort "$W/B.schema.sql" > "$W/B.s"
diff -q "$W/A.d" "$W/B.d"
diff -q "$W/A.s" "$W/B.s"
ROWS="$(grep -c '^INSERT INTO' "$W/B.data.sql" || true)"
TABLES="$(grep -c '^CREATE TABLE' "$W/B.schema.sql" || true)"
grep -q "o''brien" "$W/B.data.sql" || { echo "the quoted row did not survive" >&2; exit 1; }
echo "RESTORE DRILL PASSED: $TABLES tables and $ROWS rows identical after export, encrypt, decrypt and import"
