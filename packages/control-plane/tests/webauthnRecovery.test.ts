import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootRotation,
  signUploadRecoveryRecord,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleApplyAdminRootRotation } from "../src/adminRootRotation.js";
import {
  handleDeleteWebauthnRecovery,
  handleFetchWebauthnRecovery,
  handleFetchWrappedUmkWithToken,
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
  fetchTokenHashHex?: string;
  prfSaltHashHex?: string;
  wrappedAcmeAccountKeyB64?: string;
  wrappedAdminRootB64?: string;
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
  const request: Record<string, unknown> = {
    username, credentialId, wrappedUmk: wrappedB64, issuedAt,
  };
  if (opts.fetchTokenHashHex) request.fetchTokenHash = opts.fetchTokenHashHex;
  if (opts.prfSaltHashHex) request.prfSaltHash = opts.prfSaltHashHex;
  if (opts.wrappedAcmeAccountKeyB64) request.wrappedAcmeAccountKey = opts.wrappedAcmeAccountKeyB64;
  if (opts.wrappedAdminRootB64) request.wrappedAdminRoot = opts.wrappedAdminRootB64;
  return handleUploadWebauthnRecovery(
    {
      usernames: opts.storage.usernames,
      webauthnRecovery: opts.storage.webauthnRecovery,
    },
    { request, signature: bytesToHex(sig) },
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

  it("#28 — escrows the ACME account key alongside the UMK; preserves it on a UMK-only re-upload", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk, wrappedAcmeAccountKeyB64: "QUNNVC1LRVktQ0lQSEVS" });
    const stored = await storage.webauthnRecovery.get(USERNAME);
    expect(stored?.wrappedAcmeAccountKeyB64).toBe("QUNNVC1LRVktQ0lQSEVS");
    // A later UMK-only refresh (no account-key field) must NOT drop the escrow.
    await upload({ storage, irk, wrappedUmk: new Uint8Array([0xbb]) });
    const after = await storage.webauthnRecovery.get(USERNAME);
    expect(after?.wrappedAcmeAccountKeyB64).toBe("QUNNVC1LRVktQ0lQSEVS");
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

describe("webauthn recovery — metadata fetch (Task #74)", () => {
  it("returns presence + credentialId + wrappedUmkHash WITHOUT the ciphertext", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      credentialId: string;
      wrappedUmk?: string;
      wrappedUmkHash: string;
      hasFetchTokenGate: boolean;
    };
    expect(body.credentialId).toBe("deadbeef".repeat(4));
    // Task #74: the ciphertext is no longer surfaced through the
    // unauthenticated GET — fetching it requires the fetchToken via
    // POST /fetch. A regression here would let a victim's
    // username-hash-knower exfiltrate the wrapped UMK without ever
    // proving knowledge of the passphrase.
    expect(body.wrappedUmk).toBeUndefined();
    expect(typeof body.wrappedUmkHash).toBe("string");
    expect(body.wrappedUmkHash.length).toBe(64);
    // Legacy upload (no fetchTokenHash provided) → gate flag is false.
    expect(body.hasFetchTokenGate).toBe(false);
  });

  it("surfaces hasFetchTokenGate=true for rows uploaded with the new hashes", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchTokenHashHex = await sha256Hex(new Uint8Array([1, 2, 3]));
    const prfSaltHashHex = await sha256Hex(new Uint8Array([9, 9, 9]));
    await upload({ storage, irk, fetchTokenHashHex, prfSaltHashHex });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    const body = res.body as { hasFetchTokenGate: boolean };
    expect(body.hasFetchTokenGate).toBe(true);
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

describe("webauthn recovery — Argon2id-gated fetch (Task #74)", () => {
  it("releases the wrappedUmk only when fetchToken's SHA-256 matches the stored hash", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32);
    crypto.getRandomValues(fetchToken);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    const prfSaltHashHex = await sha256Hex(new Uint8Array([7, 7, 7]));
    const wrapped = new Uint8Array([0xa, 0xb, 0xc, 0xd]);
    await upload({ storage, irk, wrappedUmk: wrapped, fetchTokenHashHex, prfSaltHashHex });

    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      wrappedUmk: string;
      credentialId: string;
      prfSaltHash: string;
      registeredIrkPubHex: string;
    };
    expect(body.wrappedUmk).toBe(bytesToB64(wrapped));
    expect(body.credentialId).toBe("deadbeef".repeat(4));
    expect(body.prfSaltHash).toBe(prfSaltHashHex);
    // Recovery Phase B — the success body surfaces the currently registered
    // IRK so the client can detect a rotated key.
    expect(body.registeredIrkPubHex).toBe(bytesToHex(irk.publicKey));
  });

  it("surfaces the CURRENT registered IRK (Phase B rotation detection)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32);
    crypto.getRandomValues(fetchToken);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex });

    // Simulate a key rotation after the recovery envelope was written: the
    // usernames row now holds a DIFFERENT IRK than the recovery record.
    const rotated = makeKey();
    await storage.usernames.swapIrkPub(
      USERNAME,
      bytesToHex(irk.publicKey),
      bytesToHex(rotated.publicKey),
      Date.now(),
    );

    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(200);
    const body = res.body as { registeredIrkPubHex: string };
    // The fetch returns the CURRENT (rotated) key, not the one baked into the
    // recovery record — so the client sees recovered != registered and re-pairs.
    expect(body.registeredIrkPubHex).toBe(bytesToHex(rotated.publicKey));
  });

  it("returns 403 for the wrong fetchToken (passphrase guess)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(1);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex });

    const wrong = new Uint8Array(32).fill(2);
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(wrong), issuedAt: Date.now() },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("invalid fetch token");
  });

  it("returns 404 when no record exists", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(3);
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      "ghost",
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for legacy rows without a fetchTokenHash (re-enrol required)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk }); // legacy upload — no fetchTokenHash
    const fetchToken = new Uint8Array(32).fill(4);
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/re-enrol/i);
  });

  it("rejects malformed bodies (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk });
    for (const bad of [
      null,
      "not-an-object",
      {},
      { fetchToken: "not-hex", issuedAt: Date.now() },
      { fetchToken: "ab", issuedAt: Date.now() }, // too short
      { fetchToken: "aa".repeat(32) }, // missing issuedAt
    ]) {
      const res = await handleFetchWrappedUmkWithToken(
        { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
        USERNAME,
        bad,
      );
      expect([400, 403]).toContain(res.status);
    }
  });

  it("rejects stale issuedAt (403)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(5);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex });
    const res = await handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() - 10 * 60_000 },
    );
    expect(res.status).toBe(403);
  });
});

