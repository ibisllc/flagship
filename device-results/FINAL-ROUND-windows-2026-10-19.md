# NO-GO

Release recommendation: hold the release. The Android/iOS device-pairing gap, passcode-backup zero-byte save, Studio restart-after-UAC bug, and first-boot unlock request anomaly remain unresolved or unverified. The Android and iOS pairing fixes exist on separate unpushed branches; neither has been merged or live-validated.

| ID | Status | Evidence |
|---|---|---|
| A | PASS | Fresh amd64 VM install completed about 3 minutes after VM start. The first sealed boot produced no visible phone approval for over 10 minutes; after enabling the guest serial console and restarting, the guest logged `posted unlock-key boot-request`, the phone approval appeared within about a minute, and HTTPS returned 200 at 04:10:54Z. Let's Encrypt YR2 certificate covered the box name and wildcard SAN; phone showed Leader/Online and Studio Running/Healthy. Cause of the first missed request is unknown. |
| B | PASS | Box and random names resolved to the same wildcard A/AAAA addresses, TTL 300; resolution was immediate from recipe creation. No box CAA or at-rest `_acme-challenge` TXT record. Apex CAA allowed Let's Encrypt for `issue` and `issuewild` plus Cloudflare's automatic CA entries. |
| C | FAIL | Stop then Start passed: Start 04:26:48Z, self-unlocked from the box-sealed lease, HTTPS 200 at 04:27:40Z (52 s), no phone prompt. Restart as administrator shut the VM down gracefully in about 6 s, but the UAC prompt expired unseen and the retest could not be completed. After cancel/expiry, every Start failed with `VM <name>: not starting while the app quits`; quitting and reopening Studio restored Start. |
| D | FAIL | Account and server creation passed. Git import rejected a long description with `flagship.app.json present but invalid: description must be at most 30 characters`; changing the name after Check repo did not update the selected install name (preview `hello…` Available, installed `flagship-hello-test-2`). Rename completed in 41 s (new URL 200, old URL 404). Add a device dead-ended with `Adding a device from this phone isn't available yet. Use the web app.` Account deletion passed in about 17 s. The “Account was removed” screen was not run because it requires the unavailable second-device pairing flow. |
| E | FAIL | With the box hostname blocked, Android reached the box through `relay-fallback.flagship.services`; with that also blocked, it used `(built-in addresses)`. Home showed Online and Leader within about 10 s and 30 s respectively. However, the server page's Front page card reported `Couldn't reach the server to load front-page settings`, and Retry failed while direct DNS was blocked. |
| F | PASS | Web onboarding, reload/unlock, Home, Services, Activity, Settings, Trusted devices, and Scan a pairing code worked against production. Remote paired with the phone using matching code `002 806`; approval at 05:37:53Z yielded a keyless browser session about 16 s later, and `/api/companion/redeem` returned 200. See L for UI defects observed during this pass. |
| G | FAIL | Plain account backup downloaded correctly (7,797 bytes). A clean passcode-backup save created a 0-byte file without an error, although the 8,050-byte `FLGSHBK1` backup remained in app cache; the server deletes its copy after download. Reopening the backup dialog also retained “Backup ready” without showing the passcode again. Restore into the second account was attempted twice and hung at `Flagship is locked / Authenticating…` without a prompt; restore verification did not complete. |
| H | NOT RUN | No USB stick was available; hosted ISO-fallback provisioning was not attempted. |
| I | NOT RUN | `/api/notices` returned 204. Update check reported `This server is on the latest release` at `v0.0.0-2026-10-19-072ee32d`; with no newer endorsed release, applying an update and exercising failed-health rollback were unavailable. |
| J | PASS | Android was force-stopped from 05:02:44Z to 05:34:17Z (over 31 minutes). The box poller recorded 268 HTTPS 200 responses out of 269; one probe returned 000 at 05:10:07Z. Daemon journal 04:27:07–05:35:38Z contained no alias-reconcile lines, 429s, or errors. |
| K | PASS | Production monitor recorded 180+ probes with no 5xx or Cloudflare 1102 responses. The single box-poller 000 is recorded under J. |
| L | FAIL | Usability and consistency defects listed below remain. |

## Setup and release contract

Tests ran on Windows 11 with WHPX, against production, without environment overrides. Studio was built from fresh `origin/main` commit `59dbc8cac` as a self-contained, single-file, ReadyToRun publish; the APK was a debug build. Android emulator: API 35 Google APIs x86_64, `emulator-5554`, PIN 1234. The owner's physical phone was not touched. `FLAGSHIP_VM_APPLIANCE_BASE` was unset.

Contract checks passed: deployed main pin `59dbc8cac`, live shell v153 on `webapp.` and `remote.`, `/api/notices` 204, baked pin starts `5016749377de`, both appliance manifests name endorsed commit `072ee32d`, and the independently downloaded amd64 appliance matched SHA-256 `69366977…ed8a41df` at 2,510,533,120 bytes. The box `/api/leads` also reported `072ee32d`.

## Defects and likely files

- UAC cancel/expiry poisons Studio's VM manager: `apps/builder-windows/src/VM/VMManager.cs` (`ShutDownAllAsync()` sets `_quitting = true`) and `apps/builder-windows/src/MainWindow.xaml.cs` (`RestoreAfterShutdown()` re-enables the window but does not clear the manager state). Reproduced by the owner; workaround is quit and reopen Studio.
- Android passcode backup save creates an empty destination: `apps/mobile/android/.../ServerArchiveScreens.kt`, around the save-backup launcher/result handling (handoff identified lines 140–215). Restore lock/authentication hang is in the same restore flow and needs separate diagnosis.
- Long app descriptions: `packages/protocol/src/manifest.ts` around line 377 enforces a 30-character limit; `manifest.md` describes the field as free text. Desired behavior from the owner: warn and truncate.
- Git import ignores edits made after checking the repository; revalidate the final chosen name before install. Likely Android import/manifest preview state and install request construction.
- Android pairing in the tested main build is unavailable: release `Variant.devicePairingRelays()` returns null (`release/Variant.kt`), and Add/Join refuse in `AppVariant.kt`. iOS Release similarly wires `UnavailablePairingRelayClient()` in `FlagshipApp.swift` around line 509. Web pairing relay works.
- The blocked-DNS front-page card still has a direct-only call path; locate the server page's front-page settings fetch and route it through the same relay fallback used by Home.
- Test-created `saved-backups-*` directories exhausted C: during the prior Vitest run. Cause recorded at `packages/server-daemon/tests/serverArchive/saved.test.ts`: `world()` creates temp directories without cleanup and a test truncates a real 5 GiB NTFS file around line 503. Two 5 GiB leftovers were removed during the prior session.

Other L observations:

- Studio code-entry hint says “like ABCD-EFGH” while the displayed code is `RNMYJGOB` (no dash).
- README publish guidance using only `--self-contained true` produced a framework-dependent build and a “You must install .NET Desktop Runtime” dialog; the Windows README also says the appliance shortcut is unused.
- Hosted-VM provisioning still says “If it ran from a USB stick, unplug it…”. Studio remains on “Installing…” during specialization and its “up 2m” health age goes stale.
- Fresh Android account showed a “Post-recovery / Recovery: snapshot” Activity card and an account “Loading…” skeleton lasting over five minutes.
- After rename, Home's “Leads flagship-hello-test-2” badge and box `/api/leads` retained the old app stem. Server page reported “Software 0.0.0”.
- Cloudflare Insights beacon was blocked by CSP on every web load. After web onboarding Finish, Home retained a stale “First run / unpaired” panel until reload; new-account identity showed “Username (not set)”. Remote Home showed “Your first server is one tap away” while paired, and Services listed the user's own app under Shared.
- Full-screen screenshots capture the owner's desktop and were avoided.

## Pairing fix branches and recommendation

Both fix branches are unpushed and unmerged. Android `fix/android-device-pairing` adds a `/qr-pipe` relay client, Release and real-backend Debug wiring, 12 relay tests and a golden vector. The handoff reports 2,289 JVM tests, `assembleDebug`, and Release compilation passing; `testReleaseUnitTest` remains blocked by the pre-existing `BuildMcpIdeConfigTest.kt` failure. A live two-device join was not performed. Its admin currently errors on a malformed leg-1 payload where web ignores it. Branch commits: `bcb1e564b`, `f38085b4c`, `3c6a54237`.

iOS `fix/ios-device-pairing` adds `LivePairingRelayClient.swift`, Release wiring, tests, and golden vectors. It was not compiled or run because this Windows machine has no Xcode. Its vector file (`test-vectors/pairing-relay.json`) needs reconciliation with Android's `test-vectors/device-pairing-relay.json` when integrating. Branch commits: `326985984`, `f7c1524bc`, `75d31b1be`, `17fe70a34`, `f5dc6e5d4`.

Recommendation: NO-GO until the four release blockers in the opening paragraph are fixed or explicitly accepted, the Android relay is live-joined on two devices, and iOS is compiled/tested on a Mac with vector parity reviewed. Owner confirmation is requested before this report branch or either fix branch is pushed. No code fixes or relay merges were made as part of this report.

## Cleanup state

The prior session had already deleted the throwaway account `sturdy-heron`; throwaway web accounts remain as listed in the handoff. `quiet-plum` remains because the pending restore test uses it. This session could not inspect or automate native app windows: the Windows app-control bridge returned `Trusted RPC service is not configured`. Consequently, the pending restore retest and live two-device join were not performed. Cleanup completed: both poll/monitor loops and the serial logger were stopped; the VM received a graceful ACPI powerdown (guest log ended at `reboot: Power down`); emulator `emulator-5554` exited through its authenticated console; Studio exited; and the exact `home.sturdy-heron.flagship.services` VM bundle was removed after its config identity was checked. Deletion of `harrywinner2/flagship-hello-test` is pending: GitHub rejected the CLI request because its saved token lacks the `delete_repo` scope. I requested approval to add that scope and retry.
