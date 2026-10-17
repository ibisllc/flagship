# Flagship open-bug audit for the MVP (2026-10-16)

Checked against `main` at `71e74bdfe`. `main` moved to `cd2dcffd6` during the audit; that commit fixes R0 below. The audit was read-only.

**Scope:** `docs/launch-mvp.md`, which covers:
- the core loop
- the iOS, Android, webapp and Mac Studio apps (Windows and Linux Studio as "preview")
- the free tier
- Flagship Inference
- the GA close-out list
- the CA lease
- Share this server
- access control with ranks

**Out of scope (on branches):** payments, custom domains, name change and dibs, marketplace, retail NFC, the browser extension, LAN-direct and phone USB burn.

**Sources:**
- `AGENTS.md` "Current status & open work" (the copy on disk includes the 2026-10-16 entry "Adding a server is admin-only")
- the memory `bug_*` files
- `gh issue list` and `gh pr list`: **no open issues, no open PRs**
- TODO, FIXME, XXX and HACK markers: **none added since 2026-10-01**; the 31 live markers date from 2026-05 to 2026-07, and there is no FIXME or HACK anywhere
- skipped tests
- the gym results: the live run of 10-15 19:16 passed 112/112, the live run of 10-16 00:50 passed invites, gating and one-list
- today's `npm run ready`, run in the ready worktree
- the docs' open sections

**Today's `npm run ready`:**

| Phase | Result |
|---|---|
| branches | RED: `feat/marketplace` has 15 conflicts |
| tsc | green |
| vitest | 9905/9935 passed (30 skipped by environment) |
| e2e | RED: S11 failed, see R0 |
| locked gym | GREEN 88/88. The 12 web gym failures in the 10-15 01:10 run are gone (fixed, or removed in `d44de7946`) |
| parity | RED: 15 |

**How to read the entries:**
- **Class:** DEFECT means the code does the wrong thing. GAP means a missing piece or missing hardening. UNVALIDATED means no known defect, but never run on real hardware. OPS means it needs a deploy, endorsement, store build or owner action.
- **Agent:** "yes" means an agent can fix it in software in this repo.

---

## 1. Blockers an agent can fix in software

### B-1. The `DEV_LATE_LOG` endpoint is unauthenticated on public production
- **What:** anyone can POST 64 KB chunks without limit into R2 `ISO_TEMP_BUCKET`. Anyone who knows a label can GET the logs back.
- **Shipping installers post box logs to it:**
  - the initramfs Wi-Fi log, label `<serial>-wifi`
  - the bootstrap log tail on failure
  - the netboot post-log
- **Where:**
  - `apps/com/src/controlPlaneRoutes.ts:789` (route), `:3565-3610` (handler, commented "Unauthenticated for dev; remove before public launch")
  - posters: `packages/flagship-builder/src/userdata.ts:1468`, `preseed.ts:194`, `packages/installer-netboot/post-log.sh:35`
- **Family:** .com Worker and installer.
- **Still open:** handler checked in the code. The site gate has been off since `e78b85662` (`SITE_PUBLIC = "1"`, `apps/com/wrangler.toml:241`), so this is live and public. The other W12 routes (`DEV_RESCUE`, `DEV_DESTROY`, `DEV_SERVER_INFO`, `DEV_UPLOAD_ISO`) are admin-gated, but are GA close-out item 5 too.
- **Class:** DEFECT (security and privacy). **Agent:** yes. Remove the routes and the posters, or gate them behind a box signature.

### B-2. Egress fence fails open for live apps
- **What:** if the gateway can't start, `ensureUnfencedNetworks` creates ordinary bridges, so live apps reach the whole internet until a 30 s retry succeeds. AI staging copies and builds stay refused.
- **Why it matters:** it breaks the owner-signed access-list promise, and it is the exfiltration path the "AI never learns who the owner is" rule relies on.
- **Where:** `packages/server-daemon/src/runtime.ts:1338-1342`, `egress/boot.ts:143-160`, `egress/networks.ts:129`.
- **Family:** box daemon.
- **Class:** GAP (security). **Agent:** yes. Refuse to start live apps while the fence is down, as the gVisor gate already does.

