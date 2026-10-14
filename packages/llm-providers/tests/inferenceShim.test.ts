/**
 * The free-AI meter shim (infra/inference/shim) as a whole Worker: token
 * check, allowance check, what reaches the upstream, and what gets metered.
 * `fetch` is replaced with a fake that plays both `.com` and the upstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintScopedInferenceToken } from "@flagship/control-plane";
import { FREE_AI_MESSAGES } from "@flagship/control-plane";
import shim, {
  EXPIRED_MESSAGE,
  TOO_LONG_MESSAGE,
  UNAVAILABLE_MESSAGE,
  USED_UP_MESSAGE,
  type Env,
} from "../../../infra/inference/shim/src/index.js";
import { SseUsageScanner, isContextTooLong, sanitizeChatRequest } from "../../../infra/inference/shim/src/meter.js";
import { openaiStreaming, type ChatStreamEvent } from "../src/index.js";

const SECRET = "shim-secret";
const UPSTREAM = "https://upstream.example.test/v1/chat/completions";
const COM = "https://com.example.test";

const env: Env = {
  FLAGSHIP_INFERENCE_TOKEN_SECRET: SECRET,
  UPSTREAM_CHAT_URL: UPSTREAM,
  UPSTREAM_API_KEY: "upstream-key",
  UPSTREAM_MODEL: "vendor/coder-model",
  MAX_OUTPUT_TOKENS: "4096",
  COM_BASE_URL: COM,
};

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let seen: Seen[];
let remaining: number;
let upstreamResponse: () => Response;

function token(exp = Date.now() + 60_000) {
  return mintScopedInferenceToken(
    { username: "alice", keyId: "fa-1", iat: Date.now(), exp, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
    SECRET,
  );
}

beforeEach(() => {
  seen = [];
  remaining = 10_000;
  upstreamResponse = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-upstream-trace": "abc" } },
    );
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: input, headers, body });
    if (input === `${COM}/api/free-ai/allowance`) {
      return new Response(JSON.stringify({ ok: true, remainingTokens: remaining }), { status: 200 });
    }
    if (input === `${COM}/api/llm-promo/usage`) return new Response("{}", { status: 200 });
    if (input === UPSTREAM) return upstreamResponse();
    throw new Error(`unexpected fetch ${input}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(body: unknown, auth?: string, extraHeaders: Record<string, string> = {}) {
  const waits: Promise<unknown>[] = [];
  const res = await shim.fetch(
    new Request("https://inference.example.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: (p) => void waits.push(p) },
  );
  return { res, settle: () => Promise.all(waits) };
}

const upstreamCall = () => seen.find((s) => s.url === UPSTREAM);
const usageReport = () => seen.find((s) => s.url === `${COM}/api/llm-promo/usage`);

describe("free-AI shim", () => {
  it("sends the upstream only an allowlisted request under our key, and meters the true usage", async () => {
    const t = await token();
    const { res, settle } = await call(
      {
        model: "flagship-free",
        user: "alice@home.alice.flagship.services",
        metadata: { account: "alice" },
        messages: [{ role: "user", content: "build a todo app", name: "alice" }],
        tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
        max_completion_tokens: 100_000,
      },
      t,
      { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9", "user-agent": "flagship-daemon" },
    );
    await settle();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream-trace")).toBeNull();
    const up = upstreamCall()!;
    expect(up.headers).toEqual({ "content-type": "application/json", authorization: "Bearer upstream-key" });
    expect(up.body).toEqual({
      model: "vendor/coder-model",
      messages: [{ role: "user", content: "build a todo app" }],
      tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
      max_tokens: 4096,
    });
    expect(JSON.stringify(up.body)).not.toContain("alice");
    expect(usageReport()!.body).toEqual({ token: t, inputTokens: 120, outputTokens: 30 });
  });

  it("stops before the upstream once the allowance is spent", async () => {
    remaining = 0;
    const { res } = await call({ messages: [{ role: "user", content: "hi" }] }, await token());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: USED_UP_MESSAGE, code: "free-ai-used-up" } });
    expect(upstreamCall()).toBeUndefined();
  });

  it("refuses missing, forged and expired tokens without calling anyone", async () => {
    expect((await call({ messages: [] })).res.status).toBe(401);
    const forged = await mintScopedInferenceToken(
      { username: "alice", keyId: "x", iat: 0, exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      "other",
    );
    expect((await call({ messages: [{ role: "user", content: "x" }] }, forged)).res.status).toBe(403);
    const expired = await call({ messages: [{ role: "user", content: "x" }] }, await token(Date.now() - 1));
    expect(expired.res.status).toBe(401);
    expect(((await expired.res.json()) as { error: { message: string } }).error.message).toBe(EXPIRED_MESSAGE);
    expect(seen).toHaveLength(0);
  });

  it("passes on .com's reason when it stops the call", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ ok: true, remainingTokens: 0, code: "free-ai-busy-today", message: "Free building is busy today." }),
        { status: 200 },
      ),
    );
    const { res } = await call({ messages: [{ role: "user", content: "x" }] }, await token());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "Free building is busy today.", code: "free-ai-busy-today" } });
  });

  it("fails closed when .com can't answer the allowance check", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const { res } = await call({ messages: [{ role: "user", content: "x" }] }, await token());
    expect(res.status).toBe(503);
  });

  it("turns an upstream rate limit into a short 'busy' error without its body", async () => {
    upstreamResponse = () => new Response("provider internals", { status: 429 });
    const { res } = await call({ messages: [{ role: "user", content: "x" }] }, await token());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("provider internals");
  });

  it("says a build is too big when the upstream refuses it for context length, without its body", async () => {
    upstreamResponse = () =>
      new Response(
        JSON.stringify({
          error: { message: "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.", code: "context_length_exceeded" },
        }),
        { status: 400 },
      );
    const { res } = await call({ messages: [{ role: "user", content: "x" }] }, await token());
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { message: TOO_LONG_MESSAGE, code: "free-ai-too-long" } });
    expect(text).not.toContain("32768");
    expect(TOO_LONG_MESSAGE).toBe(FREE_AI_MESSAGES.tooLong);
    expect(TOO_LONG_MESSAGE).toBe(
      "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.",
    );
  });

  it("words its refusals as Flagship Inference, the same as .com", () => {
    expect(USED_UP_MESSAGE).toBe(FREE_AI_MESSAGES.usedUp);
    expect(UNAVAILABLE_MESSAGE).toBe(FREE_AI_MESSAGES.unavailable);
    for (const m of [USED_UP_MESSAGE, UNAVAILABLE_MESSAGE, EXPIRED_MESSAGE]) {
      expect(m).toContain("Flagship Inference");
      expect(m).not.toMatch(/free AI|tokens?\b/i);
    }
  });

  it("keeps any other upstream 400 as 'unavailable'", async () => {
    upstreamResponse = () => new Response(JSON.stringify({ error: { message: "invalid tool schema" } }), { status: 400 });
    const { res } = await call({ messages: [{ role: "user", content: "x" }] }, await token());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: UNAVAILABLE_MESSAGE, code: "free-ai-upstream" } });
  });

  it("recognises the ways providers word a context overflow", () => {
    for (const body of [
      '{"error":{"code":"context_length_exceeded"}}',
      "This model's maximum context length is 131072 tokens",
      '{"detail":"Input is too long for requested model."}',
      '{"error":"prompt is too long: 210000 tokens > 200000 maximum"}',
      "Please reduce the length of the messages or completion.",
      "The input exceeds the context window of this model",
      "Requested token count exceeds the model's maximum context length",
    ]) {
      expect(isContextTooLong(400, body), body).toBe(true);
    }
    expect(isContextTooLong(413, "")).toBe(true);
    expect(isContextTooLong(400, '{"error":"model not found"}')).toBe(false);
    expect(isContextTooLong(401, "maximum context length")).toBe(false);
  });

  it("is paused by the kill switch", async () => {
    const res = await shim.fetch(
      new Request("https://inference.example.test/v1/chat/completions", { method: "POST", body: "{}" }),
      { ...env, PAUSED: "1" },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(503);
  });

  it("streams through unchanged, asks for the usage chunk, and meters it", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    upstreamResponse = () =>
      new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            // split mid-line to exercise buffering
            const all = sse.join("");
            c.enqueue(enc.encode(all.slice(0, 37)));
            c.enqueue(enc.encode(all.slice(37)));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const t = await token();
    const { res, settle } = await call({ stream: true, messages: [{ role: "user", content: "hi" }] }, t);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // The box's own OpenAI streaming adapter reads the shim's stream.
    const events: ChatStreamEvent[] = [];
    const text = await res.text();
    await openaiStreaming.chatStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { apiKey: t, baseUrl: "https://inference.example.test" },
      (e) => events.push(e),
      async () => ({
        ok: true,
        status: 200,
        async text() {
          return text;
        },
        async *lines() {
          yield* text.split("\n");
        },
      }),
    );
    await settle();
    expect(events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello");
    expect(upstreamCall()!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(usageReport()!.body).toEqual({ token: t, inputTokens: 50, outputTokens: 2 });
  });

  it("charges an estimate when the upstream reports no usage", async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(400) } }] }), { status: 200 });
    const { settle } = await call({ messages: [{ role: "user", content: "y".repeat(800) }] }, await token());
    await settle();
    const r = usageReport()!.body as { inputTokens: number; outputTokens: number };
    expect(r.inputTokens).toBeGreaterThanOrEqual(200);
    expect(r.outputTokens).toBeGreaterThanOrEqual(100);
  });
});

describe("sanitizeChatRequest", () => {
  it("rejects bodies without messages", () => {
    expect(sanitizeChatRequest({}, { maxOutputTokens: 10 }).ok).toBe(false);
    expect(sanitizeChatRequest([], { maxOutputTokens: 10 }).ok).toBe(false);
  });

  it("keeps the box's model when no upstream model is set, and a smaller max_tokens", () => {
    const r = sanitizeChatRequest(
      { model: "m", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
      { maxOutputTokens: 1000 },
    );
    expect(r.ok && r.body).toEqual({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "x" }] });
  });
});

describe("SseUsageScanner", () => {
  it("estimates from generated text and tool arguments when no usage chunk arrives", () => {
    const s = new SseUsageScanner();
    s.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: "abcd" } }] })}\n`);
    s.feed(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: "efgh" } }] } }] })}\n`);
    expect(s.finish(40)).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
});
