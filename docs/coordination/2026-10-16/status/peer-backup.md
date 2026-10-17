# peer-backup (paused 2026-10-16)

**Goal:** peer backup between accounts. A Peer server's newest scheduled archive is stored as 4-of-8 bricks on other accounts' servers. The matching is blind, filler is provable, owners prove their bricks with Merkle challenges, and a restore works from any device with the UMK. Design: docs/peer-backup.md.

## Landed on main
- 7ca3dbfe3: design doc, protocol (keys, bricks, Merkle, mailbox, filler, root, RFC 9474 blind RSA, vectors), and the MDS erasure fix (the old 4/8 coder lost {2,4,5,6}).
- 79a53c408: index holds shard hashes; the mail AEAD is pluggable.
- 4db2f7f88: .com check-ins, filler, directory, tokens, redeem and roots; D1 store; migration 0104 (KNOWN_MIGRATIONS + wipe list).
- 0ea6e7a5e: relay mailboxes over the tunnel (hub /pb/m/<id>, pb-mail-v1, PIK-signed announce).
- 645e6c3c7: box engine (holder/owner/restore) + a 10-server simulation in CI (honest, drop, garbage, collusion, offline, leave, double-spend, filler cheat, restore from any 4; also on D1).
- 76a3a321e: daemon wiring (policy, cap, saved hooks, status slot, tunnel mail), BFF v2 status, POST /api/screens/peer-backup/root.
- 08b1df223: gym-only PB_* secrets in gym-setup-live-env.sh / gym-refresh.sh, PB_NETWORK 1/1 in wrangler.gym.toml, owner setup commands, filler Worker cost (§14–15).
- 2af854e81: the v2 status keeps the v1 fields, so old clients and Migrate's pre-flight keep decoding it.
- (Backup agent, 524b32cba: from-peers restore calls our fetchArchive.)

## Saved but not landed
- wip/peer-backup-2026-10-16 = main at 2af854e81 (nothing unlanded; green).

## Remaining work (in order)
1. M — Webapp: rewrite apps/web/public/webapp/views/peer-backup.js for v2 (status lines shared with lib/backupPolicy.js peerLines; holders "Server 1..n" with state and last proof; hosting breakdown; restore-by date; no toggle). Add a "Details" link from the server-backups.js #bk-peer slot. Update tests/webappPeerBackupView.test.ts. Bump the shell above origin/main (v131 when paused).
2. M — Webapp restore from peers: the device derives PBK = HKDF(deriveSwkFromSeed(UMK, lostServerId), "flagship/peer-backup-key/v1") (vector in packages/protocol/test-vectors/peer-backup), then POST /peer-backup/root → open the archive's account slot → /server-restore/order → /from-peers → /commit (flow in the backup agent's note). Files: lib/serverArchive.js plus the import view.
3. M — iOS: a PeerBackupStatusV2 model (FlagshipAPI ScreensModels.swift), the client method, VM, PeerBackupScreen.swift rewrite, tests; the same restore-from-peers option. Delete DerivedData afterwards.
4. M — Android: the same in ScreensModels.kt, LiveScreensClient/Mock, PeerBackupViewModel/Screen, tests; `./gradlew clean` afterwards.
5. S — Mock gym scenarios on all three apps (peer status states; restore from peers). Update parity/features.json.
6. S — Live-gym group spec (tools/live-e2e): A/home on Peer → bricks on B/home; status protected; root opens; restore onto a fresh box from peers; check-in/filler proof seen. Needs refresh + migration 0104 + an endorsed box release ≥ 76a3a321e + a .services deploy.
7. S — Retire v1 (backupLoop file walk, /api/peer-backup/frames, request-peers/stk) once nothing calls runRestoreOnce; delete v1 dirs at start (§12).
8. L (phase 2) — decoy leases from .com through the relay (§6.3); hub routing across Fly machines (mailbox 404 on the other machine).
9. S — AGENTS.md status entry.

## Blockers / owner decisions
- Prod: migration 0104 + PB_TOKEN_RSA_JWK / PB_FILLER_SECRET / PB_TAG_SECRET (exact commands in docs/peer-backup.md §15), then .com and .services deploys and an endorsed box release.
- Relay egress cost: every brick crosses Fly (≈2× archive per weekly generation). Accept it, or plan incremental archives.

## Gym coverage
- Added: CI simulation (control-plane), the hub mail e2e (apps/web/tests/tunnelPeerMail.test.ts), engine/BFF unit tests, .com D1 route tests.
- Missing: mock gym scenarios on all three apps; the live-gym peer-backup group.
