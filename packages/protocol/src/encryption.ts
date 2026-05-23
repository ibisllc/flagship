import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import type { Bytes } from "./types.js";

export interface EncryptedChunk {
  ciphertext: Bytes;
  nonce: Bytes;
  contentHash: Bytes;
}

export function deriveChunkKey(swk: Bytes, contentHash: Bytes): Bytes {
  return hkdf(sha256, swk, contentHash, new TextEncoder().encode("flagship.chunk.v1"), 32);
}

export function encryptChunk(plaintext: Bytes, swk: Bytes): EncryptedChunk {
  const contentHash = sha256(plaintext);
  const key = deriveChunkKey(swk, contentHash);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  return { ciphertext, nonce, contentHash };
}

export function decryptChunk(chunk: EncryptedChunk, swk: Bytes): Bytes {
  const key = deriveChunkKey(swk, chunk.contentHash);
  return gcm(key, chunk.nonce).decrypt(chunk.ciphertext);
}

/**
 * LLM-call subkey: derived from SWK; used to wrap LLM API keys + prompts
 * end-to-end between the phone and the user's own Flagship server. Defense
 * in depth — the tunnel is already encrypted, but a cipher break on the
 * tunnel still leaves an attacker with ciphertext that needs SWK to decrypt.
 *
 * Both sides (phone and server) hold SWK, so both can derive this key.
 */
export function deriveLlmKey(swk: Bytes): Bytes {
  return hkdf(sha256, swk, new Uint8Array(0), new TextEncoder().encode("flagship.llm.v1"), 32);
}

export interface SealedBlob {
  ciphertext: Bytes;
  nonce: Bytes;
}

export function sealLlmPayload(plaintext: Bytes, swk: Bytes): SealedBlob {
  const key = deriveLlmKey(swk);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  return { ciphertext, nonce };
}

export function openLlmPayload(blob: SealedBlob, swk: Bytes): Bytes {
  const key = deriveLlmKey(swk);
  return gcm(key, blob.nonce).decrypt(blob.ciphertext);
}

// ──────────────────────────────────────────────────────────────────────
// Public-key sealed payloads (LUKS unlock key delivery)
//
// Functionally equivalent to libsodium's `crypto_box_seal`: encrypt a
// payload to a recipient X25519 pubkey such that only the recipient's
// private key can decrypt it. The recipient never has to be online —
// the sender mints an ephemeral keypair, derives a shared secret, and
// throws the ephemeral private key away. The recipient pulls the
// ephemeral pubkey out of the sealed blob, derives the same secret,
// and decrypts.
//
// Wire layout (`Uint8Array`):
//
//   [eph_x25519_pub: 32 B][nonce: 12 B][ciphertext + GCM tag: var]
//
// Total size = 44 + plaintext.length. Recipients that decode this
// format byte-for-byte interoperate with this implementation
// regardless of the language they're written in.
//
// Used by the install path to seal the LUKS unlock key against the
// phone's BAK X25519 pubkey before shipping it to flagshipserver.com.
// `.com` stores the sealed blob; the phone (with its BAK private key)
// is the only entity that can recover the plaintext key.
// ──────────────────────────────────────────────────────────────────────

import { ed25519, x25519 } from "@noble/curves/ed25519.js";

export const FLAGSHIP_SEAL_TAG = "flagship.seal.v1";

export function sealForRecipient(
  plaintext: Bytes,
  recipientX25519Pub: Bytes,
): Bytes {
  if (recipientX25519Pub.length !== 32) {
    throw new Error("recipient X25519 pubkey must be 32 bytes");
  }
  const ephPriv = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientX25519Pub);
  const key = hkdf(
    sha256,
    shared,
    ephPub,
    new TextEncoder().encode(FLAGSHIP_SEAL_TAG),
    32,
  );
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = gcm(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return out;
}

/**
 * Convenience for sealing against an Ed25519 pubkey: converts the
 * recipient's Ed25519 pubkey to its X25519 (Curve25519) equivalent via
 * the standard birational map, then seals. The phone side runs the
 * matching conversion on its Ed25519 private key (libsodium's
 * `crypto_sign_ed25519_sk_to_curve25519`) to recover the X25519
 * private key it needs to open the sealed blob.
 *
 * This is the same trick libsodium's `crypto_box_seal` uses when
 * given a sign-key. It re-uses one keypair for both signing and
 * encryption — generally inferior to keeping them separate, but
 * unblocks the LUKS-key install path before the phone has a
 * dedicated BAK X25519 keypair.
 */
export function sealForEd25519Recipient(
  plaintext: Bytes,
  recipientEd25519Pub: Bytes,
): Bytes {
  const x25519Pub = ed25519.utils.toMontgomery(recipientEd25519Pub);
  return sealForRecipient(plaintext, x25519Pub);
}

export function openSealed(
  blob: Bytes,
  recipientX25519Priv: Bytes,
): Bytes {
  if (blob.length < 44) {
    throw new Error("sealed blob too short (need at least eph_pub + nonce)");
  }
  if (recipientX25519Priv.length !== 32) {
    throw new Error("recipient X25519 priv must be 32 bytes");
  }
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 44);
  const ct = blob.slice(44);
  const shared = x25519.getSharedSecret(recipientX25519Priv, ephPub);
  const key = hkdf(
    sha256,
    shared,
    ephPub,
    new TextEncoder().encode(FLAGSHIP_SEAL_TAG),
    32,
  );
  return gcm(key, nonce).decrypt(ct);
}

/**
 * Box-side companion to `sealForEd25519Recipient`: open a blob that was
 * sealed against an Ed25519 pubkey (e.g. a server's STK), using that
 * key's Ed25519 *private* seed. The seed is converted to its X25519
 * (Curve25519) scalar via the standard birational map — libsodium's
 * `crypto_sign_ed25519_sk_to_curve25519` — before opening.
 *
 * This is the move the booting box makes to recover a phone-sealed
 * boot secret or a box-sealed auto-unlock-lease key: the STK never
 * needs a separate encryption keypair; the same identity seed both
 * signs `SecretRequest` and opens `SealedSecretResponse` /
 * `AutoUnlockLeaseV2.sealedKey`. `recipientEd25519Priv` is the 32-byte
 * Ed25519 seed (the `privateKey` half of a `Keypair`).
 */
export function openSealedFromEd25519Recipient(
  blob: Bytes,
  recipientEd25519Priv: Bytes,
): Bytes {
  if (recipientEd25519Priv.length !== 32) {
    throw new Error("recipient Ed25519 priv (seed) must be 32 bytes");
  }
  const x25519Priv = ed25519.utils.toMontgomerySecret(recipientEd25519Priv);
  return openSealed(blob, x25519Priv);
}
