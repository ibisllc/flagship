# Flagship — orientation for Codex

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. `CLAUDE.md` imports this file using Claude Code's supported `@AGENTS.md` syntax; never hand-sync a second copy. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + webapp./remote.flagshipserver.com (host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   studio/                 /studio — short desktop download + direct phone-pairing guide
   dev/create-server       /dev/create-server — phone simulator
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
- `https://flagshipserver.com/dev/create-server` — phone simulator (mints build codes)
- `https://flagshipserver.com/status/` — live health
- `https://flagshipserver.com/api/health` — JSON health
- `https://flagship.services/api/health` — direct Fly health
- `https://<server>.<user>.flagship.services/` — user content (after a real install)

## Common operations

```sh
# Tests
npx vitest run                                  # everything (~30s)
npx tsc -b                                      # typecheck the whole tree

# Deploy
npx tsc -b && (cd apps/com && npm run deploy)   # Worker — it bundles the BUILT dist/ of the packages in scripts/com-bundled-packages.sh. Use `npm run deploy` (NOT `wrangler deploy` directly): its `predeploy` rebuilds those packages from an empty dist/ (scripts/clean-build-com.sh — `tsc -b` alone never deletes a removed module's output) and then runs the guard (scripts/predeploy-com.sh — route-safety + dist-freshness + orphaned-output + migration drift)
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
  **watchOS 11.0** (the iOS 18 companion). Not yet reviewed against the rule:
  the Mac Studio app (`macOS 14`) and Android (`minSdk 28`) — see the open
  list. Platform versions in the `swift-tools-version:5.9` manifests use the
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
  long-lived id may be shared between contexts. App ranks are fixed and
  ordered: Member < Manager < Master (crown) < the box owner; apps decide
  what each rank may do, the box never blocks writes by rank.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace; also Pro payments + vouchers), **`feat/retail`** (getting the
  app working with retail / NFC boxes), **`feat/browser-extension`**,
  **`feat/phone-usb-burn`** (Android burns a USB stick on its own),
  **`feat/custom-names`** (dibs + paid name change) and **`feat/custom-domains`**
  (custom domains as a Pro feature) — the last two branch OFF `feat/marketplace`
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
> Last updated **2026-10-12**.

### Launch

Scope agreed 2026-10-13 in `docs/launch-mvp.md` (date to be set): free only,
no payments; free AI credits on by default; free tier slowed, not cut, past
25 GB; custom domains, name change + dibs, marketplace and payments come
after. Windows/Linux Studio ship as "preview". **Share this server** (another
account can view or co-manage a server, never destroy it) is in the MVP
(`docs/share-a-server.md`, branch `feat/share-server`).

**Release readiness (2026-10-15):** `npm run ready` is the scoreboard to re-run
after each batch of fixes (branch drift, tsc, vitest, e2e, locked gym, cross-
client parity; `-- --native --live` before a release candidate). Loop and
owners: `docs/runbooks/release-readiness.md`; feature matrix:
`parity/features.json` (`npm run parity -- --report`).

### Urgent

- **Renew the CA endorsement lease before 2026-11-05.** The production CA's
  only live lease (`.maintainers/ca-endorsements/bundle.json`) expires then, and
  every CA-chain check fails closed after it (app trust checks, relay blessing,
  Alpine bootstrap). Needs the owner's YubiKey: mint a `CaEndorsement` with the
  maintainers CLI, commit it, redeploy `.com`.

### In flight

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
  each. Ranks are member < manager < master (+ owner), cumulative; apps
  enforce them, the box never blocks by rank; manifests carry one line per
  rank (`access.role_descriptions`, the AI must write them). Every invite
  redemption is its own grant; effective rank = highest live grant; the
  owner's signed `flagship/app-member-role/v1` order (targets `invite:`,
  `grant:<invite>/<aid>`, `aid:`) via `GET/POST
  /api/screens/services/:id/members[/role]`. Open apps get
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
  never ran). Not yet run live: a phone on a metal box's Wi-Fi, and a copy
  between two Studio VMs (needs the endorsed release on both).
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
  at once (`flagship://remote?s=<sid>&k=<browser X25519>`, the `/qr-pipe`
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
  "Show my servers" instead of an empty list; the co-manage entry moved to
  the Add-a-server page. Needs: migration 0096 before the `.com` deploy
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
allowances (1M / 5M / 20M a month) are placeholders. `feat/custom-names`'
`accountRename.ts` must move `meter_counters` rows too.

