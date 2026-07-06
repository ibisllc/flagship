import { describe, expect, it } from "vitest";
import {
  ed,
  isMigrationDisposition,
  signServerMigrationAck,
  signServerMigrationAttach,
  signServerMigrationControl,
  signServerMigrationOrder,
  verifyServerMigrationAck,
  verifyServerMigrationAttach,
  verifyServerMigrationControl,
  verifyServerMigrationOrder,
  type Keypair,
  type ServerMigrationAck,
  type ServerMigrationAttach,
  type ServerMigrationControl,
  type ServerMigrationOrder,
} from "../src/index.js";

/**
 * Cross-platform pins for the server-migration envelopes
 * (docs/server-migration.md). The exact `|`-joined canonical strings here are
 * the contract any future Swift/Kotlin mirror must reproduce byte-for-byte.
 * Seed convention matches the other vector suites (32×0x07 etc.).
 */
function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const ORDER: ServerMigrationOrder = {
  serverDomain: "home.alice.flagship.services",
  oldStkPubHex: "aa".repeat(32),
  diskDisposition: "wipe-after-handoff",
  nonce: "deadbeef",
  issuedAt: 1700,
};
const ORDER_CANONICAL =
  "flagship/server-migration/v1|home.alice.flagship.services|" +
  "aa".repeat(32) +
  "|wipe-after-handoff|deadbeef|1700";

const CONTROL: ServerMigrationControl = {
  serverDomain: "home.alice.flagship.services",
  action: "abort",
  nonce: "0badcafe",
  issuedAt: 1800,
};
const CONTROL_CANONICAL =
  "flagship/server-migration-control/v1|home.alice.flagship.services|abort|0badcafe|1800";

const ATTACH: ServerMigrationAttach = {
  serverDomain: "home.alice.flagship.services",
  newServerDomain: "attic.alice.flagship.services",
  newStkPubHex: "bb".repeat(32),
  issuedAt: 1900,
};
const ATTACH_CANONICAL =
  "flagship/server-migration-attach/v1|home.alice.flagship.services|" +
  "attic.alice.flagship.services|" +
  "bb".repeat(32) +
  "|1900";

const ACK: ServerMigrationAck = {
  serverDomain: "home.alice.flagship.services",
  stkPubHex: "bb".repeat(32),
  phase: "take-over",
  issuedAt: 2000,
};
const ACK_CANONICAL =
  "flagship/server-migration-ack/v1|home.alice.flagship.services|" +
  "bb".repeat(32) +
  "|take-over|2000";

describe("server-migration order vector", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const admin = makeKey(7);
    const sig = signServerMigrationOrder(ORDER, admin);
    const expected = new TextEncoder().encode(ORDER_CANONICAL);
    expect(ed.verify(sig, expected, admin.publicKey)).toBe(true);
    expect(verifyServerMigrationOrder(ORDER, sig, admin.publicKey)).toBe(true);
  });

  it("lowercases serverDomain + oldStk + nonce into the canonical bytes", () => {
    const admin = makeKey(8);
    const upper: ServerMigrationOrder = {
      ...ORDER,
      serverDomain: "HOME.Alice.Flagship.Services",
      oldStkPubHex: "AA".repeat(32),
      nonce: "DEADBEEF",
    };
    const sig = signServerMigrationOrder(upper, admin);
    expect(ed.verify(sig, new TextEncoder().encode(ORDER_CANONICAL), admin.publicKey)).toBe(true);
  });

  it("the old-STK binding is in the bytes — a different oldStk ⇒ a different signature", () => {
    const admin = makeKey(9);
    const sigA = signServerMigrationOrder(ORDER, admin);
    const other = { ...ORDER, oldStkPubHex: "cc".repeat(32) };
    expect(verifyServerMigrationOrder(other, sigA, admin.publicKey)).toBe(false);
  });

  it("verify never throws on a forged/junk signature", () => {
    const admin = makeKey(10);
    expect(verifyServerMigrationOrder(ORDER, new Uint8Array(64), admin.publicKey)).toBe(false);
    expect(verifyServerMigrationOrder(ORDER, new Uint8Array(3), admin.publicKey)).toBe(false);
  });

  it("a '|' in a field is rejected at sign time (field guard)", () => {
    const admin = makeKey(11);
    expect(() =>
      signServerMigrationOrder({ ...ORDER, serverDomain: "a|b" }, admin),
    ).toThrow(/separator/);
  });

  it("isMigrationDisposition excludes wipe-now (invariant 1)", () => {
    expect(isMigrationDisposition("keep")).toBe(true);
    expect(isMigrationDisposition("wipe-after-handoff")).toBe(true);
    expect(isMigrationDisposition("wipe-now")).toBe(false);
    expect(isMigrationDisposition(undefined)).toBe(false);
  });
});

describe("server-migration control vector", () => {
  it("canonical bytes match the pinned string", () => {
    const admin = makeKey(7);
    const sig = signServerMigrationControl(CONTROL, admin);
    expect(ed.verify(sig, new TextEncoder().encode(CONTROL_CANONICAL), admin.publicKey)).toBe(true);
    expect(verifyServerMigrationControl(CONTROL, sig, admin.publicKey)).toBe(true);
  });

  it("the action is in the bytes — confirm-ready ≠ abort", () => {
    const admin = makeKey(7);
    const sig = signServerMigrationControl(CONTROL, admin);
    expect(
      verifyServerMigrationControl({ ...CONTROL, action: "confirm-ready" }, sig, admin.publicKey),
    ).toBe(false);
  });
});

describe("server-migration attach vector", () => {
  it("canonical bytes match the pinned string; signed by the new box STK", () => {
    const stk = makeKey(7);
    const sig = signServerMigrationAttach(ATTACH, stk);
    expect(ed.verify(sig, new TextEncoder().encode(ATTACH_CANONICAL), stk.publicKey)).toBe(true);
    expect(verifyServerMigrationAttach(ATTACH, sig, stk.publicKey)).toBe(true);
  });

  it("a different signer key does not verify", () => {
    const stk = makeKey(7);
    const sig = signServerMigrationAttach(ATTACH, stk);
    expect(verifyServerMigrationAttach(ATTACH, sig, makeKey(8).publicKey)).toBe(false);
  });
});

describe("server-migration ack vector", () => {
  it("canonical bytes match the pinned string", () => {
    const stk = makeKey(7);
    const sig = signServerMigrationAck(ACK, stk);
    expect(ed.verify(sig, new TextEncoder().encode(ACK_CANONICAL), stk.publicKey)).toBe(true);
    expect(verifyServerMigrationAck(ACK, sig, stk.publicKey)).toBe(true);
  });

  it("the phase is in the bytes — a pre-seeded ack can never replay as take-over", () => {
    const stk = makeKey(7);
    const preSeeded: ServerMigrationAck = { ...ACK, phase: "pre-seeded" };
    const sig = signServerMigrationAck(preSeeded, stk);
    expect(verifyServerMigrationAck(ACK, sig, stk.publicKey)).toBe(false);
  });
});
