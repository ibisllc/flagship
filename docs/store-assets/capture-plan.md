# Store captures: what the native tests must produce

The store art (`npm run store-assets`, see `README.md` in this folder) frames real app screens. Until the iOS and
Android tests below exist, the renderer uses marked webapp stand-ins or a red "CAPTURE MISSING" frame, and
`npm run store-assets:release-check` fails. This file is the contract for the native engineer: add the tests, run
them, and the next render picks the files up with no other change.

## The contract

* **Output path:** `store/captures/<platform>/<lang>/<device>/<id>.png`, `platform` `ios` or `android`, `lang` the
  code from `i18n/locales.json` (`en`, `es`, `fr`, `de`, `pt-BR`, `ja`, `zh-Hans`), `id` the slide (`01`…`08`, `07b`, `07c`).
  Slide 01's second frame, the caller's browser, is `store/captures/voici/<lang>/browser/01.png` (and `01.json`, the
  Call button's place), made by `node scripts/store-assets/capture-voici.mjs` from the real voi.ci site.
  The renderer lists every missing path (`node scripts/store-assets/render.mjs check`).
* **Pixel size** (`store/store.json` `captureSize`; another size is scaled and reported):

  | Device folder | Simulator / emulator | Pixels |
  |---|---|---|
  | `ios/iphone-6.9` | iPhone 17 Pro Max (or 16 Pro Max) | 1320 × 2868 portrait |
  | `ios/ipad-13` | iPad Pro 13-inch (M4 or later) | 2752 × 2064 **landscape** (the iPad app is landscape-only; the art shows the iPad on its side) |
  | `ios/watch-ultra` | Apple Watch Ultra 3 (49 mm) | 422 × 514 |
  | `android/phone` | Pixel 9 (API 35/36 image) | 1080 × 2400 |
  | `android/tablet-7` | the phone AVD resized to 1920 × 1200 at 320 dpi | 1920 × 1200 **landscape** (the app's wide layout: navigation rail) |
  | `android/tablet-10` | the phone AVD resized to 2560 × 1600 at 320 dpi | 2560 × 1600 **landscape** |
  | `android/wear` | Wear OS 4+ Large Round AVD | 384 × 384 |

* **Language:** the real app in that language, never English UI. iOS: launch arguments
  `-AppleLanguages (<appleId>) -AppleLocale <appleId>_<region>` (`ja` → `ja_JP`). Android: per-app language,
  `adb shell cmd locale set-app-locales com.flagshipserver.app --locales <androidId>` (Wear the same on the watch AVD),
  or `AppCompatDelegate.setApplicationLocales` in the test.
* **Appearance** follows the slide's place in the strip (the slide's background alternates light, dark, light…):
  `02` dark (Home), `03` light (Calls), `04` dark, `05` light, `06` dark (backups), `08` dark (build chat); the call
  screen (`01`) is always dark, whatever the device setting, `07`/`07b` (watch) dark. iOS `XCUIDevice`/`-AppleInterfaceStyle Dark`; Android `adb shell cmd uimode night yes|no`.
* **Clean status bar:** iOS `xcrun simctl status_bar <udid> override --time 2026-10-21T09:41:00.000<host offset>` (an ISO time with
  fractional seconds also fixes the date the iPad's status bar shows; capture-ios.sh computes it) `--batteryState charged
  --batteryLevel 100 --cellularBars 4 --wifiBars 3`, after setting the simulator's own AppleLanguages / AppleLocale for
  the capture's language and restarting it (the iPad's date is in the system's language, not the app's); Android demo
  mode (`adb shell settings put global sysui_demo_allowed 1`, then `am broadcast -a com.android.systemui.demo -e
  command clock -e hhmm 0941`, battery 100, Wi-Fi and cell at full with `-e fully true` (without it both carry a
  "!"), no notifications).
* **No real person, box or address** (brief §5): every screen comes from the mock gym seeded with
  `store/demo-world.json`: account `river-otter`, servers `home` (leader) and `cabin`, apps Notes, Photos, Recipes,
  Chess Club, Budget (each with its own voi.ci link, `apps[].link`), members Ana (Manager), Kenji and Lea (Member),
  this phone named by `deviceName` (never a model name), four conversations and five calls on voi.ci, and a build
  chat (`build`). Nothing reaches a network. No toast, keyboard,
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
devices", three backups (last one 6 h before the capture), nothing failing; and, for `07b` only, `cabin`
waiting for its start-up approval (iOS has this as `-smoke-awaiting-unlock`, the watch as `-smoke-watch-waiting`).
Fix the clock to the same moment the webapp captures use (2026-10-21 09:00 UTC) so dates match across languages.

## Per slide

| id | Screen and state | iOS (`StoreCaptureTests`, iPhone and iPad) | Android (`StoreCaptureTest`, phone and both tablets) |
|---|---|---|---|
| 01 | An incoming voi.ci call ringing: Sam (the world's `messages.nickname` in the capture's language, `calls.ringing`), Answer and Decline (light; the stage itself is always dark). The renderer draws the caller's browser (`voici/<lang>/browser/01.png`) between the header (name, status, "End-to-end encrypted · quantum-safe") and Decline / Answer, reading where they are from the capture's pixels, so it never covers the encryption line | `-smoke-call-stage ringing` over `-smoke-store-world`: `VoiciRingingStage` named from the world (`StoreWorld.ringingName`); wait for the nickname's text. CallKit's system screen can't be captured, so it is the app's own ringing stage. The stage shows no video-offered mark (none exists in the app) | `VoiciCallActivity` (the full-screen incoming-call screen) with the call center ringing from the world (`StoreWorld.ringingName`; the test sets the center's state, nothing rings, no network); wait for `voici-call-answer` and `voici-call-decline`. Always dark; no video-offered mark (none in the app) |
| 02 | Home: both servers Online, `home` with the Leader badge, app counts, no recovery nudge, no banner, no "Browse the marketplace" card (0.4 hides the marketplace) | `-smoke-tab home`; wait for the cabin row; `quick-action-install-service` must not exist | `smokeTab=home`; wait for both server cards |
| 03 | Social's Calls page (the call button's): missed, video and audio calls, named by the owner's nicknames (`calls.history`, `messages.others`). The Inbox with the four conversations and the call button's missed count is kept beside it as `x03-inbox.png` (not rendered) | `-smoke-tab messages`; tap `social-tab-inbox`, wait for a `messages-row-*` row, shoot the Inbox, tap `social-call-button`, wait for `voici-calls-list`. iPad at Dynamic Type XXXL (the page takes the pane's full width) | `smokeTab=messages`; `StoreWorld.seedCalls` records `calls.history` on `VoiciCenter.shared`; tap `social-tab-inbox`, wait for four `messages-row-*` rows, shoot, tap `social-call-button`, wait for `calls-title`. The 10" tablet at 400 dpi (the page is a column; the 7" stays at 320, since a higher density there drops the short side under 600 dp and the app takes the phone's layout) |
| 04 | Services / apps list, "All servers", five apps, each with its own voi.ci link | `-smoke-tab apps`; wait for Budget and Chess Club rows | `smokeTab=apps`; wait for Budget and Chess Club rows |
| 05 | Chess Club → Access control: Members only selected, Members (3) with ranks visible | `-smoke-tab apps`; open Chess Club → `service-detail-open-access`; wait for `service-access-role-inv-lea`. iPad: the page's top, Dynamic Type XXXL (the page takes the pane's full width, like Calls) | open Chess Club → `service-access-members-title`; the phone scrolls the switch to the top and draws this one slide at a lower density if Lea would sit under the navigation bar (the Play phone art then shows this slide's whole phone, `store.json` `fit`); tablets: the page is far taller than a landscape screen, so the switch and the members never fit together at a readable size: the three members and their ranks at the run's density, Lea's row ending where the art's crop does (0.4 drew the whole page tiny). Each try's measurements go to `x05-fit.txt` |
| 06 | `home` server page scrolled to Backups (policy, last backup, the list, each backup's "Restore into this server…") | open `home`, scroll `sd-backups-policy` near the top; a `sd-backup-restore-*` button must be in view | open `home`, `bring("sd-backups")`; each row's `sd-backups-restore-*` (Restore into this server…) in view |
| 07 | Watch: servers list, both online, nothing waiting | Watch app launched with `-watch-store-world` on the Ultra simulator (status bar 9:41 where the simulator takes it) | `wear/src/test` `StoreWatchCaptureTest` (Robolectric, 384 × 384): `WearApp` over the world; the clock set to 09:41, the scroll indicator faded |
| 07b | Watch: `cabin` waiting, the Approve button | as 07 with the waiting flag (`-watch-store-waiting`) | as 07 with cabin waiting |
| 07c | Wear OS only: the tile (both servers up, `home` the leader), bare, no frame | none (watchOS has no tiles) | `wear/src/test` `StoreTileCaptureTest`: the tile's real layout (`statusTileLayout`) drawn by the Tiles renderer under Robolectric, 384 × 384 |
| 08 | The build chat (`build`): the owner described a book club app, the AI asked one question and built it on `home`; "Ready to deploy", Deploy | `-smoke-tab apps -smoke-store-chat <build.sessionId>` (a Debug seam opens the chat as its push link would); wait for `vibecode-reply-field` | launched with `flagship://vibecode/<build.sessionId>` as the intent's data; wait for `vibecode-continue-field` |

The feature graphic needs no capture of its own: it crops that language's Android `01`. The App Store strip is 01-06
and 08 (7 of its 10); Play's phone and tablets are 01-08 (its maximum of 8), so adding a slide there means cutting one
(the watch first, brief §4). Slide order (2026-11-27): the call, then Home ("your own cloud"), then Social, so voi.ci
and the cloud both show in the first three.

## Running them

The tests exist (2026-11-01): iOS `StoreCaptureTests` (UI test) and the Watch app's `-watch-store-world` launch;
Android `StoreCaptureTest` (instrumented) and the Wear OS app's `StoreWatchCaptureTest` (Robolectric, since the phone
emulator can't hold the watch build) and `StoreTileCaptureTest` (the tile, `07c`). Each platform has one wrapper that builds, runs every ga language and device,
and cleans up after itself:

```sh
bash scripts/store-assets/capture-ios.sh       # iPhone 6.9", iPad 13", Apple Watch Ultra; [--lang ja,de] [--device ipad-13]
bash scripts/store-assets/capture-android.sh   # phone, 7" and 10" tablets (one AVD, resized), Wear OS; [--lang ...] [--device ...]
npm run store-assets:render
```

iOS creates its store simulators for the run and deletes them and its DerivedData after (`--keep-build` keeps both);
Android boots `flagship_api35` headless without saving a snapshot, lifts the AVD's screen-lock PIN for the run
(`STORE_AVD_PIN`, default 1234) and puts it back. The seam is `-smoke-store-world` (iOS, the world's JSON in the
`FLAGSHIP_STORE_WORLD` launch environment) and `flagship.smokeStoreWorld` (Android, the JSON as an extra);
`-smoke-store-waiting` / `flagship.smokeStoreWaiting` has cabin ask to start. Times are relative to the moment of
capture (the app's clock is not fixed), so absolute dates on the backups slide are the capture day. The Android phone
runs at 370 dpi (the AVD's 420 is reset after) so slide 05 holds the Members-only switch and all three members; the 10" tablet draws Social at 400 dpi.
`--only 05,08` (both wrappers) retakes just those slides and keeps the rest.

### The Wear OS tile: screenshot and picker preview

`StoreTileCaptureTest` renders the tile from the same layout code the tile service sends (`statusTileLayout` in
`StatusTileService.kt`), so the screenshot and the preview cannot drift from the tile. It writes two things:

```sh
cd apps/mobile/android
STORE_CAPTURE_WEAR=1 ./gradlew :wear:testDebugUnitTest --tests com.flagshipserver.wear.StoreTileCaptureTest --rerun
    # store/captures/android/<lang>/wear/07c.png (capture-android.sh --device wear runs it)
WEAR_TILE_PREVIEW=1 ./gradlew :wear:testDebugUnitTest --tests com.flagshipserver.wear.StoreTileCaptureTest --rerun
    # wear/src/main/res/drawable[-<lang>]-nodpi/tile_preview.png: the tile picker's preview (the manifest's
    # androidx.wear.tiles.PREVIEW), 384 x 384, one per ga language. Rerun and commit after changing the tile's
    # layout or its words.
```

Play takes Wear OS screenshots bare (no device frame) at 384 × 384 or larger; the `watch` template keeps the round
content as captured. To check one by hand on a Wear OS AVD instead: add the tile from the watch face's tile
carousel, then `adb -s <watch> exec-out screencap -p > 07c.png`.