describe("webauthn recovery — admin-root escrow (Slice D D-3)", () => {
  async function gatedFetch(storage: InMemoryStorage, fetchToken: Uint8Array) {
    return handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
  }

  it("escrows wrappedAdminRoot on upload and releases it on the gated fetch", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(6);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex, wrappedAdminRootB64: "QURNSU4tUk9PVC1DVA==" });

    const res = await gatedFetch(storage, fetchToken);
    expect(res.status).toBe(200);
    expect((res.body as { wrappedAdminRoot?: string }).wrappedAdminRoot).toBe("QURNSU4tUk9PVC1DVA==");
  });

  it("preserves the escrowed admin root across a UMK-only re-upload that omits it", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk, wrappedAdminRootB64: "QURNSU4tUk9PVC1DVA==" });
    await upload({ storage, irk, wrappedUmk: new Uint8Array([0xcc]) });
    const after = await storage.webauthnRecovery.get(USERNAME);
    expect(after?.wrappedAdminRootB64).toBe("QURNSU4tUk9PVC1DVA==");
  });

  it("REPLACES the escrowed admin root on a re-upload carrying a new value (post-rotation re-escrow)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(7);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex, wrappedAdminRootB64: "T0xELVJPT1QtQ1Q=" });
    // Credential recovery rotated the admin root; the recovering device
    // re-escrows the NEW root under the same credential.
    await upload({ storage, irk, fetchTokenHashHex, wrappedAdminRootB64: "TkVXLVJPT1QtQ1Q=" });

    const stored = await storage.webauthnRecovery.get(USERNAME);
    expect(stored?.wrappedAdminRootB64).toBe("TkVXLVJPT1QtQ1Q=");
    const res = await gatedFetch(storage, fetchToken);
    expect((res.body as { wrappedAdminRoot?: string }).wrappedAdminRoot).toBe("TkVXLVJPT1QtQ1Q=");
  });

  it("omits wrappedAdminRoot from the gated fetch for a legacy upload without it", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchToken = new Uint8Array(32).fill(8);
    const fetchTokenHashHex = await sha256Hex(fetchToken);
    await upload({ storage, irk, fetchTokenHashHex });

    const res = await gatedFetch(storage, fetchToken);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("wrappedAdminRoot");
  });

  it("does NOT surface the admin-root ciphertext on the public metadata GET", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    await upload({ storage, irk, wrappedAdminRootB64: "QURNSU4tUk9PVC1DVA==" });
    const res = await handleFetchWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("wrappedAdminRoot");
  });
});

