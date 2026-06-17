/**
 * v1.2 TOTP enrollment domain — the IRK-signed enroll-begin / enroll-confirm
 * / disable envelopes (the 2FA spectrum on multi-device accounts).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// v1.2 Phase 3 — TOTP enrollment + disable envelopes. Distinct tags so
// a leaked enroll-begin signature can't be replayed as enroll-confirm
// (or as a TOTP disable, which would nuke the user's 2FA). Verify
// codes are NOT signed — they're a side-channel proof attached to the
// signed envelope, same pattern as `RePairInitiate.totpProof`.
const TAG_TOTP_ENROLL_BEGIN = "flagship/totp-enroll-begin/v1";
const TAG_TOTP_ENROLL_CONFIRM = "flagship/totp-enroll-confirm/v1";
const TAG_TOTP_DISABLE = "flagship/totp-disable/v1";

/**
 * v1.2 Phase 3 — TOTP enroll-begin envelope (IRK-signed).
 *
 * The caller proves possession of the current IRK so a stolen
 * iCloud-keychain attacker can't stage a new TOTP secret (and
 * then immediately re-pair under their own 2FA). On success the
 * Worker generates a fresh 20-byte TOTP secret, encrypts it with
 * the KEK, and writes `usernames.totp_secret_encrypted`. The
 * account stays single-device until enroll-confirm.
 */
export interface TotpEnrollBegin {
  username: string;
  issuedAt: number;
}

/**
 * v1.2 Phase 3 — TOTP enroll-confirm envelope (IRK-signed).
 *
 * The `code` field is NOT in the canonical bytes (see RePairInitiate
 * jsdoc for the same rationale: codes are ephemeral and a long-lived
 * signature embedding the code would leak the code to anyone with
 * replay access). The Worker validates the IRK signature against the
 * canonical envelope (no code bytes) and validates the code against
 * the staged TOTP secret synchronously. On success the Worker:
 *   - sets `totp_enrolled_at = now`
 *   - flips `account_type = 'multi'`
 *   - generates 10 recovery codes + writes their argon2id hashes
 *   - returns the 10 plaintext codes ONCE (the only time they leave the Worker)
 */
export interface TotpEnrollConfirm {
  username: string;
  issuedAt: number;
}

/**
 * v1.2 Phase 3 — TOTP disable envelope (IRK-signed).
 *
 * Drops the TOTP secret + recovery codes, flips `account_type` back
 * to `'single'`. As with enroll-confirm, the verification `code` is
 * carried beside the signed envelope, not inside it. The handler
 * additionally refuses to disable when the account has other paired
 * sessions (multi-device state requires multi-device 2FA).
 */
export interface TotpDisable {
  username: string;
  issuedAt: number;
}

function canonicalTotpEnrollBegin(r: TotpEnrollBegin): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_TOTP_ENROLL_BEGIN, r.username, r.issuedAt].join("|"),
  );
}
function canonicalTotpEnrollConfirm(r: TotpEnrollConfirm): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_TOTP_ENROLL_CONFIRM, r.username, r.issuedAt].join("|"),
  );
}
function canonicalTotpDisable(r: TotpDisable): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_TOTP_DISABLE, r.username, r.issuedAt].join("|"),
  );
}

export function signTotpEnrollBegin(r: TotpEnrollBegin, irk: Keypair): Bytes {
  return ed.sign(canonicalTotpEnrollBegin(r), irk.privateKey);
}
export function verifyTotpEnrollBegin(
  r: TotpEnrollBegin,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalTotpEnrollBegin(r), irkPub);
  } catch {
    return false;
  }
}

export function signTotpEnrollConfirm(
  r: TotpEnrollConfirm,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalTotpEnrollConfirm(r), irk.privateKey);
}
export function verifyTotpEnrollConfirm(
  r: TotpEnrollConfirm,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalTotpEnrollConfirm(r), irkPub);
  } catch {
    return false;
  }
}

export function signTotpDisable(r: TotpDisable, irk: Keypair): Bytes {
  return ed.sign(canonicalTotpDisable(r), irk.privateKey);
}
export function verifyTotpDisable(
  r: TotpDisable,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalTotpDisable(r), irkPub);
  } catch {
    return false;
  }
}
