/**
 * Flagship free-AI meter shim — Cloudflare Worker.
 *
 * The single front door for free AI credits. `.com` hands boxes this host
 * (FLAGSHIP_INFERENCE_ENDPOINT), so a promo credential only ever reaches
 * it. Per call it:
 *   1. verifies the scoped `.com` token (Bearer);
 *   2. asks `.com` how much of the account's allowance is left, and stops
 *      at zero with a message pointing to bring-your-own-key;
 *   3. rebuilds the request from an allowlist (no `user`, no message
 *      names, no extras, the upstream's own model id, capped output) and
 *      sends it to the upstream with only our key: no box headers, no
 *      client IP, no account id ever leave this Worker;
 *   4. reports the true usage (or an estimate when the upstream gives
 *      none) to `.com` /api/llm-promo/usage.
 *
 * The upstream is any OpenAI-compatible chat-completions API: a hosted
 * model provider at launch, our own vLLM later. Changing it is a config
 * change here; boxes and apps never notice. Prompts are not logged or
 * stored.
 */
import {
  SseUsageScanner,
  buildUsageReport,
  estimateTokens,
  extractUsage,
  sanitizeChatRequest,
  verifyScopedInferenceToken,
} from "./meter.js";

export interface Env {
  /** HMAC secret — MUST equal .com's FLAGSHIP_INFERENCE_TOKEN_SECRET. */
  FLAGSHIP_INFERENCE_TOKEN_SECRET: string;
  /** Full chat-completions URL of the upstream, e.g. https://api.example.com/v1/chat/completions. */
  UPSTREAM_CHAT_URL?: string;
  /** Legacy: a vLLM base; `/v1/chat/completions` is appended. */
  VLLM_UPSTREAM?: string;
  /** The upstream's API key (a secret). Boxes never see it. */
  UPSTREAM_API_KEY?: string;
  /** Legacy name for UPSTREAM_API_KEY. */
  VLLM_UPSTREAM_KEY?: string;
  /** The upstream's model id; replaces the model a box asks for. */
  UPSTREAM_MODEL?: string;
  /** Ceiling on output tokens per call. Default 8192. */
  MAX_OUTPUT_TOKENS?: string;
  /** "1" answers every call with "free AI is paused" (a kill switch). */
  PAUSED?: string;
  /** .com base for the allowance check and usage reports. */
  COM_BASE_URL: string;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export const USED_UP_MESSAGE = "Your free AI credits are used up. Add your own AI key to keep building.";
export const UNAVAILABLE_MESSAGE = "Free AI isn't available right now. You can add your own AI key.";
export const EXPIRED_MESSAGE = "This free AI pass has expired. Send your message again to continue.";
export const BUSY_MESSAGE = "Free AI is busy right now. Try again in a minute.";

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
      return json(404, { error: { message: "not found" } });
    }
    if (env.PAUSED === "1") return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");
    const upstream = upstreamUrl(env);
    if (!upstream) return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");

    const token = bearer(request);
    if (!token) return aiError(401, "Missing free AI token.", "free-ai-token-invalid");
    const v = await verifyScopedInferenceToken(token, env.FLAGSHIP_INFERENCE_TOKEN_SECRET);
    if (!v.ok) {
      return v.reason === "expired"
        ? aiError(401, EXPIRED_MESSAGE, "free-ai-token-expired")
        : aiError(403, "This free AI token isn't valid.", "free-ai-token-invalid");
    }

    const remaining = await remainingTokens(env, token);
    if (remaining === null) return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");
    if (remaining <= 0) return aiError(429, USED_UP_MESSAGE, "free-ai-used-up");

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return aiError(400, "The request body must be JSON.", "invalid-request");
    }
    const maxOut = Number(env.MAX_OUTPUT_TOKENS);
    const clean = sanitizeChatRequest(raw, {
      ...(env.UPSTREAM_MODEL ? { model: env.UPSTREAM_MODEL } : {}),
      maxOutputTokens: Number.isFinite(maxOut) && maxOut > 0 ? Math.floor(maxOut) : 8192,
    });
    if (!clean.ok) return aiError(400, clean.error, "invalid-request");
    const body = JSON.stringify(clean.body);

    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = env.UPSTREAM_API_KEY ?? env.VLLM_UPSTREAM_KEY;
    if (key) headers.authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await fetch(upstream, { method: "POST", headers, body });
    } catch {
      return aiError(502, UNAVAILABLE_MESSAGE, "free-ai-upstream");
    }
    if (!res.ok) {
      await res.body?.cancel();
      return res.status === 429 || res.status >= 500
        ? aiError(503, BUSY_MESSAGE, "free-ai-busy")
        : aiError(502, UNAVAILABLE_MESSAGE, "free-ai-upstream");
    }

    if (clean.stream && res.body) {
      const scanner = new SseUsageScanner();
      const decoder = new TextDecoder();
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          scanner.feed(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          scanner.feed(decoder.decode());
          ctx.waitUntil(reportUsage(env, token, scanner.finish(body.length)));
        },
      });
      return new Response(res.body.pipeThrough(tap), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    const text = await res.text();
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      usage = extractUsage(JSON.parse(text));
    } catch {
      // not JSON: charged by estimate below
    }
    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
      usage = { inputTokens: estimateTokens(body.length), outputTokens: estimateTokens(text.length) };
    }
    ctx.waitUntil(reportUsage(env, token, usage));
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  },
};

function upstreamUrl(env: Env): string | null {
  if (env.UPSTREAM_CHAT_URL) return env.UPSTREAM_CHAT_URL;
  if (env.VLLM_UPSTREAM) return `${env.VLLM_UPSTREAM.replace(/\/$/, "")}/v1/chat/completions`;
  return null;
}

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]! : null;
}

function comUrl(env: Env, path: string): string {
  return `${env.COM_BASE_URL.replace(/\/$/, "")}${path}`;
}

/** The account's remaining free tokens, or null when `.com` can't say (fail closed). */
async function remainingTokens(env: Env, token: string): Promise<number | null> {
  try {
    const r = await fetch(comUrl(env, "/api/free-ai/allowance"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { remainingTokens?: unknown };
    return typeof b.remainingTokens === "number" ? b.remainingTokens : null;
  } catch {
    return null;
  }
}

async function reportUsage(
  env: Env,
  token: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  try {
    await fetch(comUrl(env, "/api/llm-promo/usage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildUsageReport(token, usage)),
    });
  } catch {
    // A dropped report under-counts; never fail the user's call for it.
  }
}

/** An OpenAI-shaped error the box's adapter reads, with our own wording. */
function aiError(status: number, message: string, code: string): Response {
  return json(status, { error: { message, code } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
