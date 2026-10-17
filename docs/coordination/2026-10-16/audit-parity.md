# Feature parity audit for the MVP release

- **Checked:** origin/main `71e74bdfe`, 2026-10-16. Read-only.
- **Range:** `git log b900b609b..origin/main`, 600 commits. iOS build 4 was cut at `b900b609b` and Android versionCode 8 at `fffcfb544`. No Android commits fall between those two cuts.
- **Method:** each feature was checked by reading the code in every family. Five parallel sub-audits did the reading, and I spot-checked the top findings. Paths are relative to the repo root.

Short forms used in the paths below:
- WEB = `apps/web/public/webapp`
- IOS = `apps/mobile/ios/Sources/FlagshipUI`
- SH = `apps/mobile/shared/Sources`
- AND = `apps/mobile/android/app/src/main/java/com/flagshipserver/app`

**Before reading the table:** nothing below is in a store build yet. Every iOS and Android change listed was committed after both store cuts, so the store apps have none of it. The webapp is current, with shell **v116** (`WEB/service-worker.js:266`).

Status key:
- **P** = present
- **Pt** = partial
- **M** = missing
- **DD** = deliberately different
- **na** = not applicable
- **dead** = the code exists but nothing reaches it

---

## 1. Matrix

### Adding servers, Home and the server page

| Feature | webapp | iOS | Android | watch/wear | Studio | Evidence / notes |
|---|---|---|---|---|---|---|
| Admin-signed AuthCode issue (`flagship/auth-code-admin/v1`, enforced by 71e74bdfe) | P | P | P | na | na: Studio never calls issue, register, RCK or claim | WEB views/create-server.js:614-640; IOS ViewModels/CreateServerViewModel.swift:433,449; AND CreateServerScreen.kt:1453-1473,1510. `.com` checks it in control-plane/src/authCode.ts:141-162 and serverRegister.ts:234-251 (the AuthCode bytes must be identical) |
| RCK registration signed by the admin root (no IRK fallback any more) | P | P | P | na | na | WEB lib/adminRoot.js:70 (SENSITIVE_TAGS); IOS CreateServerViewModel.swift:462; AND CreateServerScreen.kt:1455. Order differs: Android registers the RCK before issuing the AuthCode, the others after |
| Take-over claim names the acquirer's root and is admin-signed | P | P | P | na | na | WEB views/transfer-claim.js:176-182; IOS TransferAcquirerViewModel.swift:131-137; AND TransferAcquirerViewModel.kt:107-131 |
| Restore order signed by the admin root (c1b2f98ca) | P | P | P | na | na | WEB create-server.js:752; IOS :523; AND :1336. Android unseals the root twice (gap 21) |
| 403 `add-server-admin-only` shown as the app's own sentence | P | P | P | na | na | WEB lib/addServerGate.js:64-74; IOS AddServerRefusal.swift; AND NetworkErrorHumanizer.kt:67 |
| Client gate: the recipe must pin a root the device holds; demo accounts pin none | P | **Pt** | P | na | na | iOS Import-a-backup builds CreateServerViewModel without `isDemoAccount` (IOS Screens/ServerArchiveScreens.swift:196-202). Gap 1 |
| Add/Import a server menu (Create / Co-manage / Import), admin devices only | P | P | P | na | na | WEB views/import-backup.js:56-64, home.js:675,1207; IOS HomeScreen.swift:625-652; AND HomeScreen.kt:167-186,513. DD: the webapp also offers a "Take over" link; the phones take over only through a scanned or opened offer |
| Non-admin empty Home: "only an admin device can add servers" | P | P | P | na | na | Same copy everywhere |
| Server order: drag, `server-order/v1`, POST to boxes, Leader badge gray until the box confirms, Make leader, handle on the left, no numbers | P | P | P | wear follows the order | na | WEB home.js:945-1034, lib/serverOrder.js; IOS ServerOrderCard.swift, HomeScreen.swift:560,729; AND ServerOrderList.kt:227, ServerOrderSaver.kt |
| Order save refused (409) is explained | P | P | P | | | Worded three ways (gap 31) |
| Locked Home offers "Show my servers" | P | P | P | na | na | |
| Backup: two files with key slots, sized before start | **Pt** | P | P | na | na | The webapp hides the box's reasons, e.g. "needs about X GB" (gap 4) |
| Backup downloads: token link with Range in a browser; 4 parts + SHA-256 + resume on phones; browser download approval | P | P | P | | | SH FlagshipCore/ArchiveDownloader.swift; AND core/ArchiveDownloader.kt |
| Restore a backup onto a waiting server in one flow | P (error text: gap 4) | P (demo accounts: gap 1) | **P, equivalent** | | | AND ServerArchiveViewModels.kt:299-735 has the same steps and copy as iOS 097142897/37858b3fd and WEB import-backup.js:252-420 |
| One Backup / Migrate card, "a new machine / VM" | P | P | P | | | |
| Migrate always wipes the old server; Replace and Timeline removed | P | P (Replace is dead code) | P (Replace is dead code) | | | IOS ReplaceServerScreen/ViewModel and AND ReplaceServerScreen/ViewModel are unreachable (gap 33) |
| Activity: box log merged with account events; `server.state.corrupt` shown as a warning (9c7eaa219) | P | P | P | | | WEB lib/activityFeed.js:34; IOS ActivityViewModel.swift:135; AND BoxEventLabels.kt:37, ActivityScreen.kt:222 |
| Server page: monitoring, gVisor notice, offline / never online / not paired + Pair, delete / revoke / un-revoke, update + last update + /api/releases fallback, health, dead-man, lock/power, transfer QR, stays on its own server | P | P | P | na | na | |

