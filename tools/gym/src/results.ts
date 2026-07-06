/**
 * The results artifact (§12-G3): per-scenario pass/fail + timings + screenshot
 * paths, written as a machine-readable JSON summary AND a human-readable text
 * summary into `gym-results/<timestamp>/`. AI findings ride along as ADVISORY
 * only — they never feed `passed`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Surface, Tier } from "./scenario.js";
import type { AiFinding } from "./ai/hooks.js";

export interface ScreenshotRef {
  /** The screenshot-point id (or a framework-emitted name). */
  readonly point: string;
  /** Path relative to the run directory. */
  readonly path: string;
}

export interface ScenarioResult {
  readonly id: string;
  readonly surface: Surface;
  readonly tier: Tier;
  readonly goal: string;
  /** THE VERDICT — set only by the deterministic gate (Layer 1). */
  readonly passed: boolean;
  readonly skipped: boolean;
  /** Why a scenario was skipped (e.g. guardrail abort, surface unavailable). */
  readonly skipReason?: string;
  readonly durationMs: number;
  readonly screenshots: readonly ScreenshotRef[];
  /** Captured stdout/stderr tail from the underlying framework, for triage. */
  readonly log?: string;
  /** ADVISORY findings from the short-AI judge/navigator. Never gates. */
  readonly aiFindings: readonly AiFinding[];
}

export interface GymRunSummary {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly suite: string;
  readonly tier: Tier;
  readonly surfaces: readonly Surface[];
  readonly totals: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly results: readonly ScenarioResult[];
  /** Absolute path to the run directory. */
  readonly runDir: string;
  /** True iff every non-skipped scenario passed (the gate verdict). */
  readonly ok: boolean;
}

/** Build the directory name for a run: a sortable UTC timestamp. */
export function runDirName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Create `gym-results/<timestamp>/` (+ a `screenshots/` subdir) and return it. */
export function createRunDir(repoRoot: string, name: string): string {
  const dir = join(repoRoot, "gym-results", name);
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  return dir;
}

/** Fold per-scenario results into a run summary. */
export function summarize(args: {
  startedAt: Date;
  finishedAt: Date;
  suite: string;
  tier: Tier;
  surfaces: readonly Surface[];
  results: readonly ScenarioResult[];
  runDir: string;
}): GymRunSummary {
  const considered = args.results.filter((r) => !r.skipped);
  const passed = considered.filter((r) => r.passed).length;
  const failed = considered.filter((r) => !r.passed).length;
  const skipped = args.results.filter((r) => r.skipped).length;
  return {
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
    suite: args.suite,
    tier: args.tier,
    surfaces: args.surfaces,
    totals: { total: args.results.length, passed, failed, skipped },
    results: args.results,
    runDir: args.runDir,
    // A run with zero considered scenarios is NOT ok — it proves nothing.
    ok: failed === 0 && considered.length > 0,
  };
}

/** Render the human-readable summary text. */
export function renderText(summary: GymRunSummary): string {
  const lines: string[] = [];
  lines.push(`Flagship UI gym — ${summary.suite} (tier: ${summary.tier})`);
  lines.push(`surfaces: ${summary.surfaces.join(", ")}`);
  lines.push(`started:  ${summary.startedAt}`);
  lines.push(`finished: ${summary.finishedAt}`);
  lines.push("");
  for (const r of summary.results) {
    const mark = r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL";
    lines.push(`[${mark}] ${r.surface}/${r.id}  (${r.durationMs}ms)`);
    lines.push(`       goal: ${r.goal}`);
    if (r.skipReason) lines.push(`       skipped: ${r.skipReason}`);
    for (const s of r.screenshots) lines.push(`       shot: ${s.path}`);
    for (const f of r.aiFindings) {
      lines.push(`       ai(${f.role}/${f.severity}): ${f.message} [advisory]`);
    }
  }
  lines.push("");
  lines.push(
    `totals: ${summary.totals.passed} passed, ${summary.totals.failed} failed, ` +
      `${summary.totals.skipped} skipped of ${summary.totals.total}`,
  );
  lines.push(`verdict: ${summary.ok ? "OK (deterministic gate green)" : "FAILED"}`);
  lines.push("");
  lines.push("Note: ai(...) lines are ADVISORY (D7 judge / navigate-heal); they");
  lines.push("never affect the verdict. The verdict is the deterministic gate.");
  return lines.join("\n");
}

/** Write summary.json + summary.txt into the run dir. */
export function writeArtifacts(summary: GymRunSummary): void {
  writeFileSync(join(summary.runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(summary.runDir, "summary.txt"), renderText(summary) + "\n");
}
