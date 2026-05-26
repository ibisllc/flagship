// P14 — Companion-browser dock: authenticated client helpers.
//
// Mirrors the lib/peerBackup* / lib/labelBook patterns: thin wrappers
// over `screensFetch` so the view doesn't have to know about the
// session-token plumbing. The PUBLIC `/api/companion/redeem` endpoint
// is hit directly by the receiver in app.js (no session token yet),
// so we don't expose a wrapper for it here.
//
// Endpoint shapes (P14 wave 1):
//   POST /api/screens/companion/mint-ticket { label?: string }
//     → { ticketId, ticketSecret, expiresAt }
//   GET  /api/screens/companion/list
//     → { companions: [{ tokenPrefix, label?, redeemedAt, lastSeenMs, expiresAt, userAgent? }] }
//   POST /api/screens/companion/revoke      { tokenPrefix }
//     → { ok: true }

import { screensFetch } from "./api.js";

/** Mint a fresh companion ticket. */
export async function companionMintTicket({ label } = {}) {
  return await screensFetch("/api/screens/companion/mint-ticket", {
    method: "POST",
    body: JSON.stringify({ label: label ?? null }),
  });
}

/** List active companion sessions. */
export async function companionList() {
  return await screensFetch("/api/screens/companion/list");
}

/** Revoke a companion by tokenPrefix (>= 8 chars). Idempotent. */
export async function companionRevoke(tokenPrefix) {
  if (!tokenPrefix || tokenPrefix.length < 8) {
    throw new Error("tokenPrefix (>= 8 chars) required");
  }
  return await screensFetch("/api/screens/companion/revoke", {
    method: "POST",
    body: JSON.stringify({ tokenPrefix }),
  });
}

/**
 * Build the receiver-URL the QR code encodes. The receiver browser
 * loads `https://web.flagshipserver.com/?companion=<base64url-JSON>`
 * and the boot path in app.js redeems the ticket. Encoding the proof
 * in the URL query is correct here — the only target ever to consume
 * it is the receiver browser the QR is being shown to, and the user
 * controls both screens. The TTL on the ticket (60s) bounds replay.
 *
 * Payload shape:
 *   { ticketId, ticketSecret, podBaseUrl, username }
 */
export function buildCompanionReceiverUrl({
  ticketId,
  ticketSecret,
  podBaseUrl,
  username,
  webappBaseUrl = "https://web.flagshipserver.com",
}) {
  if (!ticketId || !ticketSecret || !podBaseUrl || !username) {
    throw new Error("buildCompanionReceiverUrl: ticketId/ticketSecret/podBaseUrl/username required");
  }
  const payload = JSON.stringify({ ticketId, ticketSecret, podBaseUrl, username });
  const b64 = base64UrlEncode(new TextEncoder().encode(payload));
  return `${webappBaseUrl}/?companion=${b64}`;
}

/** Inverse of {@link buildCompanionReceiverUrl}'s `?companion=…` arg. */
export function parseCompanionPayload(b64u) {
  if (typeof b64u !== "string" || b64u.length === 0) return null;
  try {
    const bytes = base64UrlDecode(b64u);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    if (
      !parsed
      || typeof parsed.ticketId !== "string"
      || typeof parsed.ticketSecret !== "string"
      || typeof parsed.podBaseUrl !== "string"
      || typeof parsed.username !== "string"
    ) return null;
    return {
      ticketId: parsed.ticketId,
      ticketSecret: parsed.ticketSecret,
      podBaseUrl: parsed.podBaseUrl,
      username: parsed.username,
    };
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