### Apps, access and members

| Feature | webapp | iOS | Android | watch/wear | Studio | Evidence / notes |
|---|---|---|---|---|---|---|
| Account members list + admin-only `app-rank/v1` orders | P | P | P | na | na | WEB lib/memberRoles.js, views/service-access.js:713-815; IOS ServiceAccessViewModel.swift:242; AND ServiceAccessScreen.kt:323,508. The webapp heading has no "(n)" count |
| Open / Members-only mode and removal admin-only (`service-access-mode/v2`, `service-allow-remove/v2`) | P | P | P | na | na | The locked-mode line is worded three ways |
| Non-admin devices invite at Member with their own device key | P | P | **Pt** | na | na | Android `canInvite` shows "+ Add" while the box hasn't answered or lists no members (AND viewmodels/ServiceAccessViewModel.kt:187-193). Gap 5 |
| Withdraw only your own invites; "Invited by" | P | P | P | na | na | The "is it mine" tier rule differs a little in each app |
| One Face ID per admin invite | DD (no biometric on the web) | P | P | na | na | |
| `app-member-role/v1` retired | P | P | P | | | No client code uses it |
| App sign-in signs with the device key on own servers and the share key on shared ones | P | **Pt** | **Pt** | na | na | With no account device id on an own server, iOS and Android fall back to the global AID; the webapp refuses (WEB lib/knockIdentity.js:146-153). Gap 15 |
| Uninstall signed with the admin root, admin devices only | P | P | P | na | na | Demo accounts and wording differ (gaps 2 and 30) |
| Runs-on / app copy (`app-copy/v1`) gated to admin devices | P | **Pt** | **Pt** | na | na | Only the untick is gated. A non-admin tick is sent and then refused by the box (packages/server-daemon/src/appCopy/target.ts:148). Gap 3 |
| Access list (`app-access/v1`), access requests, suggested drafts | P (alerts cover the current server only) | P | P | na | na | Gap 13 |
| API keys / Database writes (`app-api-key/v1`, `app-db-write/v1`) | P | P | P | na | na | No app gates them to admin devices, but the box refuses non-admin orders (gap 6) |
| Per-app visitor id (`app-aid/v1`), `&s=` in invite links | P | P | P | na | na | |
| Status pill, "On N servers" as a number + server icon | P | P | P | na | na | |
| Recent logs; app "Back up now" with its data | P | P | P | na | na | Android shows the backup size in KB |
| Members-only line on shared apps | P | P | P | na | na | |
| One access list per app (c0fb70691) | na | na | na | na | na | Box to box only; no client part |

### Build chat and AI

