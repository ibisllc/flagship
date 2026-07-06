import { describe, expect, it, afterAll } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  signPbManifestDeposit,
  signPbRequestPeers,
  type Keypair,
  type PbManifestDeposit,
  type PbRequestPeers,
} from "@flagship/protocol";
import { InMemoryStorage, D1Storage, type Storage } from "@flagship/storage";
import { createSqliteD1, type SqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import {
  handleGetBackupManifest,
  handlePbRequestPeers,
  handlePeerStkLookup,
  handlePutBackupManifest,
} from "../src/peerBackupMatch.js";

const NOW = 1_750_000_000_000;

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const aliceStk = makeKey(1);
const bStk = makeKey(2);
const cStk = makeKey(3);
const revokedStk = makeKey(4);
const mallory = makeKey(9);

async function seed(s: Storage) {
  await s.servers.put({
    serverDomain: "home.alice.flagship.services",
    username: "alice",
    identityPubKeyHex: bytesToHex(aliceStk.publicKey),
    registeredAt: 10,
  });
  await s.servers.put({
    serverDomain: "attic.alice.flagship.services",
    username: "alice",
    identityPubKeyHex: bytesToHex(bStk.publicKey),
    registeredAt: 20,
  });
  await s.servers.put({
    serverDomain: "garage.alice.flagship.services",
    username: "alice",
    identityPubKeyHex: bytesToHex(cStk.publicKey),
    registeredAt: 30,
  });
  await s.servers.put({
    serverDomain: "dead.alice.flagship.services",
    username: "alice",
    identityPubKeyHex: bytesToHex(revokedStk.publicKey),
    registeredAt: 40,
  });
  await s.servers.revoke("dead.alice.flagship.services", "test", NOW - 1);
  // A different account — must never appear in alice's peer set.
  await s.servers.put({
    serverDomain: "home.bob.flagship.services",
    username: "bob",
    identityPubKeyHex: bytesToHex(makeKey(7).publicKey),
    registeredAt: 5,
  });
}

function signedRequest(over: Partial<PbRequestPeers> = {}, signer: Keypair = aliceStk) {
  const request: PbRequestPeers = {
    requesterServerId: "home.alice.flagship.services",
    n: 5,
    shardSizeBytes: 4096,
    durabilityHint: "high",
    issuedAt: NOW,
    ...over,
  };
  return { request, signature: bytesToHex(signPbRequestPeers(request, signer)) };
}

const deps = (s: Storage) => ({
  servers: s.servers,
  daemonStatus: s.daemonStatus,
  now: () => NOW,
});

const openHandles: SqliteD1[] = [];
afterAll(() => {
  for (const h of openHandles) h.close();
});

/** Run the same scenario against InMemory AND the real D1 adapter. */
async function bothAdapters<T>(body: (s: Storage) => Promise<T>): Promise<T> {
  const mem = new InMemoryStorage();
  const sqlite = createSqliteD1();
  openHandles.push(sqlite);
  const d1 = new D1Storage(sqlite);
  const memResult = await body(mem);
  const d1Result = await body(d1);
  expect(d1Result).toEqual(memResult);
  return memResult;
}

describe("handlePbRequestPeers", () => {
  it("valid STK envelope → same-account, non-revoked peers with baseUrl", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(deps(s), signedRequest());
    });
    expect(r.status).toBe(200);
    const peers = (r.body as { peers: { serverId: string; stkPubHex: string; baseUrl: string }[] }).peers;
    expect(peers.map((p) => p.serverId).sort()).toEqual([
      "attic.alice.flagship.services",
      "garage.alice.flagship.services",
    ]);
    expect(peers.every((p) => p.baseUrl === `https://${p.serverId}`)).toBe(true);
    expect(peers.find((p) => p.serverId.startsWith("attic"))!.stkPubHex).toBe(
      bytesToHex(bStk.publicKey),
    );
  });

  it("prefers recently-live peers when daemonStatus is present", async () => {
    const s = new InMemoryStorage();
    await seed(s);
    await s.daemonStatus.put({
      serverDomain: "garage.alice.flagship.services",
      username: "alice",
      lastReported: NOW - 1000,
      reportJson: "{}",
      signatureHex: "00",
    });
    const r = await handlePbRequestPeers(deps(s), { ...signedRequest(), excludeServerIds: [] });
    const peers = (r.body as { peers: { serverId: string }[] }).peers;
    expect(peers[0]!.serverId).toBe("garage.alice.flagship.services");
  });

  it("honors excludeServerIds and caps at n", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(deps(s), {
        ...signedRequest({ n: 1 }),
        excludeServerIds: ["ATTIC.alice.flagship.services"],
      });
    });
    const peers = (r.body as { peers: { serverId: string }[] }).peers;
    expect(peers).toHaveLength(1);
    expect(peers[0]!.serverId).toBe("garage.alice.flagship.services");
  });

  it("unknown requester → 404, never a peer list", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(
        deps(s),
        signedRequest({ requesterServerId: "home.eve.flagship.services" }, mallory),
      );
    });
    expect(r.status).toBe(404);
  });

  it("revoked requester → 403", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(
        deps(s),
        signedRequest({ requesterServerId: "dead.alice.flagship.services" }, revokedStk),
      );
    });
    expect(r.status).toBe(403);
  });

  it("signature by the wrong key → 403 (a stranger cannot map the account)", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(deps(s), signedRequest({}, mallory));
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe("invalid signature");
  });

  it("stale issuedAt → 403", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePbRequestPeers(deps(s), signedRequest({ issuedAt: NOW - 11 * 60_000 }));
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe("stale request");
  });

  it("malformed envelope → 400", async () => {
    const s = new InMemoryStorage();
    await seed(s);
    const r = await handlePbRequestPeers(deps(s), {
      request: { requesterServerId: "home.alice.flagship.services", n: 0, shardSizeBytes: 1, durabilityHint: "high", issuedAt: NOW },
      signature: "zz",
    });
    expect(r.status).toBe(400);
  });
});

