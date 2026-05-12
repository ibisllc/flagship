/**
 * EncryptedBlobAdapter — exercises the round-trip, the per-blob fresh
 * nonce, the rejection of wrong-key decrypts, and the synthetic log
 * ordering. The adapter is the substrate the Flagship .com control plane
 * uses to hold per-user identity state without ever seeing plaintext.
 */
import { describe, expect, it } from "vitest";
import { EncryptedBlobAdapter } from "../src/encryptedBlobAdapter.js";
import type { Envelope, Mandate } from "../src/types.js";

const SIXTY_FOUR_HEX = "0".repeat(64);
const ENV: Envelope = ((): Mandate => ({
  kind: "Mandate",
  version: 1,
  mandateId: "550e8400-e29b-41d4-a716-446655440000",
  track: "release",
  holder: SIXTY_FOUR_HEX,
  issuedAt: "2026-05-11T00:00:00Z",
  expiresAt: "2026-07-10T00:00:00Z",
  successors: [],
  signedBy: SIXTY_FOUR_HEX,
  signatures: [],
}))();

function fixedKey(byte: number): () => Promise<Uint8Array> {
  return async () => {
    const k = new Uint8Array(32);
    k.fill(byte);
    return k;
  };
}

function blobBackedAdapter(key: () => Promise<Uint8Array>) {
  let blob: Uint8Array | null = null;
  const adapter = new EncryptedBlobAdapter({
    fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
    storeBlob: async (b) => {
      blob = new Uint8Array(b);
    },
    deriveKey: key,
  });
  return { adapter, peek: () => blob };
}

describe("EncryptedBlobAdapter", () => {
  it("write-then-read returns identical bytes", async () => {
    const { adapter } = blobBackedAdapter(fixedKey(1));
    const payload = new TextEncoder().encode("hello world");
    await adapter.write("alpha", payload, ENV);
    const r = await adapter.read("alpha");
    expect(r.bytes).toEqual(payload);
  });

  it("encrypt-decrypt round-trip across a fresh adapter instance", async () => {
    let blob: Uint8Array | null = null;
    const key = fixedKey(7);
    const a = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async (b) => {
        blob = new Uint8Array(b);
      },
      deriveKey: key,
    });
    await a.write("alpha", new Uint8Array([1, 2, 3]), ENV);
    await a.write("beta", new Uint8Array([4, 5, 6]), ENV);

    const b = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async () => {},
      deriveKey: key,
    });
    const r1 = await b.read("alpha");
    const r2 = await b.read("beta");
    expect(Array.from(r1.bytes)).toEqual([1, 2, 3]);
    expect(Array.from(r2.bytes)).toEqual([4, 5, 6]);
  });

  it("list filters by prefix and returns log-ordered shas", async () => {
    const { adapter } = blobBackedAdapter(fixedKey(2));
    await adapter.write("apps/a", new Uint8Array([1]), ENV);
    await adapter.write("devices/d1", new Uint8Array([2]), ENV);
    await adapter.write("apps/b", new Uint8Array([3]), ENV);

    const apps = await adapter.list("apps/");
    expect(apps.map((e) => e.path)).toEqual(["apps/a", "apps/b"]);
    const all = await adapter.list("");
    expect(all.map((e) => e.path)).toEqual(["apps/a", "devices/d1", "apps/b"]);
  });

  it("log() reflects insertion order via the synthetic counter", async () => {
    const { adapter } = blobBackedAdapter(fixedKey(3));
    await adapter.write("z", new Uint8Array([1]), ENV);
    await adapter.write("y", new Uint8Array([2]), ENV);
    await adapter.write("x", new Uint8Array([3]), ENV);
    const log = await adapter.log();
    expect(log.map((e) => e.path)).toEqual(["z", "y", "x"]);
    expect(log.map((e) => Number(e.sha))).toEqual([1, 2, 3]);
  });

  it("read on an unknown path throws", async () => {
    const { adapter } = blobBackedAdapter(fixedKey(4));
    await expect(adapter.read("missing")).rejects.toThrow(/no entry at missing/);
  });

  it("re-keying produces a different blob with the same content", async () => {
    let blob: Uint8Array | null = null;
    const a1 = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async (b) => {
        blob = new Uint8Array(b);
      },
      deriveKey: fixedKey(9),
    });
    await a1.write("only-entry", new Uint8Array([42]), ENV);
    const oldBlob = blob ? new Uint8Array(blob) : null;
    if (!oldBlob) throw new Error("first blob never written");

    let newBlob: Uint8Array | null = null;
    const a2 = new EncryptedBlobAdapter({
      fetchBlob: async () => null,
      storeBlob: async (b) => {
        newBlob = new Uint8Array(b);
      },
      deriveKey: fixedKey(10),
    });
    await a2.write("only-entry", new Uint8Array([42]), ENV);
    expect(newBlob).not.toBeNull();
    expect(Array.from(newBlob!)).not.toEqual(Array.from(oldBlob));
  });

  it("wrong key fails to decrypt", async () => {
    let blob: Uint8Array | null = null;
    const writer = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async (b) => {
        blob = new Uint8Array(b);
      },
      deriveKey: fixedKey(11),
    });
    await writer.write("alpha", new Uint8Array([1, 2]), ENV);

    const wrongKeyReader = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async () => {},
      deriveKey: fixedKey(12),
    });
    await expect(wrongKeyReader.read("alpha")).rejects.toThrow();
  });

  it("each write rotates the AES-GCM nonce", async () => {
    let blob: Uint8Array | null = null;
    const adapter = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async (b) => {
        blob = new Uint8Array(b);
      },
      deriveKey: fixedKey(13),
    });
    await adapter.write("a", new Uint8Array([1]), ENV);
    const firstNonce = blob!.slice(0, 12);
    await adapter.write("b", new Uint8Array([2]), ENV);
    const secondNonce = blob!.slice(0, 12);
    expect(Array.from(firstNonce)).not.toEqual(Array.from(secondNonce));
  });

  it("rejects an out-of-spec key length", async () => {
    const adapter = new EncryptedBlobAdapter({
      fetchBlob: async () => null,
      storeBlob: async () => {},
      deriveKey: async () => new Uint8Array(16),
    });
    await expect(
      adapter.write("a", new Uint8Array([1]), ENV),
    ).rejects.toThrow(/must return 32 bytes/);
  });

  it("truncated blob fails decrypt cleanly", async () => {
    let blob: Uint8Array | null = null;
    const writer = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async (b) => {
        blob = new Uint8Array(b);
      },
      deriveKey: fixedKey(14),
    });
    await writer.write("a", new Uint8Array([1]), ENV);
    blob = blob!.slice(0, 8);
    const reader = new EncryptedBlobAdapter({
      fetchBlob: async () => (blob ? new Uint8Array(blob) : null),
      storeBlob: async () => {},
      deriveKey: fixedKey(14),
    });
    await expect(reader.read("a")).rejects.toThrow();
  });
});
