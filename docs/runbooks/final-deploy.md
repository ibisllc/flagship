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

## 1. Cloudflare plan and DNS limits (do this first)

Why: the Workers **Free** plan gives a request 10 ms of CPU. A gym request was
killed by it, and prod runs the same code, so any heavy handler can 1102 for
real people. `.com` also uses Durable Objects (rate limits, relay sessions)
and a 10-minute cron.

1. Cloudflare dashboard, account that owns `flagship-com`: **Workers & Pages
   -> Plans -> Workers Paid ($5/month)**. Nothing in the repo changes
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

Dashboard: Workers & Pages -> flagship-com -> Settings -> shows the Paid plan;
the CPU-time chart no longer has 1102 spikes after step 7.

Rollback: a plan change is reversible in the dashboard (downgrading puts the
10 ms limit back, so don't, unless billing forces it).

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
  needed for the daemon. At the time of writing the newest endorsement was
  `e07f6ba7` (2026-10-18) and the only later box-path change was
  `64df9098c` (a test vector); the wildcard-DNS change needs nothing on boxes
  (`docs/wildcard-dns.md` section 8).
- Anything else: endorse the new tip.

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

## 4. Pending D1 migrations

D1 migrations are applied by hand, before the Worker deploy, because the Worker
reads the new tables.

```sh
cd ~/flagship-deploy
ls packages/storage/migrations | tail -3                 # newest file in the repo
cd apps/com
npx wrangler d1 execute flagship-state --remote \
  --command "SELECT version FROM schema_version ORDER BY version DESC LIMIT 5"
```

State at the time of writing: the repo's newest migration is **0105**
(`0105_re_pair_proof.sql`) and prod has 0105 applied, so **nothing is pending**.
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

## 6. Gym refresh and live verification of the root wildcard (GATE: nothing deploys to prod until this passes)

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
account's before these exist (the guard in `docs/wildcard-dns.md` section 5). So
this step may come before or after the `.com` deploy (step 7), but the trim
(step 8's follow-up and step 12) needs it.

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

**Gate result (2026-10-18, gym Worker with `2963833d7`, relay v18):** full run
248 checks, 0 failed; the first box's issuance, polled 1,700 times per target and
resolver, never answered NODATA or NXDOMAIN for the box name or a label under it
(`docs/wildcard-dns.md` section 11.6); zone back to its base.

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

## 7. Deploy `.com`

```sh
cd ~/flagship-deploy
git fetch origin && git checkout --detach origin/main && npm ci && npx tsc -b
cd apps/com
npm run deploy        # predeploy: clean rebuild of the bundled packages, route-safety, dist freshness, orphaned output, prod-migration drift
```

This deploy carries the root-wildcard logic (no address or CAA record is written
for anybody; legacy records are cleared once the step 6a wildcard exists; the new
reap rules and `zone-health`; the challenge shield is gone): it needs the step 6 gate green,
**no D1 migration** and **no endorsed box release** (boxes only publish and
delete their own `_acme-challenge` TXT through `.com`; they publish no A, AAAA or
CAA). The hourly legacy sweep stays off until you set `DNS_LEGACY_SWEEP=1`. Do not use `--force` or set `FLAGSHIP_SKIP_*`. If the migration check says it
cannot read the ledger, log in (`npx wrangler login`) and rerun.

Check:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://flagshipserver.com/api/health            # 200
curl -s https://flagshipserver.com/api/health | head -c 300
curl -s https://webapp.flagshipserver.com/service-worker.js | grep -m1 SHELL_VERSION        # = main's SHELL_VERSION (v150 at the RC pass)
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
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services
```

`--strategy=immediate` drops every box's tunnel for about 20 seconds; that is
expected. Do it when nobody is mid-unlock.

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
"preview"; neither has been run on a real Windows PC or Linux desktop beyond the
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
   step 7, which contains the reap rules): gym leftovers
   (`npx tsx tools/live-e2e/sweep-cli.ts`, then `--destroy`), then prod:

   ```sh
   node scripts/reap-orphans.mjs --show --out ~/pre-ga-reap-plan.json    # dry run; read it
   node scripts/reap-orphans.mjs --apply --plan ~/pre-ga-reap-plan.json  # types "delete N records and M servers"
   ```

   Step 6a (the root wildcard) must be in the zone first: the plan keeps live
   accounts' records until it is. Re-run the dry run: 0 orphaned records and
   servers, zone count a handful, then `npm run zone-health` is OK. The same pass
   trims every record at an account or box name (`docs/wildcard-dns.md` section 5).
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
  as preview (already the plan).
- Mac Studio reports version 0.2.0 (step 10; stamped from `release/version.json`).
- Not run by anyone yet, per AGENTS.md: the whole server restore, docker
  save/load and pg_dump/restore against a real box and the live gym groups
  `quota`, `share` (account-key accept) and the group list newer than the last
  live run on 2026-10-15/16.
