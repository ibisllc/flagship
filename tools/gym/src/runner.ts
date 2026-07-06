/**
 * The gym runner (§12-G3) — executes selected scenarios per surface, captures
 * screenshots at the screenshot points, runs the DETERMINISTIC assertions (via
 * the per-surface adapters) → pass/fail, layers the ADVISORY AI hooks on top,
 * and writes the results artifact into `gym-results/<timestamp>/`.
 *
 * The split is strict: `outcome.passed` (Layer 1, from the adapter) is the only
 * input to the verdict. AI findings are appended but never read by the gate.
 */

import type { Scenario, Surface, Tier } from "./scenario.js";
import { guardScenario } from "./guardrail.js";
import {
  createRunDir,
  runDirName,
  summarize,
  writeArtifacts,
  type GymRunSummary,
  type ScenarioResult,
} from "./results.js";
import type { SurfaceAdapter, AdapterContext } from "./adapters/types.js";
import type { AiHooks, AiFinding } from "./ai/hooks.js";
import { defaultAiHooks } from "./ai/hooks.js";

/**
 * Result of the live-env reachability check (§12-G6). When the `gym.` test env
 * isn't deployed, `reachable` is false and every `backend:"live"` scenario is
 * SKIPPED (never failed) — so a `total` run stays green on a machine that never
 * stood up the env. Only evaluated when the selection contains a live scenario.
 */
export interface LiveEnvCheck {
  reachable: boolean;
  reason: string;
}

export interface RunnerOptions {
  readonly repoRoot: string;
  readonly suite: string;
  readonly tier: Tier;
  /** Restrict to these surfaces; default = all surfaces present in the scenarios. */
  readonly surfaces?: readonly Surface[];
  readonly adapters: Readonly<Record<Surface, SurfaceAdapter>>;
  /** Advisory AI hooks; defaults to the deterministic no-op hooks. */
  readonly aiHooks?: AiHooks;
  /** Sink for progress lines; defaults to console.log. */
  readonly log?: (line: string) => void;
  /**
   * Gate for `backend:"live"` scenarios (§12-G6). Called at most ONCE per run,
   * and ONLY when the selection contains a live scenario. When it resolves
   * `reachable:false`, every live scenario is SKIPPED cleanly with the reason —
   * the deterministic gate never sees a failure for an absent env. Omit it and
   * any live scenario is skipped as "no live-env check configured".
   */
  readonly liveEnvCheck?: () => Promise<LiveEnvCheck>;
}

/** Select the scenarios for this run by tier + surface filter. */
export function selectScenarios(
  all: readonly Scenario[],
  tier: Tier,
  surfaces?: readonly Surface[],
): Scenario[] {
  return all.filter((s) => {
    // every-merge is a subset of total: an every-merge scenario also runs in
    // total, but a total-only scenario does not run in every-merge.
    const tierMatch = tier === "total" ? true : s.tier === "every-merge";
    const surfaceMatch = !surfaces || surfaces.length === 0 || surfaces.includes(s.surface);
    return tierMatch && surfaceMatch;
  });
}

/** Run one scenario through its adapter + the advisory AI layer. */
async function runOne(
  scenario: Scenario,
  adapter: SurfaceAdapter,
  ctx: AdapterContext,
  ai: AiHooks,
  log: (line: string) => void,
): Promise<ScenarioResult> {
  // GUARDRAIL (§7-G): refuse a destructive scenario whose target is not demo.
  const guard = guardScenario(scenario);
  if (!guard.allowed) {
    log(`[GUARD] ${scenario.surface}/${scenario.id}: ${guard.reason}`);
    return {
      id: scenario.id,
      surface: scenario.surface,
      tier: scenario.tier,
      goal: scenario.goal,
      passed: false,
      skipped: true,
      skipReason: guard.reason,
      durationMs: 0,
      screenshots: [],
      aiFindings: [],
    };
  }

  log(`[RUN ] ${scenario.surface}/${scenario.id} — ${scenario.goal}`);
  const outcome = await adapter.run(scenario, ctx);

  // Layer 2 (advisory only): judge each captured screenshot; annotate any
  // missing handles via the navigator. NEVER feeds the verdict.
  const aiFindings: AiFinding[] = [];
  for (const shot of outcome.screenshots) {
    const found = await ai.judge.judge({
      scenarioId: scenario.id,
      point: shot.point,
      screenshotPath: shot.path.startsWith("/") ? shot.path : `${ctx.runDir}/${shot.path}`,
      goal: scenario.goal,
    });
    aiFindings.push(...found);
  }
  for (const missing of outcome.missingHandles ?? []) {
    const suggestion = await ai.navigator.navigate({
      scenarioId: scenario.id,
      goal: scenario.goal,
      missingHandle: missing,
    });
    aiFindings.push(...suggestion.findings);
  }

  log(`[${outcome.passed ? "PASS" : "FAIL"}] ${scenario.surface}/${scenario.id} (${outcome.durationMs}ms)`);
  return {
    id: scenario.id,
    surface: scenario.surface,
    tier: scenario.tier,
    goal: scenario.goal,
    passed: outcome.passed,
    skipped: false,
    durationMs: outcome.durationMs,
    screenshots: outcome.screenshots,
    log: outcome.log,
    aiFindings,
  };
}

