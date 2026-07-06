# `@flagship/gym` — the UI test gym harness (G3)

A repeatable harness that drives the **real app** on each surface and produces
**pass/fail + screenshots**. It implements the model in `docs/ui-test-gym.md`
§2 / §2.1: a **deterministic gate** (scripted element-handle taps + state
assertions + captured screenshots = the verdict) with a **pluggable, advisory**
short-AI layer (judge / navigate-self-heal) that **never** decides pass/fail.

This package is the harness home from **§12-G3**. The full §6 70×4 matrix fills
in incrementally on top of it — each scenario is a small additive entry.

**Two tranches share the harness** (`src/suites.ts`):

- **every-merge** (§12-G4) — the curated cheap subset (cold launch, per-tab
  render, create-server, validation, the slivers). Runs in BOTH gyms.
- **total** Tier-1 tranche (§12-G5) — the higher-value, fixture-feasible,
  NO-BACKEND §6 rows: D1 server-detail cards + the revoke/decommission
  CONFIRM UI, D2 build modes (chooser / git / mcp / AI-key step), D3 settings
  (session-tiers grey-out + the recovery toast, AI-keys manager, recovery
  screen, the webapp PIN lock), D4 security (the biometric lock screen, the
  red maintainer-trust sliver), D5 server-event seed states (awaiting-unlock
  approve card, a dead server's never-online pill, the active-operations
  sliver), and a D7-light "primary action enabled/disabled per state" check.
  These are `total` + `fixture` → they run ONLY in `gym:total`, never the
  every-merge gate. The fixture seed states are seeded with NO backend (iOS
  via `DemoFixtures` variants + `-smoke-*` launch args; webapp via the
  client-side stores reached through the served ES modules). The LIVE
  action→effect slice (Tier-2, against a real box) is **G6 — not in this
  registry**.

## One-command runner

```sh
# The two headline one-liners (from the repo root):
npm run gym:locked                 # FAST, no cloud — the full deterministic frontend
                                   # matrix across web · iOS · iPad · Android (mock-only)
npm run gym:total                  # OVERNIGHT — the locked matrix PLUS real-cloud e2e:
                                   # provisions real gym boxes, drives the backend chain
                                   # + the gating e2e, then tears them down

# The building blocks the two headlines compose from:
npm run gym:every-merge            # the fast Tier-1 subset (no backend)
npm run gym:live                   # ONLY the live Tier-2 slice (§12-G6)

# Narrow to a surface (web | ios | android), or override the tier / drop the live slice:
npm run gym -- every-merge --surface web
npm run gym -- total --surface ios
npm run gym -- total --mock-only          # the locked matrix (what gym:locked runs)
npm run gym -- every-merge --surface web,ios

# Or directly via the CLI:
npx tsx tools/gym/src/cli.ts every-merge --surface web
```

**`gym:locked` (fast, no cloud)** runs `gym total --mock-only` — every fixture-backed
frontend scenario, all surfaces, with NO backend and NO env probe. This is the
"have we tested all the frontend features" gate before hand-testing.

**`gym:total` (overnight, real cloud)** is `scripts/gym-total.sh`: it runs the locked
matrix first, then — if `.gym-secrets.env` has `GYM_ADMIN_SECRET` — provisions REAL
gym Hetzner boxes and drives the live backend e2e (`tools/live-e2e/run.ts`) + the
service-access gating e2e (`tools/live-e2e/gating-drive.ts`), each self-tearing-down
its box. With no secrets it cleanly SKIPS the cloud half and just runs the matrix, so
it's safe to invoke anywhere.

The standalone **live Tier-2 slice** (`gym:live` / `gym total` without `--mock-only`)
**detects** whether the `gym.` test env is deployed (pings `<control-apex>/api/health`)
and **SKIPS cleanly** (never fails) when it isn't. See "Live Tier-2 slice" below.

The command runs the selected suite, then **waits** and prints a pass/fail
summary + the path to the results artifact. Exit code = the deterministic
verdict (`0` = gate green, `1` = a scenario failed or nothing ran, `2` = the
runner itself crashed). AI findings never affect the exit code.

## Results artifact

Each run writes `gym-results/<utc-timestamp>/` (gitignored):

```
gym-results/2026-06-17T08-09-10-123Z/
  summary.json        # machine-readable: per-scenario pass/fail + timings + screenshot paths + advisory AI findings
  summary.txt         # human-readable rendering of the same
  screenshots/
    web-smoke-cold-launch-cold-launch-web-0.png
    web-smoke-cold-launch-bootstrap-ready-web-1.png
    ios-smoke-cold-launch-cold-launch-ios-0.png
    ...
```

`summary.json` shape: `GymRunSummary` (`src/results.ts`) — `{ suite, tier,
surfaces, totals:{total,passed,failed,skipped}, results:[ScenarioResult], ok }`.
`ScenarioResult.passed` is THE verdict (set only by the deterministic gate);
`ScenarioResult.aiFindings` is advisory and never read by the gate.

## Surfaces

| Surface | Engine | How the adapter drives it |
|---|---|---|
| **web** | Playwright (chromium) | WRAPS `apps/web/e2e` via `apps/web/e2e/gym/playwright.gym.config.ts` — a self-contained static webapp server (no wrangler, no pod-sim, no backend). Maps Playwright's JSON report + `gym-screenshot:` attachments into the artifact. |
| **ios** | XCUITest | Shells `xcodebuild test -scheme FlagshipApp -only-testing:FlagshipAppUITests/<Class>[/method]`, launching in `-smoke-mode` (seeded `DemoFixtures`, no backend). The every-merge legs are `GymSmokeTests` + `GymEveryMergeTests`; the total tranche is `GymTotalTests`. Extracts screenshots from the `.xcresult`. **Building this also builds the App + UITest target.** |
| **android** | (stub) | Adapter **interface + TODO only**. The full Compose-UI-Test/emulator harness + the ~43-screen `testTag` sweep is a later phase (§10 Phase-5). The runner cleanly SKIPS Android. |

