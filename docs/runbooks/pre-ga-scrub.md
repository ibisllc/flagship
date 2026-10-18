# Pre-GA scrub: the last wipe of all test users

This is the **last** time every pre-GA account is cleared out of production.
After it, `.com`'s D1 holds only the accounts on the keep list; from then on
real people sign up and nobody wipes them.

Demo and evaluation accounts stay available as a **feature**: the demo flow
that creates them is untouched. The existing demo sample users made before GA
**can** be wiped; they survive only if you name them on the keep list.

The tool is `scripts/wipe-all-users.sh` (guards, keep list and per-table preview;
tests in `scripts/wipe-all-users*.test.ts`). It only touches D1. It never
touches Cloudflare DNS, R2, Fly, UpCloud or any box.

## What survives

Owner decision (2026-10-18): the keep list is **only** `playstore-test-0725`,
the shared App Store / Google Play review login. Every other account on prod is
deleted, demo sample users and your own accounts included. That is the hard
default of the script; nothing else is kept unless you name it on purpose.

- `playstore-test-0725`, always (the built-in default). Do not run this while a
  store review is open and the account is missing from the database.
- The override, for safety only: any account you name (`WIPE_KEEP`, `--keep`,
  or a `--keep-file`). Use it only if the dry run shows an account that must
  not go; the dry run prints the kept usernames.
- Tables that hold no account and protect the kept ones are kept whole:
  `boot_nonces`, `meter_batches`, `stripe_events`, `share_inbox` (sealed, no
  account in it). Catalog and infrastructure tables on the script's
  `PRESERVED-TABLES` line (`marketplace_listings`, `username_suggestion_queue`,
  `repo_adapters`, `rate_limit_log`, `inference_settings`, ...) are never touched.
- Anonymous throwaway tables are emptied: `nfc_rendezvous`, `qr_pipe_metrics`,
  `username_suggest_throttle`.

A kept account is kept **whole**: its device rows, servers, routing, boot-unlock
keys, mailbox, invites it authored, shares it owns, backups, meter counters,
audit events and so on stay, found through the key each table uses (username,
account id, the account's server domains, its order serials, and the account
and device public keys). Every other account's rows go, in every table.

Not covered, by design: a kept account that was a *member* of a server owned by
a wiped account loses that share (the server is gone). Anything of a wiped
account that lives outside D1 stays where it is (see "After").

## Before you start

- **Go decision.** Run the dry run (step 1) first and take its output (the
   `keep list`, the `accounts` list and the per-table counts) to the owner for
   an explicit go. Nothing below the dry run happens without it, and the real
   run still demands the typed confirmation (step 3).
- **Maintenance notice.** If the clients can show one, publish it before the
   run (`docs/security-notices.md`; it has not landed on `main` yet, check
   `git fetch && git show origin/main:docs/security-notices.md`). If it is
   still missing, there is no in-app notice: tell the people who have test
   accounts out of band, since their accounts and servers will stop working.
1. A terminal on this Mac, repo on current `main`, `cd /Users/harrywinner/flagship`.
2. **Credential: wrangler access to the prod D1 database `flagship-state`.**
   Either `npx wrangler login` as the Cloudflare account that owns it, or
   `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if more than one account)
   with D1 edit rights in the environment. The script does **not** use
   `FLAGSHIP_ADMIN_SECRET`; nothing in this runbook needs a secret on the
   command line. A dry run only reads, but uses the same login.
3. Pending D1 migrations applied (`cd apps/com && npx wrangler d1 migrations list
   flagship-state --remote`). Prod's schema drifts from the repo; a table the
   script cannot scope (a column missing) is reported as `ERROR` and stops the
   run before anything is deleted.
4. Demo users with running cloud servers cost money after their database rows
   are gone. Look first (read-only):
   `cd apps/com && npx wrangler d1 execute flagship-state --remote --command "SELECT username, state, active_server_id FROM demo_users WHERE active_server_id IS NOT NULL"`
   then, for each one you are not keeping,
   `node scripts/sample-user.mjs cleanup <username>` (needs `FLAGSHIP_ADMIN_SECRET`
   in your shell, as that tool always does).

## 1. Dry run against prod (writes nothing)

```sh
WIPE_ENV=prod WIPE_D1=flagship-state bash scripts/wipe-all-users.sh --list-accounts
```

No `--yes` means dry run: every query is a `SELECT`, nothing is written. Add the
keep list you intend to use (step 2) so the preview matches the real run.

Read the output top to bottom:

- **keep list**: `keep` = found in the database and survives. `absent` = the
  built-in default is not in this database (fine on gym, but on prod it means
  the review login is already gone: stop and find out why). `MISSING` = a name
  you typed does not exist; the script refuses to go on (almost always a typo).
- **accounts** (`--list-accounts`): every account with `KEEP` or `delete`, its
  demo flag, type and claim time. This is the list to read carefully.
- **wipe preview**, one line per table: `scope` is `by account` (rows of kept
  accounts stay), `wipe all` or `keep all`; `total` is the rows now, `keep` the
  rows that survive, `delete` the rows that go. The last line is the totals.
  `absent in this database` means that table is not in prod (skipped, normal).
  `ERROR: could not scope` means a column the rule needs is missing in prod:
  apply the migration and rerun; a real run refuses while any table shows it.
- Sanity: for `usernames`, `keep` must equal the number of names you kept. Every
  `by account` table should have `keep` at or near that number times the rows an
  account normally has; a table with `keep 0` that you expected to hold a kept
  account's rows is worth a look.

## 2. Edit the keep list

The default is only `playstore-test-0725` and needs no file. Only if the dry
run shows an account that must survive, add it (the review login stays either
way):

```sh
# a file, one username per line, # starts a comment
printf '# extra accounts to keep\n<username>\n' > ~/pre-ga-keep.txt
WIPE_ENV=prod WIPE_D1=flagship-state bash scripts/wipe-all-users.sh \
  --list-accounts --keep-file ~/pre-ga-keep.txt

