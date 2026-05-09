// Thin fetch wrapper for /api/screens/* and other paired-session-gated
// daemon endpoints.
//
// The webapp talks to two different hosts:
//   1. `flagshipserver.com` — when the webapp is loaded as the user's
//      browser-resident PWA before pairing (e.g. promo issuance).
//      Calls go to the worker on the same origin.
//   2. The user's own pod (`<server>.<user>.flagship.services`) —
//      after pairing, the webapp talks to its own daemon for /api/screens/*.
//
// `screensFetch` infers the target from `localStorage.flagship.podBaseUrl`
// (set by the pairing flow). Falls back to same-origin for dev/desk
// pairings where the webapp itself runs on the pod.

const POD_BASE_KEY = "flagship.podBaseUrl";
const SESSION_TOKEN_KEY = "flagship.sessionToken";

export function setPodBaseUrl(url) {
  if (url) localStorage.setItem(POD_BASE_KEY, url);
  else localStorage.removeItem(POD_BASE_KEY);
}

export function getPodBaseUrl() {
  return localStorage.getItem(POD_BASE_KEY) || "";
}

export function setSessionToken(tok) {
  if (tok) localStorage.setItem(SESSION_TOKEN_KEY, tok);
  else localStorage.removeItem(SESSION_TOKEN_KEY);
}

export function getSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY) || "";
}

export class ScreensError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ScreensError";
    this.status = status;
  }
}

/**
 * Fetch a `/api/screens/*` endpoint on the user's pod. Returns the
 * parsed JSON body on 2xx; throws ScreensError with status + parsed
 * `error` field on non-2xx.
 *
 * Pass init like a normal fetch. The session token is sent via the
 * `x-flagship-session` header.
 */
export async function screensFetch(path, init = {}) {
  const base = getPodBaseUrl();
  if (!base) {
    throw new ScreensError("not paired to a server yet", 0);
  }
  const tok = getSessionToken();
  if (!tok) {
    throw new ScreensError("no session token; re-pair", 0);
  }
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const headers = {
    "x-flagship-session": tok,
    ...(init.headers || {}),
  };
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body = null;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const msg = body && typeof body === "object" && "error" in body ? body.error : `HTTP ${r.status}`;
    throw new ScreensError(msg, r.status);
  }
  return body;
}
