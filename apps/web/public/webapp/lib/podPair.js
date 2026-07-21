// Webapp ↔ pod pairing.
//
// After the user has bootstrapped a UMK and unlocked it, this module
// pairs the webapp with a specific pod (the user's own server) so the
// /api/screens/* BFF endpoints become reachable.
//
// Flow:
//   1. User pastes the pod's base URL (e.g.
//      https://home.alice.flagship.services).
//   2. Webapp generates a 32-byte random session token.
//   3. Signs an `add-paired-session` PhoneOrder with the IRK.
//   4. POSTs the order to <pod>/api/orders-from-user.
//   5. On 2xx, persists (podBaseUrl, sessionToken) via lib/api.js.
//
// The pod's /api/orders-from-user verifies the signature against the
// pre-registered IRK pubkey before accepting.

import { bytesToHex, signWithIrk } from "../keystore.js";
import { setPodBaseUrl, setSessionToken } from "./api.js";
import { getSession } from "./state.js";

function randomTokenHex(byteLen = 32) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * Canonical bytes for an `add-paired-session` PhoneOrder. The pod
 * dispatcher (auth.ts canonicalPhoneOrder) parses this same shape —
 * keep them in sync. Format:
 *   flagship/order/add-paired-session/v2|<serverId>|<token>|<issuedAt>
 */
function canonicalAddPairedSession({ serverId, token, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/order/add-paired-session/v2",
      serverId,
      token,
      issuedAt,
    ].join("|"),
  );
}

/**
 * Pair this webapp with a pod by signing + posting an
 * `add-paired-session` PhoneOrder. The pod's `serverId` is its FQDN
 * (the daemon enforces serverId === its own FQDN).
 */
export async function pairWithPod(args) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  const baseUrl = String(args.baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    throw new Error("baseUrl must be https://");
  }
  // The serverId the pod expects in the order body equals its FQDN —
  // i.e. the host portion of the baseUrl.
  const serverId = new URL(baseUrl).host;
  const token = randomTokenHex();
  const issuedAt = Date.now();
  const canonical = canonicalAddPairedSession({ serverId, token, issuedAt });
  const sig = await signWithIrk(session.umk, canonical);
  const orderBody = {
    request: {
      type: "add-paired-session",
      serverId,
      token,
      issuedAt,
    },
    signature: bytesToHex(sig),
  };
  const r = await fetch(`${baseUrl}/api/orders-from-user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orderBody),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`pod refused pairing: ${r.status} ${text}`.trim());
  }
  setPodBaseUrl(baseUrl);
  setSessionToken(token);
  return { baseUrl, token };
}