/** Run a suite: select, guard, drive adapters, write the artifact. */
export async function runGym(
  scenarios: readonly Scenario[],
  opts: RunnerOptions,
): Promise<GymRunSummary> {
  const log = opts.log ?? ((l: string) => console.log(l)); // eslint-disable-line no-console
  const ai = opts.aiHooks ?? defaultAiHooks();
  const startedAt = new Date();
  const runDir = createRunDir(opts.repoRoot, runDirName(startedAt));
  const ctx: AdapterContext = { repoRoot: opts.repoRoot, runDir };

  const selected = selectScenarios(scenarios, opts.tier, opts.surfaces);
  const surfacesInRun = [...new Set(selected.map((s) => s.surface))];

  // Resolve which surfaces' toolchains are present; SKIP (never fail) absent ones.
  const availability = new Map<Surface, { ok: boolean; reason?: string }>();
  for (const surface of surfacesInRun) {
    const adapter = opts.adapters[surface];
    availability.set(surface, await adapter.available(ctx));
  }

  // Resolve the live-env gate ONCE, lazily, and ONLY if a live scenario is in the
  // selection (so a pure-fixture run never makes a network call). An absent env
  // → every live scenario SKIPS cleanly (§12-G6).
  let liveGate: LiveEnvCheck | undefined;
  const hasLive = selected.some((s) => s.backend === "live");
  if (hasLive) {
    liveGate = opts.liveEnvCheck
      ? await opts.liveEnvCheck()
      : { reachable: false, reason: "no live-env check configured (gym env detect-and-skip)" };
    log(`[LIVE] ${liveGate.reachable ? "env reachable" : "env unreachable → live scenarios skip"}: ${liveGate.reason}`);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    // Live scenarios are gated on env reachability — SKIP (never fail) when down.
    if (scenario.backend === "live" && liveGate && !liveGate.reachable) {
      log(`[SKIP] ${scenario.surface}/${scenario.id}: ${liveGate.reason}`);
      results.push({
        id: scenario.id,
        surface: scenario.surface,
        tier: scenario.tier,
        goal: scenario.goal,
        passed: false,
        skipped: true,
        skipReason: liveGate.reason,
        durationMs: 0,
        screenshots: [],
        aiFindings: [],
      });
      continue;
    }

    const adapter = opts.adapters[scenario.surface];
    const avail = availability.get(scenario.surface)!;
    if (!avail.ok) {
      log(`[SKIP] ${scenario.surface}/${scenario.id}: ${avail.reason}`);
      results.push({
        id: scenario.id,
        surface: scenario.surface,
        tier: scenario.tier,
        goal: scenario.goal,
        passed: false,
        skipped: true,
        skipReason: avail.reason,
        durationMs: 0,
        screenshots: [],
        aiFindings: [],
      });
      continue;
    }
    results.push(await runOne(scenario, adapter, ctx, ai, log));
  }

  const summary = summarize({
    startedAt,
    finishedAt: new Date(),
    suite: opts.suite,
    tier: opts.tier,
    surfaces: surfacesInRun,
    results,
    runDir,
  });
  writeArtifacts(summary);
  return summary;
}
