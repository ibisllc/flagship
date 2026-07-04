import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { deriveSWK } from "@flagship/protocol";
import { BackupLoop, type BackupShipping } from "../src/backupLoop.js";
import { InMemoryShardRegistry } from "../src/peerBackup/registry.js";
import { InMemoryShardBytesStore } from "../src/peerBackup/shardStore.js";
import { InMemoryManifestStore, chunkIsRestorable, type BackupManifest } from "../src/peerBackup/manifest.js";
import type { PeerProvider, ShardPusher } from "../src/peerBackup/repairDaemon.js";
import { RepairDaemon } from "../src/peerBackup/repairDaemon.js";

const OWNER = "home.alice.flagship.services";
const umk = { seed: new Uint8Array(32).fill(21) };
const swk = deriveSWK(umk, OWNER);

const PEERS = ["attic", "garage", "closet", "shed", "loft"].map((n, i) => ({
  serverId: `${n}.alice.flagship.services`,
  stkPub: new Uint8Array(32).fill(i + 1),
}));

function provider(peers = PEERS): PeerProvider {
  return {
    async requestPeers(args) {
      return peers.filter((p) => !args.excludeServerIds.includes(p.serverId)).slice(0, args.n);
    },
  };
}

/** Fake pusher: stores per-peer, optionally failing for specific peers. */
function pusher(failPeers: string[] = []) {
  const stored = new Map<string, InMemoryShardBytesStore>();
  const calls: { peer: string; idx: number }[] = [];
  const p: ShardPusher = {
    async push(args) {
      calls.push({ peer: args.peerServerId, idx: args.shardIndex });
      if (failPeers.includes(args.peerServerId)) return { ok: false, reason: "unreachable" };
      let s = stored.get(args.peerServerId);
      if (!s) {
        s = new InMemoryShardBytesStore();
        stored.set(args.peerServerId, s);
      }
      s.put(args.encChunkId, args.shardIndex, args.bytes);
      return { ok: true };
    },
  };
  return { p, stored, calls };
}

function harness(over: Partial<BackupShipping> = {}) {
  const registry = new InMemoryShardRegistry();
  const ownShards = new InMemoryShardBytesStore();
  const manifestStore = new InMemoryManifestStore();
  const uploads: BackupManifest[] = [];
  const { p, stored, calls } = pusher();
  const shipping: BackupShipping = {
    myServerId: OWNER,
    peerProvider: provider(),
    pusher: p,
    registry,
    ownShards,
    manifestStore,
    uploadManifest: async (m) => {
      uploads.push(JSON.parse(JSON.stringify(m)) as BackupManifest);
      return { ok: true };
    },
    ...over,
  };
  const loop = new BackupLoop({ swk, k: 3, n: 5, initiallyEnabled: true, shipping });
  return { loop, registry, ownShards, manifestStore, uploads, stored, calls };
}

const FILE = { path: "data/app.db", content: new Uint8Array(10_000).map((_, i) => (i * 31) % 256) };