describe("webauthn recovery — adversarial rotate→recover chain (2026-07-03 invariant)", () => {
  // THE INVARIANT (docs device-admin-tier, 2026-07-03): after an admin-root
  // rotation a later recovery must restore the CURRENT root —
  //   unwrap(wrapped_admin_root_b64) == usernames.admin_root_pub_hex (post-swap)
  // — and that recovered root must be the terminus of the old→new proof chain,
  // so a recovered device can sign the NEXT rotation the boxes accept. This
  // drives the full offline loop against InMemory: upload → apply rotation →
  // re-escrow → gated-fetch, asserting the invariant every hop.

  const ADMIN_SALT = "flagship/recovery-admin-root-wrap/v1";
  const enc = new TextEncoder();

  function randSeed(fill: number): Uint8Array {
    return new Uint8Array(32).fill(fill);
  }
  function adminPubHex(seed: Uint8Array): string {
    return bytesToHex(ed.getPublicKey(seed));
  }
  async function adminWrapKey(prf: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
    const ikm = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode(ADMIN_SALT), info: new Uint8Array() },
      ikm,
      256,
    );
    return crypto.subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, usage);
  }
  // Wrap/unwrap in the exact mobile escrow format (HKDF admin-root salt +
  // AES-256-GCM, nonce‖ct‖tag base64) so the blob the test escrows is the same
  // shape a real client would upload.
  async function wrapAdminSeed(seed: Uint8Array, prf: Uint8Array): Promise<string> {
    const key = await adminWrapKey(prf, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, seed));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0);
    out.set(ct, 12);
    return bytesToB64(out);
  }
  async function unwrapAdminSeed(b64: string, prf: Uint8Array): Promise<Uint8Array> {
    const bin = atob(b64);
    const blob = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) blob[i] = bin.charCodeAt(i);
    const key = await adminWrapKey(prf, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
    return new Uint8Array(pt);
  }

  async function setupWithAdminRoot(irk: Keypair, adminRootSeed: Uint8Array): Promise<InMemoryStorage> {
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(irk.publicKey),
      claimedAt: 1,
      adminRootPubHex: adminPubHex(adminRootSeed),
    });
    return s;
  }

  async function applyRotation(
    storage: InMemoryStorage,
    oldSeed: Uint8Array,
    newSeed: Uint8Array,
  ) {
    const oldPub = ed.getPublicKey(oldSeed);
    const newPub = ed.getPublicKey(newSeed);
    const issuedAt = Date.now();
    const sig = signAdminRootRotation(
      { username: USERNAME, oldAdminRootPub: oldPub, newAdminRootPub: newPub, issuedAt },
      { privateKey: oldSeed, publicKey: oldPub },
    );
    return handleApplyAdminRootRotation(
      { usernames: storage.usernames, rotations: storage.adminRootRotations },
      USERNAME,
      {
        rotation: {
          username: USERNAME,
          oldAdminRootPub: bytesToHex(oldPub),
          newAdminRootPub: bytesToHex(newPub),
          issuedAt,
        },
        signatureHex: bytesToHex(sig),
      },
    );
  }

  async function reEscrow(
    storage: InMemoryStorage,
    irk: Keypair,
    fetchTokenHashHex: string,
    adminRootSeed: Uint8Array,
    prf: Uint8Array,
  ) {
    await upload({
      storage,
      irk,
      fetchTokenHashHex,
      wrappedAdminRootB64: await wrapAdminSeed(adminRootSeed, prf),
    });
  }

  async function gatedFetch(storage: InMemoryStorage, fetchToken: Uint8Array) {
    return handleFetchWrappedUmkWithToken(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      USERNAME,
      { fetchToken: bytesToHex(fetchToken), issuedAt: Date.now() },
    );
  }

  /** unwrap(released wrappedAdminRoot) pub == stored admin_root_pub_hex. */
  async function assertInvariant(storage: InMemoryStorage, fetchToken: Uint8Array, prf: Uint8Array) {
    const res = await gatedFetch(storage, fetchToken);
    expect(res.status).toBe(200);
    const released = (res.body as { wrappedAdminRoot?: string }).wrappedAdminRoot;
    expect(typeof released).toBe("string");
    const recoveredSeed = await unwrapAdminSeed(released!, prf);
    const recoveredPub = adminPubHex(recoveredSeed);
    const stored = (await storage.usernames.get(USERNAME))?.adminRootPubHex;
    expect(recoveredPub).toBe(stored);
    return recoveredSeed;
  }

  it("two-hop chain r0→r1→r2: recovery restores the CURRENT root every hop, and it chains", async () => {
    const irk = makeKey();
    const prf = new Uint8Array(32).fill(0x5a);
    const root0 = randSeed(0x10);
    const root1 = randSeed(0x11);
    const root2 = randSeed(0x12);
    const fetchToken = new Uint8Array(32).fill(0x33);
    const fetchTokenHashHex = await sha256Hex(fetchToken);

    const storage = await setupWithAdminRoot(irk, root0);
    // Initial escrow carries root0 (the current root at enrolment).
    await reEscrow(storage, irk, fetchTokenHashHex, root0, prf);
    const recovered0 = await assertInvariant(storage, fetchToken, prf);
    expect(adminPubHex(recovered0)).toBe(adminPubHex(root0));

    // Hop 1: r0→r1. The recovered root0 is the terminus that SIGNS the rotation
    // (proving a recovered device can drive the next rotation the box accepts).
    const r1 = await applyRotation(storage, recovered0, root1);
    expect(r1.status).toBe(200);
    expect((r1.body as { applied: boolean }).applied).toBe(true);
    expect((await storage.usernames.get(USERNAME))?.adminRootPubHex).toBe(adminPubHex(root1));
    // Re-escrow the NEW root, then recovery must restore root1 (not root0).
    await reEscrow(storage, irk, fetchTokenHashHex, root1, prf);
    const recovered1 = await assertInvariant(storage, fetchToken, prf);
    expect(adminPubHex(recovered1)).toBe(adminPubHex(root1));
    expect(adminPubHex(recovered1)).not.toBe(adminPubHex(root0));

    // Hop 2: r1→r2, signed by the recovered root1 → chains to the terminus.
    const r2 = await applyRotation(storage, recovered1, root2);
    expect(r2.status).toBe(200);
    await reEscrow(storage, irk, fetchTokenHashHex, root2, prf);
    const recovered2 = await assertInvariant(storage, fetchToken, prf);
    expect(adminPubHex(recovered2)).toBe(adminPubHex(root2));

    // The served rotation lane holds the full replayable chain root0→root1→root2.
    const lane = await storage.adminRootRotations.list(USERNAME);
    expect(lane.map((r) => [r.oldAdminRootPubHex, r.newAdminRootPubHex])).toEqual([
      [adminPubHex(root0), adminPubHex(root1)],
      [adminPubHex(root1), adminPubHex(root2)],
    ]);
  });

  it("HAZARD (skipRecoveryUpdate): rotate but SKIP re-escrow → recovery restores the DEAD root", async () => {
    const irk = makeKey();
    const prf = new Uint8Array(32).fill(0x5a);
    const root0 = randSeed(0x20);
    const root1 = randSeed(0x21);
    const fetchToken = new Uint8Array(32).fill(0x44);
    const fetchTokenHashHex = await sha256Hex(fetchToken);

    const storage = await setupWithAdminRoot(irk, root0);
    await reEscrow(storage, irk, fetchTokenHashHex, root0, prf);

    // Rotate the pinned root r0→r1 but DO NOT re-escrow (the skipRecoveryUpdate
    // path). The stored authority is now root1…
    const rot = await applyRotation(storage, root0, root1);
    expect(rot.status).toBe(200);
    expect((await storage.usernames.get(USERNAME))?.adminRootPubHex).toBe(adminPubHex(root1));

    // …but the escrow still wraps root0. Recovery therefore restores a DEAD root
    // whose pub NO LONGER equals the stored anchor — the documented hazard. We
    // PIN it so a future "auto re-escrow on rotation" change flips this test.
    const res = await gatedFetch(storage, fetchToken);
    const released = (res.body as { wrappedAdminRoot?: string }).wrappedAdminRoot;
    const recoveredSeed = await unwrapAdminSeed(released!, prf);
    expect(adminPubHex(recoveredSeed)).toBe(adminPubHex(root0)); // the stale/dead root
    expect(adminPubHex(recoveredSeed)).not.toBe(
      (await storage.usernames.get(USERNAME))?.adminRootPubHex,
    );
    // And crucially the dead root can't sign a rotation the box accepts: a proof
    // signed by root0 no longer chains to the current anchor (root1) → 409.
    const deadRotate = await applyRotation(storage, recoveredSeed, randSeed(0x22));
    expect(deadRotate.status).toBe(409);
  });
});

