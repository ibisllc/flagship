// Shared human-facing error copy. UX-B — never put a raw `HTTP 503` or a
// thrown stack message in front of a user; map status / exception → plain
// language here, and keep the technical detail in console.error for
// debugging (the caller does the console.error; this only returns copy).
//
// Usage at a user-facing call site:
//
//   } catch (e) {
//     console.error("custom-domain bind failed", e);   // dev detail
//     toast(humanError(e), "err");                      // human copy
//   }
//
// The argument can be:
//   - a thrown Error (possibly carrying `.status` — api.js / totp.js do)
//   - a ScreensError / CompanionRelayError (carry `.status` / `.code`)
//   - a bare number (an HTTP status)
//   - a Response-like `{ status }`
//   - a RateLimitedError (lib/rateLimited.js): its own sentence, which says
//     who is limited and when to try again
//
// `signExpired: true` flips 401/403 to the "your session expired" copy
// where that is the real cause; otherwise 401/403 fall through to the
// generic "that didn't work" so we don't mislabel an authorization denial
// as an expiry.

const COPY = {
  server: "Our service is briefly unavailable — wait a moment and try again.",
  network: "Network error — check your internet connection.",
  auth: "Your session expired — sign in again.",
  request: "That request didn't work — check your connection and try again.",
  dropped: "The connection dropped — try again.",
  timeout: "That took too long — check your connection and try again.",
  generic: "That didn't work. Please try again.",
};

/** Pull an HTTP-ish status off whatever was thrown / passed. */
function statusOf(e) {
  if (typeof e === "number" && Number.isFinite(e)) return e;
  if (e && typeof e === "object") {
    if (typeof e.status === "number") return e.status;
    // CompanionRelayError carries `.code` as a stringified status ("500")
    // or a symbolic code ("network", "no-pod", …).
    if (typeof e.code === "string" && /^\d{3}$/.test(e.code)) {
      return parseInt(e.code, 10);
    }
  }
  return statusInText(e);
}

/** A status a thrown message spells out ("HTTP 503: error code: 1102",
 *  "release failed (409): …"), for errors that carry no `.status`. A
 *  Cloudflare "error code: 1xxx" page is the edge failing: a server problem. */
function statusInText(e) {
  if (!e || typeof e !== "object" || typeof e.message !== "string") return null;
  const m = e.message;
  const http = /^\s*HTTP\s*(\d{3})\b/i.exec(m) ?? /\bfailed \((\d{3})\)/i.exec(m);
  if (http) return parseInt(http[1], 10);
  if (/\berror code:?\s*1\d{3}\b/i.test(m)) return 502;
  return null;
}

/** True when a transport error says the connection broke mid-request. */
function isDropped(e) {
  const m = String(e?.message ?? e).toLowerCase();
  return (
    m.includes("connection closed") ||
    m.includes("connection reset") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("unexpected end of") ||
    m.includes("broken pipe") ||
    m === "eof"
  );
}

/** True when a transport error says the request ran out of time. */
function isTimeout(e) {
  if (e && typeof e === "object" && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
  const m = String(e?.message ?? e).toLowerCase();
  return m.includes("timed out") || m.includes("timeout");
}

/** True when the thrown thing looks like a transport / offline failure. */
function isNetwork(e) {
  if (!e) return false;
  if (typeof e === "object") {
    if (e.code === "network") return true;
    if (e.name === "TypeError") return true; // fetch() rejects with TypeError offline
  }
  const m = String(e?.message ?? e).toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network error") ||
    m.includes("load failed")
  );
}

/**
 * Map an error / status into plain-language copy safe to show a user.
 *
 * @param {unknown} e   thrown Error, ScreensError, CompanionRelayError,
 *                      a bare HTTP status number, or `{ status }`.
 * @param {{ signExpired?: boolean }} [opts]
 *   signExpired — when true, 401/403 means a stale session (show the
 *   sign-in-again copy). Default false: 401/403 fall to the generic copy.
 * @returns {string} human-facing message — never a raw status or stack.
 */
export function humanError(e, opts = {}) {
  if (e && typeof e === "object" && e.rateLimited === true && typeof e.message === "string") {
    return e.message;
  }
  // An error written for the person (e.g. lib/addServerGate.js's refusal).
  if (e && typeof e === "object" && typeof e.userMessage === "string" && e.userMessage) {
    return e.userMessage;
  }
  const status = statusOf(e);

  if (status == null && isNetwork(e)) return COPY.network;
  if (status == null && isDropped(e)) return COPY.dropped;
  if (status == null && isTimeout(e)) return COPY.timeout;

  if (status != null) {
    if (status === 0) {
      // status 0 = no network round-trip happened (our own pre-flight
      // guard threw, or a CORS/offline fetch). Treat as a connection issue.
      return COPY.network;
    }
    if (status >= 500) return COPY.server;
    if (status === 408) return COPY.timeout;
    if (status === 401 || status === 403) {
      return opts.signExpired ? COPY.auth : COPY.generic;
    }
    if (status >= 400) return COPY.request;
  }

  if (isNetwork(e)) return COPY.network;
  return COPY.generic;
}

export const HUMAN_ERROR_COPY = COPY;

/** An Error whose message is written for the person, so humanError shows it as is. */
export function userError(message, props = {}) {
  return Object.assign(new Error(message), props, { userMessage: message });
}

/** `.com` reasons written for developers, and what to say instead. */
const KNOWN_REASONS = [
  [/subdomain already controlled by a different rck/i,
    "That name is still held by an earlier, unfinished order. Cancel that order from Home, or choose another name."],
  [/^stale request/i, "This device's clock looks off. Check the date and time, then try again."],
  [/^invalid signature/i, "Your account key didn't match. Try again, or sign in again."],
  [/^not authorized/i, "This device isn't allowed to do that."],
];

/** The sentence for a `.com` reason we know, else null. */
export function knownReasonText(reason) {
  const r = String(reason ?? "").trim();
  for (const [re, sentence] of KNOWN_REASONS) if (re.test(r)) return sentence;
  return null;
}

/** A box's terse reason ("this server is waiting for a different backup") as a sentence. */
export function asSentence(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * The box's own explanation of a refused request (`{"error": "…"}` on a 4xx/5xx,
 * as ScreensError carries it), as a sentence; else humanError's copy. For flows
 * whose box refusals are written for the owner (backup, restore, access orders).
 */
export function boxErrorText(e, opts = {}) {
  if (e && typeof e === "object" && typeof e.userMessage === "string" && e.userMessage) return e.userMessage;
  if (e && typeof e === "object" && e.rateLimited === true) return humanError(e, opts);
  const status = statusOf(e);
  const reason = e && typeof e === "object" && e.body && typeof e.body === "object" ? e.body.error : null;
  if (status != null && status >= 400 && status <= 599 && typeof reason === "string" && reason.trim()) {
    return knownReasonText(reason) ?? asSentence(reason);
  }
  return humanError(e, opts);
}
