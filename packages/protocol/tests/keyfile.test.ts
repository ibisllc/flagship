import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { generateUMK, deriveIRK } from "../src/keys.js";
import {
  wrapUmkToKeyfile,
  unwrapUmkFromKeyfile,
  KeyfileError,
  KEYFILE_MAGIC,
  type ArgonParams,
} from "../src/keyfile.js";

// Fast argon params for tests; the file records them so unwrap stays fast too.
const FAST: ArgonParams = { m: 512, t: 1, p: 1 };
const META = { username: "harry", accountId: "acct-1", createdAt: "2026-05-25T00:00:00.000Z" };
const PASS = "correct horse battery";

describe("flagshipkey UMK file backup", () => {
  it("round-trips the UMK and re-derives the same IRK", () => {
    const umk = generateUMK();
    const file = wrapUmkToKeyfile(umk, PASS, META, FAST);
    const { umk: back, meta } = unwrapUmkFromKeyfile(file, PASS);
    expect(bytesToHex(back.seed)).toBe(bytesToHex(umk.seed));
    expect(meta).toEqual(META);
    // The whole point: the recovered UMK yields the identical identity key.
    expect(bytesToHex(deriveIRK(back).publicKey)).toBe(bytesToHex(deriveIRK(umk).publicKey));
  });

  it("is self-describing JSON (magic/version/kdf/aead, no plaintext seed)", () => {
    const umk = generateUMK();
    const env = JSON.parse(wrapUmkToKeyfile(umk, PASS, META, FAST));
    expect(env.magic).toBe(KEYFILE_MAGIC);
    expect(env.version).toBe(1);
    expect(env.kdf.algo).toBe("argon2id");
    expect(env.aead).toBe("aes-256-gcm");
    expect(JSON.stringify(env)).not.toContain(bytesToHex(umk.seed)); // never stores the raw seed
  });

  it("rejects the wrong passphrase", () => {
    const file = wrapUmkToKeyfile(generateUMK(), PASS, META, FAST);
    try {
      unwrapUmkFromKeyfile(file, "wrong passphrase here");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(KeyfileError);
      expect((e as KeyfileError).code).toBe("bad-passphrase");
    }
  });

  it("fails when a bound header field is tampered (AAD)", () => {
    const env = JSON.parse(wrapUmkToKeyfile(generateUMK(), PASS, META, FAST));
    env.username = "mallory"; // bound into the AAD → decrypt must fail
    expect(() => unwrapUmkFromKeyfile(JSON.stringify(env), PASS)).toThrowError(KeyfileError);
  });

  it("fails when the ciphertext is tampered", () => {
    const env = JSON.parse(wrapUmkToKeyfile(generateUMK(), PASS, META, FAST));
    const ct = env.ciphertextHex;
    env.ciphertextHex = (ct[0] === "0" ? "1" : "0") + ct.slice(1);
    expect(() => unwrapUmkFromKeyfile(JSON.stringify(env), PASS)).toThrowError(KeyfileError);
  });

  it("rejects a non-keyfile / wrong magic / wrong version", () => {
    expect(() => unwrapUmkFromKeyfile("not json", PASS)).toThrowError(/valid JSON/);
    expect(() => unwrapUmkFromKeyfile(JSON.stringify({ magic: "x" }), PASS)).toThrowError(/flagship key file/);
    const env = JSON.parse(wrapUmkToKeyfile(generateUMK(), PASS, META, FAST));
    env.version = 99;
    expect(() => unwrapUmkFromKeyfile(JSON.stringify(env), PASS)).toThrowError(/unsupported version/);
  });

  it("rejects a too-short passphrase at wrap time", () => {
    expect(() => wrapUmkToKeyfile(generateUMK(), "short", META, FAST)).toThrowError(/too short/);
  });
});
