/**
 * The spending limit (`--max-usd`). Two walls:
 *
 *  - before a run starts, its estimated cost (the dearest run of that model
 *    and scenario so far, else a prior from the cost doc's build estimate)
 *    plus what is spent and what running runs have reserved must fit;
 *    otherwise no more runs start;
 *  - before each model call, its worst case (every prompt token uncached,
 *    the whole output allowance used) plus what is spent and what other
 *    calls in flight could still cost must fit; otherwise the call is not
 *    sent, and the run ends as stopped by the budget.
 *
 * Spending is counted from the provider's reported usage at DeepInfra's
 * prices (`prices.ts`).
 */

import { priceFor } from "./prices.js";

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

export class BudgetGuard {
  private spent = 0;
  private inFlightCalls = 0;
  private readonly reservations = new Map<string, number>();
  private trippedReason: string | null = null;

  constructor(readonly maxUsd: number) {
    if (!(maxUsd > 0)) throw new Error("--max-usd must be above 0");
  }

  spentUsd(): number {
    return this.spent;
  }

  /** Why the guard stopped the measurement, or null. */
  tripped(): string | null {
    return this.trippedReason;
  }

  private reserved(): number {
    let r = 0;
    for (const v of this.reservations.values()) r += v;
    return r;
  }

  /**
   * Reserve room for a run. False (and nothing reserved) when it could take
   * the total past the limit; the caller stops starting runs.
   */
  tryStartRun(runId: string, estimateUsd: number): boolean {
    if (this.trippedReason) return false;
    if (this.spent + this.reserved() + estimateUsd > this.maxUsd) {
      this.trippedReason =
        `stopped before the next run: $${this.spent.toFixed(4)} spent, and the next run could cost ` +
        `up to $${estimateUsd.toFixed(4)} against the $${this.maxUsd} limit`;
      return false;
    }
    this.reservations.set(runId, estimateUsd);
    return true;
  }

  endRun(runId: string): void {
    this.reservations.delete(runId);
  }

  /** Throws BudgetExceeded when the call's worst case doesn't fit. */
  beginCall(worstUsd: number): void {
    if (this.spent + this.inFlightCalls + worstUsd > this.maxUsd) {
      this.trippedReason ??=
        `stopped mid-run: $${this.spent.toFixed(4)} spent, and the next model call could cost ` +
        `up to $${worstUsd.toFixed(4)} against the $${this.maxUsd} limit`;
      throw new BudgetExceeded(this.trippedReason);
    }
    this.inFlightCalls += worstUsd;
  }

  endCall(worstUsd: number, actualUsd: number): void {
    this.inFlightCalls = Math.max(0, this.inFlightCalls - worstUsd);
    this.spent += Math.max(0, actualUsd);
  }
}

/** One build in the cost doc (§5): 424k input and 13k output tokens. */
const DOC_BUILD = { inputTokens: 424_000, outputTokens: 13_000 } as const;
/** How far above the doc's estimate a run's prior may go. */
const PRIOR_SAFETY = 2;
/** Room above the dearest run seen so far. */
const OBSERVED_SAFETY = 1.25;

/**
 * Estimates a run's cost before it starts: from runs already measured when
 * there are any, else from the doc's per-build estimate at the uncached
 * price, doubled.
 */
export class RunEstimator {
  private readonly byScenario = new Map<string, number>();
  private readonly perStep = new Map<string, number>();

  prior(model: string, steps: number): number {
    const p = priceFor(model);
    const build = (DOC_BUILD.inputTokens * p.inUsd + DOC_BUILD.outputTokens * p.outUsd) / 1e6;
    return build * PRIOR_SAFETY * Math.max(1, steps);
  }

  estimate(model: string, scenario: string, steps: number): number {
    const seen = this.byScenario.get(`${model}|${scenario}`);
    if (seen !== undefined) return seen * OBSERVED_SAFETY;
    const step = this.perStep.get(model);
    const prior = this.prior(model, steps);
    return step !== undefined ? Math.max(prior, step * Math.max(1, steps) * OBSERVED_SAFETY) : prior;
  }

  observe(model: string, scenario: string, steps: number, usd: number): void {
    const k = `${model}|${scenario}`;
    this.byScenario.set(k, Math.max(this.byScenario.get(k) ?? 0, usd));
    const per = usd / Math.max(1, steps);
    this.perStep.set(model, Math.max(this.perStep.get(model) ?? 0, per));
  }
}
