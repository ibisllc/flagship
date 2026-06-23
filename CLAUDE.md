# Flagship — orientation for Claude Code

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + web.flagshipserver.com (webapp host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   ready/                  /ready/ — after an order: copy/download the recipe + get the burner (replaced the old /build/ paste-a-code page; /build/iso/ stays as the R2 ISO-stream backend)
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on web.flagshipserver.com)
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
- `https://flagshipserver.com/ready/` — after an order: copy/download the recipe + get the burner
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
npx tsc -b && (cd apps/com && npm run deploy)   # Worker — tsc -b FIRST: it bundles the BUILT control-plane dist/, so a deploy without a rebuild silently ships stale handler logic. Use `npm run deploy` (NOT `wrangler deploy` directly): it runs the `predeploy` guard (scripts/predeploy-com.sh — route-safety + dist-freshness)
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# D1 schema migrations
cd apps/com && npx wrangler d1 execute flagship-state \
    --file=../../packages/storage/migrations/0003_install_events.sql --remote

# Smoke a fresh build chain
# 1. Open https://flagshipserver.com/dev/create-server in a browser
# 2. Mint an order; collect the recipe from https://flagshipserver.com/ready/
# 3. Run packages/hello-daemon with the printed creds
# 4. curl https://<assigned-subdomain>/   (real green padlock)
```

## Conventions

- **No `Co-Authored-By: Claude` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace) and **`feat/retail`** (getting the app working with
  retail / NFC boxes). **No marketplace/retail code may sit on `main` until
  that feature launches** — branching IS the gate, there is NO gating/flag code
  in `main`.
  - **`feat/transfer-a-box` is a *develop-then-MERGE* branch, not a perpetual
    gate.** Unlike marketplace/retail (held off `main` until a product launch),
    transfer-a-box is a core follow-on to the already-shipped account-deletion
    work — its protocol contract is ALREADY on `main` (inert: no handlers/UI),
    and the branch completes the rest (the `.com` namespace-migration broker, the
    giver-phone re-seal, box-side cert/entitlement re-home, the giver-QR +
    acquirer-camera clients). **TODO: merge `feat/transfer-a-box` into `main`
    once it is complete + reviewed + (box-side) reburn-validated.** Design +
    build-order: `docs/account-deletion-and-name-reclaim.md` §4. (Started on a
    background worker 2026-06-21.)
  - **`alpine` is a *parked* branch, not a feature-to-launch.** It holds the
    full Alpine bare-metal installer path (ISO builder + apkovl + installer-tiny
    + the burner Quick/trailer flow + `/api/personalize-iso`) that `main` shed
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

> **This section is the single source of truth.** Update it as work lands —
> don't spawn new `docs/*handoff*.md` files. Dated handoffs + completed launch
> trackers are frozen in `docs/archive/`. Last updated **2026-06-22**.

### 2026-06-22 — `--` service-addressing + dashed-username grammar: FOUNDATION (TS+webapp) + NATIVE migration

**The slug↔creator delimiter is now `--` and usernames may carry interior dashes,
end-to-end across all surfaces** (spec: `docs/service-addressing-double-dash.md`).
Decision recap: app ids/url labels need a way to identify a service uniquely
*throughout the system*, so the composite is `<creator>--<slug>` (and the flattened
url form `<slug>--<creator>`, bare slug when self-authored — `--` is only ever
visible on a same-slug multi-vendor collision). Usernames therefore relax from
`^[a-z0-9]{3,30}$` (dashless) to `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$` (3–30, interior
single dashes, no leading/trailing) **plus an explicit `--` ban** (the regex alone
would permit `--`). Routing/certs/voi.ci are **delimiter-agnostic** (the SNI router
splits on the first DOT and treats the leftmost label as opaque; the per-box wildcard
covers any leftmost label) so this change touches naming/parsing only — never the
cert or routing layer (§4.E of the spec).

- **Foundation (pushed to `main`, 5 commits):** `packages/protocol/serviceId.ts`
  (`SERVICE_ID_DELIM = "--"`, `composeServiceId`/`parseServiceId`/`deriveUrlFragment`);
  control-plane `labels.ts` (`USERNAME_RE` + `isValidUsernameShape` `--` ban) +
  `randomUsername.ts` (the `<adjective>-<noun>-<NNNN>` generator + `GET
  /api/username/random`); services-zone `validation.ts` (`parseAppLabel` splits on
  `--`); daemon parse/generate sites (`cloneService`/`updateClient`/`deploySession`/
  `deployArtifact`); the webapp username-first cover flip + dashed grammar. ~50 TS
  daemon/control-plane test fixtures converted single→double dash. `tsc -b` clean,
  **3430** vitest green.
- **Native migration (iOS + Android, THIS pass):** mirrored the grammar + the
  `serviceId` **local-derivation fallbacks** (the only native parse of the
  composite — clients prefer the daemon-provided `urlLabel`; this is the offline
  fallback). iOS: `FlagshipServerClient.swift` (`usernameRe` + reason + `--` ban;
  the `firstIndex(of:"-")` split → `range(of:"--")`), `ChooseUsernameViewModel`,
  `ServiceDetailViewModel`, `ServicesTab` (×4), `VibeCodeChatScreen`,
  `ServiceDetailScreen` copy. Android: `ChooseUsernameScreen.kt` (`usernameRegex` +
  `usernameShapeOk`), `api/FlagshipServerClient.kt` (mock grammar + `indexOf("--")`
  split), `ServiceAccessScreen`/`ServicesTab`/`VibeCodeChatScreen`/`ServiceDetailScreen`.
  Demo/mock serviceId fixtures (`harry--plants`, `alice--notes`, `meta--scratchpad`,
  `trent--scratchpad`, the `scratchpad--trent` url label) + their split-derived test
  expectations converted across ~34 native files. Username-grammar tests rewritten
  (single dash now valid, `--`/leading/trailing rejected, new reason strings).

Gates: iOS `xcodebuild test` **1183/1184** (the 1 = a cross-suite flake —
`ServiceUninstallTests.test_uninstall_resolvesCreatorSlugFromLoadedDetail` passes
isolated + intra-class 8/8) · Android `:app:testDebugUnitTest` **BUILD SUCCESSFUL**
(1054). Mobile shows it after an Xcode/Gradle rebuild. **NOT yet built (deferred,
per the spec's later phases):** the display rule polish (`<slug>--<creator>` only on
same-slug collision), recovery-enrollment gate, paid name-change re-home, dibs
domain-proof.

### 2026-06-22 — naming/recovery model DECIDED + spec; "claim after a wait" removed

**Owner-directed naming + recovery model (spec: `docs/naming-recovery-and-name-change.md`).**
After a long design discussion: **names are self-custody + forever** — no admin
stripping, no GC, no no-credential "grace takeover" (that path is being removed).
Recovery is credential-only (passkey / key-file / device-pair). Account creation
will assign a **random name** (free, unsquattable); **changing your name costs
money** (~$5, via the unlinkable-Pro rails) and is a same-owner **namespace
migration** (re-homes every box — FQDN/cert/DNS/entitlement — reusing the
transfer-a-box machinery; IRK unchanged ⇒ no disk re-seal). A **12-month launch
dibs** lets domain holders claim matching names via DNS/`.well-known` proof;
brands beyond that use **their own domain** (the sovereignty tier). Full build
checklist + 10 open decisions in the spec. **Shipped this turn:** removed the
no-credential "Claim after a wait" option from the webapp cover (accessOptions is
now the 3 credential paths; live, deployed). **NOT yet built:** everything else in
the spec (random-assign, paid name-change/re-home, dibs, the cover flip to
sign-in-only, the removals).

### 2026-06-22 — unified username-first cover (webapp) + Box Request Inbox visibility gaps

**Box Request Inbox visibility gaps (all surfaces, shipped):** a box waiting on
*entitlement* read "Never came online" on Home, and the Activity "Open approvals"
entry was gated behind the feed LOADING (which fails for the offline/awaiting
boxes that need it). Fixed: liveness now folds in `awaitingEntitlement`
(iOS `AppState.isAwaitingApproval`; Android `AppState.liveness`; webapp
`classifyServer`) so it reads "Waiting for approval" (decommission suppressed);
the approvals entry is hoisted OUT of the loaded-state branch on iOS + Android.
Webapp live; iOS/Android after a rebuild.

**Unified cover — WEBAPP done, mobile PENDING.** Root cause of "the name harry is
already taken": the cover's *create* path (`openAccount.claimUsername`) claims
with the webapp's fresh device key; a name bound to a *different* IRK (your
phone's) is rejected, and the create UI dead-ended at a trademark-claim / "try
another" — it never called `/api/account/resolve` or offered recovery. Rebuilt
the cover **username-first** (`views/bootstrap.js` + `index.html`): enter a name →
`resolveAccount` → **free** ⇒ sign up (claim), **demo** ⇒ join sandbox, **taken**
⇒ render ALL FOUR access pathways (`lib/accountAccess.js` `accessOptions`):
recover-with-passkey (enabled iff cloud recovery enrolled), scan-a-pairing-code
(→ `enterJoin`), import-a-key-file (→ `enterRecovery`), claim-with-a-wait (grace,
per `graceModel`) — unsupported ones shown DISABLED + explained, not hidden. The
passphrase moved off the cover into the sign-up step. Gates: webapp accountAccess
**5** + static **31** + login-never-404 **25** + home/inbox/profiles/sessions/
post-recovery/account-deletion green; `tsc -b` clean. **NEXT: mirror the
username-first cover + access-options on iOS + Android lock screens** (where #1
scan-pairing wasn't even offered).

### 2026-06-21 — box-side self-delete execution + iOS ceremony XCTest SHIPPED; transfer-a-box protocol landed

**Closed two of the three account-deletion follow-ups + landed the cryptographic
core of the third** (design: `docs/account-deletion-and-name-reclaim.md`). 5
commits on `main`, each gated:

- **Box-side self-delete EXECUTION (the §5 content-wipe, end-to-end).** A
  `purpose:"self-delete"` `secret_mailbox` lane (storage: types + InMemory + D1 +
  D1↔InMemory parity); `handleAccountDeletionBundle` now DEPOSITS the owner-IRK-
  signed `servers-self-delete` order (one row per owned server) during the bundle
  commit — replacing the audit-only forward; a **revoke-tolerant**
  `handleConsumeSelfDeleteDeposit` (`GET /api/server/:d/self-delete`) — the
  ceremony revokes the server during teardown, so unlike the entitlement/pairing
  consume it must NOT 403 on `revokedAt` (safe: the order is owner-IRK-signed +
  re-verified box-side); and the daemon `selfDeleteConsumer` (heartbeat poll →
  decode/verify the carrier under the config-pinned owner IRK → `realWipeContent`
  = stop `flagship-data-services` + `docker compose down -v` + prune + drop the
  app data tree). Idempotent via a local marker. Box-side ⇒ needs a reburn for
  live e2e (unit-tested here: storage parity, control-plane deposit→consume-once
  +revoke-tolerant, daemon 10 cases incl. forged/wrong-account/junk rejected
  without wiping).
- **iOS dedicated ceremony XCTest** — `AccountDeletionViewModelTests` (6/6 TEST
  SUCCEEDED): opt-out bundles no servers order; opt-in bundles it + both orders
  re-verify under the owner IRK over the exact canonical bytes + share one
  issuedAt; wipe + drop-to-Welcome ONLY after 200; 403 "last device" surfaces the
  backstop and NEVER wipes; 403-generic/404 fail without wiping. Closes the
  "iOS has no dedicated ceremony XCTest" follow-up.
- **Transfer-a-box — protocol contract LANDED** (the rest is the remaining build).
  `server-transfer-offer` (giver IRK, the QR) + `server-transfer-claim` (acquirer
  IRK), byte-identical TS/Swift/Kotlin, pinned vectors (TS 8 · Swift 4 · Kotlin
  BUILD SUCCESSFUL). **Key finding (in §4): the broker is a NAMESPACE MIGRATION,
  not a username swap** — the box FQDN/cert-SANs/DNS/`podCanonical`/routing all
  encode the owner, so `alice`→`bob` re-homes the box; and the LUKS re-seal is a
  GIVER-PHONE step (only it holds the giver IRK; the box can't re-seal itself).
  REMAINING: `.com` namespace-migration broker, giver-phone re-seal-on-claim,
  box-side cert/entitlement re-home, client giver-QR + acquirer-camera.
  **✅ MERGED to `main` 2026-06-22** (`feat/transfer-a-box` deleted). Built across
  two workers + a main-loop validation/native-build pass. The full feature:
  storage `server_transfers` broker lane (migrations **0059** + **0060** disk-key
  handoff column, D1+InMemory+parity); the `.com` broker (`serverTransfer.ts` —
  offer deposit [giver-IRK mailbox-auth, verified under the box's CURRENT owner
  IRK] + one-time claim CAS [acquirer's REGISTERED IRK] → the `.com`-half
  **namespace migration** re-homing servers + routing `<server>.<giver>`→
  `<server>.<acquirer>` + per-box DNS + audit; claim-poll; the disk-key re-seal
  handshake `POST .../transfer/disk-key`+`/disk-key-claim`); daemon
  `transferRehomeConsumer` (polls `GET .../transfer/rehome`, persists a re-home
  marker, applies it at boot — overriding serverFqdn + owner IRK so the EXISTING
  A′ cert re-mint + entitlement self-heal do the rest, no new ACME code); the
  giver-phone disk-key re-seal (the giver re-seals to the **acquirer IRK**, a
  two-phone handshake — NOT a direct box-sealed-lease, since post-migration the
  lease-v2 handler verifies under the acquirer IRK); and the native iOS + Android
  giver-QR + acquirer-camera clients (+ webapp). Validation pass fixed the
  worker's compile-unverified iOS tokens (`FSFont.bodySm()`, `FSSpace.s4`).
  Gates: `tsc -b` clean · full vitest **6230** (the 1 "fail" = the known
  argon2id load-timeout flake, 12/12 isolated) · iOS **1184/0** · Android BUILD
  SUCCESSFUL · Swift shared 5/5. **Deployed** (`.com` Worker carries the broker;
  migrations 0059+0060 applied+stamped). **REMAINING (owner, NOT CI-validatable):
  a reburn for the box-side re-home + the giver→acquirer disk-key handshake live
  e2e**, and the small server-detail "Transfer to another account" entry +
  nav-route into `TransferGiverScreen` (the VMs/screens exist; just the hookup).

Gates: `tsc -b` clean · storage parity +2 · control-plane accountDeletion **23** +
secretMailbox · server-daemon selfDeleteConsumer **10** (full daemon+storage+
control-plane **2909**) · protocol vectors **14** · iOS `AccountDeletionViewModelTests`
**6/6** · Swift `ServerTransferCanonicalTests` **4/4** · Android
`ServerTransferVectorTest` BUILD SUCCESSFUL. **NOT deployed** (box-side needs a
reburn; the `.com` self-delete consume route ships on the next Worker deploy).
### 2026-06-22 (latest) — Box Request Inbox: one always-on channel for "a box is asking its owner" (SPEC + backend + webapp + iOS + Android)

**Why:** a box that needs an approval (unlock a disk, authorize itself to serve)
was surfaced through a sprawl of one-offs — two hand-computed `/pods` booleans
(`awaitingUnlock` + `awaitingEntitlement`), a unlock-only `BootApprovalWatcher`
with **no entitlement equivalent** (0 mobile refs to `awaitingEntitlement` vs
83 to `awaitingUnlock`), and pull-to-refresh detection. So an entitlement-stuck
box (e.g. ezra) re-asks forever (daemon `process.exit(1)` → systemd restart →
re-post) but nothing in the app turns the ask into a tappable card — loud on the
wire, silent to the human. Owner-directed unification. Spec:
`docs/box-request-inbox.md`.

**The insight:** the wire primitive is ALREADY generic over type — the box signs
`flagship/secret-request/v1|serverDomain|stkPub|purpose|nonce|issuedAt`; `purpose`
IS the type. So this is mostly *delete + unify* in the clients, not new protocol.
One inbox, one channel, one **type registry** (`type → {title, detail, respond}`);
`unlock-key` and `entitlement` become two registry entries. New types later =
one entry + one `purpose` string. (Also locked in the spec: there is **no
create-time entitlement deposit** — it binds the box's first-boot STK, unknown at
create. Deposit-on-unlock is the optimization; the inbox is the universal
fallback.)

**Landed this pass (backend + webapp reference, on `main` worktree, verified):**
- **Backend** (`podInventory.ts`): `/pods` now returns a typed
  `pendingRequests: [{id,type,issuedAt,expiresAt}]` digest per pod (the cheap,
  unauthenticated, pollable detection tier), computed from the same
  `listPendingForUser` scan (which already returns ONLY request lanes — deposit
  lanes never surface). The two booleans are kept for one release but **derived**
  from `pendingRequests` (compat for deployed webapp + un-rebuilt apps). +2 tests.
- **Webapp** (reference client): `bootApproval.js` refactored to a `satisfy(req)`
  dispatcher over `BOX_REQUEST_TYPES` (registry); added the `entitlement`
  responder so the webapp now answers BOTH types (was unlock-only, entitlement
  read-only). New `lib/boxInbox.js` — the channel/store (foreground-poll
  abstraction, future push/socket behind the same interface). `views/boot-approval.js`
  generalised to the inbox: every type actionable, registry titles, foreground
  auto-poll (no drag-to-refresh). +5 webapp tests; existing view/crypto tests
  updated.

**Mobile (iOS + Android) — DONE.** Key insight: the approvals LIST already
answered BOTH types (`confirmAndRespond` has the `.entitlement` branch); the gap
was purely PROACTIVE surfacing — the watcher + server-card only reacted to
`awaitingUnlock` (mobile had **0** refs to `awaitingEntitlement` vs 83 to
`awaitingUnlock`). So per platform: decode `awaitingEntitlement`/`pendingRequests`
off `/pods`; the watcher (`BootApprovalWatcher`) now publishes a typed
`PendingApprovalSets {unlock, entitlement}` from one poll into
`serversAwaitingApproval` + new `serversAwaitingEntitlement`; the coordinator
gained `approvePendingEntitlement` (mirrors `approvePendingUnlock`, no lease); the
server-card (`BootUnlockApprovalViewModel` + card) is parameterized by
`SecretPurpose` so ONE card serves both lanes (purpose-aware copy + dispatch);
ServerDetail renders the serve-auth card when `awaitingEntitlement`. This closes
the "silent box" hole — a box stuck on entitlement is now a one-tap card, not an
invisible crash-loop.

Gates: `tsc -b` clean (whole tree) · control-plane podInventory **27** (full
control-plane **1068**) · webapp boxInbox **5** + bootApproval crypto **6** + view
**7** + uxCopy **18** · iOS `xcodebuild test` **TEST SUCCEEDED** (BootApprovalWatcher
4 + BootUnlockApprovalViewModel 11 + SecretRequestCoordinator 13, +2 new) · Android
`:app:testDebugUnitTest` **BUILD SUCCESSFUL** (+2 new). Mobile shows it after an
Xcode/Gradle rebuild; backend + webapp deploy with `.com`.

**Remaining (deferred):** the two `/pods` booleans stay (derived from
`pendingRequests`) for one release, dropped once nothing reads them; a unified
`pendingRequests`-typed inbox object on mobile (vs the two parallel sets) and an
SSE/WebSocket + push transport are the spec's later refinements.

### 2026-06-21 — account-deletion ceremony + username reclaim SHIPPED (all 4 surfaces)

**The no-backup deletion ceremony + reclaim is built, tested, and on `main`**
(design: `docs/account-deletion-and-name-reclaim.md`). Scope delivered: the
deletion ceremony + the §5 self-delete bundle invariant + the admin reclaim tool.
**Transfer-a-box and box-side execution of the content-wipe order are DEFERRED**
(box-side disk-key re-seal needs a daemon pass + reburn; `.com` currently
records/forwards the servers-self-delete as audit rows only).

- **Protocol:** `account-self-delete` + `servers-self-delete` owner-IRK envelopes
  (`flagship/{account,servers}-self-delete/v1|<username>|<issuedAt>`), wrapped
  never-throwing verify, pinned cross-platform vectors (TS + Swift + Kotlin).
- **Control-plane:** `handleAccountDeletionBundle` — verifies the owner IRK,
  enforces LAST-DEVICE (zero active `device_capability_grants`; the founding
  device is the `usernames.irk_pub_hex` holder, not in the roster), HARD-DELETES
  the username row (name frees immediately) + ordered per-server teardown. **§5
  atomic bundle:** the content-wipe `servers-self-delete` is validated fully
  BEFORE any commit and accepted ONLY bundled with a valid last-device
  account-self-delete — a bad/absent companion or non-last-device rejects the
  WHOLE bundle (neither recorded). Admin reclaim `POST /api/admin/username/:u/reclaim`
  (≥90d inactive, dry-run) + `last_active` (migration **0058**) bumped coarsely.
- **Clients (webapp/iOS/Android):** full-page IRREVERSIBLE warning (username lost
  / servers stop — transfer first / no recovery) + type-username + biometric +
  opt-in "ask all servers to delete content" checkbox; signs the bundle, POSTs,
  and wipes local key material ONLY after a 200; 403 "last device" surfaced w/o
  wiping. `SignOutPolicy` gained the `deletionCeremony`/`DELETION_CEREMONY`
  outcome (no recovery + last device); both tier-2 sign-out and danger-zone
  remove-device route into the ceremony.

Gates: `tsc -b` clean · control-plane/storage/protocol **2053** · webapp account-
deletion **12/12** · iOS `xcodebuild test` **1172/0** · Android
`:app:testDebugUnitTest` **BUILD SUCCESSFUL** · Swift cross-platform vector
**5/5**. 7 commits, rebased cleanly onto the entitlement work + re-verified, pushed.
**Built via 2 multi-agent passes** (foundation agent + a client fan-out that
STALLED on the native builds — the workflow/agent stall-watchdog repeatedly killed
long silent `xcodebuild`/`gradle` runs, so iOS + Android were finished + built by
the main loop directly; webapp completed in-agent).

**Open follow-ups:** (1) **transfer-a-box** (giver QR + acquirer "Pair an existing
box" camera + box-side re-seal) — its own workflow next; (2) **box-side
self-delete execution** (daemon consumes the deposited order + a reburn); (3) iOS
has no dedicated ceremony XCTest yet (build-green + canonical vectors cover it;
webapp + Android have policy/ceremony tests). **Deploy prereqs (NOT done — owner
go):** apply + stamp migration **0058** before the next Worker deploy (the
predeploy migration gate blocks otherwise); this feature is **not deployed**; the
iOS/Android apps need fresh builds to test on device.

### 2026-06-21 — fold "authorize to serve" INTO the first-boot unlock (entitlement deposit) — BACKEND + DAEMON

**Why:** real boxes (frank, hali) stranded because authorizing a box to *serve*
is a SECOND phone approval, separate from the boot/unlock approval — and it
surfaces ~10s after unlock with no push, so owners never saw it. Owner decision:
*"if I give permission to boot, consent to serve is implied"* (for boxes that
require a boot-unlock). Design rationale in `docs/security-phone-as-unlock-endpoint.md`
(§4/§8 already unify unlock + entitlement as one mechanism).

**Mechanism (no protocol/canonical-bytes change — the entitlement carrier is
PUBLIC, IRK-signed, not a secret):** the phone, when it approves the first-boot
unlock, ALSO mints an owner-IRK-signed RootEntitlement for the box's STK (which
it holds from the unlock request) and DEPOSITS it on `.com`; the box claims it on
boot with no second tap. New blind store-and-forward lane mirroring the pairing
deposit.

**Landed this pass (backend + daemon, on `main`, isolated worktree):**
- **`.com` entitlement-deposit lane** — `POST/GET /api/server/:d/entitlement-deposit`
  (`secretMailbox.ts` `handlePost/ConsumeEntitlementDeposit`; POST is IRK-mailbox-
  auth + I2 registered-STK bind; GET is public consume-once). Storage:
  `put/consumeEntitlementDeposit` (D1 + InMemory, `purpose:"entitlement-deposit"`
  rows; no migration — reuses `secret_mailbox`). 1h TTL. Wired in
  `controlPlaneRoutes.ts`.
- **Daemon claims the deposit BEFORE relaying** (owner's explicit requirement):
  `entitlementRelay.ts` `claimEntitlementDeposit` (GET → `decodeAndVerifyEntitlementCarrier`
  under owner IRK → persist; short retry for a slightly-late deposit). Order in
  `loadEntitlementsOrExit`: disk → [self-heal discard if not IRK-signed] → **claim
  deposit** → relay. Null on no-deposit/mismatch → falls back to relay (never a brick).

Gates: `tsc -b` clean · storage+control-plane+server-daemon vitest **2871** (+3 new
`claimEntitlementDeposit` tests: claim+persist, 404→null→relay, wrong-STK→null).

**CLIENTS — DONE (all three surfaces).** On the unlock approval the phone now also
mints + deposits the entitlement for the box's STK (reusing the relay responder's
RootEntitlement mint), so an encrypted box comes online with ONE approval:
- **iOS** — `SecretRequestCoordinator.confirmAndRespond` deposits after the unlock
  reply when the owner IRK is in hand (the watch-delegate quick path has no IRK →
  box relays); `SecretMailboxClient.depositEntitlement`. Test
  `testUnlockApproval_alsoDepositsEntitlementForBoxStk` (carrier verifies under the
  phone IRK). `xcodebuild` **TEST SUCCEEDED**.
- **Android** — same wiring in `core/SecretRequestCoordinator.kt` +
  `api/SecretMailboxClient.depositEntitlement`. `:app:testDebugUnitTest` **BUILD
  SUCCESSFUL**.
- **webapp** — `bootApproval.js` `depositEntitlement` + `buildEntitlementCarrier`
  (ported from the daemon/protocol), wired into `approveUnlock` (best-effort).
  Test: the carrier verifies under `@flagship/protocol` `verifyRootEntitlement`
  (byte-identical canonical). webapp vitest green.

Copy: unlock label is now *"Unlock device and authorize it to join your cloud"* on
all three (deposit happens on every unlock approval; harmless on reboots). The
first-boot-only *"Unlock device"* / established-reboot split is a deferred
refinement (needs the per-pod liveness signal threaded into the approval screen).
Mobile shows it after an Xcode/Gradle rebuild; webapp + backend are live.

### 2026-06-20 — onboarding hardening: pairing-TTL + daemon entitlement self-heal + awaiting-entitlement signal

Follow-ons to the burner self-sign fix below, all on `main` (built in an isolated
worktree to avoid colliding with concurrent agents):

- **Create-time pairing deposit TTL 5 min → 14 days** (`secretMailbox.ts`
  `DEFAULT_PAIRING_DEPOSIT_TTL`, used only by `handlePostPairingDeposit`). The
  deposit is written at recipe-mint and only CLAIMED at first boot (minutes-to-
  days later); the 5-min mailbox TTL (kept for live secret-request round-trips)
  meant it expired before real hardware ever booted, so create-time auto-pairing
  silently no-op'd (frank's expired ~10 min before it even registered).
- **Daemon entitlement self-heal** (`index.ts loadEntitlementsOrExit`): an on-disk
  bundle is now locally verified against the owner IRK (`verifyRootEntitlement` vs
  `cfg.irkPublicKey` — the SAME check the hub runs at HELLO). If it fails (a
  self-signed/stale bundle), the daemon DISCARDS it and falls through to the phone
  relay instead of crash-looping forever — so a wedged box recovers itself with no
  shell access (a production box has none). cfg-absent (demo/gym) keeps legacy
  present-as-is behavior.
- **`awaitingEntitlement` on `/pods`** (`podInventory.ts`, mirrors `awaitingUnlock`):
  a box that has posted its entitlement secret-request reads "waiting for approval"
  (authorize it to serve your account), not "Never came online". Backend signal +
  webapp can consume immediately; mobile copy needs an app rebuild to show.

Gates: `tsc -b` clean · control-plane vitest 70 (secretMailbox/podInventory/demo) ·
daemon entitlement/relay 19. The TTL fix needs a `.com` deploy to take effect for
the NEXT create-server; the daemon + signal ship via the box's first-boot clone.

### 2026-06-20 — ⭐ real boxes never came online: burner self-signed entitlement, hub now rejects it; FIXED

**Root cause: a skipped cutover.** Commit `5b46fb9e` (2026-06-16) turned on
hub-side IRK-signature enforcement (`irkLookup`, fail-closed on
`surface=services`) — the right security fix. But the burner
(`packages/flagship-burner/src/userdata.ts` + the Swift twin
`apps/burner-mac/.../UserData.swift`) still minted a **self-signed**
RootEntitlement (signed by the box's OWN identity key, not the owner IRK). The
burner's own comment had warned this MUST be cut over *before* irkLookup goes
live; it wasn't. So every real phone-created box's tunnel HELLO is now rejected
(`"rootEntitlement signature failed verification"`) → tunnel never registers →
the canonical `:443` URL resets (ERR_EMPTY_RESPONSE) → no ACME cert, no
heartbeat → phone shows **"Never came online."** Diagnosed live on
`frank.harry.flagship.services`: registered + DNS-published, daemon reached
`provision_status=pairing`, then silent (no `live`/`error`, `daemon_status`
empty, `:443` SSL reset); `flyctl ips` confirmed DNS → the Fly dedicated
passthrough IP, so the only missing layer was tunnel registration.

**Fix (burner only, all on `main`): stop self-signing.** The burner now writes
NO `entitlements.json`; the daemon's existing first-boot relay
(`server-daemon/src/entitlementRelay.ts`, fires `if (!loaded && cfg)`) requests
an **IRK-signed** RootEntitlement from the owner's phone via `.com`'s blind
mailbox (purpose `entitlement`; responders already exist on iOS/Android +
control-plane), and the phone signs one for THIS box's STK. `cfg` (owner IRK) is
derived from `/var/flagship/install-blob.json` even without `FLAGSHIP_CONFIG`, so
the relay always has what it needs. Demo (`demoUsersAdminCloudInit.ts`) + gym
(`gymProvision.ts`) paths are UNTOUCHED — they legitimately self-mint with a
real/demo IRK that the hub accepts. TS↔Swift bootstrap kept byte-identical
(re-pinned sha: wired `1540d942…`, Debian `555dd7b1…`).

Gates: TS burner vitest **186** · `tsc -b` clean · Swift `EngineTests` all pass
(incl. both byte-identical bootstrap pins) · demo/gym self-mint tests **27**
still green. **Existing self-signed boxes (e.g. frank) self-heal by removing
`/var/flagship/entitlements.json` + restarting the daemon (`Restart=on-failure`
re-fires the relay) → approve the entitlement on the phone.** Follow-up found
(not yet fixed): the create-time **pairing** deposit TTL is ~5 min, far shorter
than a real box's boot-to-daemon time (frank's expired ~10 min before it
registered) — auto-pairing silently no-ops on real hardware.

### 2026-06-20 — iOS sign-out didn't erase the account key (security) + deletion/reclaim design

**⭐ SECURITY (iOS) — sign-out left the account key behind; FIXED (`34ce141f`).**
Repro: sign out on the lock screen → delete the app → reinstall → still Face-ID-
unlocks to the (even prod-deleted) account. Root cause: the wrapped UMK / ephemeral
/ sim-wrap key are written **iCloud-synchronizable** (`.cloudRoot`,
`kSecAttrSynchronizable=true`) and reads use `SynchronizableAny`, but the DELETE
paths (`Keystore.keychainDelete` + the `wipeAllProfiles` class-sweep) had **no
Synchronizable filter** — and `SecItemDelete` without it matches only NON-synced
items. So the synced UMK was never erased by sign-out, survived app reinstall, and
restored from iCloud Keychain. Fix: add `kSecAttrSynchronizableAny` to both delete
queries. iOS `xcodebuild test` **1172/0**. (Client-side — owner must rebuild the
app; a device/sim with a pre-fix stranded key clears on the next post-fix sign-out
or a sim "Erase All Content".) Note: Android wipes app data on uninstall, so this
is iOS-specific; webapp tier-1 is the PIN path.

**Owner-directed follow-ons (DESIGN FIRST — see `docs/account-deletion-and-name-reclaim.md`):**
a **no-backup deletion ceremony** (Sign out / Remove device with no recovery + no
other device → popup → full-page irreversible warning [name loss, servers stop —
transfer first] → confirm = remove-device + kill account) and a **GC** that frees
usernames with no registered device (name becomes claimable again). Both await
owner decisions (grace windows, abandoned-reclaim y/n, transfer-away flow, orphaned
-box handling — §5 of the doc). Backend facts: usernames have only `claimed_at`
(no `last_active`, no recycling); a deleted account's `/api/users/:u/pods` returns
`200 {pods:[]}` (no "account gone" signal); user DATA lives on the box, `.com`
holds only identity/routing/recovery records.

### 2026-06-20 — prod deploy + wipe for an e2e + a CRITICAL migration-drift fix

**Pre-e2e ops:** deployed `.com` (Worker `eab7d68d`, carries the gym-caught webapp
white-screen fix) + `.services` (Fly, immediate) + wiped prod D1 clean
(`scripts/wipe-all-users.sh`, 45 tables). Rebuilt + re-signed (IBIS LLC Dev ID) +
reinstalled the Mac burner to `/Applications` (no burner source changes — fresh
binary of the same logic).

**⭐ CRITICAL — account creation was 500ing in prod (migration drift), fixed.**
"Open account" on iOS showed *"Service temporarily unavailable"* (the iOS
`ScreensClient.plainLanguage` 5xx copy). Root cause: the Worker deploy shipped
current `main`, but **prod D1 was 6 migrations behind** — the deployed
`handleUsernameClaim` `INSERT` references `usernames.aid_pub_hex` (added by
**0057**), absent in prod ⇒ every claim threw ⇒ Cloudflare **1101** ⇒ 500.
Verified live (`POST /api/username/claim` valid-shaped body → 500; `pragma_table_info`
→ no `aid_pub_hex`; audit → prod had 0051 but was missing **0052–0057**). **Fix:
applied 0052_vouchers · 0053_stripe_events · 0054_app_purchases · 0055_trust_exceptions
· 0056_service_invites · 0057_service_invites_v2 to prod in order** (all additive,
none pre-existed). Re-probed with a REAL signed claim (`deriveIRK(generateUMK())`
+ `signClaimUsername`) → **200 `{ok:true}`**; deleted the probe row (usernames back
to 0). **Lesson: a Worker deploy bundles built `dist/` that can run AHEAD of the
prod D1 schema — always audit + apply pending migrations as part of a deploy.**

**⭐⭐ SECURITY — low-order public-key acceptance (Ed25519), FIXED + deployed
(`f3f9778f`).** While hardening the above, the zero-key probe revealed something
worse than the suspected throw: the **all-zero public key + zero signature
VERIFIED as valid** (it created a username) — the classic Ed25519 low-order-key
forgery. Any envelope whose verifier pubkey comes from untrusted input (a username
claim IRK, a redeem AID, …) could be satisfied by the zero key ⇒ **anyone could
squat any username / forge a "valid" signature for a key nobody controls.** Fix at
the single `ed` chokepoint (`packages/protocol/src/edSync.ts`): a Proxy swaps
`ed.verify` for a hardened version that rejects the **libsodium small-order +
non-canonical blocklist** (incl. 0x00…00) and never throws on malformed input —
**covering all ~104 `ed.verify` call sites at once** (subsumes the try/catch the
earlier note called for). Pinned by `edLowOrderReject.test.ts` (zero key → false;
malformed → false-not-throw; legit key → true). Verified live post-deploy: zero-key
claim → **403**, valid signed claim → **200**. Full `vitest` green (the chokepoint
is used everywhere). No call-site or canonical-bytes change ⇒ no signature break.

**OPS-2 ENFORCEMENT — deploy-time migration-drift gate added (so the drift above
can't recur).** The `schema_version` ledger + `/api/admin/schema-status` existed
but the ledger was **empty** and nothing gated the deploy. Now: (1) reconciled the
prod ledger (stamped 0001–0057, all applied to live prod); (2) `scripts/check-prod-migrations.mjs`
diffs the repo's migration files vs the prod ledger and **refuses the deploy** on
drift (degrades to a warning when prod is unreachable); (3) wired into
`scripts/predeploy-com.sh`, **opt-in via `FLAGSHIP_CHECK_PROD_MIGRATIONS=1`** which
the `apps/com` `predeploy` npm script sets (so the predeploy unit tests — which run
on a wrangler-authed dev box — never query prod). Bypass: `FLAGSHIP_SKIP_MIGRATION_CHECK=1`.
Proven: gate exit-1'd on the empty ledger, exit-0'd after reconcile, and ran live
in the `f3f9778f` deploy (`✓ prod ledger in sync (57 migrations)`).

### 2026-06-20 — 3 parity branches integrated + a gym-caught webapp white-screen fixed

**Integrated three `claude/*` parity branches** (each: verified the gap still
existed on `main` → cherry-picked the fix onto current `main` → tested → improved
+ brought ALL THREE surfaces to parity → re-tested → merged → deleted the branch).
Note: the branches forked off `708ad863` (pre-pairing), so a naive merge would
have reverted create-time pairing — cherry-picked their additive commits instead.

- **Add-server provision-vs-pair chooser** — webapp branch integrated; **iOS
  brought to parity** (the `AddServerChooserScreen` was a dead screen wired
  nowhere; `HomeRoute.addServer` now shows it → `.provisionServer` vs. a pair
  guidance toast; XCUITest + gym scenario tap through the chooser). Android
  already had it.
- **Post-recovery keep/replace/wipe choice (L4)** — webapp branch integrated;
  mirrors iOS/Android (wipe dimmed "Coming soon", same as iOS's
  `wipeAndRestartEnabled:false`). Mobile already had it.
- **Multi-pod `PodSwitcher`** — Android branch integrated **and the webapp added**
  (`lib/podSwitcher.js` + Services-list render, mirroring iOS's >1-pod rule), so
  all three match iOS.

**⭐ The gym also caught a real pre-existing webapp white-screen on `main`** (fixed
`45b0694c`, pushed): `app.js` imported `enterVibeCodeChat` TWICE → a parse-time
SyntaxError halted all app JS → blank webapp. Unit tests load modules
individually so never hit the full boot graph; a headless boot probe pinned it
(`Identifier 'enterVibeCodeChat' has already been declared`). The live webapp was
white-screening until this push.

Gates: `tsc -b` clean · webapp vitest **1454/1455** (the 1 "fail" = a load-induced
argon2id timeout in the untouched `keyfile.test.ts`; passes 12/12 in isolation) ·
clean web gym **90/90** · iOS **TEST BUILD SUCCEEDED** + AddServerChooser **2/2** ·
Android `:app:testDebugUnitTest` (PodSwitcher) BUILD SUCCESSFUL · webapp boot
probe zero errors. All on `main`. Parity-follow-ups section updated (3 closed).

### 2026-06-19 — ⭐ CREATE-TIME PAIRING: the creating device comes online ALREADY paired (no manual tap)

**The "Pair this server" tap is gone for the creating device, on all 3 clients.**
Live hand-testing surfaced it: a freshly-online box showed "isn't paired with this
device yet" and the manual pair button 404'd. Root insight (owner's): the recipe
ALREADY carries crypto material to the box, so the phone can **pre-register** the
pairing with `.com` at create-time and the box claims it on first boot — each side
does its half with no manual step, and the "waiting" state survives a phone
refresh (the link lives in `.com`). Chose the **at-create deposit of a RANDOM,
revocable token** (NOT a deterministic-derived key — confirmed with the owner),
sealed so `.com` stays content-blind.

**Key constraint that shaped the design:** the box generates its OWN identity key
only at first boot (`gen-identity`), so the phone can't seal to it at create. So
the phone mints a fresh **PAIRING keypair**, seals an owner-IRK-signed
`add-paired-session` order FOR its pub, **deposits** the sealed blob to `.com`
(content-blind, IRK mailbox-auth), and **embeds the pairing key's PRIVATE half in
the recipe** as an UNSIGNED sibling `pairingKeyPrivHex`. The booting daemon reads
it, opens the deposit, verifies the owner-IRK signature, and adds the session.

- **Backend (already on `main`):** `POST/GET /api/server/:d/pairing-deposit`
  (control-plane `secretMailbox.ts`) — create-time POST is IRK-mailbox-auth +
  namespace-checked (no box identity exists yet; the seal is the binding); the box
  does a public, consume-once GET. Reuses `secret_mailbox` with a `purpose:"pairing"`
  lane (no new table/migration).
- **Daemon (`index.ts`):** `consumePendingPairing` now opens the deposit by trying
  the **recipe pairing key first, then the box identity** (`pairingKeyFromInstallBlob`
  reads `pairingKeyPrivHex` from `/var/flagship/install-blob.json`); best-effort +
  non-fatal (manual pairing stays the fallback).
- **Recipe plumbing (zero canonical-bytes risk):** `pairingKeyPrivHex` is an
  UNSIGNED top-level recipe sibling — `packages/protocol/installBlob.ts` is
  **untouched**, so existing recipe signatures + the burner sha-pins are
  byte-identical (absent ⇒ unchanged). TS burner threads it (`loadBlob` →
  `installBlobToJson` → on-disk JSON); the Mac (Swift) burner needed a **one-line**
  `normalizeEnvelope` change (it embeds the recipe verbatim).
- **Clients:** the creating device builds + deposits at mint time (reusing the
  single create-server biometric — no extra Face ID) and **persists the token** as
  its session token, so the BFF authenticates the moment the box claims the deposit.
  iOS `CreateTimePairing` (FlagshipCore) + `SecretMailboxClient.depositPairing`;
  Android `CreateTimePairing.kt` + the same mailbox method (Android had NO
  paired-session primitive before — this also gives it its first working BFF
  session, via a new `LocalSessionStore`); webapp `depositCreateTimePairing`
  (bootApproval.js) wired into `mintInstallBlobBundle`. All seal-round-trips are
  pinned by tests (open with the pairing seed → owner-IRK verify, mirroring the
  daemon).

Gates: `tsc -b` clean · burner/daemon/control-plane vitest **1708** · webapp
crypto+view **56** · iOS **TEST BUILD SUCCEEDED** + CreateServer/BootUnlock **14**
+ shared `CreateTimePairing` **2** · Android `:app:testDebugUnitTest` BUILD
SUCCESSFUL (+ CreateTimePairing) · Swift burner **116** + new recipe-sibling test.
**Known follow-up:** the phone's session token is a single-active slot (pre-existing
iOS/Android limitation) — a 2nd paired pod still needs a per-pod token store; a real
`UIDevice.current.name`/Android model name for the session label (defaults
"iPhone"/"Android"); the `/boot/install-blob.json` copy carries the pairing key in
plaintext until first-boot consume (minor, time-bounded, USB-in-hand; consume-once
makes it inert after).

### 2026-06-19 — apps default to LIVE + two headline gym callables (`gym:locked` / `gym:total`)

**Pre-hand-testing ergonomics, owner-directed, on `main`.** Two changes so the
owner can hand-test against real boxes with one command each:

- **The apps default to the LIVE client in EVERY build** (was: Debug→mock,
  Release→live). iOS `DeveloperSettings.releaseDefaultUseLive` is now `true`
  unconditionally; Android `getBoolean(KEY_LIVE, true)`. The mock/demo client is
  now opt-in via the existing 3-tap Developer toggle (`flagship.dev.useLiveClient`),
  and a persisted flip still wins across launches (a tester who taps to mock stays
  on mock). Webapp was already always-live (no toggle). The iOS
  `DeveloperSettingsTests` contract was updated to pin "live in every build".
- **Two one-line callables** (the owner's framing):
  - **`npm run gym:locked`** — FAST, no cloud. `gym total --mock-only`: the full
    deterministic frontend matrix (web 45 · iOS/iPad 36 · Android 15), NO backend,
    NO env probe. New `--mock-only` CLI flag drops the live slice entirely. The
    "have we tested all frontend features" gate.
  - **`npm run gym:total`** — OVERNIGHT, real cloud. New `scripts/gym-total.sh`:
    runs the locked matrix, THEN (if `.gym-secrets.env` has `GYM_ADMIN_SECRET`)
    provisions REAL gym Hetzner boxes and drives `tools/live-e2e/run.ts` (full
    backend chain) + `tools/live-e2e/gating-drive.ts` (service-access gating),
    each self-tearing-down its box (no leaked billing on an unattended run).
    Degrades cleanly to the matrix-only when no secrets are present, so it's safe
    anywhere. Verdict = AND of every phase that ran.

  `gym:every-merge` + `gym:live` stay as the lower-level building blocks.

Gates: `npx tsc -b` clean · gym harness vitest **60** · `gym:locked` web leg
**45/45** with **0** `[LIVE]` lines (proves `--mock-only` skips the cloud slice) ·
iOS `xcodebuild test` **1145 tests / 0 failures** (incl. the DeveloperSettings
contract) · Android `:app:assembleDebug` + `:app:testDebugUnitTest` BUILD
SUCCESSFUL. **Owner-side:** the iOS/Android binaries are freshly built; for a
device install, do the usual Xcode Archive (iOS) — the Debug APK is at
`apps/mobile/android/app/build/outputs/apk/debug/`.

### 2026-06-18 — ⭐⭐ FULL-PLATFORM gym boxes: ServicePlatform + paired session + build, PROVEN

**The gym can now test real app-platform features against real boxes** — services
/ build / vibe / git / mcp, not just cert+serve. `npm run live-e2e` against a
full-platform box is **12/12 OK** (pushed; `tsc -b` clean):
`✓ ServicePlatform constructed (/api/services 200, not 503) · ✓ paired session
minted (add-paired-session order, demo-delegated-key signed) · ✓ git-import ran a
real clone + Flagship-fitness verdict over the paired session`, on top of the
lifecycle/TLS/cert/journal checks.

**⭐ Root-cause bug found + fixed (affected EVERY box):** `startDaemonRuntime`
never passed `host{username,irkPub}+swk` to its `servicePlatform` opts, so the
runtime gate (`runtime.ts:1013`) was always false → ServicePlatform was `null`
everywhere → `/api/services` 503 and the entire build/deploy/screens/vibe surface
(mounted only under `if (runtime.servicePlatform)`) never wired. Fixed in
`index.ts` (prod-preserving: only activates with a config + SWK).

**Full-platform demo box (cloud-init):** mints the SWK (nothing else did — it was
meant to be phone-provisioned), sets `FLAGSHIP_PSK_PUB_HEX` (= the demo delegated
pub, so `/api/orders-from-user` accepts an `add-paired-session` order a test signs
via `deriveDemoDelegatedKey`), installs docker (on its OWN apt line — `docker-cli`
is NOT a Debian pkg and aborted the whole apt → killed git/jq/xxd → bootstrap
death; that cost a provision), and enables the `flagship-data-services` stack. Use
`--size cpx31` (the data stack won't fit cpx11). Daemon fix + cloud-init both
prod-preserving; cost: full boxes bill more (~cpx31) — torn down after each run.

**Remaining feature matrix (builds on this foundation, incremental e2e each):**
vibe-code with a BYOK key (the LLM build — `GYM_AI_API_KEY` is available), MCP
IDE connect, marketplace/scratch service INSTALL (owner-IRK `/api/services` — needs
a manifest + docker to actually run), manage service (env/uninstall), server
delete, and expired-mandate handling (.com `pubkey-cert` 403 needs an in-process
injected `now`; relay-trust is daemon lockdown state). The auth map + shapes are
in this session's notes; the paired-session + owner-IRK seams are both proven.

### 2026-06-18 — ⭐ REAL-SERVER e2e suites (backend + frontend) built, run, GREEN

**The gym's mocked Tier-1 had NO test that drove an actual server. Built two live
suites that provision/drive REAL gym boxes + the real backend, ran them, and
fixed every gap they surfaced** (all on `main`, pushed; `npx vitest run` **5666
pass**, `tsc -b` clean):

- **Backend live e2e — `tools/live-e2e/run.ts` (`npm run live-e2e`).** Provisions
  a fresh gym Hetzner box (or `LIVE_E2E_REUSE_USER=` reuses one), then asserts the
  whole chain against it: control-plane health, the box serves browser-trusted
  TLS, the LE cert SANs cover the box apex + per-box wildcard, `/api/services`
  (200 list or 503 when the docker platform is off), `/api/front-page`, the
  control-plane directory shows it ONLINE, and the **owner-IRK-SIGNED** API — it
  derives the deterministic demo owner IRK from `DEMO_IRK_KEK` and POSTs a real
  signed `JournalRequest` (gets daemon log lines back) + asserts a forged sig is
  rejected 403. **Reuse run 9/9, fresh-provision 11/11** (provision → online →
  cert → serve → API → teardown, no lingering box).
  - **Infra fix that unblocked the signed surface:** the demo cloud-init now
    writes `/etc/flagship/config.json` (serverId/userId/bakPublicKey/irkPublicKey,
    all from the install blob — `authCode.userPubKey` is the demo IRK) + sets
    `FLAGSHIP_CONFIG`. Without a config the daemon logged *"FLAGSHIP_CONFIG not
    provided; skipping local HTTP API"* and `wireOwnerHandlers()` short-circuited
    on `cfg===null` → front-page / journal / power / dead-man all 404'd. Fails
    closed (malformed config → no-cfg fallback), never blocks the cert bring-up.
- **Frontend live e2e — `apps/web/e2e/live/` (`npm run live-e2e:web`).** Playwright
  drives the ACTUAL deployed gym webapp (`web.gym.flagshipserver.com`) against the
  ACTUAL gym backend. **2/2 green:** the live webapp serves + boots + resolves its
  apex to the gym host, and it makes a successful real call to the gym control
  plane (`gym.flagshipserver.com/api/maintainer-blessing → 200`). It surfaced +
  fixed **3 real gym-env gaps** (all prod-preserving via `env.CONTROL_APEX`):
  (1) `route.ts WEBAPP_HOST` was hardcoded to prod → the gym webapp host 307'd to
  prod (`webappHost(env)` now apex-aware); (2) the webapp's username CLAIM POSTed
  a RELATIVE `/api/username/claim` → hit the GET/HEAD-only webapp origin → 405
  (fixed `openAccount.js`/`create-server.js` to use `controlApex()`); (3) the
  control plane's CORS allowlist didn't include the gym webapp origin
  (`isCorsAllowed(origin, env)` now allows `web.<CONTROL_APEX>`).

**Open / documented findings (NOT blocking):**
- **gym webapp full account CREATION is trust-gated.** The webapp's trust gate
  verifies the control plane's `maintainer-blessing` against its baked
  `MAINTAINER_PINNED_MANDATE_HASH`; the gym env doesn't yet serve a blessing that
  verifies, so `isServerTrusted` is false and the mutating ops (claim/create) are
  silently blocked (the form renders + the trust call fires, which the test
  asserts). Standing up the gym maintainer-blessing is the follow-on to test
  account creation through the UI.
- **Demo boxes run NO service platform** (no docker/host-IRK) → `/api/services`
  503 + the screens BFF / build-modes surfaces aren't wired. Testing those needs
  the data-services stack enabled on the demo cloud-init (heavier follow-on).
- Boxes bill (~$0.50/day) — the suites teardown what they provision; reused boxes
  (e.g. `gymbox`) need a manual delete. Rotate the pasted test Hetzner token.

### 2026-06-18 — ⭐ LIVE gym Tier-2 box PROVEN online end-to-end (3 real fixes)

**A real gym box now provisions into the `gym.` test env and serves
browser-trusted Let's Encrypt TLS at its gym FQDN — the live Tier-2 slice's
backend is proven, so `gym:total`/`gym:live` can run against a real box, not a
mock.** Validated live: `home.gymbox.gym.flagship.services` → **HTTP 200, TLS
verify=0** (LE cert `issuer=CN=YR2`, valid 90d), serving the daemon's apex page.
Getting there surfaced + fixed **three real bugs** (all on `main`, pushed; `tsc
-b` clean, +4 control-plane tests):

1. **Cloud-init didn't pin the daemon to its provisioning control plane**
   (`demoUsersAdminCloudInit.ts`, `893e0a87`). `daemon.env` wrote only
   `FLAGSHIP_SUBDOMAIN` + `FLAGSHIP_IDENTITY_PRIV_HEX`, so `controlPlaneBaseUrl`
   fell back to the `flagshipserver.com` default — a gym box did hub-discovery,
   ACME DNS-01, and the status heartbeat against PROD even though it *registered*
   against gym (via the already-threaded `registrationUrl`). Now writes
   `FLAGSHIP_CONTROL_PLANE_BASE_URL=$CTRL_BASE` (gym). Prod unaffected (CTRL_BASE
   == the default there).
2. **The gym Fly hub verified box claims against the wrong `.com`**
   (`fly.gym.toml`, `0bf8e7e7`). `server.ts: comBaseUrl = FLAGSHIP_COM_BASE_URL
   ?? flagshipserver.com`, and the gym Fly app never set it → the hub's
   `irkLookup` (fail-closed) hit PROD, where the gym box's user doesn't exist →
   tunnel claim rejected → no HELLO_ACK → `tunnel.ready()` hangs at runtime.ts:849
   → ACME never starts. Set `FLAGSHIP_COM_BASE_URL=https://gym.flagshipserver.com`
   (Fly secret for the live app + durable in `fly.gym.toml` [env]). After this the
   daemon logged `tunnel online … ACME issuance running`.
3. **ACME DNS-01 publish wasn't idempotent** (`cloudflareDns.ts`, `0bf8e7e7`).
   `createTxt` is a plain CF create; a daemon restart / issuance retry that
   re-publishes the same challenge value before the prior record is swept hit CF
   **81058 "An identical record already exists"** and wedged issuance *forever*
   (observed live, attempts 1–5 backing off to 300s). Now treats 81058 as success
   (lists + returns the existing record) — the DNS-01 invariant is only that the
   TXT value is present. **This is a prod bug too**, not gym-only. After deploy:
   `🔒 cert installed … on attempt 1`.

**Also:** scaled the gym Fly app to **1 machine** (durable in `fly.gym.toml`) — a
box tunnels to a single hub machine and the registry is per-machine, so a 2nd
machine made `:443` SNI routing land ~50% on a machine with no route (intermittent
`SSL_ERROR_SYSCALL`). One machine → **6/6 HTTP 200**. HA isn't the point for a
one-box test env.

**Gym infra now fully live + healthy:** control plane `gym.flagshipserver.com/api/health`
200 · data plane `flagship-services-gym.fly.dev:8443/api/health` 200 (1 machine) ·
per-box DNS + ACME DNS-01 publish into `flagship.services` via the gym's own
`CLOUDFLARE_DNS_API_TOKEN`. The gym box-bring-up chain (provision → register →
tunnel→gym-hub → LE cert via gym DNS-01 → serve) is the "iso" the live tests
needed; it's done.

**Open / next:**
- **The live Tier-2 slice itself is an iOS XCUITest** (`FlagshipAppUITests/GymLiveTests`,
  `tools/gym/src/live.ts`) that *creates its own* box through the app under
  `gymdemo` then installs a service. It's gated detect-and-skip on
  `gym.flagshipserver.com/api/health` (now reachable → it will RUN, not skip).
  Running it needs an Xcode build (`-apex-host gym.flagshipserver.com`) + a ~15-min
  real provision; that's the remaining owner-side run. Tier-1 `gym:total` (web
  Playwright + fixtures) runs now with no backend.
- **`gymbox` (Hetzner `142510080`, `167.233.123.181`) is BILLING (~$0.50/day).**
  It was the pre-flight proof; the iOS slice provisions its own. Tear down when
  done: delete via the Hetzner API token, or `node scripts/sample-user.mjs` has no
  delete — use the gym admin/Hetzner API. (Two stale `gymdemo` pending orders +
  any leftover `_acme-challenge` TXT are harmless.)
- **ROTATE the test Hetzner token** (it was pasted into a chat transcript).

### 2026-06-18 — first FULL multi-surface gym e2e run (web·iOS·iPad·android·live) + 3 gym fixes

**Ran the whole gym across all four surfaces on the Mac, in parallel, with the
live `gym.` env reachable.** Results + what it surfaced (commit `821f323a`):
- **web 45/45 PASS** (Playwright→chromium, self-served webapp). Clean.
- **android 15/15** after fixing **2 real test-parity gaps the gym caught** (the
  app was correct, the tests over-/mis-asserted): (1) the D5 lifecycle-pill tests
  (`awaitingUnlockPillOnHome`/`deadServerSurfacesOnHome`) queried the MERGED
  semantics tree, but the pill `testTag` is in `FSListRow`'s `below` slot under
  the row's `combinedClickable` (which merges descendants) → query the UNMERGED
  tree; (2) `onNodeWithTag` (exactly-1) vs the demo `Music` pod ALSO classifying
  DEAD → 2 never-online pills → use `onAllNodesWithTag().onFirst()` (≥1, mirroring
  iOS XCUITest `.exists`). These `androidTotal` rows had only ever been
  compile-gated; first on-device run = first-run calibration (as predicted).
- **iOS 36/36 fixtures PASS** (iPhone + iPad sims; the iPad D8 rows too). The one
  initial red (`ios-total-ai-keys-add-form`) was a **false negative I induced** —
  running android `gradle` builds concurrently with the iOS `xcodebuild` tripped a
  DerivedData DB lock; re-run **alone it passes** (`totalTestCount:1`). Lesson:
  don't run two native builds at once on this 16 GB Mac.
- **⭐ The live slice exposed a gym-correctness bug + a missing harness.** The
  `ios-live-vertical-slice` (the ONLY `backend:live` scenario) was **false-passing
  in 9s with zero screenshots**: `GymLiveTests.swift` **does not exist** (only
  EveryMerge/Smoke/IPad/Total/TotalDetail do), and the iOS adapter computed
  `passed = (xcodebuild exit 0)` with **no 0-test guard** — `xcodebuild` exits 0
  when `-only-testing:` matches nothing, so an absent harness silently went green.
  Fixed the adapter to read the executed count from the `.xcresult`
  (`xcresulttool ... test-results summary` → `totalTestCount`); 0 ⇒ FAIL,
  unreadable ⇒ trust exit code (no false-fail) — mirrors the Android adapter's
  long-standing guard. **Verified: `gym live` now correctly FAILS** the
  unimplemented slice instead of false-passing.

**Net:** web + iOS + iPad + android fixture coverage is GENUINELY green
(45+36+15). The true "with server" e2e on iOS is **NOT actually implemented** —
`GymLiveTests.swift` must be written (the backend it needs is proven: the live
gym box `home.gymbox.gym.flagship.services` serves a real LE-padlock, see the
entry above). Until then `gym:total`/`gym:live` are HONESTLY red on the live slice
(the right state — a declared-but-absent test should fail the gate, not pass it).
Follow-ups: implement `GymLiveTests.swift` (provision-through-app vs. a lighter
launch-live-reach-home smoke — the full 15-min UI provision is fragile for a
gate); the demo `Music` offline pod classifying DEAD/"Never came online" is a
pre-existing cross-platform fixture nuance (no distinct offline liveness state),
worth a product call but not introduced here.

### 2026-06-17 — UI test gym built end-to-end + a real GA parity bug fixed

**The "gym" (automated UI-test harness, `docs/ui-test-gym.md`) is built,
integrated, and one-command-runnable on `main`** — a deterministic gate +
advisory BYOK AI judge, across web (Playwright) · iOS/iPad (XCUITest) · Android
(Compose-UI-Test) · a live `gym.` tier. Built in one run via 4 parallel worktree
workers (web / iOS / Android / AI-quality), each in a disjoint per-surface
registry lane (`tools/gym/src/suites/{web,ios,android,quality}.ts`), all
integrated + gated green.

- **One command, then wait** — the two headline callables (2026-06-19):
  `npm run gym:locked` (FAST, no cloud — the full deterministic frontend matrix,
  all surfaces, `gym total --mock-only`) · `npm run gym:total` (OVERNIGHT — the
  locked matrix THEN real-cloud e2e: provisions real gym boxes + drives
  `tools/live-e2e/run.ts` + `gating-drive.ts`, self-tearing-down; degrades to
  the matrix alone with no `.gym-secrets.env`). Building blocks remain:
  `gym:every-merge` (fast merge gate) · `gym:live` (the live Tier-2 slice;
  detect-and-skips until the env is deployed). Each writes `gym-results/<ts>/`
  (summary.json + summary.txt + screenshots) and exits 0/1 on the DETERMINISTIC
  verdict. `GYM_AI_API_KEY` turns on the advisory screenshot judge (BYOK,
  anthropic-shaped, error-swallowing — NEVER the pass/fail oracle).
- **Coverage now:** web **45** scenarios (D1–D7), iOS/iPad **36** (incl. the iPad
  sidebar/reading-column adaptive checks + 3 D7 token/nav/dead-control gates),
  Android **15** (the net-new `app/src/androidTest/` instrumentation harness + a
  12-screen `testTag` sweep + a real detect-and-skip adapter — runs once an AVD
  exists; the JVM Robolectric suite stays the fast lane). Last integrated gate:
  every-merge **18 pass / 8 android-skip**, verdict OK; whole-tree `tsc -b`
  clean; vitest **430 files / 5631 pass / 28 skip**.
- **⭐ The gym caught + I fixed a real GA blocker (parity):** on iOS the Settings →
  **Account security** row was a DEAD CONTROL — `SettingsTab` never passed
  `onOpenAccountSecurity` and `SettingsRoute` had no `.accountSecurity` case, so
  the TOTP + recovery-code enroll screen was **unreachable from iOS Settings**
  (web + Android both reach it). Fixed: route case + handler +
  `AccountSecurityContainer`; the formerly-skipped gym test is now a passing
  regression guard (`xcodebuild` TEST SUCCEEDED). (Earlier in the run the gym also
  caught a webapp-boot crash — a duplicate `hasPin` import — fixed on `main`.)
- **Live `gym.` tier — turnkey, owner-gated deploy:** `scripts/gym-setup-live-env.sh`
  is one idempotent command (generates test-only secrets, creates D1/R2, patches
  the `wrangler.gym.toml` placeholders, deploys the gym Worker, then the Fly app
  once authed); `docs/runbooks/gym-test-env.md` is the do-it-yourself version.
  **NOT deployed by the agent** — it provisions a public surface on the prod CF
  zone and needs `flyctl auth login` + a test Hetzner token (owner's). wrangler is
  authed; Fly is not.

**Open follow-ups (deferred, not blocking):**
- **Deploy the live tier** (owner): `flyctl auth login` + a test Hetzner token →
  `bash scripts/gym-setup-live-env.sh` → `npm run gym:live` / `gym:total` then
  exercise the real backend (the iOS live vertical slice + the webapp live leg).
- **Android: AVD provisioned + every-merge 8/8 GREEN on-device (`84533f17`).**
  Created the `flagship_gym` AVD (API-35 arm64) and ran the gym's Android leg on
  the emulator. The first real device-run (it had only ever been compile-gated)
  surfaced 4 issues, all fixed: below-fold asserts (→ `assertExists`), nav-settle
  timing (→ a `GymBase.waitUntilExists` helper), the `isUnlocked`-gated ops seed
  (→ `SmokeMode.markUnlocked`, mirroring iOS's deterministic-unlock seam), and a
  **real affordance bug** — the add-server chooser tile's `testTag` sat on the
  inert card, not the clickable CTA, so a tap-by-tag never navigated. Robolectric
  stays the fast per-merge lane; the on-device run needs the AVD booted (runbook).
  The total-gym Android tranche (the extra 7 `androidTotal` rows) may need the
  same first-run calibration when first run on-device.
- **Scenario-model niceties** the workers wished for (non-blocking): a `device?:
  "iphone"|"ipad"` field (vs the `GymIPad` harness substring), plural
  `dimensions`, a `routes`/`seed` block to declare a scenario's backendless seed
  state in the registry, and a "not-hittable" assertion kind.
- **Matrix fill-in** continues incrementally per `docs/ui-test-gym.md` §6 (the
  full ~70×4 is a strong start at web 45 / iOS 36 / Android 15); marketplace gym
  scenarios ship on `feat/marketplace` (branch-gate).
- **Feature branches** (`feat/marketplace`, `feat/retail`) are now behind `main`
  by the gym + apex-threading + this fix; re-rebase when convenient (the gym +
  G1/G2 apex-threading are main-only workspace artifacts/refactors).

### 2026-06-17 — security/ops gap-closures + cross-surface parity build-out

**Large `main` session: closed the agent-doable security/ops gaps from the
full-repo audit, did a UX/refactor pass, and raised Android (and the webapp)
toward iOS parity across the new feature surfaces.** All work is **local on
`main`, NOT yet pushed**; `npx tsc -b` clean and all four surfaces validated
green (see the per-area gates below). A second worker's maintainer-trust feature
landed in parallel (entry below) — at integration its iOS compile breaks were
fixed here too (see "Maintainer-trust").

**Security / ops gap-closures (`main`):**
- **SSRF guard hardened** on both the BYOK provider `baseUrl` and the git-clone
  path — now also blocks **redirect-to-private** and **DNS-resolves-to-private**
  (the residual rebinding hole the audit flagged), not just literal RFC1918/
  loopback/metadata IPs.
- **Push-revoke authenticated** — the device-revoke/push path now requires a
  signed envelope (was a gap alongside the already-fixed push-relay auth); the
  3 clients (webapp/iOS/Android) carry the matching signer (parity).
- **Tunnel-hub `irkLookup` fail-closed** — a missing/failed IRK lookup no longer
  falls open; closes a cross-tenant claim path on the relay.
- **Credential-store path-traversal fix** — the per-session/build `.cred` key is
  sanitized so a crafted session/build id can't escape the store dir.
- **CI gate workflow** added (typecheck + vitest + the canonical-byte freshness
  check below) so a red tree/divergence fails in CI, not just locally.
- **Shared canonical-byte vectors + freshness check** — the cross-platform
  signed-message vectors are now a single shared fixture with a CI check that
  fails if TS/Swift/Kotlin drift (previously pinned per-surface, drift-prone).
- **Storage parity-harness expansion** — broadened the D1↔InMemory harness; it
  **caught one more real D1 divergence** (fixed).
- **Crypto exact-pinning** — tightened loose crypto assertions to exact-match
  pins.
- **Wipe / migration-ledger de-drift** — reconciled the wipe-script table list
  and the migration ledger so they no longer drift from the live schema.
- **Deploy-rollback runbook** added; **ca-lease-status test made deterministic**
  (was time-flaky → CI greenness).

**UX + refactors (`main`):**
- **Truthful recovery-lockout copy** — the lockout/lapse messaging no longer
  overstates what happens; and the **single-device grace 7→3-day migration was
  actually finished**, fixing two real bugs found mid-change: a
  notification-ladder regression (the T+0/+1d/+3d alert cadence had drifted off
  the shortened window) and a `graceModel` rename that hadn't propagated.
- **"Services" terminology unified** across surfaces (the Apps→Services rename
  finished where it had been left half-applied).
- **Static error-humanizer** rolled out (raw `HTTP <code>`/stack strings →
  plain language) — **deterministic string mapping, NO AI** in the path.
- **Control-plane typed-error sweep** — handlers return typed errors instead of
  ad-hoc throws/strings.
- **Daemon `index.ts` decomposed** into focused `wire*()` builders (it had grown
  into one giant boot function); behavior identical.
- **`packages/protocol` `auth.ts` split** into per-domain modules — **canonical
  bytes are byte-identical** (the cross-platform vectors above prove it), so no
  signature break.
- **Marketplace install AI-key flow + scan-grade/Confirm parity** — the install
  surfaces now share the AI-key recall/confirm step and the scan-grade display
  (mobile brought level with the webapp).

**Android → iOS parity build-out (+ a few webapp items) (`main`):**
- **Android server-detail:** inline **boot-unlock Approve card** (was iOS-only),
  **dead-man** persisted state + live countdown, **journal unit picker**, and a
  **real service-detail VM** (real load + env editor + Save/Uninstall, replacing
  the stub).
- **Replace-device finalize screen** (countdown + Complete) + the
  **pending-re-pair banner** — on **iOS and Android** (mobile had lacked the
  webapp's finalize ceremony).
- **Android create-server backup-policy picker**, **Settings real account-type**,
  **AI-keys "Make default"** affordance, neutral Home empty-state copy.
- **Android live vibe-code stream VM** (replaced the static `sampleStream` mock)
  + **chat-screen routing** (consume the `VibeCodeChat` deep-link) + the **ops
  sliver** now feeds from real scratch builds with corrected tap targets.
- **Webapp:** keyfile-import takeover re-pair (the security path), trust-sliver
  lock-gating, vibecode deep-link, toast queue, and the matching smaller items.

**Maintainer-trust (other worker, merged into `main`):** the feature (entry
below) arrived with **iOS compile errors** — a non-exhaustive `HumanError`
switch (the new `controlServerUntrusted`/trust cases) + missing `public` inits
on a couple of the new shared types. Both fixed here; afterwards **`main` and
both feature branches (`feat/marketplace`, `feat/retail`) build green on all
four surfaces**.

**Gates:** `npx tsc -b` clean · `npx vitest run` green (web/daemon/control-
plane/protocol/storage) · iOS xcodebuild XCTests + app build green · Android
`:app:testDebugUnitTest` green. **All local — NOT pushed.** Feature branches were
re-rebased onto refactored `main` and re-validated.

### GA close-out TODO (do NOT do in dev) — dev-mode disablements ("Bucket C")

> **We are still in dev. These are capabilities that are intentionally LEFT
> ENABLED for bring-up and MUST be disabled/removed (and gate-enforced) only
> when going to GA.** This is the single consolidated list — the previously
> scattered mentions in the dated security notes and the Ship/launch list now
> point here. Cross-cutting CI gate (item 4) is what keeps the others from
> silently regressing into a release.
>
> 1. **Guard/disarm the prod-wipe script** (`scripts/wipe-all-users*.sh` /
>    `*.sql`). Today it deletes every user + server in one idempotent command —
>    fine for the pre-release slate, a footgun once we serve real accounts. Add a
>    per-env confirmation token + a prod row-count safety/dry-run + an
>    audit-logged admin-only path, OR remove the blanket script from the
>    deployable surface so no one can nuke prod in one command. Keep its table
>    list in sync with new migrations until then.
> 2. **Remove the `debug` / `flagship` console user** (the burner-installed sudo
>    bring-up backdoor — `flagship` is SSH-key-only; `/etc/issue` warns loudly).
>    Burner change → needs a reburn to take.
> 3. **Remove the burn-time LUKS recovery passphrase**
>    (`flagship-burn-time-luks-rekey-me-immediately`, a kept known constant in
>    `packages/flagship-burner/src/userdata.ts` + the Swift
>    `UserData.swift` mirror) **and re-enable the `luksRemoveKey` guard** (it is
>    deliberately guarded OFF, not deleted, so the slot survives bring-up).
> 4. **Add a CI grep-gate that FAILS a RELEASE build** if the `debug`-user or
>    burn-time-passphrase constants (items 2–3) are present — so a forgotten
>    backdoor can never ship. (The dev/non-release path keeps them.)
> 5. **Remove the demo/dev flips in the burner + apps** — demo-mode and the
>    3-tap live/mock toggle (iOS `DeveloperSettings`/`DemoFixtures` + the
>    Welcome-box 3-tap; the burner's demo path).
> 6. **Fill the `pro.html` payment placeholders** — Monero (XMR) address +
>    mailing address (`apps/web/public/pro.html` carries `[ your Monero
>    address — fill in before publishing ]` / `[ your mailing address … ]`).
>    **Needs the owner's real addresses.** NOTE: `pro.html` lives on
>    **`feat/marketplace`** (the monetization page is extracted there, not on
>    `main`) — fill it on that branch as part of the marketplace launch.
> 7. **Remove the `DEV_LATE_LOG` / W12 debug endpoints** — the unauthenticated
>    late-command log-exfil (`/api/dev/late-log/:label`) + the admin-gated
>    Hetzner rescue/destroy/ISO-upload debug routes in
>    `apps/com/src/controlPlaneRoutes.ts` (all tagged `W12 debug`).

### Parity follow-ups (deferred, beyond polish)

> Cross-surface gaps. **2026-06-20: three closed** by integrating the
> `claude/*` branches (each verified-gap → integrated → improved → all-surface
> parity → tested → merged → branch deleted):
> - ✅ **Webapp "add a server" chooser** (provision vs. pair) — integrated on the
>   webapp; **iOS brought to parity too** (the `AddServerChooserScreen` existed but
>   was a dead screen — `HomeRoute.addServer` now shows it, forking to the new
>   `.provisionServer` route vs. a pair-guidance toast). Android already had it.
> - ✅ **Webapp post-recovery keep/replace/wipe choice (L4)** — integrated; mirrors
>   iOS/Android exactly (keep/replace working, wipe-and-restart dimmed "Coming
>   soon", same as `wipeAndRestartEnabled:false` on iOS).
> - ✅ **Multi-pod `PodSwitcher`** — Android added (from the branch) **and the
>   webapp added** (new `lib/podSwitcher.js` + Services-list render), so all three
>   match iOS's >1-pod switcher.
>
> **2026-06-20 (later): the last three closed** (workers, max-effort — parallel
> read-only mapping → sequential iOS-then-Android implement+build, never two
> native builds at once; all native-only, 4 focused commits, pushed):
> - ✅ **Companion-requests background poll (L8)** — added an **inbox-scoped 10s
>   poll** on iOS (`CompanionRequestsViewModel.startPolling/stopPolling`, wired via
>   `.task`/`.onDisappear`) and Android (mirror, wired via `DisposableEffect`),
>   matching the webapp reference faithfully — `pollPending` (10s, first tick
>   immediate, silent re-ticks, per-tick error-swallow keeping last-good rows).
>   Deliberately **option A, not an always-on app-scope badge poller**: the
>   webapp's `startBadgePoll` exists but has **no callers**, so the inbox-scoped
>   loop IS true parity; the Settings badge stays a one-shot on all three (as the
>   webapp's is). A heavier always-fresh badge poller is a noted follow-up if ever
>   wanted. +4 iOS XCTests, +3 Android unit tests.
> - ✅ **Android `AddControlDevice` order-send wiring** — replaced the no-op with a
>   real signed send: new shared `core/AddPairedSessionOrder` (canonical bytes
>   **byte-identical** to the TS/Swift/webapp vector, pinned by test),
>   `LockPowerClient.pairSession` POSTing the owner-IRK `add-paired-session` order
>   to `<pod>/api/orders-from-user`, new `AddControlDeviceViewModel` (idempotent —
>   no-ops if a session token exists; persists the token only after HTTP 200),
>   mirroring iOS `PodPairViewModel`. Pair-confirm CTA replaces the dead button.
> - ✅ **Add-server chooser "pair an existing box" alignment** — Android's silent
>   no-op now shows a **guidance toast using iOS's exact copy**, and the chooser
>   card body was aligned to iOS ("Open it from Home to pair this device.") so it
>   no longer promises a scan/code flow the toast then denies.
>
> Gates: iOS `xcodebuild test` **1172/0** (xcresult-confirmed, +4) · Android
> `:app:testDebugUnitTest` **BUILD SUCCESSFUL** (independently re-run for the new
> canonical-bytes vector) · native-only (no TS/webapp surface touched, so
> `tsc -b`/webapp vitest unaffected). **The cross-surface parity follow-up list is
> now empty.**

### 2026-06-17 — maintainer-trust enforcement landed (apps + boxes verify the blessing)

**The maintainer→CA blessing is now load-bearing end to end** (spec:
`docs/maintainer-trust-enforcement.md`). Previously the whole `@ibisllc/maintainers`
authority chain existed but nothing at the edges verified it, and the `.com`
lease had lapsed (2026-06-02). All on `main`, green (`tsc -b` clean · vitest
**5520**):
- **Authority re-established + enforced:** a backdated 90d `CaEndorsement`
  (gap-free `2026-06-02`→`2026-08-31`, re-blessing hot key `230ad9ed…`) is
  committed + deployed; `CA_ENDORSEMENT_ENFORCE=true` is live so `.com` refuses
  to sign directory attestations without a live lease. Also fixed the
  `ca-lease-status` expired-sibling false-alarm.
- **`GET /api/maintainer-blessing`** exposes the ca-track mandate chain +
  endorsement bundle so any client verifies `pin → authorizedCaKeys(now) ∋
  servedKey` against its OWN baked `MAINTAINER_PINNED_MANDATE_HASH` (safe even
  if `.com` is rogue). Shared verify primitive ported byte-identically to TS ·
  browser-JS · Swift · Kotlin (one authoritative fixture).
- **App trust gate (webapp · iOS · Android):** `isServerTrusted` halts ALL
  backend calls when unverified; visible non-dismissible **red top sliver** (one
  line per failing cert-hash slug); biometric/PIN-gated override records a
  device-key-signed `TrustException` synced via `.com` (one acceptance per cert,
  fleet-wide).
- **Box↔relay (deploy-safe OBSERVE):** `.services` self-keys + fetches a daily
  `.com` `ServiceBlessing` (`POST /api/services/hub-blessing`) presented on the
  tunnel HELLO_ACK + a hub proof-of-possession; the daemon verifies it and has a
  lockdown + owner-SOS mechanism — all behind **`FLAGSHIP_RELAY_TRUST_ENFORCE`
  (default OFF)**, so the live fleet is never bricked; flip per the rollout doc
  after on-hardware validation.

**Open / follow-ups (this feature):**
- **Ceremony app — DEFERRED (not started):** a native **iOS NFC** app driving
  YubiKey PIV-Ed25519 over Core NFC ISO7816 (PIV AID `A000000308…`) to run
  CA-lease/mandate ceremonies tap-to-sign, with the §10.2 keyless commit-writer
  (spec `docs/maintainer-ca-endorsement.md` §11–12; canonical home = the
  `maintainers` repo). Confirmed feasible on iPhone (needs a YubiKey 5 **NFC**,
  fw ≥ 5.7). The **CLI covers ceremonies meanwhile**, so this is usability/
  successor-onboarding value, sequenced after enforcement.
- **Direct LAN / box-AP channel — FUTURE (not started):** a physical-LAN or
  box-hosted-Wi-Fi path between box and owner-phone when physically close, for a
  fully `.com`-independent channel for trust decisions (SOS / exception grants) +
  local admin. The clean long-term answer to the "forced through `.com`" dilemma.
- **Operational (owner):** deploy `main`; **iOS Xcode build** (the Swift trust
  gate + vector tests are the one unrun gate — Android/webapp/backend green);
  flip `FLAGSHIP_RELAY_TRUST_ENFORCE` on a canary box then fleet-wide after the
  rollout-doc validation; wire `resolveTrustExceptions` (needs a box-side
  IRK-anchored device-roster accessor) + replace the log-only SOS with the real
  `flagship/push-relay/v1` fan-out; re-mint the lease before `2026-08-31`.
- **Static-asset content-hashing — site-ops, surfaced this session (NOT started):**
  flagshipserver.com flashes unstyled for a moment during a Worker deploy.
  *Why:* `apps/web/public` assets use plain names (`/components.css`, `/style.css`)
  served `max-age=0, must-revalidate`, so mid-deploy a transient CSS 404 hits the
  SPA fallback and returns HTML (browser parses HTML as CSS). Self-heals; NOT a
  code regression; and NOT an origin-egress issue (Cloudflare's edge serves these,
  not Fly). *How to fix (deliberate, its own effort — rewrites the same files the
  webapp refactor touches, so the other worker must be paused):* add an asset
  build step that content-hashes filenames (`style.<hash>.css`) + rewrites every
  reference (77+ native-ESM webapp imports + each HTML `<link>`/`<script>` + the
  service-worker precache), then serve hashed files `immutable, max-age=1yr`.
  *Why it helps:* deploys go atomic (old+new coexist as distinct files ⇒ no
  unstyled flash) and caching becomes safely aggressive. *Cheap partial
  mitigation meanwhile:* make the Worker return a real 404 (not the SPA HTML
  fallback) for `.css`/`.js` so a transient miss recovers instead of mis-serving
  HTML. Already anticipated by `apps/com/src/route.ts:746-752`.
- **`maintainers` repo:** a `ca-endorsement --not-before/--issued-at` backdate
  flag was built (used once to mint the gap-free lease) but **intentionally NOT
  merged** — backdating attestations is a hopefully-never tool; it's parked
  unmerged on a branch. The repo's `main` is otherwise untouched.

### 2026-06-15 — `feat/marketplace` brought up to speed + `main` shed marketplace/monetization

**`main` is now clean of ALL marketplace + monetization app code** (commit
`390e92fb`): the build-a-service chooser's "Get from the marketplace" tile and
the "Tier & usage" / "Plan / Subscription" monetization dashboard (the
TierStatus screen/VM/route/settings-row across webapp/iOS/Android + the
`/api/screens/tier-status` daemon proxy + `TierStatusResponse`) were extracted
from every surface. Workspace artifacts stay on `main` (the
`marketplace_listings` migration + the marketplace/monetization design docs).
Branching IS the gate — no flag/gating code on `main`. (`main` gates after the
extraction: vitest **2554** web/daemon · iOS **984** · Android **797** · `tsc
-b` clean.)

**`feat/marketplace` = `main` + the feature, integrated** (4 commits on top of
`main`; `git diff main feat/marketplace` is exactly the marketplace+monetization
delta — mergeable to ship). It had been 220 commits behind (forked 2026-06-06,
pre-build-modes), so it was **rebased onto current `main`**, then:
- tier/usage re-added ON the branch (the inverse of the main extraction — the
  branch carries the full monetization surface);
- the chooser's marketplace tile wired to the LIVE marketplace
  (`AppsRoute.marketplace` / nav `"marketplace"` / `enterMarketplace`) instead
  of main's removed "coming soon" stub (build-modes landed after the branch
  forked, so this was the integration point);
- **the Android marketplace brought to full parity with iOS** — the previously
  Mac-blocked + stubbed piece. Was a UI stub (`sampleListings()`=empty, install
  a TODO); now real browse (`marketplaceBrowse()`) + real IRK-signed install
  (`InstallServiceEnvelope` over byte-identical `installServiceCanonicalBytes`,
  POST `<pod>/api/services`, mirroring `FrontPageViewModel`'s signed-order
  flow). iOS + webapp marketplace were already real.

Branch gates: `npx tsc -b` clean · `npx vitest run` **5276** · iOS **1003**
XCTests + app build · Android **816** unit tests. The marketplace is
**code-complete on the branch**; what remains is OPERATIONAL, not code: run the
security-scanner cron against real listings (Trivy/semgrep/R2 + the E2 live
exercise), seed `marketplace_listings`, and the product call on "Hearth". Not
launched — it ships only when `feat/marketplace` merges. (`feat/retail` still
needs to integrate `main` to pick up build-modes + the ops sliver + this
extraction.)

### 2026-06-15 — global "active operations" sliver (WhatsApp-style) on all surfaces

**New core feature, owner-directed, on `main`.** A teal strip pinned in the top
safe-area that the whole shell slides DOWN to reveal (modelled on WhatsApp's
active-call bar): it shows the most-recent in-progress operation ("deploying
server Home" / "building blog on Home") with a spinner, a `+N` hint for the
rest, hides under the biometric lock, and deep-links to that operation's own
screen on tap.

**One generic primitive — `ActiveOperationsCenter`** (mirrors the
`ToastCenter`/`DeepLinker` app-scope-observable pattern; the sliver reads ONLY
from it), fed by two deliberately different sources:
- **Deploy** ops are DERIVED from the pending-pod list
  (`syncDeployOperations(pods)`) — pods are already global/persistent/polled, so
  a deploying server stays in the sliver across navigation with zero extra
  plumbing.
- **Build** ops are REGISTERED imperatively (`upsertBuild`/`removeBuild`) by the
  in-app build lifecycle — a service build has no global signal today.

`primary` = highest `seq` (most recent); reconciliation is churn-free (a steady
re-sync never reorders/reassigns); namespaced `deploy:`/`build:` ids keep a pod
and a build session from ever colliding. Label shapes are identical everywhere:
`deploying server <X>` / `building <X> on <Y>` / `building <X>`.

- **iOS (reference):** `FlagshipCore/ActiveOperationsCenter.swift` +
  `FlagshipUI/Components/GlobalOperationsBar.swift`, mounted via
  `.safeAreaInset(edge:.top)` on the shell (one mount covers the iPhone TabView
  AND the iPad sidebar); injected in `FlagshipApp`, deploy-synced in
  `ContentView` on every pod-list change, build lifecycle hooked in
  `VibeCodeStreamViewModel` (registers on `.building`, clears on
  deploy/done/error/teardown).
- **Android:** Kotlin/Compose mirror — StateFlow center + `GlobalOperationsBar`
  above `RootShell` in a Column (push-down via `AnimatedVisibility`),
  `LaunchedEffect(pods)` deploy sync; build feeder on `BuildGitViewModel` (the
  vibe-code screen is still a static mock, so git-import is its real imperative
  build-with-deploy lifecycle).
- **Webapp:** pure `lib/activeOperations.js` (the testable half) +
  `lib/operationsBar.js` (fixed teal bar; `--ops-bar-h` pushes the sticky header
  down = the slide); deploy feeder in `views/home.js`, build feeder in
  `views/vibe-code.js` (tap resumes the LIVE session). Deploy tap routes to Home
  (a still-deploying box has no paired session for server-detail) where its
  pending card already renders.

Gates: iOS xcodebuild **995** XCTests (+13) + App build (+ a live-sim screenshot
of the sliver) · Android **805** unit tests (+13, `:app:testDebugUnitTest`) ·
web `npx vitest run` **1197** (+16) + `npx tsc -b` clean. Each surface ships an
`ActiveOperations*` test class (label shapes, churn-free sync, primary ordering,
build lifecycle, deep-link targets, id-collision safety).

**Follow-ups:** build ops persist across tab-switches (TabView keeps the VM
alive) and clear on terminal/back-out, but a build started OUTSIDE the app
(MCP/IDE) or surviving a hard nav-pop needs a server-side "active builds" signal
to surface — the center is generic, so that's a drop-in. Android's build feeder
rides git-import until the live vibe-code stream VM exists; the live LLM provider
+ mobile scratch attachment picker (the pre-existing gaps) also light up richer
build-op labels (real service name) when they land.

### 2026-06-14 — build-a-service multi-mode SHIPPED + folded into `main`

**Merged to `main`** (core feature, owner-directed). The whole multi-mode
"build a service" flow — chooser (scratch / git / mcp / marketplace / journal)
+ the shared build journal + AI-adapt + value-free env-requests + scratch
multimodal chat + **BYOK wired live** + an **AI-key step** on every surface —
is now on `main`. `feat/marketplace` + `feat/retail` must integrate `main` to
pick it up. Design + contract: `docs/build-modes.md`.

**AI-key flow (all surfaces).** The box-AI paths (scratch always; git only
when a non-fit repo needs adapting) show a "provide or confirm your AI key"
step before the model runs; marketplace + MCP skip it (no box model). It
recalls **device-saved keys** as a masked slug (`provider · label · ····1234`,
never the full key), pre-selects the active one (Confirm), and offers "Save on
this device". Storage is device-local + encrypted per surface — webapp
`providers.js` (UMK-wrapped IndexedDB), iOS Keychain (`SavedKeyStore`), Android
`EncryptedSharedPreferences` (`AiKeyStore`) — plus a **Settings → AI keys**
manager (view-slug / add / delete). The chosen `{provider, apiKey, baseUrl?}`
rides the build request as `credential` (sealed transiently per session/build
by the daemon; flagshipserver.com never in the path). One future item: the
**in-house / self-hosted inference server** (LAN `baseUrl` + `baseUrlGuard`
override) — BYOK needs no inference infra.

Final gates at merge: `npx tsc -b` clean · `npx vitest run` **5147 pass / 8
skip / 392 files** · iOS **979** XCTests · Android **789** unit tests + both
build. (Mobile chat *attachment picker* is the one deferred nice-to-have;
webapp has it.)

### 2026-06-14 — BYOK AI wired LIVE on the box

**`LlmHarness` is now complete + the live build paths actually run the
model.** Closed the three gaps that left scratch-chat + git-adapt as tested
seams:
- **Streaming in `LlmHarness`** (`chatStream(credential, request, onEvent)`):
  resolves a `StreamingLLMProvider` from a new `StreamingProviderRegistry`
  (anthropic/openai/google), applies the SSRF `baseUrlGuard`, streams
  `ChatStreamEvent`s; defaults `streamingFetchImpl` to a shared
  `defaultStreamingFetch` (Node fetch) so openai/google work in prod too. Plus
  `chatWithCredential` (non-streaming) for the adapt path. The harness holds
  NO key — it opens a credential per call.
- **Transient sealed BYOK credential store** (`llm/buildCredentialStore.ts`,
  mirrors `serviceEnvStore`): InMemory + File, keyed by session/build, SWK-
  sealed at rest (one `.cred` file, mode-0600), reload-on-boot so an in-flight
  build survives a daemon restart (the owner-endorsed "transient key on the
  box while the phone is locked"). `providerName()` is the only non-secret
  accessor; the value is never logged.
- **Contract:** optional `credential: {provider, apiKey, baseUrl?}` on
  vibe-code start/reply + build git/adapt. Delivered ONCE over the
  paired-session-gated pinned pipe (box terminates TLS), sealed for the
  session/build, **reused on later turns** — never echoed, never logged,
  never journalled (provider NAME at most). **flagshipserver.com is NEVER in
  the credential path.**
- **`index.ts` wiring:** constructs the harness + `FileBuildCredentialStore`,
  the live `startStreaming` thunk (`buildVibeCodeStartStreaming` now resolves
  provider+config per-session from the stored credential), and the live
  `adaptRunner` (+ `adaptCredentialAvailable` → clean 503 ONLY on genuine
  no-credential).
- **Graceful absence:** scratch start returns `200 {needsCredential:true}`
  (session exists, not streaming) → client shows "add an AI key"; adapt → 503
  "AI adapt not configured".

Future item: in-house / self-hosted inference server (LAN `baseUrl` +
`baseUrlGuard` override) — strict public-https guard applies today.

Gates: `npx tsc -b` clean · full `npx vitest run` **5138** pass / 8 skip (391
files; server-daemon+providers slice green incl. new `buildCredentialStore`,
`LlmHarness.chatStream`/`chatWithCredential`, live startStreaming + adapt
tests). iOS/Android untouched (clients are a later worker).

### 2026-06-14 — build-a-service multi-mode (`feat/build-modes`, FEATURE-COMPLETE pending launch)

**New feature branch `feat/build-modes`** — the "build a service" workflow
fans from one model-source pick into a **"how do you want to build it?"**
chooser over four sources, all converging on ONE deploy primitive
(harness-only Forgejo push → docker build → signed install) and ONE shared
**build journal**. Design + wire contract: `docs/build-modes.md`. Key answer
to the design question: **the box never needs an AI key as architecture** —
it's a contract-bounded function surface; the model is only needed by whoever
*authors*. 3 of 5 modes need no box-side model (git-fit, mcp, marketplace);
transient sealed keys for scratch/adapt are deliberate (build continues while
the phone is locked).

**Landed + gated (daemon + webapp):**
- **`buildmodes/` daemon backbone (all tested):** `buildJournal` (append-only
  JSONL, value-free/redacted, restart-safe), `gitImport` (clone + Flagship-
  fitness verdict + `buildAdaptPrompt`), `buildWorkspace` (path-safe file
  tree), `contract` (rules restated for an external agent), `mcpServer` (pure
  JSON-RPC 2.0 MCP — tools express the whole limited surface incl. value-free
  `request_env_var`), `mcpKeyStore` (sealed per-build bearer key, binds an IDE
  to one build), `deployArtifact` (mode-agnostic deploy core), `buildOrchestrator`,
  `buildModesHttp` (`/api/build/*` paired-gated + `/mcp/build/:id` bearer-gated
  Streamable-HTTP). Wired into `index.ts` (guarded on servicePlatform; scratch
  bridged into the same journal).
- **Webapp client:** chooser + git + mcp (URL/key/IDE-config/rotate) + journal
  viewer (`views/build-*.js`); create-service entry repointed to the chooser;
  marketplace tile degrades to "coming soon" until `feat/marketplace` merges.
- **`request_env_var` → owner (value-free):** the orchestrator keeps a per-build
  pending env-request list, fires a value-free `notifyOwner({buildId, name})`
  hook (log-only by default — production swaps in the push relay, mirroring the
  vibe-code W10 hook) + journals an `env-requested` entry; new
  `GET /api/build/sessions/:id/env-requests` returns the deduped list
  (`name/why?/secret?/requestedAt/requestedBy/currentlySet`, NEVER a value);
  the webapp mcp view shows it with a "the IDE never sees the value — set it in
  Configure environment" note.

Gates: `npx tsc -b` clean · daemon+providers+web vitest **2539** (229 files) ·
**iOS 945 XCTests** (+31, xcodebuild green) · **Android 761 unit tests** (+16,
gradle green). Forgejo-push stays harness-only (external actors go through
chat/git/mcp, the harness materializes).

**Multimodal chat for scratch — DONE (server seam + webapp UI).** Provider
layer was already done (`Attachment`/`ChatMessage.attachments` + Anthropic
base64 translation). Now: the vibe session carries attachments
(`pushUserMessage(text, attachments)` / `pushUserReply`), `vibeCodeStartStreaming`
puts them on the `ChatRequest` user message, and `messages()` surfaces them for
a reload; the screens BFF (`/vibe-code/start` + `talkToUser` `/reply`) and the
`/api/llm/sessions` start + `user-reply` paths accept inlined base64
attachments via one shared validator (`llm/vibeCodeAttachments.ts`: **≤6/turn,
image ≤4 MB decoded, text ≤256 KB, common image/* + text**); scratch turns
journal `user-message` (truncated text preview) + `attachment-added` (NAME +
kind + size ONLY, never content/base64) to the shared build journal (buildId =
vibe sessionId, hoisted above the vibe wiring in `index.ts`); the webapp
`views/vibe-code.js` is now a real chat (message list, composer with an
image/text attach picker, removable chips + image thumbnails, FileReader→base64
with the caps mirrored client-side, `/reply` follow-ups, Deploy). NOTE: the
live LLM provider is still NOT constructed in `index.ts` — this is the proven
*seam*; it lights up when that separate wiring lands. Gates: `tsc -b` clean ·
daemon vibe/buildmodes/screens green (+ new `vibeCodeAttachments` +
`screensVibeAttachments`) · web `webappBuildModesView` + new
`webappScratchChatView` · `llm-providers/multimodal` still green.

**Remaining (next):** AI-adapt endpoint for non-fit git repos — DONE (server
+ webapp): `POST /api/build/sessions/:id/adapt` renders the cloned tree via
`buildAdaptPrompt`, runs it through an injected `adaptRunner`, parses the
emit-format output with `VibeCodeStreamParser`, and merges the path-guarded
files into the workspace (manifest required); 503 "AI adapt not configured"
until the daemon's live LLM provider is wired (the pre-existing gap), and the
webapp falls back to from-scratch on a 503.

**iOS + Android — DONE.** Native chooser + git/mcp/journal screens (SwiftUI +
Compose) built to the `docs/build-modes.md` UX spec, with a build-modes API
client whose Mock matches the live wire format (pinned by tests). MCP screen
shows the copyable key + IDE config + the value-free env-requests list; git
screen has the fitness verdict + Install / Build-with-AI (503 → scratch);
journal list + timeline. Scratch tile routes to the existing vibe screen;
marketplace tile degrades to "coming soon".

**Remaining (all gated on one pre-existing dependency):** wire a **live LLM
provider** into the daemon boot path (`index.ts` never constructs one today —
not specific to this feature) — that single change lights up scratch-chat
streaming + git-adapt on all surfaces. Plus two nice-to-haves: the mobile
scratch **attachment picker** (mobile scratch uses the existing vibe screen),
and swapping the value-free `notifyOwner` env-request hook for the real push
relay (it's log-only by default, like the vibe-code W10 hook).
### 2026-06-14 — owner-only journal diagnostics ("View journal") on all surfaces + daemon

**New owner-IRK endpoint `POST /api/journal`** (new primitive) — returns the
trailing lines of an allowlisted systemd unit's journal (`flagship-daemon` /
`flagship-data-services`) for owner diagnostics ("server is online but X isn't
working"). It rides the EXACT security shape as `/api/power`: an IRK-signed
`{request,signature}` envelope verified against the box's config-pinned owner
IRK, served over the box's OWN pinned pipe — `.com` never sees the request or
the logs (no user data leaves the box). Standalone `flagship/journal-read/v1`
envelope (`packages/protocol`, byte-identical across TS/Swift/Kotlin), 5-min
replay window, `unit` allowlist + `lines` clamp on the daemon, `journalctl` via
execFile (no shell). Surfaced as a **"Diagnostics → View journal"** card on the
server-detail screen of all four surfaces: daemon (`journalHttp.ts`), webapp
(`lib/journal.js` + card), iOS (`JournalRequest`/`JournalViewModel`/`JournalCard`,
reusing `LockPowerClient`), Android (mirror). iOS/Android sign behind the
biometric (deriveIRK); the webapp signs with the in-memory UMK. 5 commits.

Gates: `npx tsc -b` clean · vitest green incl. new `journalHttp` (9) +
`webappJournal` (6) + canonical-byte pins on iOS/Android. **iOS (xcodebuild) +
Android (gradle) need a Mac build; the daemon endpoint reaches existing boxes
only via a recipe/daemon rebuild + box update (the card 404s until then).**

### 2026-06-14 — session-action buttons simplified across surfaces + webapp PIN lock

**Settings "leave the app" cluster relabelled + grey-out gating (all
surfaces).** The three tiers are now framed as a lock spectrum: tier-1
**"Lock with Face ID"** (iOS) / **"Lock with biometrics"** (Android), tier-2
**"Lock with passkey"** (was "Sign out" — erases the local key + data, restore
via recovery passkey), tier-3 **"Remove this device from account"**. Subtitles
simplified. Tiers 2+3 are now **greyed-but-tappable until cloud recovery is
enrolled** (demo exempt); a tap-while-greyed shows a toast ("Set up account
recovery to use this.") instead of running the destructive path — this also
closed an inconsistency where the *more* destructive remove-device had *no*
gate while sign-out did. iOS adds a `muted` style to `FSDangerButton` +
`onRecoveryRequired` wired to `ToastCenter`; Android mirrors it (Toast); the
confirm dialogs realigned to "Lock with passkey?". A fail-closed action-layer
backstop now guards remove-from-account too.

**Tier-1 "Lock with PIN code" — webapp only (new primitive).** The browser has
no biometric, so the webapp's tier-1 lock is a numeric PIN (replaces the
dropped biometric button). `lib/pinLock.js`: the UMK is PIN-wrapped in
IndexedDB (argon2id stretch) but the wrap key is bound to a **non-extractable
WebCrypto HMAC "device pepper"** — so a stolen IndexedDB copy can't be
brute-forced offline (guesses must run in-origin, where the **5-try lockout →
wipe-PIN → fall back to passphrase** bites). Threat model is explicitly the
casual "grabbed my unlocked tab", NOT device theft (that's tier-2 + disk
encryption). Flows: "Lock with PIN code" runs first-time setup (new+confirm)
then locks; **"Change PIN"** (visible only when set) requires the current PIN
then new+confirm; **any** full-passphrase unlock CLEARS the PIN (the reset
rule), and `resetDevice()` now clears it too so a tier-2/3 wipe can't leave a
PIN-wrapped copy of the key behind. New views `view-pin-unlock` /
`view-pin-set`; boot routes to the PIN screen when a PIN is set.

Gates: `npx tsc -b` clean · web vitest 1142 pass + new `webappPinLock` (crypto
roundtrip, lockout-wipe, device-pepper binding, reset-rule) + updated
`uxCopyFindings`/`webappSessionTiers`. **iOS (xcodebuild) + Android (gradle)
still need a build on the Mac** — this session was Linux, so only the TS/web
gates ran. The relabel/grey-out touch no copy-pinned mobile tests.

### 2026-06-12 — owner-assignable apex ("Front page") shipped on all surfaces + console banner fixed

**Front page (owner-assignable apex) — full slice, all surfaces.** The box
apex now 302s (no-store, never 301) to an installed service's tier-1
canonical, or serves the default Flagship card when unassigned. Design
rationale (from the apex discussion): REDIRECT, not serve-in-place — one
origin per app (no split cookie jars / zombie service workers on reassign),
and the URL bar lands on the pinned trust tier.
- **Protocol:** new `set-front-page` PhoneOrder
  (`flagship/order/set-front-page/v1|<serverId>|<label>|<issuedAt>`, "" =
  clear) + cross-platform pinned vector (`bc57770c…`, asserted by TS, webapp,
  Swift, Kotlin).
- **Daemon:** `frontPage.ts` — persisted `FrontPageStore`
  (/var/flagship/front-page.json), `GET/POST /api/front-page` (POST is the
  owner-IRK envelope path, same as `/api/power`; 422 on uninstalled label),
  the 302 itself (GET/HEAD on "/", APEX HOST ONLY — LAN IPs + /api/* are
  untouchable by construction), fallback to the default card when the
  assigned service disappears.
- **Clients:** "Front page" picker on server-detail — webapp
  (lib/frontPage.js + section), iOS (FrontPageCard + FrontPageViewModel +
  SetFrontPageOrder/FrontPageClient in shared, env-injected, pinned session),
  Android (FrontPageCard + FrontPageViewModel + core/api mirrors). Options
  come from the pod's unauthenticated `GET /api/services`; a stale assigned
  label shows "(no longer installed)" so the owner can clear it.

**Console banner fixed + subtitle (`a8666b51`).** The /etc/issue art was
block-Unicode + em-dashes; Debian's console font (Lat15) has no such glyphs →
rows of "?" boxes on metal (owner photo). Now pure ASCII + a bright-cyan
"Get yours at flagshipserver.com" line via a printf'd literal ESC (the VT
palette has no true teal). Test pins the banner to ASCII. Burner needs the
usual rebuild+sign+install to carry it (done this session).

Gates: vitest (protocol 507 · daemon 1221 · burner 185 · web 1135) · iOS 917
· Android 734 · `tsc -b` clean. NOTE: Android tests need
`JAVA_HOME=/opt/homebrew/opt/openjdk@17` on this machine (no system Java);
iOS tests run via `xcodebuild test -scheme FlagshipMobile-Package
-destination 'platform=iOS Simulator,id=<sim>,arch=arm64'` (plain `swift
test` fails on UIKit).

### 2026-06-12 (later) — ⭐ PHONE-APPROVAL UNLOCK E2E PROVEN ON METAL + mapper-name root cause

**MILESTONE: the full phone-approval LUKS chain is validated end-to-end on real
hardware.** az2.harry: burn → phone lease granted → box-sealed lease
self-unlock → (after the in-place mapper-name patch below) clean cryptroot
handoff → daemon up → Let's Encrypt per-box cert minted (issuer YR2, 20:01 UTC)
→ `https://az2.harry.flagship.services/` HTTP 200 with a verifying chain.
The 3×Enter + console-patch recovery worked exactly as designed.

**Box apex page shipped (brand v2).** The daemon's unassigned-apex landing
(`defaultApexPage`, runtime.ts) replaced the dev hello page: tokens.css
palette + the square/ring/core mark (breathing core = liveness), FQDN
rendered server-side, "This is a Flagship server… choose what appears here
from the Flagship app." Fully SELF-CONTAINED by design — no remote fonts/
assets, so a box never leaks its visitors to .com (pinned by test); noindex
(hostnames are CT-public). **Design decisions from the apex discussion:** no
in-page attestation ceremonies (self-attestation can't bootstrap trust —
TLS + phone pinning are the real mechanism), no box stats on a public page
(CT logs make every box apex discoverable). **Follow-up (product): make the
apex owner-assignable to one of the box's apps** (the page copy already
promises it); maybe a "verify this server" QR deep-linking into the app
(phone = verifier), explicitly attesting box health only — not the
browser's channel.

**🐛 NEW (track): the 5-minutely STK-signed daemon-status heartbeat is NOT
landing** — 60+ min after cert mint, `/pods` shows
`lastReported/signedStatus/currentCert` all null for az2 (and az). The box
serves fine; impact is phone-side cert PINNING (no pin installs without
`signedStatus`) + liveness detail. Next probe (console, `debug` user):
`journalctl -u flagship-daemon --no-pager | grep -i -E 'daemon-status|heartbeat|report'`
— then check the `.com` ingest path (handler auth? D1 write?).

The az2 live run got further than ever (burn ok, phone lease granted, box
self-unlocked from the box-sealed lease, VG activated) then hung forever at
Debian's "Please unlock disk sda4_crypt:" prompt → app showed "Never came
online". **ROOT CAUSE: the initramfs premount opened the LUKS container as
`flagship_root`, but Debian's `local-top/cryptroot` skips an already-active
target ONLY under its crypttab name (`sda4_crypt`)** — so cryptroot prompted
against an in-use device (unanswerable: cryptsetup refuses a busy source).
Every earlier encrypted e2e used the `manual` keyword, where cryptroot itself
opens the device — the premount-succeeds handoff had never run on metal.
**Fix (burner-only, committed): the Debian premount reads the target name from
`/cryptroot/crypttab` and opens under THAT (fallback `flagship_root`)**;
cryptroot then skips (verified against trixie cryptsetup 2:2.7.5-2 source:
`setup_mapping()` returns 0 if `dm_blkdevname "$CRYPTTAB_NAME"` exists; its
`prereqs()` lists every other local-top script, so the premount-first ordering
is guaranteed, not luck). New cross-language sha pin for the encrypted DEBIAN
bootstrap (`21cfa21b`, TS + Swift; the old `ba0f4fcc` pin covers the Ubuntu
literal and is unchanged). Burner rebuilt + re-signed + installed.
**az2 recovery without a reburn:** at the prompt press Enter 3× (cryptroot
gives up + exits; root LV is already active so boot continues; ignore/Enter
through the full-OS sda4_crypt passphrase prompt — it times out harmless),
log in as `debug` on the console, then
`sudo sed -i 's/"$ROOT_LUKS_PART" flagship_root/"$ROOT_LUKS_PART" sda4_crypt/' /etc/initramfs-tools/scripts/local-top/flagship-unlock && sudo update-initramfs -u`
and reboot — the box should then self-unlock AND come online (validates the
whole phone-approval chain). UI polish for the phone approval flow noted as a
follow-up (owner request).

### 2026-06-12 — phone-approval unlock debugged to root cause + boot merge live

Long live-hardware session driving the FIRST end-to-end **phone-approval LUKS
unlock** (every prior unlock used the `manual` keyword, so this path was never
exercised). Box `az.harry` (10.10.3.142) reached green padlock but the
phone-approval flow surfaced a chain of real bugs, now all fixed + pushed +
deployed (Worker `b23e0e3d`; com/boot/services all 200):

- **⭐ ROOT-CAUSE: the box sealed its disk key to the discarded delegated key
  (`eadd7195`, burner — needs re-burn to take).** The bootstrap sealed the LUKS
  key to the blob's `phoneDelegatedPubKey`, but the phone generates that
  per-server keypair at create-time and DISCARDS the private half — so the disk
  key was sealed to a key NO phone could reproduce (error: "couldn't unseal the
  disk key with this phone's keys"). Fix: seal to the account **IRK**
  (`authCode.userPubKey`, already in the blob) — phone re-derives it via
  `deriveIRK` and it survives cloud recovery. Burner-only (userdata.ts + Swift
  mirror, sha re-pinned ba0f4fcc); **burner rebuilt+signed+installed**. This is
  the "owner-IRK path" the pre-existing-bug note called for. EXISTING boxes
  sealed to the dead key can't be unlocked → re-burn (or SSH re-seal a live box).
- **Boot-worker consolidation CUT OVER (live).** `boot.flagshipserver.com` is now
  a Custom Domain on `flagship-com` (served from `@flagship/boot-core` in-process);
  the fragile cross-worker notify bridge is gone. `apps/boot` kept as a routeless
  clone target. (Full rationale + DNS mechanics: the 2026-06-11 entry below +
  `docs/boot-worker-consolidation.md`.)
- **Cheap `awaitingUnlock` directory signal (`0a0c93ad` + trickle `19306f3c`).**
  A locked box can't heartbeat and the phone's mailbox read is biometric (can't
  poll), so a waiting box was misclassified "never came online" + offered for
  (dangerous) deletion. `/api/users/:u/pods` now returns `awaitingUnlock` per pod
  (from `secret_mailbox.listPendingForUser`, no auth); iOS + Android + webapp
  consume it → "waiting for approval", delete suppressed.
- **iOS approval-card chain fixed:** surfaced the boot-unlock card at the TOP of
  the server page, OUTSIDE the state switch (`3ed05f12`); made the mailbox read
  user-initiated since the IRK is biometric and can't poll (`db996e8e`); show it
  whenever `awaitingUnlock` is true regardless of BFF load (`aa38e5d9`); and the
  REAL blocker — **the card built its VM in `onAppear` inside a `Group { if let
  vm }`, so the first render was a zero-size empty view and onAppear never fired
  in the ScrollView → card permanently blank** — fixed by building the VM
  synchronously in the body (`e8ac4ed9`). The full UI now works: card shows →
  Check (Face ID) → finds request → Approve (Face ID).

**OWNER — to validate the unlock fix (NOT yet proven):** the UI + relay are
proven; only the unseal needs a box sealed with the new code. Either (A) **SSH
re-seal** `az.harry`: console `manual`+burn-passphrase to boot it, then re-key +
`seal-for-bak --bak-ed25519-pub <authCode.userPubKey>` + re-upload (faster, no
burn), or (B) **fresh burn** with the rebuilt burner. Then Check→Approve should
unseal. Also rebuild the iOS + Android apps (all the card/awaitingUnlock changes
are source-only).

**New follow-ups:** `phoneDelegatedPubKey` is now unused for unlock (still used by
the separately-DEAD PhoneOrder path) — clean up or persist; phone-approval unlock
e2e still unproven; (carried) `recovery.flagshipserver.com` doesn't resolve
(route, no DNS record — make it a custom domain like boot.); push-token/APNs gap
(no auto-notification until TestFlight/Play).

### 2026-06-11 — full deploy + prod wipe for a fresh hardware e2e

Prepped a clean-slate e2e (no agent-doable blockers remained — machine backlog
closed; this session's docker fix + status-pill UI all landed).
- **Burner** rebuilt + re-signed (IBIS LLC Developer ID) + installed to
  `/Applications` (carries the docker-install bootstrap `edd3580e`).
- **`.com` Worker deployed** (`npx tsc -b && wrangler deploy`). Prod D1 already
  had migrations 0047/0048/0049; applied **0050 (boot_nonces, idempotent)**.
- **Boot-worker consolidation CUT OVER (live, version `82bb011f`).** After
  weighing merge-vs-true-decouple: the coupling is intrinsic (boot AUTHORIZES an
  unlock by binding the principal to the identity-plane directory — `gate.ts`),
  and the security boundary is the phone IRK, not the worker split, so a separate
  deployment only ever bought the fragile shared-secret notify bridge (the
  silent-401 unlock-hang). Kept the logical separation at the `@flagship/boot-core`
  package boundary; merged the deployment. **Mechanism: `boot.flagshipserver.com`
  is now a CUSTOM DOMAIN on flagship-com, not a zone route** — the zone has no
  wildcard, and a bare route has no DNS record to catch (recovery., a route with
  no record, doesn't even resolve). `wrangler deploy` reassigned the existing
  custom domain from flagship-boot → flagship-com in place (DNS+cert reused →
  zero downtime). Verified: `/api/health` flipped to `service:"flagship-com",
  surface:"boot"` (ssl_verify=0), gate rejects unauthed `/api/boot/lease/…` with
  `400 malformed authorization`. Contract byte-identical → box/burner/phone need
  no change (compat audited: boot-core routes = `boot-stage.sh` + initramfs +
  `SecretMailboxClient` call sites; in-process directory/notify/push wired in
  `tryBootHost`). `apps/boot` kept as a routeless clone target.
- **`.services` Fly app deployed** (`flyctl deploy`, immediate). Health: com /
  boot / services all 200.
- **Prod DB wiped** (`scripts/wipe-all-users.sh` — 44 tables, marketplace_listings
  + schema_version preserved). servers/usernames/secret_mailbox all 0.
- **Owner-side for the e2e:** rebuild the iOS app in Xcode + the Android app
  (the status-pill fix + cert simplification + push token are source-only); then
  fresh encrypted burn → register → green padlock → **phone-approval unlock**
  (the one path still unproven; prior e2e unlocked via the `manual` keyword).
  The previous live box (`xyz.harry.flagship.services`, 10.10.3.142) was just
  de-registered by the wipe — reuse that hardware for the fresh burn. Burner
  re-rebuilt + DB re-wiped right before this e2e (clean: servers/usernames/
  mailbox = 0; boot merge live).

- **🐛 FOUND (track to GA) — `recovery.flagshipserver.com` does NOT resolve.**
  It's declared as a Worker **Route** in `apps/com/wrangler.toml`, but the
  flagshipserver.com zone has **no wildcard** and recovery. has **no explicit
  DNS record**, so `dig`/`curl` fail with "could not resolve host" — the webapp
  cloud-recovery sub-origin flow (WebAuthn rpId `recovery.flagshipserver.com`)
  is currently broken in prod. Same DNS gotcha the boot cutover surfaced: a
  route only fires for a hostname that already resolves into Cloudflare (`web.`
  works because it has an explicit proxied CNAME). **Fix:** either add a proxied
  DNS record for recovery. (CNAME → flagshipserver.com, like web.) OR make it a
  **custom domain** on flagship-com (like boot. now is — wrangler self-provisions
  DNS+cert). Needs CF dashboard/API (no CF API token in the agent env; wrangler
  can't create arbitrary DNS records, but the custom-domain route in wrangler.toml
  would do it on the next deploy). Doesn't block the cert/boot/unlock e2e.

### 2026-06-11 — vestigial UI removed + WhatsApp-inspired redesign

- **Removed the vestigial "grant a box cert autonomy" ceremony** (iOS + Android;
  webapp never had it). Cert simplification made every box self-renew, so sealing
  the shared ACME account key to a box for "autonomous minting" is meaningless.
  Kept the AcmeAccountKeyGrant machinery (tier-2 + recovery still use it).
- **UI redesign (WhatsApp-inspired), trickled to all platforms.** Found + fixed a
  brand split: mobile was still on the legacy blue `#3B5BFF` while web was on the
  brand teal — **unified mobile on teal `#14B8A6`/`#2DD4BF`**. New shared component
  language (filter chip row, search field, account monogram, profile hero card,
  single dismissible announcement card, grouped icon-square settings rows, clean
  list rows), applied to the three hero screens (Home/Servers, Apps, Settings) on
  iOS (reference), Android (Compose mirror), and webapp (vanilla JS mirror): large
  collapsing title + search + filter chips (All/Online/Pending/Offline on Home;
  All/Yours/Shared on Apps) + list rows + announcement card; Settings gets a
  profile hero + grouped rows. A shared status classifier (PodStatusStyle /
  HomeStatusFilter) keeps the bucket rules identical across platforms. Large-screen
  pass: a 640pt centered reading column + inline titles on iPad/expanded. Pure
  presentation restyle — every callback/flow + the sign-out gating preserved.
  Note: the webapp already had a bottom tab bar (an earlier note was stale).
- Analysis confirmed iOS/Android were already at near-parity on flows; the
  redesign + teal unification closed the main visual/brand gaps.

Gates: `npx vitest run` 4914 (371 files) · iOS 906 · Android 724 · webapp 1125 ·
`npx tsc -b` clean. All pushed.

### 2026-06-11 (later) — cert model simplified + lock/dead-man feature

**Cert model simplified to one system-wide policy.** Removed the creation-time
managed-vs-autonomous / offline-window choice and the account-wide
certificate-validity setting (all clients). Every box now self-renews its own
per-box A′ cert with its own ACME account key on a single policy: standard
~90-day cert, renew at ≤30 days remaining (one issuance per ~60 days) with a
per-box random hold-off + backoff-jitter so the fleet never bursts Let's
Encrypt. The shared account-key + mint-reservation machinery is untouched
(tier-2 service certs + recovery still use it). `certAutonomy` removed from the
InstallBlob + canonical bytes (byte-identical when absent → no signature break)
across protocol, daemon, iso-personalizer, both burners, and all 3 clients.
Follow-up: the post-creation "grant a box cert autonomy" ceremony
(CertAutonomyGrant* on iOS/Android) is now vestigial — retire separately.

**Lock & power-off + dead-man heartbeat-lock shipped** (`docs/lock-and-poweroff.md`;
ungated/all-users for now — paid gating is a later pass). One shared daemon
primitive (`executeLockAndPower` = suppress auto-unlock → `systemctl
poweroff|reboot`), exposed two ways:
- **Manual buttons** on server-detail (iOS/Android/webapp): "Lock and turn off" /
  "Lock and restart" (drop "Lock and" on a non-LUKS box) → confirm + biometric →
  IRK-signed power-off envelope to **`POST /api/power`**.
- **Dead-man**: opt-in per box (default off). A MANUAL biometric affirmation
  (never the silent renewer — a stolen phone can't keep it alive) renews a lease;
  on lapse past grace the daemon suppresses auto-unlock then powers off/restarts
  per policy. Window default 24h, user-shortenable with a one-tap "tighten now"
  (border-control case). Lockout default = turn off (rubber-hose posture),
  selectable to restart (fast resume).
- A **one-shot** `/boot/flagship-lock-once` marker forces approve-mode on the
  next boot only (consumed after a successful luksOpen), honored at the actual
  LUKS-unlock layer — the initramfs premount for encrypted boxes (TS+Swift
  byte-identical, sha re-pinned), boot-stage.sh for the unencrypted path,
  mutually exclusive. A single Lock&restart does NOT permanently flip the box to
  approve-mode. Needs a live reburn to validate the kernel/luksOpen path.

**⚠️ PRE-EXISTING BUG surfaced (track to GA): the phone→box PhoneOrder path is
DEAD on real Debian boxes.** The daemon verifies orders against `pskPub` read
from `/var/flagship/psk.pub.hex`, but that file is NEVER written — the installer
writes `/var/flagship/phone-delegated.pub` instead, and the phone generates the
per-server "delegated" keypair at create-time then DISCARDS the private half. So
`/api/orders-from-user` is disabled on metal, and **`shut-down` +
`add-paired-session`/`remove-paired-session` cannot be invoked on a real box.**
The lock feature sidestepped this (power-off now verifies against the owner IRK
at `/api/power`, like the dead-man, which works because the box persists
`cfg.irkPublicKey`). Fix the rest of the orders surface before GA: either
persist the delegated private key on the phone + reconcile the
psk.pub.hex/phone-delegated.pub filename + sign orders with it, OR cut the
remaining orders over to the owner-IRK path like power-off did.

Gates (2026-06-11 later): `npx vitest run` 4868 (369 files) · iOS 896 · Android
718 · burner-mac swift 107 · `npx tsc -b` clean. All pushed.

### 2026-06-11 (late) — full-repo security/UX/ops audit + remediation

Ran a six-dimension read-only audit (protocol/crypto, cloud API, daemon/boot,
client, UX, architecture/ops), **personally verified every critical/high claim**
(four agent-flagged "CRITICALs" were false — see below), then fixed the verified
set. 13 focused commits, all gated (vitest **4817**/365 files · iOS 877 · Android
702 · `npx tsc -b` clean). On `main`, pushed.

