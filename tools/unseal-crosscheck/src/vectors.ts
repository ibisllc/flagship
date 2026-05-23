// Shared vector builders for the TS->Go cross-check. These call the REAL
// @flagship/protocol so the bytes the Go binary must decode are produced by the
// exact code path a phone / install path uses — not a re-implementation. The
// Go binary is then run on these bytes and asserted to reproduce the secret.

import {
  buildSealedSecretResponse,
  ed,
  sealForEd25519Recipient,
  type SecretRequest,
  type SecretPurpose,
} from "@flagship/protocol";

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  // Node's Buffer.from(_, "hex") SILENTLY drops a trailing odd nibble and stops
  // at the first non-hex char, which can fabricate a "valid" but wrong-length
  // key — exactly the kind of host/runtime divergence that would bake a broken
  // boot vector. Reject anything Go's encoding/hex would reject so both sides
  // parse identically.
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`not valid even-length hex: ${JSON.stringify(s)}`);
  }
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** A box identity (STK) keypair from a fixed 32-byte Ed25519 seed. */
export function identityFromSeedHex(seedHex: string): {
  privHex: string;
  pub: Uint8Array;
} {
  const priv = fromHex(seedHex);
  if (priv.length !== 32) throw new Error("seed must be 32 bytes");
  return { privHex: seedHex, pub: ed.getPublicKey(priv) };
}

export interface RawSealVector {
  kind: "raw";
  identityPrivHex: string;
  sealedHex: string;
  expectedSecretHex: string;
}

export interface ResponseVector {
  kind: "response";
  identityPrivHex: string;
  sealedHex: string;
  nonceHex: string;
  purpose: SecretPurpose;
  serverDomain: string;
  requestNonceHex: string;
  expectedSecretHex: string;
}

/** Seal a known secret for a box STK via the raw sealForEd25519Recipient path. */
export function makeRawVector(seedHex: string, secret: Uint8Array): RawSealVector {
  const id = identityFromSeedHex(seedHex);
  const sealed = sealForEd25519Recipient(secret, id.pub);
  return {
    kind: "raw",
    identityPrivHex: id.privHex,
    sealedHex: toHex(sealed),
    expectedSecretHex: toHex(secret),
  };
}

/** Build a real SealedSecretResponse for a known secret + request. */
export function makeResponseVector(
  seedHex: string,
  secret: Uint8Array,
  opts: {
    serverDomain: string;
    purpose: SecretPurpose;
    nonce: Uint8Array;
    issuedAt: number;
  },
): ResponseVector {
  const id = identityFromSeedHex(seedHex);
  const request: SecretRequest = {
    serverDomain: opts.serverDomain,
    stkPub: id.pub,
    purpose: opts.purpose,
    nonce: opts.nonce,
    issuedAt: opts.issuedAt,
  };
  const resp = buildSealedSecretResponse(secret, request);
  return {
    kind: "response",
    identityPrivHex: id.privHex,
    sealedHex: toHex(resp.sealed),
    nonceHex: toHex(opts.nonce),
    purpose: opts.purpose,
    serverDomain: resp.serverDomain,
    requestNonceHex: resp.requestNonceHex,
    expectedSecretHex: toHex(secret),
  };
}
