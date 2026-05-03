/**
 * Local shard registry — two tables of state per Flagship server:
 *
 *   - my_shards   : shards of MY data that other peers are storing for me.
 *   - their_shards: shards of OTHER users' data that I'm storing.
 *
 * The roadmap specifies SQLite for production; v0 ships an in-memory
 * implementation behind the same `ShardRegistry` interface. Persistence is
 * the caller's concern (and easy to retrofit because everything goes through
 * the interface).
 */

import type { Bytes } from "@flagship/protocol";

export interface MyShardRow {
  /** sha256 of plaintext (32 bytes). Owner-side only — peers never see this. */
  chunkId: Bytes;
  /** sha256 of ciphertext (32 bytes). What peers see. */
  encChunkId: Bytes;
  shardIndex: number;
  peerServerId: string;
  /** Peer's STK pubkey, used to verify their challenge-response signatures. */
  peerStkPub: Bytes;
  storedAt: number;
  lastChallenge?: number;
  challengeStreak: number;
}

export interface TheirShardRow {
  encChunkId: Bytes;
  shardIndex: number;
  ownerServerId: string;
  /** Owner's STK pubkey — knowing this lets us verify the challenges they send. */
  ownerStkPub: Bytes;
  storedAt: number;
  sizeBytes: number;
}

/** Composite key over (encChunkId, shardIndex). */
function shardKey(encChunkId: Bytes, shardIndex: number): string {
  let s = "";
  for (const b of encChunkId) s += b.toString(16).padStart(2, "0");
  return `${s}#${shardIndex}`;
}

export interface ShardRegistry {
  // my_shards
  recordMyShard(row: MyShardRow): void;
  myShards(): MyShardRow[];
  myShardsForChunk(encChunkId: Bytes): MyShardRow[];
  recordChallengeOk(encChunkId: Bytes, shardIndex: number, peerServerId: string, at: number): void;
  recordChallengeFail(encChunkId: Bytes, shardIndex: number, peerServerId: string): number;
  removeMyShard(encChunkId: Bytes, shardIndex: number, peerServerId: string): boolean;

  // their_shards
  recordTheirShard(row: TheirShardRow): void;
  theirShards(): TheirShardRow[];
  theirShard(encChunkId: Bytes, shardIndex: number): TheirShardRow | undefined;
  removeTheirShard(encChunkId: Bytes, shardIndex: number): boolean;

  // accounting
  totalConsumedPledgedBytes(): number;
}

export class InMemoryShardRegistry implements ShardRegistry {
  /** Key: shardKey(encChunkId, shardIndex) + "@" + peerServerId */
  private myStore = new Map<string, MyShardRow>();
  /** Key: shardKey(encChunkId, shardIndex) — only one row per shard owned by us. */
  private theirStore = new Map<string, TheirShardRow>();

  recordMyShard(row: MyShardRow): void {
    const k = `${shardKey(row.encChunkId, row.shardIndex)}@${row.peerServerId}`;
    this.myStore.set(k, copyMy(row));
  }

  myShards(): MyShardRow[] {
    return [...this.myStore.values()].map(copyMy);
  }

  myShardsForChunk(encChunkId: Bytes): MyShardRow[] {
    const prefix = shardKey(encChunkId, 0).split("#")[0]!;
    return [...this.myStore.entries()]
      .filter(([k]) => k.startsWith(prefix + "#"))
      .map(([, v]) => copyMy(v));
  }

  recordChallengeOk(
    encChunkId: Bytes,
    shardIndex: number,
    peerServerId: string,
    at: number,
  ): void {
    const k = `${shardKey(encChunkId, shardIndex)}@${peerServerId}`;
    const row = this.myStore.get(k);
    if (!row) return;
    row.lastChallenge = at;
    row.challengeStreak = 0;
  }

  recordChallengeFail(
    encChunkId: Bytes,
    shardIndex: number,
    peerServerId: string,
  ): number {
    const k = `${shardKey(encChunkId, shardIndex)}@${peerServerId}`;
    const row = this.myStore.get(k);
    if (!row) return 0;
    row.challengeStreak += 1;
    return row.challengeStreak;
  }

  removeMyShard(encChunkId: Bytes, shardIndex: number, peerServerId: string): boolean {
    const k = `${shardKey(encChunkId, shardIndex)}@${peerServerId}`;
    return this.myStore.delete(k);
  }

  recordTheirShard(row: TheirShardRow): void {
    const k = shardKey(row.encChunkId, row.shardIndex);
    this.theirStore.set(k, copyTheir(row));
  }

  theirShards(): TheirShardRow[] {
    return [...this.theirStore.values()].map(copyTheir);
  }

  theirShard(encChunkId: Bytes, shardIndex: number): TheirShardRow | undefined {
    const r = this.theirStore.get(shardKey(encChunkId, shardIndex));
    return r ? copyTheir(r) : undefined;
  }

  removeTheirShard(encChunkId: Bytes, shardIndex: number): boolean {
    return this.theirStore.delete(shardKey(encChunkId, shardIndex));
  }

  totalConsumedPledgedBytes(): number {
    let n = 0;
    for (const r of this.theirStore.values()) n += r.sizeBytes;
    return n;
  }
}

function copyMy(r: MyShardRow): MyShardRow {
  return {
    ...r,
    chunkId: r.chunkId.slice(),
    encChunkId: r.encChunkId.slice(),
    peerStkPub: r.peerStkPub.slice(),
  };
}

function copyTheir(r: TheirShardRow): TheirShardRow {
  return {
    ...r,
    encChunkId: r.encChunkId.slice(),
    ownerStkPub: r.ownerStkPub.slice(),
  };
}