| Feature | webapp | iOS | Android | watch/wear | Studio | Evidence / notes |
|---|---|---|---|---|---|---|
| Continue a chat, switch provider (`/reply`, canContinue, provider) | P | P | **Pt** | na | na | A chat that fails during generation on Android has no Continue: AND ui/screens/VibeCodeScreens.kt:575 (gap 9) |
| Model menu grouped by provider, effort only where listed, "older messages will be summarised" notice | P | P | P | na | na | WEB lib/modelGroups.js; IOS ModelGroups.swift; AND core/ModelGroups.kt use the same formula |
| Model menu + attachments on the FIRST message of a new build | P | P | **M** | na | na | AND VibeCodeScreens.kt:380-415 has neither, and it sends the saved default unchecked. Gap 8 |
| "used N credits"; CSV/JSON/PDF attachments | P | P | P (only after the chat starts) | na | na | |
| Long transcript collapsed + Jump to latest | **M** | P | **P** (features.json is stale) | na | na | WEB views/vibe-code.js:853-867 renders everything and forces scrollTop on every poll. Gap 7 |
| Flagship Inference: built-in provider first, can't be removed, disabled once ended, credits line, AI-key step skipped | P | P | P | na | na | No client hard-codes the lineup (3e8fef1de). The iOS mock catalogue still has Low as the default (AiModelsModels.swift:150-172) |
| `free-ai-too-long` and other mint refusals show the server's words | **Pt** | P | P | na | na | WEB lib/freeAi.js:198 always uses its own copy. Gap 23 |
| AI-needs-you chat opens on the server it belongs to | P | **Pt** | **Pt** | na | na | The phones open the session id on the current server, so it 404s after a server switch. Gap 10 |
| Answer the AI's env-var request (also when editing a live app) | P | P (sends no model) | P | na | na | Gap 25 |
| Build list: continue failed and ready chats | P (every server) | P (one server) | P (one server) | na | na | Gap 14 |
| Staged deploys, internet approval, AI relay switch per key; git import (name, adapt, share, report, get flagship.app.json); Edit this service; resume sessions; unique names / Invite only; add a key separately from choosing one | P | P | P | na | na | iOS DD: one terminal-style screen. Android: the Settings "Save on this device" toggle does nothing (gap 24) |

### Sharing, account and links

| Feature | webapp | iOS | Android | watch/wear | Studio | Evidence / notes |
|---|---|---|---|---|---|---|
| Share a server (`server-share/v1`): owner, accept, shared page, metrics | P | P | P | na | na | |
| Open a shared server's apps, incl. Database for "Can see app data" | **Pt** | P | **P** (features.json is stale) | na | na | AND SharedAppScreen.kt (d12a21b87). The webapp has no app page and no Database entry (gap 11) |
| Co-manager start-up push (`server-share-push/v1`), co-manager update (`server-share-update/v1`), house-key warning | P | P | P | na | na | Same copy everywhere |
| Settings: Lock + Sign out in one box, two-button Danger zone; Browser sessions show only `kind=remote` | P | P | P | na | na | |
| Push notifications switch | P | P | P | na | na | |
| Join another account while signed in | **Pt** (only by opening a link) | P | **P** (features.json is stale) | na | na | Gap 12 |
| 429 rate-limit sentence with retry time | P | P | P | na | na | At each app's network layer |
| Account read tokens on /pods, /stream, /audit, /apps/<id>/links | P | P | P | through the phone | na | |
| Remote QR-first (`remote-ticket/v1`) | P (browser side) | P | P | na | na | iOS requires a 16-byte sid; Android accepts 16-64 characters |
| https app links; nothing emits `flagship://` | P (by design: /join /share /transfer /access /invite) | **P** (features.json is stale) | **P** (features.json is stale) | na | P (`/builder?c=&k=`) | `/qr` no longer exists (route.ts:56); the derived check is 0 red |
| Sign-up retry, "Secure your account", demo detected from the account, account-alert links, per-category push text | P | P | P | na | na | |
| Audit kind labels | P | P | **Pt** | | | Android lacks `account-deleted` and `username-reclaimed` (gap 32) |
| Website look (v112+), strict CSP, no framing | P | **gap** | **gap** | na | na | CSP and framing are web-only by nature. The native colour tokens still use the old palette (gap 16) |

### Native surfaces, LAN and Studio

