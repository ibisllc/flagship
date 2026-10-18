# D1 backup and restore

The production database is `flagship-state` (D1). Two things protect it:

1. **D1 Time Travel**, Cloudflare's own point-in-time restore: on the Workers Free
   plan 7 days back, on Paid 30 (Cloudflare docs, "D1 Time Travel": available on
   Free, nothing to enable, production backend only). Use it first for "we ran a bad
   statement an hour ago".
2. **The encrypted daily export** in R2, for everything Time Travel cannot do:
   older than 7 days, a lost or deleted database, a different account.

## What the backup is

`.github/workflows/d1-backup.yml` runs `scripts/d1-backup.sh` every day at 03:17 UTC
(and on demand: Actions > D1 backup > Run workflow):

```
wrangler d1 export flagship-state --remote      (the platform dumps; no Worker CPU)
  -> refuse a dump with fewer than 60 CREATE TABLEs or no rows
  -> gzip, then age-encrypt to the public key in .maintainers/backup-recipient.pub
  -> r2://flagship-d1-backups/d1/daily/flagship-state-<UTC stamp>.sql.gz.age
  -> read it back and compare SHA-256
  -> r2://flagship-d1-backups/latest.json    {takenAt, key, bytes, sha256, tables, recipient}
```

The first run of each month also copies the file to `d1/monthly/YYYY-MM.sql.gz.age`.
A second schedule (every 6 hours) fetches `latest.json` and **fails the workflow when
`takenAt` is more than 36 hours old** or the file is missing; GitHub emails the owner a
failed scheduled run. That check also catches the workflow being disabled (GitHub
turns off scheduled workflows in a repo with no activity for 60 days).

Why it is not a Worker cron any more: the old one made one D1 call per table (89) and
spent about 45 ms of CPU. The Workers Free plan allows 50 subrequests and 10 ms, so it
never finished (`docs/runbooks/workers-cpu-budget.md` "Crons").

Why age: one small public key in the repo (`.maintainers/backup-recipient.pub`), its
private identity file kept offline by the owner, nothing else to trust. Until the
owner replaces the placeholder in that file the backup refuses to run (loudly: the
workflow goes red). **Keep the private file safe in two places: without it no backup
can be read.** (An alternative with no new key is to encrypt to the published
security@flagshipserver.com PGP key, whose private half is on the YubiKeys; it needs a
YubiKey and `gpg` to restore. Not chosen: the release runner and this runbook assume age.)

The plaintext SQL exists only in the runner's temp directory for the length of the
run.

### One-time setup (the owner; steps are in `final-deploy.md` step 1b)

```sh
npx wrangler r2 bucket create flagship-d1-backups        # private: no dev-url, no public domain
# keep d1/daily/ for 30 days, d1/monthly/ forever (the rule only names d1/daily/):
npx wrangler r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30
npx wrangler r2 bucket lifecycle list flagship-d1-backups
```

Then generate the backup key pair once, offline (`brew install age`):

```sh
age-keygen -o d1-backup-key.txt     # prints: Public key: age1...   The FILE is the private identity.
```

Store `d1-backup-key.txt` in two offline places, put the single `age1...` line in
`.maintainers/backup-recipient.pub` (replacing the whole placeholder file) and commit it.
Then, in the GitHub repo settings (Secrets and variables > Actions), add
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Make the token with
dashboard > My Profile > API Tokens > Create Custom Token, restricted to this one
account, with `Account > D1 > Edit` and `Account > Workers R2 Storage > Edit`, and
nothing else. It is a separate token from any deploy token, because a leak of it lets
someone edit D1; rotate it when someone leaves. The same two secrets run
`model-capabilities.yml`.

Then run the workflow once by hand and check the object:

```sh
npx wrangler r2 object get flagship-d1-backups/latest.json --file - --remote
```

## Restore

Pick the situation:

### A. Something was damaged in the last 7 days: Time Travel

```sh
cd apps/com
npx wrangler d1 time-travel info flagship-state                       # note the current bookmark
npx wrangler d1 time-travel info flagship-state --timestamp=<unix>    # the bookmark just before the damage
npx wrangler d1 time-travel restore flagship-state --timestamp=<unix>
```