### B-3. GA close-out item 2: the burn-time LUKS passphrase is still live
- **What:** `BURN_PASSPHRASE` (`flagship-build-time-luks-rekey-me-immediately`) is still set, and the `luksRemoveKey` is wrapped in `if false; then`. Every USB or installer-ISO box keeps a LUKS slot with a publicly known passphrase.
- **Not affected:** VM appliances. `appliance.ts:146` removes the factory key.
- **Where:**
  - `packages/flagship-builder/src/userdata.ts:513`, `:1678`
  - vendored engines: `packages/flagship-builder/engine/preseed-engine.js`, `apps/builder-mac/.../Resources/preseed-engine.js`, `apps/mobile/android/app/src/main/assets/preseed-engine.js`
- **Family:** builder and every installer.
- **Class:** DEFECT (security). **Agent:** yes, at the owner's go. Flip the guard, regenerate the engines and golden vectors, update the tests. Existing boxes keep the slot.

### B-4. GA close-out item 1: the prod-wipe script's table list has drifted
- **What:**
  - The guard is done (`4b38ac73d`, `c3f11a0c9`).
  - `server_health` (migration 0084, per-server data) is missing from the DELETE list.
  - The newer tables (`rate_limit_log`, `inference_settings`, `model_capabilities`, `adapter_insights`) are neither wiped nor listed as preserved.
  - The sync test checks only hand-picked tables.
- **Related defect:** nothing ever deletes `server_health` rows (`packages/storage/src/d1.ts:3469/3477` only write and read them), so server Delete and account Delete leave the row behind.
- **Where:** `scripts/wipe-all-users.sh`, `scripts/wipe-all-users*.sql`, `scripts/wipe-all-users.test.ts:167`.
- **Family:** .com and scripts.
- **Class:** GAP and DEFECT. **Agent:** yes.

### B-5. GA close-out item 3: demo and dev leftovers
- **What:**
  - The webapp `?debug=1` sticky developer tools: `apps/web/public/webapp/app.js:266`, `views/orders-debug.js:170`.
  - The public phone simulator at `/dev/create-server`, `apps/web/public/dev/create-server.js`. It calls `/api/build-tickets/issue` (table dropped in 0033) and the now admin-signed `/api/auth-code/issue`, so it is broken in public.
- **Already safe:** the native mock and developer toggles are debug-only. Demo accounts must stay, because review uses `playstore-test-0725`.
- **Family:** webapp and .com static site.
- **Class:** GAP. **Agent:** yes.

---

## 2. Should-fix, agent can fix in software