**Verified-and-fixed:**
- **cert-pin keep-last-known-good (iOS+Android, the top security fix):** `update(pods)`
  used to DROP a verified pin when a still-listed pod's daemon-status didn't
  re-verify → a MITM on the `.com` path could strip `signedStatus` and downgrade to
  default TLS (rogue-cert passes). Now: present+verifies replaces, present+unverified
  RETAINS, absent/revoked prunes. `d6c61ab`/`b145481`.
- **push/relay auth** `19097ce` — was unauthenticated (push spam + registration
  oracle); now an STK-signed `flagship/push-relay/v1` envelope from a registered box,
  category constrained to an enum, no-token target returns `200 {fanout:0}` (oracle
  closed).
- **rate limits** `c96f521` — added buckets for push-relay, voici/shorten,
  llm-promo/issue (were unthrottled at the edge).
- **app-container isolation** `33d2760` — `--cap-drop=ALL`, dedicated bridge (apps can
  no longer reach the daemon API/siblings over host loopback; data path preserved via
  host-gateway alias), `--memory/--cpus/--pids-limit`, read-only rootfs.
- **BYOK SSRF guard** `809bae9` — `assertSafeProviderBaseUrl` blocks loopback/
  link-local/metadata-IP/RFC1918 (override for LAN Ollama); DNS-rebinding documented
  as residual.
