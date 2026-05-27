# Next-session handoff — 2026-05-27 end-of-day

Where work stopped + what to pick up. Both human tasks and agent-doable
follow-ups to reach release-grade.

**Last commit on main:** `5dd36c5` (NFC docs cross-link — N-DOCS-2).

For full detail: `docs/v1-operational-tasks.md` (canonical backlog incl.
§ N NFC tier), `docs/feature-parity.md` (matrix — every row ✅),
`docs/nfc-box-pairing.md` (retail-box design + 2026-05-26 refinements).

---

## Honest "what works for the owner today?" snapshot (2026-05-27)

If you (the owner) want to create your home server **today**, here's
the truthful picture:

| Path | Status | Why |
|---|---|---|
| **Alpine apkovl** (self-deleting, the Recommended path) | ❌ blocked | `POST /api/personalize-iso` returns 503 — `flagship-alpine-base.iso` has never been built + uploaded to R2 with the `af_packet` kernel-module fix. The Phase-4 lynchpin below. |
| **Debian-13 netinst** (Advanced mode in burner GUI) | ✅ works end-to-end | Pinned default in `packages/flagship-burner/src/distros.ts`; 2026-05-25 e2e on home.harry; 3 fixes landed in `2f7f743`; native Mac burner GUI signed under "IBIS LLC" Developer ID. |
| **iOS install-progress alerts** | 🟡 code wired, can't actually receive | Daemon → cloud (deployed today, migration 0038) → APNs push → `ProvisionTimelineView` + `InstallProgressLiveActivity` (Lock Screen + Dynamic Island) — but **not on TestFlight**, so nothing on your device receives them yet. |
| **Android install-progress alerts** | 🟡 same as iOS | `ProvisionPhasePush.kt` + `InstallProgressScreen.kt` mirror iOS; FCM wired Worker-side. **Not on Play internal track yet.** |
| **Apple Watch install-progress alerts** | ❌ no surface | The Watch app today handles unlock approvals only. Install-progress surface for Watch is unscoped work. |

**Net for the owner**: today, the only working server-creation route is
**Debian via the Mac burner's advanced mode**, and the install will
complete silently because no Apple/Android device has the app
installed yet to receive the push timeline. The Phase 1, 2, 3, and 4
items below all clear independent blockers; doing any one of them
takes a tier from 🟡 → ✅ or unblocks a ❌.

---

## What landed today (2026-05-27)

5 commits + 2 prod deploys on top of the 2026-05-26 baseline.

| # | Commit | What |
|---|---|---|
| 1 | `c225aa1` | **A2** — runtime to compiled `dist/`, Fly deploy `956 MB` (-5 MB; the handoff overestimated the savings — bulk of image is `node_modules`, not src/+tsx) |
| 2 | `c95282b` | **C1** — `@flagship/protocol` NFC envelopes: `PairPayload` + sign/verify + HKDF transcript + K_session + SAS + LED-SAS alphabet + `BoxUnpair` + `WiFiConfig` sealed under K_session AEAD; 27 tests. N-PROTO-1..4 done. |
| 3 | `fba55d4` | **C2** — server-daemon NFC pair-mode plumbing: RNG entropy gate, per-boot ephemeral keygen, pair-emitter, state machine (UNPAIRED ↔ SESSION_LOCKED ↔ PAIRED w/ 30s session lock + first-claim latch), resale wipe verifier; 34 tests. N-BOX-2/5/7/9 done. |
| 4 | `2f75771` | **C4** — Worker activation API: D1 migration 0039 (`box_serials`), HMAC-authed `POST /api/serial/activate` + public `GET /api/serial/:serial/status` + `GET /api/rendezvous/:suffix6`; 22 tests. **Live in prod** (Worker `32a9831b`; migration applied). N-CLOUD-1/3 done. |
| 5 | `5dd36c5` | **C5** — NFC docs cross-link in `lifecycle-spec.md` + `multi-device.md`. N-DOCS-2 done. |

