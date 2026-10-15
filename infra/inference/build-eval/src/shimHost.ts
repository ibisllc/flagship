/**
 * Flagship Inference, in-process: the real meter shim (`infra/inference/shim`)
 * between the box's provider adapter and DeepInfra (or the mock), with a
 * stand-in for the two `.com` calls the shim makes.
 *
 *   box adapter (flagship provider) ──▶ shim.fetch ──▶ upstream ──▶ DeepInfra
 *                                          │
 *                                          └─▶ fake `.com`: allowance (the
 *                                              catalog model, as `.com`
 *                                              resolves it) and usage reports
 *
 * The shim calls the global `fetch`; a router installed here sends its
 * `.com` and upstream URLs to this host and everything else to the real
 * fetch. The shim is configured with a placeholder upstream key: the real
 * key is added here, on the way to DeepInfra, so it never enters the shim's
 * env or any text the shim produces.
 *
 * Every upstream call is filed (`context.ts`) with the usage DeepInfra
 * reported, cached prompt tokens included, and passes the budget guard first.
 */

import { randomBytes } from "node:crypto";
import { INFERENCE_PRICING, mintScopedInferenceToken, resolveInferenceModel } from "@flagship/control-plane";
import type { FetchLike, StreamingFetchLike } from "@flagship/llm-providers";
import shim, { type Env } from "../../shim/src/index.js";
import type { CallRecord } from "./accounting.js";
import { DEFAULT_WEIGHTS } from "./accounting.js";
import type { BudgetGuard } from "./budget.js";
import { callContext } from "./context.js";
import { MockUpstream } from "./mockModel.js";
import { catalogIdForUpstream, costUsd, worstCaseCallUsd } from "./prices.js";
import type { LlmCredential } from "../../../../packages/server-daemon/src/llmHarness.js";

export const DEEPINFRA_CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions";
/** What the box's credential points at; the adapter appends /v1/chat/completions. */
export const INFERENCE_BASE = "https://inference.build-eval.test";

const SUMMARISER_HEAD = "You condense the earlier part";
const ERROR_CHARS = 300;
const ACCOUNT_REFUSALS = new Set([401, 402, 403]);

/** The upstream's own error message, from an OpenAI-shaped body or the raw text. */
export function upstreamMessage(detail: string): string {
  try {
    const m = (JSON.parse(detail) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string" && m.length > 0) return m.slice(0, ERROR_CHARS);
  } catch {
    // not JSON
  }
  return detail.slice(0, ERROR_CHARS) || "no detail";
}

export interface ShimHostOptions {
  /** "deepinfra" calls the real API with `apiKey`; "mock" answers in-process. */
  upstream: "deepinfra" | "mock";
  apiKey?: string | null;
  guard: BudgetGuard;
  /** Applied to any upstream error text before it is stored. */
  redact: (s: string) => string;
  /** How long the shim waits for the upstream's response headers (60 s, as in its wrangler.toml). */
  timeoutMs?: number;
  /** The shim's per-call output cap (its MAX_OUTPUT_TOKENS; default 8192 as deployed). */
  maxOutputTokens?: number;
}

/** The global-fetch router: hosts register their URL prefixes. */
const routes = new Map<string, (url: string, init?: RequestInit) => Promise<Response>>();
let realFetch: typeof fetch | null = null;

function install(prefix: string, handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  if (!realFetch) {
    realFetch = globalThis.fetch;
    const original = realFetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      for (const [p, h] of routes) if (url.startsWith(p)) return h(url, init);
      return original(input, init);
    }) as typeof fetch;
  }
  routes.set(prefix, handler);
}

function uninstall(prefix: string): void {
  routes.delete(prefix);
  if (routes.size === 0 && realFetch) {
    globalThis.fetch = realFetch;
    realFetch = null;
  }
}

/** The SSE lines of a response body, for the box's streaming adapter. */
async function* sseLines(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  estimated_cost?: number;
}

function readUsage(u: ProviderUsage | null | undefined): { inputTokens: number; outputTokens: number; cachedTokens: number; providerCostUsd?: number } | null {
  if (!u || (typeof u.prompt_tokens !== "number" && typeof u.completion_tokens !== "number")) return null;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    ...(typeof u.estimated_cost === "number" ? { providerCostUsd: u.estimated_cost } : {}),
  };
}

