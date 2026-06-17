/**
 * Per-box cert routing revocation domain — soft (Disconnect) + hard
 * (compromise), both IRK-signed by the account root.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and the shared field-validator are unchanged, so canonical bytes
 * and signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { assertCanonicalField } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Per-box cert routing revocation — soft (Disconnect) + hard (compromise).
// Per-user-cert design §5.1–5.2: revocation is enforced at the ROUTING
// layer (per-box STK / RCK), not the cert. Both envelopes are IRK-signed by
// the account root — only the trust-root may decommission or hard-revoke a
// box and retire its per-box `[<server>.<user>, *.<server>.<user>]` cert
// (model C's shared `[<user>, *.<user>]` cert is gone — A′ migration).
//
//   soft  = Disconnect: eject the box from the cert-recipient set + drop its
//           routing (STK/RCK), NO re-mint. Only genuinely soft if the box's
//           cert KEY is WIPED — an un-wiped box keeps a usable key, so a soft
//           request with wiped=false must be refused (caller routes to hard).
//   hard  = compromise: the ordered sequence in hardRevokeSteps() (routing →
//           delegation → eject → re-mint → CA-revoke). The shared SAN set
//           means every hard re-mint hits LE's duplicate-cert window, so the
//           control plane debounces rapid repeats (control-plane handler).
//
// A shared field-validator rejects the separator + control chars in each
// string field, mirroring the per-field guards used throughout this module.
// ──────────────────────────────────────────────────────────────────────

export interface CertSoftRevoke {
  username: string;
  serverDomain: string;
  /**
   * The box's cert KEY has been destroyed (LUKS-wiped / clean decommission).
   * Soft revoke is only sound when true — a box leaving the user's control
   * with the key intact is an off-path MITM risk and MUST be hard-revoked.
   */
  wiped: boolean;
  /** ms since epoch; freshness is the control plane's concern. */
  issuedAt: number;
}

const TAG_CERT_SOFT_REVOKE = "flagship/cert-soft-revoke/v1";

function canonicalCertSoftRevoke(r: CertSoftRevoke): Bytes {
  assertCanonicalField(r.username, "CertSoftRevoke", "username");
  assertCanonicalField(r.serverDomain, "CertSoftRevoke", "serverDomain");
  return new TextEncoder().encode(
    [TAG_CERT_SOFT_REVOKE, r.username, r.serverDomain, r.wiped ? "1" : "0", r.issuedAt].join("|"),
  );
}

export function signCertSoftRevoke(r: CertSoftRevoke, kp: Keypair): Bytes {
  return ed.sign(canonicalCertSoftRevoke(r), kp.privateKey);
}

export function verifyCertSoftRevoke(r: CertSoftRevoke, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalCertSoftRevoke(r), pub);
  } catch {
    return false;
  }
}

export interface CertHardRevoke {
  username: string;
  serverDomain: string;
  /** ms since epoch; the control plane debounces rapid repeats off this. */
  issuedAt: number;
}

const TAG_CERT_HARD_REVOKE = "flagship/cert-hard-revoke/v1";

function canonicalCertHardRevoke(r: CertHardRevoke): Bytes {
  assertCanonicalField(r.username, "CertHardRevoke", "username");
  assertCanonicalField(r.serverDomain, "CertHardRevoke", "serverDomain");
  return new TextEncoder().encode(
    [TAG_CERT_HARD_REVOKE, r.username, r.serverDomain, r.issuedAt].join("|"),
  );
}

export function signCertHardRevoke(r: CertHardRevoke, kp: Keypair): Bytes {
  return ed.sign(canonicalCertHardRevoke(r), kp.privateKey);
}

export function verifyCertHardRevoke(r: CertHardRevoke, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalCertHardRevoke(r), pub);
  } catch {
    return false;
  }
}
