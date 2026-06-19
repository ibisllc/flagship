# Gym proof-ledger — what's been PROVEN against a real box

> **Persistent record. Safeguard against context loss.** The "gym" = drive the
> REAL client (webapp / iOS sim / Android emulator) against a REAL Hetzner box
> and watch a feature work, with saved evidence — NOT mocks, NOT hand-run
> harnesses pretending to be the app. Every row here is a thing genuinely
> demonstrated end-to-end with on-disk evidence (a `curl -i` capture, a journal
> transcript, or screenshots). Update this file as proofs land. Last updated
> **2026-06-18**.
>
> **POLICY (owner, 2026-06-18): EVERY improvement gets logged here AND merged to
> `main`** — do NOT strand prod fixes/features on feature or worker branches.
> Gym-only test scaffolding (drivers, `__gymAdopt`/`__gymCreate` seams, the gym
> pin, `wrangler.gym.toml`) stays gym-side; everything that improves the product
> lands on `main`.
>
> Conventions: boxes are `home.<user>.gym.flagship.services` (gym env). Commits
> are on `main` unless tagged `(gym)`. Evidence lives under a worker's
> `gym-results/<area>/` (gitignored — local artifacts). Secrets:
> `/Users/harrywinner/flagship/.gym-secrets.env` (source by abs path). Gym deploy:
> `wrangler --config wrangler.gym.toml`. The `gym` branch is **behind `main`** —
> prod fixes get extracted to `main` (3-way apply), gym-only seams (`__gymAdopt`,
> `__gymCreate`) stay on `gym`.

## PROVEN — real app → real box (with evidence)

