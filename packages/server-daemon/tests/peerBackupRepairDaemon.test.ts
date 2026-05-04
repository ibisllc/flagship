import { describe, expect, it } from "vitest";
import {
  InMemoryShardRegistry,
  type MyShardRow,
} from "../src/peerBackup/registry.js";
import {
  RepairDaemon,
  type PeerProvider,
  type ShardPusher,
} from "../src/peerBackup/repairDaemon.js";
import type { OwnerShardSource } from "../src/peerBackup/proofOfStorage.js";

const enc = new Uint8Array(32).fill(0xab);
const stk = (n: number) => new Uint8Array(32).fill(n);

function row(over: Partial<MyShardRow> = {}): MyShardRow {
  return {
    chunkId: new Uint8Array(32).fill(0xcd),
    encChunkId: enc,
    shardIndex: over.shardIndex ?? 0,
    peerServerId: over.peerServerId ?? "peer-A",
    peerStkPub: over.peerStkPub ?? stk(0xa1),
    storedAt: 0,
    challengeStreak: over.challengeStreak ?? 0,
    ...over,
  };
}

const SHARD_BYTES = new Uint8Array(2048).fill(0x42);

const okSource: OwnerShardSource = {
  loadShardSlice() {
    return SHARD_BYTES.slice(0, 1024);
  },
  shardLength() {
    return SHARD_BYTES.length;
  },
};

const okLoader = {
  loadShard(_enc: Uint8Array, _idx: number) {
    return SHARD_BYTES;
  },
};

function makeProvider(peers: { serverId: string; stkPub: Uint8Array }[]): PeerProvider {
  return {
    async requestPeers(args) {
      return peers
        .filter((p) => !args.excludeServerIds.includes(p.serverId))
        .slice(0, args.n);
    },
  };
}

function makePusher(behavior: "ok" | "fail" = "ok"): ShardPusher & { calls: { peer: string; idx: number }[] } {
  const calls: { peer: string; idx: number }[] = [];
  return {
    calls,
    async push(args) {
      calls.push({ peer: args.peerServerId, idx: args.shardIndex });
      return { ok: behavior === "ok" };
    },
  };
}

