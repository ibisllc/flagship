/**
 * P9 daemon BFF — /api/screens/peer-backup/{status,toggle}.
 *
 * Two HTTP routes + a pure projector. Tests cover:
 *   1. Pure projector (`buildPeerBackupStatus`) over empty / partial /
 *      participating registries — emits empty/zero values where the
 *      underlying state is missing without fabricating.
 *   2. Toggle endpoint flips BackupLoop.enabled (idempotent), echoes
 *      the new status, and 503s when no BackupLoop is wired.
 *   3. End-to-end HTTP shape exercise through `buildScreensHttp` —
 *      verifies the response shape matches what
 *      `apps/web/public/webapp/views/peer-backup.js` reads
 *      (participating + peersBackingYouUp + peersYouBackUp + shards +
 *      repair + stats).
 */

import { describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import { BackupLoop } from "../../src/backupLoop.js";
import {
  InMemoryShardRegistry,
  type MyShardRow,
  type TheirShardRow,
} from "../../src/peerBackup/registry.js";
import { buildPeerBackupStatus } from "../../src/screens/peerBackupStatus.js";
import { PeerActivityWatchdog } from "../../src/peerBackup/peerActivityWatchdog.js";
import { RepairStatsAccumulator } from "../../src/peerBackup/repairStatsAccumulator.js";
import {
  buildScreensHttp,
  type ScreensHttpDeps,
} from "../../src/screens/screensHttp.js";
import type { HttpRequest } from "../../src/runtime.js";
import type { PeerBackupStatusResponse } from "../../src/screens/types.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";

const swk = deriveSWK({ seed: new Uint8Array(32).fill(7) }, "home-box");

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: { "x-flagship-session": "tok-good" },
    body: Buffer.alloc(0),
    ...over,
  };
}

function fakeGate(allowToken = "tok-good") {
  return {
    has(t: string) {
      return t === allowToken;
    },
    check(r: HttpRequest) {
      const hdr = r.headers["x-flagship-session"];
      if (typeof hdr === "string" && hdr === allowToken) return null;
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    },
  };
}

const COMMON: Omit<ScreensHttpDeps, "gate"> = {
  serverFqdn: SERVER_FQDN,
  username: USERNAME,
  daemonVersion: "0.0.1-test",
  startedAt: 1_000,
  now: () => 5_000,
};

const cid = (n: number) => new Uint8Array(32).fill(n);
const stk = (n: number) => new Uint8Array(32).fill(n);

function myRow(over: Partial<MyShardRow> = {}): MyShardRow {
  return {
    chunkId: cid(1),
    encChunkId: cid(2),
    shardIndex: 0,
    peerServerId: "peer-A",
    peerStkPub: stk(0xa1),
    storedAt: 100,
    sizeBytes: 0,
    challengeStreak: 0,
    ...over,
  };
}

function theirRow(over: Partial<TheirShardRow> = {}): TheirShardRow {
  return {
    encChunkId: cid(2),
    shardIndex: 0,
    ownerServerId: "owner-X",
    ownerStkPub: stk(0xb2),
    storedAt: 100,
    sizeBytes: 4 * 1024 * 1024,
    ...over,
  };
}

// ---------- 1. Pure projector --------------------------------------------

