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

  it("the noble sync path verifies the honest signature", () => {
    expect(verifyEd25519Sync(b(v.publicKeyHex), b(v.honestSignatureHex), b(v.messageHex))).toBe(true);
  });
});
