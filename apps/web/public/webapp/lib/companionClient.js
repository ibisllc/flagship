// P14 — Companion-browser dock: authenticated client helpers.
//
// Mirrors the lib/peerBackup* / lib/labelBook patterns: thin wrappers
// over `screensFetch` so the view doesn't have to know about the
// session-token plumbing. The PUBLIC `/api/companion/redeem` endpoint
// is hit directly by the remote page (lib/companionReceiver.js, no
// session token yet), so we don't expose a wrapper for it here.
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
