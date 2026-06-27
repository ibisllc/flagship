/**
 * Phone↔burner pairing crypto — the burner (initiator) side, in TS.
 *
 * This is the cross-platform mirror of apps/burner-mac BurnerPairing.swift
 * (Swift) + apps/mobile/android core/BurnerPairing.kt (Kotlin). It lets a
 * Node burner (packages/flagship-burner `pair`) run the SAME pairing the
 * macOS Swift burner does, so a Linux / Chromebook box can pair with the
 * phone and receive the recipe.
 *
 * Crypto is byte-compatible with the QR-relay stack: X25519 → HKDF-SHA256
 * with salt `flagship/qr/v1`, info `flagship/qr/sas/v1` (SAS) and
 * `flagship/qr/enc/v1` (AES-256-GCM key). The short-code → session-id
 * mapping uses `flagship/burner-sid/v1`. All pinned by burnerPairing.test.ts
 * (and apps/com/test/burnerPairingVector.test.ts).
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import type { Bytes } from "./types.js";

const enc = (s: string) => new TextEncoder().encode(s);
const RELAY_SALT = enc("flagship/qr/v1");
const ENC_INFO = enc("flagship/qr/enc/v1");
const SAS_INFO = enc("flagship/qr/sas/v1");
const SID_TAG = enc("flagship/burner-sid/v1");
const CODE_BYTE_COUNT = 5;

// ── base64url (no padding) ──────────────────────────────────────────────
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64UrlEncode(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64_ALPHABET[b2 & 63];
  }
  return out;
}
export function base64UrlDecode(s: string): Bytes | null {
  const lookup = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i++) lookup.set(B64_ALPHABET[i]!, i);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const v = lookup.get(ch);
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ── base32 RFC 4648 (uppercase A–Z2–7, no padding) ──────────────────────
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes: Bytes): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}
export function base32Decode(s: string): Bytes | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B32_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ── session identity ────────────────────────────────────────────────────
export function newCodeBytes(): Bytes {
  const b = new Uint8Array(CODE_BYTE_COUNT);
  crypto.getRandomValues(b);
  return b;
}

export function sessionId(codeBytes: Bytes): string {
  const input = new Uint8Array(SID_TAG.length + codeBytes.length);
  input.set(SID_TAG, 0);
  input.set(codeBytes, SID_TAG.length);
  return base64UrlEncode(sha256(input)).slice(0, 32);
}

export function humanCode(codeBytes: Bytes): string {
  return base32Encode(codeBytes);
}

export function formatHumanCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function codeBytesFromHuman(raw: string): Bytes | null {
  const cleaned = raw.toUpperCase().replace(/[ -]/g, "");
  const bytes = base32Decode(cleaned);
  return bytes && bytes.length === CODE_BYTE_COUNT ? bytes : null;
}

export function qrPayload(human: string, burnerPub: Bytes): string {
  return `flagship://burner?c=${human}&k=${base64UrlEncode(burnerPub)}`;
}

// ── handshake ───────────────────────────────────────────────────────────
export interface BurnerKeypair {
  secretKey: Bytes;
  publicKey: Bytes;
}
export function newBurnerKeypair(): BurnerKeypair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export interface SessionMaterial {
  sasCode: string; // 6 digits, zero-padded
  aeadKey: Bytes; // 32-byte AES-256-GCM key
}
export function deriveSessionMaterial(burnerSecret: Bytes, phonePublicKey: Bytes): SessionMaterial {
  const shared = x25519.getSharedSecret(burnerSecret, phonePublicKey);
  const aeadKey = hkdf(sha256, shared, RELAY_SALT, ENC_INFO, 32);
  const sas4 = hkdf(sha256, shared, RELAY_SALT, SAS_INFO, 4);
  const u32 =
    ((sas4[0]! << 24) | (sas4[1]! << 16) | (sas4[2]! << 8) | sas4[3]!) >>> 0;
  return { sasCode: String(u32 % 1_000_000).padStart(6, "0"), aeadKey };
}

export function formatSas(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Open a phone-delivered payload: ciphertext (ct||tag) + a 12-byte nonce,
 *  both base64url (matching the phone's seal). Throws on a bad tag. */
export function openDelivered(ciphertextB64u: string, nonceB64u: string, aeadKey: Bytes): Bytes {
  const ct = base64UrlDecode(ciphertextB64u);
  const nonce = base64UrlDecode(nonceB64u);
  if (!ct || !nonce || nonce.length !== 12) throw new Error("malformed delivery");
  return gcm(aeadKey, nonce).decrypt(ct);
}

/** Seal a payload as the phone would (for tests / a phone simulator). */
export function sealDelivered(plaintext: Bytes, aeadKey: Bytes): { ciphertextB64u: string; nonceB64u: string } {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = gcm(aeadKey, nonce).encrypt(plaintext);
  return { ciphertextB64u: base64UrlEncode(ct), nonceB64u: base64UrlEncode(nonce) };
}
