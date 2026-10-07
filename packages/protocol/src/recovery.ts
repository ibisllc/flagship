/**
 * Account recovery & lifecycle domain — re-pair takeover (RePairInitiate /
 * RePairObject), wipe-and-restart, the webapp cloud-shard recovery upload,
 * merge-back (#76), username rename (#93), and the inheritance declaration
 * (#77).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_RE_PAIR_INITIATE = "flagship/re-pair-initiate/v1";
const TAG_RE_PAIR_OBJECT = "flagship/re-pair-object/v1";
const TAG_RE_PAIR_COMPLETE = "flagship/re-pair-complete/v1";
const TAG_WIPE_RESTART = "flagship/wipe-restart/v1";
const TAG_UPLOAD_RECOVERY_RECORD = "flagship/upload-recovery-record/v1";
const TAG_MERGE_BACK = "flagship/merge-back/v1";
const TAG_USERNAME_RENAME = "flagship/username-rename/v1";
const TAG_INHERITANCE_DECLARATION = "flagship/inheritance-declaration/v1";

/**
 * Recovery re-pair (J.3) — after the user has lost their old UMK
 * and generated a fresh one (so a NEW IRK), they POST this
 * envelope to claim ownership of their existing username + servers.
 * .com starts a grace timer; after it expires the holder of the NEW
 * IRK signs a `RePairComplete` and .com swaps the username's IRK
 * pubkey atomically.
 *
 * Signed by the NEW IRK (the one taking over).
 *
 * The signature alone is NOT authorization — it is self-asserted (the
 * initiator signs with the key it is asking .com to install). `.com`
 * additionally requires a RECOVERY CREDENTIAL proof beside this
 * envelope: a TOTP / recovery code (`totpProof`, multi-device) or the
 * recovery-session token minted by the passphrase-gated wrapped-UMK
 * fetch (single-device). See `handleInitiateRePair`.
 */
export interface RePairInitiate {
  username: string;
  newIrkPub: Bytes;
  /** Old IRK pubkey. `.com` requires it to equal the account's currently-registered IRK and CAS-swaps on it at completion, so a stale snapshot can never displace a newer key. It is PUBLIC (served by the username lookup) and therefore proves nothing on its own. */
  oldIrkPub: Bytes;
  issuedAt: number;
  /**
   * v1.2 — REQUIRED when the target account_type === 'multi'.
   *
   * Carries a 6-digit TOTP or a 10-char recovery code so the Worker
   * can gate the multi-device recovery path on out-of-Apple proof
   * before the 24h grace even starts. Phase 2 only checks structural
   * presence (the code is non-empty + the method is one of the two
   * allowed literals) and stamps `totp_proof_consumed` on the
   * pending row; Phase 3 (TOTP enrollment + verification) replaces
   * the structural check with `verifyTotp` from the `otpauth`
   * library + an atomic single-use recovery-code redemption.
   *
   * **NOT** part of the canonical-bytes signed envelope. Codes are
   * ephemeral by design (TOTP rolls every 30s; recovery codes are
   * single-use) and a code embedded in a long-lived signature would
   * either leak the code to anyone with replay access to the
   * signature, or force the canonical bytes to invalidate within
   * seconds. Instead the body MAY carry the proof beside the signed
   * envelope; the Worker validates the IRK signature against the
   * canonical envelope (no totpProof bytes) and validates the proof
   * against the stored TOTP secret + recovery-codes table
   * synchronously.
   */
  totpProof?: {
    /** 6-digit TOTP code OR 10-char base32 recovery code. */
    code: string;
    method: "totp" | "recovery";
  };
}

/**
 * Cancel a pending re-pair. Signed by the NEW IRK — the recoverer's
 * OWN key, so this is a SELF-cancel ("I started recovery on the wrong
 * device"), NOT a veto the displaced owner can exercise. The old-IRK
 * veto was removed deliberately (a device thief usually also holds the
 * credential, so veto power was a net negative); the brake on an
 * unauthorized takeover is the credential gate at initiate, not an
 * objection window. See `handleObjectRePair`.
 */
