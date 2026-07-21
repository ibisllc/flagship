/**
 * Sealed directory/profile-key delivery — the crypto layer for the
 * `AccountDirectoryKeyGrant` envelope (`accountMetadata.ts`).
 *
 * A RESTRICTED device (one that never holds the account UMK) cannot itself
 * derive the account-profile key or the device-directory key — those are
 * `HKDF(UMK, …)` outputs (`deriveAccountProfileKey` / `deriveDeviceDirectoryKey`).
 * So it can list the private directory but not decrypt any name. This module is
 * the hand-off that fixes that without ever exposing a plaintext key to `.com`:
 * an ADMIN device (which holds the UMK) SEALS the permitted 32-byte key to the
 * recipient device's registered Ed25519 identity pubkey via the existing
 * `SecretSeal` primitive (`sealForEd25519Recipient`, verified against the four
 * cross-platform seal KATs), wraps it in an admin-root-signed
 * `AccountDirectoryKeyGrant`, and publishes it. `.com` stores + relays the
 * SEALED blob only — it never sees the key or any name.
 *
 * This is the EXACT twin of the SWK/CGK/Acme sealed deliveries, except the
 * signed wrapper is the already-shipped `AccountDirectoryKeyGrant` (admin-root
 * Ed25519 signature over `canonicalAccountDirectoryKeyGrant`) rather than a
 * bespoke carrier, so the server authorization path (`handlePutAccountDirectoryKeyGrant`)
 * is reused unchanged.
 *
 * `sealedKeyHex` wire layout (hex of `SecretSeal` output):
 *
 *   [eph_x25519_pub:32][nonce:12][ciphertext(32)+GCM tag(16)]  = 92 bytes → 184 hex
 *
 * Trust flow:
 *   - PHONE/admin: `buildAccountDirectoryKeyGrant` seals the key to the
 *     recipient device pub and admin-root-signs the grant.
 *   - RECIPIENT: `openAccountDirectoryKeyGrant` verifies the admin-root
 *     signature AND that the grant names THIS account + THIS device (+ not
 *     expired) BEFORE unsealing with the device's Ed25519 seed. Returns the
 *     32-byte key or `null` on ANY defect (bad signature, wrong recipient,
 *     wrong account, tampered ciphertext, expired). NEVER throws — matching the
 *     repo's other verify/open helpers.
 */
import {
  type AccountDirectoryKeyGrant,
  signAccountDirectoryKeyGrant,
  verifyAccountDirectoryKeyGrant,
} from "./accountMetadata.js";
import { hex, type MsgSigner } from "./canonicalBase.js";
import { sealForEd25519Recipient, openSealedFromEd25519Recipient } from "./encryption.js";
import type { Bytes } from "./types.js";

/** Account-profile and device-directory keys are both 32-byte HKDF outputs. */
export const DIRECTORY_KEY_BYTES = 32;

export type DirectoryKeyKind = AccountDirectoryKeyGrant["keyKind"];

function bytesFromHex(value: string): Bytes {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) throw new Error("invalid lowercase hex");
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * PHONE/admin side. Seal a 32-byte directory key to the recipient device's
 * Ed25519 identity pubkey (mapped to X25519 under the hood) and return the
 * `sealedKeyHex` the grant carries. Split out so a caller can seal without
 * building the whole grant (and so the golden-vector generator can pin the seal
 * input separately from the randomized output).
 */
export function sealDirectoryKey(key: Bytes, recipientDevicePub: Bytes): string {
  if (key.length !== DIRECTORY_KEY_BYTES) throw new Error("directory key must be 32 bytes");
  if (recipientDevicePub.length !== 32) throw new Error("recipient device pubkey must be 32 bytes");
  return hex(sealForEd25519Recipient(key, recipientDevicePub));
}

