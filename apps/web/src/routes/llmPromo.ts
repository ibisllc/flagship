import type { FastifyInstance } from "fastify";
import { sha256 } from "@noble/hashes/sha256";
import {
  verifyLlmPromoChat,
  verifyLlmPromoQuota,
  type LlmPromoChatRequest,
  type LlmPromoQuotaRequest,
} from "@flagship/protocol";
import type { ChatMessage } from "@flagship/llm-providers";
import { hexToBytes } from "../lib/hex.js";

/**
 * Flagship-promo LLM proxy. The upstream API key for the GPU server lives
 * ONLY here in flagshipserver.com env (NEVER ships to clients). The phone
 * presents an IRK-signed chat request; we verify, check the per-account
 * quota, forward to the OpenAI-compatible upstream, increment quota, and
 * return.
 *
 * BYOK calls bypass this entirely (phone → user's own server → provider).
 * This proxy is the *only* path where flagshipserver.com sees prompt
 * plaintext, and the UI discloses that whenever the promo provider is the
 * active one.
 */

const LIFETIME_TOKEN_LIMIT = 500_000;
const DAILY_TOKEN_LIMIT = 100_000;
const ROLLING_WINDOW_MS = 24 * 60 * 60_000;
const MAX_AGE_MS = 5 * 60_000;
const ALMOST_OUT_FRACTION = 0.8;
const MAX_TOKENS_PER_REQUEST = 4096;

export interface PromoQuotaSnapshot {
  lifetimeUsed: number;
  lifetimeTotal: number;
  windowUsed: number;
  windowTotal: number;
  windowResetsAt: number;
  almostOut: boolean;
  exhausted: boolean;
}

interface UsageEntry {
  at: number;
  tokens: number;
}

export interface PromoQuotaStore {
  /** Snapshot the current usage for a given IRK pubkey hex. */
  snapshot(irkPubHex: string, now: number): PromoQuotaSnapshot;
  /** Record token usage. Returns the post-increment snapshot. */
  record(irkPubHex: string, tokens: number, now: number): PromoQuotaSnapshot;
}

export class InMemoryPromoQuotaStore implements PromoQuotaStore {
  private byIrk = new Map<string, { lifetime: number; window: UsageEntry[] }>();

  snapshot(irkPubHex: string, now: number): PromoQuotaSnapshot {
    return this.computeSnapshot(this.ensure(irkPubHex), now);
  }

  record(irkPubHex: string, tokens: number, now: number): PromoQuotaSnapshot {
    const entry = this.ensure(irkPubHex);
    entry.lifetime += tokens;
    entry.window.push({ at: now, tokens });
    return this.computeSnapshot(entry, now);
  }

  private ensure(hex: string): { lifetime: number; window: UsageEntry[] } {
    let e = this.byIrk.get(hex);
    if (!e) {
      e = { lifetime: 0, window: [] };
      this.byIrk.set(hex, e);
    }
    // Drop entries outside the rolling window so the array stays bounded.
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    e.window = e.window.filter((u) => u.at >= cutoff);
    return e;
  }

  private computeSnapshot(
    e: { lifetime: number; window: UsageEntry[] },
    now: number,
  ): PromoQuotaSnapshot {
    const cutoff = now - ROLLING_WINDOW_MS;
    const fresh = e.window.filter((u) => u.at >= cutoff);
    const windowUsed = fresh.reduce((s, u) => s + u.tokens, 0);
    const oldest = fresh[0]?.at;
    const windowResetsAt = oldest ? oldest + ROLLING_WINDOW_MS : now;
    const lifetimeFrac = e.lifetime / LIFETIME_TOKEN_LIMIT;
    const windowFrac = windowUsed / DAILY_TOKEN_LIMIT;
    return {
      lifetimeUsed: e.lifetime,
      lifetimeTotal: LIFETIME_TOKEN_LIMIT,
      windowUsed,
      windowTotal: DAILY_TOKEN_LIMIT,
      windowResetsAt,
      almostOut: lifetimeFrac >= ALMOST_OUT_FRACTION || windowFrac >= ALMOST_OUT_FRACTION,
      exhausted: e.lifetime >= LIFETIME_TOKEN_LIMIT || windowUsed >= DAILY_TOKEN_LIMIT,
    };
  }
}

