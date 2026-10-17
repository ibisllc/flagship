# Gym coverage audit: every feature, every button, live end to end

Read-only audit of `main` at `71e74bdfe` (2026-10-16). Nothing in the repo was changed, and no tests, builds or live runs were started for this audit.

**Detailed inventories (one row per control, with file:line, the covering test and a suggested test for each gap):**

- Webapp: `/private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad/inv-web.md`
- iOS/iPadOS: `/private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad/inv-ios.md` (extraction scripts in `.../scratchpad/inv/`)
- Android: `/private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad/inv-android.md`

This file holds the summary, the coverage matrix by feature, the gaps per family, the live-tier gap analysis, known limitations, and a proposed live plan.

---

## 0. Headline

| | Webapp | iOS | Android |
|---|---|---|---|
| Screens / dialog groups | 89 groups (all 53 `#view-*` + dialogs/sheets) | ~98 (4 tabs, 59 routes, 27 sheets, 5 covers, 3 popovers) | ~70 screens + components, widget, shortcuts, notification, Wear |
| Interactive controls | 634 | 626 | 698 |
| Tapped/clicked and effect asserted | 160 (25%) | 58 (9%) | 48 (7%) |
| Only asserted to render | 55 (9%) | 52 (8%) | 18 (3%) |
| Uncovered | 419 (66%) | 504 (80%), plus 12 only in unregistered, live-only or screenshot tests | 632 (90%) |
| Registered gym scenarios | 88 (13 every-merge, 72 total, 3 quality) | 64 mock + 4 live | 41 (9 every-merge, 32 total) |
| Latest locked-gym result | 88/88 green (2026-10-16 readiness run) | not run in this window | not run in this window |

The control counts come from scripts and the test mapping was done by hand, so expect them to be a few off. The ratios are what matter.

**Six structural findings:**

1. **The live tier never drives an app.** All 13 live groups in `tools/live-e2e/groups` call the box and `.com` directly, with keys derived from the demo KEK. None of the clients' buttons run against a real box in `gym:total` or `gym:weekly`, because `gym:total` = `gym:locked` (`--mock-only`) + `shared-run.ts`.
   - The only app-driven live tests are the 4 iOS `GymLiveTests` (not run by `gym:total`, and the vertical slice is stale) and `apps/web/e2e/live/*` (separate configs; `webapp-live.spec.ts` is stale).
2. **The gym fleet uses demo accounts and demo boxes.** Demo accounts are exempt from several real-account rules:
   - admin-only add-server (`71e74bdfe`: "A demo account keeps the checks it had");
   - account read tokens ("demo accounts read without one").
   - Demo boxes come from the demo cloud-init. Root stays plaintext (`demoCloudConfig.ts` §4: "W13 demo path does NOT re-key root") and the entitlement is self-minted with the IRK private key. So phone-approval disk unlock, notify-to-start, co-manager unlock at boot, Watch approval and first-boot update never run live.
3. **"Every button" sweeps barely exist.**
   - Web: one dead-control sweep, on the build chooser only. It checks each control has an id and is enabled, and clicks nothing.
   - iOS and Android: no generic sweep at all.
   - Most web gym tests jump straight to a screen with `page.evaluate(enter*())`, so the navigation controls in front of it (Home server cards, Services app cards, most Settings rows) are never clicked.
4. **Mock tests check signatures with the wrong key in places.**
   - The web mock session holds no admin root, so `gym-servers` checks that the server order and the un-revoke are **IRK-signed** (`signedByIrk`). On an admin-pinned (real) account `.com` refuses exactly that; live `lifecycle` and `server-order` prove the refusal. Nothing in the mocks checks the admin-root signature on most sensitive orders.
   - The iOS mocks accept any signature, so iOS signing is checked only in unit tests.
5. **Registry drift.** Some tests run nowhere and some test what the app no longer does:
   - iOS: `test_importBackupOpensTheRestoreFlow`, `test_aServerWaitingForItsBackupOffersToSendIt` and `test_backupStartsWithThePasscode` exist but aren't registered in `tools/gym/src/suites/ios.ts`.
   - Android: `GymWatchTest#quickApproveFromWatchTogglesTheDelegateGrant` isn't registered in `android.ts`.
   - `GymLiveTests.test_liveVerticalSlice` will fail: it taps `home-add-server` and waits for `cs-name-field`, but that button now opens the Add/Import dialog, and only on an admin device.
6. **The gym env lags main.** The readiness run on 2026-10-16 shows the `gym` branch 76 commits behind `main`. The gym Worker runs the `gym` branch, but boxes install `GYM_INSTALLER_GIT_REF` (default `main`), so the Worker and the boxes run different code until `scripts/gym-refresh.sh` runs.

---

## 1. Coverage matrix by feature

Legend:

- **T**: a test taps or clicks it and asserts the effect.
- **R**: rendered only.
- **U**: covered only by a test that isn't registered.
- **–**: none.
- **✓**: a live group covers it.
- **P**: live coverage is partial.
- **n/a**: doesn't apply.

Test names are abbreviated. Web titles are in `apps/web/e2e/gym/*.spec.ts`, iOS methods in `apps/mobile/ios/App/UITests/`, Android methods in `.../androidTest/.../gym/`, live checks in `tools/live-e2e/groups/`.

