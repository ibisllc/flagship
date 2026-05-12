/**
 * Encrypted user-identity mandate store (#71) — end-to-end exercise of
 * the put/get handlers against the in-memory storage. Each test
 * constructs a fresh keyring, signs the canonical bytes, posts, then
 * reads back through the GET path and asserts that the Worker NEVER
 * exposes plaintext beyond what `docs/policy/no-kyc.md` permits.
 */
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  deriveUsernameHash,
  handleGetUserIdentity,
  handlePutUserIdentity,
  userIdentityCanonicalBytes,
} from "@flagship/control-plane";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function makeKey(seedByte: number): { priv: Uint8Array; pubHex: string } {
  const priv = new Uint8Array(32);
  priv.fill(seedByte);
  return { priv, pubHex: bytesToHex(ed.getPublicKey(priv)) };
}

function signCanonical(
  priv: Uint8Array,
  usernameHash: string,
  blob: Uint8Array,
  signers: string[],
  version: number,
): string {
  const canon = userIdentityCanonicalBytes(usernameHash, blob, signers, version);
  return bytesToHex(ed.sign(canon, priv));
}

describe("user-identity mandate store (#71)", () => {
  it("PUT with a valid signature stores the row and returns ok", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(1);
    const usernameHash = deriveUsernameHash("alice");
    const blob = new Uint8Array([10, 20, 30, 40]);
    const signers = [key.pubHex];
    const signature = signCanonical(key.priv, usernameHash, blob, signers, 1);

    const r = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: signers,
        blobVersion: 1,
        signature_hex: signature,
      },
    );
    expect(r.status).toBe(200);
    const stored = await storage.userIdentity.get(usernameHash);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.encryptedBlob)).toEqual([10, 20, 30, 40]);
    expect(stored!.blobVersion).toBe(1);
  });

  it("PUT with an invalid signature is rejected", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(2);
    const decoy = makeKey(3);
    const usernameHash = deriveUsernameHash("bob");
    const blob = new Uint8Array([1, 1, 1]);
    const signers = [key.pubHex];
    const signature = signCanonical(decoy.priv, usernameHash, blob, signers, 1);

    const r = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: signers,
        blobVersion: 1,
        signature_hex: signature,
      },
    );
    expect(r.status).toBe(403);
    expect(await storage.userIdentity.get(usernameHash)).toBeUndefined();
  });

  it("PUT with an older blobVersion is rejected with 409", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(4);
    const usernameHash = deriveUsernameHash("carol");
    const signers = [key.pubHex];
    const blob1 = new Uint8Array([1]);
    const sig1 = signCanonical(key.priv, usernameHash, blob1, signers, 5);
    expect(
      (await handlePutUserIdentity(
        { storage: storage.userIdentity },
        {
          usernameHash,
          encryptedBlob_b64: bytesToB64(blob1),
          authorizedSigners: signers,
          blobVersion: 5,
          signature_hex: sig1,
        },
      )).status,
    ).toBe(200);

    const blob2 = new Uint8Array([2]);
    const sig2 = signCanonical(key.priv, usernameHash, blob2, signers, 3);
    const r = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob2),
        authorizedSigners: signers,
        blobVersion: 3,
        signature_hex: sig2,
      },
    );
    expect(r.status).toBe(409);
    const stored = await storage.userIdentity.get(usernameHash);
    expect(stored!.blobVersion).toBe(5);
    expect(Array.from(stored!.encryptedBlob)).toEqual([1]);
  });

  it("GET returns the opaque blob, signers, version, and signature", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(5);
    const usernameHash = deriveUsernameHash("dave");
    const blob = new Uint8Array([9, 9, 9, 9]);
    const signers = [key.pubHex];
    const signature = signCanonical(key.priv, usernameHash, blob, signers, 1);
    await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: signers,
        blobVersion: 1,
        signature_hex: signature,
      },
    );

    const r = await handleGetUserIdentity(
      { storage: storage.userIdentity },
      usernameHash,
    );
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.usernameHash).toBe(usernameHash);
    expect(body.encryptedBlob_b64).toBe(bytesToB64(blob));
    expect(body.authorizedSigners).toEqual(signers);
    expect(body.blobVersion).toBe(1);
    expect(body.signature_hex).toBe(signature);
  });

  it("GET on an unknown hash returns 404", async () => {
    const storage = new InMemoryStorage();
    const r = await handleGetUserIdentity(
      { storage: storage.userIdentity },
      "0".repeat(64),
    );
    expect(r.status).toBe(404);
  });

  it("GET response never includes a private key or plaintext field", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(6);
    const usernameHash = deriveUsernameHash("erin");
    const blob = new TextEncoder().encode("ciphertext-bytes-only");
    const signers = [key.pubHex];
    const signature = signCanonical(key.priv, usernameHash, blob, signers, 1);
    await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: signers,
        blobVersion: 1,
        signature_hex: signature,
      },
    );

    const r = await handleGetUserIdentity(
      { storage: storage.userIdentity },
      usernameHash,
    );
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toContain(bytesToHex(key.priv));
    // No plaintext field of any kind:
    const body = r.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("plaintext");
    expect(body).not.toHaveProperty("decrypted");
    expect(body).not.toHaveProperty("username");
    expect(typeof body.encryptedBlob_b64).toBe("string");
  });

  it("PUT verifies against ANY entry in authorizedSigners", async () => {
    const storage = new InMemoryStorage();
    const phone = makeKey(7);
    const laptop = makeKey(8);
    const tablet = makeKey(9);
    const usernameHash = deriveUsernameHash("frank");
    const blob = new Uint8Array([0xa, 0xb]);
    const signers = [phone.pubHex, laptop.pubHex, tablet.pubHex];
    // Sign with the laptop — the middle entry — to prove iteration works.
    const signature = signCanonical(laptop.priv, usernameHash, blob, signers, 1);

    const r = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: signers,
        blobVersion: 1,
        signature_hex: signature,
      },
    );
    expect(r.status).toBe(200);
  });

  it("PUT rejects signature paired with a different authorizedSigners list", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(10);
    const usernameHash = deriveUsernameHash("grace");
    const blob = new Uint8Array([1, 2, 3]);
    const signers = [key.pubHex];
    const signature = signCanonical(key.priv, usernameHash, blob, signers, 1);
    const tampered = [key.pubHex, makeKey(11).pubHex];

    const r = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash,
        encryptedBlob_b64: bytesToB64(blob),
        authorizedSigners: tampered,
        blobVersion: 1,
        signature_hex: signature,
      },
    );
    expect(r.status).toBe(403);
  });

  it("PUT rejects malformed fields", async () => {
    const storage = new InMemoryStorage();
    const key = makeKey(12);
    const r1 = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash: "not-hex",
        encryptedBlob_b64: bytesToB64(new Uint8Array([1])),
        authorizedSigners: [key.pubHex],
        blobVersion: 1,
        signature_hex: "f".repeat(128),
      },
    );
    expect(r1.status).toBe(400);

    const r2 = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash: "0".repeat(64),
        encryptedBlob_b64: bytesToB64(new Uint8Array([1])),
        authorizedSigners: [],
        blobVersion: 1,
        signature_hex: "f".repeat(128),
      },
    );
    expect(r2.status).toBe(400);

    const r3 = await handlePutUserIdentity(
      { storage: storage.userIdentity },
      {
        usernameHash: "0".repeat(64),
        encryptedBlob_b64: bytesToB64(new Uint8Array([1])),
        authorizedSigners: [key.pubHex],
        blobVersion: 0,
        signature_hex: "f".repeat(128),
      },
    );
    expect(r3.status).toBe(400);
  });

  it("deriveUsernameHash is deterministic and hex", () => {
    const h1 = deriveUsernameHash("harry");
    const h2 = deriveUsernameHash("harry");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain("harry");
  });
});
