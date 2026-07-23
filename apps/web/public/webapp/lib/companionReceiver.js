// P14 — Companion receiver flow.
//
// On webapp boot we look for `?companion=<base64url JSON>` in the URL.
// If present, this is a docking handoff — a regular browser is being
// turned into a 4-hour companion to the user's pod. We:
//
//   1. Parse the payload (ticketId, ticketSecret, podBaseUrl, username).
//   2. POST `${podBaseUrl}/api/companion/redeem` with the ticket creds.
//   3. On 200, persist a NEW profile slot in `flagship.profiles.v2`
//      flagged `kind: "companion"`. The slot records the
//      companionSessionToken, podBaseUrl, username, and expiresAt;
//      the UMK seed + IRK private key are NOT present — that's how
//      the rest of the webapp knows this is a read-only session.
//   4. Set the new profile active.
//   5. Strip `?companion=…` from the URL via history.replaceState.
//
// The signing helpers elsewhere (releaseServer, revokeServer, …) call
// `requireOwnerProfile()` from `companionGuard.js` BEFORE pulling the
// UMK from session — that throws a tagged error → router catches →
// shows a toast. v1 is read-only; wave 9 will add the write-relay.

import {
  ensureProfile,
  set as profileSet,
  setActiveCloudName,
} from "./profilesStore.js";
import { parseCompanionPayload } from "./companionClient.js";
import { setPodBaseUrl, setSessionToken } from "./api.js";
import { humanError } from "./humanError.js";

/** Where to find the dock payload on the current document. Test seam. */
export function companionPayloadFromLocation(loc = globalThis.location) {
  if (!loc || typeof loc.search !== "string") return null;
  const sp = new URLSearchParams(loc.search);
  const b64 = sp.get("companion");
  if (!b64) return null;
  return parseCompanionPayload(b64);
}

/**
 * Mint a deterministic cloudName for a companion profile. Two
 * docks of the SAME browser to the SAME pod with the SAME tokenPrefix
 * collide (overwrite); a fresh redeem mints a fresh prefix so this is
 * unique-per-companion-session by construction.
 */
export function companionCloudName(podBaseUrl, tokenPrefix) {
  const host = (() => {
    try { return new URL(podBaseUrl).host; } catch { return podBaseUrl; }
  })();
  return `companion-${host}-${tokenPrefix}`;
}

export function persistCompanionSession({
  companionSessionToken,
  expiresAt,
  podBaseUrl,
  username,
}) {
  if (typeof companionSessionToken !== "string" || typeof expiresAt !== "number") {
    return { error: "missing companionSessionToken/expiresAt in response" };
  }
  if (typeof podBaseUrl !== "string" || !podBaseUrl || typeof username !== "string" || !username) {
    return { error: "missing companion server or username" };
  }
  const tokenPrefix = companionSessionToken.slice(0, 12);
  const cloudName = companionCloudName(podBaseUrl, tokenPrefix);
  ensureProfile(cloudName);
  setActiveCloudName(cloudName);
  profileSet("username", username);
  profileSet("podBaseUrl", podBaseUrl);
  profileSet("sessionToken", companionSessionToken);
  profileSet("kind", "companion");
  profileSet("companionExpiresAt", String(expiresAt));
  setPodBaseUrl(podBaseUrl);
  setSessionToken(companionSessionToken);
  return {
    cloudName,
    sessionToken: companionSessionToken,
    expiresAt,
    podBaseUrl,
    username,
    kind: "companion",
  };
}

/**
 * The shape of the dependency block the receiver flow needs. Tests
 * inject `fetchImpl`; production uses the global fetch.
 */
export function defaultReceiverDeps() {
  return {
    fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    historyReplaceState: (url) => {
      try { globalThis.history?.replaceState?.({}, "", url); } catch { /* ignore */ }
    },
    locationHref: globalThis.location?.href ?? "",
  };
}

/**
 * Redeem a `?companion=…` payload. Returns the persisted profile slot
 * (incl. session token + expiresAt) on success, or an `{error}` shape
 * on any failure so the caller can render a toast without throwing.
 */
export async function redeemCompanionAndPersist(payload, deps = defaultReceiverDeps()) {
  if (!payload) return { error: "no payload" };
  const fetchImpl = deps.fetchImpl;
  if (!fetchImpl) return { error: "no fetch" };
  let r;
  try {
    r = await fetchImpl(`${payload.podBaseUrl.replace(/\/+$/, "")}/api/companion/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: payload.ticketId,
        ticketSecret: payload.ticketSecret,
      }),
    });
  } catch (e) {
    console.error("companion redeem network error", e);
    return { error: humanError(e) };
  }
  if (!r.ok) {
    // UX-B — prefer the daemon's own short, plain-language error string when
    // it supplies one (e.g. "ticket expired"); otherwise map the status to
    // plain language via humanError — NEVER fall back to a raw `HTTP <code>`.
    let serverMessage = null;
    try {
      const body = await r.json();
      if (typeof body?.error === "string" && body.error.trim()) {
        serverMessage = body.error.trim();
      }
    } catch { /* ignore */ }
    console.error("companion redeem failed", r.status, serverMessage);
    return { error: serverMessage ?? humanError(r.status), status: r.status };
  }
  let body;
  try {
    body = await r.json();
  } catch (e) {
    console.error("companion redeem: bad response body", e);
    return { error: humanError(e) };
  }
  const {
    companionSessionToken,
    expiresAt,
    podBaseUrl,
    username,
  } = body ?? {};
  const persisted = persistCompanionSession({
    companionSessionToken,
    expiresAt,
    podBaseUrl: podBaseUrl ?? payload.podBaseUrl,
    username: username ?? payload.username,
  });
  if (persisted.error) return persisted;

  // Strip the query string from the URL so a reload doesn't try to
  // re-redeem an already-consumed ticket (replay = 409).
  try {
    const u = new URL(deps.locationHref || "");
    u.searchParams.delete("companion");
    deps.historyReplaceState(u.pathname + (u.search ? `?${u.searchParams}` : "") + u.hash);
  } catch {
    /* ignore */
  }

  return persisted;
}
