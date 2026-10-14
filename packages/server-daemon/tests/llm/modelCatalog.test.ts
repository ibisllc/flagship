import { describe, expect, it } from "vitest";
import { ModelCatalog } from "../../src/llm/modelCatalog.js";

const CATALOG = {
  models: [
    { id: "low", tier: "Low", model: "Q", multiplier: 1, label: "Low 1× (Q)", descriptor: "", contextTokens: 262144, modalities: ["text", "image"], reasoning: true, default: true },
    { id: "medium", tier: "Medium", model: "D", multiplier: 1, label: "Medium 1× (D)", descriptor: "", contextTokens: 1000000, modalities: ["text"], reasoning: true },
  ],
  defaultModel: "low",
  creditTokens: 1000,
  inputWeight: 1,
  outputWeight: 4,
};
const CAPS = {
  fetchedAt: 1,
  models: [
    { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini", contextTokens: 400000, input: ["text", "image"], tools: true, reasoning: { efforts: ["low", "high"], defaultEffort: "low" } },
  ],
};

function catalog(now = { t: 0 }) {
  const fetched: string[] = [];
  let fail = false;
  const c = new ModelCatalog({
    baseUrl: "https://com.example/",
    now: () => now.t,
    fetch: async (url) => {
      fetched.push(url);
      if (fail) throw new Error("offline");
      return { ok: true, json: async () => (url.endsWith("/models") ? CATALOG : CAPS) };
    },
  });
  return { c, fetched, setFail: (v: boolean) => (fail = v), now };
}

describe("the box's model catalog", () => {
  it("knows each model's context: the catalog for Flagship Inference, the table for own keys", async () => {
    const { c } = catalog();
    expect(await c.contextTokens("flagship", "medium")).toBe(1000000);
    expect(await c.contextTokens("flagship", undefined)).toBe(262144);
    expect(await c.contextTokens("openai", "gpt-5.4-mini")).toBe(400000);
    expect(await c.contextTokens("openai", "unknown-model")).toBeUndefined();
  });

  it("caches for hours and keeps a stale copy when .com can't answer", async () => {
    const { c, fetched, setFail, now } = catalog();
    await c.inference();
    await c.inference();
    expect(fetched).toEqual(["https://com.example/api/inference/models"]);
    now.t += 7 * 60 * 60_000;
    setFail(true);
    expect((await c.inference())?.defaultModel).toBe("low");
  });

  it("builds an own-key menu from the key's list, and says when there's none", async () => {
    const { c } = catalog();
    const menu = await c.menu("openai", async () => ({ ok: true, models: [{ id: "gpt-5.4-mini" }, { id: "fresh-model" }] }), "gpt-5");
    expect(menu).toMatchObject({
      kind: "own",
      listed: true,
      defaultModel: "gpt-5",
      models: [
        { id: "gpt-5.4-mini", efforts: ["low", "high"], defaultEffort: "low", vision: true, known: true },
        { id: "fresh-model", known: false },
      ],
    });
    expect(await c.menu("openai", async () => ({ ok: false, reason: "no-list" }))).toMatchObject({ listed: false, reason: "no-list" });
    expect(await c.menu("flagship", async () => ({ ok: false, reason: "no-list" }))).toMatchObject({ kind: "flagship", catalog: { defaultModel: "low" } });
  });
});