| Feature | webapp | iOS | Android | watch/wear | Studio | Evidence / notes |
|---|---|---|---|---|---|---|
| Home-screen widget | na | P (says "Pods") | P | | na | IOS: App/WidgetExtension/PodStatusWidget.swift:19,150. AND: companion/PodStatusWidget.kt |
| Install progress (Live Activity / ongoing notification) | na | P | P (DD: notification) | | na | iOS `onStart` is called now (InstallProgressBridge.swift:65), so the AGENTS.md line saying it is never called is stale. Android has no PendingPodWatcher (gap 19) |
| App Intents / Siri vs launcher shortcuts | na | P | DD (shortcuts, no spoken status) | | na | |
| Notification channels / actionable categories | na | na (no UNNotificationCategory) | P | | | |
| Watch: install timeline | | | | iOS P / Wear P | | |
| Watch: server list | | | | **iOS M** / Wear P | | Gap 18 |
| Watch: boxes waiting to unlock | | | | **iOS Pt** / Wear P | | The iOS watch fills its list only after the phone's Approvals screen loads (IOS Screens/SecretRequestsScreen.swift:128). Gap 17 |
| Watch: complication / tile | | | | iOS Pt (install phase only) / Wear P | | |
| Watch: approve a boot with the delegate key | | P | P | iOS P / Wear P | | The iOS "Quick approve" copy is wrong (AccountSecurityScreen.swift:186). The two apps match requests differently |
| LAN-direct | na (DD: docs/lan-direct.md:78) | P | P | | na | |
| Studio pairing, verify, burn, appliance hosting, resource plan, graceful stop/restart, stalled-boot advisory, "Unlocking…", disk cache, ISO prune, health readout, keep awake, remembered Wi-Fi, one-click Host here | | | | | Mac P / Win P / Linux P | Windows and Linux 0.1.3 match the Mac. The Linux stalled-boot copy is shorter |
| Studio version stamped from the release | | | | | **Mac M** / Win P / Linux P | apps/builder-mac/Info.plist:22 hard-codes 0.1.0. Gap 26 |
| Studio endpoints gated by 71e74bdfe | | | | | none | Studio only uses /builder-pipe, iso-manifest, order status/health and downloads |

---

## 2. Gap list, in priority order

### P0: broken flows a reviewer or a real account will hit

1. **iOS: Import a backup fails on a demo account** (S). Home offers Import, but `ServerArchiveScreens.swift:196-202` builds `CreateServerViewModel` without `isDemoAccount: app.isDemoAccount`. `AddServerGate.recipeAdminRootPin` then throws "Only an admin device…". The App Store and Play reviewer account `playstore-test-0725` is a demo account. Reference: IOS Shell/HomeTab.swift:676-683.
2. **Demo accounts are treated differently by the uninstall gate** (S).
   - iOS offers Remove on demo accounts (IOS Shell/ServicesTab.swift:572).
   - The webapp (`isAdminDevice`, WEB views/service-detail.js:228) and Android (`hasAdminRoot`, AND ui/screens/ServiceDetailScreen.kt:117) hide it.
   - Pick one rule, `isDemoAccount` or `!!profile?.demoServer`, as in WEB lib/addServerGate.js:18, and use it everywhere.
3. **iOS and Android: ticking a server under "Runs on" is not gated to admin devices** (S). A non-admin device sends the copy and the box refuses it on admin-pinned boxes. Reference: WEB views/service-detail.js:892-895 and lib/appPlacement.js:38. Fix in IOS ServicesTab.swift:570 / AppPlacementViewModels.swift:459 and AND ServiceDetailScreen.kt:279 (`onCopy`).
4. **Webapp: backup and restore errors lose their reason** (S). `humanError()` turns `BackupError` and `waitForBackup`/`waitForRestore` throws (they carry no `userMessage`) into "That didn't work. Please try again.". The owner never sees:
   - "needs about X GB"
   - "That passcode doesn't open this backup."
   - "<name> is waiting for a different backup."
   - the restore's own `reason`

   Files: WEB lib/serverBackupFormat.js:36-43, lib/serverArchive.js:95,246, views/import-backup.js:226, views/server-detail.js `openBackupDialog`. iOS and Android show these texts.
5. **Android: "+ Add" (invite) is shown before the box confirms this device's rank** (S). See AND viewmodels/ServiceAccessViewModel.kt:187-193. Reference: IOS ServiceAccessViewModel.swift:229-232 and WEB lib/memberRoles.js:206-212.
6. **All three: orders only an admin can sign are offered to non-admin devices** (M: three families × four surfaces). The box checks these under the admin root on admin-pinned boxes, so a non-admin device signs with the IRK and is refused:
   - Allow/Deny and Save list (access list)
   - Create API key
   - Database writes
   - the access-alert sheet

   Box checks: server-daemon/src/egress/approvals.ts:120-124, appApiKeys.ts, dataLayer/ownerDb.ts. Give these the same read-only "Only an admin device can…" treatment as uninstall.
