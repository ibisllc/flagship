/**
 * The model menu over the screens BFF: a key's menu, the owner's model and
 * effort on start and on each reply, credits per reply, and sample data
 * kept for the test copy.
 */
import { describe, expect, it } from "vitest";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import type { HttpRequest } from "../../src/runtime.js";
import type { LlmCredential } from "../../src/llmHarness.js";

const SERVER_FQDN = "home.alice.flagship.services";

function post(path: string, body: unknown): HttpRequest {
  return {
    method: "POST",
    path,
    headers: { "x-flagship-session": "tok", "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}
const get = (path: string): HttpRequest => ({ method: "GET", path, headers: { "x-flagship-session": "tok" }, body: Buffer.alloc(0) });

function build() {
  const reg = new VibeCodeSessionRegistry();
  const asked: LlmCredential[] = [];
  const started: Array<{ model?: string; effort?: string }> = [];
  const handle = buildScreensHttp({
    gate: {
      has: () => true,
      check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "{}" }),
    },
    serverFqdn: SERVER_FQDN,
    username: "alice",
    daemonVersion: "test",
    startedAt: 0,
    vibeCode: {
      registry: reg,
      username: "alice",
      serverFqdn: SERVER_FQDN,
      startStreaming: async (a) => void started.push({ ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) }),
      resumeStreaming: async () => {},
      aiModels: async (c) => {
        asked.push(c);
        return { provider: c.provider, kind: "own", listed: true, models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 Mini", vision: true, tools: true, known: true }] };
      },
    },
  });
  return { reg, handle, asked, started };
}

describe("screens BFF — model choice", () => {
  it("answers a key's model menu, and needs a credential", async () => {
    const { handle, asked } = build();
    const r = await handle(post("/api/screens/ai/models", { credential: { provider: "openai", apiKey: "sk-test" } }));
    expect(r?.status).toBe(200);
    expect(JSON.parse(r!.body as string)).toMatchObject({ kind: "own", models: [{ id: "gpt-5.4-mini" }] });
    expect(asked[0]).toMatchObject({ provider: "openai", apiKey: "sk-test" });
    expect((await handle(post("/api/screens/ai/models", {})))?.status).toBe(400);
  });

  it("keeps the model and effort from start, switches them on a reply, and shows credits", async () => {
    const { reg, handle, started } = build();
    const s = await handle(
      post("/api/screens/vibe-code/start", {
        prompt: "an orders app",
        model: "medium",
        effort: "high",
        credential: { provider: "flagship", apiKey: "pass", source: "promo" },
        attachments: [{ kind: "data", name: "orders.csv", mediaType: "text/csv", text: "id,total\n1,2\n" }],
      }),
    );
    expect(s?.status).toBe(200);
    expect(started).toEqual([{ model: "medium", effort: "high" }]);
    const { sessionId } = JSON.parse(s!.body as string) as { sessionId: string };
    const session = reg.get(sessionId)!;
    expect(session.sampleFiles()).toEqual({ "orders.csv": "id,total\n1,2\n" });

    // The model streams a question; Flagship Inference charges it.
    session.setModel("medium", "high");
    session.feedAssistant("Which currency?");
    session.recordCredits(2.8);
    session.receiveToolUse({ id: "q1", name: "talkToUser", input: { message: "Which currency?" } });
    const reply = await handle(
      post(`/api/screens/llm/sessions/${sessionId}/reply`, { text: "euros", model: "medium-vision", effort: null }),
    );
    expect(reply?.status).toBe(200);
    expect(session.meta.model).toBe("medium-vision");
    expect(session.meta.effort).toBeUndefined();

    const state = JSON.parse((await handle(get(`/api/screens/llm/sessions/${sessionId}`)))!.body as string);
    expect(state.model).toBe("medium-vision");
    expect(state.messages.find((m: { role: string }) => m.role === "assistant")).toMatchObject({ credits: 2.8 });
  });

  it("refuses a malformed model or effort on a reply", async () => {
    const { reg, handle } = build();
    const session = reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    session.pushUserMessage("x");
    session.receiveToolUse({ id: "q", name: "talkToUser", input: { message: "?" } });
    const r = await handle(post(`/api/screens/llm/sessions/${session.meta.sessionId}/reply`, { text: "y", effort: "HIGH; drop" }));
    expect(r?.status).toBe(400);
  });
});
