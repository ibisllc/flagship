import { describe, expect, it } from "vitest";
import { InMemoryMeterStorage, InMemoryTierStorage } from "@flagship/storage";
import {
  INFERENCE_MODELS,
  INFERENCE_PRICING,
  InMemoryModelCapabilityStore,
  TOKENS_PER_CREDIT,
  buildCost,
  chargeMultiplier,
  handleFreeAiAllowance,
  handleModelCapabilities,
  handleNewModelCapabilities,
  inferenceCatalog,
  inferenceCatalogResponse,
  mintScopedInferenceToken,
  multiplierFor,
  recordFreeAiUsage,
  refreshModelCapabilities,
  resolveInferenceModel,
  type CatalogEntry,
} from "../src/index.js";

const base = INFERENCE_MODELS.find((m) => m.id === INFERENCE_PRICING.baseModel)!;

function entry(id: string, inUsd: number, outUsd: number, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    tier: id,
    model: id,
    descriptor: "",
    contextTokens: 1,
    modalities: ["text"],
    maxOutputTokens: 1,
    upstream: { a: { id, inUsd, outUsd, thinkingOff: {} } },
    ...extra,
  };
}

describe("multipliers come from real cost plus the margin", () => {
  it("is the build-mix cost ratio × margin, rounded up to the step; the base is 1×", () => {
    const b = entry("b", 0.1, 0.95);
    expect(multiplierFor(b, b)).toBe(1);
    // Same cost: 1 × 1.25 → 1.5 (rounded up, never under cost × margin).
    expect(multiplierFor(entry("x", 0.1, 0.95), b)).toBe(1.5);
    // Twice the cost: 2.5.
    expect(multiplierFor(entry("y", 0.2, 1.9), b)).toBe(2.5);
    // Cheaper than the base is still at least 1×.
    expect(multiplierFor(entry("z", 0.01, 0.01), b)).toBe(1);
  });

  it("prices a model at its dearest upstream", () => {
    const two = entry("two", 0.1, 0.95, {
      upstream: {
        a: { id: "a", inUsd: 0.1, outUsd: 0.95, thinkingOff: {} },
        b: { id: "b", inUsd: 0.3, outUsd: 0.95, thinkingOff: {} },
      },
    });
    expect(buildCost(two)).toBeCloseTo((0.3 * 424_000 + 0.95 * 13_000) / 1e6, 10);
  });

  it("serves today's lineup with labels the menu shows", () => {
    const cat = inferenceCatalog();
    expect(cat.map((m) => [m.id, m.multiplier])).toEqual([
      ["low", 1],
      ["medium", 1],
      ["medium-vision", 2],
      ["high", 3.5],
    ]);
    expect(cat[0]!.label).toBe("Low 1× (Qwen3.6-35B-A3B)");
    expect(cat.find((m) => m.id === "medium-vision")!.label).toBe("Medium multimodal 2× (GLM-5.3-Flash)");
    for (const m of cat) {
      expect(m.multiplier).toBe(multiplierFor(INFERENCE_MODELS.find((e) => e.id === m.id)!, base));
      expect(m.multiplier % INFERENCE_PRICING.step).toBe(0);
    }
  });

  it("keeps the catalog coherent", () => {
    const ids = new Set(INFERENCE_MODELS.map((m) => m.id));
    expect(ids.size).toBe(INFERENCE_MODELS.length);
    expect(INFERENCE_MODELS.filter((m) => m.default)).toHaveLength(1);
    expect(INFERENCE_MODELS.some((m) => m.modalities.includes("image"))).toBe(true);
    for (const m of INFERENCE_MODELS) {
      expect(Object.keys(m.upstream).sort()).toEqual(["deepinfra", "openrouter"]);
      if (m.visionAlternative) {
        expect(ids.has(m.visionAlternative)).toBe(true);
        expect(INFERENCE_MODELS.find((x) => x.id === m.visionAlternative)!.modalities).toContain("image");
      }
    }
    expect(INFERENCE_PRICING.creditTokens).toBe(TOKENS_PER_CREDIT);
    expect(inferenceCatalogResponse({ inputWeight: 1, outputWeight: 4 })).toMatchObject({ defaultModel: "low", creditTokens: 1000 });
  });

  it("never thinks: every upstream names its switch, and the menu offers no effort", () => {
    for (const m of INFERENCE_MODELS) {
      for (const u of Object.values(m.upstream)) expect(u.thinkingOff).toBeTypeOf("object");
      expect(m.maxOutputTokens).toBeGreaterThanOrEqual(16_384);
    }
    for (const m of inferenceCatalog()) expect(m.reasoning).toBe(false);
    const low = INFERENCE_MODELS.find((m) => m.id === "low")!;
    expect(low.upstream.deepinfra!.thinkingOff).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(low.upstream.openrouter!.thinkingOff).toEqual({ reasoning: { effort: "none" } });
  });

  it("resolves a call's model for the shim, unknown ids to the default", () => {
    const m = resolveInferenceModel("medium");
    expect(m).toMatchObject({
      id: "medium",
      multiplier: 1,
      modalities: ["text"],
      maxOutputTokens: 32_768,
      visionAlternative: "Medium multimodal 2× (GLM-5.3-Flash)",
    });
    expect(m.upstream.openrouter).toEqual({
      id: "deepseek/deepseek-v4-flash",
      maxPriceIn: 0.09,
      maxPriceOut: 0.18,
      thinkingOff: { reasoning: { effort: "none" } },
    });
    expect(m.upstream.deepinfra!.thinkingOff).toEqual({ reasoning_effort: "none" });
    expect(resolveInferenceModel("high").maxOutputTokens).toBe(24_576);
    expect(resolveInferenceModel("flagship-free").id).toBe("low");
    expect(chargeMultiplier("high")).toBe(3.5);
    expect(chargeMultiplier(undefined)).toBe(1);
    expect(chargeMultiplier("no-such-model")).toBe(3.5);
  });
});