# or inline
WIPE_ENV=prod WIPE_D1=flagship-state WIPE_KEEP=<username>,<other> \
  bash scripts/wipe-all-users.sh --list-accounts
```

Rules the script enforces: names are lowercased and must look like usernames
(letters, digits, dashes); a keep file that is missing, unreadable or names
nobody refuses, as does a blank `WIPE_KEEP`; the keep list is never empty.
(`WIPE_KEEP_DEFAULT=0` drops the review login from the list, only for after
the store reviews are over and only with another name kept.) Rerun the dry run
until the `accounts` list shows exactly the accounts you want as `KEEP`.

## 3. The real run (owner, at a terminal)

```sh
WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod \
  bash scripts/wipe-all-users.sh --yes --keep-file ~/pre-ga-keep.txt
```

(or `WIPE_KEEP=...` instead of the file). The guards, all of which must pass:
`WIPE_ENV` and `WIPE_D1` named (nothing defaults to prod); `prod` only with
`flagship-state`; `--yes`; `WIPE_CONFIRM=prod`; stdin is a real terminal (an
agent, CI or a pipe is refused). The script prints the preview again, then asks
you to **type the database name** (`flagship-state`). Then it deletes table by
table (`wiped`, `keep`, `skip`), re-counts every table, and prints
`done: N wiped, 0 skipped, 0 failed, 0 with leftovers`. It takes several
minutes (a few hundred D1 calls). Any `FAILED` or `LEFTOVER` line means rerun
the same command; it is safe to repeat.

## 4. Verify (read-only)

Counts per table. The script's own recount already printed `0 with leftovers`;
check it independently with the same `keep` numbers the dry run showed:

```sh
cd apps/com
npx wrangler d1 execute flagship-state --remote --command "SELECT username, is_demo FROM usernames ORDER BY username"
for t in servers routing auth_codes device_identities daemon_status secret_mailbox meter_counters audit_events demo_users; do
  npx wrangler d1 execute flagship-state --remote --command "SELECT '$t' AS tbl, count(*) AS n FROM $t" --json
