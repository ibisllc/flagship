// P13 — per-server kill-switch helper.
//
// User-initiated server revocation. Unlike `releaseServer.js` (which
// frees the NAME so it can be re-claimed), this locks the server itself
// out: it can't connect or unlock until the owner un-revokes it, and its
// name stays reserved. Used when a box is lost, stolen, or being
// decommissioned.
//
// IRK-signed envelope, same trust level as releasing a name — only the
// account owner can produce a signature that verifies against the
// registered IRK.
//
// Mirror of packages/protocol/src/auth.ts `ServerRevocation` /
// `signRevocation`, and of `ServerUnrevocation` (installBlob.ts) for the
// undo. The iOS/Android composers mirror the same canonical-bytes shapes
// natively.

import { CompanionWriteError, requireOwnerProfile } from "./companionGuard.js";
import { submitWriteRequest } from "./companionWriteRelay.js";
import { controlApex } from "./apex.js";

/** Canonical-bytes tag — MUST match @flagship/protocol TAG_REVOKE. */
export const TAG_REVOKE = "flagship/revoke/v1";

/** Canonical-bytes tag — MUST match @flagship/protocol TAG_SERVER_UNREVOKE. */
export const TAG_SERVER_UNREVOKE = "flagship/server-unrevoke/v1";

/** The fixed reason vocabulary. Must match @flagship/protocol RevocationReason.
 *  These are also the only reasons `.com` will un-revoke: any other reason on a
 *  revoked record means the server was deleted, transferred or retired. */
export const REVOCATION_REASONS = ["lost", "stolen", "decommissioned"];

const ORIGIN = controlApex();

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Build the canonical bytes the IRK signs. MUST match
 * packages/protocol/src/auth.ts `canonicalRevoke` byte-for-byte:
 *   "flagship/revoke/v1|<userId>|<revokedServerId>|<reason>|<issuedAt>"
 */
export function canonicalRevokeBytes({ userId, revokedServerId, reason, issuedAt }) {
  return canonical([TAG_REVOKE, userId, revokedServerId, reason, issuedAt]);
}

/**
 * IRK-sign + POST the per-server revocation. Resolves `{ ok, body }`
 * on a 2xx; throws on any other status with `.code` set to the HTTP
 * status (or "network" for transport-level failures) so callers can
 * branch in the UI.
 *
 * @param {object} args
 * @param {string} args.userId            account handle the IRK is registered under
 * @param {string} args.revokedServerId   the server's full `<server>.<user>.flagship.services`
 * @param {"lost"|"stolen"|"decommissioned"} args.reason
 * @param {Uint8Array} args.umk           session UMK (for IRK signing)
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string, origin?: string, now?: () => number }} [deps]
 */
