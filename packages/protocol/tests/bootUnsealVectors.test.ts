// The early-boot unlock wire (test-vectors/boot-unseal, from
// tools/boot-unseal-vectors.mjs) against the protocol code a phone and the
// worker run. The Go helper (tools/unseal-crosscheck) and the Rust
// flagship-boot crate read the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalBootAuth,
  ed,
  openSealedFromEd25519Recipient,
  openSealedSecretResponse,
  signBootAuth,
  signSecretRequest,
  verifySecretRequest,
  type SecretPurpose,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/boot-unseal/vectors.json", import.meta.url), "utf8"));
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function open(c: { kind: string; identityPrivHex: string; sealedHex: string; nonceHex?: string; purpose?: string }): Uint8Array {
  const seed = unhex(c.identityPrivHex);
  const sealed = unhex(c.sealedHex);
  if (c.kind === "raw") return openSealedFromEd25519Recipient(sealed, seed);
  const purpose = c.purpose as SecretPurpose;
  return openSealedSecretResponse(
    { serverDomain: "", requestNonceHex: c.nonceHex!, purpose, sealed, issuedAt: 0 },
    { serverDomain: "", stkPub: new Uint8Array(32), purpose, nonce: unhex(c.nonceHex!), issuedAt: 0 },
    seed,
  );
}

describe("boot-unseal vectors: opening sealed leases and replies", () => {
  for (const c of V.unseal) {
    it(c.name, () => {
      if (c.expect.ok) {
        expect(hex(open(c))).toBe(c.expect.secretHex);
      } else {
        expect(() => open(c)).toThrow();
      }
    });
  }
});

describe("boot-unseal vectors: the box's signed requests", () => {
  const A = V.boxes.A;
  const B = V.boxes.B;
  it("box keys", () => {
    expect(hex(ed.getPublicKey(unhex(A.seedHex)))).toBe(A.pubHex);
    expect(hex(ed.getPublicKey(unhex(B.seedHex)))).toBe(B.pubHex);
  });

  it("SecretRequest canonical bytes, signature and body", () => {
    const r = V.secretRequest;
    const fields = { serverDomain: r.serverDomain, stkPub: unhex(r.stkPubHex), purpose: r.purpose as SecretPurpose, nonce: unhex(r.nonceHex), issuedAt: r.issuedAt };
    expect(hex(signSecretRequest(fields, { privateKey: unhex(A.seedHex), publicKey: unhex(A.pubHex) }))).toBe(r.signatureHex);
    expect(ed.verify(unhex(r.signatureHex), new TextEncoder().encode(r.canonical), unhex(A.pubHex))).toBe(true);
    expect(verifySecretRequest(fields, unhex(r.signatureHex), unhex(A.pubHex))).toBe(true);
    expect(JSON.parse(r.body)).toEqual({ request: { serverDomain: r.serverDomain, stkPub: r.stkPubHex, purpose: r.purpose, nonce: r.nonceHex, issuedAt: r.issuedAt }, signature: r.signatureHex });
  });

  it("a SecretRequest signed by another box does not verify for box A", () => {
    const r = V.secretRequest;
    const fields = { serverDomain: r.serverDomain, stkPub: unhex(r.stkPubHex), purpose: r.purpose as SecretPurpose, nonce: unhex(r.nonceHex), issuedAt: r.issuedAt };
    expect(verifySecretRequest(fields, unhex(r.signatureByBoxBHex), unhex(A.pubHex))).toBe(false);
  });

  for (const name of ["leaseGet", "requestPost", "responsePoll"] as const) {
    it(`box-auth header: ${name}`, () => {
      const h = V.bootAuth[name];
      const args = { role: "box" as const, serverDomain: h.serverDomain, method: h.method, path: h.path, pubKeyHex: h.pubKeyHex, nonceHex: h.nonceHex, issuedAt: h.issuedAt };
      expect(new TextDecoder().decode(canonicalBootAuth(args))).toBe(h.canonical);
      expect(ed.verify(unhex(h.signatureHex), new TextEncoder().encode(h.canonical), unhex(A.pubHex))).toBe(true);
      expect(signBootAuth(args, unhex(A.seedHex))).toBe(h.authorization);
    });
  }
});
