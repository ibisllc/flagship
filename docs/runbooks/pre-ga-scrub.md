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