### Shell, Home, account

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Four tabs, nav graph | T: quality nav-graph | T: GymEveryMerge tab tests, iPad sidebar tests | T: `fourTabsReachableFromBottomBar` | n/a |
| App lock (PIN / biometric) | T: pin-set, roundtrip, lockout, cleared-by-passphrase, change-current | T: `test_lockScreenTrapsOnLaunch`, `test_biometricLockScreenTraps` | – (BiometricLockScreen: 6 controls uncovered) | n/a |
| Brand tokens | T: brand-dna, token-conformance | – | – | n/a |
| Onboarding: create account to the end | – (every helper stops at the passphrase prompts; account-open POST untested) | R: `-smoke-onboarding` only | – (smoke mode always completes onboarding) | P: demo create via `/api/dev/sample-user/create`, not the app flow |
| Home server order: drag, keyboard | T: "home drag reorders…", "keyboard reorder reverts…" | – (handle is hidden from accessibility; needs a coordinate drag) | – (`home-server-handle-$id`, Move up/down actions) | ✓ `server-order` (signed order, .com refusal, both boxes acknowledge, reorder) |
| Make leader + Leader badge | – (`#make-leader-btn`) | T: `test_makeLeaderWaitsForTheServerToConfirm` | T: `makeLeaderWaitsForTheServerToConfirm`; confirmed badge never seen | ✓ `server-order` (leader acknowledges) |
| Leader hand-over when the leader goes down | n/a | n/a | n/a | ✓ `one-list` "the leader going down hands the role to home2" |
| Add/Import a server (admin only) | R: menu opens and its 3 labels are checked; no choice clicked | T: create + `test_nonAdminHomeHasNoAddServer`; U: import | T: Create + `nonAdminHomeHasNoAddServer`; Co-manage, Import, Cancel uncovered | – (`.com` refusal of IRK-only add-server, 71e74bdfe, never runs: the fleet is demo) |
| Create server form | T: form, name-invalid, advanced toggles | T: `test_createServerFullStepFlow` | T: reachable, advanced toggles | P: boxes come from demo/gym provision, not the app's recipe |
| Pod switcher | T | T | T | n/a |
| Offline / never-online / revoked server states | R: revoked only (offline, coming-up, never-online, not-paired, connecting never seeded) | T: offline, dead server | T: offline, dead server | – |
| Activity feed (box log merged with account events) | R: tab only | R: tab only (mock has no `boxActivity`) | R: title only | – |
| Settings: Sign out, Lock, Remove device, Delete account | P: greyed actions, last-device deletion ceremony | – | R: Sign out | – |
| Browser sessions (`kind: remote` filter, revoke) | – | – (mock already returns one remote and one device session) | – (row has no testTag) | – |
| Recovery: keyfile, cloud | T: recovery screen, keyfile export; flows s08, s10 | P (see inv-ios) | P | P: `apps/web/e2e/live/account-recovery.spec.ts`, gym branch only, not in shared-run |
| Devices: add device (SAS), trusted devices, promote to admin | T: add-device SAS, trusted-devices, promote toggle | T: promote toggle | – | P: `apps/web/e2e/live/device-add.spec.ts` and `two-device-pairing.spec.ts`, not in shared-run |
| Admin root state, rotate | T | T | T | – |
| TOTP | – | T: `test_accountSecurityTotpEnrollStages` | – | – |
| Maintainer-trust sliver and override | T | T | T | ✓ `core` (trust chain served under the gym CA) |
| Rate-limit 429 sentences | – | – | – (JVM `RateLimitedTest`) | – |
| Account read tokens | (unit) | (unit) | (unit) | – (demo accounts read without a token) |
| Join another account | P (see inv-web) | – | – | – |

### Server page

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Server page cards | T: various | T: `test_serverDetailRendersCards` | R | ✓ `core` (server-detail) |
| Update card + update order | T: "update card … orders the latest release"; other releases, Go back, Advanced, Check again, Send again uncovered | T: `test_updateCardOffersTheNewRelease`; sheet's `update-latest-btn` untested | R | P `update` (downgrade to an older endorsed release only) |
| Revoke, un-revoke | T: revoke-confirm, un-revoke (**IRK-signed**) | T: revoke sheet opens; un-revoke; reason picker and hold-to-confirm untested | – (only checked absent for a co-manager) | ✓ `lifecycle` (IRK refused, admin root accepted, DNS republished) |
| Delete server (wipe-now + release name) | T: typed-name gate | P: dead-server delete button; type-to-confirm untested | – | P `lifecycle` (name released; the wipe-now order and the box wiping itself are not checked) |
| Backup/clone server (sealed archive) | – (all 12 controls) | U: `test_backupStartsWithThePasscode` | – (22 controls) | – |
| Import a backup / restore onto a waiting server | – (9 dialog controls) | U: `test_importBackupOpensTheRestoreFlow`, `test_aServerWaitingForItsBackupOffersToSendIt` | – (needs a SAF stub + archive asset) | – |
| Migrate (always wipes the old server) | – (6 controls) | – (`sd-migrate-server`, `migrate-*`) | – | – |
| Transfer a server | T: offer, take-over claim, non-admin refusal | T: `test_transferOfferEntryOpensCeremony` | T | P `enforcement` (deterministic re-home authority proofs only) |
| Lock & power, dead-man | T: lock-power confirm | T: `test_serverDetailDeadManScreenOpens` | – | ✓ `core` (forged/IRK refused, admin root accepted); `one-list` (power restart/off) |
| Journal, front page | T | T: journal controls, front-page picker | – | ✓ `core` |
| Box inbox / awaiting-unlock approve | T: box-inbox | T: `test_boxInboxApproveCard`, `test_serverDetailAwaitingUnlockSurfaces` | T: `boxInboxApproveCard`, R: awaiting-unlock pill | – (no approve-mode boxes) |
| Watch quick approve | n/a | – (needs a paired-Watch seam) | U: `GymWatchTest` (the phone toggle); `:wear` has no androidTest | – |

### Sharing a server

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Owner: share sheet, link, QR | T: "share owner card and share sheet" | T: `test_shareServerOwnerSeesSharesAndConfirmsCode` | T: `shareServerOwnerSeesSharesAndConfirmsCode` | ✓ `share` (IRK grant refused, admin-root grant + acceptance) |
| Owner: confirm the code, change level, remove, unlock/app-data switches | – | – (the unlock/data toggles have no identifiers) | – | P `share` (revoke only) |
| Co-manager: accept a link, read the code | T: "member accepts a link…", non-admin refusal | – (`-smoke-share-route accept` exists, untested) | – | P (box-side only; `.com` inbox `POST /api/users/A/server-shares`, list, accept never run) |
| Co-manager: view vs manage levels | T: member home + shared page (one level) | T: `test_sharedServerCoManagerView` | T: `sharedServerCoManagerView` | P `share` (manage level only; the view level is never opened) |
| Co-manager: owner-only actions refused | T (cards absent) | T | T (Delete/Revoke absent) | ✓ `share` (builds, MCP, copies, server order, share admin all refused) |
| Co-manager: notify to start | – | – (`shared-startup-notify`) | – (`shared-notices-switch`) | – |
| Co-manager: update to an endorsed release | – (`#shared-release-btn`) | – | – | – |
| Co-manager: approve start-up | – | – | T: `shared-approve-startup` | – |
| Co-manager: leave | – | – | R | – |
| Co-manager signs into apps at Manager (share key) | – | – | – | – |

