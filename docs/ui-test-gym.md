# UI test gym — design doc (demo-fixture + live-Hetzner tiers)

> **Status: PROPOSAL, owner approval pending. Nothing built yet.** This is the
> plan for an automated UI "gym": drive the ACTUAL app — iOS, Android, webapp —
> through every on-screen scenario, with two backend postures (fast local
> fixtures + a real Hetzner demo box). Last updated 2026-06-17.
>
> Why now: the metal-install path is proven (encrypted box → green padlock on
> real hardware, 2026-06-10/12) and a Hetzner demo VPS runs the **same daemon a
> real box does** (`scripts/sample-user.mjs` / `packages/control-plane/src/demoUsers*.ts`),
> so a true end-to-end UI exercise against a real backend is now feasible without
> shipping hardware to a CI runner.

---

## 1. Goal & non-goals

**Goal.** A repeatable, CI-runnable harness that *launches the real app on each
surface and taps through it* — onboarding, account-create, recovery, create a
server, install a service, approve an unlock, the lot — asserting on-screen
state and capturing screenshots/video on failure. Catch UI regressions (a moved
button, a broken nav edge, a screen that won't render a state) that unit tests
miss because they never compose the real screen graph or cross screen
boundaries.

**Non-goals.**
- Not a replacement for the unit suites (vitest / XCTest / Robolectric). Those
  stay the bulk of coverage; the gym is the thin top of the pyramid that proves
  the screens actually wire together.
- Not real-time human-like exploration / fuzzing. This is **deterministic,
  scripted UI testing**: a script taps a known element by its accessibility
  id / test-tag and asserts a known next state. (No AI-driven "click around and
  see"; no `appium`/`idb` record-and-replay — see §2.)
- Not load/perf testing, not the hardware-install / LUKS-unlock kernel path
  (that needs real metal — see `docs/cert-model-A-prime-migration.md` test list).
- Not a security boundary. The gym uses demo/operator-gated backends; it never
  touches a real user account.

---

## 2. How the gym drives the UI

Each surface has a native UI-automation framework that launches the built app
and drives it through the OS accessibility tree. The app "taps itself" via a
test script that finds elements by **stable accessibility id / test-tag** and
asserts the resulting screen state.

| Surface | Framework | How it drives | Element handle |
|---|---|---|---|
| **iOS** | **XCUITest** (`XCUIApplication`) | `xcodebuild test` on a Simulator; the test process launches the app out-of-process and queries the a11y tree | `accessibilityIdentifier` |
| **Android** | **Compose UI Test + Espresso** on an emulator (instrumented `androidTest`) | `connectedDebugAndroidTest` launches the app on an AVD; `composeTestRule`/Espresso drive it | `Modifier.testTag(...)` / content-description |
| **webapp** | **Playwright** (chromium) | launches a headless browser at the webapp origin and drives the DOM | CSS / `data-testid` / role+text |

Properties the gym must have on every surface:
- **Element handles, not coordinates** — assert/tap by id, never pixel position
  (survives layout/theme changes; the iOS app already carries 219 of these).
- **Failure artifacts** — screenshot + video/trace on failure, uploaded as CI
  artifacts (Playwright `screenshot:"only-on-failure"` + `trace`/`video:"retain-on-failure"`
  is already configured; XCUITest emits an `.xcresult`; Compose/Espresso can
  dump a bitmap + view hierarchy).
- **Deterministic** — a fixed seed/fixture or a freshly-provisioned demo box, so
  a green run means green, not "the shared box happened to be in a good state".

**Honest constraints.**
- This is scripted, not exploratory. A scenario the script doesn't enumerate is
  not covered, full stop. Coverage = the matrix in §5, nothing more.
- `appium` and `idb` are **not installed** and are **not needed**: XCUITest is
  first-party (ships with Xcode) and talks to the Simulator directly; Compose
  UI Test + Espresso are first-party Android; Playwright is a self-contained
  npm dep. No extra device-bridge daemons.
- iOS UI tests require **macOS + Xcode + a Simulator runtime**. Android
  instrumentation requires **an emulator (AVD)** — heavier than the existing
  Robolectric JVM tests (see §3). The webapp needs only Node + a chromium
  download.

---

## 3. Current state / head start

We are **not** starting from zero. Per-surface reality, with file paths:

### iOS — a real XCUITest target already exists
- **Target:** `FlagshipAppUITests` (`bundle.ui-testing`) in
  `apps/mobile/ios/App/project.yml`, depends on `FlagshipApp`,
  `TEST_TARGET_NAME: FlagshipApp`. Run via
  `xcodebuild test -scheme FlagshipApp -destination 'platform=iOS Simulator,...'`.
- **Existing specs:** `apps/mobile/ios/App/UITests/OnboardingSmokeTests.swift`
  — two smoke tests (`test_coldLaunchReachesCreateServerMatch`,
  `test_qrRelayDriveToMatchCode`) that cold-launch and drive Welcome →
  ChooseUsername → CreateServer → the mock-relay match page.
- **Element handles:** **219 `accessibilityIdentifier`** occurrences across 45
  files in `apps/mobile/ios` + `apps/mobile/shared` (e.g. `cs-name-field`,
  `cs-continue-button`, `cs-demo-qr-button`, `cs-match-label`). This is the
  single biggest head start — most screens are already addressable.
- **~50 screens** under `apps/mobile/ios/Sources/FlagshipUI/Screens` + `Shell`.

### iOS — the two launch modes (exactly how a test selects each)
1. **Demo-fixture mode (no network):** launch with the process argument
   `-smoke-mode`. `FlagshipApp.applySmokeModeIfRequested(...)`
   (`apps/mobile/ios/App/Sources/FlagshipApp.swift`) sees
   `ProcessInfo.processInfo.arguments.contains("-smoke-mode")` and calls
   `DemoFixtures.activate(app, username: "smoketest")` — seeded local AppState,
   no backend. Pair with `-smoke-tab <home|apps|activity|settings>` to land on a
   tab (`ContentView.smokeInitialDestination`). The XCUITest sets these via
   `app.launchArguments`.
2. **Live mode (real backend):** controlled by
   `DeveloperSettings.useLiveClient` (`apps/mobile/shared/Sources/FlagshipCore/DeveloperSettings.swift`),
   persisted in `UserDefaults` key `flagship.dev.useLiveClient`. Release builds
   default ON, Debug default to the mock (`releaseDefaultUseLive`). The active
   client is chosen in `FlagshipApp.activeClient`
   (`dev.useLiveClient ? liveClient : mockClient`, and the same for
   server/relay/mailbox/lockPower/frontPage). For a Tier-2 test, the launcher
   pre-seeds the toggle (launch a Release-config build, or set the UserDefaults
   key via a launch arg the app reads in DEBUG) so the live `ScreensClient`
   points at the demo box. Note: in the app the toggle is reached by 3-tapping
   the version row (`DeveloperSettings.unlocked`) — the gym sets it
   programmatically rather than tapping the gesture.

### webapp — a real 17-flow Playwright gym already runs in CI
- **Location:** `apps/web/e2e/` — `playwright.config.ts` (chromium-only,
  `serviceWorkers:"block"`, `--ignore-certificate-errors`, PNA flags disabled),
  17 flow specs `flows/s00..s16.spec.ts`, fixtures `fixtures/identity.ts` +
  `fixtures/pod-sim.ts`, and a `pod-sim/` simulator package.
- **Specs (gaps in the numbering are intentional):** s00 rig-smoke · s01 signup
  · s02 pod-pair · s04 vibe-code · s05 unlock-approve · s06 long-lived-lease ·
  s08 recovery-setup · s09 recovery-cross-browser · s10 manual-export · s11
  push-subscribe + s11 wipe-restart · s12 push-deliver · s13 offline-replay ·
  s14 marketing-surface · s15 webapp-shell · s16 build-relay.
- **How it runs:** `.github/workflows/e2e.yml` — `ubuntu-22.04`, `npm install`
  → `npx tsc -b` → `playwright install chromium` → start `wrangler dev` (local
  miniflare on :8787) → `npm test`. Triggered on `pull_request` +
  `workflow_dispatch` (deliberately **not** `push:main` until it has a proven
  green run on a real runner). The pod-sim spins up per-worker; most specs stub
  apex `/api/*` via `page.route` (SW blocked); S14 hits the apex directly.
- **~42 views** under `apps/web/public/webapp/views`.

### Android — partial; the instrumentation harness is net-new
- **What exists:** Compose UI tests, but as **Robolectric JVM unit tests** in
  `apps/mobile/android/app/src/test/...ui/screens/` —
  `HomeScreenComposeTest.kt`, `AddServerChooserComposeTest.kt`,
  `ProvidersComposeTest` — each renders **one composable** via
  `createComposeRule()` (`@RunWith(RobolectricTestRunner)`, `@Config(sdk=[33])`)
  and asserts with `onNodeWithText`/`assertIsDisplayed`. These run in the normal
  `:app:testDebugUnitTest` JVM suite (no emulator).
- **What is NOT there (the net-new work):**
  1. **No on-device/emulator instrumentation harness** — `build.gradle.kts`
     declares the `androidTestImplementation(...)` deps (`androidx.test.ext:junit`,
     `compose.ui:ui-test-junit4`) but there is **no `src/androidTest/` source
     dir**, so nothing runs on an AVD and nothing launches the full app
     (`MainActivity`) and drives it across screens.
  2. **Almost no `testTag`s** — only 2 main-source screens carry them
     (`HomeScreen.kt`, `DemoInstallProgressScreen.kt`). iOS has 219 handles;
     Android has ~0 for the rest of the ~48 screens under
     `apps/mobile/android/app/src/main/java/com/flagshipserver/app/ui/screens`.
- **Launch modes (already wired, mirror iOS):**
  `DeveloperSettings.useLiveClient` is a `StateFlow` (UserDefaults-equivalent
  `useLiveClient` pref); `MainActivity` picks
  `if (useLive && sessionToken != null) liveScreens else mockScreens`.
  `DemoFixtures.activate(...)` exists (`core/DemoFixtures.kt`). So the *app* can
  already run demo-vs-live; what's missing is the harness to launch and drive
  it.

### Hetzner demo backend — already provisionable
- **Worker-side provisioning:** `apps/com/src/hetzner.ts` (pure-`fetch` Hetzner
  Cloud REST; the Worker creates a VPS with a cloud-init `user_data` script that
  `wget`s a personalized ISO from R2 and `dd`s it — no SSH). State machine +
  reaper in `packages/control-plane/src/demoUsers.ts` /
  `demoUsersAdmin*.ts`; Worker routes `/api/dev/sample-user/{create,delete,
  admin-claim-and-issue,…}` (`apps/com/src/controlPlaneRoutes.ts`).
- **Operator CLIs:** `scripts/sample-user.mjs` (W11 — per-user; the laptop needs
  **only `FLAGSHIP_ADMIN_SECRET`**, the Worker holds `HCLOUD_TOKEN` and runs all
  Hetzner ops) and `scripts/demo-account.mjs` (shared live demo account;
  registered-operator-key-signed, dry-run default, manual teardown only).
- **Guardrails today:** `MAX_CONCURRENT_DEMO_VPS` cap (429 over budget); a
  `*/10` cron reaper destroys idle VPS and promotes `provisioning → up`. Demo
  vars + KEKs in `apps/com/wrangler.toml` (`DEMO_IRK_KEK` derives deterministic
  demo IRKs).

---

## 4. Architecture — two tiers

The gym runs the **same scripts** in two backend postures. A tag/annotation on
each test selects its tier.

### Tier 1 — demo-fixture mode (fast, every PR/push, $0 backend)
- **What it is:** the app launched against **seeded local state / a mock client**
  — no network, no Worker, no VPS.
- **How each surface enters it:**
  - iOS: `app.launchArguments = ["-smoke-mode", "-smoke-tab", "home"]` →
    `DemoFixtures.activate`. `useLiveClient` stays false → `mockClient`.
  - Android: launch `MainActivity` with the dev toggle off (default) →
    `mockScreens`; seed via `DemoFixtures.activate` (a debug-only launch
    intent/arg the harness sets — to be added).
  - webapp: the existing pattern — `pod-sim` fixture + `page.route` stubs for
    apex `/api/*`, SW blocked (`apps/web/e2e/fixtures/pod-sim.ts`).
- **What it validates:** every screen *renders* in each of its states; nav edges
  and back-stack; form validation; conditional UI (filters, empty states,
  greyed/gated buttons, the active-operations sliver, the trust sliver); copy.
  It does **not** prove the real wire contract (mocks can drift from live).
- **Cost/speed:** seconds per test; no infra; safe to gate every PR.

### Tier 2 — live Hetzner demo server (true e2e, nightly/on-demand)
- **What it is:** a real demo account on the live control plane + a real Hetzner
  VPS running the production daemon; the app in **live mode** drives the real
  flow end-to-end (real signed envelopes, real `/pods`, real daemon endpoints,
  real green-padlock pod URL).
- **How each surface enters it:**
  - iOS: a Release-config build (or DEBUG with the harness pre-seeding the
    `flagship.dev.useLiveClient` UserDefault) so `activeClient = liveClient`,
    pointed at the demo username.
  - Android: launch with `useLiveClient = true` + a stored session token
    (the harness seeds the pref) → `liveScreens`/`liveBuild`.
  - webapp: point `WEBAPP_BASE_URL`/`APEX_BASE_URL` at `web.flagshipserver.com`
    / `flagshipserver.com` (the config already supports this) and run against
    the live demo account instead of the pod-sim.
- **What it validates:** the contract the mocks only approximate — the real
  identity calls, the create-server → provision → online ladder, install a
  service against the live daemon, approve-unlock, front-page, journal, etc.
- **Cost/speed:** minutes (VPS boot ~1–3 min + flow time); consumes Hetzner €
  and an operator-secret-gated provision. Nightly + `workflow_dispatch`, not per
  PR.

**Rule of thumb:** Tier 1 answers "does the UI work?"; Tier 2 answers "does the
UI talk to a real box correctly?". Most scenarios get Tier-1 coverage; a curated
**critical vertical slice** gets Tier-2.

---

## 5. Scenario matrix

On-screen scenarios surveyed from the real screen graphs (iOS
`FlagshipUI/Screens`+`Shell`, Android `ui/screens`+`shell`, webapp
`public/webapp/views`). "Coverage today" = existing automated UI coverage only
(unit tests not counted). T1 = demo-fixture feasible; T2 = needs live backend.

| # | Scenario | Surfaces | Coverage today | T1? | T2? |
|---|---|---|---|---|---|
| 1 | Onboarding / Welcome → create account → choose username | iOS·And·Web | iOS smoke (`OnboardingSmokeTests`); web s01 | ✅ | ✅ |
| 2 | Secure account / biometric (Face ID / biometric / set passphrase) | iOS·And·Web | none (web partial via s11) | ✅ (mock biometric) | ⚠️ biometric can't be real in CI |
| 3 | Recovery enrollment (passkey / WebAuthn-PRF, recovery codes) | iOS·And·Web | web s08, s09 (cross-browser) | ✅ | ⚠️ WebAuthn virtual-authenticator on web; mobile passkey hard in CI |
| 4 | Create server — name + disk-encryption toggle + backup-policy | iOS·And·Web | iOS smoke (form→QR); web s02 (pair) | ✅ | ✅ |
| 5 | Deliver-recipe handoff (QR/relay → match SAS) | iOS·And·Web | iOS smoke (mock relay); web s02 | ✅ | ✅ |
| 6 | Install-progress ladder (phase timeline) | iOS·And·Web | none (iOS `DemoInstallProgressScreen` has tags) | ✅ | ✅ |
| 7 | Approve-unlock (boot-unlock Approve card) | iOS·And·Web | web s05 | ✅ | ✅ |
| 8 | Home / Servers list + status filters (All/Online/Pending/Offline) | iOS·And·Web | And `HomeScreenComposeTest` (Robolectric); web s15 | ✅ | ✅ |
| 9 | Server-detail: Front page picker | iOS·And·Web | none | ✅ | ✅ |
| 10 | Server-detail: Lock & power-off / restart | iOS·And·Web | none | ✅ | ✅ |
| 11 | Server-detail: Dead-man heartbeat-lock (opt-in + countdown) | iOS·And·Web | none | ✅ | ⚠️ lapse is time-based |
| 12 | Server-detail: View journal (diagnostics) | iOS·And·Web | none | ✅ | ✅ |
| 13 | Services list + service-detail + env editor (Save/Uninstall) | iOS·And·Web | none | ✅ | ✅ |
| 14 | Build-a-service chooser → scratch / git / mcp / journal | iOS·And·Web | web s04 (vibe), s16 (build-relay) | ✅ | ✅ |
| 15 | Build: AI-key step (recall masked slug / confirm / save) | iOS·And·Web | none | ✅ | ⚠️ live model run = BYOK key, not in CI |
| 16 | Marketplace browse / install + scan-grade *(feat/marketplace only)* | iOS·And·Web | none | ✅ (on branch) | ✅ (on branch) |
| 17 | Settings: session tiers (lock/passkey/remove-device, grey-out gating) | iOS·And·Web | none | ✅ | ✅ |
| 18 | Settings: AI-keys manager (view-slug / add / delete / make-default) | iOS·And·Web | none | ✅ | n/a (device-local) |
| 19 | Settings: account-security (TOTP enroll, recovery, account-type) | iOS·And·Web | web s08 | ✅ | ⚠️ TOTP secret |
| 20 | Re-pair / replace-device finalize (countdown + Complete) + pending banner | iOS·And·Web | none | ✅ | ⚠️ grace window time-based |
| 21 | TOTP entry / second-factor on re-pair | iOS·And·Web | none | ✅ | ⚠️ |
| 22 | Add-device SAS (cross-device pairing code) | iOS·And·Web | none | ✅ | ✅ |
| 23 | Active-operations sliver (WhatsApp-style, deploy/build deep-link) | iOS·And·Web | none (unit `ActiveOperations*` per surface) | ✅ | ✅ |
| 24 | Maintainer-trust sliver + biometric/PIN override (red bar) | iOS·And·Web | none | ✅ (inject untrusted verdict) | ✅ |
| 25 | voi.ci / share (tier-1 canonical copy/share) | iOS·And·Web | none | ✅ | ✅ |
| 26 | Webapp PIN lock (set / change / unlock / reset) | Web only | web (unit `webappPinLock`) | ✅ | n/a |
| 27 | PodSwitcher (multi-pod) | iOS (And gap) | none | ✅ | ✅ |
| 28 | Peer-backup / companion-dock / browser-tabs | iOS·And·Web | none | ✅ | ⚠️ companion needs live pair |

**Count: 28 scenario rows.** ~7 are Tier-1-only or have a Tier-2 caveat
(biometric, WebAuthn, time-based grace/lapse, BYOK model runs) that CI can't
fully exercise without real secrets/hardware — those get a documented stub
(virtual authenticator, injected clock, mock biometric) and a manual-only note.
Row 16 (marketplace) lives on `feat/marketplace`; the gym scripts for it ship on
that branch per the branch-is-the-gate rule.

---

## 6. Tier-2 Hetzner strategy

### How provisioning works today
`scripts/sample-user.mjs create <username> --display "<name>"` (needs only
`FLAGSHIP_ADMIN_SECRET` locally) calls the Worker's
`/api/dev/sample-user/create`; the Worker (holding `HCLOUD_TOKEN`) creates a
Hetzner VPS via `hetzner.ts` with a cloud-init `user_data` that pulls the
personalized ISO from R2 and `dd`s it — no SSH from the runner. The box boots
the **production daemon**, registers, and serves
`<server>.<demo-user>.flagship.services` with a real Let's Encrypt cert. State
(`provisioning → up`) is tracked in `demo_users`; the `*/10` cron reaps idle
boxes. (`scripts/demo-account.mjs` is the alternate, registered-operator-key
path for the long-lived shared demo account.)

### Per-run fresh VPS vs shared long-lived box
| | Fresh-per-run | Shared long-lived (reset between runs) |
|---|---|---|
| **Isolation** | perfect — every run starts clean | must reset/wipe state between runs (risk of bleed) |
| **Flake** | boot variance (~1–3 min) in the critical path | none from boot; state-reset can be fragile |
| **Cost** | one VPS-hour-ish per run + churn | one box billed continuously |
| **Speed** | slower (provision + boot each run) | fast (box already warm) |
| **Quota** | bounded by `MAX_CONCURRENT_DEMO_VPS` | trivial |
| **Tests the provision path itself** | YES (create-server → online is real) | NO (box pre-exists) |

**Recommendation: a hybrid.**
- A **single nightly fresh-provision run** of the *vertical slice* (scenario
  1→4→6→7→13) — this is the only way to actually test create-server →
  provision → online → install, and a clean box every night catches drift in
  the provisioning path itself.
- The broader Tier-2 scenario set runs against a **shared long-lived demo box
  reset to a known state** between scenarios (faster, no boot variance for flows
  that assume an already-online box). Reset = the existing per-scenario teardown
  of services/state on the demo account, not a reburn.
- Always **tear down fresh boxes** at the end (`sample-user.mjs delete <user>`
  + the `*/10` reaper as a backstop); the shared box persists.

### Cost / time (rough)
- Hetzner `cx22`-class VPS ≈ small single-digit € per *month*; a nightly fresh
  box up for ~30 min ≈ cents/run. Negligible vs the macOS-runner cost (§7).
- Provision + boot to "online": ~1–3 min; a full vertical-slice run: ~5–10 min.

### Credential prerequisites
- `FLAGSHIP_ADMIN_SECRET` (runner secret) for `sample-user.mjs`.
- `HCLOUD_TOKEN`, `DEMO_IRK_KEK`, `DEMO_PUBLIC_SSH_KEY_ID` already live in the
  Worker — the runner never holds the Hetzner token.
- For the operator-gated `demo-account.mjs` path: a registered operator Ed25519
  key (YubiKey/WebAuthn-exported) — **not** suitable for unattended CI; reserve
  it for the human-driven shared-box lifecycle.

---

## 7. CI wiring

| Surface | Runner | Job |
|---|---|---|
| webapp | `ubuntu-22.04` | already wired — `.github/workflows/e2e.yml` (wrangler-dev miniflare) |
| iOS | **macOS runner** (`macos-14`+, Xcode + Simulator) | `xcodebuild test -scheme FlagshipApp -destination 'platform=iOS Simulator,...' -only-testing:FlagshipAppUITests` |
| Android | `ubuntu` + **emulator** (`reactivecircus/android-emulator-runner` or AVD) | `:app:connectedDebugAndroidTest` (the net-new `androidTest` suite) |

- **Tier 1** runs on **PR + push** (fast, free-ish). The webapp tier-1 already
  does. iOS adds a UI-test step to the existing iOS CI; Android adds an emulator
  job (heavier — see capacity below).
- **Tier 2** runs **nightly (`schedule`) + `workflow_dispatch`**, never on PR —
  it provisions a Hetzner box and uses live secrets. Keep it off `push:main`
  until it has a proven green run on a real runner (same posture `e2e.yml`
  already takes).
- **Artifacts:** Playwright report + traces/video (already configured); the iOS
  `.xcresult` bundle; Android Compose failure bitmaps + view-hierarchy dumps.
  Upload on `always()`, ~14-day retention.

**Runner capacity required (be honest):**
- **macOS runners are the expensive constraint** — GitHub bills them ~10× a
  Linux minute, and an Xcode UI-test boot is slow. Budget this deliberately;
  consider running iOS UI tests on a self-hosted Mac (this dev Mac already runs
  the XCTest suite) for the nightly Tier-2 slice.
- **Android emulator** jobs need KVM/nested-virt; the standard GitHub
  `ubuntu` runners support `android-emulator-runner` but a cold-boot AVD adds
  several minutes per run. Robolectric stays the fast path; reserve the emulator
  for the genuine launch-and-drive scenarios.

---

## 8. Gaps & prerequisites

1. **Android instrumentation harness is net-new** — add a `src/androidTest/`
   source set, an `AndroidJUnitRunner` config, and a launch-the-real-`MainActivity`
   harness (`createAndroidComposeRule<MainActivity>()`), plus a debug-only launch
   path that seeds `DemoFixtures` / the `useLiveClient` pref from an intent extra.
   (The Robolectric single-composable tests stay as-is; they're complementary.)
2. **Android test-tags** — add `Modifier.testTag(...)` across the ~46 untagged
   screens (iOS already has 219 a11y ids; Android has ~2 screens). This is the
   bulk of the Android effort and should mirror the iOS id naming where possible.
3. **Demo-fixture coverage per scenario** — `DemoFixtures` (both surfaces) needs
   seed data for each scenario state the matrix enumerates (a server in each
   status, a pending re-pair, an untrusted-trust verdict, an active operation,
   installed services with env). Today it seeds a basic paired shell.
4. **iOS Tier-2 launch seam** — a clean way to force `useLiveClient` + a session
   from launch args (today it's a UserDefault + a 3-tap gesture). Add a
   DEBUG-only launch-arg reader, or run a Release build configured for the demo
   account.
5. **Tier-2 credentials in CI** — `FLAGSHIP_ADMIN_SECRET` as a runner secret;
   confirm the Worker's `HCLOUD_TOKEN`/`DEMO_IRK_KEK` are live; decide the
   fresh-vs-shared demo-box posture (§6).
6. **CI macOS-runner budget** — the single biggest cost/approval item (§7);
   needs an owner call on hosted-minutes vs self-hosted Mac.
7. **Unavoidable stubs** — biometric, WebAuthn passkey, TOTP, and time-based
   grace/lapse windows can't be fully exercised unattended; document a virtual
   authenticator (web), a mock biometric, and an injectable clock, and mark the
   residual as manual-only.

---

## 9. Phased rollout

**Phase 1 — one live vertical slice (prove the harness + live wiring).**
On **one surface** (iOS — it has the XCUITest target + 219 ids already, the
shortest path), script the slice: **onboarding → create a demo server →
online → approve unlock → install a service**, run it **Tier-2 against a
freshly-provisioned Hetzner box**. This proves end-to-end that the harness can
drive the real app against a real backend, and shakes out the launch-seam +
provisioning + teardown plumbing. *Effort: ~2–4 days* (most is the live-launch
seam + provisioning glue, not the taps).

**Phase 2 — broad Tier-1 demo-mode coverage per surface.**
Fill the §5 matrix in **demo-fixture mode** on iOS + webapp (webapp already has
17 specs — extend to the newer scenarios: front-page, lock/power, dead-man,
journal, service-env, trust sliver, ops sliver, session tiers). Expand
`DemoFixtures` seed states. Runs on every PR. *Effort: ~1–2 weeks across iOS +
webapp* (gated by how much seed data each scenario needs).

**Phase 3 — the Android harness.**
Stand up `src/androidTest/`, add `testTag`s across screens, port the Tier-1
matrix to Compose UI Test + Espresso on an emulator. *Effort: ~1.5–2.5 weeks*
(the test-tag sweep dominates; the harness itself is a few days).

**Phase 4 — Tier-2 nightly + CI gating.**
Wire the nightly `schedule`/`workflow_dispatch` Tier-2 job (fresh-box vertical
slice + shared-box broad set), add the macOS + emulator CI jobs, wire artifact
upload, and decide which Tier-1 scenarios become **required PR gates** vs
advisory. *Effort: ~3–5 days* (mostly CI YAML + secret plumbing + flake
quarantine).

---

## 10. Open decisions for the owner

1. **Backend posture (Tier 2):** fresh-VPS-per-run vs shared-long-lived-box, or
   the recommended hybrid (§6)? This drives cost, flake, and whether the
   provision path itself is tested.
2. **Credential availability:** put `FLAGSHIP_ADMIN_SECRET` in CI as a runner
   secret for unattended Tier-2? (The operator-key `demo-account.mjs` path stays
   human-only.) Confirm the demo Worker secrets are live.
3. **CI runner availability / budget:** approve hosted macOS minutes for iOS UI
   tests, or run them nightly on a self-hosted Mac (this dev machine)? Same call
   for the Android emulator job. **This is the gating cost.**
4. **Scenario priorities:** which of the 28 rows are must-have day one, and which
   become **required PR gates** vs advisory? (Recommend: the vertical slice +
   onboarding/create-server/home as gates; the rest advisory until stable.)
5. **Demo-vs-live emphasis:** how much weight on Tier-1 (fast, cheap, but mocks
   can drift) vs Tier-2 (true contract, but slow/€/secret-gated)? Recommend
   Tier-1 broad + Tier-2 a curated slice.
6. **Surface order:** confirm iOS-first for Phase 1 (most head start), or
   prioritize a different surface.

---

## Headline recommendation

Build a **two-tier** gym — Tier 1 (demo-fixture, fast, every PR) for breadth,
Tier 2 (live Hetzner demo box, nightly) for the real contract — and **start with
a single live vertical slice on iOS** (onboarding → create demo server → online
→ approve unlock → install a service) to prove the harness + live wiring before
investing in broad coverage. iOS and the webapp have a real head start (an
XCUITest target + 219 a11y ids; a 17-spec Playwright gym already in CI); Android
is the largest net-new lift (an emulator instrumentation harness + a test-tag
sweep). The gating constraint is **CI runner budget (macOS)**, not the test code.
