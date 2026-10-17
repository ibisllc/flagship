# backups: status (paused 2026-10-16)

Goal: one backup engine (scheduled + one-off, one .flagship file), a real backup policy with its size limit, Migrate on the archive path, on box + all three apps.

## Landed on main
- 7f94d8207 Box: scheduled backups on the server-archive format, KEK-pool deposit (flagship/server-archive-keys/v1 + vectors), retention, disk checks
- 8f8e002dc Box: backup policy (flagship/backup-policy/v1 + vectors), the size limit (phone reserve / peer 1/3 / none), refusals, appBudgets, peer hooks
- 3509450c9 Box: Back up now needs a passcode; a restore names failed apps and ends
- 14409cf52 Box: one .flagship file (FLGSHBK1 header + vectors, Range/4 MiB serving, shell split recipe tested)
- 76a094df2 Webapp: Backups section, signed policy at create, one-file download/import, gym-backups.spec.ts (shell v129)
- cb8801f0d Policy wording speaks of a device (webapp create form rule)
- 3524f5476 Box: Migrate on the archive path (pause + moving page, late restore order, box-to-box pull, probe, consumer swap)
- 76ea38429 + 9647d8c41 Webapp: Migrate data move with downtime estimate and progress (shell v131), gym scenario
- 524b32cba Box: restore from peers (from-peers route + setPeerFetcher wired to the peer engine)

## Saved, not landed
- wip/backups-2026-10-16 (ab02d8e35): webapp shows `storage` on the app page and server Backups section, and the app-storage-full alert (toast + notification opening the app page). Webapp unit tests green; no appStorage unit tests, no mock gym scenario, shell not bumped.
- iOS and Android sub-agents: wip/backups-ios-2026-10-16, wip/backups-android-2026-10-16 (they report their own status in status/backups-ios.md, status/backups-android.md).

## Remaining (in order)
1. S: land the storage WIP: unit tests for lib/appStorage.js, a gym-backups scenario (app full + alert), shell bump (apps/web).
2. L: iOS client per scratchpad/backup-client-spec.md (addendum A–D) + Migrate data move + storage display; mock gym.
3. L: Android client, same.
4. M: native Migrate screens spec for the sub-agents (mirror apps/web/public/webapp/lib/migrateArchive.js + server-detail.js migrate dialog).
5. M: phones' background fetch (BGProcessingTask / WorkManager) keeping the newest .flagship within the reserve (in the native spec, not started on main).
6. S: webapp "restore from peers" entry in Import a backup (needs the peer agent's /peer-backup/root; box route is on main).
7. S: AGENTS.md status entry for backups/policy/Migrate (not written yet).
8. S: Studio copy "any backups live with your phone/account" (HostedServersViews.swift:56/671) is now true only for phone-side; review.

## Blockers / owner decisions
- None open. Decided: KEK pool, passcode mandatory for manual, per-app give-up, one file only, Migrate pauses apps (with estimate), live replication later.
- Runtime writes past the limit depend on the quota agent's per-app quotas (landed per coordinator).

## Gym
- Added (webapp mock): gym-backups.spec.ts (5), gym-archive one-file download/import, damaged/truncated file, one-app-fails restore, Migrate start + data move; tools/gym registry updated. Box unit tests: schedule, retention, disk room, KEK deposit, restart persistence, one-file Range, 5 GB sparse file, policy/cap, migrate pause/pull/probe, from-peers.
- Missing: iOS/Android mock gym (sub-agents); live checks (spec #1 sent to the coordinator; Migrate live spec still to send: two gym boxes, migrate a real app with data, check data on the new box and the old box wiped).
