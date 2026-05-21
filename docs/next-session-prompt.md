# Next-session prompt — Flagship Burner + cloud demo end-to-end

Paste this verbatim into the next Claude Code session. The session before this one (2026-05-21) landed the W13 cloud-init-direct path for the cloud demo; this session ships the **Burner**, drives the demo to "fully alive", and proves the real-USB story on a metal box.

Style we kept across the marathon:
- **Deep-think before edits** — recon current state before writing code.
- **Sequential sub-workers** — one focused sub-agent per phase, isolated in worktree, merge to main when verified.
- **Logical commits** — one PR-sized commit per landed phase, body explains WHY not WHAT.
- **Verify before trust** — re-run `npx tsc -b` + `npx vitest run` + mobile gates after each merge.
- **No mid-session pauses for "ready for next phase?"** — flow continuously.

---

## Where we left off (state at 2026-05-21 16:30 UTC)

**W13 cloud-init-direct path landed** (commit chain on `main`, see most recent commits). Skips custom ISO + d-i entirely:
- Hetzner debian-12 base image
- cloud-init runs our `flagship-bootstrap.sh` on first boot
- Pulls Node 20 from NodeSource (Debian-12 ships Node 18 which is too old)
- `npm install --workspaces` (vs `npm ci` which silently no-ops workspaces)
- Inline registration to `/api/server/register`
- ~2 minutes from VPS creation → daemon registered in `.com`

The custom-ISO W12 path is preserved in tree (`packages/installer-netboot/`) but **unused** by the demo. It's a debugging artifact; don't delete — keep for real-USB referencework.

**Live demo at session-end**: VPS `132252195` (IP `188.245.202.158`) is provisioned, registered, awaiting promotion to `state='up'` at the next 16:30 cron tick. If the next session inherits a stale row, just `npx wrangler d1 execute flagship-state --remote --command "UPDATE demo_users SET state='none', active_server_id=NULL WHERE username='demo-alice'"` and re-launch via `curl -sS -X POST https://flagshipserver.com/api/dev/sample-user/demo-alice/admin-cloud-init-now -H "x-admin-secret: $FLAGSHIP_ADMIN_SECRET" -H "content-type: application/json" -d '{"display":"Demo Alice"}'`.

**Debug endpoints added** (admin-gated via `FLAGSHIP_ADMIN_SECRET`):
- `POST /api/dev/rescue/<serverId>` — enable Hetzner rescue + return root password
- `POST /api/dev/destroy/<serverId>` — destroy any Hetzner VPS by id
- `GET /api/dev/server/<serverId>` — Hetzner server record (status, IP)
- `PUT /api/dev/upload-iso/<filename>` — upload an ISO into `ISO_BUCKET`
- `POST/GET /api/dev/late-log/<label>` — install-stage exfil log

Keep these around; they unblock rescue-mode forensics from the laptop without ever having `HCLOUD_TOKEN` locally.

**Memory contains** the Burner spec (`project_flagship_burner.md`) — read it first.

---

## Punch list — in no particular order, all of these are FOR THIS SESSION

### 1. Flagship Burner (Mac / Win / Linux)

The single tool a real user installs. Replaces "download personalized ISO + balenaEtcher" with "download stock Ubuntu ISO once + Burner + recipe". See `project_flagship_burner.md` in memory for the full threat model + requirements.

- **CLI prototype first** (`flagship-burn` — single Go or Rust static binary, works on all three OSes).
  - Reads recipe (copy-paste OR JSON file)
  - Verifies stock Ubuntu/Debian ISO against Canonical/Debian GPG signature
  - Writes ISO to USB
  - Injects cloud-init `user-data` overlay so first boot runs flagship-bootstrap
  - **Auto-shreds recipe file** after successful flash (consumes-and-deletes)
- **Distro allowlist with pinned SHA + GPG fingerprint** baked into the binary
- **Native GUIs** layered on top:
  - Mac: SwiftUI or Tauri-on-Rust wrapper
  - Windows: signed exe, admin elevation for raw disk
  - Linux: AppImage + Flatpak
- **Reproducible builds + signed releases** — users can verify the binary
- **Copy-paste recipe + download-JSON both supported** — copy-paste is preferred for same-device flow (no file at rest)
- **Test on the operator's iPhone + Linux laptop combo** until perfect

### 2. Graphical end-to-end test of the cloud demo

- iOS Simulator + TestFlight build pointing at `flagshipserver.com`
- Walk the full flow: build code → claim → admin-cloud-init-now → registration arrives → user sees pod alive in iOS app
- Stress edge cases: network drops mid-bootstrap, daemon crash on first boot, recipe expired, recipe replayed, dupe install
- Capture screenshots for marketing / TestFlight metadata

### 3. Generalize to other app platforms

- Android (Kotlin) parity
- Web app at `web.flagshipserver.com` exercising the same backend
- All three render the same `DeviceCapabilityBlock` + scope buttons consistently

### 4. Real-metal install

- Use the Burner (item 1) to write a USB
- Boot a real laptop or thinkmini from it
- Confirm the daemon registers from the user's network (not Hetzner)
- This is the **proof point for opening the site publicly**

### 5. Vibecode "hello world" with user access

- Show that a fresh-installed pod can run a tiny user-authored service end-to-end
- Phone-mediated auth → daemon serves "hello, harry" with green padlock at `home.harry.flagship.services`
- Foundational demo for the "vibecode an app on your pod" pillar
- Use the existing vibecode infrastructure (multi-turn + per-app env vars + signed orders)

### 6. Stretch / nice-to-have

- Recipe TTL audit — make sure phone-issued tickets actually expire (replay-protect spec)
- Auto-promote W13 row even when daemon-status (not just servers) registers — current promotion uses `servers` table but a robust cron also handles the `lastReported` signal
- Build-relay reliability under load

---

## Pinned threat reminders

- **Recipe file at rest** is a real attack surface. Burner ships copy-paste as default; download-JSON for cross-device; auto-shred after consume.
- **CA endorsement** must be re-signed before `2026-06-02T22:40:29.858Z` (see `[[project_resume_2026_05_16]]`). Don't let it expire without renewing.
- **No Co-Authored-By trailer** on commits.

## Where to dig

- W13 design: `docs/cloud-init-direct-provisioning.md`
- W13 handler: `packages/control-plane/src/demoUsersAdminCloudInit.ts`
- Bootstrap script (the runcmd that runs on the user's VPS): inline in `demoUsersAdminCloudInit.ts`'s `buildCloudConfigUserData`
- Burner spec: memory `project_flagship_burner.md`
- Cron fixes: `apps/com/src/scheduled.ts`, `packages/control-plane/src/demoUsers.ts`
- Old W12 d-i path (kept for reference): `packages/installer-netboot/` + `scripts/build-flagship-netboot-iso.sh`
