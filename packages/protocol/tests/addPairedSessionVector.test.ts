import { describe, expect, it } from "vitest";
import {
  ed,
  signPhoneOrder,
  verifyPhoneOrder,
  type Keypair,
  type PhoneOrder,
} from "../src/index.js";

/**
 * Cross-platform pin for the `add-paired-session` PhoneOrder canonical bytes.
 * The phone (iOS `AddPairedSessionOrder`, webapp `lib/podPair.js`) signs this
 * exact shape and the box's `/api/orders-from-user` re-derives it to verify, so
 * the byte vector must match the Swift pin in
 * `apps/mobile/ios/Tests/FlagshipMobileTests/AddPairedSessionCanonicalTests.swift`
 * and the webapp's `canonicalAddPairedSession`.
 */
const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("add-paired-session PhoneOrder vector", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const order: PhoneOrder = {
      type: "add-paired-session",
      serverId: SERVER,
      token: "deadbeef",
      label: "Harry's iPhone",
      issuedAt: 1700,
    };
    const psk = makeKey(9);
    const sig = signPhoneOrder(order, psk);
    const expected = new TextEncoder().encode(
      `flagship/order/add-paired-session/v1|${SERVER}|deadbeef|Harry's iPhone|1700`,
    );
    expect(ed.verify(sig, expected, psk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips", () => {
    const psk = makeKey(11);
    const order: PhoneOrder = {
      type: "add-paired-session",
      serverId: SERVER,
      token: "abc123",
      label: "iPhone",
      issuedAt: 42,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder(order, sig, psk.publicKey)).toBe(true);
  });

  it("a renamed label fails the signature (label is committed)", () => {
    const psk = makeKey(13);
    const order: PhoneOrder = {
      type: "add-paired-session",
      serverId: SERVER,
      token: "t",
      label: "iPhone",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    const renamed: PhoneOrder = { ...order, label: "iPad" };
    expect(verifyPhoneOrder(renamed, sig, psk.publicKey)).toBe(false);
  });

  it("a captured add-paired-session sig does not verify as remove-paired-session", () => {
    const psk = makeKey(15);
    const add: PhoneOrder = {
      type: "add-paired-session",
      serverId: SERVER,
      token: "t",
      label: "iPhone",
      issuedAt: 5,
    };
    const sig = signPhoneOrder(add, psk);
    const remove: PhoneOrder = {
      type: "remove-paired-session",
      serverId: SERVER,
      token: "t",
      issuedAt: 5,
    };
    expect(verifyPhoneOrder(remove, sig, psk.publicKey)).toBe(false);
  });
});