The runner **skips** (never fails) a surface whose toolchain is absent — so
`gym:every-merge --surface web` runs on Linux CI with no Xcode, and iOS is
skipped there rather than red.

## AI judge / navigator (advisory, default no-op, BYOK)

Two bounded roles (`src/ai/hooks.ts`):

- **judge** — reviews each captured screenshot for clarity/ergonomics/contrast
  (the D7-beautiful review aid). Emits findings a human triages.
- **navigate / self-heal** — when a scripted handle misses because the UI
  shifted, reasons over the current a11y tree toward the same deterministic
  goal and/or proposes the handle delta.

Both default to a **deterministic no-op** (`NoOpJudge` / `NoOpNavigator`) so the
gym runs with **no API key**. A real short-LLM call is a **BYOK drop-in**
(`src/ai/byokSeam.ts`): set `GYM_AI_API_KEY` (+ optional `GYM_AI_PROVIDER` /
`GYM_AI_BASE_URL` / `GYM_AI_MODEL`) and implement the two stub bodies. The
deterministic gate works with the AI hooks entirely absent; AI output is
recorded as advisory in the artifact and never gates.

## Demo-only destructive guardrail (§7-G)

A scenario that performs a destructive op (wipe/decommission/revoke/uninstall)
must name the demo username it targets (`Scenario.destructive`). The runner
**fail-closes** — it refuses to run the framework — for any target outside the
fixed demo-fixture identities (`src/guardrail.ts`). No real account is ever a
destructive target. (None of the shipped smoke scenarios are destructive.)

## Live Tier-2 slice (§12-G6)

The one end-to-end scenario the gym runs against a REAL backend — the isolated
`gym.` test env (`docs/ui-test-gym.md` §6.5; stand it up via
`docs/runbooks/gym-test-env.md`):

> onboarding → create a demo server (gym `.com` + the test Hetzner project) →
> it comes online → approve the boot-unlock → install a service → assert the
> **real** effect (the service runs / appears on the live `/pods` — D6 G8/G12).

It lives in `src/live.ts` (`LIVE_SCENARIOS`), **separate from `ALL_SCENARIOS`**
so the every-merge + total Tier-1 tranches stay entirely no-backend. It is
`backend:"live"`, `total` tier, and demo-guarded (it creates/installs against the
`gymdemo` demo user only — §7-G).

**Detect-and-skip — why `gym:total` stays green today.** `liveEnvReachable()`
pings `<control-apex>/api/health` (default `gym.flagshipserver.com`, override with
`GYM_LIVE_CONTROL_APEX` / `GYM_LIVE_SERVICES_APEX`). The runner gates every
`backend:"live"` scenario on it and **SKIPS** (never **FAILS**) when the env is
unreachable — DNS miss, refused, timeout, or non-2xx all read as "not deployed".
The fixture scenarios carry the verdict, so a `total` run is green with no env.
The check is resolved **once**, and **only** when a live scenario is selected, so
a pure-fixture run makes no network call.

**Launch in live mode** (once the env is up):
- **iOS** — `-apex-host gym.flagshipserver.com` launch arg points the live client
  at the gym apex (the G2 seam: live-client base + `flagship.dev.useLiveClient`);
  the cert-pinning test build carries the `gym.` SPKI pin or disables pinning in
  debug (§12-G2). XCUITest class: `GymLiveTests`.
- **webapp** — serve Playwright from the gym origin (`web.gym.flagshipserver.com`);
  the webapp derives its apex from `window.location.origin` (§12-G2).

## Layout

```
tools/gym/
  src/
    scenario.ts          # the Scenario model (deterministic steps/assertions/screenshotPoints)
    runner.ts            # selects + guards + gates live on env-reachability + drives adapters + layers advisory AI + writes the artifact
    results.ts           # artifact shape (GymRunSummary) + JSON/text writers
    guardrail.ts         # the §7-G demo-only destructive guard
    suites.ts            # the fixture scenario registry (every-merge subset + the total Tier-1 tranche)
    live.ts              # the live Tier-2 slice + the gym-env detect-and-skip probe (§12-G6)
    cli.ts               # the `gym` CLI (one command, then wait)
    adapters/
      types.ts           # the SurfaceAdapter interface
      web.ts             # wraps Playwright
      ios.ts             # wraps XCUITest
      android.ts         # interface + stub (later phase)
    ai/
      hooks.ts           # judge + navigator interfaces + no-op defaults
      byokSeam.ts        # the BYOK adapter seam
  tests/harness.test.ts  # vitest coverage of the deterministic logic
apps/web/e2e/gym/        # the webapp gym leg (wraps the existing Playwright rig)
  playwright.gym.config.ts
  gym-smoke.spec.ts      # the every-merge subset
  gym-total.spec.ts      # the total Tier-1 tranche
  static-server.ts
apps/mobile/ios/App/UITests/
  GymSmokeTests.swift       # the iOS every-merge cold-launch smoke
  GymEveryMergeTests.swift  # the iOS every-merge breadth
  GymTotalTests.swift       # the iOS total Tier-1 tranche
```