export interface RePairObject {
  username: string;
  /** Pinned to the new IRK pubkey from the pending row, so a leaked old objection can't cancel a future re-pair. */
  newIrkPub: Bytes;
  issuedAt: number;
}

function canonicalRePairInitiate(r: RePairInitiate): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_RE_PAIR_INITIATE, r.username, hex(r.newIrkPub), hex(r.oldIrkPub), r.issuedAt].join("|"),
  );
}

function canonicalRePairObject(r: RePairObject): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_RE_PAIR_OBJECT, r.username, hex(r.newIrkPub), r.issuedAt].join("|"),
  );
}

export function signRePairInitiate(r: RePairInitiate, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRePairInitiate(r), newIrk.privateKey);
}
export function verifyRePairInitiate(r: RePairInitiate, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRePairInitiate(r), newIrkPub);
  } catch {
    return false;
  }
}

export function signRePairObject(r: RePairObject, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRePairObject(r), newIrk.privateKey);
}
export function verifyRePairObject(r: RePairObject, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRePairObject(r), newIrkPub);
  } catch {
    return false;
  }
}

/**
 * Finalize a pending re-pair once its grace window has elapsed.
 *
 * Signed by the NEW IRK — the key the pending row will install — so
 * `.com` installs a key only on the instruction of whoever holds it.
 * The swap target is still read from the pending row, never from this
 * envelope: a valid signature cannot redirect the swap, it only
 * authorizes the one already scheduled.
 *
 * Field shape is IDENTICAL to `RePairObject` (username, newIrkPub,
 * issuedAt) and both are signed by the same key — which is exactly why
 * the tag differs. Without a distinct tag, a captured SELF-CANCEL
 * signature would replay as a COMPLETION (and vice versa), turning the
 * recoverer's own "stop" into "go". The tag is the verb.
 */
export interface RePairComplete {
  username: string;
  /** Pinned to the pending row's new IRK pubkey; a mismatch is rejected. */
  newIrkPub: Bytes;
  issuedAt: number;
}

function canonicalRePairComplete(r: RePairComplete): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_RE_PAIR_COMPLETE, r.username, hex(r.newIrkPub), r.issuedAt].join("|"),
  );
}

export function signRePairComplete(r: RePairComplete, newIrk: Keypair): Bytes {
  return ed.sign(canonicalRePairComplete(r), newIrk.privateKey);
}
export function verifyRePairComplete(r: RePairComplete, sig: Bytes, newIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRePairComplete(r), newIrkPub);
  } catch {
    return false;
  }
}

/**
 * Wipe & restart (v1.1) — the user holds the OLD IRK + the recovered
 * UMK but elects to nuke the account state instead of running the
 * 24h-grace re-pair path. Signed by the OLD IRK (proving the caller
 * is in possession of the displaced key, which is the same trust
 * basis as the recovery envelope) AND, when delivered to the Worker,
 * accompanied by the new recovery envelope that the Worker swaps in
 * atomically.
 *
 * Distinct tag from RePairInitiate so a leaked RePair signature can't
 * be replayed as a Wipe (different verbs, different effects).
 */
export interface WipeRestart {
  username: string;
  /** OLD IRK pubkey, included so .com can SQL-CAS on the current row. */
  oldIrkPub: Bytes;
  /** NEW IRK pubkey installed by this operation. */
  newIrkPub: Bytes;
  /** New WebAuthn credentialId (hex) for the rotated recovery passkey. */
  newCredentialIdHex: string;
  /** SHA-256 of the new wrappedUmk (so the canonical bytes don't bloat). */
  newWrappedUmkHashHex: string;
  issuedAt: number;
}

