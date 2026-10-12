/**
 * POST /api/llm/sessions/:id/deploy may carry a fresh BYOK credential that
 * replaces the session's stored key before the staged loop runs, so a retry
 * after the owner turned the relay off uses the new setting.
 */
import { describe, expect, it } from "vitest";
import { TokenSetSessionGate } from "../../src/alertInboxHttp.js";
import { InMemoryBuildCredentialStore } from "../../src/llm/buildCredentialStore.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { buildVibeCodeHttpHandlers } from "../../src/llm/vibeCodeHttp.js";
import type { LlmCredential } from "../../src/llmHarness.js";
import type { HttpRequest } from "../../src/runtime.js";

const SECRET = "phone-paired-secret";
const post = (path: string, body?: object): HttpRequest => ({
  method: "POST",
  path,
  headers: { authorization: `Flagship-Session ${SECRET}` },
  body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
});

function setup(withStore = true) {
  const registry = new VibeCodeSessionRegistry();
  const credentials = new InMemoryBuildCredentialStore();
  const seen: Array<LlmCredential | null> = [];
  const journal: Array<{ sessionId: string; provider: string; relay: boolean }> = [];
  const handle = buildVibeCodeHttpHandlers({
    registry,
    gate: new TokenSetSessionGate(new Set([SECRET])),
    username: "alice",
    serverFqdn: "home.alice.flagship.services",
    deploySession: async (session) => {
      seen.push(await credentials.get(session.meta.sessionId));
      return { ok: true, serviceId: "alice-habits", url: "https://habits.alice.flagship.services" };
    },
    ...(withStore ? { credentials } : {}),
    onCredentialReplaced: (a) => journal.push(a),
  });
  return { registry, credentials, seen, journal, handle };
}

async function newSession(h: ReturnType<typeof setup>["handle"]): Promise<string> {
  const r = await h(post("/api/llm/sessions", { prompt: "habit tracker" }));
  return JSON.parse(String(r!.body)).sessionId as string;
}

describe("deploy with a refreshed credential", () => {
  it("replaces the stored key before the staged loop runs", async () => {
    const { credentials, seen, journal, handle } = setup();
    const sid = await newSession(handle);
    await credentials.put(sid, { provider: "anthropic", apiKey: "sk-old" });
    const r = await handle(post(`/api/llm/sessions/${sid}/deploy`, { credential: { provider: "anthropic", apiKey: "sk-new", relay: false } }));
    expect(r!.status).toBe(200);
    expect(seen).toEqual([{ provider: "anthropic", apiKey: "sk-new", relay: false }]);
    expect(journal).toEqual([{ sessionId: sid, provider: "anthropic", relay: false }]);
    expect(JSON.stringify(journal)).not.toContain("sk-new");
    expect(String(r!.body)).not.toContain("sk-new");
  });

  it("works on the background form too", async () => {
    const { seen, handle } = setup();
    const sid = await newSession(handle);
    const r = await handle(post(`/api/llm/sessions/${sid}/deploy`, { background: true, credential: { provider: "openai", apiKey: "sk-x" } }));
    expect(r!.status).toBe(202);
    await new Promise((res) => setImmediate(res));
    expect(seen).toEqual([{ provider: "openai", apiKey: "sk-x" }]);
  });

  it("without a credential the stored key stays", async () => {
    const { credentials, seen, journal, handle } = setup();
    const sid = await newSession(handle);
    await credentials.put(sid, { provider: "anthropic", apiKey: "sk-old" });
    expect((await handle(post(`/api/llm/sessions/${sid}/deploy`)))!.status).toBe(200);
    expect(seen).toEqual([{ provider: "anthropic", apiKey: "sk-old" }]);
    expect(journal).toEqual([]);
  });

  it("refuses a malformed credential without deploying", async () => {
    const { registry, seen, handle } = setup();
    const sid = await newSession(handle);
    for (const credential of [{ provider: "anthropic" }, { provider: "anthropic", apiKey: "k", relay: "yes" }, "sk"]) {
      const r = await handle(post(`/api/llm/sessions/${sid}/deploy`, { credential }));
      expect(r!.status).toBe(400);
    }
    expect(seen).toEqual([]);
    expect(registry.get(sid)?.meta.status).not.toBe("deploying");
  });

  it("503 when the box has nowhere to keep the key", async () => {
    const { handle, seen } = setup(false);
    const sid = await newSession(handle);
    const r = await handle(post(`/api/llm/sessions/${sid}/deploy`, { credential: { provider: "anthropic", apiKey: "k" } }));
    expect(r!.status).toBe(503);
    expect(seen).toEqual([]);
  });
});
