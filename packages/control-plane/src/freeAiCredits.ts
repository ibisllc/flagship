/**
 * Free AI credits — the launch path for building apps without your own AI
 * key (docs/build-modes.md "Free AI credits").
 *
 * The phone or webapp signs a `flagship/llm-promo-issue/v1` request
 * (provider "flagship") and `.com` answers with a short-lived scoped token
 * for the metering shim (infra/inference/shim), the only place the model is
 * reached. The box gets that token as an ordinary `source:"promo"`
 * credential and calls the shim through the hub relay; the shim checks the
 * account's allowance here before each call and reports true usage to
 * `/api/llm-promo/usage` after it.
 *
 * Minting records nothing: only metered usage counts against the
 * allowance, so clients can mint a fresh token for every build and reply.
 * The allowance is read through {@link AiCreditsLedger}, the one seam the
 * shared metering core ("ai-tokens") replaces when it lands; until then it
 * reads the metered totals `handleLlmPromoUsage` already records.
 */

import { verifyLlmPromoIssue, type LlmPromoIssueRequest } from "@flagship/protocol";
import type { LlmPromoStorage, UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { InferenceEndpoint } from "./inferenceEndpoint.js";
import { mintScopedInferenceToken, verifyScopedInferenceToken } from "./inferenceToken.js";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/** Tokens (input + output) each account may use for free. */
export const FREE_AI_TOKENS_DEFAULT = 1_000_000;

/** How long a minted token works. Clients mint a fresh one per send. */
export const FREE_AI_TOKEN_TTL_MS = 12 * 60 * 60_000;

export const FREE_AI_USED_UP_MESSAGE =
  "Your free AI credits are used up. Add your own AI key to keep building.";
export const FREE_AI_UNAVAILABLE_MESSAGE =
  "Free AI isn't available right now. You can add your own AI key.";

export interface AiCredits {
  usedTokens: number;
  allowanceTokens: number;
  remainingTokens: number;
}

/** Where the account's AI-token use is read from. */
export interface AiCreditsLedger {
  usedTokens(username: string): Promise<number>;
}

/** The ledger over the metered totals in `llm_promo_lifetime`. */
export function promoStorageLedger(storage: LlmPromoStorage): AiCreditsLedger {
  return {
    async usedTokens(username) {
      const rec = await storage.getLifetime(username);
      return (rec?.lifetimeInputTokens ?? 0) + (rec?.lifetimeOutputTokens ?? 0);
    },
  };
}

/** Parse `FLAGSHIP_FREE_AI_TOKENS`; absent or invalid ⇒ the default. "0" turns free AI off. */
export function parseFreeAiAllowance(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return FREE_AI_TOKENS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return FREE_AI_TOKENS_DEFAULT;
  return Math.floor(n);
}

export interface FreeAiDeps {
  usernames: UsernameStorage;
  ledger: AiCreditsLedger;
  /** Null when the endpoint or the token secret isn't configured. */
  endpoint: InferenceEndpoint | null;
  tokenSecret: string | undefined;
  allowanceTokens?: number;
  freshnessMs?: number;
  now?: () => number;
  /** Test seam for the token's key id. */
  newKeyId?: () => string;
}

interface SignedBody {
  request?: Partial<LlmPromoIssueRequest>;
  signature?: unknown;
}

async function creditsFor(deps: FreeAiDeps, username: string): Promise<AiCredits> {
  const allowanceTokens = deps.allowanceTokens ?? FREE_AI_TOKENS_DEFAULT;
  const usedTokens = Math.max(0, await deps.ledger.usedTokens(username));
  return { usedTokens, allowanceTokens, remainingTokens: Math.max(0, allowanceTokens - usedTokens) };
}

function available(deps: FreeAiDeps): boolean {
  return !!deps.endpoint && !!deps.tokenSecret && (deps.allowanceTokens ?? FREE_AI_TOKENS_DEFAULT) > 0;
}

/**
 * Check a signed free-AI request: well-formed, provider "flagship", signed
 * by the account's AID or IRK (the dual-accept every account-signed `.com`
 * call uses), and fresh. Returns the normalised username or an error.
 */
async function authenticate(
  deps: FreeAiDeps,
  body: SignedBody | undefined,
): Promise<{ ok: true; username: string } | { ok: false; res: HandlerResponse }> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    r.username.length === 0 ||
    typeof r.serverFqdn !== "string" ||
    r.provider !== "flagship" ||
    typeof r.desiredDailyInputTokenCap !== "number" ||
    typeof r.desiredDailyOutputTokenCap !== "number" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return { ok: false, res: malformed("malformed body") };
  }
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { ok: false, res: notFound("username not registered") };
  const claim: LlmPromoIssueRequest = {
    username: r.username,
    serverFqdn: r.serverFqdn,
    provider: "flagship",
    desiredDailyInputTokenCap: r.desiredDailyInputTokenCap,
    desiredDailyOutputTokenCap: r.desiredDailyOutputTokenCap,
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return { ok: false, res: malformed("invalid hex") };
  }
  const keys = [userRec.aidPubHex, userRec.irkPubHex].filter((k): k is string => typeof k === "string");
  const signed = keys.some((hex) => {
    try {
      return verifyLlmPromoIssue(claim, sig, hexToBytes(hex));
    } catch {
      return false;
    }
  });
  if (!signed) return { ok: false, res: forbidden("invalid signature") };
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) {
    return { ok: false, res: forbidden("stale request") };
  }
  return { ok: true, username: r.username.toLowerCase() };
}

