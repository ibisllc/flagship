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

### Parity wave 8 (2026-05-26, design decisions in)
- **P14 Phase 1 (all 4 surfaces)** — companion-browser dock. Owner picked "Remote-control + 4h TTL" (WhatsApp-Web pattern) + "All 3 hosts + receiver in one big wave". Daemon: companion-ticket store + 4 endpoints (mint / redeem / list / revoke); paired-session store gains `companion` + `expiresAt` columns; companion writes → 403 `companion-write-not-allowed`. Webapp: host UI in Settings + boot-time `?companion=…` receiver flow that persists a `kind: companion` profile in the P12 store + `requireOwnerProfile()` gates on every signing helper. iOS + Android: matching host UIs. QR encodes `https://web.flagshipserver.com/?companion=<base64url JSON>` with sorted-keys (iOS) / declaration-order (Android) JSON; 60s ticket TTL, single-use; 4h companion session TTL. — `c7ea6e6` (48 new tests on daemon+webapp + 23 iOS + 17 Android; full repo 4067 pass / 10 skip)

### Parity wave 9 (2026-05-26, cont.)
- **P9 daemon data gaps closed** — the three documented "honest zeros" now carry real data. `MyShardRow` gains `sizeBytes` (required); RepairDaemon.placeOne writes `bytes.length`; projector sums real bytes. New `PeerActivityWatchdog` + `wrapPeerLink` tap PeerLink send/recv; projector prefers watchdog ts over the `lastChallenge ?? storedAt` proxy when newer. New `RepairStatsAccumulator` (24h rolling window) implements `RepairStatsProvider`. No wire-shape changes — existing slots populated. Caveat: RepairDaemon has no production caller yet; the accumulator is wire-ready and starts emitting real numbers once a scheduled-tick site lands. — `c0ff3cb` (26 new tests; 1031 daemon pass)

### Parity wave 10 (2026-05-26, cont.)
- **P8 keyboard polish (iOS + Android)** — the framebuffer-viewer VMs already exposed `sendKey`; this lands the on-phone UI. Each surface adds a "Show keyboard / Hide keyboard" toggle in the controls bar that focuses a soft-input field; every value-change is diffed via the pure `keyEvents(from,to)` helper (insert / delete / replace) and shipped as keyDown+keyUp pairs through `vm.sendKey`. Backspace handled. DOM-code mapping covers letters + digits + Space/Enter/Tab/Period/Comma/Slash/Minus/Equal. Wire format byte-identical with the webapp + the existing P8 tests. — `4bc57cc` (iOS) + `a03a05c` (Android)
- **Webapp polish — TOTP 401 retry + pending /re-pair banner** — closes the two follow-ups from commit `20224ce`. `replaceDeviceCeremony.js` detects the Worker's 401 `{ accountType: "multi" }` body, prompts for a 6-digit code via injected `requestTotpProof`, retries with `totpProof: { code, method }`. New `fetchPendingRePair()` polls `GET /api/users/:u/re-pair` (verified to exist at `packages/control-plane/src/rePair.ts:1019-1037`); new `lib/pendingRePairBanner.js` renders a "Replace pending — Finalize now" banner above the device list when grace is elapsed. Worker side flagged as needing nothing; v2-hardening note: the GET is unauthenticated by design (leaks pending pubkeys to anyone who knows the username). — `27b14b1` (22 new tests; 867 webapp pass)

### Parity wave 11 (2026-05-26, cont.) — P14 Phase 2 write-relay
- **Daemon write-relay (4 endpoints)** — `POST /api/companion/request-write` (companion-gated, kinds limited to release-server + revoke-server in v1), `GET /api/screens/companion/pending-writes` (owner-gated), `POST /api/screens/companion/resolve-pending` (owner-gated, idempotent), `GET /api/companion/my-pending` (companion-gated; resolved rows are sticky and do NOT downgrade to expired). New InMemoryCompanionWriteRequestStore. Phase 2.5 push hooks marked inline. 27 new tests. — `0c6e7bd`
- **Webapp both halves** — companion-side: `requireOwnerProfile()` in releaseServer.js + revokeServer.js now routes through `submitWriteRequest` instead of throwing; a polling sheet shows "Forwarded to owner — waiting (mm:ss)" until the daemon's my-pending shows approved/denied/expired. Owner-side: new Settings → "Companion requests" view with a pending-count badge; Approve runs the existing signer helper (releaseServerName / revokeServer with the owner's umk + signWithIrk) and posts resolve {approved} ONLY on destination-POST success; Deny posts resolve {denied}. 45 new tests; full repo 4186 pass. — `fc4da67`
- **Mobile owner UI (iOS + Android)** — Settings → "Companion requests" with pending-count badge. Each row's intent (release/revoke) is parsed per-kind from the dynamic JSON (`[String: AnyCodable]` on iOS, `JsonObject` on Android). Approve uses 1.5s hold-to-confirm (`LongPressGesture` / `withTimeout(1500)`); calls `FlagshipServerClient.releaseServerName` or `.revokeServer`; only on destination-POST success posts resolve. Inline error slot per row preserves the request for retry. 8 + 7 new tests. — `b499dd8`