done
```

Only `playstore-test-0725` (and anything you named) is listed; each count is
what that account owns (typically one account's rows, `0` for tables the review
account does not use). Then check nothing is orphaned in D1 (all four must be 0):

```sh
npx wrangler d1 execute flagship-state --remote --command "SELECT (SELECT count(*) FROM servers WHERE lower(username) NOT IN (SELECT lower(username) FROM usernames)) AS orphan_servers, (SELECT count(*) FROM device_identities WHERE account_id NOT IN (SELECT username FROM usernames)) AS orphan_devices, (SELECT count(*) FROM daemon_status WHERE lower(server_domain) NOT IN (SELECT lower(server_domain) FROM servers)) AS orphan_status, (SELECT count(*) FROM auth_codes WHERE lower(username) NOT IN (SELECT lower(username) FROM usernames)) AS orphan_codes"
```

The store-review account is intact and still signs in: its `usernames`,
`servers`, `device_identities` and `demo_users` rows are present (counts above),
then sign in to `playstore-test-0725` the way the reviewers do (the demo
test-account entry, see `docs/sample-users.md` section 17) on a phone or the
webapp and open its server list: it must look as it did before. If its server
shows offline, wait for the next heartbeat before worrying.

No orphaned server, DNS or R2 objects: D1 is only part of the picture, see
"Reaping" next. The orphan check for those is the reap's own dry run coming
back empty.

## Reaping what the wipe leaves behind (dry-run first)

The wipe deletes rows only. The wiped accounts' cloud servers, their
`<server>.<user>.flagship.services` DNS records (the zone is near its 200-record
cap: about 154 used, about 70 of them leftovers) and any R2 objects stay until
you reap them. **Keep the dry-run output from step 1: once the rows are gone,
that list of usernames is the only record of what to reap.**

1. **Demo accounts with a running cloud server: before the wipe.**
   `node scripts/sample-user.mjs cleanup <username>` (needs `FLAGSHIP_ADMIN_SECRET`
   in your shell; it has no dry-run, so work from the read-only list in "Before
   you start" step 4 and run it one account at a time). It tears down the
   provider server and the account's cloud-side state while the rows still exist
   to find them. Do this for each demo account that is on the delete list.
2. **Gym leftovers (the shared zone's gym records and gym servers).** Dry run,
   which lists what it would remove and the zone's record count, then destroy;
   only when no live gym run is in progress:
   `npx tsx tools/live-e2e/sweep-cli.ts` then `npx tsx tools/live-e2e/sweep-cli.ts --destroy`
   (the gym Worker's `/api/gym/teardown`; it touches only `flagship-env=gym`
   servers and records under the gym apex, never prod's).
3. **Prod DNS records and non-demo servers of wiped accounts: no tool exists
   yet.** Nothing in the repo reaps prod's `flagship.services` records for
   removed accounts (the gym teardown is deliberately gym-only), and boxes on
   UpCloud/Hetzner that are not demo accounts are deleted by hand in the
   provider console. Until a prod reap tool with a dry run exists (open task:
   mirror `apps/com/src/gymCloud.ts`'s dry-run/destroy for named usernames
   under the prod apex, owner-run), list the wiped usernames from your saved
   dry run and remove their records in the Cloudflare dashboard by hand, then
   confirm the zone count dropped. Never reap by pattern; reap by the saved list.

## If the dry run shows an unexpected account

Do not run the real wipe. For the account in question:

1. Look: `SELECT username, is_demo, account_type, claimed_at FROM usernames WHERE username = '<name>'`
   and its `servers` / `demo_users` rows. A demo sample user or an old test
   account: leave it on the delete list. Something you do not recognise that has
   servers or recent `audit_events`: find out whose it is first.
2. If it must survive, add it to the keep list and rerun the dry run.
3. If a real person turns out to have an account, tell them before wiping.

If a *kept* name shows `MISSING`, fix the spelling (the script already refused).

## After

- Already-installed servers of wiped accounts are **not** scrubbed. They keep
  running; their registrations are gone, so they simply stop working and age
  out. Delete the cloud ones you pay for (UpCloud, Hetzner) by hand.
- Cloudflare DNS records, R2 objects and Fly state of wiped accounts are not
  touched: see "Reaping" above.
- Note the date here and, in **AGENTS.md**, update GA close-out item 1 ("wipe
  script guard"): the scrub is done, and the script can now be guarded further or
  removed per that item. The release guard (`scripts/release-guard.sh`) still
  requires the script's guards while the file exists.

## Rehearsing

Never rehearse against prod. Against the gym database (zeroes it, the keep list
still applies; the gym has no review account):

```sh
WIPE_ENV=gym WIPE_D1=flagship-state-gym WIPE_WRANGLER_CONFIG=wrangler.gym.toml \
  bash scripts/wipe-all-users.sh --list-accounts
```

Or on a local D1 seeded with five accounts (`WIPE_LOCAL=1` is refused for prod):

```sh
cd apps/com && npx wrangler d1 migrations apply flagship-state-gym --config wrangler.gym.toml --local --persist-to /tmp/wipe-rehearsal
npx tsx scripts/wipe-all-users-fixture.ts /tmp/wipe-rehearsal/v3/d1/miniflare-D1DatabaseObject/<file>.sqlite
WIPE_ENV=local WIPE_D1=flagship-state-gym WIPE_WRANGLER_CONFIG=wrangler.gym.toml \
  WIPE_LOCAL=1 WIPE_LOCAL_PERSIST=/tmp/wipe-rehearsal bash scripts/wipe-all-users.sh --list-accounts
```