| id | Bug | Where | Family | Evidence it's still open | Agent |
|---|---|---|---|---|---|
| S-1 | **No push when an AI build chat needs the owner.** `notifyOwner` only logs and queues to the AlertInbox, which the phone drains only while open. An IDE/MCP `request_env_var` doesn't even reach the inbox. A build stalls silently while the phone is closed. | `packages/server-daemon/src/index.ts:2496-2513` ("push fan-out wiring is operator-supplied"), `:2631`; `docs/build-modes.md` "Remaining work" | box daemon and .com push relay | code read | yes |
| S-2 | **No per-app disk quota and no Postgres role limits.** There is no prjquota, no `CONNECTION LIMIT` and no `temp_file_limit`, so one app can fill the disk or starve the shared Postgres. Related: app copy has no bundle-size cap and no free-disk check. | `docs/app-runtimes.md` §5.3 / phase 5 (nothing in `server-daemon/src` or `installer`); `appCopy/target.ts:237,324-333` | box daemon | grep finds nothing | yes |
| S-3 | **Git and IDE builds are lost on any daemon restart, including the restart an update causes.** All their state lives in in-memory Maps. | `packages/server-daemon/src/buildmodes/buildOrchestrator.ts:338-353` | box daemon | code read | yes |
| S-4 | **Backup and Migrate leave out the Forgejo repos, and Migrate now always wipes the old box.** IDE/git-mode users lose their repos when they Migrate. AI-built apps survive, because the archive carries their working tree. | `serverArchive/build.ts:96-102` (`ARCHIVE_EXCLUDES`), `docs/server-backup-and-clone.md:56` | box daemon | code read | yes |
| S-5 | **Orphaned dev dataspaces are never swept.** A restart in the middle of staging leaves the dev DB and the `flagship-devfiles-*` volume behind, a disk leak. Any fix must keep dataspaces that still back continuable chats (30 days). | `buildmodes/staging.ts:240-249` (`sweep()` removes only `flagship-stg-*` containers) | box daemon | code read | yes |
| S-6 | **Share screens tell co-managers they need an invite.** Every members-only app shows "Members only. You need an invite to use this app.", although the box counts an active share as a co-manager at Manager rank. This item is not in AGENTS. | `apps/web/public/webapp/views/shared-server.js:212`; iOS `ShareServerScreens.swift:801,878`; Android `SharedAppScreen.kt:172`, `ShareServerScreens.kt:916`; box `accessPrincipals.ts:13,228` | webapp, iOS, Android | code read | yes |
| S-7 | **Cross-box gossip never reaches a sibling.** The box POSTs to `https://broadcast--<user>.<apex>` on :443. The SNI router has no case for it and destroys the connection; the handler is only on :8443; prod has no DNS for it. Per-app leadership never forms. Each box claims `leadsServices`, so `.com` `appHome` follows the latest heartbeat: the app's canonical and voi.ci links flip between boxes and ignore the server order. One-list no longer depends on gossip (`3ce20fb28`). | `server-daemon/src/gossip/index.ts:193-194`; `apps/web/src/tunnel/sniRouter.ts:178-196`; `apps/web/src/server.ts:356-361`; `control-plane/src/serviceRename.ts:274-280` | .services hub and box | code read | yes, by carrying gossip over the tunnel WS or the :8443 host (the literal design needs owner cert and DNS work) |
| S-8 | **Android Settings → Recovery "Restore from cloud" throws away the recovered key.** It decrypts the UMK, discards it (`// TODO: persist seed into Keystore`), and still toasts success with "Re-pair your servers next". | `apps/mobile/android/.../ui/screens/RecoveryScreen.kt:241` | Android | code read | yes (remove it, or route it to the real recovery flow) |
| S-9 | **The public docs page shows the literal word "TODO"** (manifest reference, recovery flow, API reference). | `apps/web/public/docs/index.html:231,243,249` | .com static site | grep | yes |
| S-10 | **The iOS model menu has no group for a key typed but not saved.** A reopened chat on such a key finds no group. The webapp has `UNSAVED_GROUP`. | `apps/mobile/ios/Sources/FlagshipUI/ViewModels/ModelGroups.swift:44-50` vs `apps/web/public/webapp/lib/modelGroups.js:46-56` | iOS | code read | yes |
| S-11 | **You can't remove one person's join from a group invite.** The only options are per AID (the whole person on that box) or the whole invite; no grant-revoke order exists. | `docs/service-access-gating.md:171-173`; `protocol/src/appAccessOrders.ts:14,24` | box, protocol, all 3 apps | grep | yes |
| S-12 | **Co-managers, and guests raised to Manager, can't invite.** This conflicts with the Conventions rule "invite rights come from being manager-class". | `docs/service-access-gating.md:269-272` | .com, box, clients | spec plus code | yes, after an owner design decision (`.com` mustn't learn who shares with whom) |
| S-13 | **Repo-adapter submit/complain endpoints have no rate limit.** Three anonymous complaints retire an adapter. | `apps/com/src/adapterIndex.ts:660`; no entry in `apps/com/src/rateLimit.ts` | .com | grep | yes |
| S-14 | **Restricted devices never receive the directory/profile key.** The libraries exist in all ports, but nothing builds, publishes or opens a grant, so account names stay undecryptable on restricted devices (a shipping mode). | webapp `lib/directoryKeyDelivery.js:104` (no importer); Swift `AccountDirectoryKeyGrant.open` (no caller) | all clients | grep | yes |
| S-15 | **The webapp and remote hosts serve the SPA/marketing HTML for a missing `.css` or `.js`.** The apex has the guard (`dc785fbf2`); content hashing was never done. Mid-deploy unstyled flash. | `apps/com/src/route.ts:1552-1566` vs `:933-948` | .com | code read | yes |
| S-16 | **Box journals are volatile** (`/run/log/journal`). A crash loop leaves no log on disk, as in the home2 forensics. | no `Storage=persistent` in builder or daemon | builder and box | grep | yes |
| S-17 | **LAN-direct is merged and on by default on `main`.** `launch-mvp.md` says it is kept off `main` for launch, and it has never run live. | `packages/server-daemon/src/index.ts:1197-1199` (`FLAGSHIP_LAN_DIRECT=0` opts out) | box, iOS, Android | code read | yes (default it off), but the owner decides |
| S-18 | **Relay-trust enforcement is off** (`FLAGSHIP_RELAY_TRUST_ENFORCE`). The blessing check is never called on the tunnel connect path. TLS is still end to end. | `server-daemon/src/relayLockdown.ts:372`, `relayBlessing.ts:20` | box | code read | partly (the code yes; validation steps 7-9 need a canary box) |
| S-19 | **The release scoreboard is red for fixable reasons.** (a) Parity: the 14 signed-tag gaps are all dead code or by-design, not functional defects, so allowlist them with reasons or delete the dead code. One latent mismatch: iOS BAK uses `flagship/bak/v1|<id>` (`Keystore.swift:353/784/831`) where protocol and web use `flagship.bak.v1`; nothing seals to a BAK today. (b) `parity/features.json` is stale (5 "missing" entries whose anchors match, Android share-server, Studio versions, removed `/qr` rows). (c) `feat/marketplace` has 15 rebase conflicts. | `scripts/parity-check.mjs`, `parity/features.json`, `scripts/rebase-features.sh` | tooling | today's `npm run ready` | yes |
| S-20 | **Debian 13.7.0 re-pin not done.** 13.6.0 is still fetched from `cdimage/archive/`, and the gym has no `_ARM64` manifest. | `apps/com/wrangler.toml:288,293`; `distros.ts:53,69`; `wrangler.gym.toml:171` | builder and .com | grep | the edit yes; validation needs a metal USB install |
| S-21 | **Minimum-OS rule not applied.** Android is at `minSdk 28` (Android 9, out of security support); Mac Studio at macOS 14. | `apps/mobile/android/app/build.gradle.kts:31`; `apps/builder-mac/Package.swift:7` | Android and Mac Studio | grep | yes, once the owner decides |

