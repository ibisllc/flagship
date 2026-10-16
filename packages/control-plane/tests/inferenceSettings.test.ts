import { describe, expect, it } from "vitest";
import {
  INFERENCE_SETTINGS_DEFAULTS,
  InMemoryInferenceSettingsStore,
  chargeMultiplier,
  freeAiConfigFrom,
  handleGetInferenceSettings,
  handlePutInferenceSettings,
  inferenceCatalog,
  inferenceLineup,
  parseInferenceSettings,
  resolveInferenceModel,
} from "../src/index.js";

describe("the lineup comes from the settings over the shipped defaults", () => {
  it("ships GLM as the default and Low off at 3×", () => {
    expect(INFERENCE_SETTINGS_DEFAULTS).toEqual({
      defaultModel: "medium-vision",
      models: { low: { enabled: false, multiplier: 3 } },
    });
    const l = inferenceLineup();
    expect(l.defaultModel).toBe("medium-vision");
    expect(l.entries.find((e) => e.id === "low")).toMatchObject({ enabled: false, multiplier: 3, computedMultiplier: 1 });
  });

  it("turns a model back on with its set price, overrides a multiplier and a description", () => {
    const l = inferenceLineup({
      defaultModel: "high",
      models: { low: { enabled: true }, high: { multiplier: 4, descriptor: "Best for big apps." } },
    });
    const cat = inferenceCatalog(l);
    expect(cat.map((m) => [m.id, m.multiplier, m.default ?? false])).toEqual([
      ["low", 3, false],
      ["medium", 1, false],
      ["medium-vision", 2, false],
      ["high", 4, true],
    ]);
    expect(cat.find((m) => m.id === "high")).toMatchObject({ label: "High 4× (MiniMax-M3)", descriptor: "Best for big apps." });
    expect(chargeMultiplier("high", l)).toBe(4);
    expect(resolveInferenceModel("low", l)).toMatchObject({ id: "low", multiplier: 3 });
  });

  it("doesn't point a text model at a vision model that is off", () => {
    const l = inferenceLineup({ defaultModel: "high", models: { "medium-vision": { enabled: false } } });
    expect(inferenceCatalog(l).find((m) => m.id === "medium")!.visionAlternative).toBeUndefined();
    expect(resolveInferenceModel("medium", l).visionAlternative).toBeUndefined();
    expect(resolveInferenceModel("medium-vision", l).id).toBe("high");
    expect(inferenceCatalog().find((m) => m.id === "medium")!.visionAlternative).toBe("medium-vision");
  });

  it("layers the allowance: shipped defaults, then the env, then the settings", () => {
    const env = { AI_PROMO_WEEKLY_TOKENS: "600000", AI_PROMO_ENDS_AT: "2027-01-01T00:00:00Z" };
    expect(freeAiConfigFrom(env, null)).toMatchObject({ starterTokens: 2_000_000, weeklyTokens: 600_000 });
    const cfg = freeAiConfigFrom(env, { allowance: { weeklyTokens: 750_000, outputWeight: 5, endsAt: null } });
    expect(cfg).toMatchObject({ starterTokens: 2_000_000, weeklyTokens: 750_000, outputWeight: 5, endsAt: null });
    expect(freeAiConfigFrom({}, { allowance: { endsAt: "2027-02-01T00:00:00.000Z" } }).endsAt).toBe(Date.parse("2027-02-01T00:00:00Z"));
  });
});

