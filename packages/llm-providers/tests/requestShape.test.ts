import { beforeEach, describe, expect, it } from "vitest";
import {
  anthropic,
  anthropicStreaming,
  forgetRequestShapeLessons,
  lessonFromRejection,
  openai,
  openaiStreaming,
  openrouter,
  ProviderError,
  type ChatRequest,
  type FetchLike,
  type StreamingFetchLike,
} from "../src/index.js";

const OK = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  model: "gpt-5",
};

const NO_MAX_TOKENS = JSON.stringify({
  error: {
    message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error",
    param: "max_tokens",
    code: "unsupported_parameter",
  },
});

/** A fake server that rejects bodies `reject` returns an error for. */
function server(reject: (body: Record<string, unknown>) => string | null, okBody: unknown = OK) {
  const bodies: Record<string, unknown>[] = [];
  const f: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body!) as Record<string, unknown>;
    bodies.push(body);
    const err = reject(body);
    return {
      ok: err == null,
      status: err == null ? 200 : 400,
      text: async () => err ?? JSON.stringify(okBody),
      json: async () => okBody,
    };
  };
  return { f, bodies };
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "gpt-5",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16000,
  ...over,
});

beforeEach(() => forgetRequestShapeLessons());

describe("request shape: learning what a provider accepts", () => {
  it("sends api.openai.com max_completion_tokens first", async () => {
    const { f, bodies } = server(() => null);
    await openai.chat(req(), { apiKey: "k" }, f);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 16000 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it("retries with max_completion_tokens when an OpenAI-compatible server refuses max_tokens, and remembers", async () => {
    const { f, bodies } = server((b) => ("max_tokens" in b ? NO_MAX_TOKENS : null));
    const cfg = { apiKey: "k", baseUrl: "https://proxy.example.com" };
    const r = await openai.chat(req(), cfg, f);
    expect(r.content).toBe("hi");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 16000 });

    await openai.chat(req(), cfg, f);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("max_tokens");
  });

  it("goes back to max_tokens for a server that doesn't know max_completion_tokens", async () => {
    const { f, bodies } = server((b) =>
      "max_completion_tokens" in b ? JSON.stringify({ error: { message: "Unrecognized request argument supplied: max_completion_tokens" } }) : null,
    );
    await openai.chat(req(), { apiKey: "k" }, f);
    expect(bodies[1]).toMatchObject({ max_tokens: 16000 });
  });

  it("drops a temperature the model won't take", async () => {
    const { f, bodies } = server((b) =>
      "temperature" in b
        ? JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", param: "temperature" } })
        : null,
    );
    await openai.chat(req({ temperature: 0.2 }), { apiKey: "k" }, f);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("caps the output tokens at the ceiling the model states", async () => {
    const { f, bodies } = server((b) =>
      (b.max_completion_tokens as number) > 4096
        ? JSON.stringify({ error: { message: "max_tokens is too large: 16000. This model supports at most 4096 completion tokens, whereas you provided 16000.", param: "max_tokens" } })
        : null,
    );
    await openai.chat(req({ model: "gpt-4-0613" }), { apiKey: "k" }, f);
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 4096 });
  });

  it("caps Claude's max_tokens to the model's ceiling", async () => {
    const msg = { content: [{ type: "text", text: "hi" }], model: "claude-haiku", stop_reason: "end_turn", usage: {} };
    const { f, bodies } = server(
      (b) =>
        (b.max_tokens as number) > 8192
          ? JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022" } })
          : null,
      msg,
    );
    await anthropic.chat(req({ model: "claude-haiku", maxTokens: undefined }), { apiKey: "k" }, f);
    expect(bodies[0]).toMatchObject({ max_tokens: 32000 });
    expect(bodies[1]).toMatchObject({ max_tokens: 8192 });
  });

  it("doesn't retry an error that isn't about a parameter", async () => {
    const { f, bodies } = server(() => JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    await expect(openai.chat(req(), { apiKey: "k" }, f)).rejects.toBeInstanceOf(ProviderError);
    expect(bodies).toHaveLength(1);
  });

  it("never drops the model or the messages", () => {
    const body = { model: "x", messages: [] };
    expect(lessonFromRejection(body, 400, JSON.stringify({ error: { message: "model not supported", param: "model" } }))).toBeNull();
    expect(lessonFromRejection(body, 400, JSON.stringify({ error: { message: "messages: invalid" } }))).toBeNull();
  });

  it("OpenRouter learns the same way", async () => {
    const { f, bodies } = server((b) => ("max_tokens" in b ? NO_MAX_TOKENS : null));
    await openrouter.chat(req(), { apiKey: "k" }, f);
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 16000 });
  });

  it("the streaming adapters retry before streaming", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f: StreamingFetchLike = async (_url, init) => {
      const body = JSON.parse(init!.body!) as Record<string, unknown>;
      bodies.push(body);
      const bad = "max_tokens" in body;
      return {
        ok: !bad,
        status: bad ? 400 : 200,
        text: async () => (bad ? NO_MAX_TOKENS : ""),
        lines: async function* () {
          yield `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`;
          yield "data: [DONE]";
        },
      };
    };
    const events: string[] = [];
    await openaiStreaming.chatStream(req(), { apiKey: "k", baseUrl: "https://proxy.example.com" }, (e) => events.push(e.kind), f);
    expect(bodies).toHaveLength(2);
    expect(events).toEqual(["delta", "end"]);

    const claudeBodies: Record<string, unknown>[] = [];
    const g: StreamingFetchLike = async (_url, init) => {
      const body = JSON.parse(init!.body!) as Record<string, unknown>;
      claudeBodies.push(body);
      const bad = (body.max_tokens as number) > 8192;
      return {
        ok: !bad,
        status: bad ? 400 : 200,
        text: async () => (bad ? JSON.stringify({ error: { message: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens" } }) : ""),
        lines: async function* () {},
      };
    };
    await anthropicStreaming.chatStream(req({ model: "claude-x", maxTokens: undefined }), { apiKey: "k" }, () => {}, g);
    expect(claudeBodies.map((b) => b.max_tokens)).toEqual([32000, 8192]);
  });
});
