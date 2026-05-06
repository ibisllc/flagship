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
import type {
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
  freshnessMs?: number;
  now?: () => number;
  /** Override caps per tier. */
  caps?: Partial<Record<TierName, TierCaps>>;
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
    (r.provider !== "anthropic" && r.provider !== "openai" && r.provider !== "google") ||
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

  // Mint the upstream provider key.
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

  return ok({
    ok: true,
    provider: r.provider,
    apiKey: minted.key,
    providerKeyId: minted.providerKeyId,
    expiresAt,
    dailyInputTokenCap: dailyInput,
    dailyOutputTokenCap: dailyOutput,
    tier,
  });
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
