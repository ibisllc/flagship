// The remote browser's session store. After the phone approves a remote
// (lib/companionDockStart.js), the page redeems the one-use ticket on the
// server the phone named and keeps the answer as a profile slot flagged
// `kind: "companion"`: session token, server, username, expiry, and no UMK
// seed or IRK key. Signing helpers refuse such a profile
// (companionGuard.js requireOwnerProfile).

import {
  ensureProfile,
  getProfileSlot,
  listCloudNames,
  removeProfileRecord,
  set as profileSet,
  setActiveCloudName,
} from "./profilesStore.js";
import { setPodBaseUrl, setSessionToken } from "./api.js";
import { dataApex } from "./apex.js";
import { humanError } from "./humanError.js";

import { tr } from "./i18n.js";

/** `https://<host>` for a server on the data apex, or null for anything else
 *  (another apex, a look-alike, http, a port, a path or a query). */
export function serverOriginOnApex(value, apex = dataApex()) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { return null; }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(`.${apex}`)) return null;
  return `https://${host}`;
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
  podBaseUrl: namedServer,
  username,
}, { apex } = {}) {
  if (typeof companionSessionToken !== "string" || typeof expiresAt !== "number") {
    return { error: tr("missing companionSessionToken/expiresAt in response") };
  }
  if (typeof namedServer !== "string" || !namedServer || typeof username !== "string" || !username) {
    return { error: tr("missing companion server or username") };
  }
  const podBaseUrl = serverOriginOnApex(namedServer, apex);
  if (!podBaseUrl) return { error: tr("The server named another server this page won't connect to") };
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

/** Drop every remote profile whose session has run out (or whose expiry is
 *  unreadable). The server stops honouring the token at the same moment, so
 *  the slot only holds a dead token and a server name. */
export function retireExpiredCompanionProfiles(now = Date.now(), storage) {
  const retired = [];
  for (const cloudName of listCloudNames(storage)) {
    const slot = getProfileSlot(cloudName, storage);
    if (slot?.kind !== "companion") continue;
    const expiresAt = Number(slot.companionExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) continue;
    removeProfileRecord(cloudName, storage);
    retired.push(cloudName);
  }
  return retired;
}

/**
 * The shape of the dependency block the receiver flow needs. Tests
 * inject `fetchImpl`; production uses the global fetch.
 */
export function defaultReceiverDeps() {
  return {
    fetchImpl: globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  };
}

/**
 * Redeem a remote ticket the phone sealed to this browser. Returns the
 * persisted profile slot (incl. session token + expiresAt) on success, or an
 * `{error}` shape on any failure so the caller can render a toast without
 * throwing.
 */
export async function redeemCompanionAndPersist(payload, deps = defaultReceiverDeps()) {
  if (!payload) return { error: "no payload" };
  const fetchImpl = deps.fetchImpl;
  if (!fetchImpl) return { error: "no fetch" };
  const server = serverOriginOnApex(payload.podBaseUrl, deps.apex);
  if (!server) return { error: tr("The phone named a server this page won't connect to") };
  let r;
  try {
    r = await fetchImpl(`${server}/api/companion/redeem`, {
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
  return persistCompanionSession({
    companionSessionToken,
    expiresAt,
    podBaseUrl: podBaseUrl ?? server,
    username: username ?? payload.username,
  }, { apex: deps.apex });
}
