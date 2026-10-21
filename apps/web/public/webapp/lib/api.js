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
import { controlApex } from "./apex.js";

import { tr } from "./i18n.js";
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

/**
 * Slice D (§5) — POST an admin master-root rotation proof to `.com`.
 *
 * The OLD admin root has signed `flagship/admin-root-rotation/v1` over
 * `{ username, oldAdminRootPub, newAdminRootPub, issuedAt }`. `.com` records the
 * new `admin_root_pub_hex` and relays the (unforgeable) proof to each box, which
 * verifies it against its PINNED old root before re-pinning. `.com` can never
 * forge such a proof — it holds no admin root — which is exactly what lets a box
 * adopt a relayed new root. This call targets the `.com` apex (identity plane),
 * NOT a pod, so it does not use the per-pod session token.
 *
 * @param {{
 *   username: string,
 *   rotation: { username: string, oldAdminRootPub: string, newAdminRootPub: string, issuedAt: number },
 *   signatureHex: string,
 *   fetch?: typeof fetch,
 *   baseUrl?: string,
 * }} args
 * @returns {Promise<object>}
 */
export async function postAdminRootRotation(args) {
  const f = args.fetch || fetch;
  const base = args.baseUrl || controlApex();
  const r = await f(
    `${base}/api/users/${encodeURIComponent(args.username)}/admin-root-rotation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rotation: args.rotation, signatureHex: args.signatureHex }),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`admin-root rotation failed (${r.status}): ${txt}`.trim());
  }
  return r.json().catch(() => ({}));
}

export class ScreensError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = "ScreensError";
    this.status = status;
    // The parsed error body, for callers that read more than `error` (e.g.
    // the name clash a vibe-code start refuses with).
    this.body = body;
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
    return tr("This server isn't set up to build services yet. Building services needs the services feature enabled on this box.");
  }
  return e instanceof ScreensError ? e.message : String(e);
}

// The box's own explanation (`{"error": "…"}`) of a refused request, for the
// build flows whose refusals are written for the owner (a repo that won't
// clone, an invalid name, a failed deploy). Null for anything else.
export function boxReason(e) {
  if (!(e?.status >= 400 && e.status <= 599)) return null;
  const reason = e.body && typeof e.body === "object" ? e.body.error : null;
  return typeof reason === "string" && reason ? reason : null;
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
  return screensFetchWith(base, getSessionToken(), path, init);
}

/** A `/api/screens/*` call against `base` with an explicit session `token`. */
export async function screensFetchWith(base, tok, path, init = {}) {
  if (!base) {
    throw new ScreensError("not paired to a server yet", 0);
  }
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
    throw new ScreensError(msg, r.status, body);
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
    throw new ScreensError(msg, r.status, body);
  }
  return body;
}

// ── One box, named by FQDN (docs/app-placement.md) ──

function hostOf(base) {
  try {
    return base ? new URL(base).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** The host of the current pod (the active-pod slot), or "". */
export function currentPodFqdn() {
  return hostOf(getPodBaseUrl());
}

/** This device's session token for `podFqdn`: its own per-pod token, else the
 *  legacy slot's when that slot names the same box. "" when it has none. */
export function sessionTokenForPod(podFqdn) {
  const fqdn = String(podFqdn ?? "").trim().toLowerCase();
  if (!fqdn) return "";
  const own = getSessionTokenForPod(fqdn);
  if (own) return own;
  return currentPodFqdn() === fqdn ? getSessionToken() : "";
}

/**
 * A screens client bound to one box: its own base URL and session token, so a
 * call never follows the current-pod slot. `fqdn` "" binds the current pod.
 * `fetch(path, init)` resolves to the parsed body like `screensFetch`.
 */
export function boxClient(podFqdn = "") {
  const fqdn = String(podFqdn ?? "").trim().toLowerCase() || currentPodFqdn();
  // The current pod keeps its own base URL: one paired by address may carry a port.
  const baseUrl = fqdn && fqdn !== currentPodFqdn() ? `https://${fqdn}` : getPodBaseUrl();
  const token = () => (fqdn ? sessionTokenForPod(fqdn) : getSessionToken());
  return {
    fqdn,
    baseUrl,
    token,
    hasSession: () => !!token(),
    fetch: (path, init = {}) => screensFetchWith(baseUrl, token(), path, init),
  };
}

/** Point the current-pod slot at `podFqdn` when this device has a session for
 *  it. Resolves to whether it moved (or already pointed there). */
export function makeCurrentPod(podFqdn) {
  const fqdn = String(podFqdn ?? "").trim().toLowerCase();
  if (!fqdn) return false;
  if (currentPodFqdn() === fqdn && getSessionToken()) return true;
  const tok = getSessionTokenForPod(fqdn);
  if (!tok) return false;
  setPodBaseUrl(`https://${fqdn}`);
  setSessionToken(tok);
  return true;
}
