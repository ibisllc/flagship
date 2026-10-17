import { describe, expect, it } from "vitest";
import {
  anthropicStreaming,
  googleStreaming,
  openaiStreaming,
  openrouterStreaming,
  type ChatStreamEvent,
  type StreamingFetchLike,
} from "../src/index.js";
import { transientRetry } from "../src/providers/openai.js";

/**
 * Build a streaming fetch fake that yields the given pre-baked
 * lines. `text()` is the body for non-200 responses.
 */
function streamingFakeFetch(opts: {
  lines?: string[];
  status?: number;
  textBody?: string;
}): { f: StreamingFetchLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const status = opts.status ?? 200;
  const linesArr = opts.lines ?? [];
  const textBody = opts.textBody ?? "";
  const f: StreamingFetchLike = async (url, init) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return textBody; },
      lines() {
        return (async function* () {
          for (const l of linesArr) yield l;
        })();
      },
    };
  };
  return { f, calls };
}

describe("anthropicStreaming", () => {
  it("emits deltas for content_block_delta + an end with usage", async () => {
    const { f, calls } = streamingFakeFetch({
      lines: [
        "event: message_start",
        `data: {"type":"message_start"}`,
        "",
        "event: content_block_delta",
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`,
        "",
        "event: content_block_delta",
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}`,
        "",
        "event: message_delta",
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":7,"output_tokens":3}}`,
        "",
        "event: message_stop",
        `data: {"type":"message_stop"}`,
        "",
      ],
    });
    const events: ChatStreamEvent[] = [];
    await anthropicStreaming.chatStream(
      { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    expect(calls[0]?.url).toMatch(/\/v1\/messages$/);
    expect((calls[0]?.body as { stream?: boolean }).stream).toBe(true);
    expect(events.filter((e) => e.kind === "delta").map((e) => (e as { kind: "delta"; text: string }).text).join("")).toBe("Hello world");
    const end = events[events.length - 1];
    expect(end?.kind).toBe("end");
    if (end?.kind === "end") {
      expect(end.stopReason).toBe("end_turn");
      expect(end.usage?.inputTokens).toBe(7);
      expect(end.usage?.outputTokens).toBe(3);
    }
  });

  it("emits an error event on a non-200 response", async () => {
    const { f } = streamingFakeFetch({ status: 401, textBody: "unauthorized" });
    const events: ChatStreamEvent[] = [];
    await anthropicStreaming.chatStream(
      { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "bad" },
      (e) => events.push(e),
      f,
    );
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("error");
    if (events[0]?.kind === "error") {
      expect(events[0].status).toBe(401);
      expect(events[0].message).toContain("unauthorized");
    }
  });

  it("emits an error event when the SSE stream itself reports error", async () => {
    const { f } = streamingFakeFetch({
      lines: [
        "event: error",
        `data: {"type":"error","error":{"message":"overloaded"}}`,
        "",
      ],
    });
    const events: ChatStreamEvent[] = [];
    await anthropicStreaming.chatStream(
      { model: "claude-haiku", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.some((e) => e.kind === "end")).toBe(false);
  });
});

describe("openaiStreaming", () => {
  it("emits deltas for choices[].delta.content + an end with finish_reason", async () => {
    const { f, calls } = streamingFakeFetch({
      lines: [
        `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
        `data: [DONE]`,
      ],
    });
    const events: ChatStreamEvent[] = [];
    await openaiStreaming.chatStream(
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    expect(calls[0]?.url).toMatch(/\/v1\/chat\/completions$/);
    expect((calls[0]?.body as { stream?: boolean }).stream).toBe(true);
    expect(
      events.filter((e) => e.kind === "delta").map((e) => (e as { kind: "delta"; text: string }).text).join(""),
    ).toBe("Hello there");
    const end = events[events.length - 1];
    expect(end?.kind).toBe("end");
    if (end?.kind === "end") expect(end.stopReason).toBe("stop");
  });
});

describe("openaiStreaming: a provider busy for a moment", () => {
  const ok = [
    `data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}`,
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
  ];
  /** Answers each call with the next of `replies` (status + body), then streams `ok`. */
  function sequence(replies: Array<{ status: number; body: string }>) {
    let n = 0;
    const f: StreamingFetchLike = async () => {
      const r = replies[n++];
      return {
        ok: !r,
        status: r?.status ?? 200,
        async text() { return r?.body ?? ""; },
        lines() { return (async function* () { if (!r) for (const l of ok) yield l; })(); },
      };
    };
    return { f, calls: () => n };
  }
  const run = async (f: StreamingFetchLike) => {
    const events: ChatStreamEvent[] = [];
    await openaiStreaming.chatStream({ model: "m", messages: [{ role: "user", content: "hi" }] }, { apiKey: "k", baseUrl: "https://api.example.com" }, (e) => events.push(e), f);
    return events;
  };

  it("retries an overloaded / rate-limited answer before the turn fails (live: DeepInfra engine_overloaded)", async () => {
    const saved = [...transientRetry.delaysMs];
    transientRetry.delaysMs = [0, 0];
    try {
      const busy = `{"error":{"message":"Model busy, retry later","type":"invalid_request_error","code":"engine_overloaded"}}`;
      const seq = sequence([{ status: 400, body: busy }, { status: 429, body: "slow down" }]);
      const events = await run(seq.f);
      expect(seq.calls()).toBe(3);
      expect(events.some((e) => e.kind === "error")).toBe(false);
      expect(events.at(-1)?.kind).toBe("end");
    } finally {
      transientRetry.delaysMs = saved;
    }
  });

  it("gives up after its retries, and never retries a real refusal", async () => {
    const saved = [...transientRetry.delaysMs];
    transientRetry.delaysMs = [0, 0];
    try {
      const always = sequence([{ status: 503, body: "" }, { status: 503, body: "" }, { status: 503, body: "" }]);
      const e1 = await run(always.f);
      expect(always.calls()).toBe(3);
      expect(e1.find((e) => e.kind === "error")).toMatchObject({ status: 503 });
      const denied = sequence([{ status: 401, body: "invalid api key" }]);
      const e2 = await run(denied.f);
      expect(denied.calls()).toBe(1);
      expect(e2.find((e) => e.kind === "error")).toMatchObject({ status: 401 });
    } finally {
      transientRetry.delaysMs = saved;
    }
  });
});

describe("openrouterStreaming", () => {
  it("streams OpenAI-compatible deltas through the OpenRouter endpoint", async () => {
    const { f, calls } = streamingFakeFetch({
      lines: [
        `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{"content":" router"},"finish_reason":null}]}`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
        `data: [DONE]`,
      ],
    });
    const events: ChatStreamEvent[] = [];
    await openrouterStreaming.chatStream(
      { model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "or-test" },
      (e) => events.push(e),
      f,
    );
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0]?.body as { stream?: boolean }).stream).toBe(true);
    expect(
      events.filter((e) => e.kind === "delta").map((e) => (e as { kind: "delta"; text: string }).text).join(""),
    ).toBe("Hello router");
    expect(events.at(-1)).toEqual({ kind: "end", stopReason: "stop" });
  });

  it("surfaces OpenRouter mid-stream errors without reporting a successful end", async () => {
    const { f } = streamingFakeFetch({
      lines: [
        `data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}`,
      ],
    });
    const events: ChatStreamEvent[] = [];
    await openrouterStreaming.chatStream(
      { model: "anthropic/claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "or-test" },
      (e) => events.push(e),
      f,
    );
    expect(events).toEqual([{ kind: "error", message: "Rate limit exceeded" }]);
  });
});

describe("googleStreaming", () => {
  it("emits deltas for candidates[].content.parts + an end with usage", async () => {
    const { f, calls } = streamingFakeFetch({
      lines: [
        `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}`,
        `data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}`,
      ],
    });
    const events: ChatStreamEvent[] = [];
    await googleStreaming.chatStream(
      { model: "gemini-1.5-flash", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    expect(calls[0]?.url).toMatch(/streamGenerateContent\?alt=sse/);
    expect(
      events.filter((e) => e.kind === "delta").map((e) => (e as { kind: "delta"; text: string }).text).join(""),
    ).toBe("Hello world");
    const end = events[events.length - 1];
    expect(end?.kind).toBe("end");
    if (end?.kind === "end") {
      expect(end.stopReason).toBe("STOP");
      expect(end.usage?.inputTokens).toBe(4);
    }
  });
});