describe("buildPeerBackupStatus — projector", () => {
  it("reports participating=false + empty everything when no deps wired", () => {
    const r = buildPeerBackupStatus({});
    expect(r.participating).toBe(false);
    expect(r.peersBackingYouUp).toEqual([]);
    expect(r.peersYouBackUp).toEqual([]);
    expect(r.shards).toEqual([]);
    expect(r.repair).toEqual({
      state: "idle",
      lastTickMs: null,
      queued: 0,
      completed24h: 0,
    });
    expect(r.stats).toEqual({
      total: 0,
      durable: 0,
      atRisk: 0,
      yourBytesStored: 0,
      peerBytesHosted: 0,
    });
  });

  it("emits participating=true when BackupLoop.enabled is set but no shards exist yet", () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5, initiallyEnabled: true });
    const r = buildPeerBackupStatus({ backupLoop: loop });
    expect(r.participating).toBe(true);
    expect(r.shards).toEqual([]);
    expect(r.peersBackingYouUp).toEqual([]);
  });

  it("aggregates shards by encChunkId + counts survivors (challengeStreak < 3)", () => {
    const reg = new InMemoryShardRegistry();
    // chunk-A: 5 placements; 4 survive (one row has streak=3).
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-1" }));
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 1, peerServerId: "peer-2" }));
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 2, peerServerId: "peer-3" }));
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 3, peerServerId: "peer-4" }));
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 4, peerServerId: "peer-5", challengeStreak: 3 }),
    );
    // chunk-B: 2 placements, both with streak=3 → at-risk.
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xbb), shardIndex: 0, peerServerId: "peer-6", challengeStreak: 3 }),
    );
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xbb), shardIndex: 1, peerServerId: "peer-7", challengeStreak: 3 }),
    );
    const r = buildPeerBackupStatus({ registry: reg, k: 3 });
    expect(r.shards).toHaveLength(2);
    const chunkA = r.shards.find((s) => s.shardId === bytesToHex(cid(0xaa)))!;
    expect(chunkA.replicas).toBe(4);
    expect(chunkA.minReplicas).toBe(3);
    const chunkB = r.shards.find((s) => s.shardId === bytesToHex(cid(0xbb)))!;
    expect(chunkB.replicas).toBe(0);
    expect(r.stats.total).toBe(2);
    expect(r.stats.durable).toBe(1);
    expect(r.stats.atRisk).toBe(1);
  });

  it("rolls up peersBackingYouUp by peerServerId with online cutoff", () => {
    const reg = new InMemoryShardRegistry();
    // peer-1 hosts 2 shards; latest lastChallenge = 4500.
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-1", storedAt: 1000, lastChallenge: 4500 }),
    );
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 1, peerServerId: "peer-1", storedAt: 2000 }),
    );
    // peer-stale hasn't been seen since storedAt=1000; now=5000, threshold 1s → offline.
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xbb), shardIndex: 0, peerServerId: "peer-stale", storedAt: 1000 }),
    );
    const r = buildPeerBackupStatus({
      registry: reg,
      k: 3,
      now: () => 5_000,
      onlineThresholdMs: 1_000,
    });
    const peer1 = r.peersBackingYouUp.find((p) => p.peerFqdn === "peer-1")!;
    expect(peer1.shardsHosted).toBe(2);
    expect(peer1.lastSeenMs).toBe(4_500);
    expect(peer1.online).toBe(true);
    const stale = r.peersBackingYouUp.find((p) => p.peerFqdn === "peer-stale")!;
    expect(stale.online).toBe(false);
  });

  it("rolls up peersYouBackUp by ownerServerId with byte totals", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordTheirShard(theirRow({ ownerServerId: "owner-1", shardIndex: 0, sizeBytes: 1024 }));
    reg.recordTheirShard(theirRow({ ownerServerId: "owner-1", shardIndex: 1, sizeBytes: 2048 }));
    reg.recordTheirShard(theirRow({ ownerServerId: "owner-2", encChunkId: cid(0xee), sizeBytes: 8192 }));
    const r = buildPeerBackupStatus({ registry: reg, k: 3 });
    expect(r.peersYouBackUp).toHaveLength(2);
    const o1 = r.peersYouBackUp.find((p) => p.peerFqdn === "owner-1")!;
    expect(o1.shardsHosted).toBe(2);
    expect(o1.bytesHosted).toBe(3072);
    const o2 = r.peersYouBackUp.find((p) => p.peerFqdn === "owner-2")!;
    expect(o2.bytesHosted).toBe(8192);
    expect(r.stats.peerBytesHosted).toBe(11264);
  });

  it("includes repair-stats snapshot when provider supplied", () => {
    const r = buildPeerBackupStatus({
      repairStats: {
        snapshot: () => ({
          state: "running",
          lastTickMs: 9_000,
          queued: 3,
          completed24h: 12,
          lastError: "timeout: peer-7",
        }),
      },
    });
    expect(r.repair).toEqual({
      state: "running",
      lastTickMs: 9_000,
      queued: 3,
      completed24h: 12,
      lastError: "timeout: peer-7",
    });
  });

  it("yourBytesStored is 0 when rows carry sizeBytes=0 (legacy / unwired placement)", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 0, sizeBytes: 0 }));
    const r = buildPeerBackupStatus({ registry: reg, k: 3 });
    expect(r.stats.yourBytesStored).toBe(0);
  });

  it("yourBytesStored sums sizeBytes across surviving rows (Gap 1 wired)", () => {
    const reg = new InMemoryShardRegistry();
    // 3 placements * 1024 = 3072 bytes total — all survive.
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-1", sizeBytes: 1024 }),
    );
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 1, peerServerId: "peer-2", sizeBytes: 1024 }),
    );
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 2, peerServerId: "peer-3", sizeBytes: 1024 }),
    );
    // Lost row — excluded from the sum.
    reg.recordMyShard(
      myRow({
        encChunkId: cid(0xbb),
        shardIndex: 0,
        peerServerId: "peer-x",
        sizeBytes: 9999,
        challengeStreak: 3,
      }),
    );
    const r = buildPeerBackupStatus({ registry: reg, k: 3 });
    expect(r.stats.yourBytesStored).toBe(3072);
    // Shard summary surfaces the sample sizeBytes for the chunk.
    const aaSummary = r.shards.find(
      (s) => s.shardId === new Array(32).fill(0xaa).map((b) => b.toString(16).padStart(2, "0")).join(""),
    )!;
    expect(aaSummary.bytes).toBe(1024);
  });
});

