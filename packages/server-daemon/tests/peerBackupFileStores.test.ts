import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { FileShardBytesStore } from "../src/peerBackup/fileShardStore.js";
import { FileShardRegistry } from "../src/peerBackup/fileShardRegistry.js";
import type { MyShardRow, TheirShardRow } from "../src/peerBackup/registry.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pb-store-"));
}

describe("FileShardBytesStore", () => {
  const enc = sha256(new Uint8Array([1, 2, 3]));

  it("put/get/slice/delete round-trip on disk", () => {
    const store = new FileShardBytesStore(scratch());
    const bytes = new Uint8Array(3000).map((_, i) => i % 251);
    store.put(enc, 4, bytes);
    expect(Array.from(store.get(enc, 4)!)).toEqual(Array.from(bytes));
    expect(Array.from(store.slice(enc, 4, 100, 16)!)).toEqual(Array.from(bytes.slice(100, 116)));
    expect(store.slice(enc, 4, 2990, 100)).toBeUndefined();
    expect(store.delete(enc, 4)).toBe(true);
    expect(store.get(enc, 4)).toBeUndefined();
    expect(store.delete(enc, 4)).toBe(false);
  });

  it("survives a re-open (a daemon restart)", () => {
    const dir = scratch();
    new FileShardBytesStore(dir).put(enc, 0, new Uint8Array([9, 8, 7]));
    const reopened = new FileShardBytesStore(dir);
    expect(Array.from(reopened.get(enc, 0)!)).toEqual([9, 8, 7]);
  });

  it("overwrite replaces atomically (no tmp leftovers served)", () => {
    const store = new FileShardBytesStore(scratch());
    store.put(enc, 1, new Uint8Array([1]));
    store.put(enc, 1, new Uint8Array([2, 2]));
    expect(Array.from(store.get(enc, 1)!)).toEqual([2, 2]);
  });

  it("rejects a negative shardIndex (path traversal guard)", () => {
    const store = new FileShardBytesStore(scratch());
    expect(() => store.put(enc, -1, new Uint8Array([1]))).toThrow(/bad shardIndex/);
  });
});

function myRow(over: Partial<MyShardRow> = {}): MyShardRow {
  return {
    chunkId: sha256(new Uint8Array([1])),
    encChunkId: sha256(new Uint8Array([2])),
    shardIndex: 0,
    peerServerId: "attic.alice.flagship.services",
    peerStkPub: new Uint8Array(32).fill(5),
    storedAt: 111,
    sizeBytes: 42,
    challengeStreak: 0,
    ...over,
  };
}

function theirRow(over: Partial<TheirShardRow> = {}): TheirShardRow {
  return {
    encChunkId: sha256(new Uint8Array([3])),
    shardIndex: 1,
    ownerServerId: "home.bob.flagship.services",
    ownerStkPub: new Uint8Array(32).fill(6),
    storedAt: 222,
    sizeBytes: 7,
    ...over,
  };
}

describe("FileShardRegistry", () => {
  it("persists my_shards + their_shards across re-open", () => {
    const path = join(scratch(), "registry.json");
    const reg = new FileShardRegistry(path);
    reg.recordMyShard(myRow());
    reg.recordMyShard(myRow({ shardIndex: 1, peerServerId: "garage.alice.flagship.services" }));
    reg.recordTheirShard(theirRow());
    reg.recordChallengeFail(myRow().encChunkId, 0, myRow().peerServerId);

    const reopened = new FileShardRegistry(path);
    expect(reopened.myShards()).toHaveLength(2);
    expect(reopened.theirShards()).toHaveLength(1);
    const row = reopened
      .myShards()
      .find((r) => r.shardIndex === 0 && r.peerServerId === myRow().peerServerId)!;
    expect(row.challengeStreak).toBe(1);
    expect(Array.from(row.peerStkPub)).toEqual(Array.from(myRow().peerStkPub));
    expect(reopened.totalConsumedPledgedBytes()).toBe(7);
  });

  it("remove persists too", () => {
    const path = join(scratch(), "registry.json");
    const reg = new FileShardRegistry(path);
    reg.recordMyShard(myRow());
    reg.removeMyShard(myRow().encChunkId, 0, myRow().peerServerId);
    reg.recordTheirShard(theirRow());
    reg.removeTheirShard(theirRow().encChunkId, 1);
    const reopened = new FileShardRegistry(path);
    expect(reopened.myShards()).toHaveLength(0);
    expect(reopened.theirShards()).toHaveLength(0);
  });

  it("a corrupt snapshot starts empty instead of crashing", () => {
    const path = join(scratch(), "registry.json");
    writeFileSync(path, "{ not json");
    const reg = new FileShardRegistry(path);
    expect(reg.myShards()).toEqual([]);
    reg.recordMyShard(myRow());
    expect(JSON.parse(readFileSync(path, "utf8")).myShards).toHaveLength(1);
  });
});