**Plus** prior-to-NFC work in the same session: Phase 1 prod deploy
of P13 server-revoke + provision-status (`b0367ebe`, migration 0038);
iOS xcodebuild 615/615 sanity pass; both DEMO_IRK_KEK +
FLAGSHIP_TOTP_KEK + all 4 APNs secrets confirmed already set
(the prior handoff was stale on that step).

**Gates**: vitest 333 files / **4286 pass** (+83 new today), tsc clean.

### NFC tier matrix after today

| Layer | Status |
|---|---|
| Protocol | ✅ N-PROTO-1..4 |
| Daemon (box-side, pure logic) | ✅ N-BOX-2/5/7/9 |
| Daemon (hardware bring-up) | ⏳ N-BOX-1/3/4/6 (needs Q3 hardware) |
| Cloud (Worker) | ✅ N-CLOUD-1/3 live in prod; N-CLOUD-2 helper shipped, hot-path wire-in deferred |
| Phone (iOS + Android) | ⏳ **C3 not started** — Swift `NFCTagReaderSession` + Kotlin Tag + ECDH + claim submit |
| Docs | ✅ N-DOCS-2 (cross-link); ⏳ N-DOCS-1 (e2e plan) |

---

## 👤 Human — irreducibly you (in dependency order)

### Phase 1 — production deploys (DONE)

- [x] Fly deploy (A2 compiled-dist image, 956 MB)
- [x] Worker secrets (`DEMO_IRK_KEK` + `FLAGSHIP_TOTP_KEK` already set prior; confirmed)
- [x] Worker deploy ships P13 server-revoke + provision-status + N-CLOUD-1/3
- [ ] **Daemon binary rebuild + ship via update-pack** so user boxes pick
  up the P6 / P9 / P14 BFFs + the new NFC box-side state machine.
  Deferred to the next box-image refresh per owner call.

### Phase 2 — TestFlight (iOS, half-day; 🖥 for the Archive)

**TF1 — APNs secrets** (DONE — all 4 confirmed already set).

**TF2** — Tick Associated Domains: developer.apple.com → Identifiers →
`com.flagshipserver.app` → Capabilities → ☑ Associated Domains →
Save. 📱

**TF3 — Xcode Archive** 🖥:
- Open `apps/mobile/ios/App/FlagshipApp.xcodeproj`.
- Scheme **FlagshipMobile**, destination **Any iOS Device (arm64)**.
- Product → Archive → Distribute App → App Store Connect → Upload.
- **Pre-Archive sanity DONE this session**: 615 XCTests pass on
  iPhone 16e simulator.

**TF4 — ASC metadata** (📱 — ASC has an iPhone app):
- Privacy URL: `https://flagshipserver.com/privacy.html`.
- 1024 icon (already in asset catalog), screenshots (6.7" + 6.1" + iPad pro).
- "What to Test" paragraph (ask the next agent session to draft if needed).
- Company: **Houston Automation Lab**.

**TF5 — Smoke push** 🖥📦 — install via TestFlight on a real iPhone
after TF3 lands; **first thing to try is the install-progress timeline**
(the daemon → cloud → push pipeline went live today; this is the
end-to-end proof that 🟡 → ✅ for install alerts).

**TF6 — Invite 5 external testers** 📱 via ASC. Apple review ~24–48h
before externals can install.

### Phase 3 — Play Console (Android, half-day)

- [ ] Build signed release AAB:
  ```sh
  cd apps/mobile/android
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ./gradlew :app:bundleRelease
  ```
- [ ] Upload to Play Console → Internal testing → new release.
- [ ] Add 5 testers (Gmail) → Save.

### Phase 4 — Alpine `af_packet` fix (THE LYNCHPIN; multi-hour 🖥)

This is the single thing standing between "Debian advanced-mode is the
only working path" and "Alpine apkovl Recommended path works
end-to-end". Today `/ready/` → personalize-iso → 503.

- [ ] Build custom Alpine initramfs with `af_packet` baked in (or fix
  the modloop mount in apkovl mode).
