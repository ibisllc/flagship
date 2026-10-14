/**
 * Flagship Inference — "for a limited time, building your apps is free on
 * Flagship" (docs/build-modes.md "Flagship Inference").
 *
 * The phone or webapp signs a `flagship/llm-promo-issue/v1` request
 * (provider "flagship") and `.com` answers with a short-lived scoped pass for
 * the metering shim (infra/inference/shim), the only place the model is
 * reached. The box gets that pass as an ordinary `source:"promo"` credential
 * and calls the shim through the hub relay; the shim checks the account here
 * before each call and reports true usage to `/api/llm-promo/usage`, which
 * records it through {@link recordFreeAiUsage}.
 *
 * The allowance, all counted on the metering core (meter.ts):
 *   - a weekly top-up ("ai-promo-week", resets Monday 00:00 UTC, the rest
 *     doesn't carry over), spent first;
 *   - a one-time starter reserve ("ai-promo-starter"), spent after it;
 *   - only while the account has a registered server that reported in the
 *     last day, so a farm of accounts without boxes gets nothing;
 *   - a cap on every account's use together per UTC day ("ai-promo-global"),
 *     so the promotion can't cost more than a set amount a day;
 *   - until an optional end date.
 * Tokens are weighted (an output token costs more to serve; the apps show
 * them as credits of {@link TOKENS_PER_CREDIT}); raw input and output are
 * recorded too ("ai-promo-input"/"ai-promo-output"). All numbers
 * are `.com` config ({@link freeAiConfigFromEnv}). Minting records nothing,
 * so the apps mint a fresh pass for every build start and reply.
 */

