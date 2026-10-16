import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  D1ModelCapabilityStore,
  forgetInferenceSettings,
  handleInferenceModelRoutes,
  loadInferenceSettings,
} from "../src/inferenceModelRoutes.js";

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://flagshipserver.com${path}`, { headers });

describe("AI model menu routes", () => {
  it("serves the Flagship Inference catalog, cacheable", async () => {
    const res = await handleInferenceModelRoutes(get("/api/inference/models"), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as { models: Array<{ id: string; label: string }>; defaultModel: string; outputWeight: number };
    expect(body.defaultModel).toBe("medium-vision");
    expect(body.outputWeight).toBe(4);
    expect(body.models.map((m) => m.id)).toEqual(["medium", "medium-vision", "high"]);
  });

  it("changes the menu from the admin settings, without a deploy", async () => {
    const sqlite = createSqliteD1();
    forgetInferenceSettings();
    try {
      const env = { DB: sqlite as unknown as D1Database, FLAGSHIP_ADMIN_SECRET: "adm" };
      const put = (body: unknown, headers: Record<string, string> = { "x-admin-secret": "adm" }) =>
        handleInferenceModelRoutes(
          new Request("https://flagshipserver.com/api/admin/inference-settings", {
            method: "PUT",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          }),
          env,
        );
      expect((await handleInferenceModelRoutes(get("/api/admin/inference-settings"), env)).status).toBe(401);
      expect((await put({ settings: {}, note: "x" }, {})).status).toBe(401);
      expect((await put({ settings: { defaultModel: "low" }, note: "x" })).status).toBe(400);

      const ok = await put({
        settings: { defaultModel: "high", models: { low: { enabled: true } }, allowance: { weeklyTokens: 750_000 } },
        note: "owners ran out mid-edit",
      });
      expect(ok.status).toBe(200);
      const menu = (await (await handleInferenceModelRoutes(get("/api/inference/models"), env)).json()) as {
        defaultModel: string;
        models: Array<{ id: string; multiplier: number }>;
      };
      expect(menu.defaultModel).toBe("high");
      expect(menu.models.map((m) => [m.id, m.multiplier])).toEqual([
        ["low", 3],
        ["medium", 1],
        ["medium-vision", 2],
        ["high", 3.5],
      ]);
      expect(await loadInferenceSettings(env)).toMatchObject({ allowance: { weeklyTokens: 750_000 } });

      const view = (await (await handleInferenceModelRoutes(get("/api/admin/inference-settings", { "x-admin-secret": "adm" }), env)).json()) as {
        effective: { allowance: { weeklyCredits: number } };
        history: Array<{ note: string }>;
      };
      expect(view.effective.allowance.weeklyCredits).toBe(750);
      expect(view.history.map((h) => h.note)).toEqual(["owners ran out mid-edit"]);
    } finally {
      forgetInferenceSettings();
      sqlite.close();
    }
  });

  it("falls back to the shipped defaults when the stored row no longer validates", async () => {
    const sqlite = createSqliteD1();
    forgetInferenceSettings();
    try {
      const db = sqlite as unknown as D1Database;
      await db
        .prepare("INSERT INTO inference_settings (settings, note, set_at) VALUES (?, ?, ?)")
        .bind(JSON.stringify({ defaultModel: "a-model-since-removed" }), "old", 1)
        .run();
      expect(await loadInferenceSettings({ DB: db })).toBeNull();
    } finally {
      forgetInferenceSettings();
      sqlite.close();
    }
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
