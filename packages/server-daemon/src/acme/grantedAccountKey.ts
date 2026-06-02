import { openSealedFromEd25519Recipient } from "@flagship/protocol";

/**
 * #28 — seal-to-box: a box that an admin has granted indefinite cert-minting
 * autonomy receives the user's shared ACME ACCOUNT key sealed to its STK
 * (Station/identity key). The admin device produces an `AcmeAccountKeyGrant`
 * whose `sealedAccountKey` is `sealForEd25519Recipient(utf8(pkcs8Pem), stkPub)`
 * — i.e. the account key in PKCS#8 PEM form, sealed to the box's Ed25519 STK.
 * The box opens it with its STK seed; the result is fed straight into the ACME
 * client as `accountKeyPem`, so every box under the user mints certs under ONE
 * Let's Encrypt account.
 *
 * `.com` only ever holds the opaque ciphertext — it never sees the account key
 * (the seal primitive is end-to-end, recipient = the box STK).
 *
 * Throws if the blob doesn't decrypt under this STK (wrong recipient / tamper)
 * or if the plaintext isn't a PEM private key — the caller treats a throw as
 * "no usable grant" and falls back to disk / self-generation.
 */
export function unsealGrantedAccountKeyPem(
  sealedAccountKey: Uint8Array,
  stkSeed: Uint8Array,
): string {
  if (stkSeed.length !== 32) {
    throw new Error("STK seed must be 32 bytes");
  }
  const plain = openSealedFromEd25519Recipient(sealedAccountKey, stkSeed);
  const pem = new TextDecoder().decode(plain);
  // A PKCS#8 (or SEC1) PEM the ACME client (`acme-client`) can load. We only
  // sanity-check the framing here; the ACME client does the real parse.
  if (!/-----BEGIN (EC )?PRIVATE KEY-----/.test(pem) || !pem.includes("-----END")) {
    throw new Error("unsealed ACME account key is not a PEM private key");
  }
  return pem;
}
