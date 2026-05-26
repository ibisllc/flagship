# v1 operational task list (persisted 2026-05-25)

Durable copy of the session task list (the harness TaskList does NOT survive a
reboot/new session). Source of truth for the remaining work to a full
end-to-end-operational v1. Companion docs: `docs/feature-parity.md` (P-tasks),
`docs/installer-tiny.md` (install path + §3a e2e findings), `docs/SESSION-HANDOFF.md`.

Owner legend: **agent** = doable in a Claude session · **ops/CI** = needs an
Alpine builder / Docker / R2 write · **owner** = hardware / Apple-Play
credentials / live exercise.

Branch: `feat/keyfile-backup-and-provisioning-status` (18 commits ahead of main,
all green; the integration point — D1 merges it). vitest 3864/308 green, iOS
xcodebuild green, Android gradle green, `tsc -b` clean.

---

## ✅ Done this session (committed)

### Earlier (before 2026-05-25 evening)
- **#10** installer-core (headless base config, GRUB BIOS+UEFI, success-gated self-wipe) — `ac527a9`
- **#11** recipe-sig verify ARMED (seam a) + first-boot provisioning WIRED (seam b) + QEMU full-install e2e runner; the e2e found+fixed 7 real install bugs and root-caused the modloop/af_packet blocker — `32d9af1`, `ee0b835`, `0d96c5b`, `25743a2`
- **#12** server personalize-stream endpoint (`POST /api/personalize-iso`) + box-side ISO9660 trailer-find + `/ready` custom-ISO download — `2bec7b8`, `baaffd3`
- **CS** removed iOS "Skip — pretend it's already running"; mock-backed real create-server flow via a demo-QR in MOCK mode — `97fae58`

