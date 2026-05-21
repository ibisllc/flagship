# Next-session prompt — drive Flagship to a public v1 launch

The 2026-05-21 session shipped the protocol cleanup (`v2`), the buildTicket
removal (QR-pipe is the only flow), the recipe-TTL knob (6h default), the
Burner CLI Phase-1, the Mac SwiftUI GUI, and a fully-green vitest. This
session's job: ship the last mile — real-metal USB install, native Windows +
Linux Burner GUIs, iOS / Android store uploads, vibecode "hello world" demo,
and a polished public-facing flagshipserver.com.

Style we've kept (and you should keep):

- **Deep-think before edits** — recon current state before writing code.
- **Sequential sub-workers** — one focused sub-agent per phase in an
  isolated worktree, merge to main when verified.
- **Logical commits** — one PR-sized commit per landed phase, body explains
  WHY not WHAT. No Co-Authored-By trailer (CLAUDE.md user pref).
- **Verify before trust** — re-run `npx tsc -b` + `npx vitest run` + mobile
  gates after each merge.
- **No mid-session pauses for "ready for next phase?"** — flow continuously.
- **Ask before architectural / UX / security changes** — owner pref locked
  in the 2026-05-21 session.
- **Push to origin frequently.** Owner wants commits to land on `origin/main`
  as they're proven, not batched.

---

## Where we left off (state at 2026-05-21 end of day)

### Architecture (locked + tested + live)

- **W13 cloud-init-direct demo path** — `home.demo-alice.flagship.services`
  registers in ~2 minutes from Hetzner debian-12 VPS launch. Cron promotes
  `provisioning → up` once `servers` table has the entry. The custom-ISO
  W12 path is preserved in tree but unused.
- **QR-pipe is the only handoff flow** — phone signs blob, sends through a
  per-session Durable Object, desktop reads. Build-ticket flow (`POST
  /api/build-tickets/issue` etc.) entirely ripped — endpoints gone, D1
  table dropped via migration 0033, mobile + webapp paths updated.
- **InstallBlob v2** — canonical-bytes layout dropped `blob.issuedAt` and
  `blob.expiresAt`. `authCode.expiresAt` is the sole TTL. Tag stays
  `flagship/install-blob/v1`; the inner `version: 2` is the discriminator.
  See `docs/recipe-schema-v2.md` for the spec.
- **Recipe TTL knob** — default 6h, clamped [5min, 24h]. Picker on iOS
  (`CreateServerStubScreen.swift` design page slider), Android (`CreateServerScreen.kt`
  Compose slider), webapp (`#cs-ttl-hours` number input). Worker enforces
  the 24h cap unilaterally in `serverRegister.ts` (defense in depth).
- **Burner CLI** at `packages/flagship-burner/` — `verify` /
  `verify-iso` / `user-data` / `prepare` / **`write`** / `distros`
  subcommands. Never calls `flagshipserver.com`; verifies the phone-
  signed Ed25519 locally. Auto-shreds the recipe file after successful
  consume. Pinned distro allowlist (Ubuntu Server 22.04 only at
  launch). 59/59 burner tests pass.
- **Mac SwiftUI Burner GUI** at `apps/burner-mac/` — single-screen
  redesign with 3 compact drop-rows (Recipe / ISO / USB), one-click
  Bake (admin prompt via `osascript do shell script ... with
  administrator privileges`), live expiry countdown on the recipe
  row, log drawer collapsed by default. 28/28 swift tests pass.
  `make release` produces a codesigned + notarized + stapled DMG once
  Developer ID Application cert is in env.
- **Linux GTK4 + Python Burner GUI** at `apps/burner-linux/` — same
  3-row layout, PolicyKit elevation for the write step. 62/62 pytest
  pass. AppImage + Flatpak manifests included.
- **Windows WPF + .NET 8 Burner GUI** at `apps/burner-windows/` — same
  layout, `requireAdministrator` UAC manifest, single-file self-
  contained publish. Builds on any box with the .NET 8 SDK; this
  Mac doesn't have it so gates run on the build host.
- **Webapp "Download recipe" button** — emits a `.json` file matching
  the Burner's `loadBlobFromFile()` schema verbatim, for cross-
  device flows.

### Test gates as of session end

- `npx vitest run` → **3214/3222** (8 skipped — vps-e2e harness
  pending its own QR-pipe rewrite); previously-broken apkovl-
  endorsement test ALSO fixed in 6a7fd28
