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
  return null;
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
  const status = statusOf(e);

  if (status == null && isNetwork(e)) return COPY.network;

  if (status != null) {
    if (status === 0) {
      // status 0 = no network round-trip happened (our own pre-flight
      // guard threw, or a CORS/offline fetch). Treat as a connection issue.
      return COPY.network;
    }
    if (status >= 500) return COPY.server;
    if (status === 401 || status === 403) {
      return opts.signExpired ? COPY.auth : COPY.generic;
    }
    if (status >= 400) return COPY.request;
  }

  if (isNetwork(e)) return COPY.network;
  return COPY.generic;
}

export const HUMAN_ERROR_COPY = COPY;
