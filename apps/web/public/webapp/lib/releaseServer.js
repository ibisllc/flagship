// Cancel-the-server / free-the-name helper.
//
// When an install fails (or a delivered recipe is abandoned), the chosen
// server name stays reserved: the RCK routing record pins it, so retrying
// the SAME name fails with "subdomain already controlled by a different
// RCK". Revoking just the auth-code is not enough — it kills the install
// TICKET but leaves the name pinned.
//
// `releaseServerName` IRK-signs a `flagship/release-server-name/v1`
// envelope and POSTs it to the Worker's `/api/server/release`, which
// releases every artifact that pins the name (routing record + active
// auth-codes + the server record). Authorization is the IRK signature
// itself — only the account owner can produce it, so an active server
// can't be released out from under its owner.
//
// Mirror of packages/protocol/src/auth.ts `ReleaseServerName` /
// `signReleaseServerName`. The iOS/Android composers mirror the same
// canonical-bytes shape natively.

import { CompanionWriteError, requireOwnerProfile } from "./companionGuard.js";
import { submitWriteRequest } from "./companionWriteRelay.js";
import { controlApex, dataApex } from "./apex.js";

/** Canonical-bytes tag — MUST match @flagship/protocol
 *  TAG_RELEASE_SERVER_NAME. */
export const TAG_RELEASE_SERVER_NAME = "flagship/release-server-name/v1";

const ORIGIN = controlApex();

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function defaultBytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Build the `<server>.<user>.flagship.services` domain from its parts. */
export function serverDomainOf(serverName, username) {
  return `${serverName}.${username}.${dataApex()}`;
}

/**
 * IRK-sign + POST the release. Resolves `{ ok, body }` on a 2xx; throws
 * on any other status (so the caller can surface a precise error).
 *
 * @param {object} args
 * @param {string} args.username            the account handle
 * @param {string} args.serverDomain        `<server>.<user>.flagship.services`
 * @param {Uint8Array} args.umk             session UMK (for IRK signing)
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk
 * @param {{ fetch?: typeof fetch, bytesToHex?: (b: Uint8Array) => string, origin?: string, now?: () => number }} [deps]
 */
export async function releaseServerName(args, deps = {}) {
  const { username, serverDomain, umk, signWithIrk } = args;
  if (!username || !serverDomain) throw new Error("username and serverDomain required");
  const issuedAt = (deps.now || Date.now)();
  // P14 Phase 2 — companion profiles can't sign locally (no UMK on this
  // device). For relay-supported kinds (release-server is one of two),
  // we forward the intent to the owner via /api/companion/request-write
  // instead of throwing. The owner-profile app surfaces the request in
  // its "Companion requests" view and signs+posts on approval.
  try {
    (deps.requireOwnerProfile ?? requireOwnerProfile)();
  } catch (e) {
    if (e instanceof CompanionWriteError) {
      const submit = deps.submitWriteRequest || submitWriteRequest;
      const queued = await submit(
        {
          kind: "release-server",
          intent: { username, serverDomain, issuedAt },
        },
        deps,
      );
      return {
        ok: false,
        pending: true,
        kind: "release-server",
        requestId: queued.requestId,
        queuedAt: queued.queuedAt,
        expiresAt: queued.expiresAt,
      };
    }
    throw e;
  }
  if (!umk || typeof signWithIrk !== "function") {
    throw new Error("unlock the webapp first");
  }
  const f = deps.fetch || fetch;
  const toHex = deps.bytesToHex || defaultBytesToHex;
  const origin = deps.origin || ORIGIN;
  const sig = await signWithIrk(
    umk,
    canonical([TAG_RELEASE_SERVER_NAME, username, serverDomain, issuedAt]),
  );
  const resp = await f(`${origin}/api/server/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username, serverDomain, issuedAt },
      signature: toHex(sig),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`release failed (${resp.status}): ${text}`);
  }
  return { ok: true, body: await resp.json().catch(() => ({})) };
}
