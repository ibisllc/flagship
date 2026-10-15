/**
 * The runs to make, in the order that leaves a balanced sample if the
 * budget stops them early (each repeat goes through every scenario,
 * smallest first, and every model), and a pool that runs them under the
 * budget guard.
 */

import type { BudgetGuard, RunEstimator } from "./budget.js";
import type { RunResult } from "./runBuild.js";
import type { Scenario } from "./scenarios.js";

export interface PlannedRun {
  runId: string;
  scenario: Scenario;
  model: string;
  repeat: number;
  /** The first build plus its edits. */
  steps: number;
}

export function planRuns(scenarios: readonly Scenario[], models: readonly string[], repeat: number): PlannedRun[] {
  const out: PlannedRun[] = [];
  for (let r = 1; r <= repeat; r++) {
    for (const s of scenarios) {
      for (const m of models) out.push({ runId: `${s.id}-${m}-r${r}`, scenario: s, model: m, repeat: r, steps: 1 + s.edits.length });
    }
  }
  return out;
}

export interface MatrixArgs {
  plan: readonly PlannedRun[];
  guard: BudgetGuard;
  estimator: RunEstimator;
  concurrency: number;
  run: (p: PlannedRun) => Promise<RunResult>;
  onDone?: (r: RunResult, index: number) => void | Promise<void>;
  onSkip?: (p: PlannedRun, why: string) => void;
}

/** Runs the plan; stops starting runs once the guard says no. */
export async function runMatrix(a: MatrixArgs): Promise<{ results: RunResult[]; notStarted: number }> {
  const results: RunResult[] = [];
  let next = 0;
  let stop = false;
  let finished = 0;
  const worker = async () => {
    while (!stop && next < a.plan.length) {
      const p = a.plan[next++]!;
      const estimate = a.estimator.estimate(p.model, p.scenario.id, p.steps);
      if (!a.guard.tryStartRun(p.runId, estimate)) {
        stop = true;
        next--;
        a.onSkip?.(p, a.guard.tripped() ?? "budget");
        return;
      }
      try {
        const r = await a.run(p);
        a.estimator.observe(p.model, p.scenario.id, p.steps, r.totals.costUsd);
        results.push(r);
        await a.onDone?.(r, ++finished);
        if (a.guard.tripped()) stop = true;
      } finally {
        a.guard.endRun(p.runId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, a.concurrency) }, worker));
  return { results, notStarted: a.plan.length - next };
}
