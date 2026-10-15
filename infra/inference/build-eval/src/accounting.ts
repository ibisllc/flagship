/**
 * Turning what the provider reported into what Flagship Inference charges.
 *
 * Credits follow `.com`'s charge for a shim usage report
 * (`recordFreeAiUsage`): weighted = ceil((input × inputWeight + output ×
 * outputWeight) × multiplier), and 1 credit = 1,000 weighted tokens. Cached
 * prompt tokens are charged like any other input; only the $ cost sees the
 * provider's cache discount. The box's per-reply "used N credits" line is
 * the shim's own figure (`creditsFor`, rounded up to a tenth per call),
 * kept alongside as `creditsShown`.
 */

import { INFERENCE_PRICING, chargeMultiplier } from "@flagship/control-plane";
import { creditsFor } from "../../shim/src/meter.js";
import { costUsd } from "./prices.js";

/** `AI_PROMO_INPUT_WEIGHT` / `AI_PROMO_OUTPUT_WEIGHT` defaults. */
export const DEFAULT_WEIGHTS = { inputWeight: 1, outputWeight: 4 } as const;
/** `AI_PROMO_STARTER_TOKENS` / `AI_PROMO_WEEKLY_TOKENS` defaults (weighted). */
export const ALLOWANCE = { starterTokens: 2_000_000, weeklyTokens: 500_000 } as const;
/** docs/ai-inference-costs.md §5: one build estimated at 474k weighted tokens. */
export const ESTIMATED_BUILD_WEIGHTED = 474_000;

/** Which part of a build a model call belongs to. */
export type Phase = "chat" | "fix";

/** One model call, as the provider reported it. */
export interface CallRecord {
  runId: string;
  /** "build", "edit-1", "edit-2", … */
  step: string;
  phase: Phase;
  /** Catalog id ("low", …). */
  model: string;
  /** A compaction's summariser call, not a build turn. */
  summariser: boolean;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** DeepInfra's own figure, when its usage carries one. */
  providerCostUsd?: number;
  ms: number;
  status: number;
  /** Redacted, short. */
  error?: string;
}

export interface Totals {
  calls: number;
  /** Model calls that were build turns (summariser calls excluded). */
  turns: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** input × 1 + output × 4, before the model multiplier. */
  weightedTokens: number;
  /** What `.com` deducts: weighted × multiplier / 1,000. */
  credits: number;
  /** The sum of the shim's per-call "used N credits". */
  creditsShown: number;
  costUsd: number;
  /** DeepInfra's own cost figure summed, when every call carried one. */
  providerCostUsd?: number;
}

export function weightedOf(u: { inputTokens: number; outputTokens: number }, w = DEFAULT_WEIGHTS): number {
  return Math.max(0, u.inputTokens) * w.inputWeight + Math.max(0, u.outputTokens) * w.outputWeight;
}

/** Weighted tokens `.com` charges for one call: the model multiplier applied, rounded up. */
export function chargedWeighted(model: string, u: { inputTokens: number; outputTokens: number }, w = DEFAULT_WEIGHTS): number {
  return Math.ceil(weightedOf(u, w) * Math.max(1, chargeMultiplier(model)));
}

export function emptyTotals(): Totals {
  return {
    calls: 0,
    turns: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    weightedTokens: 0,
    credits: 0,
    creditsShown: 0,
    costUsd: 0,
  };
}

export function totalsOf(calls: readonly CallRecord[], w = DEFAULT_WEIGHTS): Totals {
  const t = emptyTotals();
  let charged = 0;
  let provider = 0;
  let providerAll = calls.length > 0;
  for (const c of calls) {
    t.calls++;
    if (c.summariser) t.compactions++;
    else t.turns++;
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    t.cachedTokens += c.cachedTokens;
    t.weightedTokens += weightedOf(c, w);
    charged += chargedWeighted(c.model, c, w);
    t.creditsShown += creditsFor(c, Math.max(1, chargeMultiplier(c.model)), {
      ...w,
      creditTokens: INFERENCE_PRICING.creditTokens,
    });
    t.costUsd += costUsd(c.model, c);
    if (typeof c.providerCostUsd === "number") provider += c.providerCostUsd;
    else providerAll = false;
  }
  t.credits = round(charged / INFERENCE_PRICING.creditTokens, 1);
  t.creditsShown = round(t.creditsShown, 1);
  t.costUsd = round(t.costUsd, 6);
  if (providerAll) t.providerCostUsd = round(provider, 6);
  return t;
}

/** How many of something costing `weighted` (charged) tokens an allowance buys. */
export function howMany(allowanceTokens: number, weighted: number): number {
  return weighted > 0 ? round(allowanceTokens / weighted, 1) : Infinity;
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
