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

export interface BackupStatus {
  /** Whether the user has toggled backup on for this server. */
  enabled: boolean;
  /** Last time `runOnce` actually executed work (not skipped). */
  lastBackupAt: number | null;
  /** Number of distinct chunks this server has produced shards for. */
  totalChunks: number;
  /** Chunks that currently have ≥ K healthy peer copies (placeholder until repair daemon wires in). */
  healthyChunks: number;
  /** Bytes this server is reciprocally hosting for OTHER users (this is what it costs us to receive backup ourselves). */
  hostingBytes: number;
  /** Last toggle timestamp. */
  lastToggledAt: number | null;
}

export class BackupLoop {
  private enabled = false;
  private lastBackupAt: number | null = null;
  private lastToggledAt: number | null = null;
  private totalChunks = 0;
  private hostingBytes = 0;

  constructor(private readonly cfg: BackupConfig & { initiallyEnabled?: boolean }) {
    if (cfg.initiallyEnabled) this.enabled = true;
  }

  /** Toggle from the phone (caller has already verified the IRK signature). */
  setEnabled(enabled: boolean, at: number = Date.now()): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.lastToggledAt = at;
  }

  /** Tracks a hosted shard (called by the peer-backup server when it accepts a PUT). */
  recordHostedBytes(delta: number): void {
    this.hostingBytes = Math.max(0, this.hostingBytes + delta);
  }

  status(): BackupStatus {
    return {
      enabled: this.enabled,
      lastBackupAt: this.lastBackupAt,
      totalChunks: this.totalChunks,
      // Repair daemon will populate the real number; until then equal totalChunks
      // when we last saw them as a fresh upload.
      healthyChunks: this.totalChunks,
      hostingBytes: this.hostingBytes,
      lastToggledAt: this.lastToggledAt,
    };
  }

  runOnce(files: ReadonlyArray<FileToBack>, now: number = Date.now()): BackupReport {
    if (!this.enabled) {
      return { filesProcessed: 0, totalShards: 0, totalShardBytes: 0 };
    }
    let totalShards = 0;
    let totalShardBytes = 0;
    for (const f of files) {
      const enc = encryptChunk(f.content, this.cfg.swk);
      const shards = encodeShards(enc.ciphertext, this.cfg.k, this.cfg.n);
      totalShards += shards.shards.length;
      for (const s of shards.shards) totalShardBytes += s.length;
      // TODO v2: ship shards to peers via control-plane matchmaking
    }
    if (files.length > 0) {
      this.totalChunks += files.length;
      this.lastBackupAt = now;
    }
    return {
      filesProcessed: files.length,
      totalShards,
      totalShardBytes,
    };
  }
}