It rewrites the database in place and cancels in-flight queries; it prints the bookmark
from just before the restore, so a mistake can be undone with `restore --bookmark=`.
The `.com` Worker keeps serving throughout (it sees the restored rows when the restore
lands). Nothing to redeploy.

### B. Time Travel cannot help: restore the encrypted export into a NEW database

The export carries the schema and the data, so the target is an empty database that
has had no migrations run. Restoring into the live database would fail on the first
`CREATE TABLE`; make a new one and switch the Worker to it.

1. Get the file (any machine with `wrangler` logged in):

   ```sh
   mkdir -p ~/d1-restore && cd ~/d1-restore
   npx wrangler r2 object get flagship-d1-backups/latest.json --file latest.json --remote
   cat latest.json                       # {"takenAt": ..., "key": "d1/daily/....sql.gz.age", "sha256": ...}
   npx wrangler r2 object get "flagship-d1-backups/$(jq -r .key latest.json)" --file dump.sql.gz.age --remote
   shasum -a 256 dump.sql.gz.age           # must equal latest.json's sha256
   ```

   An older day: `npx wrangler r2 object list` does not exist in wrangler 4; list the
   bucket in the dashboard (R2 > flagship-d1-backups > `d1/daily/` or `d1/monthly/`) and
   fetch that key.

2. Decrypt with the offline identity file:

   ```sh
   age -d -i d1-backup-key.txt dump.sql.gz.age | gunzip > dump.sql
   grep -c '^CREATE TABLE' dump.sql      # about 89
   ```

3. Load a new database and check it:

   ```sh
   npx wrangler d1 create flagship-state-restored
   npx wrangler d1 execute flagship-state-restored --remote --file dump.sql
   npx wrangler d1 execute flagship-state-restored --remote \
       --command "SELECT (SELECT COUNT(*) FROM usernames) AS accounts, (SELECT COUNT(*) FROM servers) AS servers"
   ```

4. Point the Worker at it: in `apps/com/wrangler.toml` change `database_id` of the `DB`
   binding to the new id (keep `database_name = "flagship-state"` so scripts and the
   migration-drift check still find it by name, or update them too), then
   `npx tsc -b && (cd apps/com && npm run deploy)`.

5. Verify (below). Keep the damaged database until the restored one has served real
   traffic for a day, then delete it.

The data only goes back to the backup's `takenAt`: boxes re-send their heartbeats
within five minutes, but anything signed or claimed since (an account created, a
device paired, a rank order) is gone and must be redone.

### Verify

- `curl -s https://flagshipserver.com/api/health` returns 200.
- `GET /api/username/<a-real-claimed-name>` returns its record.
- `GET /api/admin/schema-status` (with `x-admin-secret`) lists every migration applied.
- Open the webapp, sign in with the review login and open the server list.

## Rehearse it

`bash scripts/d1-restore-drill.sh` runs the whole procedure on local databases with a
throwaway age key standing in for the offline one: migrate database A, seed rows
(including a name with a quote), `d1-backup.sh --local` (export + sanity checks +
gzip + encrypt), decrypt, import into an empty database B, then compare A and B row for row
and table for table. Last run: 89 tables, 92 rows, identical. Run it after changing
`d1-backup.sh` or upgrading wrangler. `scripts/d1-backup.test.ts` pins the rest
(the freshness rule, the placeholder refusal, the secrets the workflow may name).

## The old Worker-era dumps

Before 2026-10-18 a Worker cron wrote `d1/hourly/*.jsonl.gz` and `d1/monthly/*.jsonl.gz`
to `r2://flagship-backups/`. On Free it never completed, so the bucket probably holds
little; it is no longer written to or bound to the Worker. If an old JSONL dump is ever
needed: each line is `{"type":"row","table":...,"data":{...}}`; turn the rows into
`INSERT OR REPLACE` statements with `jq` and load them into a database that already has
the migrations applied. Delete the bucket once the new backup has run a month.
