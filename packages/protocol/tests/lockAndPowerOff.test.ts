import { describe, expect, it } from "vitest";
import {
  ed,
  signPhoneOrder,
  verifyPhoneOrder,
  signSetDeadManPolicy,
  verifySetDeadManPolicy,
  signDeadManAffirmation,
  verifyDeadManAffirmation,
  type Keypair,
  type PhoneOrder,
  type SetDeadManPolicy,
  type DeadManAffirmation,
} from "../src/index.js";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("power-off PhoneOrder", () => {
  it("canonical bytes — off mode", () => {
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "off", issuedAt: 1700 };
    const psk = makeKey(7);
    const sig = signPhoneOrder(order, psk);
    // Independently recompute the expected canonical bytes.
    const expected = new TextEncoder().encode(
      `flagship/order/power-off/v1|${SERVER}|off|1700`,
    );
    expect(ed.verify(sig, expected, psk.publicKey)).toBe(true);
  });

  it("canonical bytes — restart mode", () => {
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "restart", issuedAt: 42 };
    const psk = makeKey(9);
    const sig = signPhoneOrder(order, psk);
    const expected = new TextEncoder().encode(
      `flagship/order/power-off/v1|${SERVER}|restart|42`,
    );
    expect(ed.verify(sig, expected, psk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips both modes", () => {
    const psk = makeKey(11);
    for (const mode of ["off", "restart"] as const) {
      const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode, issuedAt: 1 };
      const sig = signPhoneOrder(order, psk);
      expect(verifyPhoneOrder(order, sig, psk.publicKey)).toBe(true);
    }
  });

  it("a tampered mode fails the signature", () => {
    const psk = makeKey(13);
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "off", issuedAt: 1 };
    const sig = signPhoneOrder(order, psk);
    const tampered: PhoneOrder = { ...order, mode: "restart" };
    expect(verifyPhoneOrder(tampered, sig, psk.publicKey)).toBe(false);
  });

  it("a captured power-off sig does not verify as a different order variant", () => {
    const psk = makeKey(15);
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "off", issuedAt: 5 };
    const sig = signPhoneOrder(order, psk);
    const shutDown: PhoneOrder = { type: "shut-down", serverId: SERVER, issuedAt: 5 };
    expect(verifyPhoneOrder(shutDown, sig, psk.publicKey)).toBe(false);
  });

  it("a wrong key fails", () => {
    const psk = makeKey(17);
    const other = makeKey(18);
    const order: PhoneOrder = { type: "power-off", serverId: SERVER, mode: "restart", issuedAt: 9 };
    const sig = signPhoneOrder(order, psk);
    expect(verifyPhoneOrder(order, sig, other.publicKey)).toBe(false);
  });
});

describe("SetDeadManPolicy", () => {
  const policy: SetDeadManPolicy = {
    serverId: SERVER,
    enabled: true,
    windowMs: 24 * 3600_000,
    graceMs: 6 * 3600_000,
    lockoutMode: "off",
    issuedAt: 1000,
  };

  it("canonical bytes", () => {
    const irk = makeKey(20);
    const sig = signSetDeadManPolicy(policy, irk);
    const expected = new TextEncoder().encode(
      `flagship/set-deadman-policy/v1|${SERVER}|1|${24 * 3600_000}|${6 * 3600_000}|off|1000`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("round-trips and honors enabled flag + lockoutMode in the bytes", () => {
    const irk = makeKey(21);
    const sig = signSetDeadManPolicy(policy, irk);
    expect(verifySetDeadManPolicy(policy, sig, irk.publicKey)).toBe(true);
    // Flip enabled → signature must no longer verify (it's in the bytes).
    expect(verifySetDeadManPolicy({ ...policy, enabled: false }, sig, irk.publicKey)).toBe(false);
    // Flip lockoutMode → fails too.
    expect(verifySetDeadManPolicy({ ...policy, lockoutMode: "restart" }, sig, irk.publicKey)).toBe(false);
  });

  it("a wrong key fails", () => {
    const irk = makeKey(22);
    const other = makeKey(23);
    const sig = signSetDeadManPolicy(policy, irk);
    expect(verifySetDeadManPolicy(policy, sig, other.publicKey)).toBe(false);
  });
});

describe("DeadManAffirmation", () => {
  const affirm: DeadManAffirmation = {
    serverId: SERVER,
    nonce: new Uint8Array(16).fill(0xab),
    issuedAt: 2000,
  };

  it("canonical bytes", () => {
    const irk = makeKey(30);
    const sig = signDeadManAffirmation(affirm, irk);
    const nonceHex = "ab".repeat(16);
    const expected = new TextEncoder().encode(
      `flagship/deadman-affirm/v1|${SERVER}|${nonceHex}|2000`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("round-trips", () => {
    const irk = makeKey(31);
    const sig = signDeadManAffirmation(affirm, irk);
    expect(verifyDeadManAffirmation(affirm, sig, irk.publicKey)).toBe(true);
  });

  it("a tampered nonce fails the signature (replay-with-different-nonce defense)", () => {
    const irk = makeKey(32);
    const sig = signDeadManAffirmation(affirm, irk);
    const tampered: DeadManAffirmation = { ...affirm, nonce: new Uint8Array(16).fill(0xcd) };
    expect(verifyDeadManAffirmation(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("a wrong key fails", () => {
    const irk = makeKey(33);
    const other = makeKey(34);
    const sig = signDeadManAffirmation(affirm, irk);
    expect(verifyDeadManAffirmation(affirm, sig, other.publicKey)).toBe(false);
  });
});
