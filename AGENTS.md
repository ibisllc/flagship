# Flagship — orientation for Codex

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. `CLAUDE.md` imports this file using Claude Code's supported `@AGENTS.md` syntax; never hand-sync a second copy. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state); its host-rewrite for webapp./remote. is kept for dev and the gym
apps/webapp-static/        Static-only Worker `flagship-webapp`: webapp./remote.flagshipserver.com (assets generated from apps/web/public/webapp; zero Worker requests)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   studio/                 /studio — short desktop download + direct phone-pairing guide
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on webapp. AND remote.flagshipserver.com)
apps/mobile/               iOS Swift + Android Kotlin clients — substantial code; not yet on TestFlight/Play

packages/protocol/         Canonical-bytes + Ed25519 sign/verify for every signed message
packages/storage/          Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane/    Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon/    PRODUCTION daemon entry (acme, tunnel client, service runner, lease store, browser bundle)
packages/hello-daemon/     Minimal demo daemon — kept around for chain smoke-testing only
packages/iso-personalizer/ Trailer format (build/parse/personalize-stream)
packages/installer-apkovl/ Builds the apkovl tarball baked into the Alpine ISO
packages/tunnel-protocol/  Frame format for the tunnel + SNI parser
packages/services-zone/    `<server>.<user>.flagship.services` validation + DNS publisher
packages/bootkey-builder/  Caddyfile + per-server FQDN/SAN helpers
packages/llm-providers/    BYOK provider adapters

billing/                   Standalone, reusable repo-in-a-folder (own lockfile, CI billing.yml; mirror +
                           npm publish await the owner): @ibisllc/billing-metering (core, /conformance, /http)
                           + store-sqlite / store-postgres / store-d1. Flagship uses metering + store-d1 as
                           workspaces. Generic only: no Flagship names or imports. Vouchers next.

installer/                 Public install scripts the apkovl curls at boot
   install.sh              First-boot installer: LUKS + git clone + register
   boot-stage.sh           Steady-state boot: contact .services for unlock-key

Dockerfile                 Builds the Fly app image
fly.toml                   :443 raw-TCP (SNI passthrough) + :8443 TLS-term (API + tunnel hub)
```

## Architecture in one sentence

**`.com` (Worker + D1 + R2)** owns identity & persistent state. **`.services` (single Fly app)** is a stateless pipe: SNI passthrough on :443 + tunnel-hub WebSocket on :8443. **The user's daemon** runs ACME locally (TLS-ALPN-01 over the same passthrough chain), holds the Let's Encrypt cert, and serves services. **Routing-Control-Key (RCK)** is a phone-held primitive that decouples "who can claim a subdomain's traffic" from "which server is currently handling it" — enables failover/migration/delegation.

## Live URLs

- `https://flagshipserver.com/` — landing
- `https://webapp.flagshipserver.com/` — the owner webapp (PWA)
- `https://remote.flagshipserver.com/` — browser remote (phone-approved, keyless)
- `https://flagshipserver.com/studio` — download Studio + direct phone-pairing guide
- `https://flagshipserver.com/status/` — live health
- `https://flagshipserver.com/api/health` — JSON health
- `https://flagship.services/api/health` — direct Fly health
- `https://<server>.<user>.flagship.services/` — user content (after a real install)

## Common operations

```sh
# Tests
npx vitest run                                  # everything (~3 min)
npx tsc -b                                      # typecheck the whole tree

# Deploy
npx tsc -b && (cd apps/com && npm run deploy)   # Worker — it bundles the BUILT dist/ of the packages in scripts/com-bundled-packages.sh. Use `npm run deploy` (NOT `wrangler deploy` directly): its `predeploy` rebuilds those packages from an empty dist/ (scripts/clean-build-com.sh — `tsc -b` alone never deletes a removed module's output) and then runs the guard (scripts/predeploy-com.sh — route-safety + dist-freshness + orphaned-output + static-asset list + migration drift), and after flagship-com deploys the webapp Worker (scripts/deploy-webapp-static.sh)
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# D1 schema migrations
cd apps/com && npx wrangler d1 execute flagship-state \
    --file=../../packages/storage/migrations/0003_install_events.sql --remote

# Smoke a fresh build chain
# 1. Create and download a signed recipe from the webapp (or pair a phone with Studio)
# 2. Open the recipe in Flagship Studio and write the installer
# 3. Boot the target, then curl https://<assigned-subdomain>/
```

## Conventions

- **No `Co-Authored-By: Codex` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.
- **Minimum OS = the oldest version that is still SAFE to use** (owner rule,
  2026-10-07). "Safe" = the vendor still ships security fixes for that branch
  AND every security feature the app relies on works there. Never raise the
  floor for convenience; raise it when a branch stops getting security fixes
  or a security-critical API needs it. Re-check on every toolchain update.
  Current floors: **iOS/iPadOS 18.0** (iOS 17 stopped receiving fixes, every
  iOS 17 iPhone can run 18, and passkey PRF — cloud recovery — is iOS 18+),
  **watchOS 11.0** (the iOS 18 companion), **Android 13 (`minSdk 33`)** and
  **Wear OS 4 (`minSdk 33`, owner decision 2026-10-17)**. Android 13 is the
  oldest branch where every security feature the app leans on exists: the
  Recents screenshot block for the app lock (`setRecentsScreenshotEnabled`,
  API 33), the sensitive-clipboard flag for API keys (33), the runtime
  notification permission for content-free pushes (33), non-exported broadcast
  receivers, and the biometric-or-credential key auth parameters (30). Android
  9 to 12 lack the first three, so they were dropped rather than carried with
  weaker behaviour; the API-level branches for them are gone from the code.
  That older Android branches are mostly out of vendor security support is
  general knowledge, to verify against vendor bulletins (a mid-2026 check found
  Samsung S22 and later, and Pixel 6 and later, still patched, older phones
  phasing out); the decision rests on the three missing features. Wear OS 4 is
  Android 13, so the watch matches the phone.
  **macOS 15** for Studio (Sequoia; Sonoma stopped getting fixes, owner
  decision 2026-10-17; the mobile packages' `.macOS("15.0")` is host-build
  only and follows Studio). Platform versions in the `swift-tools-version:5.9` manifests use the
  string form (`.iOS("18.0")`); `.v18` needs tools 6.0, which also flips on
  Swift 6 strict concurrency.
- **An AI never learns who or where the owner is** (owner rule, 2026-10-12;
  `docs/ai-privacy-and-staging.md`). Nothing a model (the box's own AI or an
  IDE agent) reads may name the account, the server, the owner's other apps,
  their address, time zone, locale or habits: keep it out of prompts, and
  pass every box-written text a model reads back (tool results, errors,
  logs) through `buildModelRedactor` (`server-daemon/src/llm/modelPrivacy.ts`).
  An AI only ever works on a private staging copy with sample data, and a
  live service is never attached to an AI session again.
- **A visitor's identity is per app** (owner rule, 2026-10-13;
  `docs/service-access-gating.md`). A person's key toward an app is derived
  from their account root and that app only, whoever invited them, so a
  server owner can link two grants for the SAME app ("John" and "Chess
  Club") but never the same person across two apps or servers. No
  long-lived id may be shared between contexts. Apps decide what each rank
  may do; the box never blocks writes by rank.
- **Three ranks, and only admins change them** (owner rule, 2026-10-15;
  `docs/service-access-gating.md` "Account members"). Exactly member <
  manager < master (no owner rank). In every app, by default: the owning
  account's admin devices are master, its other devices and co-managing
  accounts manager, people they invite member. Invite and withdraw rights
  come from being manager-class in that app (a non-admin device, or a
  co-manager at "Can manage", invites only at Member and withdraws only its
  own invites; a demoted, refused or view-only one's links stop letting new
  people in). Only admins change ranks (demotion and refusal
  included), modes, or remove others, and the box enforces it: the admin root
  on admin-pinned boxes, never the IRK. Admins keep one biometric per invite.
- **One access list per app across the account's servers** (owner rule,
  2026-10-15; `docs/service-access-gating.md` "One list per app"). The app's
  lead server distributes signed changes box to box in server order; every
  box verifies every entry itself; nothing about members goes through
  `.com`. Separate per-server lists are a later Pro option (branch only).
- **Only `main` is deployed** (owner rule, 2026-10-15). `main` is the sole
  source of truth: every `.com`, `.services`, shim or box release is built
  from a commit that is already on `main`, or lands on `main` (pushed)
  straight after a deploy that had to go first, e.g. a security fix that
  must be live before it is public. Never leave deployed code only on a
  branch or worktree. Feature branches deploy only to the gym.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace; also Pro payments + vouchers), **`feat/retail`** (getting the
  app working with retail / NFC boxes), **`feat/browser-extension`**,
  **`feat/phone-usb-burn`** (Android burns a USB stick on its own),
  **`feat/other-os-installers`** (the Ubuntu autoinstall and Debian-netboot
  installer paths `main` shed on 2026-10-18, kept for a possible multi-OS effort),
  **`feat/data-sovereignty`** (parked 2026-10-18, not needed at launch: rescue a
  server's data over the LAN when `.com` is gone; plan in its
  `docs/data-sovereignty.md`),
  **`feat/custom-names`** (dibs + paid name change) and **`feat/custom-domains`**
  (custom domains as a Pro feature) and **`feat/outbound-proxy`** (a box's
  traffic through a proxy + OHTTP setup) — the last three branch OFF `feat/marketplace`
  (they need its payment rail), so rebase them onto it after it moves.
  **No marketplace/retail code may sit on `main` until
  that feature launches** — branching IS the gate, there is NO gating/flag code
  in `main`.
  - **`feat/transfer-a-box` was a *develop-then-MERGE* branch — DONE.** Merged to
    `main` 2026-06-22 (branch deleted); only the box-side re-home + disk-key
    handshake reburn-validation remains (see the status log). Design:
    `docs/account-deletion-and-name-reclaim.md` §4.
  - **`alpine` is a *parked* branch, not a feature-to-launch.** It holds the
    full Alpine bare-metal installer path (ISO builder + apkovl + installer-tiny
    + the builder Quick/trailer flow + `/api/personalize-iso`) that `main` shed
    when we went Debian-only. Same mechanics (it's `main` + the Alpine delta,
    built by reverting the removal commits — `git diff <pre-extraction> alpine`
    was empty = lossless), but its purpose is *revival* if/when the Alpine
    initramfs USB-enumeration blocker is solved, not merging into a launch.
  - **Each branch = `main` + exactly one feature.** A branch is built so its
    diff against `main` is *only* that feature (so merging it ships the
    feature). Branches are **independent of each other** — you can check out one
    at a time to work on it; neither carries the other's code.
  - **Dependencies go through git, not entanglement.** If a feature ever
    depends on another, branch it OFF that feature's branch — never co-mingle
    two features on one branch.
  - **Extraction/reorg is forward-only** (no history rewrite on `main`) and
    **lossless** — nothing in features/UX/code/tests is lost, only relocated;
    anything removed from `main` exists on the feature branch.
  - **Workspace artifacts stay on `main`, never extracted:** DB migrations +
    repo-root `docs/*` design specs. Neither ships to users or the website —
    they're dev scaffolding. A feature-only table in prod (`marketplace_listings`,
    `box_serials`) is fine: develop the feature by checking out its branch and
    running against the live table. Only *application* code is extracted.
  - **At commit time, weigh impact on the feature branches** — they don't
    auto-receive `main`'s commits, so a `main`-only fix to shared code needs
    cherry-picking forward when a branch is integrated.


## Current status & open work

> **Current state only.** Update entries in place as work lands; delete them
> when done. History up to 2026-10-10 is frozen verbatim in
> `docs/archive/status-log-through-2026-10-10.md`; read it for the why behind
> anything below. Keep this section short: it loads into every agent session.
> Last updated **2026-10-18**.

### Launch

Scope agreed 2026-10-13 in `docs/launch-mvp.md` (date to be set): free only,
no payments; free AI credits on by default; free tier slowed, not cut, past
25 GB; custom domains, name change + dibs, marketplace and payments come
after. Windows/Linux Studio ship as "preview". **Share this server** (another
account can view or co-manage a server, never destroy it) is in the MVP
(`docs/share-a-server.md`; on `main`).