// ---------- Gap 2 — peer-activity watchdog -------------------------------

describe("buildPeerBackupStatus — peer-activity watchdog (Gap 2)", () => {
  it("falls back to lastChallenge ?? storedAt when no watchdog wired (unchanged behaviour)", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-A", storedAt: 1000 }),
    );
    const r = buildPeerBackupStatus({
      registry: reg,
      k: 3,
      now: () => 5_000,
      onlineThresholdMs: 1_000,
    });
    const a = r.peersBackingYouUp.find((p) => p.peerFqdn === "peer-A")!;
    expect(a.lastSeenMs).toBe(1000);
    expect(a.online).toBe(false);
  });

  it("prefers the watchdog's live timestamp when it is newer than the proxy", () => {
    const reg = new InMemoryShardRegistry();
    // Proxy says lastSeen=1000 (offline); watchdog says 4900 (online at now=5000, threshold=1000).
    reg.recordMyShard(
      myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-A", storedAt: 1000 }),
    );
    const watchdog = new PeerActivityWatchdog(() => 4900);
    watchdog.bump("peer-A");
    const r = buildPeerBackupStatus({
      registry: reg,
      peerActivity: watchdog,
      k: 3,
      now: () => 5_000,
      onlineThresholdMs: 1_000,
    });
    const a = r.peersBackingYouUp.find((p) => p.peerFqdn === "peer-A")!;
    expect(a.lastSeenMs).toBe(4900);
    expect(a.online).toBe(true);
  });

  it("ignores a stale watchdog when the proxy is newer", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(
      myRow({
        encChunkId: cid(0xaa),
        shardIndex: 0,
        peerServerId: "peer-A",
        storedAt: 1000,
        lastChallenge: 4500,
      }),
    );
    const watchdog = new PeerActivityWatchdog(() => 200);
    watchdog.bump("peer-A");
    const r = buildPeerBackupStatus({
      registry: reg,
      peerActivity: watchdog,
      k: 3,
      now: () => 5_000,
      onlineThresholdMs: 1_000,
    });
    const a = r.peersBackingYouUp.find((p) => p.peerFqdn === "peer-A")!;
    expect(a.lastSeenMs).toBe(4500);
    expect(a.online).toBe(true);
  });
});

// ---------- Gap 3 — repair-stats accumulator -----------------------------

describe("buildPeerBackupStatus — repair-stats accumulator (Gap 3)", () => {
  it("falls back to idle/zero when no accumulator wired", () => {
    const r = buildPeerBackupStatus({});
    expect(r.repair).toEqual({
      state: "idle",
      lastTickMs: null,
      queued: 0,
      completed24h: 0,
    });
  });

  it("threads RepairStatsAccumulator.snapshot() into the wire shape", async () => {
    let now = 1_000;
    const acc = new RepairStatsAccumulator({ now: () => now });
    now = 2_000;
    await acc.wrapTick(async () => ({ replaced: 4 }));
    const r = buildPeerBackupStatus({ repairStats: acc });
    expect(r.repair.state).toBe("idle");
    expect(r.repair.lastTickMs).toBe(2_000);
    expect(r.repair.completed24h).toBe(4);
    expect(r.repair.lastError).toBeUndefined();
  });
});

// ---------- 2. Toggle handler --------------------------------------------