export async function revokeServer(args, deps = {}) {
  const { userId, revokedServerId, reason, umk, signWithIrk } = args;
  if (!userId || !revokedServerId) {
    throw makeError("userId and revokedServerId required", "400");
  }
  if (!REVOCATION_REASONS.includes(reason)) {
    throw makeError(`reason must be one of ${REVOCATION_REASONS.join(", ")}`, "400");
  }
  const issuedAt = (deps.now || Date.now)();
  // P14 Phase 2 — companion profiles route the intent through the
  // owner via /api/companion/request-write. Owner-app side surfaces
  // it under Settings → Companion requests; on approve the owner signs
  // + posts the actual revocation envelope.
  try {
    (deps.requireOwnerProfile ?? requireOwnerProfile)();
  } catch (e) {
    if (e instanceof CompanionWriteError) {
      const submit = deps.submitWriteRequest || submitWriteRequest;
      const queued = await submit(
        {
          kind: "revoke-server",
          intent: { userId, revokedServerId, reason, issuedAt },
        },
        deps,
      );
      return {
        ok: false,
        pending: true,
        kind: "revoke-server",
        requestId: queued.requestId,
        queuedAt: queued.queuedAt,
        expiresAt: queued.expiresAt,
      };
    }
    throw e;
  }
  if (!umk || typeof signWithIrk !== "function") {
    throw makeError("unlock the webapp first", "400");
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || ORIGIN;

  const sig = await signWithIrk(
    umk,
    canonicalRevokeBytes({ userId, revokedServerId, reason, issuedAt }),
  );

  let resp;
  try {
    resp = await f(`${origin}/api/server-registry/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { userId, revokedServerId, reason, issuedAt },
        signature: toHex(sig),
      }),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw makeError(`revoke failed (${resp.status}): ${text}`, String(resp.status));
  }
  return { ok: true, body: await resp.json().catch(() => ({})) };
}

/**
 * Build the canonical bytes the sensitive-order key signs. MUST match
 * packages/protocol/src/installBlob.ts `serverUnrevocationCanonicalBytes`:
 *   "flagship/server-unrevoke/v1|<username>|<serverDomain>|<issuedAt>"
 */
export function canonicalUnrevokeBytes({ username, serverDomain, issuedAt }) {
  return canonical([TAG_SERVER_UNREVOKE, username, serverDomain, issuedAt]);
}

/**
 * Sign + POST the un-revoke. Resolves `{ ok, body }` on a 2xx (body is
 * `{ ok, unrevokedAt, dnsRepublished }` or `{ ok, alreadyActive: true }`);
 * throws with `.code` set to the HTTP status (or "network") otherwise.
 * Not relayable for a companion profile: the owner app has to do it.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {string} args.serverDomain   `<server>.<user>.flagship.services`
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 *        the sensitive-order signer (admin root when pinned, else the IRK)
 * @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string, origin?: string, now?: () => number, requireOwnerProfile?: () => void }} [deps]
 */
export async function unrevokeServer(args, deps = {}) {
  const { username, serverDomain, umk, signWithIrk } = args;
  if (!username || !serverDomain) {
    throw makeError("username and serverDomain required", "400");
  }
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!umk || typeof signWithIrk !== "function") {
    throw makeError("unlock the webapp first", "400");
  }
  const issuedAt = (deps.now || Date.now)();
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || ORIGIN;

  const sig = await signWithIrk(umk, canonicalUnrevokeBytes({ username, serverDomain, issuedAt }));

  let resp;
  try {
    resp = await f(`${origin}/api/server-registry/unrevoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { username, serverDomain, issuedAt },
        signature: toHex(sig),
      }),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const msg = resp.status === 409
      ? "This server was deleted or handed over and can't be restored."
      : (body && body.error) || `un-revoke failed (${resp.status})`;
    throw makeError(msg, String(resp.status));
  }
  return { ok: true, body: await resp.json().catch(() => ({})) };
}

function makeError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 3-second confirmation countdown. The webapp substitutes this for the
 * mobile "hold to confirm" long-press: the user taps Revoke once, then
 * sees a 3-2-1 countdown with a prominent Cancel button. If Cancel is
 * hit (or the abort signal fires) before zero, the promise rejects
 * with `.code === "cancelled"`. Otherwise it resolves.
 *
 * `onTick(secondsRemaining)` is called once per second starting at 3
 * and ending at 0 — wire it to the dialog's countdown label.
 *
 * @param {object} args
 * @param {AbortSignal} [args.signal]
 * @param {(s: number) => void} [args.onTick]
 * @param {object} [deps]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
 * @param {(handle: any) => void} [deps.clearTimeout]
 */
export function countdownConfirm(args = {}, deps = {}) {
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const onTick = typeof args.onTick === "function" ? args.onTick : () => {};
  return new Promise((resolve, reject) => {
    let remaining = 3;
    let handle = null;
    const onAbort = () => {
      if (handle != null) clearT(handle);
      reject(makeError("cancelled", "cancelled"));
    };
    if (args.signal) {
      if (args.signal.aborted) { onAbort(); return; }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
    onTick(remaining);
    const tick = () => {
      remaining -= 1;
      onTick(remaining);
      if (remaining <= 0) { resolve(undefined); return; }
      handle = setT(tick, 1000);
    };
    handle = setT(tick, 1000);
  });
}
