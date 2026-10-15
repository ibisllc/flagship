/**
 * The meter shim with a primary and a fallback upstream, and the catalog
 * model `.com` resolves on the allowance check: which upstream is called
 * with which id, when the fallback is tried, and what each call is charged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintScopedInferenceToken } from "@flagship/control-plane";
import shim, { BUSY_MESSAGE, type Env } from "../../../infra/inference/shim/src/index.js";
import {
  DEFAULT_OUTPUT_TOKENS,
  creditsFor,
  outputCap,
  shouldFallBack,
  upstreamBody,
} from "../../../infra/inference/shim/src/meter.js";
import { flagshipStreaming, type ChatStreamEvent } from "../src/index.js";

const SECRET = "shim-secret";
const PRIMARY = "https://api.deepinfra.example/v1/openai/chat/completions";
const FALLBACK = "https://openrouter.ai/api/v1/chat/completions";
const COM = "https://com.example.test";

const env: Env = {
  FLAGSHIP_INFERENCE_TOKEN_SECRET: SECRET,
  UPSTREAM_CHAT_URL: PRIMARY,
  UPSTREAM_API_KEY: "di-key",
  UPSTREAM_NAME: "deepinfra",
  FALLBACK_CHAT_URL: FALLBACK,
  FALLBACK_API_KEY: "or-key",
  FALLBACK_NAME: "openrouter",
  UPSTREAM_TIMEOUT_MS: "50",
  COM_BASE_URL: COM,
};

const LOW = {
  id: "low",
  multiplier: 1,
  modalities: ["text", "image"],
  maxOutputTokens: 32_768,
  upstream: {
    deepinfra: { id: "Qwen/Qwen3.6-35B-A3B", thinkingOff: { chat_template_kwargs: { enable_thinking: false } } },
    openrouter: { id: "qwen/qwen3.6-35b-a3b", maxPriceIn: 0.1, maxPriceOut: 0.95, thinkingOff: { reasoning: { effort: "none" } } },
  },
};
const MEDIUM = {
  id: "medium",
  multiplier: 2,
  modalities: ["text"],
  maxOutputTokens: 20_000,
  upstream: {
    deepinfra: { id: "deepseek-ai/DeepSeek-V4-Flash", thinkingOff: { reasoning_effort: "none" } },
    openrouter: { id: "deepseek/deepseek-v4-flash", thinkingOff: { reasoning: { effort: "low" } } },
  },
  visionAlternative: "Medium multimodal 3× (Qwen3.8-27B)",
};

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
let seen: Seen[];
let primary: () => Response | Promise<Response>;
let fallback: () => Response;

const ok = (usage = { prompt_tokens: 1000, completion_tokens: 100 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage }), { status: 200 });

beforeEach(() => {
  seen = [];
  primary = () => ok();
  fallback = () => ok();
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: input, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    if (input === `${COM}/api/free-ai/allowance`) {
      const model = body.model === "medium" ? MEDIUM : LOW;
      return new Response(
        JSON.stringify({ ok: true, remainingTokens: 10_000, model, inputWeight: 1, outputWeight: 4, creditTokens: 1000 }),
      );
    }
    if (input === `${COM}/api/llm-promo/usage`) return new Response("{}");
    if (input === PRIMARY) {
      // Like the real fetch: an abort rejects the pending call.
      const aborted = new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return Promise.race([Promise.resolve().then(primary), aborted]);
    }
    if (input === FALLBACK) return fallback();
    throw new Error(`unexpected fetch ${input}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function call(body: unknown) {
  const t = await mintScopedInferenceToken(
    { username: "alice", keyId: "fa-1", iat: Date.now(), exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
    SECRET,
  );
  const waits: Promise<unknown>[] = [];
  const res = await shim.fetch(
    new Request("https://inference.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: (p) => void waits.push(p) },
  );
  await Promise.all(waits);
  return { res, t };
}

const calls = (url: string) => seen.filter((s) => s.url === url);
const usage = () => seen.find((s) => s.url === `${COM}/api/llm-promo/usage`)?.body;

describe("primary and fallback upstreams", () => {
  it("sends the catalog model's primary id, and asks .com about that model", async () => {
    const { res } = await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(seen[0]!.body).toMatchObject({ model: "low" });
    expect(calls(PRIMARY)[0]!.body.model).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(calls(PRIMARY)[0]!.headers.authorization).toBe("Bearer di-key");
    expect(calls(FALLBACK)).toHaveLength(0);
    expect(usage()).toMatchObject({ inputTokens: 1000, outputTokens: 100, model: "low" });
  });

  it("retries once on the fallback when the primary answers 5xx, with the fallback's id, key and privacy routing", async () => {
    primary = () => new Response("overloaded", { status: 503 });
    const { res } = await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const fb = calls(FALLBACK)[0]!;
    expect(fb.body.model).toBe("qwen/qwen3.6-35b-a3b");
    expect(fb.headers.authorization).toBe("Bearer or-key");
    expect(fb.body.provider).toEqual({ zdr: true, data_collection: "deny", max_price: { prompt: 0.1, completion: 0.95 } });
    expect(JSON.stringify(fb.body)).not.toContain("alice");
    expect(usage()).toMatchObject({ model: "low" });
  });

  it("falls back on a timeout and on a dropped connection", async () => {
    primary = () => new Promise<Response>(() => {}) as Promise<Response>;
    expect((await call({ model: "low", messages: [{ role: "user", content: "hi" }] })).res.status).toBe(200);
    expect(calls(FALLBACK)).toHaveLength(1);
    seen = [];
    primary = () => {
      throw new TypeError("connection reset");
    };
    expect((await call({ model: "low", messages: [{ role: "user", content: "hi" }] })).res.status).toBe(200);
    expect(calls(FALLBACK)).toHaveLength(1);
  });

  it("never retries a 4xx about the request", async () => {
    primary = () => new Response(JSON.stringify({ error: { message: "bad tool schema" } }), { status: 400 });
    const { res } = await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(calls(FALLBACK)).toHaveLength(0);
    primary = () => new Response("slow down", { status: 429 });
    seen = [];
    const again = await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(again.res.status).toBe(503);
    expect(calls(FALLBACK)).toHaveLength(0);
  });

  it("tries the fallback at most once, then says busy", async () => {
    primary = () => new Response("down", { status: 500 });
    fallback = () => new Response("down too", { status: 502 });
    const { res } = await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(BUSY_MESSAGE);
    expect(calls(PRIMARY)).toHaveLength(1);
    expect(calls(FALLBACK)).toHaveLength(1);
    expect(usage()).toBeUndefined();
  });
});

describe("our own tunnelled vLLM as the fallback", () => {
  it("doesn't send a catalog model to an upstream the catalog lists no id for", async () => {
    primary = () => new Response("down", { status: 500 });
    const viaVpc: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const own: Env = {
      ...env,
      FALLBACK_NAME: "flagship-vllm",
      FALLBACK_CHAT_URL: "https://vllm-upstream.example/v1/chat/completions",
      FALLBACK_MODEL: "flagship-coder",
      FALLBACK_ACCESS_CLIENT_ID: "id.access",
      FALLBACK_ACCESS_CLIENT_SECRET: "sec",
      FALLBACK_CACHE_SALT: "per-pass",
      FALLBACK_VPC: {
        fetch: async (url: string, init?: RequestInit) => {
          viaVpc.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
          return ok();
        },
      },
    };
    const t = await mintScopedInferenceToken(
      { username: "alice", keyId: "fa-1", iat: Date.now(), exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    const waits: Promise<unknown>[] = [];
    const res = await shim.fetch(
      new Request("https://inference.example/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ model: "low", messages: [{ role: "user", content: "hi" }] }),
      }),
      own,
      { waitUntil: (p) => void waits.push(p) },
    );
    await Promise.all(waits);
    // The catalog names ids for deepinfra/openrouter only: a pinned model must
    // not stand in for a catalog model (it would be charged that model's
    // multiplier), so the vLLM is skipped and the call is "busy".
    expect(res.status).toBe(503);
    expect(viaVpc).toHaveLength(0);
  });

  it("serves a call the catalog has no ids for through the tunnel", async () => {
    primary = () => new Response("down", { status: 500 });
    const viaVpc: Array<{ headers: Record<string, string>; body: any }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (input === `${COM}/api/free-ai/allowance`) return new Response(JSON.stringify({ ok: true, remainingTokens: 10_000 }));
      if (input === `${COM}/api/llm-promo/usage`) return new Response("{}");
      if (input === PRIMARY) return new Response("down", { status: 500 });
      throw new Error(`unexpected fetch ${input} ${JSON.stringify(body)}`);
    });
    const own: Env = {
      ...env,
      UPSTREAM_MODEL: "Qwen/Qwen3.6-35B-A3B",
      FALLBACK_CHAT_URL: "https://vllm-upstream.example/v1/chat/completions",
      FALLBACK_MODEL: "flagship-coder",
      FALLBACK_ACCESS_CLIENT_ID: "id.access",
      FALLBACK_ACCESS_CLIENT_SECRET: "sec",
      FALLBACK_CACHE_SALT: "per-pass",
      FALLBACK_VPC: {
        fetch: async (_url: string, init?: RequestInit) => {
          viaVpc.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
          return ok();
        },
      },
    };
    const t = await mintScopedInferenceToken(
      { username: "alice", keyId: "fa-1", iat: Date.now(), exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    const res = await shim.fetch(
      new Request("https://inference.example/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      own,
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    expect(viaVpc).toHaveLength(1);
    expect(viaVpc[0]!.headers).toMatchObject({ authorization: "Bearer or-key", "cf-access-client-id": "id.access", "cf-access-client-secret": "sec" });
    expect(viaVpc[0]!.body.model).toBe("flagship-coder");
    expect(viaVpc[0]!.body.cache_salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the catalog model shapes the call", () => {
  it("turns thinking off with each model's switch on each upstream, whatever effort the box asks", async () => {
    const asks = {
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      chat_template_kwargs: { enable_thinking: true },
      messages: [{ role: "user", content: "hi" }],
    };
    await call({ model: "low", ...asks });
    const p = calls(PRIMARY)[0]!.body;
    expect(p.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(p.reasoning_effort).toBeUndefined();
    expect(p.reasoning).toBeUndefined();

    seen = [];
    await call({ model: "medium", ...asks });
    const m = calls(PRIMARY)[0]!.body;
    expect(m.reasoning_effort).toBe("none");
    expect(m.chat_template_kwargs).toBeUndefined();
    expect(m.reasoning).toBeUndefined();

    primary = () => new Response("down", { status: 500 });
    seen = [];
    await call({ model: "low", ...asks });
    const f = calls(FALLBACK)[0]!.body;
    expect(f.reasoning).toEqual({ effort: "none" });
    expect(f.reasoning_effort).toBeUndefined();
    expect(f.chat_template_kwargs).toBeUndefined();

    seen = [];
    await call({ model: "medium", ...asks });
    // A host where the model can't stop thinking gets the lowest effort it takes.
    expect(calls(FALLBACK)[0]!.body.reasoning).toEqual({ effort: "low" });
  });

  it("caps output at the model's own cap, under the optional global ceiling", async () => {
    await call({ model: "low", messages: [{ role: "user", content: "hi" }] });
    expect(calls(PRIMARY)[0]!.body.max_tokens).toBe(32_768);
    seen = [];
    await call({ model: "medium", max_tokens: 100_000, messages: [{ role: "user", content: "hi" }] });
    expect(calls(PRIMARY)[0]!.body.max_tokens).toBe(20_000);
    seen = [];
    await call({ model: "medium", max_tokens: 500, messages: [{ role: "user", content: "hi" }] });
    expect(calls(PRIMARY)[0]!.body.max_tokens).toBe(500);
    seen = [];
    const t = await mintScopedInferenceToken(
      { username: "alice", keyId: "fa-1", iat: Date.now(), exp: Date.now() + 60_000, dailyInputTokenCap: 1, dailyOutputTokenCap: 1 },
      SECRET,
    );
    await shim.fetch(
      new Request("https://inference.example/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ model: "low", messages: [{ role: "user", content: "hi" }] }),
      }),
      { ...env, MAX_OUTPUT_TOKENS: "16000" },
      { waitUntil: () => {} },
    );
    expect(calls(PRIMARY)[0]!.body.max_tokens).toBe(16_000);
  });

  it("refuses images for a text-only model, naming the one to switch to", async () => {
    const { res } = await call({
      model: "medium",
      messages: [{ role: "user", content: [{ type: "text", text: "like this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }],
    });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string; message: string } };
    expect(b.error.code).toBe("free-ai-no-images");
    expect(b.error.message).toContain("Medium multimodal");
    expect(calls(PRIMARY)).toHaveLength(0);
  });

  it("tells the box what the call cost: weighted tokens × multiplier, in credits", async () => {
    const { res } = await call({ model: "medium", messages: [{ role: "user", content: "hi" }] });
    // (1000 + 100 × 4) × 2 = 2,800 weighted = 2.8 credits
    expect(((await res.json()) as { flagship: { credits: number } }).flagship.credits).toBe(2.8);
    expect(usage()).toMatchObject({ model: "medium" });
  });

  it("appends the credits chunk to a stream, which the box's adapter reads", async () => {
    primary = () =>
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 50 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const { res, t } = await call({ model: "low", stream: true, messages: [{ role: "user", content: "hi" }] });
    const text = await res.text();
    const events: ChatStreamEvent[] = [];
    await flagshipStreaming.chatStream(
      { model: "low", messages: [{ role: "user", content: "hi" }] },
      { apiKey: t, baseUrl: "https://inference.example" },
      (e) => events.push(e),
      async () => ({ ok: true, status: 200, text: async () => text, async *lines() { yield* text.split("\n"); } }),
    );
    expect(events.find((e) => e.kind === "end")).toMatchObject({ credits: 2.2 });
  });
});

describe("shim helpers", () => {
  it("credits round up to a tenth", () => {
    expect(creditsFor({ inputTokens: 1, outputTokens: 0 }, 1)).toBe(0.1);
    expect(creditsFor({ inputTokens: 424_000, outputTokens: 13_000 }, 1.5)).toBe(714);
  });

  it("falls back only on server-side failures", () => {
    expect(shouldFallBack({ status: 500 })).toBe(true);
    expect(shouldFallBack({ status: 504 })).toBe(true);
    expect(shouldFallBack({ error: new Error("timeout") })).toBe(true);
    expect(shouldFallBack({ status: 400 })).toBe(false);
    expect(shouldFallBack({ status: 413 })).toBe(false);
    expect(shouldFallBack({ status: 429 })).toBe(false);
  });

  it("shapes thinking per model and host, and never forwards the box's own switch", () => {
    const di = { name: "deepinfra", url: PRIMARY };
    const or = { name: "openrouter", url: FALLBACK };
    const asked = { messages: [], reasoning_effort: "high", thinking: { type: "enabled" }, enable_thinking: true };
    expect(upstreamBody(asked, di, "x", LOW)).toEqual({ messages: [], model: "x", chat_template_kwargs: { enable_thinking: false } });
    expect(upstreamBody(asked, di, "x", MEDIUM)).toEqual({ messages: [], model: "x", reasoning_effort: "none" });
    expect(upstreamBody(asked, or, "x", LOW)).toMatchObject({ reasoning: { effort: "none" } });
    // No catalog (a pinned model): nothing the box asked for, nothing added.
    const pinned = upstreamBody(asked, di, "x", null);
    expect(pinned).toEqual({ messages: [], model: "x" });
    // The catalog's object is copied, never shared between calls.
    const a = upstreamBody({ messages: [] }, di, "x", LOW);
    (a.chat_template_kwargs as Record<string, unknown>).enable_thinking = true;
    expect(LOW.upstream.deepinfra.thinkingOff.chat_template_kwargs.enable_thinking).toBe(false);
  });

  it("output cap: the model's, the default without one, the ceiling over both", () => {
    expect(outputCap(LOW)).toBe(32_768);
    expect(outputCap(LOW, 8000)).toBe(8000);
    expect(outputCap(LOW, 64_000)).toBe(32_768);
    expect(outputCap(null)).toBe(DEFAULT_OUTPUT_TOKENS);
    expect(outputCap({ ...LOW, maxOutputTokens: undefined })).toBe(DEFAULT_OUTPUT_TOKENS);
    expect(outputCap(LOW, Number.NaN)).toBe(32_768);
  });
});
