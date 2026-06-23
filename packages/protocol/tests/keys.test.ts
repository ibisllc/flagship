import { describe, expect, it } from "vitest";
import {
  deriveServiceMemberStableId,
  deriveServiceSecret,
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

  // Cross-platform PINNED vector. The phone (iOS/Android) derives the SWK from
  // the recovered UMK + serverId and embeds it in the install-blob recipe; the
  // daemon re-derives nothing (it consumes the embedded value), but the phone
  // MUST produce a byte-identical SWK across platforms or the wrong key lands on
  // the box. The Swift/Kotlin deriveSWK twins assert this exact (seed, serverId)
  // → hex so they can never drift from this TS reference.
  //   umk.seed = 32 × 0x07, serverId = "srv-vector-1"
  //   SWK = HKDF-SHA256(seed, info="flagship.swk.v1|srv-vector-1", 32)
  it("deriveSWK pinned cross-platform vector", () => {
    const hex = Array.from(deriveSWK(fixed, "srv-vector-1"))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(
      "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377",
    );
  });
});

describe("per-app stable identity", () => {
  const fixed = { seed: new Uint8Array(32).fill(7) };
  const swk = deriveSWK(fixed, "srv-A");
  const accepter1 = deriveIRK({ seed: new Uint8Array(32).fill(55) }).publicKey;
  const accepter2 = deriveIRK({ seed: new Uint8Array(32).fill(66) }).publicKey;

  it("deriveServiceSecret is deterministic for (swk, appId)", () => {
    expect(deriveServiceSecret(swk, "habit-tracker")).toEqual(deriveServiceSecret(swk, "habit-tracker"));
  });

  it("deriveServiceSecret differs by appId", () => {
    expect(deriveServiceSecret(swk, "habit-tracker")).not.toEqual(deriveServiceSecret(swk, "photos"));
  });

  it("stable id is deterministic for (appSecret, irkPub)", () => {
    const sec = deriveServiceSecret(swk, "habit-tracker");
    expect(deriveServiceMemberStableId(sec, accepter1)).toEqual(deriveServiceMemberStableId(sec, accepter1));
  });

  it("same person across two apps gets DIFFERENT stable IDs (privacy)", () => {
    const secA = deriveServiceSecret(swk, "habit-tracker");
    const secB = deriveServiceSecret(swk, "photos");
    const idA = deriveServiceMemberStableId(secA, accepter1);
    const idB = deriveServiceMemberStableId(secB, accepter1);
    expect(idA).not.toEqual(idB);
  });

  it("two different people in the same app get different stable IDs", () => {
    const sec = deriveServiceSecret(swk, "habit-tracker");
    expect(deriveServiceMemberStableId(sec, accepter1)).not.toEqual(
      deriveServiceMemberStableId(sec, accepter2),
    );
  });

  it("stable id is 32 hex chars (16 bytes), short enough for headers and URLs", () => {
    const sec = deriveServiceSecret(swk, "habit-tracker");
    const id = deriveServiceMemberStableId(sec, accepter1);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
