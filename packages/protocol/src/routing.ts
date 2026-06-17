/**
 * Routing-Control-Key (RCK) domain — the phone-held primitive that
 * decouples "who may claim a subdomain's traffic" from "which server
 * handles it now". Covers RCK registration + retargeting and the #75
 * rotation envelopes (routine RotateRck + recovery-grace RecoverRck +
 * RevokeRecoverRck).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_RCK_REGISTER = "flagship/rck-register/v1";
const TAG_RCK_SET_TARGET = "flagship/rck-set-target/v1";
const TAG_ROTATE_RCK = "flagship/rotate-rck/v1";
const TAG_RECOVER_RCK = "flagship/recover-rck/v1";
const TAG_REVOKE_RECOVER_RCK = "flagship/revoke-recover-rck/v1";

/**
 * Routing-Control-Key registration. Phone signs with IRK to establish a
 * keypair that controls "where does this subdomain's traffic go right now?"
 * — separate from the server identity that's *currently* handling it. Lets
 * the phone re-route on failover / migration / delegation without having
 * to rotate any other key.
 */
export interface RegisterRck {
  username: string;
  subdomain: string;
  rckPubKey: Bytes;
  issuedAt: number;
}

/**
 * Routing target update — phone re-aims a subdomain at a different server
 * identity. Signed with the RCK private key. .com mutates the routing
 * record; .services's SNI passthrough router reads the new target on the
 * next lookup.
 */
export interface SetRoutingTarget {
  subdomain: string;
  newTargetIdentityPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

function canonicalRegisterRck(r: RegisterRck): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [TAG_RCK_REGISTER, r.username, r.subdomain, hex(r.rckPubKey), r.issuedAt].join("|"),
  );
}

function canonicalSetRoutingTarget(r: SetRoutingTarget): Bytes {
  legacyFieldGuard("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_RCK_SET_TARGET,
      r.subdomain,
      hex(r.newTargetIdentityPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRegisterRck(r: RegisterRck, irk: Keypair): Bytes {
  return ed.sign(canonicalRegisterRck(r), irk.privateKey);
}
export function verifyRegisterRck(r: RegisterRck, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRegisterRck(r), irkPub);
  } catch {
    return false;
  }
}

export function signSetRoutingTarget(r: SetRoutingTarget, rck: Keypair): Bytes {
  return ed.sign(canonicalSetRoutingTarget(r), rck.privateKey);
}
export function verifySetRoutingTarget(r: SetRoutingTarget, sig: Bytes, rckPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetRoutingTarget(r), rckPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// RCK rotation (#75) — two envelopes per Thread B:
//
// RotateRck: routine rotation. Signed by BOTH the old RCK AND the IRK
// (batched under one biometric prompt on the phone). Takes effect
// immediately. Used when the phone still holds the old RCK.
//
// RecoverRck: recovery-grace rotation. Signed by the new IRK only.
// .com holds it pending for 24h; the old IRK (if recoverable) can
// revoke during grace. Used after J.3 when the phone holding the old
// RCK is gone.
// ──────────────────────────────────────────────────────────────────────

export interface RotateRck {
  subdomain: string;
  newRckPubKey: Bytes;
  oldRckPubKey: Bytes;
  issuedAt: number;
  nonce: Bytes;
}

function canonicalRotateRck(r: RotateRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_ROTATE_RCK,
      r.subdomain,
      hex(r.newRckPubKey),
      hex(r.oldRckPubKey),
      r.issuedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

/** Sign with BOTH oldRck and IRK; both signatures returned. */
export function signRotateRck(
  r: RotateRck,
  oldRck: Keypair,
  irk: Keypair,
): { sigOldRck: Bytes; sigIrk: Bytes } {
  const b = canonicalRotateRck(r);
  return { sigOldRck: ed.sign(b, oldRck.privateKey), sigIrk: ed.sign(b, irk.privateKey) };
}

export function verifyRotateRck(
  r: RotateRck,
  sigOldRck: Bytes,
  sigIrk: Bytes,
  oldRckPub: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    const b = canonicalRotateRck(r);
    return ed.verify(sigOldRck, b, oldRckPub) && ed.verify(sigIrk, b, irkPub);
  } catch {
    return false;
  }
}

export interface RecoverRck {
  subdomain: string;
  newRckPubKey: Bytes;
  newIrkPubKey: Bytes;
  declaredAt: number;
  /** = declaredAt + 24h hard minimum; .com enforces. */
  effectiveAt: number;
  nonce: Bytes;
}

function canonicalRecoverRck(r: RecoverRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_RECOVER_RCK,
      r.subdomain,
      hex(r.newRckPubKey),
      hex(r.newIrkPubKey),
      r.declaredAt,
      r.effectiveAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRecoverRck(r: RecoverRck, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRecoverRck(r), newIrk.privateKey);
}

export function verifyRecoverRck(r: RecoverRck, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRecoverRck(r), newIrkPub);
  } catch {
    return false;
  }
}

export interface RevokeRecoverRck {
  subdomain: string;
  /** References the RecoverRck.declaredAt that should be cancelled. */
  pendingDeclaredAt: number;
  revokedAt: number;
  nonce: Bytes;
}

function canonicalRevokeRecoverRck(r: RevokeRecoverRck): Bytes {
  validateNoSepCtrl("subdomain", r.subdomain);
  return new TextEncoder().encode(
    [
      TAG_REVOKE_RECOVER_RCK,
      r.subdomain,
      r.pendingDeclaredAt,
      r.revokedAt,
      hex(r.nonce),
    ].join("|"),
  );
}

export function signRevokeRecoverRck(r: RevokeRecoverRck, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalRevokeRecoverRck(r), oldIrk.privateKey);
}

export function verifyRevokeRecoverRck(
  r: RevokeRecoverRck,
  sig: Bytes,
  oldIrkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevokeRecoverRck(r), oldIrkPub);
  } catch {
    return false;
  }
}
