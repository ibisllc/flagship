// The override orchestrator — the glue between the red sliver tap, the
// biometric/PIN gate (the webapp's tier-1 lock is a PIN, lib/pinLock.js), the
// signed TrustException (lib/trustException.js), local persistence, the
// trust-store override mark (lib/serverTrust.js), and the .com sync.
//
// Flow (docs/maintainer-trust-enforcement.md "Recovery = owner-signed,
// per-cert exception"):
//   1. owner taps a red sliver line for certHash;
//   2. PIN gate (unlockWithPin) — proves the owner is present, like the
//      biometric on native;
//   3. build + sign a TrustException (cert-hash-scoped, device-key-signed);
//   4. persist it locally + applyLocalException → markOverridden (calls
//      resume; the sliver line STAYS, now flagged "accepted");
//   5. best-effort POST to .com so the acceptance propagates fleet-wide.
//
// Boot calls loadAndApplyExceptions() to (a) re-apply locally-persisted
// exceptions and (b) pull+apply the directory's verified set, so one
// acceptance per cert works across all of a user's devices.

import { kvGet, kvPut, activeProfileId } from "../keystore.js";
import { serverTrust } from "./serverTrust.js";
import {
  buildSignedTrustException,
  postTrustException,
  fetchTrustExceptions,
} from "./trustException.js";

function storeKey(profileId) {
  return `trustExceptions.${profileId}`;
}

/* ---------- local persistence (per profile) ---------- */

/** Read the locally-persisted exceptions for the active (or given) profile. */
export async function loadLocalExceptions(deps = {}) {
  const kv = deps.kv ?? { get: kvGet, put: kvPut };
  const profileId = deps.profileId ?? activeProfileId();
  const arr = await kv.get(storeKey(profileId));
  return Array.isArray(arr) ? arr : [];
}

/** Persist an exception locally (dedup by certHash; first wins). */
export async function persistLocalException(ex, deps = {}) {
  const kv = deps.kv ?? { get: kvGet, put: kvPut };
  const profileId = deps.profileId ?? activeProfileId();
  const arr = await loadLocalExceptions({ kv, profileId });
  if (arr.some((e) => e.certHash === ex.certHash)) return arr;
  const next = arr.concat(ex);
  await kv.put(storeKey(profileId), next);
  return next;
}

/** Mark a verified exception as overridden in the live trust store. */
export function applyException(ex) {
  if (ex && ex.certHash) serverTrust.markOverridden(ex.certHash, ex);
}

/**
 * The override action. Gate is the PIN unlock (passed in by the caller, which
 * holds the entered PIN); on success build/sign/persist/apply/POST.
 *
 * @param {object} args
 *   args.umk        unlocked UMK seed (for signing)
 *   args.certClass  "control" | "relay"
 *   args.certHash   the failing cert-hash
 *   args.username   for the .com sync (optional — skips POST when absent)
 * @param {object} [deps]
 *   deps.now, deps.kv, deps.profileId, deps.fetch, deps.base,
 *   deps.signWithIrk, deps.deriveIrk   (forwarded to the building/sync layers)
 * @returns {Promise<{ex:object, posted:{ok:boolean,status:number}}>}
 */
export async function grantTrustException(args, deps = {}) {
  const ex = await buildSignedTrustException(
    {
      umk: args.umk,
      certClass: args.certClass,
      certHash: args.certHash,
      grantedAt: deps.now ? deps.now() : undefined,
    },
    deps,
  );
  await persistLocalException(ex, deps);
  applyException(ex);
  let posted = { ok: false, status: 0 };
  if (args.username) {
    posted = await postTrustException(args.username, ex, deps);
  }
  return { ex, posted };
}

/**
 * Boot-time: re-apply locally-persisted exceptions, then pull the directory's
 * verified set and apply those too (one acceptance per cert, fleet-wide).
 * Best-effort — a network failure just leaves the local set applied.
 */
export async function loadAndApplyExceptions(username, deps = {}) {
  const local = await loadLocalExceptions(deps);
  for (const ex of local) applyException(ex);
  if (username) {
    const remote = await fetchTrustExceptions(username, deps);
    for (const ex of remote) {
      await persistLocalException(ex, deps);
      applyException(ex);
    }
  }
}
