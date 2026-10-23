/**
 * Offline secret-bearing recipes (SECURITY-HARDENING-PLAN.md 3.13, SEC-RECIPE-001).
 *
 * The default recipe carries no secret: the workload key reaches the box sealed to its own
 * identity through the control plane. An owner who builds a box with no network path to that
 * lane (Advanced mode) may put the workload key in the recipe file. That key is a sibling of
 * the signed install blob, not part of its bytes, so anything that can edit the file could swap
 * it. This envelope closes that: the owner's account key signs a commitment (the key's hash)
 * bound to this server name and this order serial, and the builder and the box refuse a
 * secret that does not match it. A recipe that carries a secret with no valid envelope is
 * refused, not downgraded.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_OFFLINE_SECRETS = "flagship/offline-secrets/v1";

export interface OfflineSecrets {
  serverDomain: string;
  /** The order serial of the signed install blob this belongs to. */
  serial: string;
  /** SHA-256 of the 32 workload-key bytes, lowercase hex. */
  swkSha256Hex: string;
  issuedAt: number;
}

/** The sibling as it travels in the recipe file. */
export interface OfflineSecretsSibling extends OfflineSecrets {
  signatureHex: string;
}

export function canonicalOfflineSecrets(s: OfflineSecrets): Bytes {
  legacyFieldGuard("serverDomain", s.serverDomain);
  legacyFieldGuard("serial", s.serial);
  if (!/^[0-9a-f]{64}$/.test(s.swkSha256Hex)) throw new Error("swkSha256Hex must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_OFFLINE_SECRETS, s.serverDomain.toLowerCase(), s.serial, s.swkSha256Hex, s.issuedAt].join("|"));
}

export function swkCommitment(swk: Bytes): string {
  return hex(sha256(swk));
}

export function signOfflineSecrets(s: OfflineSecrets, userIrk: Keypair): OfflineSecretsSibling {
  return { ...s, signatureHex: hex(ed.sign(canonicalOfflineSecrets(s), userIrk.privateKey)) };
}

export type OfflineSecretsVerdict = { ok: true } | { ok: false; reason: "missing" | "malformed" | "wrong-server" | "wrong-order" | "wrong-secret" | "bad-signature" | "outside-order-validity" };

/**
 * Does `sibling` authorize `swkHex` for the order described by the signed blob's auth code?
 * `userPub` is the account key the blob names (already verified against the blob's signature).
 */
export function verifyOfflineSecrets(
  sibling: unknown,
  swkHex: string,
  order: { serverDomain: string; serial: string; userPub: Bytes; issuedAt: number; expiresAt: number },
): OfflineSecretsVerdict {
  if (sibling === undefined || sibling === null) return { ok: false, reason: "missing" };
  const s = sibling as Partial<OfflineSecretsSibling>;
  if (
    typeof s.serverDomain !== "string" || typeof s.serial !== "string" || typeof s.swkSha256Hex !== "string" ||
    typeof s.issuedAt !== "number" || typeof s.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(s.signatureHex)
  ) return { ok: false, reason: "malformed" };
  if (!/^[0-9a-f]{64}$/i.test(swkHex)) return { ok: false, reason: "malformed" };
  if (s.serverDomain.toLowerCase() !== order.serverDomain.toLowerCase()) return { ok: false, reason: "wrong-server" };
  if (s.serial !== order.serial) return { ok: false, reason: "wrong-order" };
  const swk = Uint8Array.from(Buffer.from(swkHex.toLowerCase(), "hex"));
  if (swkCommitment(swk) !== s.swkSha256Hex.toLowerCase()) return { ok: false, reason: "wrong-secret" };
  if (s.issuedAt < order.issuedAt - 60_000 || s.issuedAt > order.expiresAt) return { ok: false, reason: "outside-order-validity" };
  let ok = false;
  try {
    ok = ed.verify(Uint8Array.from(Buffer.from(s.signatureHex, "hex")), canonicalOfflineSecrets({ serverDomain: s.serverDomain, serial: s.serial, swkSha256Hex: s.swkSha256Hex.toLowerCase(), issuedAt: s.issuedAt }), order.userPub);
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
}