describe("metering charges the multiplier", () => {
  const SECRET = "s";
  const deps = () => ({ meter: new InMemoryMeterStorage(), tiers: new InMemoryTierStorage() });

  it("charges weighted tokens × multiplier against the week", async () => {
    const d = deps();
    const after = await recordFreeAiUsage(d, "alice", 1000, 100, 3.5);
    // (1000 + 100 × 4) × 3.5 = 4,900
    expect(after.week.used).toBe(4900);
    const plain = await recordFreeAiUsage(deps(), "bob", 1000, 100);
    expect(plain.week.used).toBe(1400);
  });

  it("the allowance check names the model, its multiplier and how credits are counted", async () => {
    const d = { ...deps(), tokenSecret: SECRET };
    const token = await mintScopedInferenceToken(
      { username: "alice", keyId: "k", iat: Date.now(), exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    const r = await handleFreeAiAllowance(d, { token, model: "high" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      model: { id: "high", multiplier: 3.5, upstream: { deepinfra: { id: "MiniMaxAI/MiniMax-M3" } } },
      inputWeight: 1,
      outputWeight: 4,
      creditTokens: 1000,
    });
  });
});

describe("the capability table", () => {
  const catalog = (ids: string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: ids.map((id) => ({
        id,
        name: id,
        context_length: 100_000,
        architecture: { input_modalities: ["text"] },
        supported_parameters: ["tools"],
        pricing: { prompt: "0.000001", completion: "0.000002" },
      })),
    }),
  });
  const ids = Array.from({ length: 25 }, (_, i) => `vendor/model-${i}`);

  it("starts quiet, then logs and lists models that appear later", async () => {
    const store = new InMemoryModelCapabilityStore();
    const logs: string[] = [];
    const day = 24 * 60 * 60_000;
    const first = await refreshModelCapabilities({ store, fetch: async () => catalog(ids), now: 1_000 * day, log: (m) => logs.push(m) });
    expect(first).toEqual({ total: 25, added: [] });
    const second = await refreshModelCapabilities({
      store,
      fetch: async () => catalog([...ids, "newco/shiny-1"]),
      now: 1_001 * day,
      log: (m) => logs.push(m),
    });
    expect(second.added).toEqual(["newco/shiny-1"]);
    expect(logs.join()).toContain("newco/shiny-1");
    const admin = await handleNewModelCapabilities({ store, now: 1_001 * day });
    expect((admin.body as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual(["newco/shiny-1"]);
    const served = await handleModelCapabilities({ store, now: 1_001 * day });
    expect((served.body as { models: unknown[] }).models).toHaveLength(26);
    // A model gone from the catalog for over three days stops being served.
    await refreshModelCapabilities({ store, fetch: async () => catalog(ids), now: 1_005 * day });
    const later = await handleModelCapabilities({ store, now: 1_005 * day });
    expect((later.body as { models: Array<{ id: string }> }).models.map((m) => m.id)).not.toContain("newco/shiny-1");
  });

  it("refuses a broken catalog rather than emptying the table", async () => {
    const store = new InMemoryModelCapabilityStore();
    await expect(refreshModelCapabilities({ store, fetch: async () => catalog(["a/b"]), now: 1 })).rejects.toThrow();
    await expect(
      refreshModelCapabilities({ store, fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }), now: 1 }),
    ).rejects.toThrow();
    expect(await store.count()).toBe(0);
  });
});
