import { describe, it, expect } from "vitest";
import {
  anthropic,
  openai,
  google,
  openrouter,
  ollama,
  defaultRegistry,
  ProviderError,
  type FetchLike,
  type ChatRequest,
} from "../src/index.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(jsonResponse: unknown, status = 200): { f: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return typeof jsonResponse === "string" ? jsonResponse : JSON.stringify(jsonResponse);
      },
      async json() {
        return jsonResponse;
      },
    };
  };
  return { f, calls };
}

const baseReq: ChatRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "you are flagship" },
    { role: "user", content: "hello" },
  ],
  maxTokens: 100,
  temperature: 0.5,
};

describe("anthropic provider", () => {
  it("posts to /v1/messages with x-api-key, splits system from messages, returns text content", async () => {
    const { f, calls } = fakeFetch({
      content: [{ type: "text", text: "hi there" }],
      model: "test-model",
      usage: { input_tokens: 4, output_tokens: 2 },
      stop_reason: "end_turn",
    });
    const out = await anthropic.chat(baseReq, { apiKey: "sk-test" }, f);
    expect(out.content).toBe("hi there");
    expect(out.inputTokens).toBe(4);
    expect(out.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["x-api-key"]).toBe("sk-test");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect((c.body as { system: string }).system).toBe("you are flagship");
    expect((c.body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("throws ProviderError on non-2xx", async () => {
    const { f } = fakeFetch("rate limited", 429);
    await expect(anthropic.chat(baseReq, { apiKey: "x" }, f)).rejects.toBeInstanceOf(ProviderError);
  });

  it("honors custom baseUrl (proxy / staging endpoint)", async () => {
    const { f, calls } = fakeFetch({ content: [{ type: "text", text: "ok" }], model: "m" });
    await anthropic.chat(baseReq, { apiKey: "x", baseUrl: "https://proxy.example" }, f);
    expect(calls[0]!.url).toBe("https://proxy.example/v1/messages");
  });
});

describe("openai provider", () => {
  it("posts to /v1/chat/completions with bearer auth and chat-style messages", async () => {
    const { f, calls } = fakeFetch({
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      model: "gpt-test",
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const out = await openai.chat(baseReq, { apiKey: "sk-oa" }, f);
    expect(out.content).toBe("hello world");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-oa");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.body as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it("rejects empty choices", async () => {
    const { f } = fakeFetch({ choices: [], model: "m" });
    await expect(openai.chat(baseReq, { apiKey: "x" }, f)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("google (gemini) provider", () => {
  it("translates assistant→model role and lifts system into systemInstruction", async () => {
    const { f, calls } = fakeFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    });
    const req: ChatRequest = {
      model: "gemini-test",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    };
    const out = await google.chat(req, { apiKey: "g-key" }, f);
    expect(out.content).toBe("ok");
    const body = calls[0]!.body as {
      contents: { role: string }[];
      systemInstruction: { parts: { text: string }[] };
    };
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.systemInstruction.parts[0]!.text).toBe("be brief");
    expect(calls[0]!.url).toContain("/v1beta/models/gemini-test:generateContent");
    expect(calls[0]!.url).toContain("key=g-key");
  });
});

describe("openrouter provider", () => {
  it("posts OpenAI-shaped body to openrouter.ai", async () => {
    const { f, calls } = fakeFetch({
      choices: [{ message: { content: "hey" }, finish_reason: "stop" }],
      model: "anthropic/claude",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const out = await openrouter.chat(baseReq, { apiKey: "or-test" }, f);
    expect(out.content).toBe("hey");
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer or-test");
    expect(calls[0]!.headers["x-title"]).toBe("Flagship");
  });
});

describe("ollama provider", () => {
  it("posts to /api/chat with stream:false and parses message.content", async () => {
    const { f, calls } = fakeFetch({
      message: { content: "from local" },
      model: "llama3",
      done_reason: "stop",
      prompt_eval_count: 7,
      eval_count: 3,
    });
    const out = await ollama.chat(baseReq, { apiKey: "" }, f);
    expect(out.content).toBe("from local");
    expect(out.outputTokens).toBe(3);
    expect((calls[0]!.body as { stream: boolean }).stream).toBe(false);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("attaches bearer auth when apiKey is provided (for remote ollama proxies)", async () => {
    const { f, calls } = fakeFetch({ message: { content: "x" }, model: "m" });
    await ollama.chat(baseReq, { apiKey: "remote-token", baseUrl: "https://ollama.home" }, f);
    expect(calls[0]!.headers.authorization).toBe("Bearer remote-token");
  });
});

describe("ProviderRegistry", () => {
  it("ships the five built-in providers", () => {
    expect(defaultRegistry.list().sort()).toEqual(
      ["anthropic", "google", "ollama", "openai", "openrouter"].sort()
    );
  });

  it("throws on unknown providers — no silent fallback", () => {
    expect(() => defaultRegistry.get("not-real")).toThrow(/unknown provider/);
  });

  it("supports registering custom providers (escape hatch for future adapters)", () => {
    const custom = {
      name: "custom",
      async chat() {
        return { content: "fixed", model: "x" };
      },
    };
    defaultRegistry.register(custom);
    expect(defaultRegistry.has("custom")).toBe(true);
  });
});
