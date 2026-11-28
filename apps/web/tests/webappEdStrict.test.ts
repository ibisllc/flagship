// test-vectors/ed25519-strict: the webapp's WebCrypto verify (lib/edKey.js verifyEd25519) is strict (cofactorless,
// canonical R and S): it refuses the mixed-order R that ZIP-215 accepts and verifies the honest signature.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEd25519, verifyEd25519Sync } from "../public/webapp/lib/edKey.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/ed25519-strict/vectors.json"), "utf8")) as {
  publicKeyHex: string;
  messageHex: string;
  honestSignatureHex: string;
  mixedOrderRSignatureHex: string;
};
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("web ed25519-strict", () => {
  it("WebCrypto refuses the mixed-order R and accepts the honest signature", async () => {
    expect(await verifyEd25519(b(v.publicKeyHex), b(v.mixedOrderRSignatureHex), b(v.messageHex))).toBe(false);
    expect(await verifyEd25519(b(v.publicKeyHex), b(v.honestSignatureHex), b(v.messageHex))).toBe(true);
  });

  it("the noble sync path is strict too: honest signature yes, mixed-order R no", () => {
    expect(verifyEd25519Sync(b(v.publicKeyHex), b(v.honestSignatureHex), b(v.messageHex))).toBe(true);
    expect(verifyEd25519Sync(v.publicKeyHex, v.honestSignatureHex, b(v.messageHex))).toBe(true);
    expect(verifyEd25519Sync(b(v.publicKeyHex), b(v.mixedOrderRSignatureHex), b(v.messageHex))).toBe(false);
  });

  it("the sync path refuses S >= L, a non-canonical R and a small-order key", () => {
    const sig = b(v.honestSignatureHex);
    const big = Uint8Array.from(sig);
    big.set(Uint8Array.from(Buffer.from("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010", "hex")), 32);
    expect(verifyEd25519Sync(b(v.publicKeyHex), big, b(v.messageHex))).toBe(false);
    const nonCanonR = Uint8Array.from(sig);
    nonCanonR.set(Uint8Array.from(Buffer.from("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex")), 0);
    expect(verifyEd25519Sync(b(v.publicKeyHex), nonCanonR, b(v.messageHex))).toBe(false);
    expect(verifyEd25519Sync(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)), sig, b(v.messageHex))).toBe(false);
  });
});
