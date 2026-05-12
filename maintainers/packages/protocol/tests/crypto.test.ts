import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  hexToBytes,
  bytesToHex,
  sign,
  verify,
  pubKeyFromPriv,
  intermediateMerkleRoot,
  sha256Hex,
} from "../src/crypto.js";

describe("crypto helpers", () => {
  it("roundtrips hex/bytes", () => {
    const original = "deadbeef00ff80";
    const bytes = hexToBytes(original);
    expect(bytesToHex(bytes)).toBe(original);
  });

  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("dea")).toThrow();
  });

  it("rejects invalid characters in hex", () => {
    expect(() => hexToBytes("zz")).toThrow();
  });

  it("generates a keypair with deterministic seed", () => {
    const seed = new Uint8Array(32);
    seed[0] = 1;
    const a = generateKeypair(seed);
    const b = generateKeypair(seed);
    expect(a.privKey).toBe(b.privKey);
    expect(a.pubKey).toBe(b.pubKey);
  });

  it("signs and verifies", () => {
    const seed = new Uint8Array(32);
    seed[0] = 7;
    const { privKey, pubKey } = generateKeypair(seed);
    const msg = new TextEncoder().encode("hello maintainers");
    const sig = sign(msg, privKey);
    expect(verify(sig, msg, pubKey)).toBe(true);
  });

  it("rejects signature with wrong key", () => {
    const seedA = new Uint8Array(32);
    seedA[0] = 1;
    const seedB = new Uint8Array(32);
    seedB[0] = 2;
    const a = generateKeypair(seedA);
    const b = generateKeypair(seedB);
    const msg = new TextEncoder().encode("hi");
    const sig = sign(msg, a.privKey);
    expect(verify(sig, msg, b.pubKey)).toBe(false);
  });

  it("rejects signature on tampered message", () => {
    const seed = new Uint8Array(32);
    seed[0] = 3;
    const { privKey, pubKey } = generateKeypair(seed);
    const msg = new TextEncoder().encode("original");
    const sig = sign(msg, privKey);
    const tampered = new TextEncoder().encode("tampered");
    expect(verify(sig, tampered, pubKey)).toBe(false);
  });

  it("pubKeyFromPriv matches generateKeypair pubKey", () => {
    const seed = new Uint8Array(32);
    seed[0] = 5;
    const { privKey, pubKey } = generateKeypair(seed);
    expect(pubKeyFromPriv(privKey)).toBe(pubKey);
  });

  it("sha256Hex is deterministic and 64 chars", () => {
    const a = sha256Hex(new Uint8Array([1, 2, 3]));
    const b = sha256Hex(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });

  it("intermediateMerkleRoot is empty SHA-256 for empty list", () => {
    const root = intermediateMerkleRoot([]);
    // SHA-256 of empty bytes
    expect(root).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("intermediateMerkleRoot is deterministic and depends on order", () => {
    const h1 = "0".repeat(40);
    const h2 = "1" + "0".repeat(39);
    const ab = intermediateMerkleRoot([h1, h2]);
    const ba = intermediateMerkleRoot([h2, h1]);
    expect(ab).not.toBe(ba);
  });

  it("intermediateMerkleRoot rejects malformed hash", () => {
    expect(() => intermediateMerkleRoot(["not-40-hex"])).toThrow();
  });
});
