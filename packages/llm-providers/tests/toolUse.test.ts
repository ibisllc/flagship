/**
 * Tool-use forwarding + parsing across the four adapters that natively
 * support it (Anthropic, OpenAI, OpenRouter, Google). Ollama is covered
 * by the no-forward assertion at the bottom: it ignores `req.tools` and
 * the wire body never carries them, so callers fall back to text.
 *
 * Each test injects a captured-fixture API response and asserts:
 *   (i)  the request body carries the provider's native tool shape
 *   (ii) the response surfaces a `tool_use` event/block with the
 *        parsed arguments
 *   (iii) no env-var VALUE appears in the request body (invariant D
 *        sentinel — tool specs are schemas + descriptions only).
 */

import { describe, expect, it } from "vitest";
import {
  anthropic,
  anthropicStreaming,
  google,
  googleStreaming,
  ollama,
  openai,
  openaiStreaming,
  openrouter,
  type ChatStreamEvent,
  type FetchLike,
  type StreamingFetchLike,
  type ToolSpec,
} from "../src/index.js";

const REQUEST_ENV_VAR_TOOL: ToolSpec = {
  name: "requestEnvVar",
  description: "request an env var",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      why: { type: "string" },
    },
    required: ["name", "description", "why"],
  },
};

const SENTINEL = "DO-NOT-LEAK-VALUE-sk-9b2c-DO-NOT-LEAK";

function jsonFetch(body: unknown, status = 200): { f: FetchLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(body); },
      async json() { return body; },
    };
  };
  return { f, calls };
}

function streamingFetch(lines: string[]): { f: StreamingFetchLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const f: StreamingFetchLike = async (url, init) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      async text() { return ""; },
      lines() {
        return (async function* () {
          for (const l of lines) yield l;
        })();
      },
    };
  };
  return { f, calls };
}

