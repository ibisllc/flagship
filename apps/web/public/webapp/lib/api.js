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
// Fix B — per-pod session token + base URL:
//   `screensFetchFrom(podFqdn, path)` targets a specific pod directly using
//   its per-pod token. The legacy `screensFetch()` (active-pod slot) is
//   preserved for call-sites not yet updated.

import {
  get as profileGet,
  set as profileSet,
  getSessionTokenFor,
  setSessionTokenFor,
  getPodBaseUrlFor,
} from "./profilesStore.js";

// ── Legacy per-profile single-slot API (kept for backward compatibility) ──

export function setPodBaseUrl(url) {
  profileSet("podBaseUrl", url || null);
}

export function getPodBaseUrl() {
  return profileGet("podBaseUrl") || "";
}

export function setSessionToken(tok) {
  profileSet("sessionToken", tok || null);
}

export function getSessionToken() {
  return profileGet("sessionToken") || "";
}

// ── Fix B — per-pod token + URL helpers ──

/**
 * Return the session token for a specific pod (keyed by lower-cased FQDN),
 * or null when not paired.
 * @param {string} podFqdn  lower-cased FQDN (e.g. "home.alice.flagship.services")
 */
export function getSessionTokenForPod(podFqdn) {
  return getSessionTokenFor(podFqdn) || null;
}

/**
 * Persist the session token for a specific pod.
 * @param {string} podFqdn  lower-cased FQDN
 * @param {string|null} tok
 */
export function setSessionTokenForPod(podFqdn, tok) {
  setSessionTokenFor(podFqdn, tok || null);
}

/**
 * The base URL for a specific pod — always deterministic: `https://<podFqdn>`.
 * Never stored: derived from the FQDN on the fly.
 * @param {string} podFqdn  lower-cased FQDN
 * @returns {string}
 */
export function podBaseUrl(podFqdn) {
  return getPodBaseUrlFor(podFqdn);
}

export class ScreensError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ScreensError";
    this.status = status;
  }
}

// The build-a-service `/api/build/*` surface is mounted only when the box has
// its service platform wired; when it isn't, the ENTIRE prefix 404s. So a 404
// on a build ENTRY call (git "Check repo", MCP create, the build list) means
// "this box can't build services", not "that thing was removed". Returns the
// friendly platform-absent copy for that case; otherwise the usual message.
// Do NOT use on session-scoped 404s (a specific build id that's genuinely gone).
export function buildEntryError(e) {
  if (e instanceof ScreensError && e.status === 404) {
    return "This server isn't set up to build services yet. Building services needs the services feature enabled on this box.";
  }
  return e instanceof ScreensError ? e.message : String(e);
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
  return screensFetchFrom(getPodBaseUrl(), path, init);
}

/**
 * Like `screensFetch` but against an EXPLICIT pod base URL rather than the
 * active-pod slot — used to fan out across the user's pods (e.g. the
 * "All servers" view aggregating each pod's apps list). The session token is
 * the same paired session across the user's pods, so it authenticates on each.
 */
export async function screensFetchFrom(base, path, init = {}) {
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

/**
 * Fix B — fetch a `/api/screens/*` endpoint using a SPECIFIC POD's own token
 * and deterministic base URL (`https://<podFqdn>`). Each pod authenticates
 * with its own paired session token so that multiple pods never share a single
 * token slot.
 *
 * Throws descriptive ScreensErrors for the key error states so callers can
 * show honest copy:
 *   - liveness "unreachable"/"never" → caller should not even reach here
 *     (show offline/coming-up copy before calling screensFetch)
 *   - no stored token → "Pair this device with this server" prompt
 *   - base is empty (bad FQDN) → not paired error
 *
 * @param {string} podFqdn  lower-cased FQDN of the target pod
 * @param {string} path     URL path (e.g. "/api/screens/server-detail")
 * @param {RequestInit} [init]
 */
export async function screensFetchForPod(podFqdn, path, init = {}) {
  const base = podBaseUrl(podFqdn);
  if (!base) {
    throw new ScreensError("not paired to a server yet", 0);
  }
  const tok = getSessionTokenForPod(podFqdn);
  if (!tok) {
    throw new ScreensError("no session token for this pod; pair this device with this server", 0);
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
