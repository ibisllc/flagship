// flagshipserver.com answers every rate-limited call with HTTP 429 and
//   { error: "rate-limited", endpoint, limit: "ip"|"irk"|"usernameHash",
//     retryAfterSec, message }
// The sentence is worded here from `limit` + `retryAfterSec`, the same way
// as apps/com/src/rateLimit.ts (rateLimitedMessage), so every screen says
// who is limited and when to try again. Other 429s (free-ai-used-up, the
// username-suggest cooldown, wipe-restart) keep their own shapes.
//
// MIRRORS: iOS + Android "rate-limited-message" (parity/features.json).

export const RATE_LIMITED_FALLBACK = "Too many tries. Try again later.";

const WHO = {
  ip: "from your network",
  irk: "from this account",
  usernameHash: "for this account name",
};

/** "in a minute" / "in about 12 minutes" / "in about 2 hours". */
export function retryAfterPhrase(sec) {
  if (sec < 60) return "in a minute";
  const min = Math.ceil(sec / 60);
  if (min < 60) return `in about ${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.max(1, Math.round(min / 60));
  return `in about ${h} hour${h === 1 ? "" : "s"}`;
}

/** The sentence for a limit axis and wait, or null when either is unusable. */
export function rateLimitedMessage(limit, retryAfterSec) {
  const who = typeof limit === "string" && Object.hasOwn(WHO, limit) ? WHO[limit] : null;
  const sec = seconds(retryAfterSec);
  if (!who || sec === null) return null;
  return `Too many tries ${who}. Try again ${retryAfterPhrase(sec)}.`;
}

function seconds(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True for the edge rate limiter's 429 body. */
export function isRateLimitedBody(body) {
  return !!body && typeof body === "object" && body.error === "rate-limited";
}

export class RateLimitedError extends Error {
  constructor(body = {}, retryAfterHeader = null) {
    const retryAfterSec = seconds(body.retryAfterSec) ?? seconds(retryAfterHeader);
    const limit = typeof body.limit === "string" ? body.limit : null;
    const serverMessage = typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;
    super(rateLimitedMessage(limit, retryAfterSec) ?? serverMessage ?? RATE_LIMITED_FALLBACK);
    this.name = "RateLimitedError";
    this.rateLimited = true;
    this.code = "rate-limited";
    this.status = 429;
    this.endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
    this.limit = limit;
    this.retryAfterSec = retryAfterSec;
  }
}

/** The error for a parsed response, or null when it isn't the rate limiter's 429. */
export function rateLimitedError(status, body, retryAfterHeader = null) {
  if (status !== 429 || !isRateLimitedBody(body)) return null;
  return new RateLimitedError(body, retryAfterHeader);
}

/**
 * The error for a fetch Response, or null. Reads a clone, so the caller can
 * still read the body when it isn't the rate limiter's.
 */
export async function rateLimitedFromResponse(resp) {
  if (!resp || resp.status !== 429) return null;
  let body = null;
  try {
    const copy = typeof resp.clone === "function" ? resp.clone() : resp;
    body = JSON.parse(await copy.text());
  } catch {
    return null;
  }
  return rateLimitedError(429, body, resp.headers?.get?.("retry-after") ?? null);
}

/** Throw the rate limiter's error for this Response, if it is one. */
export async function throwIfRateLimited(resp) {
  const err = await rateLimitedFromResponse(resp);
  if (err) throw err;
}

/** The text to show for a failure: the sentence alone when rate-limited. */
export function failureText(e, prefix) {
  if (e?.rateLimited) return e.message;
  const detail = String(e?.message ?? e);
  return prefix ? `${prefix}${detail}` : detail;
}
