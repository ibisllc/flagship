import { describe, expect, it } from "vitest";
import {
  canonicalArchV2SwitchOrder,
  ed,
  parseArchV2SwitchOrder,
  signArchV2SwitchOrder,
  verifyArchV2SwitchOrder,
  type ArchV2SwitchOrder,
} from "../src/index.js";

const seed = new Uint8Array(32).fill(7);
const pub = ed.getPublicKey(seed);
const order: ArchV2SwitchOrder = { serverDomain: "Home.Alice.flagship.services", target: "arch-v2", nonce: "ab".repeat(16), issuedAt: 1_790_000_000_000 };

describe("flagship/arch-v2-switch/v1", () => {
  it("has fixed canonical bytes, with the server name lowercased", () => {
    expect(new TextDecoder().decode(canonicalArchV2SwitchOrder(order))).toBe(
      `flagship/arch-v2-switch/v1|home.alice.flagship.services|arch-v2|${"ab".repeat(16)}|1790000000000`,
    );
  });

  it("verifies under the signer only, and not once any field changes", () => {
    const sig = signArchV2SwitchOrder(order, (m) => ed.sign(m, seed));
    expect(verifyArchV2SwitchOrder(order, sig, pub)).toBe(true);
    expect(verifyArchV2SwitchOrder({ ...order, target: "classic" }, sig, pub)).toBe(false);
    expect(verifyArchV2SwitchOrder({ ...order, serverDomain: "home2.alice.flagship.services" }, sig, pub)).toBe(false);
    expect(verifyArchV2SwitchOrder({ ...order, nonce: "cd".repeat(16) }, sig, pub)).toBe(false);
    expect(verifyArchV2SwitchOrder(order, sig, ed.getPublicKey(new Uint8Array(32).fill(8)))).toBe(false);
  });

  it("refuses anything out of shape", () => {
    expect(parseArchV2SwitchOrder(order)).toEqual(order);
    for (const bad of [
      null,
      "x",
      { ...order, target: "docker" },
      { ...order, nonce: "AB".repeat(16) },
      { ...order, nonce: "ab" },
      { ...order, issuedAt: -1 },
      { ...order, issuedAt: "1" },
      { ...order, serverDomain: "a|b" },
      { serverDomain: order.serverDomain, target: order.target, nonce: order.nonce },
    ]) {
      expect(parseArchV2SwitchOrder(bad)).toBeNull();
    }
    expect(() => canonicalArchV2SwitchOrder({ ...order, target: "x" as never })).toThrow();
  });
});