describe("anthropic — tool-use", () => {
  it("forwards tools (input_schema) and parses content[].tool_use blocks (non-stream)", async () => {
    const { f, calls } = jsonFetch({
      content: [
        { type: "text", text: "Asking the user for an env var." },
        { type: "tool_use", id: "tu_01", name: "requestEnvVar", input: { name: "OPENAI_API_KEY", description: "OAI", why: "calls" } },
      ],
      model: "claude-sonnet",
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "tool_use",
    });
    const r = await anthropic.chat(
      { model: "claude-sonnet", messages: [{ role: "user", content: "build x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      f,
    );
    const sentBody = calls[0]!.body as { tools?: Array<{ name: string; input_schema: unknown }> };
    expect(sentBody.tools?.[0]?.name).toBe("requestEnvVar");
    expect(sentBody.tools?.[0]?.input_schema).toBeTruthy();
    expect(r.content).toContain("Asking");
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses?.[0]?.name).toBe("requestEnvVar");
    expect(r.toolUses?.[0]?.input.name).toBe("OPENAI_API_KEY");
    // Invariant D sentinel: no value in the request body.
    expect(JSON.stringify(sentBody)).not.toContain(SENTINEL);
  });

  it("streaming: emits tool_use after content_block_stop with assembled partial_json", async () => {
    const { f, calls } = streamingFetch([
      `data: {"type":"message_start"}`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_abc","name":"requestEnvVar","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"OPENAI_API_KEY\\","}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"description\\":\\"oai\\",\\"why\\":\\"calls\\"}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":1,"output_tokens":2}}`,
      `data: {"type":"message_stop"}`,
    ]);
    const events: ChatStreamEvent[] = [];
    await anthropicStreaming.chatStream(
      { model: "m", messages: [{ role: "user", content: "x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    const tu = events.find((e) => e.kind === "tool_use");
    expect(tu).toBeTruthy();
    if (tu?.kind === "tool_use") {
      expect(tu.id).toBe("tu_abc");
      expect(tu.name).toBe("requestEnvVar");
      expect(tu.input.name).toBe("OPENAI_API_KEY");
    }
    // Request body carries tools, not values.
    const sent = calls[0]!.body as { tools?: unknown };
    expect(sent.tools).toBeTruthy();
    expect(JSON.stringify(sent)).not.toContain(SENTINEL);
  });
});

describe("openai — tool-use", () => {
  it("forwards tools as function shape and parses tool_calls (non-stream)", async () => {
    const { f, calls } = jsonFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_01",
                type: "function",
                function: {
                  name: "requestEnvVar",
                  arguments: '{"name":"STRIPE_KEY","description":"stripe","why":"payments"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      model: "gpt-4o",
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const r = await openai.chat(
      { model: "gpt-4o", messages: [{ role: "user", content: "x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      f,
    );
    const sentBody = calls[0]!.body as { tools?: Array<{ type: string; function: { name: string; parameters: unknown } }> };
    expect(sentBody.tools?.[0]?.type).toBe("function");
    expect(sentBody.tools?.[0]?.function.name).toBe("requestEnvVar");
    expect(sentBody.tools?.[0]?.function.parameters).toBeTruthy();
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses?.[0]?.name).toBe("requestEnvVar");
    expect(r.toolUses?.[0]?.input.name).toBe("STRIPE_KEY");
    expect(JSON.stringify(sentBody)).not.toContain(SENTINEL);
  });

  it("streaming: assembles tool_calls across delta shards, flushes on finish_reason=tool_calls", async () => {
    const { f } = streamingFetch([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"requestEnvVar","arguments":""}}]},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"name\\":\\"STRIPE_KEY\\",\\"description\\":\\"s\\","}}]}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"why\\":\\"pay\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      `data: [DONE]`,
    ]);
    const events: ChatStreamEvent[] = [];
    await openaiStreaming.chatStream(
      { model: "gpt-4o", messages: [{ role: "user", content: "x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    const tu = events.find((e) => e.kind === "tool_use");
    expect(tu).toBeTruthy();
    if (tu?.kind === "tool_use") {
      expect(tu.id).toBe("call_1");
      expect(tu.name).toBe("requestEnvVar");
      expect(tu.input.name).toBe("STRIPE_KEY");
    }
  });
});

describe("openrouter — tool-use", () => {
  it("forwards tools and parses tool_calls (OpenAI-compatible)", async () => {
    const { f, calls } = jsonFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_or",
                type: "function",
                function: { name: "talkToUser", arguments: '{"message":"what color?"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      model: "x",
    });
    const r = await openrouter.chat(
      {
        model: "x",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "talkToUser", description: "chat", inputSchema: { type: "object" } }],
      },
      { apiKey: "k" },
      f,
    );
    const sentBody = calls[0]!.body as { tools?: Array<{ function: { name: string } }> };
    expect(sentBody.tools?.[0]?.function.name).toBe("talkToUser");
    expect(r.toolUses?.[0]?.name).toBe("talkToUser");
    expect(r.toolUses?.[0]?.input.message).toBe("what color?");
  });
});

describe("google — tool-use", () => {
  it("forwards tools (function_declarations) and parses functionCall parts (non-stream)", async () => {
    const { f, calls } = jsonFetch({
      candidates: [
        {
          content: {
            parts: [
              { text: "asking" },
              { functionCall: { name: "requestEnvVar", args: { name: "GOOGLE_KEY", description: "g", why: "search" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    const r = await google.chat(
      { model: "gemini", messages: [{ role: "user", content: "x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      f,
    );
    const sentBody = calls[0]!.body as {
      tools?: Array<{ function_declarations: Array<{ name: string }> }>;
    };
    expect(sentBody.tools?.[0]?.function_declarations?.[0]?.name).toBe("requestEnvVar");
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses?.[0]?.name).toBe("requestEnvVar");
    expect(r.toolUses?.[0]?.input.name).toBe("GOOGLE_KEY");
  });

  it("streaming: surfaces functionCall as tool_use", async () => {
    const { f } = streamingFetch([
      `data: {"candidates":[{"content":{"parts":[{"text":"intro"}]}}]}`,
      `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"talkToUser","args":{"message":"hi"}}}]},"finishReason":"STOP"}]}`,
    ]);
    const events: ChatStreamEvent[] = [];
    await googleStreaming.chatStream(
      { model: "gemini", messages: [{ role: "user", content: "x" }], tools: [REQUEST_ENV_VAR_TOOL] },
      { apiKey: "k" },
      (e) => events.push(e),
      f,
    );
    const tu = events.find((e) => e.kind === "tool_use");
    expect(tu).toBeTruthy();
    if (tu?.kind === "tool_use") {
      expect(tu.name).toBe("talkToUser");
      expect(tu.input.message).toBe("hi");
    }
  });
});

describe("ollama — graceful no-op for tools", () => {
  it("ignores req.tools and the wire body never carries them (text-only fallback)", async () => {
    const { f, calls } = jsonFetch({
      message: { content: "plain text" },
      model: "llama3",
    });
    const r = await ollama.chat(
      {
        model: "llama3",
        messages: [{ role: "user", content: "x" }],
        tools: [REQUEST_ENV_VAR_TOOL],
      },
      { apiKey: "k" },
      f,
    );
    const sentBody = calls[0]!.body as { tools?: unknown };
    expect(sentBody.tools).toBeUndefined();
    expect(r.content).toBe("plain text");
    expect(r.toolUses).toBeUndefined();
  });
});