describe("HTTP — POST /api/screens/peer-backup/toggle", () => {
  it("returns 503 when no BackupLoop is wired", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ participate: true })),
      }),
    );
    expect(r?.status).toBe(503);
  });

  it("flips BackupLoop.enabled and echoes the new status", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5 });
    expect(loop.status().enabled).toBe(false);
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ participate: true })),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as PeerBackupStatusResponse;
    expect(body.participating).toBe(true);
    expect(loop.status().enabled).toBe(true);
  });

  it("is idempotent — re-enabling an already-enabled loop is a no-op 200", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5, initiallyEnabled: true });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ participate: true })),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as PeerBackupStatusResponse;
    expect(body.participating).toBe(true);
  });

  it("can disable participation again", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5, initiallyEnabled: true });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ participate: false })),
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as PeerBackupStatusResponse;
    expect(body.participating).toBe(false);
    expect(loop.status().enabled).toBe(false);
  });

  it("400s on a malformed body (missing 'participate')", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5 });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ wrong: true })),
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("requires the paired-session gate", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5 });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    const r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        headers: {},
        body: Buffer.from(JSON.stringify({ participate: true })),
      }),
    );
    expect(r?.status).toBe(401);
  });
});

// ---------- 3. End-to-end HTTP shape -------------------------------------

describe("HTTP — GET /api/screens/peer-backup/status", () => {
  it("returns the empty/unenrolled shape when no peerBackup deps wired", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: fakeGate() });
    const r = await handle(req({ path: "/api/screens/peer-backup/status" }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as PeerBackupStatusResponse;
    expect(body.participating).toBe(false);
    expect(body.peersBackingYouUp).toEqual([]);
    expect(body.peersYouBackUp).toEqual([]);
    expect(body.shards).toEqual([]);
    expect(body.stats.total).toBe(0);
    expect(body.repair.state).toBe("idle");
  });

  it("returns the full populated shape when registry has shards on both sides", async () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 0, peerServerId: "peer-A" }));
    reg.recordMyShard(myRow({ encChunkId: cid(0xaa), shardIndex: 1, peerServerId: "peer-B" }));
    reg.recordTheirShard(theirRow({ ownerServerId: "owner-X", sizeBytes: 1024 }));
    const loop = new BackupLoop({ swk, k: 3, n: 5, initiallyEnabled: true });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: {
        backupLoop: loop,
        registry: reg,
        k: 3,
      },
    });
    const r = await handle(req({ path: "/api/screens/peer-backup/status" }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as PeerBackupStatusResponse;

    // Shape matches the webapp's reads in peer-backup.js (lines 86-91, 132-136, 184-197, 201-210).
    expect(body.participating).toBe(true);
    expect(Array.isArray(body.peersBackingYouUp)).toBe(true);
    expect(Array.isArray(body.peersYouBackUp)).toBe(true);
    expect(Array.isArray(body.shards)).toBe(true);
    expect(typeof body.repair.state).toBe("string");
    expect(typeof body.stats.total).toBe("number");

    expect(body.peersBackingYouUp).toHaveLength(2);
    for (const p of body.peersBackingYouUp) {
      expect(typeof p.peerFqdn).toBe("string");
      expect(typeof p.shardsHosted).toBe("number");
      expect(typeof p.lastSeenMs).toBe("number");
      expect(typeof p.online).toBe("boolean");
    }
    expect(body.peersYouBackUp).toHaveLength(1);
    for (const p of body.peersYouBackUp) {
      expect(typeof p.peerFqdn).toBe("string");
      expect(typeof p.shardsHosted).toBe("number");
      expect(typeof p.bytesHosted).toBe("number");
      expect(typeof p.lastFetchedMs).toBe("number");
    }
    expect(body.shards).toHaveLength(1);
    for (const s of body.shards) {
      expect(typeof s.shardId).toBe("string");
      expect(typeof s.replicas).toBe("number");
      expect(typeof s.minReplicas).toBe("number");
      expect(typeof s.bytes).toBe("number");
    }
  });

  it("end-to-end: toggle ON then GET status reflects participating=true", async () => {
    const loop = new BackupLoop({ swk, k: 3, n: 5 });
    const handle = buildScreensHttp({
      ...COMMON,
      gate: fakeGate(),
      peerBackup: { backupLoop: loop },
    });
    // Initial state.
    let r = await handle(req({ path: "/api/screens/peer-backup/status" }));
    expect((JSON.parse(r!.body as string) as PeerBackupStatusResponse).participating).toBe(false);
    // Toggle.
    r = await handle(
      req({
        method: "POST",
        path: "/api/screens/peer-backup/toggle",
        body: Buffer.from(JSON.stringify({ participate: true })),
      }),
    );
    expect(r?.status).toBe(200);
    // Re-read.
    r = await handle(req({ path: "/api/screens/peer-backup/status" }));
    expect((JSON.parse(r!.body as string) as PeerBackupStatusResponse).participating).toBe(true);
  });
});

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