describe("webauthn recovery — upload accepts the new Argon2 hashes (Task #74)", () => {
  it("stores fetchTokenHash + prfSaltHash on upsert when supplied", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    const fetchTokenHashHex = await sha256Hex(new Uint8Array([1]));
    const prfSaltHashHex = await sha256Hex(new Uint8Array([2]));
    const res = await upload({ storage, irk, fetchTokenHashHex, prfSaltHashHex });
    expect(res.status).toBe(200);
    const stored = await storage.webauthnRecovery.get(USERNAME);
    expect(stored?.fetchTokenHashHex).toBe(fetchTokenHashHex);
    expect(stored?.prfSaltHashHex).toBe(prfSaltHashHex);
  });

  it("rejects a malformed fetchTokenHash on upload (400)", async () => {
    const irk = makeKey();
    const storage = await setup(irk);
    // Sign over the legitimate canonical-bytes (the new hashes aren't
    // part of the signed payload — they ride the same upload-record sig).
    const wrappedUmk = new Uint8Array([1, 2, 3]);
    const issuedAt = Date.now();
    const wrappedB64 = bytesToB64(wrappedUmk);
    const wrappedUmkHashHex = await sha256Hex(wrappedUmk);
    const sig = signUploadRecoveryRecord(
      { username: USERNAME, credentialIdHex: "deadbeef".repeat(4), wrappedUmkHashHex, issuedAt },
      irk,
    );
    const res = await handleUploadWebauthnRecovery(
      { usernames: storage.usernames, webauthnRecovery: storage.webauthnRecovery },
      {
        request: {
          username: USERNAME,
          credentialId: "deadbeef".repeat(4),
          wrappedUmk: wrappedB64,
          issuedAt,
          fetchTokenHash: "not-hex",
        },
        signature: bytesToHex(sig),
      },
    );
    expect(res.status).toBe(400);
  });
});