7. **Android: the QR path hands the recipe out before `.com` accepts the server** (S). `qrRelay.deliver(...)` runs at AND CreateServerScreen.kt:540, before `registerControlPlane`. If `.com` then refuses the AuthCode, for example after a root rotation, the browser or Studio holds a recipe that can never register. iOS and the webapp issue the AuthCode first.
8. **Test tools are now refused by `.com` (403)** (S). These sign the AuthCode and RCK with the IRK and send no `adminSignature`:
   - `apps/builder-windows/e2e/mint-recipe.ts:84-142`
   - `tools/vps-e2e/src/runE2E.ts:130-175`

   71e74bdfe updated the smoke scripts and the dev simulator but not these two.
9. **Release blocker:** Android `app/build.gradle.kts:33` still has `versionCode = 8`, which Play has already burned, and wear is `1_000_008` (S). Bump both, and derive wear's value from the phone's.

### P1: parity gaps in features shipped for the MVP

10. **Webapp: long build transcript** (S-M). There is no cap or "Jump to latest", and every poll forces `scrollTop` to the bottom, so the owner can't scroll up while the AI works (WEB views/vibe-code.js:853-867). Reference: IOS VibeTranscript.swift + VibeCodeSessionScreen.swift:124-160, or AND core/VibeTranscript.kt + VibeCodeChatScreen.kt:295-304,702.
11. **Android: no model menu or attachments on the first message of a new build** (M). The saved default model is also sent unchecked (AND VibeCodeScreens.kt:380-415). Reference: IOS VibeCodeScreens.swift:150,177,284-335 and ServicesTab.swift:725-806; WEB vibe-code.js:660-690.
12. **Android: a chat that fails during generation can't be continued from that screen** (S). Add `failed` to the hand-off at AND VibeCodeScreens.kt:575.
13. **iOS and Android: the AI-needs-you push or alert doesn't name its server** (M). The chat opens on the current server, and 404s if the owner has switched servers. Reference: WEB lib/aiChatAlerts.js:47-66 and vibe-code.js:1278-1294 (`openVibeCodeSessionById`). Files to change: IOS PushNotifications.swift:99, AiChatAlertPoller.swift:111; AND push/FlagshipFcmService.kt:154, tabs/ServicesTab.kt:71.
14. **Webapp: no Database page for a "Can see app data" share** (M). There is no shared-app page at all; rows sit inline in WEB views/shared-server.js:210-235. Reference: IOS ShareServerScreens.swift:842-958 and AND SharedAppScreen.kt:196. The webapp could reuse views/app-db.js through the share client.
15. **Webapp: no Settings entry to join another account while signed in** (S). Today the only way is to open a /join link. Reuse the paste prompt at WEB views/bootstrap.js:249 and qrScanner.js. Reference: IOS SettingsScreen.swift:531 and AND SettingsScreen.kt:285-291.
16. **iOS watch: waiting boxes appear only after the phone's Approvals screen has loaded** (M). Publish them from the pods reconcile or the push path instead. Reference: AND companion/WatchBridge.kt:46 and CompanionSurfaces.kt:40-43. Align request matching at the same time: iOS needs the exact requestId, while Android matches the fqdn and checks expiry.
17. **iOS watch: no server list, and the complication shows only the install phase** (M). Reference: wear/.../WearMainActivity.kt:124 and companion/WatchProtocol.kt:129-154.
18. **Native colour tokens lag the website look** (M per platform). docs/design-system.md §2 and §9 say the phone apps mirror apps/web/public/tokens.css. They still use the old palette:

    | Token | Old (in the apps) | Website |
    |---|---|---|
    | Background | #FAFAF7 / #0E0F12 | #F7F6F2 / #0A0A09 |
    | Dark text | #F2F1EC | #ECE7D6 |
    | Muted | #6B6A63 | #555149 |

    Android's on-accent colour is pure white or black, which the doc bans. Files: IOS Theme.swift:34-57 and AND ui/theme/Tokens.kt:55-80.