### Parity wave 1 (2026-05-25 evening)
- **A1** `/ready` Advanced-options disclosure (BYO-ISO/Debian path tucked behind a `<details>`; Alpine custom-ISO download stays primary) — `620d16f`
- **P1 (webapp)** post-creation backup reminder banner on home (dismissable; reuses the wizard's `flagship.recovery.warn.v1` signal) — `e598f32`
- **P2 / P3 / P5 / P7 (iOS)** — trademark-claim, release-server (real `ReleaseServerName` envelope + release-then-revoke on cancel), dedicated audit-log viewer, tier-status screen — `ca7165a` (500 XCTest, 0 failures)
- **A2** Mac burner Quick (dumb-flash, default) vs Advanced (remaster) mode toggle — `e3407ef` (71 burner tests pass)
- **P2 / P3 / P5 / P7 (Android)** — Android half of the parity wave, wire-identical with iOS (same canonical bytes, copy, field sets) — `01e8dd4` (gradle test BUILD SUCCESSFUL)

### Parity wave 2 (2026-05-25 night)
- **P10 / P11 (webapp)** — full Replace-device + Wipe & restart ceremonies wired into Settings → Trusted devices. Both `<dialog>` flows with the 3-second-countdown confirmation, verbatim copy from `docs/revocation-ui.md`. New `lib/replaceDeviceCeremony.js` + `lib/wipeRestartCeremony.js`; canonical bytes round-tripped through `@flagship/protocol` verifiers in tests. `keystore.js` gains `currentIrkVersion()` for IRK rotation. — `20224ce` (full repo: 311 files, 3907 pass / 10 skip)
- **P1 (iOS + Android)** — persistent backup-reminder banner on Home, mirroring the webapp predicate. `RecoveryBannerStore` on each platform; dismiss flag in UserDefaults / SharedPreferences. — `4bd3e73`

### Parity wave 3 (2026-05-25 night, cont.)
- **P9 daemon BFF** — `GET /api/screens/peer-backup/status` + `POST .../toggle` on the daemon Screens-BFF, byte-for-byte matching the webapp's expected 22-field response shape (so the existing webapp view lights up). Pure projector `buildPeerBackupStatus()` over BackupLoop + ShardRegistry. Honest about data gaps (per-shard bytes, peer liveness, repair-tick counters not yet tracked → returns 0/empty/idle rather than fabricating). — `af9cbc7` (313 files / 3940 pass / 10 skip)
- **P13 (webapp + iOS + Android + Worker handler)** — per-server kill-switch end-to-end. Each client surface adds a "Danger zone" to the server-detail screen with the reason picker (lost/stolen/decommissioned) and the established confirmation (1.5s hold mobile / 3s countdown webapp). Canonical bytes `flagship/revoke/v1|userId|revokedServerId|reason|issuedAt`, IRK-signed. The Worker handler (`handleRevokeServer` in `packages/control-plane/src/serverRevocation.ts`) verifies + idempotency + walks `AutoUnlockLeaseStorage` and `BoxSealedLeaseStorage` to tear down every active lease for that server (the "brick on next boot" effect). `AuditEventKind` gains `server-revoked`. — `be1553e` (webapp) + `a53386d` (iOS+Android) + `859e17f` (Worker)
- **D2 (local hygiene, not committed)** — pruned 83 merged branches + 51 stale `.claude/worktrees/agent-*` worktrees. Remaining: main + `w11` (unmerged, kept) + 3 unmerged worktree-agent branches.

### Parity wave 4 (2026-05-25 night, cont.)
- **P9 client UIs (all 3 surfaces)** — closes the P9 row end-to-end. Webapp view wired into Settings + reconciled field-by-field with the BFF (no drift; honest-zero rendering for the documented data gaps) — `8cbccf7` (76 files / 785 pass). Mobile UIs on iOS + Android with byte-identical wire shapes (Codable + @Serializable types mirror the daemon's TypeScript), new PeerBackupViewModel + PeerBackupScreen on each platform, Mock fixtures + 9 + 8 tests, hand-rolled stubs in ActivityViewModelTest*s patched for the interface extension — `4b82f5a`.

### Parity wave 5 (2026-05-25 night, cont.)
- **P4 Android QR pairing + admit** — Compose `QrImage` wrapper over the existing ZXing+PairingQr path, focused VM tests on the admit boundary (happy / server-rejects / wrong-device fail-closed), 3 canonical-bytes pins against iOS + the Worker verifier (`flagship/device-admit/v1|<username>|<newDevicePubHex>|<issuedAt>`). The bulk of the admit flow was already in place from earlier work — this rounds out the verification surface. — `f607668`
- **P12 webapp multi-profile + storage migration** — new `lib/profilesStore.js` owns a per-profile `flagship.profiles.v2` namespace, idempotent one-shot legacy migration gated by a sentinel (NEVER nukes legacy keys), bidirectional mirroring so unrefactored call-sites stay aligned. New Profiles view mirrors iOS visually. 21 + 5 new tests; 811 webapp tests pass. — `a76cf57`

### Parity wave 6 (2026-05-25 night, cont.)
- **P6 daemon BFF + production wiring** — 4 collaborator-invite routes (issue / list / access / revoke) on the daemon Screens-BFF, backed by the existing `AppInviteStore` (with two new methods — `listPendingInvites` + `revokeInvite`). The production daemon entry constructs one `InMemoryAppInviteStore` so the phone-side signed surface and the BFF point at the same ledger when the signed surface gets wired. 20 new tests. — `87868e8` + `d0e6508`
- **P8 mobile WS framebuffer viewer (iOS + Android)** — full server-side-browser viewer mirroring the webapp byte-for-byte: WS URL shape, frame/error/input wire shapes, JPEG decoding into UIImage/Bitmap, drag → mouseDown/Move/Up, exp-backoff reconnect ≤3. 14 + 14 new tests; phase-2 deferrals (keyboard, scroll-forwarding gestures, finer error surfacing) noted inline. — `1540747`

### Parity wave 7 (2026-05-25 night, cont.)
- **P6 client UIs (all 3 surfaces)** — closes P6 end-to-end. Webapp finalize (empty-state copy + 4 new tests). New iOS InviteIssue/InviteManage + InviteLabelBook (UserDefaults). New Android equivalents (SharedPreferences). Privacy invariant preserved on all 3: only `opaqueTag` + `role` + `contextNote` cross the wire. Webapp 815 pass, iOS green, Android BUILD SUCCESSFUL. — `a25a864`

---

## A — Install → live padlock (the e2e operation)

- ~~**A1** — `/ready` Advanced-options affordance (BYO-ISO/Debian)~~ ✅ `620d16f`.
- ~~**A2** — Burner Quick (default, dumb-flash) vs Advanced (remaster) toggle~~ ✅ `e3407ef`. The TS burner in `packages/flagship-burner` is a CLI library only (no UI), so the "Mode toggle" lives on the Mac GUI; the TS side already exposes both code paths.
- **A3** — Base-ISO af_packet fix (modloop/DHCP). **_ops/CI (lynchpin)._** Stock
  Alpine standard ISO in apkovl-mode doesn't mount modloop → no af_packet → no
  DHCP (`docs/installer-tiny.md §3a`). Bake af_packet into the initramfs / make
  modloop mount. Unblocks a green `qemu-install-e2e.sh` AND the real install.
  Needs an Alpine builder — not doable on the Mac.
- **A4** — Build reproducible Alpine base ISO + upload to R2 as
  `ALPINE_BASE_ISO_KEY` (default `flagship-alpine-base.iso`). _ops._ Blocked by
  A3. Until done, `/api/personalize-iso` 503s.
- **A5** — Real-hardware Alpine e2e: fresh backed-up account → custom ISO →
  dumb-flash → boot → early-signal timeline → green padlock. _owner._ Blocked by
  A3, A4. Box: `flagship-pod`/pw `flagship`; burn LUKS pass
  `flagship-burn-time-luks-rekey-me-immediately`.
- **A6** — Real-hardware boot-unlock e2e via `boot.flagshipserver.com` (deployed):
  reboot → box fetches sealed lease / requests unlock → phone approves → LUKS
  unlock; both `auto` and `approve` modes. _owner._ Blocked by A5.

## P — 3-surface feature parity (webapp · iOS · Android)

See `docs/feature-parity.md` for the full matrix. Every task is audit-then-port.

- **P0** — Parity audit gate + keep `docs/feature-parity.md` current; verify the
  "done" cells are truly wired (marketplace iOS, create-server iOS pickers). _agent._
- **P1** — Post-creation backup REMINDER on all 3. _agent._ ✅ (`e598f32` + `4bd3e73`).
- **P2** — Trademark-claim → iOS + Android. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P3** — Pending-server cancel → real `ReleaseServerName` envelope + `/api/server/release`. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P4** — Cross-device QR pairing + admit → Android. _agent._ ✅ (`f607668`).
- **P5** — Audit log → iOS + Android. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P6** — Collaborator invites (issue + manage) → daemon BFF + 3 UI. _agent._
  ✅ (`87868e8` BFF + `d0e6508` prod wiring + `a25a864` client UIs).
  Privacy invariant preserved on all 3: server sees only opaqueTag + role
  + optional contextNote; labels (displayName/channel/sentTo/notes) stay
  on each client keyed by (serviceId, opaqueTag).
- **P7** — Tier-status / monetization → iOS + Android. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P8** — Browser-viewer → iOS + Android. _agent._ ✅ (`1540747`).
  Native WS clients streaming JPEG frames + forwarding mouseDown/Move/Up
  (scroll + keyboard are Phase-2 plumbing-ready deferrals). The locked
  decision held: this is the server-side-browser-tab viewer for bot
  workflows, NOT a phone-side WebView.
- **P9** — Peer-backup management → daemon Screens-BFF + 3 UI. _agent._
  ✅ (`af9cbc7` BFF + `8cbccf7` webapp + `4b82f5a` mobile). All four
  parts shipped: daemon BFF (matches webapp's expected 22-field shape),
  webapp view wired into Settings, iOS + Android Compose UIs reading the
  same wire shape. Honest-zero rendering surfaces the documented
  daemon-state gaps (per-shard bytes, peer liveness, repair counters)
  without faking values.
- **P10** — Replace device (IRK rotation) → webapp. _agent._ ✅ (`20224ce`).
- **P11** — Wipe & restart → webapp. _agent._ ✅ (`20224ce`) — full ceremony,
  not the older "ship disabled" stance.
- **P12** — Multi-profile switching → webapp. _agent._ ✅ (`a76cf57`).
  Per-profile localStorage namespace (`flagship.profiles.v2`) + one-shot
  idempotent legacy migration + new Profiles view. Defensive: legacy
  keys retained + bidirectional mirroring so unrefactored call-sites
  stay aligned (a future hard cut-over removes the mirror).
- **P13** — Kill-switch / server-revocation UI → all 3 + Worker handler. _agent._
  ✅ (`be1553e` + `a53386d` + `859e17f`). Per-server danger zone with reason
  picker + 1.5s hold (mobile) / 3s countdown (webapp); IRK-signed; the Worker
  cascades the boot lease tear-down so the box bricks on next boot.
- **P14** — Companion-browser dock (new, 2026-05-25). Every owner app must be
  able to dock to a regular browser as an ephemeral companion surface (the
  owner app is the long-lived trust root, the browser is paired in for
  ergonomic input; WhatsApp-style). Cross-cutting; lands on all three. _agent._

## C / TF — Ship the apps

- **TF1** — Wrangler APNs secrets (4 + `wrangler login`) in `apps/com/`:
  APNS_KEY_ID=FHZWTBFQCM, APNS_TEAM_ID=8G8RHBU9BN,
  APNS_BUNDLE_ID=com.flagshipserver.app, APNS_PRIVATE_KEY_PEM=<AuthKey_FHZWTBFQCM.p8>.
  _owner (interactive login)._
- **TF2** — Tick "Associated Domains" capability on App ID com.flagshipserver.app
  (checkbox only; entitlement already correct). _owner._ Blocks TF3.
- **TF3** — Xcode Archive → Distribute → App Store Connect. _owner._
- **TF4** — ASC metadata: privacy URL (https://flagshipserver.com/privacy.html —
  exists), 1024 icon, screenshots, nutrition labels, "What to Test", Company
  "Houston Automation Lab". _owner (agent can draft What-to-Test + extend privacy
  for APNs)._
- **TF5** — Smoke push on a real device (sim has no real APNs token). _owner._
  Blocked by TF1, TF3.
- **TF6** — Invite 5 external TestFlight testers (Apple beta review ~1–2 days).
  _owner._ Blocked by TF3, TF4.
- **C1** — Android app → Play internal track (build/sign AAB, FCM, upload, 5
  testers). _owner (JDK/Android SDK + Play Console)._

## D — Integrate the WIP

- **D1** — Merge `feat/keyfile-backup-and-provisioning-status` → main after the
  full gate. _agent preps, owner approves push._ Blocked by A1, A2, P1, P2, P3
  (land a coherent slice first).
- ~~**D2** — Prune stale branches~~ ✅ (local cleanup, no commit). 83
  merged branches + 51 `.claude/worktrees/agent-*` worktrees removed.
  Remaining: main + `w11` + 3 unmerged worktree-agents (kept intentionally).

## E — v1-alpha live exercises (docs/build-tasks.md §S)

- **E1** — recovery (lost phone→new), STK rotation, update-pack across 2 pods
  over 7 days, lineage-break + re-anchor. _owner/live._
- **E2** — Marketplace MVP live (≥10 listings, ≥3 cross-pod installs) + LLM-promo
  cap enforced/tested. _owner/live._
- **E3** — Public security disclosure pages + bounty payout path. _owner._

---

## Dependency chain (key)

```
A3 ─▶ A4 ─▶ A5 ─▶ A6
TF2 ─▶ TF3 ─▶ TF5 / TF6
(A1, A2, P1, P2, P3) ─▶ D1
```

## Next agent-doable, smallest-first
(Updated 2026-05-25 late after wave 7.) Every P-task except P14 + P0
is now ✅ across all 3 surfaces. **Up next**: P14 companion-browser
dock (all 3, new design work — no precedent, would benefit from an
owner design pass before agents) → P0 verify-only audits (marketplace
iOS / create-server iOS pickers — light read-only review). Then the
hardware/owner items (A3–A6 base-ISO + e2e, TF* App Store, C1 Play,
E1–E3 v1-alpha live exercises).