function canonicalWipeRestart(r: WipeRestart): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("newCredentialIdHex", r.newCredentialIdHex);
  legacyFieldGuard("newWrappedUmkHashHex", r.newWrappedUmkHashHex);
  return new TextEncoder().encode(
    [
      TAG_WIPE_RESTART,
      r.username,
      hex(r.oldIrkPub),
      hex(r.newIrkPub),
      r.newCredentialIdHex.toLowerCase(),
      r.newWrappedUmkHashHex.toLowerCase(),
      r.issuedAt,
    ].join("|"),
  );
}

export function signWipeRestart(r: WipeRestart, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalWipeRestart(r), oldIrk.privateKey);
}
export function verifyWipeRestart(r: WipeRestart, sig: Bytes, oldIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalWipeRestart(r), oldIrkPub);
  } catch {
    return false;
  }
}

/**
 * Webapp cloud-shard recovery — upload a wrapped-UMK ciphertext to
 * flagshipserver.com, encrypted under a WebAuthn passkey's PRF
 * output. `.com` only stores the ciphertext + the credentialId
 * pointer; the unwrap key never leaves the user's browser.
 *
 * The signed envelope binds the upload to the user's IRK so squatting
 * "I am alice" is impossible — `.com` cross-checks the signature
 * against the IRK pubkey stored against `username` in the usernames
 * table.
 *
 * Field shape:
 *   - username:        identifier under which the record is keyed
 *                      (matches the existing usernames table; ASCII,
 *                      lowercased)
 *   - credentialIdHex: WebAuthn credential ID (hex), used by the
 *                      recovering browser to scope the get() call
 *   - wrappedUmkHash:  SHA-256 of the wrapped-UMK ciphertext, hex.
 *                      We sign the hash (not the blob) to keep
 *                      canonical-bytes small and to let `.com` check
 *                      the upload-time hash matches the stored blob
 *                      bytes.
 */
export interface UploadRecoveryRecord {
  username: string;
  credentialIdHex: string;
  wrappedUmkHashHex: string;
  issuedAt: number;
}

function canonicalUploadRecoveryRecord(r: UploadRecoveryRecord): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("credentialIdHex", r.credentialIdHex);
  legacyFieldGuard("wrappedUmkHashHex", r.wrappedUmkHashHex);
  return new TextEncoder().encode(
    [
      TAG_UPLOAD_RECOVERY_RECORD,
      r.username,
      r.credentialIdHex,
      r.wrappedUmkHashHex,
      r.issuedAt,
    ].join("|"),
  );
}

