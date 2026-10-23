import { describe, expect, it } from "vitest";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { decryptChunk, deriveBackupManifestKey, deriveServiceSecret, encryptChunk, hkdfFromSwk, opaqueSecret, openLlmPayload, sealLlmPayload } from "../src/index.js";
import { ed, isOpaqueKey, opaqueKey, openSealedFromEd25519Recipient, sealForEd25519Recipient, signBootSuspension, verifyBootSuspension } from "../src/index.js";

const seed = new Uint8Array(32).fill(5);
const pub = ed.getPublicKey(seed);

function remote(unseal = true) {
  const calls: string[] = [];
  const key = opaqueKey({
    publicKey: pub,
    sign: (m) => (calls.push("sign"), ed.sign(m, seed)),
    ...(unseal ? { unseal: (b: Uint8Array) => (calls.push("unseal"), openSealedFromEd25519Recipient(b, seed)) } : {}),
  });
  return { key, calls };
}

describe("an opaque key stands in for a private key", () => {
  it("signs through its holder and yields the same signature as the real seed", () => {
    const { key, calls } = remote();
    const msg = new TextEncoder().encode("flagship/test/v1|hello");
    expect(ed.sign(msg, key)).toEqual(ed.sign(msg, seed));
    expect(ed.getPublicKey(key)).toEqual(pub);
    expect(calls).toEqual(["sign"]);
  });

  it("works in the protocol's own signers", () => {
    const { key } = remote();
    const order = { serverDomain: "home.alice.flagship.services", epoch: 1, seq: 1, action: "suspend" as const, reason: "dead-man", signer: "box" as const, issuedAt: 1760000000000 };
    const sig = signBootSuspension(order, key);
    expect(verifyBootSuspension(order, sig, pub)).toBe(true);
  });

  it("opens a sealed blob through its holder", () => {
    const { key, calls } = remote();
    const blob = sealForEd25519Recipient(new TextEncoder().encode("secret"), pub);
    expect(new TextDecoder().decode(openSealedFromEd25519Recipient(blob, key))).toBe("secret");
    expect(calls).toEqual(["unseal"]);
    expect(() => openSealedFromEd25519Recipient(blob, remote(false).key)).toThrow(/cannot open/);
  });

  it("refuses every attempt to read its bytes", () => {
    const { key } = remote();
    expect(isOpaqueKey(key)).toBe(true);
    expect(isOpaqueKey(seed)).toBe(false);
    expect(key.length).toBe(32);
    const must = (f: () => unknown) => expect(f).toThrow(/held by flagship-keyd/);
    must(() => key[0]);
    must(() => Buffer.from(key).toString("hex"));
    must(() => Array.from(key));
    must(() => [...key]);
    must(() => key.slice());
    must(() => key.subarray(0));
    must(() => new Uint8Array(key.buffer));
    must(() => { key[0] = 1; });
    must(() => JSON.stringify(Array.prototype.slice.call(key)));
  });
});

describe("an opaque workload secret", () => {
  const swk = new Uint8Array(32).fill(0x77);
  const calls: string[] = [];
  const handle = opaqueSecret({
    derive: (salt, info) => (calls.push(info), hkdf(sha256, swk, salt, new TextEncoder().encode(info), 32)),
  });

  it("produces the same subkeys as the real secret through every protocol consumer", () => {
    expect(deriveServiceSecret(handle, "alice--chess")).toEqual(deriveServiceSecret(swk, "alice--chess"));
    expect(deriveBackupManifestKey(handle)).toEqual(deriveBackupManifestKey(swk));
    const chunk = encryptChunk(new TextEncoder().encode("data"), handle);
    expect(new TextDecoder().decode(decryptChunk(chunk, swk))).toBe("data");
    const sealed = sealLlmPayload(new TextEncoder().encode("hi"), swk);
    expect(new TextDecoder().decode(openLlmPayload(sealed, handle))).toBe("hi");
    expect(new Set(calls)).toEqual(new Set(["flagship.app-secret.v1", "flagship.pb-manifest.v1", "flagship.chunk.v1", "flagship.llm.v1"]));
  });

  it("refuses a label that is not on the list and every read of its bytes", () => {
    expect(() => hkdfFromSwk(handle, new Uint8Array(0), "flagship/root-entitlement/v1")).toThrow(/not allowed/);
    expect(() => Buffer.from(handle).toString("hex")).toThrow(/held by flagship-keyd/);
    expect(() => hkdf(sha256, handle, new Uint8Array(0), new Uint8Array(1), 32)).toThrow();
  });
});
