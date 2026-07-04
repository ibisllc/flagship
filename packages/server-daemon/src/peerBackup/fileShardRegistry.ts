import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bytes } from "@flagship/protocol";
import {
  InMemoryShardRegistry,
  type MyShardRow,
  type ShardRegistry,
  type TheirShardRow,
} from "./registry.js";

/**
 * File-backed ShardRegistry — a JSON snapshot of the in-memory registry,
 * re-written (tmp+rename, 0600) after every mutation. The registry is
 * small (one row per placed shard, no shard bytes), so snapshot-on-write
 * beats a WAL for something this size, and it matches the daemon's other
 * JSON stores (entitlements.json, paired-sessions). Byte fields are hex
 * in the file.
 *
 * Losing this file is NOT data loss: my_shards is reconstructable from
 * the manifest (which ships to .com) and their_shards from the peer-pool
 * directory — the registry is the working index, the manifest is the
 * recovery root.
 */
export class FileShardRegistry implements ShardRegistry {
  private readonly mem = new InMemoryShardRegistry();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: PersistedRegistry;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as PersistedRegistry;
    } catch {
      // A torn/corrupt snapshot must not brick the daemon — start empty;
      // the next mutation re-writes a good file, and the manifest/pool
      // remain the recovery roots.
      return;
    }
    for (const r of parsed.myShards ?? []) {
      this.mem.recordMyShard({
        chunkId: fromHex(r.chunkIdHex),
        encChunkId: fromHex(r.encChunkIdHex),
        shardIndex: r.shardIndex,
        peerServerId: r.peerServerId,
        peerStkPub: fromHex(r.peerStkPubHex),
        storedAt: r.storedAt,
        sizeBytes: r.sizeBytes,
        ...(r.lastChallenge !== undefined ? { lastChallenge: r.lastChallenge } : {}),
        challengeStreak: r.challengeStreak,
      });
    }
    for (const r of parsed.theirShards ?? []) {
      this.mem.recordTheirShard({
        encChunkId: fromHex(r.encChunkIdHex),
        shardIndex: r.shardIndex,
        ownerServerId: r.ownerServerId,
        ownerStkPub: fromHex(r.ownerStkPubHex),
        storedAt: r.storedAt,
        sizeBytes: r.sizeBytes,
      });
    }
  }

  private save(): void {
    const snapshot: PersistedRegistry = {
      version: 1,
      myShards: this.mem.myShards().map((r) => ({
        chunkIdHex: toHex(r.chunkId),
        encChunkIdHex: toHex(r.encChunkId),
        shardIndex: r.shardIndex,
        peerServerId: r.peerServerId,
        peerStkPubHex: toHex(r.peerStkPub),
        storedAt: r.storedAt,
        sizeBytes: r.sizeBytes,
        ...(r.lastChallenge !== undefined ? { lastChallenge: r.lastChallenge } : {}),
        challengeStreak: r.challengeStreak,
      })),
      theirShards: this.mem.theirShards().map((r) => ({
        encChunkIdHex: toHex(r.encChunkId),
        shardIndex: r.shardIndex,
        ownerServerId: r.ownerServerId,
        ownerStkPubHex: toHex(r.ownerStkPub),
        storedAt: r.storedAt,
        sizeBytes: r.sizeBytes,
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  recordMyShard(row: MyShardRow): void {
    this.mem.recordMyShard(row);
    this.save();
  }
  myShards(): MyShardRow[] {
    return this.mem.myShards();
  }
  myShardsForChunk(encChunkId: Bytes): MyShardRow[] {
    return this.mem.myShardsForChunk(encChunkId);
  }
  recordChallengeOk(encChunkId: Bytes, shardIndex: number, peerServerId: string, at: number): void {
    this.mem.recordChallengeOk(encChunkId, shardIndex, peerServerId, at);
    this.save();
  }
  recordChallengeFail(encChunkId: Bytes, shardIndex: number, peerServerId: string): number {
    const streak = this.mem.recordChallengeFail(encChunkId, shardIndex, peerServerId);
    this.save();
    return streak;
  }
  removeMyShard(encChunkId: Bytes, shardIndex: number, peerServerId: string): boolean {
    const removed = this.mem.removeMyShard(encChunkId, shardIndex, peerServerId);
    if (removed) this.save();
    return removed;
  }
  recordTheirShard(row: TheirShardRow): void {
    this.mem.recordTheirShard(row);
    this.save();
  }
  theirShards(): TheirShardRow[] {
    return this.mem.theirShards();
  }
  theirShard(encChunkId: Bytes, shardIndex: number): TheirShardRow | undefined {
    return this.mem.theirShard(encChunkId, shardIndex);
  }
  removeTheirShard(encChunkId: Bytes, shardIndex: number): boolean {
    const removed = this.mem.removeTheirShard(encChunkId, shardIndex);
    if (removed) this.save();
    return removed;
  }
  totalConsumedPledgedBytes(): number {
    return this.mem.totalConsumedPledgedBytes();
  }
}

interface PersistedRegistry {
  version: 1;
  myShards: Array<{
    chunkIdHex: string;
    encChunkIdHex: string;
    shardIndex: number;
    peerServerId: string;
    peerStkPubHex: string;
    storedAt: number;
    sizeBytes: number;
    lastChallenge?: number;
    challengeStreak: number;
  }>;
  theirShards: Array<{
    encChunkIdHex: string;
    shardIndex: number;
    ownerServerId: string;
    ownerStkPubHex: string;
    storedAt: number;
    sizeBytes: number;
  }>;
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hexStr: string): Bytes {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
