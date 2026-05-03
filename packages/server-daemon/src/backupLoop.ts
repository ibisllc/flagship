import { encodeShards, encryptChunk, type Bytes } from "@flagship/protocol";

export interface BackupConfig {
  swk: Bytes;
  k: number;
  n: number;
}

export interface FileToBack {
  path: string;
  content: Bytes;
}

export interface BackupReport {
  filesProcessed: number;
  totalShards: number;
  totalShardBytes: number;
}

export class BackupLoop {
  constructor(private readonly cfg: BackupConfig) {}

  runOnce(files: ReadonlyArray<FileToBack>): BackupReport {
    let totalShards = 0;
    let totalShardBytes = 0;
    for (const f of files) {
      const enc = encryptChunk(f.content, this.cfg.swk);
      const shards = encodeShards(enc.ciphertext, this.cfg.k, this.cfg.n);
      totalShards += shards.shards.length;
      for (const s of shards.shards) totalShardBytes += s.length;
      // TODO v2: ship shards to peers via control-plane matchmaking
    }
    return {
      filesProcessed: files.length,
      totalShards,
      totalShardBytes,
    };
  }
}
