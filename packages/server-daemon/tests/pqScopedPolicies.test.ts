import { describe, expect, it } from "vitest";
import { LlmHarness, connectorIdFor } from "../src/llmHarness.js";

describe("connector gate (architecture v2 §13.6)", () => {
  it("names Flagship Inference and own keys as the clients do", () => {
    expect(connectorIdFor({ provider: "openai", source: "promo" })).toBe("ai-flagship-inference");
    expect(connectorIdFor({ provider: "OpenAI", source: "byok" })).toBe("ai-openai");
  });

  it("refuses a blocked provider before anything leaves the box", async () => {
    let called = 0;
    const h = new LlmHarness({
      swk: {} as never,
      connectorGate: (id) => (id === "ai-openai" ? "blocked by the owner" : null),
      fetchImpl: async () => {
        called++;
        throw new Error("network");
      },
    });
    await expect(h.chatWithCredential({ provider: "openai", apiKey: "k" } as never, { model: "m", messages: [] } as never)).rejects.toThrow("blocked by the owner");
    const events: unknown[] = [];
    const out = await h.chatStream({ provider: "openai", apiKey: "k" } as never, { model: "m", messages: [] } as never, (e) => events.push(e));
    expect(out).toEqual({ ok: false, reason: "connector-blocked", message: "blocked by the owner" });
    expect(called).toBe(0);
  });
});