export class ShimHost {
  private readonly id = randomBytes(6).toString("hex");
  private readonly comBase: string;
  private readonly upstreamUrl: string;
  private readonly secret = randomBytes(32).toString("hex");
  private readonly mock = new MockUpstream();
  readonly env: Env;
  /** Usage reports the shim sent `.com` (a cross-check on the provider's figures). */
  readonly usageReports: Array<{ runId?: string; inputTokens: number; outputTokens: number; model?: string }> = [];

  constructor(private readonly opts: ShimHostOptions) {
    if (opts.upstream === "deepinfra" && !opts.apiKey) throw new Error("the deepinfra upstream needs a key");
    this.comBase = `https://com.build-eval.test/${this.id}`;
    this.upstreamUrl = `https://upstream.build-eval.test/${this.id}/v1/openai/chat/completions`;
    this.env = {
      FLAGSHIP_INFERENCE_TOKEN_SECRET: this.secret,
      UPSTREAM_CHAT_URL: this.upstreamUrl,
      UPSTREAM_NAME: "deepinfra",
      UPSTREAM_API_KEY: "placeholder-added-on-the-way-out",
      UPSTREAM_TIMEOUT_MS: String(opts.timeoutMs ?? 60_000),
      MAX_OUTPUT_TOKENS: String(opts.maxOutputTokens ?? 8192),
      COM_BASE_URL: this.comBase,
    };
    install(this.comBase, (url, init) => this.com(url, init));
    install(this.upstreamUrl, (_url, init) => this.upstream(init));
  }

  close(): void {
    uninstall(this.comBase);
    uninstall(this.upstreamUrl);
  }

  /** A Flagship Inference credential for one run, as the apps hand the box. */
  async credential(username = "evalowner"): Promise<LlmCredential> {
    const now = Date.now();
    const apiKey = await mintScopedInferenceToken(
      { username, keyId: `eval-${randomBytes(4).toString("hex")}`, iat: now, exp: now + 12 * 3600_000, dailyInputTokenCap: 0, dailyOutputTokenCap: 0 },
      this.secret,
    );
    return { provider: "flagship", apiKey, baseUrl: INFERENCE_BASE, source: "promo", relay: false };
  }

  /** The box adapter's non-streaming fetch, answered by the shim. */
  readonly fetchLike: FetchLike = async (input, init) => this.callShim(input, init);