import { verifyLlmPromoIssue, type LlmPromoIssueRequest } from "@flagship/protocol";
import type {
  DaemonStatusStorage,
  MeterStorage,
  ServerStorage,
  TierStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { InferenceEndpoint } from "./inferenceEndpoint.js";
import { mintScopedInferenceToken, verifyScopedInferenceToken } from "./inferenceToken.js";
import { resolveInferenceModel } from "./inferenceModels.js";
import { meterCheck, meterRecord, sameForEveryTier, type MeterDeps, type MeterResource } from "./meter.js";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/** How long a minted pass works. The apps mint a fresh one per send. */
export const FREE_AI_TOKEN_TTL_MS = 12 * 60 * 60_000;

/** A server counts as running when it reported in this long ago or less. */
export const SERVER_SEEN_WINDOW_MS = 24 * 60 * 60_000;

/** The account id of the all-accounts daily counter. */
const GLOBAL_ACCOUNT = "*";

export const FREE_AI_MESSAGES = {
  usedUp: "You've used this week's Flagship Inference credits. More arrive on Monday, or add your own AI key to keep building.",
  busyToday: "Flagship Inference is busy today. Try again tomorrow, or use your own AI key.",
  ended: "The free building period has ended — use your own AI key.",
  noServer: "Flagship Inference starts once one of your servers is running.",
  unavailable: "Flagship Inference isn't available right now. You can add your own AI key.",
  /** The shim's `free-ai-too-long`: the request didn't fit the model's context. */
  tooLong: "This build is too big for Flagship Inference. Try a smaller change, or use your own AI key.",
} as const;

export interface FreeAiConfig {
  /** One-time reserve per account, in weighted tokens. */
  starterTokens: number;
  /** Top-up each ISO week, in weighted tokens; doesn't accumulate. */
  weeklyTokens: number;
  /** Every account together, per UTC day, in weighted tokens. */
  dailyCapTokens: number;
  /** Weighted tokens = input × inputWeight + output × outputWeight. */
  inputWeight: number;
  outputWeight: number;
  /** After this (ms), nothing new is issued and the apps hide free AI. */
  endsAt: number | null;
}

export const FREE_AI_DEFAULTS: FreeAiConfig = {
  starterTokens: 2_000_000,
  weeklyTokens: 500_000,
  dailyCapTokens: 50_000_000,
  inputWeight: 1,
  outputWeight: 4,
  endsAt: null,
};

function wholeOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function weightOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** ISO 8601 date/time or epoch ms; anything else ⇒ no end date. */
function dateOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const t = raw.trim();
  const ms = /^\d+$/.test(t) ? Number(t) : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The promotion's numbers from `.com` env vars, each optional:
 *   AI_PROMO_STARTER_TOKENS   (default 2,000,000)
 *   AI_PROMO_WEEKLY_TOKENS    (default 500,000)
 *   AI_PROMO_DAILY_CAP_TOKENS (default 50,000,000, all accounts together)
 *   AI_PROMO_INPUT_WEIGHT     (default 1)
 *   AI_PROMO_OUTPUT_WEIGHT    (default 4)
 *   AI_PROMO_ENDS_AT          (ISO 8601 or epoch ms; unset ⇒ no end date)
 * A malformed value falls back to its default rather than breaking the promo.
 */
export function freeAiConfigFromEnv(env: Record<string, string | undefined>): FreeAiConfig {
  return {
    starterTokens: wholeOr(env.AI_PROMO_STARTER_TOKENS, FREE_AI_DEFAULTS.starterTokens),
    weeklyTokens: wholeOr(env.AI_PROMO_WEEKLY_TOKENS, FREE_AI_DEFAULTS.weeklyTokens),
    dailyCapTokens: wholeOr(env.AI_PROMO_DAILY_CAP_TOKENS, FREE_AI_DEFAULTS.dailyCapTokens),
    inputWeight: weightOr(env.AI_PROMO_INPUT_WEIGHT, FREE_AI_DEFAULTS.inputWeight),
    outputWeight: weightOr(env.AI_PROMO_OUTPUT_WEIGHT, FREE_AI_DEFAULTS.outputWeight),
    endsAt: dateOrNull(env.AI_PROMO_ENDS_AT),
  };
}

/** Weighted tokens for a usage report (rounded up). */
export function weightedTokens(cfg: FreeAiConfig, inputTokens: number, outputTokens: number): number {
  return Math.ceil(Math.max(0, inputTokens) * cfg.inputWeight + Math.max(0, outputTokens) * cfg.outputWeight);
}

/** The apps show credits: one credit is this many weighted tokens. */
export const TOKENS_PER_CREDIT = 1000;

/** Whole credits in a weighted-token count (rounded down, never negative). */
export function creditsOf(weighted: number): number {
  return Math.max(0, Math.floor(weighted / TOKENS_PER_CREDIT));
}

export interface AiCredits {
  week: { used: number; allowance: number; remaining: number; resetsAt: number | null };
  starter: { used: number; allowance: number; remaining: number };
  /** Totals across both, as the first apps read them. */
  usedTokens: number;
  allowanceTokens: number;
  remainingTokens: number;
  /** What the apps show: the week's and the starter's credits left together. */
  remainingCredits: number;
  /** The weekly top-up in credits. */
  weeklyCredits: number;
  tokensPerCredit: number;
}

/** Why free AI can't be used right now (null: it can, while credits remain). */
export type FreeAiBlock = "unconfigured" | "ended" | "no-server" | "busy-today" | null;

export interface FreeAiDeps {
  usernames: UsernameStorage;
  servers: ServerStorage;
  daemonStatus: DaemonStatusStorage;
  meter: MeterStorage;
  tiers: TierStorage;
  /** Null when the endpoint or the token secret isn't configured. */
  endpoint: InferenceEndpoint | null;
  tokenSecret: string | undefined;
  config?: FreeAiConfig;
  freshnessMs?: number;
  now?: () => number;
  /** Test seam for the pass's key id. */
  newKeyId?: () => string;
}

type MeterSide = Pick<FreeAiDeps, "meter" | "tiers" | "config" | "now">;

function cfgOf(deps: { config?: FreeAiConfig }): FreeAiConfig {
  return deps.config ?? FREE_AI_DEFAULTS;
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? (() => Date.now()))();
}

function meterDeps(deps: MeterSide): MeterDeps {
  const cfg = cfgOf(deps);
  return {
    meter: deps.meter,
    tiers: deps.tiers,
    now: deps.now,
    resources: {
      "ai-promo-week": { unit: "tokens", period: "week", plans: sameForEveryTier(cfg.weeklyTokens, "stop") },
      "ai-promo-starter": { unit: "tokens", period: "lifetime", plans: sameForEveryTier(cfg.starterTokens, "stop") },
      "ai-promo-global": { unit: "tokens", period: "day", plans: sameForEveryTier(cfg.dailyCapTokens, "stop") },
    },
  };
}

function check(deps: MeterSide, account: string, r: MeterResource) {
  return meterCheck(meterDeps(deps), account, r);
}

