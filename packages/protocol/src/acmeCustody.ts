/**
 * ACME account-key custody domain (per-user-cert design) — the IRK-signed
 * grant that distributes the sealed ACME account key to admin-scope devices,
 * its revoke, and the dead-lead-safe MintReservation CAS lease.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, bounds, and validators are unchanged, so canonical bytes and
 * signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// ACME account-key custody (per-user-cert design §4.2)
//
// The ACME ACCOUNT key is the AUTHORITY to mint the per-user TLS cert. It is
// held ONLY by admin-scope devices (and, opt-in, an "autonomous" box), sealed
// to each recipient — NEVER UMK-derived (that would hand it to every device,
// breaking the admin boundary) and NEVER given to .com. The grant is
// IRK-signed: the account root distributes the (opaque, already-sealed)
// account key to the devices it designates admin. The recipient unseals with
// its own key; a consumer SEPARATELY confirms the recipient holds the `admin`
// DeviceScope before honoring a mint. Rotation (RevokeAcmeAccountKey) retires
// an accountKeyId — on admin demotion / compromise the old key goes dead and
// every holder re-receives the new one under a fresh grant.
// ──────────────────────────────────────────────────────────────────────

export interface AcmeAccountKeyGrant {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  username: string;
  /** sha256-hex of the ACME account PUBLIC key — a public reference shared by
   *  every grant of the same key. Rotation changes it. */
  accountKeyId: string;
  /** The recipient device's Ed25519 pubkey (32 bytes) the key is sealed to. */
  recipientPubKey: Bytes;
  /** The ACME account key sealed to recipientPubKey (opaque ciphertext —
   *  the protocol carries it; the seal/unseal primitive is the caller's). */
  sealedAccountKey: Bytes;
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; re-seal before expiry. */
  expiresAt: number;
}

const TAG_ACME_ACCOUNT_KEY_GRANT = "flagship/acme-account-key-grant/v1";
const MAX_SEALED_ACCOUNT_KEY = 4096; // generous bound for a sealed keypair

function validateAcmeAccountKeyGrantFields(g: AcmeAccountKeyGrant): void {
  const fields: Array<[string, string]> = [
    ["grantId", g.grantId],
    ["username", g.username],
    ["accountKeyId", g.accountKeyId],
  ];
  for (const [name, value] of fields) {
    if (value.length === 0) throw new Error(`AcmeAccountKeyGrant: empty "${name}"`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c) throw new Error(`AcmeAccountKeyGrant field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(`AcmeAccountKeyGrant field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
      }
    }
  }
  if (g.expiresAt <= g.issuedAt) {
    throw new Error("AcmeAccountKeyGrant: expiresAt must be strictly after issuedAt");
  }
  if (g.recipientPubKey.length !== 32) {
    throw new Error(`AcmeAccountKeyGrant: recipientPubKey must be 32 bytes, got ${g.recipientPubKey.length}`);
  }
  if (g.sealedAccountKey.length === 0 || g.sealedAccountKey.length > MAX_SEALED_ACCOUNT_KEY) {
    throw new Error("AcmeAccountKeyGrant: sealedAccountKey must be non-empty within bounds");
  }
}

function canonicalAcmeAccountKeyGrant(g: AcmeAccountKeyGrant): Bytes {
  validateAcmeAccountKeyGrantFields(g);
  return new TextEncoder().encode(
    [
      TAG_ACME_ACCOUNT_KEY_GRANT,
      g.grantId,
      g.username,
      g.accountKeyId,
      hex(g.recipientPubKey),
      hex(g.sealedAccountKey),
      g.issuedAt,
      g.expiresAt,
    ].join("|"),
  );
}

export function signAcmeAccountKeyGrant(g: AcmeAccountKeyGrant, irk: Keypair): Bytes {
  return ed.sign(canonicalAcmeAccountKeyGrant(g), irk.privateKey);
}

export function verifyAcmeAccountKeyGrant(g: AcmeAccountKeyGrant, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAcmeAccountKeyGrant(g), irkPub);
  } catch {
    return false;
  }
}

/** sha256-hex of the canonical bytes — the storage key / dedup handle. */
export async function acmeAccountKeyGrantId(g: AcmeAccountKeyGrant): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalAcmeAccountKeyGrant(g));
  return hex(new Uint8Array(digest));
}

