import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { D1ModelCapabilityStore, handleInferenceModelRoutes } from "../src/inferenceModelRoutes.js";

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://flagshipserver.com${path}`, { headers });

describe("AI model menu routes", () => {
  it("serves the Flagship Inference catalog, cacheable", async () => {
    const res = await handleInferenceModelRoutes(get("/api/inference/models"), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as { models: Array<{ id: string; label: string }>; defaultModel: string; outputWeight: number };
    expect(body.defaultModel).toBe("low");
    expect(body.outputWeight).toBe(4);
    expect(body.models[0]!.label).toBe("Low 1× (Qwen3.6-35B-A3B)");
  });

  it("serves the capability table from D1 and keeps the new-model view behind the admin secret", async () => {
    const sqlite = createSqliteD1();
    try {
      const db = sqlite as unknown as D1Database;
      const store = new D1ModelCapabilityStore(db);
      const now = Date.now();
      await store.upsert([
        { capability: { id: "openai/gpt-5.4-mini", name: "Mini", contextTokens: 400000, input: ["text", "image"], tools: true }, firstSeen: 0, lastSeen: now },
        { capability: { id: "newco/shiny", name: "Shiny", contextTokens: 1000, input: ["text"], tools: true }, firstSeen: now, lastSeen: now },
      ]);
      // A second upsert keeps first_seen.
      await store.upsert([{ capability: { id: "newco/shiny", name: "Shiny 2", contextTokens: 1000, input: ["text"], tools: true }, firstSeen: now + 5, lastSeen: now }]);
      const env = { DB: db, FLAGSHIP_ADMIN_SECRET: "adm" };
      const caps = await handleInferenceModelRoutes(get("/api/inference/capabilities"), env);
      const body = (await caps.json()) as { models: Array<{ id: string; name: string }> };
      expect(body.models.map((m) => m.id)).toEqual(["newco/shiny", "openai/gpt-5.4-mini"]);
      expect(body.models[0]!.name).toBe("Shiny 2");
      expect((await handleInferenceModelRoutes(get("/api/admin/model-capabilities"), env)).status).toBe(401);
      const admin = await handleInferenceModelRoutes(get("/api/admin/model-capabilities", { "x-admin-secret": "adm" }), env);
      expect(((await admin.json()) as { models: Array<{ id: string; firstSeen: number }> }).models).toEqual([
        expect.objectContaining({ id: "newco/shiny", firstSeen: now }),
      ]);
    } finally {
      sqlite.close();
    }
  });
});