/** The account's weekly and starter credits right now. */
export async function freeAiCredits(deps: MeterSide, username: string): Promise<AiCredits> {
  const week = await check(deps, username, "ai-promo-week");
  const starter = await check(deps, username, "ai-promo-starter");
  return {
    week: { used: week.used, allowance: week.allowance, remaining: week.remaining, resetsAt: week.resetsAt },
    starter: { used: starter.used, allowance: starter.allowance, remaining: starter.remaining },
    usedTokens: week.used + starter.used,
    allowanceTokens: week.allowance + starter.allowance,
    remainingTokens: week.remaining + starter.remaining,
    remainingCredits: creditsOf(week.remaining + starter.remaining),
    weeklyCredits: creditsOf(week.allowance),
    tokensPerCredit: TOKENS_PER_CREDIT,
  };
}

/** Has every account together used today's cap? */
async function busyToday(deps: MeterSide): Promise<boolean> {
  return (await check(deps, GLOBAL_ACCOUNT, "ai-promo-global")).remaining <= 0;
}

function ended(deps: { config?: FreeAiConfig; now?: () => number }): boolean {
  const endsAt = cfgOf(deps).endsAt;
  return endsAt !== null && nowOf(deps) >= endsAt;
}

/** A registered, unrevoked server of the account reported in recently. */
export async function hasRunningServer(
  deps: Pick<FreeAiDeps, "servers" | "daemonStatus" | "now">,
  username: string,
): Promise<boolean> {
  const since = nowOf(deps) - SERVER_SEEN_WINDOW_MS;
  for (const s of await deps.servers.listForUser(username)) {
    if (s.revokedAt !== undefined) continue;
    const st = await deps.daemonStatus.get(s.serverDomain);
    if (st && st.lastReported >= since) return true;
  }
  return false;
}

async function blockFor(deps: FreeAiDeps, username: string): Promise<FreeAiBlock> {
  if (!deps.endpoint || !deps.tokenSecret) return "unconfigured";
  if (ended(deps)) return "ended";
  if (!(await hasRunningServer(deps, username))) return "no-server";
  if (await busyToday(deps)) return "busy-today";
  return null;
}

const BLOCK_REPLY: Record<Exclude<FreeAiBlock, null>, { status: number; code: string; message: string }> = {
  unconfigured: { status: 503, code: "free-ai-unavailable", message: FREE_AI_MESSAGES.unavailable },
  ended: { status: 410, code: "free-ai-ended", message: FREE_AI_MESSAGES.ended },
  "no-server": { status: 403, code: "free-ai-no-server", message: FREE_AI_MESSAGES.noServer },
  "busy-today": { status: 429, code: "free-ai-busy-today", message: FREE_AI_MESSAGES.busyToday },
};

interface SignedBody {
  request?: Partial<LlmPromoIssueRequest>;
  signature?: unknown;
}

/**
 * Check a signed free-AI request: well-formed, provider "flagship", signed by
 * the account's AID or IRK (the dual-accept every account-signed `.com` call
 * uses), and fresh. Returns the lowercased username or an error.
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
  if (Math.abs(nowOf(deps) - r.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) {
    return { ok: false, res: forbidden("stale request") };
  }
  return { ok: true, username: r.username.toLowerCase() };
}

/**
 * `POST /api/free-ai/status` — what the apps show. `available` is false when
 * free AI isn't configured or has ended (`ended: true`: the apps hide it);
 * `reason` names what stops it right now ("no-server", "busy-today"), with
 * `message` to show.
 */
export async function handleFreeAiStatus(
  deps: FreeAiDeps,
  body: SignedBody | undefined,
): Promise<HandlerResponse> {
  const auth = await authenticate(deps, body);
  if (!auth.ok) return auth.res;
  const block = await blockFor(deps, auth.username);
  const credits = await freeAiCredits(deps, auth.username);
  const available = block !== "unconfigured" && block !== "ended";
  return {
    status: 200,
    body: {
      available,
      ended: block === "ended",
      reason: available ? block : null,
      ...(block ? { message: BLOCK_REPLY[block].message } : {}),
      credits,
    },
  };
}

/**
 * `POST /api/free-ai/token` — a pass the box can build with. Nothing is
 * counted here; the shim meters what it's actually used for.
 */