  /** The box adapter's streaming fetch, answered by the shim. */
  readonly streamingFetchLike: StreamingFetchLike = async (input, init) => {
    const res = await this.callShim(input, init);
    let used = false;
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      lines: () => {
        if (used) throw new Error("body already read");
        used = true;
        return sseLines(res.body);
      },
    };
  };

  private async callShim(
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer },
  ): Promise<Response> {
    const waits: Promise<unknown>[] = [];
    const res = await shim.fetch(
      new Request(input, { method: init?.method ?? "POST", headers: init?.headers ?? {}, ...(init?.body !== undefined ? { body: init.body as string } : {}) }),
      this.env,
      { waitUntil: (p) => void waits.push(p) },
    );
    // A streamed body reports usage when it ends; a JSON one already has.
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) await Promise.all(waits);
    return res;
  }

  /** The fake `.com`: what `handleFreeAiAllowance` answers, with no limit; usage reports kept. */
  private async com(url: string, init?: RequestInit): Promise<Response> {
    const path = url.slice(this.comBase.length);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/api/free-ai/allowance") {
      return Response.json({
        ok: true,
        remainingTokens: Number.MAX_SAFE_INTEGER,
        allowanceTokens: Number.MAX_SAFE_INTEGER,
        model: resolveInferenceModel(typeof body.model === "string" ? body.model : undefined),
        inputWeight: DEFAULT_WEIGHTS.inputWeight,
        outputWeight: DEFAULT_WEIGHTS.outputWeight,
        creditTokens: INFERENCE_PRICING.creditTokens,
      });
    }
    if (path === "/api/llm-promo/usage") {
      const runId = callContext.getStore()?.runId;
      this.usageReports.push({
        ...(runId ? { runId } : {}),
        inputTokens: Number(body.inputTokens) || 0,
        outputTokens: Number(body.outputTokens) || 0,
        ...(typeof body.model === "string" ? { model: body.model } : {}),
      });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  /** One call to the model, as the shim makes it: budgeted, sent, and filed with its usage. */
  private async upstream(init?: RequestInit): Promise<Response> {
    const ctx = callContext.getStore();
    if (!ctx) throw new Error("a model call outside any run");
    const raw = String(init?.body ?? "");
    const body = JSON.parse(raw) as { model?: string; stream?: boolean; max_tokens?: number; messages?: Array<{ content?: unknown }> };
    const model = catalogIdForUpstream(body.model ?? "");
    if (!model) throw new Error(`the shim asked for an unknown upstream model ${body.model}`);
    const summariser = typeof body.messages?.[0]?.content === "string" && body.messages[0].content.startsWith(SUMMARISER_HEAD);
    const stream = body.stream === true;
    // Worst case: ~3 characters a token for code, and the whole output cap.
    const worst = worstCaseCallUsd(model, Math.ceil(raw.length / 3), body.max_tokens ?? 8192);
    // Over budget: not sent. The shim sees a dropped connection and answers
    // the box "busy", which ends the run; the runner reads the guard's reason.
    this.opts.guard.beginCall(worst);
    const t0 = Date.now();
    let settled = false;
    const settle = (usage: ReturnType<typeof readUsage>, status: number, error?: string) => {
      if (settled) return;
      settled = true;
      const rec = this.record(ctx, model, summariser, stream, usage, Date.now() - t0, status, error);
      this.opts.guard.endCall(worst, usage ? costUsd(model, usage) : 0);
      ctx.record(rec);
    };
    let res: Response;
    try {
      res =
        this.opts.upstream === "mock"
          ? this.mock.respond(raw, ctx.mock ?? { kind: "node" }, ctx.runId)
          : await (realFetch ?? fetch)(DEEPINFRA_CHAT_URL, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
              body: raw,
              ...(init?.signal ? { signal: init.signal } : {}),
            });
    } catch (e) {
      settle(null, 0, this.opts.redact((e as Error).message ?? "upstream failed"));
      throw e;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      settle(null, res.status, this.opts.redact(detail.slice(0, ERROR_CHARS)));
      // Every later call would be refused the same way (no credit, bad key).
      if (ACCOUNT_REFUSALS.has(res.status)) {
        this.opts.guard.halt(`stopped: DeepInfra refused the account (HTTP ${res.status}): ${this.opts.redact(upstreamMessage(detail))}`);
      }
      return new Response(detail, { status: res.status, headers: res.headers });
    }
    if (!stream || !res.body) {
      const text = await res.text();
      let usage: ReturnType<typeof readUsage> = null;
      try {
        usage = readUsage((JSON.parse(text) as { usage?: ProviderUsage }).usage);
      } catch {
        /* not JSON */
      }
      settle(usage, res.status, usage ? undefined : "no usage in the response");
      return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    }
    // Tap the stream for its usage chunk, passing every byte through.
    let usage: ReturnType<typeof readUsage> = null;
    let buf = "";
    const decoder = new TextDecoder();
    const scan = (line: string) => {
      const l = line.trim();
      if (!l.startsWith("data:")) return;
      const payload = l.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const u = readUsage((JSON.parse(payload) as { usage?: ProviderUsage }).usage);
        if (u) usage = u;
      } catch {
        /* partial or foreign line */
      }
    };
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          scan(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        controller.enqueue(chunk);
      },
      flush() {
        buf += decoder.decode();
        if (buf) scan(buf);
        settle(usage, 200, usage ? undefined : "no usage in the stream");
      },
    });
    return new Response(res.body.pipeThrough(tap), { status: res.status, headers: { "content-type": "text/event-stream" } });
  }

  private record(
    ctx: { runId: string; step: string; phase: CallRecord["phase"] },
    model: string,
    summariser: boolean,
    stream: boolean,
    usage: ReturnType<typeof readUsage>,
    ms: number,
    status: number,
    error?: string,
  ): CallRecord {
    return {
      runId: ctx.runId,
      step: ctx.step,
      phase: ctx.phase,
      model,
      summariser,
      stream,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
      ...(usage?.providerCostUsd !== undefined ? { providerCostUsd: usage.providerCostUsd } : {}),
      ms,
      status,
      ...(error ? { error } : {}),
    };
  }
}