/** `POST /api/free-ai/status` — the account's free AI credits. */
export async function handleFreeAiStatus(
  deps: FreeAiDeps,
  body: SignedBody | undefined,
): Promise<HandlerResponse> {
  const auth = await authenticate(deps, body);
  if (!auth.ok) return auth.res;
  return { status: 200, body: { available: available(deps), credits: await creditsFor(deps, auth.username) } };
}

/**
 * `POST /api/free-ai/token` — a credential the box can build with. Nothing
 * is counted here; the shim meters what the token is actually used for.
 */
export async function handleFreeAiToken(
  deps: FreeAiDeps,
  body: SignedBody | undefined,
): Promise<HandlerResponse> {
  const auth = await authenticate(deps, body);
  if (!auth.ok) return auth.res;
  if (!available(deps) || !deps.endpoint || !deps.tokenSecret) {
    return { status: 503, body: { error: FREE_AI_UNAVAILABLE_MESSAGE, code: "free-ai-unavailable" } };
  }
  const credits = await creditsFor(deps, auth.username);
  if (credits.remainingTokens <= 0) {
    return { status: 429, body: { error: FREE_AI_USED_UP_MESSAGE, code: "free-ai-used-up", credits } };
  }
  const now = (deps.now ?? (() => Date.now()))();
  const expiresAt = now + FREE_AI_TOKEN_TTL_MS;
  const keyId = deps.newKeyId?.() ?? `fa-${crypto.randomUUID()}`;
  // The per-token caps are what an older shim enforces on its own; the
  // account allowance the shim checks before each call is the real limit.
  const apiKey = await mintScopedInferenceToken(
    {
      username: auth.username,
      keyId,
      iat: now,
      exp: expiresAt,
      dailyInputTokenCap: credits.remainingTokens,
      dailyOutputTokenCap: credits.remainingTokens,
    },
    deps.tokenSecret,
  );
  return {
    status: 200,
    body: {
      ok: true,
      credential: {
        provider: "flagship",
        apiKey,
        baseUrl: deps.endpoint.baseUrl,
        source: "promo",
        relay: true,
      },
      model: deps.endpoint.model,
      expiresAt,
      credits,
    },
  };
}

/**
 * `POST /api/free-ai/allowance` — the shim's check before each model call.
 * Authenticated by the token itself (only `.com` can mint one).
 */
export async function handleFreeAiAllowance(
  deps: Pick<FreeAiDeps, "ledger" | "tokenSecret" | "allowanceTokens" | "now">,
  body: { token?: unknown } | undefined,
): Promise<HandlerResponse> {
  if (!deps.tokenSecret) {
    return { status: 503, body: { error: FREE_AI_UNAVAILABLE_MESSAGE, code: "free-ai-unavailable" } };
  }
  if (!body || typeof body.token !== "string") return malformed("malformed body");
  const now = (deps.now ?? (() => Date.now()))();
  const v = await verifyScopedInferenceToken(body.token, deps.tokenSecret, now);
  if (!v.ok) return forbidden("invalid inference token");
  const allowanceTokens = deps.allowanceTokens ?? FREE_AI_TOKENS_DEFAULT;
  const usedTokens = Math.max(0, await deps.ledger.usedTokens(v.claims.username));
  return {
    status: 200,
    body: { ok: true, remainingTokens: Math.max(0, allowanceTokens - usedTokens), allowanceTokens },
  };
}