19. **Webapp: access-request alerts come only from the current server** (M). iOS (ViewModels/AppAccessAlertCenter.swift) and Android (core/AccessRequestCenter.kt) ask every managed box. This may be deliberate, since each server needs its own session, but no code comment says so.
20. **iOS and Android: the build-sessions list covers one server; the webapp's covers all** (M). Reference: WEB lib/vibeSessions.js:213-240.
21. **Android: no background poller for pending installs** (M). iOS has `PendingPodWatcher` (IOS ViewModels/PendingPodWatcher.swift:133). On Android the ongoing notification and the Wear timeline advance only when a push arrives or a screen is open.
22. **iOS and Android: own-server sign-in with no account device id falls back to the global AID** (S). The webapp refuses instead, which fits the per-app identity rule better (WEB lib/knockIdentity.js:146-153). Files: IOS KnockAuthorizeViewModel.swift:148-151 and AND KnockAuthorizeViewModel.kt:113-114.
23. **iOS copy is wrong (S):**
    - "Quick approve from watch" says "without unlocking your iPhone", but the responder needs the app session unlocked (IOS Screens/AccountSecurityScreen.swift:186). Use Android's wording.
    - The widget and Siri intents still say "Pod" / "No pods yet" (App/WidgetExtension/PodStatusWidget.swift:19,150; App/Sources/Intents/FlagshipAppIntents.swift).

### P2: small differences and wording

24. **Webapp: free-AI mint refusals ignore the server's own text** (S). Change WEB lib/freeAi.js:198 to `r.body?.error ?? MESSAGE_BY_CODE[code]`, as the phones do.
25. **Android: Settings → AI keys "Save on this device" toggle does nothing** (S). Hide it as the build step does (AND AiKeyScreens.kt:594-597 vs :177).
26. **iOS: the env-var answer sends no model or credential**, while the webapp and Android send both (S). Files: IOS VibeCodeSessionScreen.swift:629-645 vs WEB vibe-code.js:1016-1023 and AND VibeCodeChatScreen.kt:548.
27. **Mac Studio version is never stamped** (S). Info.plist hard-codes 0.1.0 / build 1. Stamp it in scripts/release-studio.sh from the `studio-v` tag, as studio-release.yml does for Windows and Linux.
28. **Studio hard-codes `flagshipserver.com`** in the Mac and Windows pairing QR and in all three order status/health URLs, so a gym Studio pairs and reads against production (S).
29. **Studio, smaller (S):**
    - The Linux stalled-boot copy is shorter and has no detail-pane sentence.
    - Mac pairing has no retry backoff after a failed relay connect; Windows and Linux back off 5→60 s.
30. **Uninstall wording differs** (S):
    - Button: webapp "Remove app", iOS "Remove service", Android "Uninstall".
    - Dialog titles differ the same way.
    - Only Android explains why a non-admin can't remove an app.
31. **Smaller wording differences** (S each):
    - The 409 server-order message.
    - The locked-mode line.
    - "Account members" has no count on the webapp.
    - The webapp says "Leave <name>"; the phones say "Leave this server".
    - The webapp's shared page has no certificate-renewal line.
32. **Android, small:**
    - No audit labels for `account-deleted` and `username-reclaimed` (AND AuditLogViewModel.kt:64) (S).
    - Backup size shown in KB.
    - Restore may ask for Face ID twice (CreateServerScreen.kt:1336 then :1455) (S).
33. **Dead code to delete** (S):
    - iOS and Android ReplaceServer screens and view models.
    - Android PostRecoveryChoiceScreen.kt, RecoverFromWelcomeContainer.kt and core/RecoveryChoice.kt.
    - The signed-tag drift below.

### Deliberately different (no action)

- **Webapp has no:** watch, widgets, LAN-direct, boot approval, A′ cert pinning (`daemon-status/v1`), Studio pairing (`builder-sid/v1`), or per-invite biometric (it uses a PIN).
- **Webapp offers "Take over" on Home**; the phones take over only through a scanned or opened offer.
- **Each app's own form:**
  - iOS has one terminal-style build screen.
  - Android shows install progress as an ongoing notification and uses launcher shortcuts instead of App Intents.
  - Linux Studio stores Wi-Fi in plain text in a 0600 file when libsecret is missing.
- **Co-managing stays app-gated** (`.com` can't see the second account's root).

### Signed-tag drift (14 red in the parity check): none is a feature gap

