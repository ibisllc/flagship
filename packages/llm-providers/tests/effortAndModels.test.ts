import { describe, expect, it } from "vitest";
import {
  anthropic,
  flagshipStreaming,
  google,
  listProviderModels,
  openai,
  openaiStreaming,
  openrouter,
  type ChatRequest,
  type ChatStreamEvent,
  type FetchLike,
  type StreamingFetchLike,
} from "../src/index.js";

function capture(reply: unknown = { choices: [{ message: { content: "ok" } }], model: "m" }) {
  const calls: Array<{ url: string; body: any; headers?: Record<string, string> }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: init?.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(reply), json: async () => reply };
  };
  return { f, calls };
}

const withEffort: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }], reasoningEffort: "high" };

describe("reasoning effort goes in each provider's own parameter", () => {
  it("OpenAI: reasoning_effort", async () => {
    const { f, calls } = capture();
    await openai.chat(withEffort, { apiKey: "k" }, f);
    expect(calls[0]!.body.reasoning_effort).toBe("high");
  });

  it("OpenRouter: reasoning.effort", async () => {
    const { f, calls } = capture();
    await openrouter.chat(withEffort, { apiKey: "k" }, f);
    expect(calls[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("Anthropic: adaptive thinking with output_config.effort", async () => {
    const { f, calls } = capture({ content: [{ type: "text", text: "ok" }], model: "c" });
    await anthropic.chat({ ...withEffort, reasoningEffort: "xhigh" }, { apiKey: "k" }, f);
    expect(calls[0]!.body.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]!.body.output_config).toEqual({ effort: "xhigh" });
  });

  it("Gemini: thinkingConfig.thinkingLevel", async () => {
    const { f, calls } = capture({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await google.chat({ ...withEffort, reasoningEffort: "low" }, { apiKey: "k" }, f);
    expect(calls[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("no effort: nothing extra is sent", async () => {
    const { f, calls } = capture();
    await openai.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" }, f);
    expect(calls[0]!.body.reasoning_effort).toBeUndefined();
  });
});

describe("attachments on OpenAI-compatible and Gemini adapters", () => {
  const req: ChatRequest = {
    model: "m",
    messages: [
      {
        role: "user",
        content: "like this",
        attachments: [
          { kind: "image", mediaType: "image/png", dataBase64: "AAAA", name: "s.png" },
          { kind: "text", text: "a,b\n1,2", name: "data.csv" },
        ],
      },
    ],
  };

  it("OpenAI: an image_url data URL and a labelled text part", async () => {
    const { f, calls } = capture();
    await openai.chat(req, { apiKey: "k" }, f);
    expect(calls[0]!.body.messages[0].content).toEqual([
      { type: "text", text: "like this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "data.csv:\na,b\n1,2" },
    ]);
  });

  it("Gemini: inline_data", async () => {
    const { f, calls } = capture({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await google.chat(req, { apiKey: "k" }, f);
    expect(calls[0]!.body.contents[0].parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
  });
});

describe("Flagship Inference reports what a call cost", () => {
  it("reads the shim's credits chunk after [DONE]", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":100}}',
      "data: [DONE]",
      'data: {"object":"flagship.usage","credits":2.1}',
    ];
    const sf: StreamingFetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      async *lines() {
        yield* lines;
      },
    });
    const events: ChatStreamEvent[] = [];
    await flagshipStreaming.chatStream(
      { model: "low", messages: [{ role: "user", content: "x" }] },
      { apiKey: "t", baseUrl: "https://inference.example" },
      (e) => events.push(e),
      sf,
    );
    const end = events.find((e) => e.kind === "end");
    expect(end).toMatchObject({ kind: "end", credits: 2.1, usage: { inputTokens: 1000, outputTokens: 100 } });
  });

  it("asks for usage in the stream", async () => {
    let body: any;
    const sf: StreamingFetchLike = async (_u, init) => {
      body = JSON.parse(init!.body!);
      return { ok: true, status: 200, text: async () => "", async *lines() {} };
    };
    await openaiStreaming.chatStream({ model: "m", messages: [{ role: "user", content: "x" }] }, { apiKey: "k" }, () => {}, sf);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("listing a key's models", () => {
  function reply(status: number, body: unknown) {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
    };
    return { f, calls };
  }

  it("OpenAI-compatible: GET {base}/v1/models with the bearer key", async () => {
    const { f, calls } = reply(200, { data: [{ id: "gpt-5.4-mini" }, { id: "Qwen/Qwen3.6-35B-A3B", context_length: 262144 }] });
    const r = await listProviderModels("openai", { apiKey: "sk", baseUrl: "https://api.deepinfra.com/v1/openai" }, f);
    expect(calls[0]!.url).toBe("https://api.deepinfra.com/v1/openai/v1/models");
    expect(calls[0]!.headers?.authorization).toBe("Bearer sk");
    expect(r).toEqual({ ok: true, models: [{ id: "gpt-5.4-mini" }, { id: "Qwen/Qwen3.6-35B-A3B", contextTokens: 262144 }] });
  });

  it("Anthropic: x-api-key and display names", async () => {
    const { f, calls } = reply(200, { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1000000 }] });
    const r = await listProviderModels("anthropic", { apiKey: "ak" }, f);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(calls[0]!.headers?.["x-api-key"]).toBe("ak");
    expect(r).toEqual({ ok: true, models: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextTokens: 1000000 }] });
  });

  it("Google: only models that generate content", async () => {
    const { f } = reply(200, {
      models: [
        { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    const r = await listProviderModels("google", { apiKey: "g" }, f);
    expect(r).toEqual({ ok: true, models: [{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextTokens: 1048576 }] });
  });

  it("Ollama: its local tags", async () => {
    const { f, calls } = reply(200, { models: [{ name: "qwen3:32b" }] });
    const r = await listProviderModels("ollama", { apiKey: "", baseUrl: "http://192.168.1.5:11434" }, f);
    expect(calls[0]!.url).toBe("http://192.168.1.5:11434/api/tags");
    expect(r).toEqual({ ok: true, models: [{ id: "qwen3:32b" }] });
  });

  it("a host with no list, a rejected key, an unknown provider", async () => {
    expect(await listProviderModels("openai", { apiKey: "k", baseUrl: "https://x.example" }, reply(404, {}).f)).toMatchObject({ ok: false, reason: "no-list" });
    expect(await listProviderModels("openai", { apiKey: "k" }, reply(401, {}).f)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await listProviderModels("flagship", { apiKey: "k" }, reply(200, {}).f)).toEqual({ ok: false, reason: "no-list" });
  });
});
