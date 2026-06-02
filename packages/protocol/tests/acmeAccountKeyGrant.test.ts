import { describe, expect, it } from "vitest";
import {
  generateUMK,
  deriveIRK,
  signAcmeAccountKeyGrant,
  verifyAcmeAccountKeyGrant,
  acmeAccountKeyGrantId,
  signRevokeAcmeAccountKey,
  verifyRevokeAcmeAccountKey,
  type AcmeAccountKeyGrant,
  type RevokeAcmeAccountKey,
} from "../src/index.js";

const NOW = 1_780_000_000_000;
const irk = deriveIRK(generateUMK());

function sampleGrant(over: Partial<AcmeAccountKeyGrant> = {}): AcmeAccountKeyGrant {
  const recipient = deriveIRK(generateUMK());
  return {
    grantId: "22222222-2222-4222-8222-222222222222",
    username: "dani",
    accountKeyId: "a".repeat(64), // sha256-hex of the account pubkey
    recipientPubKey: recipient.publicKey,
    sealedAccountKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), // opaque ciphertext
    issuedAt: NOW,
    expiresAt: NOW + 30 * 24 * 3600 * 1000,
    ...over,
  };
}

describe("AcmeAccountKeyGrant", () => {
  it("signs + verifies under the account IRK", () => {
    const g = sampleGrant();
    const sig = signAcmeAccountKeyGrant(g, irk);
    expect(verifyAcmeAccountKeyGrant(g, sig, irk.publicKey)).toBe(true);
    const other = deriveIRK(generateUMK());
    expect(verifyAcmeAccountKeyGrant(g, sig, other.publicKey)).toBe(false);
  });

  it("grantId is a deterministic sha256 of the canonical bytes", async () => {
    const g = sampleGrant();
    expect(await acmeAccountKeyGrantId(g)).toBe(await acmeAccountKeyGrantId(g));
    expect((await acmeAccountKeyGrantId(g)).length).toBe(64);
  });

  it("rejects a tampered sealed key (signature no longer verifies)", () => {
    const g = sampleGrant();
    const sig = signAcmeAccountKeyGrant(g, irk);
    const tampered = { ...g, sealedAccountKey: new Uint8Array([9, 9, 9, 9]) };
    expect(verifyAcmeAccountKeyGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("validates structure (expiry, pubkey length, empty/oversized sealed key, separator)", () => {
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ expiresAt: NOW - 1 }), irk)).toThrow(/expiresAt/);
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ recipientPubKey: new Uint8Array(31) }), irk)).toThrow(/32 bytes/);
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ sealedAccountKey: new Uint8Array(0) }), irk)).toThrow(/sealedAccountKey/);
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ sealedAccountKey: new Uint8Array(5000) }), irk)).toThrow(/sealedAccountKey/);
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ username: "da|ni" }), irk)).toThrow(/separator/);
    expect(() => signAcmeAccountKeyGrant(sampleGrant({ accountKeyId: "" }), irk)).toThrow(/empty/);
  });
});

describe("RevokeAcmeAccountKey", () => {
  function rev(over: Partial<RevokeAcmeAccountKey> = {}): RevokeAcmeAccountKey {
    return { accountKeyId: "a".repeat(64), username: "dani", reason: "demotion", issuedAt: NOW, ...over };
  }

  it("signs + verifies the rotation under the IRK", () => {
    const r = rev();
    const sig = signRevokeAcmeAccountKey(r, irk);
    expect(verifyRevokeAcmeAccountKey(r, sig, irk.publicKey)).toBe(true);
  });

  it("accepts each reason; rejects an unknown one", () => {
    for (const reason of ["demotion", "compromise", "rotation"] as const) {
      const r = rev({ reason });
      expect(verifyRevokeAcmeAccountKey(r, signRevokeAcmeAccountKey(r, irk), irk.publicKey)).toBe(true);
    }
    expect(() => signRevokeAcmeAccountKey(rev({ reason: "whatever" as never }), irk)).toThrow(/unknown reason/);
  });
});
