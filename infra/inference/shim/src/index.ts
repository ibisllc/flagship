/**
 * Flagship inference meter shim — Cloudflare Worker.
 *
 * Sits between the user's box and the private vLLM endpoint. It is the
 * host `.com` hands the box in FLAGSHIP_INFERENCE_ENDPOINT, so the box's
 * promo credential is pinned to it. Responsibilities:
 *   1. Verify the scoped .com token (Bearer) — reject if invalid/expired.
 *   2. Enforce the per-token daily cap (fast local gate).
 *   3. Proxy the OpenAI chat-completions request to vLLM (adding the
 *      upstream key the box never sees).
 *   4. Report TRUE usage back to .com (metering model (b)).
 *
 * Prompts pass THROUGH — they are not logged or stored here.
 */
import {
  TokenMeter,
  buildUsageReport,
  extractUsage,
  verifyScopedInferenceToken,
} from "./meter.js";

interface Env {
  /** HMAC secret — MUST equal .com's FLAGSHIP_INFERENCE_TOKEN_SECRET. */
  FLAGSHIP_INFERENCE_TOKEN_SECRET: string;
  /** Private vLLM base (…/openai or http://pod:8000). Adapter appends /v1/…*/
  VLLM_UPSTREAM: string;
  /** Optional upstream auth (RunPod Serverless API key). */
  VLLM_UPSTREAM_KEY?: string;
  /** .com base for the usage webhook. */
  COM_BASE_URL: string;
}

const meter = new TokenMeter();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    // Only the OpenAI chat-completions surface is exposed.
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
      return json(404, { error: "not found" });
    }

    const token = bearer(request);
    if (!token) return json(401, { error: "missing bearer token" });
    const v = await verifyScopedInferenceToken(token, env.FLAGSHIP_INFERENCE_TOKEN_SECRET);
    if (!v.ok) return json(403, { error: `token ${v.reason}` });

    // Fast local per-token daily cap (input+output budget on this isolate).
    const capTotal = v.claims.dailyInputTokenCap + v.claims.dailyOutputTokenCap;
    if (meter.spentFor(v.claims.keyId) >= capTotal) {
      return json(429, { error: "daily token cap reached", cap: capTotal });
    }

    const body = await request.text();
    const upstream = `${env.VLLM_UPSTREAM.replace(/\/$/, "")}/v1/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.VLLM_UPSTREAM_KEY) headers.authorization = `Bearer ${env.VLLM_UPSTREAM_KEY}`;

    let res: Response;
    try {
      res = await fetch(upstream, { method: "POST", headers, body });
    } catch (e) {
      return json(502, { error: "upstream unreachable", detail: String(e) });
    }

    // Streaming pass-through is possible but usage lives in the final SSE
    // chunk; for the metered path we handle the non-streaming JSON shape.
    // (A streaming variant would parse the terminal `usage` chunk.)
    const text = await res.text();
    if (res.ok) {
      try {
        const usg = extractUsage(JSON.parse(text));
        meter.add(v.claims.keyId, usg.inputTokens + usg.outputTokens);
        // Report true usage to .com — best-effort, never blocks the response.
        ctx.waitUntil(reportUsage(env, token, usg));
      } catch {
        // Non-JSON success (unexpected) — skip metering rather than fail.
      }
    }
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  },
};

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]! : null;
}

async function reportUsage(
  env: Env,
  token: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  try {
    await fetch(`${env.COM_BASE_URL.replace(/\/$/, "")}/api/llm-promo/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildUsageReport(token, usage)),
    });
  } catch {
    // A dropped usage report just under-counts; never fail the user's call.
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
