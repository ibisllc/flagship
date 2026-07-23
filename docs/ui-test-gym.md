# UI test gym — design doc (every-merge gym + the total gym)

> **Status: APPROVED — rev4 (final decisions locked + an executable build plan
> added). Build targets G1–G4 + a start on G5/G6 this run; the rest fills in
> incrementally on the harness.** This is the plan for an automated UI "gym":
> drive the ACTUAL app — iOS, iPad, Android, webapp — through every flow we have
> built, asserting on-screen state, the real backend effect, server-event
> propagation, and a structured aesthetic review, with two backend postures (fast
> local fixtures + a real Hetzner demo box). Last updated 2026-06-17.
>
> Why now: the metal-install path is proven (encrypted box → green padlock on
> real hardware, 2026-06-10/12) and a Hetzner demo VPS runs the **same daemon a
> real box does** (`scripts/sample-user.mjs` / `packages/control-plane/src/demoUsers*.ts`),
> so a true end-to-end UI exercise against a real backend is now feasible without
> shipping hardware to a CI runner.
>
> **rev4 — what the owner LOCKED (final, supersedes the rev3 "remaining"
> questions; the §11 items are now RESOLVED and §12 carries the executable build
> plan):**
> - **Test env = `gym.` SUBDOMAINS on the EXISTING zones — no new domain.** The
>   isolated test env is **`gym.flagshipserver.com`** (control plane / the `.com`
>   Worker) + **`gym.flagship.services`** (data plane / the Fly app), reusing the
>   two Cloudflare zones we already own. Test boxes are
>   `<server>.<user>.gym.flagship.services`. This RETIRES the rev3 "hard
>   prerequisite: a spare domain" — there is no new domain to acquire (§6.5, §11).
> - **The `gym.` domain is public/knowable — isolation is by ZEROING the backend
>   between runs (D1 wipe), not by secrecy.** A knowable test apex is fine; the
>   test env runs against its OWN D1/R2 and is wiped clean between runs with the
>   existing wipe script, so there is no cross-run state and no real-user data in
>   it. Secrecy was never the isolation mechanism (§4, §6.5).
> - **Ban the username `gym` (prod AND test).** One reserved-name ban closes BOTH
>   the namespace collision (a prod user `gym` would own `gym.flagshipserver.com`'s
>   identity / `gym.flagship.services`'s zone) AND the CT-monitor false-positive
>   (prod's CT monitor only matches a test cert when a prod user equals the apex
>   label — so banning `gym` means a test cert under `*.gym.flagship.services` can
>   never collide with a registered prod user). Also extend the reserved set to
>   `test`/`e2e`/`qa`/`ci`/`staging`. The chokepoint is
>   `validateUserLabel` / `RESERVED_USER_LABELS` in
>   `packages/control-plane/src/labels.ts` (mirrored in
>   `packages/services-zone/src/validation.ts`) — see §6.5 + §12-G1.
> - **Exact-same-code via a prod-default apex variable.** Introduce ONE apex /
>   base-URL variable per surface whose **default is today's literal**
>   (`flagship.services` / `flagshipserver.com`), so prod behavior is
>   byte-identical and the SAME code runs for tests and for users' live
>   experience; only the test env sets the var to the `gym.` apex. This is a
>   behavior-preserving, gated refactor (prod default unchanged → the full suite +
>   the canonical-byte vectors stay green) — and it incidentally fixes the latent
>   SNI-allocator/zone misparse by parsing **apex-RELATIVE**, not fixed-depth (§3,
>   §6.5, §12-G1/G2).
> - **One-command-then-wait runner.** Each gym is invoked by a SINGLE command and
>   produces a pass/fail summary + screenshots; the engine is the deterministic
>   gate + the short-AI judge/navigator already specified in §2.1 (§9, §12-G3).
>
> **rev3 — what the owner decided (still in force; the framing this doc carries):**
> - **The runner is the owner's physical Mac (this machine).** The heavy
>   iOS/iPad/Android UI tiers + the total gym + the live-Hetzner runs execute
>   LOCALLY here (Simulators / emulator local; it provisions ephemeral Hetzner via
>   the Worker; it judges via short AI). This RESOLVES the old "hosted-macOS CI
>   runner budget" question — there is no hosted-macOS cost. The cheap
>   every-merge gym stays in GitHub-Linux CI; the rest runs on this Mac on a
>   nightly / monthly / on-demand cadence (§7, §9, §10).
> - **Tier-2 Hetzner is ephemeral** — every live run creates a fresh demo server,
>   tests, then deletes it (guaranteed teardown). RESOLVES the §6 "fresh vs
>   shared" question in favor of fresh-per-run; cost stays ~cents/run (§6, §11).
> - **The harness is a deterministic gate + a short-AI judge/navigator** — the
>   pass/fail oracle is scripted element-handle taps + state assertions + diffable
>   screenshots; short-running AI plays two BOUNDED, advisory roles (judge the
>   screenshots for "does this look right / beautiful", and navigate / self-heal
>   when a control moves). The AI is **not** the pass/fail oracle. NEW §2
>   subsection; owner-recommended, pending final confirm of how much AI drives.
> - **Pre-GA, the D5 server-side states are induced via this box's own admin
>   access** (`FLAGSHIP_ADMIN_SECRET` + the demo/Hetzner control surface) against
>   DEMO entities — so **no new production hooks are needed pre-GA** (§6, §7-A).
> - **Post-GA, a dedicated internet-real isolated TEST environment** — rev4 puts
>   it on **`gym.` subdomains of the existing zones** (`gym.flagshipserver.com` +
>   `gym.flagship.services`, its own D1/R2/Hetzner, wiped between runs); it carries
>   the clean state-induction hooks, so the monthly GA-era gym never touches prod
>   (§6.5).

---

## 0. The two gyms (read this first)

The owner's vision is **two distinct gyms**, not one:

1. **The every-merge gym** — a *fast regression net* that runs per PR/merge. A
   curated, cheap, deterministic **subset** of the total matrix (mostly Tier-1
   demo-fixture flows): does the app still launch, render its core screens, and
   navigate without a broken edge. It gates merges. Minutes, not tens of minutes;
   $0 backend; no flake budget to spend.

2. **The total gym** — the *comprehensive acceptance suite* that checks **every
   feature built so far, across every app surface** (iOS, iPad, Android, webapp).
   It is the centerpiece of this doc. It is large by design and runs on a slower
   cadence (nightly / pre-release / on-demand), mixing Tier-1 breadth with a
   Tier-2 live slice and a semi-automated aesthetic review.

The two gyms share **one harness, one element-handle convention, and one set of
scripts** (§2). The every-merge gym is literally a tag-selected subset of the
total-gym scenarios. The difference is *which* scenarios run, on *what cadence*,
against *which backend posture* — not different machinery.

> **The total gym must cover, in detail** (the owner's seven points, mapped to the
> dimensions in §6):
> 1. Lifecycle CRUD — create / control / **delete** for **accounts, servers, AND
>    services** → **D1**.
> 2. Every mode of creating a service, in detail (scratch, git, mcp, marketplace,
>    journal) → **D2**.
> 3. Settings effectively control the account, incl. edge cases (multi-device,
>    lost device) → **D3**.
> 4. UI is usable (every button works), understandable (not verbose, meaningful
>    nav), and beautiful (ergonomic, colors) → **D7**.
> 5. Server-side events surface on the front end as they should (server issues,
>    usage, certificates expiring) and UI actions have the effect they should →
>    **D5 + D6**.
> 6. The entire global security experience (screen lock, biometrics, recovery
>    files, takeover/grace, trust enforcement) → **D4**.
> 7. Everything works on every surface → **D8** (the matrix is dimension ×
>    surface throughout).

---

## 1. Goal & non-goals

**Goal.** A repeatable, CI-runnable harness that *launches the real app on each
surface and taps through it* — and, for the total gym, asserts four things per
scenario: (a) the on-screen state, (b) the **real backend effect** of any action
taken (D6), (c) that **server-side events propagate** to the right surface (D5),
and (d) a **structured aesthetic/usability review** (D7). Catch UI regressions (a
moved button, a broken nav edge, a screen that won't render a state, a dead
control, a server event that never surfaces, an action with no effect) that unit
tests miss because they never compose the real screen graph or cross screen
boundaries.

**Non-goals.**
- Not a replacement for the unit suites (vitest / XCTest / Robolectric). Those
  stay the bulk of coverage; the gym is the thin top of the pyramid that proves
  the screens actually wire together end to end.
- Not real-time human-like exploration / fuzzing, and **not an AI free to decide
  outcomes**. The pass/fail oracle is **deterministic, scripted UI testing**: a
  script taps a known element by its accessibility id / test-tag and asserts a
  known next state (no `appium`/`idb` record-and-replay — see §2). Short-running
  AI is layered on top in two **bounded, advisory** roles only — a screenshot
  **judge** (D7 aesthetic / "does this look right") and a goal-directed
  **navigator / self-healer** — but the AI **never** decides whether a scenario
  passes. See "Harness model" (§2.1) for the precise split; letting AI freely
  decide outcomes would undermine determinism.
- Not load/perf testing, not the hardware-install / LUKS-unlock kernel path
  (that needs real metal — see `docs/cert-model-A-prime-migration.md` test list).
- **Not a security boundary, and never run against a real account.** The gym uses
  demo/operator-gated backends; destructive operations (account wipe, server
  decommission, service uninstall — D1) run on **DEMO entities only**. This is a
  hard guardrail, stated loudly in §7 and enforced by construction (§7-G).

---

## 2. How the gym drives the UI

Each surface has a native UI-automation framework that launches the built app
and drives it through the OS accessibility tree. The app "taps itself" via a
test script that finds elements by **stable accessibility id / test-tag** and
asserts the resulting screen state.

| Surface | Framework | How it drives | Element handle |
|---|---|---|---|
| **iOS / iPad** | **XCUITest** (`XCUIApplication`) | `xcodebuild test` on a Simulator (iPhone *and* iPad destinations); launches the app out-of-process and queries the a11y tree | `accessibilityIdentifier` |
| **Android** | **Compose UI Test + Espresso** on an emulator (instrumented `androidTest`) | `connectedDebugAndroidTest` launches the app on an AVD; `composeTestRule`/Espresso drive it | `Modifier.testTag(...)` / content-description |
| **webapp** | **Playwright** (chromium) | launches a headless browser at the webapp origin and drives the DOM | CSS / `id` / role+text (the webapp addresses by `id`, not `data-testid` — see §8) |

Properties the gym must have on every surface:
- **Element handles, not coordinates** — assert/tap by id, never pixel position
  (survives layout/theme changes; the iOS app already carries ~217 of these).
- **Failure + capture artifacts** — screenshot + video/trace on failure, uploaded
  as CI artifacts (Playwright `screenshot:"only-on-failure"` + `trace`/`video:"retain-on-failure"`
  is already configured; XCUITest emits an `.xcresult`; Compose/Espresso can dump
  a bitmap + view hierarchy). The total gym additionally captures a screenshot at
  every scenario step **on success too**, for the D7 aesthetic pass (§7-B).
- **Deterministic** — a fixed seed/fixture or a freshly-provisioned demo box, so
  a green run means green, not "the shared box happened to be in a good state".

**Honest constraints.**
- This is scripted, not exploratory. A scenario the script doesn't enumerate is
  not covered, full stop. Coverage = the total-gym matrix in §6, nothing more.
- `appium` and `idb` are **not installed** and are **not needed**: XCUITest is
  first-party (ships with Xcode) and talks to the Simulator directly; Compose UI
  Test + Espresso are first-party Android; Playwright is a self-contained npm dep.
  No extra device-bridge daemons.
- iOS UI tests require **macOS + Xcode + a Simulator runtime**. The iPad
  destination is the same framework, a second `-destination`. Android
  instrumentation requires **an emulator (AVD)** — heavier than the existing
  Robolectric JVM tests (see §3). The webapp needs only Node + a chromium
  download.
- **The heavy tiers run on the owner's Mac, not on hosted CI.** XCUITest needs
  macOS; the Android emulator needs nested-virt; the AI judge/navigator needs an
  API key + budget. All three live comfortably on this dev Mac (it already runs
  the XCTest + Robolectric suites and provisions Hetzner via the Worker), so the
  iOS/iPad/Android tiers + the total gym + every live-Hetzner run execute LOCALLY
  here. Only the cheap Tier-1 every-merge subset stays in GitHub-Linux CI (§7,
  §9). This is what makes the AI-in-the-loop harness practical: short AI calls
  run on the owner's machine on a nightly/monthly cadence, not per-PR on metered
  runners.

### 2.1. Harness model: deterministic gate + short-AI judge/navigator

> **owner-recommended, pending final confirm** — the owner is still deciding *how
> much* to let AI drive (see §11). This subsection states the model the gym is
> designed around. The principle is fixed even if the AI share is dialed up or
> down: **determinism is the source of truth; AI adds judgment and flexibility.**

The gym is an **agentic driver over a deterministic substrate**. Two layers,
deliberately separated so that AI variance can never change a verdict:

**Layer 1 — the deterministic gate (the source of truth, pass/fail).**
- **Scripted element-handle taps** — every action targets a stable handle
  (iOS/iPad `accessibilityIdentifier`, Android `Modifier.testTag` /
  content-description, webapp `id` / role+text), never a pixel coordinate (§8).
- **Expected-state assertions** — after each step the script asserts a known next
  state on the a11y tree / DOM (a screen is shown, a row exists, a button is
  enabled/disabled, a field holds a value), plus the D6 backend-effect assertion
  at Tier-2.
- **Diffable captured screenshots** — captured at every step (§7-B) and compared
  against a committed baseline / token-conformance sample where applicable.
- This layer is **reproducible**: a green run means green because the assertions
  passed, full stop. It is the only thing that gates anything.

**Layer 2 — short-running AI, two BOUNDED roles (a few short calls per scenario,
not a long agent; low-cost).**
- **(a) JUDGE — qualitative screenshot review (ADVISORY, not a gate).** A short
  vision call reviews the captured screenshots of a scenario for clarity,
  ergonomics, contrast/spacing/layout, and the subjective "is this beautiful /
  does this look right" question (the D7-beautiful pass — §6 D7). It emits a
  **findings list a human triages**. It explicitly does **not** produce a
  pass/fail verdict, and we **acknowledge run-to-run variance** in its output
  (the same screen may draw slightly different remarks across runs — that is fine
  for a review aid, fatal for a gate, which is exactly why it is not one).
- **(b) NAVIGATE / SELF-HEAL — goal-directed driving + churn recovery.** Each
  scenario carries a **deterministic goal** (the assertions of Layer 1). When the
  scripted path can't reach a handle because the UI shifted — a control was moved,
  renamed, or re-nested between builds — a short AI call reasons over the current
  a11y tree to drive toward the same goal and/or proposes the handle delta, so the
  suite stays robust to UI churn instead of failing on every cosmetic move. The
  **goal and the final assertion stay deterministic**; AI only finds the path to
  them. (A self-heal is surfaced as a warning + a suggested script patch, so drift
  is visible and the script is kept honest rather than silently papered over.)

**Why the split (stated plainly).** Letting the AI freely decide outcomes would
make the gym non-reproducible and untrustworthy as a gate — a flaky judge would
flip green/red on identical code. So: **determinism = the assertions (the
verdict); AI = judgment (D7 review) + flexibility (navigate/heal)**. The AI is
**never the pass/fail oracle.**

**Cost model.** Both AI roles are *short* calls, not a long agent loop: roughly
**one judge call per captured screen** (a handful per scenario) plus an
**occasional navigate/heal call** only when a handle misses. At a few short
multimodal calls per scenario this is **low $** even across the full total-gym
matrix; it runs on the owner's Mac under the owner's own provider key (the same
BYOK posture the build paths use), and the cheap every-merge gym (Layer 1 only,
no AI) carries zero AI cost. Note the judge cadence is itself tunable (per-step
vs per-scenario-summary) to trade coverage for spend.

We are **not** starting from zero. Per-surface reality, with file paths:

### iOS / iPad — a real XCUITest target already exists
- **Target:** `FlagshipAppUITests` (`bundle.ui-testing`) in
  `apps/mobile/ios/App/project.yml`, depends on `FlagshipApp`,
  `TEST_TARGET_NAME: FlagshipApp`. Run via
  `xcodebuild test -scheme FlagshipApp -destination 'platform=iOS Simulator,...'`.
- **Existing specs:** `apps/mobile/ios/App/UITests/OnboardingSmokeTests.swift`
  — two smoke tests (`test_coldLaunchReachesCreateServerMatch`,
  `test_qrRelayDriveToMatchCode`) that cold-launch and drive Welcome →
  ChooseUsername → CreateServer → the mock-relay match page.
- **Element handles:** **~217 `accessibilityIdentifier`** occurrences across the
  FlagshipUI tree (e.g. `cs-name-field`, `cs-continue-button`, `cs-demo-qr-button`,
  `sd-front-page-picker`, `sd-power-off`, `sd-journal-fetch`, `build-src-scratch`,
  `service-env-add-btn`, `global-operations-bar`). This is the single biggest head
  start — most screens are already addressable.
- **~51 screen files** under `apps/mobile/ios/Sources/FlagshipUI/Screens` +
  `Shell` (full inventory in §5).
- **iPad adaptive shell already exists** — `apps/mobile/ios/Sources/FlagshipUI/Shell/RootShell.swift`
  (lines ~146–163) has a 280pt sidebar + main-panel layout for the regular
  size class, a `.fsReadingColumn()` (~640pt) modifier applied across Home /
  Settings / Activity / build screens, and `@Environment(\.horizontalSizeClass)`
  branches that demote large titles to inline. **This is exactly the iPad
  surface D8 must assert** and it is already built — the gym adds an iPad
  destination, it does not build the layout.

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
   (`dev.useLiveClient ? liveClient : mockClient`, same for
   server/relay/mailbox/lockPower/frontPage). For a Tier-2 test, the launcher
   pre-seeds the toggle (a Release-config build, or a DEBUG launch-arg the app
   reads) so the live `ScreensClient` points at the demo box. Note: in the app
   the toggle is reached by 3-tapping the version row
   (`DeveloperSettings.unlocked`) — the gym sets it programmatically.

### webapp — a real Playwright gym already runs in CI
- **Location:** `apps/web/e2e/` — `playwright.config.ts` (chromium-only,
  `serviceWorkers:"block"`, `--ignore-certificate-errors`, PNA flags disabled),
  16 flow specs `flows/s00..s16.spec.ts`, fixtures `fixtures/identity.ts` +
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
- **~43 views** under `apps/web/public/webapp/views` + **~57 lib modules** under
  `apps/web/public/webapp/lib` (full inventory in §5).

### Android — partial; the instrumentation harness is net-new
- **What exists:** Compose UI tests, but as **Robolectric JVM unit tests** in
  `apps/mobile/android/app/src/test/...ui/screens/` —
  `HomeScreenComposeTest.kt`, `AddServerChooserComposeTest.kt`,
  `ProvidersComposeTest` — each renders **one composable** via
  `createComposeRule()` (`@RunWith(RobolectricTestRunner)`, `@Config(sdk=[33])`)
  and asserts with `onNodeWithText`/`assertIsDisplayed`. These run in the normal
  `:app:testDebugUnitTest` JVM suite (no emulator).
- **What is NOT there (the net-new work), confirmed this survey:**
  1. **No on-device/emulator instrumentation harness** — `build.gradle.kts`
     declares the `androidTestImplementation(...)` deps but there is **no
     `src/androidTest/` source dir** (verified: `app/src/` has only `main/` +
     `test/`), so nothing launches the full app (`MainActivity`) and drives it
     across screens on an AVD.
  2. **Almost no `testTag`s** — confirmed **12 occurrences across only 2 screens**
     (`HomeScreen.kt` = 7, `DemoInstallProgressScreen.kt` = 3). iOS has ~217;
     Android has ~0 for the rest of the ~45 screens under
     `apps/mobile/android/app/src/main/java/com/flagshipserver/app/ui/screens`.
     This test-tag sweep is the bulk of the Android effort.
- **Launch modes (already wired, mirror iOS):**
  `DeveloperSettings.useLiveClient` is a `StateFlow`; `MainActivity` picks
  `if (useLive && sessionToken != null) liveScreens else mockScreens`.
  `DemoFixtures.activate(...)` exists (`core/DemoFixtures.kt`). So the *app* can
  already run demo-vs-live; what's missing is the harness to launch and drive it
  (and a debug launch-intent that seeds `DemoFixtures` / the pref).

### Hetzner demo backend — already provisionable
- **Worker-side provisioning:** `apps/com/src/hetzner.ts` (pure-`fetch` Hetzner
  Cloud REST; the Worker creates a VPS with a cloud-init `user_data` script that
  `wget`s a personalized ISO from R2 and `dd`s it — no SSH). State machine +
  reaper in `packages/control-plane/src/demoUsers.ts` /
  `demoUsersAdmin*.ts`; Worker routes `/api/dev/sample-user/{create,delete,
  admin-claim-and-issue,…}` (`apps/com/src/controlPlaneRoutes.ts`).
- **Operator CLI:** `scripts/sample-user.mjs` — the only one (the laptop needs
  **only `FLAGSHIP_ADMIN_SECRET`**; the Worker holds `HCLOUD_TOKEN` and runs all
  Hetzner ops). Subcommands: `create <user> --account-name "<name>"`, `cleanup`,
  `list`, `status`. The account name is stored as an ENCRYPTED account profile —
  there is no plaintext display column, and `--display` is rejected.
- **Guardrails today:** `MAX_CONCURRENT_DEMO_VPS` cap (429 over budget); a
  `*/10` cron reaper destroys idle VPS and promotes `provisioning → up`. Demo
  vars + KEKs in `apps/com/wrangler.toml` (`DEMO_IRK_KEK` derives deterministic
  demo IRKs).

---

## 4. Architecture — two tiers (orthogonal to the two gyms)

The gym runs the **same scripts** in two backend postures. A tag/annotation on
each test selects its tier. **Tier ≠ gym:** the every-merge gym is *all Tier-1*;
the total gym is *Tier-1 breadth + a curated Tier-2 slice*.

> **Isolation is by zeroing, not secrecy (rev4).** The Tier-2 backend — the
> `gym.flagshipserver.com` / `gym.flagship.services` test env (§6.5) — has a
> **public, knowable domain**; that is fine. Isolation comes from the test env
> running against its **own D1/R2** and being **wiped clean between runs** with the
> existing wipe script (`scripts/wipe-all-users.sh` against the test D1), so there
> is no cross-run state and no real-user data anywhere in it. The username `gym`
> is banned in prod so the test apex can never collide with a real user's identity
> or zone (§6.5). Don't reach for secrecy as a control — zeroing the backend is
> the control.

### Tier 1 — demo-fixture mode (fast, $0 backend)
- **What it is:** the app launched against **seeded local state / a mock client**
  — no network, no Worker, no VPS.
- **How each surface enters it:**
  - iOS/iPad: `app.launchArguments = ["-smoke-mode", "-smoke-tab", "home"]` →
    `DemoFixtures.activate`. `useLiveClient` stays false → `mockClient`.
  - Android: launch `MainActivity` with the dev toggle off (default) →
    `mockScreens`; seed via `DemoFixtures.activate` (a debug-only launch
    intent/arg the harness sets — to be added).
  - webapp: the existing pattern — `pod-sim` fixture + `page.route` stubs for
    apex `/api/*`, SW blocked (`apps/web/e2e/fixtures/pod-sim.ts`).
- **What it validates:** every screen *renders* in each of its states; nav edges
  and back-stack; form validation; conditional UI (filters, empty states,
  greyed/gated buttons, the active-operations sliver, the trust sliver); copy;
  the **every-button sweep** (D7-usable) and **nav-graph** (D7-understandable);
  and — because fixtures can seed any state directly — the **D5 event-surfacing**
  scenarios (a server in each status, a near-expiry cert, an over-allowance
  banner). It does **not** prove the real wire contract (mocks can drift from
  live), so the D6 action→effect assertions are *simulated* at Tier-1 (the mock
  records that the action fired + flips its own state) and *real* only at Tier-2.
- **Cost/speed:** seconds per test; no infra; safe to gate every PR. This is the
  home of the **every-merge gym**.

### Tier 2 — live Hetzner demo server (true e2e, EPHEMERAL, nightly/on-demand)
- **What it is:** a real demo account on the live control plane + a real Hetzner
  VPS running the production daemon; the app in **live mode** drives the real
  flow end-to-end (real signed envelopes, real `/pods`, real daemon endpoints,
  real green-padlock pod URL).
- **Ephemeral by decision (rev3):** every Tier-2 run **creates a fresh demo
  server, tests against it, then deletes it** — there is no shared long-lived
  box. Teardown is guaranteed two ways: the run's own
  `scripts/sample-user.mjs delete <user>` in a `finally` (so a failed assertion
  still tears down), backstopped by the `*/10` Worker reaper that destroys any
  idle/orphaned demo VPS (`apps/com/wrangler.toml [triggers]` + the
  `demoUsers.ts` reaper). This RESOLVES the old §11 "fresh vs shared" question in
  favor of **fresh-per-run** — it also means the provision path itself is
  exercised every run, and there is no cross-run state to corrupt. (Shared-box is
  kept only as a noted fallback if Hetzner provisioning ever gets too slow for the
  cadence — see §11.)
- **How each surface enters it:**
  - iOS/iPad: a Release-config build (or DEBUG with the harness pre-seeding the
    `flagship.dev.useLiveClient` UserDefault) so `activeClient = liveClient`,
    pointed at the demo username.
  - Android: launch with `useLiveClient = true` + a stored session token (the
    harness seeds the pref) → `liveScreens`/`liveBuild`.
  - webapp: point `WEBAPP_BASE_URL`/`APEX_BASE_URL` at `webapp.flagshipserver.com`
    / `flagshipserver.com` (the config already supports this) and run against
    the live demo account instead of the pod-sim.
- **What it validates:** the contract the mocks only approximate — the real
  identity calls, the create-server → provision → online ladder, install a
  service against the live daemon, approve-unlock, front-page, journal, etc. This
  is where D6 action→effect is asserted **for real** (the apex actually 302s, the
  box actually powers off, the container actually runs) and where the **D5
  test-control hooks** (§7-A) force the live box/account into each event state.
- **Cost/speed:** minutes (VPS boot ~1–3 min + flow time + teardown); consumes
  Hetzner € and an admin-secret-gated provision. Because the box is destroyed at
  the end of each run, **cost stays ~cents per run** (a CX-class VPS billed by the
  hour, alive for minutes). Runs on the owner's Mac on a **nightly / monthly /
  on-demand** cadence, not per PR. This is the home of the total gym's **vertical
  slice + live-contract** scenarios.

**Rule of thumb:** Tier 1 answers "does the UI work, and does it show the right
thing for a given state?"; Tier 2 answers "does the UI talk to a real box
correctly, and does the action have the real effect?". The every-merge gym is
Tier-1-only; the total gym uses both.

---

## 5. Surveyed UI inventory (what the total gym must span)

Surveyed from the real screen graphs this session. Cite-by-path; nothing invented.

### iOS / iPad — ~51 screens (`apps/mobile/ios/Sources/FlagshipUI/Screens` + `Shell`)
- **Onboarding/account:** `WelcomeScreen`, `ChooseUsernameScreen`,
  `SecureAccountScreen`, `OpenAccountScreen`.
- **Recovery/auth:** `RecoveryScreen`, `PostRecoveryScreen`,
  `PostRecoveryChoiceScreen` (keep-both / replace-lost / wipe-restart),
  `JoinAccountScreen`, `JoinUsernameScreen`, `RealAccountLoginScreen`,
  `KeyfileImportSheet`, `KeyfileExportScreen`.
- **Home/servers:** `HomeScreen`, `AddServerChooserScreen`, `PendingServerScreen`,
  `CreateServerStubScreen`, `DemoInstallProgressScreen`, `ProvisionTimelineView`.
- **Server-detail + cards (all in `ServerDetailScreen.swift` unless noted):**
  `ServerDetailScreen`, `BootUnlockCard`, `BootUnlockApprovalCard`,
  `DecommissionDeadServerCard`, `DangerZoneCard` + `RevokeServerSheet`,
  `FrontPageCard` (`FrontPageViews.swift`), `LockPowerCard` (`LockPowerViews.swift`),
  `JournalCard` + `DeadManCard` (`JournalViews.swift`), `MetricsSection`.
- **Services:** `ServicesTab` (Shell), `ServiceDetailScreen` (where-it-runs pod
  toggles + leader radio), `ServiceEnvScreen`, `ReplaceServiceStemSheet`.
- **Build-a-service:** `BuildSourceChooserScreen` + `BuildGitScreen` +
  `BuildMcpScreen` + `BuildJournalScreen` (`BuildModesScreens.swift`),
  `VibeCodeProviderPickScreen` + `VibeCodeDescribeScreen` (`VibeCodeScreens.swift`),
  `VibeCodeChatScreen`, `BuildKeyScreen`, `AiKeysScreen`.
- **Settings:** `SettingsScreen`, `AccountSecurityScreen`, `ProfilesScreen`,
  plus the AI-keys + privacy/appearance rows.
- **Device mgmt:** `AddDeviceScreen` (QR + SAS, screenshot-protected),
  `PairingSafeguards`, `ReplaceDeviceFinalizeScreen` (grace countdown + Complete),
  `JoinAccountScreen`/`JoinUsernameScreen` (incoming side).
- **Activity/audit:** `ActivityScreen`, `AuditLogScreen`, `ApproveUnlockScreen`.
- **Companion/peer:** `CompanionDockScreen`, `CompanionRequestsScreen`,
  `PeerBackupScreen`, `BrowserViewerScreen`, `BrowserTabsScreen`.
- **Invite/collab:** `InviteIssueScreen`, `InviteManageScreen`.
- **Utility:** `QRScanner`, `DeveloperScreen`.
- **Shell + global chrome:** `RootShell` (iPhone TabView / iPad sidebar),
  `HomeTab`/`ServicesTab`/`ActivityTab`/`SettingsTab`, `BiometricLockScreen`,
  `GlobalOperationsBar` + `GlobalTrustBar` + `Toaster` + `PodSwitcher`
  (`FlagshipUI/Components`).
- **App-scope centers** (`apps/mobile/shared/Sources/FlagshipCore`):
  `ActiveOperationsCenter` (deploy/build sliver source), `ToastCenter`,
  `TrustCenter` (verdict + override → red sliver), `DeepLinker` (push/URL → nav),
  plus the **iOS-only Watch delegate** (`WatchDelegateKey.swift`,
  `WatchApproval.swift`, `WatchProvisionTimeline.swift`, `WatchSecurityAlertsBridge.swift`
  + the `App/WatchApp/` target) — D8 surface-specific.

### Android — ~45 screens (`.../app/src/main/java/com/flagshipserver/app/ui/screens`)
Mirrors iOS cluster-for-cluster: `WelcomeScreen`, `ChooseUsernameScreen`,
`BiometricSetupScreen`, `SecureAccountScreen`, `OpenAccountScreen`;
`RecoveryScreen`, `PostRecoveryScreen`, `PostRecoveryChoiceScreen`,
`KeyfileExport/ImportScreen`; `HomeScreen`, `ServerDetailScreen`,
`PendingServerScreen`, `InstallProgressScreen`; `ServicesListScreen`,
`ServiceDetailScreen`, `ServiceEnvScreen`; `BuildModeScreens.kt`
(`BuildSourceChooser`/`BuildGit`/`BuildMcp`/`BuildJournal`), `VibeCodeScreens.kt`
(`ProviderPick`/`Describe`/`Generating`), `VibeCodeChatScreen`, `AiKeyScreens.kt`
(`AiKeyStep` + `AiKeysManager`); `SettingsScreen`, `AccountSecurityScreen`,
`ProvidersScreen`, `PairedSessionsScreen`, `PrivacyScreen`, `DeveloperScreen`;
`AddDeviceScreen` + `JoinDeviceScreen` + `AddControlDeviceScreen` (SAS),
`ReplaceDeviceFinalizeScreen`; `ActivityScreen`, `SecretRequestsScreen`,
`AuditLogScreen`; `CompanionDockScreen`, `CompanionRequestsScreen`,
`PeerBackupScreen`, `TrustedDevicesScreen`, `ProfilesScreen`,
`InviteIssue/ManageScreen`, `BrowserTabs/ViewerScreen`, `QRScanner`,
`DemoInstallProgressScreen`. Shell: `ui/shell/RootShell.kt` (bottom-bar compact /
nav-rail expanded), `tabs/{Home,Services,Activity,Settings}Tab.kt`,
`BiometricLockScreen.kt`; components `GlobalOperationsBar.kt` (above RootShell in a
Column), `GlobalTrustBar.kt`, `Toaster.kt`, `SecureWindow.kt` (FLAG_SECURE),
`PodStatusStyle.kt`. Centers (`core/`): `ActiveOperationsCenter`, `ToastCenter`,
`DeepLink`, `AiKeyStore` (EncryptedSharedPreferences), `DeveloperSettings`,
`TrustCenter`. **No Wear app** (Watch delegate is iOS-only) — D8 difference.

### webapp — ~43 views (`apps/web/public/webapp/views`) + ~57 lib modules
- **Onboarding:** `bootstrap.js`, `wizard.js` (7-step), `join.js`.
- **Auth/recovery:** `unlock.js`, `pinLock.js` (**webapp-only PIN**, no biometric),
  `recovery.js`, `post-recovery.js`.
- **Home/servers:** `home.js`, `server-detail.js` (leases / auto-unlock /
  dead-man / power+lock / revoke), `pending-server.js`.
- **Pairing/device:** `pair.js`, `pod-pair.js`, `create-server.js`,
  `trusted-devices.js`, `add-device.js` (QR + SAS).
- **Services:** `services-list.js`, `service-detail.js`, `service-env.js`.
- **Build-a-service:** `build-source.js`, `vibe-code.js`, `vibecode-chat.js`,
  `build-git.js`, `build-mcp.js`, `build-key.js`, `build-journal.js`.
- **Activity:** `activity.js`, `boot-approval.js`, `account-audit.js`,
  `install-progress.js`, `browser-viewer.js`.
- **Settings/security:** `settings.js`, `account-security.js`, `paired-sessions.js`.
- **Multi-device/peer:** `peer-backup.js`, `companion-dock.js`,
  `companion-requests.js`, `profiles.js`, `invite-issue.js`, `invite-manage.js`.
- **Debug:** `orders-debug.js`, `url-controller.js`.
- **Key lib chrome (matching D4/D5/D6):** `activeOperations.js` +
  `operationsBar.js` (teal sliver), `trustSliver.js` + `trustOverride.js` +
  `serverTrust.js` + `maintainerTrust.js` (red trust sliver + override),
  `pinLock.js`, `lockAndPower.js`, `frontPage.js`, `journal.js`, `leases.js`,
  `sessionTiers.js`, `recovery.js` + `keyfile*.js`, `crossDevicePairing.js` +
  `replaceDeviceCeremony.js` + `pendingRePairBanner.js`, `totp.js`,
  `revokeServer.js` + `releaseServer.js` + `wipeRestartCeremony.js`, `push.js`,
  `humanError.js`, `auditLog.js`, `providers.js` (AI keys, UMK-wrapped IndexedDB).
- **Surface notes:** bottom tab bar (4 tabs: Home / Services / Activity /
  Settings), tap-only; **no marketplace view on main** (the feature is on
  `feat/marketplace` — branch-is-the-gate); elements addressed by `id`, no
  `data-testid` convention.

### Backend events + action endpoints (the D5/D6 source of truth)
- **`/pods` inventory** — `GET /api/users/:u/pods`,
  `packages/control-plane/src/podInventory.ts`. The central server-status surface:
  per pod `{ serverDomain, identityPubKey, registeredAt, revokedAt, routingTarget,
  lastReported, currentCert:{sha256,validUntil,issuer}, signedStatus:{report,signatureHex},
  appsServed[], awaitingUnlock, state:"online" }`; per pending order
  `{ orderRef, serverName, fqdn, phase, createdAt, state:"pending" }`.
- **Liveness/heartbeat** — `POST /api/daemon-status` (STK-signed, 5-minutely,
  `podInventory.ts`); the liveness bridge falls back to the latest auth-code's
  `provision_status.phase` when no `daemon_status` row exists.
- **Certificate events** — pin verification via `verifyDaemonStatusReport`
  (`packages/protocol/src/daemonStatus.ts`); CT rogue-cert scan
  (`packages/control-plane/src/ctMonitor.ts`, cron → audit `ct-unexpected-cert` +
  owner push); CA-lease expiry (`caLeaseWarning.ts`, `GET /api/admin/ca-lease-status`);
  renewal reflected in `currentCert` via the heartbeat.
- **Usage/metering — present on `main`** (`packages/control-plane/src/metering.ts`):
  `POST /api/usage/report` + `GET /api/usage/status?username=` (relay-secret
  gated) returning `{ tier, period, usedBytes, quotaBytes, remainingBytes,
  overQuota, admit, overageUsd }`. NOTE the distinction: the *metering backend*
  is on main; the *tier-status dashboard UI* (`TierStatus*`) was extracted to
  `feat/marketplace` — so the D5 "usage" front-end scenarios are **branch-gated**
  (assert them on `feat/marketplace`), while the backend signal exists on main.
- **Owner-action endpoints (daemon, IRK-signed PhoneOrder over the box's own
  pinned pipe unless noted):** `POST /api/front-page` (`frontPage.ts`) →
  apex 302; `POST /api/power` (`deadManHttp.ts`) → poweroff/reboot;
  `POST /api/deadman/policy` + `POST /api/deadman/affirm` (`deadManHttp.ts`);
  `POST /api/journal` (`journalHttp.ts`, unit-allowlisted); service
  install/uninstall/restart (`httpApi.ts` `/apps*`, paired-session gated) +
  env set/unset (`screens/screensHttp.ts`); build modes
  (`buildmodes/buildModesHttp.ts` `/api/build/{git,mcp,sessions/:id/adapt,deploy}`)
  + vibe-code (`llm/vibeCodeHttp.ts` `/api/llm/sessions*`). **Control-plane
  actions:** server revoke (`serverRevoke.ts` / `serverRevocation.ts`), release,
  boot-unlock approve via the secret-mailbox (`secretMailbox.ts`).

---

## 6. The total gym — coverage by dimension

The total gym is organized by the owner's seven points (D1–D8). Each dimension is
a **cluster of scenarios**; the full matrix is *cluster × {iOS, iPad, Android,
webapp}* (D8). For each scenario the total gym asserts on-screen state **and**
(where applicable) the D6 action→effect and the D5 event-surfacing. The §6.9
table folds the original 28-row matrix in as a labelled seed subset.

> **Coverage tally:** ~70 total-gym coverage items below (D1: 13, D2: 11, D3: 17,
> D4: 9, D5: 13 events, D6: ~12 action→effect pairs, D7: 3 quality sweeps, D8:
> the surface multiplier). Each runs on up to four surfaces.

### D1 — Entity lifecycle (create / control / **delete**) — 13 items
> **GUARDRAIL (loud):** every *delete/wipe/decommission/uninstall* item runs on a
> **DEMO entity only** — a demo account, a demo server, a demo-installed service.
> The harness fail-closes if the target username is not demo-classified (§7-G). A
> real account is **never** the target of a destructive scenario.

**Accounts:**
- A1 **Create account** — Welcome → choose username → secure (biometric/passphrase)
  → open account → lands on empty-home. (iOS `WelcomeScreen`→`OpenAccountScreen`;
  Android same; webapp `bootstrap.js`→`wizard.js`.) *Existing seed:* iOS smoke,
  web s01.
- A2 **Control account** — Settings reachable; profile/identity edits persist;
  appearance (auto/light/dark) applies. (D3 overlaps.)
- A3 **Delete / wipe account** (DEMO) — Settings → "Remove this device from
  account" / wipe-restart ceremony → local key + data erased, returns to Welcome.
  (iOS tier-3 button + `wipeRestart`; webapp `wipeRestartCeremony.js`.) **D6:** the
  control-plane wipe-restart row is created (Tier-2, demo account).

**Servers:**
- A4 **Create server** — name + disk-encryption toggle + backup-policy → recipe/QR
  → SAS match. (iOS `AddServerChooserScreen`→`PendingServerScreen`; webapp
  `create-server.js`→`pair.js`.) *Seed:* iOS smoke, web s02.
- A5 **Provision → online ladder** — install-progress phase timeline advances;
  pod upserts to Home; pending→online flip. (iOS `ProvisionTimelineView`/
  `DemoInstallProgressScreen`; Android `InstallProgressScreen`; webapp
  `install-progress.js`.) **D5:** rides `pending[].phase` from `/pods`.
- A6 **Control: front page** — set/clear the apex front-page service (D6-pair below).
- A7 **Control: lock & power-off / restart** — confirm + biometric → power order
  (D6-pair below).
- A8 **Control: dead-man** — opt-in toggle + window/grace + "tighten now"; affirm
  resets the lease (D6-pair below).
- A9 **Control: journal** — Diagnostics → View journal → trailing lines render
  (D6-pair below).
- A10 **Decommission a never-online server** (DEMO) — `DecommissionDeadServerCard`
  → frees the name. **D6:** server gone from `/pods`, name re-claimable.
- A11 **Revoke a server** (DEMO) — `DangerZoneCard` → `RevokeServerSheet`
  hold-to-confirm → revoked. **D6:** `revokedAt` set, gone from active `/pods`.

**Services:**
- A12 **Install / configure / control a service** — install (any D2 mode) →
  service appears → env editor Save → where-it-runs pod toggles / leader radio.
  (iOS `ServiceDetailScreen`+`ServiceEnvScreen`; webapp `service-detail.js`+
  `service-env.js`.) **D6:** container runs, env injected, leader routing changes.
- A13 **Uninstall a service** (DEMO) — service-detail Remove/Uninstall → gone.
  **D6:** container stopped, data deprovisioned, vanished from the services list.

### D2 — Service-creation modes IN DETAIL — 11 items
The build chooser fans to five sources, all converging on one deploy primitive +
one build journal (`docs/build-modes.md`). Per surface.
- B1 **Chooser** — `BuildSourceChooserScreen` / `build-source.js` shows scratch /
  git / mcp / (marketplace, branch-gated) / journal; each tile routes correctly.
- B2 **Scratch — provider/AI-key step** — `VibeCodeProviderPickScreen` /
  `BuildKeyScreen`: recall a device-saved key as a masked slug
  (`provider · label · ····1234`), pre-select active (Confirm), "save on device".
- B3 **Scratch — vibe-code chat** — `VibeCodeChatScreen` / `vibe-code.js`:
  multi-turn message list, composer, deploy. **Edge:** `200 {needsCredential:true}`
  → "add an AI key"; `talkToUser`/`requestEnvVar` tool turns surface.
- B4 **Scratch — multimodal attachment** — image/text attach picker, removable
  chips, caps (≤6/turn, image ≤4 MB, text ≤256 KB). **Surface diff (D8):** webapp
  has the picker; mobile scratch picker is a deferred nice-to-have — assert the
  text path on mobile, the attachment path on webapp.
- B5 **Git — clone + fitness verdict** — `BuildGitScreen` / `build-git.js`: paste
  URL → Flagship-fitness verdict (fit / needs-adapt).
- B6 **Git — install-as-is** (fit path) → deploy.
- B7 **Git — AI-adapt** (non-fit) — adapt with AI-key step; **edge:** `503 "AI
  adapt not configured"` → fall back to from-scratch.
- B8 **MCP — IDE connect** — `BuildMcpScreen` / `build-mcp.js`: copyable bearer
  key + IDE config + rotate.
- B9 **MCP — value-free env-requests** — the IDE's `request_env_var` list shows
  `name/why?/secret?/currentlySet` with the "the IDE never sees the value" note;
  **assert no value is ever displayed** (security-relevant).
- B10 **Journal — resume a prior build** — `BuildJournalScreen` / `build-journal.js`:
  list past sessions → open timeline → resume/deploy.
- B11 **Marketplace** *(feat/marketplace only)* — browse + scan-grade badge +
  IRK-signed install. Scripts ship on the branch (branch-is-the-gate); on `main`
  the tile is absent. **D6 (branch):** install → container runs.

### D3 — Settings → account control + EDGE CASES — 17 items
- C1 **Session tiers** — tier-1 lock-with-biometrics (iOS/Android) / lock-with-PIN
  (webapp); tier-2 lock-with-passkey; tier-3 remove-device. **Grey-out gating:**
  tiers 2+3 greyed-but-tappable until recovery enrolled; tap-while-greyed shows a
  toast, does **not** run the destructive path. (iOS `SettingsScreen` + `FSDangerButton`
  muted; webapp `sessionTiers.js`.)
- C2 **AI-keys manager** — `AiKeysScreen` / `ProvidersScreen` / `providers.js`:
  view-slug / add / delete / make-default; never displays the full key.
- C3 **Account-security: TOTP enroll** — `AccountSecurityScreen` / `account-security.js`:
  QR + code entry + verify. **Edge:** wrong code rejected. *Seed:* web s08.
- C4 **Account-security: recovery enroll** — passkey/WebAuthn-PRF + recovery codes.
  *Seed:* web s08/s09.
- C5 **Account-security: account-type badge** — single-device vs multi-device shown.

**Edge case — multi-device:**
- C6 **Add a device via SAS** — admin side `AddDeviceScreen` mints QR + shows SAS;
  incoming side `JoinAccountScreen`/`JoinDeviceScreen` scans + confirms SAS +
  receives sealed bundle. (Screenshot-protected on mobile; webapp
  `crossDevicePairing.js` + `add-device.js`.) **Recent fix to assert:** the
  SAS-confirm button is gated against a double-tap (webapp+Android, commit
  `bc6a004e`).
- C7 **Device list / per-device control** — `TrustedDevicesScreen` /
  `trusted-devices.js`: list peer devices, per-row actions.
- C8 **Revoke / quarantine a device** — remove a device from the account.
- C9 **Per-device capability scoping** — a restricted (browse-only) device shows
  the capability chip and **disables** scope-gated actions (assert the buttons are
  actually disabled, D7-usable overlap).

**Edge case — lost device / recovery:**
- C10 **Recover via passkey** — `RecoveryScreen` / `recovery.js` restore branch:
  WebAuthn-PRF unwrap → reattach. *Seed:* web s08, s09 (cross-browser).
- C11 **Recover via keyfile** — `KeyfileImportSheet`/`KeyfileImportScreen` /
  `keyfile*.js`: import wrapped UMK. *Seed:* web s10 (manual export).
- C12 **Single-device re-pair with grace** — brand-new IRK, grace countdown, T+0/
  +1d/+3d alerts; second-factor (TOTP/recovery-code) when enrolled.
- C13 **Multi-device re-pair** — old-key veto path.
- C14 **Replace-device finalize** — `ReplaceDeviceFinalizeScreen`: grace countdown
  gates Complete; completed/failed states.
- C15 **Pending re-pair banner** — `pendingRePairBanner.js` / the iOS/Android
  equivalent surfaces the completion deadline.
- C16 **Wipe-restart** — the destructive reset (DEMO; overlaps A3). *Seed:* web s11.
- C17 **Recovery files: keyfile export** — `KeyfileExportScreen` / `keyfile.js`:
  export the wrapped UMK; round-trips with C11.

### D4 — Global security experience — 9 items
- E1 **Screen lock** — `BiometricLockScreen` traps the shell when locked; re-locks
  on background (iOS scene-phase, Android `onStop`). Webapp PIN lock equivalent.
- E2 **Biometric gate on a signed action** — any IRK-signed action (power, revoke,
  env-set, front-page) prompts the gate before firing. (Mock biometric at Tier-1;
  see §7 — real biometric can't run unattended.)
- E3 **Webapp PIN lock** *(webapp-only, D8)* — set / change / unlock / 5-try
  lockout → wipe-PIN → passphrase fallback; any passphrase unlock clears the PIN.
  *Seed:* unit `webappPinLock`; the gym drives the live screens
  (`view-pin-set`/`view-pin-unlock`).
- E4 **Recovery files** — overlaps C11/C17; the *security* framing: a stolen
  keyfile is useless without the passphrase.
- E5 **Takeover grace / objection window** — the re-pair grace + the old key's
  objection (overlaps C12/C13); assert the alert timeline + objection control.
- E6 **Second-factor on takeover** — TOTP / recovery-code prompt on the re-pair
  initiate when enrolled.
- E7 **Maintainer-trust enforcement — red sliver** — inject an untrusted verdict
  (`TrustCenter.markUntrusted` / `serverTrust.js`) → the persistent red
  `GlobalTrustBar` / `trustSliver` shows one line per failure, non-dismissible.
- E8 **Trust override** — tap the sliver → biometric/PIN-gated `TrustException`
  (`TrustOverrideViewModel` / `trustOverride.js`) → traffic un-halts but the
  sliver **persists** (degraded state stays visible).
- E9 **Trust verdict transitions** — unknown → trusted → untrusted → override; the
  failure lines persist post-override. (Cross-platform vectors already pinned —
  `MaintainerTrustVector*` on all three.)

### D5 — Server-event → FRONT-END propagation — 13 events
For each: the backend event, where it surfaces per surface, and the **induction
mechanism** (how a test forces it). Tier-1 = a fixture seeds the state directly;
Tier-2 = a **test-control hook** forces the live demo box/account into the state.
Hooks flagged "BUILD" are prerequisites (collected in §7-A).

| # | Backend event | Surfaces it appears on | Where | Tier-1 induction | Tier-2 induction |
|---|---|---|---|---|---|
| F1 | **Awaiting-unlock** | iOS·iPad·And·Web | `awaitingUnlock` on `/pods` → "waiting for approval" card; delete suppressed | fixture sets `awaitingUnlock:true` | real box reboots into approve-mode (the §6.D1-A8 lock path or a boot-lock marker) |
| F2 | **Coming-online** | all | pending→online flip; install ladder | fixture phase sequence | real provision ladder (the A5 vertical slice) |
| F3 | **Dead / offline** | all | status classifier → "offline"; decommission offered | fixture: stale `lastReported`, no daemon-status | **BUILD: hook to stop the demo daemon / age `lastReported`** |
| F4 | **Server usage / allowance** *(branch-gated UI)* | all (on `feat/marketplace`) | usage dashboard counters + over-allowance upgrade alert | fixture seeds `usedBytes/quotaBytes/overQuota` | **BUILD: hook to bump the demo account's `metering` counter** (the `metering.ts` usage row) |
| F5 | **Cert-pin mismatch** | iOS·iPad·And (webapp can't pin) | hard-fail security alert ("someone may be intercepting") | fixture injects a non-verifying `signedStatus` | **BUILD: hook to serve a mismatched cert SHA in daemon-status** |
| F6 | **CT-monitor rogue-cert** | all | account-security alert (push deep-link) from `ctMonitor` | fixture seeds a `ct-unexpected-cert` audit event | **BUILD: seed a CT alert row for the demo user** |
| F7 | **Cert renewal** | all | `currentCert.validUntil` advances on server-detail | fixture sets `validUntil` | real ACME renew (slow; or hook) |
| F8 | **Cert near-expiry** | all | server-detail cert-expiry notice | fixture: `validUntil` ~days out | **BUILD: hook to force a near-expiry cert on the demo box** |
| F9 | **CA-lease expiry** | (operator/admin) | `/api/admin/ca-lease-status` warn/expired | fixture status | seed lease notAfter near threshold |
| F10 | **Daemon-status liveness heartbeat** | all | `lastReported` freshness drives the status pill | fixture `lastReported` | real 5-minutely heartbeat |
| F11 | **Active operation — deploy** | all | teal sliver "deploying server X", deep-link | fixture pending pod | real provision (derived from `/pods` pending) |
| F12 | **Active operation — build** | all | teal sliver "building X on Y" | fixture build registration | real build session (`/api/build/*`) |
| F13 | **Install-progress milestones** | all | phase ladder + push milestone | fixture phase steps | real `provision_status` posts |

> **Induction posture:** Tier-1 covers all 13 by seeding fixture state — this is
> cheap and belongs in broad coverage. Tier-2 proves the *live* propagation for
> the ones that matter, and needs **6 new test-control hooks** (F3, F4, F5, F6,
> F8, plus the generic "set demo account/box state" admin verb). Those hooks are
> the main D5 prerequisite (§7-A) and are an owner decision (§10).

### D6 — UI-action → EFFECT — ~12 high-value pairs
For each actionable control, assert BOTH the real backend change AND the UI
update. At Tier-1 the mock records the action + flips its state (UI assertion
only); at Tier-2 the effect is **real**.

| # | Action (UI) | Backend effect (assert) | UI effect (assert) | Endpoint |
|---|---|---|---|---|
| G1 | Set front page | apex `GET /` 302s to `<label>.<fqdn>` | picker reflects label | `POST /api/front-page` |
| G2 | Clear front page | apex serves default card | picker cleared | `POST /api/front-page` (label "") |
| G3 | Lock & power-off | box powers off; auto-unlock suppressed | status flips offline | `POST /api/power` mode=off |
| G4 | Lock & restart | box reboots | status flips then returns | `POST /api/power` mode=restart |
| G5 | Dead-man affirm | lease expiry extended | countdown resets | `POST /api/deadman/affirm` |
| G6 | Set dead-man policy | policy persisted | toggle/window reflect | `POST /api/deadman/policy` |
| G7 | View journal | journalctl runs (allowlisted unit) | lines render | `POST /api/journal` |
| G8 | Install service | container runs, env injected | service appears in list | `POST /apps` |
| G9 | Set service env | env sealed + injected | KV row reflects | `POST /api/screens/services/:id/env/set` |
| G10 | Uninstall service | container stopped, data deprovisioned | gone from list | `DELETE /apps/:id` |
| G11 | Revoke / decommission server | gone from `/pods` (revokedAt/freed) | gone from Home | `serverRevoke` / decommission |
| G12 | Approve boot-unlock | sealed lease deposited; box unlocks | request clears; box comes online | `secretMailbox` response |

### D7 — UI QUALITY (be explicit about automatable-vs-review) — 3 sweeps
- **D7-usable (AUTOMATABLE).** An "every interactive control" sweep: enumerate
  every button/row on each rendered screen, assert each is **reachable**, carries
  an **a11y id / test-tag** (so it is even addressable), and that **firing it
  triggers its action** (navigates, opens a sheet, fires a request, or shows a
  toast — *no dead controls*). This is a real pass/fail gate. **Prerequisite:**
  the Android test-tag sweep (§3) — today most Android controls aren't addressable,
  so this sweep can't run on Android until tags land.
- **D7-understandable (MOSTLY AUTOMATABLE).** Three parts:
  1. **Nav-graph assertions** — no orphan screens, no dead-end pushes, no
     unreachable routes; every route in the tab NavHosts / the webapp router map is
     reachable and every push has a working back edge. Pass/fail.
  2. **Copy lints** — reuse the existing checks: `apps/web/tests/humanError.test.ts`
     + `humanError.js`, `apps/web/tests/uxCopyFindings.test.ts`, and the iOS
     `HumanErrorTests.swift` / `FlagshipUI/HumanError.swift`. Extend them to flag
     raw `HTTP <code>` strings, jargon, and over-verbose copy on the captured
     screens. Mostly pass/fail (the "too verbose" heuristic is fuzzy).
  3. **Vision review of captured copy** — the agent reads the screenshots and
     flags confusing/verbose labels (review aid, not a gate).
- **D7-beautiful (SEMI-AUTOMATED — a review aid, NOT a binary gate).** Three
  parts, and we state plainly that **aesthetic quality is partly subjective**:
  1. **Per-scenario screenshot capture** on every surface (§7-B) — iPhone, iPad,
     Android, webapp (and webapp at mobile + desktop widths).
  2. **Vision-based review pass** — the agent reads the screenshots and flags
     ergonomics / color / spacing / layout / contrast issues. Produces a written
     findings list, **not** a pass/fail verdict.
  3. **Design-system / token conformance** — assert the rendered palette against
     `docs/design-system.md` (§2 Color, §3 Typography, §7 Voice/tone, §12 "Done
     means") and the tokens: webapp `apps/web/public/tokens.css` (the brand teal
     `--teal:#14B8A6` / `--teal-bright:#2DD4BF`, dark canvas), iOS `FSColors`,
     Android theme. The **token-conformance** part is pass/fail (sampled pixels /
     computed styles must match the palette; no stray legacy blue `#3B5BFF`); the
     **ergonomic** part is the review aid. The existing brand specs (web s14
     marketing-surface, s15 webapp-shell) already assert palette/fonts — extend
     that idea to every captured screen.

> **Honest split for D7:** *usable* and *understandable-nav* are true automated
> gates; *copy lints* and *token conformance* are automated gates with one fuzzy
> heuristic each; the *aesthetic/ergonomic* pass is a **structured review, not a
> gate** — it produces findings a human triages. Do not overclaim "the gym proves
> the UI is beautiful"; it proves the UI conforms to the design system and
> surfaces candidate aesthetic issues for review.

### D8 — EVERY SURFACE — the matrix multiplier
Every D1–D7 cluster runs on *{iOS, iPad, Android, webapp}*. Surface-specific
assertions the gym must make (don't assume parity):
- **iPad** — the sidebar (not TabView), the ~640pt `.fsReadingColumn()`, inline
  (not large) titles, landscape. Run a dedicated iPad `-destination`; assert the
  sidebar layout renders and the reading column constrains width. (Already built —
  `RootShell.swift`; the gym adds the destination.)
- **webapp** — **PIN lock vs mobile biometric** (E3 is webapp-only); the apex /
  marketing surface; the bottom tab bar at ≤768px vs top-strip ≥769px; **cannot
  cert-pin** (F5 is iOS/iPad/Android only — webapp relies on CAA+CT).
- **mobile** — biometric lock + signed-action gates (mocked in CI); the scratch
  attachment picker is webapp-only today (B4).
- **iOS-only** — the **Apple Watch delegate** (boot-approval from the Watch) and
  the Watch complication/timeline. Validate on a real watch (manual-only — the
  Simulator watch pairing is unreliable in CI).
- **Android-only** — `SecureWindow`/FLAG_SECURE on the pairing screens; the
  nav-rail in the expanded size class (foldable/tablet).

### §6.9 — The original 28-row matrix, folded in as a seed subset
The earlier scenario matrix is the **seed** of the total gym (and most of the
every-merge subset). It maps onto the dimensions as: rows 1–7 → A1/A4/A5/G12 +
C1–C4 (onboarding, create-server, install-progress, approve-unlock, secure-account,
recovery); rows 8–13 → A6–A13 + G1/G3/G7/G9 (home/filters, front-page, lock-power,
dead-man, journal, services/env); rows 14–16 → B1–B11 (build modes, AI-key,
marketplace); rows 17–22 → C1/C2/C3/C6/C12/C14/E6 (session tiers, AI-keys,
account-security, add-device SAS, re-pair, replace-finalize, second-factor); rows
23–24 → F11/F12 + E7–E9 (ops sliver, trust sliver); rows 25–28 → share, E3 PIN,
PodSwitcher, peer-backup/companion. **The total gym is broader than these 28:** it
*adds* the lifecycle-deletes (A3/A10/A11/A13), the D6 action→effect *backend*
assertions (G1–G12), the D5 server-event *inductions* (F1–F13), the D7 every-button
+ nav + aesthetic sweeps, and the **iPad** surface. Existing automated coverage
today: iOS smoke (2) + the 16 webapp Playwright specs + Android Robolectric
single-composable tests — everything else in the matrix is new.

---

## 6.5. Backend posture over time — pre-GA admin-induction vs post-GA test-env

The total gym needs to put the **live backend** into each D5 server-side state
(force a box dead, bump usage past allowance, age a cert toward expiry, seed a CT
rogue-cert alert, …) without mocks and without touching real users. The owner's
decision splits this cleanly across the launch boundary.

### Pre-GA — induce state via THIS box's admin access (no new prod hooks)
Before GA there are no real users to protect from, and this Mac already holds
**`FLAGSHIP_ADMIN_SECRET`** (the same secret `scripts/sample-user.mjs` and
`scripts/wipe-demo-users.mjs` use; `apps/com/src/controlPlaneRoutes.ts` gates the
`/api/dev/sample-user/*` admin surface on it) plus the full demo/Hetzner control
surface. So **pre-GA the gym induces D5 states by using that admin access against
the DEMO account / DEMO box DIRECTLY** — e.g. delete/stop the demo VPS or age its
last-report to force "dead/offline" (F3), drive the demo account's `metering` row
to force over-allowance (F4), and so on — operating on demo-classified entities
only (the §7-G guardrail still applies). **No new production endpoints are needed
pre-GA**: the clean per-event "test-control hooks" (the §7-A wishlist) are
explicitly **deferred to the post-GA test-env below**, not added to prod. (Where
a state can't be reached with today's admin verbs, the pre-GA path is a thin
admin-secret-gated helper that runs on the owner's Mac against the demo account —
still not a prod feature surface.)

### Post-GA — a dedicated, internet-real, isolated TEST environment on `gym.` subdomains
Once real users exist, the gym must stop touching prod entirely. The plan is a
**parallel TEST deployment of BOTH planes**, internet-real (real certs, real DNS,
real Hetzner — no mocks) and **fully isolated from production** (its own
D1/R2/DO/secrets, zero shared state). The D5 state-induction hooks live IN this
test-env, against test endpoints — so the post-GA monthly gym never needs prod
admin access at all.

> **LOCKED (rev4) — the test env lives on `gym.` SUBDOMAINS of the EXISTING
> zones; no new domain.** The control plane is **`gym.flagshipserver.com`** (the
> test `.com` Worker), the data plane is **`gym.flagship.services`** (the test Fly
> app), and test boxes are **`<server>.<user>.gym.flagship.services`**. Both reuse
> the two Cloudflare zones we already own — there is no spare domain to acquire and
> no new zone to add. This RETIRES the rev3 "hard prerequisite: a separate test
> domain". The three concerns that callout raised are each handled WITHOUT a new
> domain:
> 1. **CT-log / cert-pin collision → closed by banning the username `gym`.** Prod's
>    CT monitor (`ctMonitor.ts`) only treats a cert as unexpected for a prod user
>    when a registered user equals the relevant apex label. With `gym` banned as a
>    username (below + §12-G1), **no prod user can ever own the `gym` label**, so a
>    real test cert minted under `*.gym.flagship.services` can never match a
>    registered prod box's SAN set and can never trip a prod owner's alert. (Test
>    certs DO still land in public CT — that is inherent to using a real LE cert on
>    a real subdomain, and is harmless: they advertise only that test boxes exist
>    under `gym.`, which is already public/knowable. Isolation is by zeroing, §4,
>    not by hiding the names.)
> 2. **DNS records → naturally namespaced under `gym.`.** Per-box A/AAAA for test
>    boxes are published under `*.gym.flagship.services` (and the test Worker's
>    routes/custom domains under `gym.flagshipserver.com`), so they never sit at the
>    prod apex and never shadow a prod record.
> 3. **State pollution → the test env has its OWN D1/R2** and is **wiped between
>    runs** (`scripts/wipe-all-users.sh` against the test D1), so prod data is never
>    touched and there is no cross-run leakage.

**Ban the username `gym` (prod AND test) — the single change that makes `gym.`
safe.** Add `gym` to `RESERVED_USER_LABELS` in
`packages/control-plane/src/labels.ts` (the chokepoint `validateUserLabel`,
lines ~20–27 + ~56–65; both `/api/users/check` via `usersCheck.ts` and
`/api/users/claim` via `usernameClaim.ts` flow through it) and mirror it in
`packages/services-zone/src/validation.ts`. While there, extend the set to also
cover `test`/`e2e`/`qa`/`ci`/`staging` (none are reserved today; `gym` isn't
either — verified this survey). Note: prod also folds an off-git `TEST_ACCOUNTS`
Worker secret into the reject list at request time (`usersCheck.ts`); the `gym`
ban is in-repo because it is a permanent product invariant, not a rotating sandbox
list. See §12-G1 for the exact edit.

**What a parallel test-env needs — scoped against the real prod deploy (paths
verified this survey):**

| Plane / resource | Prod today (cite) | Test-env mirror needed |
|---|---|---|
| **`.com` Worker** | `apps/com/wrangler.toml` — `name = "flagship-com"`, `main = src/index.ts` | a SECOND Worker, e.g. `flagship-com-gym` (separate `wrangler.gym.toml` or `--name`), served at the **`gym.flagshipserver.com`** custom domain; its `[vars]` set the apex var to the `gym.` apex (§12-G1) |
| **D1 database** | binding `DB` → `flagship-state` (`database_id = d6f3bc03-…`), `migrations_dir = ../../packages/storage/migrations` | its OWN D1 (`flagship-state-gym`, new `database_id`); apply the SAME migrations dir; **wiped between runs** (`scripts/wipe-all-users.sh` against this D1) |
| **R2 buckets** | three: `flagship-iso` (`ISO_BUCKET`), `flagship-iso-temp` (`ISO_TEMP_BUCKET`, public dev-url), `flagship-backups` (`BACKUPS_BUCKET`) | three test buckets (`-test` suffix); re-enable the temp bucket's public dev-url + re-pin `FLAGSHIP_R2_TEMP_PUBLIC_BASE` (the `pub-…r2.dev` host changes per bucket) |
| **Durable Object** | `BUILD_RELAY` → `BuildRelaySession` (`new_sqlite_classes`) | same class, auto-created in the test Worker (no shared state) |
| **Rate-limit namespaces** | `RATE_LIMITER` (ns 1001), `RATE_LIMITER_QR_PIPE` (ns 1002) | distinct namespace ids for the test Worker |
| **KV** | *(none today — prod `.com` uses D1 + R2 + DO, no `kv_namespaces` binding)* | none required to match prod; add only if the test-env grows one |
| **`[vars]`** | `SERVICES_BASE_URL`, `TUNNEL_HUB_URL`, base-ISO + `FLAGSHIP_ISO_MANIFEST`, passthrough IPs, zone id, `CA_ENDORSEMENT_ENFORCE`, … | test copies pointing at the test Fly app; the **new apex var set to the `gym.` apex** (default stays the prod literal everywhere else — §12-G1); **`CA_ENDORSEMENT_ENFORCE` left OFF in test** (or a test CA) so the chokepoint doesn't gate the test directory |
| **Secrets / KEKs** | `FLAGSHIP_ADMIN_SECRET`, `HCLOUD_TOKEN`, `DEMO_IRK_KEK`, `SERVICES_HMAC_KEY`, `CLOUDFLARE_DNS_API_TOKEN`/broker, VAPID, APNS/FCM, `FLAGSHIP_CA_PRIV_HEX` | a SEPARATE set for the test Worker (`wrangler secret put` against the test Worker); a **test Hetzner project token** (see below); test-only VAPID/CA |
| **Routes / custom domains** | zone routes `flagshipserver.com/*`, `www.`, `webapp.`, `remote.`; custom domains `recovery.`, `boot.` | the equivalents on **`gym.` subdomains of the SAME zone**: custom domain `gym.flagshipserver.com` for the test Worker, plus `webapp.gym.`, `recovery.gym.`, `boot.gym.` (wrangler self-provisions DNS+cert for custom domains, the boot. mechanism we already use) |
| **`.services` data plane** | `fly.toml` (repo ROOT, not `apps/web/fly.toml`) — `app = "flagship-services"`, `primary_region = "iad"`, SNI passthrough :443 + tunnel hub :8443, `[env] FLAGSHIP_SURFACE = "services"`, `Dockerfile` builds it | a SECOND Fly app, e.g. `flagship-services-gym` (its own `fly.gym.toml` / `flyctl -a`), same Dockerfile/image, its own anycast IPs; its `[env]` sets the apex var to **`gym.flagship.services`** (§12-G1) |
| **Worker→Fly wiring** | `SERVICES_BASE_URL = https://flagship-services.fly.dev:8443`, `TUNNEL_HUB_URL = wss://…:8443/tunnel`, `SERVICES_PASSTHROUGH_IPV4/6` | repoint all three at the test Fly app + its anycast IPs |
| **DNS / zone** | `flagshipserver.com` (identity) + `flagship.services` (`CLOUDFLARE_SERVICES_ZONE_ID = 51f3…`); per-box `<server>.<user>.flagship.services` A/AAAA published by the Worker | **the SAME two zones** — the test env lives under the `gym.` label: identity at `gym.flagshipserver.com`, data at `gym.flagship.services`, per-box `<server>.<user>.gym.flagship.services` A/AAAA published by the test Worker into the existing services zone. No new zone (rev4). |
| **Demo / Hetzner provisioning** | `apps/com/src/hetzner.ts` (pure-fetch REST), state machine `packages/control-plane/src/demoUsers*.ts`, routes `/api/dev/sample-user/*` in `controlPlaneRoutes.ts`, CLI `scripts/sample-user.mjs`, `MAX_CONCURRENT_DEMO_VPS` + `*/10` reaper | a **test Hetzner project** with its own `HCLOUD_TOKEN` + budget (so test boxes never count against prod's demo cap or bill) |
| **D5 test-control hooks** | n/a (pre-GA = admin-induction) | the clean per-event hooks (§7-A: force-dead, bump-usage, cert-mismatch, near-expiry, CT-alert, generic set-state) live HERE, gated on the **test** admin secret, against **test** endpoints |

> **RESOLVED (rev4) — reuse the existing zones under `gym.`; the "separate
> domain" prerequisite is RETIRED.** Earlier revisions called a spare domain a hard
> blocker because test runs mint real LE certs, emit real CT-log entries, and
> publish real DNS records. The locked decision keeps all of that on the EXISTING
> zones under the `gym.` label and neutralizes each concern without a new domain:
> CT/cert-pin collisions are closed by **banning the username `gym`** (no prod user
> can own the apex label, so a test cert can never match a registered box — see the
> three-point breakdown above); DNS records are **namespaced under `gym.`** and
> never shadow prod; state pollution is impossible because the test env has its
> **own D1/R2** and is **wiped between runs**. Test certs still appear in public CT
> (inherent to a real cert on a real subdomain) but that is harmless — they reveal
> only that `gym.` test boxes exist, which is already public/knowable, and
> isolation is by zeroing the backend, not by hiding the names (§4). **No owner
> domain decision is needed.**

**Effort & isolation — honest.** This is **bounded but real**: it is "deploy the
two planes again with test-namespaced resources under `gym.`" — a
`wrangler.gym.toml` + a `fly.gym.toml` + a fresh D1/R2/DO/secret set + the `gym.`
custom-domain records on the existing zones + a test Hetzner project. **The
app-code prerequisite is now the apex-var refactor (§12-G1/G2) plus the §7-A
hooks** — once the apex is a variable, standing up the test env is "set the var to
`gym.` + deploy", and the SAME code runs in both places (the rev4 exact-same-code
guarantee). The `Dockerfile`, the Worker source, and the migrations are all
identical. The payoff: it **isolates cleanly from prod** (a separate Worker, DB,
Fly app, and Hetzner project, on `gym.` subdomains, wiped between runs — zero risk
to real users or their data, no shared blast radius) and makes a **sustainable
monthly GA-era total-gym run** possible without ever pointing automation at
production. **When to build it is an open decision (§11):** stand it up now (and
run the pre-GA gym against admin-induction in the meantime), or defer the build
until GA approaches. Either way, pre-GA the gym does **not** depend on it —
admin-induction covers the interim. Note the apex-var refactor (G1/G2) is worth
landing regardless, because it also fixes the latent fixed-depth SNI/zone parse
(§3).

---

## 7. Mechanisms (concrete + honest — what exists vs what must be built)

### 7-A. D5 event induction (the biggest prerequisite)
- **Tier-1 (exists in spirit, must be extended):** `DemoFixtures` on each surface
  seeds local state. Today it seeds a basic paired shell; the gym needs seed
  variants for **every D5 event state** — a server in each status, a near-expiry
  cert, a cert-pin mismatch, an over-allowance counter, a CT alert, a pending
  re-pair, an untrusted trust verdict, an active deploy + build. **BUILD:** the
  seed-variant catalog (iOS `DemoFixtures.swift`, Android `DemoFixtures.kt`,
  webapp `pod-sim` + `page.route` payloads).
- **Tier-2 — forcing a *live* demo box/account into a state. Two postures by
  launch boundary (see §6.5):**
  - **Pre-GA = admin-access induction, NO new prod hooks.** The owner's Mac holds
    `FLAGSHIP_ADMIN_SECRET` + the demo/Hetzner control surface, so the gym induces
    these states by acting on the DEMO entities directly with the admin powers
    that already exist (delete/stop the demo VPS or age `lastReported` for F3,
    drive the demo `metering` row for F4, etc.), demo-classified only (§7-G).
    Where a state needs more than today's admin verbs, the pre-GA path is a thin
    admin-secret-gated helper run from the owner's Mac against the demo
    account — **not** a prod feature surface. This is the interim posture; it adds
    nothing to production.
  - **Post-GA = the clean test-control hooks, living in the TEST-ENV (§6.5), not
    prod.** Build these per-event hooks against the **test** endpoints (test admin
    secret, demo-only), so the GA-era monthly gym never touches prod:
    - **F3** stop/age the demo daemon (or age `lastReported`) → "dead/offline".
    - **F4** bump the demo account's `metering` usage counter → over-allowance.
    - **F5** make daemon-status report a mismatched cert SHA → pin-mismatch alert.
    - **F6** seed a `ct-unexpected-cert` audit row for the demo user.
    - **F8** force a near-expiry cert SHA/validUntil on the demo box.
    - a **generic "set demo state"** admin verb so the gym doesn't grow one
      endpoint per event. They mirror the existing `/api/dev/sample-user/*` admin
      surface (`controlPlaneRoutes.ts`) but are deployed to the **test** Worker.
  **Owner calls in §11:** the per-event hooks are now scoped to the test-env (so
  they never touch prod control-plane); pre-GA needs only admin-induction.

### 7-B. Visual / aesthetic review pipeline
1. **Capture** — on every total-gym scenario step, capture a screenshot per
   surface (Playwright `page.screenshot`; XCUITest `XCUIScreen.screenshot()` for
   iPhone *and* iPad; Compose/Espresso bitmap). Store with a stable
   `<scenario>-<step>-<surface>.png` name.
2. **Vision review** — a review job reads the captured set and emits a findings
   list (ergonomics, color, spacing, contrast, layout). **Review aid, not a gate.**
3. **Token conformance (gate)** — sample computed styles / pixels against the
   palette (`tokens.css` teal + dark canvas; `FSColors`; Android theme) and the
   `design-system.md` rules; fail on stray legacy blue or off-palette accents.
   **BUILD:** the capture-on-success harness (Playwright already captures
   on-failure; success-capture + the XCUITest/Compose capture are new) and the
   conformance sampler.

### 7-C. iPad adaptive-layout checks
Run the iOS scripts against an iPad `-destination`; assert the sidebar renders
(not the TabView), the reading column constrains content width, titles are inline.
The layout is **already built** (`RootShell.swift`); the work is the second
destination + the layout assertions. **BUILD:** iPad-specific assertion helpers.

### 7-D. Every-button-works sweep (D7-usable)
Walk each rendered screen's a11y tree, enumerate interactive nodes, assert each is
addressable + firing it produces an effect. **BUILD:** the per-surface sweep
driver + (the big one) the **Android test-tag sweep** so Android controls are
addressable at all.

### 7-E. Copy + nav lints (D7-understandable)
Extend the existing `humanError`/`uxCopyFindings`/`HumanError` checks to the
captured screen text; build a nav-graph assertion that walks the router/NavHost
maps for orphans + dead ends. **PARTLY EXISTS** (copy lints) / **BUILD** (nav
graph + on-screen copy extraction).

### 7-F. Launch seams
- iOS Tier-2: a DEBUG launch-arg reader that sets `flagship.dev.useLiveClient` +
  a session (today it's a UserDefault + a 3-tap gesture). **BUILD.**
- Android: a debug launch-intent that seeds `DemoFixtures` (Tier-1) or the
  `useLiveClient` pref + session (Tier-2). **BUILD.**
- webapp: already supported via `WEBAPP_BASE_URL`/`APEX_BASE_URL` + the pod-sim.

### 7-G. DEMO-only destructive-op guardrail (HARD)
Every destructive scenario (A3 wipe, A10 decommission, A11 revoke, A13 uninstall,
C8 revoke-device, C16 wipe-restart) asserts the **target username is
demo-classified** before running, and the harness **fail-closes** (aborts the
scenario, red) if not. At Tier-2 this rides the existing demo-classification
(`accountResolve` / `demo_users`); at Tier-1 the fixture username is fixed
(`smoketest`/`smoketest-demo`). **No real account is ever a destructive target.**
**BUILD:** the guard assertion in the harness base class on each surface.

---

## 8. Element addressability — per surface
- **iOS/iPad:** ~217 `accessibilityIdentifier`s already; kebab-case feature
  prefixes (`sd-`, `cs-`, `build-`, `service-env-`, `recovery-`, `install-`).
  Gap: a sweep to confirm *every* interactive control has one (D7-usable).
- **Android:** **12 tags on 2 screens** — the test-tag sweep across ~43 screens is
  the dominant Android prerequisite. Mirror the iOS id naming.
- **webapp:** addressed by `id` (no `data-testid` convention) — 500+ ids
  (`bootstrap-go`, `unlock-go`, `pin-set-go`, `build-src-scratch`, `vc-send`,
  `service-env-save`, `sd-*` mirrors). Playwright locates by `id`/role/text.

---

## 9. CI wiring — Linux CI for the cheap gate, the owner's Mac for the heavy tiers

**The runner split is now a decision (rev3), not an open question.** Two homes:

1. **GitHub-Linux CI — the every-merge gym only** (cheap, deterministic, per-PR).
2. **The owner's physical Mac — the heavy iOS/iPad/Android UI tiers + the total
   gym + every live-Hetzner run** (nightly / monthly / on-demand). There is **no
   hosted-macOS spend** — the prior "macOS CI runner budget" constraint is
   resolved by running locally.

| Tier / surface | Runs where | Job |
|---|---|---|
| **every-merge: TS gate** | GitHub-Linux | `npx tsc -b` + `npx vitest run` (the existing per-merge gate) |
| **every-merge: webapp UI** | GitHub-Linux | already wired — `.github/workflows/e2e.yml` (wrangler-dev miniflare, the Tier-1 Playwright subset) |
| **total gym: iOS + iPad** | **owner's Mac** (local Xcode + Simulator) | `xcodebuild test -scheme FlagshipApp` with iPhone **and** iPad `-destination`s, `-only-testing:FlagshipAppUITests` |
| **total gym: Android** | **owner's Mac** (local AVD; JDK17 at `/opt/homebrew/opt/openjdk@17`) | `:app:connectedDebugAndroidTest` (the net-new `androidTest` suite) |
| **total gym: webapp broad + Tier-2 + aesthetic** | **owner's Mac** | full Playwright matrix + the live-Hetzner vertical slice + the AI judge/navigator (BYOK key, local budget) |

- **The every-merge gym** runs on **PR + push** in **GitHub-Linux CI** (fast,
  Layer-1-only / no AI, Tier-1 subset): the TS `tsc -b`+`vitest` gate plus the
  webapp Playwright subset (`e2e.yml`). This is the merge gate. The iOS/Android UI
  tiers are **not** in this gate — they run on the Mac (heavier + need
  Simulator/AVD), so the per-PR gate stays Linux-cheap.
- **The total gym** runs on the **owner's Mac** on a **nightly / monthly /
  on-demand** cadence (a local script / launchd job, not a hosted runner), never
  on every PR — its Tier-2 slice provisions+destroys an ephemeral Hetzner box
  (§6) and its judge/navigator + aesthetic pass need the AI key + local budget.
  The post-GA monthly run points at the test-env (§6.5), not prod.
- **Artifacts (local on the Mac, archived where the owner chooses):** Playwright
  report + traces/video (configured); the iOS `.xcresult`; Android Compose failure
  bitmaps + view-hierarchy dumps; **the total gym's full screenshot set** (success
  + failure) for the D7 review + the AI judge's findings list. The Linux
  every-merge job still uploads its Playwright artifacts as CI artifacts on
  `always()`, ~14-day retention.

**Capacity (be honest — the constraint moved, it didn't vanish):**
- **The expensive constraint is no longer hosted-macOS minutes — it's the owner's
  Mac's wall-clock** (and the AI judge/navigator's API spend). An Xcode UI-test
  boot is slow and the iPad destination roughly doubles the iOS run, so the
  iOS+iPad+Android tiers + the aesthetic pass are a **nightly/monthly** job on this
  machine, not a per-PR one. This is exactly why the every-merge gate is kept
  Linux-only and AI-free.
- **The Android emulator** runs locally on the Mac (an AVD; nested-virt is native
  on Apple silicon). Robolectric stays the fast per-merge path; reserve the
  on-device emulator for the genuine launch-and-drive total-gym scenarios.
- **AI cost** is the short judge/navigator calls (§2.1) — low $, on the owner's
  BYOK key — and is incurred only on the Mac total-gym runs, never per PR.

---

## 10. Phased rollout (honest effort sizing — the total gym is large)

The every-merge gym and the total gym build on different cadences. The every-merge
subset grows *continuously* (each new screen adds its render+nav+button check); the
total gym is built **cluster-by-cluster** (D1…D8).

**Phase 1 — one live vertical slice on iOS, on the owner's Mac (prove the harness
+ live wiring).** On **iOS** (it has the XCUITest target + ~217 ids already, the
shortest path), script the slice **onboarding → create a demo server → online →
approve unlock → install a service** and run it **Tier-2 against a freshly-
provisioned, then-deleted Hetzner box** (the ephemeral create→test→`finally`-delete
loop, §6), on this Mac's local Simulator, asserting the D6 effects for real
(G8/G12). This proves end-to-end that the harness drives the real app against a
real backend, and shakes out the launch-seam + ephemeral provision/teardown +
demo-guardrail plumbing. (Pre-GA this runs against prod's demo surface with
admin-induction, §6.5; the AI judge/navigator can be added here or deferred to
Phase 6.) *Effort: ~2–4 days.*

**Phase 2 — stand up the every-merge gym (Tier-1 core, all PRs, GitHub-Linux).**
Curate the cheap deterministic subset — onboarding, create-server (form→QR),
home + status filters, the build chooser, settings landing, the slivers render —
in demo-fixture mode. The **per-PR Linux gate** is the TS `tsc -b`+`vitest` gate +
the **webapp** Playwright subset (the iOS/Android UI tiers stay on the Mac — §9 —
because they need a Simulator/AVD; their demo-fixture subset runs in the
nightly/local job, not the per-PR gate). Wire the Linux subset as the **merge
gate**; expand `DemoFixtures` (iOS/Android) + the `pod-sim` payloads (webapp) for
the subset states so the Mac-side iOS/Android subset is ready when the local job
runs. *Effort: ~1 week.*

**Phase 3 — total-gym D1/D2/D6 (lifecycle + build modes + action→effect).**
Fill D1 (incl. the demo-only deletes), D2 (all five modes), and the D6 pairs on
iOS + webapp, Tier-1 broad + the Tier-2 vertical-slice effects. *Effort: ~1.5–2
weeks.*

**Phase 4 — total-gym D3/D4/D5 (settings edge cases + security + event induction).**
Multi-device + lost-device flows, the global security experience, and the D5 event
surfacing. **Pre-GA this uses admin-access induction** against the demo entities
(§6.5) — the fixture seed-variant catalog (Tier-1) dominates and the clean
per-event hooks are deferred to the test-env. The fixture catalog is the main lift
here. *Effort: ~2–3 weeks.*

**Phase 5 — the Android harness + test-tag sweep.**
Stand up `src/androidTest/`, add `testTag`s across ~43 screens, port the D1–D5
matrix to Compose UI Test + Espresso on an emulator. The test-tag sweep dominates.
*Effort: ~2–3 weeks.*

**Phase 6 — D7 quality + iPad + the AI judge/navigator + the nightly local total-gym
job.** The every-button sweep, nav-graph + copy lints, the **screenshot-capture +
token-conformance** gate (Layer 1), the **iPad destination**, the **short-AI judge
(D7-beautiful review aid) + navigator/self-healer** (§2.1), and the **nightly /
monthly local total-gym driver on the owner's Mac** (a launchd job / script — the
ephemeral-Hetzner vertical slice + the broad Tier-1 set + the aesthetic pass; no
hosted runner). The Linux every-merge gate stays as-is; decide which Tier-1 subset
of the total gym (if any) is promoted into it. *Effort: ~2–3 weeks* (local
orchestration + the AI judge/navigator wiring + the capture harness + flake
quarantine).

**Phase 7 (post-GA) — the isolated `gym.` test environment (= §12-G6).** Stand up
the parallel test `.com` + test `.flagship.services` on **`gym.` subdomains of the
existing zones** + a test Hetzner project (§6.5), move the clean per-event D5 hooks
into it, and repoint the monthly total-gym run at the `gym.` endpoints so GA-era
runs never touch prod. *Effort: bounded-but-real — a `wrangler.gym.toml` +
`fly.gym.toml` + a fresh D1/R2/DO/secret set + the `gym.` custom-domain records +
the hooks. The only app-code prerequisite is the apex-var refactor (§12-G1/G2),
worth landing regardless; no new domain (rev4) — the test-domain blocker is
retired.*

> **Total-gym honest sizing:** roughly **8–12 focused weeks** to full coverage
> across four surfaces, dominated by the Android test-tag sweep, the fixture
> seed-variant catalog, and the D7 capture/review pipeline. The every-merge gym is
> a ~1-week stand-up (Phase 2) and then grows incrementally. The post-GA `gym.`
> test-env (Phase 7 / §12-G6) is a separate bounded-but-real chunk (a parallel
> `gym.` deploy + the apex-var refactor, not a new domain) — pre-GA the gym does
> not need it.

---

## 11. Open decisions for the owner

### RESOLVED (folded into the doc above)
**rev4 — the final locks:**
- **Test env = `gym.` subdomains on the EXISTING zones.** `gym.flagshipserver.com`
  (control plane) + `gym.flagship.services` (data plane); test boxes
  `<server>.<user>.gym.flagship.services`. **No new domain / zone.** This RETIRES
  the rev3 "test DOMAIN" prerequisite entirely (§6.5, §4, §12-G6).
- **Ban the username `gym` (prod + test).** One reserved-name ban closes both the
  namespace collision and the prod CT-monitor false-positive. Extend the set to
  `test`/`e2e`/`qa`/`ci`/`staging`. Chokepoint: `RESERVED_USER_LABELS` /
  `validateUserLabel` in `packages/control-plane/src/labels.ts` (mirror
  `packages/services-zone/src/validation.ts`) (§6.5, §12-G1).
- **Exact-same-code via a prod-default apex var.** One apex/base-URL var per
  surface, default = today's literal, so prod is byte-identical and the SAME code
  serves tests and users; only the test env sets it to `gym.`. Behavior-preserving,
  gated (full suite + canonical-byte vectors stay green); also fixes the latent
  fixed-depth SNI/zone misparse by parsing apex-relative (§6.5, §12-G1/G2).
- **Isolation by zeroing, not secrecy.** The `gym.` domain is public/knowable;
  isolation is the test env's own D1/R2 + a wipe between runs (§4, §6.5).
- **One-command-then-wait runner.** Each gym = a single command → pass/fail +
  screenshots; engine is the §2.1 deterministic gate + short-AI judge/navigator
  (§9, §12-G3).

**rev3 — still in force:**
- **Runner = the owner's physical Mac.** The iOS/iPad/Android UI tiers + the
  total gym + every live-Hetzner run execute LOCALLY on this Mac; only the cheap
  every-merge gym stays in GitHub-Linux CI. **There is no hosted-macOS cost** —
  this retires the old "CI runner budget (macOS)" gating question (§7, §9, §10).
- **Tier-2 Hetzner is ephemeral** — fresh-per-run create→test→delete, guaranteed
  teardown (`sample-user.mjs delete` in `finally` + the `*/10` reaper), ~cents/run.
  This retires the old "fresh vs shared" question; shared-box is a noted fallback
  only (§6).
- **Harness = deterministic gate + short-AI judge/navigator.** The pass/fail
  oracle is scripted handle-taps + assertions + diffable screenshots; short AI is
  bounded + advisory (judge the screenshots, navigate/self-heal) and is **never**
  the pass/fail oracle (§2.1).
- **Pre-GA D5 state induction = this box's admin access** against demo entities —
  **no new prod hooks pre-GA**; the clean per-event hooks move into the post-GA
  `gym.` test-env (§6.5, §7-A).

### REMAINING (need an owner call — none block this run; G1–G6 proceed)
1. **WHEN to stand up the `gym.` test-env.** Build it now (and run pre-GA against
   admin-induction in the meantime), or defer to GA-approach? Pre-GA the gym does
   not depend on it; the cost is the apex-var refactor (G1/G2, worth doing anyway)
   + a parallel `gym.` deploy (§6.5, §12-G6). *This run does the apex-var refactor
   and stages the deploy commands; the actual `gym.` deploy is owner-gated on
   tokens.*
2. **Final confirm of the AI-driver split (how much AI drives).** §2.1 is
   owner-recommended pending confirm: keep AI strictly to judge + navigate/heal
   with determinism as the verdict, or widen/narrow the AI's role? (Also: the
   judge cadence — per-step vs per-scenario-summary — trades coverage for spend.)
3. **Which subset gates merges.** Confirm the every-merge gate = the TS
   `tsc -b`+`vitest` gate + the webapp Playwright subset on GitHub-Linux as
   **required PR gates**, with the Mac iOS/Android tiers + the rest of the total
   gym advisory/nightly (§9, §10, §12-G4).
4. **Aesthetic-pass cadence.** Is the D7 judge (screenshot vision-review) a
   **per-release / monthly** pass (recommended — heavy + partly subjective + costs
   AI $) or more frequent? The token-conformance gate (Layer 1) can run more often
   even if the judge runs monthly.
5. **Branch-gated surfaces.** The marketplace UI (D2-B11) and the usage/tier-status
   dashboard (D5-F4 front-end) live on `feat/marketplace` — confirm their gym
   scripts ship on that branch (branch-is-the-gate), while the gym on `main` omits
   them.
6. **Surface order.** Confirm iOS-first for the live vertical slice (most head
   start), or prioritize a different surface (§12-G5).

---

## 12. Build plan (this run + incremental)

> **Why this section exists:** the build must survive context compaction. A
> fresh-context worker should be able to resume the gym from THIS doc alone —
> below are the executable phases, in dependency order, each with the concrete
> files to touch and the gate to run. **This run targets G1–G4 + a start on
> G5/G6.** The full 70×4 §6 matrix is NOT built in one pass — after the harness
> exists (G3), each remaining scenario is a small additive spec, filled in
> incrementally (each scenario = a new spec). The §10 phased rollout is the
> coverage-growth story; this §12 is the executable bring-up story. They agree:
> G1–G2 are the apex-var prerequisite; G3 ≈ §10 Phase-1/2 harness; G4 ≈ §10
> Phase-2 gate; G5 ≈ §10 Phase-1/3 first tranche; G6 ≈ §10 Phase-7 (now on
> `gym.`).

**Conventions for every phase:** the gate is `npx tsc -b` clean + `npx vitest run`
fully green with the **prod defaults unchanged** (so the refactors are
behavior-preserving), plus the surface-native suites where touched (iOS
`xcodebuild test`, Android `:app:testDebugUnitTest`). Branch is `main` unless a
phase says otherwise; the marketplace/usage-dashboard gym scripts ship on
`feat/marketplace` (branch-is-the-gate, §11-REMAINING-5).

### G1 — Apex-threading (backend): one apex var, default = prod literal
**Goal.** Replace the hardcoded backend apex literals with ONE variable per
boundary whose **default is `flagship.services` / `flagshipserver.com`**, so prod
is byte-identical and the test env sets it to `gym.flagship.services` /
`gym.flagshipserver.com`. Parse **apex-RELATIVE** (strip the configured apex
suffix, then split), never fixed-depth — this also fixes the latent SNI/zone
misparse. **Plus: ban the username `gym`.**

**Thread the apex through these load-bearing sites (paths verified this survey):**
- `packages/control-plane/src/authCode.ts` (~line 73) — `expectedDomain =
  \`${server}.${user}.flagship.services\`` serverDomain validation. Make the apex a
  parameter (default `"flagship.services"`).
- `apps/web/src/tunnel/allocator.ts` (~lines 487–488, 516–517, 561–562) —
  `const APEX = "flagship.services"` + `APEX_SUFFIX`. **Already apex-relative**
  (`endsWith(APEX_SUFFIX)` + dynamic slice) — make `APEX` injectable, keep the
  relative parse.
- `apps/web/src/tunnel/tunnelHub.ts` (~lines 629, 896–897, 905–906) —
  `podCanonicalShapeOk()` / `extractMiddleLabel()` use the literal
  `".flagship.services"` with `.length` slicing. **This is the fixed-depth-ish
  site**: derive the apex from config and keep the relative strip.
- `apps/web/src/tunnel/lazyRedirection.ts` (~line 83) — the
  `fqdn === "flagship.services" || fqdn.endsWith(".flagship.services")` first-party
  guard. Drive off the configured apex.
- `packages/control-plane/src/dns01.ts` (~lines 164, 264, 200/282/319) — already
  has `deps.apex ?? "flagship.services"`; ensure every DNS-01 path takes the apex
  (it mostly does) and the test deploy passes the `gym.` apex.
- `packages/control-plane/src/serverRegister.ts` — `userZoneOf(podApex)` (~lines
  294, 367–376) strips the literal `".flagship.services"`. Make the apex a
  parameter; keep the apex-relative `head.split(".")` → last-label-as-user logic.
- `apps/com/src/controlPlaneRoutes.ts` (~line 1837) — `handleCleanupApex({ dns,
  apex: "flagship.services" })`. Source the apex from the Worker `[vars]`.
- `packages/bootkey-builder/src/caddyfile.ts` (~lines 32, 41, 51) — `serverFqdn`
  / wildcard SAN helpers compose `…flagship.services`. Make the apex an arg
  (default prod).
- `apps/com/wrangler.toml [vars]` — add the apex var (prod value = the literal);
  the `gym.flagshipserver.com` test Worker (G6) overrides it. The control-plane
  `comBaseUrl` default (`packages/server-daemon/src/runtime.ts` ~line 1052,
  `?? "https://flagshipserver.com"`) is already a parameter — leave the default.

> **Honest count.** rev3 said "~20 backend sites"; the broad grep finds the
> literal `flagship.services` in ~120 source files and `flagshipserver.com` in
> ~90 (incl. tests/fixtures/comments/sibling apps). The **load-bearing
> parse/validate/compose sites** that must change are the ones listed above (~8
> modules); the long tail is mostly tests, generated `dist/`, comments, and the
> already-parameterized `?? "…"` defaults that need no change. Thread the named
> sites; grep the rest and change only those that actually parse or compose the
> apex.

**Ban the username `gym` (+ test labels).**
- `packages/control-plane/src/labels.ts` — add `"gym"`, `"test"`, `"e2e"`,
  `"qa"`, `"ci"`, `"staging"` to `RESERVED_USER_LABELS` (~lines 20–27). Both
  `/api/users/check` (`usersCheck.ts`) and `/api/users/claim` (`usernameClaim.ts`)
  flow through `validateUserLabel`, so this one edit bans them everywhere.
- `packages/services-zone/src/validation.ts` — mirror the same additions (the
  zero-dep copy, ~lines 35–75).
- Add a test asserting `validateUserLabel("gym").ok === false` (and the others).

**Gate:** `npx tsc -b` clean + `npx vitest run` green **with prod defaults**
(byte-identical behavior; canonical-byte / serverDomain vectors unchanged because
the default apex is the same literal). The reserved-name additions add a few
assertions; nothing else moves.

### G2 — Apex-threading (clients): one base-URL/apex constant per surface
**Goal.** Mirror G1 on the three clients: ONE base-URL/apex constant per surface,
default = prod, routed through the ~45 literal occurrences the survey found
(~150 client source files mention a prod literal, but most are tests/comments;
change the live base-URL/host-derivation sites). Plus handle cert-pinning for the
test build.
- **webapp** — derive the apex from `window.location.origin` where possible (the
  webapp is served from the same host it talks to), with an explicit
  `APEX_BASE_URL` / `WEBAPP_BASE_URL` override already supported (§4 Tier-2). Route
  the hardcoded host literals under `apps/web/public/webapp/lib` + `views` through
  it. A webapp served from `gym.flagshipserver.com` then "just works" against the
  `gym.` apex.
- **iOS** — one apex/base-URL constant in `apps/mobile/shared/Sources/FlagshipCore`
  (alongside `DeveloperSettings` / the live-client base), default = prod; the
  Tier-2 launch seam (G3, §7-F) can point it at `gym.`.
- **Android** — one constant mirroring iOS in `core/`; default = prod.
- **Cert-pinning for the test build (REQUIRED).** Android
  `apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/HttpClientFactory.kt`
  (~lines 43, 46) hardcodes two prod SPKI pins (`sha256/3GwlKvse…`,
  `sha256/V8/g9Sny…`) via `CertPinInterceptor.kt`; iOS pins per-box via the
  STK-signed daemon-status (§ Phase-4 cert work). For the `gym.` test build, either
  **add a test pin set** (the `gym.` LE chain's SPKI) **or disable pinning in the
  test/debug build** (a debug-only flag gating `HttpClientFactory`'s pinner). Prod
  pins stay unchanged. (webapp can't pin — no change.)

**Gate:** `npx tsc -b` clean + `npx vitest run` green; iOS `xcodebuild test` +
Android `:app:testDebugUnitTest` green with **prod defaults** (the
`HttpClientFactory` pin test stays green for prod; add a test for the test-build
pin/disable path).

### G3 — Gym harness + one-command runner
**Goal.** The engine from §2.1 (deterministic gate + short-AI judge/navigator) +
screenshot capture + a single command per gym that prints pass/fail + writes a
screenshots dir. **One command, then wait.**
- **Engine (Layer 1):** the scripted handle-tap + expected-state-assert + diffable
  screenshot loop (§2.1), per surface: **XCUITest** (iOS/iPad, building on
  `FlagshipAppUITests` + `OnboardingSmokeTests.swift`), **Compose UI Test +
  Espresso** (Android — needs the net-new `src/androidTest/` dir, §3/§7-D),
  **Playwright** (webapp — extend `apps/web/e2e/`).
- **Short-AI layer (Layer 2):** the bounded judge (screenshot review, advisory)
  + navigate/self-healer (§2.1), BYOK key, run on the Mac only. Can be stubbed in
  G3 and lit up in G5/Phase-6.
- **Screenshot capture:** capture-on-success + on-failure, named
  `<scenario>-<step>-<surface>.png` (§7-B); Playwright already has on-failure.
- **The `gym` runner / npm scripts:** a `gym` CLI (or npm scripts) exposing at
  least `gym:every-merge` (the fast Tier-1 subset, Layer-1 only, no backend) and
  `gym:total` (the full local run incl. Tier-2 + the AI passes) → a **pass/fail
  summary + a screenshots dir**. Per-surface drivers wired underneath (XCUITest /
  Compose-UI-Test / Playwright). Wire the demo-only guardrail (§7-G) into the
  harness base class.

**Gate:** the runner executes end-to-end on at least one surface (webapp, the
cheapest) and emits the summary + screenshots; `npx tsc -b` clean.

### G4 — Every-merge gym (fast Tier-1 subset, no backend)
**Goal.** The curated cheap deterministic subset (§10 Phase-2): onboarding,
create-server (form→QR), home + status filters, the build chooser, settings
landing, the slivers render — **demo-fixture mode, no backend**, wired as the
merge gate.
- **webapp** in GitHub-Linux CI — extend `.github/workflows/e2e.yml` (already
  wrangler-dev miniflare + the Playwright subset).
- **iOS** on this Mac — the demo-fixture XCUITest subset (`-smoke-mode`
  launch-args, §ios-launch-modes); runs in the local nightly job, not the per-PR
  Linux gate (§9).
- Expand `DemoFixtures` (iOS `DemoFixtures.swift`) + the `pod-sim`/`page.route`
  payloads (webapp) for the subset states.

**Gate:** the every-merge subset is green and fast (Linux webapp subset as the
required PR gate; the Mac iOS subset in the local job); `npx tsc -b` + `npx vitest
run` green.

### G5 — Total-gym Tier-1 tranche + iOS live vertical slice
**Goal.** Begin filling the real §6 matrix.
- **Tier-1 tranche (demo-fixture) — DONE (this run).** A substantial first batch
  of higher-value §6 rows in demo-fixture mode (NO backend), tagged `total`, on
  **web + iOS** (Android stays stubbed). They run only in `gym:total`, never the
  every-merge gate. Shipped (≈21 scenarios — 10 web + 11 iOS):
  - **D1 (render/confirm):** iOS server-detail cards (lock/power, front-page,
    journal); the revoke CONFIRM sheet (the hold-to-confirm UI, NOT a backend
    delete).
  - **D2 (build modes):** the chooser (scratch/git/mcp tiles) + the git
    fitness-verdict screen + the mcp connect screen + the AI-key step — web + iOS.
  - **D3 (settings):** session-tiers grey-out gating + the "set up recovery" toast
    on a greyed tap (web); the AI-keys manager (web + iOS); the recovery screen
    (web); the webapp PIN lock set/validate/roundtrip (web, E3).
  - **D4 (security):** the biometric lock screen via the tier-1 Lock action (iOS,
    E1); the red maintainer-trust sliver from a seeded untrusted verdict (web +
    iOS, E7).
  - **D5 (server-event seed states):** awaiting-unlock → the waiting-for-approval
    Home pill (iOS, F1); a dead server → the never-online Home pill (iOS, F3); the
    active-operations teal sliver from a seeded build (web, F12).
  - **D7 (light):** the PIN-set form's primary action validates a mismatch (web).
  - Seeded with NO backend: iOS via new `DemoFixtures` variants
    (`samplePodsWithAwaitingUnlock` / `samplePodsWithDeadServer`) + smoke-mode
    launch args (`-smoke-awaiting-unlock` / `-smoke-dead` / `-smoke-trust-untrusted`);
    webapp via the client-side stores (`serverTrust.setVerdict`,
    `activeOperations.upsertBuild`) reached through the served ES modules, plus
    the existing device-local IndexedDB/WebCrypto paths.
- **iOS live vertical slice (Tier-2) — DEFERRED to G6.** Script **onboarding →
  create a demo server → online → approve unlock → install a service** and run it
  Tier-2 against a **freshly-provisioned, then-deleted** Hetzner box (the ephemeral
  create→test→`finally`-delete loop, §6), asserting the D6 effects for real
  (G8/G12). This is the live action→effect path; it is gated on the test-env /
  admin-induction (§6.5) and is **NOT** part of the Tier-1 tranche above. (The
  approve-unlock CARD and the revoke/decommission EFFECT specifically need a live
  mailbox/box, so the Tier-1 tranche asserts their fixture-seeded SURFACING/CONFIRM
  UI only, and the action→effect lands here.)

**Gate:** the Tier-1 tranche is green in the harness (`gym:total` web + iOS,
demo-fixture, no backend); the live slice is G6.

### G6 — Test-env stand-up (`gym.` subdomains)
**Goal.** Stand up the isolated test env on the existing zones (§6.5):
- **Control plane:** a `flagship-com-gym` Worker (a `wrangler.gym.toml` or
  `--name`), served at the **`gym.flagshipserver.com`** custom domain; its `[vars]`
  set the apex var (G1) to the `gym.` apex; its own D1 (`flagship-state-gym`,
  same migrations dir), R2 (`-gym` buckets), DO, rate-limit namespaces, secrets,
  and a **test Hetzner project token**.
- **Data plane:** a `flagship-services-gym` Fly app (a `fly.gym.toml` / `flyctl
  -a`), same `Dockerfile`/image, its own anycast IPs; `[env]` sets the apex var
  to `gym.flagship.services`. Repoint the Worker→Fly wiring (`SERVICES_BASE_URL` /
  `TUNNEL_HUB_URL` / passthrough IPs) at it.
- **DNS:** `gym.flagshipserver.com` (+ `webapp.gym.`, `recovery.gym.`, `boot.gym.`)
  custom domains (wrangler self-provisions DNS+cert); per-box
  `<server>.<user>.gym.flagship.services` A/AAAA published by the test Worker into
  the existing services zone.
- **Wipe-between-runs:** run `scripts/wipe-all-users.sh` against the **test** D1
  before each run (isolation by zeroing — §4).
- **Deploy posture:** if Cloudflare/Fly/Hetzner tokens are present in the
  environment, deploy; **otherwise this phase ships the exact commands** (the
  `wrangler.gym.toml` / `fly.gym.toml` + the `wrangler deploy --name …` /
  `flyctl deploy -a flagship-services-gym` invocations) for the owner to run. The
  D5 clean per-event hooks (§7-A) live here, gated on the **test** admin secret.

**Gate:** `gym.flagshipserver.com/api/health` + `gym.flagship.services/api/health`
return 200 (when deployed); the apex-var refactor keeps prod green throughout.

### This run vs. incremental
**This run:** G1 + G2 (apex var + reserved-name ban + client pins) → G3 (harness +
one-command runner) → G4 (every-merge gym) → **start** G5 (the first Tier-1 tranche
+ the iOS live vertical slice) and **stage** G6 (the `gym.` configs/commands;
deploy if tokens present). **Afterward, incrementally:** the rest of the §6 70×4
matrix fills in on the harness one spec at a time (§10 Phases 3–6), the Android
test-tag sweep (§10 Phase-5) unblocks Android's D7-usable sweep, and the `gym.`
test-env's per-event D5 hooks (§7-A) light up the live propagation tests once GA
approaches.

---

## Headline recommendation

Build **two gyms sharing one harness**: an **every-merge gym** (Tier-1 demo-fixture
subset — fast, deterministic, gates merges) and a **total gym** (the comprehensive
acceptance suite — every feature × every surface, organized by D1 lifecycle / D2
build-modes / D3 settings-edge-cases / D4 security / D5 server-event-propagation /
D6 action→effect / D7 quality / D8 every-surface). **Start with a single live
vertical slice on iOS** (onboarding → create demo server → online → approve unlock
→ install a service, Tier-2) to prove the harness + live wiring, then grow the
every-merge subset continuously and the total gym cluster-by-cluster. iOS and the
webapp have a real head start (an XCUITest target + ~217 a11y ids; a 16-spec
Playwright gym in CI; the iPad adaptive layout is already built); Android is the
largest net-new lift (an emulator instrumentation harness + a ~43-screen test-tag
sweep). **The harness is a deterministic gate (handle-taps + assertions + diffable
screenshots — the verdict) with a short, bounded, advisory AI layer on top (a
screenshot judge + a navigate/self-healer); the AI is never the pass/fail oracle.**
The heavy tiers + the total gym + the ephemeral-Hetzner runs execute **locally on
the owner's Mac** (nightly/monthly), so there is **no hosted-macOS cost** — the
cheap every-merge gate stays on GitHub-Linux. Pre-GA, D5 server-side states are
induced via this box's own admin access against demo entities; **post-GA, a
dedicated isolated test-env on `gym.` subdomains of the existing zones**
(`gym.flagshipserver.com` + `gym.flagship.services`, its own D1/R2/Hetzner, wiped
between runs) carries the clean state-induction hooks so the monthly GA-era gym
never touches prod. The same code runs in both places: **one apex/base-URL
variable per surface, default = the prod literal**, so prod behavior is
byte-identical and only the test env points at `gym.`; the username `gym` is banned
so the test apex can never collide with a real user or trip the prod CT monitor.
Honest scope: the total gym is ~8–12 focused weeks to full four-surface coverage;
the every-merge gym is a ~1-week stand-up that then grows incrementally; the
test-env is a parallel `gym.` deploy whose only app-code prerequisite is the
apex-var refactor (worth landing regardless — it also fixes the latent fixed-depth
SNI/zone parse). **This run targets G1–G4 + a start on G5/G6 (§12); the full 70×4
matrix fills in incrementally on the harness afterward.** **Hard rule throughout:
destructive lifecycle scenarios run on demo entities only — never a real account.**
