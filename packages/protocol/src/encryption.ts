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
