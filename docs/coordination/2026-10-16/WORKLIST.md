# MVP work list (coordinator, 2026-10-16 evening)

Rule from now on (2026-10-17: raised to THREE slots): at most THREE worker agents at once: one per build lock (Android, iOS) plus one web/box-only agent that takes no build lock:
an ANDROID stream (owns android-build.lock) and an iOS stream (owns native-build.lock).
Each stream works through its list in order: rebase a wip branch → build → unit tests → mock gym → land → next.
Web/box-only items run in whichever stream is idle on native builds, or by the coordinator.
Status files: scratchpad/status/*.md. Decisions: scratchpad/decisions.md. Manual tests: scratchpad/manual-tests.md.

## Stream A: Android (one agent, in order)
A1. android-device-bugs: wip/android-device-bugs-2026-10-16 (Bug 1 no fixtures, mocks/dev mode out of release, C1–C4 cloud recovery, M6/M9 draft + subdomain, M10 logging, M11 stuck Authenticating, M12 cold-start lock, M14 key backup off main thread, M8 biometric binding). Then a debug APK → the coordinator retests on Harry's phone (M8 create server, burn to USB, M12).
A2. co-invite-native (Android half + Android IDE configs + docs): wip/co-invite-native-2026-10-16, commits 30cd31db7, b09613837, 259b16354.
A3. share-accept Android: wip/share-accept-2026-10-16.
A4. debug-access Android: wip/debug-access-2026-10-16 (310ba149f).
A5. env-sign Android part: wip/env-sign-2026-10-16 (see status/env-sign.md).
A6. backups Android: wip/backups-android-2026-10-16 (Backups section, policy, one file, phone copy WorkManager, wizard).
A7. android-gym sweep: wip/auto-a362f24ae7b10110f-2026-10-16 (auto-saved; agent cut off before its status; ~90 sweep scenarios + follow-ups A1-A5 + admin-only server page + signature-verifying mocks, needs a build + emulator run).
A8. android-redesign (Material 3, iOS baseline): wip/android-redesign-2026-10-16 (theme, components, 4 tabs + ~60 screens converted; never compiled; agent cut off before its status). Largest; last, so the gym and features settle first.

## Stream B: iOS (one agent, in order)
B1. no-mocks iOS: wip/no-mocks-2026-10-16 (Release build + binary scan, Debug build, gym, land).
B2. debug-access iOS: wip/debug-access-2026-10-16 (iOS commits).
B3. share-accept iOS: wip/share-accept-ios-2026-10-16.
B4. co-invite iOS IDE configs: commit 4fe43b944 on wip/co-invite-native-2026-10-16.
B5. env-sign iOS part.
B6. backups iOS: wip/backups-ios-2026-10-16 (status pending).
B7. ios-gym sweep + helpers: wip/ios-gym-2026-10-16 (agent cut off while writing status; helpers' work in the same worktree).
B8. iOS small fixes from the Android agent: backup banner full stop; "box" → "server" in Activity; subdomain prefilled "home"; recovery text says "iCloud Keychain" but should name the passkey app.

## Stream C: cross-platform features (after A1/B1; webapp first, then the native ports go into A/B)
C1. Device pairing, real relay, ADMIN-ONLY (decided): webapp first (wip/pairing-relay-2026-10-16: join sends grant + profile; .com has refused it since July), vectors, then iOS (B) and Android (A), live check.
C2. Peer backups clients: webapp v2 status + restore from peers, then iOS/Android, gym, live spec; retire the v1 code.
C3. Backups remainder: webapp storage WIP (wip/backups-2026-10-16) + tests + shell; native Migrate screens spec; AGENTS entry; Studio wording.
C4. connect-account Android: wip/connect-account-2026-10-16 (webapp dbb1d746e/bb7a9de79 and iOS e2b23515a landed; Android compiles, 39/40 unit, rerun + GymOnboardingTest + land). Do it right after A1.

## Stream D: live gym (one agent, owns gym.lock; can run alongside A/B since it uses no build lock)
D1. gym-refresh (PB_* secrets, D1 0104) → full run with wip/live-gym-2026-10-16 (archive, migrate, backups, quota groups) → fix → land.
D2. 3 green full runs in a row; AGENTS paragraph.
D3. Later: peer-backup group (needs an endorsed release), mcp-ide --ai variant.

## Owner (Harry)
O1. DNS zone (154/200, ~12 records per account): approve reaping ~70 leftover records (coordinator gives the exact command), then choose the long-term fix (wildcard per account / higher Cloudflare cap / gym on its own domain, which also fixes the shared Let's Encrypt budget).
O2. Deploy .com from main (D1 migration 0104 first) and .services; set PB_TOKEN_RSA_JWK / PB_FILLER_SECRET / PB_TAG_SECRET (docs/peer-backup.md §15; never rotate the filler secret).
O3. Endorse a box release (YubiKey) once A/B/D are green: every box-side change today needs it.
O4. Renew the CA lease before 2026-11-05 (share acceptance and every CA check depend on it).
O5. Store builds (iOS + Android, new versionCode) after O3.
O6. Confirm: the shared server keeps the joining account's admin PUBLIC key (never the name), docs/share-a-server.md §2.
O7. Confirm: Relay egress for peer backups (~2× archive per weekly generation through Fly) is acceptable for now.

## Then
E1. GA close-out (AGENTS.md list) once the gym is green.
E2. Harry's Windows PC + Chromebook runs (docs/runbooks/device-test-agent.md).

## Also saved
- Auto-backups of other worktrees: wip/auto-<agentid>-2026-10-16 (a079b83 build-chat-model-switch, a25bff, a31d97, a85a0ff, abb758 = debug-access Android fork incl. untracked files; already salvaged into 310ba149f).
- Every agent is paused or stopped; no locks held after the Android gym agent's lock is released.

## Added 2026-10-17 (owner)
F1. GitHub CI on main: make every workflow green (CI tsc+vitest, e2e Playwright+pod-sim, android unit tests+debug APK, iOS, parity, others). List the latest failing run per workflow with `gh run list --branch main`, read the logs (`gh run view --log-failed`), fix the cause (not by skipping tests), land, repeat until green. Web/box slot, no native lock. Land checks must be unpiped.
F2. Debate (no code): should free users get one custom domain, or is routing your own domain(s) to your box a free feature? Write a short for/against with a recommendation into decisions.md; owner decides. Today: custom domains are a Pro feature on feat/custom-domains (1 domain at Pro, unlimited at Pro Max); main refuses new orders.
F3. iOS Activity tab: accordion sections (one open at a time, inner scroll when long), account events with "load more" (no separate audit-log entry), server section named after the server, absolute date+time stamps, more event kinds labelled. Coordinator, branch coord-activity; pushed to the owner's iPhone.
F4. Android Activity tab: port F3 in spirit (Material 3 expandable sections, same wording and event labels). Standing rule: every approved iOS UX change gets an Android port (decisions.md 2026-10-17).
P1. iOS UI polish pass to native state of the art (every screen: spacing, type scale, hierarchy, empty/loading/error states, dark mode, Dynamic Type, iPad layout, animations, haptics; no sloppy copy). Screenshot every screen on iPhone + iPad simulators, critique against Apple HIG, fix, re-shoot. Owner: not optional for GA.
P2. Android UI polish pass to Material 3 state of the art (same method, emulator phone + tablet, dark/light, dynamic type/font scale, predictive back, edge-to-edge, motion).
