# Next-session handoff — 2026-05-26 end-of-day

Where work stopped + what to pick up. Both human tasks and agent-doable
follow-ups to reach release-grade.

**Last commit on main:** `1c1962f` (Docker prune + `tsx` → root deps).
**Final image size after dev-dep prune:** 972 → 961 MB (the bulk of the
image is workspace runtime deps, not devDeps — bigger wins listed under
*Agent / A2*).

For full detail: `docs/v1-operational-tasks.md` (canonical backlog incl.
§ N NFC tier), `docs/feature-parity.md` (matrix — every row ✅),
`docs/nfc-box-pairing.md` (retail-box design + 2026-05-26 refinements).

---

## What landed today (so this picks up cleanly)

- **38 commits** closing the agent-doable v1 backlog.
- **P14 Phase 1 + Phase 2** across all 4 surfaces — companion-dock + write-relay.
- **P9 daemon data gaps** closed (per-shard bytes / peer liveness / repair stats).
- **P8/P10 polish bundle** (mobile keyboard + webapp TOTP retry + pending /re-pair banner).
- **P0a + P0b** iOS gaps (create-server backup-policy + LLM-prefs; marketplace install).
- **P12 hard cut-over** (legacy localStorage mirror dropped, 14 call-sites refactored).
- **NFC retail-box design** improved + persisted as § N in `v1-operational-tasks.md`.
- **Fly deploy:** done. **Image size:** 961 MB (down from 972; prune was a small win — see A2).
- Build context (`.dockerignore`): ~4.1 GB → ~150 MB.

---

## 👤 Human — irreducibly you (in dependency order)

### Phase 1 — production deploys (~15 min, mostly 📱)
Already done:
- [x] **Fly deploy** (`apps/web` Fastify on flagship.services).

Still to do:
- [ ] **Worker secrets** (set once, 30 s):
  ```sh
  cd apps/com
  echo "$(openssl rand -hex 32)" | npx wrangler secret put DEMO_IRK_KEK
  echo "$(openssl rand -hex 32)" | npx wrangler secret put FLAGSHIP_TOTP_KEK
  ```
- [ ] **Worker deploy** — pushes the P13 server-revoke endpoint live:
  ```sh
  cd apps/com && npx wrangler deploy
  ```
  Verify: `curl -s https://flagshipserver.com/api/health` → 200.
- [ ] **Daemon binary rebuild + ship via update-pack** so user boxes
  pick up the P6 / P9 / P14 BFFs (or wait for the next box-image refresh).

### Phase 2 — TestFlight (iOS, half-day; 🖥 for the Archive)
**TF1 — APNs secrets** (📱):
- [ ] `wrangler secret put APNS_KEY_ID` → `FHZWTBFQCM`
- [ ] `wrangler secret put APNS_TEAM_ID` → `8G8RHBU9BN`
- [ ] `wrangler secret put APNS_BUNDLE_ID` → `com.flagshipserver.app`
- [ ] `cat AuthKey_FHZWTBFQCM.p8 | wrangler secret put APNS_PRIVATE_KEY_PEM`

**TF2** — Tick Associated Domains: developer.apple.com → Identifiers → `com.flagshipserver.app` → Capabilities → ☑ Associated Domains → Save. 📱

**TF3 — Xcode Archive** 🖥:
- Open `apps/mobile/ios/App/FlagshipApp.xcodeproj`.
- Scheme **FlagshipMobile**, destination **Any iOS Device (arm64)**.
- Product → Archive → Distribute App → App Store Connect → Upload.

**TF4 — ASC metadata** (📱 — ASC has an iPhone app):
- Privacy URL: `https://flagshipserver.com/privacy.html`.
- 1024 icon (already in asset catalog), screenshots (6.7" + 6.1" + iPad pro).
- "What to Test" paragraph (ask the next agent session to draft if needed).
- Company: **Houston Automation Lab**.

**TF5 — Smoke push** 🖥📦 — install via TestFlight on a real iPhone after TF3 lands; pair a real or demo box; trigger a push.

**TF6 — Invite 5 external testers** 📱 via ASC. Apple review ~24–48h before externals can install.

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
- [ ] Build custom Alpine initramfs with `af_packet` baked in (or fix the modloop mount in apkovl mode).
- [ ] Reproducible ISO build via `SOURCE_DATE_EPOCH`.
- [ ] Upload to R2 as `flagship-alpine-base.iso` under `ISO_BUCKET`:
  ```sh
  npx wrangler r2 object put flagship-alpine-base.iso \
      --file=./alpine-base-flagship.iso --bucket=ISO_BUCKET
  ```

**Until this lands, `POST /api/personalize-iso` 503s and Phase 5 is blocked.**

### Phase 5 — Real-hardware Alpine e2e (1 h once Phase 4 done; 📦)
- [ ] Fresh backed-up account on iPhone (use the new "Secure your account" iCloud passkey path).
- [ ] Mint recipe at `flagshipserver.com/dev/create-server`.
- [ ] Download personalized ISO from `/ready` (Recommended path).
- [ ] Burn via the Mac Assembler (Quick mode is the default now).
- [ ] Boot box, watch the provisioning-status timeline, observe live padlock at `https://<server>.<you>.flagship.services/`.
- [ ] Boot-unlock e2e via `boot.flagshipserver.com` (reboot the box, watch the sealed-lease unlock).

