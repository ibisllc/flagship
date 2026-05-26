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
- **P4** — Cross-device QR pairing + admit → Android (webapp + iOS done). _agent._
- **P5** — Audit log → iOS + Android. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P6** — Collaborator invites (issue + manage) → iOS + Android (webapp
  `invite-issue.js`/`invite-manage.js`; verify daemon BFF first). _agent._
- **P7** — Tier-status / monetization → iOS + Android. _agent._ ✅ (`ca7165a` + `01e8dd4`).
- **P8** — Browser-viewer → iOS + Android. **Decision 2026-05-25**: mirror the
  webapp's WS framebuffer-stream + input-forwarding (the real use-case is
  server-side social-media login so bots can act as the user — session must
  live on the box; native WebView is a different feature). _agent._
- **P9** — Peer-backup management → daemon Screens-BFF + 3 UI. **Decision
  2026-05-25**: build full BFF (status + toggle) to webapp's expected contract
  + wire all 3. _agent._
- **P10** — Replace device (IRK rotation) → webapp. _agent._ ✅ (`20224ce`).
- **P11** — Wipe & restart → webapp. _agent._ ✅ (`20224ce`) — full ceremony,
  not the older "ship disabled" stance.
- **P12** — Multi-profile switching → webapp (iOS/Android done; needs a
  storage migration from single localStorage to a multi-profile store). _agent._
- **P13** — Kill-switch / server-revocation UI → all 3. **Decision 2026-05-25**:
  per-server danger zone (reason picker lost/stolen/decommissioned), guarded
  by the established two-tap-hold (mobile) / 3-second countdown (webapp), IRK
  signature only. _agent._
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
- **D2** — Prune stale branches: ~80 `worktree-agent-*`/feature branches are
  already IN-MAIN + in-HEAD (a:0) — stale leftovers; 4 `a:1` branches
  (w11/Hetzner, demo_users, android-rename, W11) are superseded. Verify
  containment in main, delete, `git worktree prune`. Keep main + the active
  branch. _agent._

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
(Updated 2026-05-25 night after wave 2.) **Up next**: P13 per-server
danger zone (all 3) → P9 daemon BFF then 3 UIs → P4 Android QR + admit
→ P12 webapp multi-profile + storage migration → P6 collaborator invites
iOS + Android → P8 framebuffer-stream port (iOS + Android) → P14
companion-browser dock → D2 prune stale branches. Then the
hardware/owner items (A3–A6, TF*, C1, E*).