- `npx tsc -b` → clean across the whole workspace
- iOS xcodebuild test → **300/300** (incl. 8 new TTL + v2 canonical-
  bytes regression tests)
- Android `./gradlew test` → BUILD SUCCESSFUL
- `apps/burner-mac/` `swift test` → **28/28** (+7 expiry tests)
- `apps/burner-linux/` `pytest` → **62/62**
- `apps/burner-windows/` → source ships; gates run on a Windows host
  with `dotnet build` + `dotnet test`

### Operator follow-ups (irreducible — needs human shell + credentials)

- `wrangler secret put DEMO_IRK_KEK` (`openssl rand -hex 32`) — admin-claim-
  and-issue endpoints return 503 without it
- `wrangler d1 execute flagship-state --remote --file=packages/storage/migrations/0033_drop_build_tickets.sql`
  — drops the now-unused `build_tickets` table on prod D1
- CA endorsement re-signing before `2026-06-02T22:40:29.858Z`

---

## Punch list — in priority order

### P0 (gate for opening flagshipserver.com to the public)

1. **Real-metal USB install proof point.** Use today's Burner CLI to write a
   stock Ubuntu Server ISO + a real recipe (minted from your phone) onto a
   USB stick. Boot a laptop from it. Confirm the daemon registers from your
   home network (not Hetzner). This is the single proof point that says
   "the install path actually works for real users."
2. **`flagship-burn write` subcommand.** Direct raw-disk write. The other
   parallel worktree (`.claude/worktrees/agent-ae04553a499422f1d/`) was
   building this; merge it in, run gates, ship. Phase-2 alternative to the
   `prepare`-then-`dd` two-step.
3. **Webapp recipe-download UX polish.** The button works (`#cs-download-recipe`)
   but it sits in a card the user has to scroll to. Lift it to a more
   prominent spot once the cross-device flow is the recommended path.

### P1 (broader reach)

4. **Windows Burner GUI.** Same shape as `apps/burner-mac/` but in
   WinUI or Tauri-on-Rust (your call). Bundles a signed `node` runtime so
   end users don't need to install one.
5. **Linux Burner GUI.** AppImage or Flatpak. Same architecture as Mac.
6. **iOS TestFlight upload.** Substantial work — Xcode project setup,
   Apple Developer cert wrangling, App Store Connect metadata, 5 external
   testers. See memory `project-testflight-blockers.md`.
7. **Android Play internal track.** Same shape, FCM setup, signing key.
8. **iOS XCUITest graphical e2e.** Requires converting the SwiftPM library
   to an xcodeproj with an app target. Substantial; defer if TestFlight
   manual QA is sufficient.

### P2 (showcase / story)

9. **Vibecode "hello world" demo.** Show the foundational pillar: user
   types a prompt on their phone → daemon spins up a tiny app → renders
   at `home.harry.flagship.services/hello`. The infra (multi-turn
   protocol + per-app env vars + signed orders) is built; needs a demo
   recipe that ties it together end-to-end.
10. **Marketplace scanner.** `marketplace_listings.scan_grade` column
    is still NULL today. v1 launch requirement before opening the
    public marketplace.

---

## Pinned threat reminders

- **Recipe file at rest** is a real attack surface. The current mitigations
  (auto-shred, 5min-24h TTL, copy-paste flow on same-device) are documented
  in `packages/flagship-burner/README.md` § threat model. Don't widen the
  TTL ceiling without weighing the cost.
- **CA endorsement** must be re-signed before `2026-06-02T22:40:29.858Z`.
- **No Co-Authored-By trailer** on commits.

## Where to dig

| Topic | Path |
|---|---|
| Recipe schema | `docs/recipe-schema-v2.md` |
| Cloud-init demo design | `docs/cloud-init-direct-provisioning.md` |
| W13 handler | `packages/control-plane/src/demoUsersAdminCloudInit.ts` |
| Burner CLI | `packages/flagship-burner/` + `README.md` |
| Mac Burner GUI | `apps/burner-mac/` + `README.md` |
| Cron fixes | `apps/com/src/scheduled.ts`, `packages/control-plane/src/demoUsers.ts` |
| Old W12 d-i path (kept for reference) | `packages/installer-netboot/` |
| Memory: Burner spec | `project-flagship-burner.md` |
| Memory: this session's progress | the latest `MEMORY.md` entry |