### Phase 6 — v1-alpha live exercises (multi-day, observational)
- [ ] **E1** — recovery / rotation / update-pack over 7 days, 2 pods.
- [ ] **E2** — Marketplace MVP: ≥10 listings + ≥3 cross-pod installs + LLM-promo cap enforced.
- [ ] **E3** — Public security disclosure pages + bounty payout path.

### Phase 7 — NFC business gate (the only NFC blocker)
- [ ] **Q3 from the design review** — decide hardware shipping model:
  - direct-ship / partner with mini-PC OEMs / open-hardware reference / hybrid.
- This single decision unblocks **N-MCU, N-MFG, N-HW, N-BIZ** in `docs/v1-operational-tasks.md § N`.

---

## 🤖 Agent — pick up any time, no human input needed

### A. Image-size follow-ups (next obvious wins)

- [ ] **A1.** Workspace-scoped prod install — exclude `apps/web/e2e` + the other Worker workspaces from the runtime image (the version I drafted earlier but pulled because of missing-workspace risk). Adds COPY lines for each kept workspace's `package.json` + a selective `npm install --workspace=...` step. **Est. ~25 MB savings.**
- [ ] **A2.** Switch runtime from `tsx` to compiled `dist/` JS (the Dockerfile already flags this as a follow-up). Each workspace's `main` flips from `src/index.ts` to `dist/index.js`; runtime uses `node` instead of `tsx`; `packages/*/src` drops out of the runtime image entirely. **Est. ~150–250 MB savings — the biggest single lever left.**
- [ ] **A3.** Try a distroless base (`gcr.io/distroless/nodejs20`). **Est. ~100–150 MB savings**; loses shell access for `flyctl ssh console` troubleshooting.
- [ ] **A4.** Audit `apps/web/public/` for duplicate vendoring — `noble-hashes` appears in `apps/web/public/webapp/vendor/` AND `apps/web/public/recovery/vendor/`; drop the unused copy. **Est. ~5 MB.**

### B. v1 polish follow-ups (no v1 blocker; nice-to-haves)

- [ ] **B1.** P14 Phase 2.5 — push replaces polling. Two `PHASE 2.5 HOOK` comments in `packages/server-daemon/src/screens/companionWriteRelay.ts` mark the `notifyOwner` + `notifyCompanion` sites; companion + owner UIs already poll, so this is daemon-only.
- [ ] **B2.** Expand P14 relayable-kinds beyond `release-server` + `revoke-server` (replace-device, wipe-restart — both involve recovery passkeys; defer until a real need surfaces).
- [ ] **B3.** Refactor `apps/web/public/webapp/keystore.js` to read `currentIrkVersion` through `profilesStore` (today it owns its own per-profile suffix scheme; closes a P12-hard-cut-over carve-out).
- [ ] **B4.** Add a production caller for `RepairDaemon` — the wave-9 `RepairStatsAccumulator` is wire-ready but no scheduled-tick site exists yet; until it does the BFF returns honest zeros for repair counters.

### C. NFC retail tier — Q3-independent first wave (start any time)

The hardware Q3 decision blocks N-MCU / N-MFG / N-HW / N-BIZ. The following don't need it:

- [ ] **C1 — `N-PROTO-1..4`**: `PAIR` + `SIG` canonical bytes + HKDF transcript helpers; `BoxUnpair` envelope (rebind-only per Q4); `WiFiConfig` envelope over K_session; SAS helper + LED-SAS encoding alphabet.
- [ ] **C2 — `N-BOX-2, 5, 7, 9`**: per-boot ephemeral keygen with hard RNG entropy gate; first-valid-claim latch + 30-second session-lock window; mDNS + cloud rendezvous with the 6-digit STK suffix; resale wipe verification.
- [ ] **C3 — `N-PHONE-2, 4, 5`**: iOS `NFCTagReaderSession` read flow; Android NFC read; ECDH + K_session + claim submit on both. (Defer `N-PHONE-3` read+write tap until LED-SAS exists.)
- [ ] **C4 — `N-CLOUD-1..3`**: in-store activation API; Worker-side enforce "activated" check on first claim; 6-digit-suffix disambiguation rendezvous.
- [ ] **C5 — `N-DOCS-2`**: cross-link the NFC tier into `lifecycle-spec.md` + `multi-device.md`.

Everything else under `§ N` (N-MCU companion-MCU, N-MFG manufacturing, N-HW platform pick, N-BIZ business model) waits on Q3 or hardware bring-up.

---

## Suggested next-session opening move

**Smallest, highest value**: Phase 1 deploys (15 min, mostly 📱) — sets
the P13 endpoint live + the two long-pending Worker secrets.

**Highest agent leverage**: A2 (switch runtime to compiled `dist/`) —
biggest single image-size win. Most invasive change in the agent list;
worth a focused session.

**Lowest-risk agent warm-up**: A1 + A4 (workspace-scoped install +
duplicate-vendor audit) — small, isolated, ~30 MB combined savings,
good for getting the next session into the codebase.

**Strategic agent work**: C1–C5 — open the NFC tier without needing
any human gate.