- [ ] Reproducible ISO build via `SOURCE_DATE_EPOCH` (reproducible-iso
  CI workflow already exists per CLAUDE.md "DONE" notes — verify it
  picks up the new initramfs).
- [ ] Upload to R2 as `flagship-alpine-base.iso` under `ISO_BUCKET`:
  ```sh
  npx wrangler r2 object put flagship-alpine-base.iso \
      --file=./alpine-base-flagship.iso --bucket=ISO_BUCKET
  ```
- [ ] Re-probe `curl -s -X POST https://flagshipserver.com/api/personalize-iso
  -H 'Content-Type: application/json' -d '{}'` — should NOT return the
  `"base ISO ... not provisioned"` 503 anymore.

**Until this lands, the Alpine path is unavailable to the owner;
Debian advanced-mode is the only working creation route.**

### Phase 5 — Real-hardware Alpine e2e (1 h once Phase 4 done; 📦)

- [ ] Fresh backed-up account on iPhone (use the new "Secure your
  account" iCloud passkey path).
- [ ] Mint recipe at `flagshipserver.com/dev/create-server`.
- [ ] Download personalized ISO from `/ready` (the now-Recommended path).
- [ ] Burn via the Mac Assembler (Quick mode is the default).
- [ ] Boot box, watch the provisioning-status timeline **on your
  phone's Live Activity** (the end-to-end test for everything that
  shipped today), observe live padlock at
  `https://<server>.<you>.flagship.services/`.
- [ ] Boot-unlock e2e via `boot.flagshipserver.com` (reboot the box,
  watch the sealed-lease unlock).

### Phase 6 — v1-alpha live exercises (multi-day, observational)

- [ ] **E1** — recovery / rotation / update-pack over 7 days, 2 pods.
- [ ] **E2** — Marketplace MVP: ≥10 listings + ≥3 cross-pod installs +
  LLM-promo cap enforced.
- [ ] **E3** — Public security disclosure pages + bounty payout path.

### Phase 7 — NFC business gate (the only NFC blocker)

- [ ] **Q3 from the design review** — decide hardware shipping model:
  - direct-ship / partner with mini-PC OEMs / open-hardware reference / hybrid.
- This single decision unblocks **N-MCU, N-MFG, N-HW, N-BIZ** in
  `docs/v1-operational-tasks.md § N`. The agent-doable NFC work
  (protocol, daemon, cloud, docs) is DONE.

---

## 🤖 Agent — pick up any time, no human input needed

### A. Image-size follow-ups (small-to-modest returns)

- [ ] **A1.** Workspace-scoped prod install. **Deprioritized this
  session** — the Dockerfile already drops `apps/com`, `apps/boot`,
  `apps/dns-broker`, `apps/web/e2e` node_modules + runs
  `npm prune --omit=dev`. The remaining A1 win (a selective
  `npm install --workspace=apps/web`) carries the "missing workspace
  risk" the prior session called out, and A2 already shipped without
  it. Probably skip — the image is bottlenecked by `node_modules`
  hoisted at root, which only A3 changes.
- [x] **A2.** Compiled-dist runtime. **DONE** in `c225aa1`. Saved
  ~5 MB on the image (well below the prior handoff's 150-250 MB
  estimate — the real fat is `node_modules`). Quality win regardless:
  the runtime entry is plain `node apps/web/dist/server.js`, no `tsx`
  transformer overhead.
- [ ] **A3.** Distroless base (`gcr.io/distroless/nodejs20`). Estimate
  ~60-100 MB savings; costs `flyctl ssh console` shell access.
  **GATED on real-hardware e2e satisfaction per owner call** — do NOT
  pick up until Phase 5 has run cleanly at least once.
- [x] **A4.** noble-hashes dedup. **Skipped this session** — real
  in-image savings ~70K (not 5 MB as estimated); webapp +
  recovery copies serve different code; risks regression on the
  recovery flow.

### B. v1 polish follow-ups (no v1 blocker; nice-to-haves)