**One product version, 0.2 Beta (owner, 2026-10-18).** The homepage badge, the
webapp, iOS, Android and every Studio show the same product version, `0.2`
labelled Beta, from `release/version.json` (the only file to edit; then
`node scripts/check-versions.mjs --write`; `npm run parity` fails on drift).
The stores keep their own numbers: iOS 1.1 build 5 (1.0 is approved; the store
version must climb), Android versionCode 9 (wear +1,000,000), Studio 0.2.0.
About reads "Flagship 0.2 Beta (iOS 1.1, build 5)" / "(build 9)". Protocol
levels and the webapp shell number are separate and unchanged.

**Release readiness (2026-10-15):** `npm run ready` is the scoreboard to re-run
after each batch of fixes (branch drift, tsc, vitest, e2e, locked gym, cross-
client parity; `-- --native --live` before a release candidate). Loop and
owners: `docs/runbooks/release-readiness.md`; feature matrix:
`parity/features.json` (`npm run parity -- --report`).

### Recurring: ask the owner to check the rate limits

About once a week (and at the start of a launch-week session), ask the owner
to run `npm run rate-limits` (needs `FLAGSHIP_ADMIN_SECRET`; `-- --days 30`
for a month) and decide whether any budget in `apps/com/src/rateLimit.ts`
needs moving: many distinct sources refused means real people hit it;
many near passes with no refusals means little headroom. Record the date
of the last check here: **not yet checked**.

### Urgent

- **Renew the CA endorsement lease before 2026-11-05.** The production CA's
  only live lease (`.maintainers/ca-endorsements/bundle.json`) expires then, and
  every CA-chain check fails closed after it (app trust checks, relay blessing,
  Alpine bootstrap). Needs the owner's YubiKey: mint a `CaEndorsement` with the
  maintainers CLI, commit it, redeploy `.com`.

- **The `flagship.services` DNS zone is nearly full (2026-10-16); the fix is on
  `main`, not deployed (2026-10-18).** Cloudflare Free caps the zone at 200
  records (and fixes the SOA negative-cache time at 30 minutes); prod held ~154
  when measured, ~70 of them leftovers of accounts with no server. Owner decision
  2026-10-18 (`docs/wildcard-dns.md`): the **root wildcard**. The zone holds ONE
  `*.flagship.services` A + AAAA (the relay, DNS only) and ONE apex CAA pair
  (`issue`, `issuewild` "letsencrypt.org"): **about 4 records at rest, 0 per
  account or box, 2 temporary challenge TXT per certificate in flight**, so
  thousands of accounts fit and Cloudflare Free suffices. `.com` writes no
  address or CAA record for anybody any more; a record owned by an account or box
  name stops the wildcard below it (measured, section 3 of the doc), so what
  earlier layouts left is removed: at each account's next event (issue,
  register, un-revoke, transfer, revoke), by the reap tool (`npm run
  reap-orphans`: every A/AAAA/CAA/TXT at an account or box name, live accounts
  too once the wildcard is in place) and, opt-in (`DNS_LEGACY_SWEEP=1`), hourly.
  Nothing is deleted before the wildcard is in the zone at exactly the relay's
  address. The challenge shield is REMOVED (a TXT below a name blocks nothing; measured, it was harmful); direct-IP
  servers are refused (`direct-mode-unsupported`); `republish-server-dns` is gone.
  `npm run zone-health` (read-only, exit 1 on a missing/wrong/proxied wildcard,
  a missing apex CAA or any record at an account or box name) is the standing
  check; run it after the manual step and weekly. The gym core group checks the
  account holds ZERO records and its names resolve through the zone wildcard.
  **To do (owner):** (1) the one-time manual DNS step in Cloudflare
  (`docs/runbooks/final-deploy.md` step 6a): `*` A = `149.248.216.86` and `*`
  AAAA = `2a09:8280:1::110:d2b6:0`, both DNS only (grey cloud; confirm with
  `flyctl ips list -a flagship-services`), plus the apex CAA `0 issue
  "letsencrypt.org"` and `0 issuewild "letsencrypt.org"` (the apex has none
  today), then `npm run zone-health`; (2) deploy `.com` (`apps/com`; no D1
  migration, **no endorsed box release**, the relay needs nothing new for this);
  (3) a live gym run first (step 6), then the reap (dry run, then `--apply`) and
  `npm run zone-health` again. The protected review account keeps its own
  records until its review ends.

### In flight

- **`.com` on the Workers Free plan (owner, 2026-10-18; 10 ms CPU a request, 100,000
  requests a day, 50 subrequests).** `docs/runbooks/workers-cpu-budget.md` has the
  limits, the measurements and what each cache is keyed on. Done on `main`: reads
  started together leave as one D1 batch and are remembered until a write
  (`RequestD1`), native Ed25519 first plus a memory of verified triples, a
  light held `/stream` (130 D1 calls to 8), noble's 20 ms table built at startup;
  the directory read went from 16 D1 calls and about 9 ms to 4 and 4.7 (net of the
  dev floor 6.7 to 1.9). `scripts/cpu-profile.ts` / `cpu-workerd.ts` measure;
  `apps/com/test/cpuBudget.test.ts` is the guard. Clients back off while `.com`
  fails (webapp shell v153, iOS and Android live-sync loops). **The box doorbell**:
  the heartbeat reply says which lanes hold something and carries a digest of
  aliases, device grants and rotations; a box skips polls it says are empty (a box
  asks about 1,200 times a day, was 4,470: about 75 accounts fit under 100,000, was
  21). Needs a `.com` deploy first (shell v153), then an endorsed box release (an
  old box simply keeps polling), and iOS/Android store builds for the backoff.
  **Static files and crons (2026-10-18, built on `main`, needs a `.com` deploy):**
  `webapp.` / `remote.flagshipserver.com` moved to a static-only Worker
  `flagship-webapp` (`apps/webapp-static`, assets built by `scripts/static-assets.ts
  build-webapp`, headers from `apps/com/src/securityHeaders.ts`): a shell install or
  update was ~190 Worker requests per user and is now 0; `flagship-com` runs
  `run_worker_first = ["/*"]` minus 46 listed static files (a page view of `/` went
  10 to 1), guarded by `scripts/predeploy-com.sh` and `apps/com/test/staticAssets.test.ts`.
  **First deploy: run `bash scripts/deploy-webapp-static.sh` BEFORE `npm run deploy`**
  (`npm run deploy` now runs both afterwards); `final-deploy.md` step 7. The Worker's
  crons are split into budgeted ticks (`cronPlan.ts`, `cronBudget.test.ts`; the 6-hourly
  one made 230 subrequests and 36 ms); the **D1 backup and the model-table refresh run in
  GitHub Actions** (`d1-backup.yml`: daily, gpg-encrypted to the security@ key, R2
  `flagship-d1-backups`, fails when over 36 h old; `docs/runbooks/d1-restore.md`;
  `model-capabilities.yml`). **Owner, before the first deploy** (`final-deploy.md` step 1b):
  create the bucket, add the repo secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, run the backup once. Without it the deploy removes the only
  backup. Open: the adapter publish takes 4 new files a day on Free; the gym Worker
  still serves everything itself (the static-only path is covered by tests and a local
  workerd smoke, not the gym). Next: gate the
  invite-revocation and share-end polls on the doorbell (576 requests a day a box).
