import { describe, expect, it } from "vitest";
import {
  ed,
  signServerDecommission,
  verifyServerDecommission,
  type Keypair,
  type ServerDecommission,
} from "../src/index.js";

/**
 * Cross-platform pins for the server-decommission (graceful replacement) order.
 * The exact `|`-joined canonical strings here MUST match the Swift mirror
 * (`apps/mobile/shared/Tests/FlagshipSharedTests/ServerDecommissionCanonicalTests.swift`)
 * and the Kotlin mirror
 * (`apps/mobile/android/app/src/test/java/com/flagshipserver/app/core/ServerDecommissionVectorTest.kt`).
 * Spec: docs/server-replacement-graceful-decommission.md §6.
 */
function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const VECTOR: ServerDecommission = {
  podCanonical: "home.alice.flagship.services",
  retiredStkPubHex: "aa".repeat(32),
  finalBackup: true,
  diskDisposition: "wipe-after-handoff",
  backupEpoch: 7,
  nonce: "deadbeef",
  issuedAt: 1700,
};

const VECTOR_CANONICAL =
  "flagship/server-decommission/v1|home.alice.flagship.services|" +
  "aa".repeat(32) +
  "|1|wipe-after-handoff|7|deadbeef|1700";

describe("server-decommission vector", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const irk = makeKey(7);
    const sig = signServerDecommission(VECTOR, irk);
    const expected = new TextEncoder().encode(VECTOR_CANONICAL);
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
    expect(verifyServerDecommission(VECTOR, sig, irk.publicKey)).toBe(true);
  });

  it("lowercases podCanonical + retiredStk + nonce into the canonical bytes", () => {
    const irk = makeKey(8);
    const upper: ServerDecommission = {
      ...VECTOR,
      podCanonical: "HOME.Alice.Flagship.Services",
      retiredStkPubHex: "AA".repeat(32),
      nonce: "DEADBEEF",
    };
    const sig = signServerDecommission(upper, irk);
    // Verifies against the LOWERCASED canonical → casing is normalized.
    const expected = new TextEncoder().encode(VECTOR_CANONICAL.replace("1700", `${VECTOR.issuedAt}`));
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("finalBackup false encodes as 0", () => {
    const irk = makeKey(9);
    const order: ServerDecommission = { ...VECTOR, finalBackup: false, backupEpoch: 0 };
    const sig = signServerDecommission(order, irk);
    const expected = new TextEncoder().encode(
      "flagship/server-decommission/v1|home.alice.flagship.services|" +
        "aa".repeat(32) +
        "|0|wipe-after-handoff|0|deadbeef|1700",
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("the STK-binding is in the bytes — a different retiredStk ⇒ a different signature", () => {
    const irk = makeKey(10);
    const sigA = signServerDecommission(VECTOR, irk);
    const sigB = signServerDecommission({ ...VECTOR, retiredStkPubHex: "bb".repeat(32) }, irk);
    expect(Buffer.from(sigA).equals(Buffer.from(sigB))).toBe(false);
    // The order for instance A does NOT verify as the order for instance B.
    expect(verifyServerDecommission({ ...VECTOR, retiredStkPubHex: "bb".repeat(32) }, sigA, irk.publicKey)).toBe(false);
  });

  it("verify never throws on a forged/junk signature", () => {
    const irk = makeKey(11);
    expect(verifyServerDecommission(VECTOR, new Uint8Array(64), irk.publicKey)).toBe(false);
    expect(verifyServerDecommission(VECTOR, new Uint8Array(3), irk.publicKey)).toBe(false);
  });
});