---

## 3. Later: outside MVP scope, cosmetic, or by design

| id | Bug | Where | Agent |
|---|---|---|---|
| L-1 | A box-internal mode change (an AI app deployed members-only) isn't journaled to the app's other servers | `server-daemon/src/index.ts:2437-2444` | yes |
| L-2 | App copy of a digest-pinned image loads untagged, so the copy fails cleanly | `appCopy/ops.ts:162-163`, `target.ts:343-347` | yes |
| L-3 | A source restart mid-copy fails the copy and needs a new signed order | `appCopy/source.ts:93,273,302` | yes |
| L-4 | Android sends the saved Flagship default model unchecked. `.com` falls back to the default model, so a stale choice doesn't fail | `VibeCodeScreens.kt:402-414` | yes |
| L-5 | Builds can push repo code out through an allowed (writable) registry | `egress/policy.ts:49-80` | yes (app-runtimes phase 2) |
| L-6 | Egress approvals are per service, not per image | `protocol/src/appAccess.ts:16` | yes |
| L-7 | App roles can count the box's databases via `pg_database` (the names are opaque) | `dataLayer/realAdmins.ts:60-64` | yes |
| L-8 | The app-detail `members` field is stale and dead; `inviteHandler.ts` and `serviceAccessGate.ts` are unwired | `screens/screensHttp.ts:1552,1585-1596`; `index.ts:4391-4440` | yes (delete them) |
| L-9 | Non-admin device keys are UMK-derived, so ranks between one person's devices aren't enforceable | `protocol/src/accountMetadata.ts:12,96` | yes (large) |
| L-10 | The webapp build chat has no transcript cap and no "Jump to latest" | `views/vibe-code.js` | yes |
| L-11 | Peer backup never deletes replaced chunks on peers (no `PB_DELETE`) | `backupLoop.ts:175` | yes |
| L-12 | Peer-backup shards of the old name aren't carried by Backup/clone | `serverArchive/build.ts:100` | yes |
| L-13 | The webapp Migrate gate reads backup enrolment from create-time state | `lib/serverReplacement.js:164` | yes |
| L-14 | Migrate needs a same-account peer, so a one-server owner can't Migrate (the UI says so) | `views/server-detail.js:2229` | design |
| L-15 | `.com` doesn't check the granting device against the roster for a trust exception; the box re-checks | `control-plane/src/serviceBlessing.ts:143` | yes |
| L-16 | Qwen sometimes asks its questions as plain text and deploys with no manifest. Low (Qwen) is now off | box build loop | yes |
| L-17 | iOS/Android show raw store names and no Files size, although the box serves `GET /data/files/:id` | `server-daemon/src/httpApi.ts:487` | yes |
| L-18 | Gym: `order-update` hard-codes the prod apex; the `update` group only moves boxes backward | `control-plane/src/demoUsers.ts:63-64`; `tools/live-e2e/groups/update.ts` | yes |
| L-19 | `release-studio.sh` assumes wrangler is on PATH | `scripts/release-studio.sh:72` | yes |
| L-20 | Test hygiene: iOS tests `XCTSkip` on a failed precondition, hiding real failures | `AdminRootPhase3Tests.swift:654`, `OpenAccountViewModelTests.swift:197`, `RealAccountLoginViewModelTests.swift:271,445` | yes |
| L-21 | Native UI tests for rename, managed override and lock/unlock were never replaced | iOS and Android UI tests | yes |
| L-22 | Obsolete plaintext display-name fixtures in tests; CAA `iodef` TODO | `services-zone/src/caaPin.ts:36` | yes |
| L-23 | The Play upload cert is not in `assetlinks.json`, so passkey recovery fails on a sideloaded APK only | `apps/web/public/.well-known/assetlinks.json` | yes, if wanted |
| L-24 | Design limits: a late wipe after take-over needs the old daemon to run; ending an unlock share doesn't rotate the disk key (warned in the UI) | `decommissionConsumer.ts`; `docs/share-a-server.md` §10 | design |

