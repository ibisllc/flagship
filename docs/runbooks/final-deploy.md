# Final deploy: the ordered owner steps for GA

Written 2026-10-18 against `main` at the release-candidate pass. **The owner
runs every step below, at a terminal; nothing here was run by an agent.** Each
step has what to do, a check that it worked (the probes used so far), and how
to back out (`deploy-rollback.md` has the long form; Studio, the stores and the
scrub have their own notes here).

Principles that hold throughout (AGENTS.md "Conventions"):

- Only `main` is deployed. Deploy from a clean worktree of `origin/main` with
  its own `node_modules` (never the shared checkout, never a symlinked
  `node_modules`).
- Never `wrangler deploy` directly: `cd apps/com && npm run deploy`.
- One deployer at a time. Don't touch prod while a gym run is in progress.
- A step that fails: stop, roll that step back, do not continue down the list.

## Run it with the script

`scripts/release.sh` is the way to run this runbook. It is interactive (it needs a
terminal), pins the release to one commit, builds from its own clean worktree, asks
y/N/skip/quit before every step that changes anything outside the checkout, never
force-pushes and keeps its progress in `~/.flagship-release/state.json` so a failed
run resumes at the failed step. The commands below stay as the reference it follows.

```sh
bash scripts/release.sh --list                # the 34 steps, with phase, commands, gate, rollback
bash scripts/release.sh --phase A             # deploy the real state (steps 1-21), before the Windows test
bash scripts/release.sh --phase B             # after the Windows results (steps 22-34)
bash scripts/release.sh --dry-run --phase A   # print every command, run nothing
bash scripts/release.sh --status              # pinned sha, finished steps, next step
bash scripts/release.sh --from 10             # resume at, or --only 10 to run only, one step
```

Phase A ends by writing `device-results/DEPLOYED-FINAL-<date>.md` (main sha, endorsed
release, shell version, DNS design, appliance sha256, what is live) and, on your yes,
pushes it to `device-results/windows-2026-10-17` so the Windows agent tests the real
deployed state. Phase B (scrub, reap, retire the wipe tool, public Studio, stores)
refuses to start until phase A is recorded finished.

The script's order differs from the section numbers below in four places, on purpose:
the gym gate (6) and a fresh D1 backup come before the migrations (4), so nothing on
prod changes until the gate is green; the VM appliance builds start right after the
endorsement (3) so the hours-long builds overlap the deploys; the deploys run
`.services` (8) first, then the manual DNS step (6a), then `.com` (7): the new `.com`
publishes no per-box address records, so a box registering while the wildcard does not
exist yet would get names that do not resolve (and resolvers negative-cache that for
30 minutes), and the relay must already drop unregistered names uniformly when the
wildcard starts answering them. Adding the wildcard first is safe for existing
accounts, whose own records keep answering. `zone-health` ships with the `.com`
deploy, so the DNS step is checked with `dig` and `zone-health` runs as a post-check
of the `.com` deploy. The maintenance notice (12.1) is its own step at the start of
phase B. What it cannot do for you: the DNS canary after the gym run (the gym itself runs from the
script: `scripts/gym-release-run.sh`, gated on its exit code), the Cloudflare dashboard DNS records, the YubiKey and PIN prompts (the
tools ask on `/dev/tty`), the App Store Connect and Play Console submissions, and
reading the Windows results (typed `windows-ok` before the scrub).

### What the owner does by hand in a release (0.3 and later)

The script stops and asks at each of these; nothing else needs you.

