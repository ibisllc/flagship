import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIRK } from "@flagship/protocol";

// Dynamic-import the browser-shipping keystore module so the source we serve
// to clients is exactly what the test verifies. The module avoids
// IndexedDB at load time, so it imports clean in Node.
async function loadKeystore() {
  const path = resolve(__dirname, "..", "public", "webapp", "keystore.js");
  return import(pathToFileURL(path).href);
}

describe("webapp keystore — pure crypto interop with @flagship/protocol", () => {
  it("hex helpers roundtrip", async () => {
    const k = await loadKeystore();
    const b = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(k.bytesToHex(b)).toBe("deadbeef");
    expect(Array.from(k.hexToBytes("deadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("HKDF + PKCS8 yield an Ed25519 IRK whose public key matches @noble's deriveIRK", async () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = i;
    const k = await loadKeystore();
    const irk = await k.deriveIrkFromSeed(seed);
    const expected = deriveIRK({ seed });
    expect(Array.from(irk.publicKey)).toEqual(Array.from(expected.publicKey));
  });

  it("BAK derivation matches @noble for a given (seed, serverId) pair", async () => {
    const seed = new Uint8Array(32).fill(7);
    const serverId = "srv-test";
    const k = await loadKeystore();
    const bak = await k.deriveBakFromSeed(seed, serverId);
    const { deriveBAK } = await import("@flagship/protocol");
    const expected = deriveBAK({ seed }, serverId);
    expect(Array.from(bak.publicKey)).toEqual(Array.from(expected.publicKey));
  });

  it("SWK derivation (box, DOTS info) matches @flagship/protocol deriveSWK", async () => {
    const seed = new Uint8Array(32).fill(7);
    const serverId = "srv-test";
    const k = await loadKeystore();
    const swkHex = await k.deriveSwkFromSeed(seed, serverId);
    const { deriveSWK } = await import("@flagship/protocol");
    const expected = Array.from(deriveSWK({ seed }, serverId))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(swkHex).toBe(expected);
  });

  it("SWK derivation reproduces the pinned cross-platform vector", async () => {
    // packages/protocol/tests/keys.test.ts:
    //   umk.seed = 32 × 0x07, serverId = "srv-vector-1"
    const k = await loadKeystore();
    const swkHex = await k.deriveSwkFromSeed(new Uint8Array(32).fill(7), "srv-vector-1");
    expect(swkHex).toBe(
      "55c865a17c9106f0cb6847da659706ed7601e6769253f9b11d851e013b421377",
    );
  });

  it("wrap → unwrap returns the original UMK seed (PBKDF2 + AES-GCM)", async () => {
    const k = await loadKeystore();
    const seed = new Uint8Array(32).fill(0x42);
    const wrapped = await k._internal.wrapUmk("correct-horse-battery-staple", seed);
    const unwrapped = await k._internal.unwrapUmk("correct-horse-battery-staple", wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(seed));
  });

  it("wrong passphrase fails to unwrap (AES-GCM tag check)", async () => {
    const k = await loadKeystore();
    const seed = new Uint8Array(32).fill(0x42);
    const wrapped = await k._internal.wrapUmk("right-pass", seed);
    await expect(k._internal.unwrapUmk("wrong-pass", wrapped)).rejects.toBeDefined();
  });

  it("PBKDF2 iteration count is at least 600k (defense against offline brute force)", async () => {
    const k = await loadKeystore();
    expect(k._internal.PBKDF2_ITERS).toBeGreaterThanOrEqual(600_000);
  });

  it("pkcs8FromSeed produces 48 bytes (16-byte header + 32-byte seed)", async () => {
    const k = await loadKeystore();
    const seed = new Uint8Array(32).fill(1);
    const pkcs8 = k._internal.pkcs8FromSeed(seed);
    expect(pkcs8.length).toBe(48);
    expect(Array.from(pkcs8.slice(0, 16))).toEqual([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x04, 0x22, 0x04, 0x20,
    ]);
  });
});
