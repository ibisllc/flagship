import { describe, expect, it } from "vitest";
import {
  InMemoryShardRegistry,
  type MyShardRow,
  type TheirShardRow,
} from "../src/peerBackup/registry.js";

const cid = (n: number) => new Uint8Array(32).fill(n);
const stk = (n: number) => new Uint8Array(32).fill(n);

function myRow(over: Partial<MyShardRow> = {}): MyShardRow {
  return {
    chunkId: over.chunkId ?? cid(1),
    encChunkId: over.encChunkId ?? cid(2),
    shardIndex: over.shardIndex ?? 0,
    peerServerId: over.peerServerId ?? "peer-A",
    peerStkPub: over.peerStkPub ?? stk(0xa1),
    storedAt: over.storedAt ?? 100,
    challengeStreak: over.challengeStreak ?? 0,
    ...over,
  };
}

function theirRow(over: Partial<TheirShardRow> = {}): TheirShardRow {
  return {
    encChunkId: over.encChunkId ?? cid(2),
    shardIndex: over.shardIndex ?? 0,
    ownerServerId: over.ownerServerId ?? "owner-X",
    ownerStkPub: over.ownerStkPub ?? stk(0xb2),
    storedAt: over.storedAt ?? 100,
    sizeBytes: over.sizeBytes ?? 4 * 1024 * 1024,
    ...over,
  };
}

describe("InMemoryShardRegistry — my_shards", () => {
  it("records and lists shards I have placed on peers", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow({ shardIndex: 0, peerServerId: "peer-A" }));
    reg.recordMyShard(myRow({ shardIndex: 1, peerServerId: "peer-B" }));
    expect(reg.myShards()).toHaveLength(2);
  });

  it("groups shards belonging to the same encChunkId across peers", () => {
    const reg = new InMemoryShardRegistry();
    const enc = cid(7);
    reg.recordMyShard(myRow({ encChunkId: enc, shardIndex: 0, peerServerId: "peer-A" }));
    reg.recordMyShard(myRow({ encChunkId: enc, shardIndex: 1, peerServerId: "peer-B" }));
    reg.recordMyShard(myRow({ encChunkId: cid(8), shardIndex: 0, peerServerId: "peer-C" }));
    expect(reg.myShardsForChunk(enc)).toHaveLength(2);
    expect(reg.myShardsForChunk(cid(8))).toHaveLength(1);
  });

  it("recordChallengeOk resets streak and stamps lastChallenge", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow({ challengeStreak: 2 }));
    reg.recordChallengeOk(cid(2), 0, "peer-A", 999);
    const row = reg.myShards()[0]!;
    expect(row.challengeStreak).toBe(0);
    expect(row.lastChallenge).toBe(999);
  });

  it("recordChallengeFail increments streak monotonically", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow());
    expect(reg.recordChallengeFail(cid(2), 0, "peer-A")).toBe(1);
    expect(reg.recordChallengeFail(cid(2), 0, "peer-A")).toBe(2);
    expect(reg.recordChallengeFail(cid(2), 0, "peer-A")).toBe(3);
  });

  it("removeMyShard returns true on hit and false on miss", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow());
    expect(reg.removeMyShard(cid(2), 0, "peer-A")).toBe(true);
    expect(reg.removeMyShard(cid(2), 0, "peer-A")).toBe(false);
  });

  it("returns copies on read so caller mutation cannot poison the registry", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordMyShard(myRow({ peerServerId: "peer-A" }));
    const out = reg.myShards()[0]!;
    out.peerServerId = "evil";
    expect(reg.myShards()[0]!.peerServerId).toBe("peer-A");
  });
});

describe("InMemoryShardRegistry — their_shards", () => {
  it("records, gets, and removes shards I'm hosting for others", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordTheirShard(theirRow());
    expect(reg.theirShard(cid(2), 0)?.ownerServerId).toBe("owner-X");
    expect(reg.removeTheirShard(cid(2), 0)).toBe(true);
    expect(reg.theirShard(cid(2), 0)).toBeUndefined();
  });

  it("totalConsumedPledgedBytes sums sizeBytes across hosted shards (drives accounting)", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordTheirShard(theirRow({ shardIndex: 0, sizeBytes: 1000 }));
    reg.recordTheirShard(theirRow({ shardIndex: 1, sizeBytes: 2000 }));
    reg.recordTheirShard(theirRow({ encChunkId: cid(9), shardIndex: 0, sizeBytes: 4000 }));
    expect(reg.totalConsumedPledgedBytes()).toBe(7000);
  });

  it("re-recording a hosted shard with the same key updates in place (idempotent PUT)", () => {
    const reg = new InMemoryShardRegistry();
    reg.recordTheirShard(theirRow({ sizeBytes: 1000 }));
    reg.recordTheirShard(theirRow({ sizeBytes: 1500 }));
    expect(reg.theirShards()).toHaveLength(1);
    expect(reg.theirShard(cid(2), 0)?.sizeBytes).toBe(1500);
  });
});