### Built, waiting on deploys or rebuilds

- **`.com` Worker:** current with `main` as of 2026-10-13 (webapp shell **v60**; `main` is at v71).
  Always `npx tsc -b` first and apply pending D1 migrations before deploying.
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
- **Windows + Linux:** `studio-v0.1.2` on GitHub Releases, built by the
  on-demand `studio-release.yml` (pass `publish=true` to release). Windows is a
  zip with `xorriso` bundled in `tools\`, **unsigned** (no code-signing cert;
  v0.0.1 wasn't signed either). Linux is an x86-64 AppImage that needs Node.js
  20+ and pkexec. Neither has been run on a real Windows PC or Linux desktop:
  see "Validating on Windows and Linux" below.
- **Mac App Store plan: deferred** (owner, 2026-10-13, to keep Studio one
  app). `docs/studio-mac-app-store.md` is saved for a future migration:
  sandboxed hosting-only Studio in the store, USB burning in a small
  direct-download USB Writer opened from Studio with the recipe.
- Studio's VM networking is NAT on every host, so a hosted VM can never be
  reached directly from a phone on the same Wi-Fi (LAN-direct can't help a
  phone there; two VMs on one Mac do reach each other).

### Validating on Windows and Linux

Follow `docs/runbooks/desktop-windows-linux-validation.md`: the released
Windows zip and Linux AppImage each need one real run (pair with a phone, host a
server through phone unlock to a green padlock, burn a USB and boot it on
metal), plus the Debian 13.7.0 check. Record results under "Desktop Studio".

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
   ISOs are pruned after 30 days (Mac + Linux). **Validated live on this Mac
   2026-10-10** (`home2.plucky-avocet`, iPhone dev build + signed Studio):
   create → specialized and resealed in ~45 s → phone unlock → Let's Encrypt
   cert + HTTPS 200 about 2.5 min after creation. The first attempt exposed that
   both appliance seed builders (Swift + Node CLI) seeded the raw recipe instead
   of install-blob.json, so the guest bootstrap read nulls and stopped silently;
   fixed via the engine's `buildInstallBlobJsonFromRecipe`, and the specializer
   now reports each stage and any failure to the install timeline. Remaining:
   publish the CI rebuilds of both arches (they bake the code of their build
   day, so rebuild when `main` moves meaningfully); Linux/Windows still host via
   the installer ISO by default.
3. **Hetzner:** account suspended; five orphaned servers to delete by hand when
   it unlocks (153213447, 153638469, 153643080, 153813669, 155315594).
4. **Minimum-OS review** (Conventions rule): Mac Studio is macOS 14, Android is
   `minSdk 28`. Decide for the next releases.
5. **Restricted-device profile-key delivery is unimplemented.** The server
   stores and authorizes `accountDirectoryKeyGrant`s, but no client seals or
   unseals `sealedKeyHex`. Mirror the `AcmeAccountKeyGrant` envelope with
   TS/Swift/Kotlin parity, golden vectors and negative tests.
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
12. **Netboot path** (`parse-trailer.sh`) verifies v2 blobs but nothing ships it.
13. **Relay-trust enforcement is OFF** (`FLAGSHIP_RELAY_TRUST_ENFORCE`). Before
    flipping it on a canary, do `docs/maintainer-trust-enforcement.md`
    live-validation steps 7–9 (dedicated hub credential, persisted blessing,
    re-verify on expiry).
14. **VM boot observability:** the wired initramfs unlock log isn't persisted to
    the FLAGSHIP_BOOT partition (the Wi-Fi path's is), and the "taking longer
    than expected" stalled-boot advisory exists on Mac only, not Linux/Windows.
15. **Obsolete plaintext display-name fixtures** remain in some active tests.
16. **Repo adapters** (`docs/repo-adapters.md`): built and deployed
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
17. **Flagship Inference region choice:** both shim upstreams are US
    (DeepInfra primary, OpenRouter fallback). Add a user-selectable US/EU
    region (an EU upstream such as Scaleway, picked per account).
18. **Share this server, after v1** (owner, 2026-10-14; v1 targets a family:
    start-up approval while the owner is away, plus day-to-day upkeep).
    Later, in order: **succession** (the owner names a successor who can
    claim ownership if the owner's dead-man switch lapses, after a waiting
    period the owner can cancel; today transfer needs the giver, so a server
    dies with its owner's account); **disk-key rotation** when an unlock
    share ends (an ex-sharer may have kept the key); an **activity log
    co-managers can see**; **IDE/git builds for co-managers** with MCP keys
    scoped to the share and revoked with it. Offices (company owns the
    server, staff come and go) need all four: target them after.
19. **Set the real Flagship Inference allowances** from measured builds:
    run the DeepInfra build harness (`infra/inference/build-eval`) for
    tokens per build per model, then set `AI_PROMO_*` on `.com` (generous
    starter; weekly ≥ one real edit session). The paid-tier AI allowances
    (1M/5M/20M) in `meter.ts` are placeholders until payments.

### Feature branches (each = `main` + one feature; rebase when `main` moves)

- **`feat/marketplace`** (+ Pro payments, vouchers). **`feat/custom-names`**
  (dibs + paid name change; off marketplace): server side built; remaining are
  renaming an account that has servers, the client flow on all three apps, a
  live D1 run, and owner config (`DIBS_WINDOW_START/END`, $10/$20 vouchers,
  exempt `/dibs` from the coming-soon gate). Migrations 0092–0094 live there.
- **`feat/custom-domains`** (off marketplace): Pro gate built. `main` refuses new
  orders with "Custom domains aren't available yet" and has no custom-domain
  UI in any app (removed 2026-10-13; the branch holds it all); keep the
  branch's Pro wording at launch. Remaining: live e2e, Stripe price ids.
- **`feat/phone-usb-burn`:** validate the OTG write on a real phone + stick,
  publish the seed and set `FLAGSHIP_ISO_SEED`.
- **`feat/retail`** (NFC box), **`feat/browser-extension`**, **`alpine`** (parked
  installer), **`gym`** (test harness; run its live account-recovery spec).

### Pricing decisions (owner, 2026-10-09)

Free 25 GB; Pro $10/mo (250 GB, 1 custom domain); Pro Max $20/mo (500 GB,
unlimited domains); overage $0.05/GB; name change $10; dibs claim $20 (`.com`
holders only, for one year starting when paid name change ships, not October
2026: owner, 2026-10-13). Quotas are live on `main`; nothing is purchasable
yet, and nothing will be at launch (`docs/launch-mvp.md`); payments are the
first update after it (`docs/anonymous-vouchers.md`, $1 voucher unit). Detail: `docs/naming-recovery-and-name-change.md` §16,
`docs/monetization-free-tier-first.md`.

### GA close-out (do NOT do in dev)

1. Guard or remove the prod-wipe script (`scripts/wipe-all-users*`); keep its
   table list in step with migrations until then.
2. Remove the burn-time LUKS passphrase
   (`flagship-build-time-luks-rekey-me-immediately`) and re-enable the
   `luksRemoveKey` guard. `release-guard.sh` stays red on release tags until then.
3. Remove the demo/dev flips (demo mode, any remaining hidden toggles).
4. Fill the `pro.html` payment placeholders (on `feat/marketplace`).
5. Remove `DEV_LATE_LOG` / W12 debug endpoints in `controlPlaneRoutes.ts`.
6. Quiet the box console: diagnose `journalctl -b -p warning` on a real box
   first, fix real warnings at the source, then add `quiet loglevel=3`.
- Grant-gated debug SSH ships in v1 by owner decision; `debugAccessGate.ts` is
  its only sanctioned home and the release guard enforces that.

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
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `box-request-inbox.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`, `account-deletion-and-name-reclaim.md`, `server-replacement-graceful-decommission.md`, `box-recipe-persistence-and-restore.md`, `multi-pod-liveness-session-leadership.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `naming-recovery-and-name-change.md`, `username-suggestion-queue.md`, `sample-users.md`
- **Install / ISO / builder** — `studio-mac-app-store.md`, `recipe-schema-v2.md`, `installer-tiny.md`, `installer-netboot.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`, `recipe-delivery-and-remote-install.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `repo-adapters.md`, `monetization-free-tier-first.md`, `metering.md`, `launch-mvp.md`, `anonymous-vouchers.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`, `ui-test-gym.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `main-reconciliation-plan.md`, `runbooks/`, `policy/`
