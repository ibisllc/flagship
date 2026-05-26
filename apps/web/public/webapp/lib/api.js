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
// `screensFetch` reads the target through the per-profile profilesStore
// `podBaseUrl` slot. Falls back to same-origin for dev/desk pairings.

import { get as profileGet, set as profileSet } from "./profilesStore.js";

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
