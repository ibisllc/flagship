import { describe, expect, it } from "vitest";
import {
  anthropicStreaming,
  googleStreaming,
  openaiStreaming,
  type ChatStreamEvent,
  type StreamingFetchLike,
} from "../src/index.js";

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
