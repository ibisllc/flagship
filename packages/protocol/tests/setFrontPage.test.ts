import { describe, expect, it } from "vitest";
import {
  ed,
  signPhoneOrder,
  verifyPhoneOrder,
  type Keypair,
  type PhoneOrder,
} from "../src/index.js";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("set-front-page PhoneOrder", () => {
  it("canonical bytes — assign a label", () => {
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "photos",
      issuedAt: 1700,
    };
    const psk = makeKey(7);
    const sig = signPhoneOrder(order, psk);
    // Independently recompute the expected canonical bytes — the
    // Swift/Kotlin/webapp mirrors pin this same shape.
    const expected = new TextEncoder().encode(
      `flagship/order/set-front-page/v1|${SERVER}|photos|1700`,
    );
    expect(ed.verify(sig, expected, psk.publicKey)).toBe(true);
  });

  it("canonical bytes — clear (empty label)", () => {
    const order: PhoneOrder = { type: "set-front-page", serverId: SERVER, label: "", issuedAt: 42 };
    const psk = makeKey(9);
    const sig = signPhoneOrder(order, psk);
    const expected = new TextEncoder().encode(
      `flagship/order/set-front-page/v1|${SERVER}||42`,
    );
    expect(ed.verify(sig, expected, psk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips", () => {
    const psk = makeKey(11);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "blog",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder(order, sig, psk.publicKey)).toBe(true);
  });

  it("a tampered label fails the signature", () => {
    const psk = makeKey(13);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "photos",
      issuedAt: 1,
    };
    const sig = signPhoneOrder(order, psk);
    const tampered: PhoneOrder = { ...order, label: "evil" };
    expect(verifyPhoneOrder(tampered, sig, psk.publicKey)).toBe(false);
  });

  it("a pipe in the label is rejected (canonical field guard)", () => {
    const psk = makeKey(15);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "a|b",
      issuedAt: 1,
    };
    expect(() => signPhoneOrder(order, psk)).toThrow();
  });

  it("a captured sig does not verify as a different order variant", () => {
    const psk = makeKey(17);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "photos",
      issuedAt: 5,
    };
    const sig = signPhoneOrder(order, psk);
    const other: PhoneOrder = { type: "shut-down", serverId: SERVER, issuedAt: 5 };
    expect(verifyPhoneOrder(other, sig, psk.publicKey)).toBe(false);
  });

  it("CROSS-PLATFORM PINNED VECTOR — Swift/Kotlin/webapp mirrors assert this same signature", () => {
    const psk = makeKey(7);
    const order: PhoneOrder = {
      type: "set-front-page",
      serverId: SERVER,
      label: "photos",
      issuedAt: 1700,
    };
    const sig = signPhoneOrder(order, psk);
    const hex = Array.from(sig)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(
      "bc57770c09c3f54d9acdb628bd4767142ea035d944c88e7de340c10df84a67b9aa62800fdb597624a3f49ccec222d2c4" +
        "6ff64eadaa80111964946240a2fc9405",
    );
  });
});
