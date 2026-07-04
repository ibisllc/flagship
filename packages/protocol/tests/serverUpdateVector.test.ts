import { describe, expect, it } from "vitest";
import {
  ed,
  canonicalUpdateOrder,
  signUpdateOrder,
  verifyUpdateOrder,
  type UpdateOrder,
  type Keypair,
} from "../src/index.js";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("server-update order", () => {
  const order: UpdateOrder = {
    serverDomain: SERVER,
    targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
    fromCommit: "1234567890abcdef1234567890abcdef12345678",
    nonce: "00112233445566778899aabbccddeeff",
    issuedAt: 1700,
  };

  it("canonical bytes — tag|serverDomain|targetCommit|fromCommit|nonce|issuedAt", () => {
    const expected = new TextEncoder().encode(
      `flagship/server-update/v1|${SERVER}|${order.targetCommit}|${order.fromCommit}|${order.nonce}|1700`,
    );
    expect(canonicalUpdateOrder(order)).toEqual(expected);
  });

  it("rejects a '|' or control char in any string field", () => {
    expect(() => canonicalUpdateOrder({ ...order, targetCommit: "a|b" })).toThrow();
    expect(() => canonicalUpdateOrder({ ...order, fromCommit: "a\nb" })).toThrow();
    expect(() => canonicalUpdateOrder({ ...order, nonce: "a|b" })).toThrow();
  });

  it("signs + verifies under the admin authority (pinned cross-platform vector)", () => {
    const admin = makeKey(7);
    const sig = signUpdateOrder(order, admin);
    expect(verifyUpdateOrder(order, sig, admin.publicKey)).toBe(true);
    // Pinned vector — the Swift/Kotlin mirrors (a later client pass) assert this
    // exact signature. TS is the source of truth.
    expect(Buffer.from(sig).toString("hex")).toBe(
      "c9c0085c9e50a9d27a8e130045bf302e5ee350f519d07df66fc03e1e7345737de299ba92448b5a05315f1ae9183f42d40eae90e9f6f0f30a78de5e2ea8e1690d",
    );
  });

  it("rejects a tampered order, a wrong key, and the zero key", () => {
    const admin = makeKey(7);
    const sig = signUpdateOrder(order, admin);
    expect(verifyUpdateOrder({ ...order, targetCommit: "deadbeef" }, sig, admin.publicKey)).toBe(false);
    expect(verifyUpdateOrder({ ...order, issuedAt: 1701 }, sig, admin.publicKey)).toBe(false);
    expect(verifyUpdateOrder(order, sig, makeKey(8).publicKey)).toBe(false);
    expect(verifyUpdateOrder(order, sig, new Uint8Array(32))).toBe(false);
  });
});