describe("RepairDaemon — repairOnce", () => {
  it("re-places shards whose challengeStreak crossed the loss threshold", async () => {
    const reg = new InMemoryShardRegistry();
    // 10 shards, 2 lost (peer-A and peer-B), 8 surviving (peer-C..J).
    for (let i = 0; i < 10; i++) {
      reg.recordMyShard(row({ shardIndex: i, peerServerId: `peer-${String.fromCharCode(65 + i)}` }));
    }
    reg.recordChallengeFail(enc, 0, "peer-A");
    reg.recordChallengeFail(enc, 0, "peer-A");
    reg.recordChallengeFail(enc, 0, "peer-A");
    reg.recordChallengeFail(enc, 1, "peer-B");
    reg.recordChallengeFail(enc, 1, "peer-B");
    reg.recordChallengeFail(enc, 1, "peer-B");

    const provider = makeProvider([
      { serverId: "peer-Z", stkPub: stk(0xff) },
      { serverId: "peer-Y", stkPub: stk(0xee) },
    ]);
    const pusher = makePusher("ok");

    const daemon = new RepairDaemon({
      registry: reg,
      source: okSource,
      loader: okLoader,
      peerProvider: provider,
      pusher,
      k: 10,
      n: 16,
    });
    const r = await daemon.repairOnce();
    expect(r.attempted).toBe(2);
    expect(r.replaced).toBe(2);
    expect(pusher.calls.map((c) => c.peer).sort()).toEqual(["peer-Y", "peer-Z"]);

    // Registry now reflects the new placements; old peer rows gone.
    const peers = reg.myShards().map((r) => r.peerServerId);
    expect(peers).not.toContain("peer-A");
    expect(peers).not.toContain("peer-B");
    expect(peers).toContain("peer-Z");
  });

  it("excludes peers already holding shards of this chunk (no co-location)", async () => {
    const reg = new InMemoryShardRegistry();
    for (let i = 0; i < 10; i++) {
      reg.recordMyShard(row({ shardIndex: i, peerServerId: `peer-${i}` }));
    }
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    let observedExclude: string[] | undefined;
    const provider: PeerProvider = {
      async requestPeers(args) {
        observedExclude = args.excludeServerIds;
        return [{ serverId: "peer-fresh", stkPub: stk(0x11) }];
      },
    };
    const daemon = new RepairDaemon({
      registry: reg,
      source: okSource,
      loader: okLoader,
      peerProvider: provider,
      pusher: makePusher("ok"),
      k: 10,
      n: 16,
    });
    await daemon.repairOnce();
    expect(observedExclude).toBeDefined();
    for (let i = 0; i < 10; i++) expect(observedExclude!).toContain(`peer-${i}`);
  });

  it("emits a critical DATA LOSS alert when survivors < K", async () => {
    const reg = new InMemoryShardRegistry();
    // Only 5 shards, all dead.
    for (let i = 0; i < 5; i++) {
      reg.recordMyShard(row({ shardIndex: i, peerServerId: `peer-${i}` }));
      reg.recordChallengeFail(enc, i, `peer-${i}`);
      reg.recordChallengeFail(enc, i, `peer-${i}`);
      reg.recordChallengeFail(enc, i, `peer-${i}`);
    }
    const alerts: string[] = [];
    const daemon = new RepairDaemon({
      registry: reg,
      source: okSource,
      loader: okLoader,
      peerProvider: makeProvider([]),
      pusher: makePusher("ok"),
      k: 10,
      n: 16,
      onAlert: async (a) => {
        alerts.push(a.level + ":" + a.message);
      },
    });
    const r = await daemon.repairOnce();
    expect(r.criticalAlerts).toBe(1);
    expect(alerts.some((a) => a.startsWith("critical:"))).toBe(true);
  });

  it("emits a warning when survivors are below K + healthyBuffer (proactive re-place)", async () => {
    const reg = new InMemoryShardRegistry();
    // 11 shards: 1 lost, 10 surviving — at K + 0 buffer. With K=10, buffer=2,
    // survivors=10 < 12 → warning fires.
    for (let i = 0; i < 11; i++) {
      reg.recordMyShard(row({ shardIndex: i, peerServerId: `peer-${i}` }));
    }
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    const alerts: { level: string; survivors: number }[] = [];
    const daemon = new RepairDaemon({
      registry: reg,
      source: okSource,
      loader: okLoader,
      peerProvider: makeProvider([{ serverId: "peer-Z", stkPub: stk(0x99) }]),
      pusher: makePusher("ok"),
      k: 10,
      n: 16,
      healthyBuffer: 2,
      onAlert: async (a) => alerts.push({ level: a.level, survivors: a.survivors }),
    });
    const r = await daemon.repairOnce();
    expect(r.proactivelyBoosted).toBe(1);
    expect(alerts.some((a) => a.level === "warning" && a.survivors === 10)).toBe(true);
  });

  it("skips re-place when no fresh peer is available (peer pool exhausted)", async () => {
    const reg = new InMemoryShardRegistry();
    for (let i = 0; i < 10; i++) {
      reg.recordMyShard(row({ shardIndex: i, peerServerId: `peer-${i}` }));
    }
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    reg.recordChallengeFail(enc, 0, "peer-0");
    const daemon = new RepairDaemon({
      registry: reg,
      source: okSource,
      loader: okLoader,
      peerProvider: makeProvider([]), // empty pool
      pusher: makePusher("ok"),
      k: 10,
      n: 16,
    });
    const r = await daemon.repairOnce();
    expect(r.attempted).toBe(1);
    expect(r.replaced).toBe(0);
  });
});