- **canonical field-guard uniformity** `424af57` — `legacyFieldGuard` now on every
  free-text canonical field (defense-in-depth; JSON blobs exempt).
- **D1↔InMemory parity harness** `b65d2a3` — real D1-over-`node:sqlite`, all 48
  migrations; **caught a real bug** (D1 `voiciLinks.insert` masked every storage error
  as a collision — now rethrows).
- **ops guardrails:** predeploy staleness gate `5620219`; migration ledger +
  `/api/admin/schema-status` + CA-lease lapse warning (`/api/admin/ca-lease-status`,
  7-day audit alert) `2371e88`.
- **UX pass (all surfaces)** `f2d428a`/`4b1d971`/`2f4d2ca` — cert-pin hard-fail now a
  visible "someone may be intercepting" alert (was a silent network error); raw `HTTP
  <code>` strings → plain language; sign-out→recovery CTA; wedged-install escape;
  de-jargoned recovery copy; short-vs-canonical link labels.

**Audit claims that did NOT survive verification (don't re-chase):** cert-pin
"label-boundary bypass" (the leading `.` defeats it), "SQL injection" (it's an
authenticated owner-only SQL console over the owner's own DB), "preseed shell
injection" (debconf scalar, not shell; newline already stripped), "root-helper
arbitrary write" (write target is `/dev/disk*`, caller is code-sign-pinned), "TOTP
brute-force" (handler self-throttles 5/15min). Residual real-but-deferred: tier-2
mint/install client UX; cert-pin can't run in-browser (webapp relies on CAA+CT);
DNS-rebinding on BYOK baseUrl.

**Deploy note for this batch:** apply migration `0049_schema_version.sql` with the
rest; the new admin endpoints + CA-lease cron ride the normal Worker deploy; the
predeploy gate now runs automatically before `wrangler deploy`.

### 2026-06-11 — machine-doable backlog closed (cert A′ + #52 + parity + NFC C3)

Everything agent-doable from the open-work list landed this session; `main` and
`feat/retail` are both green and pushed. Beyond the cert migration (block below):
- **#52 re-pair hardening (`b95f9ad`):** the same-day-rotation mystery is
  ROOT-CAUSED in code — `/re-pair/complete` is signature-less and accepted any
  row with `completesAt <= now` with NO upper bound, so a stale pending row from
  earlier testing was completable forever, by anyone (this is almost certainly
  how the live rotation "beat" the 3d grace). Fixed: completion only inside
  `[completesAt, +7d)`, else 410 + sweep + audit; initiate's lock keeps a row
  alive through that window (a rival initiate could previously evict a legit
  recovery at grace-elapse). And single-device initiate now requires TOTP or a
  recovery code when enrolled (neither enrolled → grace-only + audited);
  iOS/Android/webapp reuse the multi-device second-factor UX on the 401.
- **Android install-progress parity (`c57a350`):** live ladder on
  the pending-pod detail (order mode w/ serial, else /pods `pending[].phase`
  directory fallback), instant Home upsert at delivery, and the fake-ONLINE
  random-podId pod on leaving the progress screen is gone. Follow-up noted:
  Android has no PendingServerStore — pending pods don't survive process death
  with their serial (iOS persists them).
- **NFC C3 shipped on `feat/retail`** (`837c179`+`3a628fd`+`a5b4c77`, pushed):
  iOS+Android read-only tap flow per the locked Q2 decision — incl. a REAL
  protocol bug fix (the Wi-Fi rendezvous deposit never carried the phone's
  ephemeral pub, so the box could never have decrypted it; new blob format
  `ePhonePub||ciphertext`), 30s session-lock shared constant, SAS glance,
  LED-SAS fallback seam. `main` stays retail-free; § N updated. Open: N-PHONE-3
  write tap, N-PHONE-6 LED capture UI, N-BOX-8 daemon rendezvous consumer.

**OWNER CHECKLIST (in order — everything machine-side is done and pushed):**
1. **Deploy `.com`**: apply D1 migrations `0047_ct_alerts.sql` AND
   `0048_daemon_status_signed.sql` to prod FIRST (0048 before the Worker — the
   new write path needs the columns), wire `CloudflareDnsClient` as the CAA
   client, then `npx tsc -b && cd apps/com && npx wrangler deploy`.
2. `flyctl deploy` the `.services` app (hub wildcard-claim hardening + per-box
   DNS route changes).
3. **One prod read I was permission-blocked from** (then optionally wipe):
   `cd apps/com && npx wrangler d1 execute flagship-state --remote --command
   "SELECT username, initiated_at, completes_at, objected_at FROM
   pending_re_pairs"` — if a stale row predating the live rotation is (still)
   there, that confirms the #52 root cause empirically; the code fix closes the
   hole either way. Then `bash scripts/wipe-all-users.sh` for the clean slate.
4. **Rebuild + re-sign the Mac burner** (A′ daemon changes ship in the recipe).
5. **Rebuild the iOS app in Xcode** (pinning + tier-1 URLs + re-pair second
   factor + push token).
6. **Hardware e2e** — the full post-cert-rebuild test list at the bottom of
   `docs/cert-model-A-prime-migration.md`: fresh encrypted burn → per-box cert
   green on `<server>.<user>` AND `x.<server>.<user>`, phone-approval unlock
   (notify pipe is fixed), pin enforcement on a real box, CAA/CT checks,
   decommission, voi.ci.
7. Recovery Phase B on-device validation + iOS owner-device confirmations
   (carry-overs, unchanged).

**New follow-ups surfaced this session (agent-doable next time):** tier-2
mint/install client orchestration UX (daemon endpoints + envelopes are live);
phone reminder before a shared service cert expires; custom-domain CNAME target
`<user>.flagship.services` no longer has an A record under per-box DNS (weigh
with tier-2 work); mobile in-app Replace-device lacks the TOTP prompt (webapp
ceremony has it); Android PendingServerStore persistence; webapp pending
re-pair banner could surface the completion deadline on GET.

### 2026-06-10 (late) — CERT-MODEL MIGRATION C → A′ EXECUTED IN CODE

**⭐ The entire cert-model migration is implemented on `main` and gated** (15
commits; vitest 4608 · iOS full suite green · Android 669 · burner-mac 109 ·
`npx tsc -b` clean). `docs/cert-model-A-prime-migration.md` header lists what
remains. What landed:
- **Phase 1 (per-box wildcard):** the daemon mints `[<server>.<user>, *.<server>.<user>]`
  (`boxCertSans`, SANs re-derived at startup ⇒ model-C certs auto-discard +
  re-mint on first boot); `.com` registration publishes the per-box A/AAAA pair;
  DNS-01 (`dns01.ts` AND the dns-broker policy) accept a box's challenges ONLY at
  its own subdomain; CAA stays at the user zone (RFC 8659 tree-climb covers
  everything below); CT monitoring (both monitors) flags any cert whose SAN set
  doesn't fit exactly ONE registered box's pair — incl. the retired per-user shape.
- **Phase 2 (`--` revert):** pin operator deleted (hierarchy replaces it);
  tier-1 canonical `https://<label>.<server>.<user>` is the share/copy/open URL on
  iOS + Android + webapp (clients use the daemon-provided AppSummary.url, not
  local derivation); mocks mirror the live shape. Tier-2 `<label>.<user>` kept
  ONLY where genuinely leader-routed. Bonus bug fix: app-backup `resolveSource`
  composed `<creator>--<slug>` and never matched (8a00e3b).
- **Phase 3 (voi.ci):** no change needed — targets already mint from the tier-1
  canonical.
- **Phase 4 (pinning):** `/pods` relays the VERBATIM STK-signed daemon-status
  (`signedStatus`, migration **0048**); `verifyDaemonStatusReport` in
  @flagship/protocol + byte-identical Swift/Kotlin mirrors (pinned cross-platform
  vector). iOS (URLSession delegate) + Android (hostname-verifier + interceptor —
  the verifier stage covers WebSockets, which OkHttp interceptors skip) HARD-FAIL
  when a verified pin mismatches; fail-open only when no pin exists. STK pubs
  derive LOCALLY (.com's echo is not a trust input); demo/mock can't install pins.
- **Phase 5 (tier-2 shared service certs):** ServiceCertAuthority (IRK, ≤1h) +
  mint/export/install envelopes; the authorized box mints `[<service>.<user>]`
  via its own ACME with the authority forwarded on DNS-01; key distribution is
  phone-driven over each box's pinned canonical pipe (`POST /api/service-certs/
  {mint,export,install}` on the daemon); certManager serves it on exact SNI;
  rehydrates on restart. Renewal = phone re-mints (deliberate v1).
- **Hub hardening (came out of the routing audit):** routing never used wildcard
  claims (the one-label SNI strip IS the per-box wildcard, and the old `*.<user>`
  claim was inert) — but nothing REFUSED foreign wildcards; now the hub nacks any
  wildcard claim except a box's own `*.<podCanonical>`, the allocator drops `*`
  canonicals, findBySni refuses `*` SNIs.

**Deploy set for this migration (owner, do together):** `npx tsc -b && cd apps/com
&& npx wrangler deploy` · apply migrations **0047_ct_alerts.sql + 0048_daemon_
status_signed.sql** to prod D1 (0048 BEFORE the Worker deploy — the new D1 write
path needs the columns) · wire `CloudflareDnsClient` as the CAA client · rebuild
+ re-sign the Mac burner · rebuild the iOS app · wipe + fresh burn → the full
post-cert-rebuild hardware test list in the migration doc.

**Open follow-ups from the migration:** tier-2 mint/install client UX (phone
orchestration of the new daemon endpoints — protocol + endpoints are done);
phone-side reminder before a shared service cert expires; custom-domain CNAME
target says `<user>.flagship.services` whose A record per-box DNS no longer
publishes (weigh with tier-2/custom-domain work); webapp cannot pin (browser
constraint — CAA + CT are its backstop).

### 2026-06-10 session — ENCRYPTED BOX e2e PROVEN ON METAL + cert-model plan

**⭐ MILESTONE: the encrypted-box end-to-end works on real hardware.** After a long
debug chain, a real encrypted box (`abc5.harry1.flagship.services`) reached a genuine
**Let's Encrypt green padlock** (issuer CN=YR1, per-user cert `[harry1, *.harry1]`),
serving content, `.services` content-blind. The #27 saga's entire downstream is
validated. (The unlock was MANUAL via the `manual` keyword + recovery passphrase — the
PHONE-approval unlock still needs a fresh end-to-end run, see TODO.)

**DOCKER FIX (2026-06-11, agent, on real metal + on `main`):** the daemon was
crash-looping on the live A′ box because docker was never installed — the bootstrap
apt-installed node/git but not docker, so `ensureNetwork`'s `docker network create`
hit ENOENT. Two commits: `1b1b75e7` made the daemon survive a missing docker
(serviceRunner's realCommandRunner had no `'error'` listener → unhandled crash;
`ensureNetwork` now swallows it); `edd3580e` installs docker in the bootstrap
(`docker.io docker-cli docker-compose` — docker-cli listed explicitly because
`--no-install-recommends` drops it) + a gated `flagship-data-services.service`
oneshot that runs `installer/data-services/init.sh` after docker is up (NOT before
the daemon — image pulls must not delay the padlock). Verified live: docker installs,
`network create` succeeds, the full data stack (postgres/minio/redis/forgejo/chromium)
comes up healthy, daemon logs **"data layer wired"**, green padlock holds. Swift burner
mirror byte-identical (bootstrap sha pin re-asserts both sides). Burner 200 TS + 57
swift EngineTests green; `tsc -b` clean.

**~~NEXT SESSION = EXECUTE THE CERT-MODEL MIGRATION~~ — DONE, see the block
above.** Full detailed plan in
`docs/cert-model-A-prime-migration.md` (all decisions LOCKED). Headline: move off the
current model **C** (per-box key + per-user wildcard `*.<user>`, each box re-mints →
hits LE's duplicate-cert limit at >5 boxes + forced the `--` name hack) to **A′**:
- **A′ = per-box wildcard** `[<server>.<user>, *.<server>.<user>]` — box-local key,
  never shared, distinct per box (no duplicate-limit), covers `<service>.<server>.<user>`.
- **Revert `--`** flattening → hierarchical `<service>.<server>.<user>`.
- **Three trust tiers** (the share-URL encodes the assurance): canonical
  `<service>.<server>.<user>` (security+hardware, pinned) · `<service>.<user>` (security,
  hardware-agnostic, leader-routed — the EXISTING multi-server mechanism, KEPT) ·
  `voi.ci/<blurb>` (convenience redirector, visible 302, trust-us).
- **Canonical long-form HTTPS = the root primitive** — incl. delivering a tier-2
  `<service>.<user>` key to a box over its own pinned pipe (phone→box direct, NOT `.com`).
- **voi.ci stays a path redirector** (no per-service certs, no voi.ci LE exposure).
- **Cert-fingerprint pinning** (hard-fail) off the STK-signed daemon-status fingerprint
  — the real defense against a `.com` rogue cert.
- **PSL** for flagship.services: file once there are real users (per LE).
- The post-cert-rebuild **test TODO** lives at the bottom of that doc (the rebuild
  touches names/certs/DNS/routing/all clients → full validation pass follows).

**What landed this session (all committed + pushed; `main` green, tree clean):**
- **Boot-unlock brought up on metal** — initramfs Wi-Fi (op-mode module staging, DNS
  resolv.conf+NSS, CA bundle, wired DHCP) `7db385a`/`de10869`/`c2617a9`/`8101e6b`;
  Beacon E `installing`; **wait-forever for phone + `manual` keyword override + mailbox
  heartbeat** `964cd88`; boot worker fixes — **service binding to the identity plane**
  `d17ae01` (same-zone Worker→Worker fetch was returning HTML), **fetch `this`-binding
  1101 fix** `242ab68`, no-store directory reads `76aa05e`.
- **#52 sign-out gate** `8f9c9c0` · **/pods serial→orderRef** `aa78e2b` · **iOS
  install-progress** `48a4b9e` · **decommission failed servers (free the name)**
  `240ac3e` + dead-server status `e4b38e5` · **3-state liveness (waiting/coming-online/
  dead)** `56910d1` · **monotonic install checklist (phase order)** `97f63c5` ·
  **liveness bridge (live box reads online) + daemon-status heartbeat** `41a039a` ·
  Dock progress contrast `73cf35f`.
- **Cert-security (committed, NOT deployed — deploy WITH the cert rebuild):** CAA
  CA-restriction publishing `ca29a0b`; CT-log rogue-cert monitor (6h cron, owner
  push) `1f8086e`.
- **Notify pipe FIXED (root cause of "no phone permission ever"):** the boot→`.com`
  notify shared secret was mismatched (silent 401) → re-synced `NOTIFY_SHARED_SECRET`
  (boot) and `BOOT_NOTIFY_SECRET` (.com) to one value. (No commit — secret rotation.)
- Security tracking added to the pre-GA list `b52762f` (/pods enumeration; CAA+CT;
  daemon reporting).

**OWNER-SIDE (carry into next session):** rebuild the iOS app (push token + all the
UX); deploy `.com` + apply migration `0047_ct_alerts.sql` + wire `CloudflareDnsClient`
as the CAA client (do this WITH the cert rebuild); rebuild+re-sign the Mac burner after
the A′ daemon change; then the phone-approval unlock e2e.

Gates (2026-06-10): `npx vitest run` 4517 (351 files) · iOS 824 · Android 620 · burner
175 TS + 105 swift · webapp green · `npx tsc -b` clean.

### 2026-06-09 session — what landed + the live encrypted-unlock failure

**NEXT SESSION — FIRST MOVES (in order):**
1. **Deploy the Worker** — `npx tsc -b && cd apps/com && npx wrangler deploy`. One deploy ships three things: the `/pods` orderRef hardening (`aa78e2b`), and (already-seeded) `FLAGSHIP_ISO_MANIFEST` Simple-mode downloads.
2. `bash scripts/wipe-all-users.sh` (clean slate).
3. Rebuild the iOS app in Xcode — `main` has the consolidated server list (#56), orderRef reconciliation, the #52 sign-out gate, the three-tier session model (#46), and the keychain self-heal.
4. **Rebuild + re-sign the Mac burner** — it is NO LONGER current: `main` now carries the 2026-06-09 initramfs Wi-Fi hardening + the `installing` beacon (`7db385a`); a reburn from the old binary would re-test the broken hook.
5. **Encrypted Wi-Fi e2e (#27) — the ONE piece the project still has to prove.** Create a fresh account → **enroll Cloud Recovery FIRST** (sign-out is now BLOCKED without it, #52) → create a server with **Encrypt disk ON** (default) → burn with the rebuilt burner → boot → unplug USB → power on → watch LUKS-unlock-over-Wi-Fi. If it still fails: console-login as `debug` / `flagship`, read **`/boot/flagship-wifi-build.log`** (NEW — stage-by-stage build-time staging log: interface/driver/firmware/binaries, each OK or MISSING) + `/boot/flagship-wifi.log` (an empty one now means "premount never ran", nothing else).

**2026-06-09 evening sweep (agent) — four task closures on `main`:**
- `7db385a` **#27 hardening + Beacon E** — see the updated LIVE FAILURE note below.
- `8f9c9c0` **#52 DONE** — Tier-2 sign-out is blocked without cloud recovery on iOS + Android + webapp (shared `SignOutPolicy`, enforced at the action layer that calls `Keystore.wipe()`, not just dialog copy; blocked dialog routes into recovery enrollment; demo/mock sessions exempt). The re-pair audit answered the open question: single-device re-pair-by-grace with a brand-new self-signed IRK is the **designed** takeover path (no credential to initiate, old key has no veto, only T+0/+1d/+3d alerts) — so blocking the no-recovery wipe is the correct fix. One loose end: the observed live rotation completed same-day, which the 3d grace shouldn't permit — check whether a stale pending re-pair row predated it.
- `aa78e2b` **/pods serial → orderRef** (details in the SECURITY list below).
- **Android #56 parity was already DONE** (`f0acd5d`, complete port + 6 pending-state tests) — the "in flight" note below was stale.
- **Recovery Phase B iOS re-pair branch (open-work item 5) is already fully wired + tested** — `registeredIrkPubHex` captured (RecoveryViewModel:184), `recoveredKeyMatchesRegistered` (:239), Phase A/B branch in `RealAccountLoginViewModel.startSingleDeviceTakeover()` (:250) calling `initiateRotatedRePair` with `oldIrkPub = registeredIrkPubHex`, KeyfileImportViewModel instant skip-grace. Only on-device validation remains.
- `48a4b9e` **iOS install-progress fixes from the live burn** (deploy+wipe+burner-rebuild had been run; a real encrypted Wi-Fi install was in flight and the backend phases were advancing — Beacon E `installing` CONFIRMED firing on metal): (1) the delivered page's hardcoded "Status: pending" → live ladder polling the per-order status; (2) the pod now upserts onto Home the moment the delivered page appears (was: only on "Done" — a watcher of that page never saw the server until pull-down); (3) a serial-less pod (surfaced from `/pods`, which ships only opaque orderRefs) sat forever on the empty "Booting up" ladder → the timeline VM gained a directory fallback (poll `/pods`, project `pending[].phase`, flip live on registration) and `upsertPendingPod` re-attaches the local serial to a serial-less twin. iOS 801 XCTests. **Parity follow-up (agent-doable): check Android for the same three behaviors** (instant surface at delivery; serial-less pending detail riding `pending[].phase`); webapp is unaffected (home renders pending straight from `/pods` and shows phase on the card). **Owner: rebuild the iOS app in Xcode to pick this up.**

**#27 LIVE FAILURE (2026-06-09):** an encrypted Wi-Fi-only box installed/sealed/registered fine but **failed to auto-unlock** — stuck at `Please unlock disk`, `curl (6) could not resolve host boot.flagshipserver.com` (NO network in the initramfs), Wi-Fi beacon empty (DHCP never succeeded). After a hand-unlock with the burn-time recovery passphrase the **full-OS daemon also didn't check in** (daemons=0) — so Wi-Fi isn't engaging on this box in EITHER context, despite #45. Everything downstream of unlock is PROVEN — the no-LUKS box reached a real Let's Encrypt green padlock (`*.harry.flagship.services`) on hardware.
**→ HARDENED (`7db385a`, agent audit, awaits a real reburn):** the build-time hook was confirmed able to silently no-op exactly as suspected — driver detection unvalidated (empty `wl*` lookup fed `manual_add_modules ""` behind `|| true`), Debian-13 `.xz`/`.zst` firmware variants never matched, and `wpa_cli` + `ip` (both used by the premount) never staged. Hook now validates every step + logs to `/boot/flagship-wifi-build.log`, stages firmware variants + dependency-module firmware + `cfg80211`/`mac80211`, copies `wpa_cli`/`ip`, falls back to `copy_modules_dir kernel/drivers/net/wireless`; premount logs before mounting, waits (bounded) for FLAGSHIP_BOOT, records the mount result; iface wait 15s→30s; the full-OS Wi-Fi safety-net unit dropped its `After=network.target` chicken-and-egg. TS↔Swift byte-identical, sha pins updated. The static tests prove the script text — the kernel/net path needs the live reburn (FIRST MOVES above).

**DEPLOY GOTCHA (cost real time this session):** `wrangler deploy` bundles apps/com's import of the BUILT `@flagship/control-plane` `dist/` — a control-plane change that isn't compiled silently ships stale. ALWAYS `npx tsc -b && cd apps/com && npx wrangler deploy`. (This is why the outstanding-orders endpoint "deployed" yet never worked.)

**App server-list — CONSOLIDATED (#56, LIVE):** one unauthenticated `GET /api/users/:u/pods` now returns registered `pods` (`state:"online"`) + active `pending` orders (`state:"pending"`, with `serial`/fqdn/phase) — **no more biometric Face ID on a list refresh**, and a just-created server appears instantly. Server `bae3537` (deployed via tsc -b + wrangler, verified `pending` key live), webapp `792a620`. Replaces the split-brain (registered `/pods` + biometric-signed `outstanding-orders` whose silent per-order `provision_status` failure swallowed the whole list) that caused the entire "server doesn't appear / Face ID on refresh" saga. iOS done; webapp done; Android done (`f0acd5d`). Wire note: `pending[].serial` was replaced by `orderRef` in `aa78e2b` (see SECURITY below) — deploy before judging client pending behavior against prod.

**SECURITY — pre-production cleanup (track to GA):**
- **`debug`/`flagship` user, burn-time LUKS passphrase, mass-wipe → see the "GA close-out TODO" subsection** (top of this status section). Those dev-mode disablements are now consolidated there (items 1–4); this note recorded their discovery.
- **#52 — DONE (`8f9c9c0`).** Tier-2 sign-out is blocked on all three surfaces when `hasCloudRecovery` is false (action-layer `SignOutPolicy` gate; blocked dialog routes to recovery enrollment; demo exempt). Audit verdict: the rotation rode the DESIGNED single-device re-pair-by-grace path (no credential to initiate, no old-key veto) — see the evening-sweep note above. Possible follow-up: require a credential on the single-device re-pair initiate, and check why the live rotation beat the 3d grace.
- **/pods serial exposure — HARDENED (`aa78e2b`, not yet deployed).** The unauthenticated `/pods` `pending[]` no longer carries the auth-code `serial` (a provision-status write capability); it ships an opaque `orderRef = hex(sha256("flagship/order-ref/v1|" + serial))` (`orderRefForSerial`, control-plane `podInventory.ts`; byte-identical mirrors in iOS `FlagshipCore.OrderRef` + Android `core.OrderRef`, pinned cross-platform vector). The creating device reconciles by hashing its locally-stored serial; a non-creating device reconciles by fqdn and shows list-level phase only (it never learns the serial, so no deep-progress poll / cancel-revoke there). All surfaces + tests updated in lockstep. Deploy needs the usual `npx tsc -b && cd apps/com && npx wrangler deploy`.
- **/pods unauthenticated server-list enumeration (track to GA).** `GET /api/users/:u/pods` is unauthenticated (a deliberate #56 tradeoff to avoid a biometric Face ID on every list refresh, and because the boot worker's directory client reads it). It leaks METADATA to any knower-of-a-username: the user's server domains, identity pubkeys, registered timestamps, apps-served (NO secrets/keys/content; the serial is already opaque-`orderRef`'d). Pre-GA decision needed: require auth (re-introduces the refresh-biometric problem #56 solved), OR rate-limit + make usernames non-guessable, OR accept-with-rationale. Currently UNTRACKED-until-now.
- **CAA pinning + CT monitoring — SPEC'd, NOT deployed (track to GA).** Because `.com` controls the `flagship.services` DNS zone, it could in principle satisfy a DNS-01 challenge and mint a ROGUE per-user cert (it never sees the box's cert private key — that's generated + held box-local and never transmitted — but it controls the name). Defenses are designed in `docs/per-user-cert-and-addressing.md` (CAA pinned to the user's ACME account so LE refuses out-of-account issuance; CT monitoring on the phone to alert on any cert the owner didn't mint) but NOT implemented. Mitigating factor today: a cert is NOT the access-control primitive — routing authority (RCK/STK, phone-held) is, so a rogue cert can't redirect traffic. Deploy CAA+CT before GA.
- **Daemon liveness/cert reporting — DONE (2026-06-10 late).** The daemon sends the 5-minutely STK-signed daemon-status heartbeat (wired in server-daemon index); `/pods` now relays the VERBATIM signed report (`signedStatus`, migration 0048) so phones verify the cert fingerprint against the locally-derived STK and hard-fail-pin on it. The provision-status liveness bridge remains as the fallback for boxes that haven't reported yet.

Gates (2026-06-09 evening): `npx vitest run` 4465 (348 files) · iOS 793 XCTests · Android 611 · burner 175 (TS) + 105 (swift) · webapp 1012 · `npx tsc -b` clean.

### Live in production
- **Per-user TLS** — one Let's Encrypt cert per user, SANs `[<user>, *.<user>]`, real green padlock (per-box → per-user cutover verified live 2026-06-02). ACME runs on the user's daemon over SNI passthrough; `.services` stays content-blind. Wildcard SANs via DNS-01.
- Auto-unlock-lease (one-shot + long-lived) with silent renewer; WebAuthn-PRF cloud recovery; Web Push (RFC 8291 encrypted payloads); `/consume` → push.
- **Cert model** (iOS + web + Android): creation is a binary — *managed* (your devices renew it, default) vs *autonomous* (the box self-renews); renewal window is an account-wide "Certificate validity" setting (presets 7/30/90, default 30).
- **Recovery Phase B backend** deployed — single-device re-pair grace 7d→3d; the wrapped-UMK fetch returns `registeredIrkPubHex` for rotation detection.
- Brand/teal migration complete (rounded-square-containing-a-circle mark; the flag-on-mast pennant is **retired — do not reintroduce**). `/og` social card, `/ready` page, webapp no-server empty states, iOS Apps→Services rename + persistent pending servers.
- **All prod users wiped 2026-06-02** for a clean pre-release slate (`marketplace_listings` preserved).

Gates (2026-06-03): web 978 · com+control-plane 1108 · iOS 755 XCTests · `npx tsc -b` clean. `npx vitest run` ~30s. Workspace deps: `npm install` + `npx tsc -b`.

### Open work

**Hardware / boot — Debian-only now; getting a box to boot is the gate:**
> **Decision (2026-06-08): Debian is the sole shipping path; Alpine is parked on the `alpine` branch.** Alpine's initramfs wouldn't enumerate USB on real metal ("mounting boot media failed"), and the fix was hardware-iteration-gated + speculative; Debian-installer already solves the hard UEFI-NVRAM-rejection problem and its whole downstream (bootstrap, boot-stage, LUKS, systemd, register) is shared + Debian-ready. `main` is Alpine-free + green.
>
> **DONE (agent, 2026-06-08) — the Debian-quick + manifest + phone-home plan all landed on `main`:**
> - ✅ **`POST /api/iso-manifest`** — server-driven base-ISO manifest (dumb-executor burner; `{download:{url,sha256,version,sizeBytes,attestation}}` or `{download:null}`; blessed manifest in Worker env `FLAGSHIP_ISO_MANIFEST` = the hold/fast-track lever). Spec: `docs/iso-manifest.md`.
> - ✅ **Burner Simple mode** (mac/linux/windows) — manifest-driven Debian base cache: downloads + sha-verifies when ordered, shows the URL under the progress bar, logs path+sha on every launch + after each download; remasters via the shared preseed path. Advanced (user ISO) stays. (mac swift 90 · linux pytest 88 · windows via its own CI.)
> - ✅ **Website simplified** — one story: mint recipe → copy/download on `/ready` → get the burner → it fetches the OS itself. All user-facing Alpine/ISO-pick/Advanced-mode framing gone.
> - ✅ **Earliest phone-home** — best-effort beacons in the burner preseed (TS + Swift, byte-identical, injection-sanitized): Beacon A in `preseed/early_command` (`d-i-started`, busybox-wget, pre-network `|| true`) + Beacon B at top of `late_command` (`installer-running`) → existing `POST /api/install-events/<serial>` (the channel the phone watches).
> - ✅ **Wipe script re-audited** through migration 0046 (`scripts/wipe-all-users-prerelease-2026-06-02.sql`): dropped stale `build_tickets`, added `acme_account_key_delivery` + `nfc_rendezvous`.
>
> Gates on `main`: `tsc -b` clean · vitest **4379** · iOS **728** + App build · Android · burner-mac swift **90** · burner-linux pytest **88**.

**Wi-Fi unlock + no-LUKS escape hatch — DONE (agent, 2026-06-08):**
> A Wi-Fi-only box installed + sealed fine but **hung at the early-boot LUKS
> unlock on every reboot**: the initramfs unlock premount curls the boot relay
> assuming the network is up (true on Ethernet's auto-DHCP, false on Wi-Fi where
> the early-boot env brings up no radio). Two landed fixes, both with byte-identical
> TS↔Swift generators (sha-pinned) + green gates (vitest 4406 · iOS 728→738 ·
> Android 583 · burner swift 104 · tsc clean):
> - ✅ **Wi-Fi in the initramfs** (`b1dd738`): a build-time hook stages the box's
>   actual `wl*` driver + firmware + `wpa_supplicant`; a boot-time `init-premount`
>   (runs strictly before `local-top/flagship-unlock`) associates + DHCPs, fully
>   best-effort + wall-clock bounded so it can never hang boot. Only on the
>   encrypted Wi-Fi path; wired burns byte-identical. **Also keeps the burn-time
>   LUKS passphrase as a bring-up recovery slot** (`luksRemoveKey` guarded off, not
>   deleted) — a KNOWN CONSTANT; the GA flip-the-guard-back-on action is tracked in
>   the "GA close-out TODO" subsection (item 3).
> - ✅ **No-LUKS server option** (`dad6bf0`+`f4231a2`): phone-signed
>   `InstallBlob.diskEncryption` ("luks"|"none"), appended last in canonical bytes
>   as `de=<mode>` (absent ⇒ encrypted; a relay can't downgrade luks→none without
>   breaking the sig). Toggle in every create-server flow (iOS/Android/webapp +
>   demo/dev mint), default ON; OFF provisions an unencrypted box that boots
>   without needing network at unlock. Help entry added for "stuck at installed".
> - ✅ **Install checklist** (`d92e1ea`): dropped the redundant `installed` rung
>   (it spun while the box was powered off); Installing now goes green + carries
>   "unplug the USB" detail. `installed` stays a wire phase + push milestone.
>
> Owner-side next: rebuild+re-sign the Mac burner (below), then a live Wi-Fi
> reburn to confirm the initramfs radio actually associates + DHCPs before the
> unlock relay (the static tests prove the script text, not the kernel/net path).

**Remaining to a live box (owner + hardware):**
1. **Deploy to activate the manifest.** `FLAGSHIP_ISO_MANIFEST` is already seeded in `apps/com/wrangler.toml` [vars] (Debian 13.5.0 netinst, version-pinned cdimage url, official signed sha, size 791 674 880; verified live 2026-06-08) — so just `cd apps/com && npx wrangler deploy` turns Simple-mode downloads on. (To serve from our own R2 instead of Debian's CDN, upload the same bytes and change only the `url` field — sha is unchanged. Re-pin all three on a new Debian point release.)
2. **Rebuild + re-sign the Mac burner** (it now ships Simple-as-default + the manifest client).
3. **Run the wipe** — `bash scripts/wipe-all-users.sh` (NOT the raw `--file` .sql: prod D1 drifts from the repo's migrations, and a one-transaction `--file` run aborts on the first table prod lacks; the runner deletes each table independently and skips absent ones).
4. **Verify Debian-preseed reliability + live e2e** — cmdline injection (`Remaster.swift`/`remasterIso.ts` grub+isolinux patch) was per-ISO flaky earlier; add real-Debian-ISO tests, then create-account → recipe → burn → boot → watch the phone-home timeline → registers → green padlock.

**Install / provisioning polish:**
- ✅ **Beacon the partitioning→installing transition — DONE (`7db385a`).**
  `partman/early_command` now drops a backgrounded best-effort
  `/usr/lib/base-installer.d/05flagship-beacon` that POSTs `phase:"installing"`
  via the shared `debianBeaconCommand` idiom; byte-identical in both generators,
  pinned by tests. NOT locally testable (no d-i dry-run) → observe on the next
  real burn's checklist (cosmetic if it doesn't fire: lag, not hang).

**App / recovery:**
5. **Recovery Phase B re-pair branch — CODE DONE, on-device validation only.** The full Phase A/B branch is already wired + tested (see the 2026-06-09 evening-sweep note): validate on a real device that a rotated-key recovery lands in re-pair-with-grace and an unrotated one pairs instantly. Backend already deployed.
6. **iOS owner-device confirmations** (from 2026-06-02, never confirmed on device): cross-device-QR recovery fix (`f4593a3`); Passwords-app icon flips to the teal ring; a real burn → box registers → green padlock.
7. **iOS diagnostics:** jetsam memory crash after ~14 min (use the Memory Graph Debugger; note which screen grows); input-field delay on "I already have an account" (confirm with a Release/Profile build).

**Ship / launch (owner-side, mostly):**
8. **Stores.** iOS TestFlight (Associated Domains capability, Xcode Archive + ASC upload, metadata, 5 external testers); Android Play (signed AAB via `./gradlew :app:bundleRelease`, internal track, 5 testers). Neither app is on a store yet, so push / Live-Activity timelines can't be received on a real device.
9. **Marketplace security scanner** — `marketplace_listings.scan_grade` ships NULL; needs the Trivy + custom-checks service that posts grade + R2 report. MVP gate before public marketplace.
10. **v1-alpha live exercises** (multi-day, observational): recovery / rotation / update-pack over 7 days × 2 pods; peer-backup at scale; marketplace MVP; public disclosure + bounty path.
11. **Disarm the mass-wipe + the other dev-mode disablements before real users → see the "GA close-out TODO" subsection** (top of this status section). The wipe-script guard/removal, the `debug` user, the burn-time LUKS passphrase, the demo/dev flips, the `pro.html` payment placeholders, the `DEV_LATE_LOG`/W12 debug endpoints, and the release-build CI grep-gate are all consolidated there.
12. **In-house AI inference server (build-modes follow-on).** Today the AI-authoring paths (scratch chat, git-adapt) run on **BYOK** — the box calls the user's chosen provider directly; no inference infra needed. When we stand up our own model server, wire it as a third posture (in addition to BYOK + a possible Flagship-promo tier): run an OpenAI-compatible endpoint (Ollama / vLLM / TGI) on the box or a LAN/datacenter host, point a provider at its `baseUrl`, and flip the `LlmHarness` `baseUrlGuard` (`allowPrivate`/`allowHttp` or `hostAllowlist`) — the guard is built for exactly this (see `llmHarness.ts` + `docs/build-modes.md` "in-house inference server"). No bespoke inference code; the adapter (`ollama`/`openai`) already exists. Also decide the default-provider UX once it's hosted (auto-select the in-house server vs. keep BYOK primary).

**NFC retail tier (post-v1; design in `docs/v1-operational-tasks.md § N`):** protocol + daemon state machine + cloud activation API are built & partly live; **C3 — iOS + Android NFC read flow** is the remaining agent-doable chunk. Hardware bring-up waits on the hardware-shipping business decision.

### When in doubt
This file is the in-repo source of truth. For deeper detail, read the relevant living spec in `docs/` (index below), the operational runbooks in `docs/runbooks/`, or — for architecture — `project_overview.md` in agent memory. `docs/archive/` is frozen history.

### Living design specs (index)
- **Cert & addressing** — `per-user-cert-and-addressing.md`, `per-user-cert-worklist.md`, `multiplexing.md`, `service-addressing-double-dash.md`
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `box-request-inbox.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`, `account-deletion-and-name-reclaim.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `naming-recovery-and-name-change.md`, `sample-users.md`
- **Install / ISO / burner** — `recipe-schema-v2.md`, `installer-tiny.md`, `installer-netboot.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `monetization-free-tier-first.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `runbooks/`, `policy/`
