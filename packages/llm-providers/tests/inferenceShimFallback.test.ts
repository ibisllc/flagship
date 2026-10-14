/**
 * The meter shim with a primary and a fallback upstream, and the catalog
 * model `.com` resolves on the allowance check: which upstream is called
 * with which id, when the fallback is tried, and what each call is charged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintScopedInferenceToken } from "@flagship/control-plane";
import shim, { BUSY_MESSAGE, type Env } from "../../../infra/inference/shim/src/index.js";
import { creditsFor, shouldFallBack, upstreamBody } from "../../../infra/inference/shim/src/meter.js";
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
  reasoning: true,
  upstream: {
    deepinfra: { id: "Qwen/Qwen3.6-35B-A3B" },
    openrouter: { id: "qwen/qwen3.6-35b-a3b", maxPriceIn: 0.1, maxPriceOut: 0.95 },
  },
};
const MEDIUM = {
  id: "medium",
  multiplier: 2,
  modalities: ["text"],
  reasoning: false,
  upstream: { deepinfra: { id: "deepseek-ai/DeepSeek-V4-Flash" }, openrouter: { id: "deepseek/deepseek-v4-flash" } },
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

describe("the catalog model shapes the call", () => {
  it("translates Think harder into each upstream's effort parameter", async () => {
    await call({ model: "low", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
    expect(calls(PRIMARY)[0]!.body.reasoning_effort).toBe("high");
    primary = () => new Response("down", { status: 500 });
    seen = [];
    await call({ model: "low", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
    expect(calls(FALLBACK)[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(calls(FALLBACK)[0]!.body.reasoning_effort).toBeUndefined();
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

  it("drops the effort for a model that doesn't reason", () => {
    const b = upstreamBody({ messages: [], reasoning_effort: "high" }, { name: "deepinfra", url: PRIMARY }, "x", { ...MEDIUM });
    expect(b.reasoning_effort).toBeUndefined();
  });
});