describe("BackupLoop ship path", () => {
  it("encode → push to distinct peers → registry + manifest recorded + manifest uploaded", async () => {
    const h = harness();
    const r = await h.loop.runOnce([FILE], 5000);
    expect(r.chunksShipped).toBe(1);
    expect(r.shardsPlaced).toBe(5);
    expect(r.chunksUnderReplicated).toBe(0);
    expect(r.manifestUploaded).toBe(true);

    const m = h.manifestStore.load()!;
    expect(m.generation).toBe(1);
    expect(m.updatedAt).toBe(5000);
    expect(m.chunks).toHaveLength(1);
    const chunk = m.chunks[0]!;
    expect(chunk.path).toBe(FILE.path);
    expect(chunk.chunkIdHex).toBe(Buffer.from(sha256(FILE.content)).toString("hex"));
    expect(chunk.placements).toHaveLength(5);
    // Distinct shard indices on distinct peers (5 peers, 5 shards).
    expect(new Set(chunk.placements.map((p) => p.peerServerId)).size).toBe(5);
    expect(chunkIsRestorable(chunk)).toBe(true);

    // Registry mirrors the placements; own shards kept locally for repair.
    expect(h.registry.myShards()).toHaveLength(5);
    const encChunkId = Uint8Array.from(Buffer.from(chunk.encChunkIdHex, "hex"));
    for (let i = 0; i < 5; i++) expect(h.ownShards.get(encChunkId, i)).toBeDefined();
    expect(h.uploads).toHaveLength(1);

    // Each placement's sha matches what the peer actually holds.
    for (const p of chunk.placements) {
      const peerStore = h.stored.get(p.peerServerId)!;
      const bytes = peerStore.get(encChunkId, p.shardIndex)!;
      expect(Buffer.from(sha256(bytes)).toString("hex")).toBe(p.shardSha256Hex);
    }
  });

  it("peer failures mid-push: ≥k placed → still restorable; repair daemon tops up later", async () => {
    const failing = ["shed.alice.flagship.services", "loft.alice.flagship.services"];
    const { p } = pusher(failing);
    const h = harness({ pusher: p });
    const r = await h.loop.runOnce([FILE]);
    expect(r.shardsPlaced).toBe(3); // 5 - 2 failed
    expect(r.chunksUnderReplicated).toBe(0); // 3 distinct indices = k → restorable
    const chunk = h.manifestStore.load()!.chunks[0]!;
    expect(chunkIsRestorable(chunk)).toBe(true);
    expect(chunk.placements.map((pl) => pl.shardIndex).sort()).toEqual([0, 1, 2]);

    // Repair: mark the two missing shard rows as lost? They were never
    // recorded (push failed) — the repair daemon's unit is registry rows,
    // so top-up of never-placed shards is the NEXT runOnce (content
    // unchanged but not-fully-replicated chunks are only skipped when
    // restorable — here it IS restorable, so re-ship happens on change).
    // What repair DOES cover: a placed shard whose peer goes dark.
    const rows = h.registry.myShards();
    expect(rows).toHaveLength(3);
    // Simulate peer of shard 0 going dark (3 failed challenges).
    const dark = rows.find((row) => row.shardIndex === 0)!;
    h.registry.recordChallengeFail(dark.encChunkId, 0, dark.peerServerId);
    h.registry.recordChallengeFail(dark.encChunkId, 0, dark.peerServerId);
    h.registry.recordChallengeFail(dark.encChunkId, 0, dark.peerServerId);

    const { p: repairPusher } = pusher();
    const repair = new RepairDaemon({
      registry: h.registry,
      source: { loadShardSlice: () => undefined, shardLength: () => undefined },
      loader: {
        loadShard: (enc, idx) => h.ownShards.get(enc, idx),
      },
      peerProvider: provider(),
      pusher: repairPusher,
      k: 3,
      n: 5,
    });
    const rep = await repair.repairOnce();
    expect(rep.replaced).toBe(1);
    // The dark peer's row was replaced by a fresh peer's row.
    const after = h.registry.myShards().filter((row) => row.shardIndex === 0);
    expect(after).toHaveLength(1);
    expect(after[0]!.peerServerId).not.toBe(dark.peerServerId);
  });

  it("zero peers (single-box account): chunk recorded local-only + flagged under-replicated", async () => {
    const h = harness({ peerProvider: provider([]) });
    const r = await h.loop.runOnce([FILE]);
    expect(r.shardsPlaced).toBe(0);
    expect(r.chunksShipped).toBe(1);
    expect(r.chunksUnderReplicated).toBe(1);
    const chunk = h.manifestStore.load()!.chunks[0]!;
    expect(chunk.placements).toHaveLength(0);
    expect(chunkIsRestorable(chunk)).toBe(false);
    expect(h.loop.status().healthyChunks).toBe(0);
    expect(h.loop.status().totalChunks).toBe(1);
  });

  it("unchanged + restorable chunk is skipped (no re-encrypt churn); changed content re-ships", async () => {
    const h = harness();
    await h.loop.runOnce([FILE]);
    const gen1 = h.manifestStore.load()!.generation;
    const r2 = await h.loop.runOnce([FILE]);
    expect(r2.chunksSkipped).toBe(1);
    expect(r2.chunksShipped).toBe(0);
    expect(h.manifestStore.load()!.generation).toBe(gen1); // nothing changed → no bump
    expect(h.uploads).toHaveLength(1);

    const changed = { path: FILE.path, content: new Uint8Array(9000).fill(3) };
    const oldEncChunkIdHex = h.manifestStore.load()!.chunks[0]!.encChunkIdHex;
    const r3 = await h.loop.runOnce([changed]);
    expect(r3.chunksShipped).toBe(1);
    const m = h.manifestStore.load()!;
    expect(m.generation).toBe(gen1 + 1);
    expect(m.chunks).toHaveLength(1); // replaced, not appended
    expect(m.chunks[0]!.encChunkIdHex).not.toBe(oldEncChunkIdHex);
    // Old chunk's registry rows + local shards were dropped.
    const oldEnc = Uint8Array.from(Buffer.from(oldEncChunkIdHex, "hex"));
    expect(h.registry.myShardsForChunk(oldEnc)).toHaveLength(0);
    expect(h.ownShards.get(oldEnc, 0)).toBeUndefined();
  });

  it("under-replicated (but changed) content is NOT skipped on the next run", async () => {
    // First run: no peers → local-only. Second run with peers must ship.
    const flaky = harness({ peerProvider: provider([]) });
    await flaky.loop.runOnce([FILE]);
    expect(flaky.manifestStore.load()!.chunks[0]!.placements).toHaveLength(0);

    const good = harness({ manifestStore: flaky.manifestStore, registry: flaky.registry, ownShards: flaky.ownShards });
    const r = await good.loop.runOnce([FILE]);
    expect(r.chunksSkipped).toBe(0);
    expect(r.chunksShipped).toBe(1);
    expect(chunkIsRestorable(flaky.manifestStore.load()!.chunks[0]!)).toBe(true);
  });

  it("manifest upload failure is non-fatal and retried on the next changing run", async () => {
    let fail = true;
    const uploads: number[] = [];
    const h = harness({
      uploadManifest: async (m) => {
        if (fail) return { ok: false, reason: "com down" };
        uploads.push(m.generation);
        return { ok: true };
      },
    });
    const r1 = await h.loop.runOnce([FILE]);
    expect(r1.manifestUploaded).toBe(false);
    expect(h.manifestStore.load()!.generation).toBe(1); // kept locally

    fail = false;
    const changed = { path: FILE.path, content: new Uint8Array([1, 2, 3, 4]) };
    const r2 = await h.loop.runOnce([changed]);
    expect(r2.manifestUploaded).toBe(true);
    expect(uploads).toEqual([2]);
  });

  it("round-robins shards when the account has fewer peers than n", async () => {
    const two = PEERS.slice(0, 2);
    const h = harness({ peerProvider: provider(two) });
    const r = await h.loop.runOnce([FILE]);
    expect(r.shardsPlaced).toBe(5);
    const chunk = h.manifestStore.load()!.chunks[0]!;
    expect(new Set(chunk.placements.map((p) => p.peerServerId)).size).toBe(2);
    expect(chunkIsRestorable(chunk)).toBe(true);
  });
});
