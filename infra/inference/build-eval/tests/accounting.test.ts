import { describe, expect, it } from "vitest";
import { INFERENCE_MODELS, chargeMultiplier } from "@flagship/control-plane";
import { chargedWeighted, howMany, totalsOf, weightedOf, type CallRecord } from "../src/accounting.js";
import { DEEPINFRA_PRICES, catalogIdForUpstream, costUsd, worstCaseCallUsd } from "../src/prices.js";
import { median, p90, percentile } from "../src/report.js";

const call = (over: Partial<CallRecord>): CallRecord => ({
  runId: "r",
  step: "build",
  phase: "chat",
  model: "low",
  summariser: false,
  stream: true,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  ms: 1,
  status: 200,
  ...over,
});

describe("weighted tokens and credits", () => {
  it("weights output 4× and applies the model's multiplier, rounded up, as .com charges", () => {
    expect(weightedOf({ inputTokens: 1000, outputTokens: 100 })).toBe(1400);
    expect(chargedWeighted("low", { inputTokens: 1000, outputTokens: 100 })).toBe(1400);
    expect(chargeMultiplier("high")).toBe(3.5);
    expect(chargedWeighted("high", { inputTokens: 1001, outputTokens: 0 })).toBe(Math.ceil(1001 * 3.5));
    expect(chargedWeighted("medium-vision", { inputTokens: 10, outputTokens: 1 })).toBe(28);
  });

  it("sums a run: credits per 1,000 charged tokens, summariser calls as compactions, cache only in dollars", () => {
    const t = totalsOf([
      call({ inputTokens: 400_000, outputTokens: 10_000, cachedTokens: 300_000 }),
      call({ inputTokens: 20_000, outputTokens: 2_000, summariser: true }),
      call({ model: "high", inputTokens: 1_000, outputTokens: 1_000 }),
    ]);
    expect(t.calls).toBe(3);
    expect(t.turns).toBe(2);
    expect(t.compactions).toBe(1);
    expect(t.weightedTokens).toBe(440_000 + 28_000 + 5_000);
    expect(t.credits).toBe((440_000 + 28_000 + 5_000 * 3.5) / 1000);
    expect(t.cachedTokens).toBe(300_000);
    // Low: cached input costs the same as fresh on DeepInfra.
    const low = (420_000 * 0.1 + 12_000 * 0.95) / 1e6;
    const high = (1_000 * 0.28 + 1_000 * 1.1) / 1e6;
    expect(t.costUsd).toBeCloseTo(low + high, 6);
    expect(t.creditsShown).toBeGreaterThanOrEqual(t.credits);
  });

  it("keeps DeepInfra's own cost only when every call carried one", () => {
    expect(totalsOf([call({ providerCostUsd: 0.01 }), call({ providerCostUsd: 0.02 })]).providerCostUsd).toBeCloseTo(0.03, 6);
    expect(totalsOf([call({ providerCostUsd: 0.01 }), call({})]).providerCostUsd).toBeUndefined();
  });

  it("says how many builds an allowance buys", () => {
    expect(howMany(2_000_000, 474_000)).toBe(4.2);
    expect(howMany(500_000, 0)).toBe(Infinity);
  });
});

describe("the price table", () => {
  it("matches the catalog's DeepInfra ids and prices for every model", () => {
    for (const m of INFERENCE_MODELS) {
      const p = DEEPINFRA_PRICES[m.id];
      expect(p, m.id).toBeDefined();
      expect(p!.upstreamId).toBe(m.upstream.deepinfra!.id);
      expect(p!.inUsd).toBe(m.upstream.deepinfra!.inUsd);
      expect(p!.outUsd).toBe(m.upstream.deepinfra!.outUsd);
      expect(p!.cachedInUsd).toBeLessThanOrEqual(p!.inUsd);
      expect(catalogIdForUpstream(p!.upstreamId)).toBe(m.id);
    }
  });

  it("discounts cached input at the cached price and bounds a call's worst case", () => {
    expect(costUsd("medium", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 })).toBeCloseTo(0.018, 9);
    expect(costUsd("medium", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 5_000_000 })).toBeCloseTo(0.018, 9);
    expect(worstCaseCallUsd("high", 1_000_000, 1_000_000)).toBeCloseTo(0.28 + 1.1, 9);
    expect(() => costUsd("nope", { inputTokens: 1, outputTokens: 1 })).toThrow(/no DeepInfra price/);
  });
});

describe("percentiles", () => {
  it("interpolates", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(9.1, 9);
    expect(percentile([], 50)).toBeNaN();
  });
});
