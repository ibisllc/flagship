#!/usr/bin/env bash
# Encrypted backup of the production D1 database (flagship-state).
#
# Why this is a script and not a Worker cron: the old Worker backup made one D1
# call per table (89 on an almost empty database), over the Workers Free plan's
# 50-subrequest limit, and spent about 45 ms of CPU against a 10 ms limit, so on
# Free it never finished. `wrangler d1 export` runs in the platform instead.
#
#   export -> sanity check -> gpg-encrypt to the security@ key -> R2 -> read back
#
# The plaintext never leaves this process: it is written to a temp dir, encrypted,
# deleted, and only the ciphertext is uploaded. The recipient is the public
# security@flagshipserver.com key already published in the repo; its private half
# lives only on the owner's two YubiKeys, so a leaked bucket or token reads
# nothing and a restore needs a YubiKey (docs/runbooks/d1-restore.md).
#
# Usage (CI: .github/workflows/d1-backup.yml; needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID in the environment):
#   bash scripts/d1-backup.sh                 # remote D1 -> R2
#   bash scripts/d1-backup.sh --local DIR     # local D1 (wrangler dev state) -> DIR, no upload
# Environment:
#   D1_DATABASE   database name           (flagship-state)
#   D1_BACKUP_BUCKET                       (flagship-d1-backups)
#   D1_BACKUP_KEY_FILE  recipient key      (apps/web/public/.well-known/pgp-key.txt)
#   D1_BACKUP_FPR       pinned fingerprint (D96D675DB03E3F3BBC8870302308936D215496D0)
#   D1_MIN_TABLES       refuse a dump with fewer CREATE TABLEs (60)
#   D1_PROJECT_DIR      --local only: the directory whose wrangler.toml and .wrangler/state to read
#                       (default apps/com; the restore drill points it at a scratch project)
#   GNUPGHOME           optional: a throwaway keyring (the restore drill uses one)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${D1_DATABASE:-flagship-state}"
BUCKET="${D1_BACKUP_BUCKET:-flagship-d1-backups}"
KEY_FILE="${D1_BACKUP_KEY_FILE:-$ROOT/apps/web/public/.well-known/pgp-key.txt}"
FPR="${D1_BACKUP_FPR:-D96D675DB03E3F3BBC8870302308936D215496D0}"
MIN_TABLES="${D1_MIN_TABLES:-60}"
WRANGLER=(npx --yes wrangler@4.151.0)
LOCAL=0
OUT_DIR=""
if [ "${1:-}" = "--local" ]; then
  LOCAL=1
  OUT_DIR="${2:?usage: d1-backup.sh --local DIR}"
  mkdir -p "$OUT_DIR"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y-%m-%d)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SQL="$WORK/flagship-state-$STAMP.sql"
CT="flagship-state-$STAMP.sql.gpg"

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

echo "== encrypt to $FPR"
KEYRING_CHECK="$(gpg --batch --with-colons --show-keys "$KEY_FILE" | awk -F: '$1=="fpr"{print $10; exit}')"
if [ "$KEYRING_CHECK" != "$FPR" ]; then
  echo "refusing: $KEY_FILE holds key $KEYRING_CHECK, not the pinned $FPR" >&2
  exit 1
fi
gpg --batch --quiet --import "$KEY_FILE"
gpg --batch --yes --quiet --trust-model always --compress-algo zlib \
  --recipient "$FPR" --output "$WORK/$CT" --encrypt "$SQL"
shred -u "$SQL" 2>/dev/null || rm -f "$SQL"
CT_BYTES="$(wc -c < "$WORK/$CT" | tr -d ' ')"
CT_SHA="$(shasum -a 256 "$WORK/$CT" | awk '{print $1}')"

cat > "$WORK/latest.json" <<JSON
{"takenAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","key":"d1/daily/$CT","bytes":$CT_BYTES,"sha256":"$CT_SHA","plaintextBytes":$BYTES,"tables":$TABLES,"recipient":"$FPR"}
JSON

if [ $LOCAL = 1 ]; then
  cp "$WORK/$CT" "$OUT_DIR/$CT"
  cp "$WORK/latest.json" "$OUT_DIR/latest.json"
  echo "== wrote $OUT_DIR/$CT"
  exit 0
fi

put() { "${WRANGLER[@]}" r2 object put "$BUCKET/$1" --file "$2" --remote ${3:+--content-type "$3"}; }
echo "== upload d1/daily/$CT ($CT_BYTES bytes)"
put "d1/daily/$CT" "$WORK/$CT" application/pgp-encrypted
# The first backup of each month is also kept under d1/monthly/, outside the
# 30-day lifecycle rule on d1/daily/.
if [ "$(date -u +%d)" = "01" ] || [ "${D1_FORCE_MONTHLY:-0}" = "1" ]; then
  put "d1/monthly/$(date -u +%Y-%m).sql.gpg" "$WORK/$CT" application/pgp-encrypted
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
