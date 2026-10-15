/**
 * Flagship free-AI meter shim — Cloudflare Worker.
 *
 * The single front door for Flagship Inference. `.com` hands boxes this host
 * (FLAGSHIP_INFERENCE_ENDPOINT), so a promo credential only ever reaches
 * it. Per call it:
 *   1. verifies the scoped `.com` token (Bearer);
 *   2. asks `.com` how much of the account's allowance is left, and stops
 *      at zero with `.com`'s reason (used up this week, busy today, ended);
 *   3. rebuilds the request from an allowlist (no `user`, no message
 *      names, no extras, the upstream's own id for the catalog model `.com`
 *      resolved, thinking turned off with that model's switch on that host,
 *      output capped at the model's own cap) and sends it to the primary
 *      upstream with
 *      only our key: no box headers, no client IP, no account id ever leave
 *      this Worker. When the primary fails (5xx, a timeout, a dropped
 *      connection; never a 4xx about the request), the same request goes
 *      once to the fallback upstream, before any byte reaches the box;
 *   4. reports the true usage (or an estimate when the upstream gives
 *      none) and the catalog model to `.com` /api/llm-promo/usage, which
 *      charges it at that model's multiplier, and tells the box what the
 *      call cost (a final `flagship.usage` chunk).
 *
 * Upstreams are any OpenAI-compatible chat-completions APIs: hosted model
 * providers at launch (DeepInfra, OpenRouter's zero-retention hosts), our own
 * vLLM later. Changing them is a config change here; boxes and apps never
 * notice. Prompts are not logged or stored.
 */
import {
  DEFAULT_PRICING,
  SseUsageScanner,
  buildUsageReport,
  cacheSalt,
  creditsFor,
  estimateTokens,
  extractUsage,
  hasImages,
  isContextTooLong,
  outputCap,
  sanitizeChatRequest,
  shouldFallBack,
  upstreamBody,
  upstreamModelId,
  verifyScopedInferenceToken,
  type Pricing,
  type ResolvedModel,
  type Upstream,
} from "./meter.js";

