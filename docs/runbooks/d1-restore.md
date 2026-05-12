# D1 restore from R2 backup

The Worker dumps D1 → R2 every 6h (see `apps/com/src/scheduled.ts`). This
runbook turns one of those dumps back into a live D1 database.

## What's on disk

```
r2://flagship-backups/
   d1/hourly/YYYY-MM-DD-HH.jsonl.gz   pruned after 30 days
   d1/monthly/YYYY-MM.jsonl.gz        kept indefinitely
```

Each file is gzipped JSON Lines. One line per record. Three record
shapes:

```jsonl
{"type":"meta","tookAt":"2026-05-11T06:00:00.000Z","cron":"0 */6 * * *"}
{"type":"table","name":"usernames"}
{"type":"row","table":"usernames","data":{"username":"harry","irk_pub_hex":"...","claimed_at":1747000000000}}
{"type":"table","name":"servers"}
{"type":"row","table":"servers","data":{...}}
...
```

A `meta` row opens the file. Then for every dumped table, one `table`
header row followed by zero-or-more `row` rows.

## Step 1 — pull the dump

```sh
# List available backups
npx wrangler r2 object list flagship-backups --prefix d1/hourly/ | tail

# Pick one and download (uses the R2 binding's API token from your
# wrangler login):
mkdir -p /tmp/d1-restore
npx wrangler r2 object get \
    flagship-backups/d1/hourly/2026-05-11-06.jsonl.gz \
    --file=/tmp/d1-restore/dump.jsonl.gz

gunzip /tmp/d1-restore/dump.jsonl.gz   # produces dump.jsonl
```

## Step 2 — turn JSONL into SQL

D1 doesn't have a native bulk-load endpoint other than `wrangler d1
execute --file=<sql>`. Convert the dump to INSERTs with this one-liner
(needs `jq`):

```sh
jq -r '
  select(.type == "row")
  | "INSERT OR REPLACE INTO [\(.table)] (\(
      .data | keys_unsorted | map("[\(.)]") | join(",")
    )) VALUES (\(
      .data | [.[] | (
        if . == null then "NULL"
        elif type == "string" then "'" + gsub("'"; "''") + "'"
        elif type == "boolean" then (if . then "1" else "0" end)
        else (.|tostring) end
      )] | join(",")
    ));"
' /tmp/d1-restore/dump.jsonl > /tmp/d1-restore/restore.sql
```

Sanity-check the output:

```sh
head -3 /tmp/d1-restore/restore.sql
wc -l /tmp/d1-restore/restore.sql
```

## Step 3 — restore

DRY-RUN against a scratch database first. Don't touch production until
you've verified the file applies cleanly:

```sh
# Spin up a throwaway D1, run schema migrations, then load.
npx wrangler d1 create flagship-restore-scratch
# Capture the new database_id from the output, then in apps/com/wrangler.toml
# temporarily swap the binding pointing at it, or pass --database explicitly.

# Apply schema first
for f in packages/storage/migrations/*.sql; do
  npx wrangler d1 execute flagship-restore-scratch --remote --file="$f"
done

# Load the data
npx wrangler d1 execute flagship-restore-scratch \
    --remote --file=/tmp/d1-restore/restore.sql

# Spot-check
npx wrangler d1 execute flagship-restore-scratch \
    --remote --command="SELECT COUNT(*) FROM usernames;"
```

If the scratch restore looks right, repeat against the real database
(`flagship-state`). Take a quick last-resort backup first by running
the scheduled handler manually:

```sh
# Force one extra hourly snapshot before clobbering anything:
npx wrangler dev --test-scheduled
# In another terminal:
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*%2F6+*+*+*'
```

Then apply:

```sh
npx wrangler d1 execute flagship-state \
    --remote --file=/tmp/d1-restore/restore.sql
```

## Step 4 — verify

- /api/health on prod still returns 200.
- /api/username/<a-real-claimed-name> returns the expected record.
- /api/server/by-domain/<some.domain> resolves.
- /api/marketplace/search returns rows.

## Notes

- The dump skips `sqlite_*` and `_cf_*` internal tables. Schema is
  rebuilt from `packages/storage/migrations/*.sql`, not the dump.
- `INSERT OR REPLACE` is used so re-running the same dump is
  idempotent. If you need a strict "wipe and reload," `DELETE FROM
  <table>` each table first.
- Monthly snapshots (`d1/monthly/YYYY-MM.jsonl.gz`) are kept
  indefinitely. Set up a quarterly review to confirm bucket size
  isn't drifting unexpectedly.
- The scheduled handler can be invoked locally for testing with
  `npx wrangler dev --test-scheduled` plus the cdn-cgi handler URL
  above. The cron expression in `apps/com/wrangler.toml` is the
  source of truth for production frequency.
