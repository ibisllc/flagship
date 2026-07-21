import { describe, expect, it } from "vitest";
import {
  flagship,
  flagshipStreaming,
  defaultRegistry,
  defaultStreamingRegistry,
  type ChatRequest,
  type ChatStreamEvent,
  type FetchLike,
  type StreamingFetchLike,
} from "../src/index.js";

const req: ChatRequest = {
  model: "flagship-coder-v1",
  messages: [
    { role: "system", content: "you are flagship" },
    { role: "user", content: "hello" },
  ],
  tools: [{ name: "read_file", description: "read a file", inputSchema: { type: "object" } }],
};

describe("flagship provider (in-house inference posture)", () => {
  it("is registered in both the blocking + streaming registries", () => {
    expect(defaultRegistry.has("flagship")).toBe(true);
    expect(defaultStreamingRegistry.has("flagship")).toBe(true);
  });

  it("posts to the credential baseUrl's /v1/chat/completions with a Bearer token (OpenAI-compatible)", async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const f: FetchLike = async (url, init) => {
      captured = { url, headers: init?.headers ?? {}, body: JSON.parse(init!.body as string) };
      return {
        ok: true,
        status: 200,
        async text() { return ""; },
        async json() {
          return {
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            model: "flagship-coder-v1",
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          };
        },
      };
    };
    const res = await flagship.chat(req, { apiKey: "scoped-token", baseUrl: "https://infer.example.com" }, f);
    expect(res.content).toBe("hi");
    expect(captured!.url).toBe("https://infer.example.com/v1/chat/completions");
    expect(captured!.headers.authorization).toBe("Bearer scoped-token");
    // Tools are forwarded in OpenAI shape (agentic path).
    expect((captured!.body as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it("streams deltas + tool_calls via the OpenAI SSE mapping", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ];
    const f: StreamingFetchLike = async () => ({
      ok: true,
      status: 200,
      async text() { return ""; },
      lines() {
        return (async function* () { for (const l of lines) yield l; })();
      },
    });
    const events: ChatStreamEvent[] = [];
    await flagshipStreaming.chatStream(req, { apiKey: "scoped-token", baseUrl: "https://infer.example.com" }, (e) => events.push(e), f);
    expect(events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text).join("")).toBe("hello");
    const tool = events.find((e) => e.kind === "tool_use");
    expect(tool).toMatchObject({ name: "read_file", id: "c1" });
    expect(events.at(-1)).toMatchObject({ kind: "end" });
  });
});
