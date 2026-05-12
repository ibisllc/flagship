/**
 * Cryptographic primitives — thin wrappers over @noble/ed25519 and
 * @noble/hashes. Synchronous Ed25519 via noble; SHA-256 for the
 * Merkle root of intermediate commits.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha256.js";

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const high = parseHexDigit(hex.charCodeAt(i));
    const low = parseHexDigit(hex.charCodeAt(i + 1));
    if (high === -1 || low === -1) throw new Error("invalid hex character");
    out[i / 2] = (high << 4) | low;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

function parseHexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

export function sign(message: Uint8Array, privKeyHex: string): string {
  const sig = ed25519.sign(message, hexToBytes(privKeyHex));
  return bytesToHex(sig);
}

export function verify(
  signatureHex: string,
  message: Uint8Array,
  pubKeyHex: string,
): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), message, hexToBytes(pubKeyHex));
  } catch {
    return false;
  }
}

export function generateKeypair(seed?: Uint8Array): { privKey: string; pubKey: string } {
  const priv = seed ?? randomBytes(32);
  if (priv.length !== 32) throw new Error("seed must be 32 bytes");
  const pub = ed25519.getPublicKey(priv);
  return { privKey: bytesToHex(priv), pubKey: bytesToHex(pub) };
}

export function pubKeyFromPriv(privKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(privKeyHex)));
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * Compute the canonical Merkle root of an ordered list of intermediate
 * commit hashes. Per spec: SHA-256 over the concatenated 20-byte raw
 * representations.
 */
export function intermediateMerkleRoot(commitHashes: string[]): string {
  const buf = new Uint8Array(commitHashes.length * 20);
  for (let i = 0; i < commitHashes.length; i++) {
    const h = commitHashes[i]!;
    if (h.length !== 40) throw new Error(`commit hash at index ${i} is not 40 hex chars`);
    const bytes = hexToBytes(h);
    if (bytes.length !== 20) throw new Error(`commit hash at index ${i} is not 20 bytes`);
    buf.set(bytes, i * 20);
  }
  return sha256Hex(buf);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(b);
    return b;
  }
  throw new Error("no secure random source available");
}
