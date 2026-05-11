import { describe, expect, it } from "vitest";
import { ed, signUploadRecoveryRecord, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleDeleteWebauthnRecovery,
  handleFetchWebauthnRecovery,
  handleUploadWebauthnRecovery,
} from "../src/webauthnRecovery.js";

const USERNAME = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return bytesToHex(h);
}

async function setup(irk: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(irk.publicKey),
    claimedAt: 1,
  });
  return s;
}

async function upload(opts: {
  storage: InMemoryStorage;
  irk: Keypair;
  username?: string;
  credentialId?: string;
  wrappedUmk?: Uint8Array;
  issuedAt?: number;
}) {
  const username = opts.username ?? USERNAME;
  const credentialId = opts.credentialId ?? "deadbeef".repeat(4);
  const wrappedUmk = opts.wrappedUmk ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const issuedAt = opts.issuedAt ?? Date.now();
  const wrappedB64 = bytesToB64(wrappedUmk);
  const wrappedUmkHashHex = await sha256Hex(wrappedUmk);
  const sig = signUploadRecoveryRecord(
    { username, credentialIdHex: credentialId, wrappedUmkHashHex, issuedAt },
    opts.irk,
  );
  return handleUploadWebauthnRecovery(
    {
      usernames: opts.storage.usernames,
      webauthnRecovery: opts.storage.webauthnRecovery,
    },
    {
      request: { username, credentialId, wrappedUmk: wrappedB64, issuedAt },
      signature: bytesToHex(sig),
    },
  );
}

describe("webauthn recovery — upload", () => {
  it("accepts a valid IRK-signed upload and stores ciphertext", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean; updated: boolean }).ok).toBe(true);
    expect((res.body as { updated: boolean }).updated).toBe(false);
    const stored = await storage.webauthnRecovery.get(USERNAME);
    expect(stored?.credentialIdHex).toBe("deadbeef".repeat(4));
  });

  it("upsert replaces wrappedUmk + credentialId, preserves createdAt", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk, wrappedUmk: new Uint8Array([0xaa]) });
    const first = await storage.webauthnRecovery.get(USERNAME);
    await new Promise((r) => setTimeout(r, 5));
    const res = await upload({
      storage, irk,
      credentialId: "feedface".repeat(4),
      wrappedUmk: new Uint8Array([0xbb]),
    });
    expect(res.status).toBe(200);
    expect((res.body as { updated: boolean }).updated).toBe(true);
    const second = await storage.webauthnRecovery.get(USERNAME);
    expect(second?.credentialIdHex).toBe("feedface".repeat(4));
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).toBeGreaterThan(first!.updatedAt);
  });

  it("rejects malformed body (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await handleUploadWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      { request: { username: USERNAME }, signature: "00" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid username shape (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk, username: "has spaces" });
    expect(res.status).toBe(400);
  });

  it("rejects a credentialId with bad hex shape (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk, credentialId: "zz" });
    expect(res.status).toBe(400);
  });

  it("rejects when the username doesn't exist (404)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk, username: "ghost" });
    expect(res.status).toBe(404);
  });

  it("rejects under a different IRK (403) — squat defense", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const otherIrk = makeKey();
    const res = await upload({ storage, irk: otherIrk });
    expect(res.status).toBe(403);
  });

  it("rejects a stale issuedAt (403)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk, issuedAt: Date.now() - 10 * 60_000 });
    expect(res.status).toBe(403);
  });

  it("rejects an empty wrappedUmk (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await upload({ storage, irk, wrappedUmk: new Uint8Array(0) });
    expect(res.status).toBe(400);
  });
});

describe("webauthn recovery — fetch", () => {
  it("returns ciphertext + credentialId for a known username", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    expect(res.status).toBe(200);
    const body = res.body as { credentialId: string; wrappedUmk: string };
    expect(body.credentialId).toBe("deadbeef".repeat(4));
    expect(body.wrappedUmk.length).toBeGreaterThan(0);
  });

  it("404s when no record exists for the username", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      "ghost",
    );
    expect(res.status).toBe(404);
  });
});

describe("webauthn recovery — delete (kill switch)", () => {
  it("removes the record when given a valid IRK signature pinning the current bytes", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const wrapped = new Uint8Array([1, 2, 3, 4]);
    await upload({ storage, irk, wrappedUmk: wrapped });
    const wrappedHash = await sha256Hex(wrapped);
    const issuedAt = Date.now();
    const sig = signUploadRecoveryRecord(
      { username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkHashHex: wrappedHash, issuedAt },
      irk,
    );
    const res = await handleDeleteWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      {
        request: { username: USERNAME, credentialId: "deadbeef".repeat(4), wrappedUmkHash: wrappedHash, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(200);
    expect(await storage.webauthnRecovery.get(USERNAME)).toBeUndefined();
  });

  it("409s when the record changed since the signature was made (stale-replay defense)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const old = new Uint8Array([0xaa]);
    await upload({ storage, irk, wrappedUmk: old });
    const oldHash = await sha256Hex(old);
    const issuedAt = Date.now();
    const sig = signUploadRecoveryRecord(
      { username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkHashHex: oldHash, issuedAt },
      irk,
    );
    // User uploaded a fresh record AFTER signing the delete. The delete
    // should refuse — otherwise a leaked old delete-sig could nuke a
    // fresh record.
    await new Promise((r) => setTimeout(r, 5));
    await upload({ storage, irk, wrappedUmk: new Uint8Array([0xbb]) });

    const res = await handleDeleteWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      {
        request: { username: USERNAME, credentialId: "deadbeef".repeat(4), wrappedUmkHash: oldHash, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(409);
    expect(await storage.webauthnRecovery.get(USERNAME)).toBeDefined();
  });

  it("403s when the URL username doesn't match the body", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const wrapped = new Uint8Array([1]);
    await upload({ storage, irk, wrappedUmk: wrapped });
    const wrappedHash = await sha256Hex(wrapped);
    const issuedAt = Date.now();
    const sig = signUploadRecoveryRecord(
      { username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkHashHex: wrappedHash, issuedAt },
      irk,
    );
    const res = await handleDeleteWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      "different",
      {
        request: { username: USERNAME, credentialId: "deadbeef".repeat(4), wrappedUmkHash: wrappedHash, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("403s under a different IRK", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const wrapped = new Uint8Array([1]);
    await upload({ storage, irk, wrappedUmk: wrapped });
    const wrappedHash = await sha256Hex(wrapped);
    const otherIrk = makeKey();
    const issuedAt = Date.now();
    const sig = signUploadRecoveryRecord(
      { username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkHashHex: wrappedHash, issuedAt },
      otherIrk,
    );
    const res = await handleDeleteWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      {
        request: { username: USERNAME, credentialId: "deadbeef".repeat(4), wrappedUmkHash: wrappedHash, issuedAt },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(403);
  });
});
