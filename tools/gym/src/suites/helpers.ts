/**
 * Shared scenario builders for the per-surface registry modules
 * (suites/{web,ios,android,quality}.ts). Extracted from the old monolithic
 * suites.ts so each surface's scenarios live in their OWN file — parallel
 * authors never collide on one registry, and the aggregator (suites.ts) just
 * concatenates them.
 *
 * Every builder here produces a `backend:"fixture"` Tier-1 scenario (NO backend
 * — the demo-fixture posture, §4). The LIVE Tier-2 slice lives in live.ts.
 *
 * `harness` binds the registry entry to the REAL per-surface driver:
 *   - web:     a Playwright `test(...)` grep TITLE under apps/web/e2e/gym/
 *   - ios:     an `-only-testing:` identifier (Target/Class[/method])
 *   - android: a Compose-UI-Test `-Pandroid.testInstrumentationRunnerArguments.class`
 *              identifier (Class[#method]) under app/src/androidTest/
 */

import type {
  Scenario,
  Tier,
  Surface,
  ScenarioStep,
  ScenarioAssertion,
  ScreenshotPoint,
  Dimension,
  DestructiveTarget,
} from "../scenario.js";

export interface ScenarioParts {
  readonly steps: readonly ScenarioStep[];
  readonly assertions: readonly ScenarioAssertion[];
  readonly screenshots: readonly ScreenshotPoint[];
  /** Optional §6 coverage cluster (advisory). */
  readonly dimension?: Dimension;
  /**
   * Optional destructive target (§7-G). A fixture destructive scenario asserts
   * the CONFIRM UI / mock-flip (not a real delete); set the demo username so the
   * guardrail passes (e.g. "smoketest", an ALLOWED_DEMO_USERNAMES member).
   */
  readonly destructive?: DestructiveTarget;
}

/** A named screenshot point (§7-B). */
export const shot = (id: string, describe: string): ScreenshotPoint => ({ id, describe });

function build(
  surface: Surface,
  tier: Tier,
  id: string,
  goal: string,
  harness: string,
  parts: ScenarioParts,
): Scenario {
  return {
    id,
    surface,
    tier,
    backend: "fixture",
    goal,
    steps: parts.steps,
    assertions: parts.assertions,
    screenshotPoints: parts.screenshots,
    harness,
    ...(parts.dimension ? { dimension: parts.dimension } : {}),
    ...(parts.destructive ? { destructive: parts.destructive } : {}),
  };
}

// ── webapp (Playwright grep title) ──
/** Every-merge web scenario (runs in BOTH gyms). */
export const web = (id: string, goal: string, grepTitle: string, parts: ScenarioParts): Scenario =>
  build("web", "every-merge", id, goal, grepTitle, parts);
/** Total-gym-only web scenario (the Tier-1 tranche; runs in `gym:total`). */
export const webTotal = (id: string, goal: string, grepTitle: string, parts: ScenarioParts): Scenario =>
  build("web", "total", id, goal, grepTitle, parts);

// ── iOS / iPad (-only-testing: identifier) ──
/** Every-merge iOS scenario (runs in BOTH gyms). */
export const ios = (id: string, goal: string, onlyTesting: string, parts: ScenarioParts): Scenario =>
  build("ios", "every-merge", id, goal, onlyTesting, parts);
/** Total-gym-only iOS scenario (the Tier-1 tranche; runs in `gym:total`). */
export const iosTotal = (id: string, goal: string, onlyTesting: string, parts: ScenarioParts): Scenario =>
  build("ios", "total", id, goal, onlyTesting, parts);

// ── Android (Compose-UI-Test class#method identifier) ──
/** Every-merge Android scenario (runs in BOTH gyms). */
export const android = (id: string, goal: string, testClass: string, parts: ScenarioParts): Scenario =>
  build("android", "every-merge", id, goal, testClass, parts);
/** Total-gym-only Android scenario (the Tier-1 tranche; runs in `gym:total`). */
export const androidTotal = (id: string, goal: string, testClass: string, parts: ScenarioParts): Scenario =>
  build("android", "total", id, goal, testClass, parts);
