// Strict Ed25519 verification at the `ed` chokepoint (test-vectors/ed25519-strict): a signature ZIP-215's cofactored
// check accepts (a mixed-order R) is refused, and honest signatures still verify, on the sync and the native path.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as noble from "@noble/ed25519";
import { ed, edVerifyFast } from "../src/edSync.js";

const v = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/ed25519-strict/vectors.json"), "utf8")) as {
  publicKeyHex: string;
  messageHex: string;
  honestSignatureHex: string;
  mixedOrderRSignatureHex: string;
};
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("ed25519-strict", () => {
  it("the mixed-order R passes ZIP-215 but not the strict verify", async () => {
    expect(noble.verify(b(v.mixedOrderRSignatureHex), b(v.messageHex), b(v.publicKeyHex), { zip215: true })).toBe(true);
    expect(ed.verify(b(v.mixedOrderRSignatureHex), b(v.messageHex), b(v.publicKeyHex))).toBe(false);
    expect(await ed.verifyAsync(b(v.mixedOrderRSignatureHex), b(v.messageHex), b(v.publicKeyHex))).toBe(false);
    expect(await edVerifyFast(b(v.mixedOrderRSignatureHex), b(v.messageHex), b(v.publicKeyHex))).toBe(false);
  });

  it("the honest signature verifies on every path", async () => {
    expect(ed.verify(b(v.honestSignatureHex), b(v.messageHex), b(v.publicKeyHex))).toBe(true);
    expect(ed.verify(v.honestSignatureHex, v.messageHex, v.publicKeyHex)).toBe(true);
    expect(await edVerifyFast(b(v.honestSignatureHex), b(v.messageHex), b(v.publicKeyHex))).toBe(true);
  });

  it("refuses S >= L and a flipped bit, and accepts fresh honest signatures", () => {
    const sig = b(v.honestSignatureHex);
    const big = new Uint8Array(sig);
    big[63] = big[63]! | 0xf0;
    expect(ed.verify(big, b(v.messageHex), b(v.publicKeyHex))).toBe(false);
    const flipped = new Uint8Array(sig);
    flipped[5] = flipped[5]! ^ 1;
    expect(ed.verify(flipped, b(v.messageHex), b(v.publicKeyHex))).toBe(false);
    for (let i = 0; i < 32; i++) {
      const seed = new Uint8Array(32).fill(i + 1);
      const msg = new TextEncoder().encode(`honest-${i}`);
      expect(ed.verify(noble.sign(msg, seed), msg, noble.getPublicKey(seed))).toBe(true);
    }
  });
});
