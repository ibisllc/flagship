/**
 * First contact between a new server and the phone that created it (owner decision 2026-10-24).
 * The server makes its own key; the phone pins that key the first time it blesses the server and
 * verifies everything against it from then on. Two things keep that first moment honest:
 *
 *   - The enrollment proof. The recipe carries a one-time 32-byte secret the creating device keeps
 *     a copy of. The box proves it holds the recipe AND binds its new key to it:
 *
 *       HMAC-SHA256(secret, flagship/enrollment-proof/v1|<serverDomain>|<stkPubHex>|<authCodeSerial>)
 *
 *     `.com` and the relay never see recipes, so they cannot swap in a key of their own. The secret
 *     is worthless after first boot.
 *
 *   - The server code: six digits from the key alone, shown on the box's console (and by Studio)
 *     and on the phone, so a person can tell the box in front of them from one built from a stolen
 *     recipe:  first 4 bytes of SHA-256(flagship/server-code/v1|<stkPubHex>), big-endian, mod 10^6.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ENROLLMENT_PROOF = "flagship/enrollment-proof/v1";
export const TAG_SERVER_CODE = "flagship/server-code/v1";

export interface EnrollmentStatement {
  serverDomain: string;
  stkPubHex: string;
  authCodeSerial: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function canonicalEnrollmentProof(s: EnrollmentStatement): Bytes {
  legacyFieldGuard("serverDomain", s.serverDomain);
  legacyFieldGuard("authCodeSerial", s.authCodeSerial);
  if (!HEX64.test(s.stkPubHex)) throw new Error("stkPubHex must be 64 lowercase hex");
  return new TextEncoder().encode([TAG_ENROLLMENT_PROOF, s.serverDomain.toLowerCase(), s.stkPubHex, s.authCodeSerial].join("|"));
}

/** The box's proof, lowercase hex. `secret` is the recipe's 32-byte enrollment secret. */
export function enrollmentProofHex(secret: Bytes, s: EnrollmentStatement): string {
  if (secret.length !== 32) throw new Error("the enrollment secret is 32 bytes");
  return hex(hmac(sha256, secret, canonicalEnrollmentProof(s)));
}

/** Constant-time check on the creating device's side. Never throws. */
export function verifyEnrollmentProof(secret: Bytes, s: EnrollmentStatement, proofHex: unknown): boolean {
  try {
    const want = enrollmentProofHex(secret, s);
    if (typeof proofHex !== "string" || proofHex.length !== want.length) return false;
    const got = proofHex.toLowerCase();
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/** The six-digit code a person compares, as a string with leading zeros. */
export function serverCode(stkPubHex: string): string {
  if (!HEX64.test(stkPubHex)) throw new Error("stkPubHex must be 64 lowercase hex");
  const d = sha256(new TextEncoder().encode(`${TAG_SERVER_CODE}|${stkPubHex}`));
  const n = ((d[0]! << 24) >>> 0) + (d[1]! << 16) + (d[2]! << 8) + d[3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

export const TAG_SERVER_CODE_SEEN = "flagship/server-code-seen/v1";

/**
 * Studio's word that the VM it hosts showed this key on its console: HMAC-SHA256 under the per-server
 * `studioConfirmKey` the phone handed Studio beside the recipe (never inside it, so a stolen recipe file
 * cannot forge it) over `flagship/server-code-seen/v1|<serverDomain>|<stkPubHex>`. `.com` stores it
 * beside the order's status; only the phone can check it.
 */
export function serverSeenMacHex(studioConfirmKey: Bytes, serverDomain: string, stkPubHex: string): string {
  if (studioConfirmKey.length !== 32) throw new Error("the Studio confirm key is 32 bytes");
  legacyFieldGuard("serverDomain", serverDomain);
  if (!HEX64.test(stkPubHex)) throw new Error("stkPubHex must be 64 lowercase hex");
  return hex(hmac(sha256, studioConfirmKey, new TextEncoder().encode(`${TAG_SERVER_CODE_SEEN}|${serverDomain.toLowerCase()}|${stkPubHex}`)));
}

/** Constant-time check on the phone. Never throws. */
export function verifyServerSeen(studioConfirmKey: Bytes, serverDomain: string, stkPubHex: string, macHex: unknown): boolean {
  try {
    const want = serverSeenMacHex(studioConfirmKey, serverDomain, stkPubHex);
    if (typeof macHex !== "string" || macHex.length !== want.length) return false;
    const got = macHex.toLowerCase();
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
