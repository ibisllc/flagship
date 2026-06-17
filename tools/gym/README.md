# `@flagship/gym` — the UI test gym harness (G3)

A repeatable harness that drives the **real app** on each surface and produces
**pass/fail + screenshots**. It implements the model in `docs/ui-test-gym.md`
§2 / §2.1: a **deterministic gate** (scripted element-handle taps + state
assertions + captured screenshots = the verdict) with a **pluggable, advisory**
short-AI layer (judge / navigate-self-heal) that **never** decides pass/fail.

This package is the harness home from **§12-G3**. The full §6 70×4 matrix fills
in incrementally on top of it — each scenario is a small additive entry.

## One-command runner

```sh
# From the repo root:
npm run gym:every-merge            # the fast Tier-1 subset (no backend)
npm run gym:total                  # the full local run (incl. live + AI passes)

# Narrow to a surface (web | ios | android), or override the tier:
npm run gym -- every-merge --surface web
npm run gym -- total --surface ios
npm run gym -- every-merge --surface web,ios

# Or directly via the CLI:
npx tsx tools/gym/src/cli.ts every-merge --surface web
```

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
| **ios** | XCUITest | Shells `xcodebuild test -scheme FlagshipApp -only-testing:FlagshipAppUITests/GymSmokeTests`, launching in `-smoke-mode` (seeded `DemoFixtures`, no backend). Extracts screenshots from the `.xcresult`. **Building this also builds the App + UITest target.** |
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

## Layout

```
tools/gym/
  src/
    scenario.ts          # the Scenario model (deterministic steps/assertions/screenshotPoints)
    runner.ts            # selects + guards + drives adapters + layers advisory AI + writes the artifact
    results.ts           # artifact shape (GymRunSummary) + JSON/text writers
    guardrail.ts         # the §7-G demo-only destructive guard
    suites.ts            # the scenario registry (one web + one iOS smoke this run)
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
  gym-smoke.spec.ts
  static-server.ts
apps/mobile/ios/App/UITests/GymSmokeTests.swift   # the iOS gym leg (XCUITest)
```
