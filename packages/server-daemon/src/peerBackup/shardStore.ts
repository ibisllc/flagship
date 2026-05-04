import type { Bytes } from "@flagship/protocol";

/**
 * Storage interface for the shards I host on behalf of other servers
 * (their_shards). v0 in-memory; v1 will be flat files under
 * /var/flagship/peer-pool/<encChunkId>/<shardIndex>.
 */
export interface ShardBytesStore {
  put(encChunkId: Bytes, shardIndex: number, bytes: Bytes): void;
  get(encChunkId: Bytes, shardIndex: number): Bytes | undefined;
  delete(encChunkId: Bytes, shardIndex: number): boolean;
  /** Return a region of the stored shard for proof-of-storage challenges. */
  slice(encChunkId: Bytes, shardIndex: number, offset: number, length: number): Bytes | undefined;
}

function key(encChunkId: Bytes, shardIndex: number): string {
  let s = "";
  for (const b of encChunkId) s += b.toString(16).padStart(2, "0");
  return `${s}#${shardIndex}`;
}

export class InMemoryShardBytesStore implements ShardBytesStore {
  private store = new Map<string, Uint8Array>();

  put(encChunkId: Bytes, shardIndex: number, bytes: Bytes): void {
    this.store.set(key(encChunkId, shardIndex), bytes.slice());
  }

  get(encChunkId: Bytes, shardIndex: number): Bytes | undefined {
    const b = this.store.get(key(encChunkId, shardIndex));
    return b ? b.slice() : undefined;
  }

  delete(encChunkId: Bytes, shardIndex: number): boolean {
    return this.store.delete(key(encChunkId, shardIndex));
  }

  slice(encChunkId: Bytes, shardIndex: number, offset: number, length: number): Bytes | undefined {
    const b = this.store.get(key(encChunkId, shardIndex));
    if (!b) return undefined;
    if (offset + length > b.length) return undefined;
    return b.slice(offset, offset + length);
  }
}
