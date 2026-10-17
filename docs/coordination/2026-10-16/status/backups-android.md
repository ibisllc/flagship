# backups-android (paused 2026-10-16)

Goal: Android side of the backup client spec (policy, scheduled/saved backups, keys deposit, one .flagship file, phone copy, restore that gives up per app).

## Landed on main
None.

## Saved, not landed
Branch `wip/backups-android-2026-10-16`, 5 WIP commits on top of cb8801f0d-era main (top c9864e057).
**Never compiled or tested.** The Android build lock was held by other agents the whole time, and the disk had under 5 GB free.
Contents:
- core/BackupOrders.kt: ports of backup-policy/v1 and server-archive-keys/v1 (digest, mint, deposit), with vector tests (BackupOrdersVectorsTest).
- ServerBackupFormat: attachBackupPolicy; the one-file bundle (FLGSHBK1 header parse/build, bundleFileName), with BackupBundleTest against the server-backup-bundle vectors.
- api/SavedBackupModels.kt + ScreensClient/Live/Mock: backups view, schedule PUT, keys, run, bundle chunk, link, delete, backup-policy GET/POST. The mock answers in the box's shapes and sentences ("your device" wording). The two-file chunk/backup-file routes are removed.
- ServerBackupsViewModel + ui/screens/ServerBackupsSection.kt (on the server page above Backup/Migrate): policy line, usage bar, over-limit, peer lines, status/next/failed, schedule editor in local time, approve button, Back up now (no-keys → deposit → retry), list rows with Download (one file, SAF CreateDocument) and Delete (confirm), phone-copy toggle.
- BackupsText (wording + local↔UTC schedule), AdminOrderGate.SERVER sentence, Keystore.mintServerArchiveKeys / sensitiveSigningNeedsPrompt.
- Phone copy: PhoneBackupCopies + PhoneBackupFetcher + BackupFetchWorker (WorkManager, 12 h, unmetered + charging + battery/storage not low; work-runtime-ktx 2.9.1 added); scheduled from MainActivity.
- Create wizard: new policy wording and reserve picker (BackupPolicyOptions), draft reserve, policy signed (admin root, else IRK) and attached beside the pairing order in mintRecipeBundle.
- Back up now: passcode reason line; downloads and saves one .flagship file. Import: picks one file, reads header + metadata only, streams the data part (PartOfPickedFile). Restore result: "Restored N apps" + "Couldn't restore: <name>: <reason>".
- Tests: BackupsTextTest, ServerBackupsViewModelTest, PhoneBackupCopiesTest (includes a sparse 2.3 GB resume), CreateServerBackupPolicyTest, ServerArchiveViewModelTest updated (one file, truncated, 2.2 GB sparse import, partial restore), compose test updated.
- Gym: GymBackupsTest (13 scenarios), plus smoke seams `flagship.smokeBackups`, GymSeams.importBackupFile and MockScreensClient.smokeInstance.
- parity/features.json: scheduled-backups android → present.

## Remaining (in order)
1. (M) Take android-build.lock and run `:app:compileDebugKotlin :wear:compileDebugKotlin` (JAVA_HOME openjdk@17). Fix compile errors (expect a few in the new files and the script-edited CreateServerScreen.kt / ServerArchiveScreens.kt / ServerArchiveViewModels.kt).
2. (M) Run `:app:testDebugUnitTest`; fix failures (watch the mock ↔ view-model sentences and the flaky-resume timing in PhoneBackupCopiesTest).
3. (M) Run GymBackupsTest on emulator-5554; adjust tags and waits.
4. (S) Squash the WIP into real commits (protocol ports; client+mock; section; wizard; one file; worker; tests; gym), then land-main.sh.
5. (S) Optional: "Send to a browser" for saved backups (savedBackupLink is in the client; no UI yet).

## Blockers / decisions
- Disk is often under 5 GB, and the Android lock is busy, so builds need a quiet slot.
- Peer status `holders` is read as a count, or as an array's size (the engine's shape isn't fixed yet).

## Gym coverage
Added (unverified): admin deposits keys once; non-admin sees the box's reason with controls disabled; Back up now progress → listed; failed run line; weekly schedule PUT in UTC; download one file + delete; wizard policy step; policy Phone→Peer, a refusal sentence, over-limit, unset→Choose; import one file; a damaged file is refused; a restore with one failed app.
Missing: an end-to-end gym check of the signed backupPolicy sibling (covered only by a unit test); the background worker on a device.