---

## 4. Needs the owner (hardware, YubiKey, store, money, accounts)

### Blockers

| id | Item | Notes |
|---|---|---|
| O-1 | **CA endorsement lease expires 2026-11-05T19:31Z** | Mint with the YubiKey, commit, redeploy `.com`. After it lapses every CA-chain check fails closed. |
| O-2 | **Endorse a box release** | The newest is `c9ce3d9b` (10-14), with about 35 daemon commits after it. Missing on boxes until then: backup/clone, Activity, Migrate-wipe (`72e889fd`, `8139913f8`, `cbbae854c`), Back up now, account members and admin-only orders, one-list (`c0fb70691`, `3ce20fb28`), share push and co-manager update, continue-chat, paired-session `kind`, restore from the admin root only (`c1b2f98ca`), the knock page (`7e0271ed`). YubiKey. |
| O-3 | **iOS and Android store builds** | Read tokens already return 401 on `/pods`, `/stream` and the others for real accounts, so the current store builds have broken live status today. Order rule: store builds before the next `.com` deploy (shell v116), or the store apps can't create servers (`add-server-admin-only`). Take a version code above 8 on Play and a build above 4 on iOS. Wear OS needs the Play form factor and the watch APK. |
| O-4 | **Flagship Inference isn't live** | Pick the provider, deploy the shim with `UPSTREAM_*`, `FALLBACK_API_KEY` and `FLAGSHIP_INFERENCE_TOKEN_SECRET`, and set `FLAGSHIP_INFERENCE_ENDPOINT` on `.com`. Also: `.com` is behind `main` (live shell v114, `main` v116). |
| O-5 | **`flagship.services` zone capped at 200 DNS records, shared with prod** | Per-box A/AAAA plus wildcard plus per-user CAA means roughly 25-35 accounts fill it, and then every new box fails DNS-01 ("Record quota exceeded"). Needs a paid plan or a zone split. An agent could only reduce the records per box. (`apps/com/src/gymCloud.ts:111`, `docs/runbooks/gym-test-env.md:66`) |
| O-6 | **Guest memory corruption in Studio VMs is undiagnosed** | home2 ext4 oopses; leticia's zeroed packages still failed checksums after repair on `57b69edb`. The disk caching fix is in, but the memory balloon is still attached (`VZHost.swift:131`). Needs Mac soak runs; an agent could prepare a no-balloon A/B build. |
| O-7 | **"Proven on real hardware" (launch-mvp)** | A phone-created box on current code: phone unlock, SWK, pairing and entitlement deposits, update from the webapp and Android (only iOS has been validated), then Delete, Revoke and Un-revoke. Lost-phone recovery and Phase B re-pair. Postgres plus a backup restore (`appCopy/ops.ts` docker save/load and pg_dump/restore only have fakes). The three app runtimes and a non-root `/data` write on a real box. |
| O-8 | **iOS defects that need a device** | The jetsam crash after about 14 min, and the input delay on "I already have an account". Both undiagnosed. |
| O-9 | **GA close-out item 6: quiet the box console** | First diagnose `journalctl -b -p warning` on a real box. |
| O-10 | **GA close-out items 1-3 and 5** | Software fixes are listed above (B-1, B-3, B-4, B-5). AGENTS says "do NOT do in dev", so they need the owner's go and, for B-3, a reburn. |

### Should-fix and later