### Apps and members

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Services list + app page | T | T | T (list) | ✓ `core` (install, env, serve, uninstall) |
| Access control: Members only / Open to all | T: to members-only; back to Open uncovered | T: `test_accessControlModeAndRanks` | T: to members-only; back to Open uncovered | ✓ `gating` (v2 orders, knock page, 403 JSON, public routes, back to open) |
| Account members, ranks, refuse | T: 5 gym-apps tests | T: 6 tests (admin, non-admin, member-rank device, invited-by) | T: 5 tests | ✓ `invites` + `gating` |
| Invite at Member, withdraw your own | T: non-admin invite + withdraw/revoke | R (live-only, stale `GymLiveTests`) | T: add + create; withdraw uncovered | ✓ `invites` (DEMOTE, REFUSE, WITHDRAW, ADMIN INVITE at Manager) |
| Invite result: link, QR, copy, share, group invites | – | – | – | n/a |
| Invitee redeem screen (`#ir-accept` etc.) | – | – (no deep-link seam) | – | ✓ `gating` (protocol redeem under the per-app id) |
| Second admin device (admin grant) acting as master | – | – | – | – (`invites` uses one admin + one non-admin device) |
| One access list per app across servers | n/a | n/a | n/a | ✓ `one-list` (follower order reaches the leader, cross-box join, withdraw during a restart, hand-over). Rank orders across boxes not checked |
| Internet access requests + access list | T: allow/deny, editor review/save | T: alert allow/deny, not-now, pending allow from the page | T: same set | ✓ `access-lists` |
| Access list: Ignore, Dismiss suggestion, global alert sheets, old-box egress | – | – | – | n/a |
| Runs on (copy to another server) | T: tick copies, untick uninstalls (signed) | R: `test_runsOnListsServersAndServerPageListsApps` | R | ✓ `app-copy` (relay route only; the LAN route isn't asserted) |
| App API keys | T: create, secret shown once, revoke | T: create; revoke and scope uncovered | T: create; scope, Copy/Done, revoke uncovered | – |
| App database (read-only + signed write) | T: browse + signed write confirm | T: browse | T: browse | P `runtimes` (Database view read-only; `flagship/app-db-write/v1` never run) |
| App "Back up now" | T | – (the mock supports it) | – | ✓ `runtimes` (tar.gz with the Postgres dump and files) |
| Runtimes (python/node/static) under gVisor, Postgres 18, /data | n/a | n/a | n/a | ✓ `runtimes` |
| Enforcement controls (restricted mode, admin gate, invite revocation reaching the box, debug access, transfer re-home) | n/a | n/a | n/a | ✓ `enforcement` (6 checks) |

### Build and AI

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Build chooser, git verdict, MCP connect | T | T | R | ✓ `core` (real git-import verdict, MCP connect + `get_contract`) |
| AI build on a staging copy, owner privacy | T: needs-credential routing | R: `test_vibeCodeChatScreenRenders` | – | ✓ `ai-staging` (scripted stub model; nothing the model received names the owner) |
| Build chat model menu by provider, effort | P: per-reply model choice; effort only checked as absent; switching to a saved key's model uncovered | – (`vibecode-model-menu`) | – (JVM `ModelMenuComposeTest`) | – |
| Build chat attachments | T: staging + refusal | – | – | – |
| Continue a ready/failed chat + switch provider | – | – | – (JVM `ChatContinuationTest`) | – |
| Flagship Inference entry + credits | T: 3 gym-inference tests | R: `test_flagshipInferenceCreditsInAiKeys` | R | – (no shim deployed for the gym; `FLAGSHIP_INFERENCE_ENDPOINT` is not set in `wrangler.gym.toml`) |
| Deploy / redeploy / discard from Build sessions | – | – | – | P `runtimes` (MCP build → finish → live) |

### Remote, LAN and native surfaces

| Feature | Web mock | iOS mock | Android mock | Live |
|---|---|---|---|---|
| Remote QR approval | T: 4 gym-remote tests (browser side); `#dock-restart` and the owner's Remote browsers screen uncovered | – (`companion-dock-*`) | – (`CompanionDockScreen`) | – (`device-add-relay-probe.ts` proves only the qr-pipe relay) |
| LAN-direct (lan-hint, box-to-box copy) | n/a | – | – | – |
| Widget, Live Activity, shortcuts, setup notification | n/a | – | – (JVM model tests only) | n/a |
| Push categories (deep links) | P: s11/s12 flows, "a notification opens the build chat…" | – | – | – |
| Studio (Mac/Windows/Linux) | n/a | n/a | n/a | – (no gym; Windows/Linux never run on real hardware) |

---

## 2. Uncovered controls and flows per family, with suggested tests

The full per-control lists are in the three inventory files; this section is the priority cut. "Harness" says how the existing seeds and fixtures would drive each test.

### 2.1 Webapp (`apps/web/e2e/gym/`)

Harness: the static server in `playwright.gym.config.ts`, `page.route()` stubs for `.com` and the box, sessions seeded through `/lib/state.js` imports, and `enter*()` helpers to open a view.

1. **Backup/clone, Import a backup, Migrate**: new `gym-archive.spec.ts`.
   - Seed an admin-root session (as `gym-servers` "Add or Import…" does, `9c409dc29`).
   - Stub `/api/screens/server-archive/*`, `/server-restore/*` and the migration endpoints on `.com`.
   - Drive Backup → passcode → start → link/download; Import → file chooser (`page.setInputFiles` with a small fixture archive) → Create → Send to waiting server; Migrate → start → hand-off/abort.
   - Assert the restore order is **admin-root-signed** (`flagship/server-restore/v1`) and the wipe order is staged.
2. **Add/Import menu choices**: in `gym-servers.spec.ts`, click each of the 3 choices and Cancel. Also assert the non-admin empty card `[data-home-empty-non-admin]`.
3. **Sign sensitive orders with the admin root**: in `gym-servers` (server order, un-revoke) and `gym-apps`, add an admin-root variant and verify against the admin root's public key with a `signedByAdminRoot` helper. Keep the IRK variant only for the demo-account case.
4. **Make leader** (`#make-leader-btn`, pill, "Waiting for it to confirm") and the **Update dialog** (other releases, Go back, Advanced commit, Check again, Send again / Forget it): `gym-servers.spec.ts`.
5. **Share, completing each side**: `gym-share.spec.ts`.
   - Owner: Yes-confirm the code, level select, start-up/app-data switches, Remove, Copy link.
   - Co-manager: notify-to-start toggle (assert a signed `flagship/server-share-push/v1` POST to `/api/server-shares/:id/push`), `#shared-release-btn` (assert a `flagship/server-share-update/v1` POST to `/api/shares/update`; a view-level share must hide it), Approve start-up, Leave (`/api/shares/leave` + `.com` leave), access Save.
6. **Members**:
   - In `gym-apps.spec.ts`: back to Open to all; an admin invites at Manager/Master; the invite result's link/QR/Copy/Share; group and approve-first invites; Finalize.
   - New `gym-invite-redeem.spec.ts` opening the `/invite#…` link to drive `#ir-accept`.
7. **Build chat** (`gym-inference.spec.ts`): continue a ready and a failed chat (`#vc-send` in reply mode → `/llm/sessions/:id/reply`), switch to a saved key's model (assert `credential` + `model` in the body), the effort picker `[data-mm-effort]` with a model that lists levels, the compaction notice, Deploy `#vc-deploy-go`, and reopen/Discard from Build sessions.
8. **Activity** (new `gym-activity.spec.ts`): stub `/api/screens/activity` and the account events; assert the merged order, per-server chips, "See all account history" and "View report".
9. **Rate limits**: one `test.describe` in `gym-quality.spec.ts`. Stub a 429 `{retryAfterSec: 720, error: "Too many tries…"}` on recovery lookup, pairing and TOTP, and assert the sentence shows.
10. **Settings**: Sign out with recovery set up, Remove this device, Delete account (ceremony up to Cancel), Browser sessions (assert only `kind: remote` rows and that revoke POSTs), TOTP, Profiles, Secured sessions.
11. **Home**: search, filter chips, the delete/backup buttons on never-seen, awaiting-backup and pending cards, "Show my servers", the recovery nudge.
12. **Every-button sweep (D7)**: extend `gym-quality.spec.ts` from the build chooser to a list of `enter*()` targets (every `#view-*`). For each view, click every visible non-destructive control (skip a deny-list of destructive ids) and assert no page error, no unhandled rejection and no dead handler.
    - This would have caught `#open-settings`, which `views/home.js:1851` wires but which doesn't exist in `index.html`.
13. **Stale tests and dead code to fix**:
    - `apps/web/e2e/live/webapp-live.spec.ts` (`#bootstrap-go`, `#bootstrap-passphrase` no longer exist);
    - the back targets of `#trusted-devices-back`, `#recovery-back` and `#paired-sessions-back`;
    - dead `views/audit-log.js`;
    - the `apps` router alias.

### 2.2 iOS (`apps/mobile/ios/App/UITests/`)

Harness: `-smoke-mode` + `-smoke-tab`, and `-smoke-username bright-maple` so server addresses match the mock box.

- Variants: `-smoke-awaiting-unlock`, `-smoke-dead`, `-smoke-revoked`.
- Seams: `-smoke-ops`, `-smoke-awaiting-backup`, `-smoke-admin-root`, `-smoke-locked`, `-smoke-no-recovery`, `-smoke-recovery-enrolled`, `-smoke-trust-untrusted`, `-smoke-access-alert`, `-smoke-access-fixture` (with `-smoke-non-admin-device` or `-smoke-member-rank-device`), `-smoke-shares -smoke-share-route owner|sheet|accept|home|member`, `-smoke-onboarding`.

Priority list:

1. **Register the 3 orphan tests** in `tools/gym/src/suites/ios.ts`. Then extend `test_backupStartsWithThePasscode` past `backup-passcode-saved` → `backup-start` → download/share (`GymTotalDetailTests`).
2. **Fix `GymLiveTests.test_liveVerticalSlice`**: launch with `-smoke-admin-root` (or the live equivalent) and call `chooseAddNewServer()` before `cs-name-field`.
3. **Home**: a coordinate drag on the row's leading edge for server order (the handle is hidden from accessibility; better, give it an id and a `.accessibilityAction` and test the Move up/down actions). Also the long-press context menu (Make leader, Send the backup, Delete server…), `home-co-manage`, and Add/Import Cancel. `GymOctoberTests`.
4. **Migrate** (`sd-migrate-server` → `migrate-start` → `migrate-hand-off` / `migrate-abort`): new `GymArchiveTests.swift`. Needs a scripted migration in the mock client.
5. **Import a backup**: needs a seam that bypasses the system file picker, e.g. a `-smoke-import-archive <bundle path>` launch arg that feeds a fixture archive to the import view model.
6. **Share**: `GymOctoberTests` with `-smoke-shares`.
   - Owner: Confirm, level change, Remove, `share-create`; add identifiers to the unlock/data toggles first.
   - Co-manager: `shared-startup-notify`, Update + confirm, Leave + confirm, the `accept` and `sheet` routes, shared app → Database.
7. **Members**:
   - Rank change `service-access-role-<id>` via its Picker.
   - Create an invite at Member in the mock (today it's live-only).
   - The withdraw/revoke dialogs.
8. **Access lists**: Deny/Ignore on the page, draft review/dismiss, editor Save.
9. **API keys** revoke + scope; **Database** paging, CSV export, SQL + write confirm; **Egress** allow/stop; app **Back up now** (the mock already serves it).
10. **Build chat**:
    - Needs a new mock with a second chat state (ready/failed with `canContinue`), to drive continue and `vibecode-model-menu` grouped by provider, the effort menus, attachments (file-picker seam) and deploy/redeploy.
    - Flagship Inference: `build-key-use-free-ai`, `free-ai-make-default`.
11. **Remote QR approval** (`companion-dock-*`): `XCUIApplication.open(URL("https://flagshipserver.com/remote?s=…&k=…"))` or the paste-a-link field, with a mock `/qr-pipe`.
12. **Settings**: Browser sessions revoke (the mock has both kinds; assert only the remote one is listed), Remove from account, the Delete account screen, the real Sign out dialog, Privacy toggles. The trusted-device menu needs a fixture.
13. **Update sheet** `update-latest-btn` + the pending notice; **runs-on** tick/untick; **Delete server** type-to-confirm; **Revoke** reason + hold-to-confirm.
14. **Activity**: add `boxActivity` entries to `DemoFixtures`.
15. **Watch quick approve**: a `-smoke-watch-paired` seam.
16. **Rate limits**: a `-smoke-rate-limited <endpoint>` seam that makes the mock client throw the 429 with `retryAfterSec`.
17. **Dead code**: `ReplaceServerScreen` has no call site.

### 2.3 Android (`apps/mobile/android/app/src/androidTest/.../gym/`)

Harness: `GymBase.launch()` sets the `flagship.smoke*` intent extras. `SmokeMode` then seeds the demo servers (Home, Office, Music offline), skips onboarding, unlocks, and forces the mock clients. It also sets `GymSeams` (admin root, device rank, biometric bypass).

- Seeds the tests never use: `podsVariant="awaiting-backup"` and `deviceRank` master/refused.
- Every test taps down from a tab. Nothing opens a screen directly.

Priority list:

1. **Add a `deepLink` parameter to `GymBase.launch()`** that sets `intent.data`; `MainActivity` already resolves `/app/<route>` and `flagship://`. That unlocks remote QR (`CompanionDockScreen`), accepting a share, the backup-download approval and the invite redeem without new fixtures.
2. **Register `GymWatchTest`** in `tools/gym/src/suites/android.ts`. Fix registry handles that are content descriptions (`sd-update-available`, `sd-delete-server`) or text (`service-access-mode-status`).
3. **Home**:
   - Drag the server order with `performTouchInput { longClick(); moveBy(...) }` on `home-server-handle-$id`, plus the Move up/down semantics actions.
   - The long-press menu (`pod-card-make-leader`, `pod-card-delete` → `delete-server-confirm`), Co-manage, Import, Cancel.
   - `GymOctoberTest`.
4. **Backup/clone, Import and Migrate** (`ServerArchiveScreens`, `MigrateServerScreen`): new `GymArchiveTest.kt`. Use the `awaiting-backup` seed; stub the file pick with Espresso-Intents (`intending(hasAction(ACTION_OPEN_DOCUMENT))`) returning a fixture archive from androidTest assets. Needs a scripted migration in the mock.
5. **Server page**:
   - Delete / Revoke / Un-revoke (seed `revoked`).
   - The Update sheet (`sd-update-server`, `update-latest-btn`, `update-order-btn`).
6. **Share**:
   - Owner: remove, code mismatch, per-share level/unlock/data switches.
   - Co-manager: `shared-notices-switch`, `shared-update-button/-confirm`, `shared-leave-confirm`.
   - Extend `MockServerShares` with a pending share and an update state.
7. **Members and apps**: back to Open to all, group invite, per-invite rank, `service-access-remove-*`, copy/share link; Deny/Ignore, the list editor, draft review; API key scope/Copy/revoke; DB paging, CSV, SQL; egress allow/stop; runs-on toggles; Back up now.
8. **Build chat**: model menu, effort, attachments (Espresso-Intents for the picker), continue a chat. Needs a mock chat with `canContinue`. Flagship Inference "Make default" and "Add own key".
9. **Settings**: Lock, Remove device, Delete account, the Sign out confirm, Browser sessions revoke. Add testTags to the Settings rows that have none ("Browser sessions", "Trusted devices", "Privacy", …).
10. **Activity**: tap entries. **BiometricLockScreen**: 6 controls.
11. **Rate limits**: a mock client 429 seam.
12. **Wear OS**: add an `androidTest` source set to `:wear` with a Compose test for `watch-approve`. **Widget and shortcuts**: a Glance `runGlanceAppWidgetUnitTest` and a ShortcutManager check.
13. **Dead code**: `ReplaceServerScreen`.

### 2.4 Cross-cutting harness work, in this order

1. Register the orphan tests, fix the stale live tests (`GymLiveTests` slice, `webapp-live.spec.ts`), and fix the registry handle mismatches.
2. Add seams: Android deep link; iOS `open(URL)`; a 429 seam in each mock client; box-activity fixtures; an admin-root web session for sensitive-order signature checks.
3. Write a generic every-button sweep for each family (web DOM sweep; iOS `app.descendants(matching: .button)` per screen; Android `onAllNodes(hasClickAction())` per screen). Give each a destructive deny-list, and assert no crash or toast error and that every control has an id.
4. File-picker stubs: Playwright `setInputFiles`, an iOS launch-arg seam, Android Espresso-Intents.

---

## 3. Live tier: what has landed since 2026-10-08 versus what the live groups check

The groups today: `core` (25 checks), `gating` (22), `invites` (14), `enforcement` (6), `server-order` (8), `runtimes` (9), `share` (6), `access-lists` (7), `ai-staging` (4), `app-copy` (6), `one-list` (6), `update` (4), `lifecycle` (4).

- Runs `live-run-2026-10-15T18-53-15-632Z` and `…T19-16-56-006Z`: about 11 minutes each, 3 boxes, all green.
- `invites` and `one-list` were green in a later run that isn't in this tree's `gym-results`.

| Feature | Live status | What's missing |
|---|---|---|
| Account members / ranks across devices | ✓ `invites` (admin + one non-admin device, IRK-signed device grant; demote, refuse, withdraw, admin invite at Manager) | a second **admin** device (admin-root-signed admin grant) acting as master; a co-managing account at Manager; a sign-in with the **share key** on a shared server; rank orders replicated across boxes |
| One list per app across two boxes | ✓ `one-list` | the CGK is deposited by the harness ("Gym boxes have no phone…"); hub gossip (`broadcast--<user>`) never forms (no TLS terminator, no DNS: open in AGENTS.md); rank orders and removals across boxes; a mode change made inside a box (AI deploy members-only) isn't handed over (known open) |
| Co-manager: view vs manage | P `share` (manage only) | a **view**-level share: refused updates, refused access edits; the `.com` share inbox (`POST /api/users/A/server-shares`, list, accept, leave, `share-ends` poll); B **leaves** |
| Co-manager: notify to start | – | needs an unlock deposit with `unlockAtBoot: true` + `POST /api/server-shares/:id/push`; the `.com` rule "kept only while the owner's unlock deposit names the same key" can be checked (deposit, register, rotate the deposit, the push row disappears); the actual push and unlock need an approve-mode box |
| Co-manager update | – | `POST /api/shares/update` with `flagship/server-share-update/v1`: view level refused, manage level applied (same endorsed-target limitation as `update`) |
| Co-manager invites at Manager | n/a (not built: "co-managers and guests at Manager don't invite yet") | — |
| Backup/clone server + restore onto a waiting server | – | build the archive on A1 (`/api/screens/server-archive/start`, `/link`, `/api/archive-download/<token>` with Range); provision a new box whose pairing carries an admin-root-signed `flagship/server-restore/v1`; check `awaitingBackup` on `/pods`; upload chunks, commit the key; the apps come up with Postgres rows and files; an IRK-signed restore order is refused (`c1b2f98ca`) |
| Migrate (always wipes) | – | migrate home2 → a fresh box; take-over rebinds the identity; the old STK is refused by the relay and hub; the old box reaches `awaiting-confirm` / wiped; leases are dropped |
| Server order / leader hand-over | ✓ `server-order` + `one-list` hand-over | leader **acknowledgement after a hand-over** in `/pods`; `orderIssuedAt` on heartbeats after a box restart |
| Admin-only add-server (`71e74bdfe`) | – | the fleet is demo, and demo keeps the old checks. Needs a **non-demo** account (as `recipe-provision.ts` builds): IRK-only auth-code → 403 `add-server-admin-only`; admin-signed `auth-code-admin/v1` → box registers; RCK with no IRK fallback; take-over claim needs admin |
| Build chat continue + provider switch, real model | – | `ai-staging` uses one scripted stub model. Add a second stub provider for a deterministic switch, and an opt-in **real DeepInfra** run (key at `~/.config/flagship/deepinfra-eval.key`): build → ready → `reply` with a new `model` + `credential` from another provider → runs again → deploys |
| Flagship Inference via the shim | – | no gym shim; `FLAGSHIP_INFERENCE_ENDPOINT` unset on the gym Worker. Deploy `flagship-inference-shim-gym` (upstream DeepInfra), mint `/api/free-ai/token` (`flagship/llm-promo-issue/v1`), build with no key, check the allowance drops (output weighted 4×), check `free-ai-too-long` and the daily cap (set a tiny `AI_PROMO_DAILY_CAP_TOKENS` on the gym) |
| App API keys | – | create (admin-root `flagship/app-api-key/v1`), call with `Authorization: Bearer fsk_…`, the app sees `X-Flagship-Visitor: api` + scope, read scope refuses POST, revoke → refused, IRK-signed grant refused |
| App DB write | – | `flagship/app-db-write/v1` signed write via the owner Database section; an IRK signature refused |
| LAN-direct | – | a phone on the box's Wi-Fi: impossible in the gym. What can be tested: `GET /api/screens/lan-hint` STK-signed (verify the signature); a box-to-box copy over UpCloud's private utility network (both boxes in de-fra1) → the copy records `route: lan`, falling back to relay. Worth checking that the boxes get utility IPs |
| Remote QR approval | – | fully protocol-drivable: the harness plays the browser (X25519, `wss://gym…/qr-pipe/<sid>`) and the phone (mint a companion ticket on A1, seal `flagship/remote-ticket/v1`); the browser redeems at `/api/companion/redeem`; the companion session can read but writes are 403 `companion-write-not-allowed`; the ticket is single-use; revoke |
| Rate-limit sentences | – | the gym has `RATE_LIMIT_SCALE=10`; e.g. recovery lookup cap 3/15 min × 10 → the 31st call returns 429 with `retryAfterSec` and the sentence; `totp-verify` 5 × 10; check `GET /api/admin/rate-limits` counted the refusal. Use a throwaway username so nothing else is locked out |
| Delete / revoke / un-revoke | ✓ revoke and un-revoke; P delete | Delete deposits the `wipe-now` decommission order before releasing the name: check the order exists and is consumed, the box stops answering and its STK is refused; also an IRK-signed release refused |
| Update via endorsed release | P (moves to an **older** endorsed release) | HEAD on gym boxes is unendorsed. Options: (a) a gym-only release-endorsement key under the gym CA pin on the `gym` branch, so gym-refresh can endorse a no-op child commit of HEAD and test a **forward** update; (b) keep the downgrade check. Also the rollback drill (a release that fails the boot health gate) and the update guard (power off mid-apply). `/api/dev/sample-user/<u>/order-update` assumes the prod apex (open) |
| Account read tokens | – | demo accounts read without one. Non-demo account: `/pods` 401 without a bearer; mint via device (30 days) / IRK (24 h) / STK (24 h) |
| Activity log | – | `/api/screens/activity` lists install, copy, update, share, backup, import, migration entries in order; `.com` account events `server-migration-*` |
| Settings / Browser sessions | – | `paired-sessions/list` returns `kind: remote|device`; revoking a remote session ends it |
| Box first-boot update, phone-approval unlock, Watch approval | – | needs an approve-mode box (see §5, "Approve-mode tier") |
| App-driven UI on a live box (any family) | – | see §5, "Live UI tier" |

---

## 4. Known gym limitations and flaky areas

**Fleet and environment**

- The boxes are demo boxes: demo cloud-init on UpCloud STARTER-4xCPU-8GB in de-fra1, plaintext root, entitlement minted on the box from an IRK private key handed over by `/api/gym/provision`. No recipe, ISO, appliance or Studio path, and no disk unlock.
- The accounts are demo accounts (`isDemo`). They are exempt from admin-only add-server, from read tokens, and (per `71e74bdfe`) from "the checks it had" on create/register/take-over. Every real-account rule goes unchecked live.
- The gym Worker runs the `gym` branch; boxes install `GYM_INSTALLER_GIT_REF` (default `main`). The 2026-10-16 readiness report shows `gym` **76 commits behind** `main`. Running live without `gym-refresh.sh` tests a skewed pair.
- **DNS budget**: the `flagship.services` zone is shared with prod and capped at 200 records. Leftover gym records once broke DNS-01 for prod. Teardown must always run; `gym-weekly.sh` sweeps as a net.
- `RATE_LIMIT_SCALE=10` on the gym (100 locally), so rate-limit checks must be scaled.
- No hub gossip between sibling boxes (`broadcast--<user>.<apex>` has no TLS terminator on :443 and no prod DNS). `one-list` relies on `access-sync` and a harness-deposited CGK.
- The `update` group can only move to an **older** endorsed release.
- No inference shim in the gym; `ai-staging` uses a scripted stub.

**Coverage and harness**

- No live UI tier in `gym:total`/`weekly`. `GymLiveTests` (4 iOS scenarios) is registered in `tools/gym/src/live.ts` but `gym:total` runs `--mock-only`.
  - These tests assume a simulator already signed in to `gymdemo`, with no account seeding, while the shared fleet makes fresh `ga…`/`gb…` accounts.
  - The vertical slice is stale (Add/Import dialog).
- Web live specs (`apps/web/e2e/live/*`) run under their own configs; `account-recovery.spec.ts` lives on the `gym` branch. `webapp-live.spec.ts` targets ids that no longer exist.
- iOS mocks accept any signature, and web mocks verify IRK signatures for orders that real accounts must sign with the admin root (see finding 4 in §0).
- Mock navigation shortcuts: web `enter*()` and Android/iOS tab-down navigation leave the entry controls unclicked.
- iOS: the server-order handle is hidden from accessibility, and system file pickers block import/attachment tests.
- Android: no deep-link seam, onboarding is unreachable in smoke mode, and `:wear` has no instrumented tests.

**Flaky or recently red**

- Web mock gym run `2026-10-15T01-10-49-388Z`: 12/53 failed (the PIN/argon2 tests, AI-key step, AI-keys manager, trusted devices, revoke confirm, git no-fit, needs-credential). These were timeouts, fixed by `ebdf452d5` ("Give each web gym scenario 90 seconds") and `5e96c880e` (seed `/pods`). The 2026-10-16 readiness run is 88/88. The argon2 PIN tests stay timing-sensitive under load.
- Webapp e2e flows (readiness 2026-10-16): `s11-wipe-restart.spec.ts` "happy path" fails with `read-token mint` → **503**, probably because `ACCOUNT_READ_TOKEN_SECRET` isn't set in the local wrangler dev environment. `s09` is skipped (manual QA only).
- Live timing hot spots:
  - `server-order` and `one-list` use fixed `sleep(45_000)` waits for 30-second rereads.
  - The `one-list` restart wait is up to 10 minutes; `update` is capped at 25 minutes.
  - A box that doesn't come up within 20 minutes skips every group that needs it, and the run exits 3 (inconclusive; weekly mode treats that as a failure).
- History: an earlier live slice was a false pass (agent memory, 2026-06-18). Several checks that don't throw still pass on `200` alone, so keep asserting effects, not status codes.
- Native gym: one simulator or emulator at a time (`491f28ad7`); the emulator plus image is about 2 GB on a tight disk. Neither native family was run in this audit window.

---

## 5. Proposed live plan

### 5.1 New and extended groups, all on `shared-run.ts`

| Group (phase) | Needs | Checks (each asserts the effect, plus the IRK/forged refusal where a signature is involved) |
|---|---|---|
| `real-account` (1) | R1 | Built from `recipe-provision.ts`: a fresh **non-demo** account with an admin root.<br>• An IRK-only auth-code issue is refused with 403 `add-server-admin-only`.<br>• An admin-signed `auth-code-admin/v1` registers R1.<br>• RCK registration has no IRK fallback.<br>• `/pods` returns 401 without a token; tokens minted by device, IRK and STK all read.<br>• The 429 sentence + `retryAfterSec` on recovery lookup (×10 scale), counted in `/api/admin/rate-limits`. |
| `api-keys` (2, after `runtimes`) | A1 | • Create a read and a write key.<br>• The bearer call shows `X-Flagship-Visitor: api` + scope.<br>• Read scope can't POST.<br>• Revoke → refused.<br>• An IRK-signed grant is refused.<br>• `app-db-write/v1` signed write lands; IRK refused. |
| `share` (extend) | A1, A2, B1 | • Share **A1 with B at view** and **A2 with B at manage** (no extra box).<br>• The `.com` inbox flow (create, list, accept).<br>• At view level, `/api/shares/update` and access edits are refused.<br>• At manage level, `/api/shares/update` to an endorsed release is admitted; reuse the `update` group's target.<br>• B signs into a members-only app on A2 with the share key and gets **manager**.<br>• `unlockAtBoot` deposit + `POST /api/server-shares/:id/push`: kept while the deposit names the key, dropped after a re-deposit.<br>• B **leaves** (box + `.com`), then the session ends. |
| `invites` (extend) | A1 | • A second **admin** device (admin-root-signed admin grant) signs in as master and issues a rank order.<br>• A co-managing account at Manager (via the share above).<br>• Rank orders replicated to home2 (fold into `one-list`). |
| `remote` (2) | A1 | Harness as browser and phone over `/qr-pipe`:<br>• Mint a ticket, seal `remote-ticket/v1`, redeem.<br>• A read works and a write is 403.<br>• Ticket reuse is refused.<br>• An expired code is refused.<br>• The owner revokes, then the session ends.<br>• `paired-sessions/list` shows it as `kind: remote`. |
| `ai-chat` (2) | A1, B1 | Extends `ai-staging`: two stub providers on B1.<br>• Build → ready → `reply` switching `model` + `credential` → runs again on its files → deploy.<br>• A failed chat continues.<br>• `canContinue` / `provider` / `conversationTokens` in state. |
| `inference` (2, opt-in `--real-ai`) | A1 | Needs a gym shim (`UPSTREAM` DeepInfra from `deepinfra-eval.key`) and `FLAGSHIP_INFERENCE_ENDPOINT` + `FLAGSHIP_INFERENCE_TOKEN_SECRET` on the gym Worker.<br>• Token pass, a keyless build on the default model to live, the allowance drops (4× output weight).<br>• A tiny gym daily cap pauses it with the shim's refusal; `free-ai-too-long`.<br>• Then one real-model chat continued with a BYOK DeepInfra key (provider switch).<br>Budget guard as in build-eval (stop at $1). |
| `archive` (3) | A1, then A3 | • Build the server archive on A1 (Range download, SHA-256 check).<br>• Provision **A3** with an admin-root-signed `server-restore/v1` in its pairing; an IRK-signed one is refused (`c1b2f98ca`).<br>• `/pods` shows `awaitingBackup`.<br>• Chunked upload with a resume test (restart A3 mid-upload), then commit the key.<br>• A1's apps serve on A3 with the same Postgres rows and files, and access state carried over.<br>• A3's activity log has the import. |
| `app-copy` (extend) | A1, A2 | Assert `route` (lan via the UpCloud utility network, else relay with a reason); verify the STK signature on `GET /api/screens/lan-hint`. |
| `activity` (8) | A1 | `/api/screens/activity` holds the install, copy, share, backup and update entries from earlier phases, in order, with no secrets in them. |
| `migrate` (9, before `lifecycle`) | A2, A4 | • Migrate home2 onto a fresh **A4** (migration recipe); take-over rebinds the identity.<br>• The old STK is refused by the relay and hub.<br>• Old box: `awaiting-confirm` → wiped (or powered off and wiped on restart); leases dropped.<br>• `.com` `server-migration-*` events.<br>• Leave A4 as the new home2 for `lifecycle`. |
| `lifecycle` (extend) | A4 (home2) | After release-name: the `wipe-now` order was deposited and consumed, the box stops answering and its STK is refused. |
| `update` (extend) | B1 | If a gym release-endorsement key is added on the `gym` branch: a **forward** update to an endorsed child of HEAD, a rollback drill (endorsed release that fails its health gate), and power-off mid-apply → the guard rolls back. |

### 5.2 Fleet shape

| Slot | Account | How it's made | Used by |
|---|---|---|---|
| A1 `home` | A (demo) | demo flow | core, gating, invites, runtimes, access-lists, api-keys, remote, ai-chat, inference, archive source, server-order, one-list |
| A2 `home2` | A | gym provision | server-order, one-list, app-copy, share (manage), migrate source |
| A3 `home3` | A | gym provision **with a restore order**, kicked off mid-run once A1's archive exists | archive |
| A4 `home2` (new) | A | gym provision with a migration recipe | migrate target, then lifecycle |
| B1 `home` | B (demo) | demo flow | enforcement, ai-staging/ai-chat stubs, share (co-manager), update |
| R1 `home` | R (**non-demo**, admin root) | recipe-provision style via `/api/gym/provision` | real-account |

That is **6 UpCloud boxes** (up from 3), at most 5 up at once (A2 is retired as A4 comes up).

Assumptions to verify:

- `/api/gym/provision` forwards a restore order in the recipe (otherwise add a gym-branch seam).
- The gym provisioning supports a migration recipe.

### 5.3 Run time and cost

- Today: about 11 minutes for 3 boxes.
- Projected wall time: **35–50 minutes**. Phase 1 as today (~11 min); A3 boots in parallel with phase 2 (~8 min); archive restore ~5 min; inference with a real model 5–10 min; migrate ~10 min; `update` forward ~10 min. Add ~10 minutes for `--real-ai`.
- Cost: about €0.036/h per box → **under €0.30 per run** in UpCloud, plus well under $1 in DeepInfra tokens. Build-eval measured a first build at 3–9% of the 474k-token estimate.

### 5.4 Live UI tier ("every button, live")

The protocol groups prove the backend. To prove the **buttons** end to end, add a `ui` phase after phase 2 that drives each client against the same fleet, account A, box A1. Keep it non-destructive except on a dedicated app slug.

1. **Webapp**: a Playwright project served from `webapp.gym.flagshipserver.com`.
   - Seed the session by importing A's demo UMK + admin root into the webapp state, as the mock gym does through `/lib/state.js` (gym-only).
   - Walk Home (order drag, Make leader) → server page (update card, journal, front page, share sheet to B) → app page (Members only ↔ Open, invite at Member, API key create + call it from the harness, Database, access list approve) → Build (Flagship Inference) → Activity → Settings (Browser sessions shows the `remote` group's session).
   - Assert the effects through the same box and `.com` endpoints the protocol groups use.
2. **iOS**: revive `GymLiveTests`.
   - Add a gym-only `-gym-live-account <username>` + seed launch argument (the app derives the keys the way `DemoFixtures` does from a test seed), so the test signs in to the fresh `ga…` account instead of `gymdemo`.
   - Fix the Add/Import step.
   - Run the same walk as the webapp.
   - Wire it into `shared-run.ts` as a group that shells out to `npm run gym -- live --surface ios`, with `GYM_LIVE_CONTROL_APEX` set.
3. **Android**: mirror with a `GymLiveTest.kt` using `flagship.smoke.liveAccount` extras pointing at the gym apex.
4. Drive the run with the cross-client parity list (`parity/features.json`, 53 features) so each feature has a live UI step on each family. Report the result with `npm run parity -- --report`.

Native live legs run one at a time (one simulator or emulator); budget ~15 minutes each.

### 5.5 Approve-mode tier (later, larger)

Phone-approval disk unlock, notify-to-start delivery, co-manager unlock at boot, Watch/Wear delegate approval and first-boot update all need a box whose disk is LUKS-sealed and asks `/api/boot/request`.

- Option: import the published VM appliance qcow2 (`flagship-iso/` in R2) as a custom UpCloud template, and add a `gym/provision` mode that seeds it with an approve-mode install blob.
- The harness then plays the phone: poll `/api/boot/share/pending`, unseal, sign `/api/boot/response`, including the `delegate` role for the watch key.
- One extra box (V1), about 10 extra minutes.
- This is the only way to cover these flows without hardware. Until it exists, they stay "validated on real devices only" (see AGENTS.md "Box-side changes").

### 5.6 Run order

1. `scripts/gym-refresh.sh` (the gym is 76 commits behind).
2. Register the orphan tests and fix the stale live tests.
3. Add the cheap protocol groups: `real-account`, `api-keys`, `remote`, the `share` extension, the `lifecycle` extension.
4. Add `ai-chat`, `activity` and the `app-copy` route check.
5. Add `archive` and `migrate` (need the fleet changes).
6. Deploy the gym shim, then `inference`.
7. The live UI tier, web first.
8. Gym release endorsement for a forward `update`.
9. The approve-mode tier.