- **Account gone (2026-10-18, N1, `docs/account-gone.md`).** After the pre-GA
  wipe a signed-in device must learn its account no longer exists. `.com`
  answers `404 { error, code: "account-not-found" }` before any auth check on
  every own-account route (read-token, pods, stream, audit, device-grants,
  directory/profile, server-order, orders, lists); a real or demo account is
  unchanged. The webapp (shell v145) shows a full-screen "This account was
  removed" (Create a new account / Remove it from this browser), stops polling
  and toasts, and forgets the stored account. It says a saved backup can be
  restored into a new account, and warns before anything removes the device's
  admin key (also Settings Sign out and Remove this device; "Save my account
  key first" opens the key export); the 404 is metered on the `account-resolve` budget and the
  read-token mint has its own. Gym `gym-gone.spec.ts`, parity row
  `account-gone`. Needs a `.com` deploy (and the shell with it). iOS (and
  Android) do the same on `main`: the one request gate (`gatedData`) sees every
  answer, later calls for the gone account are answered locally, a window
  above everything shows the screen, and Settings Sign out / Remove this
  device and the screen's Create / Remove warn first when the device holds an
  admin root or a server session (gym `GymAccountGoneTests`). The rescue
  flow was moved off `main` (owner, 2026-10-18): the screen says "If you saved a
  backup of your servers, you can restore it into a new account." and the
  warnings send people to a backup of the account key ("Save my account key
  first"). Needs iOS/Android store builds.
- **Security notices (2026-10-18, `docs/security-notices.md`).** One
  maintainer-signed notice, picked up from one anonymous `GET /api/notices`,
  for (A) a dismissible "we will update on {date}" banner and (B) a full-screen
  "Update required" lock, only for a security reason (an advisory id and reason
  are in the signed bytes). Signed offline by the cold ca-track YubiKey with
  `node scripts/security-notice.mjs <maintenance|advisory|required|clear> ...
  --sign` (previews by default; refuses a lock without `--advisory` and
  `--security-reason`), never by `.com`; apps verify against the baked pin and
  fail open. On `main`: the envelope and vectors, the tool, the `.com` route
  (committed notice `null`), the webapp (shell v144) and its gym scenarios.
  The iOS port is on `main` (`SecurityNotice.swift`, the shared vectors,
  one anonymous fetch on its own session, the banner, and the lock in its own
  window above every sheet; while locked every API request goes through
  `gatedData`, which refuses writes and box calls; gym `GymNoticeTests`), and
  Android's port too: both need store builds. Needs a `.com` deploy and a
  webapp deploy to go live; nothing is signed. The version-window rule for protocol changes
  is a design only (section 7: not built; window 0 for a security break).
- **Per-app disk limits (2026-10-16, `appQuota/`, docs/app-runtimes.md §5.3).**
  Hold each app to its share of the backup policy's limit: a files folder is
  its own sparse ext4 image (ENOSPC for that app only; a lower limit is a
  preallocated ballast), a database at its budget loses INSERT/UPDATE (and
  lo_* writes) until it's back under, app roles have connection/timeout/
  temp-file limits, orphaned images are set aside a day, deleted a week
  later, and a 90 % disk brake applies with no policy. server-detail
  and app-detail carry `storage`; a full app is Activity `app.storage.full`
  + `app-storage-full` phone alert + content-free push. Tested on a real
  Postgres 18 and real loop images on a Debian 13 VM (CI runs both). Needs
  an endorsed box release; the webapp (shell v132) and Android show `storage` and the alert, iOS doesn't yet;
  live gym group `quota` not run yet.
- **Live gym on UpCloud, all green (2026-10-17).** `bash scripts/gym-refresh.sh`
  (rebases `gym` onto main, gym D1 migrations, secret parity, deploys the gym
  Worker and Fly app) is gym:weekly's phase 0; the live half is
  `npx tsx tools/live-e2e/shared-run.ts` (`--list` shows the 22 groups: core,
  gating, invites, enforcement, server-order, runtimes, real-account,
  access-lists, ai-staging, share, api-keys, remote, ai-chat, migrate,
  app-copy, archive, mcp-ide, activity, quota, backups, one-list, update,
  lifecycle). It tears everything down through the gym-only
  `/api/gym/teardown`; never pass `--keep` for a full run (it turns off the
  staged release of boxes, and the shared `flagship.services` zone, 154 of 200
  records without the gym, then fills). Latest runs: 10-18 248 checks, 23 groups, 57 min (gym Worker at `2963833d7`, before the root-wildcard commit; the final DNS layout has not run live); 10-17 244 checks, 22 groups, ~67
  min, peak 4 boxes. Rules learnt: gym boxes clone the **`gym` branch**, not
  main (only it carries the gym trust pin, and the gym CA chain in
  `.maintainers/`, which a box reads from its checkout; without them a share's
  account-key attestation is `accept-unverifiable`), except the `update`
  group's box (B3, home3 of account B), which clones **main** because only main
  keeps the prod pin that lets a box list endorsed releases. Box fixes need
  landing on main, then `gym-refresh.sh`, before a rerun; a box reads its
  daemon log with `tools/live-e2e/journal-cli.ts <demo-user> home 2000 <regex>`
  (demo accounts only) while a group runs. Found by it and fixed on main: a
  first saved/migrate backup failed with ENOENT on a never-made folder, and a
  small files limit left an app 16 MiB less than its limit (ext4's reserve is
  never in bavail). Cloudflare rate-limits DNS deletes: if a sweep reports
  `dnsFailed`, wait 30 s and run `fleet-cli.ts sweep --destroy` again until the
  zone is back to its base. The gym D1 is no longer zeroed between runs (owner,
  2026-10-18; `gym-weekly.sh` has no wipe phase): runs use unique account
  names, tear down through `/api/gym/teardown`, and the fleet sweep covers the
  rest. Open: the `update` group can only move a gym box
  (unendorsed main HEAD) to an older endorsed release;
  `/api/dev/sample-user/<u>/order-update` assumes the prod apex.
  2026-10-18: `boot.gym.`/`recovery.gym.` fell through to the `.services`
  proxy (hard-coded prod hosts in `route.ts`), so a gym box could never post
  its unlock request: fixed on main (`bootHost`/`recoveryHost` follow
  `CONTROL_APEX`), live after the next `gym-refresh.sh`. The gym Worker was
  killed at ~11 ms CPU on signed reads (Cloudflare 1102 = HTTP 503 in the
  apps; a directory read measured 15-21 ms): the CA mandate chain was
  re-verified on every request, now once per isolate. Open: if 1102 persists,
  check the Worker's CPU limit (a Free-plan limit is 10 ms).
- **Scheduled backups, backup policy, one `.flagship` file, Migrate on the
  archive path (2026-10-16/17, `docs/server-backup-and-clone.md`).** Box:
  scheduled backups with retention and a KEK-pool deposit
  (`flagship/server-archive-keys/v1`), a signed `flagship/backup-policy/v1`
  (phone reserve / peer 1/3 / none) with the size limit, one `FLGSHBK1`
  file served with Range, Migrate that pauses apps and pulls box to box,
  restore from peers (`from-peers` route). Webapp: Backups section, policy at
  create, download/import, Migrate data move, per-app storage. Needs an
  endorsed box release and a `.com` deploy. Android client on `main`
  (2026-10-17: policy, Backups section, one file, wizard policy, phone copy
  by WorkManager; unit + 14 emulator mock-gym checks green, the worker not
  run on a device). iOS client on `main` (2026-10-17, `e4c9c4e82`,
  `cc12850a8`: Backups section, policy, one file, phone copy, per-app disk
  use and the `app-storage-full` alert, peer backup v2 status and "Restore
  from other servers"; not built for a device or run on a real box).
  Missing: live-gym checks (Migrate: two boxes, data moves, old
  box wiped). Webapp peer backup (2026-10-17, shell v134): Settings →
  Peer-backup is the v2 status (the v1 pool toggle is gone), and Add/Import →
  "Restore from other servers" derives the lost server's PBK from the UMK,
  has a running server (or the browser, from the sealed `.com` record) read
  the record, opens its backup, creates the server and calls `from-peers`
  (`lib/peerBackup.js`, parity `peer-backup-v2`; iOS the same; Android still
  shows the v1 screen).
- **iOS stream, admin and IDE items (2026-10-16/17).** Debug access v2 on the
  server page (SSH key, admin-signed, expiry, Face ID per grant; Keystore-only
  root, no gym seam in Release: `79c8021b7`..`5d97446bf`). Share-accept
  admin: only an admin device accepts a co-manage share, with .com's key
  attestation and the box's refusal sentences (`6ba659a3a`). Connect your IDE
  shows each IDE's own config (`f514ec4ff`). Add a device is admin-only
  (`831d87ec1`). All mock-gym covered; not run on a physical iPhone.
- **Backup/clone server, Add/Import a server, Migrate wipes, Activity
  (2026-10-15):** `docs/server-backup-and-clone.md`. A backup is two files:
  a small `.flagship-backup` (key slots + the saved server's settings, apps,
  and the data file's size and SHA-256, sealed under a random content key)
  and the `.flagship-data` (the apps in AES-GCM frames). Slots: a passcode
  slot (Argon2id; the apps suggest a 100-bit passcode or take one with 20
  chars / 12 with three kinds) and an account slot (the UMK archive key), so
  backups can be shared or restored after the account is lost. Vectors
  `packages/protocol/test-vectors/server-backup` + `server-restore` (TS,
  webapp, Swift, Kotlin). **Import a backup** is one flow: pick
  both files (read in place), open (account slot, else passcode), stream-check
  the data file, pick a name (saved one filled in unless taken; checked as
  typed), the existing create/burn screen makes the server with the saved
  settings and an IRK-signed `flagship/server-restore/v1` beside the pairing
  order; the box adopts it only if it verifies, then accepts that one data
  file from an owner session, reports `awaitingBackup` on its heartbeat
  (`/pods`, Home: "Waiting for its backup" with Send / Delete), resumes
  uploads across restarts, checks size + SHA-256 before the key opens it,
  and stops waiting once the apps are restored. Boxes no longer accept a
  backup they weren't created for. Webapp,
  iOS (`cc951258`..`01b0db0a`; mock gym: import screen, waiting server,
  passcode step) and Android (`4be9a598`; saves both files into a
  picked folder) at parity. `.com` (relays `awaitingBackup` on `/pods`, no
  migration) and the webapp are live since the `3e8fef1de` deploy (shell
  v113). Needs an endorsed box release and iOS/Android store builds. Not run on a real box or phone: the whole
  restore, docker save/load and pg_dump/restore (fake ops in tests).
  Migrate always retires and wipes the old server (staged `awaiting-confirm`
  wipe, leases dropped at take-over); the box activity log records updates,
  apps, migration, decommission, backups and restores, merged into all
  three Activity tabs. Open: the server's description isn't carried (it
  lives on the phones); a restore whose apps partly fail still ends the
  waiting (the failures are listed); only the creating device holds a
  session for the new box until another device pairs; peer-backup shards,
  Forgejo repos aren't in a backup; a late wipe still needs the old box's
  daemon to run.

- **Build cost measurement (2026-10-14, `infra/inference/build-eval`):**
  scripted app builds, edits and fix rounds through the box's own build loop
  and the real shim, against DeepInfra, to set the free-AI allowance from
  real numbers instead of the 474k-per-build estimate. Tested with its mock
  model only. **Owner:** put a DeepInfra key in
  `~/.config/flagship/deepinfra-eval.key` and run `npm run build-eval` (stops
  at $5), or add the `DEEPINFRA_API_KEY` repo secret and run the
  `build-eval.yml` workflow (Docker build check + Postgres).
- **Flagship Inference (2026-10-13): built on `main`, not live.** A launch
  promotion ("for a limited time, building your apps is free"). Per account:
  a one-time starter reserve plus a weekly top-up (ISO week, not
  accumulating, spent first), only while the account has a server that
  reported in the last day; one all-accounts daily cap pauses it for
  everyone; output tokens weigh 4×. Config on `.com` (defaults):
  `AI_PROMO_STARTER_TOKENS` 2M, `AI_PROMO_WEEKLY_TOKENS` 500k,
  `AI_PROMO_DAILY_CAP_TOKENS` 50M, `AI_PROMO_INPUT_WEIGHT` 1,
  `AI_PROMO_OUTPUT_WEIGHT` 4, `AI_PROMO_ENDS_AT` (unset; after it the apps
  hide free AI). The apps sign `flagship/llm-promo-issue/v1`, `.com`
  `/api/free-ai/token` mints a 12-hour pass, the box calls the meter shim
  (`infra/inference/shim`) through the relay, and the shim checks
  `/api/free-ai/allowance`, strips anything identifying, calls any
  OpenAI-compatible upstream and reports usage, counted on the metering core
  (`ai-promo-*`). All three apps show "1,840 free credits left · 500 added
  each week" (1 credit = 1,000 weighted tokens; `.com` sends the credit
  fields) and skip the AI-key step for an owner with no key;
  `docs/build-modes.md`. **Owner:** pick a hosted model API with tool calls,
  no prompt retention and prepaid credit; deploy the shim with
  `UPSTREAM_CHAT_URL`/`UPSTREAM_MODEL` + secrets `UPSTREAM_API_KEY` and
  `FLAGSHIP_INFERENCE_TOKEN_SECRET`; set the same secret and
  `FLAGSHIP_INFERENCE_ENDPOINT` on `.com` and redeploy it
  (`infra/inference/README.md`). Box side ("Show free AI refusals on the box
  in the shim's words": default model, readable refusals) needs endorsing;
  older boxes still build, as the apps send the model (git adapt excepted).
- **iOS 1.0 (build 4) approved on the App Store (2026-10-13).** Reviewer login:
  demo `playstore-test-0725`, shared with Google Play review: never tear it
  down while a review is open (Studio's store review will use it too). Still to
  confirm: the export-compliance answer (the app does its own
  X25519/AES-GCM/Ed25519 sealing), and whether "iPhone and iPad Apps on Apple
  Silicon Macs" is on in App Store Connect (untried on a Mac).
- **Google Play:** reviewer build `versionCode 8`. Version codes are burned by
  any upload, so always take one above the highest in App bundle explorer. The
  upload cert is not in `assetlinks.json`, which is right for Play but breaks
  passkey recovery on a sideloaded APK.
- **Throwaway demo `drill-1010`** (UpCloud) exists for update-server testing.
  Tear it down with `node scripts/sample-user.mjs cleanup drill-1010` when done.
- **New boxes start current (2026-10-13).** A box that has never been updated
  and holds no apps moves once, on first boot, to the newest endorsed
  descendant of its commit (`firstBootUpdate.ts`, marker
  `first-boot-update.json`; owner decision: the release signature is the
  consent, no phone order). Same gate and code swap as an ordered update
  (`applyEndorsedUpdate`), so a bad release rolls back. `vm-appliance.yml`
  now installs the newest endorsed release (`scripts/latest-endorsed-release.mjs`,
  the box's own verifier) under the `main` label recipes name; the manifest
  records the `commit`.
- **VM appliances published 2026-10-13 (both arches)**, built by `vm-appliance.yml`
  from the newest endorsed release `52d0b375` (amd64 under KVM, arm64 on
  `ubuntu-24.04-arm` under TCG), uploaded to R2 `flagship-iso/` with
  `scripts/publish-vm-appliance.sh <run-id>…` (one image at a time, checked
  against its manifest), manifests in `apps/web/public/downloads/`. A new
  server's first boot moves it to the newest endorsed release.
  **Both are stale since 2026-10-18:** the amd64 one stops at its login prompt on
  first boot (disk resize without the build key, found on Windows; fixed on
  `main`). Rebuilt from `d4c7ef4c0` as runs `39142014433` (amd64) and
  `39142016230` (arm64); the owner publishes them
  (`docs/runbooks/republish-vm-appliance.md`). Until then "Host on this PC"
  stalls on every Studio.
- **AI privacy, staging and egress (2026-10-12): built, endorsed as
  `37ba277d`; apps on `main`.** Follows the rule in Conventions. The AI works
  on a fenced staging copy (neutral identity, placeholder secrets, sample
  data), calls `finish`, and the box seals the build and installs the same
  image live. The egress fence (`egress/`): builds reach registries only,
  staging reaches nothing, and live apps reach only owner-approved
  `network.egress` hosts (signed `flagship/app-egress/v1`). AI-provider calls go
  through the hub relay (per key, on by default; the hub logs only 15-minute
  totals, known AI hosts by name, all else as "other"). Hub deployed; webapp
  shell v47 live; iOS and Android only on `main`. Behaviour changes on update:
  existing live apps lose internet until their manifest declares hosts and the
  owner approves; apps can reach their data stores for the first time (they
  used to bind 127.0.0.1 only). Open: approvals are per service, not per image;
  a build can still push repo code out through an allowed registry; the fence
  fails open for live apps (never for AI staging or builds) if it can't start;
  dev dataspaces orphaned by a restart mid-staging aren't swept.
- **App access lists (2026-10-12, `e408e136`..`c78151b4`).** A live app's
  internet access is an owner-signed allow/deny list (`flagship/app-access/v1`,
  docs §3a; vectors in `packages/protocol/test-vectors/app-access/`, which all
  four ports pass). Hosts an app is denied by default become requests, with a
  content-free `app-access` push and an `access-request` event on
  `/api/screens/events`. All three apps answer per host and edit the list.
  `.com` deployed (category + visible iOS alerts); boxes need the next
  endorsed release after `37ba277d`. Fixed along the way: iOS pushes had no
  `aps.alert`, so nothing showed while the app was closed (every category);
  iOS signed orders named the leader box instead of the box serving the app.
- **Apps as API servers + member sign-in (2026-10-12, box `85d3e911`, apps
  through `06fc4a7f`).** `docs/app-apis.md`. The app proxy streams and passes
  WebSockets; `/*` public prefixes; Flagship-issued API keys (signed
  `flagship/app-api-key/v1`, no expiry, read/write scope); a form/upgrade from
  another app's origin arrives without the member; the AI may build its own
  sign-in when the owner asks. Private apps were unreachable on live boxes (the
  proxy never resolved the member session): now the knock cookie resolves the
  owner/allow-listed AID with a per-app stable id and role. AI staging data
  tools (`query_db`, `list_tables`, `list_data_files`, `read_data_file`); the
  owner's live Database section (read-only; writes need a signed
  `flagship/app-db-write/v1`); access-list drafts from the manifest's
  `network.egress` `{host, why}`. Knock sign-in signs with the visitor's per-app
  id (own boxes: global AID; a record naming the user's own AID is ignored;
  unknown boxes refused). Needs the `85d3e911` endorsement on boxes. Open: the
  app-detail members list is stale (the IRK-keyed store no longer gates); app
  roles can count the box's databases via pg_database (names are opaque); v1
  invite links (no `a=`) need re-inviting; boxes without `ownerAidPub` can't
  recognise their owner.
- **Access control + ranks (2026-10-13).** `docs/service-access-gating.md`
  "Open mode + members". Collaborators is gone from all three apps (and the
  box's `/api/screens/app-invite/*`; `inviteHandler.ts`/`serviceAccessGate.ts`
  remain as unwired library code). The service page's "Access control": Open
  to all | Members only (independent of the list) and Members (n) with a rank
  each. Ranks are member < manager < master, cumulative; apps
  enforce them, the box never blocks by rank; manifests carry one line per
  rank (`access.role_descriptions`, the AI must write them). Every invite
  redemption is its own grant; effective rank = highest live grant (an
  admin's `aid:` order replaces it); admin-signed `flagship/app-rank/v1`
  orders via `GET /api/screens/services/:id/members` and
  `POST …/members/rank` ("Account members" below). Open apps get
  `/__flagship/sign-in?next=` / `sign-out` on the app's host. Box changes need
  the next endorsed release. Open: removing ONE person's join from a group
  (needs a grant-revoke order; today it's per AID or per invite).
  Anonymous visitors get NO rank (owner, 2026-10-14): the proxy strips every
  client `X-Flagship-*` header (also `_` spellings) and sends
  `X-Flagship-Visitor: member|api|anonymous`, with no user/role headers for
  anonymous (docs/app-apis.md §5); the app decides, AI-built apps default to
  read-only. Needs the next endorsed box release.
  Open apps forward every anonymous request; members-only apps forward
  anonymous visitors only on `access.public_routes` (normalised, dot segments
  refused), knock elsewhere; unknown mode = members-only (docs/app-apis.md §2,
  2026-10-14; needs an endorsed box release).
- **Account members, ranks, admin-only access (2026-10-15).**
  `docs/service-access-gating.md` "Account members" (replaces "Who can
  invite"). Three ranks (no owner rank: apps see master). The box keeps the
  account's device book (every device grant from `.com`
  `GET /api/users/<u>/device-grants`, read token, verified on the box under
  the pinned admin root / IRK) and classifies every sign-in key: admin device
  master, other devices and co-managers manager, invitees of non-admins
  member; admin orders `flagship/app-rank/v1` override per app (demote,
  refuse). Devices sign app sign-ins with their account device key on the
  account's own servers and the share key on shared ones. Mode, removal
  (`service-access-mode/v2`, `service-allow-remove/v2`), rank orders and
  uninstall need the admin key on pinned boxes (IRK refused). Non-admin
  manager-class devices invite at Member with their device key (`.com`
  verifies the named device; AID/IRK refused on pinned accounts) and
  withdraw only their own (`POST /api/service-access/invite-withdraw`;
  `.com` keeps signed revokes, migration 0102; the box prunes only for
  revokes it verifies); a demoted creator's links stop admitting new people.
  Access state moved to `<dataDir>/data/flagship-access/` (Migrate carries
  it), uninstall drops it. Clients at parity since webapp shell v101:
  webapp `0c86ea9ab`/`d24323173`, Android `559ec1694`..`4125224cc`, iOS
  `e8209c1de`..`62db48867` (mock gym scenarios for admin, Manager and Member
  devices on all three); `flagship/app-member-role/v1` retired
  (`109ab06de`). Live gym groups `invites` + `gating` green
  (`live-run-2026-10-16T00-50-30-999Z`: 14 + 21 checks).
- **Adding a server is admin-only, server-enforced (2026-10-16).**
  `docs/service-access-gating.md` "Adding a server". On a real account
  `.com` refuses create (the auth-code issue needs the account's pinned root
  in `ar=` and `adminSignature` over `flagship/auth-code-admin/v1|<AuthCode>`),
  RCK registration and take-over claims unless the admin root (or an
  admin-granted device) signs, and refuses accounts with no admin root; the
  box must register with the AuthCode `.com` admitted, still pinning the
  current root. Admin-pinned boxes take restore orders only from the admin
  root. Demo accounts keep their old checks. 403 `code:
  add-server-admin-only`, shown as the apps' sentence. Vectors
  `test-vectors/add-server/` (all four ports). Co-manage stays app-gated
  (a server check would unmask the second account). Deploy order: iOS/Android
  store builds first (current store builds get the refusal when creating a
  server), then `.com` (webapp shell v116 ships with it); the restore rule
  needs an endorsed box release.
- **Co-manager invites (2026-10-16, owner decision).**
  `docs/service-access-gating.md` "Co-manager invites". A co-manager at "Can
  manage" invites people to the shared server's apps at Member and withdraws
  their own, while manager-class there (an admin's demotion to Member, a
  refusal, a share down to view or ended stops their links; joined people
  stay). Signed with the share's member key and sent to the box
  (`/api/shares/invites`, `/withdraw`), which checks the standing and relays
  the create to `.com` under its STK (`flagship/service-invite-co-manager/v1`;
  tier `co-manager`, no migration, `.com` learns nothing about the share).
  The app's other servers learn the co-manager from a signed `share`
  journal entry; share-target rank orders now apply on every server.
  Names sealed under `flagship/share-invite-bundle/v1` (co-manager's devices
  only). Vectors `packages/protocol/test-vectors/co-manager-invite/` (TS,
  webapp, Swift, Kotlin). On `main` on the box, `.com`, the webapp (shell
  v119, gym `web-total-share-co-manager-invites`), iOS and Android (gym
  `ios-oct-share-co-manager-*`, `android-oct-share-co-manager-*`; the
  Android smoke world gains Cabin, shared at Can view). Needs: a `.com`
  deploy, an endorsed box release, iOS/Android store builds.
- **One access list per app (2026-10-15).** "One list per app" in the same
  doc: per-app journal of signed entries, the app's lead server distributes
  box to box (`/api/access-sync/push|pull`, CGK-derived MAC; nothing via
  `.com`), every box verifies every entry, catch-up holds invited people and
  co-managers after a restart until the list is pulled; each box finds the
  app's leader itself (`/pods` + its server order + asking the others).
  Live gym group `one-list` (home + home2): 6 checks green in the same run. Found on the way:
  cross-box gossip never reaches a sibling (the hub has no TLS terminator
  for `broadcast--<user>.<apex>` on :443, and prod has no DNS for it), so
  per-app gossip leadership has never formed live: open; gossip now at
  least uses the box's own zone (`ffc9a64c1`). Needs, for both: `.com` deploy with migration
  0102 (and shell v101), an endorsed box release, iOS/Android store builds.
  Open: a box-internal mode change (an AI-built app deployed members-only)
  isn't handed over; guests an admin raised to Manager don't invite yet;
  non-admin device keys are UMK-derived, so one non-admin device's rank
  versus another's isn't enforceable against a hostile device of the same
  person.
- **Per-app visitor identity (2026-10-13).** A visitor signs redeem / visit /
  knock / acceptance with `deriveAppAccountId(UMK, serviceRef)`
  (`flagship/app-aid/v1|<serviceRef>`), replacing the per-author contact AID;
  invite links carry `&s=<serviceRef>` (links without it are refused). Client
  change only (webapp, iOS, Android); the box is unchanged. Existing invites
  bound to old contact AIDs need re-inviting (acceptable before launch).
- **App runtimes (2026-10-12, phase 1 in `8ddf19a9`).** `docs/app-runtimes.md`.
  Apps name `runtime.base` (`node-24`, `python-3.13`, `static`, pinned by
  digest in `runtimes/catalog.ts`); the box writes the build and runs the app
  as the runtime's unprivileged user; an AI can't write a Dockerfile (an
  imported repo's own still builds); every sandbox bridge has
  `enable_icc=false`. Breaking: chat and AI-built apps must name a runtime,
  and existing AI apps get one on their next edit. Needs an endorsed box
  release and a `.com` deploy (adapter rule). Not yet built on a real box:
  the three runtimes' builds and a non-root app writing `/data`. **Phase 2
  built (`appSandbox/`):** every app and staging copy runs under gVisor
  `20260921.0` (SHA-512-pinned bundle, ~130 MB download, installed once into
  `/usr/local/lib/flagship-gvisor/`, registered in `/etc/docker/daemon.json`,
  proved with an app-shaped test container, retrying `--systemd-cgroup` when
  docker uses the systemd driver); no app starts without it, and the server
  page says why on all three apps (Docker's own failure included). On home3
  (`2d938d49`) the test container crashed gVisor: its `--pids-limit 32`
  starved runsc (`pthread_create failed`; gVisor's threads count against the
  container's cgroup). Fixed by testing with an app's own limits (256);
  drilled on a Debian 13 arm64 VM under Apple's hypervisor: install,
  register (systemd driver, no `--systemd-cgroup` needed) and test in 11 s,
  and a Node app read-only as 10001 serving HTTP under runsc (30 pids).
  Next phases: a COPY-only build with installs in a locked-down
  container, copies that send the app bundle instead of the image, disk
  quotas and Postgres role limits, vetted packages, owner-approved tier-3
  images.
- **LAN-direct (merged to `main` 2026-10-12, through `1f5eef30`).**
  `docs/lan-direct.md`. A box listens on its private LAN addresses at :443
  (piped into the same loopback TLS server the tunnel feeds;
  `FLAGSHIP_LAN_DIRECT=0` keeps it relay-only) and serves an STK-signed
  `flagship/lan-hint/v1` to paired devices; Android and iOS (CONNECT proxy,
  `NSLocalNetworkUsageDescription` added) route to it once it proves itself.
  App copies use it box to box: the source offers its endpoints in the copy
  description, the target fetches there as `https://<source>` and falls back
  to the relay (the copy records `route`). Same release: copies are gzipped
  and fetched 4 chunks at a time, and the Docker liveness check is fixed
  (`docker info --format` exits 0 with dockerd down, so ce6471c4's restart
  never ran). **In the launch MVP** (owner, 2026-10-16: failure is a no-op).
  2026-10-16 audit (`docs/lan-direct.md` "Failure handling"): the listener
  can no longer stop the daemon; a copy's LAN fetch gives up after 15 s of
  silence (was 5 min); both phones probe in the background (no request
  waits) and resend over the relay after a LAN failure when that can't
  apply a change twice. Drilled between two Debian VMs on a private link.
  Needs an endorsed box release and store builds. Not yet run live: a phone
  on a metal box's Wi-Fi, and a copy between two boxes on one LAN.
- **Where an app runs (2026-10-12, box `73211505`, apps through `a79b4de9`).**
  `docs/app-placement.md`. Make leader never moved the box new apps were
  created on, and the app page's runs-on boxes came from the leader (its Save
  sent a `service-policy/v1` order nothing consumes). Now: the leader is also
  current and survives relaunch on the phones; every creation flow picks a
  server (fixed when started from a server page); a server's page lists its
  apps with "Create app here"; runs-on asks each box; ticking signs
  `flagship/app-copy/v1` and the target pulls a snapshot from the source
  (access list arrives as a draft, API keys stay); unticking is the signed
  uninstall. Android's uninstall was dead (unsigned orders/send) and now
  signs. Needs the `73211505` endorsement on both boxes and a `.com` deploy
  (webapp shell v56). Not run on a real box: the docker save/load and
  pg_dump/restore in `appCopy/ops.ts`; a digest-pinned image may load
  untagged; no bundle size cap; a source restart mid-copy fails the copy.
  `orders/send` still has other users, so it stays.
  App links (2026-10-13): `.com` used to point an app's canonical URL,
  instances and voi.ci link at the account's first live server, wherever the
  app ran. Now `appHome` (`serviceRename.ts`) uses the boxes' heartbeats:
  the gossip leader for the app's slug (`leadsServices`), else a box that
  runs it (`runsServices`, new; sent again as soon as a box's apps change),
  and app-bound voi.ci codes resolve their target on each visit. Boxes
  that don't send `runsServices` yet count as running everything.
- **Remote is QR-first (2026-10-14).** remote.flagshipserver.com shows a QR
  at once (`https://<control apex>/remote?s=<sid>&k=<browser X25519>`, the `/qr-pipe`
  relay); the phone shows the same 6-digit code, the owner picks a server
  and approves (biometric), and the phone mints a one-use companion ticket
  on that box and seals `flagship/remote-ticket/v1` to the browser, which
  redeems it there. The page no longer asks for a username or reads `/pods`;
  the old box-side `/api/companion/dock/*` endpoints are gone. Both apps
  only routed `flagship://dock`, so the old page's QR did nothing. Needs a
  `.com` deploy (shell v72) and new iOS/Android builds; not yet run live.
  `/pods` now leaves out servers their owner deleted.
- **Account read tokens (2026-10-14, `docs/account-read-token.md`).**
  `/pods`, `/stream`, `/audit`, `/apps/aliases` and `/apps/<id>/links` need
  `authorization: Bearer <token>` (401 otherwise), minted at
  `POST /api/accounts/<u>/read-token` by a device of the account (30 days),
  its IRK (24 h) or one of its servers' STK (24 h); demo accounts read
  without one. Studio reads a VM's health from `/api/order/<serial>/health`;
  by-domain no longer says why a server was revoked. Before deploying `.com`:
  `openssl rand -hex 32 | wrangler secret put ACCOUNT_READ_TOKEN_SECRET`.
  Breaks live status on store builds for real accounts until new builds,
  and boxes' alias sync until the next endorsed release.
- **Server order (2026-10-14, `docs/server-order.md`).** The owner drags
  servers into order on Home (all three apps); the first one up leads, the
  role passes down the list and back up. A signed
  `flagship/server-order/v1` (sensitive-order key: admin root, else IRK;
  each reorder asks Face ID once on admin-root accounts) is posted to
  `POST /api/accounts/<u>/server-order`, stored in D1 `server_orders`
  (migration 0096), returned on `/pods`, `/stream` and the daemon-status
  reply; boxes verify it, keep `server-order.json`, pass it on gossip v2 and
  rank by it. "Set as preferred server" is now "Make leader"; the set-leader
  vote, lane and consumer are gone. Same commits: phones keep their account
  device key after the first unlock (silent read tokens) and Home offers
  "Show my servers" instead of an empty list; Home's one "Add/Import a
  server" button (Create / Co-manage a running server / Import a backup) is
  the same with or without servers and shows only on an admin device of the
  account (holds the admin root; demo accounts too); any other device's
  empty Home says only an admin device can add servers (2026-10-15, shell
  v108). Needs: migration 0096 before the `.com` deploy
  (webapp shell v74), an endorsed box release, iOS/Android builds. Not yet
  run on a device. Follow-up the same day (owner's Home review): no
  numbers (position is the order), a drag handle on the left of each row
  with a gray server icon by the name, "Add/connect a server" above the
  list, shorter recovery nudge; the apps hand a saved order straight to
  each server that is up (`POST /api/screens/server-order`), boxes report
  the order they hold (`orderIssuedAt` on the heartbeat and `/pods`) and
  beat at once on adopting one, and the Leader badge stays gray until the
  leader acknowledges (webapp shell v76). iOS's stuck "No. 2" came from a drop between rows
  never firing `performDrop`: rows showed the drag preview, labels the
  saved order, and nothing saved.
- **Continue a build chat and switch provider (2026-10-15, `d3dd73c8`..`0a8a9391`).**
  `docs/build-modes.md` "Continuing a chat". A chat that is ready to deploy
  or failed (also stopped by a restart) takes a new message on
  `/api/screens/llm/sessions/:id/reply` and runs again on its files; a
  deployed app keeps "Change this app". Any message may carry `model`,
  `effort` and a new `credential`: a key from another provider replaces the
  sealed one, an effort the new model doesn't list is dropped, compaction
  fits the new model's context; the box's note to the model goes through
  the model redactor. State adds `canContinue`, `provider` (name only),
  `conversationTokens`. All three apps: one model menu grouped by provider
  (Flagship Inference, then each saved key), effort only for models that
  list levels ("Think harder" is gone), a one-line notice when a switch
  would summarise older turns; the build list continues failed and ready
  chats (kept 30 days after their last change). Needs an endorsed box
  release, a `.com` deploy (webapp shell v93), iOS/Android store builds.
  Not yet run on a device. Open: iOS shows no group for a key typed but
  never saved; Android sends a saved Flagship default model unchecked on a
  new build.
- **Share this server, v1 for families (2026-10-14, `de091bcc`..`a154b318`).**
  `docs/share-a-server.md` §5.4–§5.7 and §10. A co-manager with unlock at
  boot can turn on "Notify this device when it needs to start": the device
  signs its push token for that one share (`flagship/server-share-push/v1`),
  and `.com` keeps it only while the owner's unlock deposit names the same
  key (D1 `server_share_push`, migration 0097). A disk-unlock request pushes
  the owner and each opted-in device (no content, `kind: share-start-up`,
  opens Home). A co-manager at "Can manage" signs
  `flagship/server-share-update/v1` to the box (`POST /api/shares/update`),
  which runs the owner's gates (`admitUpdateOrder`, then
  `applyEndorsedUpdate`); view level is refused. The owner's unlock opt-in
  carries the house-key warning; apps list and app detail carry
  `accessMode`, so a co-manager sees "Members only. You need an invite to
  use this app." `.com` deployed 2026-10-14 (migration 0097 applied, webapp
  shell v78). Needs an endorsed box release and iOS/Android store builds.
  Not yet run on a device or a real box.
  **Only an admin device accepts (2026-10-16, shell v130):** the shared box
  takes a first grant only with `flagship/server-share-accept-admin/v1`
  signed by the joining account's admin root (IRK if it pins none) and
  `.com`'s CA `flagship/account-key-attestation/v1` of that key, which names
  no account (`share-a-server.md` §5.1; refusals `accept-not-admin`,
  `accept-signature`, `accept-stale`, `accept-unverifiable` with sentences).
  New `.com` routes `GET /api/users/:u/account-key-attestation` and the demo
  signer `POST /api/dev/sample-user/:u/share-accept`. Webapp done; iOS and
  Android ports in progress (parity `share-accept-admin`). Needs a `.com`
  deploy, an endorsed box release (a box needs a live CA lease to accept),
  store builds; live gym `share` group updated, not yet run.
- **Adding a device is admin-only; the webapp join works again (2026-10-17,
  shell v133).** Only an admin device (holds the admin root) opens a pairing
  code; others see Add device disabled with "Only an admin device of this
  account can add devices." The sealed bundle carries `irkPubHex`, a device
  `grant` + `grantSignature` (member scopes under the account key, or every
  scope under the admin root when promoting); the joining browser verifies
  both, posts grant + signed profile to `/devices/admit` (`.com` had refused
  the webapp's join with 400 since July) and keeps its own device key wrapped
  under the account key. Vectors `packages/protocol/test-vectors/device-pairing`
  (webapp reads them). Open: iOS/Android keep the bundle shape but don't gate
  Add device to admins or read the vectors yet (parity `device-pairing-admin-only`);
  `.com` can't enforce admin-only (the admit is signed by the account key).
- **Docker containers unreachable on VM appliances (fixed in `e81df698`).**
  The appliance's `Type=ether` networkd rule pulled every container's veth off
  its bridge: every app 502'd with "read ECONNRESET" after a 3 s ARP timeout
  and build RUN steps had no network. New appliances ship
  `10-flagship-containers.network`; the daemon writes it on older boxes at
  boot. Republish both appliances so new boxes start fixed.

### Metering (2026-10-13, live)

One metering core for data and AI tokens lives in `billing/`, a standalone
reusable project (`@ibisllc/billing-metering` + `billing-store-d1`, consumed
as workspaces; it builds and tests standalone in CI, and publishing to npm
and mirroring to github.com/ibisllc/billing wait for the owner:
`billing/docs/publishing.md`, `.github/workflows/billing-mirror.yml` is
disabled). Flagship's plans are in `packages/control-plane/src/meter.ts`;
counters in D1 `meter_counters` (migration 0069, applied; `usage_counters` is
no longer read and can be dropped later). Free over 25 GB is now slowed to
256 kbit/s instead of cut (`.com` f33230d4, `.services` v37). AI-token
allowances (1M / 5M / 20M a month) are placeholders.

### Built, waiting on deploys or rebuilds

- **Account delete said "Another device is still on this account" on every
  fresh account (2026-10-18, found by the Windows test agent):** `.com`'s
  last-device check counted every active grant, but bootstrap (and demo
  provisioning) writes the founding device's own device row and admin grant,
  so the caller always counted itself. Now it counts the live device rows
  Trusted devices lists minus the caller (admin-root orders; legacy accounts
  without an admin root still count every row), answers 403
  `code: other-devices-remain` with the sentence "Remove it in Settings,
  Trusted devices, then delete the account", and retires the account's
  device rows when it deletes. Needs a `.com` deploy (webapp shell v151);
  current store builds show their generic refusal line for the new body until
  the next iOS/Android builds. Admin reclaim still counts any grant as an
  active device (a real account never looks dormant to it).
- **`.com` Worker:** last recorded deploy 2026-10-15 (`3e8fef1de`, version
  `f8c619da`, webapp shell **v113**); measured live on 2026-10-16 evening: shell
  **v114**. `main` is at shell **v153**, so a `.com` deploy is due. Prod's D1 ledger
  reads 0105 as newest (read-only query, 2026-10-18): nothing is pending (0104 was
  applied; the peer-backup secrets are not shown by the ledger). Always
  `npx tsc -b` first and apply pending D1 migrations before deploying.
- **Rate limits count in Durable Objects (2026-10-15):** every budget in
  `apps/com/src/rateLimit.ts` is applied as written (any window, counted once
  worldwide) by `RateLimitCounter` objects, one per endpoint, axis and id;
  the `ratelimit` bindings are gone. New `totp-verify` cap (5 per 15 min per
  account); username keys are case-folded; recovery, re-pair and TOTP refuse
  if the counter is unreachable. The gym runs with `RATE_LIMIT_SCALE` 10 and
  local e2e with 100. Refusals, distinct refused callers and near-limit
  passes are counted hourly in D1 `rate_limit_log` (migration 0101, nothing
  about the caller; kept 90 days), read by `GET /api/admin/rate-limits` and
  `npm run rate-limits`. The 429 carries `retryAfterSec` and a sentence
  ("Too many tries from your network. Try again in about 12 minutes."),
  which all three apps show. Live on `.com` 2026-10-15 (checked: the 4th
  recovery lookup of one name in 15 min is refused with the sentence). The
  gym Worker gets it at the next `scripts/gym-refresh.sh`; the apps' side
  needs iOS/Android store builds.
- **Env changes sign one variable (2026-10-17).** `flagship/service-env-change/v1`
  names exactly one variable, its op, the value's hash and a single-use nonce
  (box `app-env-used-nonces.json`), replacing the replayable `/env/unset` and
  the old set form; variable names are `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. Webapp
  (shell v134), iOS and Android sign it; opening an account never wraps the key
  under a random passphrase. Breaking for old boxes and builds: needs an
  endorsed box release and store builds together. Not run on a real box
  (live-e2e core.ts has the set/unset/replay check); the iOS UI gym twin was
  not re-run after its last fix.
- **Clickjacking report (2026-10-15, Low):** every `.com` Worker response
  now refuses framing (`frame-ancestors 'none'` + `X-Frame-Options: DENY`)
  and carries nosniff, HSTS and a referrer policy (`withSecurityHeaders` in
  `apps/com/src/route.ts`); `webapp.`/`remote.` get a strict shell CSP
  (`shellCsp`: script-src 'self', connect-src the control apex and the
  services apex only), so no inline script may return to the shell (tested);
  the webapp refuses to boot in a frame (`lib/frameGuard.js`, shell v114);
  the box's own pages (invite, knock, request access, landing, 404) send the
  same framing headers (`pageHeaders.ts`, `d0658fb6`), which needs an endorsed box
  release. Reporter credit pending; listed in the security page's hall of
  fame.
- **Boot hardening (2026-10-18):** a rebooting box waits at most 60 s for the
  relay's first HELLO_ACK (it keeps dialing in the background) and, while a new
  certificate is requested, serves the one it holds if it names the box, even
  inside the renewal window or past its end. Needs an endorsed box release.
- **Box trust fixes (2026-10-18):** the re-pair watcher no longer takes `.com`'s
  word that a re-pair finished: the swap (clear paired sessions, re-anchor
  membership, adopt the new IRK) needs a proof whose old-IRK signature chains
  from the IRK the box trusts, or, on an admin-pinned box, an admin-root
  rotation the box verified itself since the re-pair began; otherwise it is
  held for a week and nothing changes (`.com` now keeps and serves the
  signatures: **D1 migration 0105 before the `.com` deploy**). A restored
  backup's apps become the importing account's own (creator rewritten, no
  pull from `<slug>.<oldname>`). `BoxReadToken` calls time out after 20 s.
  Open: the self-delete order names the account, not the server, and has no
  expiry (`docs/account-deletion-and-name-reclaim.md` §5). Launch promise
  and its test: `docs/server-backup-and-clone.md` "If we are ever forced to
  cut you off". Needs an endorsed box release and a `.com` deploy.
- **Box state files written whole, corrupt ones fail closed (2026-10-16):**
  every daemon state write goes through `durableFile.ts` (one queue per
  path, unique fsynced temp file; `withFileLock` for read-modify-writes). An
  unreadable security file is kept as `<file>.corrupt-<ms>`, noted in
  Activity (`server.state.corrupt`) and loads closed: access state makes
  every app members-only until an admin opens it again, a lost dead-man
  file arms the switch as missed, a lost admin-root pin holds boot until
  the rotation chain is replayed from the seed, lost update nonces refuse
  older orders, a lost journal holds shared apps until caught up. Needs an
  endorsed box release. All three apps show the Activity entry as a warning,
  "This server found a damaged settings file and locked it down", with the
  box's line (which file, what it means) under it (webapp shell v115;
  iOS/Android need store builds).
- **App "Back up now" (2026-10-15):** the box never mounted `/api/backups/<id>`,
  so every client's archive fetch 404'd; now mounted (owner sessions only).
  The webapp fetches it with the session and saves the Blob, like iOS/Android.
  Needs an endorsed box release and a `.com` deploy.
- **Settings boxes + Browser sessions (2026-10-15):** "Lock with passkey" is
  "Sign out"; it and the lock button share one box, and the Danger zone is a
  box of two red buttons (no explainer text) on all three apps; the services
  list shows "On N servers" as N and the server icon. The phone showed under
  Browser sessions because the box listed every paired-session token (each
  device's own included) unlabelled; `paired-sessions/list` now sends
  `kind: remote|device` and the apps list only `remote`. Needs a `.com`
  deploy (shell v109), an endorsed box release, iOS/Android store builds.
- **Flagship Inference entry (2026-10-14):** free AI is a built-in provider,
  "Flagship Inference", first in every AI-key list, never removable, shown
  disabled (not hidden) once ended; the shim answers a context overflow with
  `free-ai-too-long`. 2026-10-14: "Free AI credits" renamed Flagship
  Inference in every app and message, the allowance shown in credits, and
  privacy §2.8 rewritten (generic third-party provider that may change; no
  placeholder left). Needs a `.com` deploy (webapp shell v69, credit fields,
  privacy + terms pages), a shim deploy (new refusal wording), and
  iOS/Android store builds.
- **Model menu, compaction, attachments (2026-10-14):** build chats pick a
  model per message (Flagship Inference catalog: Low 1× Qwen3.6-35B-A3B,
  Medium 1× DeepSeek-V4-Flash, Medium multimodal 2× GLM-5.3-Flash, High 3.5×
  MiniMax-M3; multipliers from real cost × 1.25, `docs/ai-inference-costs.md`
  §15) or an own key's live model list with efforts from a daily
  OpenRouter-built capability table; "used N credits" per reply; long
  conversations summarised before they outgrow the context; CSV/JSON sample
  data (test copy only) and PDFs (text extracted on the box) as attachments.
  The shim has a fallback upstream (DeepInfra → OpenRouter, both US) and the
  tunnelled-vLLM options per upstream. Needs: D1 migration 0095 + a `.com`
  deploy (webapp shell v71, catalog, capability cron, multiplier metering),
  then the shim deploy (with `FALLBACK_API_KEY`); an endorsed box release
  (compaction, model choice, attachments, `unpdf`); iOS/Android store builds.
- **App links are https (2026-10-14).** Every QR or shared link is
  `https://<control apex>/<path>` (Worker `APP_LINK_PATHS`: join, share,
  transfer, remote, builder, access, invite, invite-accept, plus `/app/<route>` for
  any other app screen: widgets, Siri intents, push `deepLink`s, e.g.
  `/app/account/security`). Params ride the fragment, which browsers never
  send, whenever they are a secret or name a server, app or person (share,
  access, invite-accept); the query otherwise.
  Nothing emits `flagship://` any more (MCP resource names aside, which aren't
  links); parsers still read the old forms. The old desktop QR login
  (`login.html`, `/deck`, `flagship://desktop`, `/api/desktop/pair`,
  `/api/qr`) is gone; remote.flagshipserver.com replaced it. Without the app the
  Worker serves `apps/web/public/open/` at the same URL (store buttons, then an
  opt-in webapp link) instead of 308ing into the webapp origin, which an
  installed Android webapp claimed. Store listings live only in
  `apps/web/public/app-stores.js` (live since 2026-10-14). Live on `.com`
  and in Studio (Mac DMG + `studio-v0.1.2`) since 2026-10-14. Still needed:
  an endorsed box release at or after `7e0271ed` (knock page) and
  iOS/Android store builds.
- **Delete / reversible Revoke / Un-revoke (2026-10-12):** live on `.com` +
  webapp (shell v44); iOS dev build installed on the owner's iPhone; Android
  only as a CI/debug APK. Delete deposits a `wipe-now` decommission order
  (best-effort) and then releases the name; an un-revoked auto-unlock box needs
  one phone approval on its next boot. Not yet exercised end to end on a real
  server (deleting home2 from the app is the first test).
- **iOS / Android:** `main` has fixes not yet in a store build: the iOS
  known-bug fixes (retried account creation registered a second device; Wipe &
  restart kept the old key), Android's matching retry fix, the Android parity
  fixes, and the update card's "last update" line. Both need rebuilds.
- **Android glanceable surfaces + Wear OS (2026-10-15, `apps/mobile/android/`
  `app/.../companion/`, `:companion`, `:wear`):** a Glance home-screen widget
  matching iOS's; an ongoing setup notification per install (Android's Live
  Activity; `provision-status` pushes no longer post one notification per
  phase); launcher shortcuts (Approvals + one per server); a notification
  channel per push category (`flagship.alerts` stays as "Other"). Wear OS app
  (minSdk 33 = Wear OS 4, versionCode = phone + 1,000,000, same applicationId
  and signing key, which the Data Layer needs): servers, boxes waiting to
  unlock, recent activity, install progress, a tile and a complication. Its
  Approve is a Data Layer request the phone answers with its own approval:
  re-fetch + directory re-verify, unseal, boot response signed with the
  watch-delegate key (role "delegate"), never a biometric prompt (only while
  the app session is unlocked and Account security → "Quick approve from
  watch" is on). Not yet run on a device or watch; the Play listing needs the
  Wear OS form factor and the watch APK uploaded. iOS's install Live Activity
  starts on an install's first checkpoint (`b7c49cbf0`).
- **Data layer = Postgres 18 + a files folder per app (2026-10-12):** on
  `main`, needs an endorsed update for existing boxes (and a `.com` redeploy
  for the demo cloud-init copy of the unit). MinIO, Redis, Adminer,
  redis-commander and the admin proxy are gone (and the `minio` / `ioredis`
  deps); Forgejo and Chromium stay. Postgres is
  `pgvector/pgvector:0.8.7-pg18-trixie` pinned by digest, PGDATA under
  `/var/flagship/data/postgres/18/docker` (init.sh moves an old Postgres 16
  cluster aside to `postgres/old-pg16`, nothing migrates it). Every app
  database gets pgcrypto, citext, pg_trgm, unaccent, fuzzystrmatch, hstore,
  ltree, btree_gin, btree_gist and vector; database/role names are opaque
  (HMAC under `DATA_NAME_KEY`), and an app role can connect only to its own
  database. `data.stores.files` mounts a per-app named volume at `/data`
  (`FLAGSHIP_FILES_DIR`; `flagship-files-<creator>--<slug>`, dev
  `flagship-devfiles-…`; before `a3b4c396` a dashed username failed every
  install with data stores); an old manifest's `objects` becomes files and `kv`
  its Postgres database. Backups dump Postgres and each files volume (also
  without the Postgres creds); self-delete removes the files volumes. The
  unit runs `init.sh` on every boot and retries, removes the old containers
  (`--remove-orphans`), and the daemon brings Postgres up in the background
  at boot; the box's own failures fail an AI deploy with the owner's reason
  instead of going to the AI. Verified on a Debian 13 arm64 VM (Docker 26):
  bring-up from the real unit, a hardened app container on `/data`,
  isolation, extensions, LISTEN/NOTIFY, SKIP LOCKED, dump → restore. Not yet
  on a real box. iOS/Android show the raw store names (no Files size yet).
- **Box-side changes** reach existing boxes only through an endorsed update or a
  reburn. Not yet validated live on a phone-created box: phone-approval unlock
  on a box sealed with current code, the post-boot SWK / pairing / entitlement
  deposits, CGK gossip claim/yield + route nudge, the debug-access gate,
  self-delete, transfer re-home + giver→acquirer disk-key handshake.

### Release script (2026-10-18)

`bash scripts/release.sh --phase A` then `--phase B` runs `docs/runbooks/final-deploy.md` by hand (pinned commit, clean worktree, prompts before every outward step, state in `~/.flagship-release/state.json`; `--list` shows the plan, `--dry-run` runs nothing). Test: `scripts/release.test.ts`.

### Update this server (2026-10-10)

The whole pipeline works on a demo box: the owner's YubiKey endorses a release
with `node scripts/endorse-release.mjs --to <sha> --from <box commit> --sign`
(run in a real terminal: the PIN prompt reads `/dev/tty`), the order goes in
(demo: `POST /api/dev/sample-user/<u>/order-update` with `x-admin-secret`), the
box applies it, and a release that fails its boot health gate rolls back on its
own (drilled on `drill-1010`). Boxes now record the verdict in
`/var/flagship/update-outcome.json` and server-detail returns it as
`lastUpdate`. **iOS on a real account validated 2026-10-11:** `home2.plucky-avocet`
went `7ac1b50a` → `9873b83e` from the phone's Update button (~20 s down).
Remaining: the same from the webapp and Android.
A box updates straight to any endorsed release (the gate checks the target's
own endorsement and lineage, not the release it runs). Boxes from before
`a73f0a41` (every one built from the 2026-10-10 appliances) can't list their
releases and answer 404; all three apps then ask `GET /api/releases?current=`
on `.com` (`apps/com/src/releaseCatalog.ts`, placed from the endorsements'
lineage), which only decides what's offered.

**home2 bricked by its `1584bfe8` update (2026-10-11).** Studio's Restart menu
force-stopped the VM at 22:44:12 UTC, 2 s after the update finished its rebuild.
Forensics on a disk clone (unlocked with the box's own lease): checkout, `npm ci`
and `tsc` had all completed, but none of it was flushed, so the box came back
with 196 tree files (including `server-daemon/src/index.ts`), 6,971 node_modules
files and the update marker all 0 bytes, and the daemon crash-looped every 5 s
(npm logs) with nothing able to roll it back. Fixed and endorsed as `67cfd8da`
(2026-10-12):
markers and outcomes are fsynced (`durableFile.ts`); the rebuild ends in `sync`;
the marker is written as `applying` before the tree changes; a bash
ExecStartPre guard (`updateGuard.ts`, needs no node_modules) rolls back an
interrupted apply, a release that never reaches the gate, or an unreadable
marker (to the last verified commit in `update-outcome.json`), dropping the
git index first so 0-byte files get rewritten; consuming an update order retires
the older ones it superseded; Studio's Stop/Restart/Quit power the guest off
gracefully before forcing (Mac, Windows, Linux). A box gets the guard only after
its first update to `67cfd8da` or later (that update still runs the old code),
so don't stop a box while it updates. home2 needs deleting and recreating; its
superseded update order (secret_mailbox rowid 13) is still unconsumed and
should be marked consumed. **Separate, unexplained:** home2's guest kernel oopsed
in ext4 three times (13:08, 13:59, 23:29 UTC, uptimes 11–46 min) with the
faulting code reading as zeros, i.e. guest memory corruption; suspect the VZ
host side (Studio attaches a memory balloon); the 23:29 one landed 1 s after
macOS began memory-pressure kills (16 GB Mac, two 4 GB VMs), the other two had
no such signal. home3 (same image) had no pstore dumps after ~6 h. Box journals are volatile
(`/run/log/journal`), so a crash loop leaves no daemon log on disk.

**leticia's Docker won't start (2026-10-13):** dockerd dies at load with
`symbol lookup error: …/libsystemd.so.0`, and 7 packages have damaged files
(apt, docker.io, libbrotli1, libstdc++6, libsystemd0, systemd, util-linux;
`systemctl` crashes). Same pattern as home2. `dockerHealth.ts` reports
dockerd's own error, and on a library/exec failure (or a crashing
`systemctl`) `systemRepair.ts` reinstalls every package `dpkg --verify`
flags, at the installed version, through dpkg alone (apt links libsystemd).
Appliances ship without apt's lists (`appliance.ts` deletes them), so it
fetches each suite's `Release` + `Release.gpg`, verifies them with `sqv` (or
`gpgv`) against the source's keyring, and checks each `Packages.gz` and .deb
against the signed SHA-256s. Drilled on a Debian 13 arm64 VM damaged like
leticia (lists gone, apt and systemctl broken): fixed in ~40 s. Only package
files are covered (not node_modules or images). On `57b69edb` the reinstall
ran but libbrotli1 and systemd still failed their checksums afterwards
(systemctl SIGILL = zeroed arm64 code), so leticia is being recreated.
Suspected root cause for home2 and leticia: Studio attached VM disks with
VZ's default `.automatic` caching mode; `VZHost.writableDisk` now uses
`.cached` + `.full` sync (unverified that it cures it; needs a Studio
release, and applies to a VM from its next start).

### Desktop Studio

- **Mac:** notarized DMG at `/download/mac` (`scripts/release-studio.sh`;
  republished 2026-10-14 with the https pairing QR; 2026-10-13 brought VM disks attached `.cached` + `.full` sync;
  2026-10-12 brought graceful VM stop + the appliance cache in Application
  Support). `wrangler` is not a repo dependency: the script's final
  `npm run deploy` needs a wrangler on PATH.
- **Windows + Linux:** `studio-v0.1.3` on GitHub Releases (2026-10-15), built by the
  on-demand `studio-release.yml` (pass `publish=true` to release; it now
  stamps the version into both apps and checks it). Windows is a zip with
  `xorriso` bundled in `tools\`, **unsigned** (no code-signing cert). Linux is
  an x86-64 AppImage that needs Node.js 20+, pkexec and xorriso. **In 0.1.3,
  level with the Mac:** hosting from
  the published prebuilt appliance by default (verified qcow2 archive kept as
  the base, a qcow2 overlay + install-blob seed per server, installer-ISO
  fallback; a base is pruned only once no server's overlay reads it), QEMU
  disks `cache=writeback,aio=threads,discard=unmap` (pinned in
  `vm-core-vectors.json` with the Mac's `.cached`+`.full`), the order-serial
  Health readout (the Mac's was dead since bb3608e9: it dropped the serial on
  install; servers installed before the fix show none), "Unlocking…" + last
  connected, keep-awake while hosting, pairing at launch with offline pause
  and retry, one-click Host here that opens the new server, remembered Wi-Fi
  (Windows DPAPI; Linux libsecret or a 0600 file; Linux gained the Wi-Fi
  fields), base-ISO pruning, taskbar progress (Windows), a graceful Restart
  as administrator (Windows), Restart + a StatusNotifierItem tray (Linux,
  smoke-tested on a real session bus in CI), and an up-front xorriso check
  (Linux). Neither has been run on a real Windows PC or Linux desktop: cut a
  release, then see "Validating on Windows and Linux" below.
- **Mac App Store plan: deferred** (owner, 2026-10-13, to keep Studio one
  app). `docs/studio-mac-app-store.md` is saved for a future migration:
  sandboxed hosting-only Studio in the store, USB burning in a small
  direct-download USB Writer opened from Studio with the recipe.
- Studio's VM networking is NAT on every host, so a hosted VM can never be
  reached directly from a phone on the same Wi-Fi (LAN-direct can't help a
  phone there; two VMs on one Mac do reach each other).

### Validating on Windows and Linux

**If you are an agent on Harry's Windows PC or Chromebook, follow
`docs/runbooks/device-test-agent.md`** (what to test, how to report: results go
on a `device-results/<machine>-<date>` branch, never `main`).

Follow `docs/runbooks/desktop-windows-linux-validation.md`: the released
Windows zip and Linux AppImage each need one real run (pair with a phone, host a
server through phone unlock to a green padlock, burn a USB and boot it on
metal), plus the Debian 13.7.0 check. Record results under "Desktop Studio".

**Windows 11 run against prod (i5-14400F, WHPX), 2026-10-18** (Windows agent,
`device-results/windows-2026-10-17`, `RESULT-hosted-vm-on-prod-windows-2026-10-18.md`;
unedited main `1b656fd24` + a CI appliance, throwaway account, no UpCloud
server). **Verified pass:** pairing a phone with Studio (typed code, matching
SAS), host on this PC from the prebuilt appliance, first boot to sealed boot,
phone approval, Online + Leader on Home, the Health card, HTTPS 200 with valid
TLS (resolved by `--resolve`), sleep inhibit (`powercfg /requests` shows
FlagshipBuilder.exe), graceful Stop (~5 s, Last connected kept).
**Fixed on `main` from it (2026-10-18; Windows agent to re-verify):**
Studio decided "Running" by fetching the server's own name before the box had
registered it, so home routers cached NXDOMAIN for the zone's negative TTL
and a healthy box showed "Waiting for you to unlock ... taking longer than
expected" for ~30 min; all three Studios now take the box's signed health
report (daemon active, tunnel up, received after this boot began) as the proof
and never look the name up (`UnlockWatch`, vectors `bootEvidence`). The
sealed-guest copy no longer says "Nothing to approve". W-1: a start with too
little free RAM now says "Not enough free memory: this server needs 4 GiB.
Close other apps and try again." and a dying QEMU shows its last real stderr
line only (vectors `qemuFailure`).
**Fixed after that run:** Restart asked the phone because Android signed the
auto-unlock lease with the admin root, which the boot worker refuses (it verifies the
owner IRK); `64df9098c` signs with the IRK (shared vector `auto-unlock-lease`; needs
a new Android store build, Play `versionCode 8` has the bug). The Apps card "Couldn't
reach the server" (A-12) is the phone's own negative DNS cache for the box name:
Android `638bce32f` and iOS `668281523` retry; Android's relay fallback uses the
apex's addresses, which are Cloudflare's edge, not the relay, so it needs a
different target. Not yet run on Windows: installer-ISO fallback, USB burn + metal
boot, webapp + Remote walks, backup import, Restart as administrator, the
published (not CI) appliance, the Android fixes landed after `eb08dcdc4`.

### Open work (owner + hardware)

1. **Debian 13.7.0 re-pin.** 13.6.0 still downloads from `cdimage/archive/`.
   Validate a 13.7.0 install first (Studio Advanced mode with a downloaded ISO,
   USB on metal), then update `FLAGSHIP_ISO_MANIFEST` + `_ARM64` in both
   wrangler files (gym has no `_ARM64` yet), `distros.ts`, `docs/iso-manifest.md`,
   the docs page + its test, and the phone-usb-burn seed pin.
   `iso-manifest-urls.yml` fails loudly the day a pin moves to `archive/`.
2. **Hosted-VM footprint (2026-10-10).** Mac Studio now hosts on the published
   prebuilt appliance by default: it downloads, verifies and expands the qcow2
   natively (`ApplianceCache` + `Qcow2Expander`, no qemu-img), APFS-clones it per
   server, and falls back to the Debian installer only when no image fits.
   Boxes install/build only the daemon (`--workspace=packages/server-daemon`,
   `tsc -b packages/server-daemon`; box `node_modules` 182 → 113 MB). Hosts with
   ≤16 GiB RAM give a VM 4 GiB, not 6 (all three cores + vectors). Unused cached
   ISOs are pruned after 30 days (all three). **Validated live on this Mac
   2026-10-10** (`home2.plucky-avocet`, iPhone dev build + signed Studio):
   create → specialized and resealed in ~45 s → phone unlock → Let's Encrypt
   cert + HTTPS 200 about 2.5 min after creation. The first attempt exposed that
   both appliance seed builders (Swift + Node CLI) seeded the raw recipe instead
   of install-blob.json, so the guest bootstrap read nulls and stopped silently;
   fixed via the engine's `buildInstallBlobJsonFromRecipe`, and the specializer
   now reports each stage and any failure to the install timeline. Remaining:
   publish the CI rebuilds of both arches (they bake the code of their build
   day, so rebuild when `main` moves meaningfully). Windows and Linux host from
   the same appliance since 2026-10-15 (not yet run on real hardware).
3. **Hetzner:** account suspended; five orphaned servers to delete by hand when
   it unlocks (153213447, 153638469, 153643080, 153813669, 155315594).
4. **Minimum-OS review** (Conventions rule): done. Android and Wear OS are
   `minSdk 33`; Mac Studio is macOS 15 (2026-10-17).
5. **Restricted-device profile-key delivery is unimplemented.** The server
   stores and authorizes `accountDirectoryKeyGrant`s, but no client seals or
   unseals `sealedKeyHex`. Mirror the `AcmeAccountKeyGrant` envelope with
   TS/Swift/Kotlin parity, golden vectors and negative tests. Until then the webapp has no `acme-account-key-grant/v1` primitive on purpose (parity allowlist: iOS/Android carry only the unused canonical bytes).
6. **Native UI tests** for account/device rename, managed override, lock/unlock
   were deleted in the private-naming cutover and never replaced.
7. **Recovery Phase B re-pair** needs a real-device check (rotated key ⇒
   re-pair with grace; unrotated ⇒ instant pair). iOS jetsam crash after ~14 min
   and the "I already have an account" input delay are undiagnosed.
8. **Marketplace security scanner** (`scan_grade` ships NULL) gates a public
   marketplace.
9. **In-house AI inference** (build-modes follow-on): flip the `LlmHarness`
   `baseUrlGuard` when we host a model.
10. **iOS 1.1:** hinge-aligned list/detail on the open iPhone Duo (confirm how
    iOS 27 reports hinge geometry first); the closed-fold return to portrait is
    unverified.
11. **Static-asset content-hashing:** the site flashes unstyled mid-deploy.
    Content-hash filenames and serve them immutable, or at least 404 `.css`/`.js`
    instead of the SPA fallback (`apps/com/src/route.ts`).
12. **Relay-trust enforcement is OFF** (`FLAGSHIP_RELAY_TRUST_ENFORCE`). Before
    flipping it on a canary, do `docs/maintainer-trust-enforcement.md`
    live-validation steps 7–9 (dedicated hub credential, persisted blessing,
    re-verify on expiry).
13. **VM boot observability:** the wired initramfs unlock log isn't persisted to
    the FLAGSHIP_BOOT partition (the Wi-Fi path's is), and the "taking longer
    than expected" stalled-boot advisory exists on Mac, Linux and Windows Studio.
14. **Obsolete plaintext display-name fixtures** remain in some active tests.
15. **Repo adapters** (`docs/repo-adapters.md`): built and deployed
    2026-10-11 — single-file format, the public store
    (github.com/ibisllc/flagship-adapters, token set, migrations 0085–0086
    applied), share by default with up to 2 fix rounds, crash/report
    complaints (3 retire an adapter), weekly insights at
    `/api/admin/adapter-insights`. Endorsed for boxes as `1584bfe8`.
    Remaining: a live import on a box and the first 00:00 UTC publish;
    `ADAPTER_REVIEW_ANTHROPIC_KEY` before release (no key = no review, no
    insights); per-IP limits on submit/complain (anyone can retire an
    adapter with 3 anonymous complaints). Git and IDE builds still live only
    in daemon memory, so a restart forgets them (journals survive).
16. **Flagship Inference region choice:** both shim upstreams are US
    (DeepInfra primary, OpenRouter fallback). Add a user-selectable US/EU
    region (an EU upstream such as Scaleway, picked per account).
17. **Share this server, after v1** (owner, 2026-10-14; v1 targets a family:
    start-up approval while the owner is away, plus day-to-day upkeep).
    Later, in order: **succession** (the owner names a successor who can
    claim ownership if the owner's dead-man switch lapses, after a waiting
    period the owner can cancel; today transfer needs the giver, so a server
    dies with its owner's account); **disk-key rotation** when an unlock
    share ends (an ex-sharer may have kept the key); an **activity log
    co-managers can see**; **IDE/git builds for co-managers** with MCP keys
    scoped to the share and revoked with it. Offices (company owns the
    server, staff come and go) need all four: target them after.
18. **Flagship Inference allowances: decided (owner, 2026-10-15).** Keep
    2M starter, 500k a week, 50M daily cap: 40 measured builds put a first
    build at 3-9% of the 474k estimate (`docs/ai-inference-costs.md` §16;
    harness `infra/inference/build-eval`). Thinking is off on Flagship
    Inference (we pay for it): the shim strips the box's effort and sends
    each model's switch, except GLM, which fails every build switched off
    and gets none; replies get per-model caps. Remeasured with thinking off
    (§16): High 9/10 (was 6/10), GLM 9/10. Live with the next shim and
    `.com` deploys. Lineup decided the same day: GLM (Medium multimodal
    2×) is the default, Low is off (3× if turned back on), Medium and High
    stay, allowance unchanged; at most ~$85 a month at the daily cap. The
    lineup and allowance are server-side settings now, changed without a
    deploy: `npm run inference-settings` (`docs/runbooks/inference-settings.md`,
    D1 `inference_settings`, migration 0103). Open: Qwen sometimes asks its questions as plain text
    and the box deploys with no manifest. The description stays at 30
    characters. Paid-tier AI allowances (1M/5M/20M) in `meter.ts` are
    placeholders until payments.

### Feature branches (each = `main` + one feature; rebase when `main` moves)

All rebased onto `main` 2026-10-16 (the earlier tips are kept as
`backup/<slug>-pre-rebase-<date>`; `main` has moved since, so they are behind again). `scripts/rebase-features.sh` reports
how far each branch is behind its parent and the conflicts a rebase would hit;
`--apply` rebases and pushes the clean ones and lists the rest. A branch that
changes the webapp runs its own shell version above its parent's
(marketplace v117, custom-domains v118, custom-names v119, outbound-proxy
v120 over `main`'s v116 at that rebase; `main` is well past that now (v153 on 10-18), so the next
rebase renumbers them again):
when `main` passes it, take the next unused number and move the tests' pins.
Not compiled since the rebase: the iOS and Android code on any branch.

- **`feat/marketplace`** (+ Pro payments, vouchers). Also a Pro option:
  **a separate access list on each server** per app (2026-10-15,
  `docs/service-access-gating.md` "Separate lists per server (Pro)": an
  admin-root-signed `flagship/app-list-scope/v1`, honoured by a box only while
  it holds a CA-signed `flagship/plan-attestation/v1` from `.com` saying Pro;
  a verified lapse merges every app into its lead server's list with a
  content-free `access-lists` push; webapp, iOS and Android at parity). Not
  run on a real box. Its migrations 0090–0091
  live on the branch (`main` skips 0088–0094 for branches). The allowance and
  purchases reads now take the account read token like `/pods`. Open: Android's
  marketplace page has its own server picker but installs through the current
  server's client. **`feat/custom-names`**
  (dibs + paid name change; off marketplace): server side built; remaining are
  renaming an account that has servers, the client flow on all three apps, a
  live D1 run, and owner config (`DIBS_WINDOW_START/END`, $10/$20 vouchers,
  exempt `/dibs` from the coming-soon gate). Migrations 0092–0094 live there; a
  rename moves `meter_counters` rows.
- **`feat/custom-domains`** (off marketplace): Pro gate built. `main` refuses new
  orders with "Custom domains aren't available yet" and has no custom-domain
  UI in any app (removed 2026-10-13 in `209a6298`; the branch brings it all
  back on top of marketplace); keep the branch's Pro wording at launch.
  Remaining: live e2e, Stripe price ids.
- **`feat/outbound-proxy`** (off marketplace; Pro): a box's outbound traffic
  through an owner-set SOCKS5/HTTP proxy, and its setup calls through an
  OHTTP relay to `.com`'s gateway (`docs/outbound-proxy.md`). It holds D1
  migration **0099** (`relay_health`): `main` skips 0099. Owner: pick the
  relay (Oblivious Network first) and set the relay secrets.
- **`feat/phone-usb-burn`:** validate the OTG write on a real phone + stick,
  publish the seed and set `FLAGSHIP_ISO_SEED`.
- **`feat/other-os-installers`** (owner, 2026-10-18): `main` + the Ubuntu
  subiquity autoinstall generator/remaster (TS, Swift, C#, the engine API
  `buildUserDataFromRecipe`) and `packages/installer-netboot` +
  `scripts/build-flagship-netboot-iso.*`, for a future other-OS effort. Its
  LUKS burn passphrase constant is removed from those paths but they are
  UNTESTED (see `OTHER-OS-INSTALLERS.md` on the branch). Rebase onto `main`
  when it moves; nothing on `main` depends on it.
- **`feat/retail`** (NFC box), **`feat/browser-extension`**, **`alpine`** (parked
  installer), **`gym`** (main + the gym trust pin and app adoption seams; kept
  current by `scripts/gym-refresh.sh`; run its live account-recovery spec).

### Pricing decisions (owner, 2026-10-09)

Free 25 GB; Pro $10/mo (250 GB, 1 custom domain); Pro Max $20/mo (500 GB,
unlimited domains); overage $0.05/GB; name change $10; dibs claim $20 (`.com`
holders only, for one year starting when paid name change ships, not October
2026: owner, 2026-10-13). Quotas are live on `main`; nothing is purchasable
yet, and nothing will be at launch (`docs/launch-mvp.md`); payments are the
first update after it (`docs/anonymous-vouchers.md`, $1 voucher unit). Detail: `docs/naming-recovery-and-name-change.md` §16,
`docs/monetization-free-tier-first.md`.

### GA close-out (do NOT do in dev)

1. ~~Prod-wipe script~~ guarded 2026-10-17 (`scripts/wipe-all-users.sh`: no
   default target, env must match the database, a prod wipe needs a person
   typing `flagship-state` at a terminal; `release-guard.sh` fails if a guard
   goes). Keep its table list in step with migrations (a test enforces it).
   Still to run: the last pre-GA scrub, keeping only `playstore-test-0725`
   (`docs/runbooks/pre-ga-scrub.md`); update this item after the run.
2. ~~Remove the burn-time LUKS passphrase~~ done 2026-10-18 for the USB/ISO
   installer (`docs/luks-burn-passphrase-removal.md`): a random passphrase per
   install is generated inside d-i, the bootstrap removes it and fails the install
   (console banner, no poweroff) unless exactly one key slot remains;
   `release-guard.sh` is green under `RELEASE=1` and fails every build if the
   constant, a disabled removal or the single-slot proof regresses. Proved in a
   real d-i run in QEMU (`tools/luks-di-qemu/`). Needs new Studio/phone builds and
   republished VM appliances (the appliance specializer verifies its factory-key
   removal too); installed boxes keep their old slot until reburned (not scrubbed).
   **Live proof 2026-10-18:** `tools/live-e2e/lanes/luks-burn.ts` booted a real
   UpCloud server from the personalized ISO; the real bootstrap registered with the
   gym `.com`, sealed, removed the key and reported the one-slot detail; torn down,
   gym DNS back to base. It also found and fixed two ISO bugs (BIOS boots landed in
   the speech installer without the preseed; apt hung on the CD apt source).
3. Remove the demo/dev flips (demo mode, any remaining hidden toggles). **iOS and webapp done 2026-10-16:** Release iOS builds carry no mock clients, fixtures, gym seams or developer mode (all `#if DEBUG`; `scripts/ios-release-clean.mjs`, `--build` checks a built app), the webapp has no `?debug=1` tools. Demo accounts stay (real `.com` accounts). iOS Add a device / Join an account had only the in-process mock relay, so Release now refuses with a sentence until the `/qr-pipe` pairing transport exists. **Rest done 2026-10-17:** the public `/dev/create-server` phone simulator is gone; `scripts/release-clean-sources.test.ts` scans the webapp, the site, Android's main source sets and `.com`'s `/api/dev` surface (only the demo `sample-user` routes remain) in plain vitest; Android's built-APK check is `apps/mobile/android/scripts/check-release-clean.sh`. Open: Studio's `FLAGSHIP_CONTROL_INSECURE` (Windows pairing over plain ws) and the box's `FLAGSHIP_MAINTAINER_PIN_OVERRIDE` seam are env-only and root-gated, left for the owner to decide.
4. Fill the `pro.html` payment placeholders (on `feat/marketplace`).
5. ~~`DEV_LATE_LOG` / W12 debug endpoints~~ removed 2026-10-17 (late-log, Hetzner
   rescue/destroy/server-info, upload-iso; installers post no logs any more; needs
   an endorsed box release and a `.com` deploy; `legacyLateLogs.ts` and its cron
   call go on or after 2026-10-31).
6. Quiet the box console: diagnose `journalctl -b -p warning` on a real box
   first, fix real warnings at the source, then add `quiet loglevel=3`.
- Owner debug access ships at GA by owner decision (2026-10-16): SSH key only,
  an admin-signed `flagship/debug-access/v2` grant naming the box, the key and
  an end time (at most 7 days; renew or revoke from the server page), shown on
  the server page and in Activity (docs/recipe-delivery-and-remote-install.md
  "Debug access"). `debugAccessGate.ts` is its only sanctioned home; the
  release guard fails any debug password anywhere, dev included.

### Environment traps

- `apps/com`: `npm run deploy` rebuilds the bundled packages from an empty
  `dist/` and runs the predeploy gates; never call `wrangler deploy` directly.
- Build and deploy only from a worktree with its own `node_modules`; a symlinked
  one silently compiles another branch's sources.
- iOS: the `Flagship` scheme is a SwiftPM library (empty archive). Build the app
  from `apps/mobile/ios/App/FlagshipApp.xcodeproj`, scheme `FlagshipApp`, with a
  `-destination` and no `-sdk`. Xcode 27.1 RC lives at
  `/Applications/Xcode-27.1.0-Release.Candidate.app` (`DEVELOPER_DIR`).
- Android: Gradle needs `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
- This Mac's disk is tight; clear DerivedData and simulator data before big builds.
- `.services` Fly deploys with `--strategy=immediate` drop every box's tunnel for
  ~20 s; that's expected, not a regression.

### When in doubt

This file is the in-repo source of truth. For deeper detail, read the relevant living
spec in `docs/`, the runbooks in `docs/runbooks/`, or — for architecture —
`project_overview.md` in agent memory. `docs/archive/` is frozen history.

### Living design specs (index)
- **Cert & addressing** — `per-user-cert-and-addressing.md`, `per-user-cert-worklist.md`, `multiplexing.md`, `service-addressing-double-dash.md`
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `box-request-inbox.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `security-notices.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`, `account-deletion-and-name-reclaim.md`, `server-replacement-graceful-decommission.md`, `box-recipe-persistence-and-restore.md`, `multi-pod-liveness-session-leadership.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `naming-recovery-and-name-change.md`, `username-suggestion-queue.md`, `sample-users.md`
- **Install / ISO / builder** — `studio-mac-app-store.md`, `recipe-schema-v2.md`, `installer-tiny.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`, `recipe-delivery-and-remote-install.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `repo-adapters.md`, `monetization-free-tier-first.md`, `metering.md`, `launch-mvp.md`, `anonymous-vouchers.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`, `ui-test-gym.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `main-reconciliation-plan.md`, `runbooks/`, `policy/`
