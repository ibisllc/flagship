# Pre-GA scrub (historical note)

Before GA the owner ran one last bulk wipe of every pre-GA account on prod D1
(`flagship-state`), keeping only the store-review login `playstore-test-0725`,
and then reaped what the wipe leaves outside D1. Accounts are never bulk-wiped
after GA (AGENTS.md Conventions), so the wipe tooling was deleted once the run
was verified.

- The wipe script (`scripts/wipe-all-users.sh`), its table list, harness,
  fixture seeder and tests live on in git history:
  `git log --diff-filter=D --oneline -- scripts/wipe-all-users.sh`, then
  `git show <that commit>^:scripts/wipe-all-users.sh`.
- `scripts/release-guard.sh` now fails every build, dev included, if any
  `scripts/wipe-all-users*` file comes back.
- The weekly gym does not zero its database (owner, 2026-10-18); it uses unique
  account names, `/api/gym/teardown` and the fleet sweep.
- What the wipe did NOT touch: Cloudflare DNS records of the wiped accounts and
  their demo cloud servers (UpCloud), R2 objects, Fly state, and boxes already
  installed (they simply stopped working). The `flagship.services` zone is
  capped at 200 records, so leftovers matter (AGENTS.md "Urgent").
- **The reap stays** as a standing tool for leftovers of a removed account:
  `scripts/reap-orphans.mjs` over the `.com` admin routes
  `/api/admin/reap/{list,classify,delete-one}` (`apps/com/src/prodReap.ts`).
  With `FLAGSHIP_ADMIN_SECRET` set: a dry run that saves a plan,
  `node scripts/reap-orphans.mjs --show --out ~/reap-plan.json`; then, in a
  terminal, `node scripts/reap-orphans.mjs --apply --plan ~/reap-plan.json`
  (typed confirmation; deletes only the orphans in that plan, each re-checked
  against D1 right before; retries every 30 s on failure; logs to
  `<plan>.log.jsonl`). An item is an orphan only if its account no longer exists
  in D1; the apex, system names, the gym, the protected review account and
  anything it does not recognise are always kept.
- To remove one account (not a bulk wipe), use the account-deletion and
  username-reclaim flows (`docs/account-deletion-and-name-reclaim.md`).

## After a reap: check what is left

`bash scripts/release.sh --phase B` step 19 runs these; by hand:

- **Gym leftovers (the shared zone's gym records and gym servers).** A default part of
  the reap: `release.sh` asks you to type `sweep`, or `skip-gym` (an explicit skip it
  records). Dry run, then destroy, only when no live gym run holds `flagship-locks/gym.lock`:
  `npx tsx tools/live-e2e/sweep-cli.ts`, then `npx tsx tools/live-e2e/sweep-cli.ts --destroy`
  (it touches only `flagship-env=gym` servers and records under the gym apex, never
  prod's). If the destroy reports `dnsFailed`, wait 30 s and run it again.
- **Left on purpose (read-only; no secret, no network).** On a dry run saved after the apply:
  `node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan-after.json`, then
  `node scripts/reap-orphans.mjs --review --plan ~/pre-ga-reap-plan-after.json`. It prints
  every kept record by reason and every kept server, and exits 1 while the plan still lists
  anything to delete. `release.sh` makes you type `reviewed` once you have read it. Expected end state: the apex and its CAA, the wildcard, system names,
  and `playstore-test-0725` with its server.
- **Owner checklist: what the tools cannot see.** UpCloud console: servers without the
  `flagship-demo` label (keep only `playstore-test-0725`), Hetzner (suspended; servers
  153213447, 153638469, 153643080, 153813669, 155315594 to delete when it unlocks), stale records in the `flagshipserver.com`
  zone, R2 objects of wiped accounts (`flagship-d1-backups` and `flagship-iso` stay), and
  Fly apps, volumes and secrets besides `flagship-services`. `release.sh` asks for
  `checked` or `skipped` for each and records the answers.
