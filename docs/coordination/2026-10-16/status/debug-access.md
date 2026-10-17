# debug-access (paused 2026-10-16 17:40)
Goal: owner debug access = SSH key only, admin-signed `flagship/debug-access/v2` with expiry/renew/revoke, shown on the server page, at parity on web/iOS/Android.

## Landed on main
- 5c1a8d00a v2 grant + revoke protocol, vectors, box controller (key-only sshd, expiry timer, durable state, endpoints, server-detail, Activity)
- 5ad4d496b CLI no longer bakes the grant's key into the image; b94dfdbfb Studio comments
- b431674fe release guard: any debug password fails every run
- 2c13b0384 docs (recipe-delivery "Debug access", AGENTS GA bullet)
- 34468d0d6, c70409613, 39f09652e, da3b0a298 webapp: v2 recipe grant, server-page card + banner, web gym, fresh passphrase unlock per grant (shell v121)
- 47662477c Linux Studio: debug checkbox removed (matches Mac/Windows)

## Saved, not landed: wip/debug-access-2026-10-16
Commits on top of main (all in the wip branch):
- 8890bafc4, 5ee986285, de0899018 iOS (from the iOS fork): v2 + vector tests, create flow with SSH key, server-page card/banner, Face ID per grant, Activity labels, mock box, 2 gym tests
- 483410469 iOS fix: card's accessibility identifier hid its controls (both gym tests failed); gym registry entries in tools/gym/src/suites/ios.ts
- c50e7184b iOS compile fix (freshSensitiveKey public)
- db198dc3e parity row iOS present; 310ba149f Android (salvaged from the Android fork's uncommitted work): v2 + vectors test, create flow, card/banner, biometric per grant (BiometricAuthority.confirmNow), labels, view-model tests, parity row
Status: iOS shared vector tests green (5/5). iOS package + gym tests NOT yet green: the last run failed to compile (fixed in c50e7184b, not rerun). Android NOT built or tested yet. tsc + vitest apps/web scripts tools/gym green on the branch. parity-check: no debug-access reds (the other reds are pre-existing).

## Remaining work (in order)
1. S: rebase wip on origin/main.
2. M: iOS under native-build.lock: package tests (DebugAccessViewModelTests, CreateServerAdvancedToggleTests, ActivityViewModelTests, SwkDepositTests) and gym tests GymOctoberTests/test_debugAccessOnBannerOff + test_debugAccessReadOnlyOnANonAdminDevice. Script: scratchpad/dbg-native.sh pkg gym. Likely fix: per-grant Face ID in the simulator (check BiometricGate's smoke seam), DebugAccessCard.swift.
3. S: land iOS (land-main.sh, check `npx tsc -b && npx vitest run apps/web scripts tools/gym` + parity-check).
4. M: Android under android-build.lock with ANDROID_SERIAL=emulator-5554: compile app + wear, testDebugUnitTest (script scratchpad/dbg-native-android.sh android). Fix compile errors in DebugAccessCard.kt / DebugAccessViewModel.kt / CreateServerScreen.kt / MockScreensClient.kt.
5. S: land Android; AGENTS.md status entry for debug access.

## Blockers / owner decisions
- Box side needs an endorsed release to reach boxes; not yet run on a real box (sshd Match block, expiry-time, loginctl, sudo).
- Webapp admin invites still use the unlocked session (debug grants now ask for the passphrase); same rule for invites = separate change.

## Gym coverage
- Added: web gym (on/renew/off with wrong + right passphrase, read-only), iOS gym 2 tests (registered, not yet passing), Android unit tests only.
- Missing: Android mock-gym scenario (GymOctoberTest twin of the iOS tests); live-gym check on a real box (grant over LAN SSH, expiry, revoke kills sessions; tools/live-e2e).
