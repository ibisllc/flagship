import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Bytes } from "@flagship/protocol";
import type { ShardBytesStore } from "./shardStore.js";

/**
 * Flat-file ShardBytesStore — the production successor to the v0
 * in-memory store. Layout is exactly the one the interface always
 * promised: `<root>/<encChunkIdHex>/<shardIndex>`.
 *
 * Used for BOTH pools:
 *   - their-shards ("/var/flagship/peer-pool")   — shards hosted for peers
 *   - own-shards   ("/var/flagship/peer-backup/own-shards") — the local
 *     copy of our own chunks' shards the repair daemon re-pushes from.
 *
 * Sync fs is deliberate: the interface is synchronous (the transport
 * handles one frame at a time), shards are small (chunk/k), and the
 * atomic tmp+rename write mirrors the daemon's other file stores.
 */
export class FileShardBytesStore implements ShardBytesStore {
  constructor(private readonly root: string) {}

  private path(encChunkId: Bytes, shardIndex: number): string {
    return join(this.root, hex(encChunkId), String(shardIndex));
  }

  put(encChunkId: Bytes, shardIndex: number, bytes: Bytes): void {
    if (!Number.isInteger(shardIndex) || shardIndex < 0) {
      throw new Error(`bad shardIndex ${shardIndex}`);
    }
    const p = this.path(encChunkId, shardIndex);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, p);
  }

  get(encChunkId: Bytes, shardIndex: number): Bytes | undefined {
    const p = this.path(encChunkId, shardIndex);
    if (!existsSync(p)) return undefined;
    try {
      return new Uint8Array(readFileSync(p));
    } catch {
      return undefined;
    }
  }

  delete(encChunkId: Bytes, shardIndex: number): boolean {
    const p = this.path(encChunkId, shardIndex);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    // Leave the (possibly now-empty) chunk dir — cheap, and avoids a
    // rmdir race with a concurrent put of a sibling shard.
    return true;
  }

  slice(encChunkId: Bytes, shardIndex: number, offset: number, length: number): Bytes | undefined {
    const b = this.get(encChunkId, shardIndex);
    if (!b) return undefined;
    if (offset + length > b.length) return undefined;
    return b.slice(offset, offset + length);
  }
}

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