describe("handlePeerStkLookup", () => {
  it("returns the directory-bound STK for a registered box", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      return handlePeerStkLookup({ servers: s.servers }, "attic.alice.flagship.services");
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      serverId: "attic.alice.flagship.services",
      stkPubHex: bytesToHex(bStk.publicKey),
    });
  });

  it("unknown → 404; revoked → 403", async () => {
    const s = new InMemoryStorage();
    await seed(s);
    expect((await handlePeerStkLookup({ servers: s.servers }, "nope.alice.flagship.services")).status).toBe(404);
    expect((await handlePeerStkLookup({ servers: s.servers }, "dead.alice.flagship.services")).status).toBe(403);
  });
});

function manifestDeposit(over: Partial<PbManifestDeposit> & { ciphertextHex?: string } = {}, signer: Keypair = aliceStk) {
  const ciphertextHex = over.ciphertextHex ?? "ab".repeat(100);
  const deposit: PbManifestDeposit = {
    serverId: "home.alice.flagship.services",
    generation: over.generation ?? 1,
    updatedAt: over.updatedAt ?? NOW,
    ciphertextSha256Hex: bytesToHex(sha256(Uint8Array.from(Buffer.from(ciphertextHex, "hex")))),
    nonceHex: over.nonceHex ?? "0102030405060708090a0b0c",
  };
  return {
    body: {
      generation: deposit.generation,
      updatedAt: deposit.updatedAt,
      ciphertextHex,
      nonceHex: deposit.nonceHex,
      signatureHex: bytesToHex(signPbManifestDeposit(deposit, signer)),
    },
  };
}

const mDeps = (s: Storage) => ({
  servers: s.servers,
  peerBackupManifests: s.peerBackupManifests,
  now: () => NOW,
});

describe("backup-manifest lane", () => {
  it("STK-signed put + public non-consuming get round-trips (both adapters)", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      const put = await handlePutBackupManifest(mDeps(s), "home.alice.flagship.services", manifestDeposit().body);
      const get1 = await handleGetBackupManifest(mDeps(s), "home.alice.flagship.services");
      const get2 = await handleGetBackupManifest(mDeps(s), "home.alice.flagship.services");
      return { put, get1, get2 };
    });
    expect(r.put.status).toBe(200);
    expect(r.get1.status).toBe(200);
    expect(r.get1).toEqual(r.get2);
    expect((r.get1.body as { ciphertextHex: string }).ciphertextHex).toBe("ab".repeat(100));
  });

  it("latest-wins by generation; replayed older deposit → 409", async () => {
    const r = await bothAdapters(async (s) => {
      await seed(s);
      await handlePutBackupManifest(mDeps(s), "home.alice.flagship.services", manifestDeposit({ generation: 2, ciphertextHex: "cc".repeat(8) }).body);
      const stale = await handlePutBackupManifest(mDeps(s), "home.alice.flagship.services", manifestDeposit({ generation: 1 }).body);
      const get = await handleGetBackupManifest(mDeps(s), "home.alice.flagship.services");
      return { stale, get };
    });
    expect(r.stale.status).toBe(409);
    expect((r.get.body as { generation: number }).generation).toBe(2);
  });

  it("put signed by a non-directory key → 403; unknown server → 404", async () => {
    const s = new InMemoryStorage();
    await seed(s);
    const forged = await handlePutBackupManifest(mDeps(s), "home.alice.flagship.services", manifestDeposit({}, mallory).body);
    expect(forged.status).toBe(403);
    const unknown = await handlePutBackupManifest(mDeps(s), "home.eve.flagship.services", manifestDeposit().body);
    expect(unknown.status).toBe(404);
    expect((await handleGetBackupManifest(mDeps(s), "home.alice.flagship.services")).status).toBe(404);
  });

  it("signature must commit to the ciphertext (swap → 403)", async () => {
    const s = new InMemoryStorage();
    await seed(s);
    const d = manifestDeposit().body;
    const swapped = { ...d, ciphertextHex: "ff".repeat(100) };
    expect((await handlePutBackupManifest(mDeps(s), "home.alice.flagship.services", swapped)).status).toBe(403);
  });
});
