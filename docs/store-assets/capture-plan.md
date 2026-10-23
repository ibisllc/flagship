# Store captures: what the native tests must produce

The store art (`npm run store-assets`, see `README.md` in this folder) frames real app screens. Until the iOS and
Android tests below exist, the renderer uses marked webapp stand-ins or a red "CAPTURE MISSING" frame, and
`npm run store-assets:release-check` fails. This file is the contract for the native engineer: add the tests, run
them, and the next render picks the files up with no other change.

## The contract

* **Output path:** `store/captures/<platform>/<lang>/<device>/<id>.png`, `platform` `ios` or `android`, `lang` the
  code from `i18n/locales.json` (`en`, `es`, `fr`, `de`, `pt-BR`, `ja`, `zh-Hans`), `id` the slide (`01`…`06`, `06b`).
  The renderer lists every missing path (`node scripts/store-assets/render.mjs check`).
* **Pixel size** (`store/store.json` `captureSize`; another size is scaled and reported):

  | Device folder | Simulator / emulator | Pixels |
  |---|---|---|
  | `ios/iphone-6.9` | iPhone 17 Pro Max (or 16 Pro Max) | 1320 × 2868 portrait |
  | `ios/ipad-13` | iPad Pro 13-inch (M4 or later) | 2752 × 2064 **landscape** (the iPad app is landscape-only; the art shows the iPad on its side) |
  | `ios/watch-ultra` | Apple Watch Ultra 3 (49 mm) | 422 × 514 |
  | `android/phone` | Pixel 9 (API 35/36 image) | 1080 × 2400 |
  | `android/tablet-7` | 7" tablet AVD, 1200 × 1920 | 1200 × 1920 |
  | `android/tablet-10` | Pixel Tablet (or 10" AVD 1600 × 2560) | 1600 × 2560 |
  | `android/wear` | Wear OS 4+ Large Round AVD | 384 × 384 |

* **Language:** the real app in that language, never English UI. iOS: launch arguments
  `-AppleLanguages (<appleId>) -AppleLocale <appleId>_<region>` (`ja` → `ja_JP`). Android: per-app language,
  `adb shell cmd locale set-app-locales com.flagshipserver.app --locales <androidId>` (Wear the same on the watch AVD),
  or `AppCompatDelegate.setApplicationLocales` in the test.
* **Appearance** follows the slide's place in the strip: `01` light, `02` dark, `03` light, `04` dark, `05` light,
  `06`/`06b` dark. iOS `XCUIDevice`/`-AppleInterfaceStyle Dark`; Android `adb shell cmd uimode night yes|no`.
* **Clean status bar:** iOS `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged
  --batteryLevel 100 --cellularBars 4 --wifiBars 3`; Android demo mode (`adb shell settings put global
  sysui_demo_allowed 1`, then `am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941`, battery 100,
  no notifications).
* **No real person, box or address** (brief §5): every screen comes from the mock gym seeded with
  `store/demo-world.json`: account `river-otter`, servers `home` (leader) and `cabin`, apps Notes, Photos, Recipes,
  Chess Club, Budget, members Ana (Manager), Kenji and Lea (Member). Nothing reaches a network. No toast, keyboard,
  alert other than the one the slide is about, or scroll indicator in the shot.

## New seam on both platforms: the store world

Both apps already have the smoke/gym fixtures (iOS `-smoke-mode` launch arguments read in
`App/Sources/FlagshipApp.swift` and `FlagshipUI/Gym/*`; Android `flagship.smoke*` intent extras parsed in
`MainActivity` → `SmokeMode`, seeding `DemoFixtures`). Add **one** switch that swaps the demo fixtures for
`store/demo-world.json` (bundle a copy into the debug/UI-test target only; Release must stay clean,
`scripts/ios-release-clean.mjs` and `apps/mobile/android/scripts/check-release-clean.sh` must still pass):

* iOS: `-smoke-store-world` (with `-smoke-mode -smoke-admin-root -smoke-recovery-enrolled -smoke-username river-otter`).
* Android: intent extra `flagship.smokeStoreWorld=true` (with `smokeMode`, `smokeAdminRoot`, `smokeUsername=river-otter`).

The world needs: two servers online with `home` the confirmed leader; the apps list across both servers; Chess Club
members-only with the three members and ranks above; `home`'s Backups section with a nightly schedule, policy "On my
devices", three backups (last one 6 h before the capture), nothing failing; and, for `02`/`06b` only, `cabin`
waiting for its start-up approval (iOS has this as `-smoke-awaiting-unlock`, the watch as `-smoke-watch-waiting`).
Fix the clock to the same moment the webapp captures use (2026-10-21 09:00 UTC) so dates match across languages.

## Per slide

| id | Screen and state | iOS (`StoreCaptureTests`, iPhone and iPad) | Android (`StoreCaptureTest`, phone and both tablets) |
|---|---|---|---|
| 01 | Home: both servers Online, `home` with the Leader badge, app counts, no recovery nudge, no banner | `-smoke-tab home`; wait for `pod-card*` ×2 | `smokeTab=home`; wait for both server cards |
| 02 | The start-up approval for `cabin` with the biometric sheet up (iOS: the Face ID system sheet cannot be captured in the simulator, so stop at the approval sheet with its Approve button; Android: the BiometricPrompt over the approval) | `-smoke-awaiting-unlock`; tap Approve on the cabin card, capture when the approval sheet is up | `smokePods` with cabin waiting; open the approval; capture with the prompt (`smokeRealBiometrics` off) |
| 03 | Services / apps list, "All servers", five apps | `-smoke-tab apps` | `smokeTab=apps` |
| 04 | Chess Club → Access control: Members only selected, Members (3) with ranks visible | `-smoke-tab apps -smoke-access-fixture` adapted to the store world; open Chess Club → Access control | open Chess Club → Access control |
| 05 | `home` server page scrolled to Backups (policy, last backup, the list) | open `home`, scroll Backups into view | `smokeBackups` world; open `home`, scroll to Backups |
| 06 | Watch: servers list, both online, nothing waiting | Watch UI test on the Ultra simulator (`WatchApp` target) | Wear AVD: a `wear` androidTest (none exists yet: add `wear/src/androidTest`) launching `WearMainActivity` with the same world over the Data Layer mock |
| 06b | Watch: `cabin` waiting, the Approve button | as 06 with the waiting flag (`-smoke-watch-waiting`) | as 06 with cabin waiting |

`07` (closing) and the feature graphic need no capture.

## Running them

```sh
# iOS (one simulator per device folder; repeat per language)
TEST_RUNNER_STORE_LANG=ja TEST_RUNNER_STORE_OUT=$PWD/store/captures/ios/ja/iphone-6.9 \
xcodebuild test -project apps/mobile/ios/App/FlagshipApp.xcodeproj -scheme FlagshipApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -only-testing:FlagshipAppUITests/StoreCaptureTests
# Android (JAVA_HOME as in AGENTS.md; repeat per AVD and language)
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.flagshipserver.app.gym.StoreCaptureTest \
  -Pandroid.testInstrumentationRunnerArguments.storeLang=ja
adb pull /sdcard/Download/store/ja store/captures/android/ja/phone
npm run store-assets:render
```

`AppStoreScreenshotTests.test_captureShowcase` (iOS, smoke fixtures) is the closest existing test: `StoreCaptureTests`
can start as a copy of it with the store-world flag, the per-slide states above, `<id>.png` file names, and a loop
the runner drives per language. Write a small wrapper (`scripts/store-assets/capture-ios.sh`,
`capture-android.sh`) once the tests exist, so `npm run store-assets` can run them when a simulator or AVD is present.
