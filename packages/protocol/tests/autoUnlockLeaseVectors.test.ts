// The auto-unlock lease is signed by the owner IRK, never by the admin root:
// the boot worker verifies the body against the IRK from the Authorization
// header (packages/boot-core/src/routes.ts handleDepositLease) and answers 403
// "invalid lease signature" otherwise. The vector fixes both signatures over
// the real canonical bytes so every client pins the same rule; Android's
// AutoUnlockLeaseVectorsTest reads the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ed,
  signAutoUnlockLeaseV2,
  verifyAutoUnlockLeaseV2,
  type AutoUnlockLeaseV2,
} from "../src/index.js";

const V = JSON.parse(
  readFileSync(new URL("../test-vectors/auto-unlock-lease/vectors.json", import.meta.url), "utf8"),
);
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function lease(l: typeof V.lease): AutoUnlockLeaseV2 {
  return {
    serverDomain: l.serverDomain,
    stkPub: unhex(l.stkPubHex),
    leaseId: l.leaseId,
    sealedKey: unhex(l.sealedKeyHex),
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
  };
}

describe("auto-unlock lease vector (IRK signs, admin root is refused)", () => {
  const l = lease(V.lease);
  it("the canonical bytes are the vector's", () => {
    const text = ["flagship/auto-unlock-lease/v2", V.lease.serverDomain, V.lease.stkPubHex, V.lease.leaseId, V.lease.sealedKeyHex, V.lease.issuedAt, V.lease.expiresAt, -1].join("|");
    expect(text).toBe(V.canonical);
    // The TS signer signs exactly these bytes.
    const seed = unhex(V.irkSeedHex);
    expect(ed.verify(unhex(V.irkSignatureHex), new TextEncoder().encode(V.canonical), ed.getPublicKey(seed))).toBe(true);
  });
  it("the IRK signature is the vector's and verifies under the IRK", () => {
    const seed = unhex(V.irkSeedHex);
    const irk = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    expect(hex(irk.publicKey)).toBe(V.irkPubHex);
    expect(hex(signAutoUnlockLeaseV2(l, irk))).toBe(V.irkSignatureHex);
    expect(verifyAutoUnlockLeaseV2(l, unhex(V.irkSignatureHex), unhex(V.irkPubHex))).toBe(true);
  });
  it("a lease signed by the admin root does not verify under the IRK (the worker's 403)", () => {
    expect(V.adminSignatureHex).not.toBe(V.irkSignatureHex);
    expect(verifyAutoUnlockLeaseV2(l, unhex(V.adminSignatureHex), unhex(V.irkPubHex))).toBe(false);
    // ...though it is a genuine signature by the admin root, so the refusal is the key, not the bytes.
    expect(verifyAutoUnlockLeaseV2(l, unhex(V.adminSignatureHex), unhex(V.adminPubHex))).toBe(true);
  });
});
