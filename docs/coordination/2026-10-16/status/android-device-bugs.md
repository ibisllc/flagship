# android-device-bugs (paused 2026-10-16)

**Goal:** fix the Android bugs found on Harry's Samsung: live account fixtures, app lock, key-backed actions, recovery, create flow. Also keep mocks and developer mode out of release builds.

**Landed on main:** none.

**Saved but not landed:** wip/android-device-bugs-2026-10-16 (7 commits on top of main 7ca3dbfe3):
- faa244f92 Bug 1 / M2: live never falls back to mock; Home, Services and Activity show empty states with no server; GymLiveAccountTest added.
- f3f08e0ad Mock clients, fixtures, gym seams and FixedPodClients moved to src/debug behind `Variant` (src/release = nothing). Developer mode deleted. DemoAccount stays in main as the live demo-server path. Pairing relay in release: "Adding a device this way isn't available yet." Tests moved to src/testDebug. CI builds release and runs scripts/check-release-clean.sh.
- 12e821c06 C1–C4 + M10: PRF taken from create when present, else a second assertion with retries. Passkey and generic errors get sentences, the generic one with a code, all logged (ErrorLog). Recovery wording is provider-neutral and names the provider; configured state shows "Recovery active". Block Store is non-fatal.
- 7aabf10e5 M6/M9: subdomain prefilled with home/homeN; singleTop launch mode; create draft and selected tab are saveable; GymDeviceBugsTest.
- 36d4504b4 M11: BiometricGate starts a prompt only when RESUMED, re-offers a prompt the screen lost, has a start watchdog, and ends every outcome with a sentence; BiometricGateTest; GymAppLockTest.
- 961d9d48f fixes found by compiling. 527fd2a79 M12/M14: launch lock log; no Recents snapshot when the lock is on; key backup off the main thread; BiometricAuthority rebinds in onStart and only its owner clears it (onDestroy of a second instance used to unbind it: key use skipped the prompt or waited on a dead screen); step logs; AppLockStateTest; cold-start gym case.

**Build state:** 961d9d48f compiled clean (debug, release, wear, unit-test and androidTest sources). 527fd2a79 has NOT been compiled. No unit tests or gym scenarios have run yet, so nothing is green and nothing landed. No debug APK built.

**Remaining work, in order:**
1. (S) Take android-build.lock. `./gradlew :app:compileReleaseKotlin :app:compileDebugAndroidTestKotlin :app:assembleDebug :app:testDebugUnitTest`, fix failures, and give the coordinator the APK path for Harry's phone (logcat -s Flagship).
2. (M) Gym on emulator-5554: GymLiveAccountTest, GymAppLockTest, GymDeviceBugsTest, GymEveryMergeTest, then the rest of the mock gym (watch "Back" ambiguity in GymDeviceBugsTest and the persisted keystore in the cold-start test).
3. (S) `:app:assembleRelease :wear:assembleRelease` + scripts/check-release-clean.sh.
4. (S) Land the stack with land-main.sh. If you want Bug 1, M11 and M12 alone first, they need reordering, because M11 sits on the mock-removal commit.
5. (S) Tick M2, M3, M6, M9, M10, M11, M12, M14 in manual-tests.md once each is green.
6. (M) M12 root cause is still unknown: the code starts locked. Needs the launch log line from Harry's phone.
7. (M) M8 root cause is unconfirmed: needs a logcat of the create-server steps on the new APK.

**Blockers / decisions:**
- Device pairing (Add device, Join with a pairing code, Scan a pairing code) only ever ran on a mock relay, on Android and on iOS (MockPairingRelayClient). A live /qr-pipe relay is the next task.
- iOS needs the same fixes: no full stop on the backup banner, "Approve a box's boot" wording, empty subdomain field (CreateServerViewModel), "iCloud Keychain" recovery text.

**Gym coverage:** added GymLiveAccountTest (M2), GymDeviceBugsTest (M3, M6, M9), GymAppLockTest (M11, M12); none run yet. Missing: M8 and M14 (needs a fake key path or a live device).
