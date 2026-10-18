#!/usr/bin/env bash
# Rehearse the D1 restore end to end against LOCAL databases, with a throwaway
# gpg key standing in for the YubiKey:
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
export GNUPGHOME="$W/gnupg"
mkdir -m 700 "$GNUPGHOME"
WRANGLER=(npx --yes wrangler@4.151.0)

echo "== throwaway key"
gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
  --quick-generate-key "drill <drill@example.invalid>" ed25519 cert never
FPR="$(gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}')"
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-add-key "$FPR" cv25519 encr never
gpg --batch --armor --export "$FPR" > "$W/recipient.asc"

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
D1_PROJECT_DIR="$W/A" D1_BACKUP_KEY_FILE="$W/recipient.asc" D1_BACKUP_FPR="$FPR" \
  bash "$ROOT/scripts/d1-backup.sh" --local "$W/out"
CT="$(ls "$W"/out/*.gpg)"
node "$ROOT/scripts/d1-backup-freshness.mjs" "$W/out/latest.json" --max-hours 1 >/dev/null

echo "== decrypt and import into an empty database B"
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --output "$W/restored.sql" --decrypt "$CT"
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
