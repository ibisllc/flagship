/**
 * Admin-authorized in-place server-update order — `flagship/server-update/v1`.
 *
 * Part of the 2-of-2 update gate (docs/server-update-mechanism.md). An in-place
 * daemon code update applies ONLY if the box confirms TWO independent facts:
 *
 *   1. AUTHORIZATION — an admin device signed THIS order, naming THIS box and the
 *      target commit. Verified box-side against the config-pinned admin master
 *      root / an admin-root-signed `admin` DeviceCapabilityGrant (the Slice-D
 *      admin tier), NOT the bare membership IRK. Because applying an update is
 *      the single most sensitive op, it rides the SAME admin-authority gate as
 *      wipe / transfer / decommission.
 *
 *   2. AUTHENTICITY — the target commit is maintainer-ENDORSED. That is proven by
 *      the EXISTING release-endorsement machinery (the daemon's ReleaseGate), so
 *      there is NO separate maintainer-signature envelope here — this order is
 *      the authorization half only. Neither half alone can push code.
 *
 * This module is the order envelope: canonical bytes + sign (by an admin device)
 * + never-throwing verify (under a candidate admin authority pubkey). It mirrors
 * the other public, signed order envelopes (debugAccess.ts / server-decommission)
 * — the order is PUBLIC (not a sealed secret), verified at `.com` deposit time
 * under the admin gate and re-verified box-side by the update consumer.
 *
 * `targetCommit` / `fromCommit` are git commit SHAs (or blessed tags):
 *   - `targetCommit` — the blessed version to move to.
 *   - `fromCommit`   — the box's expected current version (anti-replay of a stale
 *                      order: the box refuses to apply onto a different version).
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_SERVER_UPDATE = "flagship/server-update/v1";

export interface UpdateOrder {
  /** The box this order authorizes (its FQDN). */
  serverDomain: string;
  /** The blessed target commit (git SHA or tag) to move the box to. */
  targetCommit: string;
  /** The box's expected current commit — anti-replay of a stale order. */
  fromCommit: string;
  /** Single-use nonce (hex), consumed at-most-once by the box. */
  nonce: string;
  /** ms since epoch when the admin device minted this order. */
  issuedAt: number;
}

export function canonicalUpdateOrder(o: UpdateOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  legacyFieldGuard("targetCommit", o.targetCommit);
  legacyFieldGuard("fromCommit", o.fromCommit);
  legacyFieldGuard("nonce", o.nonce);
  return new TextEncoder().encode(
    [
      TAG_SERVER_UPDATE,
      o.serverDomain,
      o.targetCommit,
      o.fromCommit,
      o.nonce,
      String(o.issuedAt),
    ].join("|"),
  );
}

/** Sign an update order with an admin device / the admin master root keypair. */
export function signUpdateOrder(o: UpdateOrder, admin: Keypair): Bytes {
  return ed.sign(canonicalUpdateOrder(o), admin.privateKey);
}

/**
 * Verify the order under a CANDIDATE admin authority pubkey. Never throws
 * (hardened ed.verify + try/catch) — a forged / tampered / junk order is simply
 * rejected. The caller (`.com` deposit gate box-side re-verify) supplies the
 * admin authority to check against.
 */
export function verifyUpdateOrder(o: UpdateOrder, sig: Bytes, adminPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUpdateOrder(o), adminPub);
  } catch {
    return false;
  }
}
