/**
 * `verifyComBlessing` — the single client-side primitive that decides
 * whether `.com` (the control server) is maintainer-blessed RIGHT NOW.
 *
 * The maintainer-trust enforcement design (docs/maintainer-trust-
 * enforcement.md) makes the blessing load-bearing: an app refuses to talk
 * to an unblessed `.com`. The verdict is computed entirely client-side
 * from the public material `GET /api/maintainer-blessing` returns; `.com`
 * cannot fake it, because the client re-derives the whole chain from its
 * OWN baked pin (`MAINTAINER_PINNED_MANDATE_HASH`) and its OWN clock:
 *
 *   verifyMandateChainFromPin(BAKED_PIN, mandates)   // links 1-2
 *     → authorizedCaKeys(caEndorsements, chain, nowMs) // link 3
 *       must contain the served caPubkey
 *
 * A forked/tampered mandate log will not hash to the baked pin; a lapsed
 * CaEndorsement lease yields `[]` authorized keys; a `.com` serving a CA
 * key the chain does not authorize is untrusted. The response's own `now`
 * is NEVER used — only the caller's clock (`nowMs`), so a rogue `.com`
 * cannot skew time to revive a lapsed lease.
 *
 * Failure semantics (the locked decision): this function only ever runs
 * on a *valid response*. A NETWORK error is NOT a verdict — the caller
 * must treat a fetch failure as "no verdict yet" and NEVER flip to
 * untrusted on it (only a structurally-valid-but-failing response is
 * untrusted). This module therefore takes the already-parsed response
 * object; transport is the caller's concern.
 *
 * This is the TS reference implementation. Swift/Kotlin mirrors hand-port
 * the identical algorithm and pin to the cross-platform vectors fixture
 * (`tests/fixtures/maintainerTrust.vectors.json`).
 */

import {
  authorizedCaKeys,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { MAINTAINER_PINNED_MANDATE_HASH } from "./maintainerCa.js";

/**
 * The body `GET /api/maintainer-blessing` returns (see control-plane
 * `handleMaintainerBlessing`). `mandates` / `caEndorsements` are the raw
 * maintainers envelopes; `caPubkey` is the CA key `.com` currently serves.
 */
export interface ComBlessingResponse {
  version: number;
  pinnedMandateHash: string;
  caPubkey: string;
  issuer: string;
  mandates: Mandate[];
  caEndorsements: CaEndorsement[];
  /** `.com`'s self-assessment — advisory only, never a trust input. */
  caPubkeyAuthorizedNow?: boolean | null;
  /** `.com`'s clock — IGNORED here; the caller's `nowMs` is authoritative. */
  now?: number;
}

export type ComBlessingReason =
  | "trusted"
  | "pin-mismatch"
  | "pin-unconfigured"
  | "malformed-response"
  | "no-authorized-ca-keys"
  | "ca-key-not-authorized";

export interface ComBlessingVerdict {
  /** true ⇒ `.com` is maintainer-blessed at `nowMs` and may be trusted. */
  trusted: boolean;
  /** The CA pubkey `.com` served (echoed for slugging/UI), or "". */
  caPubkey: string;
  reason: ComBlessingReason;
}

function isHex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]+$/i.test(s) && s.length > 0;
}

/**
 * Decide whether `.com` is maintainer-blessed at `nowMs`, verifying the
 * served blessing material against the BAKED pin (never the response's
 * `pinnedMandateHash`, which is only cross-checked) and the caller's clock.
 *
 * @param resp     the parsed `/api/maintainer-blessing` body.
 * @param nowMs    the CLIENT's clock (epoch ms). NEVER `resp.now`.
 * @param bakedPin the surface's compiled-in pin; defaults to the shared
 *                 `MAINTAINER_PINNED_MANDATE_HASH`.
 */
export function verifyComBlessing(
  resp: ComBlessingResponse,
  nowMs: number,
  bakedPin: string = MAINTAINER_PINNED_MANDATE_HASH,
): ComBlessingVerdict {
  if (typeof bakedPin !== "string" || bakedPin.length === 0) {
    return { trusted: false, caPubkey: "", reason: "pin-unconfigured" };
  }
  if (
    !resp ||
    typeof resp !== "object" ||
    !isHex(resp.caPubkey) ||
    !Array.isArray(resp.mandates) ||
    !Array.isArray(resp.caEndorsements)
  ) {
    return { trusted: false, caPubkey: "", reason: "malformed-response" };
  }
  // The response echoes a pin; if it disagrees with our baked pin the
  // server is on a different (possibly forked) anchor. We verify against
  // OUR pin regardless, but surface the mismatch as the reason since the
  // forward-walk will then fail anyway.
  const caPubkey = resp.caPubkey.toLowerCase();

  let authorized: string[];
  try {
    const chain = verifyMandateChainFromPin(bakedPin, resp.mandates);
    if (!chain.root || chain.validMandates.length === 0) {
      // The served mandate log does not anchor to our baked pin.
      const reason: ComBlessingReason =
        typeof resp.pinnedMandateHash === "string" &&
        resp.pinnedMandateHash !== bakedPin
          ? "pin-mismatch"
          : "no-authorized-ca-keys";
      return { trusted: false, caPubkey, reason };
    }
    authorized = authorizedCaKeys(
      resp.caEndorsements,
      chain,
      new Date(nowMs),
    ).map((k) => k.toLowerCase());
  } catch {
    return { trusted: false, caPubkey, reason: "malformed-response" };
  }

  if (authorized.length === 0) {
    return { trusted: false, caPubkey, reason: "no-authorized-ca-keys" };
  }
  if (!authorized.includes(caPubkey)) {
    return { trusted: false, caPubkey, reason: "ca-key-not-authorized" };
  }
  return { trusted: true, caPubkey, reason: "trusted" };
}