export type AccountKeyRevokeReason = "demotion" | "compromise" | "rotation";
const ACCOUNT_KEY_REVOKE_REASONS: ReadonlySet<AccountKeyRevokeReason> = new Set([
  "demotion",
  "compromise",
  "rotation",
]);

export interface RevokeAcmeAccountKey {
  /** The accountKeyId being retired. */
  accountKeyId: string;
  username: string;
  reason: AccountKeyRevokeReason;
  issuedAt: number;
}

const TAG_REVOKE_ACME_ACCOUNT_KEY = "flagship/revoke-acme-account-key/v1";

function canonicalRevokeAcmeAccountKey(r: RevokeAcmeAccountKey): Bytes {
  for (const [name, value] of [["accountKeyId", r.accountKeyId], ["username", r.username]] as const) {
    if (value.length === 0) throw new Error(`RevokeAcmeAccountKey: empty "${name}"`);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c) throw new Error(`RevokeAcmeAccountKey field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) throw new Error(`RevokeAcmeAccountKey field "${name}" contains control char`);
    }
  }
  if (!ACCOUNT_KEY_REVOKE_REASONS.has(r.reason)) {
    throw new Error(`RevokeAcmeAccountKey: unknown reason "${String(r.reason)}"`);
  }
  return new TextEncoder().encode(
    [TAG_REVOKE_ACME_ACCOUNT_KEY, r.accountKeyId, r.username, r.reason, r.issuedAt].join("|"),
  );
}

export function signRevokeAcmeAccountKey(r: RevokeAcmeAccountKey, irk: Keypair): Bytes {
  return ed.sign(canonicalRevokeAcmeAccountKey(r), irk.privateKey);
}

export function verifyRevokeAcmeAccountKey(r: RevokeAcmeAccountKey, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRevokeAcmeAccountKey(r), irkPub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// MintReservation — the dead-lead-safe CAS lease that serializes who
// re-mints a user's per-user cert this cycle (per-user-cert design).
//
// A minter (an admin-scope device, or an "autonomous" box that holds a
// renewal delegation) signs this claim with its OWN minting key before
// acquiring the lease at `.com`. The HOLDER signs — unlike the ACME-account
// envelopes (IRK-signed by the account root), this one is authenticated by
// whoever wants to lead the cycle, and `.com` separately confirms (via
// requireMinter) that the holder is a real minter for the user. The lease
// is non-secret coordination metadata: `.com` orders/dedupes it but cannot
// forge a cert, and CT-monitoring catches anything that slips. δ (the lease
// TTL implied by expiresAt) ≈ one ACME order, ≪ remaining cert life, so a
// dead lead's lease lapses and the next minter takes over.
// ──────────────────────────────────────────────────────────────────────

export interface MintReservationClaim {
  username: string;
  /** The minter's own signing pubkey (32 bytes) — the holder that signed. */
  holderPubKey: Bytes;
  /** ms since epoch; the lease is reclaimable once now >= expiresAt. */
  expiresAt: number;
}

const TAG_MINT_RESERVATION = "flagship/mint-reservation/v1";

function canonicalMintReservation(c: MintReservationClaim): Bytes {
  if (c.username.length === 0) throw new Error('MintReservationClaim: empty "username"');
  for (let i = 0; i < c.username.length; i++) {
    const ch = c.username.charCodeAt(i);
    if (ch === 0x7c) throw new Error('MintReservationClaim field "username" contains separator \'|\'');
    if (ch <= 0x1f || ch === 0x7f) {
      throw new Error(`MintReservationClaim field "username" contains control char 0x${ch.toString(16)} at index ${i}`);
    }
  }
  if (c.holderPubKey.length !== 32) {
    throw new Error(`MintReservationClaim: holderPubKey must be 32 bytes, got ${c.holderPubKey.length}`);
  }
  return new TextEncoder().encode(
    [TAG_MINT_RESERVATION, c.username, hex(c.holderPubKey), c.expiresAt].join("|"),
  );
}

export function signMintReservation(c: MintReservationClaim, kp: Keypair): Bytes {
  return ed.sign(canonicalMintReservation(c), kp.privateKey);
}

export function verifyMintReservation(c: MintReservationClaim, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalMintReservation(c), pub);
  } catch {
    return false;
  }
}
