// Auto-pair (Slice B).
//
// Pairing a control device with a box you already own is NOT a
// security-sensitive act (docs/device-admin-entitlements.md: "pairing-for-use
// is not sensitive, so it's admin-independent") — every control device already
// sees every server. So instead of making the user paste each pod's URL, we
// self-provision a per-box BFF session token for every LIVE pod we can see that
// lacks one: the browser already holds the IRK, so it signs the same
// `add-paired-session` order pod-pair.js signs and POSTs it to the pod.
//
// Design:
//   - Fed from the /pods list (via liveSync). We only pair pods that are LIVE
//     (reachable) and lack a stored per-pod session token.
//   - Idempotent + race-safe: an in-flight `Set` prevents a second /pods tick
//     from re-pairing a pod whose POST hasn't resolved, and the token check
//     skips pods already paired → never writes a duplicate token.
//   - Manual paste (pod-pair.js) stays as the fallback for a brand-new pod URL
//     not yet in /pods.
//
// The signed order + canonical bytes are byte-identical to pod-pair.js's
// `add-paired-session` (the pod's dispatcher re-derives + verifies the same
// shape under the pre-registered IRK).

import { bytesToHex as defaultBytesToHex, signWithIrk as defaultSignWithIrk } from "../keystore.js";
import { getSession } from "./state.js";
import {
  getSessionTokenForPod,
  setSessionTokenForPod,
  getPodBaseUrl,
  getSessionToken,
  setPodBaseUrl,
  setSessionToken,
} from "./api.js";

/** Canonical bytes for an `add-paired-session` PhoneOrder — byte-identical to
 *  pod-pair.js's. Format:
 *    flagship/order/add-paired-session/v2|<serverId>|<token>|<issuedAt>
 */
export function canonicalAddPairedSession({ serverId, token, issuedAt }) {
  return new TextEncoder().encode(
    ["flagship/order/add-paired-session/v2", serverId, token, issuedAt].join("|"),
  );
}

function randomTokenHex(byteLen, toHex) {
  const buf = new Uint8Array(byteLen);
  (globalThis.crypto || crypto).getRandomValues(buf);
  return toHex(buf);
}

/** Pure: pick the FQDNs to auto-pair from a /pods snapshot. A candidate is a
 *  pod that is LIVE (reachable — we only pair a box that can accept the order)
 *  and does NOT already have a stored per-pod token.
 *  @param {any[]} pods
 *  @param {(fqdn: string) => boolean} hasToken
 *  @returns {string[]}  lower-cased FQDNs
 */
export function pickAutoPairTargets(pods, hasToken) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(pods) ? pods : []) {
    const fqdn = String(p?.fqdn ?? "").trim().toLowerCase();
    if (!fqdn || seen.has(fqdn)) continue;
    seen.add(fqdn);
    // Only pair a reachable box. `liveness === "live"` is the honest signal;
    // when the field is absent (older .com) fall back to a recent report.
    const live =
      p?.liveness === "live" ||
      (p?.liveness == null && p?.lastReported != null && Date.now() - p.lastReported <= 15 * 60_000);
    if (!live) continue;
    if (hasToken(fqdn)) continue;
    out.push(fqdn);
  }
  return out;
}

// Module-level guard so overlapping /pods ticks never double-POST for the same
// pod while its first order is still in flight.
const inFlight = new Set();

/**
 * Auto-pair every eligible pod in a /pods snapshot. Fully injectable so it's
 * unit-testable without the DOM / network / keystore.
 *
 * @param {any[]} pods                          the /pods list
 * @param {object} [deps]
 * @param {string} [deps.username]
 * @param {Uint8Array} [deps.umk]
 * @param {Function} [deps.signWithIrk]         (umk, bytes) => Promise<Uint8Array>
 * @param {Function} [deps.bytesToHex]
 * @param {typeof fetch} [deps.fetch]
 * @param {(fqdn: string) => boolean} [deps.hasToken]
 * @param {(fqdn: string, token: string) => void} [deps.storeToken]
 * @param {(fqdn: string, token: string) => void} [deps.storeLegacyIfEmpty]
 * @param {() => number} [deps.now]
 * @param {Set<string>} [deps.inFlight]
 * @returns {Promise<{ paired: string[], failed: string[] }>}
 */
export async function autoPairPods(pods, deps = {}) {
  const session = deps.umk != null ? { umk: deps.umk, username: deps.username } : safeSession();
  if (!session?.umk) return { paired: [], failed: [] };

  const toHex = deps.bytesToHex || defaultBytesToHex;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const f = deps.fetch || fetch;
  const now = deps.now || Date.now;
  const flight = deps.inFlight || inFlight;
  const hasToken = deps.hasToken || ((fqdn) => !!getSessionTokenForPod(fqdn));
  const storeToken = deps.storeToken || ((fqdn, tok) => setSessionTokenForPod(fqdn, tok));
  const storeLegacyIfEmpty =
    deps.storeLegacyIfEmpty ||
    ((fqdn, tok) => {
      // Populate the legacy active-pod slot for the FIRST pod paired, so the
      // default single-pod read path (screensFetch / getPodBaseUrl) works with
      // no further action. Never clobber an existing active slot.
      try {
        if (!getPodBaseUrl() || !getSessionToken()) {
          setPodBaseUrl(`https://${fqdn}`);
          setSessionToken(tok);
        }
      } catch { /* storage unavailable — non-fatal */ }
    });

  const targets = pickAutoPairTargets(pods, hasToken).filter((fqdn) => !flight.has(fqdn));
  const paired = [];
  const failed = [];

  await Promise.all(
    targets.map(async (fqdn) => {
      flight.add(fqdn);
      try {
        const baseUrl = `https://${fqdn}`;
        const serverId = fqdn;
        const token = randomTokenHex(32, toHex);
        const issuedAt = now();
        const sig = await sign(
          session.umk,
          canonicalAddPairedSession({ serverId, token, issuedAt }),
        );
        const r = await f(`${baseUrl}/api/orders-from-user`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request: { type: "add-paired-session", serverId, token, issuedAt },
            signature: toHex(sig),
          }),
        });
        if (!r.ok) {
          failed.push(fqdn);
          return;
        }
        // Re-check the token under the guard before writing so two racing
        // callers can't both persist (belt-and-braces with `inFlight`).
        if (!hasToken(fqdn)) {
          storeToken(fqdn, token);
          storeLegacyIfEmpty(fqdn, token);
        }
        paired.push(fqdn);
      } catch {
        failed.push(fqdn);
      } finally {
        flight.delete(fqdn);
      }
    }),
  );

  return { paired, failed };
}

/** Convenience wrapper the app wires to the liveSync snapshot. Best-effort —
 *  a failure here can never wedge the app. */
export function autoPairFromSnapshot(snapshot) {
  return autoPairPods(snapshot?.pods || []).catch(() => ({ paired: [], failed: [] }));
}

function safeSession() {
  try {
    return getSession();
  } catch {
    return null;
  }
}
