#!/usr/bin/env bash
# Encrypted backup of the production D1 database (flagship-state).
#
# Why this is a script and not a Worker cron: the old Worker backup made one D1
# call per table (89 on an almost empty database), over the Workers Free plan's
# 50-subrequest limit, and spent about 45 ms of CPU against a 10 ms limit, so on
# Free it never finished. `wrangler d1 export` runs in the platform instead.
#
#   export -> sanity check -> gzip -> age-encrypt to the owner's key -> R2 -> read back
#
# The plaintext never leaves this process: it is written to a temp dir, compressed,
# encrypted, deleted, and only the ciphertext is uploaded. The recipient is the PUBLIC
# age key in .maintainers/backup-recipient.pub; its private half (an age identity
# file) stays offline with the owner, so a leaked bucket, token or workflow reads
# nothing and a restore needs that file (docs/runbooks/d1-restore.md). Until the
# owner replaces the placeholder in the repo this refuses to run, loudly.
#
# Usage (CI: .github/workflows/d1-backup.yml; needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID in the environment):
#   bash scripts/d1-backup.sh                 # remote D1 -> R2
#   bash scripts/d1-backup.sh --local DIR     # local D1 (wrangler dev state) -> DIR, no upload
# Environment:
#   D1_DATABASE   database name           (flagship-state)
#   D1_BACKUP_BUCKET                       (flagship-d1-backups)
#   D1_BACKUP_RECIPIENT_FILE  age public key(s)  (.maintainers/backup-recipient.pub)
#   D1_MIN_TABLES       refuse a dump with fewer CREATE TABLEs (60)
#   D1_PROJECT_DIR      --local only: the directory whose wrangler.toml and .wrangler/state to read
#                       (default apps/com; the restore drill points it at a scratch project)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${D1_DATABASE:-flagship-state}"
BUCKET="${D1_BACKUP_BUCKET:-flagship-d1-backups}"
RECIPIENT_FILE="${D1_BACKUP_RECIPIENT_FILE:-$ROOT/.maintainers/backup-recipient.pub}"
MIN_TABLES="${D1_MIN_TABLES:-60}"
WRANGLER=(npx --yes wrangler@4.151.0)
LOCAL=0
OUT_DIR=""
if [ "${1:-}" = "--local" ]; then
  LOCAL=1
  OUT_DIR="${2:?usage: d1-backup.sh --local DIR}"
fi

# Refuse before touching the database: a placeholder recipient would make every
# backup unreadable, and a missing age binary would only be found after the export.
command -v age >/dev/null || { echo "refusing: the age binary is not installed (apt-get install age)" >&2; exit 1; }
RECIPIENT="$(grep -E '^age1[0-9a-z]{20,}$' "$RECIPIENT_FILE" 2>/dev/null | head -1 || true)"
if [ -z "$RECIPIENT" ]; then
  echo "refusing: $RECIPIENT_FILE holds no age public key (still the placeholder?). The owner replaces it with the output of: age-keygen -y key.txt  (docs/runbooks/final-deploy.md step 1b)" >&2
  exit 1
fi

[ -z "$OUT_DIR" ] || mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y-%m-%d)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SQL="$WORK/flagship-state-$STAMP.sql"
CT="flagship-state-$STAMP.sql.gz.age"

echo "== export $DB ($([ $LOCAL = 1 ] && echo local || echo remote))"
cd "${D1_PROJECT_DIR:-$ROOT/apps/com}"
if [ $LOCAL = 1 ]; then
  "${WRANGLER[@]}" d1 export "$DB" --local --output "$SQL"
else
  "${WRANGLER[@]}" d1 export "$DB" --remote --output "$SQL"
fi
cd "$ROOT"

BYTES="$(wc -c < "$SQL" | tr -d ' ')"
TABLES="$(grep -c '^CREATE TABLE' "$SQL" || true)"
echo "== exported $BYTES bytes, $TABLES tables"
if [ "$TABLES" -lt "$MIN_TABLES" ]; then
  echo "refusing: only $TABLES CREATE TABLE statements (expected at least $MIN_TABLES): a truncated or empty export" >&2
  exit 1
fi
if ! grep -q '^INSERT INTO' "$SQL"; then
  echo "refusing: the export has no rows at all" >&2
  exit 1
fi

echo "== compress and encrypt to $RECIPIENT"
gzip -9 < "$SQL" | age -r "$RECIPIENT" -o "$WORK/$CT"
shred -u "$SQL" 2>/dev/null || rm -f "$SQL"
CT_BYTES="$(wc -c < "$WORK/$CT" | tr -d ' ')"
CT_SHA="$(shasum -a 256 "$WORK/$CT" | awk '{print $1}')"

cat > "$WORK/latest.json" <<JSON
{"takenAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","key":"d1/daily/$CT","bytes":$CT_BYTES,"sha256":"$CT_SHA","plaintextBytes":$BYTES,"tables":$TABLES,"recipient":"$RECIPIENT"}
JSON

if [ $LOCAL = 1 ]; then
  cp "$WORK/$CT" "$OUT_DIR/$CT"
  cp "$WORK/latest.json" "$OUT_DIR/latest.json"
  echo "== wrote $OUT_DIR/$CT"
  exit 0
fi

put() { "${WRANGLER[@]}" r2 object put "$BUCKET/$1" --file "$2" --remote ${3:+--content-type "$3"}; }
echo "== upload d1/daily/$CT ($CT_BYTES bytes)"
put "d1/daily/$CT" "$WORK/$CT" application/octet-stream
# The first backup of each month is also kept under d1/monthly/, outside the
# 30-day lifecycle rule on d1/daily/.
if [ "$(date -u +%d)" = "01" ] || [ "${D1_FORCE_MONTHLY:-0}" = "1" ]; then
  put "d1/monthly/$(date -u +%Y-%m).sql.gz.age" "$WORK/$CT" application/octet-stream
fi

echo "== read back and compare"
"${WRANGLER[@]}" r2 object get "$BUCKET/d1/daily/$CT" --file "$WORK/readback" --remote
BACK="$(shasum -a 256 "$WORK/readback" | awk '{print $1}')"
if [ "$BACK" != "$CT_SHA" ]; then
  echo "refusing to publish latest.json: the uploaded object differs ($BACK vs $CT_SHA)" >&2
  exit 1
fi
# latest.json last, so a failed run never advertises a backup that is not there.
put "latest.json" "$WORK/latest.json" application/json
echo "== done $DAY: d1/daily/$CT"
