import type { Bytes } from "@flagship/protocol";
import type { MyShardRow, ShardRegistry } from "./registry.js";
import type { OwnerShardSource } from "./proofOfStorage.js";

export interface ReplacementPeer {
  serverId: string;
  stkPub: Bytes;
}

/**
 * Source of fresh peers to place a shard on. The real implementation calls
 * /api/peer-backup/request-peers; tests inject a closure.
 */
export interface PeerProvider {
  requestPeers(args: {
    shardSizeBytes: number;
    n: number;
    durabilityHint: "high" | "best-effort";
    excludeServerIds: string[];
  }): Promise<ReplacementPeer[]>;
}

/** Pushes a shard to a chosen peer. Real impl wraps PeerBackupClient.putShard. */
export interface ShardPusher {
  push(args: {
    encChunkId: Bytes;
    shardIndex: number;
    bytes: Bytes;
    peerServerId: string;
    peerStkPub: Bytes;
  }): Promise<{ ok: boolean; reason?: string }>;
}

export interface OwnerShardLoader {
  /** Return the full shard bytes for re-push. */
  loadShard(encChunkId: Bytes, shardIndex: number): Bytes | undefined;
}

export interface RepairAlert {
  level: "warning" | "critical";
  encChunkId: Bytes;
  survivors: number;
  k: number;
  message: string;
}

export interface RepairDaemonOptions {
  registry: ShardRegistry;
  source: OwnerShardSource;
  loader: OwnerShardLoader;
  peerProvider: PeerProvider;
  pusher: ShardPusher;
  /** Re-place proactively when survivors fall below k + healthyBuffer. Default 2. */
  healthyBuffer?: number;
  /** Erasure config — drives the survivor target. */
  k: number;
  n: number;
  /** Max parallel pushes per repair tick. Bandwidth throttle. Default 4. */
  maxConcurrent?: number;
  /** Hook fired on a successful re-place. */
  onReplaced?: (info: { encChunkId: Bytes; shardIndex: number; oldPeer: string; newPeer: string }) => void | Promise<void>;
  /** Hook fired on every alert. */
  onAlert?: (alert: RepairAlert) => void | Promise<void>;
  now?: () => number;
}

export interface RepairResult {
  /** Shards we tried to re-place. */
  attempted: number;
  /** Shards successfully re-placed. */
  replaced: number;
  /** Chunks proactively boosted (survivors fell below K + buffer). */
  proactivelyBoosted: number;
  /** Chunks at <K survivors — DATA LOSS alerts emitted. */
  criticalAlerts: number;
}

export class RepairDaemon {
  constructor(private readonly opts: RepairDaemonOptions) {}

  async repairOnce(): Promise<RepairResult> {
    const result: RepairResult = {
      attempted: 0,
      replaced: 0,
      proactivelyBoosted: 0,
      criticalAlerts: 0,
    };
    const buffer = this.opts.healthyBuffer ?? 2;
    const concurrency = this.opts.maxConcurrent ?? 4;

    // Group shards by encChunkId.
    const byChunk = new Map<string, MyShardRow[]>();
    for (const r of this.opts.registry.myShards()) {
      const k = bytesToHex(r.encChunkId);
      const arr = byChunk.get(k) ?? [];
      arr.push(r);
      byChunk.set(k, arr);
    }

    for (const [, rows] of byChunk) {
      const lost = rows.filter((r) => r.challengeStreak >= 3);
      const surviving = rows.filter((r) => r.challengeStreak < 3);

      if (surviving.length < this.opts.k) {
        result.criticalAlerts += 1;
        await this.opts.onAlert?.({
          level: "critical",
          encChunkId: rows[0]!.encChunkId,
          survivors: surviving.length,
          k: this.opts.k,
          message: `DATA LOSS: only ${surviving.length} of ${this.opts.k} shards survive — chunk unrecoverable`,
        });
      } else if (surviving.length < this.opts.k + buffer) {
        result.proactivelyBoosted += 1;
        await this.opts.onAlert?.({
          level: "warning",
          encChunkId: rows[0]!.encChunkId,
          survivors: surviving.length,
          k: this.opts.k,
          message: `survivors ${surviving.length} below safety buffer ${this.opts.k + buffer}; re-placing`,
        });
      }

      result.attempted += lost.length;
      if (lost.length === 0) continue;

      // Request distinct fresh peers for all lost shards in this chunk in
      // one round-trip. This avoids the race where concurrent per-shard
      // requestPeers calls could return overlapping peer lists, causing two
      // shards of the same chunk to land on the same peer.
      const sample = lost[0]!;
      const sampleData = this.opts.loader.loadShard(sample.encChunkId, sample.shardIndex);
      if (!sampleData) continue;
      const exclude = rows.map((r) => r.peerServerId);
      const candidates = await this.opts.peerProvider.requestPeers({
        shardSizeBytes: sampleData.length,
        n: lost.length,
        durabilityHint: "high",
        excludeServerIds: exclude,
      });

      const assignments = lost
        .slice(0, candidates.length)
        .map((lostRow, i) => ({ row: lostRow, peer: candidates[i]! }));

      const queue = [...assignments];
      const workers: Promise<void>[] = [];
      const placeOne = async (a: { row: MyShardRow; peer: ReplacementPeer }) => {
        const bytes = this.opts.loader.loadShard(a.row.encChunkId, a.row.shardIndex);
        if (!bytes) return;
        const push = await this.opts.pusher.push({
          encChunkId: a.row.encChunkId,
          shardIndex: a.row.shardIndex,
          bytes,
          peerServerId: a.peer.serverId,
          peerStkPub: a.peer.stkPub,
        });
        if (push.ok) {
          this.opts.registry.removeMyShard(
            a.row.encChunkId,
            a.row.shardIndex,
            a.row.peerServerId,
          );
          this.opts.registry.recordMyShard({
            chunkId: a.row.chunkId,
            encChunkId: a.row.encChunkId,
            shardIndex: a.row.shardIndex,
            peerServerId: a.peer.serverId,
            peerStkPub: a.peer.stkPub,
            storedAt: (this.opts.now ?? (() => Date.now()))(),
            challengeStreak: 0,
          });
          result.replaced += 1;
          await this.opts.onReplaced?.({
            encChunkId: a.row.encChunkId,
            shardIndex: a.row.shardIndex,
            oldPeer: a.row.peerServerId,
            newPeer: a.peer.serverId,
          });
        }
      };
      while (queue.length > 0 || workers.length > 0) {
        while (workers.length < concurrency && queue.length > 0) {
          const next = queue.shift()!;
          const p = placeOne(next).finally(() => {
            const i = workers.indexOf(p);
            if (i >= 0) workers.splice(i, 1);
          });
          workers.push(p);
        }
        if (workers.length > 0) await Promise.race(workers);
      }
    }

    return result;
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
