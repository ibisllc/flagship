import { describe, expect, it } from "vitest";
import {
  deriveAppMemberStableId,
  deriveAppSecret,
  deriveBAK,
  deriveIRK,
  deriveSWK,
  generateUMK,
} from "../src/keys.js";

describe("UMK", () => {
  it("is 32 bytes", () => {
    const umk = generateUMK();
    expect(umk.seed.length).toBe(32);
  });

  it("rejects non-32-byte seeds from custom rng", () => {
    expect(() => generateUMK(() => new Uint8Array(16))).toThrow();
  });
});

describe("derived keys", () => {
  const fixed = { seed: new Uint8Array(32).fill(7) };

  it("BAK and IRK are valid Ed25519 keypairs", () => {
    const bak = deriveBAK(fixed, "srv-1");
    const irk = deriveIRK(fixed);
    expect(bak.privateKey.length).toBe(32);
    expect(bak.publicKey.length).toBe(32);
    expect(irk.privateKey.length).toBe(32);
    expect(irk.publicKey.length).toBe(32);
  });

  it("derivation is deterministic", () => {
    const a = deriveBAK(fixed, "srv-A");
    const b = deriveBAK(fixed, "srv-A");
    expect(a.privateKey).toEqual(b.privateKey);
    expect(a.publicKey).toEqual(b.publicKey);
  });

  it("BAK differs per server (server-scoped compartmentalization)", () => {
    const a = deriveBAK(fixed, "srv-A");
    const b = deriveBAK(fixed, "srv-B");
    expect(a.privateKey).not.toEqual(b.privateKey);
  });

  it("BAK and IRK are different keys for the same server (role compartmentalization)", () => {
    const bak = deriveBAK(fixed, "srv-A");
    const irk = deriveIRK(fixed);
    expect(bak.privateKey).not.toEqual(irk.privateKey);
  });

  it("SWK is 32 bytes (AES-256 key length)", () => {
    expect(deriveSWK(fixed, "srv-A").length).toBe(32);
  });

  it("SWK differs per server", () => {
    expect(deriveSWK(fixed, "srv-A")).not.toEqual(deriveSWK(fixed, "srv-B"));
  });

  it("SWK and BAK private key are different (cannot mix usages)", () => {
    const swk = deriveSWK(fixed, "srv-A");
    const bak = deriveBAK(fixed, "srv-A");
    expect(swk).not.toEqual(bak.privateKey);
  });
});

describe("per-app stable identity", () => {
  const fixed = { seed: new Uint8Array(32).fill(7) };
  const swk = deriveSWK(fixed, "srv-A");
  const accepter1 = deriveIRK({ seed: new Uint8Array(32).fill(55) }).publicKey;
  const accepter2 = deriveIRK({ seed: new Uint8Array(32).fill(66) }).publicKey;

  it("deriveAppSecret is deterministic for (swk, appId)", () => {
    expect(deriveAppSecret(swk, "habit-tracker")).toEqual(deriveAppSecret(swk, "habit-tracker"));
  });

  it("deriveAppSecret differs by appId", () => {
    expect(deriveAppSecret(swk, "habit-tracker")).not.toEqual(deriveAppSecret(swk, "photos"));
  });

  it("stable id is deterministic for (appSecret, irkPub)", () => {
    const sec = deriveAppSecret(swk, "habit-tracker");
    expect(deriveAppMemberStableId(sec, accepter1)).toEqual(deriveAppMemberStableId(sec, accepter1));
  });

  it("same person across two apps gets DIFFERENT stable IDs (privacy)", () => {
    const secA = deriveAppSecret(swk, "habit-tracker");
    const secB = deriveAppSecret(swk, "photos");
    const idA = deriveAppMemberStableId(secA, accepter1);
    const idB = deriveAppMemberStableId(secB, accepter1);
    expect(idA).not.toEqual(idB);
  });

  it("two different people in the same app get different stable IDs", () => {
    const sec = deriveAppSecret(swk, "habit-tracker");
    expect(deriveAppMemberStableId(sec, accepter1)).not.toEqual(
      deriveAppMemberStableId(sec, accepter2),
    );
  });

  it("stable id is 32 hex chars (16 bytes), short enough for headers and URLs", () => {
    const sec = deriveAppSecret(swk, "habit-tracker");
    const id = deriveAppMemberStableId(sec, accepter1);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
