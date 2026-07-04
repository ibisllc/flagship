/**
 * LLM-promo issue endpoint.
 *
 * Phone-signed request from a user to get a one-shot scoped LLM API key
 * (Anthropic / OpenAI / Google) that the box can use to vibe-code an app.
 * The Worker checks tier-based daily/lifetime caps; if under the cap,
 * mints a scoped key from the upstream provider and returns it.
 *
 * Privacy: the Worker holds the upstream master keys (Anthropic + OpenAI
 * org credentials), but the user's prompts go directly box → provider —
 * the Worker never proxies LLM traffic. We rely on usage webhooks from
 * the providers to update the per-user counters here; without a
 * webhook the daily counter still bumps on issue, so we never over-grant.
 *
 * Tier caps (defaults, override via env):
 *   free:   50 calls/day,  200 lifetime
 *   hobby: 100 calls/day, 1000 lifetime
 *   maker: 500 calls/day,  ∞ lifetime
 *
 * Per-call default token caps:
 *   1000 input / 500 output (free + hobby)
 *   2000 input / 1000 output (maker)
 */

import {
  verifyLlmPromoIssue,
  type LlmPromoIssueRequest,
  type LlmProvider,
} from "@flagship/protocol";
import type { InferenceEndpoint } from "./inferenceEndpoint.js";
import type {
  DemoLlmLedgerStorage,
  LlmPromoStorage,
  TierName,
  TierStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

export interface LlmPromoDeps {
  llmPromo: LlmPromoStorage;
  tiers: TierStorage;
  usernames: UsernameStorage;
  /**
   * Mints a scoped API key against the provider (Anthropic /
   * OpenAI / Google). Worker-injected. Production wires it to real
   * provider APIs; tests inject a stub that returns a fake key.
   */
  mintProviderKey: (args: {
    provider: LlmProvider;
    username: string;
    serverFqdn: string;
    dailyInputTokenCap: number;
    dailyOutputTokenCap: number;
    expiresAt: number;
  }) => Promise<{ key: string; providerKeyId: string }>;
  /**
   * The blessed in-house inference endpoint. REQUIRED for a
   * `provider:"flagship"` issue — absent ⇒ that issue is refused (503)
   * rather than minting a key the box can't route. Upstream providers
   * (anthropic/openai/google) never consult it. Surfaced in the issue
   * response as `baseUrl`+`model` so the client saves them with the key.
   */
  inferenceEndpoint?: InferenceEndpoint | null;
  freshnessMs?: number;
  now?: () => number;
  /** Override caps per tier. */
  caps?: Partial<Record<TierName, TierCaps>>;
  /**
   * #85 — rolling-window token ledger for `is_demo` accounts. A demo
   * account must never reach a real provider key uncapped, so when the
   * claim is `is_demo` this dep is REQUIRED: absent ⇒ the issue is
   * denied (fail closed). Non-demo accounts never touch it.
   */
  demoLlmLedger?: DemoLlmLedgerStorage;
  /** Demo ceiling override (default {@link DEMO_LLM_TOKEN_CAP_DEFAULT}). */
  demoLlmTokenCap?: number;
  /** Demo window override (default {@link DEMO_LLM_WINDOW_MS_DEFAULT}). */
  demoLlmWindowMs?: number;
}

export interface TierCaps {
  dailyCalls: number;
  lifetimeCalls: number; // -1 = unlimited
  perCallInputTokens: number;
  perCallOutputTokens: number;
}

const DEFAULT_CAPS: Record<TierName, TierCaps> = {
  free:  { dailyCalls: 50,  lifetimeCalls: 200,  perCallInputTokens: 1000, perCallOutputTokens: 500 },
  hobby: { dailyCalls: 100, lifetimeCalls: 1000, perCallInputTokens: 1000, perCallOutputTokens: 500 },
  maker: { dailyCalls: 500, lifetimeCalls: -1,   perCallInputTokens: 2000, perCallOutputTokens: 1000 },
};

/**
 * Strict rolling-window LLM token ceiling for `is_demo` accounts (#85).
 * Independent of (and on top of) the per-tier caps: a demo account
 * exists to let a reviewer exercise vibe-coding, not to fund sustained
 * real-provider spend. Hard stop ("demo quota reached"), never billing.
 * The Worker never proxies LLM traffic, so it pessimistically counts
 * the full per-issue grant at issue time (same philosophy as
 * llm_promo_usage). Both knobs are deps-overridable.
 */
export const DEMO_LLM_TOKEN_CAP_DEFAULT = 250_000;
export const DEMO_LLM_WINDOW_MS_DEFAULT = 24 * 60 * 60_000;

interface IssueBody {
  request?: Partial<LlmPromoIssueRequest>;
  signature?: string;
}

export async function handleLlmPromoIssue(
  deps: LlmPromoDeps,
  body: IssueBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.serverFqdn !== "string" ||
    typeof r.provider !== "string" ||
    (r.provider !== "anthropic" &&
      r.provider !== "openai" &&
      r.provider !== "google" &&
      r.provider !== "flagship") ||
    typeof r.desiredDailyInputTokenCap !== "number" ||
    typeof r.desiredDailyOutputTokenCap !== "number" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  const claim: LlmPromoIssueRequest = {
    username: r.username,
    serverFqdn: r.serverFqdn,
    provider: r.provider,
    desiredDailyInputTokenCap: r.desiredDailyInputTokenCap,
    desiredDailyOutputTokenCap: r.desiredDailyOutputTokenCap,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (!verifyLlmPromoIssue(claim, sig, irkPub)) return forbidden("invalid signature");

  const freshness = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > freshness) return forbidden("stale request");

  // Resolve tier (default 'free').
  const tierRec = await deps.tiers.get(r.username);
  const tier: TierName = tierRec?.tier ?? "free";
  const caps = (deps.caps ?? {})[tier] ?? DEFAULT_CAPS[tier];

  // Check daily cap.
  const today = Math.floor(now / 86_400_000);
  const dailyRec = await deps.llmPromo.getDaily(r.username, today);
  const dailyUsed = dailyRec?.dailyCount ?? 0;
  if (dailyUsed >= caps.dailyCalls) {
    const tomorrow = (today + 1) * 86_400_000;
    return {
      status: 429,
      body: {
        error: "daily promo cap reached",
        tier,
        dailyUsed,
        dailyCap: caps.dailyCalls,
        retryAt: tomorrow,
      },
    };
  }

  // Check lifetime cap.
  if (caps.lifetimeCalls !== -1) {
    const lifetimeRec = await deps.llmPromo.getLifetime(r.username);
    const lifetimeUsed = lifetimeRec?.lifetimeCount ?? 0;
    if (lifetimeUsed >= caps.lifetimeCalls) {
      return {
        status: 429,
        body: {
          error: "lifetime promo cap reached — bring your own key or upgrade tier",
          tier,
          lifetimeUsed,
          lifetimeCap: caps.lifetimeCalls,
        },
      };
    }
  }

  // Clamp the desired caps to the tier's per-call caps.
  const dailyInput = Math.min(r.desiredDailyInputTokenCap, caps.perCallInputTokens);
  const dailyOutput = Math.min(r.desiredDailyOutputTokenCap, caps.perCallOutputTokens);
  const expiresAt = now + 60 * 60_000; // 1h

  // #85 — strict rolling-window token ceiling for demo accounts, on top
  // of the tier caps above. Fail closed: a demo claim with no ledger
  // dep is a misconfiguration we must never resolve into a live
  // provider key. Count the full per-issue grant pessimistically (the
  // Worker never observes actual usage).
  const demoWindowMs = deps.demoLlmWindowMs ?? DEMO_LLM_WINDOW_MS_DEFAULT;
  const demoGrant = dailyInput + dailyOutput;
  if (userRec.isDemo) {
    if (!deps.demoLlmLedger) return forbidden("demo LLM disabled");
    const cap = deps.demoLlmTokenCap ?? DEMO_LLM_TOKEN_CAP_DEFAULT;
    const used = await deps.demoLlmLedger.sumSince(r.username, now - demoWindowMs);
    if (used + demoGrant > cap) {
      return {
        status: 429,
        body: {
          error: "demo quota reached",
          demo: true,
          usedTokens: used,
          capTokens: cap,
          windowMs: demoWindowMs,
        },
      };
    }
  }

  // In-house inference: a `flagship` issue is only valid when the blessed
  // endpoint is configured — otherwise refuse rather than hand the box a
  // key with nowhere to route. Upstream providers ignore this.
  if (r.provider === "flagship" && !deps.inferenceEndpoint) {
    return { status: 503, body: { error: "in-house inference not configured" } };
  }

  // Mint the provider key. For `flagship` the minter returns a scoped
  // `.com` token; for upstream providers it returns the provider's own
  // scoped key.
  const minted = await deps.mintProviderKey({
    provider: r.provider,
    username: r.username,
    serverFqdn: r.serverFqdn,
    dailyInputTokenCap: dailyInput,
    dailyOutputTokenCap: dailyOutput,
    expiresAt,
  });

  // Bump counters AFTER successful mint.
  await deps.llmPromo.bumpDaily(r.username, today, dailyInput, dailyOutput);
  await deps.llmPromo.bumpLifetime(r.username, dailyInput, dailyOutput, now);
  if (userRec.isDemo && deps.demoLlmLedger) {
    await deps.demoLlmLedger.append(r.username, now, demoGrant, now - demoWindowMs);
  }

  return ok({
    ok: true,
    provider: r.provider,
    apiKey: minted.key,
    providerKeyId: minted.providerKeyId,
    expiresAt,
    dailyInputTokenCap: dailyInput,
    dailyOutputTokenCap: dailyOutput,
    tier,
    // For `flagship`, hand the client the blessed endpoint so it saves
    // baseUrl+model with the key and the box talks to it directly. The
    // credential is marked promo-sourced so the daemon pins its SSRF
    // guard to this host.
    ...(r.provider === "flagship" && deps.inferenceEndpoint
      ? {
          baseUrl: deps.inferenceEndpoint.baseUrl,
          model: deps.inferenceEndpoint.model,
          source: "promo" as const,
        }
      : {}),
  });
}

export interface LlmPromoUsageDeps {
  llmPromo: LlmPromoStorage;
  /**
   * Authenticate a usage report: verify the scoped inference token the
   * metering shim re-presents (the SAME token it validated to serve the
   * request) and return the account it was minted for. Only our shim can
   * present a valid token, so this both authenticates the report and
   * identifies the user — no separate shared secret needed. The Worker
   * wires this to `verifyScopedInferenceToken(env secret)`.
   */
  verifyToken: (token: string) => Promise<{ ok: true; username: string } | { ok: false }>;
  now?: () => number;
}

interface UsageBody {
  token?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * POST /api/llm-promo/usage — the in-house inference metering webhook
 * (metering model (b)). The shim in front of RunPod reports TRUE token
 * usage per request; we record it against the token's account so
 * /api/llm-promo/status reflects real consumption. Because we own the
 * endpoint, this closes the integrity gap of the pessimistic issue-time
 * estimate used for providers we don't proxy.
 */
export async function handleLlmPromoUsage(
  deps: LlmPromoUsageDeps,
  body: UsageBody | undefined,
): Promise<HandlerResponse> {
  if (
    !body ||
    typeof body.token !== "string" ||
    typeof body.inputTokens !== "number" ||
    typeof body.outputTokens !== "number" ||
    !Number.isFinite(body.inputTokens) ||
    !Number.isFinite(body.outputTokens) ||
    body.inputTokens < 0 ||
    body.outputTokens < 0
  ) {
    return malformed("malformed usage report");
  }
  const v = await deps.verifyToken(body.token);
  if (!v.ok) return forbidden("invalid inference token");
  const now = (deps.now ?? (() => Date.now()))();
  const day = Math.floor(now / 86_400_000);
  await deps.llmPromo.recordMeteredUsage(
    v.username,
    day,
    Math.floor(body.inputTokens),
    Math.floor(body.outputTokens),
    now,
  );
  return ok({ ok: true });
}

export async function handleLlmPromoStatus(
  deps: LlmPromoDeps,
  username: string,
): Promise<HandlerResponse> {
  const userRec = await deps.usernames.get(username);
  if (!userRec) return notFound("username not registered");
  const tierRec = await deps.tiers.get(username);
  const tier: TierName = tierRec?.tier ?? "free";
  const caps = (deps.caps ?? {})[tier] ?? DEFAULT_CAPS[tier];
  const now = (deps.now ?? (() => Date.now()))();
  const today = Math.floor(now / 86_400_000);
  const daily = await deps.llmPromo.getDaily(username, today);
  const lifetime = await deps.llmPromo.getLifetime(username);
  return ok({
    tier,
    daily: {
      used: daily?.dailyCount ?? 0,
      cap: caps.dailyCalls,
      resetsAt: (today + 1) * 86_400_000,
    },
    lifetime: {
      used: lifetime?.lifetimeCount ?? 0,
      cap: caps.lifetimeCalls,
    },
    perCallTokens: {
      input: caps.perCallInputTokens,
      output: caps.perCallOutputTokens,
    },
  });
}