describe("a settings change is checked before it is stored", () => {
  const bad = (raw: unknown) => {
    const r = parseInferenceSettings(raw);
    return r.ok ? null : r.error;
  };

  it("accepts a well-formed change and normalises it", () => {
    const r = parseInferenceSettings({
      defaultModel: "high",
      models: { high: { multiplier: 4.5, descriptor: "  Strongest.  " } },
      allowance: { weeklyTokens: 750_000, endsAt: "2027-01-01" },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        defaultModel: "high",
        models: { high: { multiplier: 4.5, descriptor: "Strongest." } },
        allowance: { weeklyTokens: 750_000, endsAt: "2027-01-01T00:00:00.000Z" },
      },
    });
    expect(parseInferenceSettings({})).toEqual({ ok: true, value: {} });
  });

  it("refuses unknown models and fields, and out-of-range numbers", () => {
    expect(bad({ defaultModel: "gpt" })).toContain("defaultModel must be one of");
    expect(bad({ models: { gpt: { enabled: true } } })).toContain('no catalog model "gpt"');
    expect(bad({ models: { high: { enabled: "yes" } } })).toContain("enabled must be true or false");
    expect(bad({ models: { high: { multiplier: 0.5 } } })).toContain("multiplier must be 1–20 in steps of 0.5");
    expect(bad({ models: { high: { multiplier: 3.3 } } })).toContain("steps of 0.5");
    expect(bad({ models: { high: { price: 1 } } })).toContain("unknown field price");
    expect(bad({ allowance: { weeklyTokens: -1 } })).toContain("allowance.weeklyTokens");
    expect(bad({ allowance: { weeklyTokens: 1.5 } })).toContain("allowance.weeklyTokens");
    expect(bad({ allowance: { endsAt: "soon" } })).toContain("ISO 8601");
    expect(bad({ models: {}, extra: 1 })).toContain("unknown field extra");
    expect(bad([])).toBe("settings must be an object");
  });

  it("refuses a lineup that can't serve: default off, or nothing on", () => {
    expect(bad({ models: { "medium-vision": { enabled: false } } })).toContain('default model "medium-vision" is turned off');
    expect(bad({ defaultModel: "low" })).toContain('default model "low" is turned off');
    expect(bad({ defaultModel: "low", models: { low: { enabled: true } } })).toBeNull();
    expect(
      bad({ models: { medium: { enabled: false }, "medium-vision": { enabled: false }, high: { enabled: false } } }),
    ).toBe("at least one model must be on");
  });
});

describe("the admin endpoint", () => {
  const deps = () => ({ store: new InMemoryInferenceSettingsStore(), env: { AI_PROMO_DAILY_CAP_TOKENS: "40000000" }, now: () => 1_800_000_000_000 });

  it("shows what's in force in tokens and credits, before anything is stored", async () => {
    const r = await handleGetInferenceSettings(deps());
    const body = r.body as {
      effective: { defaultModel: string; models: Array<{ id: string; enabled: boolean }>; allowance: Record<string, unknown> };
      stored: unknown;
      history: unknown[];
    };
    expect(body.stored).toBeNull();
    expect(body.history).toEqual([]);
    expect(body.effective.defaultModel).toBe("medium-vision");
    expect(body.effective.models.map((m) => [m.id, m.enabled])).toEqual([
      ["low", false],
      ["medium", true],
      ["medium-vision", true],
      ["high", true],
    ]);
    expect(body.effective.allowance).toMatchObject({
      starterCredits: 2000,
      weeklyCredits: 500,
      dailyCapTokens: 40_000_000,
      dailyCapCredits: 40_000,
      endsAt: null,
    });
  });

  it("stores a change with its note, keeps the history, and previews without storing", async () => {
    const d = deps();
    const preview = await handlePutInferenceSettings(d, {
      settings: { allowance: { weeklyTokens: 750_000 } },
      note: "owners ran out mid-edit",
      preview: true,
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { effective: { allowance: { weeklyCredits: number } } }).effective.allowance.weeklyCredits).toBe(750);
    expect(d.store.rows).toHaveLength(0);

    const first = await handlePutInferenceSettings(d, { settings: { allowance: { weeklyTokens: 750_000 } }, note: "owners ran out mid-edit" });
    expect(first.status).toBe(200);
    await handlePutInferenceSettings(d, { settings: { models: { high: { multiplier: 4 } } }, note: "High costs more than we charge" });
    const body = (await handleGetInferenceSettings(d)).body as {
      effective: { allowance: { weeklyCredits: number }; models: Array<{ id: string; multiplier: number }> };
      stored: { note: string; settings: unknown };
      history: Array<{ note: string }>;
    };
    // Each PUT replaces the whole stored document: the weekly change is gone.
    expect(body.effective.allowance.weeklyCredits).toBe(500);
    expect(body.effective.models.find((m) => m.id === "high")!.multiplier).toBe(4);
    expect(body.stored).toMatchObject({ note: "High costs more than we charge", settings: { models: { high: { multiplier: 4 } } } });
    expect(body.history.map((h) => h.note)).toEqual(["High costs more than we charge", "owners ran out mid-edit"]);
  });

  it("refuses a bad change or one without a reason", async () => {
    const d = deps();
    expect((await handlePutInferenceSettings(d, { settings: { defaultModel: "low" }, note: "x" })).status).toBe(400);
    const noNote = await handlePutInferenceSettings(d, { settings: {} });
    expect(noNote.status).toBe(400);
    expect((noNote.body as { error: string }).error).toContain("note must say why");
    expect((await handlePutInferenceSettings(d, "nope")).status).toBe(400);
    expect(d.store.rows).toHaveLength(0);
  });
});