export interface Env {
  /** HMAC secret — MUST equal .com's FLAGSHIP_INFERENCE_TOKEN_SECRET. */
  FLAGSHIP_INFERENCE_TOKEN_SECRET: string;
  /** Primary upstream: full chat-completions URL, e.g. https://api.deepinfra.com/v1/openai/chat/completions. */
  UPSTREAM_CHAT_URL?: string;
  /** Legacy: a vLLM base; `/v1/chat/completions` is appended. */
  VLLM_UPSTREAM?: string;
  /** The primary upstream's API key (a secret). Boxes never see it. */
  UPSTREAM_API_KEY?: string;
  /** Legacy name for UPSTREAM_API_KEY. */
  VLLM_UPSTREAM_KEY?: string;
  /** The primary's name in .com's catalog ("deepinfra"): picks its model ids. */
  UPSTREAM_NAME?: string;
  /** Pinned model id for the primary (only when .com's catalog names none). */
  UPSTREAM_MODEL?: string;
  /**
   * Cloudflare Access service token for a primary behind a Cloudflare Tunnel
   * (our own vLLM, infra/inference/upcloud). Both or neither.
   */
  UPSTREAM_ACCESS_CLIENT_ID?: string;
  UPSTREAM_ACCESS_CLIENT_SECRET?: string;
  /**
   * Workers VPC Service binding (beta) to the primary's tunnel: when bound,
   * the call goes through it and needs no public hostname. UPSTREAM_CHAT_URL's
   * host then only sets the Host header.
   */
  UPSTREAM_VPC?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  /**
   * "per-pass": add a vLLM `cache_salt` derived from the pass, so one
   * account's cached prefixes can't be probed by another's timing. Only for
   * our own vLLM (a hosted API may reject the field). The salt is an HMAC of
   * the pass: stable within a build, unlinkable across passes.
   */
  UPSTREAM_CACHE_SALT?: string;
  /** Fallback upstream, tried once when the primary fails (5xx, timeout, connection). */
  FALLBACK_CHAT_URL?: string;
  FALLBACK_API_KEY?: string;
  /** The fallback's name in .com's catalog ("openrouter"). */
  FALLBACK_NAME?: string;
  FALLBACK_MODEL?: string;
  /** The same tunnel options for the fallback (our own vLLM as the fallback). */
  FALLBACK_ACCESS_CLIENT_ID?: string;
  FALLBACK_ACCESS_CLIENT_SECRET?: string;
  FALLBACK_VPC?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  FALLBACK_CACHE_SALT?: string;
  /** How long to wait for an upstream's response headers before giving up on it. Default 60 s. */
  UPSTREAM_TIMEOUT_MS?: string;
  /**
   * Optional global ceiling on output tokens per call, over each catalog
   * model's own cap (`maxOutputTokens`). Unset: the model's cap, or 8192
   * when `.com` names no model.
   */
  MAX_OUTPUT_TOKENS?: string;
  /** "1" answers every call with "Flagship Inference isn't available right now" (a kill switch). */
  PAUSED?: string;
  /** .com base for the allowance check and usage reports. */
  COM_BASE_URL: string;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export const USED_UP_MESSAGE =
  "You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.";
export const UNAVAILABLE_MESSAGE = "Flagship Inference isn't available right now. You can add your own AI key.";
export const EXPIRED_MESSAGE = "This Flagship Inference pass has expired. Send your message again to continue.";
export const BUSY_MESSAGE = "Flagship Inference is busy right now. Try again in a minute.";
export const TOO_LONG_MESSAGE =
  "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.";
export const NO_IMAGES_MESSAGE = "This model can't see images. Switch to a model that can, or send the message without them.";

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
      return json(404, { error: { message: "not found" } });
    }
    if (env.PAUSED === "1") return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");
    const upstreams = configuredUpstreams(env);
    if (upstreams.length === 0) return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");

    const token = bearer(request);
    if (!token) return aiError(401, "Missing Flagship Inference pass.", "free-ai-token-invalid");
    const v = await verifyScopedInferenceToken(token, env.FLAGSHIP_INFERENCE_TOKEN_SECRET);
    if (!v.ok) {
      return v.reason === "expired"
        ? aiError(401, EXPIRED_MESSAGE, "free-ai-token-expired")
        : aiError(403, "This Flagship Inference pass isn't valid.", "free-ai-token-invalid");
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return aiError(400, "The request body must be JSON.", "invalid-request");
    }
    const requested =
      raw && typeof raw === "object" && typeof (raw as { model?: unknown }).model === "string"
        ? ((raw as { model: string }).model)
        : undefined;

    const allowance = await checkAllowance(env, token, requested);
    if (allowance === null) return aiError(503, UNAVAILABLE_MESSAGE, "free-ai-unavailable");
    if (allowance.remainingTokens <= 0) {
      return aiError(429, allowance.message ?? USED_UP_MESSAGE, allowance.code ?? "free-ai-used-up");
    }
    const model = allowance.model;

    const clean = sanitizeChatRequest(raw, {
      maxOutputTokens: outputCap(model, env.MAX_OUTPUT_TOKENS ? Number(env.MAX_OUTPUT_TOKENS) : undefined),
    });
    if (!clean.ok) return aiError(400, clean.error, "invalid-request");
    if (model && !model.modalities.includes("image") && hasImages(clean.body)) {
      return aiError(
        400,
        model.visionAlternative
          ? `This model can't see images. Switch to ${model.visionAlternative} to send them.`
          : NO_IMAGES_MESSAGE,
        "free-ai-no-images",
      );
    }

    // Primary first; the fallback once, only when the primary itself failed
    // and before any byte reaches the box.
    const timeout = Number(env.UPSTREAM_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000;
    let res: Response | null = null;
    let body = "";
    for (const u of upstreams) {
      const modelId = upstreamModelId(u, model, requested);
      if (!modelId) continue;
      const shaped = upstreamBody(clean.body, u, modelId, model);
      if (u.cacheSalt) shaped.cache_salt = await cacheSalt(env.FLAGSHIP_INFERENCE_TOKEN_SECRET, token);
      body = JSON.stringify(shaped);
      const outcome = await send(u, body, timeoutMs);
      if (outcome.res && !shouldFallBack({ status: outcome.res.status })) {
        res = outcome.res;
        break;
      }
      await outcome.res?.body?.cancel().catch(() => {});
      res = null;
      if (!shouldFallBack(outcome.res ? { status: outcome.res.status } : { error: outcome.error })) break;
    }
    if (!res) return aiError(503, BUSY_MESSAGE, "free-ai-busy");
    if (!res.ok) {
      if (res.status === 429) {
        await res.body?.cancel();
        return aiError(503, BUSY_MESSAGE, "free-ai-busy");
      }
      // Only read to classify: the upstream's words never reach the box.
      const detail = await res.text().catch(() => "");
      return isContextTooLong(res.status, detail)
        ? aiError(400, TOO_LONG_MESSAGE, "free-ai-too-long")
        : aiError(502, UNAVAILABLE_MESSAGE, "free-ai-upstream");
    }

    const pricing = allowance.pricing;
    const multiplier = model?.multiplier ?? 1;
    const modelLabel = model?.id;
    if (clean.stream && res.body) {
      const scanner = new SseUsageScanner();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          scanner.feed(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush(controller) {
          scanner.feed(decoder.decode());
          const usage = scanner.finish(body.length);
          // What this call cost, after the upstream's own [DONE].
          const credits = creditsFor(usage, multiplier, pricing);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ object: "flagship.usage", credits, ...(modelLabel ? { model: modelLabel } : {}) })}\n\n`),
          );
          ctx.waitUntil(reportUsage(env, token, usage, modelLabel));
        },
      });
      return new Response(res.body.pipeThrough(tap), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
      usage = extractUsage(parsed);
    } catch {
      // not JSON: charged by estimate below
    }
    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
      usage = { inputTokens: estimateTokens(body.length), outputTokens: estimateTokens(text.length) };
    }
    ctx.waitUntil(reportUsage(env, token, usage, modelLabel));
    const out = parsed ? JSON.stringify({ ...parsed, flagship: { credits: creditsFor(usage, multiplier, pricing) } }) : text;
    return new Response(out, { status: 200, headers: { "content-type": "application/json" } });
  },
};

/** The primary and (when set) the fallback upstream, in order. */
export function configuredUpstreams(env: Env): Upstream[] {
  const out: Upstream[] = [];
  const primary = upstreamUrl(env);
  if (primary) {
    const key = env.UPSTREAM_API_KEY ?? env.VLLM_UPSTREAM_KEY;
    out.push({
      name: env.UPSTREAM_NAME ?? "primary",
      url: primary,
      ...(key ? { key } : {}),
      ...(env.UPSTREAM_MODEL ? { model: env.UPSTREAM_MODEL } : {}),
      ...tunnel(env.UPSTREAM_ACCESS_CLIENT_ID, env.UPSTREAM_ACCESS_CLIENT_SECRET, env.UPSTREAM_VPC, env.UPSTREAM_CACHE_SALT),
    });
  }
  if (env.FALLBACK_CHAT_URL) {
    out.push({
      name: env.FALLBACK_NAME ?? "fallback",
      url: env.FALLBACK_CHAT_URL,
      ...(env.FALLBACK_API_KEY ? { key: env.FALLBACK_API_KEY } : {}),
      ...(env.FALLBACK_MODEL ? { model: env.FALLBACK_MODEL } : {}),
      ...tunnel(env.FALLBACK_ACCESS_CLIENT_ID, env.FALLBACK_ACCESS_CLIENT_SECRET, env.FALLBACK_VPC, env.FALLBACK_CACHE_SALT),
    });
  }
  return out;
}

function tunnel(
  id: string | undefined,
  secret: string | undefined,
  vpc: Upstream["vpc"] | undefined,
  salt: string | undefined,
): Pick<Upstream, "access" | "vpc" | "cacheSalt"> {
  return {
    ...(id && secret ? { access: { id, secret } } : {}),
    ...(vpc ? { vpc } : {}),
    ...(salt === "per-pass" ? { cacheSalt: true } : {}),
  };
}

/** POST to one upstream with only our key; a timeout or dropped connection is an error. */
async function send(u: Upstream, body: string, timeoutMs: number): Promise<{ res?: Response; error?: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (u.key) headers.authorization = `Bearer ${u.key}`;
  if (u.access) {
    headers["cf-access-client-id"] = u.access.id;
    headers["cf-access-client-secret"] = u.access.secret;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("upstream timeout")), timeoutMs);
  try {
    const init = { method: "POST", headers, body, signal: abort.signal };
    const res = u.vpc ? await u.vpc.fetch(u.url, init) : await fetch(u.url, init);
    return { res };
  } catch (error) {
    return { error: error ?? new Error("upstream failed") };
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * What `.com` says is left for the pass's account, with its reason when
 * nothing is (used up, busy today, ended), the catalog model the box asked
 * for (its multiplier and each upstream's id) and how credits are counted;
 * null when `.com` can't say, which fails the call closed.
 */
async function checkAllowance(
  env: Env,
  token: string,
  model: string | undefined,
): Promise<{
  remainingTokens: number;
  code?: string;
  message?: string;
  model: ResolvedModel | null;
  pricing: Pricing;
} | null> {
  try {
    const r = await fetch(comUrl(env, "/api/free-ai/allowance"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, ...(model ? { model } : {}) }),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as {
      remainingTokens?: unknown;
      code?: unknown;
      message?: unknown;
      model?: unknown;
      inputWeight?: unknown;
      outputWeight?: unknown;
      creditTokens?: unknown;
    };
    if (typeof b.remainingTokens !== "number") return null;
    const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
    return {
      remainingTokens: b.remainingTokens,
      ...(typeof b.code === "string" && b.code.startsWith("free-ai") ? { code: b.code } : {}),
      ...(typeof b.message === "string" ? { message: b.message } : {}),
      model: resolvedModel(b.model),
      pricing: {
        inputWeight: pos(b.inputWeight, DEFAULT_PRICING.inputWeight),
        outputWeight: pos(b.outputWeight, DEFAULT_PRICING.outputWeight),
        creditTokens: pos(b.creditTokens, DEFAULT_PRICING.creditTokens),
      },
    };
  } catch {
    return null;
  }
}

function resolvedModel(raw: unknown): ResolvedModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<ResolvedModel>;
  if (typeof m.id !== "string" || typeof m.multiplier !== "number" || !m.upstream || typeof m.upstream !== "object") return null;
  return {
    id: m.id,
    multiplier: m.multiplier > 0 ? m.multiplier : 1,
    modalities: Array.isArray(m.modalities) ? m.modalities.filter((x): x is string => typeof x === "string") : ["text"],
    ...(typeof m.maxOutputTokens === "number" && m.maxOutputTokens > 0 ? { maxOutputTokens: m.maxOutputTokens } : {}),
    upstream: m.upstream,
    ...(typeof m.visionAlternative === "string" ? { visionAlternative: m.visionAlternative } : {}),
  };
}

async function reportUsage(
  env: Env,
  token: string,
  usage: { inputTokens: number; outputTokens: number },
  model?: string,
): Promise<void> {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  try {
    await fetch(comUrl(env, "/api/llm-promo/usage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildUsageReport(token, usage, model)),
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
