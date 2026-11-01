import { describe, expect, it } from "vitest";
import {
  canonicalRustOwnershipOrder,
  ed,
  parseRustOwnershipOrder,
  signRustOwnershipOrder,
  verifyRustOwnershipOrder,
  type RustOwnershipOrder,
} from "../src/index.js";

const seed = new Uint8Array(32).fill(9);
const pub = ed.getPublicKey(seed);
const order: RustOwnershipOrder = { serverDomain: "Home.Alice.flagship.services", reconciler: "rust", proxy: "ts", nonce: "cd".repeat(16), issuedAt: 1_790_000_000_000 };

describe("flagship/rust-ownership/v1", () => {
  it("has fixed canonical bytes, with the server name lowercased", () => {
    expect(new TextDecoder().decode(canonicalRustOwnershipOrder(order))).toBe(
      `flagship/rust-ownership/v1|home.alice.flagship.services|rust|ts|${"cd".repeat(16)}|1790000000000`,
    );
  });

  it("verifies under the signer only, and not once any field changes", () => {
    const sig = signRustOwnershipOrder(order, (m) => ed.sign(m, seed));
    expect(verifyRustOwnershipOrder(order, sig, pub)).toBe(true);
    expect(verifyRustOwnershipOrder({ ...order, reconciler: "shadow" }, sig, pub)).toBe(false);
    expect(verifyRustOwnershipOrder({ ...order, proxy: "rust" }, sig, pub)).toBe(false);
    expect(verifyRustOwnershipOrder({ ...order, serverDomain: "home2.alice.flagship.services" }, sig, pub)).toBe(false);
    expect(verifyRustOwnershipOrder({ ...order, nonce: "ab".repeat(16) }, sig, pub)).toBe(false);
    expect(verifyRustOwnershipOrder(order, sig, ed.getPublicKey(new Uint8Array(32).fill(8)))).toBe(false);
  });

  it("refuses anything out of shape", () => {
    expect(parseRustOwnershipOrder(order)).toEqual(order);
    for (const bad of [null, "x", { ...order, reconciler: "ts" }, { ...order, proxy: "shadow" }, { ...order, nonce: "CD".repeat(16) }, { ...order, issuedAt: -1 }, { ...order, issuedAt: "1" }, { ...order, serverDomain: "a|b" }]) {
      expect(parseRustOwnershipOrder(bad)).toBeNull();
    }
  });
});