export interface PromoUpstream {
  /** OpenAI-compatible chat completion against the Flagship GPU server. */
  chat(req: {
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }>;
}

export interface LlmPromoOptions {
  /** Resolves a userId to its registered IRK pubkey (32-byte). */
  resolveUserIrk: (userId: string) => Uint8Array | null;
  store: PromoQuotaStore;
  upstream: PromoUpstream;
  /** Public model name that the phone must use. Anything else is rejected. */
  promoModel?: string;
  now?: () => number;
}

interface QuotaBody {
  request?: { userId?: string; issuedAt?: number };
  signature?: string;
}

interface ChatBody {
  request?: {
    userId?: string;
    model?: string;
    maxTokens?: number;
    issuedAt?: number;
  };
  signature?: string;
  messages?: ChatMessage[];
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function canonicalizeMessages(messages: ChatMessage[]): Uint8Array {
  // Stable JSON shape — same one the phone hashes before signing.
  const obj = messages.map((m) => ({ role: m.role, content: m.content }));
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function registerLlmPromo(app: FastifyInstance, opts: LlmPromoOptions): void {
  const promoModel = opts.promoModel ?? "flagship-coder-v1";
  const now = opts.now ?? (() => Date.now());

  app.post<{ Body: QuotaBody }>("/api/llm-promo/quota", async (req, reply) => {
    const r = (req.body ?? {}).request;
    if (!r || typeof r.userId !== "string" || typeof r.issuedAt !== "number") {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (typeof (req.body ?? {}).signature !== "string") {
      return reply.status(400).send({ error: "signature required" });
    }
    const irkPub = opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });
    let sig: Uint8Array;
    try {
      sig = hexToBytes((req.body ?? {}).signature as string);
    } catch {
      return reply.status(400).send({ error: "invalid hex" });
    }
    const claim: LlmPromoQuotaRequest = { userId: r.userId, issuedAt: r.issuedAt };
    if (!verifyLlmPromoQuota(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const t = now();
    if (Math.abs(t - r.issuedAt) > MAX_AGE_MS) {
      return reply.status(403).send({ error: "stale request" });
    }
    return opts.store.snapshot(bytesToHex(irkPub), t);
  });

  app.post<{ Body: ChatBody }>("/api/llm-promo/chat", async (req, reply) => {
    const body = req.body ?? {};
    const r = body.request;
    if (
      !r ||
      typeof r.userId !== "string" ||
      typeof r.model !== "string" ||
      typeof r.maxTokens !== "number" ||
      typeof r.issuedAt !== "number" ||
      typeof body.signature !== "string" ||
      !Array.isArray(body.messages)
    ) {
      return reply.status(400).send({ error: "malformed body" });
    }
    if (r.model !== promoModel) {
      return reply.status(400).send({ error: `promo only supports model ${promoModel}` });
    }
    if (r.maxTokens <= 0 || r.maxTokens > MAX_TOKENS_PER_REQUEST) {
      return reply.status(400).send({ error: `maxTokens must be 1..${MAX_TOKENS_PER_REQUEST}` });
    }
    for (const m of body.messages) {
      if (
        !m ||
        (m.role !== "system" && m.role !== "user" && m.role !== "assistant") ||
        typeof m.content !== "string"
      ) {
        return reply.status(400).send({ error: "malformed message" });
      }
    }

    const irkPub = opts.resolveUserIrk(r.userId);
    if (!irkPub) return reply.status(404).send({ error: "unknown user" });

    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return reply.status(400).send({ error: "invalid hex signature" });
    }
    const messagesSha256 = sha256(canonicalizeMessages(body.messages));
    const claim: LlmPromoChatRequest = {
      userId: r.userId,
      model: r.model,
      messagesSha256,
      maxTokens: r.maxTokens,
      issuedAt: r.issuedAt,
    };
    if (!verifyLlmPromoChat(claim, sig, irkPub)) {
      return reply.status(403).send({ error: "invalid signature" });
    }
    const t = now();
    if (Math.abs(t - r.issuedAt) > MAX_AGE_MS) {
      return reply.status(403).send({ error: "stale request" });
    }

    const irkHex = bytesToHex(irkPub);
    const before = opts.store.snapshot(irkHex, t);
    if (before.exhausted) {
      return reply.status(429).send({
        error: "promo quota exhausted",
        quota: before,
        upgrade: "add your own LLM API key to keep building",
      });
    }

    let upstreamResult;
    try {
      upstreamResult = await opts.upstream.chat({
        model: r.model,
        messages: body.messages,
        maxTokens: r.maxTokens,
      });
    } catch (e) {
      return reply.status(502).send({ error: "upstream failed", message: errMsg(e) });
    }

    const tokensUsed = (upstreamResult.inputTokens ?? 0) + (upstreamResult.outputTokens ?? 0);
    const after = opts.store.record(irkHex, Math.max(tokensUsed, 1), t);

    return {
      content: upstreamResult.content,
      model: upstreamResult.model,
      usage: {
        input: upstreamResult.inputTokens,
        output: upstreamResult.outputTokens,
      },
      quota: after,
      proxyDisclosure:
        "this prompt was processed by flagshipserver.com on its way to the Flagship GPU. Add your own LLM key to bypass the proxy.",
    };
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const _internal = { LIFETIME_TOKEN_LIMIT, DAILY_TOKEN_LIMIT, ROLLING_WINDOW_MS };