| When | What you do | Step |
|---|---|---|
| once | make the two release catalog keys on an offline stick; the script pins the root and sets `RELEASE_CATALOG_TIMESTAMP_KEY` | 2b |
| every release | the product version and the store numbers (they must climb) | 0b |
| every release | YubiKey PIN + touch: the CA lease, the release endorsement, both box artifacts | 2, 3, 3b |
| every release | the catalog's security version, floor and rollout percent; the root key file from the stick | 3c |
| once | prod secrets `FLAGSHIP_RECOVERY_PROOF_SECRET` (passkey recovery challenges; `openssl rand -hex 32`) on prod AND the gym Worker | 5 |
| once | a public test repo with tags `v1` and `v2`, named in `GYM_SYNC_REPO` (the gym's upstream-sync group skips without it) | 6 |
| every release | accept or refuse gym skips (exit 3); the DNS canary | 6 |
| once | the adapter attestation key, complaint salt and review key on `.com`; the key's public half in `release/adapter-vetting-keys.json` | 5 |
| once | the Public Suffix List request for `flagship.services` (`docs/psl-submission-flagship-services.md`) | (outside the script) |
| every release | read `i18n/REVIEW.md` lines (native readers); the voi.ci canonical switch after the gym's named-links group | 11c |
| every release | App Store Connect and Play Console submissions (iOS, Android, Wear) | 11 |
| after 0.3 is live | publish the held hall of fame entry (`hof-jay`) | 11b |

Two things to know before `--phase A`: step 8 (backup prerequisites, runbook step 1b) must be
done before the `.com` deploy because that deploy removes the Worker's own D1 backup, and the
`.com` step refuses without it unless you type `no-backup-accepted`; and the `.com` deploy
(`npm run deploy`) runs in the foreground of your terminal because wrangler asks to move the
`webapp.` and `remote.` custom domains to the new `flagship-webapp` Worker (answer yes). The gym
does not exercise that static-only Worker, so that deploy's post-checks are its first real test:
stay at the terminal.

Set up a clean deploy tree once and reuse it for every step that builds:

```sh
cd /Users/harrywinner/flagship
git fetch origin
git worktree add ~/flagship-deploy origin/main --detach   # or `git -C ~/flagship-deploy checkout --detach origin/main` to move it
cd ~/flagship-deploy && npm ci && npx tsc -b
git log -1 --oneline        # write this commit down: it is what you are shipping
```

Re-run `git -C ~/flagship-deploy checkout --detach origin/main && npm ci && npx tsc -b`
whenever `main` moves between steps, and re-read step 1 for anything that
changed.

## 0. What "ready" means before you start

On the commit you wrote down (all must be green; an agent ran them on
2026-10-18 and the table is in the release-candidate report):

```sh
npx tsc -b
npx vitest run
npm run parity                       # exit 0
RELEASE=1 bash scripts/release-guard.sh
npm run ready                        # branches is amber/red by design (feature branches drift); the rest green
```

Known state at the time of writing (re-check, do not trust):

- The five feature branches that conflict with `main` (`feat/marketplace`,
  `feat/retail`, `feat/phone-usb-burn`, `alpine`, `gym`) are not part of GA.
  `gym` is rebased by `scripts/gym-refresh.sh` (step 6).
- The arm64 VM appliance failed to build until `35e207cda`; its first green
  `main` run is the one named in step 9.

## 0b. Bump the product version

One product version on every surface (`release/version.json`, the only file to edit). The script asks
for the new `product` (0.3 for this release), the label, the iOS marketing version and build, the
Android versionCode (above the highest in Play's App bundle explorer: any upload burns a code) and the
Studio version, writes the file, runs `node scripts/check-versions.mjs --write` (every surface's copy)
and `node scripts/check-versions.mjs`, commits "Bump the product version to <v>", pushes to `main` and
re-pins. A run that keeps the version skips it. Store numbers already uploaded are burned: a revert
takes the next ones.

## 1. Cloudflare plan and DNS limits (do this first)

> **Owner decision 2026-10-18: `.com` stays on the Workers Free plan at launch.**
> Skip item 1 below (the Paid upgrade) unless section 14's signals appear, and do
> step 1b instead: the two jobs that cannot run in a Free Worker (the D1 backup, the
> model-table refresh) run in GitHub Actions, and they need the secrets and the
> bucket of 1b before the first `.com` deploy.

Why: the Workers **Free** plan gives a request 10 ms of CPU. A gym request was
killed by it, and prod runs the same code, so any heavy handler can 1102 for
real people. `.com` also uses Durable Objects (rate limits, relay sessions)
and a 10-minute cron.

1. **Free for launch** (owner decision 2026-10-18; the CPU work that makes the
   hot routes fit is in `docs/runbooks/workers-cpu-budget.md`). There is nothing
   to change in the dashboard. The upgrade signals (`exceededCpu` / error 1102,
   more than 70,000 requests in a day, the 6-hourly D1 backup that cannot run on
   Free) are in section 14. **Fallback, if a signal fires:** Cloudflare
   dashboard, account that owns `flagship-com`: **Workers & Pages -> Plans ->
   Workers Paid ($5/month)**. Nothing in the repo changes
   (`apps/com/wrangler.toml` has no `[limits]`; the default paid CPU limit is
   what we want).
2. The `flagship.services` zone's record cap (AGENTS.md "Urgent": 200 records,
   ~154 used, ~70 are leftovers). The **root wildcard** removes the constraint
   without a plan change: the zone then holds about 4 records at rest and 2 per
   certificate in flight, whatever the number of accounts
   (`docs/wildcard-dns.md`; the one-time manual DNS step is step 6a, the reap of
   the leftovers is step 12). Cloudflare Free suffices.

Check:

```sh
curl -s https://flagshipserver.com/api/health          # still 200
```

Dashboard: Workers & Pages -> flagship-com -> Metrics: no `exceededCpu` / 1102
after step 7 (on Free). If you took the Paid fallback, Settings shows the Paid
plan.

Rollback: a plan change is reversible in the dashboard (downgrading puts the
10 ms limit back, so don't, unless billing forces it).

## 1b. Free-plan prerequisites: GitHub secrets, the backup bucket, the first backup

Why: on Free a Worker cron may make 50 subrequests and spend 10 ms. The D1 backup made
89 D1 calls and the model-table refresh spent 33 ms, so both moved to GitHub Actions
(`.github/workflows/d1-backup.yml`, `model-capabilities.yml`). The `.com` deploy of step 7
removes the Worker's backup (code and R2 binding), so **without this step there is no
backup at all** (D1 Time Travel, 7 days on Free, is the only safety net). Nothing here is
a secret in the repo; you add two values in GitHub.

1. **Create the private R2 bucket and its retention rule** (no public access, no dev-url):

   ```sh
   npx wrangler r2 bucket create flagship-d1-backups
   npx wrangler r2 bucket lifecycle add flagship-d1-backups expire-daily d1/daily/ --expire-days 30
   npx wrangler r2 bucket lifecycle list flagship-d1-backups      # one rule, prefix d1/daily/
   ```

   `d1/monthly/` has no rule on purpose (the first backup of each month is kept).
2. **Make a Cloudflare API token** (dashboard > My Profile > API Tokens > Create Custom
   Token) restricted to this account with exactly `Account > D1 > Edit` and
   `Account > Workers R2 Storage > Edit`. Not a deploy token. Copy the token and the
   account id (dashboard > Workers & Pages > right column).
3. **Add the two GitHub repository secrets** (repo > Settings > Secrets and variables >
   Actions > New repository secret): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   Do not paste either into a file in the repo.
4. **Make the backup's encryption key and commit its public half.** On an offline Mac:
   `brew install age && age-keygen -o d1-backup-key.txt`. It prints `Public key: age1...`.
   Store `d1-backup-key.txt` (the PRIVATE identity) in two offline places; without it no
   backup can be read. Replace the whole of `.maintainers/backup-recipient.pub` with that
   single `age1...` line and commit it to main (the file in the repo is a placeholder,
   and the backup, the workflow and `scripts/release.sh` all refuse it). The public key
   alone decrypts nothing.
5. **Run the backup once and verify the object**: Actions > D1 backup > Run workflow
   (leave "backup"). It exports, encrypts, uploads, reads the object back and checks the
   result is fresh. Then:

   ```sh
   npx wrangler r2 object get flagship-d1-backups/latest.json --file - --remote
   ```

   shows `takenAt` just now, `tables` about 89, a `key` under `d1/daily/`. Optionally
   rehearse the restore: `bash scripts/d1-restore-drill.sh` (local, throwaway age key; needs `age`;
   `docs/runbooks/d1-restore.md` has the real steps).
6. **Run "Model capability table" once** (Actions > Model capability table > Run workflow);
   `model_capabilities` then has about 350 rows (`GET /api/inference/capabilities`).
7. The workflow also checks every six hours that the newest backup is under 36 hours old
   and fails (GitHub emails you) when not. Confirm Actions email notifications are on for
   your account, and that the repo's scheduled workflows are not disabled (GitHub turns
   them off after 60 days without repository activity; a manual run re-enables).

Check: the R2 object exists and `latest.json` is fresh; both workflows green.

Rollback: none needed; the workflows only read D1 and write the new bucket.

## 2. Renew the CA lease (due 2026-11-05, and do it before anything that needs the CA)

The production CA's only live lease expires 2026-11-05 (`.maintainers/
ca-endorsements/bundle.json`, last entry `notAfter 2026-11-05T19:31:05Z`). After
it every CA-chain check fails closed: app trust checks, relay blessing, boxes
accepting a share, the box's own bootstrap. Renew **before** you deploy, so the
deploy bundles a lease with runway.

Needs the YubiKey, in a real terminal (the PIN prompt reads `/dev/tty`):

```sh
cd <the pulled ibisllc/maintainers clone>
node packages/cli/bin/maintainers ca-endorsement \
  --ca-pubkey 230ad9ed20e56d79e836690e351cb5538fb4aca9e509d9adc9755da81cd235cc \
  --scope flagship/directory-attestation \
  --duration 30d \
  --track ca \
  --signing-key yubikey-piv:slot=9c \
  --path ~/flagship-deploy/.maintainers \
  --dry-run                     # preview first; then run again without --dry-run and type CA-LEASE
```

(The pubkey above is the one in the current bundle; confirm it with
`node scripts/rotate-ca.mjs status` first, and see `docs/ca-operations.md`
Operation 1 for 7-day vs longer leases.) Then:

```sh
cd ~/flagship-deploy
node scripts/rotate-ca.mjs status          # the new lease lists as LIVE / SERVED
git add .maintainers/ca-endorsements
git commit -m "Renew the production CA lease"
git push origin HEAD:main                  # or open a PR; it must be on main before step 7
```

The `.com` deploy (step 7) is what serves it to the apps; boxes read it from
the endorsed checkout (step 3).

Check: `curl -s https://flagshipserver.com/api/maintainer-blessing | head -c 300`
shows a lease whose `notAfter` is the new date after step 7.

Rollback: a lease is additive (overlapping leases are fine). Nothing to undo;
a wrong one is superseded by signing another.

## 2b. Release catalog keys (once)

Boxes built from a commit that pins `release/catalog-root.json` follow the signed release catalog
(SECURITY-HARDENING-PLAN.md 18.13, N13): no update, first-boot move, co-manager update or rollback
happens unless the catalog lists it, above the security floor, inside its rollout, and fresh. Two keys,
made once, kept OFFLINE (an encrypted stick, never this repo):

```sh
npx tsx tools/release-catalog/catalog.ts keygen --id root-1 --out <stick>/catalog-root-1.key.json        # prints the public key
npx tsx tools/release-catalog/catalog.ts keygen --id timestamp-1 --out <stick>/catalog-timestamp-1.key.json
npx tsx tools/release-catalog/catalog.ts root --key root-1=<pub> --key timestamp-1=<pub> \
  --role root=root-1 --role targets=root-1 --role snapshot=root-1 --role timestamp=timestamp-1 \
  --version 1 --expires-days 730 --out release/catalog-root.json
gh secret set RELEASE_CATALOG_TIMESTAMP_KEY < <stick>/catalog-timestamp-1.key.json
```

The timestamp key is the only online one: `.github/workflows/release-catalog-timestamp.yml` re-signs
`catalog-timestamp.json` daily (a box treats an expired timestamp as a stale catalog and takes no new
update, never stops what runs). A new root (rotating a key) is signed by the old root and published as
`catalog-root-<v>.json` beside `catalog-root.json`; boxes walk the chain. Losing the root key means
re-pinning a root in a release every box must reach by an owner order.

## 3. Endorse a server release (only if the box code changed)

Boxes only run signed code (`docs/maintainer-ca-endorsement.md`). A new box
installs the newest endorsed release; an existing box updates to it on the
owner's order. The VM appliances (step 9) bake the newest endorsed release too,
so **endorse before you build the appliances**.

Is a new endorsement needed? Compare the newest endorsed commit with the box's
code paths:

```sh
cd ~/flagship-deploy
node scripts/latest-endorsed-release.mjs          # prints the newest endorsed commit (needs tsc -b and full history)
E=$(node scripts/latest-endorsed-release.mjs)
git log --oneline $E..origin/main -- packages/server-daemon packages/protocol \
  packages/tunnel-protocol packages/llm-providers installer package.json package-lock.json
```

- Empty (or only `tests/` and `test-vectors/` files): no new endorsement is
  needed for the daemon.
- Anything else: endorse the new tip. **For this release it is required.** The
  newest endorsement is `e07f6ba7` (2026-10-18). Box-path commits after it include
  the doorbell, `bc59534d4` and `fbff4df7e` (`packages/server-daemon/src/doorbell.ts`,
  `daemonStatusHeartbeat.ts`, `index.ts`), plus native Ed25519 in
  `packages/protocol/src/edSync.ts` and `packages/boot-core/src/nonceStore.ts`
  (`git diff --stat e07f6ba7..origin/main -- packages/server-daemon installer
  packages/boot-core packages/protocol packages/tunnel-protocol
  packages/llm-providers package.json package-lock.json`, checked 2026-10-18).
  `scripts/release.sh` computes the same diff and says "BOX CODE CHANGED". The
  wildcard-DNS change by itself needs nothing on boxes (`docs/wildcard-dns.md`
  section 10); the doorbell does, and an old box simply keeps polling.

```sh
# 1. Preview (no signature, no write): prints target, lineage, merkle root, signer.
node scripts/endorse-release.mjs --to origin/main --from $E
# 2. Sign: a real terminal, YubiKey tap and PIN.
node scripts/endorse-release.mjs --to origin/main --from $E --sign
git add .maintainers/endorsements
git commit -m "Endorse <sha> on the ca track"
git push origin HEAD:main
node scripts/latest-endorsed-release.mjs          # now prints the new commit
```

`--from` is informational (the commit the oldest box you care about runs).

Check: the printed commit is the one you signed; `curl -s https://flagshipserver.com/api/releases?current=<old>`
(after step 7) lists it.

Rollback: an endorsement cannot be un-signed; a bad one is handled by not
ordering the update and by endorsing a newer fix. A box whose update fails its
health gate rolls itself back.

## 3b. Build, sign and publish the box artifacts

A box installs only a signed, reproducible artifact of one exact commit (SEC-INSTALL-001):

```sh
gh workflow run box-artifact.yml --ref main -f commit=<PIN> -f sequence=<N>     # N above release/box-release.json's
gh run watch <run> --exit-status && gh run download <run> -D <dir>
npx tsx tools/box-artifact/build.ts sign --manifest <name>.manifest.unsigned.json --out <name>.manifest.json \
  --signer-cmd "node scripts/yubikey-sign.mjs"                                   # PIN + touch, per arch
npx tsx tools/box-artifact/build.ts verify --manifest <name>.manifest.json --artifact <name>.tar.gz --commit <PIN> --arch <arch>
npx tsx tools/box-artifact/release-index.ts <dir>                                # merged with the published releases.json
wrangler r2 object put flagship-iso/<file> --file <file> --remote                # both arches, manifests, releases.json
bash scripts/publish-gvisor-mirror.sh --skip-if-at https://flagshipserver.com/build/iso
node scripts/gen-box-release.mjs --write && node scripts/repin-bootstrap-sha.mjs --write
```

Then `release/box-release.json` names the commit and sequence, the generated constants follow, and the
bootstrap byte pin (TS and Swift builders) moves with it; the script commits "Install box release",
pushes and re-pins. Gate: both manifests verify against `release/box-artifact-trust.json` and
`https://flagshipserver.com/build/iso/<name>.manifest.json` answers 200. Rollback: point
`box-release.json` back at the previous commit (its artifact stays in R2); never reuse a sequence.

## 3c. Sign and publish the release catalog

Skipped while no root is pinned. The script adds this release to `release/catalog-releases.json` with
the security version (raise it above every listed release; it is what "never roll back below" counts),
the floor (raise it only when an older release must stop being installable, e.g. after a security fix)
and the rollout percent, then signs targets, snapshot and timestamp with the root key from the stick
(chaining the timestamp version from the published one), uploads `catalog-{targets,snapshot,timestamp}.json`
to `flagship-iso` (the pinned root ships inside the release; `catalog-root.json` is only for a signed
rotation), checks they are served, starts the timestamp workflow once and
commits the list. Rollback: sign a new targets version without the release (a version never goes down).

## 4. Pending D1 migrations

D1 migrations are applied by hand, before the Worker deploy, because the Worker
reads the new tables.

```sh
cd ~/flagship-deploy
ls packages/storage/migrations | tail -3                 # newest file in the repo
cd apps/com
npx wrangler d1 execute flagship-state --remote \
  --command "SELECT version FROM schema_version ORDER BY version DESC LIMIT 6"
```

State, read from prod's ledger (read-only query) on 2026-10-18: the newest
versions applied are 0105, 0104, 0103, 0102, 0101, 0100, and the repo's newest
migration is **0105** (`0105_re_pair_proof.sql`), so **nothing is pending**.
(AGENTS.md used to say 0104 was pending; that was stale. Whether the three
peer-backup secrets of section 5 exist is not shown by the ledger.)
`main` skips 0088-0094 and 0099 on purpose (they live on feature branches).
`npm run deploy` runs `scripts/check-prod-migrations.mjs` and refuses to deploy
if a repo migration is missing from the ledger, so a forgotten one cannot ship.

If a later file exists (say `0106_x.sql`), per file, in order:

```sh
cd ~/flagship-deploy/apps/com
npx wrangler d1 execute flagship-state --remote --file=../../packages/storage/migrations/0106_x.sql
npx wrangler d1 execute flagship-state --remote \
  --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('0106', $(date +%s)000)"
```

Read the file's header first: a bare `ALTER TABLE ... ADD COLUMN` is
apply-once (`packages/storage/migrations/README.md`); running it twice aborts.

Check (after step 7): `curl -s -H "x-admin-secret: $FLAGSHIP_ADMIN_SECRET" https://flagshipserver.com/api/admin/schema-status | jq`
returns empty `missing` and `unknown`.

Rollback: there are no down-migrations. Roll the code back (step 7), leave
additive tables in place, forward-fix. Data damage: `docs/runbooks/d1-restore.md`.

## 5. Secrets and settings the new code reads

Before the `.com` deploy, make sure prod has what the code reads. Names only,
never values on a command line you keep:

```sh
cd ~/flagship-deploy/apps/com
npx wrangler secret list                                    # prod names
npx wrangler secret list --config wrangler.gym.toml         # the gym has every secret prod has, plus any new one
```

A name on the gym but not on prod is a candidate to create. Known ones tied to
recent work: `ACCOUNT_READ_TOKEN_SECRET` (`docs/account-read-token.md`),
`PB_TOKEN_RSA_JWK`, `PB_FILLER_SECRET`, `PB_TAG_SECRET` (peer backup,
`docs/peer-backup.md` section 15; until set the routes answer 503), and for
Flagship Inference `FLAGSHIP_INFERENCE_TOKEN_SECRET` + `FLAGSHIP_INFERENCE_ENDPOINT`
(`infra/inference/README.md`; also the shim's own `UPSTREAM_*` secrets, which the
owner still has to choose).
Release 0.3: `FLAGSHIP_RECOVERY_PROOF_SECRET` (keys the one-use passkey recovery challenges,
`openssl rand -hex 32 | wrangler secret put FLAGSHIP_RECOVERY_PROOF_SECRET`; without it the passkey
check is off and recovery takes the passphrase-only path) and `FLAGSHIP_TOTP_KEK` if the optional TOTP
extra is to stay on. Set both on the gym Worker too.
Community adapters (SEC-ADAPTER-002, `docs/repo-adapters.md`): `ADAPTER_ATTESTATION_SIGNING_KEY` (an Ed25519
seed, `openssl rand -hex 32`; keep an offline copy), `ADAPTER_COMPLAINT_SALT` (`openssl rand -hex 32`; without
it complaints never withdraw anything) and `ADAPTER_REVIEW_ANTHROPIC_KEY` (without it nothing is vetted). Boxes
turn adapter lookup on only once the key's public half is in `release/adapter-vetting-keys.json`
(`{pubHex, notBefore, notAfter}`) in an endorsed box release; D1 migration 0113 goes before the `.com` deploy.

## 6. Gym refresh and live verification (GATE: nothing deploys to prod until this passes)

Release 0.3 and later: the script runs `bash scripts/gym-release-run.sh` from its worktree. It runs
`gym-refresh.sh`, takes the gym lock (a file naming its holder; exit 4 while another session holds it),
runs EVERY live group (`npx tsx tools/live-e2e/shared-run.ts --list`), the 0.3 groups included
(`tools/live-e2e/groups/release03/`: first contact and the server code, the per-server `*.<user>`
certificate and app names, cross-owner chat, passkey recovery, origin generations, the release catalog,
the policed browser, upstream sync, keyd custody), tears the fleet down and exits 0 (go), 3 (nothing
failed, something skipped: you type `accept-skips` only if every skip is an owner item you accept) or
non-zero (no-go). `GYM_START_REF=origin/gym-ux` runs a UX branch's gym. The upstream-sync group needs
`GYM_SYNC_REPO`; the passkey group needs `FLAGSHIP_RECOVERY_PROOF_SECRET` on the gym Worker.

The root-wildcard checks below stay part of the same run.

The root-wildcard change (`docs/wildcard-dns.md`) rewrites how every account's
names resolve and how every certificate is issued, so it is proven live on the
**gym first**. The gym's own apex wildcard (`*.gym.flagship.services`) already
works this way, so a gym run exercises exactly the new code path: no address or
CAA record is written for an account, and the box gets its Let's Encrypt
certificate. The first gym run already overturned one design assumption: a
challenge TXT does *not* make the box name an empty non-terminal on Cloudflare,
and the "shield" written against that was itself what opened a 5 s NXDOMAIN
window, so it is **removed** (code, switch and tests deleted).

```sh
cd ~/flagship-deploy
bash scripts/gym-refresh.sh               # rebases `gym` onto main, gym D1 migrations, secret parity, deploys the gym Worker and gym Fly app, health
npx tsx tools/live-e2e/shared-run.ts      # the live fleet run (about 11 minutes, 3 boxes); its core group checks that the account holds ZERO records and that box, service and unregistered names resolve through the zone wildcard
```

`gym-refresh.sh` must never touch the webapp Worker. It deploys `flagship-com-gym` only
(clean build and predeploy gates, then `wrangler deploy --config wrangler.gym.toml`), never
`npm run deploy`: that script first deploys `flagship-webapp`, which owns the PRODUCTION
`webapp.` and `remote.flagshipserver.com`. On 2026-10-18 a gym refresh did exactly that and the
gym branch's webapp (its own `BAKED_PIN` `87f5ae60...`, the gym adopt seam) went live on both
production hostnames until `.com` was redeployed from `main`. The gym Worker serves its own
webapp on `webapp.gym.`, so nothing is lost. Guards that keep it that way:
`scripts/deploy-webapp-static.sh` refuses unless HEAD is on `origin/main`, the worktree is
clean, the built `lib/serverTrust.js` `BAKED_PIN` equals `MAINTAINER_PINNED_MANDATE_HASH`
(prod: `5016749377de07fd...`) and `app.js` has no `installGymAdoptSeam`, and it never runs
under a gym environment (`FLAGSHIP_GYM_DEPLOY`, `GYM_*`, `wrangler.gym.toml`); the same pin and
seam check is in `static-assets.ts check` (the `npm run deploy` predeploy). The one deliberate
override, `FLAGSHIP_WEBAPP_DEPLOY_OVERRIDE=I-AM-SHIPPING-AN-UNVERIFIED-TREE-TO-THE-PRODUCTION-WEBAPP-HOSTNAMES`,
waives only "not on main" and "dirty"; the pin, seam and gym checks cannot be waived.
Tests: `scripts/webapp-deploy-guard.test.ts`. After any `.com` deploy,
`curl -s https://webapp.flagshipserver.com/lib/serverTrust.js | grep BAKED_PIN` must show the prod pin.

Run it only when no other live run is in progress. The gym refuses to start if
its fleet will not fit the zone. Teardown goes through `/api/gym/teardown`. Every
shared run records DNS for the first box's issuance (a poll every 200 ms of the
box name and a random label under it against Cloudflare's name servers and two
public resolvers) and **fails if the box name or a label under it goes dark, or
if any address or CAA record appears for the account**;
`npx tsx tools/live-e2e/dns-ent-experiment.ts --canary` is the 30 s canary (also
in `gym:total`).

Go / no-go:

- **Go:** the core group is all green (zero records for the account, an
  unregistered name closes after the fixed wait, the box gets its Let's Encrypt
  certificate and serves HTTPS 200) and the DNS record shows no gap in the box
  name's answers during issuance.
- **No-go (blocks the prod `.com` and `.services` deploys, steps 7 and 8):** any
  failed core check; a certificate not issued; or the DNS record showing the box
  name or a label under it going dark. Do not deploy; the old DNS keeps working
  on prod until you do. Fix on `main`, `gym-refresh.sh`, run again.
- The gym and prod share the `flagship.services` zone and the Let's Encrypt
  budget (50 certificates a week): do not burn the budget on repeated runs right
  before the prod deploy.

Check: `curl -s https://gym.flagshipserver.com/api/health` and
`curl -s https://flagship-services-gym.fly.dev:8443/api/health` are 200.

## 6a. The one-time manual DNS step: the root wildcard and the apex CAA

The owner creates these **once, by hand, in the Cloudflare dashboard** (DNS ->
Records of the `flagship.services` zone). Nothing in the repo creates them: `.com`
only ever writes and deletes `_acme-challenge` TXT, and it deletes nothing of an
account's before these exist (the guard in `docs/wildcard-dns.md` section 5). Do
this step **after `.services` (8) and before the `.com` deploy (7)**: the new `.com`
writes no per-box address records, so a box that registers while the wildcard is
missing gets names that do not resolve (resolvers cache that for 30 minutes), and the
trim (step 8's follow-up and step 12) needs the wildcard too. `scripts/release.sh`
runs it in that order (`9ed418ce3`).

1. Look up the relay's exact addresses (read-only), and compare with the repo
   (`apps/com/wrangler.toml`: `SERVICES_PASSTHROUGH_IPV4/6`, the same pair
   `apps/dns-broker/wrangler.toml` and `docs/runbooks/multi-region-rollout.md`
   record; any box name already resolves to them):

   ```sh
   export PATH="$HOME/.fly/bin:$PATH"
   flyctl ips list -a flagship-services          # the shared v4 and the v6 of the app
   dig +short A home.<an-existing-account>.flagship.services @1.1.1.1    # 149.248.216.86 at the time of writing
   dig +short AAAA home.<an-existing-account>.flagship.services @1.1.1.1 # 2a09:8280:1::110:d2b6:0
   ```

   If `flyctl ips list` disagrees with `wrangler.toml`, stop and fix the repo
   first: the zone-health check compares against the Worker's variables.
2. Add, **Proxy status: DNS only (grey cloud)** on both (the dashboard offers
   orange by default; an orange wildcard bypasses the relay), TTL 60 seconds or
   Auto:

   | Type | Name | Content |
   |---|---|---|
   | A | `*` | `149.248.216.86` (the relay's IPv4) |
   | AAAA | `*` | `2a09:8280:1::110:d2b6:0` (the relay's IPv6) |

3. Run the zone health check. It will still list the old per-account and per-box
   records as problems (they are what the reap removes) but the wildcard lines
   must be OK:

   ```sh
   FLAGSHIP_ADMIN_SECRET=... npm run zone-health
   dig +short A anything-at-all.flagship.services @1.1.1.1      # the relay address, after a few seconds
   dig +short A home.<an-existing-account>.flagship.services @1.1.1.1   # unchanged
   ```

4. Add the apex CAA pair (still **by hand**):

   | Type | Name | Tag | Value |
   |---|---|---|---|
   | CAA | `@` (`flagship.services`) | Only allow specific hostnames (`issue`) | `letsencrypt.org` |
   | CAA | `@` | Only allow wildcards (`issuewild`) | `letsencrypt.org` |

   The apex has **no CAA today** (checked 2026-10-18), and the apex name itself
   (proxied A/AAAA, mail, SPF) is not affected by a wildcard or by this CAA for
   its own site beyond the CA list: Cloudflare adds its own CAs to answers for a
   proxied name, but check the dashboard's SSL/TLS -> Edge Certificates still
   shows the apex certificate active afterwards. Then prove a real issuance with
   the CAA in place (a gym run, step 6; the gym's names climb to this apex CAA)
   before the first prod box renews. Rollback: delete the two CAA records.
5. Re-run `npm run zone-health`: only the legacy account records remain as
   problems, and they go in step 8's follow-up.

Moving the relay later (a new Fly address) means editing these two records by
hand and `SERVICES_PASSTHROUGH_IPV4/6` in `apps/com/wrangler.toml` (the old
`republish-server-dns` call is gone), then `npm run zone-health`.

Rollback of the whole step: delete the wildcard pair. Accounts that still hold
their own records keep resolving; ones already trimmed go dark until it is back,
so do not roll back after the trim.

**Earlier gym result (2026-10-18, gym Worker with `2963833d7`, relay v18):** full run
248 checks, 0 failed; the first box's issuance, polled 1,700 times per target and
resolver, never answered NODATA or NXDOMAIN for the box name or a label under it
(`docs/wildcard-dns.md` section 9.4); zone back to its base. **This is not the
gate for the final layout.** `2963833d7` is an ancestor of the root-wildcard
commit `272ce0c7d`, so that run exercised the per-account wildcard layout (the
zone peaked at 12 records above base, the shape of 4 per account); `.com` did
not yet stop writing per-account records, and the core group's "the account holds
ZERO records" check (`257755719`) did not exist. Run the gym again on the commit
you deploy (step 6) and treat that run as the gate.

**What the prod deploy must verify live (read-only on prod; nothing below writes
to the prod zone):**

1. Before step 7, the gate above is green on the commit you will deploy, and
   `npx tsx tools/live-e2e/dns-ent-experiment.ts --canary` (gym, 30 s, exit 0)
   passes again on the same day: it proves Cloudflare still keeps the wildcard
   under a TXT. Re-run it after any change of Cloudflare plan or zone settings.
   Do not run it against prod (it creates throwaway records).
2. After step 7 (`.com`), a new prod account's names resolve before its box
   registers: `dig +short @jade.ns.cloudflare.com anything.<new-account>.flagship.services`
   and `@1.1.1.1` return the relay address (`149.248.216.86`); the zone holds
   exactly `*.<new-account>` A + AAAA and two CAA at `<new-account>`
   (the reap tool's dry run lists it as KEEP, no `trim` rows).
3. During the first new prod box's certificate issuance, watch it from outside
   (the box name and a label under it must keep answering, 5 per second is enough):
   `for i in $(seq 1 1500); do dig +short @jade.ns.cloudflare.com home.<acct>.flagship.services; dig +short @jade.ns.cloudflare.com probe$i.home.<acct>.flagship.services; sleep 0.2; done | sort | uniq -c`
   must show only the relay address (an empty line is a dark answer: stop and tell the maintainer).
4. After step 8 (`.services`), an unregistered name under an account with an
   online box and one under an unknown account both get no TLS answer and close
   after the same wait (the gym core group's check, by hand:
   `openssl s_client -connect <relay-ip>:443 -servername ghost.<account>.flagship.services`
   twice; the two close within 1.5 s of each other and neither prints a certificate).
5. The zone count (`GET /api/admin/reap/list` or the dashboard) is back to the
   steady state of 4 per account after each issuance: no `_acme-challenge` TXT
   older than an hour (the stale sweep removes them hourly).

## 7. Deploy `.com` (two Workers)

`.com` is now two Workers: `flagship-com` (the API, the marketing site, recovery., boot.,
voi.ci, www.) and `flagship-webapp` (the static-only project that serves `webapp.` and
`remote.flagshipserver.com`; `apps/webapp-static`). `npm run deploy` in `apps/com` runs
the guards, then builds and deploys `flagship-webapp` (`scripts/deploy-webapp-static.sh`),
**then** `flagship-com`. That order matters once: `flagship-com` no longer lists the
`webapp.` and `remote.` custom domains, and `flagship-webapp` does, so the first
`flagship-webapp` deploy takes the two hostnames over with no gap. Run it in a terminal:
wrangler asks "Custom Domains already exist for these domains ... Update them to point to
this script instead?" and you answer yes. (Deploying `flagship-com` alone first would
detach the hostnames and leave the webapp unreachable until `flagship-webapp` is
deployed.)

```sh
cd ~/flagship-deploy
git fetch origin && git checkout --detach origin/main && npm ci && npx tsc -b
cd apps/com
npm run deploy        # predeploy: clean rebuild of the bundled packages, route-safety, dist freshness, orphaned output, static-asset guard, prod-migration drift; then the webapp Worker; then flagship-com
```

Rollback of the move: put the two `custom_domain` lines for `webapp.` and `remote.` back
in the `routes` array of `apps/com/wrangler.toml` (git history has them) and deploy
`flagship-com`; the Worker still holds the host-rewrite code and the webapp files, and it
takes the hostnames back (answer yes at the prompt).

This deploy carries: the cron regroup (`apps/com/src/cronPlan.ts`; the Worker's D1 backup
and model refresh are gone, step 1b replaces them), `run_worker_first` narrowed to
"everything except 46 listed static files" with a generated `_headers`, the root-wildcard
logic from before (no address or CAA record is written for anybody; legacy records are
cleared once the step 6a wildcard exists; the new reap rules and `zone-health`; the
challenge shield is gone). It needs the step 6 gate green, step 1b done,
**no D1 migration** and **no endorsed box release** (boxes only publish and
delete their own `_acme-challenge` TXT through `.com`; they publish no A, AAAA or
CAA). The hourly legacy sweep stays off until you set `DNS_LEGACY_SWEEP=1`. Do not use `--force` or set `FLAGSHIP_SKIP_*`. If the migration check says it
cannot read the ledger, log in (`npx wrangler login`) and rerun.

Check:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://flagshipserver.com/api/health            # 200
curl -s https://flagshipserver.com/api/health | head -c 300
curl -s https://webapp.flagshipserver.com/service-worker.js | grep -m1 SHELL_VERSION        # = main's SHELL_VERSION (v150 at the RC pass)
curl -sI https://webapp.flagshipserver.com/ | grep -i "content-security-policy\|x-frame-options\|referrer-policy"   # the shell CSP now comes from the static _headers
curl -sI https://flagshipserver.com/docs/ | grep -i "x-frame-options\|strict-transport"                            # a listed static page: _headers, no Worker
curl -s -o /dev/null -w "%{http_code}\n" https://webapp.flagshipserver.com/lib/no-such-file.js                       # 404 (the static-only Worker's guard), not 200 HTML
curl -s -o /dev/null -w "%{http_code}\n" https://flagshipserver.com/status/
curl -s https://flagshipserver.com/api/notices -o /dev/null -w "%{http_code}\n"             # 204 until a notice is signed (step 12)
curl -sI https://flagshipserver.com/ | grep -i "x-frame-options\|strict-transport"
curl -s -H "x-admin-secret: $FLAGSHIP_ADMIN_SECRET" https://flagshipserver.com/api/admin/schema-status | jq
```

Then open `https://webapp.flagshipserver.com/` in a private window, sign in with
the review login (`playstore-test-0725`, demo test-account entry) and open the
server list.

Rollback: `cd apps/com && npx wrangler deployments list && npx wrangler rollback <version-id>`
(code only; custom domains and D1 are untouched).

## 7a. Deploy the DNS broker

`apps/dns-broker` is the only holder of the Cloudflare DNS token; `.com` asks it to write challenge
TXT records under a policy (an account's `_acme-challenge.<user>` record needs the account's admin-signed
server-wildcard grant). Deploy it before `.com`, whose new code sends the grant:

```sh
cd apps/dns-broker && npx wrangler deployments list && npm run deploy && npx wrangler deployments list
```

Rollback: `npx wrangler rollback` in `apps/dns-broker` (the old broker refuses the account-wide record,
so new servers fall back to their own names only).

## 8. Deploy `.services` (Fly): needed, one image

The earlier wildcard change adds the relay's uniform drop timing for an
unregistered first-party name (the root wildcard itself needs nothing on Fly);
deploy it right after `.com`, not before.

Needed if the last Fly release is older than the relay changes on `main`.
Known: `0ea6e7a5e` (peer-backup mailboxes over the tunnel, 2026-10-16) is relay
code and needs a Fly deploy, and the wildcard-DNS change adds the relay's
uniform drop timing (`docs/wildcard-dns.md` section 4: `.com` is the DNS logic,
Fly only that timing). The Dockerfile bakes `packages/`, `apps/web/src` and
`apps/web/public`, so one image covers them all.

```sh
flyctl releases -a flagship-services | head -5          # when was the last image?
git -C ~/flagship-deploy log -1 --format='%h %cI' -- apps/web/src packages Dockerfile fly.toml billing
export PATH="$HOME/.fly/bin:$PATH"
cd ~/flagship-deploy
flyctl deploy --remote-only --strategy=rolling --yes -a flagship-services
```

`--strategy=rolling` is what `fly.toml` asks for: one machine at a time (two are kept
running), and the old hub sends each box a DrainNotice so its tunnel moves to the new
machine. Do not use `--strategy=immediate`: it stops the only healthy machine and drops
every box's tunnel for about 20 seconds.

Check:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://flagship.services/api/health            # 200
curl -s https://flagship.services/api/health | head -c 200
```

then watch `https://flagshipserver.com/status/` until every box is back online
(a minute).

Rollback: `flyctl releases rollback -a flagship-services` (stateless; clean).

### After both are deployed: finish the root-wildcard rollout

Per-account records fall to **0** (the zone holds the wildcard pair and the apex
CAA once, step 6a), so the 200-record zone no longer limits the number of
accounts; it only bounds certificates in flight (2 TXT each, minutes long).
Accounts that predate the change keep their old records until you trim them, in
this order:

1. Step 6a done (`npm run zone-health` shows the wildcard and CAA lines OK).
2. The reap dry run (needs `FLAGSHIP_ADMIN_SECRET`; deletes nothing):
   `node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan.json`. It says
   whether the root wildcard is in place and prints a **trim** table next to the
   orphans: every A, AAAA, CAA and TXT at an account or box name (they stop the
   wildcard for the names below), for live accounts too. Read it. Applying it is
   part of step 12 (do it after the scrub so the two plans are not mixed); it
   deletes in an order that never darkens a name, and the Worker re-checks each
   record against D1 and the zone right before deleting.
3. `POST /api/admin/republish-server-dns` **no longer exists**: nothing is
   published per account any more. Its job (and a bulk legacy clean-up) is
   `POST /api/admin/dns-route-gc?dryRun=true` (admin secret; lists, then without
   `dryRun` deletes up to `max=N`, default 20, at most 100, per call) and the
   opt-in hourly cron (`DNS_LEGACY_SWEEP=1` in `apps/com/wrangler.toml`), both
   of which wait for the root wildcard:

   ```sh
   curl -s -X POST -H "x-admin-secret: $FLAGSHIP_ADMIN_SECRET" "https://flagshipserver.com/api/admin/dns-route-gc?dryRun=true" | jq
   ```
4. After the trim: `npm run zone-health` is OK with no account records, and
   `dig +short A home.<an-existing-account>.flagship.services @1.1.1.1` still
   answers the relay. The protected review account (`playstore-test-0725`) keeps
   its own records (a warning in zone-health) until its store review ends; trim
   it by hand then.

## 9. Publish the VM appliances

Studio's "Host on this PC / Mac" boots a prebuilt appliance that bakes the
newest endorsed release and the first-boot specializer. Rebuild when step 3
endorsed something new or `packages/flagship-builder/src/appliance.ts` or the
appliance scripts changed (`docs/runbooks/republish-vm-appliance.md`).

State at the time of writing (check `gh run list --workflow vm-appliance.yml`):

- The arm64 factory failure (`tar: file changed as we read it` while copying the
  live root, run `39142016230`) is fixed on `main` (`35e207cda`). Runs on that
  fix: arm64 `39158345483` (main, in progress when this was written; the same fix
  on its branch, `39153555449`, was green) and amd64 `39160505562` (main,
  started by the release-candidate pass from `2963833d7`).
- Older green amd64 runs, from before the fix: `39153553427` (`668281523`) and
  `39142014433` (`d4c7ef4c0`, the first-boot resize fix). Prefer the new pair.
- **Publish only a green run from `main`, one per arch, and only after reading
  its job log for the boot smoke.** If either is red, do not publish that arch.
- The release workflow takes the newest endorsed release, not the tip of
  `main`, so a newer `main` alone does not make a run stale; a **new
  endorsement (step 3) does**.

Build (only when needed; no secrets, nothing leaves GitHub):

```sh
gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=latest-endorsed
gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed
gh run list --workflow vm-appliance.yml --limit 6
gh run view <id>          # green, and the job log ends with the boot smoke passing
```

Publish (uploads to R2, one image at a time, each checked against its manifest):

```sh
cd ~/flagship-deploy
bash scripts/publish-vm-appliance.sh <green amd64 run id> <green arm64 run id>
git add apps/web/public/downloads/FlagshipVMAppliance-*.json
git commit -m "Publish the rebuilt VM appliances"
git push origin HEAD:main
# then redeploy .com (step 7) so /downloads/ serves the new manifests
```

Check: `curl -s https://flagshipserver.com/downloads/FlagshipVMAppliance-amd64.json | jq .sha256` (the file names are in `apps/web/public/downloads/`)
equals the run's manifest; one Studio "Host here" on a spare machine reaches a
green padlock.

Rollback: re-point the manifests at the previous commit and redeploy `.com`;
the old R2 parts stay (the script does not delete). Servers already made from a
bad image are deleted and recreated.

## 10. Studio releases (Mac, Windows, Linux)

**Windows and Linux** (`studio-release.yml`, on demand):

```sh
gh workflow run studio-release.yml --ref main -f publish=true
```

The version is `studio` in `release/version.json` (0.2.0, the product version
0.2 Beta; 0.1.3 is the latest GitHub release, 2026-10-16); leave `-f version`
off (a typed one that disagrees fails the run). The workflow stamps the
version into both apps and fails if the built exe or AppImage reports a
different one. Then update the two URLs in
`apps/com/src/route.ts` (`INSTALLER_DOWNLOADS.windows` / `.linux`, they pin
`studio-v0.1.3`, to `studio-v0.2.0` and the `0.2.0` file names), land, and redeploy `.com` (step 7). They ship marked
"Experimental"; neither has been run on a real Windows PC or Linux desktop beyond the
2026-10-18 Windows run recorded in AGENTS.md.

**Mac** (`scripts/release-studio.sh`, needs the notary credentials in the
keychain and `wrangler` on PATH):

```sh
bash scripts/release-studio.sh              # builds, signs, notarizes, staples; stages the DMG; publishes nothing
# check the DMG, then:
bash scripts/release-studio.sh --publish    # commits the DMG to main, pushes, runs tsc and `npm run deploy`
```

Version stamping: `make package-app` writes `studio` from `release/version.json`
(0.2.0) into the app's `CFBundleShortVersionString`, so the Mac app, Windows
and Linux all report 0.2.0 (About: "0.2 Beta"). Nothing to edit by hand. Also note `--publish` pushes straight to `main` and
deploys from whatever checkout you ran it in: run it from `~/flagship-deploy`
after step 7 so the deploy is the same commit.

Check: `curl -sI https://flagshipserver.com/download/mac | head -3` redirects
to `/downloads/FlagshipStudio.dmg`; open the DMG on a second Mac and
Gatekeeper accepts it (`spctl -a -vv /Applications/Flagship\ Studio.app`).

Rollback: `git revert` the DMG commit and redeploy `.com`; for Windows/Linux
point `INSTALLER_DOWNLOADS` back at `studio-v0.1.3` and redeploy.

## 11. iOS and Android store builds

Build these from `main` after steps 3 and 6 (the clients talk to the deployed
`.com`). The store builds carry fixes the earlier builds lack; **the Android
build in particular must be new: the auto-unlock lease signing fix (`64df9098c`,
"sign the auto-unlock lease with the IRK, not the admin root") is client code,
so the version 8 Play build fails to unlock auto-unlock servers correctly**.

**iOS** (`apps/mobile/ios/App/project.yml`): `CURRENT_PROJECT_VERSION` is `"5"`,
`MARKETING_VERSION` `"1.1"` (1.0 build 4 is approved on the App Store; the store
version must climb, so the product version 0.2 Beta shows in About as
"Flagship 0.2 Beta (iOS 1.1, build 5)"). Both numbers come from
`release/version.json` and are already set: nothing to bump for this release (the
next upload needs a higher build: edit the file, run
`node scripts/check-versions.mjs --write`; the `.xcodeproj` is checked in and
carries the numbers too, so commit it), check with the Release-clean scan,
archive and upload:

```sh
node scripts/ios-release-clean.mjs --build          # a Release build for a generic device, scanned for mocks and gym seams
DEVELOPER_DIR=/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer \
xcodebuild archive -project apps/mobile/ios/App/FlagshipApp.xcodeproj -scheme FlagshipApp \
  -destination 'generic/platform=iOS' -archivePath ~/FlagshipApp.xcarchive
# Xcode Organizer -> Distribute App -> App Store Connect (or xcodebuild -exportArchive with an app-store-connect ExportOptions plist)
```

Still to confirm in App Store Connect: the export-compliance answer (the app
does its own X25519 / AES-GCM / Ed25519 sealing) and whether "iPhone and iPad
apps on Apple Silicon Macs" is on.

**Android** (`apps/mobile/android/app/build.gradle.kts`): `versionCode` 9 and
`versionName "0.2"` come from `release/version.json` (About: "Flagship 0.2 Beta
(build 9)"); the Wear app is `versionCode = 1_000_009` (phone + 1,000,000,
same applicationId and signing key). Version codes are burned by any upload:
read the highest in Play Console -> App bundle explorer; if it is 9 or more, raise
`androidVersionCode` in `release/version.json` to one above it and run
`node scripts/check-versions.mjs --write` (the Wear code follows). Needs
`apps/mobile/android/keystore/keystore.properties` with the upload key (without
it the release falls back to the debug key and Play rejects it).

```sh
cd apps/mobile/android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:bundleRelease :wear:bundleRelease
bash scripts/check-release-clean.sh app wear        # no mocks, fixtures or gym seams in the release
```

Upload both AABs to the production track (the Wear one under the Wear OS form
factor). The upload certificate is not in `assetlinks.json` on purpose (Play
re-signs), which means passkey recovery does not work on a sideloaded APK.

Check: after review, install from the store on a clean phone, sign in as the
review login, and unlock an auto-unlock server.

Rollback: a store build cannot be recalled; halt the rollout in the console and
ship a higher version. The notice mechanism (step 12) can ask people to update.

## 11b. Publish the hall of fame entry

After 0.3 is live (never before: the entry describes what 0.3 fixed), merge the local branch `hof-jay`
(the held entry crediting the reviewer; `apps/web/public/security/`) into `main` and redeploy `.com`.
The first commit of `release/0.3` addresses the reported issues alone, so the write-up can point at it.
The script skips the step when the branch is absent.

## 11c. Translations, store art and voi.ci

From `feat/UX` once it is merged: `npm run i18n` (every user-facing string goes through the
translation system; the gate fails on a missing key or a stale native output), the native review in
`i18n/REVIEW.md` (recovery, pairing, unlock and backup wording first; you type `reviewed`),
`npm run store-assets:release-check` (store screenshots and banners per language), and the voi.ci
canonical links: `VOICI_CANONICAL = "1"` in `apps/com/wrangler.toml` once the gym's named-links group
is green, shipped by the phase B `.com` redeploy. The D1 migrations go in number order (0110, 0111,
0112); the webapp shell number and the compatibility matrix move with the UX merge.

## 12. The pre-GA scrub, the reap and the maintenance notice

Order matters; read `docs/runbooks/pre-ga-scrub.md` end to end first. Summary,
with the go/no-go points:

1. **Publish a maintenance notice first** (people with test accounts will find
   their accounts gone). Preview only until you decide; signing needs the
   YubiKey:

   ```sh
   cd ~/flagship-deploy
   node scripts/security-notice.mjs maintenance \
     --message "We will update Flagship on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable." \
     --event <ISO time of the scrub>               # PREVIEW: prints the canonical bytes, writes nothing
   # to publish: the same command with --sign, then
   git add .maintainers/notices && git commit -m "Notice: maintenance on <date>" && git push origin HEAD:main
   cd apps/com && npm run deploy                     # the Worker bundles current.json
   curl -s https://flagshipserver.com/api/notices
   ```

   Retract with `node scripts/security-notice.mjs clear --sign` (then commit and
   deploy). Apps pick a notice up on their next launch or foreground (15 minute
   minimum between polls).
2. Dry run: `WIPE_ENV=prod WIPE_D1=flagship-state bash scripts/wipe-all-users.sh --list-accounts`
   and take its output to yourself for an explicit go. The only kept account is
   `playstore-test-0725`. **Do not run it while a store review is open and that
   account is missing.**
3. Real run (a real terminal; types the database name):
   `WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod bash scripts/wipe-all-users.sh --yes`
4. Verify with the runbook's step 4 (the four orphan counts are 0; the review
   login signs in).
5. **Reap** DNS and demo servers of removed accounts (needs the `.com` deploy of
   step 7, which contains the reap rules). `release.sh` step 19 runs all of this:
   the gym sweep is part of it by default (`npx tsx tools/live-e2e/sweep-cli.ts`,
   then `--destroy`; the step asks you to type `sweep`, or `skip-gym` to skip it,
   and refuses the sweep while `/private/tmp/claude-501/flagship-locks/gym.lock`
   exists), then prod:

   ```sh
   node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan.json    # dry run; read it
   node scripts/reap-orphans.mjs --apply --plan ~/pre-ga-reap-plan.json  # types "delete N records and M servers"
   node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan-after.json
   node scripts/reap-orphans.mjs --review --plan ~/pre-ga-reap-plan-after.json
   ```

   Step 6a (the root wildcard) must be in the zone first: the plan keeps live
   accounts' records until it is. The second dry run must list 0 orphaned records
   and servers, the zone count a handful, then `npm run zone-health` is OK. The same
   pass trims every record at an account or box name (`docs/wildcard-dns.md` section 5).

   **Left on purpose.** `--review` (read-only, no secret) prints, from the second
   dry run, every DNS record the reap kept grouped by why (apex, root wildcard,
   system or reserved label, host record, protected account, an account D1 still
   has, unrecognised shape or not a record Flagship publishes) and every kept
   server with its reason. It adds no deletion rule. Read it: only the protected
   account `playstore-test-0725` and its server should be there besides the
   apex, the wildcard and system names. `release.sh` makes you type `reviewed`
   before the step finishes.

   **Owner checklist: what the tools cannot see.** The reap sees the
   `flagship.services` zone and UpCloud servers labelled `flagship-demo`. These
   need your own logins; `release.sh` asks you to type `checked` or `skipped` for
   each and records the answers:
   - UpCloud console: servers without the `flagship-demo` label. Keep only the
     `playstore-test-0725` server.
   - Hetzner (suspended): servers 153213447, 153638469, 153643080, 153813669,
     155315594 when it unlocks.
   - Cloudflare zone `flagshipserver.com`: stale records pointing at retired
     hosts (the old `web.` record pointed at an unclaimed Surge site).
   - R2 buckets: per-account objects of wiped accounts (`flagship-d1-backups`
     and `flagship-iso` stay).
   - Fly: apps, volumes and secrets besides `flagship-services`.
6. **Retire the wipe tooling** only after step 4 and the reap are verified: the
   ready commit is on the branch `chore/delete-wipe-tooling` (deliberately not
   on `main`; rebase it first):

   ```sh
   git fetch origin && git checkout chore/delete-wipe-tooling && git rebase origin/main
   npx tsc -b && npx vitest run scripts && RELEASE=1 bash scripts/release-guard.sh
   git push origin HEAD:main
   ```

   It deletes `scripts/wipe-all-users*`, makes the release guard fail any build
   in which one reappears, and drops GA close-out item 1 from AGENTS.md.

Check: D1 holds only the kept account(s); `curl -s https://flagshipserver.com/api/health`
is 200; the review login's server is online (give it one heartbeat).

Rollback: the wipe cannot be undone except from the 6-hourly R2 D1 dump
(`docs/runbooks/d1-restore.md`): take a manual export first
(`cd apps/com && npx wrangler d1 export flagship-state --remote --output ~/d1-before-scrub.sql`).
The reap deletes DNS records and demo servers. The DNS records need no recreating
(the root wildcard answers every name); a demo server is recreated from its
account. The plan file and its `.log.jsonl` list exactly what went.

## 13. What should block GA

(From the release-candidate pass; the owner decides.)

- The CA lease expiring 2026-11-05 (step 2): a hard date.
- Store builds: the iOS and Android builds in review/live predate a lot of
  `main` (including the Android lease fix); the current Play build does not
  create servers on a real account (`add-server-admin-only`) until new builds
  and `.com` are in step.
- The arm64 appliance needs a green `main` run published (step 9): until then
  Apple Silicon hosting gets the 2026-10-13 image, which stops at first boot.
- Windows and Linux Studio have not run end to end on real hardware; ship them
  as Experimental (owner, 2026-10-20).
- Mac Studio reports version 0.2.0 (step 10; stamped from `release/version.json`).
- Not run by anyone yet, per AGENTS.md: the whole server restore, docker
  save/load and pg_dump/restore against a real box, and the final root-wildcard
  DNS layout and the Free-plan group (`freePlan`, `a365def74`) on the live gym.
  The groups `quota` and `share` (account-key accept) did run green on
  2026-10-17 (22 groups, 244 checks), and 23 groups, 248 checks on 2026-10-18
  (before the root-wildcard commit).

## 14. Free vs Paid (Workers plan)

`.com` runs on the Workers Free plan (owner, 2026-10-18): 10 ms of CPU a request,
100,000 requests a day, 50 subrequests a request (every D1 call is one). Full
numbers, the caches and the guard test are in `docs/runbooks/workers-cpu-budget.md`.

CPU after the changes (real workerd, `scripts/cpu-workerd.ts`; first number the
request, second the same net of the dev server's floor; a young isolate's first
request is about 1.6 times that):

| Route | D1 calls | ms (net) |
| --- | --- | --- |
| Trusted devices (account directory) | 16 to 4 | 4.7 (1.9) |
| `/pods`, `/stream` first connect | 13 to 3 | 3.6 to 3.9 (0.8 to 1.1) |
| `/stream` held 25 s | 130 to 8 | 6.5 (4.0) |
| `/audit`, device grants | 5 to 2, 7 to 2 | 3.5, 3.6 (0.7, 0.8) |
| box heartbeat (two signatures, doorbell) | 4 to 5 | 4.8 (2.0) |

Every hot route is under 7 ms warm; the directory read is the one that comes closest
cold (about 7.5 ms). `apps/com/test/cpuBudget.test.ts` fails if one grows.

How many accounts fit under 100,000 requests a day, one always-on box each: about 75
(a box now asks about 1,200 times a day, down from about 4,470; a user in the
foreground about 110). Alarm at 70,000, about 52 accounts. Webapp users used to add
about 190 requests each time the shell was released (every static file went through the
Worker); they add none now (see the next table), so shell releases no longer move the
daily total. The account's Worker requests are the sum of `flagship-com` and
`flagship-webapp` (the latter only runs for a missing script or a non-GET: about none).

Worker requests per page load, measured with `scripts/worker-request-count.ts` in local
workerd (a request the assets layer answers by itself is free and unlimited):

| Page load | before | after |
| --- | --- | --- |
| webapp first visit (205 requests) | 205 | 0 |
| webapp, a new shell version (204 requests) | 204 | 0 |
| webapp, same version (service-worker check) | 1 | 0 |
| marketing page view of `/` (10 requests) | 10 | 1 |
| `/docs/`, `/faq`, `/privacy`, `/status/`, `/security/` | 1 + subresources | 0 |

Crons (10 ms CPU and 50 subrequests per invocation, 5 triggers per account; the gym uses
two): the 6-hourly invocation made 230 to 247 subrequests and 36 to 71 ms. It is now
split by `apps/com/src/cronPlan.ts` into ticks of at most 14 subrequests (measured) and about 5 ms
(`apps/com/test/cronBudget.test.ts`); the D1 backup and the model-table refresh run in
GitHub Actions (step 1b). Inventory in `workers-cpu-budget.md` "Crons".

Upgrade to Workers Paid (USD 5 a month) when any of these shows:

- `wrangler tail flagship-com --format json` shows `outcome: "exceededCpu"` (or the
  clients show "The service is briefly unavailable" with `error code: 1102` in the
  request log): the 10 ms limit is being hit;
- the Cloudflare dashboard (Workers > flagship-com > Metrics) shows requests above
  70,000 in a day, or any day reaching the 100,000 cap (Cloudflare then answers
  error 1027 until midnight UTC);
- the D1 backup workflow is red or its newest backup is over 36 hours old (it runs in
  GitHub Actions, so Free is not the cause; but if you would rather have it in the
  platform, the Paid plan's 30-day Time Travel and a 30 s cron allow it);
- the fleet grows: a cron plan that no longer fits (`cronBudget.test.ts`
  red) or the CT rotation stretching past a day (the scan visits 4 users every 20 minutes);
- any need for a webhook-style or per-write wake (the long-poll `/stream` needs a
  Durable Object per account to be pushed).

Time Travel (point-in-time restore) is available on Free for 7 days and on Paid for 30
(Cloudflare docs, "D1 Time Travel"); `docs/runbooks/d1-restore.md` has both restore paths.
