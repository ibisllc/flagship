import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Peer-backup manifest carrier (server-migration Layer 0).
//
// The manifest is the owner box's map of "which peer holds which shard
// of which chunk" — the recovery root a FRESH box needs before it can
// pull a single shard. It ships to `.com` so it survives the loss of
// the box that wrote it, but `.com` stays content-blind: the manifest
// is sealed under a key derived from the SWK. The SWK is deterministic
// (`deriveSWK(umk, serverId)`), so a replacement box for the same
// serverId re-derives it and opens the manifest with no escrow dance.
//
// The seal key is a DEDICATED subkey (not the raw SWK and not the
// per-chunk key): chunk keys are derived from each chunk's plaintext
// hash, which the manifest itself records — sealing the manifest under
// its own fixed-info subkey avoids publishing any plaintext hash.
// ──────────────────────────────────────────────────────────────────────

export const TAG_PB_MANIFEST_DEPOSIT = "flagship/pb-manifest/v1";
const INFO_PB_MANIFEST_KEY = "flagship.pb-manifest.v1";

export function deriveBackupManifestKey(swk: Bytes): Bytes {
  return hkdf(
    sha256,
    swk,
    new Uint8Array(0),
    new TextEncoder().encode(INFO_PB_MANIFEST_KEY),
    32,
  );
}

export interface SealedBackupManifest {
  ciphertext: Bytes;
  nonce: Bytes;
}

export function sealBackupManifest(plaintext: Bytes, swk: Bytes): SealedBackupManifest {
  const key = deriveBackupManifestKey(swk);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return { ciphertext: gcm(key, nonce).encrypt(plaintext), nonce };
}

/** Throws on a wrong SWK / tampered ciphertext (GCM auth failure). */
export function openBackupManifest(blob: SealedBackupManifest, swk: Bytes): Bytes {
  const key = deriveBackupManifestKey(swk);
  return gcm(key, blob.nonce).decrypt(blob.ciphertext);
}

/**
 * STK-signed wrapper the box presents when depositing a sealed manifest
 * on `.com`. The signature commits to the serverId, a monotonically
 * increasing generation (latest-wins upsert; a replayed older deposit
 * can never roll the stored manifest back), and the exact ciphertext.
 */
export interface PbManifestDeposit {
  serverId: ServerId;
  /** Monotonic per-server counter — `.com` rejects generation <= stored. */
  generation: number;
  updatedAt: number;
  /** sha256 of the sealed manifest ciphertext, hex. */
  ciphertextSha256Hex: string;
  /** GCM nonce of the seal, hex (12 bytes = 24 hex chars). */
  nonceHex: string;
}

function canonicalPbManifestDeposit(d: PbManifestDeposit): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PB_MANIFEST_DEPOSIT,
      d.serverId,
      d.generation,
      d.updatedAt,
      d.ciphertextSha256Hex,
      d.nonceHex,
    ].join("|"),
  );
}

export function signPbManifestDeposit(d: PbManifestDeposit, stk: Keypair): Bytes {
  return ed.sign(canonicalPbManifestDeposit(d), stk.privateKey);
}

export function verifyPbManifestDeposit(
  d: PbManifestDeposit,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalPbManifestDeposit(d), stkPub);
  } catch {
    return false;
  }
}
