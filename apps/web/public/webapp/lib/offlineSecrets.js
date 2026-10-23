// The owner's commitment to a workload key carried in an offline recipe
// (SECURITY-HARDENING-PLAN.md 3.13). Mirrors packages/protocol/src/offlineSecrets.ts; the shared
// vectors are packages/protocol/test-vectors/offline-secrets.
//
// The recipe's `swkHex` is a sibling of the signed blob, so anything that can edit the file could
// swap it. This signs a commitment (the key's SHA-256) bound to the server name and the order
// serial; the builder and the box refuse a key that does not match.

export const TAG_OFFLINE_SECRETS = "flagship/offline-secrets/v1";

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

export async function swkCommitment(swkHex) {
  const digest = await crypto.subtle.digest("SHA-256", bytesOf(swkHex.toLowerCase()));
  return hexOf(new Uint8Array(digest));
}

export function canonicalOfflineSecretsBytes(s) {
  if (!/^[0-9a-f]{64}$/.test(s.swkSha256Hex)) throw new Error("swkSha256Hex must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) throw new Error("bad issuedAt");
  for (const k of ["serverDomain", "serial"]) {
    if (!s[k] || /[|\u0000-\u001f\u007f]/.test(s[k])) throw new Error(`bad ${k}`);
  }
  return new TextEncoder().encode([TAG_OFFLINE_SECRETS, s.serverDomain.toLowerCase(), s.serial, s.swkSha256Hex, s.issuedAt].join("|"));
}

/**
 * Sign the commitment. `signWithIrk(umk, bytes)` is the keystore's account-key signer; the blob's
 * `authCode.userPubKey` is that key, which is what the builder and the box verify against.
 */
export async function signOfflineSecrets({ serverDomain, serial, swkHex, issuedAt, umk }, signWithIrk) {
  const body = { serverDomain: serverDomain.toLowerCase(), serial, swkSha256Hex: await swkCommitment(swkHex), issuedAt };
  const sig = await signWithIrk(umk, canonicalOfflineSecretsBytes(body));
  return { ...body, signatureHex: typeof sig === "string" ? sig : hexOf(sig) };
}
