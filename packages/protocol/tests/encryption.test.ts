import { describe, expect, it } from "vitest";
import { decryptChunk, deriveChunkKey, encryptChunk } from "../src/encryption.js";
import { deriveSWK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(11) };

describe("chunk encryption", () => {
  it("roundtrips plaintext through SWK", () => {
    const swk = deriveSWK(umk, "srv-1");
    const plaintext = new TextEncoder().encode("hello flagship");
    const enc = encryptChunk(plaintext, swk);
    const dec = decryptChunk(enc, swk);
    expect(dec).toEqual(plaintext);
  });

  it("contentHash is sha256(plaintext)", async () => {
    const swk = deriveSWK(umk, "srv-1");
    const plaintext = new TextEncoder().encode("test");
    const enc = encryptChunk(plaintext, swk);
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
    expect(enc.contentHash).toEqual(expected);
  });

  it("rejects decryption with the wrong SWK", () => {
    const swkA = deriveSWK(umk, "srv-A");
    const swkB = deriveSWK(umk, "srv-B");
    const enc = encryptChunk(new TextEncoder().encode("secret"), swkA);
    expect(() => decryptChunk(enc, swkB)).toThrow();
  });

  it("uses fresh nonces for repeated encryption of the same plaintext", () => {
    const swk = deriveSWK(umk, "srv-1");
    const plaintext = new TextEncoder().encode("dup");
    const a = encryptChunk(plaintext, swk);
    const b = encryptChunk(plaintext, swk);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("derives a deterministic chunk key from (swk, contentHash)", () => {
    const swk = deriveSWK(umk, "srv-1");
    const ch = new Uint8Array(32).fill(5);
    expect(deriveChunkKey(swk, ch)).toEqual(deriveChunkKey(swk, ch));
  });

  it("different contentHash → different chunk key (per-chunk key separation)", () => {
    const swk = deriveSWK(umk, "srv-1");
    const a = deriveChunkKey(swk, new Uint8Array(32).fill(1));
    const b = deriveChunkKey(swk, new Uint8Array(32).fill(2));
    expect(a).not.toEqual(b);
  });

  it("handles empty plaintext", () => {
    const swk = deriveSWK(umk, "srv-1");
    const enc = encryptChunk(new Uint8Array(0), swk);
    expect(decryptChunk(enc, swk)).toEqual(new Uint8Array(0));
  });

  it("handles a 1 MiB chunk", () => {
    const swk = deriveSWK(umk, "srv-1");
    const data = new Uint8Array(1 << 20);
    // crypto.getRandomValues has a 64 KiB per-call cap — fill in slices.
    for (let i = 0; i < data.length; i += 65536) {
      crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
    }
    const enc = encryptChunk(data, swk);
    expect(decryptChunk(enc, swk)).toEqual(data);
  });
});

describe("public-key sealed payload (LUKS unlock key delivery)", () => {
  it("sealForRecipient + openSealed roundtrips arbitrary bytes", async () => {
    const { sealForRecipient, openSealed } = await import("../src/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const recipPriv = x25519.utils.randomSecretKey();
    const recipPub = x25519.getPublicKey(recipPriv);
    const luksKey = new Uint8Array(64);
    crypto.getRandomValues(luksKey);
    const sealed = sealForRecipient(luksKey, recipPub);
    const opened = openSealed(sealed, recipPriv);
    expect(opened).toEqual(luksKey);
  });

  it("ephemeral public key sits at the front of the wire format", async () => {
    const { sealForRecipient } = await import("../src/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const recipPriv = x25519.utils.randomSecretKey();
    const recipPub = x25519.getPublicKey(recipPriv);
    const sealed = sealForRecipient(new Uint8Array([1, 2, 3]), recipPub);
    expect(sealed.length).toBe(32 + 12 + 3 + 16); // eph + nonce + ct + GCM tag
  });

  it("a different recipient cannot decrypt", async () => {
    const { sealForRecipient, openSealed } = await import("../src/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const aliceP = x25519.utils.randomSecretKey();
    const aliceK = x25519.getPublicKey(aliceP);
    const bobP = x25519.utils.randomSecretKey();
    const sealed = sealForRecipient(new Uint8Array([7, 7, 7]), aliceK);
    expect(() => openSealed(sealed, bobP)).toThrow();
  });

  it("rejects malformed sizes", async () => {
    const { sealForRecipient, openSealed } = await import("../src/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const recipPub = new Uint8Array(31);
    expect(() => sealForRecipient(new Uint8Array([1]), recipPub)).toThrow(/32 bytes/);
    const recipPriv = x25519.utils.randomSecretKey();
    expect(() => openSealed(new Uint8Array(40), recipPriv)).toThrow(/too short/);
  });

  it("each call produces a different sealed blob even for the same plaintext", async () => {
    const { sealForRecipient } = await import("../src/encryption.js");
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const recipPriv = x25519.utils.randomSecretKey();
    const recipPub = x25519.getPublicKey(recipPriv);
    const a = sealForRecipient(new Uint8Array([1, 2, 3]), recipPub);
    const b = sealForRecipient(new Uint8Array([1, 2, 3]), recipPub);
    expect(a).not.toEqual(b);
  });
});
