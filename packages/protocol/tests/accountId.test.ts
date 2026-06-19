import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  deriveBAK,
  generateUMK,
} from "../src/keys.js";

describe("deriveAccountId (AID)", () => {
  const umk = { seed: new Uint8Array(32).fill(9) };

  it("is a valid Ed25519 keypair", () => {
    const aid = deriveAccountId(umk);
    expect(aid.privateKey.length).toBe(32);
    expect(aid.publicKey.length).toBe(32);
    // public key is the genuine ed25519 derivation of the private seed
    expect(aid.publicKey).toEqual(ed.getPublicKey(aid.privateKey));
  });

  it("is deterministic for the same UMK", () => {
    const a = deriveAccountId(umk);
    const b = deriveAccountId(umk);
    expect(a.privateKey).toEqual(b.privateKey);
    expect(a.publicKey).toEqual(b.publicKey);
  });

  it("differs for a different UMK (resets only on a new account)", () => {
    const a = deriveAccountId({ seed: new Uint8Array(32).fill(1) });
    const b = deriveAccountId({ seed: new Uint8Array(32).fill(2) });
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it("is DISTINCT from the IRK derived from the SAME UMK", () => {
    // The whole point: the IRK rotates (versioned info), the AID does not.
    const aid = deriveAccountId(umk);
    const irk = deriveIRK(umk);
    expect(aid.privateKey).not.toEqual(irk.privateKey);
    expect(aid.publicKey).not.toEqual(irk.publicKey);
  });

  it("is DISTINCT from the BAK derived from the same UMK", () => {
    const aid = deriveAccountId(umk);
    const bak = deriveBAK(umk, "srv-A");
    expect(aid.privateKey).not.toEqual(bak.privateKey);
  });

  it("survives an IRK 'rotation' (recovery re-derives the same UMK → same AID)", () => {
    // Recovery preserves the UMK and derives a fresh IRK. Model that by
    // re-deriving both from the same UMK: AID stable, IRK is the same here
    // (real rotation bumps the info version), but the invariant we assert is
    // that the AID is a pure function of the UMK and never of the IRK.
    const before = deriveAccountId(umk).publicKey;
    const after = deriveAccountId({ seed: Uint8Array.from(umk.seed) }).publicKey;
    expect(after).toEqual(before);
  });

  it("signs + verifies (it is the friend's signing identity for redeem)", () => {
    const aid = deriveAccountId(umk);
    const msg = new TextEncoder().encode("hello");
    const sig = ed.sign(msg, aid.privateKey);
    expect(ed.verify(sig, msg, aid.publicKey)).toBe(true);
  });

  it("random UMKs give independent AIDs", () => {
    const a = deriveAccountId(generateUMK());
    const b = deriveAccountId(generateUMK());
    expect(a.publicKey).not.toEqual(b.publicKey);
  });
});

describe("deriveHouseholdKey", () => {
  const umk = { seed: new Uint8Array(32).fill(9) };

  it("is a 32-byte symmetric key", () => {
    expect(deriveHouseholdKey(umk).length).toBe(32);
  });

  it("is deterministic for the same UMK (every device of the account agrees)", () => {
    expect(deriveHouseholdKey(umk)).toEqual(deriveHouseholdKey(umk));
  });

  it("differs per account (UMK)", () => {
    expect(deriveHouseholdKey({ seed: new Uint8Array(32).fill(1) })).not.toEqual(
      deriveHouseholdKey({ seed: new Uint8Array(32).fill(2) }),
    );
  });

  it("is not the AID private key or the IRK private key (role separation)", () => {
    const hh = deriveHouseholdKey(umk);
    expect(hh).not.toEqual(deriveAccountId(umk).privateKey);
    expect(hh).not.toEqual(deriveIRK(umk).privateKey);
  });
});