### Parity wave 12 (2026-05-26, cont.) — close-out
- **P0a + P0b iOS gaps** — create-server adds the backup-policy picker (none / phone-only [default] / peer) + LLM-preferences TextEditor with UserDefaults-backed CreateServerDraftStore persistence (matches webapp's buildDraft.js vocabulary byte-for-byte; draft-only — never enters the signed InstallBlob). Marketplace detail's Deploy button is now a real install: ScreensModels gains InstallServiceRequest + canonical bytes `flagship/install-service/v1|serverId|creator|slug|manifestJson|(1|0)|issuedAt`; LiveScreensClient hits `<podBaseUrl>/api/services` (the daemon's service-platform handler, NOT /api/screens/*); MarketplaceDetailContainer wires idle/installing/succeeded/failed states. 7 + 5 new tests. — `e6d932b`
- **P12 hard cut-over** — drops the bidirectional localStorage mirror introduced by the original P12 (`a76cf57`). `profilesStore.set(...)` no longer mirrors writes to the flat key by default; device-wide slots (`username`, `wizardState`, `currentIrkVersion`) are explicitly carved out via a new `deviceWideOrPreProfile` flag. New `cleanupLegacyKeys()` runs once on boot (gated by both `migrated.v2` AND `legacyCleaned.v1` sentinels), deletes legacy flat keys ONLY when the new store has the value (orphan-defense). 14 call-sites refactored to use `profileGet`/`profileSet`/`profileRemove` (lib/api, state, push, keyfileBackup; views: wizard, home, unlock, pair, activity, recovery, bootstrap, join, companion-dock, pending-server). 38 store tests (+17 new), 929 webapp pass. — `23f9aee`

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

## Next session opens here

See **`docs/next-session-handoff.md`** — focused pick-up-here list for the
human path (deploys / Apple / Play / hardware / live exercises) plus the
remaining agent-doable items (image-size follow-ups, v1 polish,
NFC tier first wave). Updated 2026-05-26 end-of-day.

---

## Agent-doable backlog: **EXHAUSTED** (2026-05-26)

Every P-task and every smaller follow-up I could land without
credentials or hardware is on main. The remaining items are all
irreducibly human / ops:

- A3 Alpine base-ISO af_packet fix → A4 R2 upload → A5/A6 real-hardware
  Alpine e2e (the lynchpin gate for real green padlock on real
  hardware).
- TF1 wrangler APNs secrets + TF2 Associated Domains tick + TF3 Xcode
  Archive → TF4 ASC metadata → TF5 device-push smoke → TF6 5 testers.
- C1 Android Play internal track.
- E1–E3 v1-alpha live exercises (recovery / rotation / update-pack /
  marketplace MVP / disclosure + bounty).

The Worker deploy for the P13 server-revoke endpoint + the daemon
rebuild that picks up P6/P9/P14 BFFs are also owner-driven (wrangler
deploy + daemon binary rebuild + redeploy).

### Possible follow-ups (defer-able, no v1 blocker)
- P14 Phase 2.5 push integration (replace the polling with
  notifyOwner/notifyCompanion at the two HOOK comments in the daemon).
- P14 expand the relayable-kinds list beyond release/revoke-server
  (replace-device, wipe-restart — both involve recovery passkeys, so
  defer until a real need surfaces).
- keystore.js refactor to read currentIrkVersion through profilesStore
  (today it has its own per-profile suffix scheme).

---

## N — NFC retail tier (post-v1, planned)

The NFC tap-to-pair design for pre-built retail boxes lives in
`docs/nfc-box-pairing.md` (with refinements + locked decisions appended
2026-05-26). **Post-v1 by design** — nothing here ships before the core
v1 launches. The original spec's implementation checklist is
reorganized here into agent-doable / human-required / business-gated
buckets.

Owner decisions locked 2026-05-26 (see the doc for full text):
- Q1 online-activation gate: **deferred** (tamper-evident + first-claim only).
- Q2 iOS NFC flow: **try read+write, fall back to LED-SAS**.
- Q3 hardware shipping model: **deferred** (business gate; design tasks proceed).
- Q4 `BoxUnpair` semantics: **rebind only, no remote wipe**.

### N-PROTO — Protocol additions (`@flagship/protocol`)
- [x] **N-PROTO-1** `PAIR` + `SIG` canonical-bytes type + Ed25519 verify; HKDF transcript derivation (`flagship/pair/v1`). _agent — `packages/protocol/src/nfcPair.ts` + 27 tests._
- [x] **N-PROTO-2** `BoxUnpair` envelope `flagship/box-unpair/v1|userId|boxId|issuedAt`, IRK-signed, rebind-only semantics. _agent._
- [x] **N-PROTO-3** `WiFiConfig` envelope carried over K_session after pair. _agent — sealed under AES-GCM with K_session as key; tag-check on open prevents key-collision reinterpret._
- [x] **N-PROTO-4** SAS derivation helper + LED-SAS encoding alphabet (4-color pulses, 3-of-3 confirm, 10s/pulse, 3 retries). _agent — RGBY alphabet fixed at v1; bump `PAIR_PROTOCOL_VERSION` to reorder._

_Follow-up (small):_ add PAIR / BoxUnpair / WiFiConfig golden vectors to `test-vectors/canonical-bytes.json` to lock the byte format permanently (`canonicalBytesVectors.test.ts` is the drift detector).

### N-BOX — Box firmware / ISO (single golden image)
- **N-BOX-1** Box state machine — UNPAIRED (regen) → PAIRED (persist) → RESET (secure-erase); wire into `server-daemon` boot path. _agent + hardware to verify — pure state machine is **DONE** in `packages/server-daemon/src/nfcPairing/pairStateMachine.ts`; boot-path wiring still pending._
- [x] **N-BOX-2** Per-boot ephemeral keygen + hard RNG entropy gate (`entropy_avail ≥ 256`). _agent — `nfcPairing/rngGate.ts` + `nfcPairing/pairEmitter.ts:generatePairKeys`._
- **N-BOX-3** Pair-mode emitter — write `PAIR`/`SIG` (NDEF) to the tag; clear on PAIRED. _agent + MCU bring-up to test end-to-end._
- **N-BOX-4** Power-button long-hold handler — 10 s with LED countdown, no ACPI collision. _agent + hardware._
- [x] **N-BOX-5** First-valid-claim latch + 30 s session-lock window. _agent — `nfcPairing/pairStateMachine.ts`._
- **N-BOX-6** LED status driver + SAS encoder (fallback flow). _agent + hardware._
- [x] **N-BOX-7** mDNS advertise + cloud rendezvous (`hint` includes the 6-digit STK suffix for disambiguation). _agent — payload assembly in `nfcPairing/pairEmitter.ts:buildPairHint`; actual mDNS publisher binding still pending._
- **N-BOX-8** Post-pair Wi-Fi config receiver (over K_session). _agent — protocol envelope shipped under N-PROTO-3; daemon-side receiver still pending._
- [x] **N-BOX-9** Resale wipe verification — read-back 4 KiB after LUKS erase. _agent — `nfcPairing/wipeVerifier.ts`._
- **N-BOX-10** ISO RNG seeding (jitterentropy + haveged-equivalent baked in). _agent + ops/CI (the ISO build pipeline)._
- **N-BOX-11** NFC-failure graceful-degrade to DIY HDMI+QR path on the same box. _agent._

### N-MCU — Companion MCU (branded SKU; gated on N-BIZ)
- **N-MCU-1** Pick MCU + NTAG part (NT3H2111 / ST25DV + CH32V/STM32C0). _hardware._
- **N-MCU-2** MCU firmware: USB-CDC payload receive + NTAG I²C driver + read+write tap handling. _hardware + agent for protocol-spec adherence._
- **N-MCU-3** Reference schematic + antenna layout. _hardware._
- **N-MCU-4** Production bring-up + QA procedure. _hardware + ops._

### N-PHONE — Phone apps
- **N-PHONE-1** iOS Core NFC capability + entitlement + usage strings. _owner (Xcode/ASC)._
- **N-PHONE-2** iOS `NFCTagReaderSession` read flow + pairing UI ("tap your box"). _agent._
- **N-PHONE-3** iOS read+write tap with LAN+LED-SAS fallback (per Q2). _agent._
- **N-PHONE-4** Android NFC read/write + pairing UI. _agent._
- **N-PHONE-5** ECDH + K_session derivation + claim submit (both platforms). _agent._
- **N-PHONE-6** LED-SAS fallback UI (camera capture + decode of the LED pulse pattern). _agent._

### N-CLOUD — Cloud / Worker
- **N-CLOUD-1** Activation API — `POST /api/serial/activate` (retailer-scoped auth) + `GET /api/serial/{serial}/status` (in-store-only per Q1). _agent._
- **N-CLOUD-2** Worker-side enforce "activated" check on first ownership claim for branded boxes. _agent._
- **N-CLOUD-3** Two-box disambiguation rendezvous: the cloud `hint` carries the 6-digit STK suffix so a phone can pick the right candidate. _agent._

### N-MFG — Manufacturing / retail (gated on N-BIZ)
- **N-MFG-1** Single golden ISO build pipeline (reuse `reproducible-iso-build.md`). _ops/CI._
- **N-MFG-2** Serial space allocation scheme (per-SKU prefix, monotonic, public). _ops._
- **N-MFG-3** Retail integration spec (POS scanner → activation API). _ops + retail partner._
- **N-MFG-4** Tamper-evident packaging spec. _ops + supplier._
- **N-MFG-5** "Tap here" iconography on the case + non-metal antenna window. _design + tooling._

### N-HW — Hardware platform (gated on N-BIZ)
- **N-HW-1** Lock hardware platform (mini-PC SoC family + SBC vs custom). _hardware + business._
- **N-HW-2** BOM + cost target. _hardware + business._
- **N-HW-3** First production run + QA process. _hardware + ops._
- **N-HW-4** Hardware RNG strategy (TRNG part vs reliance on N-BOX-2 software seeding). _hardware._
- **N-HW-5** Case ID reserves a non-metal NFC window over the antenna. _design + tooling._

### N-BIZ — Business model (Q3: DEFERRED until post-v1 signals)
- **N-BIZ-1** Decide direct-ship vs partner vs open-hardware vs hybrid. _owner._
- **N-BIZ-2** Partner agreements / supplier contracts (if partner). _owner + legal._
- **N-BIZ-3** Warranty / return / support process. _owner._

### N-DOCS — Documentation + tests
- **N-DOCS-1** E2E: tap-to-pair happy path; MitM-on-LAN rejected; reset→re-pair; pre-activation claim rejected; two-boxes-one-LAN disambiguation. _agent._
- **N-DOCS-2** Update `lifecycle-spec.md` and `multi-device.md` with the NFC tier. _agent._
- **N-DOCS-3** Add NFC tier to `feature-parity.md` if exposed as a user-facing surface. _agent._
- **N-DOCS-4** Operator runbook for "shipping a branded box" (closes when N-BIZ closes). _agent._

### N — Suggested first wave (when picked up)
The unblocked-by-Q3 work is the protocol + ISO + phone work. Sensible first wave:
1. **N-PROTO-1..4** (one TS package; small).
2. **N-BOX-2, N-BOX-5, N-BOX-7, N-BOX-9** (state-machine plumbing that doesn't need hardware).
3. **N-PHONE-2, N-PHONE-4, N-PHONE-5** (read-only NFC + ECDH + claim submit; deferred read+write under N-PHONE-3 until LED-SAS exists).
4. **N-CLOUD-1, N-CLOUD-2, N-CLOUD-3** (activation API + enforcement + disambiguation).
5. **N-DOCS-2** (cross-link from the lifecycle spec).

Everything else is gated on either hardware bring-up (N-MCU + N-BOX-3/4/6/8) or the business-model gate (N-BIZ → N-MFG → N-HW).
