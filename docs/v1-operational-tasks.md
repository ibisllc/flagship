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

- **#10** installer-core (headless base config, GRUB BIOS+UEFI, success-gated self-wipe) — `ac527a9`
- **#11** recipe-sig verify ARMED (seam a) + first-boot provisioning WIRED (seam b) + QEMU full-install e2e runner; the e2e found+fixed 7 real install bugs and root-caused the modloop/af_packet blocker — `32d9af1`, `ee0b835`, `0d96c5b`, `25743a2`
- **#12** server personalize-stream endpoint (`POST /api/personalize-iso`) + box-side ISO9660 trailer-find + `/ready` custom-ISO download — `2bec7b8`, `baaffd3`
- **CS** removed iOS "Skip — pretend it's already running"; mock-backed real create-server flow via a demo-QR in MOCK mode — `97fae58`

---

## A — Install → live padlock (the e2e operation)

- **A1** — `/ready` Advanced-options affordance (BYO-ISO/Debian). _agent._ Alpine
  custom-ISO download is done (#12); add an explicit "Advanced options"
  disclosure that reveals the recipe copy/download + Assembler/Debian path
  (currently only prose, no actionable toggle). Files: `apps/web/public/ready/`.
- **A2** — Burner Advanced/remaster UI. _agent._ `apps/burner-mac` has the
  dumb-flash default AND a full BYO-ISO/Debian remaster (`Remaster.swift`) that
  is NOT wired into the UI. Add a Quick vs Advanced mode toggle in
  `WizardView`/`WizardModel`; mirror intent in the TS `packages/flagship-burner`.
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

See `docs/feature-parity.md` for the full matrix. Every task is audit-then-port
(two source audits disagreed on some cells — re-verify before porting).

- **P0** — Parity audit gate + keep `docs/feature-parity.md` current; verify the
  "done" cells are truly wired (marketplace iOS, create-server iOS pickers,
  trademark iOS). _agent._
- **P1** — Post-creation backup REMINDER on all 3 (the nag if "Secure your
  account" was skipped; audit flags webapp missing). _agent._
- **P2** — Trademark-claim → iOS + Android (webapp done; owner: it's webapp-only;
  mailto trademarks@flagshipserver.com with the requested name pre-filled in the
  username-taken state). _agent._
- **P3** — Server release/revoke → iOS + Android (webapp wires releaseServerName
  on pending-server cancel; audit-disputed — verify). _agent._
- **P4** — Cross-device QR pairing + admit → Android (webapp + iOS done). _agent._
- **P5** — Audit log → iOS + Android (webapp `audit-log.js`). _agent._
- **P6** — Collaborator invites (issue + manage) → iOS + Android (webapp
  `invite-issue.js`/`invite-manage.js`). _agent._
- **P7** — Tier-status / monetization → iOS + Android (webapp `tier-status.js`). _agent._
- **P8** — In-app browser-viewer → iOS + Android (webapp `browser-viewer.js`;
  WKWebView / Android WebView gated to the user's own subdomain). _agent._
- **P9** — Peer-backup management → iOS + Android (+ finish daemon Screens-BFF
  status/toggle; webapp `peer-backup.js` is partial). _agent._
- **P10** — Replace device (IRK rotation) → webapp (iOS/Android done). _agent._
- **P11** — Wipe & restart → webapp (iOS/Android done; `docs/wipe-restart.md`). _agent._
- **P12** — Multi-profile switching → webapp (iOS/Android done). _agent._
- **P13** — Kill-switch / server-revocation UI → all 3 (boot DELETE-lease +
  ServerRevocation exist; user-facing control missing). _agent._

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
P2 (trademark iOS+Android) → P5/P7/P8 (audit-log / tier-status / browser-viewer)
→ A1 (/ready Advanced) → A2 (burner Advanced) → P1/P3 → the rest of P → D1.
