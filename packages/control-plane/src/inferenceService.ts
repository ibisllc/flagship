/**
 * `.com`'s own calls through Flagship Inference: the adapter review and the
 * weekly adapter insight (apps/com adapterReview.ts, adapterInsights.ts).
 * No provider key lives on `.com` for them: `.com` mints itself a short pass
 * with the shim's shared secret (FLAGSHIP_INFERENCE_TOKEN_SECRET) and calls
 * the shim like a box does; the shim picks the upstream (DeepInfra, then
 * OpenRouter) and reports usage back.
 *
 * A service pass names `service` and the account `service:<name>`, which no
 * username can be (usernames are [a-z0-9-]). The allowance check and the
 * usage report recognise it and count it on the service's own daily budget
 * ("ai-service-day"), never on an account's free AI, the monthly
 * "ai-tokens" or the all-accounts promotion cap, and the promotion ending or
 * being busy never stops it. The model is fixed per service, not the box
 * menu's choice, and runs even when the owner turns it off in the menus.
 */

import type { MeterStorage, TierStorage } from "@flagship/storage";
import { TOKENS_PER_CREDIT, weightedTokens, type FreeAiConfig, FREE_AI_DEFAULTS } from "./freeAiCredits.js";
import {
  mintScopedInferenceToken,
  type InferenceService,
  type InferenceTokenClaims,
} from "./inferenceToken.js";
import { resolveInferenceModel, type InferenceLineup, type ResolvedInferenceModel } from "./inferenceSettings.js";
import { meterCheck, meterRecord, sameForEveryTier, type MeterDeps } from "./meter.js";
import { ok, type HandlerResponse } from "./types.js";

/**
 * The catalog model each service runs on. DeepSeek-V4-Flash ("medium"): reads
 * code well, a 1M-token context (an adapter is at most ~40k tokens), the
 * cheapest output in the catalog, and answers plain JSON with thinking off.
 */
export const SERVICE_MODELS: Record<InferenceService, string> = {
  "adapter-review": "medium",
  "adapter-insights": "medium",
};

/** Weighted tokens a service may spend per UTC day (about 100 full-size reviews). */
export const SERVICE_DAILY_TOKENS = 5_000_000;

/** A service pass lives just long enough for one call. */
export const SERVICE_TOKEN_TTL_MS = 10 * 60_000;

export function serviceAccountId(service: InferenceService): string {
  return `service:${service}`;
}

export async function mintServiceInferenceToken(
  service: InferenceService,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  return mintScopedInferenceToken(
    {
      username: serviceAccountId(service),
      service,
      keyId: `svc-${crypto.randomUUID()}`,
      iat: now,
      exp: now + SERVICE_TOKEN_TTL_MS,
      dailyInputTokenCap: 0,
      dailyOutputTokenCap: 0,
    },
    secret,
  );
}

/** The service's model even when the menus have it off; the default when the catalog lost it. */
export function resolveServiceModel(service: InferenceService, lineup?: InferenceLineup): ResolvedInferenceModel {
  const id = SERVICE_MODELS[service];
  if (!lineup) return resolveInferenceModel(id);
  const forced: InferenceLineup = {
    ...lineup,
    entries: lineup.entries.map((e) => (e.id === id ? { ...e, enabled: true } : e)),
  };
  return resolveInferenceModel(id, forced);
}

export interface ServiceMeterDeps {
  meter: MeterStorage;
  tiers: TierStorage;
  config?: FreeAiConfig;
  now?: () => number;
  dailyTokens?: number;
}

function serviceMeter(deps: ServiceMeterDeps): MeterDeps {
  return {
    meter: deps.meter,
    tiers: deps.tiers,
    now: deps.now,
    resources: {
      "ai-service-day": {
        unit: "tokens",
        period: "day",
        plans: sameForEveryTier(deps.dailyTokens ?? SERVICE_DAILY_TOKENS, "stop"),
      },
    },
  };
}

/** The shim's allowance answer for a service pass. */
export async function serviceAllowance(
  deps: ServiceMeterDeps & { lineup?: InferenceLineup },
  claims: InferenceTokenClaims & { service: InferenceService },
): Promise<HandlerResponse> {
  const v = await meterCheck(serviceMeter(deps), serviceAccountId(claims.service), "ai-service-day");
  const cfg = deps.config ?? FREE_AI_DEFAULTS;
  return ok({
    ok: true,
    remainingTokens: Math.max(0, v.remaining),
    allowanceTokens: deps.dailyTokens ?? SERVICE_DAILY_TOKENS,
    ...(v.remaining <= 0 ? { code: "free-ai-busy-today" } : {}),
    model: resolveServiceModel(claims.service, deps.lineup),
    inputWeight: cfg.inputWeight,
    outputWeight: cfg.outputWeight,
    creditTokens: TOKENS_PER_CREDIT,
  });
}

/** A usage report for a service pass: the service's counters only, at its model's multiplier. */
export async function recordServiceUsage(
  deps: ServiceMeterDeps & { lineup?: InferenceLineup },
  service: InferenceService,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const md = serviceMeter(deps);
  const account = serviceAccountId(service);
  const multiplier = resolveServiceModel(service, deps.lineup).multiplier;
  await meterRecord(md, account, "ai-service-input", Math.max(0, Math.floor(inputTokens)));
  await meterRecord(md, account, "ai-service-output", Math.max(0, Math.floor(outputTokens)));
  const weighted = Math.ceil(weightedTokens(deps.config ?? FREE_AI_DEFAULTS, inputTokens, outputTokens) * Math.max(1, multiplier));
  await meterRecord(md, account, "ai-service-day", weighted);
}