| Tag(s) | Why it's red | Status |
|---|---|---|
| `boot/v1` | Phone signer with no callers; the server uses `boot-auth/v1` | dead |
| `voici-shorten/v1` | No client calls /api/voici/shorten | dead on both phones |
| iOS `swk/v1` | `deriveSWK` has no callers; the live SWK is the dotted `flagship.swk.v1` on all three | dead |
| iOS `outstanding-orders/v1` | `listOutstandingOrders` is never called | dead |
| Web `build-relay/v1` | The v1 relay answers 410 | dead |
| `acme-account-key-grant/v1` | Minted with no callers (open item 5) | dead |
| `bak/v1` | An extra unseal key tried only by iOS | legacy |
| `recovery/v1`, `recovery-acme-wrap/v1` | The webapp's recovery lives in apps/web/public/recovery/, which parity-check.mjs:629-633 doesn't scan | scanner blind spot |
| `daemon-status/v1`, `builder-sid/v1` | Phone-only features | deliberate |

Suggested action: delete the dead code, allowlist the deliberate tags, and add apps/web/public/recovery to the scan roots.

---

## 3. parity/features.json corrections

### Statuses that are wrong

| Entry | Surface | Now | Should be | Why |
|---|---|---|---|---|
| `build-chat-long-transcript` | android | missing | present | VibeTranscript.kt + "Jump to latest". The web "missing" is correct |
| `native-surfaces` | android | missing | present (DD) | Better anchors: companion/PodStatusWidget.kt "GlanceAppWidget", ProvisionNotifier.kt "setOngoing", CompanionShortcuts.kt "setDynamicShortcuts" |
| `watch-boot-approval` | android | missing | present | Add a `wear` surface. The iOS `watch` surface should be partial (gap 16) |
| `share-server` | android | partial | present | |
| `share-server` | web | present | partial | No Database for shares (gap 14) |
| `https-app-links` | ios, android | partial | present | The `/qr` reasons are stale. Drop "qr" from the title; add invite and /app/<route> |
| `join-another-account` | android | partial | present | |
| `join-another-account` | web | present | partial | Link only (gap 15) |
| `backup-clone-server` | web | present | partial | Gap 4 |
| `backup-clone-server` | ios | present | partial on demo | Gap 1 |
| `app-runs-on` | ios, android | present | partial | Gap 3 |
| `app-access-list` | web | present | partial (alerts) | Gap 19 |
| `push-ai-chat` | ios, android | present | partial for opening on the right server | Gap 13 |
| `build-chat-attachments` / `build-chat-models` | android | present | partial | Nothing on the first message (gap 11) |
| `studio-pairing`, `studio-host-here` | win, linux | partial | present | |
| `studio-graceful-stop` | linux | partial | present | |
| `studio-prune-isos` | win | missing | present | |
| `studio-prune-isos` | linux | partial | present | |
| `studio-keep-awake` | win, linux | missing | present | Anchor HostPower.cs "SetThreadExecutionState" and vm/host_power.py "systemd-inhibit" |
| `studio-wifi-credentials` | win | partial | present | |
| `studio-wifi-credentials` | linux | missing | present | |
| `studio-version` | mac | present | missing | Its anchor matches the hard-coded plist |
| `studio-version` | win | partial | present | |
| `studio-version` | linux | broken anchor | present | Anchor builder-linux/version.py "VERSION =" |
| `studio-burn-usb` | linux | | | The "xorriso undocumented" reason is stale |

### Weak anchors

Many anchors are just `"export"`, `"struct "` or `"fun "`, which prove only that a file exists. Affected entries:
- app-runs-on
- app-api-keys
- app-database
- app-access-list
- transfer-server
- server-page
- flagship-inference (web)
- join-another-account (web)
- account-read-tokens (ios)
- app-members-ranks (iOS and Android only match header comments)

### Entries worth adding

- add-server-admin-only (`auth-code-admin/v1` + the AddServerGate files)
- app "Back up now"
- sign-in key choice (device / share)
- invite-withdraw + "Invited by"
- members-only line on shared apps
- "On N servers" pill
- Push notifications switch
- Settings boxes + Browser sessions `kind=remote`
- share family decisions (start-up push, co-manager update, house-key warning)
- lan-direct
- watch glance (server list / waiting boxes / complication)
- install-progress surface
- first-message model menu

### Stale AGENTS.md lines

- "iOS's install Live Activity never starts: nothing calls `InstallProgressBridge.onStart`" is fixed by b7c49cbf0.
- Open item 14 says the stalled-boot advisory is Mac only; Windows and Linux have it.
- "Clients at parity (webapp shell v101)": the shell is now v116.
- The build-chat open items:
  - "iOS shows no group for a key typed but never saved" is moot, because iOS always saves the key at the build step.
  - "Android sends a saved Flagship default model unchecked" is still true (gap 11).