export async function handleFreeAiToken(
  deps: FreeAiDeps,
  body: SignedBody | undefined,
): Promise<HandlerResponse> {
  const auth = await authenticate(deps, body);
  if (!auth.ok) return auth.res;
  const block = await blockFor(deps, auth.username);
  if (block) {
    const b = BLOCK_REPLY[block];
    return { status: b.status, body: { error: b.message, code: b.code } };
  }
  const credits = await freeAiCredits(deps, auth.username);
  if (credits.remainingTokens <= 0) {
    return { status: 429, body: { error: FREE_AI_MESSAGES.usedUp, code: "free-ai-used-up", credits } };
  }
  const endpoint = deps.endpoint!;
  const now = nowOf(deps);
  const endsAt = cfgOf(deps).endsAt;
  const expiresAt = Math.min(now + FREE_AI_TOKEN_TTL_MS, endsAt ?? Number.POSITIVE_INFINITY);
  const keyId = deps.newKeyId?.() ?? `fa-${crypto.randomUUID()}`;
  // The per-token caps are what an older shim enforces on its own; the
  // allowance the shim checks before each call is the real limit.
  const apiKey = await mintScopedInferenceToken(
    {
      username: auth.username,
      keyId,
      iat: now,
      exp: expiresAt,
      dailyInputTokenCap: credits.remainingTokens,
      dailyOutputTokenCap: credits.remainingTokens,
    },
    deps.tokenSecret!,
  );
  return {
    status: 200,
    body: {
      ok: true,
      credential: { provider: "flagship", apiKey, baseUrl: endpoint.baseUrl, source: "promo", relay: true },
      model: endpoint.model,
      expiresAt,
      credits,
    },
  };
}

/**
 * `POST /api/free-ai/allowance` — the shim's check before each model call,
 * authenticated by the pass itself (only `.com` can mint one). A refusal
 * carries the `code` and `message` the shim hands the box.
 */
export async function handleFreeAiAllowance(
  deps: Pick<FreeAiDeps, "meter" | "tiers" | "tokenSecret" | "config" | "now">,
  body: { token?: unknown; model?: unknown } | undefined,
): Promise<HandlerResponse> {
  if (!deps.tokenSecret) {
    return { status: 503, body: { error: FREE_AI_MESSAGES.unavailable, code: "free-ai-unavailable" } };
  }
  if (!body || typeof body.token !== "string") return malformed("malformed body");
  const v = await verifyScopedInferenceToken(body.token, deps.tokenSecret, nowOf(deps));
  if (!v.ok) return forbidden("invalid inference token");
  const credits = await freeAiCredits(deps, v.claims.username);
  const stop = ended(deps)
    ? { code: "free-ai-ended", message: FREE_AI_MESSAGES.ended }
    : (await busyToday(deps))
      ? { code: "free-ai-busy-today", message: FREE_AI_MESSAGES.busyToday }
      : credits.remainingTokens <= 0
        ? { code: "free-ai-used-up", message: FREE_AI_MESSAGES.usedUp }
        : null;
  return {
    status: 200,
    body: {
      ok: true,
      remainingTokens: stop ? 0 : credits.remainingTokens,
      allowanceTokens: credits.allowanceTokens,
      ...(stop ?? {}),
      // The catalog model the box asked for (unknown ⇒ the default): its
      // multiplier, modalities and id on each upstream, and how a call's
      // tokens become credits, so the shim routes it and tells the box its cost.
      model: resolveInferenceModel(typeof body.model === "string" ? body.model : undefined),
      inputWeight: cfgOf(deps).inputWeight,
      outputWeight: cfgOf(deps).outputWeight,
      creditTokens: TOKENS_PER_CREDIT,
    },
  };
}

/**
 * Charge a usage report from the shim: raw input and output are recorded as
 * they are; the weighted total, times the catalog model's multiplier, comes
 * out of this week's top-up first, then the starter reserve, and is added to
 * the all-accounts daily counter.
 */
export async function recordFreeAiUsage(
  deps: MeterSide,
  username: string,
  inputTokens: number,
  outputTokens: number,
  multiplier = 1,
): Promise<AiCredits> {
  const md = meterDeps(deps);
  const account = username.toLowerCase();
  await meterRecord(md, account, "ai-promo-input", Math.max(0, Math.floor(inputTokens)));
  await meterRecord(md, account, "ai-promo-output", Math.max(0, Math.floor(outputTokens)));
  const weighted = Math.ceil(weightedTokens(cfgOf(deps), inputTokens, outputTokens) * Math.max(1, multiplier));
  const week = await meterCheck(md, account, "ai-promo-week");
  const fromWeek = Math.min(weighted, week.remaining);
  if (fromWeek > 0) await meterRecord(md, account, "ai-promo-week", fromWeek);
  if (weighted > fromWeek) await meterRecord(md, account, "ai-promo-starter", weighted - fromWeek);
  await meterRecord(md, GLOBAL_ACCOUNT, "ai-promo-global", weighted);
  return freeAiCredits(deps, account);
}