- [ ] **B1.** P14 Phase 2.5 — push replaces polling for the companion
  write-relay. Two `PHASE 2.5 HOOK` markers in
  `packages/server-daemon/src/screens/companionWriteRelay.ts` show
  where to fire `notifyOwner({ kind: "companion-write-queued", ... })`
  + the companion-side resolve push. **Mid-size**: needs a daemon→.com
  HTTP path with a shared-secret similar to `BOOT_NOTIFY_SECRET`
  (boot worker pattern). Plus the SSE/WebSocket channel back to the
  ephemeral companion browser. Defer until a real need surfaces.
- [ ] **B2.** Expand P14 relayable-kinds beyond `release-server` +
  `revoke-server` (replace-device, wipe-restart — both involve recovery
  passkeys; defer until a real need surfaces).
- [ ] **B3.** Refactor `apps/web/public/webapp/keystore.js` to read
  `currentIrkVersion` through `profilesStore` (closes a P12 hard-cut-
  over carve-out).
- [ ] **B4.** Add a production caller for `RepairDaemon` — the
  wave-9 `RepairStatsAccumulator` is wire-ready but no scheduled-tick
  site exists yet; until it does the BFF returns honest zeros for
  repair counters.

### C. NFC retail tier — landed this session

| Sub-wave | Status this session |
|---|---|
| C1 — `@flagship/protocol` envelopes (N-PROTO-1..4) | ✅ `c95282b` |
| C2 — daemon-side state plumbing (N-BOX-2/5/7/9) | ✅ `fba55d4` |
| **C3 — iOS + Android NFC read flow (N-PHONE-2/4/5)** | ⏳ **not started — the only Q3-independent NFC chunk remaining** |
| C4 — Worker activation API (N-CLOUD-1/3) | ✅ `2f75771` + live in prod |
| C5 — docs cross-link (N-DOCS-2) | ✅ `5dd36c5` |

**C3 detail** — when picked up:
- **iOS**: `NFCTagReaderSession` (Core NFC) read flow, parse PAIR
  NDEF, verify with `verifyPair`, X25519 ephemeral, ECDH +
  K_session + claim submit. Owner-side: a "tap your box" UI that
  rolls into the existing pairing flow.
- **Android**: Same shape; `android.nfc.NfcAdapter` + `Tag` +
  `Ndef` + the ECDH + claim submit. Easier than iOS — Android NFC
  is more permissive.
- **Defer**: `N-PHONE-3` (iOS read+write tap) until LED-SAS UI
  exists per locked Q2; `N-PHONE-6` LED-SAS camera capture is
  separate. Both touch native UI heavily.

### D. NFC cloud wire-in follow-up

- [ ] **N-CLOUD-2 hot-path wire-in**: extend `handleServerRegister`
  to call `enforceActivated()` when the incoming registration carries
  a `serial` field (branded boxes do). Touches a hot path with
  cross-cutting rate-limit + audit implications — deserves a focused
  follow-up rather than a casual addition. Helper is already shipped
  + tested in `serialActivation.ts`.
- [ ] **PAIR / BoxUnpair / WiFiConfig golden vectors** in
  `test-vectors/canonical-bytes.json` so
  `canonicalBytesVectors.test.ts` catches any byte-format drift.
  Small, mechanical.

---

## Suggested next-session opening move

**Smallest, highest value**: Phase 2 TestFlight (TF2-TF6). One
half-day push gets the iOS app on a real device + closes the
🟡 → ✅ on install-progress alerts (the first thing TF5 should
exercise is booting a Debian box and watching the timeline).

**Most strategic agent work**: C3 NFC mobile read flow — the only
remaining NFC chunk that's not Q3-gated. Big finish for the NFC
tier.

**Highest single-blocker**: Phase 4 Alpine `af_packet` — the lynchpin
between today's "Debian-only" reality and the Recommended path
actually working. Multi-hour 🖥 work but unblocks Phase 5 and lets
the public landing page tell the truth.

**Lowest-effort polish**: N-CLOUD-2 wire-in + canonical-bytes golden
vectors — both small, both mechanical.
