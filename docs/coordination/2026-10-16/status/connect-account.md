# connect-account (paused 2026-10-16)

**Goal:** Welcome = "Create your account" + one "Connect to an existing account" page (account name OR pairing code) on all three apps; Welcome and the app lock share one footer (primary, secondary, gap, Patent Pending); Android insets + device-name fixes.

## Landed on main
- dbb1d746e Webapp: connect page on the cover (shell v122), lib/connectAccount.js, gym + docs + parity entry `connect-existing-account`
- bb7a9de79 Webapp: Welcome + passphrase/PIN lock share `.action-footer` with Patent Pending; lock screens gain Sign out (handleReset) (shell v125)
- e2b23515a iOS: ConnectAccountScreen + ConnectInput, FSActionFooter on Welcome + BiometricLockScreen, JoinUsernameScreen removed, `.recoverFromWelcome` → `.connectAccount`, -smoke-onboarding no longer restores a mock demo; parity ios present

## Saved, not landed: wip/connect-account-2026-10-16 (2 WIP commits on top of e2b23515a)
Android: ConnectAccountScreen.kt (replaces JoinAccountContainer.kt), core/ConnectInput.kt, FSActionFooter (ui/components/ActionFooter.kt) on WelcomeScreen + BiometricLockScreen ("Unlock" / "Sign out"), safeDrawing-bottom insets on OnboardingFlow root, SecureAccountOverlay and the lock screen, DeviceDisplayName (Settings.Global.DEVICE_NAME, else Build.MODEL) for the default device name, `flagship.smokeOnboarding` gym seam, GymOnboardingTest (3 tests), Robolectric ConnectInputTest / ConnectAccountComposeTest / FrontDoorFooterComposeTest, parity android present, tools/gym android rows.
State: compiles (:app + :wear). Emulator gym: the 2 connect tests passed on flagship_gym; lockScreenSharesTheWelcomeFooter not run yet. Unit: 39/40 green last run; FrontDoorFooterComposeTest.lockFooter failed ("Patent Pending not displayed"), fix applied (useUnmergedTree) but not rerun.

## Remaining (in order)
1. S — rerun Android unit tests (the 6 classes in scratchpad/connect-android.sh) under android-build.lock; fix lockFooter if still red (BiometricLockScreen.kt / FrontDoorFooterComposeTest.kt).
2. S — run GymOnboardingTest on emulator-5554 (ANDROID_SERIAL), incl. the new lock test; take android-lock.png (script SHOTS=1).
3. S — squash the 2 WIP commits into one "Android: ..." commit, land with land-main.sh (check: tsc + vitest apps/web tools/gym).
4. S — optional: iOS onboarding screens other than Welcome don't need inset work (SwiftUI safe area); webapp needs nothing more.

## Blockers / owner decisions
- None blocking. Note: there is no separate "short code" for device pairing; all three accept the https /join link, legacy flagship://join and the bare `sid=…&pk=…` form.
- Pre-existing, not mine: iOS and Android incoming join use a Mock pairing relay in the app wiring (FlagshipApp.swift `MockPairingRelayClient`, JoinDeviceScreen `MockDevicePairingRelay`), so a native join with a real code can't complete; webapp uses the live relay.

## Gym coverage
- Added: web gym-smoke (cover, connect page, link-to-join, footer on welcome + lock) + tools/gym web rows; iOS OnboardingSmokeTests (connect page, demo sign-in, link-to-join, scan) + lock footer in GymTotalTests (all green); Android GymOnboardingTest (on wip).
- Missing: Android lock footer gym run; live-gym not needed (no box involved).
- Screenshots: scratchpad/connect-ui/ (web-*, ios-*, android-welcome.png, android-connect.png).