| # | Feature | Box | Evidence | Commit |
|---|---|---|---|---|
| 76 | Services: set-env via real iOS UI + uninstall (signed) | home.wapjzrl3h | `gym-results/ios-service-manage/*` (env-add/list, after-uninstall) | `7b61cedf` (gym) |
| 77 | Pair devices — **companion** (4h read-only, P14) | home.wapjrq7nb | `pairing-e2e/*` (07 shared-box detail, 09 active companions), 6/6 ACAO | `7685008b` |
| 78 | Pair devices — **full device-add** (QR+DeviceAdmit+SAS, joins quarantined) | home.wapjww5bv | `device-add-e2e/*`, matched SAS, quarantineUntil, 200s | `28b1ddb3` |
| 79 | Account recovery (.flagshipkey import → same account+cloud) | home.wapjsieom | `recovery-e2e/*` (05 import, 06 recovered home, 07 server-detail), 6/6 ACAO | `6ff658f8` |
| 80/81 | **Vibe-code (scratch)** AI authors app → deploy → 200 (CANONICAL url) | home.wapjz2hfn | `ai-build-proof/vibe-200.txt` (`hello from flagship gym`), `vibe-authored-files.json` | `4d21905c` (gym), `7bfbcf06` |
| 80/81 | **Git-adapt** AI drives read/write/validate/deploy → 200 (CANONICAL url) | home.wapjz2hfn | `ai-build-proof/adapt-200.txt` (visitor #2), `adapt-journal.json` (9-turn transcript) | `4d21905c` (gym) |
| 75 | Create → manage → delete server via the real webapp | home.cswqjz9zaa | `create-server-e2e/*` (03 form, 04 manage/journal, 06 after-revoke) | `84815db1` (gym), `96fd8432` |

Model for AI builds: **openai / gpt-4o-mini** (BYOK over the paired-session pinned
pipe; flagshipserver.com never in the credential path). All boxes torn down after.

## PROD BUGS found + fixed (only surfaced by real-app-vs-real-box)

| Bug | Fix |
|---|---|
| qrEncoder.js served as SPA HTML on webapp host → pairing QR never renders (prod) | `7685008b` |
| Cross-device device-add bundle delivery **fully broken in prod** (relay had no 2nd leg) | `28b1ddb3` |
| `/join` deep-link served marketing, not the PWA receiver (webapp host) | `71196803` |
| Keyfile recovery: restore activated no cloud profile + re-pair sent old==new IRK (dead on webapp+iOS) | `6ff658f8` |
| `flagship-webapp` IndexedDB v1/v2 store-version mismatch → VersionError breaks unlock/recovery | `96fd8432` |
| create-server POSTed auth-code/RCK endpoints RELATIVE → 405 on the webapp host | `96fd8432` |
| Scratch system-prompt worked example seeds a non-building Dockerfile (COPY package.json, never emitted) | `7bfbcf06` |
| Android `NetworkOnMainThreadException` reading HTTP body on Main | `35f87cbd` |
| (pre-compaction) serve-502 host:manifestPort, daemon CORS, CF DNS 200-cap, cpx31-needs-ash, IRK dot/slash, apex-capture timing, box-deploy-signing, build-modes $PORT | various (main + gym) |

## IN PROGRESS / PENDING

- **#78 admin enforcement — DONE + PROVEN LIVE (2026-06-18, box wapk7b1z7):** `requireDeviceScope` wired into server-revocation (`6c16e323`, main, 50 tests). Live against the enforced gym control plane: ungranted dev2 revoke → **403**, owner grants `revoke-others` → dev2 revokes the server → **200** (`dnsRecordsDeleted:4`), grant revoked → dev2 → **403**, forged sig → 403, owner legacy path unbroken. Device-grant mint/revoke are owner-signed API ops (no webapp UI yet) → a signed-envelope proof, which is the faithful gate test. Artifacts: `gym-results/admin-enforce-proof/`; driver on `finale-admin-live` (gym tooling).
- **#83 iOS Remove-service button** — Worker G wiring the stub to a real signed uninstall (main).
- **#86 iOS keyfile re-pair parity** — iOS has the old==new IRK bug E fixed on webapp; needs the rotating fix (after G frees the iOS sim).
- **#92 service access gating (open/restricted + capability invite links)** — spec `docs/service-access-gating.md`. Identity = **AID** (`deriveAccountId(UMK)`, `flagship/account-id/v1`, NON-rotating; the IRK is versioned/rotates so it's NOT the identity — owner-caught). **BACKEND COMPLETE + WEBAPP CLIENT ON MAIN** (`5ddb8aec`..`9cf7e5e5` backend, `230b9cbd` webapp, `b601c17a` GET+cookie; tsc clean, full vitest 5879 pass): protocol (AID, household-key bundle, create/redeem/revoke envelopes), `.com` `service_invites` store (migration 0056) + handlers (first-bind/same-AID-idempotent/reject-different/revoke), daemon `access.mode` (default open) + **AID-signed `x-flagship-visit` OR `Flagship-App-Session` cookie** enforcement (cookie bound to AID+service, re-checks the allow-list per request so a `.com` revoke kills it; issued on redeem + `POST /api/service-access/establish-session`) + `GET /api/service-access/<ref>` (unauth, exposes only `allowCount`, never the AID graph). Webapp: crypto mirror (byte-parity-verified vs `@flagship/protocol`) + cross-platform vector fixture (`packages/protocol/tests/fixtures/serviceAccessGating.vectors.json`) + admin toggle/allow-list/invite UI + friend `/invite#secret` deep-link. flagshipserver.com is bundle-blind (no UMK). **Remaining:** iOS + Android clients (the keystore `deriveAccountId`/`deriveHouseholdKey` mirrors against the vector fixture + admin/redeem UI — native); the small webapp `establish-session` + GET-state wire-up; then the gym test (admin restrict+invite → friend redeems → access → revoke → denied; + an **IRK-rotation-keeps-access** assertion that proves the AID choice).
- **Expanded AI-build scope (user, 2026-06-18) — DO ALL:**
  - **Multi-tier URLs (#88) — BUILT + PROVEN in gym (boxes wapk13lvf→wapk4bdk5, 2026-06-18):** ALL THREE tiers now work in gym for an AI-built service. **canonical** `<svc>.home.<user>` → 200 (per-box wildcard). **short-canonical `<svc>.<user>` (tier-2 leader-routed)** → `curl -i` **200** (LE cert `CN=tiny-greeter.wapk4bdk5.gym.flagship.services`, YR2) — `gym-results/tier2-build-proof/short-canonical.txt`. **voi.ci-style** `gym.flagshipserver.com/s/<code>` → **302** → 200 — `voici.txt`. (voi.ci/* itself is prod-only + its origin 523s, so gym uses `/s/<code>` on the gym apex.)
    - The tier-2 build closed 4 gaps + found **2 MORE prod routing bugs**: the hub allocator never slot-held a directly-presented short canonical → `SSL_ERROR_SYSCALL`; the DNS-broker policy denied the `service-cert` authority (wire types existed, dispatch fell through).
    - **5 prod-mechanism hunks on `origin/finale-tier2` (tsc clean, 338 tests):** `server-daemon/runtime.ts` (apex threading + `tier2ServiceLabel` — serve the app on its tier-2 SNI), `apps/web/src/tunnel/allocator.ts` (short-canonical slot claim, 2-label-gated, +tests), `apps/dns-broker/src/policy.ts` (service-cert authority dispatch), `apps/com/controlPlaneRoutes.ts` (usernames→dns01), `control-plane/serverRegister.ts` (publish per-user `*.<user>` wildcard A/AAAA, +tests). Gym-only: `route.ts` `/s/<code>` + `wrangler.gym.toml` + drivers (`tier2-drive.ts` etc.).
    - **LANDED ON MAIN (`4acfea3d`, 2026-06-18)** — tsc clean, 1406 touched-area tests pass (incl. F's revocation enforcement coexisting). Completes the on-main cert-model A′ tier-2 (Phase 5). The tier-2 CLIENT mint/install UX is still the standing follow-up (the box self-mints + the driver delivers the entitlement in gym), so prod tier-2 isn't user-usable yet — only the mechanism. Gym is tier-2-enabled (gym Worker deployed; provision with `installerGitRef=finale-tier2` for the tier-2 daemon — fold that into `main` once the box pulls the tier-2 daemon from `main`). Gym-only `/s` redirect route + drivers stay on `origin/finale-tier2`. **NOTE (caught by an owner question):** a gym voici `/s` short-host wiring (`VOICI_SHORT_BASE` / `voiciShortHost=<CONTROL_APEX>/s`) initially slipped into the controlPlaneRoutes merge — it would have BROKEN PROD voi.ci (prod sets `CONTROL_APEX`, and `voici.ts` uses `deps.shortHost`) → backed out (`eaa3ac38`); the product dns01 `usernames` change was kept. Lesson: when extracting from a gym-branch commit, scrutinize CONTROL_APEX/SERVICES_APEX-gated lines — gym defaults can be live on prod.
  - **iOS vibe-code CHAT drive** vs a real box — a real chat turn guiding the live AI → deploy → 200 (native XCUITest, full-platform box, live streaming through the client + the app's AI-key step for BYOK).
  - **Android vibe-code CHAT drive** vs a real box (Compose UI test). NOTE: never run iOS + Android native builds concurrently (16GB Mac → DerivedData lock / OOM).
  - **Notifications** (AI-chat alerts) — must work via **(a) manufacturer push (APNs/FCM)** AND **(b) long-poll, foreground AND background → app-initiated LOCAL notification**, surfaced in the **teal top sliver** (`ActiveOperationsCenter`). Real APNs/FCM delivery to a device needs TestFlight/Play (owner-gated; not on a store yet) — the long-poll → local → sliver path is testable now; the push path is a seam to wire/verify.
- **#84 deploy** — 6 webapp/.com prod fixes batched on main (owner-gated): `7685008b 28b1ddb3 71196803 6ff658f8 96fd8432` + the route ones. Daemon systemPrompt fix `7bfbcf06` ships via the box recipe.

## ORCHESTRATION NOTES

- One background agent per task, `isolation: worktree` (off `main`) OR a pre-made `git worktree add -b <name> <path> gym` for gym-branch work. NEVER let two agents share the main tree (branch-switch corruption).
- Only ONE native build (iOS xcodebuild / Android gradle) at a time.
- Don't redeploy the gym webapp/Worker while a sibling webapp worker is live-testing the deployed gym.
- `__gymAdopt` (restore owner session from a UMK seed) is `gym:apps/web/public/webapp/app.js`; `__gymCreate` mirrors it. `provision-for-webapp.ts` + `teardown.ts` are gym-only tooling. Full-platform box = cpx31/ash with docker+SWK+`FLAGSHIP_PSK_PUB_HEX` (needed for build/vibe/adapt; `/api/services` 200 not 503).
- ROTATE the pasted test Hetzner + OpenAI keys (they were in chat).
