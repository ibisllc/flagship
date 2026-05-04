import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSTK,
  deriveSWK,
  signPbAnnounce,
  signPbPeerConfirm,
  signPbRequestPeers,
  type PbAnnounce,
  type PbPeerConfirm,
  type PbRequestPeers,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import { InMemoryServerRegistry } from "../src/routes/serverRegistry.js";
import {
  InMemoryReciprocityLedger,
  InMemoryPeerCandidatePool,
} from "../src/routes/peerBackupMatchmaker.js";

const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerSTK = deriveSTK(deriveSWK(ownerUmk, "owner-srv"));
const peerAUmk = new Uint8Array(32).fill(0xa0);
const peerASTK = deriveSTK(deriveSWK({ seed: peerAUmk }, "peer-A-srv"));
const peerBUmk = new Uint8Array(32).fill(0xb0);
const peerBSTK = deriveSTK(deriveSWK({ seed: peerBUmk }, "peer-B-srv"));
void deriveIRK;

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeApp() {
  const registry = new InMemoryServerRegistry();
  registry.put({ userId: "harry", serverId: "owner-srv", stkPub: ownerSTK.publicKey, registeredAt: 1 });
  registry.put({ userId: "sarah", serverId: "peer-A-srv", stkPub: peerASTK.publicKey, registeredAt: 1 });
  registry.put({ userId: "alex", serverId: "peer-B-srv", stkPub: peerBSTK.publicKey, registeredAt: 1 });
  const ledger = new InMemoryReciprocityLedger();
  const pool = new InMemoryPeerCandidatePool();
  const app = buildServer({
    serverRegistry: registry,
    reciprocityLedger: ledger,
    peerCandidatePool: pool,
    resolveUserIrk: () => null,
  });
  return { app, registry, ledger, pool };
}

function buildAnnounce(over: Partial<PbAnnounce> = {}, signerSTK = ownerSTK) {
  const claim: PbAnnounce = {
    serverId: over.serverId ?? "owner-srv",
    pledgedBytes: over.pledgedBytes ?? 100 * 1024 * 1024,
    shareRatio: over.shareRatio ?? 0.5,
    maxShardSize: over.maxShardSize ?? 4 * 1024 * 1024,
    region: over.region,
    tunnelEndpoint: over.tunnelEndpoint ?? "203.0.113.1:51820",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      ...claim,
    },
    signature: bytesToHex(signPbAnnounce(claim, signerSTK)),
  };
}

function buildRequestPeers(over: Partial<PbRequestPeers> = {}, signerSTK = ownerSTK) {
  const claim: PbRequestPeers = {
    requesterServerId: over.requesterServerId ?? "owner-srv",
    n: over.n ?? 4,
    shardSizeBytes: over.shardSizeBytes ?? 1 * 1024 * 1024,
    durabilityHint: over.durabilityHint ?? "high",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: claim,
    signature: bytesToHex(signPbRequestPeers(claim, signerSTK)),
  };
}

function buildPeerConfirm(over: Partial<PbPeerConfirm> = {}, signerSTK = peerASTK) {
  const claim: PbPeerConfirm = {
    peerServerId: over.peerServerId ?? "peer-A-srv",
    requesterServerId: over.requesterServerId ?? "owner-srv",
    shardId: over.shardId ?? "shard-1",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: claim,
    signature: bytesToHex(signPbPeerConfirm(claim, signerSTK)),
  };
}

describe("/api/peer-backup/announce", () => {
  it("accepts a valid STK-signed announce and adds the candidate to the pool", async () => {
    const { app, pool } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv" }, peerASTK),
    });
    expect(r.statusCode).toBe(200);
    expect(pool.list().some((c) => c.serverId === "peer-A-srv")).toBe(true);
  });

  it("rejects forged signatures (different STK)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv" }, peerBSTK),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects an announce from a revoked server", async () => {
    const { app, registry } = makeApp();
    registry.revoke("peer-A-srv", "stolen", Date.now());
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv" }, peerASTK),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rate-limits announces per account (sybil resistance)", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv" }, peerASTK),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv", issuedAt: Date.now() + 1 }, peerASTK),
    });
    expect(second.statusCode).toBe(429);
  });
});

describe("/api/peer-backup/request-peers", () => {
  it("returns N candidates excluding the requester's own account", async () => {
    const { app } = makeApp();
    // seed pool with two peers
    await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv", pledgedBytes: 1_000_000_000 }, peerASTK),
    });
    await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-B-srv", pledgedBytes: 1_000_000_000 }, peerBSTK),
    });
    // owner pledges enough to get a quota
    await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "owner-srv", pledgedBytes: 1_000_000_000 }, ownerSTK),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/request-peers",
      payload: buildRequestPeers({ requesterServerId: "owner-srv", n: 2, shardSizeBytes: 1024 }, ownerSTK),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const ids = body.peers.map((p: { serverId: string }) => p.serverId).sort();
    expect(ids).toEqual(["peer-A-srv", "peer-B-srv"]);
    expect(body.peers[0].stkPubKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects when reciprocity allowance is exhausted (402 Payment Required)", async () => {
    const { app, ledger } = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: buildAnnounce({ serverId: "peer-A-srv", pledgedBytes: 1_000_000_000 }, peerASTK),
    });
    // Owner pledged 1 byte, so anything > 0 over-consumes.
    ledger.recordPledged("harry", 1);
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/request-peers",
      payload: buildRequestPeers({ requesterServerId: "owner-srv", n: 4, shardSizeBytes: 1_000_000 }, ownerSTK),
    });
    expect(r.statusCode).toBe(402);
  });

  it("rejects malformed n / shardSizeBytes", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/request-peers",
      payload: buildRequestPeers({ n: 0, shardSizeBytes: 1024 }, ownerSTK),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("/api/peer-backup/peer-confirm", () => {
  it("accepts a valid peer confirmation", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/peer-confirm",
      payload: buildPeerConfirm(),
    });
    expect(r.statusCode).toBe(200);
  });

  it("rejects forged signatures", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/peer-backup/peer-confirm",
      payload: buildPeerConfirm({}, peerBSTK), // peerB signs claim that says peerA
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("InMemoryReciprocityLedger", () => {
  it("permitsRequest enforces N/K ratio against pledged minus consumed minus penalty", () => {
    const ledger = new InMemoryReciprocityLedger();
    ledger.recordPledged("u1", 1_000_000);
    expect(
      ledger.permitsRequest({ accountId: "u1", requestedBytes: 100_000, n: 16, k: 10, lambda: 1024 }).ok,
    ).toBe(true);
    // 600_000 * (16/10) = 960_000 — still under 1_000_000.
    ledger.recordConsumedBackup("u1", 0);
    expect(
      ledger.permitsRequest({ accountId: "u1", requestedBytes: 600_000, n: 16, k: 10, lambda: 1024 }).ok,
    ).toBe(true);
    // Now stuff in a proof-failure score that subtracts allowance.
    ledger.recordProofFailure("u1", 1000);
    expect(
      ledger.permitsRequest({ accountId: "u1", requestedBytes: 600_000, n: 16, k: 10, lambda: 1024 }).ok,
    ).toBe(false);
  });

  it("decay halves proofFailureScore after windowMs has passed", () => {
    const ledger = new InMemoryReciprocityLedger();
    ledger.recordProofFailure("u1", 100);
    ledger.decay(0, 1000);
    ledger.decay(2000, 1000);
    expect(ledger.get("u1")?.proofFailureScore).toBe(50);
  });
});