export function signUploadRecoveryRecord(r: UploadRecoveryRecord, irk: Keypair): Bytes {
  return ed.sign(canonicalUploadRecoveryRecord(r), irk.privateKey);
}
export function verifyUploadRecoveryRecord(
  r: UploadRecoveryRecord,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalUploadRecoveryRecord(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// MergeBack (#76) — for 7 days after a J.3 recovery binds, the old
// IRK retains authority to sign exactly one envelope kind: a
// MergeBack that surrenders to the new IRK and self-revokes. Handles
// "I recovered then found my phone in the couch cushions." After 7
// days, the old IRK is hard-revoked unconditionally.
// ──────────────────────────────────────────────────────────────────────

export interface MergeBack {
  username: string;
  newIrkPubKey: Bytes;
  /** Devices surrendering authority. */
  surrenderingDevices: Bytes[];
  issuedAt: number;
}

function canonicalMergeBack(m: MergeBack): Bytes {
  validateNoSepCtrl("username", m.username);
  const devices = [...m.surrenderingDevices].map((b) => hex(b)).sort().join(",");
  return new TextEncoder().encode(
    [TAG_MERGE_BACK, m.username, hex(m.newIrkPubKey), devices, m.issuedAt].join("|"),
  );
}

export function signMergeBack(m: MergeBack, oldIrk: Keypair): Bytes {
  return ed.sign(canonicalMergeBack(m), oldIrk.privateKey);
}

export function verifyMergeBack(m: MergeBack, sig: Bytes, oldIrkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalMergeBack(m), oldIrkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// UsernameRename (#93) — IRK-signed account rename. Records a
// permanent alias in .com's usernames_aliases table so old invite
// links + URLs resolve indefinitely. The OLD name is forever consumed
// — never re-issuable to anyone else (closes the "stolen-name →
// someone-else-gets-it" attack).
// ──────────────────────────────────────────────────────────────────────

export interface UsernameRename {
  oldUsername: string;
  newUsername: string;
  effectiveAt: number;
}

function canonicalUsernameRename(r: UsernameRename): Bytes {
  validateNoSepCtrl("oldUsername", r.oldUsername);
  validateNoSepCtrl("newUsername", r.newUsername);
  return new TextEncoder().encode(
    [TAG_USERNAME_RENAME, r.oldUsername, r.newUsername, r.effectiveAt].join("|"),
  );
}

export function signUsernameRename(r: UsernameRename, irk: Keypair): Bytes {
  return ed.sign(canonicalUsernameRename(r), irk.privateKey);
}

export function verifyUsernameRename(r: UsernameRename, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalUsernameRename(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// InheritanceDeclaration (#77) — opt-in heir track.
//
// A user MAY publish a signed declaration naming one or more heirs and
// a `triggerAfterInactiveDays` threshold. If the user signs nothing for
// that many days, the heir may post a takeover request which then waits
// out a 7-day public notice period before .com swaps the IRK pubkey to
// the heir.
//
// Default: OFF. The webapp's settings carries a loud opt-in popup; the
// declaration is keyed on the user's username and stored on the user-
// identity encrypted blob (see control-plane/inheritance.ts).
//
// The threshold is a K-of-N policy: `threshold` heir signatures must be
// present on a takeover request for it to advance to the notice
// period. K=1, N=1 is the simple "one heir" case; K=2, N=3 supports
// "two of three lawyers" patterns without giving any single lawyer
// unilateral takeover power.
//
// Sensitive primitive — see docs/policy/inheritance.md for the threat
// model. The 7-day notice period is critical: the user has a chance
// to sign any envelope (resetting the inactive timer) before the
// takeover binds, and may revoke the declaration outright with one
// IRK-signed POST. .com publicly logs every takeover request so the
// user is alerted via every active push channel.
// ──────────────────────────────────────────────────────────────────────

export interface InheritanceDeclaration {
  username: string;
  /** Hex pubkeys of every heir (32 bytes each), sorted ascending. */
  heirIrkPub: Bytes[];
  /** K-of-N. 1 ≤ threshold ≤ heirIrkPub.length. */
  threshold: number;
  /** Bumps when the user edits the heir set; replay-defends downstream takeovers. */
  heirSetVersion: number;
  /** Inactive-days threshold; default 365. */
  triggerAfterInactiveDays: number;
  issuedAt: number;
}

function canonicalInheritanceDeclaration(d: InheritanceDeclaration): Bytes {
  validateNoSepCtrl("username", d.username);
  // Sort heir pubkeys ascending by hex so the bytes don't depend on
  // input ordering — clients sometimes assemble heir lists from
  // multiple sources and we want the sig to verify regardless.
  const heirList = [...d.heirIrkPub].map((b) => hex(b)).sort().join(",");
  return new TextEncoder().encode(
    [
      TAG_INHERITANCE_DECLARATION,
      d.username,
      heirList,
      d.threshold,
      d.heirSetVersion,
      d.triggerAfterInactiveDays,
      d.issuedAt,
    ].join("|"),
  );
}

export function signInheritanceDeclaration(
  d: InheritanceDeclaration,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalInheritanceDeclaration(d), irk.privateKey);
}

export function verifyInheritanceDeclaration(
  d: InheritanceDeclaration,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalInheritanceDeclaration(d), irkPub);
  } catch {
    return false;
  }
}
