/**
 * The Scenario model — the deterministic unit of the gym.
 *
 * Per docs/ui-test-gym.md §2.1, a scenario's verdict is decided ENTIRELY by
 * Layer 1: scripted element-handle taps + expected-state assertions + captured
 * screenshots. The short-AI layer (judge / navigate-heal) is advisory and never
 * touches `passed`.
 *
 * Steps and assertions are deliberately surface-agnostic *descriptions*. The
 * actual driving (XCUITest / Playwright / Compose-UI-Test) lives in the
 * per-surface harness specs that an adapter invokes; a Scenario here is the
 * registry entry that selects WHICH harness test runs and records WHAT it is
 * meant to prove, so the runner can report, tag-select, and gate on it without
 * re-implementing each framework's driver.
 */

export type Surface = "web" | "ios" | "android";

/** The two gyms (§0): every-merge is a tag-selected subset of total. */
export type Tier = "every-merge" | "total";

/**
 * Backend posture (§4). Tier-1 = demo-fixture / mock, no backend. Tier-2 = a
 * live (ephemeral Hetzner) box. The smoke scenarios in this run are all
 * `fixture`; `live` is the seam the iOS vertical slice (G5) fills in.
 */
export type BackendPosture = "fixture" | "live";

/**
 * One deterministic step: tap/assert a stable handle. `kind` documents intent;
 * `handle` is the surface's stable element id (iOS accessibilityIdentifier,
 * webapp id/role+text, Android testTag). These are descriptive — the binding
 * to a real driver call lives in the harness spec keyed by `scenario.harness`.
 */
export interface ScenarioStep {
  readonly kind: "launch" | "tap" | "type" | "wait" | "assert" | "screenshot";
  /** Human description of what the step does. */
  readonly describe: string;
  /** The stable element handle this step targets, if any. */
  readonly handle?: string;
  /** A literal value for `type` steps. */
  readonly value?: string;
}

/**
 * A deterministic assertion = the goal (§2.1 "the goal and the final assertion
 * stay deterministic"). `handle` + `expect` describe the on-screen state the
 * harness spec asserts; this record lets the runner report the goal and lets
 * the (advisory) navigator know what it is steering toward.
 */
export interface ScenarioAssertion {
  readonly describe: string;
  readonly handle?: string;
  readonly expect: "present" | "absent" | "enabled" | "disabled" | "text";
  /** Expected text for `expect: "text"`. */
  readonly text?: string;
}

/**
 * A named point at which the harness captures a screenshot (§7-B). The runner
 * resolves these to `<scenario>-<point>-<surface>.png` under the results dir,
 * on success AND failure. The advisory judge reads exactly these files.
 */
export interface ScreenshotPoint {
  readonly id: string;
  readonly describe: string;
}

/**
 * GUARDRAIL surface (§7-G). A destructive scenario must name the demo username
 * it targets; the runner refuses to run a destructive scenario whose target is
 * not demo-classified. Non-destructive scenarios leave this undefined.
 */
export interface DestructiveTarget {
  readonly destructive: true;
  /** The demo username the destructive op runs against. */
  readonly demoUsername: string;
}

export interface Scenario {
  /** Stable id, e.g. "web-smoke-cold-launch". */
  readonly id: string;
  readonly surface: Surface;
  readonly tier: Tier;
  readonly backend: BackendPosture;
  /** One-line statement of the deterministic goal. */
  readonly goal: string;
  readonly steps: readonly ScenarioStep[];
  readonly assertions: readonly ScenarioAssertion[];
  readonly screenshotPoints: readonly ScreenshotPoint[];
  /**
   * The handle the adapter uses to bind this scenario to its real driver:
   *  - web:     a Playwright spec file (or grep title) under apps/web/e2e
   *  - ios:     an `-only-testing:` identifier (Target/Class[/method])
   *  - android: (stub) the Compose-UI-Test class to run
   */
  readonly harness: string;
  /** Present iff the scenario performs a destructive op (§7-G). */
  readonly destructive?: DestructiveTarget;
}

/** True when a scenario performs a destructive op and must be guarded. */
export function isDestructive(s: Scenario): s is Scenario & { destructive: DestructiveTarget } {
  return s.destructive?.destructive === true;
}
