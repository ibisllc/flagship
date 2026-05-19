import { describe, expect, it } from "vitest";
import { anthropicStreaming, type StreamingFetchLike } from "@flagship/llm-providers";
import { streamIntoSession } from "../../src/llm/streamIntoSession.js";
import { VibeCodeSession } from "../../src/llm/vibeCodeSession.js";

function streamingFakeFetch(lines: string[], status = 200, textBody = ""): StreamingFetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return textBody; },
    lines() {
      return (async function* () {
        for (const l of lines) yield l;
      })();
    },
  });
}

describe("streamIntoSession", () => {
  it("feeds streamed deltas into the session and ends cleanly", async () => {
    const session = new VibeCodeSession({
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
    });
    session.pushUserMessage("describe an app");

    const fetchFake = streamingFakeFetch([
      `data: {"type":"content_block_delta","delta":{"text":"=== flagship.app.json ===\\n"}}`,
      `data: {"type":"content_block_delta","delta":{"text":"{\\"schema_version\\":1}\\n"}}`,
      `data: {"type":"content_block_delta","delta":{"text":"=== END ===\\n"}}`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":12}}`,
      `data: {"type":"message_stop"}`,
    ]);

    const r = await streamIntoSession({
      session,
      provider: anthropicStreaming,
      request: { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
      config: { apiKey: "k" },
      fetchImpl: fetchFake,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage?.outputTokens).toBe(12);
    expect(session.meta.status).toBe("ready-to-deploy");
    expect(session.files()["flagship.app.json"]).toContain("schema_version");
  });

  it("forwards a streamed tool_use into session.receiveToolUse, pausing the session", async () => {
    const session = new VibeCodeSession({
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
    });
    session.pushUserMessage("describe an app");

    const fetchFake = streamingFakeFetch([
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"requestEnvVar","input":{}}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"OPENAI_API_KEY\\",\\"description\\":\\"oai\\",\\"why\\":\\"calls\\"}"}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
      `data: {"type":"message_stop"}`,
    ]);

    await streamIntoSession({
      session,
      provider: anthropicStreaming,
      request: { model: "claude", messages: [{ role: "user", content: "x" }] },
      config: { apiKey: "k" },
      fetchImpl: fetchFake,
    });
    expect(session.meta.status).toBe("awaiting-tool-response");
    expect(session.pendingToolUses()).toHaveLength(1);
    expect(session.pendingToolUses()[0]?.name).toBe("requestEnvVar");
  });

  it("marks the session failed when the provider stream errors", async () => {
    const session = new VibeCodeSession({
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
    });
    session.pushUserMessage("describe");

    const fetchFake = streamingFakeFetch([], 401, "unauthorized");
    const r = await streamIntoSession({
      session,
      provider: anthropicStreaming,
      request: { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
      config: { apiKey: "bad" },
      fetchImpl: fetchFake,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/unauthorized/);
    expect(session.meta.status).toBe("failed");
  });
});