/**
 * PHONE/admin side. Seal the permitted directory key to the recipient device
 * and mint the admin-root-signed `AccountDirectoryKeyGrant`. The caller passes
 * the raw 32-byte key (the admin already holds the UMK and has run
 * `deriveAccountProfileKey` / `deriveDeviceDirectoryKey`). Returns the grant +
 * its admin-root signature, ready for `handlePutAccountDirectoryKeyGrant`.
 */
export function buildAccountDirectoryKeyGrant(args: {
  accountId: string;
  recipientDeviceId: string;
  keyKind: DirectoryKeyKind;
  /** The raw 32-byte key to deliver (profile key OR device-directory key). */
  key: Bytes;
  /** The recipient device's registered Ed25519 identity pubkey (32 bytes). */
  recipientDevicePub: Bytes;
  /** The account's admin-root signer (Keypair or custodian-backed signer). */
  adminRoot: MsgSigner;
  /** The admin-root pubkey, lowercase hex — recorded in the grant. */
  adminRootPubHex: string;
  issuedAt: number;
  expiresAt: number;
}): { grant: AccountDirectoryKeyGrant; signature: string } {
  const sealedKeyHex = sealDirectoryKey(args.key, args.recipientDevicePub);
  const grant: AccountDirectoryKeyGrant = {
    accountId: args.accountId,
    recipientDeviceId: args.recipientDeviceId,
    keyKind: args.keyKind,
    sealedKeyHex,
    issuedAt: args.issuedAt,
    expiresAt: args.expiresAt,
    signerPubHex: args.adminRootPubHex.toLowerCase(),
  };
  const signature = signAccountDirectoryKeyGrant(grant, args.adminRoot);
  return { grant, signature };
}

/**
 * RECIPIENT side. Verify the admin-root signature over the grant AND that the
 * grant is addressed to THIS account + THIS device (and, if `now` is supplied,
 * that it has not expired), THEN unseal the delivered key. Returns the 32-byte
 * key or `null` on ANY defect. NEVER throws.
 *
 * The signature is checked BEFORE unsealing so a tampered `sealedKeyHex` (which
 * is inside the canonical bytes) is rejected at the signature step, and a
 * substitution to a different account/device fails the binding check even if it
 * carries a valid-looking signature for another target.
 */
export function openAccountDirectoryKeyGrant(args: {
  grant: AccountDirectoryKeyGrant;
  signature: string;
  /** The account's pinned admin-root pubkey — the only trust anchor. */
  adminRootPub: Bytes;
  /** This device's account id — the grant must name it. */
  expectedAccountId: string;
  /** This device id — the grant must name it. */
  expectedRecipientDeviceId: string;
  /** This device's Ed25519 identity SEED (32-byte private key). Legacy form;
   *  prefer `unseal` so the seed never surfaces. */
  recipientDeviceSeed?: Bytes;
  /** Custodian-backed unseal (opens a blob sealed to this device). Used instead
   *  of `recipientDeviceSeed` when present. Exactly one must be supplied. */
  unseal?: (blob: Bytes) => Bytes;
  /** Optional wall clock (ms). When supplied, an expired grant is rejected. */
  now?: number;
}): Bytes | null {
  try {
    const grant = args.grant;
    if (grant.accountId.toLowerCase() !== args.expectedAccountId.toLowerCase()) return null;
    if (grant.recipientDeviceId !== args.expectedRecipientDeviceId.toLowerCase()) return null;
    if (typeof args.now === "number" && (args.now < grant.issuedAt || args.now >= grant.expiresAt)) {
      return null;
    }
    if (!verifyAccountDirectoryKeyGrant(grant, args.signature, args.adminRootPub)) return null;
    const unseal =
      args.unseal ??
      (args.recipientDeviceSeed
        ? (blob: Bytes) => openSealedFromEd25519Recipient(blob, args.recipientDeviceSeed!)
        : null);
    if (!unseal) return null;
    const key = unseal(bytesFromHex(grant.sealedKeyHex));
    if (key.length !== DIRECTORY_KEY_BYTES) return null;
    return key;
  } catch {
    return null;
  }
}