- **Share this server:** start-up push, co-manager update and share-key sign-in, never run on a device or a real box.
- **Never run on a device:** server order, continue chat and provider switch, Remote QR-first, Wear OS, Android widgets.
- **Windows and Linux Studio:** never run on real PCs, and the Windows zip is unsigned (needs a code-signing certificate).
- **Debian 13.7.0:** USB install on metal before the re-pin (S-20).
- **iOS store settings:** confirm the export-compliance answer (`ITSAppUsesNonExemptEncryption = NO`) and the "iPhone and iPad Apps on Apple Silicon Macs" toggle.
- **Rate limits:** run `npm run rate-limits` (never checked).
- **Adapters:** set `ADAPTER_REVIEW_ANTHROPIC_KEY`.
- **Cleanup:**
  - tear down `drill-1010`
  - delete and recreate home2, and mark `secret_mailbox` rowid 13 consumed
  - delete the 5 Hetzner orphans
- **Appliances:** confirm the published `52d0b375` images contain `10-flagship-containers.network` (they should, since `e81df698` is an ancestor), then rebuild when `main` moves.
- **Decisions:** the minimum-OS floors (S-21), LAN-direct at launch (S-17), and co-manager invite rights (S-12).

---

## 5. Dropped as already fixed (verified)

| Item | Fixed by |
|---|---|
| Memory `bug_daemon_restart_always`: daemon unit uses `Restart=always` + `StartLimitIntervalSec=0` | `userdata.ts:853`, `demoCloudConfig.ts:391`, `late-command.sh:246` |
| Memory `bug_vm_initramfs_virtio_net`: hook adds `virtio_net`, `virtio_pci`, `virtio_mmio`, `e1000`, `e1000e` | `userdata.ts:1757` |
| Open work 14: the wired unlock log persisted to FLAGSHIP_BOOT; the stalled-boot advisory on Linux and Windows | `3920b9604` (`userdata.ts:1839`); `d2caeda05` |
| R0. The readiness e2e S11 failed with a 503 "read tokens aren't configured" because `release-readiness.mjs` started wrangler dev without `ACCOUNT_READ_TOKEN_SECRET` | `cd2dcffd6` (landed during the audit) |
| 12 web gym failures in the 10-15 01:10 run | all pass in today's 88/88; `web-total-greyed-action-toast` was removed in `d44de7946` |
| iOS install Live Activity never starting | `b7c49cbf0` |
| iOS DeepLink `/qr`; Android manifest `/qr` and trailing-slash routes | `671eda1ec` |
| Studio version anchors (Linux `BUILDER_VERSION`, Windows csproj) | `e2640f3f3` |
| Android SharedAppScreen (shared-server app rows not tappable) | `d12a21b87` |
| Android "Jump to latest" | present (`VibeCodeChatScreen.kt:702`) |
| iOS server order stuck at "No. 2" | `7ab43f61e` (still to check on a device) |
| "API keys aren't in the archive" | `8139913f8` (`serverArchive/build.ts:306`, `restore.ts:290`) |
| Docker containers unreachable on VM appliances | `e81df698`, inside the published `52d0b375` appliances, so "Republish both appliances" is stale |
| One-list leadership depending on gossip | `3ce20fb28` |
| Gym DNS leak | `779cb5775` (the cap itself is O-5) |
| Live-gym findings: boxes never online | `cfe8d838c` |
| Live-gym findings: admin-pinned invites never redeemable | `ad4e82463` |
| Live-gym findings: gVisor apps without DNS | `8f31506d9`, `9f7e9fbbf` |
| Live-gym findings: app backup "include user data" failing | `cbbae854c` |
| Live-gym findings: concurrent pairings returning 500 | `5e4d5d910` |
| Live-gym findings: Fly image not building | `6c86f8744`, `cf0469770` |
| One-list gym check that timed out in three 10-15/16 runs | green in `live-run-2026-10-16T00-50-30-999Z` |
| The rate limiter binding being inert in prod | `aaed1b0b8` (Durable Object limiter, live) |
| Build-cost measurement "mock only" | done (`3c49473af`, `1ebd17d15`) |
| Endorsement notes for `37ba277d`, `85d3e911`, `e408e136`, the ranks box changes (`de24d3a20`, `bb5b3b20a`, `5cf28ab12`) and the free-AI box side (`0b92d0ae1`, `77228149e`) | all inside the endorsed `c9ce3d9b` |
| `.com` prerequisites: migrations 0096, 0097, 0102, 0103 and shells up to v113 | deployed (`3e8fef1de`) |

**AGENTS.md lines that are now stale:**
- "Republish both appliances"
- "API keys aren't in the archive"
- "iOS's install Live Activity never starts"
- open-work 14
- the build-modes note that mobile apps have no attachment picker
- several "needs an endorsed release" notes for code already in `c9ce3d9b`
- "`.com` current as of 1ebd17d15 / shell v96": live is v114
