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
