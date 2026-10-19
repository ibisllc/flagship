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

## Reaping what the wipe leaves behind (the step AFTER the D1 scrub)

The wipe deletes rows only. The wiped accounts' demo cloud servers and their
`<server>.<user>.flagship.services` DNS records (the zone is capped at 200
records: about 154 used, about 70 of them leftovers from accounts that are
already gone) stay until you reap them. R2 objects and Fly state are not
covered by any tool; Hetzner is not covered (its account is suspended). The
end of this section ("Left on purpose" and "Owner checklist") is how you check
that nothing else is left. `bash scripts/release.sh --phase B` step 19 runs the
whole section, including the typed answers.

1. **Demo accounts with a running cloud server: before the wipe, optional.**
   `node scripts/sample-user.mjs cleanup <username>` (needs `FLAGSHIP_ADMIN_SECRET`
   in your shell; no dry-run, so work from the read-only list in "Before you
   start" step 4, one account at a time). The prod reap below also finds these
   servers afterwards, so this is only for ones you want gone first.
2. **Gym leftovers (the shared zone's gym records and gym servers): a default
   part of the reap.** Dry run, then destroy; only when no live gym run is in
   progress:
   `npx tsx tools/live-e2e/sweep-cli.ts` then `npx tsx tools/live-e2e/sweep-cli.ts --destroy`
   (the gym Worker's `/api/gym/teardown`; it touches only `flagship-env=gym`
   servers and records under the gym apex, never prod's). `release.sh` step 19
   asks you to type `sweep` (or `skip-gym`, an explicit skip that it records) and
   refuses the sweep while `/private/tmp/claude-501/flagship-locks/gym.lock`
   exists, because that means a gym run is live. If the destroy reports
   `dnsFailed`, wait 30 s and run it again.
3. **Prod DNS records and demo servers of removed accounts: `scripts/reap-orphans.mjs`.**
   It talks to the `.com` Worker's admin routes (`/api/admin/reap/list`,
   `/classify`, `/delete-one`, `apps/com/src/prodReap.ts`), because the
   Cloudflare DNS token and the UpCloud token live only there. **The Worker
   must be deployed with those routes first** (`npx tsc -b && (cd apps/com && npm run deploy)`
   by the owner; nothing is deployed from this runbook). Run it after the D1
   scrub has been verified (step 4): a record is an ORPHAN when its account no
   longer exists in D1, so the same tool can also be run before the scrub to
   clear the leftovers of accounts that are already gone.

   Needs `FLAGSHIP_ADMIN_SECRET` (prod) in your shell. Nothing else is read.

   **a. Dry run** (writes nothing in Cloudflare, UpCloud or D1; saves a plan file):

   ```sh
   cd /Users/harrywinner/flagship
   node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan.json
   ```

   It prints the zone and server counts, a table of accounts that are gone
   from D1 with how many records and servers each has, the kept accounts, and
   with `--show` every orphan plus the records it kept because it did not
   recognise their shape. Read it. What it keeps, always: the apex and
   wildcard, every system or reserved name (`api`, `www`, `gym`, ...), the gym
   subtree, `playstore-test-0725` and its server, every account that D1 still
   knows (usernames, aliases, servers, demo users, auth codes), any record
   shape Flagship does not publish, and any UpCloud server without the
   `flagship-demo` label or with a `flagship-env` label. Sanity checks: the
   orphan accounts are the ones you wiped (and the older leftovers listed
   under "Urgent" in AGENTS.md); `zone after the reap` is well under 200; the
   "kept accounts" list is exactly the accounts you kept. The route refuses to
   classify at all if D1 does not hold `playstore-test-0725` (wrong database,
   or the review login is gone), so a bad scrub cannot turn into a wide reap.

   **b. Apply** (a real terminal only; deletes ONLY the orphans in that saved
   plan, and only if the plan is under 24 hours old):

   ```sh
   node scripts/reap-orphans.mjs --apply --plan ~/pre-ga-reap-plan.json
   ```

   It prints the plan again, then asks you to type
   `delete N records and M servers` (the real counts). It deletes one item at
   a time. Before each one the Worker re-reads the record or server, re-checks
   D1 as of that moment and refuses (409, "refused by the re-check") anything
   that is not an orphan any more, that differs from the plan, or that touches
   the apex or a protected account. A failed call (Cloudflare rate limit,
   network) is retried every 30 seconds, up to 6 attempts, then marked
   failed. Every outcome is appended to `~/pre-ga-reap-plan.json.log.jsonl`
   (the Worker also logs each deletion). It ends by re-running the
   classification and printing what is left and the zone's record count. Exit
   0 means nothing failed or was stopped; rerun the dry run and apply again
   for stragglers.

   **c. Verify**: rerun the dry run. It should report 0 orphaned records and 0
   orphaned servers, and the zone count should match `zone after the reap`.
   Check `playstore-test-0725` still resolves (its box answers over HTTPS) and
   a kept account's box still has its three record groups. Note the date here.

   **d. Left on purpose (read-only; no secret, no network).** Run it on the
   dry run saved after the apply:

   ```sh
   node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan-after.json
   node scripts/reap-orphans.mjs --review --plan ~/pre-ga-reap-plan-after.json
   ```

   It prints every DNS record that was kept, grouped by reason (the zone apex,
   the root wildcard, system or reserved labels, host records, the protected
   account, an account D1 still has, unrecognised shapes and records Flagship
   does not publish), and every kept server with its reason, and exits 1 while
   the plan still lists anything to delete. It adds no deletion rule; it only
   shows what remains. The expected end state is the apex and its CAA, the
   wildcard, system names, and `playstore-test-0725` with its server. `release.sh`
   makes you type `reviewed` once you have read it.

   **e. Owner checklist: what the tools cannot see.** Each needs your own
   login. `release.sh` asks you to type `checked` or `skipped` for each and
   records the answers in its state file.
   - **UpCloud console:** servers without the `flagship-demo` label (the reap
     only lists labelled ones). Keep only the `playstore-test-0725` server.
   - **Hetzner** (account suspended): delete servers 153213447, 153638469,
     153643080, 153813669 and 155315594 when it unlocks.
   - **Cloudflare zone `flagshipserver.com`:** stale records pointing at
     retired hosts (the old `web.` record pointed at an unclaimed Surge site and
     was a takeover risk; audit for others).
   - **R2 buckets:** objects of wiped accounts (`flagship-d1-backups` and
     `flagship-iso` stay).
   - **Fly:** apps, volumes and secrets besides `flagship-services`
     (`flyctl apps list`, `flyctl volumes list -a flagship-services`).

## Final step: retire the wipe tooling (only after the run is verified)

This is the last time users are ever scrubbed. Do this step **only after** the
owner confirms the scrub happened **and** the verification in step 4 passed
(only `playstore-test-0725` is left, four zero orphan counts, the review login
signs in). Until then the tooling stays; after it, it must not exist.

A ready commit sits on the branch `chore/delete-wipe-tooling` (rebased on
`main` on 2026-10-18 and pushed to `origin`; **it is deliberately not on
`main`**). **Do not land it until the owner confirms that the scrub ran, was
verified (step 4) and the reap (above) is done.** It deletes the script, its
table list, harness, fixture and tests, replaces the release-guard wipe checks
with a rule that fails every build (dev included) if any
`scripts/wipe-all-users*` file reappears, drops GA close-out item 1 from
AGENTS.md and adds the rule "Accounts are never bulk-wiped after GA". Landing
it also removes this runbook's scrub steps (it becomes a short historical
note), so copy the reap commands first if you still need them; the reap tool
(`scripts/reap-orphans.mjs`) stays. To land it, after rebasing it again:

```sh
git fetch origin && git checkout chore/delete-wipe-tooling && git rebase origin/main
npx tsc -b && npx vitest run scripts && RELEASE=1 bash scripts/release-guard.sh
bash <scratchpad>/land-main.sh "retire wipe tooling" "npx tsc -b && npx vitest run scripts"
```

Git history keeps the script (`git log --diff-filter=D -- scripts/wipe-all-users.sh`).
The gym no longer needs it: the owner decided on 2026-10-18 that the weekly gym
does not zero its database (unique account names, `/api/gym/teardown` and the
fleet sweep instead); `scripts/gym-weekly.sh` no longer calls the script, and
nothing else in the tree does.

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
  out. Demo cloud servers are removed by the reap; delete any other cloud
  server you pay for (Hetzner, or UpCloud without the `flagship-demo` label) by hand.
- Cloudflare DNS records and demo servers of wiped accounts: run the reap
  (above), read its "Left on purpose" list and go through the owner checklist
  (step e). R2 objects and Fly state are not touched by any tool: the checklist
  is how you cover them.
- Note the date here and, in **AGENTS.md**, update GA close-out item 1 ("wipe
  script guard"): the scrub is done, and the script can now be guarded further or
  removed per that item. The release guard (`scripts/release-guard.sh`) still
  requires the script's guards while the file exists.

## Rehearsing

Never rehearse against prod. Against the gym database (zeroes it, the keep list
still applies; the gym has no review account; the weekly gym no longer does this):

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
