/**
 * One interface every surface adapter implements (§12-G3). An adapter binds a
 * Scenario to its real native UI-automation framework, runs it, captures
 * screenshots, and reports the DETERMINISTIC verdict + any framework artifacts.
 * The runner stays surface-agnostic above this line.
 */

import type { Scenario, Surface } from "../scenario.js";
import type { ScreenshotRef } from "../results.js";

/** What an adapter reports back for one scenario (pre-AI; AI is layered by the runner). */
export interface AdapterOutcome {
  /** THE VERDICT — Layer 1 only. */
  readonly passed: boolean;
  readonly durationMs: number;
  /** Screenshots the framework produced, copied into the run dir (relative paths). */
  readonly screenshots: readonly ScreenshotRef[];
  /** stdout/stderr tail for triage. */
  readonly log: string;
  /**
   * Handles the script could not find (for the advisory navigator). The
   * deterministic gate has already failed when this is non-empty; the navigator
   * only annotates.
   */
  readonly missingHandles?: readonly string[];
}

export interface AdapterContext {
  readonly repoRoot: string;
  /** Absolute path to the run directory; the adapter writes screenshots under screenshots/. */
  readonly runDir: string;
}

/**
 * A surface adapter. `available()` lets the runner skip a surface whose
 * toolchain is absent (e.g. no Xcode on Linux CI) rather than fail it.
 */
export interface SurfaceAdapter {
  readonly surface: Surface;
  /** Resolve whether this surface can run here (toolchain present). */
  available(ctx: AdapterContext): Promise<{ ok: boolean; reason?: string }>;
  /** Run one scenario deterministically and report the verdict + artifacts. */
  run(scenario: Scenario, ctx: AdapterContext): Promise<AdapterOutcome>;
}
